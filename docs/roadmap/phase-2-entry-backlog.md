# Phase-2 Entry Backlog — Deferred Work Carried Out of Phase 1

**Status:** living register, consolidated 2026-07-10 during Component 9 Part 9.
**Purpose:** one findable place for (§1) the agreed pre-Step-32 batch and (§2–§5)
everything Phase 1 deliberately leaves open — gathered from the Part 8/9 review
reports, the security model, the ADRs, and the Component 9 plan. This is the
document the `phase-1.md` close-out section (Step 32) points to, and the first
input to Phase-2 planning.

**Scope note:** this is the *debt and deferral* register. The Phase-2 feature
roadmap itself (blog, collections, exercises, user infrastructure) lives in
`project-architecture.md` § Development Roadmap and is not duplicated here.

---

## 1. Pre-Step-32 batch — ✅ landed 2026-07-11 (campaign closed 2026-07-11)

Agreed 2026-07-09/10 (Step 30 § 5.3, Step 31 § Findings). Landed as one batch,
gated on the full unit + integration suites passing, before Step 32 close-out.

**Gate results (2026-07-11, local):** unit 789/789; integration 141/141 —
against a DB carrying real campaign data, the exact condition that motivated
B5; graph 44/44; black/isort/ruff, crossref lint, `pip check` all clean.
*Known local nit:* on Windows the integration run passes all tests, then hangs
at exit in pytest-asyncio's session-loop close (`IocpProactor._poll`) — CI
(Linux) is unaffected; if it recurs, try `WindowsSelectorEventLoopPolicy` in
the integration conftest. Not bisected against the old pins.

| # | Item | Outcome |
|---|---|---|
| B1 | ~~**fastapi + starlette bump**~~ | ✅ fastapi 0.115.6 → 0.139.0, starlette 0.41.3 → 1.3.1; all 7 starlette advisories cleared; one starlette-1.x rename absorbed (`HTTP_422_UNPROCESSABLE_CONTENT` in `errors.py`) |
| B2 | ~~**lxml 5.3 → 6.1**~~ | ✅ lxml 6.1.1; PYSEC-2026-87 cleared; normalizer suite green |
| B3 | ~~**pip-audit + CI audits, report-only**~~ | ✅ `pip-audit==2.10.1` in `requirements-dev.txt`; `audit` job in `ci.yml` (pip-audit + npm audit). Backend `pip-audit` flipped to **blocking** with the PyJWT migration (§2, `7080ee4`); npm audit remains report-only at the step level (ESLint dev-tooling transitives only, never shipped) |
| B4 | ~~**JWT `issuer=` verification**~~ | ✅ `iss` verified against `SUPABASE_URL/auth/v1` whenever `SUPABASE_URL` is set; wrong/missing issuer → 401; unit-tested. Staging login verified 2026-07-11 after deploy (real Supabase tokens accepted) |
| B5 | ~~**Review-queue integration-test isolation**~~ | ✅ queue tests walk all cursor pages and scope to inserted ids; sweep found the same assumption in `test_concept_browse_api.py` (browses real PAC/AC concept ids) — fixed with the same full-walk helper. `test_fragment_read_api` / `test_browse_api` were already isolated (fresh movement / unique slug) |
| B6 | *(optional ride-along — not taken)* | pytest 8→9 blocked: pytest-asyncio 0.24 pins `pytest<9`, so the bump requires the pytest-asyncio 1.x migration — moved to §2 alongside the PyJWT item. black 24→26 tree reformat not ridden (churn); land as an isolated `chore:` commit whenever wanted |

---

## 2. Phase-2 security & infrastructure debt

Items with a hard trigger: **all of §2 must land before any public
(unauthenticated) URL or user exists**, unless noted.

