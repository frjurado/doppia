/**
 * Unit tests for the session API client (Component 10 Step 7).
 *
 * Verifies the login / refresh / logout calls against the backend
 * `/api/v1/auth` router with `fetch` mocked: the request shape (path, method,
 * credentials), the parsed session, and the AuthError mapping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError, login, logout, refresh } from '../session';

const _SESSION = {
  access_token: 'access-1',
  token_type: 'bearer',
  expires_in: 3600,
  user: { id: 'u1', email: 'editor@test.com', role: 'editor' },
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('login', () => {
  it('POSTs credentials with cookies included and returns the session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, _SESSION));
    const session = await login('editor@test.com', 'pw');
    expect(session.access_token).toBe('access-1');
    expect(session.user.role).toBe('editor');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/auth/login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({
      email: 'editor@test.com',
      password: 'pw',
    });
  });

  it('throws AuthError with the envelope code on bad credentials', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'INVALID_CREDENTIALS', message: 'bad' } })
    );
    await expect(login('editor@test.com', 'wrong')).rejects.toMatchObject({
      name: 'AuthError',
      code: 'INVALID_CREDENTIALS',
      status: 401,
    });
  });

  it('maps a network failure to NETWORK_ERROR', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('failed to fetch'));
    await expect(login('editor@test.com', 'pw')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
  });
});

describe('refresh', () => {
  it('POSTs to the refresh endpoint with credentials and returns the session', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, _SESSION));
    const session = await refresh();
    expect(session.access_token).toBe('access-1');

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/v1/auth/refresh');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('throws AuthError on 401 (no active session)', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(401, { error: { code: 'UNAUTHORIZED', message: 'no session' } })
    );
    await expect(refresh()).rejects.toBeInstanceOf(AuthError);
  });
});

describe('logout', () => {
  it('POSTs to the logout endpoint and never throws', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await expect(logout()).resolves.toBeUndefined();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/v1/auth/logout');
  });

  it('swallows a network failure', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));
    await expect(logout()).resolves.toBeUndefined();
  });
});
