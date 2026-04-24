import React from 'react';
import styles from './BrowseItem.module.css';

export interface BrowseItemProps {
  id: string;
  isSelected: boolean;
  onClick: (id: string) => void;
  children: React.ReactNode;
  disabled?: boolean;
}

/**
 * A selectable list item rendered as a full-width button.
 * Background shifts to container-high when selected, container on hover.
 * No border, no transition — depth via tonal layering only.
 */
export default function BrowseItem({
  id,
  isSelected,
  onClick,
  children,
  disabled = false,
}: BrowseItemProps) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onClick(id)}
      className={`${styles.item} ${isSelected ? styles.selected : ''}`}
    >
      {children}
    </button>
  );
}
