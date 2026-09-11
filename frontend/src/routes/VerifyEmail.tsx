import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import AuthCard from '../components/auth/AuthCard';
import { resendVerification } from '../services/session';
import Type from '../components/ui/Type';
import styles from '../components/auth/AuthCard.module.css';
import Button from '../components/ui/Button';

/**
 * "Check your inbox" interstitial (`/auth/verify-email`).
 *
 * Reached after registration, and from the unverified banner. The address rides
 * in the query string so the resend button has something to send to without a
 * session — an unverified account can sign in, but need not have.
 *
 * The resend result is deliberately uninformative: the backend answers the same
 * way whether or not the address is registered, so this reports "sent" and says
 * nothing that could confirm an account exists.
 */
export default function VerifyEmail() {
  const { t } = useTranslation(['auth']);
  const [params] = useSearchParams();
  const email = params.get('email') ?? '';
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleResend() {
    setBusy(true);
    try {
      await resendVerification(email);
    } catch {
      // Nothing useful to report: the endpoint cannot distinguish a missing
      // account from a delivered email, and neither should this page.
    }
    setSent(true);
    setBusy(false);
  }

  return (
    <AuthCard subtitle={t('auth:verifySubtitle')}>
      <Type variant="body-lg" as="p">
        {email ? t('auth:verifySentTo', { email }) : t('auth:verifySent')}
      </Type>
      <Type variant="body-sm" as="p" className={styles.hint}>
        {t('auth:verifyExplain')}
      </Type>

      {email && (
        <div className={styles.alternative}>
          {sent ? (
            <p className={styles.success} role="status">
              <Type variant="body-sm" as="span">
                {t('auth:verifyResent')}
              </Type>
            </p>
          ) : (
            <Button variant="secondary" fullWidth onClick={handleResend} disabled={busy}>
              <Type variant="label-md" as="span">
                {t('auth:resendVerification')}
              </Type>
            </Button>
          )}
        </div>
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
