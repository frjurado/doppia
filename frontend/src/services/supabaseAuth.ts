/**
 * Supabase Auth REST client for Phase 1.
 *
 * Calls the Supabase Auth v1 token endpoint directly rather than using the
 * Supabase JS client. Phase 2 will swap this for @supabase/supabase-js;
 * the interface is kept minimal to make that swap localised to this file
 * and auth.ts.
 *
 * Supabase anon key is public by design — it is safe to embed in the
 * frontend build. It does not grant write access without a valid JWT.
 */

import { setToken } from './auth';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Sign in with email and password via the Supabase Auth REST API.
 * On success, stores the access token and returns it.
 * On failure, throws AuthError with a human-readable message.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<string> {
  const url = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new AuthError('NETWORK_ERROR', 'Could not reach authentication service.');
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Supabase returns error_description for auth failures
    const message =
      body?.error_description ?? body?.message ?? 'Authentication failed.';
    throw new AuthError(body?.error ?? 'AUTH_ERROR', message);
  }

  const token: string = body.access_token;
  if (!token) {
    throw new AuthError('MISSING_TOKEN', 'No access token in response.');
  }

  setToken(token);
  return token;
}

/**
 * Sign out: clears the locally stored token.
 * Does not invalidate the token server-side (acceptable for Phase 1).
 */
export { clearToken as signOut } from './auth';
