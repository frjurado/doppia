import type { ReactNode } from 'react';
import Surface from '../ui/Surface';
import Type from '../ui/Type';
import styles from './AuthCard.module.css';

interface AuthCardProps {
  /** Card heading. Defaults to the wordmark, as on /login. */
  title?: string;
  /** Label-cased line under the heading (DESIGN.md §3 "The Contrast"). */
  subtitle: string;
  children: ReactNode;
}

/**
 * The shared shell for every pre-session page: login, register, verification
 * and password reset.
 *
 * Depth comes from tonal layering alone — a `container-low` card on the cream
 * base — with 0px radius and no dividing lines, per DESIGN.md §§2–4. The pages
 * differ only in what they put inside it, so the card lives here rather than
 * being copied five times.
 */
export default function AuthCard({ title = 'Doppia', subtitle, children }: AuthCardProps) {
  return (
    <Surface layer="base" className={styles.page}>
      <div className={styles.card}>
        <Surface layer="container-low" className={styles.cardInner}>
          <div className={styles.header}>
            <Type variant="display-sm" as="h1" className={styles.title}>
              {title}
            </Type>
            <Type variant="label-md" as="p" className={styles.subtitle}>
              {subtitle}
            </Type>
          </div>
          {children}
        </Surface>
      </div>
    </Surface>
  );
}
