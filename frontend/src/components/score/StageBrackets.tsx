/**
 * Layer 4 — Stage bracket track (tagging-tool-design.md §4).
 *
 * Renders one coloured bracket per stage below the staff once conceptSet is
 * true and the concept has CONTAINS edges. For multi-system selections each
 * stage emits one visual segment per system row that it spans.
 *
 * Split handles appear between adjacent non-absent stages in contiguous mode
 * (tagging-tool-design.md §6). Dragging a handle moves the shared boundary
 * between the two flanking stages; the drag snaps to the active resolution
 * grid (G4.1): measure barlines at 'measure' resolution, beat ghost positions
 * at 'beat', sub-beat ghost positions at 'subbeat'.
 *
 * Required stages render with a solid bracket; optional stages render dashed.
 * Orphaned stages render grey with reduced opacity and a warning indicator.
 * Stages in an error state (bounds outside the main bracket) render in red.
 *
 * Layer 5 stub: clicking a stage bracket activates it (fires onStageActivate)
 * so the form panel can highlight the corresponding stage card and the caller
 * can restrict beat ghosts to that stage's bar range.
 *
 * References: tagging-tool-design.md §4 §6, ADR-011 §1 §3 §6.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { GhostLayer, MeasureGhostEntry, ResolutionMode } from './ghosts';
import type { SelectionRange } from './annotator';
import type { StageBounds, StageAssignment } from './stages';
import { moveSplitHandle, stageColor } from './stages';
import type { StageBeatBoundary } from './stages';
import styles from './StageBrackets.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bracket bar height in pixels. */
const BRACKET_H = 6;
/** Gap below the last staff-line bottom before the bracket top (px). */
const BELOW_STAFF_GAP = 6;
/** Width of each gradient handle zone on a bracket endpoint. */
const HANDLE_W = 20;
/** Half-width of the split handle hit target. */
const SPLIT_HANDLE_HW = 8;
/** Max distance (px) to accept a drag snap to a ghost boundary. */
const SNAP_TOLERANCE = 60;
/** Tolerance for matching beatFloat values (float comparison). */
const BEAT_FLOAT_EPS = 0.001;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StageBracketsProps {
  /** Stage assignments ordered; provided by ScoreViewer. */
  assignments: StageAssignment[];
  /** Committed selection — used to anchor bracket rendering. */
  selection: SelectionRange | null;
  /** Ghost layer for measure / beat / sub-beat pixel positions. */
  layer: GhostLayer | null;
  /** Only render when conceptSet is true and concept has CONTAINS edges. */
  visible: boolean;
  /** Active ghost resolution — determines snap grid for split handles (G4.1). */
  resolution: ResolutionMode;
  /** The currently active stage (for bidirectional highlighting). */
  activeStageId: string | null;
  /** Called when the annotator clicks a stage bracket. */
  onStageActivate: (stageId: string | null) => void;
  /**
   * Called when the split handle drag completes.
   * Receives the full updated assignments array after moveSplitHandle().
   */
  onSplitHandleMove: (updatedAssignments: StageAssignment[]) => void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** One rendered segment for a stage bracket. */
interface BracketSegment {
  left: number;
  right: number;
  systemBottom: number;
  isFirst: boolean;
  isLast: boolean;
}

/** A split handle between two adjacent stage segments on the same system. */
interface SplitHandle {
  x: number;
  systemBottom: number;
  /** Index into sorted active stages: the left stage's position. */
  sortedIdx: number;
  stageId: string;
}

// ---------------------------------------------------------------------------
// Spatial helpers
// ---------------------------------------------------------------------------

/**
 * Collect all measure entries in [barStart, barEnd] and group them by
 * systemTop. Returns one BracketSegment per system, sorted top-to-bottom.
 *
 * Used when resolution is 'measure' or stage bounds have no beat precision.
 */
function resolveSegmentsMeasure(
  barStart: number,
  barEnd: number,
  layer: GhostLayer,
): BracketSegment[] {
  const inRange: MeasureGhostEntry[] = [];
  for (const entry of layer.measureIndex.values()) {
    if (entry.barN >= barStart && entry.barN <= barEnd) {
      inRange.push(entry);
    }
  }
  if (inRange.length === 0) return [];

  const bySystem = new Map<number, MeasureGhostEntry[]>();
  for (const entry of inRange) {
    const grp = bySystem.get(entry.systemTop) ?? [];
    grp.push(entry);
    bySystem.set(entry.systemTop, grp);
  }

  const tops = [...bySystem.keys()].sort((a, b) => a - b);
  return tops.map((sysTop, i) => {
    const grp = bySystem.get(sysTop)!;
    const left = Math.min(...grp.map(e => e.bounds.left));
    const right = Math.max(...grp.map(e => e.bounds.left + e.bounds.width));
    const systemBottom = grp[0]!.bounds.top + grp[0]!.bounds.height;
    return {
      left,
      right,
      systemBottom,
      isFirst: i === 0,
      isLast: i === tops.length - 1,
    };
  });
}

/**
 * Derive one BracketSegment per SVG system that the stage bounds cover,
 * respecting beat/sub-beat precision at the endpoints (G4.1).
 *
 * When the bounds have beatStart/beatEnd coordinates AND resolution is
 * 'beat'/'subbeat', the endpoint x positions are derived from the
 * beat or sub-beat ghost index instead of full measure widths. Intermediate
 * measures between the two endpoints contribute their full width.
 *
 * Falls back to measure-level rendering when:
 *   - resolution === 'measure', OR
 *   - both beatStart and beatEnd are null (stage not yet dragged to beat precision).
 */
function resolveSegments(
  bounds: StageBounds,
  layer: GhostLayer,
  resolution: ResolutionMode,
): BracketSegment[] {
  const { barStart, barEnd, beatStart, beatEnd } = bounds;

  const useBeat = resolution !== 'measure' && (beatStart !== null || beatEnd !== null);

  if (!useBeat) {
    return resolveSegmentsMeasure(barStart, barEnd, layer);
  }

  const index = resolution === 'beat' ? layer.beatIndex : layer.subBeatIndex;
  const bsf = beatStart ?? -Infinity;
  const bef = beatEnd ?? Infinity;

  interface SystemBounds { left: number; right: number; systemTop: number; systemBottom: number; }
  const bySystem = new Map<number, SystemBounds>();

  for (const entry of index.values()) {
    if (entry.barN < barStart || entry.barN > barEnd) continue;
    // Endpoint beat-precision filters (same logic as MainBracket.tsx §resolveSegments).
    if (entry.barN === barStart && entry.beatFloat < bsf) continue;
    if (entry.barN === barEnd   && entry.beatFloat >= bef) continue;

    const measureEntry = layer.measureIndex.get(entry.measureKey);
    const sysTop = measureEntry?.systemTop ?? entry.bounds.top;
    const sysBottom = entry.bounds.top + entry.bounds.height;

    const existing = bySystem.get(sysTop);
    if (!existing) {
      bySystem.set(sysTop, {
        left: entry.bounds.left,
        right: entry.bounds.left + entry.bounds.width,
        systemTop: sysTop,
        systemBottom: sysBottom,
      });
    } else {
      existing.left  = Math.min(existing.left,  entry.bounds.left);
      existing.right = Math.max(existing.right, entry.bounds.left + entry.bounds.width);
    }
  }

  if (bySystem.size === 0) {
    // No beat ghosts found in range — fall back to measure-level rendering.
    return resolveSegmentsMeasure(barStart, barEnd, layer);
  }

  const tops = [...bySystem.keys()].sort((a, b) => a - b);
  return tops.map((sysTop, i) => {
    const sys = bySystem.get(sysTop)!;
    return {
      left: sys.left,
      right: sys.right,
      systemBottom: sys.systemBottom,
      isFirst: i === 0,
      isLast: i === tops.length - 1,
    };
  });
}

/**
 * Find the nearest boundary ghost to pixel x within the given system, at the
 * active resolution, and return it as a StageBeatBoundary.
 *
 * - 'measure': snaps to measure left-edges; returns { barN, beatFloat: null }.
 *   barN is the measure to the RIGHT of the snap point so that the caller can
 *   use barN − 1 as the left stage's barEnd (same convention as the old
 *   nearestBoundaryBarN).
 * - 'beat' / 'subbeat': snaps to beat or sub-beat ghost left-edges; returns
 *   { barN, beatFloat } of the snapped ghost. Both boundary stages share barN.
 *
 * Returns null when no candidate is within SNAP_TOLERANCE.
 */
function nearestBoundary(
  x: number,
  systemBottom: number,
  layer: GhostLayer,
  resolution: ResolutionMode,
): StageBeatBoundary | null {
  const SYS_TOLERANCE = 20;

  if (resolution === 'measure') {
    let bestBarN: number | null = null;
    let bestDist = Infinity;

    for (const entry of layer.measureIndex.values()) {
      const entrySystemBottom = entry.bounds.top + entry.bounds.height;
      if (Math.abs(entrySystemBottom - systemBottom) > SYS_TOLERANCE) continue;

      const dist = Math.abs(entry.bounds.left - x);
      if (dist < bestDist && dist < SNAP_TOLERANCE) {
        bestDist = dist;
        bestBarN = entry.barN;
      }
    }

    if (bestBarN === null) return null;
    // Convention: barN is the right-side measure, so leftStage.barEnd = barN − 1.
    return { barN: bestBarN, beatFloat: null };
  }

  // Beat or sub-beat resolution.
  const index = resolution === 'beat' ? layer.beatIndex : layer.subBeatIndex;

  let bestBarN: number | null = null;
  let bestBeatFloat: number | null = null;
  let bestDist = Infinity;

  for (const entry of index.values()) {
    const entrySystemBottom = entry.bounds.top + entry.bounds.height;
    if (Math.abs(entrySystemBottom - systemBottom) > SYS_TOLERANCE) continue;

    const dist = Math.abs(entry.bounds.left - x);
    if (dist < bestDist && dist < SNAP_TOLERANCE) {
      bestDist = dist;
      bestBarN = entry.barN;
      bestBeatFloat = entry.beatFloat;
    }
  }

  if (bestBarN === null || bestBeatFloat === null) return null;
  return { barN: bestBarN, beatFloat: bestBeatFloat };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StageBrackets({
  assignments,
  selection,
  layer,
  visible,
  resolution,
  activeStageId,
  onStageActivate,
  onSplitHandleMove,
}: StageBracketsProps) {
  // Drag state for split handles: tracked in a ref to avoid re-renders during
  // the drag — only onSplitHandleMove triggers a React state update.
  const dragRef = useRef<{
    sortedIdx: number;
    systemBottom: number;
    initialAssignments: StageAssignment[];
  } | null>(null);

  const handleContainerRef = useRef<HTMLDivElement | null>(null);

  // ── Mouse handlers for split handle drag ──────────────────────────────────

  const handleMouseMove = useCallback((e: MouseEvent) => {
    if (!dragRef.current || !layer || !handleContainerRef.current) return;

    const containerRect = handleContainerRef.current.getBoundingClientRect();
    const x = e.clientX - containerRect.left;

    const boundary = nearestBoundary(x, dragRef.current.systemBottom, layer, resolution);
    if (boundary === null) return;

    // For measure resolution: nearestBoundary returns barN of the RIGHT measure,
    // so we convert to leftStage.barEnd = barN − 1, beatFloat = null.
    const splitBoundary: StageBeatBoundary =
      boundary.beatFloat === null
        ? { barN: boundary.barN - 1, beatFloat: null }
        : boundary;

    const updated = moveSplitHandle(
      dragRef.current.initialAssignments,
      dragRef.current.sortedIdx,
      splitBoundary,
    );
    onSplitHandleMove(updated);
  }, [layer, resolution, onSplitHandleMove]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove]);

  const startSplitDrag = useCallback(
    (e: React.MouseEvent, sortedIdx: number, systemBottom: number) => {
      e.stopPropagation();
      e.preventDefault();
      dragRef.current = { sortedIdx, systemBottom, initialAssignments: assignments };
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [assignments, handleMouseMove, handleMouseUp],
  );

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [handleMouseMove, handleMouseUp]);

  // ── Render guard ─────────────────────────────────────────────────────────

  if (!visible || !selection || !layer) return null;

  // Sort non-orphaned stages by order for rendering and split handle placement.
  const activeStages = [...assignments]
    .filter(a => !a.orphaned && !a.absent && a.bounds !== null)
    .sort((a, b) => a.order - b.order);

  // All stages including orphaned for colour index stability.
  const allSorted = [...assignments].sort((a, b) => a.order - b.order);

  // ── Build split handles (G4.1: position at beat/subbeat ghost when precise) ─

  const splitHandles: SplitHandle[] = [];
  for (let i = 0; i < activeStages.length - 1; i++) {
    const leftStage = activeStages[i]!;
    const rightStage = activeStages[i + 1]!;
    if (leftStage.containmentMode !== 'contiguous') continue;
    if (!leftStage.bounds || !rightStage.bounds) continue;

    const beatStart = rightStage.bounds.beatStart;

    if (beatStart !== null && resolution !== 'measure') {
      // Beat-precise boundary: find the beat/subbeat ghost at
      // (rightStage.barStart, beatStart) and place the handle there.
      const index = resolution === 'beat' ? layer.beatIndex : layer.subBeatIndex;
      for (const entry of index.values()) {
        if (
          entry.barN === rightStage.bounds.barStart &&
          Math.abs(entry.beatFloat - beatStart) < BEAT_FLOAT_EPS
        ) {
          const systemBottom = entry.bounds.top + entry.bounds.height;
          splitHandles.push({
            x: entry.bounds.left,
            systemBottom,
            sortedIdx: i,
            stageId: leftStage.stageId,
          });
        }
      }
    } else {
      // Measure-level boundary: left edge of the right stage's first bar.
      const boundaryBarN = rightStage.bounds.barStart;
      for (const entry of layer.measureIndex.values()) {
        if (entry.barN === boundaryBarN) {
          const systemBottom = entry.bounds.top + entry.bounds.height;
          splitHandles.push({
            x: entry.bounds.left,
            systemBottom,
            sortedIdx: i,
            stageId: leftStage.stageId,
          });
        }
      }
    }
  }

  return (
    <div
      ref={handleContainerRef}
      className={styles.layer}
      aria-hidden="true"
      data-testid="stage-brackets"
    >
      {/* ── Stage bracket segments ──────────────────────────────────────── */}
      {allSorted.map((assignment, orderIdx) => {
        if (assignment.absent) return null;
        if (!assignment.bounds) return null;

        const segments = resolveSegments(assignment.bounds, layer, resolution);
        if (segments.length === 0) return null;

        const color = assignment.orphaned
          ? '#aaaaaa'
          : stageColor(orderIdx);

        const isActive = assignment.stageId === activeStageId;

        return segments.map((seg, segIdx) => {
          const top = seg.systemBottom + BELOW_STAFF_GAP;
          const width = seg.right - seg.left;
          if (width <= 0) return null;
          const handleW = Math.min(HANDLE_W, Math.floor(width / 4));

          return (
            <div
              key={`${assignment.stageId}-${segIdx}`}
              className={[
                styles.bracket,
                assignment.required ? styles.required : styles.optional,
                assignment.error ? styles.error : '',
                assignment.orphaned ? styles.orphaned : '',
                isActive ? styles.active : '',
              ].filter(Boolean).join(' ')}
              style={{
                left: seg.left,
                top,
                width,
                height: BRACKET_H,
                '--stage-color': color,
              } as React.CSSProperties}
              data-testid={`stage-bracket-${assignment.stageId}`}
              onClick={() => onStageActivate(
                isActive ? null : assignment.stageId,
              )}
            >
              {/* Label: stage name, always visible on the first segment */}
              {seg.isFirst && (
                <span
                  className={styles.label}
                  style={{ color }}
                >
                  {assignment.stageName}
                  {assignment.orphaned && (
                    <span className={styles.orphanBadge} title="Stage not in current concept">⚠</span>
                  )}
                  {assignment.error && (
                    <span className={styles.errorBadge} title="Bounds outside main bracket">!</span>
                  )}
                </span>
              )}
              {/* Gradient endpoint handles (decorative, pointer-events auto via CSS) */}
              {seg.isFirst && (
                <div className={styles.handleLeft} style={{ width: handleW }} />
              )}
              {seg.isLast && (
                <div className={styles.handleRight} style={{ width: handleW }} />
              )}
            </div>
          );
        });
      })}

      {/* ── Split handles ──────────────────────────────────────────────── */}
      {splitHandles.map((sh, idx) => {
        const top = sh.systemBottom + BELOW_STAFF_GAP - SPLIT_HANDLE_HW;
        return (
          <div
            key={`split-${sh.sortedIdx}-${idx}`}
            className={styles.splitHandle}
            style={{
              left: sh.x - SPLIT_HANDLE_HW,
              top,
              width: SPLIT_HANDLE_HW * 2,
              height: BRACKET_H + SPLIT_HANDLE_HW * 2,
            }}
            data-testid={`split-handle-${sh.sortedIdx}`}
            onMouseDown={e => startSplitDrag(e, sh.sortedIdx, sh.systemBottom)}
          />
        );
      })}
    </div>
  );
}
