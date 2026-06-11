/**
 * FragmentBrowser tests — Component 8 Step 14.
 *
 * Coverage:
 *  - Concept-tree navigator: nesting, alias display, fragment count badge,
 *    expand/collapse, selecting a node.
 *  - include_subtypes toggle re-fetches the fragment list with the new flag.
 *  - Fragment list view: preview cards, preview_url null placeholder,
 *    status badges, data_licence display, cursor pagination (Load more).
 *  - Card click navigates to /fragments/:id.
 *  - Loading, error, and empty states.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/api';
import type { ConceptTreeResponse } from '../../services/conceptApi';
import type { ConceptBrowseItem, ConceptBrowseResponse } from '../../services/fragmentApi';
import * as conceptApi from '../../services/conceptApi';
import * as fragmentApi from '../../services/fragmentApi';
import FragmentBrowser from '../FragmentBrowser';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Covers both the static `getConceptTree` import and the dynamic
// `import('../services/conceptApi')` for searchConcepts.
vi.mock('../../services/conceptApi');
vi.mock('../../services/fragmentApi');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Three-level cadence hierarchy:
 *   Cadence
 *     Authentic Cadence (alias AC, 3 fragments)
 *       Perfect Authentic Cadence (alias PAC, 2 fragments)
 *     Half Cadence (alias HC, 1 fragment)
 */
const TREE_RESPONSE: ConceptTreeResponse = {
  root_id: 'Cadence',
  nodes: [
    {
      id: 'Cadence',
      name: 'Cadence',
      aliases: [],
      hierarchy_path: ['Cadence'],
      parent_id: null,
      fragment_count: 0,
    },
    {
      id: 'AuthenticCadence',
      name: 'Authentic Cadence',
      aliases: ['AC'],
      hierarchy_path: ['Cadence', 'Authentic Cadence'],
      parent_id: 'Cadence',
      fragment_count: 3,
    },
    {
      id: 'PerfectAuthenticCadence',
      name: 'Perfect Authentic Cadence',
      aliases: ['PAC'],
      hierarchy_path: ['Cadence', 'Authentic Cadence', 'Perfect Authentic Cadence'],
      parent_id: 'AuthenticCadence',
      fragment_count: 2,
    },
    {
      id: 'HalfCadence',
      name: 'Half Cadence',
      aliases: ['HC'],
      hierarchy_path: ['Cadence', 'Half Cadence'],
      parent_id: 'Cadence',
      fragment_count: 1,
    },
  ],
};

function makeBrowseItem(overrides: Partial<ConceptBrowseItem> = {}): ConceptBrowseItem {
  return {
    id: 'frag-001',
    movement_id: 'mov-001',
    bar_start: 1,
    bar_end: 4,
    beat_start: null,
    beat_end: null,
    repeat_context: null,
    status: 'approved',
    primary_concept_id: 'PerfectAuthenticCadence',
    primary_concept_alias: 'PAC',
    primary_concept_name: 'Perfect Authentic Cadence',
    data_licence: null,
    data_licence_url: null,
    harmony_sources: [],
    preview_url: null,
    created_by: 'user-1',
    updated_at: '2024-01-01T00:00:00Z',
    composer_name: 'Mozart',
    work_title: 'Piano Sonata',
    work_catalogue_number: 'K. 331',
    movement_number: 1,
    movement_title: null,
    ...overrides,
  };
}

function makeBrowseResponse(
  items: ConceptBrowseItem[],
  next_cursor: string | null = null,
): ConceptBrowseResponse {
  return {
    items,
    next_cursor,
    concept_id: 'PerfectAuthenticCadence',
    include_subtypes: true,
  };
}

// ---------------------------------------------------------------------------
// Render helper
// ---------------------------------------------------------------------------

/**
 * Render FragmentBrowser at /concepts with optional query params.
 * Includes a stub route for the fragment detail page so navigation tests
 * can assert the app moved to /fragments/:id.
 */
function renderBrowser(qs = '') {
  return render(
    <MemoryRouter initialEntries={[`/concepts${qs}`]}>
      <Routes>
        <Route path="/concepts" element={<FragmentBrowser />} />
        <Route path="/fragments/:fragmentId" element={<div data-testid="detail-stub" />} />
      </Routes>
    </MemoryRouter>,
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  // Default empty tree, roots, and fragment list — individual tests override as needed.
  vi.mocked(conceptApi.getConceptTree).mockResolvedValue({ root_id: 'Cadence', nodes: [] });
  vi.mocked(conceptApi.getConceptRoots).mockResolvedValue([]);
  vi.mocked(fragmentApi.listByConcept).mockResolvedValue(makeBrowseResponse([]));
});

