# Phase 2 — Component 10: Foundations & Public Read Path — Implementation Plan

This document translates Component 10 of [`phase-2.md`](phase-2.md) into a
concrete, sequenced set of implementation tasks. It follows the model of the
Component 8 plan ([`component-8-fragment-browsing.md`](component-8-fragment-browsing.md)):
it does not restate settled design, it sequences implementation and pins the
integration boundaries the design docs leave open, and where it reaches a
decision those docs do not record it flags it for confirmation rather than
baking it in silently.

Component 10 is the **hinge between Phase 1 and Phase 2**. Phase 1 built an
internal tool: every read endpoint is `require_role("editor")`, the JWT is
stored in `localStorage` under an explicit Phase-1 exception, R2 artifacts are
served unsigned from a public bucket, and no anonymous traffic exists. Phase 2
turns that asset into a public product, and Component 10 is where the internal
tool becomes safe to point a stranger at. It does three things at once:

1. **Retires the security and infrastructure debt that gates any public URL**
   (backlog §2 — nine items, in dependency order). This is the load-bearing
   work: the moment an unauthenticated request can reach the API, every one of
   these items must already be true.
2. **Opens the unauthenticated read surface** — `approved`-only browse by
   concept and fragment detail, served without an account. This is the
   surface Component 11 (the glossary) and every later public feature build
   on. The corpus browser and whole-movement score viewer **stay editorial**
   (see `phase-2.md` § What Phase 2 Delivers).
3. **De-risks the one big rendering unknown** — horizontal single-system
   layout with scroll-synced playback — with a throwaway spike whose output is
   a findings report, **months before Component 16 depends on it, not during
   it**.

Alongside these, two pieces of standing test infrastructure that Phase 1
deliberately deferred are stood up here (Verovio snapshot guards and a
Playwright e2e scaffold), because the public read path is the first surface
worth protecting and the rendering spike touches the same Verovio options the
snapshots guard.

**Track M0 runs in parallel.** The fragment editor is effectively unusable
(concept, stages, harmony panel, and commentary all render blank on edit; the
score never enters editing mode). It blocks M1/M2 (the editorial data-fix
sweep) and gates the first public exposure of fragment data in Component 11, so
its repair is slotted alongside Component 10 rather than waiting for a later
editorial pass. It is a repair with a bounded scope (the issues register), not
open-ended editor work, and it shares no critical path with the security items,
so it is a genuine parallel stream.

Component 10 has **seven parts**:

1. **Storage boundary** — the signed-URL end state (backlog §2 item 1): split
   the public bucket down to soundfonts only and route MEI/incipit/preview
   back through presigned URLs. First task; prerequisite for everything public.
2. **The public read path** — the unauthenticated `approved`-only API surface,
   ADR-009 enforcement (the ABC-corpus exclusion), and the public frontend
   read views (item 2).
3. **Auth & session hardening** — the PyJWT migration and the CI-audit flip to
   blocking (item 3), and the token-storage / session-UX end state (item 4).
4. **Public-launch guards** — rate limiting (item 5), security headers
   (item 6), the OpenAPI-docs production gate (item 7), and CORS for preview
   environments (item 8).
5. **Rendering de-risk** — the horizontal single-system rendering spike.
6. **Test infrastructure** — Verovio snapshot guards, the Playwright e2e
   scaffold, and the dev-only pytest 9 / pytest-asyncio 1.x migration (item 9).
7. **Track M0 (parallel)** — fragment editor repair.

The ordering across parts is a hard dependency chain at the front and parallel
streams behind it. Part 1 (the storage split) is the literal first task
because ADR-009 enforcement (Part 2) is bypassable while source MEI is publicly
fetchable, and no public URL may exist until it lands. Part 2 depends on Part 1
but nothing else. Parts 3 and 4 are independent of Parts 1–2 and of each other
(they touch auth, middleware, and config, not the read path) and can run in
parallel once Part 1 is underway — **but every item in Parts 1–4 must be green
before the public surface is switched on**, which is the Component-10 exit gate.
Part 5 (the spike) is fully independent and can run at any time; it is sequenced
early so its findings are in hand before Component 16 planning. Part 6 (tests)
trails the feature work it protects. Part 7 (M0) is a parallel editorial-tool
stream with no dependency on the public-path work.

---

## Prerequisites

Component 10 assumes Phase 1 is closed and its artifacts are authoritative:

