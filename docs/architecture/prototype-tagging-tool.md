# Prototype — Tagging Tool Analysis
## Reference Document for the Doppia Tagging Interface

---

## Overview

A past prototype for this project includes two JavaScript modules — `ghost.js` and `annotator.js` — that together implement a score annotation interface built on top of Verovio-rendered SVG. The system was used to tag musical fragments by drawing selections directly on a rendered score. The tag content was simpler than what Doppia requires, but the core SVG interaction architecture is sound and worth carrying forward with adaptations.

---

## What the Two Files Do

### `ghost.js` — Structural layer

`ghost.js` builds an invisible SVG overlay on top of the Verovio-rendered score and exposes a spatial index of interactive regions keyed by musical position.

**Core idea:** rather than trying to interact with Verovio's internal SVG elements directly (which are unstable across re-renders), a second layer of transparent SVG rectangles — "ghosts" — is created and positioned to match the rendered notation. All mouse interaction targets these ghosts, not the notation itself.

**What it creates:** two kinds of ghost regions, each structured as an SVG `<g>` containing several overlapping rectangles:

- **Measure ghosts** (`.gstmsr`) — sit over the staff lines of a full measure. Each contains a main rect, left and right edge rects (for boundary identity), and left and right gradient-fade edit zones (for drag affordance).
- **Beat ghosts** (`.gstbeat`) — sit above the staff in the empty space over the top staff line. Same anatomy, with an additional top rect.

**Boundary computation:** Verovio does not expose beat boundaries as geometric primitives. `ghost.js` infers them from notehead positions. For each measure, it iterates all notes, calls `tk.getTimesForElement(note.id)` to get each note's score-time onset, converts that to a beat index via `Math.floor(scoreTimeOnset * beatUnit / 4.0)`, and tracks the leftmost notehead x-position per beat. Each beat's left boundary is the leftmost notehead in that beat (minus a small margin); its right boundary is the left boundary of the next struck beat. The last struck beat extends to the measure's right edge.

**Spatial indexes:** two exported arrays — `measureIndex[n]` keyed by measure number, and `beatIndex[100*m + b]` keyed by a flat encoding of measure and beat number — give O(1) lookup of any ghost element by musical position.

**Gradient zones:** the faded gradient rectangles at each edge of a ghost communicate "this boundary is draggable" without explicit UI chrome. In the interaction layer, hovering over an existing selection's endpoint activates only the gradient zone, signalling that the boundary can be adjusted.

---

### `annotator.js` — Behavioural layer

`annotator.js` implements the user interaction logic for creating an annotation. It never creates SVG elements — it reads from the ghost indexes and toggles CSS classes on ghost rects to produce all visual feedback.

**Visual state model:** all highlighting is done by adding or removing two CSS classes — `'light'` (hover hint) and `'dark'` (active selection) — on ghost child elements via two helpers, `add(container, selectors, cls)` and `rmv(container, selectors, cls)`. Direct style manipulation is avoided entirely.

**The `Annotation` class** manages a session from start to submission. Each annotation session requires three things: a named pattern (the concept label), a fragment (a measure range), and a pattern span (a beat range within the fragment). The class tracks each independently and validates them together before enabling submission.

**State machine:** a `phase` string (`'waiting'`, `'frgmSel'`, `'ptrnSel'`) drives all listener behaviour. The state transitions are:

```
waiting
  └─ mousedown on measure ghost (no fragment set) ──► frgmSel
  └─ mousedown on endpoint of existing fragment   ──► frgmSel (from opposite end)
  └─ mousedown on beat ghost (no pattern set)     ──► ptrnSel
  └─ mousedown on endpoint of existing pattern    ──► ptrnSel (from opposite end)

frgmSel
  └─ mouseup ──► waiting (fragment committed)

ptrnSel
  └─ mouseup ──► waiting (pattern committed)
```

**Range selection:** on mousedown, an anchor position is recorded (`fA` or `pA`). On mouseenter, the full range from the anchor to the current position is highlighted by iterating `measureIndex` or `beatIndex`. On mouseup, the range is committed and the phase returns to waiting.

**Endpoint re-selection:** if the user clicks on an existing selection's left or right endpoint, the drag re-anchors from the opposite end. This allows boundary refinement without starting over — a significant UX improvement over discarding and redrawing.

**Validation:** three completion flags (`fDone`, `pDone`, `pnDone`) update a live toast panel with ✅/❌ as each component is set. A containment check ensures the beat pattern lies within the measure fragment (using `Math.floor(pStart / 100)` to decode the flat beat key back to a measure number). The submit button is disabled until all three components are valid and the containment constraint is met.

