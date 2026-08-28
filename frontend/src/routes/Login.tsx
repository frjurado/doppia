import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../components/auth/AuthContext';
import AuthCard from '../components/auth/AuthCard';
import { AuthError, startOAuth } from '../services/session';
import Type from '../components/ui/Type';
import styles from '../components/auth/AuthCard.module.css';

/**
 * Login page.
 *
 * Email/password form backed by the backend auth router (Component 10 Step 7).
 * On success, `useAuth().login` establishes the session (access token in memory,
 * refresh token in an HttpOnly cookie) and the user is navigated to the corpus
 * browser.
 *
 * Google is offered as a secondary path: a full-page navigation to the URL the
 * backend returns, never a fetch (see ADR-035's OAuth amendment). Registration
 * and password reset live on their own routes (Component 12 Step 5); the
 * invitation note stays because `REGISTRATION_MODE=invite` is still the launch
 * posture.
 *
 * Design: shared `AuthCard` shell, input underline style per
 * docs/mockups/opus_urtext/DESIGN.md §5 "Input Fields".
 */
export default function Login() {
  const { t } = useTranslation(['auth', 'errors']);
  const navigate = useNavigate();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      // A wrong password (INVALID_CREDENTIALS) and an unavailable auth service
      // (503) carry backend English text; show a translated string for the
      // former and the generic unexpected-error message otherwise.
      let message = t('errors:unexpected');
      if (err instanceof AuthError) {
        message =
          err.code === 'INVALID_CREDENTIALS'
            ? t('auth:invalidCredentials')
            : err.code === 'AUTH_SERVICE_UNAVAILABLE'
              ? t('auth:serviceUnavailable')
              : err.message;
      }
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleGoogle() {
    setError(null);
    setSubmitting(true);
    try {
      const { authorize_url } = await startOAuth('google');
      // A navigation, not a fetch: the CSP has no *.supabase.co in connect-src
      // and does not need one. No `finally` here — the page is leaving.
      window.location.assign(authorize_url);
    } catch (err) {
      setError(
        err instanceof AuthError && err.code === 'AUTH_SERVICE_UNAVAILABLE'
          ? t('auth:serviceUnavailable')
          : t('errors:unexpected')
      );
      setSubmitting(false);
    }
  }

  return (
    <AuthCard subtitle={t('auth:subtitle')}>
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
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
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
            {submitting ? t('auth:signingIn') : t('auth:signIn')}
          </Type>
        </button>
      </form>

      <div className={styles.alternative}>
        <Type variant="label-sm" as="span" className={styles.alternativeLabel}>
          {t('auth:orContinueWith')}
        </Type>
        <button
          type="button"
          className={styles.secondaryButton}
          onClick={handleGoogle}
          disabled={submitting}
        >
          <Type variant="label-md" as="span">
            {t('auth:continueWithGoogle')}
          </Type>
        </button>
      </div>

      <p className={styles.noteRow}>
        <Link to="/auth/forgot-password" className={styles.link}>
          <Type variant="body-sm" as="span">
            {t('auth:forgotPassword')}
          </Type>
        </Link>
      </p>

      <p className={styles.note}>
        <Type variant="body-sm" as="span">
          {t('auth:invitationNote')}{' '}
        </Type>
        <Link to="/register" className={styles.link}>
          <Type variant="body-sm" as="span">
            {t('auth:register')}
          </Type>
        </Link>
      </p>
    </AuthCard>
  );
}
