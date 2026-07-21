# Phase 2 — Non-AI User Features: Design & Roadmap

**Status:** agreed 2026-07-15; adopted as the Phase 2 roadmap. Component
order, the cross-cutting decisions, and the exercise design (Component 15 →
[`component-15-exercises.md`](component-15-exercises.md)) are settled;
per-component implementation plans (starting with
[`component-10-foundations-public-read-path.md`](component-10-foundations-public-read-path.md))
are drafted as each component begins.

## Purpose

Phase 2 turns the Phase 1 knowledge asset — a populated fragment database, a
seeded cadence domain, and the Verovio rendering infrastructure — into a
publicly usable product: a concept glossary, user accounts, collections with a
presentation mode, exercises, and a blog with scrollytelling. No AI layer;
that remains Phase 3.

The feature scope is defined in `../architecture/project-architecture.md`
§ Phase 2. This document turns that scope into components, an order, and a
decisions log, and slots in the debt carried out of Phase 1.

**Inputs:**

- `phase-2-entry-backlog.md` — the debt and deferral register (§2 security
  items are gated on "before any public URL exists")
- `../reports/component-9-reports/issues-deferred-for-phase-2.md` — editorial
  tool issues and small bugs found at the end of the Component 9 campaign
- `../architecture/extended-features.md` — two items promoted into Phase 2
  scope: the Concept Glossary and Presentation Mode for Collections
- `../architecture/roles-and-permissions.md` — the Phase 2 role model,
  registration flow, moderation, and data-rights decisions (new)

---

## What Phase 2 Delivers

- A public, unauthenticated read surface: approved fragments (browse by
  concept + fragment detail) and a concept glossary generated from the
  knowledge graph. **The corpus browser and whole-movement score viewer
  remain editorial** in Phase 2 — the viewer is the tagging surface; a
  read-only public score viewer is a possible later feature, not Phase 2
  scope
- Public registration (invite-only at first) with the full role model:
  anonymous, registered, editor, author, admin
- Collections: user-curated, ordered, annotated fragment lists with
  read-only sharing, snapshot import, and a classroom presentation mode
- Exercises: graph-driven multiple-choice identification and listening
  exercises with item-level progress tracking (design in
  `component-15-exercises.md`)
- A blog with scrollytelling layout: prose interleaved with Verovio-rendered,
  playable fragments, authored in a block editor with a fragment picker
- The Phase 1 security and infrastructure debt retired (signed-URL end state,
  PyJWT, rate limiting, security headers, token storage)

---

## Component Order & Dependencies

Components continue Phase 1's numbering (Phase 1 ended at Component 9).

```
10. Foundations & public read path     ── security debt gate; horizontal
    │                                     rendering spike runs here
    ▼
11. Concept Glossary                   ── first public feature; no accounts
    │
    ▼
12. User infrastructure                ── roles, registration, user state,
    │                                     moderation, data rights, topbar
    ▼
13. Collections                        ── first user-owned content
    │
    ▼
14. Presentation Mode                  ── thin display layer over 13
    │
    ▼
15. Exercises                          ── design agreed (component doc);
    │                                     needs 12's exercise tables
    ▼
16. Blog with scrollytelling           ── heaviest; de-risked by the spike
                                          in Component 10

Track M (parallel): editorial-tool repairs and UX debt — runs alongside,
prioritised opportunistically. M0 (fragment editor repair) is urgent.
```

Rationale for the order: cheapest-public-value first (glossary needs no
accounts), user infrastructure before anything user-owned, presentation mode
immediately after collections while the code is warm, exercises before blog
(agreed 2026-07-14), and scrollytelling last but de-risked early by a
rendering spike in Component 10.

---

## Component 10 — Phase 2 Foundations & Public Read Path

**Purpose:** retire the security debt that gates any public URL, open the
unauthenticated read surface, and de-risk the one big rendering unknown
(horizontal scroll) before anything is built on it.

### Security & infrastructure debt (backlog §2 — all gated on public launch)

In dependency order:

1. **Signed-URL end state — option (b).** Soundfonts-only public bucket;
   MEI/incipit/preview via presigned URLs. First task; prerequisite for
   ADR-009 enforcement. (`security-model.md` § 4) — ✅ landed `ff5e1f1`
   (2026-07-20)
2. **Public endpoints + ADR-009 enforcement.** Unauthenticated
   `approved`-only browse and fragment detail; ABC-corpus exclusion check.
   The licence serialiser already exists (Component 8).
