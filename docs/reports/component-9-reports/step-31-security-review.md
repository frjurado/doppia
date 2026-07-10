# Step 31 — Security Review

**Date:** 2026-07-09
**Scope:** verify `docs/architecture/security-model.md` against the deployed
reality, per `component-9-corpus-population-and-hardening.md` § Step 31: CORS,
rate limiting, signed-URL lifecycle, dev auth bypass, JWT handling (ADR-016),
RLS enforcement (migrations 0005/0006), role checks on all Component 7–9
endpoints (including service-layer status filtering), secrets hygiene.

**Outcome at a glance:** every check that could be run from the repo and by
live probing of staging **passes**. Three low-severity findings recorded
(§ Findings), two of them fixed in-review. Two verifications remain that
require operator access (§ Remaining operator checks), plus the § 4 public-URL
**open decision** that this review is required to close.

---

## 1. Verified — code side

| Control | Result | Evidence |
|---|---|---|
| CORS allowlist | ✅ matches doc | `main.py` `_ALLOWED_ORIGINS` per environment; unknown `ENVIRONMENT` → empty origins (fail-closed); credentials never combined with `*` |
| Dev auth bypass inert outside local | ✅ double-guarded | Startup guard: `lifespan` raises `RuntimeError` when `AUTH_MODE=local` ∧ `ENVIRONMENT≠local` (refuses to boot); per-request belt-and-suspenders 401 in `AuthMiddleware` |
| JWT validation | ✅ | Single pinned algorithm per key type (ES256 via startup-fetched JWKS, HS256 via `SUPABASE_JWT_SECRET` fallback) — no algorithm-confusion surface; missing key config → 401, not bypass; `exp` verified; role read from server-controlled `app_metadata` |
| ADR-016 (localStorage JWT) | ✅ unchanged | `doppia_access_token` in localStorage per ADR-016's Phase-1 exception; the Component 9 I1/I2 hardening (any-401 translation + stale-JWT session expiry) tightened session handling without changing storage |
| Role checks on every endpoint | ✅ | Every route in `fragments/movements/browse/concepts/reviews/corpora/admin` carries `require_role("editor")` or `("admin")` via router dependencies; the only unauthenticated routes are the two health probes (return status strings only, documented) and the SPA static catch-all |
| Service-layer status filtering | ✅ not bypassable | `FragmentService` enforces draft visibility (creator-or-admin) inside `list_by_concept`, detail reads, and the review queue — a spoofed `status=draft` returns only the caller's own drafts; covered by `test_fragment_service.py` (100% file coverage) |
| Signed-URL lifecycle | ✅ matches § 4 | `object_storage.py`: `CLIENT_FACING_URL_TTL=3600`, `BACKEND_PROCESSING_TTL=900`; keys validated; nothing persists URLs |
| RLS migration coverage | ✅ complete | All `create_table` calls live in migrations 0001/0003 — every table is in the 0005/0006 RLS list; 0007/0008 add columns only, so no post-RLS table exists unprotected |
| Rate limiting | ✅ policy match | None implemented, exactly as the documented Phase-1 decision; Fly infra-level protection only; `slowapi` plan stands for Phase 2 |
| Secrets hygiene | ✅ | Only `.env.example` tracked; `.gitignore` covers `.env*`; no token-shaped strings in tracked files except the Supabase **anon key** in `fly.toml` build args — public by design (shipped in the frontend bundle; `login-page.md`), safe **iff** RLS default-deny holds (probe below) |
| `.env.example` currency | ✅ | Backend and frontend examples cover every env var the code reads (incl. `VITE_SOUNDFONT_BASE_URL`, read via bracket notation) |

## 2. Verified — live staging probes (2026-07-09)

| Probe | Result |
|---|---|
| `GET /api/v1/health` | 200 `{"status":"ok"}` (keep-alive workflow and Fly checks use the correct prefixed paths) |
| `GET /api/v1/concepts/roots` — no token | **401** ✅ |
| `GET /api/v1/concepts/roots` — `Bearer dev-token` | **401** ✅ — the dev bypass is demonstrably off in staging |
| CORS preflight, `Origin: https://evil.example` | **400** (origin not allowed) ✅ |
| CORS preflight, own origin | 200 with `Access-Control-Allow-Origin` echoing exactly the staging origin ✅ |

## 3. Findings

1. **[fixed in-review, low]** The JWT decode comment claimed "rely on iss +
   exp", but `jwt.decode` was never passed `issuer=` — `iss` was not verified.
   Impact is low (signature verification against this project's JWKS/secret
   already scopes accepted tokens), but the comment asserted a check that
   doesn't exist. Comment corrected; **adding real `issuer=` verification is
   queued for the pre-Step-32 batch** (it is a behaviour change that needs a
   staging login test, not a mid-campaign hotfix).
