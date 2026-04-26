# Doppia Code Review — Report 3: Architecture Decision Records

## Summary

**Scope.** This report covers all 13 ADRs in `docs/adr/` (ADR-001 through ADR-013, all marked Accepted), evaluated for: (a) internal consistency, (b) consistency with each other, (c) consistency with the code that implements them, and (d) consistency with cross-referenced documents and roadmap items. It also touches the production Dockerfile and `requirements.txt` where the auth and Verovio ADRs land.

**General view.** The ADR set is unusually well-written. Each follows the same Context → Decision → Consequences → Alternatives structure; alternatives are evaluated honestly rather than serving as straw-men; cross-references between ADRs are dense and mostly correct (ADR-008 links to ADR-002 and ADR-004; ADR-013 links to ADR-008 and to a normalization-research note; ADR-009 links to the corpus-and-analysis-sources doc). The ADRs reflect genuine design thinking, not retrofitted justifications. This is rare and worth keeping.

The problems are concentrated in three places. **First, ADR-006 (i18n) is unimplemented despite being marked "Accepted" with an explicit "Phase 1 (immediately)" implementation list** — the migrations contain no translation tables and no `language` columns. **Second, the migration comment for `fragment.beat_start` / `beat_end` follows the *original* ADR-005 plan, not the superseding decision**, and `roadmap/phase-1.md` is internally inconsistent on the same point. **Third, a production-blocking bug**: `python-dotenv` is in `requirements-dev.txt` only, but `backend/main.py` and `backend/services/celery_app.py` import it unconditionally at module load — the production Docker image will fail on container start.

The other findings are smaller: stale ADR-001 referencing the wrong env-var name (same bug as the README), a minor mismatch between ADR-002 and the actual storage-key conventions in code, ADR-004's implicit assumption that all analysis is music21-driven (now superseded in spirit by ADR-009 and the actual DCML-first dispatch), and a missing "historical artefact" file referenced by ADR-011.

---

## Issue 1: ADR-006 (Internationalisation) is unimplemented despite "Phase 1 (immediately)" status

**Issue.** ADR-006 is marked Accepted (2026-04-12) and contains an explicit "What Gets Built When" section. Under "Phase 1 (immediately)" it lists:

- `language` column added to `fragment`, `blog_post`, and any future prose-bearing tables; default `'en'`
- Translation tables for concept, schema, and value nodes scaffolded in PostgreSQL
- Seeding script populates English records in translation tables for every concept seeded
- Service layer applies translation overlay on all concept-returning API calls; language parameter accepted but only `'en'` is valid
- `Accept-Language` header honoured by API from first endpoint written
- `fragment_annotation_translation` table scaffolded; populated with English records when annotations are submitted

`grep -E "language|translation" backend/migrations/versions/0001_initial_schema.py` returns zero matches. There is no `language` column on `fragment`. There is no `concept_translation`, `property_schema_translation`, `property_value_translation`, or `fragment_annotation_translation` table. There is no translation-overlay logic in any service. There is no `Accept-Language` handling in the API layer.

The blog table doesn't exist either — but that's expected; ADR-006's blog-table guidance applies whenever it's built. The fragment-table omission is the load-bearing one: the ADR specifically warns that *"scaffolding them now costs almost nothing and avoids a schema migration when the first second-language content is introduced."* Adding `language` after annotations have been written will be a backfill migration.

**Solution.** Three options, in increasing investment:

1. **Demote ADR-006 to "Proposed"** until the work is actually done. The current "Accepted" + "Phase 1 (immediately)" status is misleading.
2. **Implement the minimum viable version of the Phase 1 list now**, while the schema is still Phase 1 and no production fragment data exists. Concretely: add a migration `0003_i18n_scaffolding.py` with the four translation tables, add `language` column to `fragment`, default `'en'`. No service-layer logic required yet — the columns and tables can stay empty.
3. **Implement the full Phase 1 list**, including the `Accept-Language` handling and the seed-script overlay logic.

Recommendation: **option 2**. Schema-only scaffolding takes 30 minutes, defends the ADR's central claim that the cost of doing it later is higher, and removes the doc-vs-code drift.

**Verification.** After the migration: `\d fragment` shows a `language` column with default `'en'`; the four translation tables exist; running migrations on a fresh DB succeeds; the existing test suite still passes (no tests should depend on the absence of these columns). If demoting to Proposed instead, update the ADR header and add a "Status note" explaining the deferral.

---

## Issue 2: `fragment.beat_start` / `beat_end` migration comment contradicts ADR-005

