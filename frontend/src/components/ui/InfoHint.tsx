/**
 * ⓘ info affordance — the project's single explanation control.
 *
 * Reveals its text on hover, focus **and** click, in a floating panel that
 * never pushes sibling content down. Component 12 Step 14a made this the only
 * implementation: `PropertyForm` had grown two more of its own, one of which
 * opened on click only and expanded inline, shoving the rest of the sidebar
 * downwards.
 *
 * **Positioning contract:** the panel is absolutely positioned with
 * `left: 0; right: 0`, so it takes the width of the nearest *positioned*
 * ancestor — give it one that spans the sidebar. The wrapper is deliberately
 * unpositioned so that ancestor is the caller's row, not the icon.
 */

import { useState } from 'react';
import Type from './Type';
import styles from './InfoHint.module.css';

export interface InfoHintProps {
  /** The explanation text revealed on hover/focus/click. */
  text: string;
  /** Accessible label for the ⓘ button (names what it explains). */
  ariaLabel: string;
  /**
   * Optional heading above the text — the name of the concept a property
   * value references, where the text alone would not say what it describes.
   */
  title?: string;
  /** Test hook for the button. Defaults to `info-hint-btn`. */
  buttonTestId?: string;
  /** Test hook for the panel. Defaults to `info-hint-panel`. */
  panelTestId?: string;
}

export default function InfoHint({
  text,
  ariaLabel,
  title,
  buttonTestId = 'info-hint-btn',
  panelTestId = 'info-hint-panel',
}: InfoHintProps) {
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
        // The control may sit inside a clickable option row; opening the hint
        // must not also toggle the option.
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          setOpen((o) => !o);
        }}
        data-testid={buttonTestId}
      >
        ⓘ
      </button>
      {open && (
        <span className={styles.floating} role="tooltip" data-testid={panelTestId}>
          {title && (
            <Type variant="label-md" as="span" className={styles.title}>
              {title}
            </Type>
          )}
          <Type variant="label-sm" as="span">
            {text}
          </Type>
        </span>
      )}
    </span>
  );
}
