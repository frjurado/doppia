import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../components/auth/AuthContext';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';

/**
 * Where sign-in flows come back to (`/auth/callback`).
 *
 * Two kinds of arrival, one destination:
 *
 *  - **OAuth** — Supabase appends `?code=`, which the backend exchanges against
 *    the PKCE verifier in its HttpOnly cookie.
 *  - **Email confirmation** — the template appends `?token_hash=…&type=signup`,
 *    which the backend redeems server-side.
 *
 * Neither hands a token to this page: it carries an opaque value across and
 * gets out of the way. Presentation is deliberately minimal — this screen
 * exists for the half-second before the redirect.
 */
export default function AuthCallback() {
  const { t } = useTranslation(['auth', 'errors']);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { completeOAuthLogin, redeemEmailLink } = useAuth();
  const [error, setError] = useState<string | null>(null);
  // StrictMode double-invokes effects in development; both an authorization
  // code and a token hash are single-use, so a second attempt would fail
  // against a value the first one consumed.
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const providerError = params.get('error_description') ?? params.get('error');
    if (providerError) {
      setError(providerError);
      return;
    }

    const code = params.get('code');
    const tokenHash = params.get('token_hash');
    const linkType = params.get('type') ?? 'signup';

    const establish = tokenHash
      ? redeemEmailLink(tokenHash, linkType)
      : code
        ? completeOAuthLogin(code)
        : null;

    if (establish === null) {
      setError(t('errors:unexpected'));
      return;
    }

    establish
      .then(() => navigate('/', { replace: true }))
      .catch(() => setError(t('auth:oauthFailed')));
  }, [params, completeOAuthLogin, redeemEmailLink, navigate, t]);

  return (
    <Surface layer="base">
      <Type variant="body-md" as="p" role={error ? 'alert' : undefined}>
        {error ?? t('auth:completingSignIn')}
      </Type>
    </Surface>
  );
}