| Item | What & why | Pointer |
|---|---|---|
| ~~**Signed-URL end state — option (b)**~~ | ✅ Landed `ff5e1f1` (Component 10 Steps 1–2, 2026-07-20): soundfonts moved to the dedicated public `doppia-soundfonts` bucket (frontend-only via `VITE_SOUNDFONT_BASE_URL`); artifact bucket private, `signed_url()` always presigns (1 h / 15 m TTLs); `R2_PUBLIC_URL` and the `?v=` cache-buster removed. Preview-caching trade-off held in reserve per `security-model.md` § 4. | `security-model.md` § 4 (shipped); Step 31 report § 5 |
| ~~**Public endpoints + ADR-009 enforcement**~~ | ✅ Landed (Component 10 Steps 3–5): the `/api/v1/public/` router (`071a525`) serves anonymous `approved`-only browse/detail with a path-scoped CORS split; the ADR-009 NonCommercial-corpus exclusion is enforced structurally in the service (`10a5e62`, keyed on corpus licence, proven by an ABC fixture test); and the anonymous frontend read views ship on a minimal public shell at `/public/concepts` and `/public/fragments/:id`, reusing the Component 8 preview cards and the detail render/MIDI/licence view. The public topbar / audience-split nav remains Component 12. | ADR-009 § Implementation note; `phase-1.md` Component 8 § Phase 1 scope |
| ~~**PyJWT migration**~~ | ✅ Landed `7080ee4` (Component 10 Step 6, 2026-07-21): python-jose replaced by `PyJWT[crypto]==2.13.0` in `api/middleware/auth.py` (the only module importing `jose`). ES256/JWKS `kid`-matching is now explicit via `PyJWKSet` (`_resolve_jwk`) where python-jose matched implicitly; HS256, issuer verification, expiry, and the 401 envelope are unchanged; ES256 test coverage added (valid/unknown-kid/wrong-key/expired). Backend `pip-audit` flipped to **blocking** in `ci.yml` (tree clean; PyJWT 2.10.1 itself carried newer advisories, hence the 2.13.0 pin); npm audit stays report-only at the step level (ESLint dev-tooling transitives only). | Step 30 report § 5.3.3 |
| **pytest 9 + pytest-asyncio 1.x migration** | pytest 8→9 (PYSEC-2026-1845, dev-only) is blocked by pytest-asyncio 0.24's `pytest<9` pin; bumping means migrating the async test configuration to pytest-asyncio 1.x. Deferred from the pre-Step-32 batch (B6). | Step 30 report § 5.3.4 |
| ~~**Token storage + full session UX**~~ | ✅ Landed `f40fba5` (Component 10 Step 7, 2026-07-21): access token in SPA memory, refresh token in an HttpOnly + `SameSite=Lax` + path-scoped cookie, credential exchange proxied server-side (`services/supabase_auth.py`, `api/routes/auth.py`) so the refresh token never reaches JS. `AuthProvider` bootstraps the session on load and silently refreshes before expiry; NavBar user dropdown + sign out. `localStorage` JWT retired (dev-token bypass kept dev-only). ADR-016 exception closed → **ADR-035**. | ADR-035 (extends ADR-016); `part-8-campaign-triage.md` § full session UX |
| ~~**Rate limiting**~~ | ✅ Landed `26daa4a` (Component 10 Step 8, 2026-07-22): `slowapi` in `api/rate_limiting.py`, registered on `app.state.limiter`. Sync `redis://` storage reuses the pinned `redis` client (no `coredis`, no new service), selected by `RATELIMIT_STORAGE_URI` (default `memory://` for local/tests), fails open on a store blip. Keyed per-user (`user:{sub}`) for authenticated calls and per-IP (Fly-Client-IP → X-Forwarded-For → remote) for anonymous. The anonymous public router is covered first (60/min); each editor category is applied at its representative entrypoint (read 300/min, write 60/min, graph 60/min, upload 20/min). 429s carry the standard envelope + `Retry-After`. | `security-model.md` § 2 (shipped) |
| **Security headers** | CSP (restrictive policy drafted, `worker-src blob:` for Verovio WASM), HSTS once the production domain exists, `X-Content-Type-Options: nosniff`. | `security-model.md` § 7 |
| **OpenAPI docs exposure** | `/api/docs`, `/api/redoc`, `/api/openapi.json` are publicly reachable (no data, but they enumerate the API). Decide gate-or-disable for production. | Step 31 report § Findings 3 |
| **CORS for PR preview environments** | `ALLOWED_ORIGINS` env-var fallback so preview deploys don't require code changes. Cheap; do whenever previews appear. | `security-model.md` § "Could be done in Phase 1" |

---

## 3. Product/UX debt from the campaign and the Part 9 reviews

No hard trigger; prioritise at Phase-2 planning. Mechanisms are recorded so
each fix starts warm.

