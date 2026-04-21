# Fragment Schema Reference

## Status and purpose

This document is the authoritative specification for the fragment data model. It covers the PostgreSQL table definitions, the `summary` JSONB structure, the cross-database join pattern between PostgreSQL and Neo4j, and the versioning policy.

**The `summary` JSONB schema defined here is treated as a published API from the moment the first fragment record is written.** The Phase 3 AI reasoning layer will consume this structure directly via tool calls. Changing field names, removing fields, or restructuring the hierarchy after production fragments exist requires a versioned migration of every affected record. Additions of new optional fields at the top level are safe without a version bump, provided existing consumers ignore unknown fields. Everything else is a breaking change.

When any breaking change is made: increment `version`, write a migration script in `scripts/migrations/`, update this document, and run the migration in staging before production.

---

## PostgreSQL table definitions

### `fragment`

The central record. One row per tagged musical excerpt.

```sql
CREATE TABLE fragment (
    -- Identity
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- MEI source location (resolved via the movement row)
    movement_id         UUID NOT NULL REFERENCES movement(id) ON DELETE RESTRICT,
    bar_start           INTEGER NOT NULL,       -- inclusive; maps to MEI <measure @n>
    bar_end             INTEGER NOT NULL,       -- inclusive; maps to MEI <measure @n>

    -- Sub-measure precision
    beat_start          FLOAT,                  -- beats from start of bar_start measure
    beat_end            FLOAT,                  -- beats from start of bar_end measure

    -- Notated context (minimal; key and meter live inside summary)
    repeat_context      TEXT,                   -- e.g. "first_ending"; null if unambiguous

    -- Structured analytical summary (see below for full specification)
    summary             JSONB NOT NULL,

    -- Prose annotation (raw text; embeddings generated in Phase 3)
    prose_annotation    TEXT,

    -- Per-fragment licence (ADR-009)
    data_licence        TEXT,

    -- Hierarchy: sub-parts link to their parent (arbitrary depth allowed)
    parent_fragment_id  UUID REFERENCES fragment(id) ON DELETE CASCADE,

    -- Peer review state machine (see fragment_review for per-reviewer records)
    status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    created_by          UUID REFERENCES app_user(id),

    -- Audit timestamps
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- GIN index for querying into the JSONB summary (e.g. filtering by concept or property value)
CREATE INDEX fragment_summary_gin ON fragment USING GIN (summary);

-- Index for sub-part lookups
CREATE INDEX fragment_parent_idx ON fragment (parent_fragment_id)
    WHERE parent_fragment_id IS NOT NULL;

-- Index for status-filtered browsing (the most common query pattern)
CREATE INDEX fragment_status_idx ON fragment (status);

-- Index for movement-scoped queries (all fragments in movement X)
CREATE INDEX fragment_movement_idx ON fragment (movement_id);
```

**`movement_id`** is the foreign key to the `movement` row that owns the MEI source. The S3 object key is resolved by reading `movement.mei_object_key`; there is no `mei_file` column on the fragment itself, because the key belongs to the movement and the fragment inherits it. Keys follow the pattern `{composer.slug}/{corpus.slug}/{work.slug}/{movement.slug}.mei` (e.g. `mozart/piano-sonatas/k331/movement-1.mei`).

**`bar_start` / `bar_end`** are 1-indexed integers corresponding to `<measure @n>` values in the MEI source. They are not display bar numbers, which can diverge from `@n` values due to repeats, first/second endings, and pickup bars. See `docs/adr/ADR-005-sub-measure-precision.md` for the beat-precision implementation.

**`beat_start` / `beat_end`** define the selection boundary within their respective measures. Inclusion is *onset-based*: a note whose onset falls inside the `[beat_start, beat_end)` range is part of the fragment; a note whose onset falls outside is not, regardless of sounding duration. This creates a deliberate asymmetry at the start boundary — a note sounding at `beat_start` but attacked before it is excluded — and at the end boundary — a note attacked before `beat_end` but sustaining past it is included.

