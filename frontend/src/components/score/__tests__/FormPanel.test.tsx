/**
 * Tests for FormPanel — Component 5 Step 12.
 *
 * Verification targets from the roadmap (Step 12):
 *   "Selecting a concept with structurally-divergent children shows the
 *    refinement radio group."
 *   "Selecting one whose children differ only in properties does not."
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
