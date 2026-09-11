/**
 * Moderation queue tests — Component 12 Step 11.
 *
 * The queue ships before anything is reportable, so its ordinary state today is
 * empty — and the copy for that has to read as "nothing to do", not as an
 * error. The other case worth pinning is that dismissing removes the row from
 * the open queue without a refetch.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModerationReport } from '../../services/adminApi';
import * as adminApi from '../../services/adminApi';
import AdminModeration from '../AdminModeration';

vi.mock('../../services/adminApi', async () => {
  const actual = await vi.importActual<typeof adminApi>('../../services/adminApi');
  return { ...actual, listReports: vi.fn(), dismissReport: vi.fn() };
});

function report(overrides: Partial<ModerationReport> = {}): ModerationReport {
  return {
    id: 'r1',
    resource_ref: 'collection:abc',
    reporter_id: 'u1',
    reporter_email: 'reporter@test.com',
    reason: 'spam',
    detail: null,
    status: 'open',
    created_at: '2026-08-20T00:00:00Z',
    resolved_by: null,
    resolved_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(adminApi.listReports).mockResolvedValue({ items: [], next_cursor: null });
});

describe('AdminModeration', () => {
  it('opens on the open reports', async () => {
    render(<AdminModeration />);
    await waitFor(() => {
      expect(adminApi.listReports).toHaveBeenCalledWith({ status: 'open' });
    });
  });

  it('reads an empty queue as nothing to do, not as a failure', async () => {
    render(<AdminModeration />);
    await waitFor(() => {
      expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a report with who filed it and why', async () => {
    vi.mocked(adminApi.listReports).mockResolvedValue({
      items: [report({ detail: 'Advertising, not analysis.' })],
      next_cursor: null,
    });
    render(<AdminModeration />);

    await waitFor(() => {
      expect(screen.getByText(/collection:abc/)).toBeInTheDocument();
    });
    expect(screen.getByText(/reporter@test.com/)).toBeInTheDocument();
    expect(screen.getByText('Advertising, not analysis.')).toBeInTheDocument();
  });

  it('offers only dismissal — the other outcome arrives with sharing', async () => {
    vi.mocked(adminApi.listReports).mockResolvedValue({
      items: [report()],
      next_cursor: null,
    });
    render(<AdminModeration />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
    });
    expect(screen.queryByRole('button', { name: /unpublish/i })).not.toBeInTheDocument();
  });

  it('takes a dismissed report out of the open queue without refetching', async () => {
    vi.mocked(adminApi.listReports).mockResolvedValue({
      items: [report()],
      next_cursor: null,
    });
    vi.mocked(adminApi.dismissReport).mockResolvedValue(report({ status: 'dismissed' }));
    render(<AdminModeration />);

    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));

    await waitFor(() => {
      expect(screen.getByText(/nothing to review/i)).toBeInTheDocument();
    });
    expect(adminApi.listReports).toHaveBeenCalledTimes(1);
  });

  it('switches the filter and refetches for that status', async () => {
    render(<AdminModeration />);
    await waitFor(() => expect(adminApi.listReports).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Dismissed' }));

    await waitFor(() => {
      expect(adminApi.listReports).toHaveBeenCalledWith({ status: 'dismissed' });
    });
  });
});
