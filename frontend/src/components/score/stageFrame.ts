/**
 * Stage layout frame — Component 9 Step 4 (tagging-tool-design.md §6A.4/§6A.5).
 *
 * The committed ghost range defines a slot list (the "stage layout frame",
 * §6A.1): one slot per grid unit of the selection's effective measure-key
 * range at the active resolution. Stage geometry is a partition of that slot
 * list — K active stages separated by K−1 interior boundary indices. Each
 * boundary is a single shared value, so:
 *
 *  - overlap and gaps are impossible by construction (§6A.4 overlap
 *    prohibition) — adjacent stages derive both their geometries from the
 *    one boundary index;
 *  - the first stage starts at slot 0 and the last ends at the final slot,
 *    exactly (I7 outer-edge pinning);
 *  - stage bounds cannot exit the main bracket (I8 containment).
 *
 * moveBoundary() is total: every drag position maps to a legal clamped
 * boundary vector (I9 — commit or clamp, never bounce). The drag moves
 * exactly one boundary; space freed by a shrinking stage is absorbed by the
 * stage on the growing side of the dragged handle (I6). Optional stages
 * overtaken by the drag collapse to zero width — the overtaken boundary
 * rides along so the gesture continues against the next one — and restore
 * when the drag retreats, because every tick re-derives from the gesture's
 * initial frame (I10). Required stages clamp the drag at one grid unit.
 *
 * References: tagging-tool-design.md §6A.1 §6A.4 §6A.5, ADR-005, ADR-015.
 */

import type { GhostLayer, ResolutionMode } from './ghosts';
import type { SelectionRange } from './annotator';
import type { StageAssignment, StageBounds } from './stages';
import { effectiveMeasureKeys } from './selection';

/** Tolerance for matching beatFloat values (float comparison). */
const BEAT_FLOAT_EPS = 0.001;

// ---------------------------------------------------------------------------
// Slots
// ---------------------------------------------------------------------------

/**
 * One grid unit of the stage layout frame: a measure at 'measure' resolution,
 * a beat/sub-beat ghost at 'beat'/'subbeat'. Slots are ordered by document
 * position (then beat onset) over the selection's effective key range, with
 * the selection's beat-precision endpoint filters already applied — so the
 * frame's outer edges coincide with the main bracket's exactly.
 */
export interface StageSlot {
  /** Deduplicated physical-measure ghost key of the parent measure. */
  measureKey: string;
  /** Guarded human bar number (finite by construction, I2). */
  barN: number;
  /** Float-encoded beat onset, or null for a measure-resolution slot. */
  beatFloat: number | null;
  /** Exclusive float upper bound (§6A.7), or null for a measure slot. */
  endFloat: number | null;
  /** Document-order position of the parent measure (gap detection, §6A.3). */
  pos: number;
  left: number;
  right: number;
  systemTop: number;
  systemBottom: number;
}

/**
 * Build the stage layout frame's slot list for a committed selection.
 *
 * Derives from the selection's effective measure-key list (§6A.1 — same
 * source as the main bracket), never from `@n` intervals: duplicate bar
 * numbers elsewhere in the movement contribute nothing (STG-10), and
 * excluded sibling endings leave a document-position gap that rendering
 * folds into segmented brackets (§6A.3).
 */
