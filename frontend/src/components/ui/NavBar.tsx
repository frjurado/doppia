import { Link, NavLink } from 'react-router-dom';
import { getSession } from '../../services/auth';
import styles from './NavBar.module.css';

/**
 * Shared top-level navigation bar rendered on all browsing views
 * (corpus browser, fragment browser, review queue, fragment detail).
 *
 * Layout: Doppia wordmark (left) · primary nav links · user slot (right).
 * When authenticated: shows a non-interactive user badge (placeholder for the
 * Phase-2 dropdown). When unauthenticated: shows the login button.
 *
 * Design system: container-low tonal background, 0px border-radius,
 * Public Sans labels, Newsreader wordmark. No 1px borders.
 */
export default function NavBar() {
  const isAuthenticated = getSession() !== null;

  return (
    <nav className={styles.bar} aria-label="Main navigation">
      <Link to="/" className={styles.wordmark} aria-label="Doppia home">
        Doppia
      </Link>

      <div className={styles.links} role="list">
        <NavLink
          to="/"
          end
          role="listitem"
          className={({ isActive }) =>
            `${styles.link}${isActive ? ` ${styles.linkActive}` : ''}`
          }
        >
          Browse
        </NavLink>
        <NavLink
          to="/concepts"
          role="listitem"
          className={({ isActive }) =>
            `${styles.link}${isActive ? ` ${styles.linkActive}` : ''}`
          }
        >
          Fragments
        </NavLink>
        <NavLink
          to="/review-queue"
          role="listitem"
          className={({ isActive }) =>
            `${styles.link}${isActive ? ` ${styles.linkActive}` : ''}`
          }
        >
          Review
        </NavLink>
      </div>

      {/* Right slot: user badge when logged in, login entry point otherwise */}
      <div className={styles.actions}>
        {isAuthenticated ? (
          <div className={styles.userBadge} aria-label="User menu">
            Account ▾
          </div>
        ) : (
          <Link to="/login" className={styles.loginButton}>
            Login
          </Link>
        )}
      </div>
    </nav>
  );
}
