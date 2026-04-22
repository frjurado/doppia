# ADR-005 — Sub-Measure Selection Precision in the Tagging Tool

**Status:** Accepted  
**Date:** 2026-03-27  
**Supersedes:** Initial deferral of sub-measure precision to Phase 2 — see `docs/roadmap/phase-1.md`, Open Decisions table ("Sub-measure precision in Phase 1" row)

---

## Context

The tagging tool requires annotators to mark the spatial extent of a musical fragment on the rendered score. The fragment data model includes four boundary fields:

```sql
bar_start   INTEGER NOT NULL
bar_end     INTEGER NOT NULL
beat_start  FLOAT   -- initially nullable
beat_end    FLOAT   -- initially nullable
```

The initial decision was to implement measure-level precision only in Phase 1 and defer beat-level (and sub-beat-level) selection to Phase 2, with `beat_start` and `beat_end` scaffolded as nullable columns. The rationale was uncertainty about the technical feasibility of computing beat boundaries from Verovio-rendered SVG.

That technical uncertainty has been resolved. A prior prototype tagging tool implemented per-beat selection successfully, including the beat boundary inference algorithm, the SVG ghost overlay architecture, and the drag-selection interaction model. The prototype code is directly applicable to this system with known adaptations. A full analysis of what transfers and what requires change is documented in `docs/architecture/prototype-tagging-tool.md`.

Additionally, establishing the sub-measure coordinate system in Phase 1 — before any fragment data is written to production — avoids what would otherwise be a costly retroactive migration. Fragment records with null `beat_start`/`beat_end` would require re-annotation by domain experts to add sub-measure precision. Writing that data correctly from the start is far less expensive than recovering it later.

---

## Decision

Implement beat-level and sub-beat-level selection precision in Phase 1 of the tagging tool. The nullable `beat_start`/`beat_end` columns are promoted to used fields from the first annotation session.

Sub-beat precision (eighth notes within a beat, or eighth notes within a dotted-quarter beat in compound meters) is included in Phase 1 as a user-selectable resolution mode. The common case (beat-level selection) remains the default; sub-beat mode is an opt-in refinement.

---

## Implementation Specification

### Data model

`beat_start` and `beat_end` are float columns encoding subdivision-aware beat position as:

```
beat_position = beat_number + (subbeat_index / subdivisions_per_beat)
```

where `beat_number` is 1-indexed (matching MEI convention) and `subbeat_index` is 0-indexed within the beat.

Examples:

| Time sig | Position | `beat_start` value |
|---|---|---|
| 4/4 | Beat 2 | `2.0` |
| 4/4 | Beat 2, second eighth | `2.5` |
| 4/4 | Beat 3, third sixteenth | `3.5` |
| 6/8 | Beat 1, second eighth | `1.333...` |
| 6/8 | Beat 2, third eighth | `2.667...` |

This representation is resolution-independent: the server does not need to know which subdivision mode was active during tagging. The float value is unambiguous given the time signature.

**Constraint:** `beat_start` and `beat_end` must satisfy:
- `floor(beat_start) >= bar_start`
- `ceil(beat_end) <= bar_end`
- `beat_start < beat_end`

These constraints are enforced at the Pydantic validation layer before any database write.

**Nullable convention:** `beat_start` and `beat_end` may remain null if the annotator makes a measure-level selection only. This is valid for concepts whose granularity does not warrant sub-measure precision (e.g. a formal section spanning many bars). Null means "the full extent of the measure range"; it does not mean "data missing."

---

### Ghost overlay architecture

Beat and sub-beat ghost regions are built on the same SVG overlay architecture as measure ghosts (see `docs/architecture/prototype-tagging-tool.md`). Two additional ghost layers are created above the staff.

#### Flat index encoding

Three-level flat index for O(1) lookup by musical position:

