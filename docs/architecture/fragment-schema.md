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

    -- MEI source location
    mei_file            TEXT NOT NULL,          -- S3 object key, not a URL
    bar_start           INTEGER NOT NULL,        -- inclusive; maps to MEI <measure @n>
    bar_end             INTEGER NOT NULL,        -- inclusive; maps to MEI <measure @n>

    -- Sub-measure precision
    beat_start          FLOAT,                  -- beats from start of bar_start measure
    beat_end            FLOAT,                  -- beats from start of bar_end measure

    -- Notated context
    key                 TEXT,                   -- e.g. "A major"
    meter               TEXT,                   -- e.g. "4/4"
    formal_role         TEXT,                   -- e.g. "consequent phrase"
    repeat_context      TEXT,                   -- e.g. "first_ending", "second_ending"; null if unambiguous

    -- Structured analytical summary (see below for full specification)
    summary             JSONB NOT NULL,

    -- Prose annotation (raw text; embeddings generated in Phase 3)
    prose_annotation    TEXT,

    -- Hierarchy: sub-parts link to their parent
    parent_fragment_id  UUID REFERENCES fragment(id),

    -- Peer review state machine
    status              TEXT NOT NULL DEFAULT 'draft'
                            CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
    created_by          UUID REFERENCES app_user(id),
    reviewed_by         UUID REFERENCES app_user(id),
    review_comment      TEXT,
    reviewed_at         TIMESTAMPTZ,

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
```

**`mei_file`** stores the S3 object key, not a resolved URL. The application layer resolves keys to signed URLs at request time. Keys follow the pattern `{composer_slug}/{corpus_slug}/{work_id}/{movement_id}.mei` (e.g. `mozart/piano-sonatas/k331/movement-1.mei`).

**`bar_start` / `bar_end`** are 1-indexed integers corresponding to `<measure @n>` values in the MEI source. They are not display bar numbers, which can diverge from `@n` values due to repeats, first/second endings, and pickup bars. See `docs/adr/ADR-005-sub-measure-precision.md` for the beat-precision implementation.

**`beat_start` / `beat_end`** define the selection boundary within their respective measures. Inclusion is *onset-based*: a note whose onset falls inside the `[beat_start, beat_end)` range is part of the fragment; a note whose onset falls outside is not, regardless of sounding duration. This creates a deliberate asymmetry at the start boundary — a note sounding at `beat_start` but attacked before it is excluded — and at the end boundary — a note attacked before `beat_end` but sustaining past it is included. The rendering layer is responsible for visually clipping notes that extend beyond `beat_end`; it must not exclude notes whose onset is within the fragment range even if their duration exceeds it.

**`repeat_context`** disambiguates fragments that fall within repeated sections. Permitted values are `first_ending`, `second_ending`, and any further values documented as they arise. Null means the fragment's range is unambiguous with respect to repeats.

**`parent_fragment_id`** enables one level of sub-part nesting. A sub-part's `bar_start`/`bar_end` must fall within its parent's range; this constraint is enforced by the service layer, not the database.

**`status`** drives the peer review state machine: `draft → submitted → approved` (or `rejected → draft`). Only `approved` fragments are visible in the public fragment browser. The status filter is enforced at the service layer on every query; it is not a UI-only concern.

---

### `fragment_concept_tag`

The join surface between PostgreSQL and Neo4j. One row per concept tagged on a fragment; a fragment can carry more than one concept tag (e.g. a PAC that is also identified as occupying a consequent phrase slot).

```sql
CREATE TABLE fragment_concept_tag (
    fragment_id         UUID REFERENCES fragment(id) ON DELETE CASCADE,
    concept_id          TEXT NOT NULL,          -- references Concept.id in Neo4j
    structural_role     TEXT,                   -- e.g. "cadence", "opening gesture"
    formal_context      TEXT,                   -- e.g. "within antecedent phrase"
    is_primary          BOOLEAN NOT NULL DEFAULT true,  -- false for secondary/contextual tags
    PRIMARY KEY (fragment_id, concept_id)
);

