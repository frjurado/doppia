import styles from './IconButton.module.css';

/**
 * A bare glyph control — transport, close (design-debt register F12).
 *
 * There were four of these: two transport rows that disagreed on hover (one
 * recoloured, one filled) and on disabled opacity (0.4 against 0.35), plus two
 * close buttons. The glyph carries no text, so `ariaLabel` is required rather
 * than optional — an unlabelled × is invisible to a screen reader.
 */
export interface IconButtonProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'aria-label'
> {
  /** Names the action. Required: the glyph alone says nothing. */
  ariaLabel: string;
  /** `md` for a toolbar or a panel header, `sm` for inline chrome. */
  size?: 'sm' | 'md';
}

export default function IconButton({
  ariaLabel,
  size = 'md',
  className,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      className={[styles.button, styles[size], className ?? ''].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}
