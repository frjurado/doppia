/**
 * Stage list — tagging-tool-design.md §7.3.
 *
 * One card per stage in the form panel, ordered by the CONTAINS edge's `order`
 * property. Rendered inside FormPanel when the selected concept has stages.
 *
 * Each card displays:
 *  - Stage concept name and colour swatch.
 *  - Required / optional indicator.
 *  - Current spatial bounds (bar N – bar M), updated live from assignments.
 *  - For optional stages: an absent toggle (tagging-tool-design.md §4).
 *  - Orphaned / error states with inline warnings.
 *
 * Bidirectional linking (tagging-tool-design.md §6 §"Bidirectional linking"):
 *  - Clicking a card fires onStageActivate(stageId), which scrolls the score
 *    to highlight the corresponding bracket.
 *  - When activeStageId changes (user clicked a bracket in the score), the
 *    corresponding card scrolls into view and highlights.
 *
 * References: tagging-tool-design.md §7.3, ADR-011 §1 §6.
 */

import { useEffect, useRef } from 'react';
import type { StageAssignment } from './stages';
import { stageColor } from './stages';
import Type from '../ui/Type';
import styles from './StageList.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StageListProps {
  assignments: StageAssignment[];
  activeStageId: string | null;
  onStageActivate: (stageId: string | null) => void;
  onToggleAbsent: (stageId: string, absent: boolean) => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable bounds string for a stage card. */
function boundsLabel(assignment: StageAssignment): string {
  if (!assignment.bounds) return '—';
  const { barStart, barEnd } = assignment.bounds;
  if (barStart === barEnd) return `m. ${barStart}`;
  return `m. ${barStart} – ${barEnd}`;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StageList({
  assignments,
  activeStageId,
  onStageActivate,
  onToggleAbsent,
}: StageListProps) {
  // Ref map for auto-scroll when activeStageId changes.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());

  const sorted = [...assignments].sort((a, b) => a.order - b.order);

  // Auto-scroll active card into view when activeStageId is set from the score.
  useEffect(() => {
    if (!activeStageId) return;
    const el = cardRefs.current.get(activeStageId);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeStageId]);

  if (sorted.length === 0) return null;

  return (
    <div className={styles.list} data-testid="stage-list">
      {sorted.map((assignment, orderIdx) => {
        const isActive = assignment.stageId === activeStageId;
        const color = assignment.orphaned ? '#aaaaaa' : stageColor(orderIdx);

        return (
          <div
            key={assignment.stageId}
            ref={el => {
              if (el) cardRefs.current.set(assignment.stageId, el);
              else cardRefs.current.delete(assignment.stageId);
            }}
            className={[
              styles.card,
              isActive ? styles.cardActive : '',
              assignment.orphaned ? styles.cardOrphaned : '',
              assignment.error ? styles.cardError : '',
              assignment.absent ? styles.cardAbsent : '',
            ].filter(Boolean).join(' ')}
            role="button"
            tabIndex={0}
            aria-pressed={isActive}
            aria-label={`Stage: ${assignment.stageName}`}
            onClick={() => onStageActivate(isActive ? null : assignment.stageId)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onStageActivate(isActive ? null : assignment.stageId);
              }
            }}
            data-testid={`stage-card-${assignment.stageId}`}
          >
            {/* ── Top row: colour swatch + name + required badge ──────── */}
            <div className={styles.cardHeader}>
              <span
                className={styles.colorSwatch}
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <Type variant="label-md" as="span" className={styles.stageName}>
                {assignment.stageName}
              </Type>
              {assignment.required ? (
                <span className={styles.badgeRequired} title="Required stage">
                  required
                </span>
              ) : (
                <span className={styles.badgeOptional} title="Optional stage">
                  optional
                </span>
              )}
            </div>

            {/* ── Bounds display ───────────────────────────────────────── */}
            <div className={styles.boundsRow}>
              <Type variant="label-sm" as="span" className={styles.boundsText}>
                {assignment.absent ? 'absent' : boundsLabel(assignment)}
              </Type>
              {/* Orphaned warning */}
              {assignment.orphaned && (
                <Type variant="label-sm" as="span" className={styles.warnText}>
                  ⚠ stage not in current concept
                </Type>
              )}
              {/* Error warning */}
              {assignment.error && !assignment.orphaned && (
                <Type variant="label-sm" as="span" className={styles.errorText}>
                  ! outside main bracket
                </Type>
              )}
              {/* Limbo hint: optional, not absent, not confirmed */}
              {!assignment.required &&
                !assignment.absent &&
                !assignment.confirmed &&
                !assignment.orphaned && (
                  <Type variant="label-sm" as="span" className={styles.limboText}>
                    drag to confirm or mark absent
                  </Type>
                )}
            </div>

            {/* ── Absent toggle (optional stages only) ─────────────────── */}
            {!assignment.required && !assignment.orphaned && (
              <div
                className={styles.absentRow}
                onClick={e => e.stopPropagation()}
              >
                <label className={styles.absentLabel}>
                  <input
                    type="checkbox"
                    className={styles.absentCheckbox}
                    checked={assignment.absent}
                    onChange={e => onToggleAbsent(assignment.stageId, e.target.checked)}
                    aria-label={`Mark ${assignment.stageName} absent`}
                    data-testid={`absent-toggle-${assignment.stageId}`}
                  />
                  <Type variant="label-sm" as="span" className={styles.absentLabelText}>
                    Absent in this instance
                  </Type>
                </label>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
