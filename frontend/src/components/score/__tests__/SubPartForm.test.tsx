/**
 * Tests for SubPartForm — Component 5 Step 15 (revised design).
 *
 * The stage concept is implicit from stageConceptId; there is no concept picker.
 * The form auto-fetches the stage concept's schema on mount and renders a
 * PropertyForm for optional stage-level properties.
 *
 * Step 15 verification targets:
 *   - Schema is loaded automatically on mount using stageConceptId.
 *   - PropertyForm renders once the schema is available.
 *   - onUpdate fires with { schemaTree, propertyValues } on load and on change.
 *   - resetKey increments clear propertyValues (schema stays).
 *   - An initialTag with pre-loaded schemaTree skips the fetch.
 *   - Loading and error states render correctly.
 *   - A stage with no schemas renders nothing (null).
 *
 * The parent-fragment → child-fragment atomic write is covered by the backend
 * integration tests (Step 6); the containment rejection is tested there too.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SubPartForm from '../SubPartForm';
import * as conceptApi from '../../../services/conceptApi';
import type { ConceptSchemaTree } from '../../../services/conceptApi';

vi.mock('../../../services/conceptApi');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dominantTree: ConceptSchemaTree = {
  concept_id: 'CadentialDominant',
  schemas: [
    {
      id: 'BassScale',
      name: 'Bass Scale Degree',
      cardinality: 'ONE_OF',
      required: false,
      description: null,
      values: [
        { id: 'bass_5', name: '5̂', referenced_concept: null },
        { id: 'bass_7', name: '7̂', referenced_concept: null },
      ],
    },
  ],
  stages: [],
  type_refinement: { show: false, children: [] },
};

const emptyTree: ConceptSchemaTree = {
  concept_id: 'CadentialInitialTonic',
  schemas: [],
  stages: [],
  type_refinement: { show: false, children: [] },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(dominantTree);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubPartForm', () => {
  it('fetches schema on mount and renders the property form', async () => {
    render(
      <SubPartForm
        stageId="CadentialDominant"
        stageName="Dominant"
        stageConceptId="CadentialDominant"
        initialTag={null}
        resetKey={0}
        onUpdate={vi.fn()}
      />,
    );

    // While loading, show a loading indicator (not the form).
    expect(screen.getByTestId('sub-part-form-CadentialDominant')).toBeInTheDocument();

    // After the schema loads, the property label should appear.
    await waitFor(() =>
      expect(screen.getByText('Bass Scale Degree')).toBeInTheDocument(),
    );
    expect(conceptApi.getConceptSchemas).toHaveBeenCalledWith('CadentialDominant');
  });

  it('calls onUpdate with the loaded schema once fetch resolves', async () => {
    const onUpdate = vi.fn();

    render(
      <SubPartForm
        stageId="CadentialDominant"
        stageName="Dominant"
        stageConceptId="CadentialDominant"
        initialTag={null}
        resetKey={0}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith('CadentialDominant', {
        schemaTree: dominantTree,
        propertyValues: {},
      }),
    );
  });

  it('calls onUpdate with updated propertyValues when a property changes', async () => {
    const onUpdate = vi.fn();

    render(
      <SubPartForm
        stageId="CadentialDominant"
        stageName="Dominant"
        stageConceptId="CadentialDominant"
        initialTag={null}
        resetKey={0}
        onUpdate={onUpdate}
      />,
    );

    await waitFor(() => screen.getByText('Bass Scale Degree'));

    const radio = screen.getByLabelText('5̂');
    fireEvent.click(radio);

    expect(onUpdate).toHaveBeenCalledWith('CadentialDominant', {
      schemaTree: dominantTree,
      propertyValues: { BassScale: 'bass_5' },
    });
  });

  it('skips the fetch when initialTag carries a pre-loaded schemaTree', () => {
    const initialTag = { schemaTree: dominantTree, propertyValues: {} };

    render(
      <SubPartForm
        stageId="CadentialDominant"
        stageName="Dominant"
        stageConceptId="CadentialDominant"
        initialTag={initialTag}
        resetKey={0}
        onUpdate={vi.fn()}
      />,
    );

    // Schema renders immediately without waiting.
    expect(screen.getByText('Bass Scale Degree')).toBeInTheDocument();
    expect(conceptApi.getConceptSchemas).not.toHaveBeenCalled();
  });

  it('resets propertyValues when resetKey is incremented', async () => {
    const onUpdate = vi.fn();

    const { rerender } = render(
      <SubPartForm
        stageId="CadentialDominant"
        stageName="Dominant"
        stageConceptId="CadentialDominant"
        initialTag={null}
        resetKey={0}
        onUpdate={onUpdate}
      />,
    );

    // Wait for schema to load and select a property value.
    await waitFor(() => screen.getByText('Bass Scale Degree'));
    fireEvent.click(screen.getByLabelText('5̂'));

    onUpdate.mockClear();

    // Increment resetKey — simulates main concept change.
    rerender(
      <SubPartForm
        stageId="CadentialDominant"
        stageName="Dominant"
        stageConceptId="CadentialDominant"
        initialTag={null}
        resetKey={1}
        onUpdate={onUpdate}
      />,
    );

    // onUpdate should fire with empty propertyValues.
    expect(onUpdate).toHaveBeenCalledWith('CadentialDominant', {
      schemaTree: dominantTree,
      propertyValues: {},
    });
  });

  it('shows a loading indicator while fetching the schema', () => {
    // Never resolves in this test.
    vi.mocked(conceptApi.getConceptSchemas).mockImplementation(
      () => new Promise(() => {}),
    );

    render(
      <SubPartForm
        stageId="CadentialDominant"
        stageName="Dominant"
        stageConceptId="CadentialDominant"
        initialTag={null}
        resetKey={0}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it('shows an error message when the schema fetch fails', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockRejectedValue(new Error('network'));

    render(
      <SubPartForm
        stageId="CadentialDominant"
        stageName="Dominant"
        stageConceptId="CadentialDominant"
        initialTag={null}
        resetKey={0}
        onUpdate={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/could not load/i),
    );
  });

  it('renders nothing when the schema has no property schemas', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(emptyTree);

    const { container } = render(
      <SubPartForm
        stageId="CadentialInitialTonic"
        stageName="Initial Tonic"
        stageConceptId="CadentialInitialTonic"
        initialTag={null}
        resetKey={0}
        onUpdate={vi.fn()}
      />,
    );

    await waitFor(() =>
      // The component should return null when there are no schemas.
      expect(container.firstChild).toBeNull(),
    );
  });
});