**Rendered extent vs. data boundary.** The beat-level fields govern *data inclusion* — which notes' analytical properties are part of the fragment's summary — but not *visual inclusion*. The rendered score always displays full measures `[bar_start, bar_end]` inclusive, because Verovio cannot render a partial bar without distorting the metre and because theorists need the surrounding metric context to read the excerpt. The UI may apply visual emphasis (bracket, shading, muted notes outside the boundary) to indicate the data range within the rendered bars, but it must never truncate a bar. A consequence at the end boundary: a note whose onset is within `[beat_start, beat_end)` but whose duration extends past `beat_end` is still part of the fragment's data; the renderer shows the note in full because the rest of the bar is shown in full anyway.

**`repeat_context`** disambiguates fragments that fall within repeated sections. Permitted values are `first_ending`, `second_ending`, and any further values documented as they arise. Null means the fragment's range is unambiguous with respect to repeats.

**`parent_fragment_id`** records sub-part nesting. The database imposes no depth limit: nesting may be arbitrarily deep when it is conceptually valid (a composite concept whose stages themselves have stages). The tagging UI performs visual flattening beyond two visible levels so the score does not become unreadable, but the data model preserves the true hierarchy. A sub-part's `bar_start`/`bar_end` must fall within its parent's range; this constraint is enforced by the service layer, not the database.

**`status`** drives the peer review state machine: `draft → submitted → approved` (or `rejected → draft`). Only `approved` fragments are visible in the public fragment browser. The status filter is enforced at the service layer on every query; it is not a UI-only concern. The decisions recorded by individual reviewers live in the `fragment_review` table (below); `status` on the fragment is the aggregate outcome.

---

### `fragment_concept_tag`

The join surface between PostgreSQL and Neo4j. One row per concept tagged on a fragment; a fragment can carry more than one concept tag (e.g. a PAC that is also identified as occupying a consequent phrase slot). This is a genuine many-to-many relation: one fragment can be tagged with multiple concepts, and one concept can be tagged on many fragments.

```sql
CREATE TABLE fragment_concept_tag (
    fragment_id  UUID REFERENCES fragment(id) ON DELETE CASCADE,
    concept_id   TEXT NOT NULL,          -- references Concept.id in Neo4j
    is_primary   BOOLEAN NOT NULL DEFAULT true,
    PRIMARY KEY (fragment_id, concept_id)
);

CREATE INDEX fct_concept_idx ON fragment_concept_tag (concept_id);
```

**`concept_id`** values are the `id` strings used as primary keys in the Neo4j graph (`REQUIRE c.id IS UNIQUE`). There is no database-level foreign key across systems; referential integrity is enforced by the Pydantic validation layer at write time. If a `concept_id` is not found in Neo4j during validation, the write is rejected.

**`is_primary`** distinguishes the concept that drove the tagging decision — the one the annotator was explicitly claiming about the passage — from contextual concepts applied for cross-referencing purposes. A fragment tagged as a PAC *because* it is a PAC carries `PerfectAuthenticCadence` as `is_primary = true`. The same fragment may also carry `ConsequentPhrase` as `is_primary = false` because the passage happens to occupy a consequent slot — useful for cross-referencing but not the analytical claim the fragment exists to record. Queries looking for "fragments of type PAC" should filter on `is_primary = true`; queries assembling all cross-references for a concept should not. By convention, the primary concept is also the first entry in the denormalised `summary.concepts` array.

**Role qualifiers do not live here.** Earlier drafts carried `structural_role` and `formal_context` columns on this table; they were dropped because they restate at the join-table level what the concept itself already asserts. If a concept is not specific enough to qualify its own role, the right move is to create a more specific concept in the graph; if contextual qualification is genuinely needed, it belongs in the fragment's prose annotation.

---

### `fragment_review`

