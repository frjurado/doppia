import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AuthCard from '../components/auth/AuthCard';
import { useAuth } from '../components/auth/AuthContext';
import { ApiError, apiFetch } from '../services/api';
import Type from '../components/ui/Type';
import styles from '../components/auth/AuthCard.module.css';

/**
 * Set a new password (`/auth/reset-password`).
 *
 * Three ways in, one form:
 *
 *  - a recovery link, carrying `?token_hash=…&type=recovery`;
 *  - an invitation, carrying `type=invite` — accepting an invite *is* choosing
 *    a first password, so it needs no separate page;
 *  - a signed-in user changing their password deliberately, with no token at
 *    all.
 *
 * The first two redeem their token through the backend, which establishes the
 * session and keeps the credential out of JavaScript. After that all three are
 * the same case: a caller with a session, which is itself the authorisation —
 * Supabase authorises the write with the caller's own bearer token, so there is
 * no role check on either side.
 */
export default function ResetPassword() {
  const { t } = useTranslation(['auth', 'errors']);
  const [params] = useSearchParams();
  const { status, redeemEmailLink } = useAuth();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [redeeming, setRedeeming] = useState(false);
  const [linkFailed, setLinkFailed] = useState(false);

  const tokenHash = params.get('token_hash');
  const linkType = params.get('type') ?? 'recovery';
  const invited = linkType === 'invite';

  // Tokens are single-use, so a second redemption always fails: guard against
  // StrictMode's double-invoked effects the same way the OAuth callback does.
  const attempted = useRef(false);

  useEffect(() => {
    if (!tokenHash || attempted.current) return;
    attempted.current = true;
    setRedeeming(true);
    redeemEmailLink(tokenHash, linkType)
      .catch(() => setLinkFailed(true))
      .finally(() => setRedeeming(false));
  }, [tokenHash, linkType, redeemEmailLink]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await apiFetch<void>('/api/v1/auth/password', {
        method: 'POST',
        body: JSON.stringify({ password }),
      });
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('errors:unexpected'));
    } finally {
      setSubmitting(false);
    }
  }

  const subtitle = invited ? t('auth:inviteSubtitle') : t('auth:resetSubtitle');

  if (redeeming || status === 'loading') {
    return (
      <AuthCard subtitle={subtitle}>
        <Type variant="body-lg" as="p">
          {t('auth:checkingLink')}
        </Type>
      </AuthCard>
    );
  }

  if (linkFailed || status === 'anonymous') {
    return (
      <AuthCard subtitle={subtitle}>
        <Type variant="body-lg" as="p" role="status">
          {t('auth:resetLinkExpired')}
        </Type>
        <p className={styles.note}>
          <Link to="/auth/forgot-password" className={styles.link}>
            <Type variant="body-sm" as="span">
              {t('auth:requestNewLink')}
            </Type>
          </Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard subtitle={subtitle}>
      {done ? (
        <>
          <Type variant="body-lg" as="p" role="status">
            {invited ? t('auth:inviteDone') : t('auth:resetDone')}
          </Type>
          <p className={styles.note}>
            <Link to="/" className={styles.link}>
              <Type variant="body-sm" as="span">
                {t('auth:continue')}
              </Type>
            </Link>
          </p>
        </>
      ) : (
        <form onSubmit={handleSubmit} className={styles.form} noValidate>
          {invited && (
            <Type variant="body-sm" as="p" className={styles.hint}>
              {t('auth:inviteExplain')}
            </Type>
          )}

          <div className={styles.field}>
            <label htmlFor="password" className={styles.label}>
              <Type variant="label-md" as="span">
                {invited ? t('auth:choosePassword') : t('auth:newPassword')}
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
              {submitting ? t('auth:saving') : t('auth:setPassword')}
            </Type>
          </button>
        </form>
      )}
    </AuthCard>
  );
}
