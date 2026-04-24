/**
 * Shared API fetch base.
 *
 * All API calls go through apiFetch, which:
 * - Reads the current session token and sets the Authorization header.
 * - Throws ApiError on non-2xx responses, parsing the standard error envelope.
 * - Wraps network-level failures (fetch throws) as ApiError with NETWORK_ERROR.
 *
 * The standard error envelope from the backend is:
 *   { "error": { "code": "SCREAMING_SNAKE", "message": "...", "detail": {} } }
 */

import { getSession } from './auth';

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
 * @param path - API path relative to the origin, e.g. "/api/v1/composers".
 * @param options - Optional fetch RequestInit (method, body, etc.).
 * @returns Parsed JSON body typed as T.
 * @throws ApiError on HTTP errors or network failures.
 */
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const session = getSession();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options?.headers as Record<string, string> | undefined),
  };

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

    throw new ApiError(code, message, response.status, detail);
  }

  return response.json() as Promise<T>;
}
