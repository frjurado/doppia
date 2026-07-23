/**
 * Tests for SubmissionChecklist — Component 7 Step 1.
 *
 * Verification targets (tagging-tool-design.md §7.5, Step 1):
 *   - "Stages complete" row is absent when conceptHasStages is false
 *     (no concept selected, or a stageless concept selected).
 *   - "Stages complete" row appears and is unchecked when conceptHasStages
 *     is true and flags.stagesComplete is false.
 *   - "Stages complete" row appears and is checked when conceptHasStages
 *     is true and flags.stagesComplete is true.
 *   - Submit is disabled while any blocking item is unresolved; enabled
 *     when all are resolved (existing behaviour).
 *   - Type Refinement row is only shown when typeRefinementRequired is true.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import SubmissionChecklist from '../SubmissionChecklist';
import type { AnnotationFlags } from '../annotator';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const allFalse: AnnotationFlags = {
  fragmentSet: false,
  conceptSet: false,
  stagesComplete: false,
  propertiesComplete: false,
};

const allTrue: AnnotationFlags = {
  fragmentSet: true,
  conceptSet: true,
  stagesComplete: true,
  propertiesComplete: true,
};

const fragmentOnly: AnnotationFlags = {
  fragmentSet: true,
  conceptSet: false,
  stagesComplete: false,
  propertiesComplete: false,
};

function renderChecklist(overrides: Partial<Parameters<typeof SubmissionChecklist>[0]> = {}) {
  const defaults = {
    flags: allFalse,
    typeRefinementRequired: false,
    typeRefinementSet: false,
    conceptHasStages: false,
    isSavingDraft: false,
    isSubmitting: false,
    submitError: null,
    draftId: null,
    onSaveDraft: vi.fn(),
    onSubmit: vi.fn(),
  };
  return render(<SubmissionChecklist {...defaults} {...overrides} />);
}

// ---------------------------------------------------------------------------
// Tests — stages row conditionality
// ---------------------------------------------------------------------------

describe('SubmissionChecklist — stages row conditionality', () => {
  it('does not show a "Stages complete" row before any concept is selected (conceptHasStages false)', () => {
    renderChecklist({ conceptHasStages: false });
    expect(screen.queryByText('Stages complete')).not.toBeInTheDocument();
  });

  it('does not show a "Stages complete" row for a stageless concept (conceptHasStages false)', () => {
    renderChecklist({
      flags: { ...allTrue, stagesComplete: true },
      conceptHasStages: false,
    });
    expect(screen.queryByText('Stages complete')).not.toBeInTheDocument();
  });

  it('does not show a "Stages complete" row when concept has stages but fragment is not drawn', () => {
    renderChecklist({
      flags: { ...allFalse, fragmentSet: false },
      conceptHasStages: true,
    });
    expect(screen.queryByText('Stages complete')).not.toBeInTheDocument();
  });

  it('shows an unchecked "Stages complete" row when the concept has stages and a stage has an error', () => {
    renderChecklist({
      flags: {
        fragmentSet: true,
        conceptSet: true,
        stagesComplete: false,
        propertiesComplete: false,
      },
      conceptHasStages: true,
    });
    expect(screen.getByText('Stages complete')).toBeInTheDocument();
    // The pending indicator (○) appears in the row, not the done indicator (✓).
    const row = screen.getByText('Stages complete').closest('li')!;
    expect(row).toHaveTextContent('○');
  });

  it('shows a checked "Stages complete" row when the concept has stages and stagesComplete is true', () => {
    renderChecklist({
      flags: allTrue,
      conceptHasStages: true,
    });
    expect(screen.getByText('Stages complete')).toBeInTheDocument();
    // The done indicator (✓) appears in the row.
    const row = screen.getByText('Stages complete').closest('li')!;
    expect(row).toHaveTextContent('✓');
  });
});

// ---------------------------------------------------------------------------
// Tests — Submit button
// ---------------------------------------------------------------------------

describe('SubmissionChecklist — Submit button', () => {
  it('Submit is disabled when all flags are false', () => {
    renderChecklist({ flags: allFalse, conceptHasStages: false });
    expect(screen.getByRole('button', { name: 'Submit for Review' })).toBeDisabled();
  });

  it('Submit is enabled when all blocking items are resolved (no stages concept)', () => {
    renderChecklist({
      flags: allTrue,
      conceptHasStages: false,
    });
    expect(screen.getByRole('button', { name: 'Submit for Review' })).not.toBeDisabled();
  });

  it('Submit is disabled when stagesComplete is false but conceptHasStages is true', () => {
    renderChecklist({
      flags: { ...allTrue, stagesComplete: false },
      conceptHasStages: true,
    });
    expect(screen.getByRole('button', { name: 'Submit for Review' })).toBeDisabled();
  });

  it('Submit is enabled when all flags true and conceptHasStages true (stagesComplete satisfies the gate)', () => {
    renderChecklist({
      flags: allTrue,
      conceptHasStages: true,
    });
    expect(screen.getByRole('button', { name: 'Submit for Review' })).not.toBeDisabled();
  });

  it('calls onSubmit when Submit is clicked and all items are resolved', () => {
    const onSubmit = vi.fn();
    renderChecklist({ flags: allTrue, conceptHasStages: false, onSubmit });
    fireEvent.click(screen.getByRole('button', { name: 'Submit for Review' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Tests — Type Refinement row conditionality (existing behaviour guard)
// ---------------------------------------------------------------------------

describe('SubmissionChecklist — Type Refinement row', () => {
  it('does not show the Type Refinement row when typeRefinementRequired is false', () => {
    renderChecklist({ typeRefinementRequired: false });
    expect(screen.queryByText('Type Refinement set')).not.toBeInTheDocument();
  });

  it('shows the Type Refinement row when typeRefinementRequired is true', () => {
    renderChecklist({ typeRefinementRequired: true });
    expect(screen.getByText('Type Refinement set')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Tests — Save Draft button
// ---------------------------------------------------------------------------

describe('SubmissionChecklist — Save Draft button', () => {
  it('Save Draft is disabled before a selection is committed (fragmentSet false)', () => {
    renderChecklist({ flags: allFalse });
    expect(screen.getByRole('button', { name: 'Save Draft' })).toBeDisabled();
  });

  it('Save Draft is enabled once fragmentSet is true', () => {
    renderChecklist({ flags: fragmentOnly });
    expect(screen.getByRole('button', { name: 'Save Draft' })).not.toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Tests — reviewed edit (submitted/approved) — Save Changes replaces the pair
// ---------------------------------------------------------------------------

describe('SubmissionChecklist — reviewed edit (Save Changes)', () => {
  it('replaces Save Draft + Submit with a single Save Changes when reviewedEdit is true', () => {
    renderChecklist({ flags: allTrue, conceptHasStages: false, reviewedEdit: true });
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Draft' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit for Review' })).not.toBeInTheDocument();
  });

  it('Save Changes is gated on the same completeness as Submit (disabled while incomplete)', () => {
    renderChecklist({
      flags: { ...allTrue, propertiesComplete: false },
      conceptHasStages: false,
      reviewedEdit: true,
    });
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled();
  });

  it('calls onSaveChanges when Save Changes is clicked and the edit is complete', () => {
    const onSaveChanges = vi.fn();
    renderChecklist({
      flags: allTrue,
      conceptHasStages: false,
      reviewedEdit: true,
      onSaveChanges,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
    expect(onSaveChanges).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Tests — Draft saved indicator (Step 5)
// ---------------------------------------------------------------------------

describe('SubmissionChecklist — Draft saved indicator', () => {
  it('shows "Draft saved" once a draft exists (quiet Save Draft feedback)', () => {
    renderChecklist({ flags: fragmentOnly, draftId: 'draft-1' });
    expect(screen.getByText('Draft saved')).toBeInTheDocument();
  });

  it('suppresses "Draft saved" while a Submit is in flight (no mid-submit flash)', () => {
    // Submit creates/updates the draft as an intermediate step; the "Draft
    // saved" note must not flash during that sequence (Step 5).
    renderChecklist({ flags: allTrue, draftId: 'draft-1', isSubmitting: true });
    expect(screen.queryByText('Draft saved')).not.toBeInTheDocument();
  });

  it('suppresses "Draft saved" when an error is present', () => {
    renderChecklist({
      flags: fragmentOnly,
      draftId: 'draft-1',
      submitError: 'Failed to save draft.',
    });
    expect(screen.queryByText('Draft saved')).not.toBeInTheDocument();
  });
});
