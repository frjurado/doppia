/**
 * User management page tests — Component 12 Step 10.
 *
 * The cases worth pinning are the ones a careless edit would break quietly:
 * a role toggle is a single request whose result replaces the row (not a form
 * the user has to remember to save), and the self-demotion refusal has to read
 * as an explanation rather than as a generic failure.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/api';
import type { AdminUser } from '../../services/adminApi';
import * as adminApi from '../../services/adminApi';
import AdminUsers from '../AdminUsers';

vi.mock('../../services/adminApi', async () => {
  const actual = await vi.importActual<typeof adminApi>('../../services/adminApi');
  return {
    ...actual,
    listUsers: vi.fn(),
    grantRole: vi.fn(),
    revokeRole: vi.fn(),
    inviteUser: vi.fn(),
  };
});

vi.mock('../../components/auth/AuthContext', () => ({
  useAuth: () => ({
    status: 'authenticated',
    user: { id: 'admin-1', email: 'admin@test.com', roles: ['admin'] },
  }),
}));

function account(overrides: Partial<AdminUser> = {}): AdminUser {
  return {
    id: 'u1',
    email: 'someone@test.com',
    display_name: null,
    roles: [],
    created_at: '2026-08-01T00:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminUsers />
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminApi.listUsers).mockResolvedValue({ items: [account()], next_cursor: null });
});

describe('AdminUsers', () => {
  it('shows each account with a toggle per grantable role', async () => {
    renderPage();

    await waitFor(() => {
      expect(screen.getByText('someone@test.com')).toBeInTheDocument();
    });
    // editor, author, admin — and nothing for `registered`, which is implicit
    // in holding an account and is never granted.
    expect(screen.getByRole('button', { name: 'Editor' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Author' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Admin' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /registered/i })).not.toBeInTheDocument();
  });

  it('grants a role the account does not hold and shows the result', async () => {
    vi.mocked(adminApi.grantRole).mockResolvedValue(account({ roles: ['editor'] }));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Editor' }));

    await waitFor(() => {
      expect(adminApi.grantRole).toHaveBeenCalledWith('u1', 'editor');
    });
    // The response replaces the row, so no refetch is needed to see the change.
    expect(screen.getByRole('button', { name: 'Editor' })).toHaveAttribute('aria-pressed', 'true');
    expect(adminApi.listUsers).toHaveBeenCalledTimes(1);
  });

  it('revokes a role the account already holds', async () => {
    vi.mocked(adminApi.listUsers).mockResolvedValue({
      items: [account({ roles: ['editor'] })],
      next_cursor: null,
    });
    vi.mocked(adminApi.revokeRole).mockResolvedValue(account({ roles: [] }));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Editor' }));

    await waitFor(() => {
      expect(adminApi.revokeRole).toHaveBeenCalledWith('u1', 'editor');
    });
    expect(adminApi.grantRole).not.toHaveBeenCalled();
  });

  it('explains a refused self-demotion rather than reporting a failure', async () => {
    vi.mocked(adminApi.revokeRole).mockRejectedValue(
      new ApiError('SELF_ADMIN_REVOCATION', 'nope', 409)
    );
    vi.mocked(adminApi.listUsers).mockResolvedValue({
      items: [account({ id: 'admin-1', roles: ['admin'] })],
      next_cursor: null,
    });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Admin' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/cannot revoke your own admin/i);
    });
  });

  it('sends an invitation and confirms which address it went to', async () => {
    vi.mocked(adminApi.inviteUser).mockResolvedValue({
      email: 'newcomer@test.com',
      invited_at: '2026-08-29T00:00:00Z',
    });
    renderPage();

    await userEvent.type(await screen.findByLabelText(/email address/i), 'newcomer@test.com');
    await userEvent.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() => {
      expect(screen.getByRole('status')).toHaveTextContent('newcomer@test.com');
    });
    expect(adminApi.inviteUser).toHaveBeenCalledWith('newcomer@test.com');
  });

  it('says plainly when the address already has an account', async () => {
    vi.mocked(adminApi.inviteUser).mockRejectedValue(
      new ApiError('AUTH_SERVICE_UNAVAILABLE', 'rejected', 422)
    );
    renderPage();

    await userEvent.type(await screen.findByLabelText(/email address/i), 'taken@test.com');
    await userEvent.click(screen.getByRole('button', { name: /send invitation/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/already has an account/i);
    });
  });
});
