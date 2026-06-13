/**
 * Layer 4 — Stage bracket track (tagging-tool-design.md §4, §6A.4).
 *
 * Renders one coloured bracket per stage below the staff once conceptSet is
 * true and the concept has CONTAINS edges. Geometry derives from the stage
 * layout frame (stageFrame.ts): the selection's effective measure-key range
 * is a slot list, each stage occupies a run of slots, and adjacent stages
 * share a single boundary index — so brackets tile the main bracket exactly,
 * with no overlap or gap at any resolution (§6A.4), and a stage straddling an
 * excluded sibling ending renders segmented like the main bracket (§6A.3).
 *
 * Split handles appear between adjacent non-absent stages in contiguous mode.
 * Dragging a handle moves the shared boundary to the nearest slot edge at the
 * active resolution. The move is total (I9 — the handle clamps visibly at
 * hard limits, never bounces back on release), moves exactly one boundary
 * with the growing side absorbing all freed space (I6), and collapses
 * optional stages it overtakes — restoring them if the drag retreats, since
 * every tick re-derives from the gesture's initial frame (I10; the collapse
 * commits on mouseup).
 *
 * Required stages render with a solid bracket; optional stages render dashed.
 * Orphaned stages render grey with reduced opacity and a warning indicator.
 *
 * Layer 5 stub: clicking a stage bracket activates it (fires onStageActivate)
 * so the form panel can highlight the corresponding stage card and the caller
 * can restrict beat ghosts to that stage's bar range.
 *
 * References: tagging-tool-design.md §4 §6 §6A.4, ADR-011 §1 §3 §6.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { GhostLayer, ResolutionMode } from './ghosts';
import type { AnnotationSession, SelectionRange } from './annotator';
import type { StageAssignment } from './stages';
import { stageColor } from './stages';
import type { StageSlot, StageSegment } from './stageFrame';
import {
  buildStageSlots,
  projectBoundaries,
  projectRun,
  moveBoundary,
  frameToAssignments,
  foldStageSegments,
} from './stageFrame';
import styles from './StageBrackets.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Bracket bar height in pixels. */
const BRACKET_H = 6;
/** Gap below the last staff-line bottom before the bracket top (px).
 *  Must be > harmonyOverlay LANE_OFFSET_PX (6) + label height (~12) to avoid
 *  collision with the harmony label lane. */
