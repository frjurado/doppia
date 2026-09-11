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
  /**
   * Roles granted in `user_role`. Empty for a plain registered account —
   * `registered` is implicit in holding one and is never stored (ADR-037).
   */
  roles: string[];
  /** Unverified accounts can sign in and read, but not create content. */
  email_verified: boolean;
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

/**
 * Begin an OAuth sign-in: ask the backend for the provider's authorize URL.
 *
 * The caller must **navigate** to the returned URL (`location.assign`), never
 * fetch it — the CSP has no `*.supabase.co` in `connect-src` and does not need
 * one, because a top-level navigation is not a fetch. The PKCE verifier stays
 * in an HttpOnly cookie the backend sets on this response; it never reaches JS.
 *
 * @throws AuthError if the provider is unsupported (404) or OAuth is
 *   unconfigured server-side (503).
 */
export async function startOAuth(provider: string): Promise<{ authorize_url: string }> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/auth/oauth/${provider}/start`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    throw new AuthError('NETWORK_ERROR', 'Could not reach the sign-in service.');
  }
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/**
 * Complete an OAuth sign-in by handing the authorization code to the backend.
 *
 * The backend exchanges it against the verifier in the HttpOnly cookie, so the
 * tokens are established exactly as on the password path — the browser sees an
 * access token and nothing else.
 *
 * @throws AuthError if no flow is in progress or the code is stale (401).
 */
export async function completeOAuth(code: string): Promise<SessionResponse> {
  let response: Response;
  try {
    response = await fetch('/api/v1/auth/oauth/callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ code }),
    });
  } catch {
    throw new AuthError('NETWORK_ERROR', 'Could not reach the sign-in service.');
  }
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/**
 * Redeem a Supabase email link (recovery, invite, confirmation) for a session.
 *
 * The link lands on one of our own routes carrying an opaque `token_hash`; the
 * backend redeems it and establishes the session, so no token ever appears in
 * the URL or in JavaScript.
 *
 * @throws AuthError with 401 if the link is expired or already used — they are
 *   single-use, so a reload of a consumed link fails here.
 */
export async function verifyEmailLink(tokenHash: string, type: string): Promise<SessionResponse> {
  let response: Response;
  try {
    response = await fetch('/api/v1/auth/verify-link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ token_hash: tokenHash, type }),
    });
  } catch {
    throw new AuthError('NETWORK_ERROR', 'Could not reach the sign-in service.');
  }
  if (!response.ok) throw await parseError(response);
  return response.json();
}

/**
 * Register an account. The backend refuses this while registration is
 * invite-only, surfacing `REGISTRATION_CLOSED`.
 *
 * No session is returned: the account exists but is unverified until the
 * confirmation email is followed.
 *
 * @throws AuthError with code `REGISTRATION_CLOSED` while invite-only.
 */
export async function signUp(
  email: string,
  password: string,
  selfDeclaredRole?: string | null
): Promise<void> {
  await postJson('/api/v1/auth/signup', {
    email,
    password,
    // Optional and editable later on the profile page; omitted rather than
    // sent as null so "prefer not to say" stays the absence of an answer.
    ...(selfDeclaredRole ? { self_declared_role: selfDeclaredRole } : {}),
  });
}

/** Ask for the confirmation email to be sent again. Always succeeds. */
export async function resendVerification(email: string): Promise<void> {
  await postJson('/api/v1/auth/resend-verification', { email });
}

/**
 * Ask for a password-recovery email.
 *
 * Resolves whether or not the address is registered — the backend deliberately
 * does not distinguish, so this cannot be used to probe for accounts.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await postJson('/api/v1/auth/password-reset', { email });
}

/**
 * POST a JSON body to an auth endpoint that answers with no content.
 *
 * @throws AuthError on a non-2xx response or a network failure.
 */
async function postJson(path: string, body: unknown): Promise<void> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthError('NETWORK_ERROR', 'Could not reach the sign-in service.');
  }
  if (!response.ok) throw await parseError(response);
}
