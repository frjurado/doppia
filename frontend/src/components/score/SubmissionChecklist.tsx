/**
 * Submission checklist — tagging-tool-design.md §7.5, Step 18.
 *
 * Always-visible checklist bound to the concurrent-flag state. Shows the
 * annotator which blocking items remain, then provides Save Draft and Submit
 * for Review actions.
 *
 * Blocking items (all must be true for Submit to enable):
 *   1. Fragment drawn        — flags.fragmentSet
 *   2. Concept selected      — flags.conceptSet
 *   3. Type Refinement set   — only shown when applicable (typeRefinementRequired)
 *   4. Stages complete       — flags.stagesComplete; row is ONLY shown when
 *                              conceptHasStages is true (tagging-tool-design.md §7.5).
 *                              Stageless concepts keep stagesComplete trivially true
 *                              but the checklist row is suppressed — it is not
 *                              applicable and would mislead the annotator.
 *   5. Properties filled     — flags.propertiesComplete
 *
 * Save Draft is enabled whenever a selection exists (flags.fragmentSet), since
 * drafts may be incomplete by design (tagging-tool-design.md §"Save semantics").
 *
 * References:
 *   tagging-tool-design.md §7.5 §"Save semantics"
 *   docs/roadmap/component-5-tagging-tool.md § Step 18
 */

import { useTranslation } from 'react-i18next';
import Type from '../ui/Type';
import type { AnnotationFlags } from './annotator';
import styles from './SubmissionChecklist.module.css';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SubmissionChecklistProps {
  /** Concurrent annotation flags from the active AnnotationSession. */
  flags: AnnotationFlags;
  /**
   * True when the selected concept has structurally-divergent IS_SUBTYPE_OF
   * children that require the annotator to choose a Type Refinement.
   */
  typeRefinementRequired: boolean;
  /** True when a Type Refinement option has been selected. */
  typeRefinementSet: boolean;
  /**
   * True when the selected concept has CONTAINS edges (i.e. declares stages).
   * One of two gates that control whether the "Stages complete" row appears.
   *
   * The row is shown only when BOTH this prop AND flags.fragmentSet are true:
   *   - conceptHasStages false → no concept selected, or stageless concept → no row
   *   - flags.fragmentSet false → no bracket drawn yet, stages not pre-populated → no row
   *   - both true → row visible; checked when all non-absent stages have valid bounds
   *
   * The underlying flags.stagesComplete value is unchanged (trivially true for
   * empty assignments); this prop plus fragmentSet control visibility only.
   * See tagging-tool-design.md §7.5.
   */
  conceptHasStages: boolean;
  /** True while a Save Draft request is in flight. */
  isSavingDraft: boolean;
  /** True while a Submit request is in flight. */
  isSubmitting: boolean;
  /** Error message from the most recent Save Draft or Submit attempt. */
  submitError: string | null;
  /**
   * UUID of the previously saved draft, if any. Shown as a "Draft saved"
   * indicator. Null = annotation has not been saved yet.
   */
  draftId: string | null;
  /**
   * True when editing an already-reviewed fragment (submitted/approved). The
   * two draft actions are replaced by a single "Save changes" that PATCHes the
   * fragment — POST /submit only accepts drafts, so re-submitting is neither
   * possible nor needed (the PATCH re-opens review on its own). Step 16.
   */
  reviewedEdit?: boolean;
  /** True while a Save changes request is in flight. */
  isSavingChanges?: boolean;
  onSaveDraft: () => void;
  onSubmit: () => void;
  /** Save an analytic edit of a submitted/approved fragment (reviewedEdit). */
  onSaveChanges?: () => void;
}

// ---------------------------------------------------------------------------
// Sub-component: one checklist row
// ---------------------------------------------------------------------------

interface CheckRowProps {
  label: string;
  done: boolean;
}

