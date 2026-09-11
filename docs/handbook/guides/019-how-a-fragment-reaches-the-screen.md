# How a Fragment Reaches the Screen

## What it is

The read path: everything that happens between "a fragment record exists in PostgreSQL" and "an engraved excerpt with its cadence tag is on screen in the browser". It touches all four data stores, and it is the clearest single illustration of the project's store boundaries.

## What it does

A fragment is not one thing stored in one place. It is a *bar range into a movement*, assembled at read time from four sources: the notation (object storage), the record and its analysis (PostgreSQL), the concept vocabulary behind its tags (Neo4j, cached in Redis), and the localised concept labels (PostgreSQL again, via the translation overlay). Nothing is pre-assembled; nothing is denormalised into a single blob.

## How it works

**1 — The fragment record.** `GET /api/v1/fragments/{id}` returns the row: the movement it points into, `mc_start`/`mc_end`, the JSONB `summary` (key, meter, analysis features), the prose annotation, its concept tags, and a **15-minute presigned URL** to the movement's *normalised* MEI in object storage.

**2 — The browser fetches the notation itself.** The MEI never passes through FastAPI on this path. The client takes the presigned URL and fetches the whole movement file directly from R2 (MinIO locally). This is why the URL is short-lived and must not be stored or reused.

**3 — Verovio renders in the browser, constrained to the range.** There is no server-side slicing. The client holds the entire movement in memory and renders only `mc_start`–`mc_end`. Because the whole movement is already there, rendering *with context* (ADR-024's `bars`, `enclosing_fragment`, `previous_same_domain` modes) costs nothing extra — which is exactly why the contract is a render parameter rather than a slicing service.

*Verovio does also run server-side*, but on a different path: ADR-008 renders a static per-fragment preview SVG when a fragment reaches `submitted` status, so browse lists cost URL fetches instead of renders. Client and server are pinned to the same Verovio 6.1.0 (ADR-013) so the two renders agree.

**4 — Harmonic analysis is sliced, not stored per fragment.** Chord-level analysis lives in `movement_analysis.events` — one analysis per movement, whatever number of fragments overlap it. The service layer slices it by the fragment's range at read time. Deleting a fragment never touches it.

**5 — Tags are resolved across two stores.** `fragment_concept_tag (fragment_id, concept_id, is_primary)` is the authoritative join surface; `concept_id` is a Neo4j `Concept.id` string, with **no foreign key** — no database-level link between the two stores exists. (`summary.concepts` carries the same ids as a denormalised ordered array; it is a read convenience, not the source of truth.) The names, definitions and relationships behind those ids come from Neo4j, with subtree expansions served from Redis. Localised labels come from the PostgreSQL translation overlay; the `en` path short-circuits, since Neo4j already carries the English values.

**6 — Playback is synthesised client-side.** No rendered audio exists anywhere in the system. Tone.js builds the sound in the browser from the notation. The only audio bytes in object storage are soundfont samples — the one public-read bucket, because Tone.js cannot carry signed query parameters.

## Why integrity holds without foreign keys

Because writes are guarded, not reads. Pydantic validates the *shape* of a write (`concept_id` is a non-empty string, exactly one tag is primary) — it cannot know whether a concept exists, being a pure in-process model. Existence is a **live Neo4j round-trip before the write**, in `services/fragment_validation.py`:

- `validate_concept_existence` — every id across the parent and all sub-parts, collecting all misses into one error
- `validate_summary_properties` — property values checked against the graph's `PropertySchema` nodes
- `validate_containment` — sub-part ranges must sit inside the parent's

Pydantic guards the shape; the service layer guards the cross-database referential integrity by asking Neo4j. Both are house rules — §1 and §3 respectively.

## Example

Bars 21–24 of a Mozart sonata movement, tagged *half cadence*. The API returns the record plus a signed MEI URL; the browser downloads the whole movement and Verovio renders only those four bars; the Roman numerals come from `movement_analysis.events` sliced to bars 21–24; the words "Half Cadence" and its definition come from Neo4j (very likely from the Redis subtree cache); the piano sound is synthesised in the tab from soundfont samples. Five sources, one screen, no foreign key anywhere between them.

## Related

`docs/architecture/project-architecture.md` (component narrative), `docs/architecture/fragment-schema.md` (tables and the analysis-slicing pattern), ADR-024 (rendering context), ADR-008 (server-side previews), ADR-013 (Verovio pinning). Plain-language background: guide 012 (MEI & Verovio), guide 010 (Pydantic).
