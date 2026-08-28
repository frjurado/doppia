import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import Surface from '../ui/Surface';
import Type from '../ui/Type';
import styles from './UnverifiedBanner.module.css';

/**
 * Persistent notice for a signed-in account whose address is unconfirmed.
 *
 * An unverified account can sign in and read but cannot create content — the
 * service layer refuses those writes with `EMAIL_NOT_VERIFIED`. Without this
 * banner the refusal would arrive as a surprise at the moment of writing, so
 * the state is stated up front instead.
 *
 * Renders nothing for anonymous visitors and for verified accounts, so it is
 * safe to mount unconditionally in the shared layouts.
 */
export default function UnverifiedBanner() {
  const { t } = useTranslation(['auth']);
  const { status, user } = useAuth();

  if (status !== 'authenticated' || !user || user.email_verified) return null;

  return (
    <Surface layer="container-high" className={styles.banner} role="status">
      <Type variant="body-sm" as="span">
        {t('auth:unverifiedNotice')}{' '}
      </Type>
      <Link
        to={`/auth/verify-email?email=${encodeURIComponent(user.email)}`}
        className={styles.link}
      >
        <Type variant="body-sm" as="span">
          {t('auth:unverifiedAction')}
        </Type>
      </Link>
    </Surface>
  );
}