**Issue.** `backend/migrations/versions/0001_initial_schema.py` line 245:

```python
# Phase 1 leaves beat_start/beat_end null (ADR-005).
sa.Column("beat_start", sa.Float, nullable=True),
sa.Column("beat_end", sa.Float, nullable=True),
```

The comment says ADR-005 mandates leaving these null in Phase 1. ADR-005 says **the opposite**. Its full title is "Sub-Measure Selection Precision in the Tagging Tool" and the Decision section (line 28–32) reads:

> Implement beat-level and sub-beat-level selection precision in Phase 1 of the tagging tool. The nullable `beat_start`/`beat_end` columns are promoted to used fields from the first annotation session.

The migration comment encodes the **original deferral plan** that ADR-005 explicitly supersedes (its header says: *"Supersedes: Initial deferral of sub-measure precision to Phase 2"*).

The columns themselves are correctly nullable — that's still ADR-005 conformant (line 67: *"`beat_start` and `beat_end` may remain null if the annotator makes a measure-level selection only"*). It's the **comment** that's wrong, and a future contributor reading only the migration would conclude that beat-level work is deferred.

**Solution.** Replace the comment with the actual policy:

```python
# beat_start/beat_end are nullable: null means "the full extent of the
# measure range" (ADR-005 §"Nullable convention"). Sub-beat selection is
# implemented in Phase 1; null is reserved for concepts whose granularity
# does not warrant sub-measure precision (e.g. formal sections).
```

**Verification.** Doc review against ADR-005 line 67. Also: search for other comments/docs encoding the original deferral.

---

## Issue 3: `roadmap/phase-1.md` contradicts itself and ADR-005 on the same topic

**Issue.** `docs/roadmap/phase-1.md` line 421 (in the "Rhythmic subdivision grid" subsection) reads:

> **Decision (ADR-005):** implement measure-level precision in Phase 1; extend to beat-level in Phase 2.

But ADR-005's actual Decision section says implement beat-level **in Phase 1**. The same `phase-1.md` file at line 697 has:

> | Sub-measure precision | Implement beat-level and sub-beat-level selection in Phase 1; `beat_start`/`beat_end` are populated from the first annotation session | ADR-005 |

So the document is internally inconsistent on the same decision: line 421 has the old plan, line 697 has the new plan. The migration comment from Issue 2 follows line 421's stale claim.

**Solution.** Update line 421 to match ADR-005 and line 697:

> **Decision (ADR-005):** implement beat-level and sub-beat-level precision in Phase 1. `beat_start` / `beat_end` columns are nullable (null = "full extent of the measure range") but populated from the first annotation session. The original deferral to Phase 2 is superseded — see ADR-005 for the rationale.

**Verification.** `grep -n "ADR-005\|beat-level\|sub-measure" docs/roadmap/phase-1.md` should show consistent claims at every match. Add a CI lint that warns when a roadmap document references an ADR ID — it's a hint to verify the summary is current.

---

## Issue 4: `python-dotenv` is in dev requirements only, but imported by production code paths

**Issue.** `backend/requirements.txt` does not include `python-dotenv`. `backend/requirements-dev.txt` line 7 does. But `backend/main.py` line 20 has:

```python
from dotenv import load_dotenv
```

at module top-level, executed unconditionally at import time. `backend/services/celery_app.py` line 21 does the same. The production Dockerfile (`backend/Dockerfile`) installs only `requirements.txt`:

```
COPY backend/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
```

Production container start sequence: `uvicorn main:app` → imports `main` → hits line 20 → `ImportError: No module named 'dotenv'` → process exits.

This is a deployment-blocking bug. It hasn't surfaced because nothing has been deployed yet (`fly.toml` is in the repo but no production traffic).

**Solution.** Two options:

1. **Move `python-dotenv` to `requirements.txt`.** It's tiny (a few KB), no transitive deps, no security exposure. Loading a `.env` file in production is a no-op if the file doesn't exist — `load_dotenv()` returns `False` and continues. This is the simplest fix and matches the pattern of other small utilities in `requirements.txt`.

2. **Make the import conditional.** Replace:

```python
from dotenv import load_dotenv
load_dotenv(...)
```

with:

```python
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent.parent / ".env")
except ImportError:
    pass  # dotenv only present in dev; production reads env from the runtime
```

Recommendation: option 1. The dependency overhead is negligible and the conditional-import pattern complicates two files.

**Verification.** Build and run the production Docker image:

```bash
docker build -f backend/Dockerfile -t doppia-backend-prod .
docker run --rm -e DATABASE_URL=... doppia-backend-prod python -c "import main"
```

