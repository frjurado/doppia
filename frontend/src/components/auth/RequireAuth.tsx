import { Navigate } from 'react-router-dom';
import { getSession } from '../../services/auth';

interface RequireAuthProps {
  children: React.ReactNode;
}

/**
 * Redirects to /login if no session token is present.
 * Wrap any route that requires authentication.
 *
 * Phase 1: checks localStorage for a token. No token expiry validation —
 * expired tokens surface as 401s from the API, at which point the user
 * should clear the token and log in again. Token refresh is deferred to
 * Phase 2.
 *
 * getSession() reads from localStorage synchronously, so there is no async
 * loading state and no flash of the protected page.
 */
export default function RequireAuth({ children }: RequireAuthProps) {
  const session = getSession();
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
