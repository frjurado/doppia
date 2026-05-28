/**
 * Tests for FormPanel — Component 5 Steps 12 and 13.
 *
 * Step 12 verification targets:
 *   "Selecting a concept with structurally-divergent children shows the
 *    refinement radio group."
 *   "Selecting one whose children differ only in properties does not."
 *
 * Step 13 verification targets:
 *   "A PAC renders its inherited cadence schemas including the BOOL toggles."
 *   "Switching from PAC to IAC keeps shared values and drops inapplicable ones."
 *   "Submission is blocked while a required property is empty."
 *
 * Timer strategy: real timers throughout. The ConceptPicker has a 300 ms
 * debounce; waitFor with its 2 000 ms timeout accommodates it comfortably
 * without requiring fake-timer management. This avoids fake-timer / async
 * interaction bugs where setTimeout-based waitFor polling is blocked.
 */

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import FormPanel from '../FormPanel';
import * as conceptApi from '../../../services/conceptApi';
import type { ConceptSchemaTree, ConceptSearchHit, ConceptSearchPage } from '../../../services/conceptApi';
import type { AnnotationSession } from '../annotator';

vi.mock('../../../services/conceptApi');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const pac: ConceptSearchHit = {
  id: 'PerfectAuthenticCadence',
  name: 'Perfect Authentic Cadence',
  aliases: ['PAC'],
  hierarchy_path: ['Cadence', 'Authentic Cadence'],
  definition: null,
};

const iac: ConceptSearchHit = {
  id: 'ImperfectAuthenticCadence',
  name: 'Imperfect Authentic Cadence',
  aliases: ['IAC'],
  hierarchy_path: ['Cadence', 'Authentic Cadence'],
  definition: null,
};

/** Schema tree with structural type-refinement options (differing CONTAINS). */
const treeWithRefinements: ConceptSchemaTree = {
  concept_id: 'PerfectAuthenticCadence',
  schemas: [],
  stages: [],
  type_refinement: {
    show: true,
    children: [
      { id: 'ChildA', name: 'Variant A', definition: null },
      { id: 'ChildB', name: 'Variant B', definition: null },
    ],
  },
};

/** Schema tree with no type-refinement options (children differ only in props). */
const treeNoRefinements: ConceptSchemaTree = {
  concept_id: 'PerfectAuthenticCadence',
  schemas: [],
  stages: [],
  type_refinement: { show: false, children: [] },
};

// ── Step 13 fixtures ─────────────────────────────────────────────────────────

/** Schema shared by PAC and IAC via inheritance (SopranoScaleDegree). */
const sharedSchema = {
  id: 'SopranoScale',
  name: 'Soprano Scale Degree',
  cardinality: 'ONE_OF' as const,
  required: true,
  description: null,
  values: [
    { id: 'SD1', name: 'Scale Degree 1', referenced_concept: null },
    { id: 'SD3', name: 'Scale Degree 3', referenced_concept: null },
  ],
};

/** Schema only on PAC (not on IAC). */
const pacOnlySchema = {
  id: 'PACOnly',
  name: 'PAC-only Flag',
  cardinality: 'BOOL' as const,
  required: false,
  description: null,
  values: [],
};

/** PAC schema tree: one required ONE_OF + one optional BOOL. */
const treePACWithSchemas: ConceptSchemaTree = {
  concept_id: 'PerfectAuthenticCadence',
  schemas: [sharedSchema, pacOnlySchema],
  stages: [],
  type_refinement: { show: false, children: [] },
};

/** IAC schema tree: only the shared ONE_OF (no BOOL). */
const treeIACWithSchemas: ConceptSchemaTree = {
  concept_id: 'ImperfectAuthenticCadence',
  schemas: [sharedSchema],
  stages: [],
  type_refinement: { show: false, children: [] },
};

function makePage(hits: ConceptSearchHit[]): ConceptSearchPage {
  return { items: hits, next_cursor: null };
}

/** Minimal AnnotationSession stub — only the methods FormPanel calls. */
function makeSession(): AnnotationSession {
  return {
    setConceptSet: vi.fn(),
    setStagesComplete: vi.fn(),
    setPropertiesComplete: vi.fn(),
  } as unknown as AnnotationSession;
}

const defaultFlags = {
  fragmentSet: false,
  conceptSet: false,
  stagesComplete: false,
  propertiesComplete: false,
};

// ---------------------------------------------------------------------------
// Helper — type a query and wait for concept cards (real timers, debounce fires naturally)
// ---------------------------------------------------------------------------

const WAIT_OPTS = { timeout: 2000 };

async function searchAndWait(query: string) {
  const input = screen.getByTestId('concept-search-input');
  fireEvent.change(input, { target: { value: query } });
  await waitFor(
    () => screen.getByTestId('concept-card-PerfectAuthenticCadence'),
    WAIT_OPTS,
  );
}

