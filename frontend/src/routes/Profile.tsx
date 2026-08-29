import { useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../services/api';
import {
  downloadExport,
  getProfile,
  SELF_DECLARED_ROLES,
  updateProfile,
  type Profile as ProfileData,
  type SelfDeclaredRole,
} from '../services/profileApi';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import styles from './Profile.module.css';

/**
 * Account profile (`/profile`), reached from the account menu.
 *
 * Three things a user owns about themselves: the display name, an optional
 * self-description, and consent for the reading history. The granted roles are
 * shown but not editable — that is an admin action (Step 10), and putting them
 * on the same page as the self-description is exactly why the two are labelled
 * so differently.
 *
 * The reading-history toggle lands before the history it governs (Step 7): the
 * consent has to exist before anything could be recorded under it, and it
 * defaults to off.
 *
 * The data export (Step 8) sits at the foot of the page as a secondary action:
 * it is a right rather than a routine edit, and it is what makes the toggle
 * above it meaningful — a user can see exactly what has been recorded.
 */
export default function Profile() {
  const { t } = useTranslation(['profile', 'errors']);
  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  const [displayName, setDisplayName] = useState('');
  const [declaredRole, setDeclaredRole] = useState<SelfDeclaredRole | ''>('');
  const [optIn, setOptIn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getProfile()
      .then((loaded) => {
        if (cancelled) return;
        setProfile(loaded);
        setDisplayName(loaded.display_name ?? '');
        setDeclaredRole(loaded.self_declared_role ?? '');
        setOptIn(loaded.reading_history_opt_in);
      })
      .catch(() => {
        if (!cancelled) setLoadError(t('errors:unexpected'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);
    setSaving(true);
    try {
      const updated = await updateProfile({
        // An empty select means "prefer not to say", which is a null rather
        // than another vocabulary entry.
        display_name: displayName.trim() || null,
        self_declared_role: declaredRole || null,
        reading_history_opt_in: optIn,
      });
      setProfile(updated);
      setSaved(true);
    } catch (err) {
      setSaveError(
        err instanceof ApiError && err.code === 'EMAIL_NOT_VERIFIED'
          ? t('profile:unverifiedBlocked')
          : t('errors:unexpected')
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleExport() {
    setExportError(null);
    setExporting(true);
    try {
      await downloadExport();
    } catch {
      setExportError(t('errors:unexpected'));
    } finally {
      setExporting(false);
    }
  }

  if (loadError) {
    return (
      <Surface layer="base" className={styles.page}>
        <p className={styles.error} role="alert">
          <Type variant="body-md" as="span">
            {loadError}
          </Type>
        </p>
      </Surface>
    );
  }

  if (!profile) return null;

  return (
    <Surface layer="base" className={styles.page}>
      <Type variant="display-sm" as="h1" className={styles.title}>
        {t('profile:title')}
      </Type>

      <Surface layer="container-low" className={styles.panel}>
        <div className={styles.readonly}>
          <Type variant="label-md" as="span" className={styles.label}>
            {t('profile:email')}
          </Type>
          <Type variant="body-md" as="span">
            {profile.email}
          </Type>
          {!profile.email_verified && (
            <Type variant="body-sm" as="span" className={styles.hint}>
              {t('profile:emailUnverified')}
            </Type>
          )}
        </div>

        <div className={styles.readonly}>
          <Type variant="label-md" as="span" className={styles.label}>
            {t('profile:grantedRoles')}
          </Type>
          <Type variant="body-md" as="span">
            {profile.roles.length > 0 ? profile.roles.join(' · ') : t('profile:noGrantedRoles')}
          </Type>
          <Type variant="body-sm" as="span" className={styles.hint}>
            {t('profile:grantedRolesHint')}
          </Type>
        </div>

        <form onSubmit={handleSubmit} className={styles.form} noValidate>
          <div className={styles.field}>
            <label htmlFor="display-name" className={styles.label}>
              <Type variant="label-md" as="span">
                {t('profile:displayName')}
              </Type>
            </label>
            <input
              id="display-name"
              type="text"
              maxLength={120}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className={styles.input}
              disabled={saving}
            />
          </div>

          <div className={styles.field}>
            <label htmlFor="declared-role" className={styles.label}>
              <Type variant="label-md" as="span">
                {t('profile:selfDeclaredRole')}
              </Type>
            </label>
            <select
              id="declared-role"
              value={declaredRole}
              onChange={(e) => setDeclaredRole(e.target.value as SelfDeclaredRole | '')}
              className={styles.input}
              disabled={saving}
            >
              <option value="">{t('profile:preferNotToSay')}</option>
              {SELF_DECLARED_ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(`profile:role_${role}`)}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.toggleField}>
            <input
              id="reading-history"
              type="checkbox"
              checked={optIn}
              onChange={(e) => setOptIn(e.target.checked)}
              disabled={saving}
            />
            <label htmlFor="reading-history">
              <Type variant="body-md" as="span">
                {t('profile:readingHistory')}
              </Type>
            </label>
            <Type variant="body-sm" as="p" className={styles.hint}>
              {t('profile:readingHistoryHint')}
            </Type>
          </div>

          {saveError && (
            <p className={styles.error} role="alert">
              <Type variant="body-sm" as="span">
                {saveError}
              </Type>
            </p>
          )}
          {saved && (
            <p className={styles.saved} role="status">
              <Type variant="body-sm" as="span">
                {t('profile:saved')}
              </Type>
            </p>
          )}

          <button type="submit" className={styles.submitButton} disabled={saving}>
            <Type variant="label-md" as="span">
              {saving ? t('profile:saving') : t('profile:save')}
            </Type>
          </button>
        </form>
      </Surface>

      <Surface layer="container-low" className={styles.panel}>
        <div className={styles.readonly}>
          <Type variant="label-md" as="span" className={styles.label}>
            {t('profile:yourData')}
          </Type>
          <Type variant="body-sm" as="p" className={styles.hint}>
            {t('profile:exportHint')}
          </Type>
        </div>
        {exportError && (
          <p className={styles.error} role="alert">
            <Type variant="body-sm" as="span">
              {exportError}
            </Type>
          </p>
        )}
        <button
          type="button"
          onClick={handleExport}
          className={styles.secondaryButton}
          disabled={exporting}
        >
          <Type variant="label-md" as="span">
            {exporting ? t('profile:exporting') : t('profile:export')}
          </Type>
        </button>
      </Surface>
    </Surface>
  );
}
