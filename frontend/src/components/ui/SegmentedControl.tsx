import Type from './Type';
import styles from './SegmentedControl.module.css';

/**
 * Exclusive choice among a few short options — staff size, grid resolution
 * (design-debt register F12, the score-surface half).
 *
 * There were three of these, each with its own CSS, and they disagreed on what
 * "selected" looks like: staff size filled the active segment with `primary`,
 * grid resolution stepped it one tonal layer instead. Both are defensible;
 * having both in one toolbar is not. The primary fill wins because it is the
 * treatment Step 17 / F7 already settled on for staff size, it is what the
 * TAG toggle beside them uses, and `DESIGN.md` § 2 lists active states among
 * `primary`'s jobs.
 */

export interface SegmentOption<T> {
  value: T;
  /**
   * Short label — a segment is not the place for a sentence. A node rather
   * than a string because the grid-resolution control's segments are icons;
   * those must supply `ariaLabel`, since a glyph names nothing.
   */
  label: React.ReactNode;
  /** Accessible name, required when `label` is not readable text. */
  ariaLabel?: string;
}

export interface SegmentedControlProps<T> {
  options: readonly SegmentOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Names the group for assistive tech; required — a bare row of two-letter
   *  buttons is meaningless without it. */
  ariaLabel: string;
  className?: string;
}

export default function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  className,
}: SegmentedControlProps<T>) {
  return (
    <div
      className={[styles.group, className ?? ''].filter(Boolean).join(' ')}
      role="group"
      aria-label={ariaLabel}
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          type="button"
          className={[styles.segment, option.value === value ? styles.segmentActive : '']
            .filter(Boolean)
            .join(' ')}
          aria-pressed={option.value === value}
          aria-label={option.ariaLabel}
          title={option.ariaLabel}
          onClick={() => onChange(option.value)}
        >
          {typeof option.label === 'string' ? (
            <Type variant="label-sm" as="span">
              {option.label}
            </Type>
          ) : (
            option.label
          )}
        </button>
      ))}
    </div>
  );
}

export interface ToggleButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  pressed: boolean;
}

/**
 * A single on/off control wearing the segment's clothes.
 *
 * The same visual as one segment, because that is what it is: the harmony
 * toggle and the TAG/Done switch each had their own copy of it. Kept beside
 * `SegmentedControl` rather than in its own file so the two can never drift.
 */
export function ToggleButton({ pressed, className, children, ...rest }: ToggleButtonProps) {
  return (
    <button
      type="button"
      className={[styles.segment, pressed ? styles.segmentActive : '', className ?? '']
        .filter(Boolean)
        .join(' ')}
      aria-pressed={pressed}
      {...rest}
    >
      <Type variant="label-sm" as="span">
        {children}
      </Type>
    </button>
  );
}