function CheckRow({ label, done }: CheckRowProps) {
  return (
    <li className={`${styles.checkRow} ${done ? styles.checkRowDone : styles.checkRowPending}`}>
      <span className={styles.checkIndicator} aria-hidden="true">
        {done ? '✓' : '○'}
      </span>
      <Type variant="label-sm" as="span" className={styles.checkLabel}>
        {label}
      </Type>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function SubmissionChecklist({
  flags,
  typeRefinementRequired,
  typeRefinementSet,
  conceptHasStages,
  isSavingDraft,
  isSubmitting,
  submitError,
  draftId,
  reviewedEdit = false,
  isSavingChanges = false,
  onSaveDraft,
  onSubmit,
  onSaveChanges,
}: SubmissionChecklistProps) {
  const { t } = useTranslation('score');
  const refinementOk = !typeRefinementRequired || typeRefinementSet;

  const canSubmit =
    flags.fragmentSet &&
    flags.conceptSet &&
    refinementOk &&
    flags.stagesComplete &&
    flags.propertiesComplete;

  const canSaveDraft = flags.fragmentSet && !isSavingDraft && !isSubmitting;

  const busy = isSavingDraft || isSubmitting || isSavingChanges;

  return (
    <div className={styles.checklist}>
      {/* ── Checklist items ─────────────────────────────────────────── */}
      <Type variant="label-sm" as="h2" className={styles.heading}>
        {t('checklist.heading')}
      </Type>

      <ul className={styles.items} role="list">
        <CheckRow label={t('checklist.fragmentDrawn')} done={flags.fragmentSet} />
        <CheckRow label={t('checklist.conceptSelected')} done={flags.conceptSet} />
        {typeRefinementRequired && (
          <CheckRow label={t('checklist.typeRefinementSet')} done={typeRefinementSet} />
        )}
        {conceptHasStages && flags.fragmentSet && (
          <CheckRow label={t('checklist.stagesComplete')} done={flags.stagesComplete} />
        )}
        <CheckRow label={t('checklist.propertiesFilled')} done={flags.propertiesComplete} />
      </ul>

      {/* ── Draft saved indicator ────────────────────────────────────── */}
      {/* Quiet, persistent feedback for Save Draft (Step 5). Suppressed while a
          Submit is in flight: Submit creates/updates the draft as an
          intermediate step, and showing "Draft saved" mid-submit was the
          confusing flash annotators reported — the Submit button's own
          "Submitting…" state is the relevant feedback there. */}
      {draftId && !submitError && !isSubmitting && (
        <Type variant="label-sm" as="p" className={styles.draftSavedNote}>
          {t('checklist.draftSaved')}
        </Type>
      )}

      {/* ── Error display ────────────────────────────────────────────── */}
      {submitError && (
        <Type variant="label-sm" as="p" className={styles.errorNote} role="alert">
          {submitError}
        </Type>
      )}

      {/* ── Actions ─────────────────────────────────────────────────── */}
      {/* Reviewed edit (submitted/approved): a single Save changes (PATCH). It
          re-opens review on the server, so there is no separate submit. Draft
          and fresh creates keep Save draft + Submit for review. */}
      {reviewedEdit ? (
        <div className={styles.actions}>
          <button
            type="button"
            className={`${styles.submitButton} ${canSubmit && !busy ? styles.submitButtonReady : ''}`}
            onClick={onSaveChanges}
            disabled={!canSubmit || busy}
            aria-busy={isSavingChanges}
          >
            <Type variant="label-sm" as="span">
              {isSavingChanges ? t('checklist.saving') : t('checklist.saveChanges')}
            </Type>
          </button>
        </div>
      ) : (
        <div className={styles.actions}>
          <button
            type="button"
            className={styles.saveDraftButton}
            onClick={onSaveDraft}
            disabled={!canSaveDraft}
            aria-busy={isSavingDraft}
          >
            <Type variant="label-sm" as="span">
              {isSavingDraft ? t('checklist.saving') : t('checklist.saveDraft')}
            </Type>
          </button>

          <button
            type="button"
            className={`${styles.submitButton} ${canSubmit && !busy ? styles.submitButtonReady : ''}`}
            onClick={onSubmit}
            disabled={!canSubmit || busy}
            aria-busy={isSubmitting}
          >
            <Type variant="label-sm" as="span">
              {isSubmitting ? t('checklist.submitting') : t('checklist.submitForReview')}
            </Type>
          </button>
        </div>
      )}
    </div>
  );
}
