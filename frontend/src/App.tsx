import { BrowserRouter, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { AuthProvider } from './components/auth/AuthContext';
import RequireAuth from './components/auth/RequireAuth';
import EmailLinkRedirect from './components/auth/EmailLinkRedirect';
import BrowsingLayout from './components/ui/BrowsingLayout';
import Landing from './routes/Landing';
import PublicLayout from './components/ui/PublicLayout';
import ErrorBoundary from './components/ui/ErrorBoundary';
import Login from './routes/Login';
import AuthCallback from './routes/AuthCallback';
import Register from './routes/Register';
import VerifyEmail from './routes/VerifyEmail';
import ForgotPassword from './routes/ForgotPassword';
import ResetPassword from './routes/ResetPassword';
import Profile from './routes/Profile';
import Progress from './routes/Progress';
import AdminUsers from './routes/AdminUsers';
import AdminModeration from './routes/AdminModeration';
import RequireRole from './components/auth/RequireRole';
import { ADMIN, EDITORIAL_ROLES } from './services/roles';
import ConceptPage from './routes/ConceptPage';
import GlossaryIndex from './routes/GlossaryIndex';
import CorpusBrowser from './routes/CorpusBrowser';
import FragmentBrowser from './routes/FragmentBrowser';
import FragmentDetail from './routes/FragmentDetail';
import ReviewQueue from './routes/ReviewQueue';
import ScoreViewer from './routes/ScoreViewer';
import HorizontalRenderSpike from './routes/spike/HorizontalRenderSpike';

/**
 * Root application component.
 *
 * Sets up the React Router BrowserRouter and top-level route tree.
 * Routes are added here as components are built in each Phase 1 component task.
 *
 * Design system: before writing any UI, read docs/mockups/opus_urtext/DESIGN.md.
 * Key constraints: Henle Blue #3f5f77, Urtext Cream #fbf9f0, 0px border-radius everywhere.
 */
/**
 * `/public/concepts?concept=…` → `/fragments?concept=…`, query intact.
 *
 * Component 11's glossary has linked into the old path since it shipped, and
 * a concept id in the query is the whole point of those links.
 */
function RedirectToFragments() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/fragments', search }} replace />;
}

/** `/public/fragments/:id` → `/fragments/:id`. */
function RedirectToFragmentDetail() {
  const { fragmentId } = useParams();
  return <Navigate to={`/fragments/${fragmentId}`} replace />;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* Sits above the route tree because an emailed token can arrive at any
            path: Supabase silently substitutes its Site URL when redirect_to is
            not allowlisted. See EmailLinkRedirect. */}
        <EmailLinkRedirect>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/auth/callback" element={<AuthCallback />} />
            <Route path="/register" element={<Register />} />
            <Route path="/auth/verify-email" element={<VerifyEmail />} />
            <Route path="/auth/forgot-password" element={<ForgotPassword />} />
            <Route path="/auth/reset-password" element={<ResetPassword />} />

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
              {/* The site root, for every audience (Step 14b). It was the
              corpus browser, which bounced anonymous visitors to /login, sent
              every post-login account to a page most could not open, and left
              RequireRole with nowhere to refuse callers to. */}
              <Route path="/" element={<Landing />} />

              {/* One browse surface and one detail, both session-aware: the
              component picks the editorial or the public client from the
              caller's roles, which is how the backend already keys its policy
              (ADR-009 § 2 is enforced on caller_id is None, not on the route).
              The /public/* pair they replace redirect below. */}
              <Route path="/fragments" element={<FragmentBrowser />} />
              <Route path="/fragments/:fragmentId" element={<FragmentDetail />} />

              {/* Concept glossary — Component 11. The browse-by-domain index
              (Step 7) is the public entry surface; each concept page (Step 5)
              is keyed on the immutable concept id (§ Decisions 1). */}
              <Route path="/glossary" element={<GlossaryIndex />} />
              <Route path="/glossary/:conceptId" element={<ConceptPage />} />

              {/* Retired routes. Kept as redirects rather than deleted: the
              glossary has linked into /public/concepts?concept=… since
              Component 11, and those links are in the wild. */}
              <Route path="/public/concepts" element={<RedirectToFragments />} />
              <Route path="/public/fragments/:fragmentId" element={<RedirectToFragmentDetail />} />
              <Route path="/concepts" element={<RedirectToFragments />} />
            </Route>

            {/* Browsing views share the TopBar via BrowsingLayout (no auth gate here).
            RequireAuth is on each child so unauthenticated users still see the
            nav bar — and the Login button — before being redirected. */}
            <Route
              element={
                <ErrorBoundary>
                  <BrowsingLayout />
                </ErrorBoundary>
              }
            >
              {/* Editorial: browse.py gates these endpoints on EDITOR/ADMIN,
              so an ungated route showed a role-less account a raw permission
              string. Off the site root since Step 14b. */}
              <Route
                path="/corpus"
                element={
                  <RequireRole roles={EDITORIAL_ROLES}>
                    <CorpusBrowser />
                  </RequireRole>
                }
              />
              <Route
                path="/profile"
                element={
                  <RequireAuth>
                    <Profile />
                  </RequireAuth>
                }
              />
              {/* Progress dashboard proper is Component 15; the account menu
              opens this honest placeholder meanwhile (Step 13). */}
              <Route
                path="/progress"
                element={
                  <RequireAuth>
                    <Progress />
                  </RequireAuth>
                }
              />
              <Route
                path="/admin/users"
                element={
                  <RequireRole roles={[ADMIN]}>
                    <AdminUsers />
                  </RequireRole>
                }
              />
              <Route
                path="/admin/moderation"
                element={
                  <RequireRole roles={[ADMIN]}>
                    <AdminModeration />
                  </RequireRole>
                }
              />
              <Route
                path="/review-queue"
                element={
                  <RequireRole roles={EDITORIAL_ROLES}>
                    <ReviewQueue />
                  </RequireRole>
                }
              />
            </Route>

            {/* Score viewer is full-screen; no shared nav. Editorial like the
            corpus browser that leads to it — movements.py gates its endpoints
            on EDITOR/ADMIN. */}
            <Route
              path="/scores/:movementId"
              element={
                <RequireRole roles={EDITORIAL_ROLES}>
                  <ScoreViewer />
                </RequireRole>
              }
            />

            {/* Throwaway rendering spike (Component 10 Step 12) — dev builds only,
            never shipped to production. Findings report:
            docs/reports/component-10-horizontal-rendering-spike.md */}
            {import.meta.env.DEV && (
              <Route path="/spike/horizontal" element={<HorizontalRenderSpike />} />
            )}
          </Routes>
        </EmailLinkRedirect>
      </AuthProvider>
    </BrowserRouter>
  );
}
