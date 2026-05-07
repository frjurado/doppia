import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BrowseAccordion from '../components/browse/BrowseAccordion';
import BrowseColumn from '../components/browse/BrowseColumn';
import BrowseItem from '../components/browse/BrowseItem';
import MovementCard from '../components/browse/MovementCard';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { useBrowseSelection } from '../hooks/useBrowseSelection';
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
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 767px)');
  usePageTitle('Browse — Doppia');

  const selection = useBrowseSelection();
  const {
    composerSlug,
    corpusSlug,
    workId,
    movementId,
    composers,
    composersLoading,
    composersError,
    retryComposers,
    corpora,
    corporaLoading,
    corporaError,
    retryCorpora,
    works,
    worksLoading,
    worksError,
    retryWorks,
    movements,
    movementsLoading,
    movementsError,
    retryMovements,
    selectedMovement,
    select,
  } = selection;

  return (
    <Surface layer="base" className={styles.page} data-has-footer={selectedMovement ? 'true' : 'false'}>
      {isMobile ? (
        <BrowseAccordion selection={selection} />
      ) : (
        <div className={styles.grid}>
          {/* Composers column */}
          <Surface layer="container-lowest" className={styles.columnPanel}>
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
              onRetry={retryComposers}
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
              onRetry={retryCorpora}
            />
          </Surface>

          {/* Works column */}
          <Surface layer="container-lowest" className={styles.columnPanel}>
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
              onRetry={retryWorks}
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
              onRetry={retryMovements}
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
              onClick={() => navigate(`/scores/${selectedMovement.id}`)}
            >
              <Type variant="label-md" as="span">Open for tagging</Type>
            </button>
          </div>
        </div>
      )}
    </Surface>
  );
}
