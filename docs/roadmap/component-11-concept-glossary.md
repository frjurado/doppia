# Phase 2 — Component 11: Concept Glossary — Implementation Plan

This document translates Component 11 of [`phase-2.md`](phase-2.md) into a
concrete, sequenced set of implementation tasks. It follows the model of the
Component 10 plan
([`component-10-foundations-public-read-path.md`](component-10-foundations-public-read-path.md)):
it does not restate settled design, it sequences implementation and pins the
integration boundaries the design docs leave open, and where it reaches a
decision those docs do not record it flags it for confirmation rather than
baking it in silently.

Component 11 is the **first public feature**. Component 10 opened the
unauthenticated read *path* (approved-only fragment browse + detail, served
anonymously); Component 11 is the first thing built *on* it that a stranger
would land on directly. It needs no accounts and no new data model — every
concept node in Neo4j becomes a public page, and those pages become the anchor
that Collections, Exercises, and the Blog will all link to. It does two things:

1. **Ships the glossary itself** — a public concept page (prose definition, its
   place in the `IS_SUBTYPE_OF` hierarchy, typed relationships to other
   concepts, and inline example fragments) and a browsable concept index, served
   anonymously through the Component 10 public path. This is the new feature
   work.
2. **Retires the Track M public-surface debt that becomes visible the moment
   fragments meet strangers** — the editorial-data errata, the info-sidebar and
   label bugs, the stale concept-tree counts, and the duplicate-`@n`
   disambiguation. `phase-2.md` § Track M is explicit: *anything visible on the
   public fragment surface lands by the end of Component 11*, because the
   glossary is what first exposes fragments (their previews, counts, labels,
   summaries) to people outside the project.

Because the errata sweep (M1) needs a working editor, and the one M0 defect
deliberately deferred — main-bracket resize during edit — sits squarely in the
path of "fix the wrong-stages errata", the deferred resize decision is picked up
here too, as the enabler for the editorial sweep rather than as open-ended
editor work.

Component 11 has **four parts**:

1. **Glossary read model** — the public concept endpoints: concept-detail
   payload (definition, hierarchy, typed relationships, example-fragment
   selection), the `definition_reviewed` editorial gate, stub handling, and a
   public concept index. Backend only.
2. **Glossary frontend** — the concept page, the concept index / browse-by-domain
   surface, and inline example fragments (pre-rendered previews expanding to full
   Verovio/MIDI), with the stub and unreviewed-definition states.
3. **Track M — public-surface fixes** (the switch-on gate): M11 count-cache
   staleness, M12 duplicate-`@n` disambiguation, M6 info-sidebar fixes, M7
   stage-bracket overflow at sub-beat bounds.
4. **Track M — editor follow-through + editorial sweep**: the deferred
   main-bracket resize decision (M0 carryover), then the M1 errata sweep and M2
   `harmony_gate` seeding + confirmation sweep that the working editor unblocks.

The ordering is a soft dependency chain rather than Component 10's hard
public-launch gate. Parts 1–2 (the glossary) and Part 3 (the public-surface
fixes) are independent streams that can run in parallel; both must be green
before the glossary is switched on publicly (the Component-11 exit gate — the
same "public-surface items by end of Component 11" rule from `phase-2.md`
§ Track M). Part 4 gates the *data quality* the glossary exposes, not the code:
the errata sweep (M1) must land before the glossary goes public because its
fixes become public with it, and M1 depends on the resize decision (Step 12) to
edit stage boundaries without fighting the bracket clamp.

---

## Prerequisites

