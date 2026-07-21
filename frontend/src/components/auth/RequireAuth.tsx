import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

interface RequireAuthProps {
  children: React.ReactNode;
}

/**
 * Gate a route on an authenticated session.
 *
 * Reads auth status from AuthContext (Component 10 Step 7). Because the access
 * token now lives in memory and is restored from the refresh cookie on load,
 * the very first render after a reload is `loading` while that bootstrap
 * refresh is in flight — we must wait for it rather than redirect, or a
 * logged-in user would be bounced to /login on every reload. Once resolved:
 * `anonymous` redirects to /login; `authenticated` renders the route.
 */
export default function RequireAuth({ children }: RequireAuthProps) {
  const { status } = useAuth();

  if (status === 'loading') {
    // Bootstrap refresh in flight — render nothing briefly (no flash of the
    // protected page, no premature redirect).
    return null;
  }
  if (status === 'anonymous') {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
