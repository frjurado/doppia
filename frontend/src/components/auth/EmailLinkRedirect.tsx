import { Navigate, useLocation } from 'react-router-dom';

/**
 * Where each kind of emailed one-time token has to be redeemed.
 *
 * `invite` and `recovery` both end in choosing a password, so they share
 * `/auth/reset-password`. `signup` and `email_change` only need a session
 * established, which is what `/auth/callback` does.
 */
const DESTINATIONS: Record<string, string> = {
  invite: '/auth/reset-password',
  recovery: '/auth/reset-password',
  signup: '/auth/callback',
  email_change: '/auth/callback',
};

/**
 * Forward an emailed auth token that arrived at the wrong route.
 *
 * Supabase does **not** guarantee the link lands where we asked. `redirect_to`
 * is validated against the project's Redirect URLs allowlist *after* the fact,
 * and a value that is not on it is **silently replaced by the Site URL** — the
 * query string survives, the path does not. An invitation meant for
 * `/auth/reset-password` then arrives at `/`, where nothing reads it: the
 * bootstrap refresh 401s (correctly — the visitor has no session yet),
 * `RequireAuth` redirects to `/login`, and the token is discarded. The invitee
 * cannot create their account and there is nothing on screen to say why.
 *
 * That is a configuration mistake, and the fix is the allowlist entry. But it
 * is a *silent* one whose only symptom is a support request, it has to be made
 * again for every environment, and it costs one redirect to survive. So this
 * guard runs above the route tree: if a request carries `token_hash` and a
 * known `type` but is not already at that type's redemption route, it is sent
 * there with the query string intact.
 *
 * It changes nothing about how the token is redeemed — that is still a single
 * server-side call keeping the credential out of JavaScript (ADR-035). It only
 * makes sure the code that does it is the code that runs.
 */
export default function EmailLinkRedirect({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const tokenHash = params.get('token_hash');
  const linkType = params.get('type');

  if (tokenHash && linkType) {
    const destination = DESTINATIONS[linkType];
    // An unknown type is left alone: guessing a destination for a token we
    // cannot redeem would only move the dead end somewhere less legible.
    if (destination && destination !== location.pathname) {
      return <Navigate to={`${destination}${location.search}`} replace />;
    }
  }
  return <>{children}</>;
}
