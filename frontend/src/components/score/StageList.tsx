/**
 * Stage list — tagging-tool-design.md §7.3.
 *
 * One card per stage in the form panel, ordered by physical position in the
 * score. Rendered inside FormPanel when the selected concept has stages.
 *
 * Each card displays (Component 9 Part 8 item 4 trimmed it to essentials —
 * bounds are visible on the score brackets, not repeated here):
 *  - Stage concept name and colour swatch.
 *  - Required / optional indicator.
 *  - For optional stages: an absent toggle (tagging-tool-design.md §4).
 *  - Orphaned / error states with inline warnings.
 *  - An always-open inline property form for the stage concept's schemas
 *    (Step 15; always-open since Part 8 item 4 — activation only highlights,
 *    it no longer gates the form).
 *    The concept is implicit from the stage; no picker is shown.
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
  /**
   * True while a stage split-handle drag is in progress. Freezes the display
   * order at its pre-drag state so cards don't jump around mid-gesture as
   * bounds move; the list resorts by position once on release (Component 9
   * Part 8 item 4).
   */
  freezeOrder?: boolean;
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
  freezeOrder = false,
}: StageListProps) {
  const { t } = useTranslation('score');
  // Ref map for auto-scroll when activeStageId changes.
  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  // Display order (stageIds) captured outside a drag, so a split-handle drag
  // reorders nothing mid-gesture (Part 8 item 4).
  const frozenOrderRef = useRef<string[] | null>(null);

  // Order by physical position in the score (bar, then beat) so the sidebar
  // reads top-to-bottom the way the stages actually lay out in the music, not
  // by the abstract CONTAINS-edge schema order (Component 9 G2). Absent
  // stages have no bounds to position by; group them after the positioned
  // ones, each ordered among themselves by schema order.
  const positionSorted = [...assignments].sort((a, b) => {
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

  // During a drag, keep the pre-drag order; otherwise track the live sort.
  let sorted = positionSorted;
  if (freezeOrder && frozenOrderRef.current !== null) {
    const rank = new Map(frozenOrderRef.current.map((id, i) => [id, i]));
    sorted = [...positionSorted].sort(
      (a, b) =>
        (rank.get(a.stageId) ?? Number.MAX_SAFE_INTEGER) -
        (rank.get(b.stageId) ?? Number.MAX_SAFE_INTEGER)
    );
  } else {
    frozenOrderRef.current = positionSorted.map((a) => a.stageId);
  }

  // Auto-scroll active card into view when activeStageId is set from the score.
  useEffect(() => {
    if (!activeStageId) return;
    const el = cardRefs.current.get(activeStageId);
    if (el) {
      el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [activeStageId]);

  if (sorted.length === 0) return null;

  const activeCount = assignments.filter((a) => !a.absent && !a.orphaned).length;

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
            ref={(el) => {
              if (el) cardRefs.current.set(assignment.stageId, el);
              else cardRefs.current.delete(assignment.stageId);
            }}
            className={[
              styles.card,
              isActive ? styles.cardActive : '',
              assignment.orphaned ? styles.cardOrphaned : '',
              assignment.error ? styles.cardError : '',
              assignment.absent ? styles.cardAbsent : '',
            ]
              .filter(Boolean)
              .join(' ')}
            role="button"
            tabIndex={0}
            aria-pressed={isActive}
            aria-label={t('stageList.stageAria', { name: assignment.stageName })}
            onClick={() => onStageActivate(isActive ? null : assignment.stageId)}
            onKeyDown={(e) => {
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
                  onClick={(e) => {
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

            {/* ── Status row ───────────────────────────────────────────── */}
            {/* Bounds are no longer repeated here — they are visible on the
                score brackets (Part 8 item 4). The row renders only for the
                states that need words: absent, orphaned, bounds error. */}
            {(assignment.absent || assignment.orphaned || assignment.error) && (
              <div className={styles.boundsRow}>
                {assignment.absent && (
                  <Type variant="label-sm" as="span" className={styles.boundsText}>
                    {t('stageList.absent')}
                  </Type>
                )}
                {assignment.orphaned && (
                  <Type variant="label-sm" as="span" className={styles.warnText}>
                    {t('stageList.orphanWarn')}
                  </Type>
                )}
                {assignment.error && !assignment.orphaned && (
                  <Type variant="label-sm" as="span" className={styles.errorText}>
                    {t('stageList.boundsError')}
                  </Type>
                )}
              </div>
            )}

            {/* ── Inline stage property form (Step 15) ─────────────────── */}
            {/* Always open for present stages (Part 8 item 4) — opening cards
                one by one was tedious and easy to overlook. Activation only
                highlights. Concept is implicit from stageId. */}
            {onSubPartTagUpdate && !assignment.orphaned && !assignment.absent && (
              <div className={styles.subPartRow} onClick={(e) => e.stopPropagation()}>
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
