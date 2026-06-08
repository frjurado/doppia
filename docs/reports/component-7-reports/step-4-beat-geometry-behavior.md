# Step 4 — Stage Beat/Sub-beat Geometry: Expected Behaviour

Implementation shipped in commit on branch `feature/fragment-database`.
Files changed: `frontend/src/components/score/stages.ts`,
`frontend/src/components/score/StageBrackets.tsx`,
`frontend/src/components/score/__tests__/stages.test.ts`.

---

## 1. Bracket rendering at beat/sub-beat resolution

### Before any drag (measure-level pre-population, `beatStart = beatEnd = null`)

Brackets show **full measure width** regardless of the active resolution. This is correct — the stage has measure-level bounds. Switching the resolution toggle does not narrow the brackets; it only changes the snap grid for the next drag. Beat precision only exists in the bounds once a split handle has been dragged at beat/sub-beat resolution.

### After a split handle drag at beat resolution

After `moveSplitHandle` stores beat coordinates (e.g. `beatEnd = 2.0, barEnd = 3`), `resolveSegments` in `StageBrackets.tsx` will:

- include beat ghosts in bar 3 with `beatFloat < 2.0` → beat 1.0 only;
- set the bracket's right pixel edge to the **right edge of the beat-1.0 ghost** = the **left edge of the beat-2.0 ghost** (beat ghosts tile contiguously between struck beats).

This is correct when beat 2.0 has a note in bar 3. If beat 2.0 has no note (un-struck beat), no ghost exists at `beatFloat = 2.0` and the snap could not have landed there — the stored `beatEnd` is whatever struck beat the snap found, and the bracket aligns with that position.

The `resolveSegments` change (`useBeat = resolution !== 'measure'`) affects only measure-level (null-beat) stages at beat/sub-beat resolution: they now source pixel positions from the beat ghost index rather than the measure ghost. In practice this is visually identical because `beatLefts[0] = mLeft`. The change's purpose is architectural consistency (same pixel source as the main bracket), not a visible correction for those stages.

---

## 2. Collapsing an optional stage by dragging a split handle

### At beat/sub-beat resolution

The collapse fires when `nearestBoundary` returns a position where `beatFloat ≤ leftStage.beatStart` (defaulting to `1.0` when null). `moveSplitHandle` calls `toggleStageAbsent` and returns the collapsed state. The drag handler detects `nextAbsent > prevAbsent`, fires `onSplitHandleMove`, then nulls `dragRef.current` so further mouse-move events are no-ops.

**Expected visual:** the optional stage bracket disappears, the adjacent stage extends to cover the vacated space, the split handle disappears, the drag ends silently on mouse-up.

**Prerequisite:** The user must drag close enough to the optional stage's left edge that `nearestBoundary` snaps to a ghost at or before that stage's `beatStart`. `SNAP_TOLERANCE` is 60 px — very narrow stages may require precise positioning.

### At measure resolution

Same collapse fires when `barN < leftStage.bounds.barStart` (left-stage collapse) or `barN > maxBarN` (right-stage collapse).

---

## 3. Required stage at minimum width

### Expected: stop at minimum, no bounce-back

When the boundary would give a required stage zero width, `moveSplitHandle` returns the **same reference** (`assignments`). The drag handler detects this and calls `onSplitHandleMove(lastValidAssignments)` — the bracket freezes at the last position where there was a valid snap between drag start and minimum.

### Known limitation

If the very first snap after mousedown is already at/past the minimum (the stage is already exactly 1 beat wide), `lastValidAssignments` is still `null` at that moment, so `stable = initialAssignments` and one visual bounce still occurs. This requires the stage to start exactly at minimum width; normally-sized stages will not encounter it.

---

## 4. What Step 4 does not fix

The plan description "the stage bracket rounds to a whole measure rather than honouring the beat/sub-beat extent" is **fully addressed only for optional-stage collapse**. For the bracket rendering of already-beat-precise stages, Step 4 improves pixel-source consistency but does not change the fact that bracket edges are derived from the **beat ghost width**, which depends on which beats have struck notes. If a bracket edge does not align with the expected beat position visually, the root cause is in beat ghost construction (how far a struck beat's ghost extends when adjacent beats are silent) — that is upstream of `StageBrackets.tsx` and is not a Step 4 concern.

Any discrepancy of that kind should be logged as a separate issue against `ghosts.ts` / `computeBeatBoundaries`.
