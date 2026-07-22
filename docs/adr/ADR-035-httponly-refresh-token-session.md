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
