/**
 * Tests for ConceptPicker — Component 5 Step 12.
 *
 * Covers: search triggering, debounce, domain facets, result display with
 * hierarchy path, selection/deselection, error and empty states.
 *
 * Timer strategy: real timers throughout. The component has a 300 ms debounce;
 * waitFor with a 2 000 ms timeout accommodates it without fake-timer management.
 * Using fake timers with async spy assertions causes intermittent timeouts when
 * waitFor's internal setTimeout polling is blocked by the fake-timer runtime.
 *
 * Verification target from the roadmap (Step 12):
 *   "Searching surfaces the right concept with its hierarchy path."
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ConceptPicker from '../ConceptPicker';
import * as conceptApi from '../../../services/conceptApi';
import type { ConceptSearchHit, ConceptSearchPage } from '../../../services/conceptApi';

vi.mock('../../../services/conceptApi');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const makePAC = (): ConceptSearchHit => ({
  id: 'PerfectAuthenticCadence',
  name: 'Perfect Authentic Cadence',
  aliases: ['PAC'],
  hierarchy_path: ['Cadence', 'Authentic Cadence'],
  definition: 'A cadence with root-position tonic and dominant chords.',
});

const makeIAC = (): ConceptSearchHit => ({
  id: 'ImperfectAuthenticCadence',
  name: 'Imperfect Authentic Cadence',
  aliases: ['IAC'],
  hierarchy_path: ['Cadence', 'Authentic Cadence'],
  definition: null,
});

function makePage(hits: ConceptSearchHit[]): ConceptSearchPage {
  return { items: hits, next_cursor: null };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setup(props: Partial<React.ComponentProps<typeof ConceptPicker>> = {}) {
  const onSelect = vi.fn();
  const result = render(
    <ConceptPicker
      selectedConceptId={props.selectedConceptId ?? null}
      onSelect={props.onSelect ?? onSelect}
    />
  );
  return { ...result, onSelect };
}

const WAIT_OPTS = { timeout: 2000 };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConceptPicker', () => {
  beforeEach(() => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([]));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the search input and domain facets', () => {
    setup();
    expect(screen.getByTestId('concept-search-input')).toBeInTheDocument();
    expect(screen.getByTestId('facet-cadences')).toBeInTheDocument();
  });

  it('does not call searchConcepts when the query is empty', async () => {
    setup();
    // Wait longer than the debounce to confirm no call is made.
    await new Promise((r) => setTimeout(r, 400));
    expect(conceptApi.searchConcepts).not.toHaveBeenCalled();
  });

  it('calls searchConcepts after the debounce delay', async () => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([makePAC()]));
    setup();
    const input = screen.getByTestId('concept-search-input');

    fireEvent.change(input, { target: { value: 'perfect' } });
    await waitFor(
      () => expect(conceptApi.searchConcepts).toHaveBeenCalledWith('perfect', null),
      WAIT_OPTS
    );
  });

  it('displays search results with the concept name and hierarchy path', async () => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([makePAC()]));
    setup();
    const input = screen.getByTestId('concept-search-input');

    fireEvent.change(input, { target: { value: 'perfect authentic' } });
    await waitFor(() => screen.getByTestId('concept-card-PerfectAuthenticCadence'), WAIT_OPTS);

    // Hierarchy path breadcrumbs should be visible.
    expect(screen.getByText(/Cadence › Authentic Cadence/)).toBeInTheDocument();
    // Alias snippet should be visible.
    expect(screen.getByText(/PAC/)).toBeInTheDocument();
  });

  it('calls onSelect with the concept when a result card is clicked', async () => {
    const pac = makePAC();
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([pac]));
    const { onSelect } = setup();
    const input = screen.getByTestId('concept-search-input');

    fireEvent.change(input, { target: { value: 'perfect' } });
    await waitFor(() => screen.getByTestId('concept-card-PerfectAuthenticCadence'), WAIT_OPTS);

    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    expect(onSelect).toHaveBeenCalledWith(pac);
  });

  it('deselects the concept when the selected card is clicked again', async () => {
    const pac = makePAC();
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([pac]));
    const { onSelect } = setup({ selectedConceptId: pac.id });
    const input = screen.getByTestId('concept-search-input');

    fireEvent.change(input, { target: { value: 'perfect' } });
    await waitFor(() => screen.getByTestId('concept-card-PerfectAuthenticCadence'), WAIT_OPTS);

    fireEvent.click(screen.getByTestId('concept-card-PerfectAuthenticCadence'));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('narrows results by domain when a domain facet is active', async () => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([makePAC()]));
    setup();
    const input = screen.getByTestId('concept-search-input');

    // Activate the cadences facet before typing.
    fireEvent.click(screen.getByTestId('facet-cadences'));
    fireEvent.change(input, { target: { value: 'cadence' } });

    await waitFor(
      () => expect(conceptApi.searchConcepts).toHaveBeenCalledWith('cadence', 'cadences'),
      WAIT_OPTS
    );
  });

  it('toggling a domain facet off reverts to no domain filter', async () => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([]));
    setup();
    const input = screen.getByTestId('concept-search-input');

    // Activate then deactivate the cadences facet.
    fireEvent.click(screen.getByTestId('facet-cadences'));
    fireEvent.click(screen.getByTestId('facet-cadences'));

    fireEvent.change(input, { target: { value: 'cadence' } });
    await waitFor(
      () => expect(conceptApi.searchConcepts).toHaveBeenCalledWith('cadence', null),
      WAIT_OPTS
    );
  });

  it('shows "No concepts found." when the query returns no hits', async () => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([]));
    setup();
    const input = screen.getByTestId('concept-search-input');

    fireEvent.change(input, { target: { value: 'xyzzy' } });
    await waitFor(() => screen.getByText(/No concepts found/i), WAIT_OPTS);
  });

  it('shows an error message when searchConcepts rejects', async () => {
    vi.mocked(conceptApi.searchConcepts).mockRejectedValue(new Error('NETWORK_ERROR'));
    setup();
    const input = screen.getByTestId('concept-search-input');

    fireEvent.change(input, { target: { value: 'cadence' } });
    await waitFor(() => screen.getByRole('alert'), WAIT_OPTS);
  });

  it('shows the selected concept as a persistent card when no search is active', async () => {
    // Edit-flow prefill: a concept is selected but nothing has been searched, so
    // it is not in `results`. The picker must still surface it so the box is not
    // read as empty (fragment editor repair — Component 10 Step 16).
    const pac = makePAC();
    render(<ConceptPicker selectedConceptId={pac.id} selectedConcept={pac} onSelect={vi.fn()} />);
    expect(screen.getByTestId('concept-card-PerfectAuthenticCadence')).toBeInTheDocument();
    // The "type to search" placeholder must not show while a concept is selected.
    expect(screen.queryByText(/type/i)).not.toBeInTheDocument();
  });

  it('does not duplicate the selected concept when it is also in the results', async () => {
    const pac = makePAC();
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([pac]));
    render(<ConceptPicker selectedConceptId={pac.id} selectedConcept={pac} onSelect={vi.fn()} />);
    const input = screen.getByTestId('concept-search-input');
    fireEvent.change(input, { target: { value: 'perfect' } });
    await waitFor(
      () => expect(screen.getAllByTestId('concept-card-PerfectAuthenticCadence')).toHaveLength(1),
      WAIT_OPTS
    );
  });

  it('renders multiple results, each with its hierarchy path', async () => {
    vi.mocked(conceptApi.searchConcepts).mockResolvedValue(makePage([makePAC(), makeIAC()]));
    setup();
    const input = screen.getByTestId('concept-search-input');

    fireEvent.change(input, { target: { value: 'authentic' } });
    await waitFor(() => {
      screen.getByTestId('concept-card-PerfectAuthenticCadence');
      screen.getByTestId('concept-card-ImperfectAuthenticCadence');
    }, WAIT_OPTS);

    // Both cards share the same hierarchy path — both occurrences should appear.
    const paths = screen.getAllByText(/Cadence › Authentic Cadence/);
    expect(paths).toHaveLength(2);
  });
});
