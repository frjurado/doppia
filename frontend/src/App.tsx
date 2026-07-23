import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from './components/auth/AuthContext';
import RequireAuth from './components/auth/RequireAuth';
import BrowsingLayout from './components/ui/BrowsingLayout';
import PublicLayout from './components/ui/PublicLayout';
import ErrorBoundary from './components/ui/ErrorBoundary';
import Login from './routes/Login';
import CorpusBrowser from './routes/CorpusBrowser';
import FragmentBrowser from './routes/FragmentBrowser';
import FragmentDetail from './routes/FragmentDetail';
import PublicFragmentBrowser from './routes/PublicFragmentBrowser';
import ReviewQueue from './routes/ReviewQueue';
import ScoreViewer from './routes/ScoreViewer';
import HorizontalRenderSpike from './routes/spike/HorizontalRenderSpike';
import { getPublicFragment } from './services/publicApi';

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
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />

          {/* Public (anonymous) read path — Component 10 Step 5. No RequireAuth;
            a minimal public shell (no editor nav). The corpus browser and
            whole-movement score viewer stay editorial and are not exposed
            here. */}
          <Route
            element={
              <ErrorBoundary>
                <PublicLayout />
              </ErrorBoundary>
            }
          >
            <Route path="/public/concepts" element={<PublicFragmentBrowser />} />
            <Route
              path="/public/fragments/:fragmentId"
              element={<FragmentDetail loadFragment={getPublicFragment} publicMode />}
            />
          </Route>

          {/* Browsing views share the NavBar via BrowsingLayout (no auth gate here).
            RequireAuth is on each child so unauthenticated users still see the
            nav bar — and the Login button — before being redirected. */}
          <Route
            element={
              <ErrorBoundary>
                <BrowsingLayout />
              </ErrorBoundary>
            }
          >
            <Route
              path="/"
              element={
                <RequireAuth>
                  <CorpusBrowser />
                </RequireAuth>
              }
            />
            <Route
              path="/review-queue"
              element={
                <RequireAuth>
                  <ReviewQueue />
                </RequireAuth>
              }
            />
            <Route
              path="/concepts"
              element={
                <RequireAuth>
                  <FragmentBrowser />
                </RequireAuth>
              }
            />
            <Route
              path="/fragments/:fragmentId"
              element={
                <RequireAuth>
                  <FragmentDetail />
                </RequireAuth>
              }
            />
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

          {/* Throwaway rendering spike (Component 10 Step 12) — dev builds only,
            never shipped to production. Findings report:
            docs/reports/component-10-horizontal-rendering-spike.md */}
          {import.meta.env.DEV && (
            <Route path="/spike/horizontal" element={<HorizontalRenderSpike />} />
          )}
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
