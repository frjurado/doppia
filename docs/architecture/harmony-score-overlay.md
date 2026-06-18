# Harmony Score Overlay — Design Reference

## Status and purpose

This document specifies the in-score chord label overlay introduced in Component 7 Step 16 (G6.3). It covers data sourcing, coordinate mapping, rendering, volta filtering, mode gating, and the relationship between the overlay and the `HarmonyPanel` editing surface.

The overlay is **display-only**: it presents `movement_analysis` events positioned on the rendered score. All editing of those events remains in `HarmonyPanel` via the existing Step 7 (Component 5) primitives. The overlay and the panel share the same vocabulary and must remain in sync.

Related documents:
- `docs/architecture/fragment-schema.md` § "Harmonic analysis: movement-level single source of truth" — the `movement_analysis` table and event schema
- `docs/adr/ADR-005-sub-measure-precision.md` — the beat-float encoding
- `docs/roadmap/component-7-fragment-database.md` § Step 16 — the implementation task that created this module

---

## Mode gating

The overlay renders **only when `ScoreViewer` mode is `'tag'`**. Read-only `view` mode stays clean (score and MIDI only).

This is an intentional scope restriction: harmony labels are an annotator aid, not a reading surface. The gate is checked in `ScoreViewer.tsx` before mounting `harmonyOverlay.ts`; the module itself has no knowledge of view mode. If a view-mode reading aid is wanted later, removing the mount condition is the only change required.

---

## Data source

Events come from `GET /api/v1/movements/{id}/analysis/events`, the same endpoint `HarmonyPanel` uses. For the overlay the call is unfenced — it fetches all events for the movement, not a selection-scoped slice — because the overlay covers every visible system, not just the committed selection range.

