# ADR-015: Dual Measure Coordinate System

**Status:** Accepted
**Date:** 2026-04-30

---

## Context

Three measure-identification systems exist in the Doppia stack with no formally defined relationship between them.

**MEI `@n`** is the notated bar number written into the MEI source file. It is the coordinate system musicians use: scores display bar numbers, and fragments are described as "m. 72–75". However it is unreliable as a machine join key: it can be non-integer (`X1`, `X2` in MuseScore-exported MEI), it repeats across volta endings (both endings share `@n="3"`), and pickup bars conventionally use `@n="0"`. The Mozart staging corpus already contains all three of these cases.

**DCML `mc`** (measure count) is a 1-based, always-integer, monotonically increasing counter assigned by the DCML annotator in document order. It is unique across all measures in a movement, including both volta variants. It is the key used in the smart-merge policy (ADR-004) and is stored in `events[].mc`.

**Verovio position index** is the 1-based document-order rank used by `tk.select({measureRange: "start-end"})`. It is the only coordinate system Verovio's selection API accepts. It is not stored anywhere in the current codebase.

The consequence of the missing bridge: `_build_measure_map` currently keys on `(mn, volta)`, requiring `@n` to be parseable as an integer. On the Mozart staging corpus this produces spurious alignment warnings for every measure with a non-integer `@n`. More critically, there is no defined path from the stored `fragment.bar_start`/`bar_end` values to the position index needed for fragment rendering in Component 3.

A further observation: **DCML `mc` and Verovio position index are the same counter.** Both are 1-based document-order ranks over `<measure>` elements in a given MEI file, counting all physical measures including both volta variants. For any movement with a DCML annotation derived from that MEI, `mc=N` identifies the same measure as position index N.

---

## Decision

We adopt a dual coordinate system, with both coordinates stored on the `fragment` row.

**`mc_start` / `mc_end`** (new columns, `INTEGER NOT NULL`) — the position index / DCML measure count. This is the machine coordinate. It is stable, always integer, unique within a movement, and maps directly to Verovio's `measureRange` without conversion. It is the authoritative identifier for rendering and for cross-system joins (MEI ↔ DCML TSV ↔ Verovio).

**`bar_start` / `bar_end`** (existing columns, semantics unchanged) — the notated bar number (`@n` value). This is the human coordinate. It is the number a musician sees on the score, used for display labels ("m. 72–75"), API responses, and editorial communication. It is retained as-is; no migration of existing data is required.

`repeat_context` is retained as a display-only field ("first ending", "second ending"). It is no longer required for measure disambiguation — `mc_start`/`mc_end` already unambiguously identify the physical measures — but it remains useful for human-readable fragment descriptions.

Both coordinates are written at tag time. The tagging tool has the MEI in memory (Verovio is rendering it), so it can compute both the position index (by walking `<measure>` elements in document order) and the `@n` value (from the element attribute) without an additional round-trip. No lookup is needed at read time; the fragment row is self-contained for both rendering and display.

`_build_measure_map` is rebuilt to return `{position_index: MeasureEntry(n_raw, volta, xml_id)}` rather than `{(mn, volta): xml_id}`. Non-integer `@n` values are no longer dropped — the entry is added with the raw string preserved. The alignment check in `_parse_dcml_harmonies` is updated to key on `ev["mc"]` rather than `(ev["mn"], ev["volta"])`.

---

## Consequences

**Positive.**

- The alignment check becomes robust to non-integer `@n` values, eliminating the spurious warnings on the Mozart staging corpus.
- Fragment rendering in Component 3 uses `mc_start`/`mc_end` as `measureRange` operands directly, with no coordinate conversion at render time.
- Human-readable bar labels remain accurate and immediately available on the fragment row without secondary lookups.
- `_build_measure_map` becomes simpler and more defensive: it no longer silently drops measures.

**Negative / trade-offs.**

- `mc_start`/`mc_end` are position indices, not notated bar numbers, and are not human-interpretable in isolation. Any UI or API consumer must use `bar_start`/`bar_end` for display and `mc_start`/`mc_end` only for rendering calls. This distinction must be enforced by convention and documented clearly.
- Slight redundancy: both coordinates live on the row. This is accepted because the common read path benefits from a single SELECT with no joins or secondary lookups.
- Synchronisation risk: if a stored `bar_start` value drifts from the MEI's current `@n`, the display label would be wrong. This is managed by the normalizer's stability guarantee — `@n` values are established at ingest and not changed by any subsequent pipeline step. A deliberate MEI re-ingestion is an editorial act that should trigger a data migration.

**`repeat_context` and the harmony event range query.** The claim that `repeat_context` is "display-only" applies to *rendering*: `mc_start`/`mc_end` are sufficient to identify the physical measures without it. However, `repeat_context` currently plays a second role in the approval-gate harmony range query (documented in `docs/architecture/fragment-schema.md`), where it is used to filter `movement_analysis` events by `volta` when a fragment falls inside a repeat ending. This secondary use is unaffected by this ADR and remains correct under the current query design. The cleaner long-term approach — filtering harmony events by `mc` range directly (`event.mc >= mc_start AND event.mc <= mc_end`) rather than by `(mn, volta)` + `repeat_context` — avoids the indirection entirely and will produce correct results because `mc` is unique per ending. This simplification is deferred to Component 3 when the harmony query is first implemented. See also `docs/adr/ADR-005-sub-measure-precision.md` for the related beat-level coordinate design.

**Movements without DCML annotation.** For movements where no DCML TSV exists, `mc` values are not available from the TSV. In these cases the tagging tool derives position indices directly from the MEI (document-order walk), which is equivalent. No DCML data is required to write correct `mc_start`/`mc_end` values.

---

## Alternatives Considered

**Store only `mc_start`/`mc_end`, derive `@n` at display time.**
Rejected. The common read path (fragment browse, API response) needs the display label on every fragment. Deriving it at query time requires either a per-fragment MEI fetch from object storage or a materialised lookup table — both add complexity and a new synchronisation surface. Storing `@n` on the row is simpler.

**Store only `bar_start`/`bar_end` (`@n`), derive position index at render time via a reverse lookup.**
Rejected. This is the current implicit approach, and it is the source of the problem being solved. The reverse lookup requires `_build_measure_map` to parse `@n` as an integer, which fails silently on the Mozart corpus. It also adds a lookup to every render call.

**Change `bar_start`/`bar_end` to store `mc` and rename the columns.**
Considered. Rejected because it would require a data migration of all existing fragment rows, changes documented semantics in `fragment-schema.md`, and removes the human-readable coordinate from the primary column names. Adding new columns is a strictly additive change with no migration burden.

**Maintain a separate `measure_map` table in PostgreSQL.**
Considered for movements without DCML data. Rejected as premature: for Phase 1 all movements are DCML-annotated and the tagging tool derives position indices from the MEI at tag time. A materialised map table adds schema complexity with no current benefit. Revisit in Phase 2 if non-DCML movements require it.
