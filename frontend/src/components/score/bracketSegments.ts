/**
 * Shared bracket-segment logic (M5, Component 12 Step 14).
 *
 * Companion to `bracketLanes.ts`: that module owns *where* brackets sit
 * vertically, this one owns the segments themselves — how a selection projects
 * to one bracket run per system row, and which ends draw a serif.
 *
 * `resolveSegments` lived in `MainBracket.tsx` until the live selection
 * bracket was removed (see below). It was never really that component's: it is
 * the projection every bracket surface uses, and `FragmentOverlay` imported it
 * from there for exactly that reason.
 *
 * ## Why there is no live selection bracket
 *
 * There was one, in its own lane 9px above each system. It drew a bar plus a
 * gradient fade at each end — and the fade was documented in its own source as
 * "purely cosmetic", duplicating the ghost layer's drag handles. The ghost
 * layer already fills the committed selection over the staff (`.ghost.dark`)
 * and already renders `.ghost-handle-left` / `-right`, so the bracket restated
 * what was on screen and charged a lane for it. Above-staff brackets now start
 * closer to the staff, which is what keeps them out of the system above.
 */

import type { GhostLayer, ResolutionMode } from './ghosts';
import type { SelectionRange } from './annotator';
import { effectiveMeasureKeys } from './selection';

// ---------------------------------------------------------------------------
// Internal types and helpers
// ---------------------------------------------------------------------------

export interface BracketSegment {
  systemTop: number;
  left: number;
  right: number;
  isFirst: boolean;
  isLast: boolean;
}

interface MeasureExtent {
  /** Document-order position of the measure in the layer's measure index. */
  pos: number;
  systemTop: number;
  left: number;
  right: number;
}

/**
 * Fold per-measure pixel extents (ordered by document position) into bracket
 * segments. A new segment starts at a system break (systemTop change) or at a
 * document-order gap — the §6A.3 discontiguous rendering over excluded
 * sibling endings. Handles go on the very first and very last segment only.
 */
function foldSegments(extents: MeasureExtent[]): BracketSegment[] | null {
  if (extents.length === 0) return null;

  const segments: BracketSegment[] = [];
  let current: BracketSegment | null = null;
  let prevPos = Number.NaN;

  for (const ext of extents) {
    const contiguous = ext.pos === prevPos + 1;
    if (current && contiguous && current.systemTop === ext.systemTop) {
      current.left = Math.min(current.left, ext.left);
      current.right = Math.max(current.right, ext.right);
    } else {
      current = {
        systemTop: ext.systemTop,
        left: ext.left,
        right: ext.right,
        isFirst: false,
        isLast: false,
      };
      segments.push(current);
    }
    prevPos = ext.pos;
  }

  segments[0]!.isFirst = true;
  segments[segments.length - 1]!.isLast = true;
  return segments;
}

/**
 * Derive the bracket segments for the committed selection (§6A.1 I1 —
 * bracket ≡ ghost).
 *
 * Geometry derives from the selection's effective measure-key list — the
 * same committed ghost range the highlights render — never from `@n`
 * intervals. Pixel bounds come from the ghost index matching the active
 * resolution so the bracket is coincident with the highlighted ghosts at
 * every granularity (G3.2):
 *
 *  - resolution === 'measure' (or no beat-precision coords): full-measure
 *    bounds from the measure index.
 *  - resolution === 'beat' / 'subbeat': fine ghost bounds, with the
 *    beat-precision constraints applied only to the first and last measure
 *    of the selection (by key, not by barN — duplicate @n values must not
 *    truncate middle bars).
 *
 * For beat/sub-beat entries the systemTop used to anchor the bracket above
 * note content is borrowed from the parent measure ghost via entry.measureKey.
 *
 * Segments split at system breaks and at document-order gaps (excluded
 * sibling endings render as a visible gap — §6A.3 discontiguous rendering).
 */
