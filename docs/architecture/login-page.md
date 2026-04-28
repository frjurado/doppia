# Login Page — Implementation Spec

## Scope

A `/login` route with an email/password form connected to Supabase Auth. After successful login the access token is stored and the user is redirected to `/`. All existing routes become protected: unauthenticated users are redirected to `/login`. No registration, no forgot-password, no token refresh — accounts are managed via the Supabase dashboard (admin-only in Phase 1, per ADR-001).

---

## Files

| File | Action |
|---|---|
| `frontend/src/services/supabaseAuth.ts` | Create |
| `frontend/src/routes/Login.tsx` | Create |
| `frontend/src/routes/Login.module.css` | Create |
| `frontend/src/components/auth/RequireAuth.tsx` | Create |
| `frontend/src/App.tsx` | Modify |
| `frontend/.env.example` | Modify |

---

## Environment variables

Add to `frontend/.env.example`:

```
VITE_SUPABASE_URL=https://<project-ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon-key>
```

The anon key is a public key — it is designed to be embedded in frontend code. It does not grant write access on its own; that requires a valid JWT.

---

## `src/services/supabaseAuth.ts`

Do **not** add `@supabase/supabase-js` to `package.json`. Call the Supabase Auth REST endpoint directly. The existing `auth.ts` comment anticipates a "proper Supabase client in Phase 2" — Phase 1 uses direct REST calls to avoid a large dependency that will be replaced.

```typescript
/**
 * Supabase Auth REST client for Phase 1.
 *
 * Calls the Supabase Auth v1 token endpoint directly rather than using the
 * Supabase JS client. Phase 2 will swap this for @supabase/supabase-js;
 * the interface is kept minimal to make that swap localised to this file
 * and auth.ts.
 *
 * Supabase anon key is public by design — it is safe to embed in the
 * frontend build. It does not grant write access without a valid JWT.
 */

import { setToken } from './auth';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

export class AuthError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Sign in with email and password via the Supabase Auth REST API.
 * On success, stores the access token and returns it.
 * On failure, throws AuthError with a human-readable message.
 */
export async function signInWithPassword(
  email: string,
  password: string,
): Promise<string> {
  const url = `${SUPABASE_URL}/auth/v1/token?grant_type=password`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new AuthError('NETWORK_ERROR', 'Could not reach authentication service.');
  }

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Supabase returns error_description for auth failures
    const message =
      body?.error_description ?? body?.message ?? 'Authentication failed.';
    throw new AuthError(body?.error ?? 'AUTH_ERROR', message);
  }

  const token: string = body.access_token;
  if (!token) {
    throw new AuthError('MISSING_TOKEN', 'No access token in response.');
  }

  setToken(token);
  return token;
}

/**
 * Sign out: clears the locally stored token.
 * Does not invalidate the token server-side (acceptable for Phase 1).
 */
export { clearToken as signOut } from './auth';
```

---

## `src/components/auth/RequireAuth.tsx`

A thin wrapper that redirects unauthenticated users to `/login`. Wrap all protected routes with it in `App.tsx`.

```typescript
import { Navigate } from 'react-router-dom';
import { getSession } from '../../services/auth';

interface RequireAuthProps {
  children: React.ReactNode;
}

/**
 * Redirects to /login if no session token is present.
 * Wrap any route that requires authentication.
 *
 * Phase 1: checks localStorage for a token. No token expiry validation —
 * expired tokens surface as 401s from the API, at which point the user
 * should clear the token and log in again. Token refresh is deferred to
 * Phase 2.
 *
 * getSession() reads from localStorage synchronously, so there is no async
 * loading state and no flash of the protected page.
 */
export default function RequireAuth({ children }: RequireAuthProps) {
  const session = getSession();
  if (!session) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}
```

---

## `src/App.tsx` — modifications

```typescript
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import RequireAuth from './components/auth/RequireAuth';
import Login from './routes/Login';
import CorpusBrowser from './routes/CorpusBrowser';
import ScoreViewerStub from './routes/ScoreViewerStub';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <CorpusBrowser />
            </RequireAuth>
          }
        />
        <Route
          path="/tag/:movementId"
          element={
            <RequireAuth>
              <ScoreViewerStub />
            </RequireAuth>
          }
        />
      </Routes>
    </BrowserRouter>
  );
}
```

---

## `src/routes/Login.tsx`

```typescript
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
```

---

## `src/routes/Login.module.css`

```css
/* Full-page cream canvas */
.page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-8);
}

/* Centred card — no border, tonal depth only */
.card {
  width: 100%;
  max-width: 400px;
}

.cardInner {
  padding: var(--spacing-10) var(--spacing-8);
}

/* Header block */
.header {
  margin-bottom: var(--spacing-10);
}

.title {
  color: var(--color-primary);
  margin: 0 0 var(--spacing-2);
}

.subtitle {
  color: var(--color-on-surface-variant);
  margin: 0;
}

/* Form layout */
.form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-6);
}

/* Input field: underline style per design system §5 */
.field {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-2);
}

.label {
  color: var(--color-primary);
}

.input {
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--color-outline);
  border-radius: 0;           /* non-negotiable */
  padding: var(--spacing-2) 0;
  font-family: var(--font-serif);
  font-size: 1rem;
  color: var(--color-on-background);
  outline: none;
  width: 100%;
}

.input:focus {
  border-bottom-color: var(--color-primary);
}

.input:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Error message */
.error {
  /* --color-error is not in the token set yet; add it when the
     error-handling architecture is addressed (step 7 of the sequence). */
  color: #b00020;
  margin: 0;
}

/* Primary CTA: gradient per design system §5 "Buttons" */
.submitButton {
  margin-top: var(--spacing-2);
  padding: var(--spacing-3) var(--spacing-6);
  background: linear-gradient(
    135deg,
    var(--color-primary) 0%,
    var(--color-primary-container) 100%
  );
  color: var(--color-on-primary);
  border: none;
  border-radius: 0;           /* non-negotiable */
  cursor: pointer;
  width: 100%;
  text-align: center;
}

.submitButton:hover:not(:disabled) {
  opacity: 0.9;
}

.submitButton:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.submitButton:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 2px;
}

/* Footer note */
.note {
  margin: var(--spacing-8) 0 0;
  color: var(--color-on-surface-variant);
  text-align: center;
}
```

---

## Design decisions

**Input underline only.** DESIGN.md §5 specifies "avoid the box — use a single 1px underline of `outline`." The bottom border on inputs is the deliberate exception to the no-border rule; it applies to form inputs specifically and is explicitly called out in the design spec.

**No `@supabase/supabase-js`.** The dependency adds ~100 KB gzipped and token-refresh logic that will be replaced wholesale in Phase 2. Direct REST calls keep the bundle small and the swap surface minimal.

**No token refresh.** When the Supabase-issued token expires (default 1 hour), the next API call returns 401. The user will see an API error and must log in again. Acceptable for Phase 1 with a small internal team. Phase 2 adds refresh via the Supabase JS client.

**No server-side sign-out.** `signOut` clears localStorage only. The token remains valid server-side until expiry. Token revocation requires a backend blocklist, which is Phase 2 scope.

**`noValidate` on the form.** Disables browser-native validation UI (which cannot match the design system) in favour of the error message returned from the Supabase API, which is more precise.

**`--color-error` not yet tokenised.** The error red (`#b00020`) is inline pending the error-handling architecture pass (step 7 of the current sequence), which is the right moment to add it to `tokens.css` alongside the typed exception work.
