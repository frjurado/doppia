import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import LanguageSwitcher from './LanguageSwitcher';
import styles from './NavBar.module.css';

/**
 * Shared top-level navigation bar rendered on all browsing views
 * (corpus browser, fragment browser, review queue, fragment detail).
 *
 * Layout: Doppia wordmark (left) · primary nav links · user slot (right).
 * The user slot is driven by AuthContext (Component 10 Step 7): while the
 * bootstrap refresh is in flight it stays empty; when authenticated it shows a
 * dropdown (email · role · sign out); when anonymous it shows the login button.
 *
 * Design system: container-low tonal background, 0px border-radius,
 * Public Sans labels, Newsreader wordmark. No 1px borders; the dropdown gains
 * depth from a higher tonal layer.
 */
export default function NavBar() {
  const { t } = useTranslation('nav');
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close the dropdown on an outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;
    function onPointerDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  async function handleLogout() {
    setMenuOpen(false);
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <nav className={styles.bar} aria-label={t('ariaMain')}>
      <Link to="/" className={styles.wordmark} aria-label={t('ariaHome')}>
        Doppia
      </Link>

      <div className={styles.links} role="list">
        <NavLink
          to="/"
          end
          role="listitem"
          className={({ isActive }) => `${styles.link}${isActive ? ` ${styles.linkActive}` : ''}`}
        >
          {t('browse')}
        </NavLink>
        <NavLink
          to="/concepts"
          role="listitem"
          className={({ isActive }) => `${styles.link}${isActive ? ` ${styles.linkActive}` : ''}`}
        >
          {t('fragments')}
        </NavLink>
        <NavLink
          to="/review-queue"
          role="listitem"
          className={({ isActive }) => `${styles.link}${isActive ? ` ${styles.linkActive}` : ''}`}
        >
          {t('review')}
        </NavLink>
      </div>

      {/* Right slot: language switcher + (user dropdown when logged in, login
          otherwise; nothing while the bootstrap refresh resolves). */}
      <div className={styles.actions}>
        <LanguageSwitcher />
        {status === 'authenticated' && user ? (
          <div className={styles.userMenu} ref={menuRef}>
            <button
              type="button"
              className={styles.userButton}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={t('ariaUserMenu')}
              onClick={() => setMenuOpen((open) => !open)}
            >
              {user.email || t('account')}
              <span aria-hidden="true" className={styles.caret}>
                ▾
              </span>
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu">
                <div className={styles.menuInfo}>
                  <span className={styles.menuEmail}>{user.email}</span>
                  {user.role && <span className={styles.menuRole}>{user.role}</span>}
                </div>
                <button
                  type="button"
                  role="menuitem"
                  className={styles.menuItem}
                  onClick={handleLogout}
                >
                  {t('logout')}
                </button>
              </div>
            )}
          </div>
        ) : status === 'anonymous' ? (
          <Link to="/login" className={styles.loginButton}>
            {t('login')}
          </Link>
        ) : null}
      </div>
    </nav>
  );
}
