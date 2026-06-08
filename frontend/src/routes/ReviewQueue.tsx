import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import BrowseColumn from '../components/browse/BrowseColumn';
import BrowseItem from '../components/browse/BrowseItem';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { ApiError } from '../services/api';
import {
  ReviewQueueItem,
  ReviewQueueResponse,
  listReviewQueue,
} from '../services/fragmentApi';
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
  usePageTitle('Review Queue — Doppia');
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
    return `bars ${item.bar_start}–${item.bar_end}`;
  }

  function formatMovementLabel(item: ReviewQueueItem): string {
    const mvt = item.movement_title
      ? `${item.movement_number}. ${item.movement_title}`
      : `Movement ${item.movement_number}`;
    const catalogue = item.work_catalogue_number
      ? ` (${item.work_catalogue_number})`
      : '';
    return `${item.work_title}${catalogue} — ${mvt}`;
  }

  function formatSubmittedAt(iso: string): string {
    const date = new Date(iso);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffDays = Math.floor(diffMs / 86_400_000);
    if (diffDays === 0) return 'today';
    if (diffDays === 1) return 'yesterday';
    if (diffDays < 7) return `${diffDays} days ago`;
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  return (
    <Surface layer="base" className={styles.page}>
      {/* Page header with navigation back to corpus browser */}
      <Surface layer="container-lowest" className={styles.header}>
        <button
          type="button"
          className={styles.navLink}
          onClick={() => navigate('/')}
        >
          <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
            ← Browse
          </Type>
        </button>
        <Type variant="label-md" as="h1" className={styles.title}>
          Review Queue
        </Type>
      </Surface>

      {/* Queue list */}
      <div className={styles.body}>
        <Surface layer="container-low" className={styles.listPanel}>
          <div className={styles.listHeader}>
            <Type variant="label-md" style={{ color: 'var(--color-on-surface-variant)' }}>
              Submitted fragments
            </Type>
            {!isLoading && !error && (
              <Type variant="label-sm" style={{ color: 'var(--color-on-surface-variant)' }}>
                {items.length}{nextCursor ? '+' : ''} item{items.length !== 1 ? 's' : ''}
              </Type>
            )}
          </div>

          <BrowseColumn
            items={items}
            selectedId={selectedId}
            onSelect={handleSelect}
            isLoading={isLoading}
            getKey={(item) => item.id}
            emptyLabel="No fragments awaiting your review"
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
                    style={{ color: 'var(--color-on-surface-variant)', display: 'block', opacity: 0.7 }}
                  >
                    Submitted {formatSubmittedAt(item.submitted_at)}
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
                <Type variant="label-md" as="span">
                  {isLoadingMore ? 'Loading…' : 'Load more'}
                </Type>
              </button>
            </div>
          )}
        </Surface>
      </div>
    </Surface>
  );
}
