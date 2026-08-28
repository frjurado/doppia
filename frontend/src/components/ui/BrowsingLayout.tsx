import { Outlet } from 'react-router-dom';
import NavBar from './NavBar';
import UnverifiedBanner from '../auth/UnverifiedBanner';
import styles from './BrowsingLayout.module.css';

/**
 * Shared layout for all authenticated browsing views: corpus browser,
 * fragment browser, review queue, fragment detail. Renders the NavBar
 * above the route content (via <Outlet />).
 *
 * The unverified-email banner sits directly under the nav. It renders nothing
 * for anonymous visitors and verified accounts, so mounting it here costs
 * nothing and means no authenticated surface can forget it.
 *
 * Used as a React Router v6 layout route in App.tsx.
 */
export default function BrowsingLayout() {
  return (
    <div className={styles.layout}>
      <NavBar />
      <UnverifiedBanner />
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
