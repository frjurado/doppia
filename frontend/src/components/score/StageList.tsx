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
 *  - When active: an inline property form for the stage concept's schemas
 *    (Step 15). The concept is implicit from the stage; no picker is shown.
 *
 * Bidirectional linking (tagging-tool-design.md §6 §"Bidirectional linking"):
 *  - Clicking a card fires onStageActivate(stageId), which scrolls the score
 *    to highlight the corresponding bracket.
 *  - When activeStageId changes (user clicked a bracket in the score), the
 *    corresponding card scrolls into view and highlights.
 *
 * References: tagging-tool-design.md §7.3 §5.4, ADR-011 §1 §3 §6.
 */

import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { StageAssignment, SubPartTag } from './stages';
import { stageColor } from './stages';
import SubPartForm from './SubPartForm';
import Type from '../ui/Type';
import { formatFragmentRange } from '../../utils/fragmentRange';
import styles from './StageList.module.css';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface StageListProps {
  assignments: StageAssignment[];
  activeStageId: string | null;
  onStageActivate: (stageId: string | null) => void;
  onToggleAbsent: (stageId: string, absent: boolean) => void;
  /** Current sub-part tags keyed by stageId. Passed from ScoreViewer. */
  subPartTags?: Record<string, SubPartTag | null>;
  /** Called when a stage's property values change. */
  onSubPartTagUpdate?: (stageId: string, tag: SubPartTag | null) => void;
  /**
   * Incremented by ScoreViewer when all sub-part forms should reset (e.g.,
   * the main concept changed). Each SubPartForm is keyed on stageId + resetKey.
   */
  subPartResetKey?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable bounds string for a stage card, including beat precision. */
function boundsLabel(assignment: StageAssignment): string {
  if (!assignment.bounds) return '—';
  const { barStart, barEnd, beatStart, beatEnd } = assignment.bounds;
  return formatFragmentRange(barStart, barEnd, beatStart, beatEnd);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function StageList({
  assignments,
  activeStageId,
  onStageActivate,
  onToggleAbsent,
  subPartTags = {},
  onSubPartTagUpdate,
  subPartResetKey = 0,
}: StageListProps) {
  const { t } = useTranslation('score');
  // Ref map for auto-scroll when activeStageId changes.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());

  // Order by physical position in the score (bar, then beat) so the sidebar
  // reads top-to-bottom the way the stages actually lay out in the music, not
  // by the abstract CONTAINS-edge schema order (Component 9 G2). Absent
  // stages have no bounds to position by; group them after the positioned
  // ones, each ordered among themselves by schema order.
  const sorted = [...assignments].sort((a, b) => {
    if (a.bounds && b.bounds) {
      if (a.bounds.barStart !== b.bounds.barStart) return a.bounds.barStart - b.bounds.barStart;
      const aBeat = a.bounds.beatStart ?? 0;
      const bBeat = b.bounds.beatStart ?? 0;
      if (aBeat !== bBeat) return aBeat - bBeat;
      return a.order - b.order;
    }
    if (a.bounds && !b.bounds) return -1;
    if (!a.bounds && b.bounds) return 1;
    return a.order - b.order;
  });

  // Auto-scroll active card into view when activeStageId is set from the score.
  useEffect(() => {
    if (!activeStageId) return;
    const el = cardRefs.current.get(activeStageId);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeStageId]);

  if (sorted.length === 0) return null;

  const activeCount = assignments.filter(a => !a.absent && !a.orphaned).length;

  return (
    <div className={styles.list} data-testid="stage-list">
      {sorted.map((assignment) => {
        const isActive = assignment.stageId === activeStageId;
        // Keyed on the schema's CONTAINS-edge order, not the list's display
        // position, so a stage's colour stays stable as bounds move it around
        // the position-sorted list (Component 9 G2).
        const color = assignment.orphaned ? '#aaaaaa' : stageColor(assignment.order);
        const isLastActive = !assignment.absent && !assignment.orphaned && activeCount === 1;

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
            aria-label={t('stageList.stageAria', { name: assignment.stageName })}
            onClick={() => onStageActivate(isActive ? null : assignment.stageId)}
            onKeyDown={e => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onStageActivate(isActive ? null : assignment.stageId);
              }
            }}
            data-testid={`stage-card-${assignment.stageId}`}
          >
            {/* ── Top row: swatch/toggle + name + required badge ───────── */}
            <div className={styles.cardHeader}>
              {!assignment.required && !assignment.orphaned ? (
                <button
                  type="button"
                  className={[
                    styles.colorSwatch,
                    styles.swatchToggle,
                    assignment.absent ? styles.swatchAbsent : styles.swatchPresent,
                  ].join(' ')}
                  style={{ '--swatch-color': color } as CSSProperties}
                  onClick={e => {
                    e.stopPropagation();
                    onToggleAbsent(assignment.stageId, !assignment.absent);
                  }}
                  disabled={isLastActive}
                  aria-disabled={isLastActive}
                  aria-label={t('stageList.toggleAria', {
                    name: assignment.stageName,
                    state: assignment.absent ? t('stageList.absent') : t('stageList.present'),
                    suffix: isLastActive ? t('stageList.cannotRemoveLast') : '',
                  })}
                  data-testid={`absent-toggle-${assignment.stageId}`}
                />
              ) : (
                <span
                  className={styles.colorSwatch}
                  style={{ backgroundColor: color }}
                  aria-hidden="true"
                />
              )}
              <Type variant="label-md" as="span" className={styles.stageName}>
                {assignment.stageName}
              </Type>
              {assignment.required && (
                <span
                  className={styles.badgeRequired}
                  aria-label={t('requiredAria')}
                  title={t('stageList.requiredTitle')}
                >
                  *
                </span>
              )}
            </div>

            {/* ── Bounds display ───────────────────────────────────────── */}
            <div className={styles.boundsRow}>
              <Type variant="label-sm" as="span" className={styles.boundsText}>
                {assignment.absent ? t('stageList.absent') : boundsLabel(assignment)}
              </Type>
              {/* Orphaned warning */}
              {assignment.orphaned && (
                <Type variant="label-sm" as="span" className={styles.warnText}>
                  {t('stageList.orphanWarn')}
                </Type>
              )}
              {/* Error warning */}
              {assignment.error && !assignment.orphaned && (
                <Type variant="label-sm" as="span" className={styles.errorText}>
                  {t('stageList.boundsError')}
                </Type>
              )}
            </div>

            {/* ── Inline stage property form (Step 15) ─────────────────── */}
            {/* Shown when the card is active and the stage is present (not
                absent, not orphaned). Concept is implicit from stageId. */}
            {isActive && onSubPartTagUpdate && !assignment.orphaned && !assignment.absent && (
              <div
                className={styles.subPartRow}
                onClick={e => e.stopPropagation()}
              >
                <SubPartForm
                  key={`${assignment.stageId}-${subPartResetKey}`}
                  stageId={assignment.stageId}
                  stageName={assignment.stageName}
                  stageConceptId={assignment.stageId}
                  initialTag={subPartTags[assignment.stageId] ?? null}
                  resetKey={subPartResetKey}
                  onUpdate={onSubPartTagUpdate}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
