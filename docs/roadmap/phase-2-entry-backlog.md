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

## 1. Pre-Step-32 batch (still Phase 1 — runs when the campaign closes)

Agreed 2026-07-09/10 (Step 30 § 5.3, Step 31 § Findings). One batch, gated on
the full unit + integration suites passing, landed before Step 32 close-out.

| # | Item | Source / pointer |
|---|---|---|
| B1 | **fastapi + starlette bump** — clears the 7 starlette advisories (fix versions ≥ 0.47.2); touches auth middleware, routing, TestClient behaviour | Step 30 report § 5.3.1 |
| B2 | **lxml 5.3 → 6.1** (PYSEC-2026-87) — major bump of the normalizer/validator parser; the 797-test normalizer suite is the net | Step 30 report § 5.3.2 |
| B3 | **pip-audit into `requirements-dev.txt` + `pip-audit`/`npm audit` in CI, report-only** — flip to blocking once B1/B2 land | Step 30 report § 5.4; `security-model.md` § "Could be done in Phase 1" |
| B4 | **JWT `issuer=` verification** in `api/middleware/auth.py` — the code comment previously claimed iss verification that didn't exist (comment fixed in Step 31); adding the real check is a behaviour change needing a staging login test | Step 31 report § Findings 1 |
| B5 | **Review-queue integration-test isolation** — pagination assertions assume an empty DB and break against any DB with real submitted fragments; scope assertions to inserted ids and sweep the other integration suites for the same assumption. *(Routed to Step 30 by the triage report; missed in the Step 30 sweep — picked up here.)* | `part-8-campaign-triage.md` § review-queue test isolation |
| B6 | *(optional, ride-along)* black 24→26 (tree reformat — isolated `chore:` commit) and pytest 8→9 (dev-only advisory) | Step 30 report § 5.3.4 |

---

## 2. Phase-2 security & infrastructure debt

Items with a hard trigger: **all of §2 must land before any public
(unauthenticated) URL or user exists**, unless noted.

| Item | What & why | Pointer |
|---|---|---|
| **Signed-URL end state — option (b)** | Restrict R2 public access to a soundfonts-only public bucket; MEI/incipit/preview go back through presigned URLs. Decided 2026-07-10; **first Phase-2 task** — it is a prerequisite for ADR-009 enforcement (source MEI of an excluded corpus must not be publicly fetchable) and for any public launch. Known trade-off recorded: presigned URLs defeat browser caching of previews. | `security-model.md` § 4 (decision block); Step 31 report § 5 |
| **Public endpoints + ADR-009 enforcement** | The unauthenticated `approved`-only browse path and the ABC-corpus exclusion. The per-fragment `data_licence`/`harmony_sources` serialiser is already built and wired (Component 8) — Phase 2 adds the public route and the exclusion check. Depends on option (b) above. | ADR-009; `phase-1.md` Component 8 § Phase 1 scope |
| **PyJWT migration** | python-jose has an unfixable advisory (PYSEC-2025-185) and an unfixable transitive (`ecdsa`); upstream effectively unmaintained. Replace in `api/middleware/auth.py`. | Step 30 report § 5.3.3 |
| **Token storage + full session UX** | ADR-016's localStorage exception is scoped to Phase 1's internal deployment and "must be revisited before Phase 2 public launch": evaluate HttpOnly cookie vs full Supabase JS client (which also brings token refresh — the triage's "full session UX" item: refresh, user dropdown; the minimal `exp` patch shipped in Component 9). | ADR-016 § Consequences; `part-8-campaign-triage.md` § full session UX |
| **Rate limiting** | `slowapi` + Redis, per-user keys on expensive endpoints; starting limits already tabled. Implement before public traffic. | `security-model.md` § 2 |
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
