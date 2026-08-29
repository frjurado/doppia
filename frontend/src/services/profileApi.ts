/**
 * Account profile client (`/api/v1/users/me`) — Component 12 Step 6.
 *
 * `roles` is the *granted* set and is read-only here; `self_declared_role` is
 * how the user describes themselves and grants nothing. The two are kept
 * visibly distinct because conflating them would be a permission bug wearing a
 * naming mistake as a disguise.
 */

import { apiFetch } from './api';

export const SELF_DECLARED_ROLES = [
  'student',
  'educator',
  'researcher',
  'hobbyist',
  'professional_musician',
  'other',
] as const;

export type SelfDeclaredRole = (typeof SELF_DECLARED_ROLES)[number];

export interface Profile {
  id: string;
  email: string;
  email_verified: boolean;
  display_name: string | null;
  self_declared_role: SelfDeclaredRole | null;
  reading_history_opt_in: boolean;
  /** Granted roles. Read-only: changing these is an admin action. */
  roles: string[];
}

/** Fields a user may change about themselves. Omitted keys are left alone. */
export interface ProfileUpdate {
  display_name?: string | null;
  self_declared_role?: SelfDeclaredRole | null;
  reading_history_opt_in?: boolean;
}

/** Read the authenticated caller's own profile. */
export async function getProfile(): Promise<Profile> {
  return apiFetch<Profile>('/api/v1/users/me');
}

/**
 * Apply a partial edit.
 *
 * Only the keys present in `update` are sent, so an explicit `null` clears a
 * field while an absent key leaves it untouched — the backend draws the same
 * distinction, and losing it here would silently wipe fields the user did not
 * touch.
 *
 * @throws ApiError with `EMAIL_NOT_VERIFIED` if the address is unconfirmed.
 */
export async function updateProfile(update: ProfileUpdate): Promise<Profile> {
  return apiFetch<Profile>('/api/v1/users/me', {
    method: 'PATCH',
    body: JSON.stringify(update),
  });
}
