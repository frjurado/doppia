import { BrowserRouter, Route, Routes } from 'react-router-dom';
import RequireAuth from './components/auth/RequireAuth';
import BrowsingLayout from './components/ui/BrowsingLayout';
import ErrorBoundary from './components/ui/ErrorBoundary';
import Login from './routes/Login';
import CorpusBrowser from './routes/CorpusBrowser';
import FragmentBrowser from './routes/FragmentBrowser';
import FragmentDetail from './routes/FragmentDetail';
import ReviewQueue from './routes/ReviewQueue';
import ScoreViewer from './routes/ScoreViewer';

/**
 * Root application component.
 *
 * Sets up the React Router BrowserRouter and top-level route tree.
 * Routes are added here as components are built in each Phase 1 component task.
 *
 * Design system: before writing any UI, read docs/mockups/opus_urtext/DESIGN.md.
 * Key constraints: Henle Blue #3f5f77, Urtext Cream #fbf9f0, 0px border-radius everywhere.
 */
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />

        {/* Browsing views share the NavBar via BrowsingLayout (no auth gate here).
            RequireAuth is on each child so unauthenticated users still see the
            nav bar — and the Login button — before being redirected. */}
        <Route element={<ErrorBoundary><BrowsingLayout /></ErrorBoundary>}>
          <Route path="/" element={<RequireAuth><CorpusBrowser /></RequireAuth>} />
          <Route path="/review-queue" element={<RequireAuth><ReviewQueue /></RequireAuth>} />
          <Route path="/concepts" element={<RequireAuth><FragmentBrowser /></RequireAuth>} />
          <Route path="/fragments/:fragmentId" element={<RequireAuth><FragmentDetail /></RequireAuth>} />
        </Route>

        {/* Score viewer is full-screen; no shared nav */}
        <Route
          path="/scores/:movementId"
          element={
            <RequireAuth>
              <ScoreViewer />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
