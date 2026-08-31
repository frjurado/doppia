/**
 * Session bootstrap tests.
 *
 * The case that matters here is the one that bit in dev and nowhere else:
 * under `StrictMode` React runs effects twice (mount → unmount → mount), and
 * the bootstrap is guarded to run only once. A cancellation flag set by the
 * simulated unmount therefore had nothing to clear it — the re-run returned at
 * the guard — so a failed refresh never resolved to `anonymous` and the app sat
 * in `loading` for ever: no login link, and `RequireAuth` rendering nothing
 * instead of redirecting. Production builds do not double-invoke, which is why
 * this only ever showed up locally.
 *
 * These render under `StrictMode` on purpose. Dropping that wrapper would make
 * the regression invisible again.
 */

import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider, useAuth } from '../AuthContext';
import { clearToken } from '../../../services/auth';
import * as session from '../../../services/session';

vi.mock('../../../services/session', async () => {
  const actual = await vi.importActual<typeof session>('../../../services/session');
  return { ...actual, refresh: vi.fn(), logout: vi.fn() };
});

function StatusProbe() {
  const { status, user } = useAuth();
  return <span data-testid="status">{user ? `${status}:${user.email}` : status}</span>;
}

function renderProvider() {
  return render(
    <StrictMode>
      <AuthProvider>
        <StatusProbe />
      </AuthProvider>
    </StrictMode>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // The in-memory token store is module-level, so a session established by one
  // test would otherwise satisfy the next one's "no token" guard.
  clearToken();
});

describe('session bootstrap under StrictMode', () => {
  it('settles on anonymous when there is no session to restore', async () => {
    vi.mocked(session.refresh).mockRejectedValue(
      new session.AuthError('UNAUTHORIZED', 'No active session.', 401)
    );

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
  });

  it('settles on authenticated when the refresh cookie yields a session', async () => {
    vi.mocked(session.refresh).mockResolvedValue({
      access_token: 'tok',
      token_type: 'bearer',
      expires_in: 3600,
      user: { id: 'u1', email: 'someone@test.com', roles: ['editor'], email_verified: true },
    });

    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId('status')).toHaveTextContent('authenticated:someone@test.com')
    );
  });

  it('asks the backend to restore the session exactly once', async () => {
    vi.mocked(session.refresh).mockRejectedValue(
      new session.AuthError('UNAUTHORIZED', 'No active session.', 401)
    );

    renderProvider();

    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('anonymous'));
    // The double-invoke must not produce a second round trip: the guard is what
    // makes the cancellation flag unnecessary in the first place.
    expect(session.refresh).toHaveBeenCalledTimes(1);
  });
});
