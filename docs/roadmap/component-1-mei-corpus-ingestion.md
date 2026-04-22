# Phase 1 — Component 1: MEI Corpus Ingestion — Implementation Plan

This document translates Component 1 of `docs/roadmap/phase-1.md` into a concrete, sequenced set of implementation tasks. It assumes the foundation work described in `docs/roadmap/phase-1-foundation-plan.md` is complete — in particular, that the backend scaffold, Docker Compose stack, FastAPI skeleton with auth middleware, and the `0001_initial_schema` Alembic migration are all in place.

Component 1 establishes the corpus as the system's raw material. All subsequent components — corpus browsing, Verovio rendering, the tagging tool, music21 preprocessing, and the fragment database — depend on the invariants this component enforces: normalized MEI files in object storage, validated metadata in PostgreSQL, and a coherent composer/corpus/work/movement hierarchy keyed by the object-key convention `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei`.

---

## Foundation preflight

Before Component 1 work begins, confirm:

1. `docker compose up` brings Neo4j, PostgreSQL (with pgvector), Redis, and MinIO up cleanly, with MinIO's `doppia-local` bucket auto-created.
2. `alembic upgrade head` applies `0001_initial_schema` against local PostgreSQL and Supabase staging. The `composer`, `corpus`, `work`, `movement`, `movement_analysis`, and `fragment*` tables exist with the columns, constraints, and indexes documented in `docs/architecture/tech-stack-and-database-reference.md` and `docs/architecture/fragment-schema.md`.
3. The `AuthMiddleware` in `backend/api/middleware/auth.py` validates Supabase JWTs and `require_role("admin")` is wired as a dependency factory. Component 1's upload endpoint is `admin`-only; there is no other role gate in play here.
4. `aioboto3`, `lxml`, `music21`, `celery[redis]`, and `verovio` are pinned in `backend/requirements.txt` (they already are). `mscore` (MuseScore 3.6.2) is available on the machine running the corpus-preparation script; it is a developer-workstation dependency, not a container dependency.

Component 1 adds no new columns and no new tables. It is entirely a service-layer, pipeline, and endpoint implementation against the existing schema.

---

## Scope and deferrals

In scope:

- A corpus-preparation pipeline that converts DCML `.mscx` sources into MEI and assembles an upload package (the *import format*: a ZIP of MEI files plus a `metadata.yaml` sidecar, plus — for DCML corpora — the matching `harmonies.tsv` files).
- The MEI validation pipeline (well-formed XML, MEI RelaxNG schema, measure-number integrity, staff-count consistency, encoding sanity).
- The MEI normalizer (`backend/services/mei_normalizer.py`), exactly as specified in `docs/architecture/mei-ingest-normalization.md`.
- The bulk upload endpoint `POST /api/v1/composers/{composer_slug}/corpora/{corpus_slug}/upload`, restricted to `admin`.
- The post-ingest analysis-ingestion task that populates `movement_analysis.events`. For the Mozart first case this means parsing `harmonies.tsv`; for corpora without expert analysis it will later hand off to Component 6 (music21 fallback).

Explicitly deferred:

- **Component 6 — music21 auto-analysis fallback.** The only corpus ingested in Phase 1's initial pass is Mozart piano sonatas (DCML), which ships with expert harmonic annotations. music21's auto-analysis is the fallback described in `docs/architecture/corpus-and-analysis-sources.md` and is only invoked when no expert annotation exists. Since the first corpus does have expert annotation, music21 preprocessing is not on the critical path for Component 1. See the *Analysis ingestion* section below for how the dispatch point is built now so Component 6 plugs in later without reshaping the pipeline.
- **Incipit generation.** Component 2 owns the server-side Verovio incipit render (`previews/incipit.svg`). The ingestion pipeline emits a Celery event on successful movement ingest that Component 2 subscribes to; Component 1 does not generate incipits itself.
- **Repeat-context disambiguation UI.** `repeat_context` is a column on `fragment` already; its Phase 1 handling is purely "store the flag, flag ambiguous ranges at tag time." Component 1 is not concerned with it.
- **MEI re-ingest after score correction.** The re-ingest path (including the `movement_analysis` smart-merge described in ADR-004) is scaffolded by reusing the same pipeline with `update=true`, but the end-to-end test for it is not required before Component 2 begins.
- **Measure-number correction utility.** A `scripts/fix_measure_numbers.py` tool was originally specified for catching convention mismatches (e.g. a pickup numbered `1` instead of `0`) between an uploaded MEI and a scholarly edition reference. Deferred: piano repertoire (the first corpus) carries no printed measure numbers in editions, so there is no external reference to mismatch against; the normalizer already handles the structural pickup-bar case. The problem to solve — and the right shape of tool — will be clearer once a corpus with printed, edition-specific numbering is actually ingested. Revisit at that point.

