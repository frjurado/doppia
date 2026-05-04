import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import BrowseAccordion from '../components/browse/BrowseAccordion';
import BrowseColumn from '../components/browse/BrowseColumn';
import BrowseItem from '../components/browse/BrowseItem';
import MovementCard from '../components/browse/MovementCard';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
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
import styles from './CorpusBrowser.module.css';

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [query]);
  return matches;
}

/**
 * Main corpus browsing page.
 *
 * Renders a four-level Composer → Corpus → Work → Movement selector.
 * Selection state is synchronised to URL search params so that refreshing
 * or sharing a link restores the selection.
 *
 * Desktop: four-column CSS grid.
 * Mobile (< 768px): stacked accordion.
 */
export default function CorpusBrowser() {
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 767px)');
  usePageTitle('Browse — Doppia');

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

  // Fetch composers on mount (or on retry).
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

  // Fetch corpora when composer selection changes (or on retry).
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

  // Fetch works when corpus selection changes (or on retry).
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

  // Fetch movements when work selection changes (or on retry).
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

  return (
    <Surface layer="base" className={styles.page} data-has-footer={selectedMovement ? 'true' : 'false'}>
      {isMobile ? (
        <BrowseAccordion
          composers={composers}
          selectedComposerSlug={composerSlug}
          onSelectComposer={(slug) => select('composer', slug)}
          composersLoading={composersLoading}
          corpora={corpora}
          selectedCorpusSlug={corpusSlug}
          onSelectCorpus={(slug) => select('corpus', slug)}
          corporaLoading={corporaLoading}
          works={works}
          selectedWorkId={workId}
          onSelectWork={(id) => select('work', id)}
          worksLoading={worksLoading}
          movements={movements}
          selectedMovementId={movementId}
          onSelectMovement={(id) => select('movement', id)}
          movementsLoading={movementsLoading}
        />
      ) : (
        <div className={styles.grid}>
          {/* Composers column */}
          <Surface layer="container-low" className={styles.columnPanel}>
            <div className={styles.columnHeader}>
              <Type variant="label-md" style={{ color: 'var(--color-on-surface-variant)' }}>
                Composer
              </Type>
            </div>
            <BrowseColumn
              items={composers}
              selectedId={composerSlug}
              onSelect={(slug) => select('composer', slug)}
              isLoading={composersLoading}
              getKey={(c) => c.slug}
              renderItem={(c, isSelected, onSelect) => (
                <BrowseItem id={c.slug} isSelected={isSelected} onClick={onSelect}>
                  <Type variant="body-lg" as="span">
                    {c.name}
                  </Type>
                  <Type
                    variant="label-sm"
                    as="span"
                    style={{ color: 'var(--color-on-surface-variant)', display: 'block' }}
                  >
                    {c.sort_name}
                  </Type>
                </BrowseItem>
              )}
              error={composersError}
              onRetry={() => setComposersRetry((n) => n + 1)}
            />
          </Surface>

          {/* Corpora column */}
          <Surface layer="container-low" className={styles.columnPanel}>
            <div className={styles.columnHeader}>
              <Type variant="label-md" style={{ color: 'var(--color-on-surface-variant)' }}>
                Corpus
              </Type>
            </div>
            <BrowseColumn
              items={corpora}
              selectedId={corpusSlug}
              onSelect={(slug) => select('corpus', slug)}
              isLoading={corporaLoading && composerSlug !== null}
              getKey={(c) => c.slug}
              renderItem={(c, isSelected, onSelect) => (
                <BrowseItem id={c.slug} isSelected={isSelected} onClick={onSelect}>
                  <Type variant="body-lg" as="span">
                    {c.title}
                  </Type>
                  <Type
                    variant="label-sm"
                    as="span"
                    style={{ color: 'var(--color-on-surface-variant)', display: 'block' }}
                  >
                    {c.work_count} {c.work_count === 1 ? 'work' : 'works'}
                  </Type>
                </BrowseItem>
              )}
              emptyLabel={composerSlug ? 'No corpora found' : 'Select a composer'}
              error={corporaError}
              onRetry={() => setCorporaRetry((n) => n + 1)}
            />
          </Surface>

          {/* Works column */}
          <Surface layer="container-low" className={styles.columnPanel}>
            <div className={styles.columnHeader}>
              <Type variant="label-md" style={{ color: 'var(--color-on-surface-variant)' }}>
                Work
              </Type>
            </div>
            <BrowseColumn
              items={works}
              selectedId={workId}
              onSelect={(id) => select('work', id)}
              isLoading={worksLoading && corpusSlug !== null}
              getKey={(w) => w.id}
              renderItem={(w, isSelected, onSelect) => (
                <BrowseItem id={w.id} isSelected={isSelected} onClick={onSelect}>
                  <Type variant="body-lg" as="span">
                    {w.title}
                  </Type>
                  {w.catalogue_number && (
                    <Type
                      variant="label-sm"
                      as="span"
                      style={{ color: 'var(--color-on-surface-variant)', display: 'block' }}
                    >
                      {w.catalogue_number}
                    </Type>
                  )}
                </BrowseItem>
              )}
              emptyLabel={corpusSlug ? 'No works found' : 'Select a corpus'}
              error={worksError}
              onRetry={() => setWorksRetry((n) => n + 1)}
            />
          </Surface>

          {/* Movements column */}
          <Surface layer="container-low" className={styles.columnPanel}>
            <div className={styles.columnHeader}>
              <Type variant="label-md" style={{ color: 'var(--color-on-surface-variant)' }}>
                Movement
              </Type>
            </div>
            <BrowseColumn
              items={movements}
              selectedId={movementId}
              onSelect={(id) => select('movement', id)}
              isLoading={movementsLoading && workId !== null}
              getKey={(m) => m.id}
              renderItem={(m, isSelected, onSelect) => (
                <MovementCard movement={m} isSelected={isSelected} onClick={onSelect} />
              )}
              emptyLabel={workId ? 'No movements found' : 'Select a work'}
              error={movementsError}
              onRetry={() => setMovementsRetry((n) => n + 1)}
            />
          </Surface>
        </div>
      )}

      {/* "Open score" footer — visible when a movement is selected */}
      {selectedMovement && (
        <div className={styles.footer}>
          <div className={styles.footerContent}>
            <div className={styles.footerMeta}>
              <Type variant="label-md" as="span">
                {selectedMovement.title ?? `Movement ${selectedMovement.movement_number}`}
              </Type>
              {(selectedMovement.key_signature || selectedMovement.meter) && (
                <Type
                  variant="label-sm"
                  as="span"
                  style={{ color: 'var(--color-on-surface-variant)' }}
                >
                  {[selectedMovement.key_signature, selectedMovement.meter]
                    .filter(Boolean)
                    .join(' · ')}
                </Type>
              )}
            </div>
            <button
              type="button"
              className={styles.ctaButton}
              onClick={() => navigate(`/tag/${selectedMovement.id}`)}
            >
              Open for tagging
            </button>
          </div>
        </div>
      )}
    </Surface>
  );
}