3. **PyJWT migration** (replace python-jose), then flip the CI audit job
   from report-only to blocking. — ✅ landed `7080ee4` (2026-07-21)
4. **Token storage + full session UX.** Revisit ADR-016's localStorage
   exception: HttpOnly cookie vs full Supabase JS client (brings token
   refresh). Must land before public registration (Component 12).
   — ✅ landed `f40fba5` (2026-07-21; HttpOnly cookie, ADR-035)
5. **Rate limiting.** `slowapi` + Redis; starting limits already tabled in
   `security-model.md` § 2.
6. **Security headers.** CSP (drafted; `worker-src blob:` for Verovio WASM),
   HSTS, `nosniff`.
7. **OpenAPI docs exposure.** Gate or disable `/api/docs` in production.
8. **CORS for preview environments.** `ALLOWED_ORIGINS` env fallback —
   cheap, do when previews appear.
9. **pytest 9 + pytest-asyncio 1.x migration.** Dev-only; ride along when
   convenient.

### Horizontal rendering spike (scrollytelling de-risk)

A throwaway page that renders one movement as a single horizontal system
(Verovio `breaks` options / single-system layout) with scroll-synced MIDI
playback. Goal: learn whether Verovio fights us **months before Component 16,
not during it**. Output is a short findings report under `docs/reports/`,
plus any workaround notes. ADR-024's context modes and the one-system
rendering hook are the same machinery (backlog §4).

### Also in this component

- **Snapshot tests** (`tests/snapshots/`): populate the Verovio regression
  guards now — they gate the eventual Verovio 6.2.0 upgrade (ADR-013) and
  the spike will touch rendering options anyway.
- **Playwright e2e scaffold.** Phase 1 explicitly deferred browser tests;
  the public read path is the first surface worth covering.

---

## Component 11 — Concept Glossary

**Purpose:** every concept node becomes a public page — the cheapest public
feature (no accounts, no new data model) and the anchor that blog posts,
collections, and exercises will link to. Promoted from
`extended-features.md` § Concept Glossary with Inline Examples.

### Scope

- Concept page: prose definition, position in the `IS_SUBTYPE_OF` hierarchy,
  typed relationships to other concepts, and inline example fragments
  (pre-rendered previews + full Verovio/MIDI on expand).
- Concept index: browsable by domain, following the hierarchy.
- Read-only, anonymous; served by the Component 10 public path.

### Fragment selection (decided 2026-07-14)

- **Random 3** approved fragments tagged with the concept, with a **shuffle**
  button to re-draw. Previews are pre-rendered static SVGs (ADR-008), so
  re-draws are cheap.
- Selection pool: `approved` fragments joined via `fragment_concept_tag`
  (any tag, not only `is_primary` — same rule as browse), minus ADR-009
  exclusions.
- **Future editorial override ("featured"):** if curation is wanted later,
  add a nullable `featured_rank` integer to `fragment_concept_tag`; ranked
  fragments fill slots first, random fills the rest. No migration pain —
  documenting the option here is deliberate so the random-only launch does
  not paint us into a corner.

### Stubs and readiness gates (decided 2026-07-14)

- **Stub nodes are shown as such** — a stub page states the concept belongs
  to a not-yet-modelled domain ("Formal Function — not yet covered") rather
  than being hidden. It advertises scope honestly and keeps inbound links
  stable.
- **Definition revision is a gate on this component.** Concept `definition`
  prose was written for annotators; each concept page goes public only after
  an editorial pass. Track with a `definition_reviewed` boolean in the domain
  YAML (informational flag, like `stub`); unreviewed concepts render their
  hierarchy and fragments but a placeholder definition.

### Note on a doc inconsistency

`extended-features.md` says "`APPEARS_IN` edges do the curation work" —
that wording predates the decision that concept tags live in PostgreSQL
(`fragment_concept_tag`), not as Neo4j edges. Correct it when this component
is built.

---

## Component 12 — User Infrastructure

**Purpose:** public registration, the full role model, user state, and the
supporting product chrome (topbar, moderation, data rights). All decisions
recorded in `../architecture/roles-and-permissions.md`; summary here.

### Scope

- **Role model migration:** single `role` column → role *set* (join table
  with grant audit trail); new **Author** role distinct from Editor;
  `require_role()` becomes any-of; new `require_owner_or_role()` service
  helper as the second (and only other) sanctioned permission mechanism.
  Update `CLAUDE.md` / `CONTRIBUTING.md` invariants in the same change.
