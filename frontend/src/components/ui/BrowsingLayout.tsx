import { Outlet } from 'react-router-dom';
import NavBar from './NavBar';
import styles from './BrowsingLayout.module.css';

/**
 * Shared layout for all authenticated browsing views: corpus browser,
 * fragment browser, review queue, fragment detail. Renders the NavBar
 * above the route content (via <Outlet />).
 *
 * Used as a React Router v6 layout route in App.tsx.
 */
export default function BrowsingLayout() {
  return (
    <div className={styles.layout}>
      <NavBar />
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
