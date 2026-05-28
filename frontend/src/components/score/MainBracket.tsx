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

import type { GhostLayer, MeasureGhostEntry } from './ghosts';
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
  /** Ghost layer providing pixel bounds via measureIndex. */
  layer: GhostLayer | null;
  /** Bracket is only rendered when the fragmentSet flag is true. */
  fragmentSet: boolean;
}

// ---------------------------------------------------------------------------
// Internal types and helpers
// ---------------------------------------------------------------------------

interface BracketSegment {
  systemTop: number;
  left: number;
  right: number;
  isFirst: boolean;
  isLast: boolean;
}

/**
 * Derive one BracketSegment per SVG system row that the selection covers.
 *
 * All measureIndex entries with barN in [barStart, barEnd] are collected and
 * grouped by systemTop. Because buildGhosts assigns a single systemTop value
 * to every measure in the same system row, equality on systemTop is a reliable
 * system-identity key. Measures in different repeat endings have different
 * visual positions and therefore different systemTop values, so they form
 * distinct groups without any special endingN handling here.
 */
function resolveSegments(
  sel: SelectionRange,
  layer: GhostLayer,
): BracketSegment[] | null {
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
  const segments: BracketSegment[] = tops.map((sysTop, i) => {
    const grp   = bySystem.get(sysTop)!;
    const left  = Math.min(...grp.map(e => e.bounds.left));
    const right = Math.max(...grp.map(e => e.bounds.left + e.bounds.width));
    return {
      systemTop: sysTop,
      left,
      right,
      isFirst: i === 0,
      isLast:  i === tops.length - 1,
    };
  });

  return segments;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function MainBracket({ selection, layer, fragmentSet }: MainBracketProps) {
  if (!fragmentSet || !selection || !layer) return null;

  const segments = resolveSegments(selection, layer);
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