Currently fails. After the fix it should succeed.

---

## Issue 5: ADR-001 references `ENVIRONMENT=development` but code requires `ENVIRONMENT=local`

**Issue.** ADR-001 line 51:

> The solution is the `AUTH_MODE=local` bypass documented in the README: when `ENVIRONMENT=development`, the backend accepts a fixed development token.

`backend/api/middleware/auth.py` line 85 explicitly checks `if environment != "local"` and rejects with 401. Same bug as Report 1 Issue 2 (README) — the doc layer is consistent in being wrong. Three files (README, ADR-001, the actual code) and only the code uses `local`.

**Solution.** Update ADR-001 line 51 to say `ENVIRONMENT=local`. The code is the source of truth.

**Verification.** `grep -rn "ENVIRONMENT=development\|ENVIRONMENT=local" docs/ README.md backend/` — every reference should say `local`.

---

## Issue 6: ADR-002 storage-key conventions don't fully match the code

**Issue.** ADR-002 line 39 specifies the MEI key format:

```
{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei
```

ADR-002 line 68 mentions a parallel key for previews:

```
{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/preview.svg
```

`backend/services/object_storage.py` lines 12–17 documents **four** key conventions:

```
- Normalized MEI:  {composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei
- Original MEI:    originals/{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei
- Incipit SVG:     {composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/incipit.svg
- Preview SVG:     {composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/preview.svg
```

The `originals/` prefix and the `incipit.svg` key are not in ADR-002. Both are now used in production code: `services/ingestion.py` line 504 stores `originals/{mei_object_key}`; `services/tasks/generate_incipit.py` writes `incipit.svg` files.

ADR-008 covers preview generation but doesn't explicitly cover incipits (incipits aren't fragment previews — they're per-movement first-page renders for the browse view). There's no ADR for the `originals/` prefix.

**Solution.** Two parts:

1. **Add an addendum or supersede ADR-002** with the full key inventory — original MEI, normalized MEI, incipit SVG, preview SVG. Each with its rationale (originals preserved for audit; incipit different from preview because it's per-movement, not per-fragment).
2. **Optionally add ADR-014** for the `originals/` retention policy if it's a meaningful editorial decision (which it is — "we keep the pre-normalization MEI forever in case the normalizer has bugs we discover later" is a real choice).

**Verification.** A reader can find justification for every key path in `services/object_storage.py` lines 12–17 by following ADR cross-references. Currently they can find justification for two of four.

---

## Issue 7: ADR-004 is implicitly superseded by ADR-009 + the actual analysis dispatch

**Issue.** ADR-004 ("music21 Preprocessing Pipeline Trigger") is dated 2026-03-27 and assumes **music21 is the analysis engine**. Title, abstract, and Decision section all describe a music21 task triggered on MEI upload. The smart-merge policy (lines 56–60) is described in terms of `source = "music21_auto"` vs `"manual"` etc.

ADR-009 (2026-04-14) and the corpus-and-analysis-sources document introduced **DCML and WhenInRome as primary analysis sources, with music21 as a fallback for corpora that have neither**. The actual code in `services/tasks/ingest_analysis.py` line 802–822 dispatches on `analysis_source`:

```python
if analysis_source == "DCML":      # implemented
elif analysis_source == "WhenInRome":  # NotImplementedError (deferred)
elif analysis_source == "music21_auto": # NotImplementedError (deferred to Component 6)
elif analysis_source == "none":     # no-op
```

So today's actual implementation runs **DCML TSV parsing**, not music21 analysis, on MEI upload. ADR-004's description of "music21 runs once per movement" is no longer literally true — DCML parsing runs once per movement; music21 runs only if the corpus's `analysis_source` is `music21_auto`, and that branch isn't even implemented yet.

The smart-merge policy (preserving manually-reviewed events through re-analysis) is still valid and is implemented for the DCML branch. The trigger timing (on upload, not on fragment submission) is still valid. But the framing — "music21 preprocessing pipeline" — is misleading.

**Solution.** Either:

1. **Amend ADR-004** to reframe the decision as "Analysis Pipeline Trigger" (not "music21 Preprocessing Pipeline Trigger"). The trigger and smart-merge policy apply to whatever source the corpus declares; music21 is one source among several.
2. **Mark ADR-004 as Superseded** by a new ADR that covers the analysis-source dispatch in full. Less work to write the new ADR than to retrofit ADR-004's framing.

Recommendation: option 1 with a note. Rename to "Analysis Pipeline Trigger and Smart-Merge Policy", update the Context to explain that the source can be DCML / WhenInRome / music21_auto, keep all the trigger and merge logic. Add a "Status note: amended on YYYY-MM-DD to generalise from music21-specific framing."

**Verification.** A reader asking "when does the analysis task fire?" finds ADR-004 and gets a current answer. A reader asking "what happens if a corpus has no harmonic annotations?" finds the music21-fallback discussion under the same ADR rather than having to piece it together from `ingest_analysis.py` source code.

---

## Issue 8: ADR-011 references a "historical artefact" file that's been removed

**Issue.** ADR-011 line 107:

> `multi-level-tagging-draft.md` is superseded by `tagging-tool-design.md`. The draft is retained in the repository as a historical artefact but should not be consulted as a current design reference.

`find docs -name "multi-level-tagging*"` returns nothing. The file isn't there. It was either never committed or removed in cleanup.

**Solution.** Either:

1. **Remove the sentence** if the draft was deliberately deleted. The cross-reference is no longer needed.
2. **Restore the draft file** if the intent was to keep it.

Recommendation: option 1. Historical drafts are usually noise once superseded; removing them is fine, and the ADR is the canonical record of the supersession.

**Verification.** `grep -rn "multi-level-tagging-draft" docs/ ADR-*` returns nothing.

---

## Issue 9: ADR-008 preview-key path doesn't match the convention used by `services/object_storage.py`

**Issue.** ADR-008 line 36 specifies the preview storage-key pattern:

```
{corpus_slug}/{work_id}/{movement_id}/previews/{fragment_id}.svg
```

This uses **UUIDs (`work_id`, `movement_id`, `fragment_id`)** in the path — which is unstable as the documented base format (ADR-002 uses slugs).

`backend/services/object_storage.py` line 16 documents the preview key as:

```
{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/preview.svg
```

— all slugs, no UUIDs, and there's no per-fragment file (it's a single per-movement preview).