CREATE INDEX fct_concept_idx ON fragment_concept_tag (concept_id);
```

**`concept_id`** values are the `id` strings used as primary keys in the Neo4j graph (`REQUIRE c.id IS UNIQUE`). There is no database-level foreign key across systems; referential integrity is enforced by the Pydantic validation layer at write time. If a `concept_id` is not found in Neo4j during validation, the write is rejected.

**`is_primary`** distinguishes the concept that drove the tagging decision (primary) from contextual concepts applied for cross-referencing purposes (secondary). Queries that are looking for "fragments of type PAC" should filter on `is_primary = true`.

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

The `fragment` table references `app_user(id)` via the `created_by` and `reviewed_by` foreign keys. The `app_user` table is defined in `docs/architecture/tech-stack-and-database-reference.md` (under "User infrastructure tables"), which is the authoritative definition for all user infrastructure tables. This document covers only the fragment data model; user infrastructure is out of scope here.

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
    "auto": true
  },

  "music21_version": "9.1.0",
  "harmony_source": "DCML",

  "harmony": [
    {
      "beat": 1.0,
      "root": 2,
      "quality": "minor",
      "inversion": 1,
      "numeral": "ii6",
      "bass_pitch": "E4",
      "soprano_pitch": "A5",
      "auto": true,
      "reviewed": false
    }
  ],

  "concepts": ["PerfectAuthenticCadence"],

  "properties": {
    "SopranoPosition": "ScaleDegree1",
    "CadentialElaboration": ["Cadential64", "AppliedDominant"]
  }
}
```

### Field reference

**`version`** *(integer, required)*
Schema version. Currently always `1`. Increment on any breaking change. See versioning policy below.

**`key`** *(string, required)*
The notated key signature of the passage, as a canonical string: `"A major"`, `"D minor"`, `"F# major"`. Derived from the MEI `<key>` element. High-reliability; not flagged as auto.

**`meter`** *(string, required)*
The notated time signature: `"4/4"`, `"3/8"`, `"6/8"`. Derived from MEI `<time>`. High-reliability; not flagged as auto.

**`actual_key`** *(object, optional)*
The key inferred by music21's probabilistic key analysis. Distinct from `key` because passages may be in a key other than the movement's key signature (e.g. a tonicised region). Contains:
- `value` *(string)* — inferred key, same canonical format as `key`
- `confidence` *(float, 0.0–1.0)* — music21's confidence score
- `auto` *(boolean)* — always `true`; indicates this field requires human review

Fields with `auto: true` are flagged in the tagging UI as "auto-generated — review required." Annotators correct them via structured edit, not free text.

**`music21_version`** *(string, required)*
The version of music21 used to generate the auto-extracted fields (e.g. `"9.1.0"`). Stored so records generated by an older version can be identified and re-processed after a library upgrade that changes analysis output.

