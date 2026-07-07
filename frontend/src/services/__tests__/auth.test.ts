/**
 * Unit tests for the auth session store — Component 9 I1 (getSession must
 * reflect real auth state: an expired JWT is no session, so the NavBar shows
 * the login link, not the account badge).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getSession, setToken, clearToken } from '../auth';

const TOKEN_KEY = 'doppia_access_token';

/** Build a JWT-shaped string with the given payload (signature is ignored). */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (obj: unknown) =>
    btoa(JSON.stringify(obj)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(payload)}.sig`;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe('getSession', () => {
  it('returns null when no token is stored', () => {
    expect(getSession()).toBeNull();
  });

  it('returns the session for a non-JWT dev token (no expiry)', () => {
    setToken('dev-token');
    expect(getSession()).toEqual({ access_token: 'dev-token' });
  });

  it('returns the session for a JWT whose exp is in the future', () => {
    const token = fakeJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) + 3600 });
    setToken(token);
    expect(getSession()).toEqual({ access_token: token });
  });

  it('returns null and clears storage for a JWT whose exp has passed', () => {
    const token = fakeJwt({ sub: 'u1', exp: Math.floor(Date.now() / 1000) - 10 });
    setToken(token);
    expect(getSession()).toBeNull();
    // Cleared, so a subsequent read is also null without re-decoding.
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
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
});
