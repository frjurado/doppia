# Doppia — Development History

**Covers:** 2026-04-16 (initial commit) → 2026-09-11 (last commit on `main`, PR #32)
**Written:** 2026-10-04, from the git history (`git log`), the merged PRs, the roadmap
documents under `docs/roadmap/`, the ADRs, and the reports under `docs/reports/`.
**Scope:** what was built, in what order, and what proved hard. For the detailed
record of any single component, follow the links to its roadmap doc.

---

## 1. At a glance

| | |
|---|---|
| Elapsed time | ~5 months (148 days) |
| Commits on `main` | 499 (471 non-merge, 28 merge commits) |
| Merged pull requests | 28 (PR #1 → #32; #12–14 and #22 were never merged) |
| Architecture Decision Records | 40 (ADR-001 → ADR-040) |
| Tags | `phase1/complete` (2026-07-11) |
| Phases | Phase 1 closed 2026-07-11; Phase 2 in progress (Components 10–12 done) |
| Corpus | Mozart piano sonatas: 18 sonatas / 54 movements, frozen at the end of Phase 1 |
| AI pairing | ~450 commits carry a Claude co-author trailer (Sonnet 4.6 ×257, Opus 5 ×81, Opus 4.8 ×76, Fable 5 ×37) |

**Commits per month (non-merge):**

| Apr | May | Jun | Jul | Aug | Sep |
|---:|---:|---:|---:|---:|---:|
| 76 | 112 | 128 | 97 | 27 | 31 |

The volume peaked in May–June (tagging tool, fragment database, corpus
hardening). After that, commits got fewer and bigger: Component 12 is 52 commits
over 21 steps, and its later commits fold in design reviews and verification
records rather than one feature each.

---

## 2. Timeline

```
Apr 16 ─ Foundation ─ Apr 20
         Apr 20 ─ C1 MEI ingestion ─ Apr 22
                  Apr 23 ─ C2 Corpus browsing ─ Apr 25
                           Apr 26 ── Code-review remediation (reports 1–7), staging + CI ── May 04
                                     May 04 ─ ADR-015 dual measure coordinates
                                     May 04 ─ C3 Score viewer + MIDI ─ May 07 (polish to May 25)
                                              May 08 ─ C4 Knowledge graph (cadences) ─ May 24
                                                       May 26 ─ Accidental normalization (ADR-021/022)
                                                       May 26 ─ C5 Tagging tool ─ Jun 04
                                                                Jun 04 ─ C7 Fragment DB ─ Jun 08
                                                                         Jun 08 ─ C8 Fragment browsing ─ Jun 11
                                                                                  Jun 11 ─ C9 Corpus population & hardening ─ Jul 11
                                                                                           ★ Jul 11  Phase 1 complete (tag)
Jul 16 ─ Phase 2 roadmap
         Jul 16 ─ C10 Foundations & public read path ─ Jul 23
                  Jul 23 ─ C11 Concept glossary ─ Aug 26   (pause Jul 30 → Aug 24)
                           Aug 26 ─ C12 User infrastructure ─ Sep 11
                                    Oct 01 ─ Production-launch planning (pre-decision)
```

Component 6 (the music21 preprocessing pipeline) was **deferred whole**:
DCML analyses cover the corpus, so the music21 fallback has not been needed.

---

## 3. Phase 1 — Notation infrastructure (2026-04-16 → 2026-07-11)

Phase 1 had one aim: build the notation infrastructure, the knowledge graph and
the editorial tagging tools, and prove them on a real corpus before building
anything public.

### 3.1 Foundation (Apr 16–20 · PRs #1–#5)

- **Apr 16:** initial commit. It held the general docs, the Phase 1 roadmap and
  **ADR-001 to ADR-012 already written**, so the main decisions came before any
  code: Supabase auth, S3-compatible storage, Verovio display, React, a
  multi-level tagging design, the DCML licensing constraint, and i18n strategy.
  The same day: `CLAUDE.md` and the project scaffold.
- Docker Compose (Neo4j, PostgreSQL + pgvector, Redis, MinIO), `.env`-driven
  config, API conventions (error envelope, cursor pagination) wired in before the
  first real endpoint, Alembic and the initial schema, the test scaffold.
- **Apr 19:** first staging deployment on **Fly.io** (`fly.toml`), with Neo4j Aura
  and Supabase. The trunk was renamed `master` → `main`.

*Difficulties:* environment friction, mostly on Windows: psycopg2 on Windows,
loading `.env` in Alembic and uvicorn, Dockerfile COPY paths for Fly's build
context, and the Aura detail that `NEO4J_USER` is the instance ID, not `neo4j`.

### 3.2 Component 1 — MEI corpus ingestion (Apr 20–22 · PR #6)

Delivered in nine numbered steps: Pydantic metadata models → async object-storage
client → MEI validation → the **MEI normalizer** → DCML corpus preparation →
upload endpoint, ingestion service and Celery scaffold → DCML analysis ingestion
→ end-to-end integration tests.

The normalizer became the most revisited module in the project. Its spec was
tightened twice in the first week (repeat barlines and endings; relying on
`@metcon` instead of counting beats).

### 3.3 Component 2 — Corpus browsing (Apr 23–25 · PR #7)

Incipit SVG generation as a Celery task, browse API endpoints, the design-system
foundation ("Opus Urtext": Henle Blue, Urtext Cream, 0px radius), and the
`CorpusBrowser` page. **Verovio was pinned to 6.1.0** (ADR-013) after a spike.

### 3.4 Code-review remediation, staging hardening and CI (Apr 26 – May 4 · PRs #8–#10)

A full review of code and docs produced **seven reports**
(`docs/reports/component-2-reports/`: docs/API, services/ingestion, ADRs,
architecture docs, frontend ×2, test suite). The following week went to
working through them.

- **Apr 27:** staging gained frontend serving, ES256 Supabase auth, a Celery
  worker on Fly with Upstash Redis, and **Cloudflare R2** (SigV4) storage. Login
  page and route protection. **GitHub Actions CI** (lint, unit, integration).
- Typed exception hierarchy, a refusal to start with `AUTH_MODE=local` outside
  `ENVIRONMENT=local`, pre-commit hooks (black/isort/ruff), and a Definition of
  Done added to `CLAUDE.md`.
- Frontend: Zod validation at the API boundary, self-hosted fonts, stylelint
  design-system rules, an accessibility baseline, Vitest.
- **May 5:** Row-Level Security enabled on all public tables, to block
  Supabase PostgREST anonymous access.

*Difficulties:* async event loops in tests. Python 3.12 and the integration
conftest needed the event loop pinned, re-pinned per test, and per-invocation
engines in Celery tasks to avoid a "reused event loop" crash. This kept
coming back for the rest of the project; see §5.

### 3.5 Measure numbering — ADR-015 (May 4 · PR #11)

A spike on Verovio's `measureRange` syntax led to the **dual measure coordinate
system**: `mc` (a stable, sequential measure count) and `mn` (the printed bar
number). Everything after this point (selection, fragments, harmony events,
playback) is addressed in these coordinates.

### 3.6 Component 3 — Score viewer and MIDI playback (May 4–7, polish to May 25 · PRs #15, #18, #19)

Verovio WASM service module, score viewer route, fragment-rendering
infrastructure, the MIDI playback hook and transport bar, playback highlighting,
SoundFont hosting on R2. Follow-ups in late May fixed width/centring and staff
sizes, highlights vanishing on repeated sections, pickup and non-quarter-beat
display in the transport, and enharmonic spelling in the transpose dropdown.

*Difficulties:* the Verovio WASM import needed a two-step init (wasm + esm);
the Docker build was blocked by `tsc -b` errors that `tsc --noEmit` did not
catch.

### 3.7 Component 4 — Knowledge graph, cadence domain (May 8–24 · PR #17)

- Tooling first (May 11): YAML seed schemas with Pydantic validation, the
  `MERGE`-only seeding script, the **10-check graph validator**, the pyvis
  visualizer.
- Then a pause of about ten days, and the **domain design**: the cadence domain
  draft (May 21), ADR-019 (BOOL cardinality), ADR-020 (`PREREQUISITE_FOR`
  pedagogical sequencing, kept acyclic), capture extensions, and the first
  `seed(cadences):` commit (May 23).
- Graph structure tests, a CI graph job, a pre-commit YAML validation hook, and
  the Neo4j Bloom perspective.

### 3.8 Accidental normalization (May 26 · PRs #20, #21)

An investigation into wrong accidentals in K.279/i
(`docs/investigations/accidentals-k279-mvt1`) found spurious gestural
accidentals left behind by the MusicXML → MEI conversion. Fixed in the normalizer
(ADR-021), then made key-signature-aware with section-boundary key changes
handled (ADR-022, K.331/iii). This was the first of many normalization ADRs.

### 3.9 Component 5 — Tagging tool (May 26 – Jun 4 · PR #23)

The editorial core of Phase 1. Backend: concept search and schema-tree
endpoints, the fragment write-validation layer, submission endpoints, harmony
event corrections, and the **review state machine with an approval gate**.
Frontend, in layers over the Verovio SVG (which is never modified):

- a **ghost structural layer** (invisible measure/beat/sub-beat hit regions),
- a selection behaviour layer, the main bracket track, the concept picker,
- a dynamic property form driven by the graph's PropertySchemas,
- **stages** (sub-part tagging per stage), a harmony summary panel, prose
  annotation, a submission checklist.

A post-implementation **remediation plan (G0–G7)** followed on Jun 1–4: save and
submit returning 500s, TAG-mode gating, re-render invalidation, repeat-barline
and ending barriers, beat x-anchoring to the notehead rather than the accidental
bbox, resolution-aware minimum stage width, and property/value ordering through
edge properties on the graph (ADR-023).

*Difficulties:* geometry. Ghost overlay projection across systems, bracket
margins, per-system bracket segments, and hover/drag semantics each needed
several fix commits, and one report was written just to pin the hover and drag
affordance bugs down.

### 3.10 Component 7 — Fragment database CRUD and display (Jun 4–8 · PR #24)

Stage checklist semantics and pre-population, read/update/delete endpoints with
delete permissions and parent cascade, stored-fragment overlays with brackets and
alias labels, a fragment side panel, a reviewer work queue, approve/reject in the
panel, and in-score harmony chord labels.

### 3.11 Component 8 — Fragment browsing (Jun 8–11 · PR #25)

Downward `IS_SUBTYPE_OF` subtree traversal with a Redis cache, the
concept-scoped fragment list, the fragment-preview Celery task and its
regeneration triggers, the concept-tree navigator, and an isolated fragment
detail view with its own Verovio render, playback and sub-part brackets. The
**rendering-context contract** is ADR-024.

*Difficulty found here:* the first Supabase-authenticated request from a new
user failed until `app_user` rows were auto-provisioned.

### 3.12 Component 9 — Corpus population, hardening and close-out (Jun 11 – Jul 11 · PRs #26, #27)

Planned as "populate 5–10 movements and test". It became the longest and hardest
component of Phase 1: **the full 54 movements**, a rendering-correctness campaign,
several scope additions, and a full project review. It ran in parts:

1. **Selection and stages hardening (Jun 12–13).** A symptom catalogue and fixture
   matrix, then a written interaction-model spec and **ADR-025**: repeat barlines
   are *not* selection boundaries; voltas and D.C./D.S. markers *are*.
2. **Ingest correctness (Jun 15–16).** Recovery of measure-start clefs dropped by
   the MuseScore export, completion of cross-barline ties (ADR-026), a severity
   channel for ingestion warnings, and **re-ingestion tooling with mc-stability
   verification** (re-ingesting must not shift the `mc` coordinates that
   existing fragments point at).
3. **Playback and harmony (Jun 16–19).** Fragment-constrained playback, an
   interpolated playback caret, play-from-position, serif harmony labels and
   stacked figured bass.
4. **i18n (Jun 19–20).** Backend translation overlay with `Accept-Language`,
   i18next on the frontend, Spanish translations and a language switcher.
5. **Staging read-through → normalization campaign (Jun 28 – Jul 5).** Reading and
   listening through the 15 re-ingested movements produced a clustered issue
   triage (`staging-readthrough-issues.md`), which led to seven ADRs in eight
   days:
   - ADR-027 source-corrections overlay (Pass 0) · ADR-028 full gestural
     accidental resolution · ADR-029 grand-staff presentation · ADR-030
     deterministic `xml:id`s · ADR-031 clef reconciliation · ADR-032 MusicXML
     measure renumbering for import · ADR-033 strain-opening repeat repair
     (K.331/ii trio).
   - It ended with the **clef reconciliation rework** (`c910c3e`, Jul 5). All 15
     known double-clef cases came down to one mechanism: the converter scatters a
     single staff-level clef change across voices. Two Verovio probes overturned
     the working premises. The result was verified with 0 clef warnings across
     all 54 movements and a human review of every render.
6. **Campaign triage (Jul 7).** Volume tagging against the full corpus gave a
   mid-campaign issue batch: eight fix-now items and six Phase-2 deferrals.
   The main fix was **ADR-034, in-process task dispatch**. Background tasks
   now run on a worker thread inside the API process, so staging no longer
   needs a Celery worker or Upstash broker traffic. This also closed the gap
   where re-ingest left fragment previews stale. A daily keep-alive workflow
   stops the Supabase and Aura free tiers from auto-pausing.
7. **Full project review (Jul 9–11).** A documentation audit, a code, test and
   dependency review, and a **security review** (RLS default-deny probed on
   staging, Fly secrets inventory, JWT issuer verification, FastAPI, Starlette
   and lxml security bumps, a dependency audit in CI). Integration suites were
   isolated from real campaign data.

**Jul 11 — Phase 1 complete.** PR #27 merged, `phase1/complete` tagged. A
branching policy came with the close-out: no direct commits to `main`, PRs only.
Everything Phase 1 left open went into `docs/roadmap/phase-2-entry-backlog.md`.

---

## 4. Phase 2 — Public product (2026-07-16 → present)

Phase 2 turns the editorial tool into something the public can read and,
eventually, use: a glossary, collections, presentation mode, exercises and
scrollytelling. Its roadmap (`phase-2.md`, with exercise design and a roles model)
landed on Jul 16 (PR #28).

### 4.1 Component 10 — Foundations and public read path (Jul 16–23 · PRs #29, #30)

Mostly security and infrastructure debt that had to be paid before anything
public:

- Storage boundary: soundfonts moved to a public bucket; every other artifact is
  always presigned.
- An **anonymous public read path** (`/api/v1/public/`) with ADR-009 enforced
  (the ABC corpus is excluded for licensing reasons), and public frontend views.
- Auth: python-jose → **PyJWT**; **HttpOnly refresh-token session** replacing
  localStorage JWTs (ADR-035).
- Rate limiting (slowapi + Redis, falling back to in-memory when Redis is
  unreachable), security headers (CSP, HSTS, nosniff; CSP had to allow `data:`
  fonts because Verovio embeds its SMuFL font), OpenAPI docs gated off in
  production, CORS origins from env.
- De-risking: a **horizontal single-system rendering spike** for future
  scrollytelling, Verovio render **snapshot tests**, a **Playwright** e2e
  scaffold, and the migration to pytest 9 / pytest-asyncio 1.x.

### 4.2 Component 11 — Concept glossary (Jul 23 – Aug 26 · PR #31)

The first public content surface: a concept-detail endpoint, a
`definition_reviewed` seed flag, example-fragment selection, a public concept
index browsable by domain, and concept pages with inline example fragments.

The feature work took about a week. The rest of the component went on **data
defects that a public surface exposed** (the "M" series):

- **M12, duplicate bar numbers.** A corpus survey found movements whose
  printed bar numbers repeat (minuet/trio, Menuetto I/II). Fixed with
  **movement sections and bar-label disambiguation** (ADR-036); K.282/ii now
  restarts its numbering at Menuetto II.
- **M6.** Fragment summaries took key and meter from the wrong source, and
  harmony queries and stored brackets were not scoped by `mc`.
- **M17/M18, 3/8 movements.** Sub-part clamping was wrong in 3/8, and the
  curated meters contradicted the notation. The fix reads meter from the
  notation at the fragment's own bar. A guarded data migration refuses to
  clamp where the repair depends on M17.
- Cadence definitions were reviewed for public display (Step 13E), and the
  `harmony_gate` was declared on `Cadence` (13F).

Work paused from about Jul 30 to Aug 24. The component closed on Aug 25 with
14 triage items: the bugs were fixed in place and **seven items were deferred
to Component 12**.

### 4.3 Component 12 — User infrastructure (Aug 26 – Sep 11 · PR #32)

21 steps, 52 commits, nine hard gates.

- **Roles:** migrated to a `user_role` table with any-of `require_role()`
  (ADR-037); roles never come from JWT claims.
- **Accounts:** email-verification gate, proxied OAuth (Google, PKCE), sign-up
  gating, verification resend, password reset, registration UI, profile page,
  reading history, **self-service data export and account deletion** with a
  deleted-user system account (ADR-038).
- **Admin:** user management (invites, role grants, a guard against
  self-demotion) and a moderation schema and queue (the report action ships
  dark).
- **UI:** a responsive design addendum, an audience-split top bar with gated
  editorial routes, layout width tokens, a shared button library, one
  option-control family, segmented controls and icon buttons, a **bracket
  redesign** (M5), and a public landing page with the corpus browser moved off
  the root.
- **Concepts and i18n:** short names and per-value help (ADR-039), Spanish
  *content* served and not only a Spanish interface, the translation overlay
  wired to surfaces that never had it, and **cross-language concept search**
  (ADR-040).

Gate 2 (invite → sign-up → verification → OAuth) needed a real mailbox and a
Google account, so it was recorded as *unverified* until Francisco confirmed it
on staging. That confirmation closed the component on Sep 11.

### 4.4 Since then

- **2026-10-01:** `docs/reports/production-launch-planning.md` (not yet
  committed) is a pre-decision report on separating staging from production,
  a `doppia.org` domain, backups, email deliverability, and a way for the first
  colleagues to report problems. It is the input to the next roadmap doc.
- **Next component:** Component 13, Collections. It inherits public
  property-schema labels, the consolidated browse surface, the collection DDL,
  and pickup numbering with a repeat-barline caret (M10).

---

## 5. Recurring difficulties

These came up in more than one component. Each one changed how the project
works.

1. **Source notation is less clean than it looks.** The corpus arrives as
   MuseScore → MusicXML → MEI, and every hop loses or invents something:
   gestural accidentals, measure-start clefs, cross-barline ties, clef changes
   scattered across voices, omitted repeats, duplicate bar numbers, curated
   meters that contradict the score. **13 of the 40 ADRs** (ADR-015, 021, 022,
   025–033, 036) deal with notation correctness, before counting the M17/M18
   data fixes. The
   normalizer grew from a handful of passes to an ordered pipeline (Pass 0
   corrections overlay through Pass 11 staff presentation).
2. **Audits that agree with themselves.** In Component 9, prep audit scripts
   passed on movements that rendered wrongly (misplaced clefs, group-level
   labels). The standing rule since then: **verify renders, not just audits**.
   Fixes are checked against a render or a human read-through, and test guards
   are mutation-tested (revert the behaviour, check the test fails).
3. **Overlay geometry over Verovio.** The rule against touching Verovio's SVG
   kept the architecture clean but made every bracket, ghost, caret and harmony
   label a geometry problem: multi-system selections, accidental bounding
   boxes, tempo-mark clearance, figured bass, narrow widths. It runs through
   Components 3, 5, 7, 9 and 12 (the bracket redesign).
4. **Re-ingestion without breaking fragments.** Fragments point at `mc`
   coordinates, so every normalizer fix risks moving them. That led to
   deterministic `xml:id`s (ADR-030), the mc-stability snapshot over 54
   movements, a corrections overlay located by coordinates instead of
   `xml:id`, cache-busting for R2's edge cache, and preview regeneration on
   re-ingest (ADR-034).
5. **Async test infrastructure.** Event-loop pinning (Python 3.12, then
   pytest-asyncio 1.x with `loop_scope="session"`), per-invocation engines,
   no `async with db.begin()` on request sessions, an intermittent exit hang in
   the Windows integration suite, and test isolation from real campaign data.
   Shared listing surfaces now walk the full cursor pagination and scope
   assertions to the test's own ids.
6. **Running on free tiers.** Fly auto-stop and cold boots (longer health-check
   grace), Supabase and Aura auto-pause (the keep-alive workflow), Upstash
   broker cost (the main reason for ADR-034's inline dispatch), and no
   `release_command`, so migrations are run by hand after deploy.
7. **The Orange España / R2 incident (Aug 29–31).** Every score load on staging
   failed with `Failed to fetch`, while soundfonts and the API worked. The
   cause was outside Doppia: Orange España was not routing the Cloudflare
   anycast prefixes behind R2's S3 endpoint, so presigned MEI and SVG fetches
   never connected. Cloudflare WARP works as a stopgap. The problem was only
   partly gone by Aug 30, and a durable fix (an MEI proxy) is waiting on an ADR.
   See `r2-endpoint-unreachable-from-orange.md`.
8. **Scope growth in "close-out" components.** Component 9 grew from "populate
   and test" into a month-long campaign. Component 11's feature week turned
   into a month of data defects. In both, putting the product in front of real
   use (volume tagging, a public page) found problems no earlier step had.

---

## 6. Working practices that formed along the way

- **Decisions recorded before code:** 12 ADRs existed on day one, 40 by
  Sep 11. Each component has a step-numbered roadmap doc that gets a closure
  section at the end.
- **Review reports as work queues:** the seven Component 2 reports, the
  Component 5 G0–G7 remediation plan, the Component 9 read-through and Part 8
  triage, and the Component 11 triage. Each sorts issues into fix-now and
  deferred, and deferred items are carried forward in named registers rather
  than dropped.
- **Human gates:** no commits without approval, no direct commits to `main`
  (from Jul 11), design reviews that usually take three passes, and gates that
  need real-world verification (renders, staging, mailboxes) are recorded as
  open until a person confirms them.
- **Conventional Commits** with a `seed(<domain>):` type for knowledge-graph
  changes.

---

## Appendix A — Merged pull requests

| PR | Merged | Branch | Content |
|---:|---|---|---|
| 1 | 2026-04-16 | feature/project-foundation | Scaffold |
| 2 | 2026-04-16 | feature/cleanup | Cleanup |
| 3 | 2026-04-18 | feature/project-foundation | API conventions, Alembic, tests |
| 4 | 2026-04-19 | feature/project-foundation | Fly config, auth tests |
| 5 | 2026-04-20 | feature/staging-deployment | First staging deploy |
| 6 | 2026-04-22 | feature/mei-ingestion | Component 1 |
| 7 | 2026-04-25 | feature/corpus-browser | Component 2 |
| 8–10 | 04-26 → 05-04 | code-review | Review remediation, staging, CI |
| 11 | 2026-05-04 | feature/measure-numbers | ADR-015 |
| 15 | 2026-05-07 | feature/score-viewer | Component 3 |
| 16 | 2026-05-11 | fix/cleanup | Fixes, ADR-018 |
| 17 | 2026-05-24 | feature/knowledge-graph | Component 4 |
| 18–19 | 2026-05-25 | feature/c4-sidetrack | Score-viewer polish |
| 20–21 | 2026-05-26 | fix/accidentals… | ADR-021/022 |
| 23 | 2026-06-04 | feature/component-5 | Component 5 |
| 24 | 2026-06-08 | feature/fragment-database | Component 7 |
| 25 | 2026-06-11 | feature/fragment-browsing | Component 8 |
| 26 | 2026-07-07 | feature/selection-and-stages | Component 9, Parts 1–8 |
| 27 | 2026-07-11 | feature/c9-review | Component 9, Part 9; Phase 1 close |
| 28 | 2026-07-16 | feature/phase-2-roadmap | Phase 2 roadmap |
| 29–30 | 07-22 → 07-23 | feature/public-read-path, …parts-5-7 | Component 10 |
| 31 | 2026-08-26 | feature/component-11-concept-glossary | Component 11 |
| 32 | 2026-09-11 | feature/user-infrastructure | Component 12 |

## Appendix B — ADRs by date

| Date | ADRs |
|---|---|
| 2026-04-16 | 001 Auth provider · 002 File storage · 003 Score display mode · 004 Analysis pipeline trigger · 005 Sub-measure precision · 006 i18n strategy · 007 Prose vectorisation · 008 Fragment previews · 009 DCML licensing · 010 Frontend framework · 011 Multi-level tagging · 012 MIDI player |
| 2026-04-23 → 05-10 | 013 Verovio version policy · 014 Original MEI retention · 015 Dual measure coordinates · 016 JWT browser storage · 017 Celery config · 018 Ingestion partial-failure recovery |
| 2026-05-22 → 06-16 | 019 BOOL cardinality · 020 `PREREQUISITE_FOR` · 021/022 Accidental normalization · 023 Property/value ordering · 024 Fragment rendering context · 025 Repeat barlines vs. selection · 026 Tie completion |
| 2026-06-28 → 07-07 | 027 Corrections overlay · 028 Gestural accidentals · 029 Staff presentation · 030 Deterministic `xml:id`s · 031 Clef reconciliation · 032 MusicXML renumbering · 033 Strain-opening repeats · 034 In-process task execution |
| 2026-07-21 → 09-11 | 035 HttpOnly refresh session · 036 Movement sections / bar labels · 037 Role-set model · 038 Data rights · 039 Property value labelling · 040 Cross-language concept search |