The call is made by `harmonyOverlay.ts` via `analysisApi.getHarmonyEvents()` with `barStart = 1` and `barEnd = Infinity` (or omitting range parameters if the API accepts an unscoped call; if not, use the movement's first and last measure numbers from the `mcIndex`). The response is cached in the overlay module's local state and refreshed when a harmony edit is confirmed in `HarmonyPanel` (the overlay subscribes to a `harmonyUpdated` callback passed from `ScoreViewer`).

**No cross-database call in a route handler.** The route calls `FragmentService` (or the analysis service); the service reads `movement_analysis` from PostgreSQL. The overlay never talks to Neo4j.

---

## Coordinate mapping: `(mn, volta, beat)` → pixel x

Each `movement_analysis` event carries:
- `mn` — notated measure number (MEI `@n`; corresponds to `bar_start`/`bar_end` human coordinate)
- `volta` — ending number (`1`, `2`, …) when the event falls inside a `<ending>` element; `null` otherwise
- `beat` — 1-indexed float beat position within the measure (ADR-005 §"Data model")

The ghost layer already computes exact pixel x-positions for every beat. The mapping reuses the same lookup the selection tool uses.

### Step 1 — resolve the measure ghost

```ts
const measureKey = measureGhostKey(mn, volta);             // e.g. "m12-e1"
const measureEntry = ghostLayer.measureIndex.get(measureKey);
if (!measureEntry) return;                                   // system not yet rendered
```

`measureGhostKey` is the canonical deduplication key (handles volta collision and section-reset numbering). The `measureIndex` is populated by `buildGhosts()` after each Verovio render.

### Step 2 — resolve the beat ghost

The `beatIndex` is keyed by `encodeBeat(renderOrder, beatIdx)` where:
- `renderOrder` is the measure's 1-based document-order position (mc / DCML measure count), **not** `barN`. Use `mcIndex.get(measureKey)` to get it — `buildMcIndex()` returns this mapping and is already computed by `ScoreViewer` at render time.
- `beatIdx` is 0-indexed: `Math.floor(beat) - 1` (beat `1.0` → index `0`; beat `2.0` → index `1`).

```ts
const mc = mcIndex.get(measureKey);                          // 1-based document order
if (mc == null) return;
const beatIdx = Math.floor(event.beat) - 1;                 // 0-indexed
const beatEntry = ghostLayer.beatIndex.get(encodeBeat(mc, beatIdx));
if (!beatEntry) return;                                      // beat not present in this measure
const x = beatEntry.noteheadCenter;                          // leftmost-notehead center (see below)
```

**Centering on the notehead (Step 21).** `x` is the horizontal **center of the leftmost
notehead** at that metric position — the same head that defines the beat-boundary left
edge — *not* the beat-boundary left edge (`bounds.left`) itself. The label element is
positioned `left: x` and centered on it in CSS via `transform: translateX(-50%)`.

It is computed in `computeBeatBoundaries()` (`beatCenters[]` / `subBeatCenters[][]`) from
each note's `noteheadCenter()` x and stored on `BeatGhostEntry.noteheadCenter` /
`SubBeatGhostEntry.noteheadCenter` by `buildGhosts()`. Accidentals and ornaments are
excluded (it uses the `<g class="noteHead">` geometry, the same accidental-aware
resolution as `noteheadLeftEdge()`).

The **leftmost** head is used deliberately rather than an average over the beat: notes
bucket into a beat by onset, so averaging would pull the label rightward as later notes
within the beat (e.g. an eighth on the "&") are added. When a beat has displaced
simultaneous noteheads — a 2nd interval, where Verovio offsets one head off the stem —
the label centers on the leftmost (stem-side) head. Empty measures (no onsets) fall back
to the measure center.

### Step 3 — vertical position

Each label sits in a **harmony lane** below the system that contains the measure. The lane's top is computed from the system bounding box:

```ts
const systemBottom = measureEntry.bounds.top + measureEntry.bounds.height;
const LANE_OFFSET_PX = 6;
const y = systemBottom + LANE_OFFSET_PX;
```

`bounds.top` and `bounds.height` on `MeasureGhostEntry` span the staff lines only. The harmony lane sits just below this box, sharing the whitespace between systems. The offset is small enough to stay within the inter-system gap at every supported zoom level. If label text is tall, the lane may push into the gap — test against the smallest font size supported by `DESIGN.md` and the densest score (e.g. K.331 movement 3).

---

## Volta/ending filtering

An event with `volta = 1` belongs to the first ending only; it must not render at the same notated position as `volta = 2`. The `measureGhostKey(mn, volta)` key already disambiguates: if a measure ghost for `m12-e1` is visible and one for `m12-e2` is not (because only one ending is rendered on this pass), only the visible ghost has a `measureIndex` entry. The lookup in Step 1 naturally returns `undefined` for the absent ending, and the event is silently skipped.

This mirrors the approval-gate logic in `fragment-schema.md` § "Fragment approval and harmony review": `repeat_context = "first_ending"` restricts the gate check to events with `volta = 1`. The overlay uses the same `(mn, volta)` identity to determine which events to show, so the visual and analytical surfaces are consistent.

For Verovio renders that expand both endings (some score layouts render both passes in full), both `m12-e1` and `m12-e2` will have ghost entries, and both sets of events will be shown — one label set per ending. This is correct: the annotator can see which events belong to which pass.

---

## Re-render behaviour

The overlay is rebuilt on every Verovio re-render via the shared G1.3 `reproject()` signal in `ScoreViewer`. The sequence:

1. Verovio re-renders (scale change, font change, resize).
2. `ScoreViewer` calls `buildGhosts()` and updates `ghostLayer`.
3. `ScoreViewer` fires `reproject()` to all overlay consumers.
4. `harmonyOverlay.ts` receives the signal, iterates the cached events, runs the `(mn, volta, beat)` → pixel x mapping against the new `ghostLayer`, and repositions all label elements.

Labels are absolutely-positioned HTML elements. They are never injected into Verovio's SVG (CLAUDE.md §"Verovio SVG overlay rule"). On `reproject()`, the module either updates the `left`/`top` style of existing DOM nodes or tears down and rebuilds the label set — whichever is simpler. Because events are stable (not re-fetched on resize), the tear-down-rebuild path is preferred for correctness: it avoids stale nodes for events that mapped to no ghost on the new render.

---

## DOM structure and CSS

`harmonyOverlay.ts` creates one overlay `<div>` positioned `absolute; inset: 0; pointer-events: none; z-index: 25` (above ghost layer at z-index 20, below the bracket overlays at z-index 30 — confirm against the z-index table in `ScoreViewer.module.css`). Each label is a child `<span>`:

```html
<div class="harmony-overlay">
  <span class="harmony-label"
        style="left: 412px; top: 318px">
    V65 (A major)
  </span>
  …
</div>
```

Label content is the **primary label** format used by `HarmonyPanel`: `numeral + "/" + applied_to` (if secondary function) followed by `" (" + local_key + ")"`. For example:
- `V65 (A major)` — simple dominant seventh chord
- `V7/V (A major)` — secondary dominant
- `ii6 (D minor)` — supertonic first inversion

This keeps the panel and in-score labels lexically identical so annotators can cross-reference without translation.

CSS rules live in `harmonyOverlay.module.css`. Font: **Newsreader serif at 12px**, centered on the notehead-centroid anchor x via `transform: translateX(-50%)` (Step 21). This is a deliberate departure from the Public Sans label tier in `DESIGN.md`: in-score analysis text reads as engraved Roman-numeral / figured-bass, which is conventionally serif (confirmed with Francisco, 2026-06-18). Colour: Henle Blue `#3f5f77` at reduced opacity (≈70%) so labels read but do not compete with the notation. `0px border-radius`, no border. Unreviewed events may carry a faint amber tint to match the `HarmonyPanel` review badge — implementation detail, not a hard requirement.

---

## Click-to-focus (nice-to-have)

Clicking a label may scroll the `HarmonyPanel` to the corresponding event and briefly highlight it. This is not required for Component 7 correctness; implement only if time permits. If implemented: add `pointer-events: auto` to the label span, attach a click handler, and emit a `harmonyLabelClicked(mn, volta, beat)` callback to `ScoreViewer`, which forwards it to `HarmonyPanel` via a ref or callback prop.

---

## Module interface

```ts
// frontend/src/components/score/harmonyOverlay.ts

export interface HarmonyOverlayOptions {
  container: HTMLElement;              // the score container element
  ghostLayer: GhostLayer;              // current ghost layer
  mcIndex: Map<string, number>;        // measureKey → 1-based mc (from buildMcIndex)
  events: HarmonyEventOut[];           // movement_analysis events (all for the movement)
  onLabelClick?: (mn: number, volta: number | null, beat: number) => void;
}

export class HarmonyOverlay {
  constructor(options: HarmonyOverlayOptions);
  /** Rebuild all label positions from the current ghostLayer and mcIndex. */
  reproject(ghostLayer: GhostLayer, mcIndex: Map<string, number>): void;
  /** Replace the event list (called after a harmony edit in HarmonyPanel). */
  setEvents(events: HarmonyEventOut[]): void;
  /** Remove overlay DOM nodes; call when unmounting or leaving tag mode. */
  destroy(): void;
}
```

`ScoreViewer` constructs `HarmonyOverlay` after the first `buildGhosts()` completes in tag mode, passes it `ghostLayer` and `mcIndex` on each `reproject()` call, and calls `setEvents()` whenever `HarmonyPanel` reports a confirmed edit.

---

## Verification

- In tag mode on a DCML-annotated movement, chord labels appear under the correct system at the beat x-position of each event.
- Labels track zoom and resize changes via `reproject()` with no drift against the ghost positions.
- Volta filtering: first-ending labels appear at the correct physical position; second-ending labels appear at theirs; neither bleeds into the other's rendered pass.
- The `HarmonyPanel` and in-score labels use identical vocabulary (same `numeral`/`applied_to`/`local_key` format).
- Labels do not appear in view mode.
- Labels do not intercept ghost drag-select interactions (`pointer-events: none` on the overlay container).
- Vitest: `(mn, volta, beat)` → `encodeBeat(mc, beatIdx)` lookup is correct for ordinary measures, first-ending measures, second-ending measures, and pickup-bar measures (`mn=0`).
