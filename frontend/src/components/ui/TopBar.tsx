import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../auth/AuthContext';
import { BELOW_SM, useMediaQuery } from '../../hooks/useMediaQuery';
import { ADMIN, EDITOR } from '../../services/roles';
import LanguageSwitcher from './LanguageSwitcher';
import styles from './TopBar.module.css';

/**
 * The product topbar — one frame for every surface (Component 12 Step 13).
 *
 * This replaces the Phase-1 `NavBar` (three flat editorial links) *and* the
 * minimal public shell header, which were separate because Component 10 shipped
 * the public read path before accounts existed. That split is retired here: a
 * visitor now meets the same chrome everywhere, and an editor keeps their tools
 * without the public surfaces pretending to be a different site.
 *
 * The bar is an audience split, not a link list:
 *
 *  - **Public nav** — Fragments, Glossary. Collections / Exercises / Blog join
 *    it as they ship. Unshipped surfaces are *absent*, never greyed out.
 *  - **Editorial menu** — role-gated (editor or admin): the corpus browser
 *    (which is how the whole-movement score viewer is reached), the concept
 *    tree, the review queue, and for admins the moderation queue and user
 *    management.
 *  - **Account menu** — profile, progress, sign out; sign-in and register
 *    entry points when anonymous.
 *
 * Role-gating here is **presentation, not permission** — the same rule
 * `RequireRole` documents. The API enforces roles on every call (ADR-037);
 * hiding a menu entry only spares someone a page of failed requests.
 *
 * Responsive behaviour follows `DESIGN.md` § 7.4: below the `sm` breakpoint the
 * three groups collapse into a single disclosure panel (not three separate
 * menus), the tagline is dropped, and the panel uses the § 4 glassmorphism
 * treatment rather than a second overlay style. Groups are separated by space
 * and a label heading — no divider lines, per § 5.
 */

interface NavItem {
  to: string;
  label: string;
  /** Match the path exactly (for "/", which otherwise matches everything). */
  end?: boolean;
}

/**
 * Close on an outside click or Escape.
 *
 * Shared by both dropdowns and the mobile panel so all three dismiss the same
 * way — the behaviour the Phase-1 account dropdown established.
 */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, close, ref]);
}

interface DropdownProps {
  /** Visible text, which is also the control's accessible name. */
  label: string;
  /** Extra class on the wrapper, for per-menu sizing. */
  className?: string;
  children: ReactNode;
}

/** A labelled disclosure menu in the bar (Editorial, Account). */
function Dropdown({ label, className, children }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(open, close, ref);

  return (
    <div className={className ? `${styles.dropdown} ${className}` : styles.dropdown} ref={ref}>
      <button
        type="button"
        className={styles.dropdownButton}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
        <span aria-hidden="true" className={styles.caret}>
          ▾
        </span>
      </button>
      {open && (
        <div className={styles.menu} role="menu" onClick={close}>
          {children}
        </div>
      )}
    </div>
  );
}

