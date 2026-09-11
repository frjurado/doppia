import styles from './Button.module.css';

/**
 * Shared button variants — design-debt register F12 (Component 12, Step 14).
 *
 * `primary` and `secondary` are the page-level pair (submit / alternative
 * path). `tertiary` is DESIGN.md § 5's serif underlined control, used where a
 * button must not read as a container. `quiet` is the neutral dismissal.
 *
 * The two destructive variants are a pair, not alternatives:
 * `destructive` is the **trigger** (error ink, no container) and
 * `destructiveConfirm` is the **confirmation** (solid error fill), which
 * belongs only inside an error-container well. Never open with the solid one —
 * see DESIGN.md § 5 "Destructive actions".
 */
export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'tertiary'
  | 'quiet'
  | 'destructive'
  | 'destructiveConfirm';

/**
 * `md` is the page register (auth, admin, profile) and inherits the surface's
 * type; `sm` is the tagging tool's panel-chrome register — a 0.75rem uppercase
 * micro-label. Both existed in the tree already; this names them.
 */
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Stretch to the container's width — the auth forms' full-bleed CTA. */
  fullWidth?: boolean;
}

/**
 * The one button implementation.
 *
 * Defaults to `type="button"`. That is deliberate: HTML defaults a bare
 * `<button>` inside a form to `type="submit"`, which is the wrong default far
 * more often than it is the right one. Forms pass `type="submit"` explicitly.
 */
export default function Button({
  variant = 'secondary',
  size = 'md',
  fullWidth = false,
  className,
  type = 'button',
  ...rest
}: ButtonProps) {
  const classes = [
    styles.base,
    styles[size],
    styles[variant],
    fullWidth ? styles.fullWidth : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return <button type={type} className={classes} {...rest} />;
}
