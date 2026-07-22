/**
 * Authentication context (Component 10 Step 7 — the ADR-016 revisit).
 *
 * Owns the session lifecycle the in-memory token store cannot express on its
 * own: bootstrapping a session after a page reload (the access token is gone
 * from memory, so it asks the backend to mint a new one from the refresh
 * cookie), scheduling silent refreshes before the access token expires, and
 * exposing `login` / `logout` to the UI.
 *
 * `status` drives route gating and nav rendering:
 *   - `loading`       — bootstrap refresh in flight; RequireAuth waits (no flash)
 *   - `authenticated` — a live access token is held
 *   - `anonymous`     — no session (bootstrap found no cookie, or logout)
 *
 * Local-dev bypass: in dev builds a `dev-token` in `localStorage[DEV_TOKEN_KEY]`
 * seeds the session directly, preserving the documented local workflow without
 * a Supabase round-trip. Production builds never read localStorage for tokens.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  clearToken,
  DEV_TOKEN_KEY,
  getAccessToken,
  setToken,
  subscribe,
} from '../../services/auth';
import {
  login as sessionLogin,
  logout as sessionLogout,
  refresh as sessionRefresh,
  type SessionResponse,
  type SessionUser,
} from '../../services/session';

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous';

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Renew this many ms before the access token expires, so a request never rides
// an already-expired token. Clamped so a short-lived token still refreshes.
const REFRESH_LEAD_MS = 60_000;
const MIN_REFRESH_DELAY_MS = 5_000;

/** Derive a placeholder user for the dev-token bypass (dev builds only). */
function devUser(token: string): SessionUser {
  const role = token === 'admin-token' ? 'admin' : 'editor';
  return { id: `dev-${role}`, email: `${role}@local`, role };
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<SessionUser | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bootstrapped = useRef(false);

  const clearTimer = useCallback(() => {
    if (refreshTimer.current !== null) {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
    }
  }, []);

  const goAnonymous = useCallback(() => {
    clearTimer();
    clearToken();
    setUser(null);
    setStatus('anonymous');
  }, [clearTimer]);

  // Forward-declared so applySession can schedule a refresh that itself calls
  // applySession on success.
  const applySessionRef = useRef<(s: SessionResponse) => void>(() => {});

  const scheduleRefresh = useCallback(
    (expiresInSeconds: number) => {
      clearTimer();
      const delay = Math.max(expiresInSeconds * 1000 - REFRESH_LEAD_MS, MIN_REFRESH_DELAY_MS);
      refreshTimer.current = setTimeout(async () => {
        try {
          applySessionRef.current(await sessionRefresh());
        } catch {
          goAnonymous();
        }
      }, delay);
    },
    [clearTimer, goAnonymous]
  );

  const applySession = useCallback(
    (session: SessionResponse) => {
      setToken(session.access_token);
      setUser(session.user);
      setStatus('authenticated');
      scheduleRefresh(session.expires_in);
    },
    [scheduleRefresh]
  );
  applySessionRef.current = applySession;

  // Bootstrap once on mount (guarded against StrictMode's double-invoke).
  useEffect(() => {
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    if (import.meta.env.DEV) {
      const devToken = localStorage.getItem(DEV_TOKEN_KEY);
      if (devToken) {
        setToken(devToken);
        setUser(devUser(devToken));
        setStatus('authenticated');
        return;
      }
    }

    let cancelled = false;
    (async () => {
      try {
        const session = await sessionRefresh();
        if (!cancelled) applySession(session);
      } catch {
        if (!cancelled) setStatus('anonymous');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [applySession]);

  // Reflect a token cleared outside React (apiFetch clearing on a 401) into
  // the auth status, so RequireAuth redirects on the next render.
  useEffect(() => {
    return subscribe(() => {
      if (getAccessToken() === null) {
        setStatus((prev) => (prev === 'authenticated' ? 'anonymous' : prev));
        setUser((prev) => (prev === null ? prev : null));
        clearTimer();
      }
    });
  }, [clearTimer]);

  useEffect(() => clearTimer, [clearTimer]);

  const login = useCallback(
    async (email: string, password: string) => {
      applySession(await sessionLogin(email, password));
    },
    [applySession]
  );

  const logout = useCallback(async () => {
    clearTimer();
    await sessionLogout();
    goAnonymous();
  }, [clearTimer, goAnonymous]);

  return (
    <AuthContext.Provider value={{ status, user, login, logout }}>{children}</AuthContext.Provider>
  );
}

/** Access the auth context; throws if used outside AuthProvider. */
// eslint-disable-next-line react-refresh/only-export-components
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (ctx === null) {
    throw new Error('useAuth must be used within an AuthProvider.');
  }
  return ctx;
}
