import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import BrowseAccordion from '../components/browse/BrowseAccordion';
import BrowseColumn from '../components/browse/BrowseColumn';
import BrowseItem from '../components/browse/BrowseItem';
import MovementCard from '../components/browse/MovementCard';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
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

  const composerSlug = searchParams.get('composer');
  const corpusSlug = searchParams.get('corpus');
  const workId = searchParams.get('work');
  const movementId = searchParams.get('movement');

  const [composers, setComposers] = useState<ComposerResponse[]>([]);
  const [composersLoading, setComposersLoading] = useState(true);

  const [corpora, setCorpora] = useState<CorpusResponse[]>([]);
  const [corporaLoading, setCorporaLoading] = useState(false);

  const [works, setWorks] = useState<WorkResponse[]>([]);
  const [worksLoading, setWorksLoading] = useState(false);

  const [movements, setMovements] = useState<MovementResponse[]>([]);
  const [movementsLoading, setMovementsLoading] = useState(false);

  // Fetch composers on mount.
  useEffect(() => {
    setComposersLoading(true);
    fetchComposers()
      .then(setComposers)
      .finally(() => setComposersLoading(false));
  }, []);

  // Fetch corpora when composer selection changes.
  useEffect(() => {
    if (!composerSlug) {
      setCorpora([]);
      return;
    }
    setCorporaLoading(true);
    setCorpora([]);
    fetchCorpora(composerSlug)
      .then(setCorpora)
      .finally(() => setCorporaLoading(false));
  }, [composerSlug]);

  // Fetch works when corpus selection changes.
  useEffect(() => {
    if (!composerSlug || !corpusSlug) {
      setWorks([]);
      return;
    }
    setWorksLoading(true);
    setWorks([]);
    fetchWorks(composerSlug, corpusSlug)
      .then(setWorks)
      .finally(() => setWorksLoading(false));
  }, [composerSlug, corpusSlug]);

  // Fetch movements when work selection changes.
  useEffect(() => {
    if (!workId) {
      setMovements([]);
      return;
    }
    setMovementsLoading(true);
    setMovements([]);
    fetchMovements(workId)
      .then(setMovements)
      .finally(() => setMovementsLoading(false));
  }, [workId]);

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
    <Surface layer="base" className={styles.page}>
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