/**
 * After clicking a concept card, flush the async schema-fetch chain.
 * RTL's act flushes React state updates and pending microtasks.
 */
async function flushAfterClick() {
  await act(async () => {
    // Three microtask ticks cover the async chain in handleConceptSelect:
    // tick 1: await getConceptSchemas() resolves
    // tick 2: setSchemaTree() queued
    // tick 3: React batch flushes
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FormPanel', () => {
  beforeEach(() => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([pac, iac]));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the concept picker', () => {
    render(<FormPanel session={null} flags={defaultFlags} />);
    expect(screen.getByTestId('concept-picker')).toBeInTheDocument();
  });

  it('does not render TypeRefinement before a concept is selected', () => {
    render(<FormPanel session={null} flags={defaultFlags} />);
    expect(screen.queryByTestId('type-refinement')).not.toBeInTheDocument();
  });

  it('calls session.setConceptSet(true) when a concept is selected', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treeNoRefinements);
    const session = makeSession();

    render(<FormPanel session={session} flags={defaultFlags} />);
    await searchAndWait('perfect');

    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    // setConceptSet(true) is called synchronously before the schema fetch.
    await waitFor(() => {
      expect(session.setConceptSet).toHaveBeenCalledWith(true);
    }, WAIT_OPTS);
  });

  it('calls session.setConceptSet(false) when the concept is cleared', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treeNoRefinements);
    const session = makeSession();

    render(<FormPanel session={session} flags={defaultFlags} />);
    await searchAndWait('perfect');

    // Select.
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await waitFor(
      () => expect(session.setConceptSet).toHaveBeenCalledWith(true),
      WAIT_OPTS,
    );

    // Clear via the ✕ button.
    fireEvent.click(screen.getByLabelText('Clear selection'));
    await waitFor(
      () => expect(session.setConceptSet).toHaveBeenCalledWith(false),
      WAIT_OPTS,
    );
  });

  it('shows TypeRefinement when the selected concept has structurally-divergent children', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treeWithRefinements);

    render(<FormPanel session={null} flags={defaultFlags} />);
    await searchAndWait('perfect');

    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    expect(screen.getByTestId('type-refinement')).toBeInTheDocument();
    expect(screen.getByText('Variant A')).toBeInTheDocument();
    expect(screen.getByText('Variant B')).toBeInTheDocument();
  });

  it('does NOT show TypeRefinement when the selected concept has no structural refinements', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treeNoRefinements);

    render(<FormPanel session={null} flags={defaultFlags} />);
    await searchAndWait('perfect');

    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    expect(screen.queryByTestId('type-refinement')).not.toBeInTheDocument();
  });

  it('fires onConceptChange with concept and schema tree after selection', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treeWithRefinements);
    const onConceptChange = vi.fn();

    render(<FormPanel session={null} flags={defaultFlags} onConceptChange={onConceptChange} />);
    await searchAndWait('perfect');

    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    expect(onConceptChange).toHaveBeenCalledWith(pac, treeWithRefinements);
  });

  it('fires onRefinementChange when a refinement option is selected', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treeWithRefinements);
    const onRefinementChange = vi.fn();

    render(<FormPanel session={null} flags={defaultFlags} onRefinementChange={onRefinementChange} />);
    await searchAndWait('perfect');

    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    expect(screen.getByTestId('type-refinement')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Variant A' }));

    expect(onRefinementChange).toHaveBeenCalledWith(treeWithRefinements.type_refinement.children[0]);
  });

  it('resets refinement when a new concept is selected', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treeWithRefinements);
    const onRefinementChange = vi.fn();

    render(<FormPanel session={null} flags={defaultFlags} onRefinementChange={onRefinementChange} />);
    await searchAndWait('authentic');

    // Select PAC and choose a refinement.
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();
    fireEvent.click(screen.getByRole('radio', { name: 'Variant A' }));
    expect(onRefinementChange).toHaveBeenLastCalledWith(treeWithRefinements.type_refinement.children[0]);

    // Select IAC — refinement should reset to null.
    fireEvent.click(screen.getByTestId('concept-card-ImperfectAuthenticCadence'));
    await flushAfterClick();

    const calls = vi.mocked(onRefinementChange).mock.calls;
    expect(calls[calls.length - 1][0]).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step 13 — PropertyForm integration
// ---------------------------------------------------------------------------

