import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../services/api';
import {
  fetchComposers,
  fetchCorpora,
  fetchMovements,
  fetchWorks,
} from '../services/browseApi';
import type {
  ComposerResponse,
  CorpusResponse,
  MovementResponse,
  WorkResponse,
} from '../types/browse';

export interface UseBrowseSelectionReturn {
  composerSlug: string | null;
  corpusSlug: string | null;
  workId: string | null;
  movementId: string | null;

  composers: ComposerResponse[];
  composersLoading: boolean;
  composersError: ApiError | null;
  retryComposers: () => void;

  corpora: CorpusResponse[];
  corporaLoading: boolean;
  corporaError: ApiError | null;
  retryCorpora: () => void;

  works: WorkResponse[];
  worksLoading: boolean;
  worksError: ApiError | null;
  retryWorks: () => void;

  movements: MovementResponse[];
  movementsLoading: boolean;
  movementsError: ApiError | null;
  retryMovements: () => void;

  selectedMovement: MovementResponse | null;

  select: (key: 'composer' | 'corpus' | 'work' | 'movement', value: string) => void;
}

/**
 * Owns the four-level Composer → Corpus → Work → Movement selection state:
 * URL-param synchronisation, fetch effects (with stale-fetch cancellation and
 * retry), and the derived `selectedMovement`. Both the desktop grid and the
 * mobile accordion in CorpusBrowser consume this hook's return value directly.
 */
export function useBrowseSelection(): UseBrowseSelectionReturn {
  const [searchParams, setSearchParams] = useSearchParams();

  const composerSlug = searchParams.get('composer');
  const corpusSlug = searchParams.get('corpus');
  const workId = searchParams.get('work');
  const movementId = searchParams.get('movement');

  const [composers, setComposers] = useState<ComposerResponse[]>([]);
  const [composersLoading, setComposersLoading] = useState(true);
  const [composersError, setComposersError] = useState<ApiError | null>(null);
  const [composersRetry, setComposersRetry] = useState(0);

  const [corpora, setCorpora] = useState<CorpusResponse[]>([]);
  const [corporaLoading, setCorporaLoading] = useState(false);
  const [corporaError, setCorporaError] = useState<ApiError | null>(null);
  const [corporaRetry, setCorporaRetry] = useState(0);

  const [works, setWorks] = useState<WorkResponse[]>([]);
  const [worksLoading, setWorksLoading] = useState(false);
  const [worksError, setWorksError] = useState<ApiError | null>(null);
  const [worksRetry, setWorksRetry] = useState(0);

  const [movements, setMovements] = useState<MovementResponse[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);
  const [movementsError, setMovementsError] = useState<ApiError | null>(null);
  const [movementsRetry, setMovementsRetry] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setComposersLoading(true);
    setComposersError(null);
    fetchComposers()
      .then((data) => { if (!cancelled) setComposers(data); })
      .catch((err) => {
        if (!cancelled) {
          setComposersError(err instanceof ApiError ? err : new ApiError('UNKNOWN', String(err)));
        }
      })
      .finally(() => { if (!cancelled) setComposersLoading(false); });
    return () => { cancelled = true; };
  }, [composersRetry]);

  useEffect(() => {
    if (!composerSlug) {
      setCorpora([]);
      setCorporaError(null);
      return;
    }
    let cancelled = false;
    setCorporaLoading(true);
    setCorporaError(null);
    setCorpora([]);
    fetchCorpora(composerSlug)
      .then((data) => { if (!cancelled) setCorpora(data); })
      .catch((err) => {
        if (!cancelled) {
          setCorporaError(err instanceof ApiError ? err : new ApiError('UNKNOWN', String(err)));
        }
      })
      .finally(() => { if (!cancelled) setCorporaLoading(false); });
    return () => { cancelled = true; };
  }, [composerSlug, corporaRetry]);

  useEffect(() => {
    if (!composerSlug || !corpusSlug) {
      setWorks([]);
      setWorksError(null);
      return;
    }
    let cancelled = false;
    setWorksLoading(true);
    setWorksError(null);
    setWorks([]);
    fetchWorks(composerSlug, corpusSlug)
      .then((data) => { if (!cancelled) setWorks(data); })
      .catch((err) => {
        if (!cancelled) {
          setWorksError(err instanceof ApiError ? err : new ApiError('UNKNOWN', String(err)));
        }
      })
      .finally(() => { if (!cancelled) setWorksLoading(false); });
    return () => { cancelled = true; };
  }, [composerSlug, corpusSlug, worksRetry]);

  useEffect(() => {
    if (!workId) {
      setMovements([]);
      setMovementsError(null);
      return;
    }
    let cancelled = false;
    setMovementsLoading(true);
    setMovementsError(null);
    setMovements([]);
    fetchMovements(workId)
      .then((data) => { if (!cancelled) setMovements(data); })
      .catch((err) => {
        if (!cancelled) {
          setMovementsError(err instanceof ApiError ? err : new ApiError('UNKNOWN', String(err)));
        }
      })
      .finally(() => { if (!cancelled) setMovementsLoading(false); });
    return () => { cancelled = true; };
  }, [workId, movementsRetry]);

  function select(key: 'composer' | 'corpus' | 'work' | 'movement', value: string) {
    const next = new URLSearchParams(searchParams);
    next.set(key, value);
    if (key === 'composer') {
      next.delete('corpus');
      next.delete('work');
      next.delete('movement');
    }
    if (key === 'corpus') {
      next.delete('work');
      next.delete('movement');
    }
    if (key === 'work') {
      next.delete('movement');
    }
    setSearchParams(next, { replace: true });
  }

  const selectedMovement = movements.find((m) => m.id === movementId) ?? null;

  return {
    composerSlug,
    corpusSlug,
    workId,
    movementId,
    composers,
    composersLoading,
    composersError,
    retryComposers: () => setComposersRetry((n) => n + 1),
    corpora,
    corporaLoading,
    corporaError,
    retryCorpora: () => setCorporaRetry((n) => n + 1),
    works,
    worksLoading,
    worksError,
    retryWorks: () => setWorksRetry((n) => n + 1),
    movements,
    movementsLoading,
    movementsError,
    retryMovements: () => setMovementsRetry((n) => n + 1),
    selectedMovement,
    select,
  };
}
