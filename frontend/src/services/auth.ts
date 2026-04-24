/**
 * Authentication service.
 *
 * In Phase 1, tokens are stored in localStorage under the key
 * "doppia_access_token". In local dev, set this to "dev-token" to use the
 * backend's AUTH_MODE=local bypass.
 *
 * This module is intentionally interface-compatible with the Supabase session
 * shape so that swapping the implementation for a proper Supabase client in
 * Phase 2 requires no changes in apiFetch or any consumer.
 */

const TOKEN_KEY = 'doppia_access_token';

export interface Session {
  access_token: string;
}

/**
 * Return the current session, or null if no token is stored.
 *
 * Reads from localStorage. In local dev, seed with:
 *   localStorage.setItem('doppia_access_token', 'dev-token')
 */
export function getSession(): Session | null {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
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