describe('FormPanel Step 13 — PropertyForm', () => {
  beforeEach(() => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([pac, iac]));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Properties section when the concept has schemas', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treePACWithSchemas);

    render(<FormPanel session={null} flags={defaultFlags} />);
    await searchAndWait('perfect');
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    expect(screen.getByTestId('property-form')).toBeInTheDocument();
  });

  it('does NOT render the Properties section when the concept has no schemas', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treeNoRefinements);

    render(<FormPanel session={null} flags={defaultFlags} />);
    await searchAndWait('perfect');
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    expect(screen.queryByTestId('property-form')).not.toBeInTheDocument();
  });

  it('renders the BOOL toggle schemas among the property fields', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treePACWithSchemas);

    render(<FormPanel session={null} flags={defaultFlags} />);
    await searchAndWait('perfect');
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    // Both the required ONE_OF and the optional BOOL are rendered.
    expect(screen.getByTestId('field-SopranoScale')).toBeInTheDocument();
    expect(screen.getByTestId('bool-yes-PACOnly')).toBeInTheDocument();
    expect(screen.getByTestId('bool-no-PACOnly')).toBeInTheDocument();
  });

  it('calls session.setPropertiesComplete(false) when a required field is unset', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treePACWithSchemas);
    const session = makeSession();

    render(<FormPanel session={session} flags={defaultFlags} />);
    await searchAndWait('perfect');
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    // SopranoScale is required and not yet filled → false.
    await waitFor(() => {
      const calls = vi.mocked(session.setPropertiesComplete).mock.calls;
      expect(calls[calls.length - 1][0]).toBe(false);
    }, WAIT_OPTS);
  });

  it('calls session.setPropertiesComplete(true) once all required fields are filled', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treePACWithSchemas);
    const session = makeSession();

    render(<FormPanel session={session} flags={defaultFlags} />);
    await searchAndWait('perfect');
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    // Fill the required SopranoScale field.
    fireEvent.click(screen.getByTestId('radio-SopranoScale-SD1'));

    await waitFor(() => {
      const calls = vi.mocked(session.setPropertiesComplete).mock.calls;
      expect(calls[calls.length - 1][0]).toBe(true);
    }, WAIT_OPTS);
  });

  it('calls session.setPropertiesComplete(true) for concepts with no required schemas', async () => {
    // treeNoRefinements has schemas: [] — no required schemas → trivially complete.
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treeNoRefinements);
    const session = makeSession();

    render(<FormPanel session={session} flags={defaultFlags} />);
    await searchAndWait('perfect');
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();

    await waitFor(() => {
      const calls = vi.mocked(session.setPropertiesComplete).mock.calls;
      expect(calls[calls.length - 1][0]).toBe(true);
    }, WAIT_OPTS);
  });

  it('carries over shared property values when switching concepts', async () => {
    // PAC → fill SopranoScale → switch to IAC → SopranoScale value should persist.
    vi.mocked(conceptApi.getConceptSchemas)
      .mockResolvedValueOnce(treePACWithSchemas)   // PAC
      .mockResolvedValueOnce(treeIACWithSchemas);  // IAC

    render(<FormPanel session={null} flags={defaultFlags} />);
    await searchAndWait('authentic');

    // Select PAC and fill the required field.
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();
    fireEvent.click(screen.getByTestId('radio-SopranoScale-SD1'));

    // Switch to IAC.
    fireEvent.click(screen.getByTestId('concept-card-ImperfectAuthenticCadence'));
    await flushAfterClick();

    // SopranoScale is shared → its radio should still be checked.
    const radio = screen.getByLabelText('Scale Degree 1') as HTMLInputElement;
    expect(radio.checked).toBe(true);
  });

  it('discards non-shared property values when switching concepts', async () => {
    // PAC → toggle PACOnly BOOL → switch to IAC → PACOnly should be gone.
    vi.mocked(conceptApi.getConceptSchemas)
      .mockResolvedValueOnce(treePACWithSchemas)
      .mockResolvedValueOnce(treeIACWithSchemas);

    render(<FormPanel session={null} flags={defaultFlags} />);
    await searchAndWait('authentic');

    // Select PAC and set the BOOL field.
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();
    fireEvent.click(screen.getByTestId('bool-yes-PACOnly'));

    // Switch to IAC — IAC has no PACOnly schema.
    fireEvent.click(screen.getByTestId('concept-card-ImperfectAuthenticCadence'));
    await flushAfterClick();

    // The PACOnly BOOL toggle must not appear in the IAC property form.
    expect(screen.queryByTestId('bool-yes-PACOnly')).not.toBeInTheDocument();
  });

  it('clears property values when the concept is deselected', async () => {
    vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue(treePACWithSchemas);
    const session = makeSession();

    render(<FormPanel session={session} flags={defaultFlags} />);
    await searchAndWait('perfect');

    // Select PAC and fill a field.
    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    await flushAfterClick();
    fireEvent.click(screen.getByTestId('radio-SopranoScale-SD1'));

    // Clear the concept via the ✕ button.
    fireEvent.click(screen.getByLabelText('Clear selection'));
    await waitFor(() => {
      expect(session.setPropertiesComplete).toHaveBeenCalledWith(false);
    }, WAIT_OPTS);

    // The property form must not be visible after clearing.
    expect(screen.queryByTestId('property-form')).not.toBeInTheDocument();
  });
});
