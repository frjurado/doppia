import { Link, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LanguageSwitcher from './LanguageSwitcher';
import styles from './PublicLayout.module.css';

/**
 * Minimal shell for the anonymous public read path (Component 10 Step 5).
 *
 * Deliberately *not* the editor NavBar: the public surface has no Browse /
 * Fragments / Review links, no login gate, and no account badge. The full
 * audience-split public topbar (with a role-gated Editorial menu) is
 * Component 12 — this is the minimal shell the plan calls for, carrying only
 * the wordmark, a tagline, and the language switcher.
 *
 * Design system (DESIGN.md): container-low tonal header, 0px radius, Newsreader
 * wordmark, Public Sans labels, no 1px borders.
 */
export default function PublicLayout() {
  const { t } = useTranslation('public');

  return (
    <div className={styles.layout}>
      <header className={styles.bar}>
        <Link to="/public/concepts" className={styles.wordmark}>
          {t('wordmark')}
        </Link>
        <span className={styles.tagline}>{t('tagline')}</span>
        <div className={styles.actions}>
          <LanguageSwitcher />
        </div>
      </header>
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
