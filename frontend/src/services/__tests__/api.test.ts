/**
 * Unit tests for apiFetch Zod schema validation.
 *
 * These tests verify the runtime validation path added in Step 6 (R5-I4):
 * a malformed API response throws ZodError when a schema is provided, while
 * a well-formed response parses cleanly.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { apiFetch, ApiError } from '../api';
import { clearToken } from '../auth';

// apiFetch reads the session via getSession; stub it to return no token so
// the Authorization header is simply omitted (no auth side effects). clearToken
// is spied so the 401 path can assert it fired.
vi.mock('../auth', () => ({
  getSession: () => null,
  clearToken: vi.fn(),
}));

function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const UserSchema = z.object({ id: z.string().uuid(), name: z.string() });

describe('apiFetch — Zod schema validation', () => {
  it('parses a well-formed response when a schema is provided', async () => {
    mockFetch({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', name: 'Test' });
    const result = await apiFetch('/api/v1/test', undefined, UserSchema);
    expect(result).toEqual({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', name: 'Test' });
  });

  it('throws ZodError when the response shape does not match the schema', async () => {
    mockFetch({ id: 'not-a-uuid', missingName: true });
    await expect(apiFetch('/api/v1/test', undefined, UserSchema)).rejects.toThrow(z.ZodError);
  });

  it('returns the raw cast when no schema is provided (no validation)', async () => {
    mockFetch({ arbitrary: 'payload' });
    const result = await apiFetch<{ arbitrary: string }>('/api/v1/test');
    expect(result).toEqual({ arbitrary: 'payload' });
  });
});

describe('apiFetch — 401 handling (Component 9 I1/I2)', () => {
  it('clears the token and substitutes a translated message for INVALID_TOKEN', async () => {
    mockFetch({ error: { code: 'INVALID_TOKEN', message: 'Token has expired.', detail: {} } }, 401);
    const err = await apiFetch('/api/v1/test').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    // Raw backend message is replaced by the translated string, never displayed.
    expect((err as ApiError).message).not.toBe('Token has expired.');
    expect(clearToken).toHaveBeenCalled();
  });

  it('handles UNAUTHORIZED (no-session 401) the same way as INVALID_TOKEN', async () => {
    // get_current_user's bare 401 → UNAUTHORIZED envelope with a raw English
    // message. The old code only special-cased INVALID_TOKEN, leaking this one.
    mockFetch(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required.', detail: {} } },
      401
    );
    const err = await apiFetch('/api/v1/test').catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe('UNAUTHORIZED');
    expect((err as ApiError).message).not.toBe('Authentication required.');
    expect(clearToken).toHaveBeenCalled();
  });

  it('does not clear the token on a non-401 error', async () => {
    mockFetch(
      { error: { code: 'FRAGMENT_NOT_FOUND', message: 'No such fragment.', detail: {} } },
      404
    );
    const err = await apiFetch('/api/v1/test').catch((e) => e);
    expect((err as ApiError).code).toBe('FRAGMENT_NOT_FOUND');
    // 404 message is a real domain message, shown as-is.
    expect((err as ApiError).message).toBe('No such fragment.');
    expect(clearToken).not.toHaveBeenCalled();
  });
});

describe('apiFetch — Content-Type header', () => {
  it('does not set Content-Type on GET requests (no body)', async () => {
    mockFetch({});
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      })
    );
    await apiFetch('/api/v1/test');
    expect(capturedHeaders['Content-Type']).toBeUndefined();
  });

  it('sets Content-Type: application/json when a JSON body is present', async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      })
    );
    await apiFetch('/api/v1/test', { method: 'POST', body: JSON.stringify({ x: 1 }) });
    expect(capturedHeaders['Content-Type']).toBe('application/json');
  });

  it('does not set Content-Type when body is FormData', async () => {
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      })
    );
    await apiFetch('/api/v1/test', { method: 'POST', body: new FormData() });
    expect(capturedHeaders['Content-Type']).toBeUndefined();
  });
});