**`harmony_source`** *(string, required)*
Identifies the origin of the `harmony` array entries. Permitted values: `"DCML"` (imported from DCML `harmonies.tsv`), `"WhenInRome"` (imported via music21's `romanText` parser), `"music21_auto"` (generated by music21 without expert annotation), `"manual"` (entered or corrected by a human annotator). Governs display in the tagging UI (authoritative vs. review-required) and supports quality filtering in corpus queries. See `docs/architecture/corpus-and-analysis-sources.md` for source priority order and normalisation spec.

**`harmony`** *(array of objects, required)*
One entry per harmonic event in the fragment. Objects contain:

| Field | Type | Reliability | Description |
|---|---|---|---|
| `beat` | float | — | Beat position from the start of the fragment (1-indexed). Beat 1.0 is the downbeat of `bar_start`. |
| `root` | integer | high | Scale degree of the chord root in the local key (1–7). Not a MIDI note number. |
| `quality` | string | high | `"major"`, `"minor"`, `"diminished"`, `"augmented"`, `"half-diminished"`, `"dominant-seventh"`. |
| `inversion` | integer | high | Root position = 0; first inversion = 1; second inversion = 2; third inversion = 3. |
| `numeral` | string | medium | Roman numeral with figured bass, e.g. `"ii6"`, `"V7"`, `"bVI"`. Auto-generated; requires review. |
| `bass_pitch` | string | high | Scientific pitch notation of the lowest sounding note, e.g. `"E4"`. |
| `soprano_pitch` | string | high | Scientific pitch notation of the highest sounding note, e.g. `"A5"`. |
| `auto` | boolean | — | `true` for all music21-derived entries on initial generation. Set to `false` by annotator after review and any corrections. |
| `reviewed` | boolean | — | `false` until an annotator has explicitly confirmed or corrected this entry. |

**Reliability classes:** High-reliability fields (`root`, `quality`, `inversion`, `bass_pitch`, `soprano_pitch`) are derivable mechanically and are expected to be correct without review in most cases. Medium-reliability fields (`numeral`, `actual_key.value`) are probabilistic and must always be reviewed before a fragment reaches `approved` status.

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

---

## music21 reliability and review policy

Before a fragment can move from `submitted` to `approved`, a reviewing editor must have confirmed or corrected every field marked `"auto": true` in the `harmony` array and the `actual_key` object. The review state is tracked per harmony entry via the `reviewed` boolean. The peer review workflow surfaces unreviewed auto-generated fields prominently and blocks approval until all are cleared.

The service layer enforces this: `POST /api/v1/fragments/{id}/approve` returns a 422 if any harmony entry has `reviewed: false` and `auto: true`.

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

The movement-level cache for music21 preprocessing output. Created by the Celery task triggered on MEI upload (see `docs/adr/ADR-004-music21-pipeline-trigger.md`). One row per analysed movement; the preprocessing service slices the relevant beat range from this record at fragment creation time rather than re-running music21 per fragment.

```sql
CREATE TABLE movement_analysis (
    movement_id       TEXT PRIMARY KEY,          -- matches {composer_slug}/{corpus_slug}/{work_id}/{movement_id} from mei_file key
    mei_file          TEXT NOT NULL,             -- S3 object key of the source MEI file
    analysis_json     JSONB NOT NULL,            -- full beat-level harmonic analysis for the movement
    music21_version   TEXT NOT NULL,             -- version of music21 used; used to identify stale records after upgrades
    created_at        TIMESTAMPTZ DEFAULT now(),
    updated_at        TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX movement_analysis_music21_version_idx ON movement_analysis (music21_version);
```

**`movement_id`** follows the same naming convention as the path component in `mei_file` keys: `{composer_slug}/{corpus_slug}/{work_id}/{movement_id}`. The full S3 key is `{movement_id}.mei`.

**`analysis_json`** stores the complete beat-level harmonic analysis for the movement as produced by music21. The preprocessing service extracts the relevant bars from this JSONB object when populating a fragment's `summary.harmony` array; it does not call music21 at fragment creation time.

**`music21_version`** mirrors the `music21_version` field in the fragment `summary` JSONB. Records produced by an older music21 version can be identified by querying this column and selectively re-processed after a library upgrade that changes analysis output.

If an MEI file is corrected after upload (e.g. measure renumbering or score error fixes), the corresponding `movement_analysis` record is stale. The correction workflow must enqueue a re-analysis Celery task and flag any fragments derived from the stale record for re-review.

---

## Versioning policy

### What requires a version bump

A version bump is required for any change that would cause existing code reading `version: 1` records to misinterpret a field. This includes:

- Renaming any field
- Changing a field's type (e.g. string to integer)
- Removing any field
- Changing the semantics of an existing field (e.g. changing `root` from scale degree to MIDI number)
- Changing the structure of the `harmony` array entries

### What does not require a version bump

- Adding a new optional top-level field (provided consumers ignore unknown fields)
- Adding a new permitted value to `quality` or `properties`
- Adding new entries to the `harmony` array format that are purely additive

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

**Things that belong in the fragment table columns:** `bar_start`, `bar_end`, `key`, `meter`, `formal_role`, `status`, `prose_annotation`. These are first-class columns, not JSONB fields, because they are used as filter and sort conditions in queries. Moving them into JSONB would require GIN-indexed path queries where a column index is faster and clearer.

**Things that belong in `fragment_concept_tag`:** the concept membership relation. The `concepts` array in `summary` is a denormalised read convenience, not the source of truth.

**Free-text explanatory prose:** the prose annotation field is stored in `fragment.prose_annotation`, not inside `summary`. The vector embedding of that text will live in `prose_chunk`. Mixing structured data and prose in the JSONB would make both harder to query and to evolve.