Component 11 assumes Component 10 is closed and its artifacts are authoritative
(see that plan's § Hard Gates Before Component 11 Begins):

- **The public read path is live and safe.** `GET /api/v1/public/fragments`
  (browse by concept) and `GET /api/v1/public/fragments/{id}` (detail) serve
  `approved`-only, anonymously, with the ADR-009 ABC-corpus exclusion enforced
  in the service layer for `caller_id=None`. The frontend
  [`PublicFragmentBrowser`](../../frontend/src/routes/PublicFragmentBrowser.tsx)
  already consumes them via [`publicApi.ts`](../../frontend/src/services/publicApi.ts),
  deep-linked as `/public/concepts?concept=<id>`. **The glossary is the intended
  entry point into that browse view** — Component 10 shipped it deliberately
  without a concept-tree navigator (the editor tree/search/roots endpoints are
  editor-only) precisely because Component 11 provides the public navigation.
- **The storage boundary is closed and previews are signed.** Fragment previews
  (ADR-008 static SVGs, rendered by
  [`render_fragment_preview`](../../backend/services/tasks/render_fragment_preview.py))
  are served through presigned URLs like all other artifacts. The glossary's
  inline examples reuse this pipeline; they do not re-render.
- **The public-launch guards are live** — rate limiting (the glossary's new
  public GETs adopt the `READ_ANONYMOUS` limit, as the fragment routes do),
  CSP/HSTS/nosniff, the OpenAPI production gate, and the `ALLOWED_ORIGINS`
  fallback. New public concept endpoints inherit the `/api/v1/public/` prefix's
  CORS posture and rate-limit policy — no new middleware decisions.
- **The M0 fragment-editor repair landed** (2026-07-23). The editor is usable
  again; the one deferred defect (main-bracket resize during edit) is documented
  in the Component 10 plan § "Deferred within M0" with three options, and is
  picked up in Part 4 here.

It additionally assumes the following are settled and authoritative — they are
the *inputs* to this plan, not duplicated here:

- [`phase-2.md`](phase-2.md) § Component 11 (fragment selection, stubs, and
  definition-review decisions, all in the Decisions Log) and § Track M (the
  slots for M1/M2/M6/M7/M11/M12).
- [`../architecture/extended-features.md`](../architecture/extended-features.md)
  § Concept Glossary with Inline Examples — the source of this component, **with
  the noted correction**: it says "`APPEARS_IN` edges do the curation work",
  which predates the decision that concept tags live in PostgreSQL
  (`fragment_concept_tag`), not as Neo4j edges. Correct that wording when this
  component is built (`phase-2.md` § "Note on a doc inconsistency").
- [`../architecture/edge-vocabulary-reference.md`](../architecture/edge-vocabulary-reference.md)
  — the authoritative typed-relationship vocabulary the concept page renders
  (`IS_SUBTYPE_OF`, `PRECEDES`/`FOLLOWS`, `RESOLVES_TO`, `CONTRASTS_WITH`,
  `IS_EQUIVALENT_TO`, `PREREQUISITE_FOR`, `CONTAINS`), mirrored as constants in
  [`backend/graph/queries/relationships.py`](../../backend/graph/queries/relationships.py).
- [`../reports/component-9-reports/issues-deferred-for-phase-2.md`](../reports/component-9-reports/issues-deferred-for-phase-2.md)
  — the M1/M6/M7/M11/M12 issue detail and the per-fragment errata list
  (§ Editorial work).
- [`../adr/ADR-008-fragment-preview-generation.md`](../adr/ADR-008-fragment-preview-generation.md)
  and [`../adr/ADR-009-dcml-licensing-constraint.md`](../adr/ADR-009-dcml-licensing-constraint.md)
  — the preview pipeline the examples reuse and the exclusion the example pool
  honours.

---

## Part 1 — Glossary Read Model

The public concept endpoints. All live under the existing `/api/v1/public/`
prefix (new [`backend/api/routes/public.py`](../../backend/api/routes/public.py)
routes or a sibling `public_concepts.py`), inheriting its anonymous, no-role,
`READ_ANONYMOUS`-rate-limited posture. The service layer owns the cross-database
work; the graph queries extend
[`backend/graph/queries/concepts.py`](../../backend/graph/queries/concepts.py),
which already provides subtree, domain-root, schema-tree, and hierarchy-path
traversals.

### Step 1 — Public concept-detail payload

`GET /api/v1/public/concepts/{concept_id}` → a concept-page payload:

- **Definition prose and identity** — `name`, `aliases`, `definition`,
  `domain`, `complexity`, and the `stub` / `definition_reviewed` flags (Step 2).
- **Hierarchy position** — the `IS_SUBTYPE_OF` path from the domain root to this
  concept (the `hierarchy_path` pattern already used by `_SEARCH_CONCEPTS` /
  `get_concepts_by_ids`), plus direct parent and direct non-stub children so the
  page can render "up" and "down" links.
- **Typed relationships** — outgoing and incoming edges in the controlled
  vocabulary (`PRECEDES`/`FOLLOWS`, `RESOLVES_TO`, `CONTRASTS_WITH`,
  `IS_EQUIVALENT_TO`, `PREREQUISITE_FOR`, `CONTAINS`), each as
  `{type, direction, target: {id, name, stub}}`. New named Cypher in
  `concepts.py`; relationship-type strings come from `relationships.py`
  constants, never inline (project invariant). Stub targets are included but
  flagged so the frontend renders them as non-links or "not yet covered".

A stub concept returns a valid payload with `stub: true` and whatever hierarchy
it has, so its page can state honestly that it belongs to a not-yet-modelled
domain (decision: *stub nodes are shown as such* — `phase-2.md` Component 11).
An unknown id is a 404 in the standard error envelope.

**Decided (§ Decisions 1): key on the concept `id`.** It is the immutable join
key, it is already what `/public/concepts?concept=<id>` uses, and a slug would
add a second identity to keep stable for no functional gain in Phase 2.

### Step 2 — `definition_reviewed` editorial gate

Concept `definition` prose was written for annotators, not the public
(`phase-2.md` Component 11: *definition revision is a gate on this component*).
Add a `definition_reviewed` boolean to the domain YAML — an informational flag
like `stub` — defaulting to `false`, threaded through the seed script into a
`Concept.definition_reviewed` property.

- The seed pipeline (`scripts/seed.py`) reads and `MERGE`s the flag (seed
  invariant: `MERGE`, never `CREATE`).
- The Step 1 payload surfaces it. When `false`, the concept page renders its
  hierarchy, relationships, and example fragments but shows a **placeholder
  definition** ("definition under editorial review") instead of the raw
  annotator prose — the page still exists and links stay stable, only the prose
  is withheld.
- Reviewing definitions is an editorial content task, not code. This step ships
  the *mechanism*; flipping flags to `true` per concept happens as prose is
  revised (track the cadence-domain pass alongside the M1 editorial sweep in
  Part 4). **Launching with placeholders is acceptable** (§ Decisions 3): the
  review pass is not a code gate on switch-on, though Francisco intends to review
  the launch-set definitions before launch regardless.

### Step 3 — Example-fragment selection

`GET /api/v1/public/concepts/{concept_id}/examples` → up to **3 approved**
fragments tagged with the concept, drawn at random, with a **shuffle** re-draw
(decided 2026-07-14, `phase-2.md`):

- **Pool:** `approved` fragments joined via `fragment_concept_tag` on *any* tag
  (not only `is_primary` — the same rule as the browse surface), minus the
  ADR-009 NonCommercial exclusion. Reuse the service-layer exclusion already
  applied for anonymous callers on the fragment routes
  (`services.fragments._licence_excludes_public`) so the example pool and the
  public browse can never disagree about what is publishable.
- **Selection:** random 3; `?shuffle` (or a seed/cursor) re-draws. Previews are
  pre-rendered static SVGs (ADR-008), so re-draws are cheap — the endpoint
  returns fragment ids + preview URLs + minimal display metadata, not rendered
  notation.
- **Future editorial override** is designed for but not built: a nullable
  `featured_rank` integer on `fragment_concept_tag` (ranked fragments fill slots
  first, random fills the rest). Documenting the column shape here keeps the
  random-only launch from painting us into a corner; **no migration in
  Component 11** (`phase-2.md` Component 11 § Fragment selection).

**Decided (§ Decisions 2): server-random per request, with an optional seed
param unset by default.** Reproducibility is available if a shared page ever
needs it but is not the default.

### Step 4 — Public concept index

`GET /api/v1/public/concepts` → the browsable index: domain roots and, per root,
the non-stub `IS_SUBTYPE_OF` subtree, so the frontend can render a
browse-by-domain hierarchy that links into concept pages and (via
`/public/concepts?concept=<id>`) the existing fragment browse.

The traversal already exists (`get_domain_roots`, `get_concept_subtree` in
`concepts.py`) — this step is a **public wrapper** over those queries, not new
graph work. The editor's `/api/v1/concepts/tree`, `/roots`, and `/search`
endpoints stay editor-only (role-gated); the public index is a separate,
anonymous surface with only the fields a public reader needs (no schema trees, no
CONTAINS fingerprints). Stub concepts are included in the index but marked, so an
inbound link to a not-yet-covered concept resolves to an honest stub page
(§ Step 1) rather than a 404.

**Concept-count display (ties to M11, Step 8):** if the index shows a
per-concept approved-fragment count, it must read from the same source the M11
fix makes non-stale — do not stand up a second, independently-cached count here.

---

## Part 2 — Glossary Frontend

React + TypeScript, on the existing public shell (the minimal public layout
Component 10 shipped; the full audience-split topbar is Component 12, so the
glossary launches on the minimal chrome and inherits the topbar later). New
routes; a new `glossaryApi.ts` client wrapping the Step 1/3/4 endpoints, sibling
to `publicApi.ts`. All frontend design follows `docs/mockups/opus_urtext/DESIGN.md`
(Henle Blue, Urtext Cream, Newsreader/Public Sans, 0px radius, tonal layering).

### Step 5 — Concept page

Route (e.g. `/glossary/:conceptId` — final scheme is the Step 1 decision) that
fetches and renders the Step 1 payload:

- Definition prose, or the "under editorial review" placeholder when
  `definition_reviewed` is `false` (Step 2).
- Hierarchy position as breadcrumb/up-link (parent chain) plus child links.
- Typed relationships grouped by edge type, each target a link to its own
  concept page; stub targets render as flagged non-links ("not yet covered").
- A **stub page** state: when the concept itself is a stub, the page leads with
  the honest "this concept belongs to a domain Doppia has not yet modelled"
  banner and omits the example section.
- A link into the fragment browse for this concept
  (`/public/concepts?concept=<id>`).

### Step 6 — Inline example fragments

The distinctive glossary feature (from `extended-features.md` § Concept Glossary
*with Inline Examples*):

- Render the Step 3 examples as **pre-rendered preview SVGs** (ADR-008, signed
  URLs) — cheap, and the shuffle re-draw just swaps previews.
- **Expand to full Verovio + MIDI** on demand: expanding one example mounts the
  full renderer/playback for that fragment. Reuse the existing Verovio/MIDI
  machinery from the score viewer; **honour the SVG-overlay invariant** (never
  mutate Verovio output; overlays are absolutely-positioned, `pointer-events:
  none`) and `getElementsAtTime()` for MIDI→SVG mapping.
- A **shuffle** control re-draws the 3 examples (Step 3), with graceful empty
  and single-example states (a foundational concept may have few approved
  fragments early on).

### Step 7 — Concept index / browse-by-domain

The public entry surface (Step 4): a browse-by-domain hierarchy of concept
links, honouring stubs (shown, marked). This is the anonymous navigation
Component 10 deliberately left out of `PublicFragmentBrowser`; wiring it here
completes the public read journey (index → concept page → example expand →
fragment browse → fragment detail). Extend the Playwright e2e anonymous-read
scaffold (Component 10 Step 14) to cover that journey end to end.

---

## Part 3 — Track M: Public-Surface Fixes (glossary switch-on gate)

Everything the glossary makes public about a fragment — its preview, its count
in a listing, its concept label, its info-sidebar summary — must be correct
before strangers see it. These are the `phase-2.md` § Track M items slotted "by
end of Component 11". Detail lives in the issues-deferred doc; this plan
sequences them.

### Step 8 — M11: concept-tree count cache staleness

The concept-tree fragment counts get "stuck on cache" (issues doc § Fragment
browser). Counts are public on any browse/index surface, so this must be correct
before the glossary ships. Diagnose the cache's invalidation seam (what
recomputes the per-concept approved count, and on which fragment-lifecycle
transitions it should) and fix it so approve/reject/delete/re-tag events are
reflected. The Step 4 index consumes the fixed source (§ Part 1 note).