Per-reviewer decisions on a fragment. Kept separate from the fragment row itself so that the approval threshold can grow (from one reviewer to two, or more) without a data migration. `fragment.status` is the aggregate state machine; `fragment_review` records the individual decisions that drove it.

```sql
CREATE TABLE fragment_review (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    fragment_id  UUID NOT NULL REFERENCES fragment(id) ON DELETE CASCADE,
    reviewer_id  UUID NOT NULL REFERENCES app_user(id) ON DELETE RESTRICT,
    decision     TEXT NOT NULL CHECK (decision IN ('approved', 'rejected')),
    comment      TEXT,
    reviewed_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (fragment_id, reviewer_id)
);

CREATE INDEX fragment_review_fragment_idx ON fragment_review (fragment_id);
```

**`UNIQUE (fragment_id, reviewer_id)`** prevents a reviewer from submitting multiple decisions for the same fragment. A reviewer who changes their mind updates their existing row rather than inserting a new one.

**Approval threshold.** The transition from `submitted` to `approved` is governed by a parameterised service function that counts approving reviews excluding the fragment's creator (`reviewer_id != fragment.created_by`). Phase 1 threshold is one such review; the threshold is a configuration value so it can be raised later without touching route handlers. Admins can approve unilaterally regardless of threshold.

---

### `prose_chunk` (scaffolded; populated in Phase 3)