export function buildStageSlots(
  sel: SelectionRange,
  layer: GhostLayer,
  resolution: ResolutionMode,
): StageSlot[] {
  const keys = effectiveMeasureKeys(sel, layer);
  if (keys.length === 0) return [];

  const pos = new Map<string, number>();
  {
    let i = 0;
    for (const k of layer.measureIndex.keys()) pos.set(k, i++);
  }

  if (resolution === 'measure') {
    const slots: StageSlot[] = [];
    for (const k of keys) {
      const entry = layer.measureIndex.get(k);
      const p = pos.get(k);
      if (!entry || p === undefined) continue;
      slots.push({
        measureKey: k,
        barN: entry.barN,
        beatFloat: null,
        endFloat: null,
        pos: p,
        left: entry.bounds.left,
        right: entry.bounds.left + entry.bounds.width,
        systemTop: entry.systemTop,
        systemBottom: entry.bounds.top + entry.bounds.height,
      });
    }
    return slots;
  }

  const index = resolution === 'beat' ? layer.beatIndex : layer.subBeatIndex;
  const keySet = new Set(keys);
  const firstKey  = keys[0]!;
  const lastKey   = keys[keys.length - 1]!;
  const beatStart = sel.beatStart ?? -Infinity;
  const beatEnd   = sel.beatEnd ?? Infinity;

  const slots: StageSlot[] = [];
  for (const entry of index.values()) {
    if (!keySet.has(entry.measureKey)) continue;
    // Beat-precision constraints apply only to the endpoint measures (by key,
    // not barN — same filter as MainBracket.resolveSegments).
    if (entry.measureKey === firstKey && entry.beatFloat < beatStart) continue;
    if (entry.measureKey === lastKey  && entry.beatFloat >= beatEnd)  continue;

    const p = pos.get(entry.measureKey);
    if (p === undefined) continue;
    const measureEntry = layer.measureIndex.get(entry.measureKey);
    slots.push({
      measureKey: entry.measureKey,
      barN: entry.barN,
      beatFloat: entry.beatFloat,
      endFloat: entry.endFloat,
      pos: p,
      left: entry.bounds.left,
      right: entry.bounds.left + entry.bounds.width,
      systemTop: measureEntry?.systemTop ?? entry.bounds.top,
      systemBottom: entry.bounds.top + entry.bounds.height,
    });
  }

  slots.sort((a, b) => a.pos !== b.pos ? a.pos - b.pos : (a.beatFloat ?? 0) - (b.beatFloat ?? 0));
  return slots;
}

// ---------------------------------------------------------------------------
// Projection: StageAssignment bounds → boundary indices
// ---------------------------------------------------------------------------

/** Active stages and their interior boundaries projected onto a slot list. */
export interface StageFrameProjection {
  /** Non-absent, non-orphaned assignments with bounds, sorted by order. */
  active: StageAssignment[];
  /**
   * K−1 interior boundary slot indices (non-decreasing). boundaries[j] is the
   * first slot of active[j+1] — the single shared value both flanking stages
   * derive from (§6A.4).
   */
  boundaries: number[];
}

/**
 * Find the slot at which a stage's committed start boundary falls, scanning
 * monotonically from `from` (the previous boundary) so duplicate bar numbers
 * inside the range cannot capture the match early. Returns −1 when the
 * boundary lies outside the slot list (e.g. after a main-bracket shrink).
 */
export function findStartSlot(
  slots: StageSlot[],
  bounds: StageBounds,
  from: number,
): number {
  for (let i = from; i < slots.length; i++) {
    const s = slots[i]!;
    const keyMatch = bounds.keyStart !== undefined
      ? s.measureKey === bounds.keyStart
      : s.barN === bounds.barStart;
    if (!keyMatch) continue;
    if (bounds.beatStart === null) return i;          // measure-aligned start
    if (s.beatFloat === null) return i;               // measure slot: bar-level granularity
    if (Math.abs(s.beatFloat - bounds.beatStart) < BEAT_FLOAT_EPS) return i;
    if (s.beatFloat > bounds.beatStart) return i;     // nearest onset at/after the boundary
  }
  return -1;
}

/**
 * Project committed stage assignments onto a slot list.
 *
 * Total: a boundary that cannot be matched (stale bounds, coarser grid) falls
 * back to the previous boundary's position, keeping the vector non-decreasing
 * so derivation never produces out-of-order runs.
 */
export function projectBoundaries(
  assignments: StageAssignment[],
  slots: StageSlot[],
): StageFrameProjection {
  const active = assignments
    .filter(a => !a.absent && !a.orphaned && a.bounds !== null)
    .sort((a, b) => a.order - b.order);

  const boundaries: number[] = [];
  let from = 0;
  for (let j = 1; j < active.length; j++) {
    const found = findStartSlot(slots, active[j]!.bounds!, from);
    const idx = found === -1 ? Math.min(from, slots.length) : found;
    boundaries.push(idx);
    from = idx;
  }
  return { active, boundaries };
}