---

## Relevant ADRs and architecture docs

Cross-checked and cited from the plan below:

- `ADR-002` (file storage) — object-key convention, MinIO/R2 parity, signed-URL handling, preview key structure.
- `ADR-004` (music21 pipeline trigger) — on-upload Celery trigger, `movement_analysis` as single source of truth for harmony, smart-merge policy on re-analysis. The trigger mechanism is implemented now; the music21 branch of the dispatcher is stubbed until Component 6.
- `ADR-005` (sub-measure precision) — `beat_start`/`beat_end` are in-use from the first annotation session, so the upload pipeline populates `duration_bars` on `movement` correctly to support beat-level validation later.
- `ADR-008` (fragment preview generation) — preview key structure (`{corpus_slug}/{work_id}/{movement_id}/previews/{fragment_id}.svg`). Confirms that Component 1's storage client is the same one Component 2 and Component 7 will reuse.
- `ADR-009` (DCML licensing) — per-event `source` on `movement_analysis.events` must be set to `"DCML"` for every row ingested from `harmonies.tsv`; `corpus.licence` must be set to `CC-BY-SA-4.0`; the ABC (Beethoven string quartets) corpus must be refusable at ingest time with a clear error.
- `docs/architecture/mei-ingest-normalization.md` — authoritative specification for the normalizer; not restated below.
- `docs/architecture/corpus-and-analysis-sources.md` — source priority (DCML > When in Rome > music21 auto > manual), the Mozart pipeline (`.mscx → .mxl → .mei` via `mscore` + Verovio CLI), and the DCML notation-normalisation mappings (`V7(9)`, `V/V`, borrowed chords, phrase markers).
- `docs/architecture/fragment-schema.md` — the `movement_analysis.events` row shape and the consequences for harmony-bearing fragments.

---

## Step 1 — Pydantic metadata models

Create `backend/models/ingestion.py` containing the metadata Pydantic v2 models that validate the YAML sidecar. The three-level hierarchy below mirrors the PostgreSQL schema but is distinct: these models are the *import format*, not the persisted form. The Pydantic layer is the guard between the upload ZIP and the database.

```
ComposerMetadata
  slug, name, sort_name, birth_year, death_year, nationality, wikidata_id

CorpusMetadata
  slug, title, source_repository, source_url, source_commit,
  analysis_source: Literal["DCML", "WhenInRome", "music21_auto", "none"],
  licence: str  # validated as SPDX; "CC-BY-SA-4.0" for DCML
  licence_notice, notes

WorkMetadata
  slug, title, catalogue_number, year_composed, year_notes,
  key_signature, instrumentation, notes,
  movements: list[MovementMetadata]

MovementMetadata
  slug, movement_number, title, tempo_marking, key_signature, meter,
  mei_filename: str,        # path within the ZIP, relative to its root
  harmonies_filename: str | None   # DCML TSV path within the ZIP; None if analysis_source != "DCML"
```

Validators enforce:

- `slug` values match `^[a-z0-9][a-z0-9-]*$` at every level. Slug collisions within a parent are flagged by the Pydantic layer before any DB write.
- `catalogue_number` is free-form (Köchel, BWV, opus, etc.) per `phase-1.md`; no separate `opus_number` field.
- `analysis_source` and `licence` are consistent: a DCML corpus must carry `CC-BY-SA-4.0`; a DCML corpus that declares `analysis_source != "DCML"` is rejected.
- `ABC` (Beethoven string quartets) is refusable by slug pattern: if `source_repository` matches DCML's ABC path, the corpus-preparation script refuses to package it for ingestion and the upload endpoint refuses it on receipt. See ADR-009.