Scaffolded now so prose annotations are stored and the table structure is stable before embedding generation begins.

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE prose_chunk (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type    TEXT NOT NULL
                        CHECK (content_type IN ('concept_annotation', 'fragment_annotation', 'blog_post')),
    source_id       TEXT NOT NULL,      -- concept.id, fragment.id (UUID as text), or blog post slug
    chunk_text      TEXT NOT NULL,
    embedding       vector(1536),       -- populated in Phase 3; null until then
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- Created in Phase 3 once embeddings are populated
-- CREATE INDEX prose_chunk_embedding_idx
--     ON prose_chunk USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

The embedding dimension (1536) matches OpenAI `text-embedding-3-small`. **This dimension is fixed at table creation.** Changing it requires dropping and recreating the column and re-embedding the entire corpus. Pin the embedding model before creating the table and do not change it without a documented migration plan.

---

## Dependency notes

### `app_user`

The `fragment` table references `app_user(id)` via `created_by`; the `fragment_review` table references `app_user(id)` via `reviewer_id`. The `app_user` table is defined in `docs/architecture/tech-stack-and-database-reference.md` (under "User infrastructure tables"), which is the authoritative definition for all user infrastructure tables. This document covers only the fragment data model; user infrastructure is out of scope here.

### `movement`

The `fragment` table references `movement(id)` via `movement_id`; the `movement_analysis` table references `movement(id)` via `movement_id` (with a `UNIQUE` constraint to enforce one analysis per movement). The `movement` table — along with `composer`, `corpus`, and `work` — is defined in `docs/architecture/tech-stack-and-database-reference.md` (under "Music works infrastructure"). This document assumes those tables exist and does not re-specify them.

### `blog_post`

The `prose_chunk` table permits `content_type = 'blog_post'`, and `ADR-006` adds `language` and `source_post_id` columns to a `blog_post` table. The `blog_post` table is a Phase 2 concern and will be formally defined in Phase 2 design documents. At that point this document should be updated to cross-reference it.

---

## The `summary` JSONB schema

### Version history

| Version | Status | Notes |
|---|---|---|
| 1 | Current | Initial schema; established at project start |

Every record carries a top-level `version` integer. Code that reads `summary` must check `version` before interpreting fields. A migration script in `scripts/migrations/` must exist for every version transition.

### Full schema — version 1

```json
{
  "version": 1,

  "key": "A major",
  "meter": "4/4",

  "actual_key": {
    "value": "A major",
    "confidence": 0.92,
    "auto": true,
    "reviewed": false
  },

  "music21_version": "9.1.0",

  "concepts": ["PerfectAuthenticCadence"],

  "properties": {
    "SopranoPosition": "ScaleDegree1",
    "CadentialElaboration": ["Cadential64", "AppliedDominant"]
  },

  "concept_extensions": {}
}
```

**Harmony does not live here.** Chord-level harmonic analysis is stored at movement level in the `movement_analysis` table — per-event, mutable, reviewable — and sliced by the fragment's bar/beat range at read time. See the "Harmonic analysis: movement-level single source of truth" section below. A fragment's `summary` carries only what is specific to the fragment: notated key/meter, inferred local key, the concept tags, their property values, and any genuinely fragment-scoped extensions (e.g. `post_evasion_harmony` for an evaded cadence).

### Field reference

**`version`** *(integer, required)*
Schema version. Currently always `1`. Increment on any breaking change. See versioning policy below.

**`key`** *(string, required)*
The notated key signature of the passage, as a canonical string: `"A major"`, `"D minor"`, `"F# major"`. Derived from the MEI `<key>` element. High-reliability; not flagged as auto.

**`meter`** *(string, required)*
The notated time signature: `"4/4"`, `"3/8"`, `"6/8"`. Derived from MEI `<time>`. High-reliability; not flagged as auto.

**`actual_key`** *(object, optional)*
The key inferred by music21's probabilistic key analysis (or carried over from a pre-existing tonicisation annotation where one is available). Distinct from `key` because passages may be in a key other than the movement's key signature (e.g. a tonicised region). Contains:
- `value` *(string)* — inferred key, same canonical format as `key`
- `confidence` *(float, 0.0–1.0)* — the machine's confidence score at time of generation
- `auto` *(boolean)* — `true` when the value has not been edited by a human; `false` after a human correction
- `reviewed` *(boolean)* — `false` until an annotator has explicitly confirmed or corrected this object

**Editability during tagging.** `actual_key` is editable in the tagging UI. An annotator can confirm (flip `reviewed` to `true`, leave `auto: true`) or correct (edit `value`, flip `auto: false`, `reviewed: true`). `confidence` is preserved as provenance — the machine's original claim — even after a human edit. The rule is: `confidence` is only meaningful when read alongside `auto: true`; on records where `auto: false`, ignore it.

Fields with `auto: true` are flagged in the tagging UI as "auto-generated — review required." Annotators correct them via structured edit, not free text.

**`music21_version`** *(string, required)*
The version of music21 used to generate the auto-extracted fields (e.g. `"9.1.0"`). Stored so records generated by an older version can be identified and re-processed after a library upgrade that changes analysis output.

**`concepts`** *(array of strings, required)*
Ordered list of concept `id` values applied to this fragment, matching the entries in `fragment_concept_tag`. The first entry is always the primary concept. This array is denormalised from the join table for convenience in AI reasoning contexts where both the tag and the summary are consumed together; `fragment_concept_tag` is authoritative for querying.

**`properties`** *(object, optional)*
Instance-level property values, keyed by `PropertySchema.id`. Values are either a single string (`ONE_OF` cardinality) or an array of strings (`MANY_OF` cardinality). Every value is a `PropertyValue.id` from the knowledge graph schema. Validated against the applicable schemas at write time by the Pydantic layer.

```json
{
  "SopranoPosition": "ScaleDegree1",
  "CadentialElaboration": ["Cadential64", "AppliedDominant"]
}
```

A missing key means no value was supplied for that schema. A `required: true` schema with no value will fail Pydantic validation before the record is written.

**`concept_extensions`** *(object, optional)*
Concept-type-specific data declared by one or more of the fragment's concepts via their `capture_extensions` spec (see `docs/architecture/capture_extensions.md`). Keyed by field name as a flat namespace: if two of the fragment's concepts both declare the same field (e.g. both declare `harmony`), they share a single value — there are never two copies of the same analytical fact on one fragment. Concept-spec authors are responsible for ensuring that field names are either genuinely shared (same semantics, same type) or renamed to avoid collision.

For most fragments this object is empty. It is populated when a concept declares a field that is not already captured by (a) the base schema, (b) `movement_analysis` (e.g. harmony), or (c) a sub-fragment via `CONTAINS`. `post_evasion_harmony` on an `EvadedCadence` is the canonical example.

---

## Harmonic analysis: movement-level single source of truth

Chord-level harmonic analysis is a property of the notes in a movement, not of any particular fragment's interpretation of them. A single bar-and-beat position cannot simultaneously be "a ii6" in one fragment and "a IV" in another; there is one harmony and all fragments covering that position see it. We therefore store harmonic analysis once, at movement level, in `movement_analysis`, and slice by `(bar_start, bar_end, beat_start, beat_end)` at read time when a fragment needs it.

Consequences:

- A fragment's `summary` never persists a `harmony` array. Any consumer that needs harmony for a fragment queries the service layer, which reads from `movement_analysis` using the fragment's range.
- Corrections are universal. When an annotator corrects a chord while tagging fragment A, the write updates the event in `movement_analysis`; fragment B, which covers the same bar, sees the same corrected value next time it is displayed.
- Review state is per-event in `movement_analysis`, not per-fragment. "All `auto: true` harmony entries in this fragment's range have been reviewed" is a single query against `movement_analysis` scoped to the fragment's range.
- Cross-corpus queries ("find all bars containing a ii6 chord in minor keys") are direct queries against `movement_analysis`, not fragment-by-fragment walks.

### Harmonic rhythm and event durations

Each entry in the harmonic timeline is a **change event**: it asserts that, starting at this beat, the harmony is `X`. The event extends in time until the next event, or to the end of the movement if it is the last. This captures variable harmonic rhythm (one chord per beat, one per bar, mid-bar changes) without requiring the array to be dense.

Editing operations therefore decompose into four primitives:
- **Insert**: add a new event at beat `B`.
- **Delete**: remove an event; the preceding event now extends through its position.
- **Move boundary**: change an existing event's `beat` value.
- **Edit chord**: change the chord identity (`root`, `quality`, `inversion`, `numeral`, …) of an existing event without changing its beat.

The tagging UI exposes these primitives directly. Moving a boundary and editing a chord are categorically different operations and the UI should not conflate them.

---

## Fragment approval and harmony review

Before a fragment can move from `submitted` to `approved`, the service layer enforces:

1. Every `actual_key` object with `auto: true` must have `reviewed: true`. (If `actual_key` is absent, this check is vacuous.)
2. Every harmony event in `movement_analysis` whose position falls within the fragment's `[bar_start, beat_start] .. [bar_end, beat_end)` range must have `reviewed: true` — but only if the fragment's concepts include at least one that requires harmony review. For fragments whose concepts do not capture harmony (e.g. a Hemiola), this check is skipped; the harmonic context is still displayed when rendering the fragment, but unreviewed events do not block approval. The range query matches on `mn` against the fragment's `bar_start`/`bar_end`; when the fragment carries a non-null `repeat_context`, the query additionally filters events by `volta` (e.g. `repeat_context = "first_ending"` restricts to events with `volta = 1`), so that only the events belonging to the correct ending pass are checked.

Which concepts require harmony review is determined by their `capture_extensions` spec (see `docs/architecture/capture_extensions.md`): a concept that declares a `harmony` extension is asserting that harmony matters for its analysis, and approval of fragments tagged with that concept therefore depends on the harmony events in their range being reviewed.

The service layer endpoint `POST /api/v1/fragments/{id}/approve` returns a 422 with a structured error listing the specific unreviewed entries if either check fails.

**Review at the event level, not the fragment level.** Because review state lives on individual events in `movement_analysis`, a reviewer's work on fragment A satisfies the review gate for any later fragment B that covers overlapping events. This is a feature, not a bug: a reviewer has already made the analytical call on those chords, and the system should not ask for the same call to be made again.

---

## Cross-database join pattern

Fragment records in PostgreSQL join to concept nodes in Neo4j via `concept_id` strings. The pattern used throughout the application:

```python
# 1. Query Neo4j for the subtype tree of a concept
subtypes = graph_service.get_subtypes(concept_id="Cadence")
# Returns: ["Cadence", "AuthenticCadence", "PerfectAuthenticCadence", ...]

# 2. Query PostgreSQL for fragments tagged with any concept in that set
fragments = await fragment_repo.get_by_concept_ids(
    concept_ids=subtypes,
    status="approved"
)
```

This two-step pattern is the canonical approach. No component queries across database types in a single call. The service layer owns the join logic; route handlers call the service, not the databases directly.

**Referential integrity:** there is no database-enforced foreign key between `fragment_concept_tag.concept_id` and Neo4j. Integrity is maintained by the Pydantic validation layer at write time: before any fragment record is persisted, the validation layer verifies that every `concept_id` in the tag list exists in Neo4j. A write that references a non-existent concept is rejected with a descriptive error before it touches any database.

---

### `movement_analysis`

The authoritative record of beat-level harmonic analysis for each movement. Created by the Celery task triggered on MEI upload (see `docs/adr/ADR-004-music21-pipeline-trigger.md`). One row per analysed movement; the preprocessing service slices the relevant beat range at read time when a fragment needs harmony data, and writes back into the same row when an annotator corrects a chord.

```sql
CREATE TABLE movement_analysis (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movement_id        UUID UNIQUE NOT NULL REFERENCES movement(id) ON DELETE CASCADE,
    global_key         TEXT,                 -- e.g. "A major"; constant for the movement; from DCML globalkey column or music21 key analysis; nullable for movements not yet analysed
    events             JSONB NOT NULL,       -- per-event harmonic timeline; see structure below
    music21_version    TEXT NOT NULL,        -- version used for the initial auto-analysis
    created_at         TIMESTAMPTZ DEFAULT now(),
    updated_at         TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX movement_analysis_music21_version_idx ON movement_analysis (music21_version);
CREATE INDEX movement_analysis_events_gin        ON movement_analysis USING GIN (events);
```

**`movement_id`** is a foreign key to the `movement` row. `UNIQUE` enforces one analysis record per movement. The previous free-text key (`{composer}/{corpus}/{work}/{movement}`) is a path convention, not a database identity; it has no place as a primary key.

**`global_key`** stores the overall tonic key of the movement (e.g. `"A major"`, `"D minor"`) as a movement-level fact, not repeated on each event. For DCML sources this is the `globalkey` column value; for music21-analysed movements it is the output of music21's probabilistic key analysis. Null when the movement has no analysis record yet. Consumers that need per-event local key read `local_key` from each event; `global_key` is for movement-level filtering and display only.

**`events`** stores the complete per-event harmonic timeline for the movement as a JSONB array. Each event has the shape:

```json
{
  "mc": 18,
  "mn": 17,
  "volta": null,
  "beat": 3.0,
  "local_key": "D minor",
  "root": 2,
  "quality": "minor",
  "inversion": 1,
  "numeral": "ii6",
  "root_accidental": null,
  "applied_to": null,
  "extensions": [],
  "bass_pitch": null,
  "soprano_pitch": null,
  "source": "DCML",
  "auto": false,
  "reviewed": true
}
```

| Field | Type | Description |
|---|---|---|
| `mc` | integer | DCML measure count — a monotonically increasing linear index across the entire movement, unambiguous across repeat endings and split bars. Null for manually-inserted events and music21-auto events where no DCML source exists. The natural stable key for DCML smart-merge operations. |
| `mn` | integer | Notated measure number, corresponding to MEI `<measure @n>`. 0 for the pickup bar; 1-indexed for all others. Repeats across different endings when the same notated number appears in more than one `<ending>` element (e.g. both the first- and second-ending bars at the same notated slot carry `mn=12`). Both halves of a split bar at a repeat boundary share the same `mn`. |
| `volta` | integer or null | The ending number (1, 2, …) when the event falls inside a `<ending>` element; `null` for measures outside any repeat ending. Together with `mn`, uniquely addresses the measure in the MEI source. |
| `beat` | float | Beat position within the bar, 1-indexed. Beat 1.0 is the downbeat. |
| `local_key` | string | The prevailing local key at this event, in canonical form: `"A major"`, `"D minor"`. Corresponds to DCML's `localkey` column or to music21's running key estimate. Required for interpreting `root` and `numeral`. |
| `root` | integer | Scale degree of the chord root in `local_key` (1–7). |
| `quality` | string | `"major"`, `"minor"`, `"diminished"`, `"augmented"`, `"half-diminished"`, `"dominant-seventh"`. |
| `inversion` | integer | Root position = 0; first = 1; second = 2; third = 3. |
| `numeral` | string | Roman numeral with figured bass, e.g. `"ii6"`, `"V7"`. Does not include a flat/sharp prefix; if the root is altered, see `root_accidental`. |
| `root_accidental` | string or null | `"flat"` when the numeral carries a `b` prefix in the source notation, `"sharp"` for a `#` prefix, `null` otherwise. This is a notational fact, not an analytical interpretation: it records that the root lies a half-step below (or above) the diatonic degree, without asserting why. Whether this constitutes modal borrowing is a knowledge-graph-level label, not an event field. |
| `applied_to` | string or null | For secondary functions: the Roman numeral of the tonicised degree, e.g. `"V"` for `V/V`. `null` for non-applied chords. |
| `extensions` | array of strings | Chord extensions beyond the seventh, e.g. `["9"]` for `V7(9)`. Empty array when none. |
| `bass_pitch` | string or null | Scientific pitch notation of the lowest sounding note, e.g. `"E4"`. Not present in DCML TSV files; always `null` for DCML-sourced events. May be populated by a later music21 top-up pass without changing `source`. |
| `soprano_pitch` | string or null | Scientific pitch notation of the highest sounding note, e.g. `"A5"`. Same provenance constraint as `bass_pitch`. |
| `source` | string | Provenance: `"DCML"`, `"WhenInRome"`, `"music21_auto"`, or `"manual"`. Per-event: a movement can legitimately have DCML entries for most bars and `music21_auto` for the rest. |
| `auto` | boolean | `true` while the entry has not been edited by a human; `false` after a human edit (which also sets `source` to `"manual"`). |
| `reviewed` | boolean | `false` until an annotator has explicitly confirmed or corrected this entry. |

Event durations are implicit: each event extends in time until the next event, or to the end of the movement if it is the last. See "Harmonic rhythm and event durations" above.

**Reliability classes:** High-reliability fields (`root`, `quality`, `inversion`) are derivable mechanically and are expected to be correct without review in most cases. Medium-reliability fields (`numeral`, `local_key`) are probabilistic and must always be reviewed before a fragment whose range covers them can be approved. `bass_pitch` and `soprano_pitch` are not populated for DCML-sourced events and are always `null` until a music21 top-up pass fills them in.

**Mutability.** `events` is mutable. When an annotator corrects a chord in the tagging UI, the service layer finds the matching event by `(mn, volta, beat)` and updates it in place: sets the new chord fields, flips `source` to `"manual"`, sets `auto: false` and `reviewed: true`. For DCML-sourced events `mc` provides an additional stable cross-check, but `(mn, volta, beat)` is the universal event identity across all source types. The fragment that triggered the edit is not where the value lives — the fragment just provided the context in which the correction happened.

**Re-analysis smart merge.** If the MEI source is corrected and music21 is re-run for a movement, the re-analysis task must not clobber manually-reviewed events. The merge policy:

- Events with `source = "manual"` or `reviewed = true` are preserved unchanged.
- Events with `source in ("music21_auto", "DCML", "WhenInRome")` and `reviewed = false` are replaced by the new analysis.
- New events from the re-analysis that did not exist at their `(mn, volta, beat)` position are inserted.
- Events that existed before but are not present in the re-analysis (because a bar was deleted or a harmony change removed) are dropped unless `reviewed = true`, in which case they are preserved and flagged for human reconciliation.

Any fragment whose range overlaps a changed event is flagged for re-review. The flagging mechanism is implemented by the correction workflow documented in the Phase 1 roadmap.

**`music21_version`** identifies the version used for the initial auto-analysis. After corrections and re-analyses, this column continues to reflect the most recent re-run — individual manually-reviewed events may predate it, but the column is a useful coarse filter for "which movements were last touched by which music21 version."

### Concurrent corrections

Two annotators may land on the same chord with different opinions. The current policy is **last-reviewer-wins**: the second write replaces the first. For Phase 1 this is acceptable given the small, coordinated annotator team. When the team grows, add a `movement_harmony_audit` table that records the before/after of every `manual` edit, so that disagreements are visible and reconcilable. Do not build the audit table speculatively — build it the first time a disagreement actually matters.

---

## Versioning policy

### What requires a version bump

A version bump is required for any change that would cause existing code reading `version: 1` records to misinterpret a field. This includes:

- Renaming any field
- Changing a field's type (e.g. string to integer)
- Removing any field
- Changing the semantics of an existing field (e.g. changing a property value reference from concept id to MIDI number)
- Changing the structure of `actual_key`, `properties`, or `concept_extensions` in ways that existing consumers cannot safely ignore

### What does not require a version bump

- Adding a new optional top-level field (provided consumers ignore unknown fields)
- Adding a new permitted value to `properties`
- Adding new keys to `concept_extensions` that correspond to new concept-level capture extensions

### Migration procedure

1. Increment `version` in this document and update the version history table.
2. Write a migration script at `scripts/migrations/summary_v{N}_to_v{N+1}.py` that reads all records at version N and writes updated records at version N+1. The script must be idempotent (safe to re-run) and must operate in batches to avoid locking the table.
3. Run the migration in a test environment against a copy of production data.
4. Run in staging; verify no records remain at version N.
5. Run in production.
6. Update the Pydantic model for `summary` to reflect the new schema.

Old-version records should never persist in production after a migration is complete. Code that reads `summary` and encounters an unexpected version should raise an exception, not silently misinterpret the data.

---

## What the summary does not contain

The following do not belong in `summary` and should never be added:

**Things that belong in the knowledge graph:** concept definitions, relationship types, PropertySchema metadata, pedagogical sequencing information. These are stable across all instances of a concept and live in Neo4j.

**Things that belong in the fragment table columns:** `bar_start`, `bar_end`, `status`, `prose_annotation`, `repeat_context`, `data_licence`, `movement_id`. These are first-class columns because they are used as filter and sort conditions in queries and because they carry identity / foreign-key semantics that JSONB cannot express.

**Things that belong in `movement_analysis`:** chord-level harmonic events — their bar and beat positions, roots, qualities, inversions, Roman numerals, bass and soprano pitches, source provenance, and review state. Harmony is movement-level, not fragment-level; see "Harmonic analysis: movement-level single source of truth" above. A fragment's `summary` never duplicates the harmony for its range.

**Things that belong in `fragment_concept_tag`:** the concept membership relation. The `concepts` array in `summary` is a denormalised read convenience, not the source of truth.

**Free-text explanatory prose:** the prose annotation field is stored in `fragment.prose_annotation`, not inside `summary`. The vector embedding of that text will live in `prose_chunk`. Mixing structured data and prose in the JSONB would make both harder to query and to evolve.