### Step 9 — M12: duplicate-`@n` display disambiguation

K331/ii "Menuetto da capo" produces duplicate `@n` measure labels; public
fragment labels must disambiguate them (issues doc; backlog §3; an ADR-015
amendment). Resolve the display convention and apply it wherever a bar reference
is shown to a public reader (fragment cards, detail range, example captions).

### Step 10 — M6: info-sidebar fixes

The fragment info sidebar (detail view) is public via the glossary's example
expand and the fragment-detail route. Fix, per the issues doc § Info sidebar:

- **Property order** — show properties in the same order as the create/edit form
  (the ADR-023 group/order the schema-tree query already returns).
- **Harmony sliced to fragment range** — the sidebar shows whole-measure chords
  instead of the sub-beat-precision slice (already solved on creation; regressed
  here).
- **Local-key convention** — show local key only on the first event and when it
  changes (score convention), matching the harmony-panel display.
- **Stage properties shown** — sub-part/stage properties are currently missing
  from the read sidebar.
- **Summary key/meter bug** — 279/ii shows "C major / 4/4" irrespective of the
  real key/meter (really F major, 3/4). `phase-2.md` M6 flags this as *possibly a
  real bug* and *glossary-visible*; investigate whether it is a summary-derivation
  or a display bug and fix at the source.