/**
 * Project a single stage's committed bounds onto a slot run [lo, hi).
 *
 * Used for stages outside the frame partition (orphaned stages keep their
 * bounds but no longer participate in the boundary vector). Returns null when
 * the start boundary cannot be located; an end boundary outside the slot list
 * clamps to the frame edge.
 */
export function projectRun(
  slots: StageSlot[],
  bounds: StageBounds,
): { lo: number; hi: number } | null {
  const lo = findStartSlot(slots, bounds, 0);
  if (lo === -1) return null;

  let hi = lo;
  let seenEnd = false;
  for (let i = lo; i < slots.length; i++) {
    const s = slots[i]!;
    const isEndMeasure = bounds.keyEnd !== undefined
      ? s.measureKey === bounds.keyEnd
      : s.barN === bounds.barEnd;
    if (isEndMeasure) {
      seenEnd = true;
      if (
        bounds.beatEnd !== null &&
        s.beatFloat !== null &&
        s.beatFloat >= bounds.beatEnd - BEAT_FLOAT_EPS
      ) {
        break;
      }
      hi = i + 1;
    } else if (seenEnd) {
      break; // moved past the end measure
    } else {
      hi = i + 1;
    }
  }
  return hi > lo ? { lo, hi } : null;
}

// ---------------------------------------------------------------------------
// Boundary move (I6 / I9 / I10)
// ---------------------------------------------------------------------------

/**
 * Move interior boundary `draggedIdx` toward slot index `target` and return
 * the new boundary vector. Pure and total — every input yields a legal
 * clamped result (I9), and only the dragged boundary plus any boundaries it
 * overtakes change (I6: the stage on the growing side of the handle absorbs
 * all freed space; far-side stages never move).
 *
 * Collapse semantics (I10): an optional stage squeezed to zero width has its
 * far boundary ride along with the drag (the gesture continues against the
 * next boundary); a required stage clamps the drag one slot before zero.
 *
 * `required` is indexed by active stage (length = boundaries.length + 1).
 */
export function moveBoundary(
  boundaries: number[],
  draggedIdx: number,
  target: number,
  required: boolean[],
  slotCount: number,
): number[] {
  if (draggedIdx < 0 || draggedIdx >= boundaries.length) return [...boundaries];
  const K = boundaries.length + 1;
  const old = boundaries;
  const clampedTarget = Math.max(0, Math.min(slotCount, Math.round(target)));

  if (clampedTarget >= old[draggedIdx]!) {
    // Forward: squeeze stages right of the handle. The drag stops one slot
    // short of the first required stage's right boundary.
    let tmax = slotCount;
    for (let s = draggedIdx + 1; s < K; s++) {
      if (required[s]) {
        tmax = (s <= K - 2 ? old[s]! : slotCount) - 1;
        break;
      }
    }
    const t = Math.min(clampedTarget, tmax);
    return old.map((b, j) => (j >= draggedIdx ? Math.max(b, t) : b));
  }

  // Backward: squeeze stages left of the handle (mirror).
  let tmin = 0;
  for (let s = draggedIdx; s >= 0; s--) {
    if (required[s]) {
      tmin = (s >= 1 ? old[s - 1]! : 0) + 1;
      break;
    }
  }
  const t = Math.max(clampedTarget, tmin);
  return old.map((b, j) => (j <= draggedIdx ? Math.min(b, t) : b));
}

// ---------------------------------------------------------------------------
// Derivation: boundary indices → StageAssignment bounds
// ---------------------------------------------------------------------------

/** Derive StageBounds for the slot run [lo, hi). Returns null for an empty run. */
function boundsFromRun(slots: StageSlot[], lo: number, hi: number): StageBounds | null {
  if (hi <= lo) return null;
  const first = slots[lo]!;
  const last  = slots[hi - 1]!;
  return {
    barStart:  first.barN,
    beatStart: first.beatFloat,
    barEnd:    last.barN,
    beatEnd:   last.endFloat,
    keyStart:  first.measureKey,
    keyEnd:    last.measureKey,
  };
}