- **Registration:** email+password with mandatory verification, plus Google
  OAuth; default role `registered`. **Invite-only at launch**, opened to the
  public when Collections ship. Depends on Component 10's token-storage item.
- **User state schema** (sketches in `tech-stack-and-database-reference.md`):
  `collection`, `collection_fragment`, `exercise_result`, `reading_history`,
  profile fields. `exercise_result` and `reading_history` are created **now**,
  before their features exist — the "record from day one" principle.
  Reading history is opt-in, default off.
- **Data rights, designed in from the start:** JSON export of profile,
  collections, exercise history, reading history; account deletion deletes
  user-owned content but **reassigns editorial content (fragments, reviews)
  to a system user** — this rule shapes foreign keys, so it is a schema-time
  decision.
- **Minimal moderation tool:** report action on shared collections → admin
  queue → dismiss / unpublish share. See roles doc.
- **Topbar redesign:** the current three editorial links become a public nav
  — Fragments (browse by concept), Glossary, Blog, Collections, Exercises —
  plus a role-gated "Editorial" menu (corpus Browse / score viewer, Review,
  moderation queue, admin) and an account menu (profile, progress, logout).
  Note the corpus browser and whole-movement viewer sit in the Editorial
  menu, not the public nav (see § What Phase 2 Delivers). Treated as part of the responsive /
  design-system work below, not a standalone tweak. Fold in the design-debt
  register F8–F13 (shared button library, layout width tokens, etc. —
  `step-17-design-coherence-review.md`) where it overlaps.

### Mobile — supported-surface matrix

Decided direction: a per-surface support matrix, not blanket "mobile support".
`DESIGN.md` needs a responsive addendum (breakpoints, nav pattern) as part of
the topbar work.

| Surface | Mobile support |
|---|---|
| Glossary, blog reading, fragment detail, collection viewing | Full |
| Exercises (esp. listening — no notation needed) | Full |
| Collection editing | Degrade gracefully |
| Tagging tool, blog authoring, admin, presentation mode | Desktop-only |

Open technical check: Verovio at narrow widths (vertical scroll + small scale
— expected fine, needs an afternoon of testing) and the scrollytelling
fallback layout on phones (a Component 16 design decision).

---

## Component 13 — Collections

**Purpose:** registered users curate named, ordered lists of fragments with
personal annotations; sharing and import make them classroom-usable.

### Scope

- CRUD: create, rename, describe, delete; explicit user-controlled ordering;
  optional per-entry annotation; optional purpose metadata (*class
  preparation*, *practice*, *research*) and free-text description.
- **Fragments only** (decided 2026-07-14) — no movements/works as entries,
  at least for now. The entry model should not preclude other entry types
  later (a `kind` discriminator costs nothing).
- Sharing: read-only shareable links (viewable anonymously) and importable
  collections.
- `PREREQUISITE_FOR`-based ordering *suggestions* are optional scope — only
  if cheap once the graph queries exist.

### Import and removal semantics (decided 2026-07-14)

- **Snapshot-copy on import:** importing copies the entries and the owner's
  annotations *as they are at import time* into a collection owned by the
  importer. No live link; later edits to the source do not propagate.
  Fragments themselves are referenced, not copied.
- **Soft-tombstone on fragment removal:** if a fragment is deleted or
  un-approved, collection entries survive, rendering "this fragment is no
  longer available" from display metadata (concept name, work/movement)
  cached on `collection_fragment` at add time. The user's annotation is
  preserved. No hard cascade from `fragment` into collections.

### Moderation surface

Shared collections (titles, descriptions, annotations) are the platform's
first user-generated public content — the Component 12 moderation tool must
be live before sharing is.

---

## Component 14 — Presentation Mode for Collections

**Purpose:** an instructor walks through a collection fragment by fragment in
class: full-screen notation, playback controls, annotations togglable.
Promoted from `extended-features.md`; a display mode over Component 13, no
new data model.

### Scope

- Full-screen route over an owned or shared collection; keyboard navigation
  (next/previous fragment); MIDI playback per slide; annotation overlay
  toggle.
- Desktop-only by design (it targets a projector).
- Build immediately after Component 13 while the collection code is warm.

---

## Component 15 — Exercises

**Purpose:** graph-driven multiple-choice identification and listening
exercises with item-level progress tracking. Agreed to precede the blog.

**Design agreed 2026-07-15 — full reference:
[`component-15-exercises.md`](component-15-exercises.md).** Summary:

- **Representation:** exercise types authored as YAML in
  `backend/seed/exercises/`, seeded into PostgreSQL (the domain-seed pattern
  applied to exercises); no authoring UI in v1.
- **Validation & activation:** Pydantic (structural) + a readiness report
  script (statistical, recomputed as fragments are approved) + an admin
  preview mode (human). Activation is per *(exercise type, concept)* pair;
  first activation is a manual admin confirmation after preview.
- **Generation:** distractors via `CONTRASTS_WITH`/sibling edges, with the
  hard invariant that a distractor is never a true tag of the shown
  fragment; rendering context is a per-type ADR-024 mode
  (`enclosing_fragment` awaits Formal Function tagging).
- **Listening:** ±2-semitone random transposition; slow-down aid after the
  first full hearing; aid usage recorded, not penalised.
- **Sessions:** fixed 8 questions, interleaved across the sibling set;
  plain-fraction + streak display over raw item-level storage;
  without-replacement cycling for repeat avoidance.
- **Data integrity:** admin preview sessions are flagged
  (`mode = 'preview'`) and excluded from all statistics, keeping testing
  usage out of future difficulty data.
- **v1 scope:** one answer family (`identify_concept`), two presentations
  (notation, listening). Localization tasks ("click the cadence arrival"),
  error detection, and the other `extended-features.md` families are
  recorded as future work. Capture-extensions triage happens during this
  component.

The `exercise_session` / `exercise_result` tables ship in Component 12
regardless, so history is recorded from the first exercise ever answered.

---

## Component 16 — Blog with Scrollytelling

**Purpose:** the publication layer — prose interleaved with playable,
Verovio-rendered fragments in a scrollytelling layout. Scrollytelling is
committed for v1 (decided 2026-07-14); its rendering risk is retired early by
the Component 10 spike.

### Scope

- **Authoring:** block-level editor (TipTap — sanitisation rules already in
  `security-model.md` § TipTap: DOMPurify before any raw render) with a
  fragment picker backed by the fragment DB. Author role required
  (see roles doc); draft → published workflow.
- **Reading:** scrollytelling layout — horizontal notation advancing in sync
  with scroll; MIDI playback with auto-scroll synchronisation. Mobile gets a
  designed vertical fallback (decision recorded during implementation).
- **Fragment embeds:** consume ADR-024 context modes (`bars`,
  `enclosing_fragment`, `previous_same_domain`) — implemented here with their
  consumer, per the backlog note.
- **Knowledge-graph linkage:** posts reference concepts via the controlled
  vocabulary; concept pages (Component 11) list posts that mention them.
- **Not in scope:** vector-store ingestion is Phase 3. Phase 2 only stores
  post content cleanly structured so that ingestion later is a batch job,
  not archaeology.
- Related deferral lands here or nearby: beat-precision play-from-position
  (`playback-coordinates.md`) if scrollytelling playback needs it.

---

## Track M — Editorial-Tool Repairs & UX Debt (parallel)

Runs alongside Components 10–16; no public-launch gate, but M0 blocks
editorial work and should go first. Sources:
`../reports/component-9-reports/issues-deferred-for-phase-2.md` and backlog §3.

**Target: the whole track is clear before Component 15 (Exercises) begins.**
The suggested slots below follow two rules: anything visible on the *public*
fragment surface (detail view, previews, counts, labels) lands by the end of
Component 11, since the glossary is what first exposes fragments to strangers;
everything else rides alongside the component it pairs with naturally.