### Step 11 — M7: stage-bracket overflow at sub-beat bounds

279/ii m. 8–10 (also m. 48–50): the main bracket and info show the real fragment
("m. 8 beat 3 – m. 10 beat 1"), but the stages render as whole measures, so the
first and last stages overflow the actual fragment bounds — visible both in the
stage brackets and the sidebar (issues doc § Real bugs). This is a public-visible
rendering defect on the fragment surface. Fix the stage-bound derivation/clamp so
stages never exceed the parent fragment's sub-beat bounds.

**Note the adjacency to Step 12:** M7 lives in the same stage-bracket bounds code
as the deferred resize clamp (`computeResizeClamp` / stage-bound derivation).
Sequence Step 11 and Step 12 together and touch that code once, coherently,
rather than in two passes.

---

## Part 4 — Track M: Editor Follow-Through + Editorial Sweep

The editor was repaired in M0 with one deferred defect; the errata sweep (M1)
needs the editor whole. This part resolves the deferral, then runs the sweep.

### Step 12 — Deferred main-bracket resize during edit (M0 carryover — decision here)

**Carried from Component 10 § "Deferred within M0".** While editing a stored
fragment, shrinking the main bracket "jumps back"; it only frees when the
outermost stage is shrunk first. Root cause is verified (not a stale-ref bug):
`buildStageAssignmentsFromSubParts` marks every restored stage `confirmed: true`
(to suppress "limbo" warnings), and `computeResizeClamp` hard-clamps the main
bracket to the span of all confirmed stages — so restored stages, which fill the
fragment, block any shrink. During *creation* pre-populated stages are
`confirmed: false`, take no part in the clamp, and redistribute by weight
(`respondToMainResize`); hence the asymmetry. The `confirmed` flag does double
duty (limbo suppression **and** the resize clamp); a clean fix likely decouples
those two meanings.