/**
 * Derive a full assignments array from a boundary vector.
 *
 * Active stages get bounds from their slot runs (bar/beat coordinates plus
 * the physical measure keys, so geometry and mc resolution never fall back to
 * `@n` lookups); an empty run collapses an optional stage to absent. Absent
 * and orphaned assignments pass through unchanged. Stages whose id is in
 * `confirmIds` are marked confirmed (explicitly positioned by the annotator).
 *
 * Containment (I8) and outer-edge pinning (I7) hold by construction: runs
 * partition the frame, whose ends are the selection's exact endpoints.
 */
export function frameToAssignments(
  assignments: StageAssignment[],
  active: StageAssignment[],
  slots: StageSlot[],
  boundaries: number[],
  confirmIds?: Set<string>,
): StageAssignment[] {
  const K = active.length;
  const derived = new Map<string, StageAssignment>();

  for (let j = 0; j < K; j++) {
    const a = active[j]!;
    const lo = j === 0 ? 0 : boundaries[j - 1]!;
    const hi = j === K - 1 ? slots.length : boundaries[j]!;
    const bounds = boundsFromRun(slots, lo, hi);
    const confirmed = a.confirmed || (confirmIds?.has(a.stageId) ?? false);

    if (bounds === null) {
      // Zero-width run: optional stages collapse to absent (I10). A required
      // stage can only reach here through a degenerate frame (fewer slots
      // than stages); keep its committed bounds so nothing is silently lost.
      derived.set(a.stageId, a.required
        ? { ...a, confirmed }
        : { ...a, absent: true, bounds: null, confirmed });
    } else {
      derived.set(a.stageId, { ...a, bounds, absent: false, error: false, confirmed });
    }
  }

  return assignments.map(a => derived.get(a.stageId) ?? a);
}

// ---------------------------------------------------------------------------
// Rendering segments
// ---------------------------------------------------------------------------

/** One rendered segment of a stage bracket. */
export interface StageSegment {
  left: number;
  right: number;
  systemBottom: number;
  isFirst: boolean;
  isLast: boolean;
}

/**
 * Fold the slot run [lo, hi) into bracket segments. A new segment starts at a
 * system break or at a document-position gap — a stage straddling an excluded
 * sibling ending renders segmented with a visible gap, like the main bracket
 * (§6A.3 discontiguous rendering).
 */
export function foldStageSegments(
  slots: StageSlot[],
  lo: number,
  hi: number,
): StageSegment[] {
  const segments: StageSegment[] = [];
  let current: StageSegment | null = null;
  let prevPos = Number.NaN;

  for (let i = lo; i < hi && i < slots.length; i++) {
    const s = slots[i]!;
    const contiguous = s.pos === prevPos || s.pos === prevPos + 1;
    if (current && contiguous && current.systemBottom === s.systemBottom) {
      current.left  = Math.min(current.left, s.left);
      current.right = Math.max(current.right, s.right);
    } else {
      current = {
        left: s.left,
        right: s.right,
        systemBottom: s.systemBottom,
        isFirst: false,
        isLast: false,
      };
      segments.push(current);
    }
    prevPos = s.pos;
  }

  if (segments.length > 0) {
    segments[0]!.isFirst = true;
    segments[segments.length - 1]!.isLast = true;
  }
  return segments;
}

// ---------------------------------------------------------------------------
// Main-bracket resize response (§6A.5)
// ---------------------------------------------------------------------------

/** Result returned by respondToMainResize. */
export interface MainResizeResult {
  /** Updated stage assignments — confirmed boundaries preserved where their
   *  slots survive; unconfirmed runs redistributed by default_weight. */
  assignments: StageAssignment[];
  /**
   * If the resize required switching to a finer grid to fit all stages, this
   * is the new grid. Null when the current grid already works.
   */
  droppedGrid: ResolutionMode | null;
  /**
   * True when even sub-beat resolution cannot fit all active stages in the
   * new selection. The caller should surface a blocking checklist message.
   */
  blocked: boolean;
}

