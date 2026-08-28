import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AuthCard from '../components/auth/AuthCard';
import { AuthError, signUp } from '../services/session';
import Type from '../components/ui/Type';
import styles from '../components/auth/AuthCard.module.css';

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
 */
export default function Register() {
  const { t } = useTranslation(['auth', 'errors']);
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signUp(email, password);
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
        <Type variant="body-md" as="p" role="status">
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

        {error && (
          <p className={styles.error} role="alert">
            <Type variant="body-sm" as="span">
              {error}
            </Type>
          </p>
        )}

        <button type="submit" className={styles.submitButton} disabled={submitting}>
          <Type variant="label-md" as="span">
            {submitting ? t('auth:registering') : t('auth:register')}
          </Type>
        </button>
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
