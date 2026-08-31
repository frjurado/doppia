import { Navigate } from 'react-router-dom';
import { useAuth } from './AuthContext';

interface RequireRoleProps {
  /**
   * Roles that may see this route, **any one of** which suffices — the
   * frontend counterpart of the backend's `require_role(*roles)` (ADR-037).
   * Enumerate explicitly (`[EDITOR, ADMIN]`) rather than relying on an implicit
   * admin-passes-everything rule, exactly as the permission matrix does.
   */
  roles: readonly string[];
  children: React.ReactNode;
}

/**
 * Gate a route on a granted role, on top of {@link RequireAuth}'s session gate.
 *
 * This is **presentation, not permission**. The API enforces roles with
 * `require_role()` on every call (ADR-037); routing a signed-in caller without
 * the role away from `/admin/users` only spares them a page of failed
 * requests. Removing this component would leak no data — but leaving a route
 * ungated shows a raw backend permission string on a user-facing page, which
 * is what this exists to prevent.
 *
 * `loading` renders nothing rather than redirecting, for the same reason
 * `RequireAuth` does: the access token is restored from the refresh cookie
 * after a reload, so the first render of a legitimately-admin session has no
 * roles yet and a redirect would bounce them off their own page.
 *
 * An anonymous caller goes to `/login`; a signed-in caller without the role
 * goes to the glossary, because sending them to a login form they have already
 * passed would suggest the wrong remedy. The glossary is the public entry
 * surface and is reachable by everyone — note it cannot be `/`, which is
 * itself role-gated while the corpus browser lives there. When `/` becomes a
 * landing page (the route-topology step after Step 14) this should become `/`.
 */
export default function RequireRole({ roles, children }: RequireRoleProps) {
  const { status, user } = useAuth();

  if (status === 'loading') return null;
  if (status === 'anonymous') return <Navigate to="/login" replace />;
  if (!roles.some((role) => user?.roles.includes(role))) {
    return <Navigate to="/glossary" replace />;
  }
  return <>{children}</>;
}