`MovementMetadata.mei_filename` is required because the uploader is free to lay the ZIP out however is convenient for the source repository; the Pydantic model is what resolves "which file is which movement."

**Verification.** Unit tests in `backend/tests/unit/test_ingestion_models.py`: one YAML fixture per legal case, one per each validation error.

---

## Step 2 — Object storage client

Create `backend/services/object_storage.py` — a thin wrapper around `aioboto3` that exposes the only four operations Component 1 and Component 2 need:

```python
async def put_mei(key: str, content: bytes) -> None: ...
async def put_mei_original(key: str, content: bytes) -> None: ...  # key goes under /originals/
async def get_mei(key: str) -> bytes: ...
async def signed_url(key: str, expires_in: int = 300) -> str: ...
```

The client reads `R2_ENDPOINT_URL`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` from the environment. In local dev these point at MinIO; in staging/production they point at Cloudflare R2. No code branches on environment (per ADR-002).

Key convention:

- Normalized MEI: `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei`
- Original (pre-normalization): `originals/{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei`
- Preview (written by Component 2/Component 7, not here): `{corpus_slug}/{work_id}/{movement_id}/previews/{fragment_id}.svg`

`movement.mei_object_key` and `movement.mei_original_object_key` are both populated by the upload pipeline. Nothing else reads `mei_original_object_key` in Phase 1; it exists for provenance and for re-running the normalizer after a spec update.

**Verification.** Integration test against the Dockerized MinIO: round-trip a known byte string; confirm keyspace matches. The test fixture creates a temporary bucket per test run and tears it down on exit.

---

## Step 3 — MEI validation pipeline

Create `backend/services/mei_validator.py`. A single public function:

```python
def validate_mei(xml_bytes: bytes) -> ValidationReport:
    """Apply all MEI validation rules; return a structured report."""
```

Validation runs in this order and short-circuits on any hard failure:

1. **Well-formed XML** — `lxml.etree.fromstring`. Failure here is `INVALID_XML`.
2. **MEI RelaxNG schema** — load the MEI 5.x RelaxNG schema from `backend/resources/mei-all.rng` (committed with the repo; document the version and upstream source in the file header). Failure is `SCHEMA_VIOLATION` with the failing element's XPath.
3. **Measure number integrity** — every `<measure>` has an integer `@n`. Gaps allowed unless they exceed 10 consecutive (per `mei-ingest-normalization.md` §5); duplicates outside `<ending>` elements are flagged. Non-integer `@n` values (e.g. `"12a"`) are flagged, not auto-corrected.
4. **Staff-count consistency** — the number of staves in `<scoreDef>` matches the staves present in every `<measure>`.
5. **Encoding sanity** — at least one `<note>` or `<rest>` exists.

`ValidationReport` distinguishes *errors* (reject the file) from *warnings* (accept but surface). The normalizer (Step 4) consumes the same report type and extends it with its own auto-correction entries.

Error codes use the enum in `backend/models/errors.py` so the upload endpoint's envelope (`{"error": {"code": ..., ...}}`) is populated directly from the validation layer without rewriting.

**Verification.** Unit tests against a matrix of MEI fixtures in `backend/tests/fixtures/mei/`: one valid file, one per error class, one per warning class. Fixtures are minimal hand-written MEI snippets, not full Mozart movements.

---

## Step 4 — MEI normalizer

Implement the normalizer at `backend/services/mei_normalizer.py` per the full specification in `docs/architecture/mei-ingest-normalization.md`. The public signature is the one already documented:

```python
def normalize_mei(source_path: str, output_path: str) -> NormalizationReport:
```

Implementation must be idempotent: running the normalizer on an already-normalized file produces byte-identical output and a `NormalizationReport` with `is_clean=True` and no changes applied. This is the single hardest property to preserve, and it must be covered by a round-trip test.

Normalizer enforces (in document order, per the spec):

1. Pickup bar: `@n="0"` + `@metcon="false"`, renumbering subsequent measures if the source used `@n="1"` for the pickup.
2. Meter change propagation: insert `<meterSig>` children into measures whose meter changes are expressed only as `<staffDef>` updates.
3. `<ending>` auto-correction: assign `@n` sequentially only when `<ending>` elements have no `@n`; all other ending structure issues (zero measures, non-sequential numbers, missing second ending) are flagged, not corrected.
4. Repeat-barline pairing: flag unpaired `rptstart` and any `rptend` after the first that lacks a matching `rptstart`; treat `rptboth` as a combined `rptend`+`rptstart` event (consuming one open section and opening a new one). The first `rptend` or `rptboth`-as-close is always allowed to be unpaired.
5. `@n` uniqueness outside `<ending>` elements: flag duplicates; flag gaps exceeding 10; flag non-integer values.
6. `@n` values inside `<ending>` elements: strip alphabetic suffixes from suffix-style values (e.g. `"12a"` → `"12"`) as an auto-correction; flag unparseable non-integer values; flag duplicates within a single ending (duplicates across different endings are expected and not flagged).
7. Incomplete measures at repeat boundaries: when a measure adjacent to an `rptend`/`rptboth` barline already carries `@metcon="false"`, search for its complement after the matching `rptstart`/`rptboth`-as-open; set `@metcon="false"` on the complement if missing; flag cases where no complement can be identified. Beat-counting is not attempted — detection relies solely on `@metcon="false"` already present in the source (see `docs/architecture/mei-ingest-normalization.md` §7 for rationale).

The normalizer never touches musical content, `xml:id` values, or encoding style.

**`<harm>` element handling (deferred).** MuseScore-sourced MEI files from DCML corpora contain `<harm>` elements that originate from the Roman-numeral annotations embedded in the `.mscx` source. Verovio renders these by default, producing visual clutter that conflicts with the tagging UI's own annotation layer. The target resolution is to strip `<harm>` elements in the normalizer for corpora where `analysis_source` is `"DCML"` or `"WhenInRome"` — corpora where the authoritative harmony record is `movement_analysis.events`, not score-embedded text. However, this must not extend to corpora where `<harm>` carries original source material (e.g. figured bass in baroque scores), and the situation is more complex still for a score that carries *both* original figured bass and superimposed DCML annotations — the two are indistinguishable at the MEI level. This problem is deferred until the first baroque corpus is ingested. When that work begins, revisit this section and implement conditional stripping keyed on `analysis_source`, with a documented exemption policy for original figured bass.

**Duration metadata.** After normalization, the function emits the **maximum integer `@n` value found across all measures in the document** (inside and outside `<ending>` elements) as `NormalizationReport.duration_bars`. This is stored as `movement.duration_bars` and is what the service layer uses to reject fragments that overshoot the movement without re-parsing the MEI on every write (per `tech-stack-and-database-reference.md`). Using the maximum rather than the last `@n` outside endings is necessary because pieces frequently end inside a final or second ending. See `docs/architecture/mei-ingest-normalization.md` §Implementation for full rationale.

**Verification.** Test suite at `backend/tests/unit/test_mei_normalizer.py` — one fixture per normalization rule, each asserting both the correction applied and idempotence on a second pass. Plus: the real Mozart K. 331 first movement exercised end-to-end as an integration test.

---

## Step 5 — Measure-number correction utility (deferred)

Not implemented in Component 1. See the *Explicitly deferred* section above for rationale.

---

## Step 6 — DCML corpus-preparation pipeline

Create `scripts/prepare_dcml_corpus.py`. This is the corpus-setup script that runs on a developer workstation (not in the API) and produces a well-formed upload ZIP from a cloned DCML repository.

Inputs:

- Local path to a cloned DCML repository (e.g. `~/src/mozart_piano_sonatas`).
- Composer and corpus metadata (supplied as a small TOML config alongside the script; e.g. `scripts/dcml_corpora/mozart-piano-sonatas.toml`).

Pipeline:

1. Walk the DCML repo's `MS3/` directory for `.mscx` files.
2. For each `.mscx`: convert to MusicXML via `mscore --export-to movement.mxl movement.mscx` (MuseScore 3.6.2 headless).
3. Convert the MusicXML to MEI via `verovio --to mei movement.mxl -o movement.mei`.
4. Locate the matching `harmonies/*.tsv` file (DCML naming convention is 1:1 with the score files).
5. Assemble the upload ZIP:

   ```
   mozart-piano-sonatas.zip
     metadata.yaml
     mei/k331/movement-1.mei
     mei/k331/movement-2.mei
     ...
     harmonies/k331/movement-1.tsv
     harmonies/k331/movement-2.tsv
     ...
   ```

6. Emit a preparation report listing conversions done, files skipped, and the git SHA of the source repo (written into `corpus.source_commit` at ingest time).

Measure-number fidelity must be verified at each conversion step (per `corpus-and-analysis-sources.md`). The preparation script runs `validate_mei()` from Step 3 on every emitted `.mei` file and aborts with a descriptive error if any file would fail the upload endpoint's own validation. This catches conversion regressions locally rather than in the ingest endpoint.

**ABC refusal.** The script checks the source repository slug against a deny-list (currently just `ABC`/`beethoven_string_quartets`) and refuses to package that corpus. The deny-list is also enforced at the upload endpoint as a defence in depth, but the preparation script is where it is *first* enforced so that nobody even assembles a ZIP of ABC material.

**Verification.** The script is covered by a smoke test that runs it against a fixture subset of the Mozart repo (one or two movements, committed under `backend/tests/fixtures/dcml-subset/`). This also serves as the reproducible input to the integration tests in Step 9.

---

## Step 7 — Upload endpoint

Create `backend/api/routes/corpora.py` with one endpoint:

```
POST /api/v1/composers/{composer_slug}/corpora/{corpus_slug}/upload
```

Dependencies:

- `require_role("admin")` — no other role is permitted to ingest.
- Accepts `multipart/form-data` with a single file field `archive` containing the ZIP produced by Step 6.

Handler outline (route handler stays thin; all logic in `backend/services/ingestion.py`):

```python
@router.post("/{composer_slug}/corpora/{corpus_slug}/upload",
             status_code=201,
             response_model=IngestionReport,
             dependencies=[Depends(require_role("admin"))])
async def upload_corpus(
    composer_slug: str,
    corpus_slug: str,
    archive: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> IngestionReport:
    return await ingestion_service.ingest_corpus(
        composer_slug=composer_slug,
        corpus_slug=corpus_slug,
        archive_bytes=await archive.read(),
        db=db,
    )
```

`ingestion_service.ingest_corpus` performs the seven-step upload workflow from `phase-1.md` Component 1 §"Upload Workflow":

1. Unpack the ZIP into a `tempfile.TemporaryDirectory`.
2. Parse and validate `metadata.yaml` against `CorpusMetadata` (Step 1). On failure, reject the whole ZIP.
3. For each movement in the metadata:
   - Run `validate_mei(mei_bytes)` (Step 3). On error, reject just this movement and continue collecting.
   - Run `normalize_mei()` (Step 4). Warnings go into the per-movement ingestion report entry.
4. **Intra-corpus coherence checks.** After all per-movement checks pass: every work shares the same `composer_slug`, catalogue numbers are unique within the corpus, year ranges fall within the composer's lifetime (if `birth_year`/`death_year` are known), and `corpus.licence` matches the well-known licence for the declared `source_repository`. Coherence failures reject the whole ZIP; they are not per-movement.
5. **Write in a single database transaction.**
   - Upsert `composer` row (`MERGE`-style: `INSERT ... ON CONFLICT (slug) DO UPDATE ...`) so re-ingesting a corpus does not create duplicate composer rows.
   - Upsert `corpus` row keyed on `(composer_id, slug)`.
   - Upsert `work` rows keyed on `(corpus_id, slug)`.
   - Insert `movement` rows; if a movement already exists (re-ingest), update `mei_object_key`, `mei_original_object_key`, `duration_bars`, `normalization_warnings`, and `ingested_at`.
   - Write original MEI to `originals/{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei` via `put_mei_original`.
   - Write normalized MEI to `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei` via `put_mei`.
   - The DB transaction commits after object storage writes succeed. If any storage write fails, the transaction is rolled back; we do not want a DB row pointing at a key that does not exist.
6. **Enqueue the analysis-ingestion task per movement** (see Step 8). The task is dispatched by `corpus.analysis_source`; for DCML corpora the task receives the raw `harmonies.tsv` content as an argument (so the tempdir can be cleaned up immediately). For any other `analysis_source` the task is a no-op in Phase 1.
7. **Return the ingestion report**, structured as a Pydantic model so the FastAPI response-model machinery writes clean JSON:

```json
{
  "corpus": { "composer_slug": "mozart", "corpus_slug": "piano-sonatas" },
  "movements_accepted": [
    { "movement_slug": "k331/movement-1", "warnings": [...] }
  ],
  "movements_rejected": [
    { "movement_slug": "k332/movement-2", "errors": [{ "code": "SCHEMA_VIOLATION", ... }] }
  ],
  "coherence_warnings": [],
  "source_commit": "a1b2c3d4"
}
```

This shape is also the response the API returns on partial success. A ZIP where some movements pass and some fail is a 201 with the full report; a ZIP that fails at the metadata step or coherence step is a 422 with the standard error envelope.

**Error envelope.** All rejections use the project's standard `{"error": {"code": ..., "message": ..., "detail": {...}}}` envelope from `backend/models/errors.py`. The `detail` field is where per-movement and per-measure specifics live.

**Idempotence.** Re-uploading the same ZIP is safe. Movement rows are updated in place; normalized MEI files are overwritten. The only observable effect of a re-upload is an `ingested_at` bump and whatever the normalizer would apply to a now-updated source. The analysis-ingestion task re-runs under the smart-merge policy (Step 8), preserving manual and reviewed events.

---

## Step 8 — Analysis ingestion (provenance-dispatched)

This is the step where the Component 6 deferral is made structural.

Create a single Celery task at `backend/services/tasks/ingest_analysis.py`:

```python
@celery_app.task(name="ingest_analysis")
def ingest_movement_analysis(
    movement_id: str,
    analysis_source: Literal["DCML", "WhenInRome", "music21_auto", "none"],
    harmonies_tsv_content: str | None = None,
) -> None:
    """Populate movement_analysis.events for a single movement.

    Dispatches on analysis_source. Implemented in Phase 1 for DCML only;
    WhenInRome and music21_auto raise NotImplementedError deliberately and
    are filled in when the matching corpus is first ingested (Component 6
    for music21_auto).
    """
    if analysis_source == "DCML":
        events = _parse_dcml_harmonies(harmonies_tsv_content)
    elif analysis_source == "WhenInRome":
        raise NotImplementedError("When in Rome ingestion deferred until first non-DCML corpus.")
    elif analysis_source == "music21_auto":
        raise NotImplementedError("music21 auto-analysis deferred to Component 6.")
    elif analysis_source == "none":
        return  # no expert analysis, no music21 fallback yet — movement has no analysis row
    else:
        raise ValueError(...)

    _upsert_movement_analysis(movement_id, events, music21_version=music21.__version__)
```

The dispatch shape is the small investment that makes the Component 6 deferral clean:

- Phase 1 implements the `"DCML"` branch only. It is the only branch exercised by the Mozart ingest and therefore the only one that must be production-quality now.
- `"music21_auto"` raises deliberately. When Component 6 begins, the fix is to replace the `raise` with the music21 preprocessing call — the trigger, the task shape, the Celery wiring, the `movement_analysis` upsert logic, and the smart-merge policy are already in place and under test. This matches ADR-004's intent ("the trigger is on MEI upload") without requiring music21 on the critical path of the first ingest.
- `"WhenInRome"` is a documented hole for the first non-DCML, non-original corpus.

**DCML parser.** `_parse_dcml_harmonies(tsv: str) -> list[Event]` uses `ms3`'s TSV reading helpers (or a thin `csv.DictReader` wrapper — the format is stable and small) and maps each row to the `movement_analysis.events` shape documented in `fragment-schema.md`:

```json
{
  "mc": 18, "mn": 17, "volta": null,
  "beat": 3.0,
  "local_key": "D minor",
  "root": 2, "quality": "minor", "inversion": 1,
  "numeral": "ii6",
  "root_accidental": null, "applied_to": null, "extensions": [],
  "bass_pitch": null, "soprano_pitch": null,
  "source": "DCML", "auto": false, "reviewed": false
}
```

The DCML TSV columns map to event fields as follows:

- `mc` → `mc` (linear measure count; the stable unique key for smart-merge on DCML events)
- `mn` → `mn` (notated measure number; maps to MEI `<measure @n>`)
- `volta` → `volta` (ending number if the event falls inside a `<ending>` element; `null` otherwise — derived from the DCML `volta` column)
- `beat` → `beat`
- `localkey` → `local_key`
- `globalkey` → cross-checked against `movement.key_signature` (same canonical format, e.g. `"A major"`). If `movement.key_signature` is null, populate it from `globalkey`; if it is already set and disagrees, write a `harmony_alignment_warnings` entry — a mismatch here indicates a data-quality problem in the corpus package rather than a normalisation issue. Not stored on `movement_analysis`; the movement row is the right home for a movement-level key fact.

Notation-normalisation mappings (from `corpus-and-analysis-sources.md`) are applied here:

- `V7(9)` → `numeral: "V7"`, `extensions: ["9"]`.
- `V/V` → `numeral: "V"`, `applied_to: "V"`.
- Flat/sharp numeral prefix (`bVII`, `#IV`) → `root_accidental: "flat"` / `"sharp"` with the prefix stripped from `numeral`. Do not set any "borrowed" flag; that interpretation requires tonal context and belongs in the knowledge graph.
- Phrase markers `{` / `}` are *not* written into `movement_analysis.events` — those are boundaries, not events. They are retained in the ingestion report so that, later, a phrase-boundary hint endpoint can surface them to the tagging UI as candidate fragment boundaries (per `corpus-and-analysis-sources.md`).

`bass_pitch` and `soprano_pitch` are not present in DCML TSV files; always set them to `null` for DCML-sourced events. When Component 6 is built and music21 is available, a top-up job can fill them in without changing `source`.

**Alignment verification.** `_parse_dcml_harmonies` receives both the TSV content and the normalised MEI bytes. After parsing, a verification pass builds a map of `(mn, volta) → xml:id` by walking the MEI, then checks that every TSV row's `(mn, volta)` pair resolves to a known measure. Mismatches — which indicate a normalisation renumbering mismatch between the DCML TSV and the MEI — are collected and written to a `harmony_alignment_warnings` field in the ingestion report rather than failing hard. The field is empty for a clean ingest; non-empty means the ingest succeeded but alignment should be inspected before tagging begins on the affected movement.

**Smart-merge on re-analysis.** The upsert applies the ADR-004 policy faithfully: events where `source = "manual"` or `reviewed = true` are preserved unchanged; other events are replaced; new events are inserted; disappeared-but-reviewed events are preserved and flagged. The policy is implemented in a single place (`_merge_events`) and tested explicitly.

**Verification.**

- Unit: `_parse_dcml_harmonies` against representative `harmonies.tsv` rows covering each notation mapping (`V7`, `V/V`, `bVI`, phrase markers, secondary dominants).
- Unit: `_merge_events` against synthesised before/after event lists covering each branch of the smart-merge policy.
- Integration: full-pipeline test ingests the Mozart K. 331 movement-1 ZIP (built by Step 6) and asserts `movement_analysis.events` has the expected row count and a spot-checked chord at a known bar/beat position.

---

## Step 9 — End-to-end test

One integration test in `backend/tests/integration/test_corpus_ingestion.py`:

```
Given: a fixture ZIP (K. 331 movements 1–2, plus K. 283 movement 2) built by scripts/prepare_dcml_corpus.py
When:  POST /api/v1/composers/mozart/corpora/piano-sonatas/upload (as admin)
Then:  - 201 with an ingestion report listing all movements under movements_accepted
       - composer/corpus/work/movement rows exist with the expected slugs
       - both normalized MEI files are readable from MinIO under the expected keys
       - both original MEI files exist under originals/
       - movement_analysis.events is populated with source="DCML" entries for each movement
       - movement.duration_bars equals the maximum integer @n found anywhere in the normalized MEI (inside or outside endings)
       - Re-running the same POST is idempotent (no duplicate rows; ingested_at advances)
       - harmony_alignment_warnings is empty for all movements in the report
       - For K. 283 movement 2 (which has first and second endings): events covering measures that
         appear in both endings carry distinct mc values and correct volta values (volta=1 for first-
         ending events, volta=2 for second-ending events); the mn values repeat across the two ending
         groups as expected. Spot-check at least one (mn, volta) pair against the known TSV content.
```


---

## Sequencing

```
Day 1: Metadata models (Step 1) + object storage client (Step 2)
Day 2: MEI validator (Step 3)
Day 3: MEI normalizer (Step 4), including the idempotence round-trip test
Day 4: DCML corpus-preparation script (Step 6) + fixture subset
Day 5: Upload endpoint + ingestion service (Step 7)
Day 6: Analysis ingestion task — DCML branch + smart-merge (Step 8)
Day 7: End-to-end integration test (Step 9); run the full Mozart piano sonatas ingest in staging
```

Steps 1 and 2 are the only ones that can safely run in parallel. Steps 3–5 depend on Step 1 (the metadata layer) and on each other's contracts. Step 6 needs Step 3 available as a preflight check. Steps 7 and 8 depend on everything above.

Component 2 (Corpus Browsing) and Component 4 (Knowledge Graph) can begin as soon as the end-to-end integration test passes; Component 3 (Verovio + MIDI) can begin once a normalized MEI file is readable from R2. The tagging tool (Component 5) remains the last integration point.

---

## How the music21/Component 6 deferral plays out

Summarising the structural decisions above, so the deferral is traceable:

1. **ADR-004 stands as written.** The trigger is still on MEI upload, the task is still dispatched via Celery, and `movement_analysis` is still the single source of truth for harmony. The deferral is about the *body* of the task, not the trigger.
2. **Step 8's dispatcher is the single extension point.** When Component 6 begins, the only code change is to replace `raise NotImplementedError` in the `"music21_auto"` branch with the actual music21 preprocessing call, and to populate `corpus.analysis_source = "music21_auto"` (or `"none"`) in the relevant corpus's metadata. No other file in the pipeline changes.
3. **The Mozart first case exercises every load-bearing piece of the pipeline that matters in Phase 1.** Validation, normalization, upload, transactional writes, object storage, ingestion-report shape, licence propagation, and `movement_analysis` population are all exercised end-to-end by the DCML branch. The only thing that is *not* exercised is the music21 branch itself, which is precisely the code Component 6 will add.
4. **If a non-DCML corpus is ingested before Component 6 is done**, the upload succeeds but `movement_analysis` is not populated. The tagging tool surfaces this (harmony panel empty, review gate vacuous) and annotators can still create fragments. When Component 6 lands, a one-line script enqueues `ingest_movement_analysis` for every movement where `movement_analysis` is missing, and the smart-merge policy ensures any manual work already done is preserved.
5. **The dev roadmap order is not changed.** Components 3–4 and 5–6 can be built in parallel exactly as `phase-1.md` specifies. Component 6 still gates the tagging tool's full integration (Component 5 §5.5: the music21 summary panel), but the *fragment data model* (Component 7) does not depend on music21 running — the `summary` JSONB carries no harmony, and harmony is sliced from `movement_analysis` at read time. A tagging session against a DCML-ingested movement is already fully functional after Component 1 + Components 3–5 are complete.

The practical implication for the roadmap is that Component 6 can slip later into Phase 1 (or, if pressed, into the start of Phase 2) without blocking any user-visible Phase 1 workflow, *provided* every corpus ingested during that window is DCML or When-in-Rome-covered. The Mozart piano sonatas satisfy this constraint. If the project chooses to ingest a non-annotated corpus before Component 6 ships, that decision is what accelerates Component 6 onto the critical path — not the MEI ingestion infrastructure itself.

---

## Hard gates before Component 2 begins

1. The Mozart piano sonatas ingest end-to-end against staging (Supabase + Cloudflare R2), producing the expected composer/corpus/work/movement rows and populated `movement_analysis.events` for every movement.
2. The normalization report for every movement is captured in `movement.normalization_warnings` so that Component 5's tagging UI can surface the status to annotators per `mei-ingest-normalization.md` §Implementation.

Once these gates pass, Component 2 can start rendering what the corpus browser needs on top of the persisted composer/corpus/work/movement hierarchy.
