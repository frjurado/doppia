/**
 * Tests for PropertyForm — Component 5 Step 13 / G5.5 remediation.
 *
 * Verification targets:
 *   - ONE_OF ≤2 values → radio rows; >2 values → compact single-select popover.
 *   - MANY_OF ≤2 values → checkbox rows; >2 values → compact multi-select popover.
 *   - BOOL → binary on/off toggle; null (unset) and false both show ✗.
 *   - Payload shapes unchanged; computeIsComplete and carryOverValues unaffected.
 *
 * Structure:
 *   1. Pure-function tests (computeIsComplete, carryOverValues) — no render.
 *   2. Component rendering tests — control types, required marker, groups.
 *   3. ONE_OF radio (≤2) interaction.
 *   4. ONE_OF popover (>2) interaction.
 *   5. MANY_OF checkbox (≤2) interaction.
 *   6. MANY_OF popover (>2) interaction.
 *   7. BOOL field interaction.
 *   8. Schema description tooltip.
 *   9. VALUE_REFERENCES info panel.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import PropertyForm from '../PropertyForm';
import type { PropertyFormValues } from '../PropertyForm';
import { computeIsComplete, carryOverValues } from '../propertyFormHelpers';
import type { PropertySchema } from '../../../services/conceptApi';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** ONE_OF with 2 values → renders as radio rows. */
const schemaOneOfSmall: PropertySchema = {
  id: 'IACSopranoDegree',
  name: 'IAC Soprano Degree',
  cardinality: 'ONE_OF',
  required: false,
  description: null,
  values: [
    { id: 'SD3', name: 'Scale Degree 3', referenced_concept: null },
    { id: 'SD5', name: 'Scale Degree 5', referenced_concept: null },
  ],
};

/** ONE_OF with 3 values → renders as popover (>2 threshold). */
const schemaOneOf: PropertySchema = {
  id: 'SopranoScale',
  name: 'Soprano Scale Degree',
  cardinality: 'ONE_OF',
  required: true,
  description: null,
  values: [
    { id: 'SD1', name: 'Scale Degree 1', referenced_concept: null },
    { id: 'SD3', name: 'Scale Degree 3', referenced_concept: null },
    { id: 'SD5', name: 'Scale Degree 5', referenced_concept: null },
  ],
};

/** MANY_OF with 2 values → renders as checkbox rows. */
const schemaManyOf: PropertySchema = {
  id: 'Elaborations',
  name: 'Elaborations',
  cardinality: 'MANY_OF',
  required: false,
  description: null,
  values: [
    { id: 'C64', name: 'Cadential 6-4', referenced_concept: null },
    { id: 'App', name: 'Applied Dominant', referenced_concept: null },
  ],
};

/** MANY_OF with 3 values → renders as popover (>2 threshold). */
const schemaManyOfLarge: PropertySchema = {
  id: 'PhraseClosure',
  name: 'Phrase Closure',
  cardinality: 'MANY_OF',
  required: false,
  description: null,
  values: [
    { id: 'PC1', name: 'Closes a Sentence', referenced_concept: null },
    { id: 'PC2', name: 'Closes a Period', referenced_concept: null },
    { id: 'PC3', name: 'Closes a Hybrid Theme', referenced_concept: null },
  ],
};

const schemaBool: PropertySchema = {
  id: 'ECP',
  name: 'Expanded Cadential Progression',
  cardinality: 'BOOL',
  required: false,
  description: null,
  values: [],
};

const schemaBoolRequired: PropertySchema = {
  ...schemaBool,
  id: 'RequiredBool',
  name: 'Required Flag',
  required: true,
};