const BELOW_STAFF_GAP = 20;
/** Width of each gradient handle zone on a bracket endpoint. */
const HANDLE_W = 20;
/** Half-width of the split handle hit target. */
const SPLIT_HANDLE_HW = 8;
/** Max systemBottom distance (px) for a slot to count as "on this system". */
const SYS_TOLERANCE = 20;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StageBracketsProps {
  /** Stage assignments ordered; provided by ScoreViewer. */
  assignments: StageAssignment[];
  /** Committed selection — defines the stage layout frame (§6A.1). */
  selection: SelectionRange | null;
  /** Ghost layer for measure / beat / sub-beat pixel positions. */
  layer: GhostLayer | null;
  /** Only render when conceptSet is true and concept has CONTAINS edges. */
  visible: boolean;
  /** Active ghost resolution — determines the slot grid (G4.1). */
  resolution: ResolutionMode;
  /** The currently active stage (for bidirectional highlighting). */
  activeStageId: string | null;
  /** Called when the annotator clicks a stage bracket. */
  onStageActivate: (stageId: string | null) => void;
  /**
   * Called on every split-handle drag tick with the full updated assignments
   * array derived from the moved boundary.
   */
  onSplitHandleMove: (updatedAssignments: StageAssignment[]) => void;
  /**
   * Component 7 Step 5 — the active annotation session.
   * When provided, a split-handle drag sets the session's stageDragActive lock
   * so the main-ghost handle affordance is suppressed during the drag.
   */
  session?: AnnotationSession | null;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** A split handle between two adjacent active stages. */
interface SplitHandle {
  x: number;
  systemBottom: number;
  /** Interior boundary index in the frame (= left stage's projection index). */
  boundaryIdx: number;
}

/** Gesture state frozen at drag start — every tick re-derives from this. */
interface DragState {
  boundaryIdx: number;
  systemBottom: number;
  slots: StageSlot[];
  boundaries: number[];
  required: boolean[];
  initialAssignments: StageAssignment[];
  initialActive: StageAssignment[];
  flankIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Spatial helpers
// ---------------------------------------------------------------------------

/**
 * Map a cursor x to the nearest boundary position (slot index 0..N) on the
 * drag's system. Total: always returns a position — there is no tolerance
 * radius whose failure would leave the handle behind the cursor (I9).
 * Boundary k sits at slot k's left edge; boundary N at the last slot's right.
 */
function nearestBoundaryTarget(
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

    // Prefer candidates on the drag's system; fall back to any system.
    if (onSystem === bestOnSystem ? dist < bestDist : onSystem) {
      best = k;
      bestDist = dist;
      bestOnSystem = onSystem;
    }
  }
  return best;
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
  session,
}: StageBracketsProps) {
  // Drag state for split handles: tracked in a ref to avoid re-renders during
  // the drag — only onSplitHandleMove triggers a React state update. The
  // frame (slots + boundary vector) is frozen at drag start; each mousemove
  // derives a fresh assignments array from it, so an optional stage collapsed
  // mid-gesture restores when the drag retreats (I10).
  const dragRef = useRef<DragState | null>(null);

  const handleContainerRef = useRef<HTMLDivElement | null>(null);

  // ── Mouse handlers for split handle drag ──────────────────────────────────

  const handleMouseMove = useCallback((e: MouseEvent) => {
    const drag = dragRef.current;
    if (!drag || !handleContainerRef.current) return;

    const containerRect = handleContainerRef.current.getBoundingClientRect();
    const x = e.clientX - containerRect.left;

    const target = nearestBoundaryTarget(drag.slots, x, drag.systemBottom);
    const moved = moveBoundary(
      drag.boundaries,
      drag.boundaryIdx,
      target,
      drag.required,
      drag.slots.length,
    );
    const updated = frameToAssignments(
      drag.initialAssignments,
      drag.initialActive,
      drag.slots,
      moved,
      drag.flankIds,
    );
    onSplitHandleMove(updated);
  }, [onSplitHandleMove]);

  const handleMouseUp = useCallback(() => {
    dragRef.current = null;
    session?.setStageDragActive(false);
    document.removeEventListener('mousemove', handleMouseMove);
    document.removeEventListener('mouseup', handleMouseUp);
  }, [handleMouseMove, session]);

  const startSplitDrag = useCallback(
    (e: React.MouseEvent, boundaryIdx: number, systemBottom: number) => {
      if (!selection || !layer) return;
      e.stopPropagation();
      e.preventDefault();

      const slots = buildStageSlots(selection, layer, resolution);
      if (slots.length === 0) return;
      const { active, boundaries } = projectBoundaries(assignments, slots);
      const left  = active[boundaryIdx];
      const right = active[boundaryIdx + 1];
      if (!left || !right) return;

      dragRef.current = {
        boundaryIdx,
        systemBottom,
        slots,
        boundaries,
        required: active.map(a => a.required),
        initialAssignments: assignments,
        initialActive: active,
        flankIds: new Set([left.stageId, right.stageId]),
      };
      session?.setStageDragActive(true);
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    },
    [assignments, selection, layer, resolution, handleMouseMove, handleMouseUp, session],
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

  const slots = buildStageSlots(selection, layer, resolution);
  if (slots.length === 0) return null;

  const { active, boundaries } = projectBoundaries(assignments, slots);

  // All stages including orphaned for colour index stability.
  const allSorted = [...assignments].sort((a, b) => a.order - b.order);

  // Slot run per active stage from the shared boundary vector (§6A.4).
  const runs = new Map<string, { lo: number; hi: number }>();
  for (let j = 0; j < active.length; j++) {
    const lo = j === 0 ? 0 : boundaries[j - 1]!;
    const hi = j === active.length - 1 ? slots.length : boundaries[j]!;
    runs.set(active[j]!.stageId, { lo, hi });
  }

  // ── Split handles: one per interior boundary (contiguous mode) ───────────

  const splitHandles: SplitHandle[] = [];
  for (let j = 0; j < active.length - 1; j++) {
    if (active[j]!.containmentMode !== 'contiguous') continue;
    const bIdx = boundaries[j]!;
    if (bIdx <= 0 || bIdx >= slots.length) continue;
    const slot = slots[bIdx]!;
    splitHandles.push({
      x: slot.left,
      systemBottom: slot.systemBottom,
      boundaryIdx: j,
    });
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

        // Active stages render their frame run; orphaned stages project
        // their committed bounds individually (they are outside the frame).
        let segments: StageSegment[] = [];
        const run = runs.get(assignment.stageId);
        if (run) {
          segments = foldStageSegments(slots, run.lo, run.hi);
        } else if (assignment.orphaned) {
          const orphanRun = projectRun(slots, assignment.bounds);
          if (orphanRun) segments = foldStageSegments(slots, orphanRun.lo, orphanRun.hi);
        }
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
            key={`split-${sh.boundaryIdx}-${idx}`}
            className={styles.splitHandle}
            style={{
              left: sh.x - SPLIT_HANDLE_HW,
              top,
              width: SPLIT_HANDLE_HW * 2,
              height: BRACKET_H + SPLIT_HANDLE_HW * 2,
            }}
            data-testid={`split-handle-${sh.boundaryIdx}`}
            onMouseDown={e => startSplitDrag(e, sh.boundaryIdx, sh.systemBottom)}
          />
        );
      })}
    </div>
  );
}
