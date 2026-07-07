/**
 * ⓘ info affordance — reveals an explanation on hover/focus/click instead of
 * permanently occupying panel space (Component 9 Part 8 item 4: sidebar
 * explanatory text moves behind an (i)). Same interaction and visual pattern
 * as PropertyForm's per-field description tooltip.
 */

import { useState } from 'react';
import Type from './Type';
import styles from './InfoHint.module.css';

export interface InfoHintProps {
  /** The explanation text revealed on hover/focus/click. */
  text: string;
  /** Accessible label for the ⓘ button (names what it explains). */
  ariaLabel: string;
}

export default function InfoHint({ text, ariaLabel }: InfoHintProps) {
  const [open, setOpen] = useState(false);

  return (
    <span className={styles.wrap}>
      <button
        type="button"
        className={styles.button}
        aria-label={ariaLabel}
        aria-expanded={open}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        data-testid="info-hint-btn"
      >
        ⓘ
      </button>
      {open && (
        <span className={styles.floating} role="tooltip" data-testid="info-hint-panel">
          <Type variant="label-sm" as="span">
            {text}
          </Type>
        </span>
      )}
    </span>
  );
}
