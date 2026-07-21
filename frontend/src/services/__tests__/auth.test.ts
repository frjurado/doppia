/**
 * Unit tests for the in-memory access-token store (Component 10 Step 7).
 *
 * The store moved from localStorage to memory (the ADR-016 revisit): the access
 * token is a module-level value, and consumers subscribe to changes. The
 * Component 9 I1 behaviour is preserved — an expired JWT reads as no session.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearToken, getAccessToken, getSession, setToken, subscribe } from '../auth';

/** Build a JWT-shaped string with the given payload (signature is ignored). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

// The store is a module singleton; reset it after each test.
afterEach(() => {
  clearToken();
});

describe('getSession', () => {
  it('returns null when no token is held', () => {
    expect(getSession()).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it('returns the session for a non-JWT dev token (no expiry)', () => {
    setToken('dev-token');
    expect(getSession()).toEqual({ access_token: 'dev-token' });
    expect(getAccessToken()).toBe('dev-token');
  });

  it('returns the session for a JWT whose exp is in the future', () => {
    const token = fakeJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
    setToken(token);
    expect(getSession()).toEqual({ access_token: token });
  });

  it('returns null and clears for a JWT whose exp has passed', () => {
    const token = fakeJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 10 });
    setToken(token);
    expect(getSession()).toBeNull();
    // Cleared, so a subsequent read is also null.
    expect(getAccessToken()).toBeNull();
  });

  it('treats a JWT with no exp claim as non-expiring', () => {
    const token = fakeJwt({ sub: 'u1' });
    setToken(token);
    expect(getSession()).toEqual({ access_token: token });
  });

  it('treats a malformed token (not three segments) as non-expiring', () => {
    setToken('not.a.jwt.token.at.all');
    expect(getSession()).toEqual({ access_token: 'not.a.jwt.token.at.all' });
  });

  it('is cleared by clearToken', () => {
    setToken('dev-token');
    clearToken();
    expect(getSession()).toBeNull();
  });

  it('does not persist across a simulated reload (no localStorage write)', () => {
    setToken('dev-token');
    expect(localStorage.getItem('doppia_access_token')).toBeNull();
  });
});

describe('subscribe', () => {
  it('notifies listeners on set and clear, and unsubscribes cleanly', () => {
    const listener = vi.fn();
    const unsubscribe = subscribe(listener);

    setToken('dev-token');
    expect(listener).toHaveBeenCalledTimes(1);

    clearToken();
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setToken('dev-token');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('does not notify when clearing an already-empty store', () => {
    const listener = vi.fn();
    subscribe(listener);
    clearToken();
    expect(listener).not.toHaveBeenCalled();
  });
});
