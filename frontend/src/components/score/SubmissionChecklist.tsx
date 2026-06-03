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
 *   4. Stages complete       — flags.stagesComplete (covers required/optional/error)
 *   5. Properties filled     — flags.propertiesComplete
 *
 * Save Draft is enabled whenever a selection exists (flags.fragmentSet), since
 * drafts may be incomplete by design (tagging-tool-design.md §"Save semantics").
 *
 * References:
 *   tagging-tool-design.md §7.5 §"Save semantics"
 *   docs/roadmap/component-5-tagging-tool.md § Step 18
 */

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
  onSaveDraft: () => void;
  onSubmit: () => void;
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
      <span
        className={styles.checkIndicator}
        aria-hidden="true"
      >
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
  isSavingDraft,
  isSubmitting,
  submitError,
  draftId,
  onSaveDraft,
  onSubmit,
}: SubmissionChecklistProps) {
  const refinementOk = !typeRefinementRequired || typeRefinementSet;

  const canSubmit =
    flags.fragmentSet &&
    flags.conceptSet &&
    refinementOk &&
    flags.stagesComplete &&
    flags.propertiesComplete;

  const canSaveDraft = flags.fragmentSet && !isSavingDraft && !isSubmitting;

  const busy = isSavingDraft || isSubmitting;

  return (
    <div className={styles.checklist}>
      {/* ── Checklist items ─────────────────────────────────────────── */}
      <Type variant="label-sm" as="h2" className={styles.heading}>
        Checklist
      </Type>

      <ul className={styles.items} role="list">
        <CheckRow label="Fragment drawn" done={flags.fragmentSet} />
        <CheckRow label="Concept selected" done={flags.conceptSet} />
        {typeRefinementRequired && (
          <CheckRow label="Type Refinement set" done={typeRefinementSet} />
        )}
        <CheckRow label="Stages complete" done={flags.stagesComplete} />
        <CheckRow label="Properties filled" done={flags.propertiesComplete} />
      </ul>

      {/* ── Draft saved indicator ────────────────────────────────────── */}
      {draftId && !submitError && (
        <Type variant="label-sm" as="p" className={styles.draftSavedNote}>
          Draft saved
        </Type>
      )}

      {/* ── Error display ────────────────────────────────────────────── */}
      {submitError && (
        <Type variant="label-sm" as="p" className={styles.errorNote} role="alert">
          {submitError}
        </Type>
      )}

      {/* ── Actions ─────────────────────────────────────────────────── */}
      <div className={styles.actions}>
        <button
          type="button"
          className={styles.saveDraftButton}
          onClick={onSaveDraft}
          disabled={!canSaveDraft}
          aria-busy={isSavingDraft}
        >
          <Type variant="label-sm" as="span">
            {isSavingDraft ? 'Saving…' : 'Save Draft'}
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
            {isSubmitting ? 'Submitting…' : 'Submit for Review'}
          </Type>
        </button>
      </div>
    </div>
  );
}