export function resolveSegments(
  sel: SelectionRange,
  layer: GhostLayer,
  resolution: ResolutionMode
): BracketSegment[] | null {
  const keys = effectiveMeasureKeys(sel, layer);
  if (keys.length === 0) return null;

  const pos = new Map<string, number>();
  {
    let i = 0;
    for (const k of layer.measureIndex.keys()) pos.set(k, i++);
  }

  // Measure resolution or no beat-precision coords at either end: full-measure
  // bounds. The endpoints are independent — a range may constrain one and not
  // the other — so this must not short-circuit on beatStart alone.
  if (resolution === 'measure' || (sel.beatStart === null && sel.beatEnd === null)) {
    const extents: MeasureExtent[] = [];
    for (const k of keys) {
      const entry = layer.measureIndex.get(k);
      const p = pos.get(k);
      if (!entry || p === undefined) continue;
      extents.push({
        pos: p,
        systemTop: entry.systemTop,
        left: entry.bounds.left,
        right: entry.bounds.left + entry.bounds.width,
      });
    }
    return foldSegments(extents);
  }

  // Beat or sub-beat resolution with precise beatFloat coordinates.
  const index = resolution === 'beat' ? layer.beatIndex : layer.subBeatIndex;
  const keySet = new Set(keys);
  const firstKey = keys[0]!;
  const lastKey = keys[keys.length - 1]!;
  const beatStart = sel.beatStart ?? -Infinity;
  const beatEnd = sel.beatEnd ?? Infinity;

  const byMeasure = new Map<string, MeasureExtent>();
  for (const entry of index.values()) {
    if (!keySet.has(entry.measureKey)) continue;
    // Beat-precision constraints apply only to the endpoint measures;
    // intermediate measures contribute all their ghosts so the bracket spans
    // the full system width between the two beat-precise endpoints.
    if (entry.measureKey === firstKey && entry.beatFloat < beatStart) continue;
    if (entry.measureKey === lastKey && entry.beatFloat >= beatEnd) continue;

    const p = pos.get(entry.measureKey);
    if (p === undefined) continue;
    const measureEntry = layer.measureIndex.get(entry.measureKey);
    const sysTop = measureEntry?.systemTop ?? entry.bounds.top;
    const eLeft = entry.bounds.left;
    const eRight = entry.bounds.left + entry.bounds.width;

    const existing = byMeasure.get(entry.measureKey);
    if (!existing) {
      byMeasure.set(entry.measureKey, {
        pos: p,
        systemTop: sysTop,
        left: eLeft,
        right: eRight,
      });
    } else {
      existing.left = Math.min(existing.left, eLeft);
      existing.right = Math.max(existing.right, eRight);
    }
  }

  // An unconstrained endpoint keeps its whole measure, exactly as it would at
  // measure resolution. Without this it would start at the measure's first
  // notehead instead of its barline, leaving a gap after the stage before it —
  // the ghost span is narrower than the measure. Mirrors stageFrame's
  // clipMeasureExtent, which likewise overrides only the constrained side.
  if (sel.beatStart === null) {
    const ext = byMeasure.get(firstKey);
    const m = layer.measureIndex.get(firstKey);
    if (ext && m) ext.left = m.bounds.left;
  }
  if (sel.beatEnd === null) {
    const ext = byMeasure.get(lastKey);
    const m = layer.measureIndex.get(lastKey);
    if (ext && m) ext.right = m.bounds.left + m.bounds.width;
  }

  const extents = [...byMeasure.values()].sort((a, b) => a.pos - b.pos);
  return foldSegments(extents);
}

// ---------------------------------------------------------------------------
// Component

// ---------------------------------------------------------------------------
// Serifs
// ---------------------------------------------------------------------------

/** A rendered bracket segment's horizontal extent, within one system row. */
export interface SerifSpan {
  left: number;
  right: number;
  /** System row identity — only segments on the same row can abut. */
  lane: number;
}

/** Which ends of a segment should draw a serif. */
export interface SerifSides {
  left: boolean;
  right: boolean;
}

/**
 * Decide which ends draw a serif, so that an internal boundary draws exactly
 * one.
 *
 * Sub-parts and stages tile their parent, so neighbouring ends share an x.
 * Drawing both a right serif and the next bracket's left serif there put two
 * marks in the same place: with translucent status colours they composited
 * *darker* than a real serif, and nudging them apart to overlap only made the
 * outer ends sit visibly proud of their own bracket.
 *
 * The rule instead: **a segment drops its right serif when another segment
 * begins where it ends.** The boundary is then marked once, by the following
 * bracket's left serif, and every serif stays flush with its own bar.
 *
 * @param spans Segments in any order; results are returned in the same order.
 * @param tolerance Pixel slack for "begins where it ends" — segment extents
 *   come from measured geometry, so exact equality is not safe to assume.
 */
export function serifSides(spans: readonly SerifSpan[], tolerance = 1.5): SerifSides[] {
  // Left edges per lane, so the adjacency test is a scan rather than a product.
  const leftsByLane = new Map<number, number[]>();
  for (const span of spans) {
    const bucket = leftsByLane.get(span.lane);
    if (bucket) bucket.push(span.left);
    else leftsByLane.set(span.lane, [span.left]);
  }

  return spans.map((span) => {
    const lefts = leftsByLane.get(span.lane) ?? [];
    const abuts = lefts.some(
      (left) => Math.abs(left - span.right) <= tolerance && left !== span.left
    );
    return { left: true, right: !abuts };
  });
}
