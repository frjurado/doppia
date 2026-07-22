import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FragmentCard } from './FragmentBrowser';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { ApiError } from '../services/api';
import type { ConceptBrowseItem } from '../services/fragmentApi';
import { listPublicFragmentsByConcept } from '../services/publicApi';
import styles from './PublicFragmentBrowser.module.css';

/**
 * Anonymous public browse-by-concept view — Component 10 Step 5.
 *
 * Deep-linked read-only surface: the concept id arrives in the URL
 * (`/public/concepts?concept=<id>`), which is how Component 11's glossary will
 * link in. It renders the exact Component 8 preview-card list (reusing
 * {@link FragmentCard}) against the public API client — approved fragments
 * only, no editor affordances.
 *
 * The concept-tree navigator from the editor browser is intentionally absent:
 * its concept-search / tree / roots endpoints are editor-only, and the public
 * entry point is the glossary (Component 11), not a tree the anonymous user
 * drives. Without a `concept` param this view shows a short prompt.
 */
export default function PublicFragmentBrowser() {
  const { t } = useTranslation(['public', 'common']);
  usePageTitle(t('public:browse.pageTitle'));
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  const conceptId = searchParams.get('concept');
  const includeSubtypes = searchParams.get('include_subtypes') !== 'false';

  const [fragments, setFragments] = useState<ConceptBrowseItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const loadFragments = useCallback(
    async (cursor?: string) => {
      if (!conceptId) return;
      const isFirstPage = cursor === undefined;
      if (isFirstPage) setLoading(true);
      setError(null);
      try {
        const res = await listPublicFragmentsByConcept(conceptId, {
          includeSubtypes,
          cursor,
        });
        setFragments((prev) => (isFirstPage ? res.items : [...prev, ...res.items]));
        setNextCursor(res.next_cursor);
      } catch (err) {
        if (err instanceof ApiError) setError(err);
      } finally {
        if (isFirstPage) setLoading(false);
      }
    },
    [conceptId, includeSubtypes]
  );

  useEffect(() => {
    setFragments([]);
    setNextCursor(null);
    if (conceptId) loadFragments();
  }, [conceptId, includeSubtypes]); // eslint-disable-line react-hooks/exhaustive-deps

  const openFragment = useCallback(
    (id: string) => {
      navigate(`/public/fragments/${id}`);
    },
    [navigate]
  );

  return (
    <Surface layer="base" className={styles.page}>
      <div className={styles.inner}>
        {!conceptId ? (
          <div className={styles.empty}>
            <Type variant="body-lg" as="p" style={{ color: 'var(--color-on-surface-variant)' }}>
              {t('public:browse.selectConcept')}
            </Type>
          </div>
        ) : (
          <>
            <Type variant="title" as="h1" className={styles.heading}>
              {t('public:browse.heading', { concept: conceptId })}
            </Type>

            {loading && (
              <div className={styles.empty}>
                <Type
                  variant="label-sm"
                  as="span"
                  style={{ color: 'var(--color-on-surface-variant)' }}
                >
                  {t('public:browse.loading')}
                </Type>
              </div>
            )}

            {error && (
              <div className={styles.empty}>
                <Type variant="label-sm" as="span" style={{ color: 'var(--color-error)' }}>
                  {error.message}
                </Type>
              </div>
            )}

            {!loading && !error && fragments.length === 0 && (
              <div className={styles.empty}>
                <Type
                  variant="label-sm"
                  as="span"
                  style={{ color: 'var(--color-on-surface-variant)' }}
                >
                  {t('public:browse.noFragments')}
                </Type>
              </div>
            )}

            <div className={styles.list}>
              {fragments.map((item) => (
                <FragmentCard key={item.id} item={item} onOpen={openFragment} />
              ))}
            </div>

            {nextCursor && !loading && (
              <div className={styles.loadMore}>
                <button
                  type="button"
                  className={styles.loadMoreButton}
                  onClick={() => loadFragments(nextCursor)}
                >
                  <Type variant="label-sm" as="span">
                    {t('public:browse.loadMore')}
                  </Type>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </Surface>
  );
}
