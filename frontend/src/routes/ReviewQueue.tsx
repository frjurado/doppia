import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import BrowseColumn from '../components/browse/BrowseColumn';
import BrowseItem from '../components/browse/BrowseItem';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { ApiError } from '../services/api';
import { ReviewQueueItem, ReviewQueueResponse, listReviewQueue } from '../services/fragmentApi';
import styles from './ReviewQueue.module.css';

/**
 * Reviewer work-queue page (Component 7, Step 13).
 *
 * Lists submitted fragments the authenticated user is eligible to review
 * (their own submissions are excluded by the server). Selecting a row
 * navigates to the movement score with that fragment's detail panel open.
 *
 * Ordered by submission time descending (most recently submitted first).
 * Supports cursor-based "Load more" pagination.
 */
export default function ReviewQueue() {
  const { t, i18n } = useTranslation(['review', 'common']);
  usePageTitle(t('review:pageTitle'));
  const navigate = useNavigate();

  const [items, setItems] = useState<ReviewQueueItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const loadPage = useCallback(async (cursor?: string) => {
    try {
      const res: ReviewQueueResponse = await listReviewQueue(cursor);
      if (cursor) {
        setItems((prev) => [...prev, ...res.items]);
      } else {
        setItems(res.items);
      }
      setNextCursor(res.next_cursor);
    } catch (err) {
      if (err instanceof ApiError) setError(err);
    }
  }, []);

  useEffect(() => {
    setIsLoading(true);
    loadPage().finally(() => setIsLoading(false));
  }, [loadPage]);

  function handleLoadMore() {
    if (!nextCursor || isLoadingMore) return;
    setIsLoadingMore(true);
    loadPage(nextCursor).finally(() => setIsLoadingMore(false));
  }

  function handleSelect(id: string) {
    setSelectedId(id);
    const item = items.find((f) => f.id === id);
    if (item) {
      navigate(`/scores/${item.movement_id}?fragmentId=${item.id}`);
    }
  }

  function formatBarRange(item: ReviewQueueItem): string {
    return t('review:barRange', { start: item.bar_start, end: item.bar_end });
  }

  function formatMovementLabel(item: ReviewQueueItem): string {
    const mvt = item.movement_title
      ? `${item.movement_number}. ${item.movement_title}`
      : t('common:movementNumber', { number: item.movement_number });
    const catalogue = item.work_catalogue_number ? ` (${item.work_catalogue_number})` : '';
    return `${item.work_title}${catalogue} — ${mvt}`;
  }

  function formatSubmittedAt(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / 86_400_000);
    if (diffDays === 0) return t('review:submittedToday');
    if (diffDays === 1) return t('review:submittedYesterday');
    if (diffDays < 7) return t('review:submittedDaysAgo', { count: diffDays });
    return date.toLocaleDateString(i18n.language, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  }

  return (
    <Surface layer="base" className={styles.page}>
      {/* Queue list */}
      <div className={styles.body}>
        <Surface layer="container-low" className={styles.listPanel}>
          <div className={styles.listHeader}>
            <Type variant="label-md" style={{ color: 'var(--color-on-surface-variant)' }}>
              {t('review:submittedFragments')}
            </Type>
            {!isLoading && !error && (
              <Type variant="label-sm" style={{ color: 'var(--color-on-surface-variant)' }}>
                {t('review:itemCount', {
                  count: items.length,
                  plus: nextCursor ? '+' : '',
                })}
              </Type>
            )}
          </div>

          <BrowseColumn
            items={items}
            selectedId={selectedId}
            onSelect={handleSelect}
            isLoading={isLoading}
            getKey={(item) => item.id}
            emptyLabel={t('review:empty')}
            error={error}
            onRetry={() => {
              setError(null);
              setIsLoading(true);
              loadPage().finally(() => setIsLoading(false));
            }}
            renderItem={(item, isSelected, onSelect) => (
              <BrowseItem id={item.id} isSelected={isSelected} onClick={onSelect}>
                <div className={styles.itemRow}>
                  {/* Concept alias badge + bar range */}
                  <div className={styles.itemPrimary}>
                    {item.primary_concept_alias && (
                      <span className={styles.aliasBadge}>
                        <Type variant="label-sm" as="span">
                          {item.primary_concept_alias}
                        </Type>
                      </span>
                    )}
                    <Type variant="body-sm" as="span">
                      {formatBarRange(item)}
                    </Type>
                  </div>

                  {/* Work / movement label */}
                  <Type
                    variant="label-sm"
                    as="span"
                    style={{ color: 'var(--color-on-surface-variant)', display: 'block' }}
                  >
                    {item.composer_name} — {formatMovementLabel(item)}
                  </Type>

                  {/* Submitted time */}
                  <Type
                    variant="label-sm"
                    as="span"
                    style={{
                      color: 'var(--color-on-surface-variant)',
                      display: 'block',
                      opacity: 0.7,
                    }}
                  >
                    {t('review:submittedPrefix', { when: formatSubmittedAt(item.submitted_at) })}
                  </Type>
                </div>
              </BrowseItem>
            )}
          />

          {/* Load more */}
          {nextCursor && !isLoading && (
            <div className={styles.loadMore}>
              <button
                type="button"
                className={styles.loadMoreButton}
                onClick={handleLoadMore}
                disabled={isLoadingMore}
              >
                <Type variant="label-sm" as="span">
                  {isLoadingMore ? t('common:loading') : t('common:loadMore')}
                </Type>
              </button>
            </div>
          )}
        </Surface>
      </div>
    </Surface>
  );
}