So ADR-008 specifies a per-fragment preview file with UUID-based keys; the code (and ADR-002 line 68's mention of preview) has a per-movement preview with slug-based keys. These are designing for different things — ADR-008 is the fragment-list view's per-fragment thumbnail; the code's `preview.svg` is something else. Either the code is missing ADR-008's per-fragment previews entirely (likely — fragment previews are Component 4 or later), or the docstring in `object_storage.py` is conflating two different assets.

**Solution.** Clarify in `services/object_storage.py` that its `preview.svg` is a **movement-level** asset, not the per-fragment preview ADR-008 specifies. Add a separate convention for fragment previews when they're built:

```
- Movement preview SVG: {composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/preview.svg
- Fragment preview SVG (per ADR-008, Component 4+):
    {composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/fragments/{fragment_id}.svg
```

ADR-008 itself should be updated to use slugs everywhere except the trailing `{fragment_id}` (since fragments don't have slugs — they have UUIDs). Aligning the rest of the path with ADR-002's slug convention is one small edit.

**Verification.** When fragment previews are implemented, the key generator function should produce paths that match this convention. Add a unit test on the future `fragment_preview_key()` function asserting on the format.

---

## Issue 10: ADR cross-references don't always point to existing files

**Issue.** Several ADRs reference paths that should exist but I couldn't verify all of them in this pass. Confirmed live: `mei-ingest-normalization.md`, `tagging-tool-design.md`, `prototype-tagging-tool.md`, `real-audio-playback-research.md`, `corpus-and-analysis-sources.md`. Confirmed missing: `multi-level-tagging-draft.md` (Issue 8 above).

ADR-005 line 5 says it supersedes content in `docs/roadmap/phase-1.md` "Open Decisions table". `phase-1.md` has the related row at line 697 (correctly current) and an inconsistent prose paragraph at line 421 (Issue 3).

ADR-009 line 10 says: *"see `docs/architecture/corpus-and-analysis-sources.md`"* — that file exists; worth confirming it's current with respect to the analysis_source values used by `ingest_analysis.py`.

**Solution.** Add a cross-reference linter to CI: walk every ADR, every architecture doc, every roadmap doc; extract every path-shaped string (`docs/...`, `backend/...`); confirm the path exists. Five minutes of script, eliminates this whole class of drift.

**Verification.** The linter runs on every PR and fails if a referenced path doesn't exist. Existing references all resolve.

---

## Issue 11: ADR-013 lists snapshot-baseline regeneration as required, but `tests/snapshots/` is empty

**Issue.** ADR-013 line 22:

> All snapshot baselines in `tests/snapshots/` are invalidated and must be regenerated.

ADR-013 was accepted on 2026-04-23 and the Verovio upgrade has happened (`requirements.txt` line 39 has `verovio==6.1.0`). But `backend/tests/snapshots/` contains only `__init__.py` — there are no baselines to regenerate because there are no snapshot tests. The README and CLAUDE.md both advertise `pytest tests/snapshots/` as a real test command. ADR-013 references the snapshot suite as load-bearing for the upgrade verification.

So ADR-013's verification claim ("upgrade must pass the snapshot test suite") is currently vacuous — there's no suite to pass.

**Solution.** Two tracks:

1. **Short term**: add a sentence to ADR-013 noting that the snapshot suite is not yet built, and that the 6.1.0 upgrade has been verified manually against the spike script described in `mei-ingest-normalization.md`. Without this, ADR-013 implies a verification that didn't happen.
2. **Phase 1 deliverable**: actually build the snapshot suite. It's a small thing — a fixture MEI, a Verovio render, an XML diff against a committed baseline. The `pytest --update-snapshots` flag is a standard pattern.

**Verification.** `pytest tests/snapshots/ -v` lists at least one test; CI runs the suite on every commit; an unintended Verovio update breaks CI.

---

## Issue 12: ADR-006's CC BY-SA section conflict with the Wikidata field

**Issue.** This is a smaller observation. ADR-006 doesn't address Wikidata. But `backend/migrations/versions/0001_initial_schema.py` adds a `wikidata_id` column to `composer` (line 73-area) and the corpus ingestion code (`services/ingestion.py` line 367) populates it. Wikidata data is CC0; nothing in ADR-009 or ADR-006 covers the licensing of any Wikidata-derived fields surfaced via the API. Currently moot — the `wikidata_id` is just an external reference, not derived content — but worth a single sentence in ADR-009 saying "external reference identifiers (Wikidata IDs, MusicBrainz IDs, etc.) are not derivative works and carry no licence obligation."

**Solution.** Add the sentence to ADR-009's "What is not affected" list (line 26–34). One line, no code change.

**Verification.** Doc review.

---

## What the ADRs get right (worth keeping)

- **Consistent header format** — Status / Date / Supersedes / See also — across all 13 documents.
- **Honest alternatives sections.** ADR-007's "Alternatives Considered" rejects "Generate embeddings from Phase 1" with a real cost reason (operational complexity, ongoing API costs) rather than a make-believe deficiency.
- **Forward-compatibility focus.** ADR-001 explicitly thinks about the Phase 2 expansion of the role model; ADR-007 fixes the embedding dimension on day one to avoid a Phase 3 migration; ADR-012 mandates the `onPositionUpdate(bar, beat)` abstraction "from day one" so the real-audio swap is a config change.
- **Cross-references with section anchors.** When ADR-013 links to `mei-ingest-normalization.md §"Verovio bar-range selection: observed behaviour"`, the section name is included — so even if the doc is reorganized, the reader knows what they're looking for.
- **The "Supersedes" header in ADR-005** is exactly the right way to document a reversed decision. The original deferral plan is preserved in `roadmap/phase-1.md` and the ADR explains why it was reversed. (The follow-on bug — that nobody updated the migration comment or the prose paragraph in the same roadmap — is the failure mode this report is calling out, not a flaw in the ADR pattern itself.)

---

## Summary of action items by severity

**Production blocker (fix immediately):**
- Issue 4: `python-dotenv` not in `requirements.txt` → production container fails to start.

**Schema/data integrity (fix while migrations are still trivial to amend):**
- Issue 1: Implement ADR-006 Phase 1 scaffolding (or demote the ADR).
- Issue 2: Fix the `beat_start` / `beat_end` migration comment.

**Doc-vs-code drift (fix at next pass):**
- Issue 3: `phase-1.md` line 421 contradicts ADR-005.
- Issue 5: ADR-001 `ENVIRONMENT=development` should be `local`.
- Issue 7: Reframe ADR-004 from music21-specific to analysis-source-generic.
- Issue 11: Note ADR-013 snapshot-suite gap, or build the suite.

**Cleanup (low priority but cheap):**
- Issue 6: Document `originals/` and `incipit.svg` key conventions in an ADR.
- Issue 8: Remove the dead reference in ADR-011 line 107.
- Issue 9: Reconcile ADR-008 preview-key path with the code's slug convention.
- Issue 10: Add a cross-reference linter to CI.
- Issue 12: One-line addition to ADR-009 about Wikidata.
