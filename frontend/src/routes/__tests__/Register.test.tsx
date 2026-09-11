/**
 * Registration and password-reset page tests — Component 12 Step 5.
 *
 * Coverage:
 *  - `/register` handles the invite-only refusal as a *state*, not an error:
 *    the backend's REGISTRATION_CLOSED becomes an explanation, since that is
 *    the launch posture rather than a fault.
 *  - A successful sign-up hands off to the verification interstitial without
 *    signing anyone in — the account is unverified until the email is followed.
 *  - `/auth/forgot-password` reports the same outcome whether or not the
 *    address is registered, so the page cannot be used to probe for accounts.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthError } from '../../services/session';
import * as session from '../../services/session';
import ForgotPassword from '../ForgotPassword';
import Register from '../Register';

vi.mock('../../services/session', async () => {
  const actual = await vi.importActual<typeof session>('../../services/session');
  return { ...actual, signUp: vi.fn(), requestPasswordReset: vi.fn() };
});

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

beforeEach(() => {
  vi.clearAllMocks();
});

async function fillAndSubmit(email: string, password?: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText(/email/i), email);
  if (password !== undefined) {
    await user.type(screen.getByLabelText(/password/i), password);
  }
  await user.click(screen.getByRole('button', { name: /create account|send reset link/i }));
}

describe('Register', () => {
  it('explains the invite-only posture rather than showing an error', async () => {
    vi.mocked(session.signUp).mockRejectedValue(
      new AuthError('REGISTRATION_CLOSED', 'Registration is currently by invitation only.', 403)
    );

    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );
    await fillAndSubmit('new@test.com', 'pw12345678');

    await waitFor(() => {
      expect(screen.getByText(/by invitation only/i)).toBeInTheDocument();
    });
    // The refusal is a state of the product, not a failed attempt: no alert.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('hands off to the verification interstitial without signing in', async () => {
    vi.mocked(session.signUp).mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );
    await fillAndSubmit('new@test.com', 'pw12345678');

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(
        '/auth/verify-email?email=new%40test.com',
        expect.objectContaining({ replace: true })
      );
    });
  });

  it('surfaces a rejected sign-up as an error the user can act on', async () => {
    vi.mocked(session.signUp).mockRejectedValue(new AuthError('AUTH_ERROR', 'weak password', 422));

    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );
    await fillAndSubmit('new@test.com', 'short');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});

describe('ForgotPassword', () => {
  it('reports the same outcome for an address with no account', async () => {
    // The backend answers 202 either way; the page must not add a distinction
    // the API deliberately withholds.
    vi.mocked(session.requestPasswordReset).mockResolvedValue(undefined);

    render(
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>
    );
    await fillAndSubmit('ghost@test.com');

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent(/ghost@test\.com/);
    });
    expect(screen.getByRole('status')).toHaveTextContent(/if .* has an account/i);
  });

  it('still surfaces an unreachable auth service', async () => {
    vi.mocked(session.requestPasswordReset).mockRejectedValue(
      new AuthError('AUTH_SERVICE_UNAVAILABLE', 'down', 503)
    );

    render(
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>
    );
    await fillAndSubmit('someone@test.com');

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });
});
