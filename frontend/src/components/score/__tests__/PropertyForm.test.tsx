/**
 * Tests for PropertyForm — Component 5 Step 13.
 *
 * Verification targets from the roadmap (Step 13):
 *   "A PAC renders its inherited cadence schemas including the BOOL toggles."
 *   "Switching from PAC to IAC keeps shared values and drops inapplicable ones."
 *   "Submission is blocked while a required property is empty."
 *
 * Structure:
 *   1. Pure-function tests (computeIsComplete, carryOverValues) — no render.
 *   2. Component rendering tests — control types, required marker, groups.
 *   3. Interaction tests — field changes fire onChange; deselect patterns.
 *   4. Info reference tests — ⓘ toggle shows/hides the definition panel.
 */

import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import PropertyForm, {
  computeIsComplete,
  carryOverValues,
} from '../PropertyForm';
import type { PropertyFormValues } from '../PropertyForm';
import type { PropertySchema } from '../../../services/conceptApi';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

const schemaOneOfMany: PropertySchema = {
  id: 'LargeOneOf',
  name: 'Large Selection',
  cardinality: 'ONE_OF',
  required: false,
  description: null,
  values: Array.from({ length: 6 }, (_, i) => ({
    id: `V${i}`,
    name: `Value ${i}`,
    referenced_concept: null,
  })),
};

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

  it('renders required schemas in a required-properties group', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('required-properties')).toBeInTheDocument();
  });

  it('renders optional schemas in an optional-properties group', () => {
    render(
      <PropertyForm schemas={[schemaBool]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('optional-properties')).toBeInTheDocument();
  });

  it('renders the required * marker for required schemas', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByLabelText('required')).toBeInTheDocument();
  });

  it('renders ONE_OF with ≤5 values as a radio group', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    const group = screen.getByRole('radiogroup', { name: 'Soprano Scale Degree' });
    expect(group).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(3);
  });

  it('renders ONE_OF with >5 values as a select dropdown', () => {
    render(
      <PropertyForm schemas={[schemaOneOfMany]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('select-LargeOneOf')).toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  });

  it('renders MANY_OF as a checkbox group', () => {
    render(
      <PropertyForm schemas={[schemaManyOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
  });

  it('renders BOOL as Yes / No buttons', () => {
    render(
      <PropertyForm schemas={[schemaBool]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('bool-yes-ECP')).toBeInTheDocument();
    expect(screen.getByTestId('bool-no-ECP')).toBeInTheDocument();
  });

  it('renders a ⓘ button when a PropertyValue has referenced_concept', () => {
    render(
      <PropertyForm schemas={[schemaWithRef]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.getByTestId('info-btn-Cad64')).toBeInTheDocument();
  });

  it('does not render ⓘ button when referenced_concept is null', () => {
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId(/^info-btn-/)).not.toBeInTheDocument();
  });

  it('renders both required and optional groups when both are present', () => {
    render(
      <PropertyForm
        schemas={[schemaOneOf, schemaBool]}
        values={{}}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('required-properties')).toBeInTheDocument();
    expect(screen.getByTestId('optional-properties')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 4 — ONE_OF (radio) interaction
// ---------------------------------------------------------------------------

describe('ONE_OF (radio) field', () => {
  it('fires onChange with the selected value id', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('radio-SopranoScale-SD1'));
    expect(onChange).toHaveBeenCalledWith({ SopranoScale: 'SD1' });
  });

  it('fires onChange with null when clicking the already-selected radio (deselect)', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm
        schemas={[schemaOneOf]}
        values={{ SopranoScale: 'SD1' }}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('radio-SopranoScale-SD1'));
    expect(onChange).toHaveBeenCalledWith({ SopranoScale: null });
  });

  it('selects the correct radio when value is pre-set', () => {
    render(
      <PropertyForm
        schemas={[schemaOneOf]}
        values={{ SopranoScale: 'SD3' }}
        onChange={vi.fn()}
      />,
    );
    const radio = screen.getByLabelText('Scale Degree 3') as HTMLInputElement;
    expect(radio.checked).toBe(true);
  });

  it('renders a select and fires onChange for ONE_OF with >5 values', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaOneOfMany]} values={{}} onChange={onChange} />,
    );
    const sel = screen.getByTestId('select-LargeOneOf') as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: 'V2' } });
    expect(onChange).toHaveBeenCalledWith({ LargeOneOf: 'V2' });
  });

  it('fires onChange with null when the select placeholder is chosen', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm
        schemas={[schemaOneOfMany]}
        values={{ LargeOneOf: 'V2' }}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('select-LargeOneOf'), {
      target: { value: '' },
    });
    expect(onChange).toHaveBeenCalledWith({ LargeOneOf: null });
  });
});

// ---------------------------------------------------------------------------
// 5 — MANY_OF (checkbox) interaction
// ---------------------------------------------------------------------------

describe('MANY_OF (checkbox) field', () => {
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
// 6 — BOOL field interaction
// ---------------------------------------------------------------------------

describe('BOOL field', () => {
  it('fires onChange with true when Yes is clicked (was null)', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaBool]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('bool-yes-ECP'));
    expect(onChange).toHaveBeenCalledWith({ ECP: true });
  });

  it('fires onChange with false when No is clicked (was null)', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaBool]} values={{}} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('bool-no-ECP'));
    expect(onChange).toHaveBeenCalledWith({ ECP: false });
  });

  it('fires onChange with null when Yes is clicked while already true (deselect)', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaBool]} values={{ ECP: true }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('bool-yes-ECP'));
    expect(onChange).toHaveBeenCalledWith({ ECP: null });
  });

  it('fires onChange with null when No is clicked while already false (deselect)', () => {
    const onChange = vi.fn();
    render(
      <PropertyForm schemas={[schemaBool]} values={{ ECP: false }} onChange={onChange} />,
    );
    fireEvent.click(screen.getByTestId('bool-no-ECP'));
    expect(onChange).toHaveBeenCalledWith({ ECP: null });
  });

  it('reflects the current value via aria-pressed', () => {
    render(
      <PropertyForm schemas={[schemaBool]} values={{ ECP: true }} onChange={vi.fn()} />,
    );
    const yesBtn = screen.getByTestId('bool-yes-ECP');
    const noBtn = screen.getByTestId('bool-no-ECP');
    expect(yesBtn).toHaveAttribute('aria-pressed', 'true');
    expect(noBtn).toHaveAttribute('aria-pressed', 'false');
  });
});

// ---------------------------------------------------------------------------
// 7 — Schema description tooltip (ⓘ on the field name)
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
      <PropertyForm schemas={[schemaOneOf]} values={{}} onChange={vi.fn()} />,
    );
    expect(screen.queryByTestId('desc-btn-SopranoScale')).not.toBeInTheDocument();
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
