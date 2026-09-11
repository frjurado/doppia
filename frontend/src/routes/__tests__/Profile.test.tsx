/**
 * Profile page tests — Component 12 Step 6.
 *
 * The two things most worth pinning are the ones a careless edit would break
 * silently: that granted roles are shown but never sent back as an edit, and
 * that clearing the self-description sends an explicit null rather than being
 * dropped as "unchanged".
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/api';
import type { Profile as ProfileData } from '../../services/profileApi';
import * as profileApi from '../../services/profileApi';
import Profile from '../Profile';

vi.mock('../../services/profileApi', async () => {
  const actual = await vi.importActual<typeof profileApi>('../../services/profileApi');
  return { ...actual, getProfile: vi.fn(), updateProfile: vi.fn(), downloadExport: vi.fn() };
});

function profile(overrides: Partial<ProfileData> = {}): ProfileData {
  return {
    id: 'u1',
    email: 'editor@test.com',
    email_verified: true,
    display_name: null,
    self_declared_role: null,
    reading_history_opt_in: false,
    roles: ['editor'],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(profileApi.updateProfile).mockImplementation(async (update) =>
    profile(update as Partial<ProfileData>)
  );
});

describe('Profile', () => {
  it('shows granted roles without offering them as an edit', async () => {
    vi.mocked(profileApi.getProfile).mockResolvedValue(profile({ roles: ['editor', 'admin'] }));
    render(<Profile />);

    await waitFor(() => {
      expect(screen.getByText(/editor · admin/)).toBeInTheDocument();
    });
    // The only role control on the page is the self-description, which is a
    // different thing entirely and grants nothing.
    const selects = screen.getAllByRole('combobox');
    expect(selects).toHaveLength(1);
    expect(selects[0]).toHaveAccessibleName(/describe yourself/i);
  });

  it('reports an account with no grants rather than rendering an empty gap', async () => {
    vi.mocked(profileApi.getProfile).mockResolvedValue(profile({ roles: [] }));
    render(<Profile />);
    await waitFor(() => {
      expect(screen.getByText('None')).toBeInTheDocument();
    });
  });

  it('sends an explicit null when the self-description is withdrawn', async () => {
    // "Prefer not to say" is the absence of an answer, and the backend
    // distinguishes an explicit null from an omitted key.
    vi.mocked(profileApi.getProfile).mockResolvedValue(profile({ self_declared_role: 'educator' }));
    render(<Profile />);

    const select = await screen.findByRole('combobox');
    await userEvent.selectOptions(select, '');
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(profileApi.updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ self_declared_role: null })
      );
    });
  });

  it('sends the reading-history consent as the user set it', async () => {
    vi.mocked(profileApi.getProfile).mockResolvedValue(profile());
    render(<Profile />);

    const toggle = await screen.findByRole('checkbox');
    expect(toggle).not.toBeChecked(); // opt-in, default off
    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(profileApi.updateProfile).toHaveBeenCalledWith(
        expect.objectContaining({ reading_history_opt_in: true })
      );
    });
  });

  it('explains a refused write when the address is unconfirmed', async () => {
    vi.mocked(profileApi.getProfile).mockResolvedValue(profile({ email_verified: false }));
    vi.mocked(profileApi.updateProfile).mockRejectedValue(
      new ApiError('EMAIL_NOT_VERIFIED', 'Confirm your address.', 403)
    );
    render(<Profile />);

    await userEvent.click(await screen.findByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/confirm your email/i);
    });
  });

  it('offers the data export and reports a failure without losing the page', async () => {
    // The export is a right, so a failed download must not look like a broken
    // profile: the form stays, and only the export reports the error.
    vi.mocked(profileApi.getProfile).mockResolvedValue(profile());
    vi.mocked(profileApi.downloadExport).mockRejectedValueOnce(
      new ApiError('API_ERROR', 'nope', 500)
    );
    render(<Profile />);

    const button = await screen.findByRole('button', { name: /download my data/i });
    await userEvent.click(button);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();

    vi.mocked(profileApi.downloadExport).mockResolvedValueOnce('doppia-export.json');
    await userEvent.click(button);
    await waitFor(() => {
      expect(profileApi.downloadExport).toHaveBeenCalledTimes(2);
    });
  });
});
