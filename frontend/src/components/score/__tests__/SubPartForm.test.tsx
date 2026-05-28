/**
 * Tests for SubPartForm — Component 5 Step 15.
 *
 * Step 15 verification targets:
 *   "Tagging a cadence with a sub-tagged Dominant stage produces a parent
 *    fragment and one child with parent_fragment_id set and bounds within the
 *    parent."
 *
 * These tests cover the client-side half of that requirement: that selecting a
 * concept in a SubPartForm fires onUpdate with the correct tag shape, that
 * removing the tag fires onUpdate(stageId, null), and that incrementing resetKey
 * resets the form to empty state.
 *
 * The parent-fragment → child-fragment atomic write is covered by the backend
 * integration tests (Step 6); the containment rejection is tested there too.
 *
 * Timer strategy: real timers throughout. ConceptPicker has a 300 ms debounce;
 * waitFor (2 000 ms timeout) handles it without fake-timer management.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import SubPartForm from '../SubPartForm';
import * as conceptApi from '../../../services/conceptApi';
import type { ConceptSchemaTree, ConceptSearchHit, ConceptSearchPage } from '../../../services/conceptApi';

vi.mock('../../../services/conceptApi');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dominant: ConceptSearchHit = {
  id: 'Dominant',
  name: 'Dominant',
  aliases: [],
  hierarchy_path: ['CadenceStage'],
  definition: null,
};

const dominantTree: ConceptSchemaTree = {
  concept_id: 'Dominant',
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

const emptySearchPage: ConceptSearchPage = { items: [], next_cursor: null };
const dominantSearchPage: ConceptSearchPage = {
  items: [dominant],
  next_cursor: null,
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(conceptApi.searchConcepts).mockResolvedValue(emptySearchPage);
  vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(dominantTree);
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function typeInPicker(value: string) {
  const input = screen.getByTestId('concept-search-input');
  fireEvent.change(input, { target: { value } });
  return input;
}

async function selectConcept(id: string) {
  await waitFor(() => screen.getByTestId(`concept-card-${id}`));
  fireEvent.click(screen.getByTestId(`concept-card-${id}`));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubPartForm', () => {
  it('renders the concept picker and "Sub-part tag" heading', () => {
    render(
      <SubPartForm
        stageId="Dominant"
        stageName="Dominant"
        initialTag={null}
        resetKey={0}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByText(/sub-part tag/i)).toBeInTheDocument();
    expect(screen.getByTestId('concept-search-input')).toBeInTheDocument();
  });

  it('calls onUpdate with the selected concept after schema loads', async () => {
    const onUpdate = vi.fn();
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(dominantSearchPage);

    render(
      <SubPartForm
        stageId="Dominant"
        stageName="Dominant"
        initialTag={null}
        resetKey={0}
        onUpdate={onUpdate}
      />,
    );

    typeInPicker('Dom');
    await selectConcept('Dominant');

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith('Dominant', expect.objectContaining({
        concept: expect.objectContaining({ id: 'Dominant' }),
        schemaTree: dominantTree,
        propertyValues: {},
      })),
    );
  });

  it('renders the property form after concept selection', async () => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(dominantSearchPage);

    render(
      <SubPartForm
        stageId="Dominant"
        stageName="Dominant"
        initialTag={null}
        resetKey={0}
        onUpdate={vi.fn()}
      />,
    );

    typeInPicker('Dom');
    await selectConcept('Dominant');

    await waitFor(() =>
      expect(screen.getByText('Bass Scale Degree')).toBeInTheDocument(),
    );
  });

  it('shows Remove button once a concept is selected', async () => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(dominantSearchPage);

    render(
      <SubPartForm
        stageId="Dominant"
        stageName="Dominant"
        initialTag={null}
        resetKey={0}
        onUpdate={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('sub-part-remove-Dominant')).not.toBeInTheDocument();

    typeInPicker('Dom');
    await selectConcept('Dominant');

    await waitFor(() =>
      expect(screen.getByTestId('sub-part-remove-Dominant')).toBeInTheDocument(),
    );
  });

  it('calls onUpdate(stageId, null) when Remove is clicked', async () => {
    const onUpdate = vi.fn();
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(dominantSearchPage);

    render(
      <SubPartForm
        stageId="Dominant"
        stageName="Dominant"
        initialTag={null}
        resetKey={0}
        onUpdate={onUpdate}
      />,
    );

    typeInPicker('Dom');
    await selectConcept('Dominant');
    await waitFor(() => screen.getByTestId('sub-part-remove-Dominant'));

    fireEvent.click(screen.getByTestId('sub-part-remove-Dominant'));

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith('Dominant', null),
    );
  });

  it('resets to empty when resetKey is incremented', async () => {
    const onUpdate = vi.fn();
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(dominantSearchPage);

    const { rerender } = render(
      <SubPartForm
        stageId="Dominant"
        stageName="Dominant"
        initialTag={null}
        resetKey={0}
        onUpdate={onUpdate}
      />,
    );

    // Select a concept to populate the form.
    typeInPicker('Dom');
    await selectConcept('Dominant');
    await waitFor(() => screen.getByTestId('sub-part-remove-Dominant'));

    // Increment resetKey — simulates parent concept change.
    rerender(
      <SubPartForm
        stageId="Dominant"
        stageName="Dominant"
        initialTag={null}
        resetKey={1}
        onUpdate={onUpdate}
      />,
    );

    // Remove button should be gone — form is blank again.
    expect(screen.queryByTestId('sub-part-remove-Dominant')).not.toBeInTheDocument();
  });

  it('renders with an initialTag pre-populated', () => {
    const initialTag = {
      concept: dominant,
      schemaTree: dominantTree,
      propertyValues: {},
    };
    render(
      <SubPartForm
        stageId="Dominant"
        stageName="Dominant"
        initialTag={initialTag}
        resetKey={0}
        onUpdate={vi.fn()}
      />,
    );
    expect(screen.getByTestId('sub-part-remove-Dominant')).toBeInTheDocument();
  });

  it('calls onUpdate with updated propertyValues when a property changes', async () => {
    const onUpdate = vi.fn();
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(dominantSearchPage);

    render(
      <SubPartForm
        stageId="Dominant"
        stageName="Dominant"
        initialTag={null}
        resetKey={0}
        onUpdate={onUpdate}
      />,
    );

    typeInPicker('Dom');
    await selectConcept('Dominant');
    await waitFor(() => screen.getByText('Bass Scale Degree'));

    // Select the first radio option.
    const radio = screen.getByLabelText('5̂');
    fireEvent.click(radio);

    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith('Dominant', expect.objectContaining({
        propertyValues: expect.objectContaining({ BassScale: 'bass_5' }),
      })),
    );
  });
});