2. **[fixed in-review, trivial]** `security-model.md` § 1 CORS snippet lacked
   `Accept-Language` (added to `allow_headers` by Part 7 i18n); the health
   module docstring gave the unprefixed `/health` path. Both corrected.
3. **[recorded, informational]** `/api/docs`, `/api/redoc`, and
   `/api/openapi.json` are publicly reachable (FastAPI defaults; no data
   exposure — every data route still 401s — but they enumerate the API
   surface). Acceptable for an internal Phase-1 staging; decide before public
   launch whether to gate or disable them in production. Phase-2 checklist.

## 4. Remaining operator checks (need Francisco)

The automated probe of PostgREST was intentionally not run to completion from
this session (it would print table contents into a transcript if RLS were
mispplied). Two checks:

1. **RLS default-deny via PostgREST.** For each of `app_user`, `fragment`,
   `movement`, `alembic_version`:

   ```bash
   curl -s -o /dev/null -w "%{http_code} " \
     "https://vywprfptbicpvuygksad.supabase.co/rest/v1/<table>?select=id&limit=1" \
     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY"; \
   curl -s "https://vywprfptbicpvuygksad.supabase.co/rest/v1/<table>?select=id&limit=1" \
     -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" | head -c 40; echo
   ```

   **Expected: `200` with body `[]`** (RLS enabled + no policies ⇒ empty set,
   not an error). Any row in the body means RLS is not applied on that
   environment — run `alembic upgrade head` and re-check. (`?select=id` keeps
   any accidental output to ids only.)

   > **Result (2026-07-10, Francisco):** ✅ all four tables (`app_user`,
   > `fragment`, `movement`, `alembic_version`) return `200` with body `[]`
   > against the staging Supabase project with the anon key. RLS default-deny
   > is enforced; PostgREST exposes nothing. This is the control that makes
   > the anon key in `fly.toml` build args safe to commit.

2. **Staging secrets inventory.** `fly secrets list -a <staging-app>` — confirm
   **no `AUTH_MODE`** entry exists, `ENVIRONMENT=staging` is set (env var or
   `fly.toml [env]`), and the Supabase **service-role key** appears only as a
   backend secret, never in frontend build args (`fly.toml [build.args]`
   currently carries only the anon key — correct).

Record both results here when done.

> **Result (2026-07-10, Francisco):** ✅ `fly secrets list` — no `AUTH_MODE`
> entry anywhere; `SUPABASE_SERVICE_ROLE_KEY` present in secrets only (not in
> `fly.toml`); `ENVIRONMENT` set via `fly.toml [env]`, not duplicated in
> secrets. Both operator checks pass; Step 31 verification is complete. The
> § 5 public-URL decision remains the only open item of this review.

## 5. Open decision — § 4 public-URL branch (this review must close it)

`security-model.md` § 4 records that `R2_PUBLIC_URL` serves MEI/incipit/preview
artifacts **unsigned and non-expiring** (bucket-level public access, required
for Tone.js soundfont loading), with the `?v=` cache-buster mitigating r2.dev
edge staleness. The options as documented:

- **(a)** Keep the public branch + cache-buster as the permanent design.
- **(b)** Restrict public access to soundfonts; route MEI/incipit/preview back
  through true presigned URLs (restores TTL/signature; cache-buster becomes
  unnecessary).

**Recommendation:** adopt **(b) as the end state**, implement at the start of
Phase 2 (it must land before any public URL exists; R2 public access is
bucket-scoped, so it likely means a second, soundfonts-only public bucket —
non-trivial), and keep (a) as the documented Phase-1 operating mode: staging is
internal, access-gated, and the bucket holds only open-licensed scores.

> **Decision (2026-07-10, Francisco): option (b) adopted as the end state,**
> implemented as one of the first Phase-2 tasks (prerequisite for ADR-009
> enforcement and for any public URL); option (a) + cache-buster recorded as
> the accepted Phase-1 operating mode. Recorded in `security-model.md` § 4.
> **Step 31 is closed.** All Phase-2 items from this review are consolidated
> in `docs/roadmap/phase-2-entry-backlog.md` § 2.

---

## Disposition summary

| Item | Disposition |
|---|---|
| All code-side controls | Verified, pass |
| Staging probes (auth, dev bypass, CORS) | Verified live, pass |
| JWT `iss` comment / verification | Comment fixed; `issuer=` check → pre-Step-32 batch |
| Doc/docstring nits | Fixed |
| OpenAPI docs exposure | Recorded; Phase-2 decision |
| RLS PostgREST probe | ✅ Verified 2026-07-10 — all tables `200 []` (default-deny enforced) |
| fly secrets inventory | ✅ Verified 2026-07-10 — no `AUTH_MODE`; service-role key in secrets only; `ENVIRONMENT` in `fly.toml [env]` |
| § 4 public-URL branch | ✅ **Decided 2026-07-10:** (b) at Phase-2 start; (a) accepted for Phase 1 |