**Submission:** a URL-encoded POST to `/annotate` with `pattern`, `fStart`, `fEnd`, `pStart`, `pEnd`, and a client-generated random ID. On success, the score and fragment list are reloaded.

---

## What Transfers to the New System

| Element | Verdict | Notes |
|---|---|---|
| Ghost overlay architecture | **Keep as-is** | Core architectural insight; robust to Verovio re-renders |
| Two-file structural/behavioural split | **Keep** | Clean separation; both files independently testable |
| `measureIndex` flat array + range iteration | **Keep** | O(1) lookup, clear range iteration pattern |
| Drag-select state machine | **Keep** | mousedown/enter/leave/up model is the right interaction |
| Endpoint re-selection for boundary adjustment | **Keep** | Important UX detail; avoids discard-and-redraw |
| `add`/`rmv` class-toggle helpers | **Keep** | Keeps visual state in CSS; decoupled from interaction logic |
| Live completion tracking in toast | **Keep, adapt** | Components tracked will differ; pattern is reusable |
| Gradient edge zones as drag affordance | **Keep** | Communicates adjustability without explicit chrome |
| Per-element `addListeners` | **Replace** | Use event delegation on a container element instead |
| `100*m+b` beat encoding | **Replace** | Make encoding and inverse explicit; or use a named Map |
| Client-generated IDs via `rstring()` | **Drop** | Use server-generated UUIDs; client stores the returned ID |
| URL-encoded form POST | **Replace** | JSON POST with Pydantic-validated body on server |
| `clearGhosts()` full DOM scan | **Replace** | Track highlighted ghosts in a Set; clear only those |
| DOM queries inside `Annotation` constructor | **Replace** | Inject UI elements at construction; improves testability |
| Dual measure/beat selection as parallel workflows | **Doesn't apply** | New model has one primary selection + classification workflow |
| Flat pattern list selection | **Doesn't apply** | Replaced by graph-backed concept search with hierarchy display |
| Score reload on submit | **Doesn't apply** | New system updates overlay layer only; score render is stable |

---

## Per-Beat and Sub-Beat Rectangle Overlays

### Beat boundary computation in detail

The algorithm infers beat boundaries from notehead positions — Verovio provides no geometric primitives for beats. For each measure:

1. Arrays `bLefts` and `bRights` of size `beatCount` are initialised to `mRight` (the measure's right edge, used as a sentinel).
2. `bLefts[0]` is set to `mLeft` — the first beat always begins at the measure's left edge, adjusted past any clef, key signature, or time signature at system starts.
3. For each note, score-time onset is fetched from Verovio and converted to a measure-local beat index (see below).
4. The leftmost notehead x-position in each beat is tracked (minus a small margin `marg = 50`). **Accidentals are excluded from this comparison** — in dense multi-voice writing, accidentals may visually intrude into the space of the preceding beat, and including them would produce ghost boundaries that are shifted too far left.
5. Each beat's right boundary is the left boundary of the next struck beat. The last struck beat extends to `mRight`.
6. Only beats containing at least one note onset (`struckBeats`) get a ghost.

**The dividing line between beat N and beat N+1** is therefore the leftmost notehead (excluding accidentals) of beat N+1, minus the margin. There is no explicit grid; the visual rhythm of the notation defines the boundaries.

**Onset values and measure-local conversion.** Verovio's `getTimesForElement()` returns `scoreTimeOnset` as an *absolute* time from the start of the piece, in units where a quarter note = 1.0. To convert to a measure-local beat index, the code subtracts the current measure's own start time before applying the formula:

```javascript
const measureLocalOnset = scoreTimeOnset - measureStartTime;
const beat = Math.floor(measureLocalOnset * beatUnit / 4.0);
```

where `measureStartTime` is obtained by calling `getTimesForElement` on the measure element itself (or on the first note in the measure). For tied continuation notes, Verovio returns the onset of the *original attacked note*, so `measureLocalOnset` will be negative for any note tied in from a previous measure. The range check `if (beat >= 0 && beat < beatCount)` catches this.

**Compound meter correction.** The formula above, applied with the raw MEI `beatUnit` and `beatCount` values, produces one slot per written note value in the denominator. For 6/8 (`beatUnit=8`, `beatCount=6`) this yields 6 eighth-note slots — but the beat in compound meter is the dotted quarter, giving 2 slots. The correct beat-level index in compound meters divides the raw result by `subdivisionsPerBeat`:

```javascript
const isCompound = (beatUnit === 8) && (beatCount % 3 === 0);
const subdivisionsPerBeat = isCompound ? 3 : 2;

const rawSlot = Math.floor(measureLocalOnset * beatUnit / 4.0);
const beat    = isCompound ? Math.floor(rawSlot / subdivisionsPerBeat) : rawSlot;
```

`bLefts` and `bRights` should be allocated `isCompound ? beatCount / subdivisionsPerBeat : beatCount` slots (2 for 6/8, 3 for 9/8, 4 for 12/8). At the sub-beat layer, `rawSlot` is used directly — its 6 values for 6/8 become the 6 eighth-note sub-beat positions, which is correct.

### Sub-beat extension

Sub-beat precision requires running the same algorithm at a finer resolution. The changes are:

**Score-time conversion:**
```javascript
// Beat level
let beat = Math.floor(scoreTimeOnset * beatUnit / 4.0);

// Sub-beat level (subdivisions = 2 for binary, 3 for compound)
let subbeat = Math.floor(scoreTimeOnset * beatUnit / 4.0 * subdivisionsPerBeat);
```

**Flat index encoding** extends from two levels to three:
```javascript
// Beat: 100*m + b  (supports up to 99 beats per measure)
// Sub-beat: 10000*m + 100*b + sb  (supports up to 99 sub-beats per beat)
const BEAT_SCALE = 100;
const MEASURE_SCALE = 10000;

const encodeBeat    = (m, b)     => MEASURE_SCALE * m + BEAT_SCALE * b;
const encodeSubBeat = (m, b, sb) => MEASURE_SCALE * m + BEAT_SCALE * b + sb;

const decodeMeasure = (n) => Math.floor(n / MEASURE_SCALE);
const decodeBeat    = (n) => Math.floor((n % MEASURE_SCALE) / BEAT_SCALE);
const decodeSubBeat = (n) => n % BEAT_SCALE;
```

**Fragment data model:** `beat_start` and `beat_end` remain floats. The float value encodes subdivision-aware position as `beat + (subbeat / subdivisionsPerBeat)`. Examples in 4/4 at eighth-note precision: `1.0`, `1.5`, `2.0`, `2.5`. In 6/8 (3 sub-beats per beat): `1.0`, `1.333`, `1.667`, `2.0`. This representation is resolution-independent; the server does not need to know the subdivision mode used during tagging.

**Time signature subdivision table:**

| Time signature | Beat unit | Sub-beat unit | `subdivisionsPerBeat` |
|---|---|---|---|
| 4/4, 3/4, 2/4 | ♩ | ♪ | 2 |
| 4/4 (fine) | ♩ | ♬ | 4 |
| 6/8, 9/8, 12/8 | ♩. | ♪ | 3 |

Whether the beat is binary or ternary is derivable from the time signature: if `beatUnit == 8` and `beatCount % 3 == 0`, the beat is compound and `subdivisionsPerBeat = 3`; otherwise binary and `subdivisionsPerBeat = 2`.

**User interface:** a resolution toggle (segmented control outside the score) switches the active ghost layer between beat and sub-beat granularity. Both layers are always present in the DOM; toggling switches which layer accepts mouse events and which is visually suppressed. This avoids re-running ghost construction on toggle.

### Edge cases

The cases below are grouped by status. "Handled" cases are settled; "not yet handled" cases have a specified fix that must be implemented before sub-measure selection is production-ready; "by design" cases describe deliberate limitations.

---

#### Handled

**Empty beats.** Only beats containing at least one note onset get a ghost. A whole note held across four beats produces only one ghost spanning the measure. This is musically correct — the ghost tracks where things start, not how long they last.

**Ornament notes.** Notes with `scoreTimeDuration[0] == 0` are skipped. Grace notes have no real metric position and would corrupt beat boundary calculations. MEI encodes trills and other ornaments as single `<trill>` elements (never as expanded note sequences), so ornament glyphs do not appear as queryable notes and present no risk.

**System starts.** At the first measure of each system, `mLeft` is adjusted rightward past whichever of clef, key signature, or time signature is present, queried in that priority order.

**Multi-voice chords.** Multiple notes at the same onset compete only on x-position; the leftmost notehead wins. Accidentals are excluded from this comparison — in dense multi-voice writing they may visually intrude into the prior beat's space, and including them would shift ghost boundaries too far left.

---

#### Not yet handled

**Tied notes across barlines.** Verovio's `getTimesForElement` returns the onset of the *original attacked note* for tied continuation notes. After subtracting `measureStartTime`, this yields a negative `measureLocalOnset`, giving a `beat` value below zero. **Fix:** the range check `if (beat >= 0 && beat < beatCount)` before updating `bLefts` is sufficient — the continuation notehead is skipped and does not corrupt ghost boundaries. Note that the continuation notehead is visually present in the SVG; it is simply not used to define a beat boundary.

**Compound meter beat count.** The raw MEI attributes for 6/8 are `beatUnit=8`, `beatCount=6`. Without correction, the formula produces 6 eighth-note beat slots, not 2 dotted-quarter beats. **Fix:** apply the compound-meter correction described in the beat boundary section above. This must be resolved before any compound-meter score is tagged — the wrong beat count would write incorrect `beat_start`/`beat_end` values to the database.

**Mid-piece meter changes.** The current code reads the time signature once from `scoreDef` at the start of `addSuperGhosts`. If the meter changes mid-movement, `beatCount` and `beatUnit` will be wrong for subsequent measures. **Fix:** call `getMeterForMeasure()` for every measure, checking for a `<meterSig>` element within the measure's MEI node before falling back to the global `scoreDef` value. (See the implementation in ADR-005.) This fix is a prerequisite for sub-beat precision — getting the subdivision count wrong produces ghosts that don't align with noteheads.

**Repeat sections — ghost index collision.** By Doppia convention (see `docs/architecture/mei-ingest-normalization.md` §6), measures in first and second endings that occupy the same bar slot share the same integer `@n` — e.g. the first-ending bar 12 and the second-ending bar 12 both carry `@n="12"`. The flat `measureIndex` and `beatIndex` arrays would therefore map both endings to the same slot, with the second rendering overwriting the first. **Fix:** ghost IDs and index keys must incorporate ending context (e.g. `m${n}-e${endingN}`) when a measure falls within an `<ending>` element. The MEI parser must detect first/second ending context during ghost construction by walking up the DOM to the containing `<ending>` and reading its `@n`.

---

#### Selection constraints (by design)

**Backward repeat barlines as selection barriers.** A fragment cannot extend across a backward repeat barline (the `:|` sign) or a da capo/dal segno marker, since doing so would require a non-linear musical reading. The selection clamps at any such barline encountered during drag. Practically: a fragment *may* begin at the start of a repeated section and extend into the first ending (the music flows linearly there), but the backward repeat barline at the end of the first ending is a hard barrier — the selection cannot continue into the second ending or beyond. Da capo and dal segno structures are treated as barriers; selecting across them is deferred unless a specific strategy is adopted later. When a fragment ends inside a first or second ending, the `repeat_context` field on the stored fragment records which ending it belongs to.

**Notes outside the selected range — onset-based inclusion.** The fragment's `beat_start` and `beat_end` are selection boundaries, not onset filters per se. The rule is: a note whose onset falls *inside* the selection range is part of the fragment; a note whose onset falls *outside* is not, regardless of duration. This creates an intentional asymmetry at the start boundary: a note sounding at `beat_start` but attacked before it (e.g. a whole note whose onset is at beat 1 and the selection begins at beat 3) is not included. At the end boundary, a note attacked before `beat_end` but sounding past it is included — its sounding duration extends beyond the fragment boundary, but its onset is within range. This onset-based rule is documented in `fragment-schema.md` and governs how the rendering layer clips the fragment display.

**Notes spanning beat boundaries — onset-based assignment.** A half note on beat 1 has its onset on beat 1 regardless of its duration; it is assigned to beat 1's ghost. Beat 2's ghost is determined by whatever note (if any) begins on beat 2. This follows directly from the onset-based inclusion rule above: if no other voice articulates beat 2, no beat 2 ghost exists (see "Empty beats"). If another voice does begin on beat 2, the beat 2 ghost is present and the half note's continuation is irrelevant to ghost placement.

**Incomplete measures at repeat boundaries — likely handled; verify explicitly.** When a measure is split across a repeat barline, both halves carry `@metcon="false"` and distinct sequential integer `@n` values (see `docs/architecture/mei-ingest-normalization.md` §7). Each half appears as a separate measure in Verovio's SVG. Ghost construction reads `beatCount` from the prevailing meter for context but builds ghosts only for struck beats, so a half-measure with fewer beats than `beatCount` simply produces fewer ghosts without any error path. No special-case code is required. Worth testing with at least one split-measure score before Phase 1 ends.

**Pickup bars — likely handled; verify explicitly.** If an anacrusis is encoded as measure 0 with fewer beats than the time signature (normalized by the MEI ingest pipeline to `@n="0"` with `@metcon="false"`), `bLefts[0] = mLeft` still holds and only struck beats get ghosts, so the algorithm should behave correctly. Worth testing with at least one pickup-bar score before Phase 1 ends.