| Item | What & why deferred | Pointer |
|---|---|---|
| **G1 — beat-range display convention** | `displayEndBeat` can render "beats 1⅔–1" (end < start) for sub-beat ranges ending on a whole bound. Display-only; Francisco chose a permanent convention review over another partial patch. Minimal clamp is on file if it starts to hurt. | `part-8-campaign-triage.md` § deferrals table (mechanism incl. file/lines) |
| **Pickup / partial-bar beat numbering** | Transport shows "beat 1" for a pickup; the right fix is meter-aware offsets through the ADR-005 beat encoding — ADR-005/ADR-015-adjacent design work, touches stored-coordinate questions. | same table |
| **Caret at repeat barlines** | Hold-at-last-anchor is correct but inelegant; the polished version needs synthetic barline anchors in `buildCaretTrack`. Cosmetic. | same table |
| **Fragment edit/lifecycle UI** | No Edit affordance from the fragment viewer / no clear annotator lifecycle after approval; investigation answered in the triage report, UI deferred. | `part-8-campaign-triage.md` § fragment edit lifecycle |
| **`harmony_gate` seeding** | Cadence concepts should require harmony confirmation at tag time; deferral verified safe (no wrong data, only absent gate). When it lands, run the one-time confirmation sweep over pre-gate approved fragments. | `part-8-campaign-triage.md` § harmony_gate investigation |
| **Duplicate-`@n` display disambiguation** | The ADR-015 amendment deferred a display-time section qualifier ("Menuetto" vs "Menuetto da capo") for multi-section movements (K331/ii) to Step 15; **it was not implemented there and remains open**. Labels are display-only (mc is the join key), so no data risk. | ADR-015 § Amendment; `mei-ingest-normalization.md` § Step 8 disposition |
| **Design-debt register F8–F13** | Shared list-panel scaffold; hover-scroll preview extraction; layout width tokens; work-attribution component; shared button/control library; review-queue score previews. | `step-17-design-coherence-review.md` § Bucket 2 |
| **Verovio 6.2.0** | Available; upgrade only as a deliberate, verified event per ADR-013 (snapshot guards below make this safer). No advisory pressure. | ADR-013 |

---

## 4. Deferred features (by design, not debt)

| Item | Scope note | Pointer |
|---|---|---|
| **Component 6 — music21 auto-analysis** | The whole music21 fallback + bass/soprano top-up pass; `bass_pitch`/`soprano_pitch` render "not computed" until then. DCML covers the Phase-1 corpus; becomes relevant with the first non-DCML corpus (When in Rome path is also unbuilt). | `phase-1.md` Component 6 as-built note; ADR-004 |
| **Multi-domain fragment filter** | Designed (URL schema, per-domain sections, AND-across/OR-within semantics, `?root` redirect); build when a second domain is seeded. | Component 9 plan § Step 14 design note |
| **Beat-precision play-from-position + repeat-pass targeting** | Step 20 shipped measure-level Alt-click; beat precision and second-pass-of-a-repeat targeting deferred. | `playback-coordinates.md` § Play-from-position |
| **Scrollytelling / fragment rendering modes** | ADR-024 context modes (`bars`, `enclosing_fragment`, `previous_same_domain`) are accepted-and-ignored by the API; implement with their consumers (blog embeds, exercises). One-system/scrollytelling rendering is the same hook. | ADR-024; Component 9 plan § Step 15 note |
| **Second-language machinery (beyond UI strings)** | Concept/definition/prose Spanish; translation editorial UI; staleness job (`source_hash`); frontend `translation_missing` rendering; translator role + docs. UI-string Spanish shipped in Phase 1; the `es` overlay fallback path is exercised end to end. | ADR-006 § "Before launching a second language" |
| **Snapshot tests (Verovio regression guards)** | `tests/snapshots/` scaffolded empty; populate as the guard for the next Verovio upgrade. | CLAUDE.md § Tests; ADR-013 |
| **Phase-2 user tables** | `collection`, `collection_fragment`, `exercise_result`, `reading_history` (PK-includes-time note recorded), `app_user.self_declared_role`. Schema sketches drafted. | `tech-stack-and-database-reference.md` § User infrastructure |

---

## 5. Corpus/data notes for Phase-2 planning

- **K331/ii is the corpus's worst-case encoding** (multi-section duplicate `@n`,
  trio repeat repair via ADR-033, densest warning family). Any future
  upstream-source cleanup or corpus re-preparation starts there.
  Pointers: `mei-ingest-normalization.md` § Warning severity and dispositions;
  `ingestion-warnings.json`.
- **Corpus is frozen** as of Step 11; any Phase-2 MEI correction follows the
  full ADR-004/ADR-008 re-ingestion protocol with fragment mc-stability
  verification (`scripts/verify_mc_stability.py`, snapshot under
  `docs/reports/component-9-reports/`).

---

*Maintenance: when an item lands, strike it here with the landing commit; when
Phase-2 planning turns an item into real scope, move it into the Phase-2 plan
and leave a pointer.*