```javascript
const BEAT_SCALE    = 100;    // max 99 sub-beats per beat
const MEASURE_SCALE = 10000;  // max 99 beats per measure

const encodeBeat    = (m, b)     => MEASURE_SCALE * m + BEAT_SCALE * b;
const encodeSubBeat = (m, b, sb) => MEASURE_SCALE * m + BEAT_SCALE * b + sb;

const decodeMeasure = (n) => Math.floor(n / MEASURE_SCALE);
const decodeBeat    = (n) => Math.floor((n % MEASURE_SCALE) / BEAT_SCALE);
const decodeSubBeat = (n) => n % BEAT_SCALE;
```

These functions must be defined as named constants — not as inline arithmetic — so that the encoding contract is explicit and the inverse is always adjacent to the forward encoding.

#### Beat boundary inference

Beat boundaries are inferred from notehead positions. For each measure, Verovio's `getTimesForElement()` provides the score-time onset of each note. The onset is converted to a beat index:

```javascript
const beatIndex = Math.floor(onset * beatUnit / 4.0);
```

For sub-beat precision, the same conversion is applied at finer resolution:

```javascript
const subbeatIndex = Math.floor(onset * beatUnit / 4.0 * subdivisionsPerBeat);
```

The `subdivisionsPerBeat` value is derived from the time signature:

```javascript
const isCompound = (beatUnit === 8) && (beatCount % 3 === 0);
const subdivisionsPerBeat = isCompound ? 3 : 2;
```

For fine (sixteenth-note) precision in simple meters, `subdivisionsPerBeat = 4`.

**Per-measure meter reading is required.** The time signature must be read from the MEI node of each individual measure before falling back to the global `scoreDef`. This is necessary to handle mid-piece meter changes correctly and is a prerequisite for sub-beat precision being meaningful across a full movement.

```javascript
const getMeterForMeasure = (meiMeasure, globalBeatCount, globalBeatUnit) => {
  const localSig = meiMeasure.querySelector('meterSig');
  if (localSig) {
    const count = parseInt(localSig.getAttribute('count'));
    const unit  = parseInt(localSig.getAttribute('unit'));
    if (!isNaN(count) && !isNaN(unit)) return [count, unit];
  }
  return [globalBeatCount, globalBeatUnit];
};
```

#### Resolution toggle

A segmented control outside the score switches between three resolution modes:

| Mode | Label | `subdivisionsPerBeat` active |
|---|---|---|
| Measure | `𝄚` | — |
| Beat | `♩` / `♩.` | 1 |
| Sub-beat | `♪` | 2 or 3 |

All ghost layers are always present in the DOM. The toggle switches which layer accepts mouse events (via `pointer-events: all` / `pointer-events: none`) and which is visually active. Ghost construction is not re-run on toggle.

Sub-beat ghosts are visually distinguished from beat ghosts: smaller height above the staff, lighter default opacity, narrower edge zones.

---

### Edge cases

The following edge cases must be handled before sub-measure selection is considered production-ready. Each has a specified fix:

| Case | Status | Fix / Note |
|---|---|---|
| **Tied notes across barlines** | Not handled | Range-check `beat >= 0 && beat < beatCount` before updating `bLefts`; skip if out of range. Verovio returns the original attack onset for tied continuations; after subtracting `measureStartTime` this becomes negative. |
| **Compound meter beat count** | Not handled | For 6/8, 9/8, 12/8: allocate `beatCount / subdivisionsPerBeat` beat slots (2, 3, 4 respectively) and divide the raw slot index by `subdivisionsPerBeat` to get the beat-level index. Raw slot index is used directly for sub-beat ghosts. Must be fixed before any compound-meter score is tagged. |
| **Mid-piece meter changes** | Not handled | Read meter per measure from MEI node before falling back to global `scoreDef` (see `getMeterForMeasure()` above). Prerequisite for sub-beat precision. |
| **Repeat sections — ghost index collision** | Not handled | Measures in first and second endings share the same integer `@n` by Doppia convention (see `mei-ingest-normalization.md` §6). Incorporate ending context into ghost IDs and index keys (e.g. `m${n}-e${endingN}`); detect `<ending>` context during MEI parse by walking up the DOM to the containing `<ending>` and reading its `@n`. |
| **Incomplete measures at repeat boundaries** | Likely handled | Each half of a split measure has `@metcon="false"` and a distinct sequential `@n` (see `mei-ingest-normalization.md` §7). Ghost construction produces fewer ghosts than `beatCount` for an incomplete half, which is correct — only struck beats get ghosts. No special-case code required. Verify with at least one split-measure score before Phase 1 ends. |
| **Pickup bars** | Likely handled | Verify with at least one pickup-bar score in Component 9 corpus testing. MEI ingest normalizer ensures `@n="0"` and `@metcon="false"` on anacrusis measures. |
| **Ornament notes** | Handled | `scoreTimeDuration[0] > 0` check excludes grace notes. MEI trills are single `<trill>` elements and do not generate additional queryable note elements. |
| **Empty beats** | Handled | Only struck beats (those with at least one note onset) get ghosts. |
| **System starts** | Handled | `mLeft` adjusted past clef/key sig/time sig at measure 0 of each system. |
| **Multi-voice chords** | Handled | Leftmost notehead wins per beat; accidentals excluded from comparison. |
| **Backward repeat barlines as selection barriers** | By design | Selection clamps at `:|` barlines, da capo, and dal segno markers. Fragments may extend into a first ending; the backward repeat barline at the first ending's close is the barrier. `repeat_context` records which ending a fragment belongs to. |
| **Notes outside the selected range** | By design | Inclusion is onset-based: onset inside the `[beat_start, beat_end)` range → included; outside → excluded, regardless of duration. A note sounding at `beat_start` but attacked earlier is excluded; a note attacked before `beat_end` but sustaining past it is included. Documented in `fragment-schema.md`. |
| **Notes spanning beat boundaries** | Handled by design | Follows directly from onset-based inclusion. A held note is assigned to the beat of its onset; intermediate beats with no new onset in any voice have no ghost. |

The tied-note fix, compound-meter correction, and meter-change fix must all be implemented before sub-beat ghost construction runs on a real corpus. All three are correctness issues, not visual glitches — wrong beat boundaries or wrong beat counts would write incorrect `beat_start`/`beat_end` values to the database.

---

## Consequences

### Positive

- Fragment data is complete and correct from the first annotation session; no retroactive re-annotation required.
- The sub-measure coordinate system is established before the fragment corpus grows, making the encoding a stable contract rather than a migration target.
- Beat and sub-beat selection unlock richer exercise generation (e.g. "identify the onset of the dominant in this cadence") that would not be possible with measure-level precision alone.
- The ghost overlay architecture, adapted from the prior prototype, substantially reduces implementation risk — the core algorithm is proven.

### Negative

- The tagging tool is more complex to build in Phase 1. The per-measure meter-change fix in particular requires MEI parsing logic that was not needed for measure-level selection.
- The `100*m+b` encoding from the prototype must be extended and properly named before it is relied on for production data. This is a small but real refactoring cost.
- The resolution toggle adds a UI element and a layer of state to the score interaction that annotators must understand.

### Neutral

- `beat_start` and `beat_end` remain nullable. Measure-level-only annotations are valid. This maintains backward compatibility with any future concepts where sub-measure precision is not meaningful.
- The sub-beat float encoding is resolution-independent. The server is not coupled to the subdivision mode used during tagging.

---

## Alternatives Considered

**Defer to Phase 2 (original decision).** Rejected because the technical uncertainty that motivated deferral has been resolved by the prior prototype, and because the data migration cost of retrofitting sub-measure coordinates onto an existing corpus is significantly higher than implementing correctly in Phase 1.

**Store sub-beat positions as integer tuples `(beat, subbeat, subdivisions)` rather than floats.** Rejected because the float representation is simpler to query, sort, and compare on the server, and because the resolution-independence of the float encoding is a useful property. The tuple representation would require the server to normalise before comparison.

**Always require sub-beat selection; remove the measure-only and beat-only modes.** Rejected because most annotation concepts (formal sections, phrase boundaries) do not have meaningful sub-measure extents, and forcing annotators to specify sub-beat precision for every tag would add friction with no analytical benefit.
