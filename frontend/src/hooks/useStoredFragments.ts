/**
 * useStoredFragments — fetches all stored fragments for a movement.
 *
 * Collects all cursor-paginated pages so the overlay always shows the complete
 * set of stored fragments for the current score. Re-fetches automatically when
 * movementId changes (i.e. on each score open).
 *
 * References: docs/roadmap/component-7-fragment-database.md §Step 10
 */

import { useCallback, useEffect, useState } from 'react';
import { listMovementFragments } from '../services/fragmentApi';
import type { FragmentListItem } from '../services/fragmentApi';

export interface UseStoredFragmentsResult {
  fragments: FragmentListItem[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useStoredFragments(
  movementId: string | undefined,
): UseStoredFragmentsResult {
  const [fragments, setFragments] = useState<FragmentListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async (id: string, signal: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const items: FragmentListItem[] = [];
      let cursor: string | undefined;
      do {
        if (signal.aborted) return;
        const page = await listMovementFragments(id, cursor);
        if (signal.aborted) return;
        items.push(...page.items);
        cursor = page.next_cursor ?? undefined;
      } while (cursor !== undefined);
      setFragments(items);
    } catch (err) {
      if (!signal.aborted) {
        setError(err instanceof Error ? err.message : 'Failed to load fragments');
      }
    } finally {
      if (!signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!movementId) {
      setFragments([]);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    fetchAll(movementId, controller.signal);
    return () => controller.abort();
  }, [movementId, fetchAll]);

  const refresh = useCallback(() => {
    if (!movementId) return;
    const controller = new AbortController();
    fetchAll(movementId, controller.signal);
  }, [movementId, fetchAll]);

  return { fragments, loading, error, refresh };
}
