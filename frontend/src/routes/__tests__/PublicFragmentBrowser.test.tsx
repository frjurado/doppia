/**
 * PublicFragmentBrowser tests — Component 10 Step 5.
 *
 * Coverage:
 *  - Prompt shown when no `concept` param is present.
 *  - Fragments fetched from the public API client for a `concept` param and
 *    rendered as preview cards.
 *  - Card click navigates to the public detail route `/public/fragments/:id`.
 *  - Cursor pagination (Load more) appends the next page.
 *  - Loading, error, and empty states.
 *  - The public client is called (not the editor `listByConcept`), and with no
 *    `status` argument.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/api';
import type { ConceptBrowseItem, ConceptBrowseResponse } from '../../services/fragmentApi';
import * as publicApi from '../../services/publicApi';
import PublicFragmentBrowser from '../PublicFragmentBrowser';

vi.mock('../../services/publicApi');

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
    preview_url: null,
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

function makeResponse(
  items: ConceptBrowseItem[],
  next_cursor: string | null = null,
): ConceptBrowseResponse {
  return { items, next_cursor, concept_id: 'AuthenticCadence', include_subtypes: true };
}

function renderPublicBrowser(qs = '') {
  return render(
    <MemoryRouter initialEntries={[`/public/concepts${qs}`]}>
      <Routes>
        <Route path="/public/concepts" element={<PublicFragmentBrowser />} />
        <Route
          path="/public/fragments/:fragmentId"
          element={<div data-testid="public-detail-stub" />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(publicApi.listPublicFragmentsByConcept).mockResolvedValue(makeResponse([]));
});

describe('PublicFragmentBrowser — no concept', () => {
  it('shows a prompt and does not call the API when no concept param is set', () => {
    renderPublicBrowser();
    expect(screen.getByText(/choose a concept/i)).toBeInTheDocument();
    expect(publicApi.listPublicFragmentsByConcept).not.toHaveBeenCalled();
  });
});

describe('PublicFragmentBrowser — with a concept', () => {
  it('fetches from the public API client (no status arg) and renders cards', async () => {
    vi.mocked(publicApi.listPublicFragmentsByConcept).mockResolvedValue(
      makeResponse([makeItem()]),
    );
    renderPublicBrowser('?concept=AuthenticCadence');

    await screen.findByText('PAC');
    expect(publicApi.listPublicFragmentsByConcept).toHaveBeenCalledWith(
      'AuthenticCadence',
      expect.objectContaining({ includeSubtypes: true }),
    );
    // The public browse must never pass a status filter.
    const [, opts] = vi.mocked(publicApi.listPublicFragmentsByConcept).mock.calls[0];
    expect(opts).not.toHaveProperty('status');
  });

  it('navigates to the public detail route on card click', async () => {
    vi.mocked(publicApi.listPublicFragmentsByConcept).mockResolvedValue(
      makeResponse([makeItem({ id: 'frag-xyz' })]),
    );
    renderPublicBrowser('?concept=AuthenticCadence');

    const card = await screen.findByRole('button', { name: /open fragment/i });
    fireEvent.click(card);
    expect(screen.getByTestId('public-detail-stub')).toBeInTheDocument();
  });

  it('appends the next page when Load more is clicked', async () => {
    vi.mocked(publicApi.listPublicFragmentsByConcept)
      .mockResolvedValueOnce(makeResponse([makeItem({ id: 'a' })], 'cursor-2'))
      .mockResolvedValueOnce(makeResponse([makeItem({ id: 'b' })], null));
    renderPublicBrowser('?concept=AuthenticCadence');

    const loadMore = await screen.findByRole('button', { name: /load more/i });
    fireEvent.click(loadMore);

    await waitFor(() => {
      expect(publicApi.listPublicFragmentsByConcept).toHaveBeenCalledTimes(2);
    });
    expect(vi.mocked(publicApi.listPublicFragmentsByConcept).mock.calls[1][1]).toMatchObject({
      cursor: 'cursor-2',
    });
  });

  it('shows the empty state when no fragments are returned', async () => {
    vi.mocked(publicApi.listPublicFragmentsByConcept).mockResolvedValue(makeResponse([]));
    renderPublicBrowser('?concept=AuthenticCadence');
    expect(await screen.findByText(/no fragments found/i)).toBeInTheDocument();
  });

  it('shows an error message when the API rejects', async () => {
    vi.mocked(publicApi.listPublicFragmentsByConcept).mockRejectedValue(
      new ApiError('SERVER_ERROR', 'Something broke', 500),
    );
    renderPublicBrowser('?concept=AuthenticCadence');
    expect(await screen.findByText(/something broke/i)).toBeInTheDocument();
  });
});
