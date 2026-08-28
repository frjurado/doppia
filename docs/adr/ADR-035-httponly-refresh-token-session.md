# ADR-035 — HttpOnly Refresh-Token Session (extends ADR-016)

**Status:** Accepted
**Date:** 2026-07-21
**Extends:** [ADR-016 — JWT Browser Storage](ADR-016-jwt-browser-storage.md)

---

## Context

ADR-016 kept the Supabase access token in `localStorage` as an **explicit
Phase-1 exception**, on the record that it "must be revisited before Phase 2
public launch." Component 10 opens the public read path and, with it, the
threat model ADR-016 named: anonymous visitors, public URLs, and (from
Component 11 onward) rendered glossary/blog content — the XSS surface that makes
a `localStorage` token dangerous. This ADR is that revisit.

Two options were carried into Phase 2 by ADR-016's "Consequences": a
**backend-issued HttpOnly cookie**, or adopting the **full Supabase JS client**
(which manages its own token storage and refresh). Both retire the raw token
from `localStorage`. The confirmation with Francisco (2026-07-16) chose the
HttpOnly cookie.

Deployment topology settles a question the cookie choice depends on: the SPA and
the API are served from **one Fly app** — the Docker build copies the built
frontend into the API image and FastAPI serves it (`deployment.md`). Frontend
and API are therefore **same-origin** in staging/production, so a same-site
cookie is delivered on every request to the API without cross-site cookie
machinery.

---

## Decision

The session is split across two credentials with different lifetimes and
storage:

1. **Access token — in memory.** A module-level variable in
   `frontend/src/services/auth.ts`; never written to `localStorage` or
   `sessionStorage`. It is attached as the `Authorization: Bearer` header on API
   calls and is gone on reload. Lifetime ~1h (Supabase default).
2. **Refresh token — HttpOnly cookie.** Set by the backend, invisible to
   JavaScript, so an XSS foothold cannot exfiltrate the long-lived credential.

The credential exchange moves **server-side**. The browser no longer calls
Supabase Auth directly; it calls our own `/api/v1/auth` router, which proxies the
Supabase grant and owns the cookie:

- `POST /api/v1/auth/login` — password grant → sets the refresh cookie, returns
  the access token + user in the body.
- `POST /api/v1/auth/refresh` — reads the cookie, runs the refresh grant,
  **rotates** the cookie, returns a fresh access token. The SPA calls this on
  load (to restore a session after reload) and ~60s before access-token expiry
  (silent renewal, scheduled by `AuthProvider`).
- `POST /api/v1/auth/logout` — revokes the session at Supabase (best-effort,
  using a fresh access token minted from the cookie so it works even when the
  in-memory token has expired) and clears the cookie.

**Cookie attributes:** `HttpOnly`; `Secure` (except `ENVIRONMENT=local`, where
the SPA is plain HTTP); `SameSite=Lax`; `Path=/api/v1/auth`; `Max-Age` 30 days.

**CSRF posture.** The cookie is `SameSite=Lax` **and** path-scoped to
`/api/v1/auth`, so it is sent only on same-site requests to the three auth
endpoints and never on a cross-site POST. Every other endpoint authenticates
with the bearer access token in the `Authorization` header — a credential a
cross-origin page cannot read — not with the cookie, so there is no
cookie-driven state change to forge. No separate CSRF token is introduced; if a
future endpoint ever authenticates state changes via the cookie, a double-submit
token must be added then.

**Local-dev bypass is preserved, dev-only.** In dev builds (`import.meta.env.DEV`)
`AuthProvider` still seeds the in-memory token from a `dev-token` placed in
`localStorage['doppia_access_token']`, keeping the documented local workflow
without a Supabase round-trip. Production builds never read `localStorage` for a
token. This is a local convenience (no adversary, no public URL — the same
reasoning ADR-016 applied to all of Phase 1), not a reopening of the exception.

---

## Consequences

- **ADR-016's `localStorage` exception is closed.** The raw access token is no
  longer persisted in the browser; the refresh token lives only in the HttpOnly
  cookie. ADR-016 is updated to point here.
- **New backend surface:** `services/supabase_auth.py` (the server-side Supabase
  Auth REST client) and `api/routes/auth.py` (the cookie-owning router). Session
  state stays in our backend rather than a third-party SDK — the reason the
  cookie was chosen over the Supabase JS client.
- **Session survives reload** via the bootstrap refresh, and **expiry is
  handled** by scheduled silent refresh rather than a hard logout at the hour
  boundary (the Component 9 `exp` patch was not a refresh flow).
- **A reload shows a brief `loading` state** while the bootstrap refresh runs;
  `RequireAuth` waits on it rather than redirecting, so a logged-in user is not
  bounced to `/login` on reload.
- **`supabaseAuth.ts` (the browser-direct Supabase call) is removed**; login
  flows through the backend.
- **The hard consumer is Component 12 registration, not the Component 10
  anonymous read path.** This was built in Component 10 because it shares the
  auth middleware the PyJWT migration (Step 6) already rewrote; had it
  threatened the Component 10 timeline it would have moved to the front of
  Component 12.

---

## Alternatives rejected

**Full Supabase JS client.** Retires `localStorage` too, but moves session state
into a third-party SDK and enlarges the frontend surface, for the same
token-retirement benefit. Keeping session state in our own backend (a small
router plus the cookie) is a smaller, more controllable surface.

