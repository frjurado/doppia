import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { signInWithPassword, AuthError } from '../services/supabaseAuth';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import styles from './Login.module.css';

/**
 * Login page.
 *
 * Email/password form backed by Supabase Auth. On success, the token is stored
 * by signInWithPassword() and the user is navigated to the corpus browser.
 *
 * No registration or password-reset UI: accounts are created by an admin via
 * the Supabase dashboard. This is intentional for Phase 1 (ADR-001).
 *
 * Design: centred card on cream background, input underline style per
 * docs/mockups/opus_urtext/DESIGN.md §5 "Input Fields".
 */
export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await signInWithPassword(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      const message =
        err instanceof AuthError ? err.message : 'An unexpected error occurred.';
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
              Open Music Analysis
            </Type>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className={styles.form} noValidate>

            <div className={styles.field}>
              <label htmlFor="email" className={styles.label}>
                <Type variant="label-md" as="span">Email</Type>
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
                <Type variant="label-md" as="span">Password</Type>
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
                <Type variant="body-sm" as="span">{error}</Type>
              </p>
            )}

            <button
              type="submit"
              className={styles.submitButton}
              disabled={submitting}
            >
              <Type variant="label-md" as="span">
                {submitting ? 'Signing in…' : 'Sign in'}
              </Type>
            </button>

          </form>

          {/* Footer note */}
          <p className={styles.note}>
            <Type variant="body-sm" as="span">
              Access is by invitation. Contact your administrator.
            </Type>
          </p>

        </Surface>
      </div>
    </Surface>
  );
}