Three options are on the table (full trade-offs in the Component 10 plan):

1. **Redistribute like creation** — treat restored stages as unconfirmed for the
   clamp; lowest risk (reuses the tested create-time path); cost: optional stages
   read as needing re-confirmation until touched, and a resize can move
   carefully-set stage boundaries.
2. **Keep stages fixed** — leave restored stages confirmed; shrink the fragment
   by dragging the outermost stage first; minimal code, but the "jumps back" feel
   persists for inner-stage edits.
3. **Clamp only against orphaning** — keep stages confirmed but let a main-bracket
   shrink push/trim the stages it crosses; best UX, most new bracket-drag code,
   highest risk in that fragile area.

**The decision is deferred to Francisco and made when this step is reached**
(per the 2026-07-23 instruction: *"I'll give it a thought, and come back to it
later"*). This plan slots the decision here — as the enabler for the M1 errata
that involve stage boundaries (the "wrong stages" fixes) — and pairs the
implementation with Step 11 (M7) so the shared stage-bracket bounds code is
touched once. Recommendation to open the discussion with: **Option 1** (lowest
risk, reuses the tested path) unless the "resize can move stage boundaries" cost
proves unacceptable in practice, in which case Option 3 with a proper
`confirmed`/`clamp` decoupling.

### Step 13 — M1 errata sweep + M2 `harmony_gate`

With the editor whole (Step 12), run the editorial data fixes that become public
with the glossary:

- **M1 — the per-fragment errata** (issues doc § Editorial work): the 279/i and
  279/ii corrections (harmony not confirmed anywhere — check all; V=64/V7 fixes;
  spurious IV6 / extra Final-Tonic harmonies; commentary typos; wrong stages on
  279/i m. 93 and 279/ii m. 15). These are content edits through the repaired
  editor, verified on a real render (per the "verify renders, not just audits"
  lesson), not code — but they gate the glossary because the glossary is what
  makes them public.
- **M2 — `harmony_gate` seeding + one-time confirmation sweep** (backlog §3): the
  `capture_extensions` `harmony_gate` entries already exist on the cadence
  concepts (`cadences.yaml`); this step is the one-time sweep to confirm harmony
  events across the corpus so gated concepts have clean, confirmed harmony
  behind their public examples. Ride M2 with M1 since both are editorial-data
  passes over the same fragments.

**Definition-review pass (Step 2 consumer):** flipping `definition_reviewed` to
`true` for the launch set of concepts is the same kind of editorial content work
and rides alongside M1. Per § Decisions 3 the glossary **may launch with
placeholders** on any unreviewed tail — the review pass is not a code gate.

---

## Decisions

Confirmed with Francisco (2026-07-23); the remaining open item is deferred by
choice to implementation time.

1. **Public concept URL scheme (Step 1/5) — key on the immutable `id`.** Matches
   the `concept_id` the public fragment browse already takes
   (`/public/concepts?concept=<id>`), keeps inbound links stable, and avoids
   maintaining a second identity. No slug in Phase 2.
2. **Example randomness (Step 3) — server-random per request, with an optional
   seed param (unset by default).** Cheapest; reproducibility is available if a
   shared page ever needs it but is not the default.
3. **Definition-review launch bar (Step 2/13) — launch with placeholders is
   acceptable.** The glossary may go public with "under editorial review"
   placeholders on any not-yet-reviewed concept; Francisco intends to review the
   launch-set definitions before launch regardless, but the review pass is **not
   a code gate** on switch-on. The `definition_reviewed` mechanism ships either
   way (Step 2).
4. **Deferred resize option (Step 12) — left open, decided at implementation
   time.** Option 1 / 2 / 3 (Component 10 plan § "Deferred within M0"); the
   choice is made when the step is reached, not now. Recommendation to open the
   discussion: Option 1 (lowest risk, reuses the tested create-time path).

A settled default, revisited only if the work surfaces a reason: the
`featured_rank` editorial-override column (Step 3) is **documented but not
migrated** in Component 11 — random-only launch, column added later if curation
is wanted.

---

## Deferred to Later Components

Stated so the boundary is a decision, not a gap:

- **The public topbar / audience-split nav.** The glossary launches on Component
  10's minimal public shell; the full public nav + role-gated Editorial menu is
  **Component 12** (`phase-2.md` Component 12). The concept index (Step 7) is the
  glossary's own navigation, not the site topbar.
- **`featured_rank` editorial curation of examples** — the column shape is
  documented (Step 3); the migration and the ranked-fill logic are future work,
  triggered only if random-3 proves insufficient.
- **Posts-that-mention-this-concept back-links** on the concept page — depend on
  the Blog's knowledge-graph linkage and land with **Component 16**.
- **The remaining Track M items.** Only the public-surface set
  (M1/M2/M6/M7/M11/M12) is slotted here. M3 (post-approval lifecycle UI), M4
  (review-queue UX — *unless the evaded/abandoned-cadence naming bug also affects
  public labels, in which case pull just that naming fix forward*), M5 (bracket
  redesign), M8 (harmony-panel semantics), M9 (tagging-sidebar ordering — the
  "stage properties" label was already dropped in M0), M10, M13 (i18n), and M14
  (Verovio 6.2.0) keep their later `phase-2.md` slots.
- **Multi-domain concept index.** Only the cadence domain is seeded; the index
  (Step 4) is built domain-general but exercised against one domain. The
  multi-domain fragment filter stays deferred until a second domain is seeded
  (`phase-2.md` § Still deferred).

---

## Sequencing

Parts 1–2 (glossary) and Part 3 (public-surface fixes) are parallel streams;
both must be green before public switch-on. Part 4 gates the *data* the glossary
exposes and depends on the resize decision.

```
Part 1  Glossary read model (backend)          ┐ parallel with Part 3;
  Step 1  public concept-detail payload         │ both green before switch-on
  Step 2  definition_reviewed gate (mechanism)  │
  Step 3  example-fragment selection            │
  Step 4  public concept index                  ┘
        │
        ▼
Part 2  Glossary frontend                       ← needs Part 1 endpoints
  Step 5  concept page
  Step 6  inline example fragments (preview → Verovio/MIDI expand)
  Step 7  concept index / browse-by-domain + e2e journey

Part 3  Public-surface fixes                    ┐ parallel with Parts 1–2;
  Step 8  M11 count-cache staleness             │ all green before switch-on
  Step 9  M12 duplicate-@n disambiguation       │
  Step 10 M6 info-sidebar fixes                 │
  Step 11 M7 stage-bracket overflow  ───────────┼── touch bracket-bounds code
        │                                        │   ONCE with Step 12
Part 4  Editor follow-through + editorial sweep  │
  Step 12 deferred resize decision + fix  ───────┘   (decision made here)
  Step 13 M1 errata sweep + M2 harmony_gate      ← needs the whole editor (12)
```

The exit gate is **"the glossary is correct to show a stranger"**: the concept
pages and index render (Parts 1–2), every public-surface fix is green (Part 3),
and the errata sweep + definition-review launch set have landed (Part 4) so no
wrong summary, stale count, overflowing bracket, or unreviewed prose is exposed.
Steps 11 and 12 are sequenced adjacently because they share the stage-bracket
bounds code.

---

## Docs to Update (Definition of Done)

Per CLAUDE.md's Definition of Done, update the docs whose area this component
touches, in the same change as the work:

- **`extended-features.md`** — correct the "`APPEARS_IN` edges do the curation
  work" wording to reflect PostgreSQL `fragment_concept_tag` (the `phase-2.md`
  note); mark the Concept Glossary as built.
