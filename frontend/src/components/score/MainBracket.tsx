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

import type { GhostLayer, MeasureGhostEntry, ResolutionMode } from './ghosts';
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
 * Derive one BracketSegment per SVG system row that the selection covers.
 *
 * Pixel bounds are sourced from the ghost index that matches the active
 * resolution so the bracket is coincident with the highlighted ghosts at
 * every granularity (G3.2):
 *
 *  - resolution === 'measure': measure index (full-measure bounds, existing
 *    behaviour). Also used when sel.beatStart is null regardless of resolution
 *    because there are no fine-grained coords to derive bounds from.
 *  - resolution === 'beat': beat ghost bounds filtered by beatFloat range.
 *  - resolution === 'subbeat': sub-beat ghost bounds, same filter.
 *
 * For beat/sub-beat entries the systemTop used to anchor the bracket above
 * note content is borrowed from the parent measure ghost via entry.measureKey.
 *
 * Grouping by systemTop is reliable because buildGhosts assigns the same
 * systemTop to every ghost on a given system row. Measures in different repeat
 * endings produce different visual positions (different systemTop values) and
 * form distinct groups without any special endingN handling here.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function resolveSegments(
  sel: SelectionRange,
  layer: GhostLayer,
  resolution: ResolutionMode,
): BracketSegment[] | null {
  // Measure resolution or no beat-precision coords: use measure index.
  if (resolution === 'measure' || sel.beatStart === null) {
    const inRange: MeasureGhostEntry[] = [];
    for (const entry of layer.measureIndex.values()) {
      if (entry.barN >= sel.barStart && entry.barN <= sel.barEnd) {
        inRange.push(entry);
      }
    }
    if (inRange.length === 0) return null;

    const bySystem = new Map<number, MeasureGhostEntry[]>();
    for (const entry of inRange) {
      const grp = bySystem.get(entry.systemTop) ?? [];
      grp.push(entry);
      bySystem.set(entry.systemTop, grp);
    }

    const tops = [...bySystem.keys()].sort((a, b) => a - b);
    return tops.map((sysTop, i) => {
      const grp  = bySystem.get(sysTop)!;
      const left = Math.min(...grp.map(e => e.bounds.left));
      const right = Math.max(...grp.map(e => e.bounds.left + e.bounds.width));
      return { systemTop: sysTop, left, right, isFirst: i === 0, isLast: i === tops.length - 1 };
    });
  }

  // Beat or sub-beat resolution with precise beatFloat coordinates.
  const index = resolution === 'beat' ? layer.beatIndex : layer.subBeatIndex;
  const beatStart = sel.beatStart;
  const beatEnd   = sel.beatEnd ?? Infinity;

  interface SystemBounds { left: number; right: number; systemTop: number; }
  const bySystem = new Map<number, SystemBounds>();

  for (const entry of index.values()) {
    if (entry.barN < sel.barStart || entry.barN > sel.barEnd) continue;
    // Beat-precision constraints apply only to the endpoint measures:
    //   barStart — left boundary: exclude beats before beatStart.
    //   barEnd   — right boundary: exclude beats from beatEnd onward.
    // Intermediate measures contribute all their ghosts so the bracket
    // spans the full system width between the two beat-precise endpoints.
    if (entry.barN === sel.barStart && entry.beatFloat < beatStart) continue;
    if (entry.barN === sel.barEnd   && entry.beatFloat >= beatEnd)  continue;

    const measureEntry = layer.measureIndex.get(entry.measureKey);
    const sysTop = measureEntry?.systemTop ?? entry.bounds.top;
    const eLeft  = entry.bounds.left;
    const eRight = entry.bounds.left + entry.bounds.width;

    const existing = bySystem.get(sysTop);
    if (!existing) {
      bySystem.set(sysTop, { left: eLeft, right: eRight, systemTop: sysTop });
    } else {
      existing.left  = Math.min(existing.left, eLeft);
      existing.right = Math.max(existing.right, eRight);
    }
  }

  if (bySystem.size === 0) return null;

  const tops = [...bySystem.keys()].sort((a, b) => a - b);
  return tops.map((sysTop, i) => {
    const sys = bySystem.get(sysTop)!;
    return { systemTop: sys.systemTop, left: sys.left, right: sys.right, isFirst: i === 0, isLast: i === tops.length - 1 };
  });
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
