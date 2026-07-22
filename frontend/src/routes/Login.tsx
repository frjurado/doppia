import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../components/auth/AuthContext';
import { AuthError } from '../services/session';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import styles from './Login.module.css';

/**
 * Login page.
 *
 * Email/password form backed by the backend auth router (Component 10 Step 7).
 * On success, `useAuth().login` establishes the session (access token in memory,
 * refresh token in an HttpOnly cookie) and the user is navigated to the corpus
 * browser.
 *
 * No registration or password-reset UI: accounts are created by an admin via
 * the Supabase dashboard. This is intentional for Phase 1 (ADR-001).
 *
 * Design: centred card on cream background, input underline style per
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

  return (
    <Surface layer="base" className={styles.page}>
      <div className={styles.card}>
        <Surface layer="container-low" className={styles.cardInner}>
          {/* Header */}
          <div className={styles.header}>
            <Type variant="display-sm" as="h1" className={styles.title}>
              Doppia
            </Type>
            <Type variant="label-md" as="p" className={styles.subtitle}>
              {t('auth:subtitle')}
            </Type>
          </div>

          {/* Form */}
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

          {/* Footer note */}
          <p className={styles.note}>
            <Type variant="body-sm" as="span">
              {t('auth:invitationNote')}
            </Type>
          </p>
        </Surface>
      </div>
    </Surface>
  );
}
