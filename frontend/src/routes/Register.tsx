import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AuthCard from '../components/auth/AuthCard';
import { AuthError, signUp } from '../services/session';
import { SELF_DECLARED_ROLES, type SelfDeclaredRole } from '../services/profileApi';
import Type from '../components/ui/Type';
import styles from '../components/auth/AuthCard.module.css';
import Button from '../components/ui/Button';

/**
 * Registration page (`/register`).
 *
 * At launch `REGISTRATION_MODE=invite`, so this form exists but the backend
 * refuses it with `REGISTRATION_CLOSED`; the page then explains that access is
 * by invitation rather than leaving the user staring at a failed submit. The
 * flag flips to `open` when Collections ship, at which point the same form
 * starts working with no code change (roles-and-permissions.md § 3).
 *
 * Success does **not** sign the user in: the account is unverified until the
 * confirmation email is followed, so this hands off to the interstitial.
 *
 * The self-description is optional and carries no permissions; it is asked here
 * only because registration is the natural moment, and is editable afterwards
 * on the profile page.
 */
export default function Register() {
  const { t } = useTranslation(['auth', 'errors']);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [declaredRole, setDeclaredRole] = useState<SelfDeclaredRole | ''>('');
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signUp(email, password, declaredRole || null);
      navigate(`/auth/verify-email?email=${encodeURIComponent(email)}`, { replace: true });
    } catch (err) {
      if (err instanceof AuthError && err.code === 'REGISTRATION_CLOSED') {
        setClosed(true);
      } else if (err instanceof AuthError && err.code === 'AUTH_SERVICE_UNAVAILABLE') {
        setError(t('auth:serviceUnavailable'));
      } else {
        setError(t('auth:registrationFailed'));
      }
      setSubmitting(false);
    }
  }

  if (closed) {
    return (
      <AuthCard subtitle={t('auth:registerSubtitle')}>
        <Type variant="body-lg" as="p" role="status">
          {t('auth:registrationClosed')}
        </Type>
        <p className={styles.note}>
          <Link to="/login" className={styles.link}>
            <Type variant="body-sm" as="span">
              {t('auth:backToSignIn')}
            </Type>
          </Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard subtitle={t('auth:registerSubtitle')}>
      <form onSubmit={handleSubmit} className={styles.form} noValidate>
        <div className={styles.field}>
          <label htmlFor="email" className={styles.label}>
            <Type variant="label-md" as="span">
              {t('auth:email')}
            </Type>
          </label>
          <input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={styles.input}
            disabled={submitting}
          />
        </div>

        <div className={styles.field}>
          <label htmlFor="password" className={styles.label}>
            <Type variant="label-md" as="span">
              {t('auth:password')}
            </Type>
          </label>
          <input
            id="password"
            type="password"
            autoComplete="new-password"
            required
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={styles.input}
            disabled={submitting}
            aria-describedby="password-hint"
          />
          <Type variant="body-sm" as="p" id="password-hint" className={styles.hint}>
            {t('auth:passwordHint')}
          </Type>
        </div>

        <div className={styles.field}>
          <label htmlFor="declared-role" className={styles.label}>
            <Type variant="label-md" as="span">
              {t('auth:selfDeclaredRole')}
            </Type>
          </label>
          <select
            id="declared-role"
            value={declaredRole}
            onChange={(e) => setDeclaredRole(e.target.value as SelfDeclaredRole | '')}
            className={styles.input}
            disabled={submitting}
          >
            <option value="">{t('auth:preferNotToSay')}</option>
            {SELF_DECLARED_ROLES.map((role) => (
              <option key={role} value={role}>
                {t(`auth:role_${role}`)}
              </option>
            ))}
          </select>
        </div>

        {error && (
          <p className={styles.error} role="alert">
            <Type variant="body-sm" as="span">
              {error}
            </Type>
          </p>
        )}

        <Button
          type="submit"
          variant="primary"
          fullWidth
          className={styles.submitButton}
          disabled={submitting}
        >
          <Type variant="label-md" as="span">
            {submitting ? t('auth:registering') : t('auth:register')}
          </Type>
        </Button>
      </form>

      <p className={styles.note}>
        <Type variant="body-sm" as="span">
          {t('auth:haveAccount')}{' '}
        </Type>
        <Link to="/login" className={styles.link}>
          <Type variant="body-sm" as="span">
            {t('auth:signIn')}
          </Type>
        </Link>
      </p>
    </AuthCard>
  );
}