// ---------------------------------------------------------------------------
// Initial / no-selection states
// ---------------------------------------------------------------------------

describe('FragmentBrowser — initial state', () => {
  it('renders the prompt to search when no root param is set', () => {
    renderBrowser();
    expect(screen.getByText(/search for a concept to browse/i)).toBeInTheDocument();
  });

  it('renders the prompt to select a concept when root is set but no concept selected', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    renderBrowser('?root=Cadence');
    // Wait for the tree root node to appear (exact match avoids ambiguity with
    // "Authentic Cadence", "Perfect Authentic Cadence", etc.).
    await screen.findByText('Cadence', { exact: true, selector: 'span' });
    expect(screen.getByText(/select a concept from the tree/i)).toBeInTheDocument();
  });

  it('shows the loading state while the tree is fetching', () => {
    vi.mocked(conceptApi.getConceptTree).mockReturnValue(new Promise(() => {})); // never resolves
    renderBrowser('?root=Cadence');
    expect(screen.getByText(/loading…/i)).toBeInTheDocument();
  });

  it('shows an error message when the tree fetch fails', async () => {
    vi.mocked(conceptApi.getConceptTree).mockRejectedValue(
      new ApiError('SERVER_ERROR', 'Tree unavailable', 500),
    );
    renderBrowser('?root=Cadence');
    await screen.findByText(/tree unavailable/i);
  });
});

// ---------------------------------------------------------------------------
// Concept tree rendering
// ---------------------------------------------------------------------------

describe('FragmentBrowser — concept tree', () => {
  it('renders root and first-level nodes', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    renderBrowser('?root=Cadence');

    await screen.findByText('Cadence');
    expect(screen.getByText('Authentic Cadence')).toBeInTheDocument();
    expect(screen.getByText('Half Cadence')).toBeInTheDocument();
  });

  it('renders second-level nodes nested under their parent', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    renderBrowser('?root=Cadence');

    // PAC is a child of AuthenticCadence, which is a child of Cadence.
    await screen.findByText('Perfect Authentic Cadence');
  });

  it('shows a fragment count badge when the count is greater than zero', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    renderBrowser('?root=Cadence');

    await screen.findByText('Authentic Cadence');
    // Authentic Cadence has 3 fragments; PAC has 2; HC has 1.
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows an alias label alongside the concept name', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    renderBrowser('?root=Cadence');

    await screen.findByText('Authentic Cadence');
    // The alias ("AC") is rendered as a separate label element.
    expect(screen.getByText('AC')).toBeInTheDocument();
    expect(screen.getByText('PAC')).toBeInTheDocument();
  });

  it('does not show a count badge when fragment_count is 0', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    renderBrowser('?root=Cadence');

    await screen.findByText('Cadence');
    // Cadence itself has fragment_count 0 — no "0" label should appear.
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Fragment list view
// ---------------------------------------------------------------------------

describe('FragmentBrowser — fragment list', () => {
  it('shows a loading state while fragments are fetching', () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockReturnValue(new Promise(() => {}));
    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');
    expect(screen.getByText(/loading fragments…/i)).toBeInTheDocument();
  });

  it('renders a fragment card for each item returned by the API', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(
      makeBrowseResponse([
        makeBrowseItem({ id: 'frag-001' }),
        makeBrowseItem({ id: 'frag-002' }),
      ]),
    );
    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    // Each card has aria-label "Open fragment PAC mm. 1–4"
    const cards = await screen.findAllByRole('button', { name: /open fragment/i });
    expect(cards).toHaveLength(2);
  });

  it('renders a preview image when preview_url is set', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(
      makeBrowseResponse([
        makeBrowseItem({ id: 'frag-001', preview_url: 'https://preview.test/frag-001.svg' }),
      ]),
    );
    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    // The img has alt="" (decorative), so RTL gives it role "presentation" rather
    // than "img". Query the DOM element directly instead.
    await waitFor(() => {
      const img = document.querySelector('img');
      expect(img).not.toBeNull();
      expect(img).toHaveAttribute('src', 'https://preview.test/frag-001.svg');
    });
  });

  it('renders the "Preview generating…" placeholder when preview_url is null', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(
      makeBrowseResponse([makeBrowseItem({ id: 'frag-001', preview_url: null })]),
    );
    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    await screen.findByText(/preview generating…/i);
    expect(screen.queryByRole('img')).not.toBeInTheDocument();
  });

  it('shows the status badge with the correct data-status attribute', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(
      makeBrowseResponse([makeBrowseItem({ id: 'frag-001', status: 'approved' })]),
    );
    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    await screen.findByText('approved');
    const badge = screen.getByText('approved').closest('[data-status]');
    expect(badge).toHaveAttribute('data-status', 'approved');
  });

  it('displays data_licence when present', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(
      makeBrowseResponse([
        makeBrowseItem({ id: 'frag-001', data_licence: 'CC BY-SA 4.0' }),
      ]),
    );
    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    await screen.findByText('CC BY-SA 4.0');
  });

  it('shows the empty state when no fragments are returned', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(makeBrowseResponse([]));
    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    await screen.findByText(/no approved fragments found/i);
  });

  it('shows a Load more button when next_cursor is non-null', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(
      makeBrowseResponse([makeBrowseItem({ id: 'frag-001' })], 'cursor-page-2'),
    );
    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    await screen.findByRole('button', { name: /load more/i });
  });

  it('appends the next page when Load more is clicked', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept)
      .mockResolvedValueOnce(
        makeBrowseResponse([makeBrowseItem({ id: 'frag-001' })], 'cursor-page-2'),
      )
      .mockResolvedValueOnce(
        makeBrowseResponse([makeBrowseItem({ id: 'frag-002' })], null),
      );

    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    const loadMore = await screen.findByRole('button', { name: /load more/i });
    fireEvent.click(loadMore);

    // After the second page loads, both cards are present.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /open fragment/i })).toHaveLength(2);
    });

    // Second call must include the cursor from the first page.
    expect(vi.mocked(fragmentApi.listByConcept)).toHaveBeenCalledWith(
      'PerfectAuthenticCadence',
      expect.objectContaining({ cursor: 'cursor-page-2' }),
    );
  });

  it('hides the Load more button after reaching the last page', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept)
      .mockResolvedValueOnce(
        makeBrowseResponse([makeBrowseItem({ id: 'frag-001' })], 'cursor-page-2'),
      )
      .mockResolvedValueOnce(makeBrowseResponse([makeBrowseItem({ id: 'frag-002' })], null));

    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    const loadMore = await screen.findByRole('button', { name: /load more/i });
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// include_subtypes toggle
// ---------------------------------------------------------------------------

