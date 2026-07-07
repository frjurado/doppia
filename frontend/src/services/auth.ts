/**
 * Authentication service.
 *
 * In Phase 1, tokens are stored in localStorage under the key
 * "doppia_access_token". In local dev, set this to "dev-token" to use the
 * backend's AUTH_MODE=local bypass.
 *
 * This module is intentionally interface-compatible with the Supabase session
 * shape so that swapping the implementation for a proper Supabase client in
 * Phase 2 requires no changes in apiFetch or any consumer. However, the
 * current Session interface is a strict subset of the full Supabase shape.
 * Phase 1 consumers must access only `access_token`. Accessing other Supabase
 * session fields requires expanding this interface to the full Supabase
 * `Session` shape — do that in Phase 2 when the real Supabase client is
 * wired in.
 */

const TOKEN_KEY = 'doppia_access_token';

export interface Session {
  access_token: string;
}

/**
 * Decode a JWT's `exp` claim (seconds since epoch) without verifying the
 * signature — the backend does the authoritative verification. Returns null
 * when the token is not a JWT with a numeric `exp` (e.g. the local dev tokens
 * `dev-token` / `admin-token`, which have no expiry and are always valid).
 */
function jwtExpiryMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    // Base64URL → base64, then decode the payload segment.
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * Return the current session, or null if no valid token is stored.
 *
 * Reads from localStorage. A stored JWT whose `exp` has passed is treated as
 * no session at all — and cleared — so the UI (e.g. the NavBar login link vs.
 * account badge) reflects the real auth state before any request round-trips
 * a 401 (Component 9 I1). Non-JWT dev tokens have no `exp` and never expire.
 *
 * In local dev, seed with:
 *   localStorage.setItem('doppia_access_token', 'dev-token')
 */
export function getSession(): Session | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const expiryMs = jwtExpiryMs(token);
  if (expiryMs !== null && expiryMs <= Date.now()) {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
  return { access_token: token };
}

/**
 * Store an access token for subsequent requests.
 */
export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

/**
 * Clear the stored token (sign out).
 */
export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}
