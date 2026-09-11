import { Outlet } from 'react-router-dom';
import TopBar from './TopBar';
import styles from './PublicLayout.module.css';

/**
 * Shell for the public read path (glossary, public browse, fragment detail).
 *
 * Component 10 shipped this with a deliberately minimal header of its own,
 * because the editorial NavBar was the only alternative and accounts did not
 * exist yet. Component 12 Step 13 retires that split: the shared {@link TopBar}
 * is the product frame on every surface, and it decides for itself which
 * groups a given visitor sees. What remains here is the page scaffold.
 */
export default function PublicLayout() {
  return (
    <div className={styles.layout}>
      <TopBar />
      <main className={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}