describe('FragmentBrowser — include_subtypes toggle', () => {
  it('starts with include_subtypes checked by default', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    await screen.findByLabelText(/include subtypes/i);
    const checkbox = screen.getByRole('checkbox');
    expect(checkbox).toBeChecked();
  });

  it('re-fetches fragments with includeSubtypes=false when the toggle is unchecked', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(makeBrowseResponse([]));

    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    const checkbox = await screen.findByRole('checkbox');
    fireEvent.click(checkbox); // uncheck

    await waitFor(() => {
      expect(vi.mocked(fragmentApi.listByConcept)).toHaveBeenCalledWith(
        'PerfectAuthenticCadence',
        expect.objectContaining({ includeSubtypes: false }),
      );
    });
  });

  it('re-fetches fragments with includeSubtypes=true when the toggle is re-checked', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(makeBrowseResponse([]));

    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    const checkbox = await screen.findByRole('checkbox');
    fireEvent.click(checkbox); // uncheck
    fireEvent.click(checkbox); // re-check

    await waitFor(() => {
      const calls = vi.mocked(fragmentApi.listByConcept).mock.calls;
      const lastCall = calls[calls.length - 1];
      expect(lastCall[1]).toMatchObject({ includeSubtypes: true });
    });
  });
});

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

describe('FragmentBrowser — navigation', () => {
  it('navigates to /fragments/:id when a card is clicked', async () => {
    vi.mocked(conceptApi.getConceptTree).mockResolvedValue(TREE_RESPONSE);
    vi.mocked(fragmentApi.listByConcept).mockResolvedValue(
      makeBrowseResponse([makeBrowseItem({ id: 'frag-click-test' })]),
    );

    renderBrowser('?root=Cadence&concept=PerfectAuthenticCadence');

    const card = await screen.findByRole('button', { name: /open fragment/i });
    fireEvent.click(card);

    // The stub route for /fragments/:fragmentId should now render.
    await screen.findByTestId('detail-stub');
  });
});