const schemaWithRef: PropertySchema = {
  id: 'ElabType',
  name: 'Elaboration Type',
  cardinality: 'ONE_OF',
  required: false,
  description: null,
  values: [
    {
      id: 'Cad64',
      name: 'Cadential 6-4',
      referenced_concept: {
        id: 'Cadential64',
        name: 'Cadential 6-4',
        definition: 'A second-inversion tonic chord preceding the dominant.',
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// 1 — computeIsComplete
// ---------------------------------------------------------------------------

describe('computeIsComplete', () => {
  it('returns true when there are no schemas', () => {
    expect(computeIsComplete([], {})).toBe(true);
  });

  it('returns true when there are no required schemas', () => {
    expect(computeIsComplete([schemaBool, schemaManyOf], {})).toBe(true);
  });

  it('returns false when a required ONE_OF value is null', () => {
    expect(computeIsComplete([schemaOneOf], {})).toBe(false);
    expect(computeIsComplete([schemaOneOf], { SopranoScale: null })).toBe(false);
  });

  it('returns true when a required ONE_OF value is set', () => {
    expect(computeIsComplete([schemaOneOf], { SopranoScale: 'SD1' })).toBe(true);
  });

  it('returns false when a required BOOL value is null (unset)', () => {
    expect(computeIsComplete([schemaBoolRequired], {})).toBe(false);
    expect(computeIsComplete([schemaBoolRequired], { RequiredBool: null })).toBe(false);
  });

  it('returns true when a required BOOL is explicitly set to true', () => {
    expect(computeIsComplete([schemaBoolRequired], { RequiredBool: true })).toBe(true);
  });

  it('returns true when a required BOOL is explicitly set to false', () => {
    expect(computeIsComplete([schemaBoolRequired], { RequiredBool: false })).toBe(true);
  });

  it('returns false when a required MANY_OF value is null', () => {
    const req: PropertySchema = { ...schemaManyOf, required: true };
    expect(computeIsComplete([req], {})).toBe(false);
    expect(computeIsComplete([req], { Elaborations: null })).toBe(false);
  });

  it('returns false when a required MANY_OF has an empty array', () => {
    const req: PropertySchema = { ...schemaManyOf, required: true };
    expect(computeIsComplete([req], { Elaborations: [] })).toBe(false);
  });

  it('returns true when a required MANY_OF has at least one value', () => {
    const req: PropertySchema = { ...schemaManyOf, required: true };
    expect(computeIsComplete([req], { Elaborations: ['C64'] })).toBe(true);
  });

  it('ignores optional schemas when checking completeness', () => {
    expect(
      computeIsComplete([schemaOneOf, schemaBool], { SopranoScale: 'SD1' }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2 — carryOverValues
// ---------------------------------------------------------------------------

describe('carryOverValues', () => {
  it('keeps values whose schema id exists in nextSchemas', () => {
    const prev: PropertyFormValues = { SopranoScale: 'SD1', ECP: true };
    const result = carryOverValues(prev, [schemaOneOf, schemaBool]);
    expect(result).toEqual({ SopranoScale: 'SD1', ECP: true });
  });

  it('drops values for schemas not present in nextSchemas', () => {
    const prev: PropertyFormValues = { SopranoScale: 'SD1', ECP: true };
    const result = carryOverValues(prev, [schemaOneOf]);
    expect(result).toEqual({ SopranoScale: 'SD1' });
    expect(result).not.toHaveProperty('ECP');
  });

  it('returns an empty object when nextSchemas is empty', () => {
    const prev: PropertyFormValues = { SopranoScale: 'SD1' };
    expect(carryOverValues(prev, [])).toEqual({});
  });

  it('returns an empty object when prevValues is empty', () => {
    expect(carryOverValues({}, [schemaOneOf])).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// 3 — Rendering
// ---------------------------------------------------------------------------

describe('PropertyForm rendering', () => {
  it('renders nothing when schemas list is empty', () => {
    const { container } = render(
      <PropertyForm schemas={[]} values={{}} onChange={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the property-form container when schemas are present', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('property-form')).toBeInTheDocument();
  });

  it('renders the required * marker for required schemas', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('required')).toBeInTheDocument();
  });

  it('renders ONE_OF with ≤2 values as a radio group', () => {
    render(
      <PropertyForm schemas={[schemaOneOfSmall]} values={{}} onChange={vi.fn()} />,
    );
    const group = screen.getByRole('radiogroup', { name: 'IAC Soprano Degree' });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('renders ONE_OF with >2 values as a dropdown trigger (not radio rows)', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('dropdown-trigger-SopranoScale')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('renders MANY_OF with ≤2 values as a checkbox group', () => {
    render(
      <PropertyForm schemas={[schemaManyOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('renders MANY_OF with >2 values as a dropdown trigger (not checkbox rows)', () => {
    render(
      <PropertyForm schemas={[schemaManyOfLarge]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('dropdown-trigger-PhraseClosure')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('renders BOOL as an inline toggle button', () => {
    render(
      <PropertyForm schemas={[schemaBool]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('bool-toggle-ECP')).toBeInTheDocument();
  });

  it('renders a ⓘ button when a PropertyValue has referenced_concept', () => {
    render(
      <PropertyForm schemas={[schemaWithRef]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('info-btn-Cad64')).toBeInTheDocument();
  });

  it('does not render ⓘ button when referenced_concept is null', () => {
    render(
      <PropertyForm schemas={[schemaOneOfSmall]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId(/^info-btn-/)).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4 — ONE_OF (radio, ≤2 values) interaction
// ---------------------------------------------------------------------------

describe('ONE_OF (radio, ≤2 values) field', () => {
  it('fires onChange with the selected value id', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaOneOfSmall]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('radio-IACSopranoDegree-SD3'));
    expect(onChange).toHaveBeenCalledWith({ IACSopranoDegree: 'SD3' });
  });

  it('fires onChange with null when clicking the already-selected radio (deselect)', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm
        schemas={[schemaOneOfSmall]}
        values={{ IACSopranoDegree: 'SD3' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('radio-IACSopranoDegree-SD3'));
    expect(onChange).toHaveBeenCalledWith({ IACSopranoDegree: null });
  });

  it('selects the correct radio when value is pre-set', () => {
    render(
      <PropertyForm
        schemas={[schemaOneOfSmall]}
        values={{ IACSopranoDegree: 'SD5' }}
        onChange={vi.fn()}
      />,
    );
    const radio = screen.getByLabelText('Scale Degree 5') as HTMLInputElement;
    expect(radio.checked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5 — ONE_OF (popover, >2 values) interaction
// ---------------------------------------------------------------------------

describe('ONE_OF (popover, >2 values) field', () => {
  it('shows "Select…" placeholder when no value is set', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('dropdown-trigger-SopranoScale')).toHaveTextContent('Select…');
  });

  it('shows selected value name in the trigger', () => {
    render(
      <PropertyForm
        schemas={[schemaOneOf]}
        values={{ SopranoScale: 'SD1' }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('dropdown-trigger-SopranoScale')).toHaveTextContent('Scale Degree 1');
  });

  it('opens the popover on trigger click', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId('dropdown-popover-SopranoScale')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dropdown-trigger-SopranoScale'));
    expect(screen.getByTestId('dropdown-popover-SopranoScale')).toBeInTheDocument();
    expect(screen.getByTestId('dropdown-option-SopranoScale-SD1')).toBeInTheDocument();
    expect(screen.getByTestId('dropdown-option-SopranoScale-SD3')).toBeInTheDocument();
    expect(screen.getByTestId('dropdown-option-SopranoScale-SD5')).toBeInTheDocument();
  });

  it('selects a value and closes the popover', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('dropdown-trigger-SopranoScale'));
    fireEvent.click(screen.getByTestId('dropdown-option-SopranoScale-SD3'));
    expect(onChange).toHaveBeenCalledWith({ SopranoScale: 'SD3' });
    expect(screen.queryByTestId('dropdown-popover-SopranoScale')).not.toBeInTheDocument();
  });

  it('deselects when clicking the already-selected option', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm
        schemas={[schemaOneOf]}
        values={{ SopranoScale: 'SD3' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('dropdown-trigger-SopranoScale'));
    fireEvent.click(screen.getByTestId('dropdown-option-SopranoScale-SD3'));
    expect(onChange).toHaveBeenCalledWith({ SopranoScale: null });
  });

  it('closes the popover on Escape', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('dropdown-trigger-SopranoScale'));
    expect(screen.getByTestId('dropdown-popover-SopranoScale')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('dropdown-popover-SopranoScale')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 6 — MANY_OF (checkbox, ≤2 values) interaction
// ---------------------------------------------------------------------------

describe('MANY_OF (checkbox, ≤2 values) field', () => {
  it('adds a value to the array on first check', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaManyOf]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('checkbox-Elaborations-C64'));
    expect(onChange).toHaveBeenCalledWith({ Elaborations: ['C64'] });
  });

  it('removes a value from the array when unchecked', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm
        schemas={[schemaManyOf]}
        values={{ Elaborations: ['C64', 'App'] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('checkbox-Elaborations-C64'));
    expect(onChange).toHaveBeenCalledWith({ Elaborations: ['App'] });
  });

  it('fires onChange with null when the last checked item is unchecked', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm
        schemas={[schemaManyOf]}
        values={{ Elaborations: ['C64'] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('checkbox-Elaborations-C64'));
    expect(onChange).toHaveBeenCalledWith({ Elaborations: null });
  });
});

// ---------------------------------------------------------------------------
// 7 — MANY_OF (popover, >2 values) interaction
// ---------------------------------------------------------------------------

describe('MANY_OF (popover, >2 values) field', () => {
  it('shows "Select…" placeholder when nothing is selected', () => {
    render(
      <PropertyForm schemas={[schemaManyOfLarge]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('dropdown-trigger-PhraseClosure')).toHaveTextContent('Select…');
  });

  it('shows selected names in the trigger when ≤2 selected', () => {
    render(
      <PropertyForm
        schemas={[schemaManyOfLarge]}
        values={{ PhraseClosure: ['PC1', 'PC2'] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('dropdown-trigger-PhraseClosure')).toHaveTextContent(
      'Closes a Sentence, Closes a Period',
    );
  });

  it('shows "N selected" in the trigger when 3+ values selected', () => {
    render(
      <PropertyForm
        schemas={[schemaManyOfLarge]}
        values={{ PhraseClosure: ['PC1', 'PC2', 'PC3'] }}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('dropdown-trigger-PhraseClosure')).toHaveTextContent('3 selected');
  });

  it('opens the popover on trigger click', () => {
    render(
      <PropertyForm schemas={[schemaManyOfLarge]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId('dropdown-popover-PhraseClosure')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('dropdown-trigger-PhraseClosure'));
    expect(screen.getByTestId('dropdown-popover-PhraseClosure')).toBeInTheDocument();
  });

  it('adds a value on option click and keeps popover open', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaManyOfLarge]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('dropdown-trigger-PhraseClosure'));
    fireEvent.click(screen.getByTestId('dropdown-option-PhraseClosure-PC1'));
    expect(onChange).toHaveBeenCalledWith({ PhraseClosure: ['PC1'] });
    // Popover stays open for MANY_OF.
    expect(screen.getByTestId('dropdown-popover-PhraseClosure')).toBeInTheDocument();
  });

  it('removes a value when clicking an already-selected option', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm
        schemas={[schemaManyOfLarge]}
        values={{ PhraseClosure: ['PC1', 'PC2'] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('dropdown-trigger-PhraseClosure'));
    fireEvent.click(screen.getByTestId('dropdown-option-PhraseClosure-PC1'));
    expect(onChange).toHaveBeenCalledWith({ PhraseClosure: ['PC2'] });
  });

  it('fires onChange with null when last value is deselected', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm
        schemas={[schemaManyOfLarge]}
        values={{ PhraseClosure: ['PC1'] }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('dropdown-trigger-PhraseClosure'));
    fireEvent.click(screen.getByTestId('dropdown-option-PhraseClosure-PC1'));
    expect(onChange).toHaveBeenCalledWith({ PhraseClosure: null });
  });

  it('closes the popover on Escape', () => {
    render(
      <PropertyForm schemas={[schemaManyOfLarge]} values={{}} onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('dropdown-trigger-PhraseClosure'));
    expect(screen.getByTestId('dropdown-popover-PhraseClosure')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('dropdown-popover-PhraseClosure')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 8 — BOOL field interaction
// ---------------------------------------------------------------------------

describe('BOOL field', () => {
  it('shows ✗ indicator when value is null (unset — looks same as off)', () => {
    render(
      <PropertyForm schemas={[schemaBool]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('bool-toggle-ECP')).toHaveTextContent('✗');
  });

  it('shows ✓ indicator when value is true', () => {
    render(
      <PropertyForm schemas={[schemaBool]} values={{ ECP: true }} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('bool-toggle-ECP')).toHaveTextContent('✓');
  });

  it('shows ✗ indicator when value is false', () => {
    render(
      <PropertyForm schemas={[schemaBool]} values={{ ECP: false }} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('bool-toggle-ECP')).toHaveTextContent('✗');
  });

  it('fires onChange with true on first click (null → true)', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaBool]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('bool-toggle-ECP'));
    expect(onChange).toHaveBeenCalledWith({ ECP: true });
  });

  it('fires onChange with false on click from true (true → false)', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaBool]} values={{ ECP: true }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('bool-toggle-ECP'));
    expect(onChange).toHaveBeenCalledWith({ ECP: false });
  });

  it('fires onChange with true on click from false (false → true, never back to null)', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaBool]} values={{ ECP: false }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('bool-toggle-ECP'));
    expect(onChange).toHaveBeenCalledWith({ ECP: true });
  });

  it('reflects current state in aria-label', () => {
    const { rerender } = render(
      <PropertyForm schemas={[schemaBool]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('bool-toggle-ECP')).toHaveAttribute(
      'aria-label',
      'Expanded Cadential Progression: unset',
    );
    rerender(
      <PropertyForm schemas={[schemaBool]} values={{ ECP: true }} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('bool-toggle-ECP')).toHaveAttribute(
      'aria-label',
      'Expanded Cadential Progression: yes',
    );
    rerender(
      <PropertyForm schemas={[schemaBool]} values={{ ECP: false }} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('bool-toggle-ECP')).toHaveAttribute(
      'aria-label',
      'Expanded Cadential Progression: no',
    );
  });
});

// ---------------------------------------------------------------------------
// 9 — Schema description tooltip (ⓘ on the field name)
// ---------------------------------------------------------------------------

const schemaWithDesc: PropertySchema = {
  id: 'SopranoScale',
  name: 'Soprano Scale Degree',
  cardinality: 'ONE_OF',
  required: true,
  description: 'The scale degree sung by the soprano voice at the cadential arrival.',
  values: [{ id: 'SD1', name: 'Scale Degree 1', referenced_concept: null }],
};

describe('Schema description tooltip', () => {
  it('does not render a ⓘ desc button when description is null', () => {
    render(
      <PropertyForm schemas={[schemaOneOfSmall]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId('desc-btn-IACSopranoDegree')).not.toBeInTheDocument();
  });

  it('renders a ⓘ desc button when schema has a description', () => {
    render(
      <PropertyForm schemas={[schemaWithDesc]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('desc-btn-SopranoScale')).toBeInTheDocument();
  });

  it('shows the description panel when ⓘ is clicked', () => {
    render(
      <PropertyForm schemas={[schemaWithDesc]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId('desc-panel-SopranoScale')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('desc-btn-SopranoScale'));
    expect(screen.getByTestId('desc-panel-SopranoScale')).toBeInTheDocument();
    expect(
      screen.getByText('The scale degree sung by the soprano voice at the cadential arrival.'),
    ).toBeInTheDocument();
  });

  it('hides the description panel when ⓘ is clicked a second time', () => {
    render(
      <PropertyForm schemas={[schemaWithDesc]} values={{}} onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('desc-btn-SopranoScale'));
    expect(screen.getByTestId('desc-panel-SopranoScale')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('desc-btn-SopranoScale'));
    expect(screen.queryByTestId('desc-panel-SopranoScale')).not.toBeInTheDocument();
  });

  it('shows the panel on mouseenter and hides on mouseleave', () => {
    render(
      <PropertyForm schemas={[schemaWithDesc]} values={{}} onChange={vi.fn()} />,
    );
    const btn = screen.getByTestId('desc-btn-SopranoScale');
    fireEvent.mouseEnter(btn);
    expect(screen.getByTestId('desc-panel-SopranoScale')).toBeInTheDocument();
    fireEvent.mouseLeave(btn);
    expect(screen.queryByTestId('desc-panel-SopranoScale')).not.toBeInTheDocument();
  });
});

describe('VALUE_REFERENCES info panel', () => {
  it('shows the definition panel when ⓘ is clicked', () => {
    render(
      <PropertyForm schemas={[schemaWithRef]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId('info-panel-Cad64')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('info-btn-Cad64'));
    const infoPanel = screen.getByTestId('info-panel-Cad64');
    expect(infoPanel).toBeInTheDocument();
    // "Cadential 6-4" also appears as the option label, so scope to the panel.
    expect(within(infoPanel).getByText('Cadential 6-4')).toBeInTheDocument();
    expect(
      within(infoPanel).getByText(
        'A second-inversion tonic chord preceding the dominant.',
      ),
    ).toBeInTheDocument();
  });

  it('hides the definition panel when ⓘ is clicked a second time', () => {
    render(
      <PropertyForm schemas={[schemaWithRef]} values={{}} onChange={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId('info-btn-Cad64'));
    expect(screen.getByTestId('info-panel-Cad64')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('info-btn-Cad64'));
    expect(screen.queryByTestId('info-panel-Cad64')).not.toBeInTheDocument();
  });

  it('clicking ⓘ does not select the option', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaWithRef]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('info-btn-Cad64'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