const GRID_RANK: Record<ResolutionMode, number> = { measure: 0, beat: 1, subbeat: 2 };

/**
 * Respond to a main-bracket resize with the hybrid redistribution + clamp
 * policy (§6, "Main bracket change after stages are committed"), recomputed
 * from the committed state on the new selection's frame — never incrementally
 * from the previous render, so repeated resizes cannot accumulate error
 * (§6A.5).
 *
 *  - Boundaries flanked by a confirmed stage keep their absolute position
 *    when the slot survives in the new frame (matched by measure key + beat
 *    onset — a resize on one side cannot move a stage on the other, STG-08).
 *  - Boundaries between unconfirmed stages redistribute by default_weight
 *    within the gaps the pinned anchors leave.
 *  - The frame's outer edges are the new selection's exact endpoints, so I7
 *    holds at every resolution with no drift (STG-06, STG-07).
 *  - Required stages keep at least one slot (the normalisation pass shifts
 *    pinned anchors minimally when the hard-clamp escape valve forces it);
 *    optional stages left without space collapse to absent.
 */
export function respondToMainResize(
  assignments: StageAssignment[],
  newSelection: SelectionRange,
  currentResolution: ResolutionMode,
  layer: GhostLayer | null,
): MainResizeResult {
  const active = assignments
    .filter(a => !a.absent && !a.orphaned && a.bounds !== null)
    .sort((a, b) => a.order - b.order);
  const K = active.length;
  if (K === 0 || layer === null) {
    return { assignments, droppedGrid: null, blocked: false };
  }

  const slotsByGrid: Partial<Record<ResolutionMode, StageSlot[]>> = {};
  const slotsAt = (g: ResolutionMode): StageSlot[] =>
    (slotsByGrid[g] ??= buildStageSlots(newSelection, layer, g));

  const mCount  = slotsAt('measure').length;
  const bCount  = slotsAt('beat').length;
  const sbCount = slotsAt('subbeat').length;

  if (K > mCount && K > bCount && K > sbCount) {
    return { assignments, droppedGrid: null, blocked: true };
  }

  const chosenGrid: ResolutionMode =
    mCount >= K ? 'measure' : bCount >= K ? 'beat' : 'subbeat';
  const droppedGrid =
    GRID_RANK[chosenGrid] > GRID_RANK[currentResolution] ? chosenGrid : null;
  const effectiveGrid: ResolutionMode =
    GRID_RANK[currentResolution] >= GRID_RANK[chosenGrid]
      ? currentResolution
      : chosenGrid;

  const slots = slotsAt(effectiveGrid);
  if (slots.length < K) {
    return { assignments, droppedGrid: null, blocked: true };
  }
  const N = slots.length;

  // 1. Pin boundaries flanked by a confirmed stage to their surviving slots.
  const pinned: (number | null)[] = [];
  let from = 0;
  for (let j = 1; j < K; j++) {
    const isPinned = active[j - 1]!.confirmed || active[j]!.confirmed;
    if (isPinned) {
      const idx = findStartSlot(slots, active[j]!.bounds!, from);
      if (idx !== -1) {
        pinned.push(idx);
        from = idx;
        continue;
      }
    }
    pinned.push(null);
  }

  // 2. Redistribute unpinned runs by default_weight within their gaps.
  const boundaries: number[] = new Array<number>(K - 1);
  let j = 0;
  while (j < K - 1) {
    if (pinned[j] !== null) {
      boundaries[j] = pinned[j]!;
      j++;
      continue;
    }
    // Unpinned run [j, runEnd): distribute over [lo, hi).
    let runEnd = j;
    while (runEnd < K - 1 && pinned[runEnd] === null) runEnd++;
    const lo = j === 0 ? 0 : boundaries[j - 1]!;
    const hi = runEnd === K - 1 ? N : pinned[runEnd]!;
    // Stages spanned by this run: active[j] .. active[runEnd].
    const runStages = active.slice(j, runEnd + 1);
    const totalWeight = runStages.reduce((s, a) => s + a.defaultWeight, 0) || 1;
    let cum = 0;
    for (let r = j; r < runEnd; r++) {
      cum += active[r]!.defaultWeight;
      boundaries[r] = lo + Math.round((hi - lo) * (cum / totalWeight));
    }
    j = runEnd;
  }

  // 3. Normalise: non-decreasing, in range, one slot per required stage.
  //    minB[j] / maxB[j] are the absolute feasibility bounds given required
  //    minima on each side (feasible because N ≥ K ≥ required count).
  const reqPrefix: number[] = new Array<number>(K + 1).fill(0);
  for (let s = 0; s < K; s++) {
    reqPrefix[s + 1] = reqPrefix[s]! + (active[s]!.required ? 1 : 0);
  }
  for (let b = 0; b < K - 1; b++) {
    const minB = reqPrefix[b + 1]!;                       // required stages left of the boundary
    const maxB = N - (reqPrefix[K]! - reqPrefix[b + 1]!); // required stages right of it
    boundaries[b] = Math.max(minB, Math.min(maxB, boundaries[b]!));
  }
  for (let b = 1; b < K - 1; b++) {
    const gap = active[b]!.required ? 1 : 0;
    boundaries[b] = Math.max(boundaries[b]!, boundaries[b - 1]! + gap);
  }
  for (let b = K - 3; b >= 0; b--) {
    const gap = active[b + 1]!.required ? 1 : 0;
    boundaries[b] = Math.min(boundaries[b]!, boundaries[b + 1]! - gap);
  }

  const updated = frameToAssignments(assignments, active, slots, boundaries);
  return { assignments: updated, droppedGrid, blocked: false };
}

