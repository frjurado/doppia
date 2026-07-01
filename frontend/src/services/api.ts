/**
 * Shared API fetch base.
 *
 * All API calls go through apiFetch, which:
 * - Reads the current session token and sets the Authorization header.
 * - Throws ApiError on non-2xx responses, parsing the standard error envelope.
 * - Wraps network-level failures (fetch throws) as ApiError with NETWORK_ERROR.
 * - Optionally validates the response body against a Zod schema; throws ZodError
 *   if the shape doesn't match.
 *
 * The standard error envelope from the backend is:
 *   { "error": { "code": "SCREAMING_SNAKE", "message": "...", "detail": {} } }
 */

import { z } from 'zod';
import { getSession, clearToken } from './auth';
import i18next, { getCurrentLanguage } from '../i18n';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status?: number,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Fetch a typed JSON response from the API.
 *
 * Automatically attaches the Bearer token from the current session. Throws
 * ApiError on any non-2xx HTTP status or network failure.
 *
 * When a Zod schema is provided the response body is parsed through it; a
 * ZodError is thrown if the shape doesn't match. Call sites that don't yet
 * have a schema continue to work with the bare type cast.
 *
 * Content-Type is set to application/json only when a non-FormData body is
 * present and the caller has not already set their own Content-Type. GET and
 * multipart/form-data requests are unaffected.
 *
 * @param path - API path relative to the origin, e.g. "/api/v1/composers".
 * @param options - Optional fetch RequestInit (method, body, etc.).
 * @param schema - Optional Zod schema for runtime response validation.
 * @returns Parsed JSON body typed as T.
 * @throws ApiError on HTTP errors or network failures.
 * @throws ZodError if schema is provided and the response shape doesn't match.
 */
export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
  schema?: z.ZodSchema<T>,
): Promise<T> {
  const session = getSession();

  const headers: Record<string, string> = {
    ...(options?.headers as Record<string, string> | undefined),
  };

  const hasBody = options?.body != null;
  const callerSetContentType = 'Content-Type' in headers;
  if (hasBody && !callerSetContentType && !(options?.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  // Drive the backend translation overlay (ADR-006 § 6) from the active UI
  // language unless the caller set its own Accept-Language. The backend
  // negotiates this header and falls back to English with translation_missing.
  if (!('Accept-Language' in headers)) {
    headers['Accept-Language'] = getCurrentLanguage();
  }

  if (session) {
    headers['Authorization'] = `Bearer ${session.access_token}`;
  }

  let response: Response;
  try {
    response = await fetch(path, { ...options, headers });
  } catch (err) {
    throw new ApiError(
      'NETWORK_ERROR',
      err instanceof Error ? err.message : 'Network request failed',
    );
  }

  if (!response.ok) {
    let code = 'API_ERROR';
    let message = `HTTP ${response.status}`;
    let detail: unknown;

    try {
      const body = await response.json();
      if (body?.error) {
        code = body.error.code ?? code;
        message = body.error.message ?? message;
        detail = body.error.detail;
      }
    } catch {
      // response body was not valid JSON; keep the defaults above
    }

    // The auth middleware's INVALID_TOKEN message is raw English backend text
    // (it covers several distinct causes — expired, malformed, missing claim —
    // that all mean the same thing to the user: sign in again). Translate it
    // here, once, rather than at each of the call sites that render
    // ApiError.message directly. A stale token also means the caller is no
    // longer authenticated even though one is still stored, so clear it: the
    // next NavBar render (any navigation) then correctly shows the login link
    // instead of the account badge (I1's root cause).
    if (code === 'INVALID_TOKEN') {
      clearToken();
      message = i18next.t('auth:sessionExpired');
    }

    throw new ApiError(code, message, response.status, detail);
  }

  // 204 No Content — skip JSON parsing (e.g. delete endpoints)
  if (response.status === 204) {
    return undefined as unknown as T;
  }

  const json = await response.json();
  return schema ? schema.parse(json) : (json as T);
}
