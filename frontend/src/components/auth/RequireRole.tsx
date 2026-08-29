import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

interface RequireRoleProps {
  /** The role a caller must hold to see this route. */
  role: string;
  children: React.ReactNode;
}

/**
 * Gate a route on a granted role, on top of {@link RequireAuth}'s session gate.
 *
 * This is **presentation, not permission**. The API enforces roles with
 * `require_role()` on every call (ADR-037); routing a signed-in non-admin away
 * from `/admin/users` only spares them a page of failed requests. Removing this
 * component would leak no data.
 *
 * `loading` renders nothing rather than redirecting, for the same reason
 * `RequireAuth` does: the access token is restored from the refresh cookie
 * after a reload, so the first render of a legitimately-admin session has no
 * roles yet and a redirect would bounce them off their own page.
 *
 * An anonymous caller goes to `/login`; a signed-in caller without the role
 * goes home, because sending them to a login form they have already passed
 * would suggest the wrong remedy.
 */
export default function RequireRole({ role, children }: RequireRoleProps) {
  const { status, user } = useAuth();

  if (status === 'loading') return null;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  if (!user?.roles.includes(role)) return <Navigate to="/" replace />;
  return <>{children}</>;
}
