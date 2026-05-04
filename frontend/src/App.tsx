import { BrowserRouter, Route, Routes } from 'react-router-dom';
import RequireAuth from './components/auth/RequireAuth';
import ErrorBoundary from './components/ui/ErrorBoundary';
import Login from './routes/Login';
import CorpusBrowser from './routes/CorpusBrowser';
import ScoreViewerStub from './routes/ScoreViewerStub';

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
        <Route
          path="/"
          element={
            <RequireAuth>
              <ErrorBoundary>
                <CorpusBrowser />
              </ErrorBoundary>
            </RequireAuth>
          }
        />
        <Route
          path="/tag/:movementId"
          element={
            <RequireAuth>
              <ScoreViewerStub />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
