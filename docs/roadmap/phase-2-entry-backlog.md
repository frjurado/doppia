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

✅ **Public-launch exit gate met (Component 10, 2026-07-22).** Every §2 item
that gates a public URL is live and deployed to staging: storage boundary,
public read path + ADR-009 enforcement, PyJWT + HttpOnly session, rate limiting,
security headers, OpenAPI production gate, and the `ALLOWED_ORIGINS` CORS
fallback (plan Steps 1–11). The last §2 row — the dev-only **pytest 9 +
pytest-asyncio 1.x migration** (plan Step 15, Part 6) — landed 2026-07-22, so
**all of §2 is now complete**; it never gated public launch.

| Item | What & why | Pointer |
|---|---|---|
| ~~**Signed-URL end state — option (b)**~~ | ✅ Landed `ff5e1f1` (Component 10 Steps 1–2, 2026-07-20): soundfonts moved to the dedicated public `doppia-soundfonts` bucket (frontend-only via `VITE_SOUNDFONT_BASE_URL`); artifact bucket private, `signed_url()` always presigns (1 h / 15 m TTLs); `R2_PUBLIC_URL` and the `?v=` cache-buster removed. Preview-caching trade-off held in reserve per `security-model.md` § 4. | `security-model.md` § 4 (shipped); Step 31 report § 5 |
| ~~**Public endpoints + ADR-009 enforcement**~~ | ✅ Landed (Component 10 Steps 3–5): the `/api/v1/public/` router (`071a525`) serves anonymous `approved`-only browse/detail with a path-scoped CORS split; the ADR-009 NonCommercial-corpus exclusion is enforced structurally in the service (`10a5e62`, keyed on corpus licence, proven by an ABC fixture test); and the anonymous frontend read views ship on a minimal public shell at `/public/concepts` and `/public/fragments/:id`, reusing the Component 8 preview cards and the detail render/MIDI/licence view. The public topbar / audience-split nav remains Component 12. | ADR-009 § Implementation note; `phase-1.md` Component 8 § Phase 1 scope |
| ~~**PyJWT migration**~~ | ✅ Landed `7080ee4` (Component 10 Step 6, 2026-07-21): python-jose replaced by `PyJWT[crypto]==2.13.0` in `api/middleware/auth.py` (the only module importing `jose`). ES256/JWKS `kid`-matching is now explicit via `PyJWKSet` (`_resolve_jwk`) where python-jose matched implicitly; HS256, issuer verification, expiry, and the 401 envelope are unchanged; ES256 test coverage added (valid/unknown-kid/wrong-key/expired). Backend `pip-audit` flipped to **blocking** in `ci.yml` (tree clean; PyJWT 2.10.1 itself carried newer advisories, hence the 2.13.0 pin); npm audit stays report-only at the step level (ESLint dev-tooling transitives only). | Step 30 report § 5.3.3 |
| ~~**pytest 9 + pytest-asyncio 1.x migration**~~ | ✅ Landed (Component 10 Step 15, 2026-07-22): `pytest` 8.3.4→9.1.1, `pytest-asyncio` 0.24.0→1.4.0, `pytest-cov` 6.0.0→7.1.0. No async-config migration was needed — no `event_loop` overrides exist, and `asyncio_mode="auto"` + `asyncio_default_fixture_loop_scope="session"` carry over unchanged. Unit+snapshot (854) and integration/graph suites pass under 9/1.x; single-file Windows integration runs still exit clean (no `IocpProactor` hang reintroduced). Clears PYSEC-2026-1845 (dev-only). | Step 30 report § 5.3.4 |
| ~~**Token storage + full session UX**~~ | ✅ Landed `f40fba5` (Component 10 Step 7, 2026-07-21): access token in SPA memory, refresh token in an HttpOnly + `SameSite=Lax` + path-scoped cookie, credential exchange proxied server-side (`services/supabase_auth.py`, `api/routes/auth.py`) so the refresh token never reaches JS. `AuthProvider` bootstraps the session on load and silently refreshes before expiry; NavBar user dropdown + sign out. `localStorage` JWT retired (dev-token bypass kept dev-only). ADR-016 exception closed → **ADR-035**. | ADR-035 (extends ADR-016); `part-8-campaign-triage.md` § full session UX |
| ~~**Rate limiting**~~ | ✅ Landed `26daa4a` (Component 10 Step 8, 2026-07-22): `slowapi` in `api/rate_limiting.py`, registered on `app.state.limiter`. Sync `redis://` storage reuses the pinned `redis` client (no `coredis`, no new service), selected by `RATELIMIT_STORAGE_URI` (default `memory://` for local/tests), fails open on a store blip. Keyed per-user (`user:{sub}`) for authenticated calls and per-IP (Fly-Client-IP → X-Forwarded-For → remote) for anonymous. The anonymous public router is covered first (60/min); each editor category is applied at its representative entrypoint (read 300/min, write 60/min, graph 60/min, upload 20/min). 429s carry the standard envelope + `Retry-After`. | `security-model.md` § 2 (shipped) |
| ~~**Security headers**~~ | ✅ Landed `78cd7f2` (Component 10 Step 9, 2026-07-22): `SecurityHeadersMiddleware` stamps a restrictive CSP, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY` on every response; HSTS only when `ENVIRONMENT=production`. The CSP is derived from what the SPA actually loads — `'wasm-unsafe-eval'` for the Verovio WASM toolkit, the R2 hosts for MEI/preview/soundfonts, and no `*.supabase.co` (the browser no longer calls Supabase directly, ADR-035). `CSP_REPORT_ONLY=1` is a diagnostics valve. Post-deploy browser validation (Verovio/MIDI/no console violations) pending. | `security-model.md` § 7 (shipped) |
| ~~**OpenAPI docs exposure**~~ | ✅ Landed `0fcde03` (Component 10 Step 10, 2026-07-22): `create_app()` disables `/api/docs`, `/api/redoc`, `/api/openapi.json` in production (`docs_url`/`redoc_url`/`openapi_url=None` when `ENVIRONMENT=production` → routes unregistered, schema never served); reachable in local/staging for development. | `security-model.md` § 7 (shipped) |
| ~~**CORS for PR preview environments**~~ | ✅ Landed `d6f04da` (Component 10 Step 11, 2026-07-22): `_resolve_origins()` unions a comma-separated `ALLOWED_ORIGINS` env var with the static per-environment allowlist so Fly PR-preview deploys need no code change. Explicit origins only — normalised, de-duped, and a literal `*` dropped (the credentialed policy never goes wildcard). | `security-model.md` § 1 (shipped) |

---

## 3. Product/UX debt from the campaign and the Part 9 reviews

No hard trigger; prioritise at Phase-2 planning. Mechanisms are recorded so
each fix starts warm.

| Item | What & why deferred | Pointer |
|---|---|---|
| ~~**G1 — beat-range display convention**~~ | ✅ Decided — Component 12 Step 20 (ADR-005 amendment, 2026-09-10): the label names the first and last *included onset*, unit inferred from the endpoints' precision; end ≥ start by construction, no clamp. **Residual (phase 2, low):** the rule infers the last onset rather than knowing it; the exact version records the last included ghost's onset at commit time as a display-only field, backfilled from the timemap. Only worth doing if a real render ever contradicts its bracket. | ADR-005 § "range-label convention"; `component-12-user-infrastructure.md` § Step 20 |
| **Pickup / partial-bar beat numbering** | Transport shows "beat 1" for a pickup; the right fix is meter-aware offsets through the ADR-005 beat encoding — ADR-005/ADR-015-adjacent design work, touches stored-coordinate questions. | same table |
| **Caret at repeat barlines** | Hold-at-last-anchor is correct but inelegant; the polished version needs synthetic barline anchors in `buildCaretTrack`. Cosmetic. | same table |
| **Fragment edit/lifecycle UI** | No Edit affordance from the fragment viewer / no clear annotator lifecycle after approval; investigation answered in the triage report, UI deferred. | `part-8-campaign-triage.md` § fragment edit lifecycle |
| ~~**`harmony_gate` seeding**~~ | ✅ Landed — Component 11 Step 13F (e1221aa, 2026-07-30). Declared on `Cadence`; every subtype inherits it through `IS_SUBTYPE_OF`. The confirmation sweep ran first (K279 + K280, 465/465 in-fragment events), and pre-seed exposure was measured at 14 of 383 fragments, none of them approved — so no already-public example was invalidated. | `component-11-concept-glossary.md` § 13F |
| **Unify the three stage-bracket geometry implementations** | The same bar/beat→pixel projection exists three times: `stageFrame.buildStageSlots` (editor stage frame), `MainBracket.resolveSegments` (score viewer, live + stored brackets), and `FragmentNotation.computeBracketSegments` (fragment viewer and glossary examples). They have drifted, and the drift is not theoretical — **the same class of endpoint bug has now been fixed separately in all three**: M7 in `stageFrame` (Step 11), independent endpoints in `resolveSegments`, and an exclusive `beat_end` landing on a barline in `computeBracketSegments` (both in the Component 11 triage). A bug fixed in one view kept living in another, which is exactly how the third was found — by a reader noticing the glossary disagreed with the score viewer. Consolidating onto one projection is the durable fix; the shapes differ (ghost-layer indices vs SVG rects read from the DOM), so it needs a common input abstraction rather than a copy-paste merge. | Component 11 triage items 5 and the follow-up; `tagging-tool-design.md` § 6A.4 |
| ~~**Duplicate-`@n` display disambiguation**~~ | ✅ Landed — Component 11 Step 9 (ADR-036, 2026-07-25). The survey that preceded it corrected the record twice: Family A is **K331/ii alone**, and the volta family **does not exist** — second endings carry X-prefixed `@n`, so ADR-015 and `mei-ingest-normalization.md` § 6 both described a convention the corpus never followed. Solved with an mc-keyed `movement_section` table naming sections from the MEI's own `<dir>`, plus `qualifyRange` as the single display convention. | ADR-036; `component-11-concept-glossary.md` § Step 9 |
| **Glossary: "more specific types" as a hierarchy** | The concept page renders a flat list of the *direct* `IS_SUBTYPE_OF` children, which is all `ConceptDetailResponse` carries. Nesting needs descendant data — an API-shape decision plus a component rewrite. The index endpoint already returns a domain forest the frontend assembles, so the pieces exist. Raised in the Component 11 triage (item 6); not a bug. | `component-11-reports/component-11-triage.md` § 6 |
| **Collapsible property groups** | ADR-023 groups already render as a labelled cluster, which covers "put the rare properties together". Actually *hiding* them behind a disclosure needs a default-collapsed flag on the `HAS_PROPERTY_SCHEMA` edge and the control to go with it. Only worth doing if the cluster proves insufficient once Component 12 groups them. | `component-11-reports/component-11-triage.md` § 9 |
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
| **Concept `notes` field (glossary)** | A second optional prose block rendered below the definition, for analytical distinctions that don't belong inside a one-paragraph definition — e.g. the one-event `ReinterpretedAsHC` vs two-event `ReopeningHalfCadence` split. Motivated by the Component 11 Step 13E review pass, which rewrote the cadence definitions as public prose and left that material with no public home. Touches `ConceptYAML` (currently `extra="forbid"`), both MERGE branches in `graph/queries/seed.py`, the concept-detail Cypher, `ConceptDetailResponse`, `ConceptPage`, and tests; gate it on the same `definition_reviewed` flag. | `cadences-design.md` § Terminology and prose conventions |
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