export default function TopBar() {
  const { t } = useTranslation(['nav', 'public']);
  const { status, user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const compact = useMediaQuery(BELOW_SM);

  const [panelOpen, setPanelOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const closePanel = useCallback(() => setPanelOpen(false), []);
  useDismiss(panelOpen, closePanel, panelRef);

  // A navigation always dismisses the panel; without this it would survive a
  // route change and hang over the page the user just asked for.
  useEffect(() => {
    setPanelOpen(false);
  }, [location.pathname, location.search]);

  const authenticated = status === 'authenticated' && user !== null;
  const roles = user?.roles ?? [];
  const isAdmin = roles.includes(ADMIN);
  const isEditorial = isAdmin || roles.includes(EDITOR);

  const publicNav: NavItem[] = [
    { to: '/public/concepts', label: t('fragments') },
    { to: '/glossary', label: t('glossary') },
  ];

  const editorialNav: NavItem[] = [
    { to: '/', label: t('corpus'), end: true },
    { to: '/concepts', label: t('conceptTree') },
    { to: '/review-queue', label: t('review') },
    ...(isAdmin
      ? [
          { to: '/admin/moderation', label: t('moderation') },
          { to: '/admin/users', label: t('people') },
        ]
      : []),
  ];

  const accountNav: NavItem[] = [
    { to: '/profile', label: t('profile') },
    { to: '/progress', label: t('progress') },
  ];

  // An editor's home is the corpus they work in; everyone else's is the
  // glossary, the public entry surface. Sending an anonymous visitor to "/"
  // would bounce them straight to the login form.
  const homePath = isEditorial ? '/' : '/glossary';

  async function handleLogout() {
    setPanelOpen(false);
    await logout();
    navigate('/login', { replace: true });
  }

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `${styles.link}${isActive ? ` ${styles.linkActive}` : ''}`;

  const panelLinkClass = ({ isActive }: { isActive: boolean }) =>
    `${styles.panelItem}${isActive ? ` ${styles.panelItemActive}` : ''}`;

  return (
    <>
      <nav className={styles.bar} aria-label={t('ariaMain')}>
        <Link to={homePath} className={styles.wordmark} aria-label={t('ariaHome')}>
          {t('public:wordmark')}
        </Link>
        {/* Decorative; shrinks away under pressure before anything functional
            does, and is dropped entirely below `sm` (DESIGN.md § 7.4). */}
        <span className={styles.tagline}>{t('public:tagline')}</span>

        {compact ? (
          <div className={styles.actions}>
            <button
              type="button"
              className={styles.menuToggle}
              aria-haspopup="menu"
              aria-expanded={panelOpen}
              aria-controls="topbar-panel"
              onClick={() => setPanelOpen((o) => !o)}
            >
              {t('menu')}
            </button>
          </div>
        ) : (
          <>
            <div className={styles.links}>
              {publicNav.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={navLinkClass}>
                  {item.label}
                </NavLink>
              ))}
            </div>

            <div className={styles.actions}>
              {isEditorial && (
                <Dropdown label={t('editorial')}>
                  {editorialNav.map((item) => (
                    <NavLink
                      key={item.to}
                      to={item.to}
                      end={item.end}
                      role="menuitem"
                      className={styles.menuItem}
                    >
                      {item.label}
                    </NavLink>
                  ))}
                </Dropdown>
              )}

              <LanguageSwitcher />

              {authenticated ? (
                <Dropdown label={user.email || t('account')} className={styles.accountDropdown}>
                  <div className={styles.menuInfo}>
                    <span className={styles.menuEmail}>{user.email}</span>
                    {roles.length > 0 && (
                      <span className={styles.menuRole}>{roles.join(' · ')}</span>
                    )}
                  </div>
                  {accountNav.map((item) => (
                    <NavLink key={item.to} to={item.to} role="menuitem" className={styles.menuItem}>
                      {item.label}
                    </NavLink>
                  ))}
                  <button
                    type="button"
                    role="menuitem"
                    className={styles.menuItem}
                    onClick={handleLogout}
                  >
                    {t('logout')}
                  </button>
                </Dropdown>
              ) : status === 'anonymous' ? (
                <>
                  <Link to="/register" className={styles.link}>
                    {t('register')}
                  </Link>
                  <Link to="/login" className={styles.loginButton}>
                    {t('login')}
                  </Link>
                </>
              ) : null}
            </div>
          </>
        )}
      </nav>

      {/* One panel, all three groups — DESIGN.md § 7.4. Rendered outside the
          bar so it can overlay the page rather than stretch it. */}
      {compact && panelOpen && (
        <div className={styles.panel} id="topbar-panel" ref={panelRef}>
          <div className={styles.panelGroup}>
            <span className={styles.panelHeading}>{t('sections.browse')}</span>
            {publicNav.map((item) => (
              <NavLink key={item.to} to={item.to} end={item.end} className={panelLinkClass}>
                {item.label}
              </NavLink>
            ))}
          </div>

          {isEditorial && (
            <div className={styles.panelGroup}>
              <span className={styles.panelHeading}>{t('sections.editorial')}</span>
              {editorialNav.map((item) => (
                <NavLink key={item.to} to={item.to} end={item.end} className={panelLinkClass}>
                  {item.label}
                </NavLink>
              ))}
            </div>
          )}

          <div className={styles.panelGroup}>
            <span className={styles.panelHeading}>{t('sections.account')}</span>
            {authenticated ? (
              <>
                <span className={styles.panelEmail}>{user.email}</span>
                {accountNav.map((item) => (
                  <NavLink key={item.to} to={item.to} className={panelLinkClass}>
                    {item.label}
                  </NavLink>
                ))}
                <button type="button" className={styles.panelItem} onClick={handleLogout}>
                  {t('logout')}
                </button>
              </>
            ) : status === 'anonymous' ? (
              <>
                <NavLink to="/login" className={panelLinkClass}>
                  {t('login')}
                </NavLink>
                <NavLink to="/register" className={panelLinkClass}>
                  {t('register')}
                </NavLink>
              </>
            ) : null}
          </div>

          <div className={styles.panelGroup}>
            <span className={styles.panelHeading}>{t('language')}</span>
            <LanguageSwitcher />
          </div>
        </div>
      )}
    </>
  );
}