**In-memory access token with no server session.** Loses the session on every
reload with no way to restore it (Supabase's refresh flow needs the refresh
token, which we deliberately keep out of JavaScript). The HttpOnly-cookie
refresh endpoint is what makes reload-survival possible without exposing the
long-lived credential.

**`SameSite=Strict`.** Marginally stronger than `Lax` for our usage (the refresh
XHR is always same-site), but `Lax` is the conventional default with no downside
here and avoids surprising behaviour if a future flow relies on a top-level
navigation. The path scope and header-bearer primary auth already carry the CSRF
guarantee.

---

## Amendment — OAuth through the proxy (2026-08-28, Component 12 Step 4)

ADR-035 removed all direct browser↔Supabase traffic, which left an open
question the Component 12 plan flagged as the one genuinely untested path in
the auth design: how a third-party sign-in works when the browser is not
allowed to talk to Supabase. This amendment records the answer. **The decision
is unchanged** — the refresh token still never reaches JavaScript — and the
flow below is an application of it, not an exception to it.

### The flow

1. `POST /api/v1/auth/oauth/google/start` mints a PKCE verifier/challenge pair,
   puts the **verifier** in an HttpOnly cookie (`doppia_pkce`, 10 minutes, same
   path scope and attributes as the refresh cookie), and returns Supabase's
   authorize URL carrying only the **challenge**.
2. The SPA *navigates* to that URL (`location.assign`). Supabase redirects to
   Google, Google returns to Supabase's own callback, and Supabase redirects
   back to `PUBLIC_APP_URL/auth/callback?code=…`.
3. The SPA posts the code to `POST /api/v1/auth/oauth/callback`. The backend
   reads the verifier from the cookie, completes the exchange server-side, and
   sets the refresh cookie exactly as password login does.

### Why this needs no CSP change

The authorize URL is reached by **navigation, not fetch**. `connect-src` governs
fetch/XHR/WebSocket and has no `*.supabase.co` entry — correctly, and it still
does not need one. `form-action 'self'` governs form submissions, not
`location.assign`. The browser therefore never makes a *request* to Supabase
from our origin; it simply leaves.

### Why PKCE rather than the implicit flow

Supabase's implicit flow returns the tokens in the URL **fragment**, which puts
a refresh token directly into JavaScript's hands — the precise thing this ADR
exists to prevent. PKCE returns an authorization code instead, and a code is
useless without the verifier. Holding the verifier server-side in an HttpOnly
cookie is what makes the brokered flow safe to run through a proxy at all.

### The return address is server-side config, not a parameter

Probing Supabase's authorize endpoint (2026-08-28) established that it **does
not validate `redirect_to`** at hand-off: a request naming an unrelated domain
was forwarded to Google without complaint. Supabase enforces its Redirect URLs
allowlist later, at its own callback. Accepting a caller-supplied return URL
would therefore have made `/oauth/{provider}/start` an open redirect wearing an
OAuth flow as a disguise, so the value comes from `PUBLIC_APP_URL` and the
endpoint takes no redirect parameter at all. Outside local development an unset
`PUBLIC_APP_URL` is a hard 503, not a localhost fallback.

### Consequences

- One more short-lived cookie, with the same properties as the refresh cookie
  and a much shorter life. It is cleared on success *and* on every failure: the
  verifier is single-use, so a failed exchange cannot be retried with it.
- The provider set is closed (`SUPPORTED_OAUTH_PROVIDERS`) because the provider
  name is interpolated into the authorize URL.
- The SPA's `/auth/callback` route must guard against React StrictMode's
  double-invoked effects — the authorization code is single-use, and a second
  exchange fails against a consumed code.

---

## Amendment — email links (2026-08-29, Component 12 Step 5)

The same question the OAuth amendment answered, in its email form: a recovery,
invitation or confirmation link has to end in a session, and Supabase's default
way of delivering one puts the credential in the URL.

Supabase's `{{ .ConfirmationURL }}` points at its own `/auth/v1/verify`
endpoint, which redirects to `redirect_to` carrying the result — as
`#access_token=…&refresh_token=…` under the implicit flow, or as `?code=` under
PKCE. The first hands a refresh token to JavaScript, which is what this ADR
exists to prevent. The second cannot be exchanged by our proxy at all: a PKCE
code needs the verifier minted when the flow started, and an email link starts
in an inbox, not in our browser.

**Decision: the email templates link to our own routes carrying
`{{ .TokenHash }}`, and the backend redeems it.** The SPA route reads
`token_hash` and `type` from its query string and posts them to
`POST /api/v1/auth/verify-link`, which calls Supabase's `POST /auth/v1/verify`
server-side and sets the refresh cookie exactly as password login does. The
browser carries an opaque, single-use hash; the credential never exists in
JavaScript on this path either.

### Consequences

- **The email templates become part of the security posture.** A template
  reverted to `{{ .ConfirmationURL }}` silently reintroduces the token-in-URL
  problem, with no code change and no test failure to catch it. Recorded in
  `security-model.md` for that reason.
- Accepting an invitation *is* choosing a first password, so it shares the
  reset route (`type=invite`) rather than getting a page of its own.
- Redemption is single-use: the route guards against React StrictMode's
  double-invoked effects, as the OAuth callback does, and a reload of a consumed
  link correctly reports an expired link.
- Every route terminating a link needs an entry in Supabase's Redirect URLs
  allowlist, per environment. A missing entry is silent — Supabase substitutes
  the Site URL rather than refusing.
