/**
 * Tests for TypeRefinement — Component 5 Step 12.
 *
 * Verification target from the roadmap (Step 12):
 *   "Selecting a concept with structurally-divergent children shows the
 *    refinement radio group; selecting one whose children differ only in
 *    properties does not."
 *
 * This component only receives options it should show — the backend controls
 * structural divergence. The component tests confirm:
 *   - non-empty options → radio group rendered
 *   - empty options    → nothing rendered
 *   - selection fires onChange with the chosen option
 *   - clicking the selected option fires onChange(null) (deselect)
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import TypeRefinement from '../TypeRefinement';
import type { TypeRefinementChild } from '../../../services/conceptApi';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makeOption = (id: string, name: string): TypeRefinementChild => ({
  id,
  name,
  definition: null,
});

const simpleOption = makeOption('SimpleGerman', 'Simple');
const compoundOption = makeOption('CompoundGerman', 'Compound');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TypeRefinement', () => {
  it('renders nothing when options is empty', () => {
    const { container } = render(
      <TypeRefinement options={[]} selectedId={null} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the radio group when options is non-empty', () => {
    render(
      <TypeRefinement
        options={[simpleOption, compoundOption]}
        selectedId={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('type-refinement')).toBeInTheDocument();
    expect(screen.getByTestId('type-refinement-group')).toBeInTheDocument();
  });

  it('renders one radio option per entry with the correct name', () => {
    render(
      <TypeRefinement
        options={[simpleOption, compoundOption]}
        selectedId={null}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('refinement-option-SimpleGerman')).toBeInTheDocument();
    expect(screen.getByTestId('refinement-option-CompoundGerman')).toBeInTheDocument();
    expect(screen.getByText('Simple')).toBeInTheDocument();
    expect(screen.getByText('Compound')).toBeInTheDocument();
  });

  it('fires onChange with the selected option when an option is clicked', () => {
    const onChange = vi.fn();
    render(
      <TypeRefinement
        options={[simpleOption, compoundOption]}
        selectedId={null}
        onChange={onChange}
      />,
    );
    const simpleRadio = screen.getByRole('radio', { name: 'Simple' });
    fireEvent.click(simpleRadio);
    expect(onChange).toHaveBeenCalledWith(simpleOption);
  });

  it('fires onChange(null) when the currently-selected option is clicked again', () => {
    const onChange = vi.fn();
    render(
      <TypeRefinement
        options={[simpleOption, compoundOption]}
        selectedId="SimpleGerman"
        onChange={onChange}
      />,
    );
    const simpleRadio = screen.getByRole('radio', { name: 'Simple' });
    fireEvent.click(simpleRadio);
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('marks the selectedId option as checked', () => {
    render(
      <TypeRefinement
        options={[simpleOption, compoundOption]}
        selectedId="CompoundGerman"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole('radio', { name: 'Compound' })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Simple' })).not.toBeChecked();
  });
});