- **New ADR** — the public concept endpoints and the concept-page payload shape
  (the URL-scheme decision, the typed-relationship serialisation, the stub /
  `definition_reviewed` states), if the shape proves non-obvious. The
  `definition_reviewed` flag joins `stub` in the domain-YAML flag vocabulary —
  record it in the knowledge-graph design reference.
- **`ADR-015`** — the duplicate-`@n` disambiguation amendment (Step 9 / M12).
- **`fragment-schema.md`** — if the M6 summary key/meter bug (Step 10) is a
  derivation bug, note the fix and bump `summary` version only if the field
  structure changes (it should not — this is a population bug, not a schema
  change).
- **`phase-2.md`** — tick the Component 11 items and strike M1/M2/M6/M7/M11/M12
  in the Track M table as they land; move any implementation decision into the
  Decisions Log.
- **`phase-2-entry-backlog.md`** — strike the M items with their landing commits
  per the register's maintenance note.
- **`issues-deferred-for-phase-2.md`** — strike the errata (§ Editorial work) and
  the info-sidebar / real-bug items as they are fixed.
- **`CONTRIBUTING.md`** — extend the Playwright e2e section with the glossary
  read journey (Step 7).

---

## Hard Gates Before Component 12 Begins

1. **The glossary is live and correct:** concept pages (definition or
   editorial-review placeholder, hierarchy, typed relationships, example
   fragments) and the browse-by-domain index render anonymously through the
   public path; stub concepts show as such; the anonymous read journey
   (index → concept → example expand → fragment browse → detail) is covered by an
   e2e test.
2. **Nothing public is wrong:** the concept-tree counts are non-stale (M11),
   duplicate `@n` labels disambiguate (M12), the info sidebar shows correct
   property order / range-sliced harmony / local-key convention / stage
   properties / real key+meter (M6), and stages never overflow their fragment
   bounds (M7).
3. **The editorial data behind the glossary is clean:** the M1 errata sweep and
   the M2 `harmony_gate` confirmation sweep have landed and are verified on real
   renders. (Definition review is not a switch-on code gate — § Decisions 3 —
   though Francisco intends to review the launch set beforehand.)
4. **The deferred resize is resolved:** the main-bracket-resize-during-edit
   defect has a chosen option implemented (or an explicit, recorded decision to
   keep deferring it), and the shared stage-bracket bounds code was touched
   coherently with the M7 fix.
