/**
 * ConceptExamples tests — Component 11 Step 6.
 *
 * Coverage:
 *  - Draws examples for the concept on mount (limit 3) and renders a preview
 *    card per fragment with its metadata; a card with no preview_url shows the
 *    "generating" placeholder.
 *  - Expand fetches the full fragment through the public client and mounts the
 *    renderer; only one card is open at a time; collapsing unmounts it and
 *    re-expanding does not refetch (lazy + cached).
 *  - Shuffle re-draws (a second call) and is hidden for a single-example pool.
 *  - Graceful states: empty pool shows the muted note and no shuffle; a load
 *    error shows the error message.
 *
 * FragmentNotation is stubbed — it owns the Verovio/MIDI machinery, exercised
 * by its host's tests (FragmentDetail); here it is a marker that reports the
 * fragment id it was handed, so the wiring (fetch → mount) is what's asserted.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../services/api';
import type { ConceptBrowseItem, FragmentDetailResponse } from '../../../services/fragmentApi';
import * as glossaryApi from '../../../services/glossaryApi';
import * as publicApi from '../../../services/publicApi';
import ConceptExamples from '../ConceptExamples';

vi.mock('../../../services/glossaryApi');
vi.mock('../../../services/publicApi');

vi.mock('../FragmentNotation', () => ({
  default: ({ fragment }: { fragment: FragmentDetailResponse }) => (
    <div data-testid="fragment-notation">{fragment.id}</div>
  ),
}));

function makeItem(overrides: Partial<ConceptBrowseItem> = {}): ConceptBrowseItem {
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
    data_licence: 'CC BY-SA 4.0',
    data_licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    harmony_sources: ['DCML'],
    preview_url: 'https://example.test/preview/frag-001.svg',
    created_by: 'user-1',
    updated_at: '2026-07-20T00:00:00Z',
    composer_name: 'Mozart',
    work_title: 'Piano Sonata',
    work_catalogue_number: 'K. 331',
    movement_number: 1,
    movement_title: null,
    ...overrides,
  };
}

function examplesResponse(items: ConceptBrowseItem[]) {
  return { examples: items, concept_id: 'PerfectAuthenticCadence', include_subtypes: true };
}

function makeFragment(id: string): FragmentDetailResponse {
  // Only the id is read by the stubbed renderer; the rest is a minimal shell.
  return { id } as unknown as FragmentDetailResponse;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ConceptExamples — draw and preview cards', () => {
  it('draws examples on mount for the concept (limit 3) and renders a card each', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(
      examplesResponse([
        makeItem({ id: 'frag-001' }),
        makeItem({ id: 'frag-002', bar_start: 8, bar_end: 12 }),
      ])
    );

    const { container } = render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: /open score/i })).toHaveLength(2)
    );
    expect(glossaryApi.getPublicConceptExamples).toHaveBeenCalledWith('PerfectAuthenticCadence', {
      limit: 3,
    });
    // Preview images render from preview_url (alt="" — presentational, so
    // queried directly rather than by the img role).
    const previews = container.querySelectorAll('img');
    expect(previews).toHaveLength(2);
    expect(previews[0]).toHaveAttribute('src', 'https://example.test/preview/frag-001.svg');
  });

  it('shows the generating placeholder when a card has no preview_url', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(
      examplesResponse([makeItem({ preview_url: null })])
    );

    const { container } = render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    await screen.findByText(/generating/i);
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('ConceptExamples — expand on demand', () => {
  it('fetches the full fragment and mounts the renderer on expand', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(
      examplesResponse([makeItem({ id: 'frag-001' })])
    );
    vi.mocked(publicApi.getPublicFragment).mockResolvedValue(makeFragment('frag-001'));

    render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    const toggle = await screen.findByRole('button', { name: /open score/i });
    fireEvent.click(toggle);

    expect(await screen.findByTestId('fragment-notation')).toHaveTextContent('frag-001');
    expect(publicApi.getPublicFragment).toHaveBeenCalledWith('frag-001');
  });

  it('keeps only one card open at a time', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(
      examplesResponse([makeItem({ id: 'frag-001' }), makeItem({ id: 'frag-002' })])
    );
    vi.mocked(publicApi.getPublicFragment).mockImplementation((id) =>
      Promise.resolve(makeFragment(id))
    );

    render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    const toggles = await screen.findAllByRole('button', { name: /open score/i });
    fireEvent.click(toggles[0]);
    expect(await screen.findByTestId('fragment-notation')).toHaveTextContent('frag-001');

    // Opening the second collapses the first.
    fireEvent.click(screen.getAllByRole('button', { name: /open score/i })[0]);
    await waitFor(() => {
      const mounted = screen.getAllByTestId('fragment-notation');
      expect(mounted).toHaveLength(1);
      expect(mounted[0]).toHaveTextContent('frag-002');
    });
  });

  it('does not refetch when collapsing and re-expanding the same card', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(
      examplesResponse([makeItem({ id: 'frag-001' })])
    );
    vi.mocked(publicApi.getPublicFragment).mockResolvedValue(makeFragment('frag-001'));

    render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    fireEvent.click(await screen.findByRole('button', { name: /open score/i }));
    await screen.findByTestId('fragment-notation');

    fireEvent.click(screen.getByRole('button', { name: /close score/i }));
    await waitFor(() => expect(screen.queryByTestId('fragment-notation')).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /open score/i }));
    await screen.findByTestId('fragment-notation');

    expect(publicApi.getPublicFragment).toHaveBeenCalledTimes(1);
  });

  it('shows an error in the card body when the fragment fails to load', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(
      examplesResponse([makeItem({ id: 'frag-001' })])
    );
    vi.mocked(publicApi.getPublicFragment).mockRejectedValue(
      new ApiError('NOT_FOUND', 'gone', 404)
    );

    render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    fireEvent.click(await screen.findByRole('button', { name: /open score/i }));
    expect(await screen.findByText(/example could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByTestId('fragment-notation')).not.toBeInTheDocument();
  });
});

describe('ConceptExamples — shuffle', () => {
  it('re-draws on shuffle', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(
      examplesResponse([makeItem({ id: 'frag-001' }), makeItem({ id: 'frag-002' })])
    );

    render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    const shuffle = await screen.findByRole('button', { name: /shuffle/i });
    expect(glossaryApi.getPublicConceptExamples).toHaveBeenCalledTimes(1);
    fireEvent.click(shuffle);
    await waitFor(() => expect(glossaryApi.getPublicConceptExamples).toHaveBeenCalledTimes(2));
  });

  it('hides the shuffle control for a single-example pool', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(
      examplesResponse([makeItem({ id: 'frag-001' })])
    );

    render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    await screen.findByRole('button', { name: /open score/i });
    expect(screen.queryByRole('button', { name: /shuffle/i })).not.toBeInTheDocument();
  });
});

describe('ConceptExamples — graceful states', () => {
  it('shows the muted note and no shuffle for an empty pool', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(examplesResponse([]));

    render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    expect(await screen.findByText(/no approved examples yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /shuffle/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /open score/i })).not.toBeInTheDocument();
  });

  it('shows an error message when the draw fails', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockRejectedValue(
      new ApiError('BOOM', 'nope', 500)
    );

    render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    expect(await screen.findByText(/examples could not be loaded/i)).toBeInTheDocument();
  });

  it('renders the section heading in every state', async () => {
    vi.mocked(glossaryApi.getPublicConceptExamples).mockResolvedValue(
      examplesResponse([makeItem()])
    );

    render(<ConceptExamples conceptId="PerfectAuthenticCadence" />);

    const heading = await screen.findByRole('heading', { name: /examples/i, level: 2 });
    expect(within(heading).getByText(/examples/i)).toBeDefined();
  });
});
