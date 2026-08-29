import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../services/api';
import {
  GRANTABLE_ROLES,
  grantRole,
  inviteUser,
  listUsers,
  revokeRole,
  type AdminUser,
  type GrantableRole,
} from '../services/adminApi';
import { useAuth } from '../components/auth/AuthContext';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import styles from './Admin.module.css';

/**
 * User management (`/admin/users`) — Component 12 Step 10.
 *
 * This is what makes an invite-only launch operable without handing anyone the
 * Supabase dashboard: invite someone, see who exists, grant and revoke roles.
 *
 * Roles are shown as toggles rather than a form with a save button, because a
 * grant is a single discrete act with an audit trail behind it, not a field in
 * a draft. Each click is one request whose result replaces the row.
 *
 * The page is reachable only by admins, but that is enforced server-side by
 * `require_role(ADMIN)` on every call; the route gate here is presentation.
 */
export default function AdminUsers() {
  const { t } = useTranslation(['admin', 'errors']);
  const { user } = useAuth();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const [inviteEmail, setInviteEmail] = useState('');
  const [inviting, setInviting] = useState(false);

  const load = useCallback(
    async (query: string) => {
      setLoadError(null);
      try {
        const page = await listUsers({ query: query || undefined });
        setUsers(page.items);
        setNextCursor(page.next_cursor);
      } catch {
        setLoadError(t('errors:unexpected'));
      }
    },
    [t]
  );

  useEffect(() => {
    void load('');
  }, [load]);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    await load(search);
  }

  async function handleLoadMore() {
    if (!nextCursor) return;
    try {
      const page = await listUsers({ query: search || undefined, cursor: nextCursor });
      setUsers((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch {
      setLoadError(t('errors:unexpected'));
    }
  }

  async function handleToggleRole(target: AdminUser, role: GrantableRole) {
    setActionError(null);
    setNotice(null);
    setBusyUser(target.id);
    const held = target.roles.includes(role);
    try {
      const updated = held ? await revokeRole(target.id, role) : await grantRole(target.id, role);
      setUsers((current) => current.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      setActionError(
        err instanceof ApiError && err.code === 'SELF_ADMIN_REVOCATION'
          ? t('admin:selfDemotionRefused')
          : t('errors:unexpected')
      );
    } finally {
      setBusyUser(null);
    }
  }

  async function handleInvite(e: FormEvent) {
    e.preventDefault();
    setActionError(null);
    setNotice(null);
    setInviting(true);
    try {
      await inviteUser(inviteEmail.trim());
      setNotice(t('admin:inviteSent', { email: inviteEmail.trim() }));
      setInviteEmail('');
    } catch (err) {
      // A 422 here is almost always "this address already has an account",
      // which is worth saying plainly rather than as a generic failure.
      setActionError(
        err instanceof ApiError && err.status === 422
          ? t('admin:inviteRejected')
          : t('errors:unexpected')
      );
    } finally {
      setInviting(false);
    }
  }

  return (
    <Surface layer="base" className={styles.page}>
      <Type variant="display-sm" as="h1" className={styles.title}>
        {t('admin:usersTitle')}
      </Type>
      <Type variant="body-md" as="p" className={styles.lede}>
        {t('admin:usersLede')}
      </Type>

      <Surface layer="container-low" className={styles.panel}>
        <Type variant="label-md" as="h2" className={styles.sectionTitle}>
          {t('admin:inviteTitle')}
        </Type>
        <form onSubmit={handleInvite} className={styles.inlineForm} noValidate>
          <label htmlFor="invite-email" className={styles.sectionTitle}>
            <Type variant="label-md" as="span">
              {t('admin:inviteEmail')}
            </Type>
          </label>
          <input
            id="invite-email"
            type="email"
            required
            value={inviteEmail}
            onChange={(e) => setInviteEmail(e.target.value)}
            className={styles.input}
            disabled={inviting}
          />
          <button type="submit" className={styles.primaryButton} disabled={inviting}>
            <Type variant="label-md" as="span">
              {inviting ? t('admin:inviting') : t('admin:invite')}
            </Type>
          </button>
        </form>
        <Type variant="body-sm" as="p" className={styles.rowMeta}>
          {t('admin:inviteHint')}
        </Type>
      </Surface>

      <Surface layer="container-low" className={styles.panel}>
        <form onSubmit={handleSearch} className={styles.inlineForm} noValidate>
          <label htmlFor="user-search" className={styles.sectionTitle}>
            <Type variant="label-md" as="span">
              {t('admin:search')}
            </Type>
          </label>
          <input
            id="user-search"
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className={styles.input}
          />
          <button type="submit" className={styles.secondaryButton}>
            <Type variant="label-md" as="span">
              {t('admin:searchAction')}
            </Type>
          </button>
        </form>

        {notice && (
          <p className={styles.notice} role="status">
            <Type variant="body-sm" as="span">
              {notice}
            </Type>
          </p>
        )}
        {actionError && (
          <p className={styles.error} role="alert">
            <Type variant="body-sm" as="span">
              {actionError}
            </Type>
          </p>
        )}
        {loadError && (
          <p className={styles.error} role="alert">
            <Type variant="body-sm" as="span">
              {loadError}
            </Type>
          </p>
        )}

        {users.length === 0 && !loadError ? (
          <p className={styles.empty}>
            <Type variant="body-md" as="span">
              {t('admin:noUsers')}
            </Type>
          </p>
        ) : (
          <ul className={styles.rows}>
            {users.map((account) => (
              <li key={account.id} className={styles.row}>
                <span className={styles.rowMain}>
                  <Type variant="body-md" as="span">
                    {account.display_name || account.email}
                  </Type>
                  <Type variant="body-sm" as="span" className={styles.rowMeta}>
                    {account.display_name ? account.email : t('admin:noDisplayName')}
                    {account.id === user?.id ? ` · ${t('admin:you')}` : ''}
                  </Type>
                </span>
                <span className={styles.rowActions}>
                  {GRANTABLE_ROLES.map((role) => {
                    const held = account.roles.includes(role);
                    return (
                      <button
                        key={role}
                        type="button"
                        aria-pressed={held}
                        className={`${styles.roleChip}${held ? '' : ` ${styles.roleChipOff}`}`}
                        disabled={busyUser === account.id}
                        onClick={() => handleToggleRole(account, role)}
                      >
                        {t(`admin:role_${role}`)}
                      </button>
                    );
                  })}
                </span>
              </li>
            ))}
          </ul>
        )}

        {nextCursor && (
          <button type="button" className={styles.secondaryButton} onClick={handleLoadMore}>
            <Type variant="label-md" as="span">
              {t('admin:loadMore')}
            </Type>
          </button>
        )}
      </Surface>
    </Surface>
  );
}
