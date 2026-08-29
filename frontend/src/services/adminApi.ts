/**
 * Admin API client (`/api/v1/admin`) — Component 12 Step 10.
 *
 * Every call here is admin-only server-side. The client does not enforce that
 * and must not pretend to: hiding a link is presentation, `require_role(ADMIN)`
 * is the permission. The role check in the UI exists so admins are not shown
 * doors that open and everyone else is not shown doors that do not.
 *
 * `roles` throughout is the *granted* set from `user_role` (ADR-037), never a
 * token claim and never the self-description on the profile page.
 */

import { apiFetch } from './api';

/** Roles an admin can grant. `registered` is implicit and never granted. */
export const GRANTABLE_ROLES = ['editor', 'author', 'admin'] as const;
export type GrantableRole = (typeof GRANTABLE_ROLES)[number];

export interface AdminUser {
  id: string;
  email: string;
  display_name: string | null;
  roles: string[];
  created_at: string;
}

export interface AdminUserPage {
  items: AdminUser[];
  next_cursor: string | null;
}

/** List accounts, newest first. */
export async function listUsers(
  options: { query?: string; cursor?: string; pageSize?: number } = {}
): Promise<AdminUserPage> {
  const params = new URLSearchParams();
  if (options.query) params.set('query', options.query);
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.pageSize !== undefined) params.set('page_size', String(options.pageSize));
  const query = params.toString();
  return apiFetch<AdminUserPage>(`/api/v1/admin/users${query ? `?${query}` : ''}`);
}

/** Grant a role. Returns the account with its roles after the change. */
export async function grantRole(userId: string, role: GrantableRole): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/api/v1/admin/users/${userId}/roles`, {
    method: 'POST',
    body: JSON.stringify({ role }),
  });
}

/**
 * Revoke a role. Returns the account with its roles after the change.
 *
 * @throws ApiError with `SELF_ADMIN_REVOCATION` when an admin revokes their own
 *   admin role — refused server-side, because there is no way back.
 */
export async function revokeRole(userId: string, role: string): Promise<AdminUser> {
  return apiFetch<AdminUser>(`/api/v1/admin/users/${userId}/roles/${role}`, {
    method: 'DELETE',
  });
}

/**
 * Invite someone to create an account.
 *
 * @throws ApiError when the address already has an account (422 from Supabase).
 */
export async function inviteUser(email: string): Promise<{ email: string; invited_at: string }> {
  return apiFetch<{ email: string; invited_at: string }>('/api/v1/admin/invites', {
    method: 'POST',
    body: JSON.stringify({ email }),
  });
}
