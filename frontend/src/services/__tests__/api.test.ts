/**
 * Unit tests for apiFetch Zod schema validation.
 *
 * These tests verify the runtime validation path added in Step 6 (R5-I4):
 * a malformed API response throws ZodError when a schema is provided, while
 * a well-formed response parses cleanly.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { apiFetch } from '../api';

// apiFetch reads the session via getSession; stub it to return no token so
// the Authorization header is simply omitted (no auth side effects).
vi.mock('../auth', () => ({
  getSession: () => null,
}));

function mockFetch(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const UserSchema = z.object({ id: z.string().uuid(), name: z.string() });

describe('apiFetch — Zod schema validation', () => {
  it('parses a well-formed response when a schema is provided', async () => {
    mockFetch({ id: '00000000-0000-0000-0000-000000000001', name: 'Test' });
    const result = await apiFetch('/api/v1/test', undefined, UserSchema);
    expect(result).toEqual({ id: '00000000-0000-0000-0000-000000000001', name: 'Test' });
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

describe('apiFetch — Content-Type header', () => {
  it('does not set Content-Type on GET requests (no body)', async () => {
    mockFetch({});
    let capturedHeaders: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((_url, init) => {
        capturedHeaders = (init?.headers ?? {}) as Record<string, string>;
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }),
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
      }),
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
      }),
    );
    await apiFetch('/api/v1/test', { method: 'POST', body: new FormData() });
    expect(capturedHeaders['Content-Type']).toBeUndefined();
  });
});
