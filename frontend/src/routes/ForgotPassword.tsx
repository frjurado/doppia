import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AuthCard from '../components/auth/AuthCard';
import { AuthError, requestPasswordReset } from '../services/session';
import Type from '../components/ui/Type';
import styles from '../components/auth/AuthCard.module.css';

/**
 * Password-reset request (`/auth/forgot-password`).
 *
 * Reports success for any well-formed address, registered or not — the backend
 * answers the same way for both, so that this page cannot be used to discover
 * which addresses hold accounts. Only an unreachable auth service is surfaced
 * as a failure.
 */
export default function ForgotPassword() {
  const { t } = useTranslation(['auth', 'errors']);
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (err) {
      setError(
        err instanceof AuthError && err.code === 'AUTH_SERVICE_UNAVAILABLE'
          ? t('auth:serviceUnavailable')
          : t('errors:unexpected')
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth:forgotSubtitle')}>
      {sent ? (
        <Type variant="body-lg" as="p" role="status">
          {t('auth:resetSent', { email })}
        </Type>
      ) : (
        <form onSubmit={handleSubmit} className={styles.form} noValidate>
          <Type variant="body-sm" as="p" className={styles.hint}>
            {t('auth:forgotExplain')}
          </Type>

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

          {error && (
            <p className={styles.error} role="alert">
              <Type variant="body-sm" as="span">
                {error}
              </Type>
            </p>
          )}

          <button type="submit" className={styles.submitButton} disabled={submitting}>
            <Type variant="label-md" as="span">
              {submitting ? t('auth:sending') : t('auth:sendResetLink')}
            </Type>
          </button>
        </form>
      )}

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
