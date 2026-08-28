import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../components/auth/AuthContext';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';

/**
 * OAuth return address (`/auth/callback`).
 *
 * The last leg of the brokered dance: Supabase sends the browser back here with
 * `?code=`, and this route hands that code to the backend, which exchanges it
 * against the PKCE verifier in its HttpOnly cookie. No token is ever parsed
 * here — the page only carries a code across, then gets out of the way.
 *
 * Presentation is deliberately minimal: Component 12 Step 5 owns the
 * registration UI and will dress this (and the provider button on /login)
 * properly. What matters now is that the round trip completes.
 */
export default function AuthCallback() {
  const { t } = useTranslation(['auth', 'errors']);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { completeOAuthLogin } = useAuth();
  const [error, setError] = useState<string | null>(null);
  // StrictMode double-invokes effects in development; the authorization code is
  // single-use, so a second exchange would fail against a consumed code.
  const attempted = useRef(false);

  useEffect(() => {
    if (attempted.current) return;
    attempted.current = true;

    const code = params.get('code');
    const providerError = params.get('error_description') ?? params.get('error');
    if (providerError) {
      setError(providerError);
      return;
    }
    if (!code) {
      setError(t('errors:unexpected'));
      return;
    }
    completeOAuthLogin(code)
      .then(() => navigate('/', { replace: true }))
      .catch(() => setError(t('auth:oauthFailed')));
  }, [params, completeOAuthLogin, navigate, t]);

  return (
    <Surface layer="base">
      <Type variant="body-md" as="p" role={error ? 'alert' : undefined}>
        {error ?? t('auth:completingSignIn')}
      </Type>
    </Surface>
  );
}
