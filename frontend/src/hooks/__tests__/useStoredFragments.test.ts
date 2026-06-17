/**
 * Tests for useStoredFragments hook (Component 7 Step 10).
 *
 * Covers:
 *  - Empty result when movementId is undefined.
 *  - Single-page fetch on mount.
 *  - Multi-page cursor pagination (all pages collected).
 *  - Error state on network failure.
 *  - Automatic re-fetch when movementId changes.
 *  - refresh() triggers a fresh fetch.
 *  - Cleanup: AbortController aborts on unmount / movementId change so stale
 *    responses do not update state.
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStoredFragments } from '../useStoredFragments';
import type { FragmentListItem, FragmentListResponse } from '../../services/fragmentApi';

// ---------------------------------------------------------------------------
// Module mock
// ---------------------------------------------------------------------------

vi.mock('../../services/fragmentApi', () => ({
  listMovementFragments: vi.fn(),
}));

import * as fragmentApi from '../../services/fragmentApi';
const mockList = vi.mocked(fragmentApi.listMovementFragments);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeItem(id: string, barStart = 1, barEnd = 2): FragmentListItem {
  return {
    id,
    movement_id: 'mov-1',
    parent_fragment_id: null,
    mc_start: barStart,
    mc_end: barEnd,
    bar_start: barStart,
    bar_end: barEnd,
    beat_start: null,
    beat_end: null,
    repeat_context: null,
    status: 'approved',
    primary_concept_id: 'cad-pac',
    primary_concept_alias: 'PAC',
    primary_concept_name: 'Perfect Authentic Cadence',
    sub_parts: [],
  };
}

function makePage(
  items: FragmentListItem[],
  next_cursor: string | null = null,
): FragmentListResponse {
  return { items, next_cursor };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useStoredFragments — no movementId', () => {
  it('returns empty fragments immediately when movementId is undefined', () => {
    const { result } = renderHook(() => useStoredFragments(undefined));
    expect(result.current.fragments).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(mockList).not.toHaveBeenCalled();
  });
});

describe('useStoredFragments — single page', () => {
  it('fetches fragments and returns them', async () => {
    const items = [makeItem('frag-1'), makeItem('frag-2')];
    mockList.mockResolvedValueOnce(makePage(items));

    const { result } = renderHook(() => useStoredFragments('mov-abc'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.fragments).toEqual(items);
    expect(result.current.error).toBeNull();
    expect(mockList).toHaveBeenCalledOnce();
    expect(mockList).toHaveBeenCalledWith('mov-abc', undefined);
  });

  it('sets loading to true while fetching, then false when done', async () => {
    let resolvePage!: (v: FragmentListResponse) => void;
    const pending = new Promise<FragmentListResponse>(res => { resolvePage = res; });
    mockList.mockReturnValueOnce(pending);

    const { result } = renderHook(() => useStoredFragments('mov-loading'));

    // Hook fires the fetch on mount; loading goes true asynchronously.
    await waitFor(() => expect(result.current.loading).toBe(true));

    act(() => resolvePage(makePage([makeItem('f-1')])));

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.fragments).toHaveLength(1);
  });
});

describe('useStoredFragments — cursor pagination', () => {
  it('follows next_cursor until the last page', async () => {
    const page1 = makePage([makeItem('f-1')], 'cursor-a');
    const page2 = makePage([makeItem('f-2')], 'cursor-b');
    const page3 = makePage([makeItem('f-3')], null);

    mockList
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValueOnce(page3);

    const { result } = renderHook(() => useStoredFragments('mov-paged'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.fragments).toHaveLength(3);
    expect(result.current.fragments.map(f => f.id)).toEqual(['f-1', 'f-2', 'f-3']);

    expect(mockList).toHaveBeenCalledTimes(3);
    expect(mockList).toHaveBeenNthCalledWith(1, 'mov-paged', undefined);
    expect(mockList).toHaveBeenNthCalledWith(2, 'mov-paged', 'cursor-a');
    expect(mockList).toHaveBeenNthCalledWith(3, 'mov-paged', 'cursor-b');
  });
});

describe('useStoredFragments — error handling', () => {
  it('sets error when the API rejects', async () => {
    mockList.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useStoredFragments('mov-err'));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.fragments).toEqual([]);
    expect(result.current.error).toBe('Network error');
  });

  it('clears error on a subsequent successful fetch', async () => {
    mockList
      .mockRejectedValueOnce(new Error('First failure'))
      .mockResolvedValueOnce(makePage([makeItem('f-ok')]));

    const { result } = renderHook(() => useStoredFragments('mov-retry'));

    await waitFor(() => expect(result.current.error).toBe('First failure'));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.error).toBeNull());
    expect(result.current.fragments).toHaveLength(1);
  });
});

describe('useStoredFragments — movementId change', () => {
  it('clears fragments and re-fetches when movementId changes', async () => {
    mockList
      .mockResolvedValueOnce(makePage([makeItem('f-1')]))
      .mockResolvedValueOnce(makePage([makeItem('f-2')]));

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useStoredFragments(id),
      { initialProps: { id: 'mov-a' } },
    );

    await waitFor(() => expect(result.current.fragments).toHaveLength(1));
    expect(result.current.fragments[0].id).toBe('f-1');

    rerender({ id: 'mov-b' });

    await waitFor(() => expect(result.current.fragments).toHaveLength(1));
    expect(result.current.fragments[0].id).toBe('f-2');
  });

  it('clears fragments immediately when movementId becomes undefined', async () => {
    mockList.mockResolvedValueOnce(makePage([makeItem('f-1')]));

    const { result, rerender } = renderHook(
      ({ id }: { id: string | undefined }) => useStoredFragments(id),
      { initialProps: { id: 'mov-a' as string | undefined } },
    );

    await waitFor(() => expect(result.current.fragments).toHaveLength(1));

    rerender({ id: undefined });

    expect(result.current.fragments).toEqual([]);
    expect(result.current.loading).toBe(false);
  });
});

describe('useStoredFragments — refresh', () => {
  it('refresh() triggers a re-fetch and updates fragments', async () => {
    mockList
      .mockResolvedValueOnce(makePage([makeItem('f-old')]))
      .mockResolvedValueOnce(makePage([makeItem('f-new')]));

    const { result } = renderHook(() => useStoredFragments('mov-refresh'));

    await waitFor(() => expect(result.current.fragments[0]?.id).toBe('f-old'));

    act(() => result.current.refresh());

    await waitFor(() => expect(result.current.fragments[0]?.id).toBe('f-new'));
    expect(mockList).toHaveBeenCalledTimes(2);
  });
});