// ---------------------------------------------------------------------------
// Split-handle drag targeting (§6A.4 I9, I11)
// ---------------------------------------------------------------------------

/** Max systemBottom distance (px) for a slot to count as "on this system". */
const SYS_TOLERANCE = 20;

/**
 * Resolve which system a cursor y falls on: the distinct slot systemBottom
 * nearest to y. Systems are far apart vertically relative to the bracket
 * lane's offsets, so nearest-bottom partitions the container into horizontal
 * bands with the switchover midway between adjacent systems.
 *
 * This is what lets a split-handle drag cross systems (§6A.4 I11, Component 9
 * Part 8 item 2): the target system follows the cursor tick by tick instead
 * of staying frozen at the drag-start handle's system.
 */
export function nearestSystemBottom(slots: StageSlot[], y: number): number {
  let best = slots[0]!.systemBottom;
  let bestDist = Infinity;
  for (const slot of slots) {
    const dist = Math.abs(slot.systemBottom - y);
    if (dist < bestDist) {
      bestDist = dist;
      best = slot.systemBottom;
    }
  }
  return best;
}

/**
 * Map a cursor x to the nearest boundary position (slot index 0..N) on the
 * cursor's system (resolved per mousemove tick via `nearestSystemBottom` —
 * not the drag-start system, so the handle can jump systems mid-drag, I11).
 * Total: always returns a position — there is no tolerance radius whose
 * failure would leave the handle behind the cursor (I9).
 * Boundary k sits at slot k's left edge; boundary N at the last slot's right.
 */
export function nearestBoundaryTarget(
  slots: StageSlot[],
  x: number,
  systemBottom: number,
): number {
  let best = 0;
  let bestDist = Infinity;
  let bestOnSystem = false;

  for (let k = 0; k <= slots.length; k++) {
    const ref = k < slots.length ? slots[k]! : slots[slots.length - 1]!;
    const edgeX = k < slots.length ? ref.left : ref.right;
    const onSystem = Math.abs(ref.systemBottom - systemBottom) <= SYS_TOLERANCE;
    const dist = Math.abs(edgeX - x);

    // Prefer candidates on the cursor's system; fall back to any system.
    if (onSystem === bestOnSystem ? dist < bestDist : onSystem) {
      best = k;
      bestDist = dist;
      bestOnSystem = onSystem;
    }
  }
  return best;
}
