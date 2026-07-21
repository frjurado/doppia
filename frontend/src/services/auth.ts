/**
 * In-memory access-token store (Component 10 Step 7 — the ADR-016 revisit).
 *
 * Phase 1 kept the Supabase access token in `localStorage` (ADR-016, an
 * explicit Phase-1 exception "to be revisited before Phase 2 public launch").
 * This is that revisit: the access token now lives in a module-level variable —
 * memory only, gone on reload — and the long-lived refresh token lives in an
 * HttpOnly cookie the browser's JavaScript cannot read. The session is restored
 * after a reload by `AuthProvider` calling the backend refresh endpoint, not by
 * reading persisted storage.
 *
 * `getSession` / `setToken` / `clearToken` keep their Phase-1 names so
 * `apiFetch` and other consumers are unchanged; only the backing store moved
 * from `localStorage` to memory. `subscribe` lets `AuthProvider` react when a
 * forced clear happens outside React (e.g. `apiFetch` clearing on a 401).
 *
 * Local-dev bypass: `AuthProvider` still seeds this store from a `dev-token`
 * placed in `localStorage[DEV_TOKEN_KEY]` **in dev builds only** (see
 * `AuthContext`). That is a local-only convenience, not a production storage of
 * a real JWT, so it does not reopen the ADR-016 concern.
 */

/** localStorage key read only in dev builds to seed the local `dev-token`. */
export const DEV_TOKEN_KEY = 'doppia_access_token';

let accessToken: string | null = null;
const listeners = new Set<() => void>();

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
    const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Subscribe to token changes (set or clear). Returns an unsubscribe function.
 * Used by AuthProvider to reflect a clear triggered outside React (a 401 in
 * apiFetch) into the auth status.
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Return the current session, or null if no valid token is held.
 *
 * A held JWT whose `exp` has passed is treated as no session — and cleared — so
 * an expired access token is never attached to a request and the UI reflects
 * the real auth state (Component 9 I1). Non-JWT dev tokens never expire.
 */
export function getSession(): Session | null {
  if (!accessToken) return null;
  const expiryMs = jwtExpiryMs(accessToken);
  if (expiryMs !== null && expiryMs <= Date.now()) {
    clearToken();
    return null;
  }
  return { access_token: accessToken };
}

/** The raw access token, or null. */
export function getAccessToken(): string | null {
  return getSession()?.access_token ?? null;
}

/** Store an access token in memory for subsequent requests. */
export function setToken(token: string): void {
  accessToken = token;
  notify();
}

/** Clear the in-memory access token (sign out / forced 401 clear). */
export function clearToken(): void {
  if (accessToken === null) return;
  accessToken = null;
  notify();
}
