import React from 'react';
import { ApiError } from '../../services/api';
import Type from '../ui/Type';
import BrowseItem from './BrowseItem';
import styles from './BrowseColumn.module.css';

interface BrowseColumnProps<T> {
  items: T[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  isLoading: boolean;
  getKey: (item: T) => string;
  renderItem: (item: T, isSelected: boolean, onSelect: (id: string) => void) => React.ReactNode;
  emptyLabel?: string;
  error?: ApiError | null;
  onRetry?: () => void;
}

const SKELETON_COUNT = 3;

/**
 * A scrollable list column for one level of the Composer → Corpus → Work → Movement
 * hierarchy. Renders a loading skeleton, an empty state, or the item list.
 *
 * renderItem receives the item, its selected state, and the onSelect callback.
 * This allows callers to wrap items in BrowseItem or MovementCard as appropriate.
 */
export default function BrowseColumn<T>({
  items,
  selectedId,
  onSelect,
  isLoading,
  getKey,
  renderItem,
  emptyLabel = 'Nothing here',
  error,
  onRetry,
}: BrowseColumnProps<T>) {
  if (error) {
    return (
      <div className={styles.column}>
        <div className={styles.errorState}>
          <Type variant="label-md" style={{ color: 'var(--color-on-surface-variant)' }}>
            {error.message}
          </Type>
          {onRetry && (
            <button type="button" onClick={onRetry} className={styles.retryButton}>
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.column}>
        {Array.from({ length: SKELETON_COUNT }).map((_, i) => (
          <BrowseItem
            key={i}
            id={`skeleton-${i}`}
            isSelected={false}
            onClick={() => {}}
            disabled
          >
            <div className={styles.skeletonLine} style={{ opacity: 0.4 - i * 0.1 }} />
            <div
              className={styles.skeletonLineSm}
              style={{ opacity: 0.3 - i * 0.07 }}
            />
          </BrowseItem>
        ))}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className={styles.column}>
        <div className={styles.emptyState}>
          <Type
            variant="label-md"
            style={{ color: 'var(--color-on-surface-variant)' }}
          >
            {emptyLabel}
          </Type>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.column}>
      {items.map((item) => {
        const key = getKey(item);
        return (
          <React.Fragment key={key}>
            {renderItem(item, key === selectedId, onSelect)}
          </React.Fragment>
        );
      })}
    </div>
  );
}
