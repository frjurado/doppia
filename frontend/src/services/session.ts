/**
 * Session API client (Component 10 Step 7 — the ADR-016 revisit).
 *
 * Talks to our own backend's `/api/v1/auth` router rather than to Supabase
 * directly. The backend performs the Supabase grant and keeps the refresh token
 * in an HttpOnly cookie; these calls only ever see the short-lived access token.
 *
 * `credentials: 'include'` ensures the refresh cookie rides along even under the
 * credentialed CORS policy (in production the SPA and API are same-origin, so
 * the cookie is same-site; see docs/architecture/security-model.md § 1).
 */

export interface SessionUser {
  id: string;
  email: string;
  role: string;
}

export interface SessionResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  user: SessionUser;
}

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

async function parseError(response: Response): Promise<AuthError> {
  let code = 'AUTH_ERROR';
  let message = `HTTP ${response.status}`;
  try {
    const body = await response.json();
    if (body?.error) {
      code = body.error.code ?? code;
      message = body.error.message ?? message;
    }
  } catch {
    // non-JSON body; keep defaults
  }
  return new AuthError(code, message, response.status);
}

/**
 * Sign in with email and password. On success the backend sets the refresh
 * cookie and returns the access token + user.
 *
 * @throws AuthError on bad credentials (401), an unavailable auth service
 *   (503), or a network failure (NETWORK_ERROR).
 */
export async function login(email: string, password: string): Promise<SessionResponse> {
  let response: Response;
  try {
    response = await fetch('/api/v1/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new AuthError('NETWORK_ERROR', 'Could not reach the authentication service.');
  }
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as SessionResponse;
}

/**
 * Silently renew the session from the refresh cookie. Returns the new session,
 * or throws AuthError (401 when there is no valid session — the normal
 * "anonymous" signal during bootstrap).
 */
export async function refresh(): Promise<SessionResponse> {
  let response: Response;
  try {
    response = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    throw new AuthError('NETWORK_ERROR', 'Could not reach the authentication service.');
  }
  if (!response.ok) throw await parseError(response);
  return (await response.json()) as SessionResponse;
}

/**
 * Sign out: revoke the session server-side (best-effort) and clear the cookie.
 * Never throws — a failed logout still clears the client session.
 */
export async function logout(): Promise<void> {
  try {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // best-effort; the AuthProvider clears local state regardless
  }
}