| # | Item | Suggested slot | Notes / pointer |
|---|---|---|---|
| M0 | **Fragment editor repair** — concept, stages, harmony panel, commentary all blank on edit; effectively unusable | **Immediately, alongside Component 10** | issues doc § Fragment editor. Blocks M1/M2 |
| M1 | Editorial data fixes (harmony confirmations sweep, the per-fragment errata list) | After M0, **before Component 11 ships** — the errata become public with the glossary | issues doc § Editorial work |
| M2 | `harmony_gate` seeding + one-time confirmation sweep | With M1 (during 11) | backlog §3 |
| M3 | Fragment edit/lifecycle UI (post-approval flow) | During 13 | backlog §3 |
| M4 | Review-queue UX: scroll-to-fragment on select; back button returns to queue; evaded/abandoned cadence naming | During 12–13 (the naming bug earlier if it also affects public labels) | issues doc § Revision workflow |
| M5 | Bracket redesign (square handles, edited-vs-rest differentiation, collision/label overlap) — needs design thinking first | With Component 12's design-system work (topbar / DESIGN.md addendum) — one design pass | issues doc § Score |
| M6 | Info sidebar fixes: property order, harmony sliced to fragment range, local-key convention, stage properties missing, wrong key/meter in summary (C major/4/4 on 279/ii — possibly a real bug) | **Before Component 11 ships** — the summary bug is glossary-visible | issues doc § Info sidebar |
| M7 | Stage-bracket overflow bug at sub-beat fragment bounds (279/ii m. 8–10) | With M6, before 11 | issues doc § Real bugs |
| M8 | Harmony panel refinements (Grado vs Fundamental semantics, local-key prepopulation/display; "edit events outside a fragment?" question) | During 13–14 — harmony data quality feeds exercises | issues doc § Harmony panel |
| M9 | Tagging sidebar cleanup (drop "stage properties" label; fix stage ordering) | During 12 (small; batch with any tagging-tool touch) | issues doc § Tagging sidebar |
| M10 | G1 beat-range display convention; pickup/partial-bar beat numbering; caret at repeat barlines | During 12–13 — display conventions worth settling before wide public exposure | backlog §3 |
| M11 | Concept-tree count cache staleness | **Before/during 11** — counts are public on the browse surface | issues doc § Fragment browser |
| M12 | Duplicate-`@n` display disambiguation (K331/ii "Menuetto da capo") | During 11–12 — public-facing labels | backlog §3; ADR-015 amendment |
| M13 | i18n surface inventory (list per type/complexity/urgency, then decide) | During 12 — UI text grows fastest with registration and the new topbar | issues doc § I18N; full second-language machinery stays deferred per ADR-006 |
| M14 | Verovio 6.2.0 upgrade — deliberate event per ADR-013, only after snapshot tests (Component 10) exist | During 14 — after snapshot tests, settled before 15/16 build on rendering | backlog §3 |

Still deferred beyond Phase 2 unless triggered: Component 6 music21
auto-analysis (trigger: first non-DCML corpus), multi-domain fragment filter
(trigger: second domain seeded — likely during Component 15 design),
second-language content machinery (ADR-006).

---

## Decisions Log

| Decision | Resolution | Where recorded |
|---|---|---|
| Component order | 10 foundations → 11 glossary → 12 user infra → 13 collections → 14 presentation → 15 exercises → 16 blog | this doc |
| Exercises vs blog order | Exercises first, then blog directly with scrollytelling (no non-scrollytelling blog v1) | this doc |
| Scrollytelling risk | Early horizontal rendering spike in Component 10 | this doc |
| Role model | Multi-role set; Author distinct from Editor; `require_owner_or_role()` ownership pattern | `roles-and-permissions.md` |
| Registration | Email+password (verified) + Google OAuth; invite-only launch, open with Collections; default role `registered` | `roles-and-permissions.md` |
| Glossary fragment selection | Random 3 + shuffle; `featured_rank` documented as future override | this doc, Component 11 |
| Glossary stubs | Shown as such ("not yet covered") | this doc, Component 11 |
| Glossary definitions | Editorial revision is a per-concept gate (`definition_reviewed`) | this doc, Component 11 |
| Collection entries | Fragments only, for now | this doc, Component 13 |
| Collection import | Snapshot-copy | this doc, Component 13 |
| Fragment removal vs collections | Soft-tombstone with cached display metadata | this doc, Component 13 |
| Mobile | Supported-surface matrix; not blanket support | this doc, Component 12 |
| Topbar | Audience split: public nav + role-gated Editorial menu; part of responsive design-system work | this doc, Component 12 |
| Moderation | Minimal: report → admin queue → dismiss/unpublish | `roles-and-permissions.md` |
| Public browse scope | Fragment browse + detail public; corpus browser and whole-movement viewer stay editorial (read-only public viewer is a possible later feature) | this doc |
| Admin self-review | Existing admin bypass of self-review + threshold is kept (single-user reality); revisit when a second editor is active | `roles-and-permissions.md` § 2 |
| Track M timing | Whole track clear before Component 15; public-surface items by end of Component 11 | this doc, Track M |
| Data rights | Export + deletion designed at schema time; editorial content reassigned to system user | `roles-and-permissions.md` |
| Exercise design | Agreed 2026-07-15 — YAML-seeded types, per-pair activation gates, fixed interleaved sessions, preview-flagged testing data | `component-15-exercises.md` |

Per the Definition of Done, non-obvious decisions made during implementation
get ADRs; the registration/role-model migration in particular should be
recorded as an ADR when built (extending ADR-001).
