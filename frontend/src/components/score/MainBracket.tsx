/**
 * Layer 3 — Main bracket track (tagging-tool-design.md §3).
 *
 * Renders one coloured bracket segment per SVG system row once fragmentSet is
 * true. For single-system selections this is a single bar; for multi-system
 * selections it emits one segment per system:
 *   - First system: from barStart measure's left to end of that system.
 *   - Intermediate systems: full system width.
 *   - Last system: from start of system to barEnd measure's right.
 *
 * Gradient-zone handles appear only on the first segment's left edge (barStart
 * endpoint) and the last segment's right edge (barEnd endpoint). Intermediate
 * segments are visual connectors with no handles.
 *
 * All segments are positioned BRACKET_ABOVE_SYSTEM_PX above their system's
 * systemTop so the bracket clears note content above the staff.
 *
 * Architecture note: this component is rendered inside FragmentOverlay, which
 * has z-index: 30. The ghost overlay has z-index: 20. The bracket therefore
 * visually stacks above ghost highlights while remaining non-interactive
 * (pointer-events: none on the bracket and its handles).
 */

import type { GhostLayer, ResolutionMode } from './ghosts';
import type { SelectionRange } from './annotator';
import styles from './MainBracket.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Height of the bracket bar in pixels. */
const BRACKET_H = 5;
/** Width of each gradient handle zone. Clamped to one-third of bracket width. */
const HANDLE_W = 28;
/** Distance the bracket sits above systemTop: bracket height + small gap. */
const BRACKET_ABOVE_SYSTEM_PX = BRACKET_H + 4;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface MainBracketProps {
  /** Committed selection range from AnnotationSession, or null. */
  selection: SelectionRange | null;
  /** Ghost layer providing pixel bounds via the index matching resolution. */
  layer: GhostLayer | null;
  /** Bracket is only rendered when the fragmentSet flag is true. */
  fragmentSet: boolean;
  /** Active ghost resolution — determines which index supplies pixel bounds. */
  resolution: ResolutionMode;
}

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

/**
 * Resolve a SelectionRange to its effective measure-key list (§6A.1).
 *
 * The committed key list on the selection is authoritative. The fallback for
 * selections restored from stored human coordinates reconstructs it from the
 * bar range, applying the repeat_context ending exclusion (§6A.3) and
 * requiring finite bar numbers (I2) — a derivation keyed on `@n` intervals
 * alone painted unrelated partial bars and absorbed sibling endings
 * (fixtures SEL-03/05/08/12/13).
 */
function effectiveKeys(sel: SelectionRange, layer: GhostLayer): string[] {
  if (sel.measureKeys && sel.measureKeys.length > 0) return sel.measureKeys;
  if (!Number.isFinite(sel.barStart) || !Number.isFinite(sel.barEnd)) return [];

  const keys: string[] = [];
  for (const entry of layer.measureIndex.values()) {
    if (entry.barN < sel.barStart || entry.barN > sel.barEnd) continue;
    if (entry.endingN !== null) {
      if (sel.repeatContext === 'first_ending' && entry.endingN !== 1) continue;
      if (sel.repeatContext === 'second_ending' && entry.endingN === 1) continue;
    }
    keys.push(entry.key);
  }
  return keys;
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
      current.left  = Math.min(current.left, ext.left);
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
// eslint-disable-next-line react-refresh/only-export-components
export function resolveSegments(
  sel: SelectionRange,
  layer: GhostLayer,
  resolution: ResolutionMode,
): BracketSegment[] | null {
  const keys = effectiveKeys(sel, layer);
  if (keys.length === 0) return null;

  const pos = new Map<string, number>();
  {
    let i = 0;
    for (const k of layer.measureIndex.keys()) pos.set(k, i++);
  }

  // Measure resolution or no beat-precision coords: full-measure bounds.
  if (resolution === 'measure' || sel.beatStart === null) {
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
  const firstKey  = keys[0]!;
  const lastKey   = keys[keys.length - 1]!;
  const beatStart = sel.beatStart;
  const beatEnd   = sel.beatEnd ?? Infinity;

  const byMeasure = new Map<string, MeasureExtent>();
  for (const entry of index.values()) {
    if (!keySet.has(entry.measureKey)) continue;
    // Beat-precision constraints apply only to the endpoint measures;
    // intermediate measures contribute all their ghosts so the bracket spans
    // the full system width between the two beat-precise endpoints.
    if (entry.measureKey === firstKey && entry.beatFloat < beatStart) continue;
    if (entry.measureKey === lastKey  && entry.beatFloat >= beatEnd)  continue;

    const p = pos.get(entry.measureKey);
    if (p === undefined) continue;
    const measureEntry = layer.measureIndex.get(entry.measureKey);
    const sysTop = measureEntry?.systemTop ?? entry.bounds.top;
    const eLeft  = entry.bounds.left;
    const eRight = entry.bounds.left + entry.bounds.width;

    const existing = byMeasure.get(entry.measureKey);
    if (!existing) {
      byMeasure.set(entry.measureKey, {
        pos: p, systemTop: sysTop, left: eLeft, right: eRight,
      });
    } else {
      existing.left  = Math.min(existing.left, eLeft);
      existing.right = Math.max(existing.right, eRight);
    }
  }

  const extents = [...byMeasure.values()].sort((a, b) => a.pos - b.pos);
  return foldSegments(extents);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MainBracket({ selection, layer, fragmentSet, resolution }: MainBracketProps) {
  if (!fragmentSet || !selection || !layer) return null;

  const segments = resolveSegments(selection, layer, resolution);
  if (!segments) return null;

  return (
    <>
      {segments.map((seg, i) => {
        const top    = seg.systemTop - BRACKET_ABOVE_SYSTEM_PX;
        const width  = seg.right - seg.left;
        if (width <= 0) return null;
        const handleW = Math.min(HANDLE_W, Math.floor(width / 3));
        return (
          <div
            key={i}
            className={styles.bracket}
            style={{ left: seg.left, top, width, height: BRACKET_H }}
            aria-hidden="true"
            data-testid={i === 0 ? 'main-bracket' : `main-bracket-${i}`}
          >
            {seg.isFirst && (
              <div className={styles.handleLeft} style={{ width: handleW }} />
            )}
            {seg.isLast && (
              <div className={styles.handleRight} style={{ width: handleW }} />
            )}
          </div>
        );
      })}
    </>
  );
}