- **Phase 1 is complete** (`phase1/complete` tag, PR #27 merged 2026-07-11).
  The corpus is frozen as of Component 9 Step 11; any MEI correction in Phase 2
  follows the full ADR-004/ADR-008 re-ingestion protocol with fragment
  mc-stability verification.
- **Component 8 shipped the licence serialiser.** `_derive_data_licence`,
  `data_licence`/`data_licence_url`/`harmony_sources`, and the per-fragment
  key convention already exist and are exercised on the editor-facing browse
  and detail reads. Component 10 adds the *public* route and the ABC-corpus
  *exclusion enforcement* on top of it — it does not re-implement the
  derivation (ADR-009 was explicit that the derivation is scaffolded in
  Component 8 ahead of the Phase-2 public path).
- **The pre-Step-32 security batch landed** (backlog §1): fastapi/starlette,
  lxml, `pip-audit` report-only CI job, JWT issuer verification, and the
  integration-test isolation fixes are all in. The report-only audit job is
  the one Part 3 flips to blocking.

It additionally assumes the following docs are settled and authoritative; they
are the *inputs* to this plan and it does not duplicate them:

- [`../architecture/security-model.md`](../architecture/security-model.md)
  § 4 (signed-URL lifecycle and the public-URL branch decision block), § 2
  (rate-limiting design and starting limits), § 7 (the CSP/HSTS/nosniff
  drafts), § 1 (the CORS allowlist and the "separate prefix or disable
  credentials" note for a public read-only endpoint).
- [`../adr/ADR-009-dcml-licensing-constraint.md`](../adr/ADR-009-dcml-licensing-constraint.md)
  — the per-fragment `data_licence` derivation and the ABC-corpus public-API
  exclusion this component enforces.
- [`../adr/ADR-016-jwt-browser-storage.md`](../adr/ADR-016-jwt-browser-storage.md)
  — the `localStorage` JWT exception scoped to Phase 1 "to be revisited before
  Phase 2 public launch"; Part 3 is that revisit.
- [`../adr/ADR-013-verovio-version-policy.md`](../adr/ADR-013-verovio-version-policy.md)
  — the deliberate-upgrade policy the snapshot guards protect (M14, deferred to
  Component 14, depends on the guards built here).
- [`phase-2-entry-backlog.md`](phase-2-entry-backlog.md) § 2 (the nine
  security/infra items, with pointers) and § 4 (the ADR-024 rendering modes the
  spike explores).
- [`../architecture/roles-and-permissions.md`](../architecture/roles-and-permissions.md)
  — the role model whose `anonymous` tier the public read path is the first
  consumer of (registration and the full role set are Component 12).
- [`../reports/component-9-reports/issues-deferred-for-phase-2.md`](../reports/component-9-reports/issues-deferred-for-phase-2.md)
  § Fragment editor, § Tagging sidebar (M0's scope).

### Decisions taken into this plan

Four scoping decisions are baked in. The first two are substantive and were
**confirmed with Francisco (2026-07-16)** — see "Decisions Confirmed"; the last
two are sensible defaults consistent with the design docs.

- **Public endpoints ship under a separate `/api/v1/public/` router prefix, not
  as an anonymous branch of the existing editor routes** (confirmed 2026-07-16).
  `security-model.md` § 1 already anticipates this: a public read-only endpoint
  "must either disable credentials or be served from a separate API prefix,"
  because the wildcard-origin / no-credentials CORS posture a public GET wants
  is incompatible with the credentialed allowlist the editor API needs. A
  separate prefix also keeps the `approved`-only guarantee structural (the
  public router has no code path that reads a non-`approved` fragment) rather
  than a filter that a parameter could subvert, and it isolates rate-limit
  policy. The editor-facing routes from Components 7–8 are unchanged.
- **Token storage end state (item 4): a same-site HttpOnly refresh-token
  cookie** (confirmed 2026-07-16) — the ADR-016 revisit. Chosen over adopting
  the full Supabase JS client: the cookie is XSS-resistant and keeps session
  state in our own backend (a small session/refresh endpoint plus CSRF
  consideration), where the Supabase-JS route would have moved session state
  into a third-party SDK and enlarged the frontend surface for the same
  `localStorage`-retirement benefit. Recorded as an ADR extending ADR-016 (see
  Step 7). The hard consumer is Component 12 registration, not the Component 10
  read path (which is anonymous) — so item 4 *may* slip to the front of
  Component 12 if it threatens the Component 10 timeline, but it is planned here
  because it shares the auth middleware the PyJWT migration (item 3) is already
  rewriting.
- **The rendering spike is throwaway.** Its deliverable is a findings report
  under `docs/reports/`, not production code. No public feature depends on its
  output landing in the tree; Component 16 does. Any reusable hook it discovers
  is noted for ADR-024's `context` contract, not merged as a component.
- **M0 is a bounded repair, not open-ended editor work.** Its scope is exactly
  the issues-register § Fragment editor list plus the two § Tagging sidebar
  cleanups that are cheap to ride along (M9's "stage properties" label and the
  stage-ordering fix). Anything larger (the bracket redesign M5, the harmony
  panel semantics M8) stays in its later Track M slot.

### Current code state (verified)

Read from the tree at the time of writing, so the part boundaries land on real
seams:

- **`backend/main.py`** exposes `docs_url="/api/docs"`, `redoc_url="/api/redoc"`,
  `openapi_url="/api/openapi.json"` unconditionally (Part 4 Step 10 gates
  these). CORS uses a static per-environment `_ALLOWED_ORIGINS` dict keyed on
  `ENVIRONMENT` with no env-var fallback (Part 4 Step 11 adds one).
  `AuthMiddleware` is added before `CORSMiddleware` (correct ingress order) and
  sets `request.state.user = None` when no `Authorization` header is present —
  so anonymous requests already flow through to route handlers, and the public
  routes need only *omit* `require_role()`, not special-case the middleware.
- **`backend/api/middleware/auth.py`** imports from `jose` (python-jose):
  `from jose import ExpiredSignatureError, JWTError, jwt`. Supports ES256 via
  `SUPABASE_JWKS` (preferred) and HS256 via `SUPABASE_JWT_SECRET`; issuer is
  verified (backlog §1 B4). Part 3 Step 6 replaces the `jose` calls with PyJWT
  here — this is the only module that imports `jose` in application code.
- **`backend/requirements.txt`** pins `python-jose[cryptography]==3.4.0` (the
  advisory carrier). **`requirements-dev.txt`** pins `pytest==8.3.4` and
  `pytest-asyncio==0.24.0` (the `pytest<9` pin that blocks item 9). No
  `slowapi` and no `PyJWT`/`pyjwt` are present yet — Part 3 and Part 4 add them.
- **`backend/services/object_storage.py`** has the two-branch `signed_url()`:
  when `public_url` (`R2_PUBLIC_URL`) is set it returns an unsigned
  `{public_url}/{key}` URL with a `?v=<token>` cache-buster (`_cache_bust_token`,
  keyed on the write timestamp); otherwise it mints a presigned URL. Part 1
  narrows the public branch to soundfonts and lets MEI/incipit/preview fall
  through to the presigned branch — which retires `_cache_bust_token` for those
  keys (presigned URLs are unique per request).
- **`backend/tests/snapshots/`** contains only `__init__.py` (scaffolded empty
  in Phase 1). Part 6 Step 13 populates it.
- **No Playwright** anywhere in `frontend/` (Part 6 Step 14 scaffolds it).
- **All read routes are `require_role("editor")`** — 26 occurrences across
  `browse.py`, `fragments.py`, `concepts.py`, `reviews.py`, `movements.py`,
  and `dependencies.py`. The public router (Part 2) is a new surface, not a
  relaxation of these.
- **The fragment edit flow lives in `frontend/src/routes/ScoreViewer.tsx`**,
  not in `FragmentDetail.tsx`: `handleEditFragment` sets `editPrefillRef` /
  `editSubPartsRef`, remounts `FormPanel` with `editPrefillFormData`, and
  `buildStageAssignmentsFromSubParts` restores stage geometry. M0's blank-panel
  symptoms point at the consumption of these refs and the recorded→editing
  bracket-mode transition — Part 7 diagnoses from there.

---

## Part 1 — Storage Boundary: the Signed-URL End State

**Backlog §2 item 1. The literal first task of Phase 2.** Until this lands,
ADR-009 enforcement (Part 2) is bypassable — the source MEI of an excluded
corpus is publicly fetchable regardless of any API check — so no public URL may
exist. Decided 2026-07-10 (option (b), `security-model.md` § 4).

---

### Step 1 — Split the public bucket down to soundfonts

**The R2 access-boundary change.**

R2 exposes public access at the **bucket** level, so the Phase-1 arrangement —
one bucket, made public so Tone.js can fetch soundfonts by internally
constructed filenames — also exposes MEI, incipit, and preview objects
unsigned. Option (b) restores the boundary: a **separate soundfonts-only public
bucket**, with the corpus/artifact bucket private again.

- Create the soundfonts public bucket (or reuse a dedicated one) holding only
  the Tone.js piano soundfonts. This is the only artifact class that *must* be
  public — Tone.js constructs sample filenames internally and cannot carry
  signed query parameters.
- The corpus/artifact bucket (MEI, incipit SVGs, fragment-preview SVGs) reverts
  to private; no bucket-level public access.
- This is an infrastructure/config change (bucket provisioning, CORS rule on
  the soundfonts bucket per `security-model.md` § 1) plus the env wiring in
  Step 2. Record the two bucket names/roles in `deployment.md`.

**Verification.** The soundfonts bucket serves a sample file over a plain URL
(Tone.js loads); the corpus bucket returns 403 on an unsigned object fetch.

---

### Step 2 — Route MEI/incipit/preview back through presigned URLs

**The `object_storage.py` change that restores the TTL/signature lifecycle.**

`signed_url()`'s public branch currently fires for every key when
`R2_PUBLIC_URL` is set. Narrow it so only soundfont keys take the public
branch; MEI/incipit/preview keys fall through to the presigned branch.

- Introduce an explicit notion of *which bucket a key lives in* (soundfonts vs
  artifacts) rather than a single `public_url` gate. The soundfonts bucket
  keeps the plain-URL path; the artifact bucket always presigns, with the
  `security-model.md` § 4 TTLs (1h client-facing, 15m backend-to-backend).
- **Retire `_cache_bust_token` for artifact keys.** Presigned URLs are unique
  per request, so the stale-`r2.dev`-cache problem the cache-buster solved no
  longer applies to MEI/incipit/preview; remove the `?v=` append and the
  timestamp threading for those callers (`services/browse.py`,
  `services/fragments.py`). Keep it only if any soundfont key is ever mutable
  (they are not — leave a note).
- **Known trade-off to accept and record** (`security-model.md` § 4): presigned
  URLs defeat browser caching of fragment previews. `security-model.md`
  reserves the option to keep previews/incipits (derived renders of
  open-licensed scores) public while signing only source MEI, if preview
  caching matters at scale. Component 10 implements the fully-signed end state;
  if a preview-caching regression shows up in the spike or in Component 11's
  glossary previews, revisit per that reserved option and record the outcome.

**Verification.** A client-facing MEI/preview URL is presigned and expires
(1h); a backend processing URL uses the 15m TTL; a soundfont URL is still plain;
no `?v=` cache-buster appears on artifact URLs; `services/browse.py` and
`services/fragments.py` no longer thread write timestamps for cache-busting.
The Component 8 preview cards and the score viewer still render (URLs resolve).

---

## Part 2 — The Public Read Path

**Backlog §2 item 2.** The unauthenticated `approved`-only surface and the
ADR-009 exclusion. Depends on Part 1 (Step 1 especially — the exclusion is
meaningless while source MEI is publicly fetchable). The licence serialiser is
already built (Component 8); this part adds the public route, the exclusion
check, and the anonymous frontend.

---

### Step 3 — Public API surface (separate `/api/v1/public/` prefix)

**The unauthenticated read endpoints.**

Add a public router mounted at `/api/v1/public/` carrying the anonymous
read surface: browse approved fragments by concept, and fragment detail. These
reuse the Component 8 service methods (`list_by_concept`, the single-fragment
read) with the status hard-pinned to `approved` **in the route layer of the
public router**, so no public code path can request another status — the
`approved`-only guarantee is structural, not a defaultable parameter.

- **No `require_role()`** on these routes (anonymous). `AuthMiddleware` already
  sets `request.state.user = None` for tokenless requests, so nothing in the
  middleware needs special-casing.
- **Reuse, do not fork, the service layer.** The public browse calls the same
  `FragmentService` methods as the editor browse with `status="approved"`
  forced and the ADR-009 exclusion applied (Step 4). The cross-database join,
  cursor pagination, and licence serialisation are identical — the difference
  is the fixed status, the exclusion filter, and the CORS/rate-limit posture of
  the router, not the query.
- **CORS posture** (confirmed): the public router takes a broad-origin,
  no-credentials policy (a public GET carries no cookie/JWT), which
  `security-model.md` § 1 says must not share the credentialed editor allowlist.
  Serving the public router under its own prefix lets it take a distinct
  `CORSMiddleware` configuration (or a per-router policy) without weakening the
  editor API's `allow_credentials=True` allowlist.

**Verification.** An unauthenticated request to the public browse/detail
endpoints succeeds and returns only `approved` fragments; a request for a
non-`approved` fragment id returns 404 (not a leak of its existence/status);
the editor routes are unchanged and still `require_role("editor")`; a spoofed
`status` query on the public route has no effect.

---

### Step 4 — ADR-009 enforcement: the ABC-corpus exclusion

**The exclusion check the public path requires.**

ADR-009 §2 excludes the ABC corpus from the public API. Component 8 built the
`data_licence` derivation and explicitly deferred *enforcement* to this
public-path work. Add the exclusion as a filter applied in the public read
path (the single place the derivation already lives), so an ABC-sourced
fragment is never returned by the public browse or detail, and its MEI is never
resolvable through a public URL (Part 1 having already made the object itself
private).

- The exclusion is keyed on the corpus/source of the fragment's in-range
  events, consistent with the `data_licence` derivation — one place, one rule.
- The current corpus is entirely Mozart (DCML / CC BY-SA); there may be no ABC
  fragment to exclude *today*. Build the check as a structural guard with a
  test that inserts an ABC-sourced fixture and asserts it is absent from the
  public surface, so the guard is proven before an ABC corpus is ever ingested.

**Verification.** An ABC-sourced fragment fixture is excluded from public browse
and public detail (404); a DCML/CC-BY-SA fragment is served with its correct
`data_licence`; the editor browse (Component 8) still shows both.

---

### Step 5 — Public frontend read views

**The anonymous browse-by-concept and fragment-detail pages.**

The public-facing React views over the Step 3 endpoints. These are read-only,
account-free, and are the surface Component 11's glossary links into.

- Browse-by-concept and fragment-detail views reusing the Component 8
  components (`FragmentDetailPanel` in its standalone configuration, the
  preview-card list) against the public API client, with no editor affordances
  (no Edit, no status filter, no review controls).
- Per `DESIGN.md` (Henle Blue / Urtext Cream, Newsreader/Public Sans, 0px
  radius, tonal layering, no 1px dividers). The public topbar redesign is
  **Component 12** — Component 10 ships the read views on a minimal public
  shell, not the full audience-split nav.
- The corpus browser and whole-movement score viewer are **not** exposed here —
  they remain editorial (`phase-2.md` § What Phase 2 Delivers).

**Verification.** An anonymous browser (no token in storage) can browse a
concept's approved fragments and open a fragment detail with its Verovio render,
MIDI, and licence provenance; no editor-only control is reachable; the corpus
browser and score viewer are not linked from the public shell.

---

## Part 3 — Auth & Session Hardening

**Backlog §2 items 3 and 4.** Independent of Parts 1–2; touches the auth
middleware and the frontend session. Both items retire Phase-1 auth debt that
gates public accounts (Component 12), but they are planned here because the
PyJWT migration rewrites the middleware the token-storage work also touches, and
because flipping the CI audit to blocking clears the report-only compromise
carried since Phase 1.

---

### Step 6 — PyJWT migration, then flip the CI audit to blocking

**Replace python-jose; unblock the blocking audit.**

`api/middleware/auth.py` is the only application module importing `jose`.
python-jose carries an unfixable advisory (PYSEC-2025-185) plus two unfixable
transitives (`ecdsa` PYSEC-2026-1325; `pyasn1` CVE-2026-30922, pinned below its
fix by python-jose), and is effectively unmaintained — which is why the CI
audit job has been report-only since Phase 1 (a blocking audit would be
permanently red).

- Replace the `jose` calls in `auth.py` with **PyJWT**, preserving the existing
  behaviour exactly: ES256 via the JWKS (`SUPABASE_JWKS`, `kid`-matched),
  HS256 via `SUPABASE_JWT_SECRET`, issuer verification (backlog §1 B4),
  expiry handling, and the same 401 error envelope. PyJWT's `PyJWKClient` /
  `PyJWKSet` covers the JWKS `kid` match that python-jose did automatically.
- Remove `python-jose[cryptography]` from `requirements.txt`; add `PyJWT`.
  Confirm no other module imports `jose` (verified: only `auth.py` in
  application code; `test_auth_middleware.py` and the RLS migration reference
  are not runtime imports of the library — re-check the test).
- **Flip the CI `audit` job from report-only to blocking** once the python-jose
  advisories are gone from the tree (`ci.yml`; `continue-on-error` removed).
  Re-run `pip-audit` to confirm the advisory set is clear before flipping.

**Verification.** The full auth middleware unit suite (`test_auth_middleware.py`)
passes against PyJWT: a valid ES256 token, a valid HS256 token, an expired
token (401), a wrong-issuer token (401), and a missing token (anonymous) all
behave identically to the python-jose implementation. Staging login works with a
real Supabase token after deploy. `pip-audit` is clean; the CI audit job is
blocking and green.

---

### Step 7 — Token storage & session UX end state (ADR-016 revisit)

**Retire the `localStorage` JWT exception.**

ADR-016 scoped the `localStorage['doppia_access_token']` storage to Phase 1 and
required a revisit "before Phase 2 public launch." This is that revisit. The
confirmed end state (2026-07-16) is a **same-site HttpOnly cookie** for the
refresh/session token, chosen over the full Supabase JS client.

- Remove the raw access token from `localStorage`, implement token refresh (the
  minimal `exp` patch shipped in Component 9 is not a refresh flow), and add the
  session UX the triage's "full session UX" item calls for (user dropdown,
  logout, refresh-on-expiry).
- Add the backend session/refresh endpoint and CSRF consideration; document the
  cookie attributes (`HttpOnly`, `Secure`, `SameSite`) in `security-model.md`.
- **Record the decision as an ADR extending ADR-016.** The `localStorage`
  exception is closed there with a pointer to the new ADR.
- **Gating note:** the hard consumer is Component 12 registration, not the
  Component 10 anonymous read path. If this item threatens the Component 10
  exit, it moves to the front of Component 12 — but it is attempted here while
  the middleware is already open from Step 6.

**Verification.** No JWT is present in `localStorage`; a session survives a page
reload via the chosen mechanism; an expired access token refreshes without a
re-login; logout clears the session server- and client-side; the ADR-016
exception is recorded as closed with a pointer to the new ADR.

---

## Part 4 — Public-Launch Guards

**Backlog §2 items 5–8.** The controls that must be live the moment anonymous
traffic can reach the API. Independent of Parts 1–3 and of each other; batch
them so the exit gate (Part 1–4 all green) closes cleanly.

---

### Step 8 — Rate limiting (`slowapi` + Redis)

**Item 5.** Add `slowapi` backed by the Redis already in the stack (Upstash in
production), with the per-category starting limits tabled in `security-model.md`
§ 2 and the per-user-or-IP key function (`user:{sub}` for authenticated,
`get_remote_address` for anonymous). Rate-limit responses use the standard error
envelope with `code: RATE_LIMIT_EXCEEDED` and a `Retry-After` header.

- Apply the tighter *anonymous* limits to the Part 2 public router first (that
  is the surface that will actually see anonymous traffic); the graph-traversal
  and write categories inherit the § 2 table.
- Add `slowapi` to `requirements.txt`.

**Verification.** Exceeding a category limit returns 429 with `Retry-After` and
the correct envelope; authenticated requests are keyed per-user (two users
behind one IP do not share a bucket); the limiter uses Redis state (survives a
worker restart within the window).

---

### Step 9 — Security headers (CSP, HSTS, nosniff)

**Item 6.** Add the response headers drafted in `security-model.md` § 7 via
middleware: the restrictive CSP (`default-src 'self'`; `worker-src blob:` for
Verovio WASM; `connect-src` including `*.supabase.co` and the R2 host;
`img-src 'self' data: blob:`), `X-Content-Type-Options: nosniff` on all
responses, and `Strict-Transport-Security` once the production domain is
confirmed.

- Validate the CSP against the actual public read views (Part 2) and the
  Verovio/MIDI path — the WASM worker and any blob/data URIs the renderer uses
  must not be blocked. Tighten `connect-src` to exactly the hosts the frontend
  contacts.
- HSTS is set only when the production domain exists; leave a note if the domain
  is not yet confirmed at implementation time.

**Verification.** The public views load with the CSP active (no console CSP
violations; Verovio renders, MIDI plays); `nosniff` is present on responses; the
CSP blocks an injected inline script in a manual check.

---

### Step 10 — Gate the OpenAPI docs in production

**Item 7.** `main.py` exposes `/api/docs`, `/api/redoc`, and
`/api/openapi.json` unconditionally. **Disable them in production** (pass
`docs_url=None` / `redoc_url=None` / `openapi_url=None` to the `FastAPI(...)`
constructor when `ENVIRONMENT == "production"`); leave them reachable in
local/staging for development. No data leaks through them, but they enumerate
the API surface. Record the disable-in-production choice in `security-model.md`.

**Verification.** In a production-configured app, `/api/docs`, `/api/redoc`, and
`/api/openapi.json` return 404 (or the chosen gate); in local/staging they are
still reachable for development.

---

### Step 11 — CORS for preview environments

**Item 8.** Add an `ALLOWED_ORIGINS` env-var fallback to `main.py` so Fly.io PR
preview deployments do not require a code change per URL: read a comma-separated
`ALLOWED_ORIGINS` and union/fall back to the static `_ALLOWED_ORIGINS` allowlist
(`security-model.md` § "Could be done in Phase 1" — a ~5-line change, no new
dependency). This stays an explicit allowlist, not a wildcard or regex.

**Verification.** With `ALLOWED_ORIGINS` set to a preview URL, a request from
that origin passes CORS; unset, the static allowlist behaviour is unchanged; no
wildcard origin is introduced on the credentialed editor API.

---

## Part 5 — Rendering De-risk: the Horizontal Rendering Spike

**The scrollytelling de-risk.** Fully independent of every other part; sequenced
early so its findings inform Component 16 planning long before Component 16
begins. Its output is a **findings report**, not production code.

---

### Step 12 — Horizontal single-system render with scroll-synced MIDI

Build a throwaway page that renders one movement (or a long fragment) as a
**single horizontal system** — Verovio `breaks` options / single-system layout —
with MIDI playback whose position drives horizontal auto-scroll (reusing the
Component 3 `onPositionUpdate(bar, beat)` abstraction; the overlay rule holds —
never edit Verovio's SVG). The goal is to learn **whether Verovio fights us
before Component 16 depends on it**: does single-system layout hold at
movement length, does horizontal scroll stay in sync with playback, what are the
performance and layout-stability limits.

- **Deliverable:** a short findings report under `docs/reports/` — what works,
  what the workarounds are, and what it implies for the ADR-024 `context`
  contract and the Component 16 scrollytelling layout. ADR-024's context modes
  and the one-system rendering hook are the same machinery (backlog §4); note
  any reusable hook the spike discovers for that contract, but do not merge it
  as a component.
- This is exploratory; it may reuse the fixtures the snapshot guards (Step 13)
  are built from, since both touch Verovio rendering options.

**Verification.** The report exists under `docs/reports/`, covers a
movement-length render at single-system layout with scroll-synced playback,
documents the failure modes and workarounds, and states the implication for the
ADR-024 contract and Component 16.

---

## Part 6 — Test Infrastructure

Two standing test surfaces Phase 1 deferred, stood up now because the public
read path is the first thing worth protecting and the spike touches the same
rendering options the snapshots guard. Plus the dev-only pytest migration
(item 9), ridden along here.

---

### Step 13 — Verovio snapshot regression guards

**Populate `tests/snapshots/`** (scaffolded empty in Phase 1). These are the
guard that makes the eventual Verovio 6.2.0 upgrade (ADR-013; M14, deferred to
Component 14) a safe, deliberate event: they pin the current Verovio output for
a representative set of fragments/movements (including the Component 3 `select`
edge cases — mid-system start, repeat, first/second ending) so a version bump's
rendering deltas are visible and reviewed rather than silent.

- Build the guards against the frozen corpus so they are stable; the spike
  (Step 12) touches rendering options anyway, so the fixture set is warm.
- Wire them into CI as a regression check (not blocking the version bump — they
  *inform* it per ADR-013).

**Verification.** The snapshot suite captures the current render for the fixture
set and fails on an intentional rendering-option change; it runs in CI; ADR-013
and the M14 slot reference it as the upgrade guard.

---

### Step 14 — Playwright e2e scaffold

**The first browser-level coverage.** Phase 1 explicitly deferred e2e tests; the
public read path is the first surface worth covering end to end. Scaffold
Playwright in `frontend/` and cover the anonymous read journey: browse a concept
→ open a fragment detail → confirm the Verovio render and MIDI controls appear,
with no editor affordance reachable.

- Add Playwright as a dev dependency; wire a CI job (headless).
- Keep the scaffold minimal and public-path-focused; the editor/authoring flows
  get e2e coverage when their components stabilise (Component 12+).

**Verification.** `npx playwright test` runs the anonymous read journey headless
and green locally and in CI; the scaffold is documented in `CONTRIBUTING.md`'s
testing section.

---

### Step 15 — pytest 9 + pytest-asyncio 1.x migration

**Item 9, dev-only.** `pytest==8.3.4` is held below 9 by
`pytest-asyncio==0.24.0`'s `pytest<9` pin (backlog §1 B6). Bump both together:
migrate the async test configuration to pytest-asyncio 1.x, then move pytest to
9 (clears PYSEC-2026-1845, dev-only). Ride along here since Part 6 is already in
the test config.

- Watch the known Windows integration-run hang at exit
  (`IocpProactor._poll`, backlog §1) — if it recurs after the migration, try
  `WindowsSelectorEventLoopPolicy` in the integration conftest. CI (Linux) is
  unaffected either way.

**Verification.** `pytest backend/tests/unit/` and the integration suites pass
under pytest 9 / pytest-asyncio 1.x locally and in CI; the async fixtures behave
identically; no test is silently skipped by the config migration.

---

## Part 7 — Track M0: Fragment Editor Repair (parallel)

**Track M0 — "immediately, alongside Component 10"** (`phase-2.md` § Track M).
The fragment editor is effectively unusable and blocks M1/M2 (the editorial
data-fix sweep) and the first public exposure of fragment data in Component 11.
This is a bounded repair scoped to the issues register, running as a parallel
stream with no dependency on the security work.

---

### Step 16 — Diagnose and repair the edit-prefill flow

**Symptoms** (issues doc § Fragment editor): on editing a stored cadence
fragment, the concept search bar is empty; the stage components and their
properties are blank; the harmony panel is absent; the commentary is not shown;
**but** fragment-level properties *are* prefilled with real values; and the
score shows the "recorded fragment" brackets, not the "editing fragment"
brackets — so "Fragment drawn" reads off and cannot be toggled. In short, the
partial prefill (fragment properties) works while the concept/stage/harmony/
commentary prefill and the recorded→editing mode transition do not.

**Where to look** (verified seams in `ScoreViewer.tsx`): `handleEditFragment`
sets `editPrefillRef` / `editSubPartsRef` and `editPrefillFormData`, remounts
`FormPanel` via the session-rebuild key, and `buildStageAssignmentsFromSubParts`
restores stage geometry from the fragment's sub-parts. The blank concept/stages
point at `FormPanel`'s consumption of `editPrefill` on remount (concept +
property values not initialised) and at the stage-assignment rebuild; the absent
harmony panel and commentary point at the detail→edit hand-off not carrying
those fields into edit mode; the wrong brackets point at the mode flag that
should switch the overlay from stored-bracket rendering to editing/draw
rendering.

**Scope.** The issues-doc § Fragment editor list is the bound. Ride along the
two cheap § Tagging sidebar cleanups (M9) only if they fall out naturally: drop
the redundant "stage properties" label, and fix the stage-ordering behaviour
(un-toggled stages jumping to the end — keep the order fixed once set). Do not
pull in the bracket redesign (M5) or the harmony-panel semantics (M8) — those
keep their later Track M slots.

**Verification** (per the "verify renders, not just audits" lesson — confirm on
a real edit session, not just a unit assertion): editing a stored cadence
fragment prefills the concept in the search bar, the stages with their
component/property values, the harmony panel, and the commentary; the score
switches to editing/draw brackets and "Fragment drawn" is toggleable; saving the
edit round-trips the values correctly. Exercise it end to end on at least one
real fragment (e.g. one of the 279/i fragments from the errata list) in the UI.

---

## Decisions Confirmed

The two substantive integration decisions were confirmed with Francisco
(2026-07-16); the rest of the plan follows the design docs:

- **Public API shape — separate `/api/v1/public/` prefix with its own CORS
  posture (Step 3).** Chosen over an anonymous branch of the editor routes
  because it keeps the `approved`-only guarantee structural, isolates the
  broad-origin/no-credentials CORS a public GET needs from the credentialed
  editor allowlist (`security-model.md` § 1), and isolates rate-limit policy.
- **Token-storage end state (Step 7) — same-site HttpOnly refresh cookie.** The
  ADR-016 revisit, chosen over the full Supabase JS client (keeps session state
  in our own backend, XSS-resistant). Recorded as an ADR extending ADR-016. Its
  hard consumer is Component 12, so it may move to the front of Component 12 if
  it threatens the Component 10 timeline.

Two smaller choices ride along as settled defaults, revisited only if the work
surfaces a reason: the OpenAPI docs are **disabled** in production (Step 10, the
conservative default), and fragment previews are **signed** like all other
artifacts (Step 2), holding the `security-model.md` § 4 public-for-caching
option in reserve should a caching regression appear.

---

## Deferred to Later Components

Stated explicitly so the boundary is a decision, not a gap:

- **The public topbar / audience-split nav.** Component 10 ships the public read
  views on a minimal shell; the full public nav + role-gated Editorial menu is
  **Component 12** (roles doc; `phase-2.md` Component 12).
- **Registration and the full role model.** Component 10's public path is
  anonymous read-only; `registered`/`author`/multi-role and the `user_role`
  join table are **Component 12**. Item 4 (token storage) is built here but its
  gating consumer is registration.
- **Non-default ADR-024 rendering modes** (`bars`, `enclosing_fragment`,
  `previous_same_domain`) and the production scrollytelling layout. The spike
  (Step 12) only *explores* single-system rendering; the modes land with their
  consumers (blog embeds, exercises — Components 15–16).
- **The Verovio 6.2.0 upgrade itself** (ADR-013). Component 10 builds the
  snapshot guards; the deliberate upgrade event is **M14 / Component 14**.
- **M1–M13 Track M items.** Only M0 (editor repair) is slotted alongside
  Component 10; the editorial data-fix sweep (M1/M2), the public-surface fixes
  (M6/M7/M11/M12), and the rest keep their `phase-2.md` Track M slots.
- **The reserved preview-caching option** (`security-model.md` § 4): keeping
  previews/incipits public while signing only source MEI. Component 10 signs
  everything; revisit only if a caching regression appears.

---

## Sequencing

Part 1 is the hard first task; Parts 2–4 must all be green before the public
surface is switched on (the Component-10 exit gate); Part 5 (spike), Part 6
(tests), and Part 7 (M0) are parallel streams off the critical path.

```
Step 1  (soundfonts bucket split)            ← FIRST — gates everything public
Step 2  (presign MEI/incipit/preview)        ← completes the storage boundary
        │
        ├─ Step 3  (public /api/v1/public/ router)      ← needs Step 1–2
        │  Step 4  (ADR-009 ABC exclusion enforcement)
        │  Step 5  (public frontend read views)
        │
        ├─ Step 6  (PyJWT migration → flip CI audit)     ┐ parallel with Part 2;
        │  Step 7  (token storage / session UX)          ┘ all green before exit
        │
        ├─ Step 8  (rate limiting)            ┐
        │  Step 9  (security headers / CSP)   │ parallel; all green before the
        │  Step 10 (OpenAPI docs gate)        │ public surface goes live
        │  Step 11 (CORS preview fallback)    ┘
        │
        ├─ Step 12 (horizontal rendering spike)          ← independent; early
        │
        ├─ Step 13 (Verovio snapshot guards) ┐
        │  Step 14 (Playwright e2e scaffold) │ trail the feature work
        │  Step 15 (pytest 9 migration)      ┘
        │
        └─ Step 16 (M0 fragment editor repair)           ← parallel editorial stream
```

The exit gate is not "the public views render" — it is "**every backlog §2 item
(Steps 1–11) is green and the public surface can be switched on safely.**" The
spike, the snapshot/e2e/pytest work, and M0 do not gate the public switch-on but
should be complete before Component 11 begins (M0 because Component 11 is the
first public exposure of fragment data; the snapshot guards because Component
14's Verovio upgrade depends on them; the spike because Component 16 planning
wants its findings).

---

## Docs to Update (Definition of Done)

Per CLAUDE.md's Definition of Done, update the docs whose area this component
touches, in the same change as the work:

- **`security-model.md`** — § 4: record the soundfonts/artifact bucket split and
  the retirement of the public-URL branch + cache-buster for artifact keys as
  *shipped* (not just decided); § 2: rate limiting implemented; § 7: headers
  implemented; § 1: the public-router CORS posture and the `ALLOWED_ORIGINS`
  fallback; the OpenAPI-docs gate decision.
- **New ADR extending ADR-016** — the token-storage end state (Step 7);
  ADR-016's `localStorage` exception closed with a pointer.
- **`ADR-009`** — an implementation note that the ABC-corpus exclusion is now
  *enforced* on the public path (Component 8 built the derivation; Component 10
  enforces it).
- **`deployment.md`** — the two-bucket layout (soundfonts public / artifacts
  private) and any new env vars (`ALLOWED_ORIGINS`, the bucket names, the
  rate-limit Redis wiring).
- **`CONTRIBUTING.md`** — the Playwright e2e scaffold and the pytest 9 /
  pytest-asyncio 1.x migration in the testing section.
- **`phase-2.md`** — tick the Component 10 items as they land; move any decision
  confirmed during implementation into the Decisions Log.
- **`phase-2-entry-backlog.md`** — strike each §2 item with its landing commit
  as it ships (per the register's maintenance note); strike M0 in the Track M
  table when the editor repair lands.
- **`docs/reports/`** — the horizontal-rendering spike findings report (Step 12).

---

## Hard Gates Before Component 11 Begins

1. **The storage boundary is closed:** soundfonts are served from a public
   bucket; MEI/incipit/preview are private and served only via presigned URLs
   with the `security-model.md` § 4 TTLs; the artifact cache-buster is retired.
2. **The public read path is live and safe:** the `/api/v1/public/` router
   serves `approved`-only browse and detail anonymously; the ADR-009 ABC-corpus
   exclusion is enforced (proven by a fixture test); no non-`approved` or
   excluded fragment is reachable or its existence leaked; the editor routes are
   unchanged.
3. **Auth debt is retired:** python-jose is gone (PyJWT in `auth.py`), the CI
   audit job is blocking and green, and the `localStorage` JWT exception is
   closed with a working session/refresh mechanism recorded in an ADR.
4. **The public-launch guards are live:** rate limiting (429 + envelope +
   `Retry-After`), the CSP/HSTS/nosniff headers (validated against the public
   views and the Verovio/MIDI path), the OpenAPI-docs production gate, and the
   `ALLOWED_ORIGINS` CORS fallback.
5. **The rendering spike is reported:** a findings report exists under
   `docs/reports/` covering movement-length single-system rendering with
   scroll-synced playback, its workarounds, and its implication for the ADR-024
   contract and Component 16.
6. **Test infrastructure exists:** the Verovio snapshot guards are populated and
   in CI (ready to gate the M14 upgrade); the Playwright e2e scaffold covers the
   anonymous read journey; the suite runs under pytest 9 / pytest-asyncio 1.x.
7. **M0 is cleared:** the fragment editor prefills concept, stages, harmony, and
   commentary on edit, switches to editing brackets, and round-trips a saved
   edit — verified on a real fragment in the UI, not only in unit tests — so the
   M1/M2 editorial sweep is unblocked and Component 11 exposes correct data.
8. The touched docs reflect the shipped behaviour; the backlog §2 items and M0
   are struck with their landing commits.
