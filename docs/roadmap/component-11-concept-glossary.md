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
CONTAINS fingerprints).

**Stubs are not listed in the index** (confirmed 2026-07-23, revising an earlier
draft of this step): a domain's browsable tree is its *non-stub* subtree, which
is what `get_domain_roots`/`get_concept_subtree` already return. A stub concept
stays reachable through the **marked stub links on a concept page** (§ Step 1
returns a valid `stub: true` payload, and stub relationship/child targets are
flagged) — that is what actually keeps an inbound link from 404ing, without
cluttering the browse index with not-yet-modelled concepts.

**Concept-count display (ties to M11, Step 8):** if the index shows a
per-concept approved-fragment count, it must read from the same source the M11
fix makes non-stale — do not stand up a second, independently-cached count here.

### Step 4b — Index root selection: group by domain, exclude stage concepts

**Found on staging verification of Step 4 (2026-07-23); decided the same day.**
Step 4 shipped keying the index on `get_domain_roots`, which means *"non-stub
concept with no `IS_SUBTYPE_OF` parent"* — a **taxonomic** root, not a **domain**.
Conflating the two is the defect: the deployed index returned **seven** top-level
"domains" for the single cadence domain.

In `cadences.yaml`, three different kinds of concept have no `IS_SUBTYPE_OF`
parent, and they are not the same thing at all:

| Class | Concepts | `type` | `top_level_taggable` | Subtypes? | `CONTAINS` target? |
|---|---|---|---|---|---|
| Taxonomic root | `Cadence` | CadenceType | **false** | yes (12 nodes) | no |
| Stage leaves | `CadentialInitialTonic`, `…PreDominant`, `…Dominant`, `…FinalTonic` | *(none)* | false | no | **yes** |
| Post-cadential | `ClosingSection`, `StandingOnTheDominant` | FormalUnit | **true** | no | no |

**The obvious filter does not work.** Selecting roots on `top_level_taggable`
drops `Cadence` itself — it is deliberately `top_level_taggable: false` (an
abstract root, not directly taggable). The stages and `Cadence` share that flag
for completely different reasons, so the flag cannot separate them.

**The rule (decided — § Decisions 5):** a concept is an index root iff it has
**no `IS_SUBTYPE_OF` parent *and* is not the target of any `CONTAINS` edge.**
That yields exactly `Cadence`, `ClosingSection`, `StandingOnTheDominant`. It is
structural rather than capability-based, so it survives a stage ever becoming
taggable, and it needs no YAML change. (The data corroborates the split three
ways: stage concepts also have no `type` and are `tlt: false`.) The alternative
formulation — *taggable OR has subtypes* — gives the same three today but keys on
capability, so it is the fallback, not the rule.

Stage concepts do not disappear from the glossary: § Step 1 already surfaces
`CONTAINS` as a typed relationship, so the **Cadence** page links to Initial
Tonic / Pre-Dominant / Dominant. They keep their pages, reachable from their
parent — they are simply not top-level index entries. That is the correct IA.

**Group by domain, not by taxonomic orphanhood.** The model already carries a
real domain notion (the `domain:` field and the auto-created `BELONGS_TO` edge to
a `Domain` node). "Browse by domain" should key on *that*. The index becomes one
**Cadences** heading containing the `Cadence` tree plus the two post-cadential
concepts as sibling top-level entries — i.e. a **forest per domain**, not a
single tree. Nothing is labelled a "domain" that is not one, no fake parent is
invented, and no taxonomy decision is committed.

Response shape moves the node list up one level and replaces `root_id`/
`root_name` with the domain key:

```
{ domains: [ { domain: "cadences",
               label:  "Cadences",
               nodes:  [ {id, name, aliases, hierarchy_path,
                          parent_id, fragment_count}, … ] } ] }
```

`parent_id` is `null` for each top-level entry, so the frontend assembles a
**forest** by grouping on `parent_id` — the same flat-list-plus-`parent_id`
pattern the editor tree already uses, just with more than one root. (`label` is a
display string for the domain key; deriving it is fine for now — a `Domain` node
property can carry it later if the keys ever need nicer names.)

**This is a general fix, not a public-only one.** `get_domain_roots` is **shared
with the editor concept tree** (`/api/v1/concepts/roots`), so applying the rule
there fixes both surfaces at once — and that is what closes the related gap
Francisco observed: `ClosingSection` and `StandingOnTheDominant` are taggable but
currently unreachable by *browsing* on either surface (findable only via the
search bar), so any approved fragments tagged with them are invisible in browse.
Knock-on: `FragmentBrowser` renders a single default tree today and needs a small
change to handle several top-level entries.

**Sequencing.** This revises the Step 4 response shape, and **§ Step 7 is its
consumer** — land it *before* Step 7's index view is built, or Step 7 reworks.
It does not touch the concept page (Step 5) or examples (Step 6), so Part 2 can
proceed on those in parallel.

**Deliberately not decided here:** whether `ClosingSection` /
`StandingOnTheDominant` eventually get a real parent (see § Deferred to Later
Components). Domain grouping makes them presentable *now* without committing to
that taxonomy.

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

The public entry surface (Steps 4 + 4b): a browse-by-domain hierarchy of concept
links. This is the anonymous navigation Component 10 deliberately left out of
`PublicFragmentBrowser`; wiring it here completes the public read journey
(index → concept page → example expand → fragment browse → fragment detail).
Extend the Playwright e2e anonymous-read scaffold (Component 10 Step 14) to cover
that journey end to end.

**Consumes the § Step 4b shape — read that step first.** Two consequences for
this view: each domain renders a **forest**, not a single tree (group the flat
`nodes` list on `parent_id`, where several entries have `parent_id: null`), and
the domain heading comes from `domain`/`label` rather than a root concept's name.
Stub concepts are not in the index (§ Step 4); they are reached only as marked
links from a concept page. **Step 4b must land before this step is built**, or it
is reworked.

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

**Diagnosis and fix (2026-07-25).** There was no invalidation seam to repair —
there was a **payload boundary** in the wrong place. `ConceptService.get_tree`
cached the entire `ConceptTreeResponse`, `fragment_count` included, under
`tree:{root}:{language}` with a 1-hour TTL that only `scripts/seed.py`
invalidated. So the counts inherited the *graph's* invalidation schedule (a
re-seed) while depending on the *fragment database's* write rate (every
approve / reject / delete / re-tag) — a mismatch no amount of extra hooks fixes
cleanly, because every fragment mutation in the system would have to know about
a graph cache.

The fix moves the boundary rather than adding invalidation: the cache now holds
only the count-free, translated node structure, and `_fetch_fragment_counts` is
called on every request (one grouped PostgreSQL query over an `IN` list) and
attached to the cached structure. Structure keeps the seed-time invalidation it
always had — correctly, since a re-seed is the only thing that can change it.
Counts are simply never cached, so there is nothing to go stale and no
lifecycle event to hook. The key was bumped to `tree:v2:{root}:{language}` so a
pre-fix entry surviving a deploy cannot be read back as a structure (it would
reintroduce the bug until its TTL expired); the seed-time `tree:*` pattern still
matches. This lands on the **shared** service method, so the editor concept tree
and the Step 4 public index are de-staled by the same change — as § Part 1
required, with no second count source.

**Not done here, deliberately:** the public index (Step 4) still runs its
`1 + N` Neo4j traversals uncached on every anonymous request. Now that a cache
entry is count-free it *could* share the structure cache, but that is a
performance decision on a public endpoint, not part of M11's correctness fix —
noted for Component 12's public-surface hardening.

### Step 9 — M12: duplicate-`@n` display disambiguation

K331/ii produces duplicate `@n` measure labels; public fragment labels must
disambiguate them (issues doc; backlog §3; an ADR-015 amendment). Resolve the
display convention and apply it wherever a bar reference is shown to a public
reader (fragment cards, detail range, example captions).

**Investigated 2026-07-25; scope confirmed with Francisco the same day.** The
investigation changed this step's shape twice over, so the findings are recorded
before the plan.

#### What is actually wrong

**Two families of duplicate bar labels exist, and M12 as written names only one.**

- **Family A — a restarting bar-number sequence.** K331/ii numbers 1–48 twice.
  **The cause is the Trio restarting the count** (confirmed by Francisco from the
  score, 2026-07-25) — the Menuetto *da capo* is not written out. The ADR-015
  amendment states the opposite ("a written-out repeat … *not* the minuet+trio
  renumbering the issue backlog assumed"); **that sentence is factually wrong and
  must be corrected** (§ 9G). The later 2026-06-30 readthrough and ADR-032, which
  describe the Trio restarting, are the correct account.
- **Family B — volta endings.** *Assumed* at planning time: first and second
  endings share `@n` by project convention (`mei-ingest-normalization.md` §6),
  disambiguated only by `fragment.repeat_context`, which the public surface never
  shows. **§ 9A disproved this** — the corpus has no such duplicates; second
  endings carry X-prefixed `@n`. What survives is a cosmetic enum-vs-prose fix in
  the detail panel. The paragraphs below are kept as the record of what was
  assumed; § 9A is what actually holds.

**The blast radius was unknown and had to be measured first.** The "only
K331/ii" reading came from `ingestion-warnings.json`, which covers the
**15-movement** Component 9 staging subset; the live corpus is **54 movements**
(`mc-stability-snapshot.json`) with no equivalent warnings report. § 9A settled
it: one movement now, one more at Step 13.

**K282/ii is a known source erratum.** It is a Menuet I & II movement whose NMA
text restarts the numbering at Menuet II; the DCML encoding does not, so our
corpus shows a continuous count where the edition restarts. Francisco's decision
(2026-07-25): **fix the numbering to restart, then section it like K331/ii.**
See § 9F for the coupling this drags in — it is the riskiest part of this step.

**The duplicate labels are not display-only, contrary to the ADR-015 amendment.**
Harmony events are keyed `(mn, volta, beat)` (`services/analysis.py`) and the
fragment harmony slice filters `bar_start <= mn <= bar_end`
(`services/fragments.py` — `_slice_harmony_events` and `sources_in_range`). On a
movement where `@n` restarts, both passes collide on that identity. Francisco's
observed symptoms match exactly: **the K331/ii score shows harmony on the
Menuetto only and none on the Trio, and selecting a Trio fragment shows the
corresponding *Menuetto* measures' harmonies in the sidebar.** The ADR-015
amendment's "never used as a join key, so no data is at risk" holds for
rendering and fragment ranges; it does not hold for the harmony layer.
**In scope for this step** (decided 2026-07-25).

#### Decisions (Francisco, 2026-07-25)

1. **Editorial section marking** (investigation Option 1) is the labelling
   mechanism: a section carries a real musical name ("Trio", "Menuet II"), which
   a derived ordinal ("2nd pass") cannot. These movements are few and alike.
2. **Structural detection** (Option 2) rides alongside, for *detection only* —
   it decides whether a movement is ambiguous and flags a movement that restarts
   numbering without editorial section names. It never generates a label.
3. **Voltas are in scope**; **the harmony coordinate bug is in scope**.
4. K331/ii carries **no fragments on staging**, so nothing public is wrong
   *today* — the harmony defect is live in the editor, and the label defect is
   latent until the first fragment is tagged there.

#### 9A — Survey the real corpus ✅ done 2026-07-25

**Report: [`step-9a-duplicate-bar-number-survey.md`](../reports/component-11-reports/step-9a-duplicate-bar-number-survey.md).**
`movement.normalization_warnings` proved unusable (null for 52 of 54 movements),
so the survey walked every movement's normalised MEI from object storage
instead — the authoritative source either way. Findings that change the steps
below:

- **Family A is exactly one movement.** `k331/movement-2`: Menuetto **mc 1–48**
  (`@n` 1–48), Trio **mc 49–101** (`@n` 1–52 then `X1`), with `dir:MENUETTO`,
  `dir:Fine`, `dir:TRIO` and `dir:Menuetto da capo` marking the structure in the
  MEI itself. No fragments on it. K282/ii joins it in Step 13: Menuetto I
  **mc 1–34**, Menuetto II **mc 35–76**, numbering continuous (the erratum),
  also fragment-free.
- **Family B does not exist.** Nine movements carry `<ending>` elements; in every
  one the second ending's measure has an **X-prefixed `@n`**, never a repeat of
  the first ending's number. No two measures in this corpus share a bar label
  because of a volta. `mei-ingest-normalization.md` §6 and ADR-015 both document
  the opposite convention; that is a **documentation erratum**, corrected here.
- **Section names are already in the score** — the `<dir>` text sits exactly at
  each boundary, so § 9C's editorial step is *confirming and casing* a proposed
  name, not inventing one, and § 9B can propose bounds **and** name.
- **Section bounds must span `<ending>` measures.** Walking only bare measures
  ends K331/ii's Trio at mc 99 instead of 101, orphaning any fragment in its
  second ending. The normalizer's current run computation has exactly this bug.
- **Neither repair needs a data migration** — no fragments exist on either
  affected movement, provided both land before anything is tagged there.

Two things the survey opened, both resolved 2026-07-25:

- **The volta item is no longer a correctness item — and stays anyway.** All that
  remains is the detail panel printing the raw enum `first_ending` where prose
  belongs. Kept in Step 9 (decided): the point of this step is a label that reads
  as standard, musically meaningful text, and an enum leaking into the UI fails
  that whether or not it is ambiguous. It gates nothing, so it is the first thing
  to cut if the step runs long.
- **`normalization_warnings` is not populated** — § 9B planned to persist the
  structured runs into a column the 54-movement re-ingest wrote `null` to for 52
  movements. **Repairing that ingest path is documented and deferred** (decided);
  it is a reporting gap well beyond M12 — a normalizer that computes 51 advisories
  for K331/ii and stores none of them. § 9B therefore **persists nothing** (see
  there). Recorded as `phase-2.md` Track M **M15**.

The `bar_start`-cannot-hold-`X1` gap § 9A also surfaced is likewise documented
and deferred — Track M **M16**.

#### 9B — Structural detection (a validation guard, not persisted state) ✅ done

*Shipped as [`scripts/validate_movement_sections.py`](../../scripts/validate_movement_sections.py).
Passes across all 54 movements; warns (correctly) that K282/ii is sectioned
without a restart, pending the Step 13 repair.*

The normalizer already computes the restart runs — `_split_increasing_runs` in
`services/mei_normalizer.py` — but interpolates them into a warning *message*.
Promote them to structured data expressed in **`mc`** terms (the message's
current run lengths are positions in the filtered `@n` list, not `mc`, so they
cannot be used directly), and **include `<ending>` measures in the bounds** —
§ 9A found that walking bare measures alone ends K331/ii's Trio at mc 99 instead
of 101. Propose the section **name** too, from the `<dir>` text at the boundary
(§ 9A found it there in both affected movements).

**It persists nothing** (decided 2026-07-25). The original plan wrote the runs to
`movement.normalization_warnings`; § 9A found that column `null` for 52 of 54
movements, and repairing the ingest path that drops advisories is deferred to
Track M **M15**. Rather than depend on a column nothing populates — or add a
second one — the detection ships as a **validation script** in the shape of
`scripts/validate_graph.py`: it walks every movement's MEI, computes the runs,
and fails when a movement whose numbering restarts has no `movement_section`
rows. That is precisely the guard the plan wanted, it has no storage to go stale,
and it is runnable in CI against a seeded environment.

The § 9A survey walk is the prototype for it. Two corrections it must carry that
the normalizer's current run computation gets wrong: bounds **include `<ending>`
measures**, and the proposed **name** comes from the `<dir>` text at the
boundary.

#### 9C — The editorial section model ✅ done

*[ADR-036](../adr/ADR-036-movement-sections-and-bar-label-disambiguation.md);
migration `0009_movement_section`; `models.music.MovementSection`; seeded by
[`scripts/seed_movement_sections.py`](../../scripts/seed_movement_sections.py)
(idempotent — four rows across the two movements).*

**Decided 2026-07-25: a `movement_section` table** (`movement_id`, `ordinal`,
`name`, `mc_start`, `mc_end`), indexed on `movement_id` — not a JSONB column.
**The ADR recording it is still a prerequisite to writing the migration** (per
CLAUDE.md Definition of Done — this is a new persisted structure). Rationale
over JSONB on `movement`: the read path
resolves a section for every fragment on a page of browse cards, which is one
indexed join rather than a per-row JSON scan; and the rows are editorial content
worth constraining, not an opaque blob. Keyed on `mc` so it survives a re-ingest
(`@n` is display-only; `mc` is document order — ADR-015).

Population is editorial, through a script in `backend/data_migrations/`. § 9A
supplies the content exactly: **K331/ii — Menuetto mc 1–48, Trio mc 49–101**
(names from the MEI's own `dir:MENUETTO` / `dir:TRIO`); and, at Step 13,
**K282/ii — Menuetto I mc 1–34, Menuetto II mc 35–76**. Four rows across two
movements is the whole editorial burden.

A movement with fewer than two sections has **no rows**, so nothing changes for
the ~52 unaffected movements.

#### 9D — Read model: attach the qualifier ✅ done

*`FragmentService._fetch_movement_sections` batches the spans per page;
`_section_label` resolves by `mc` containment. `section_label` is on all four
read models.*

The service resolves a fragment's section by `mc` containment and exposes it as
`section_label: str | None` (null when the movement has no sections) on the four
fragment read models: `FragmentDetailResponse`, `FragmentListItem`,
`ReviewQueueItem`, and — the one that matters for the public surface —
**`ConceptBrowseItem`**, which is the model behind both the public browse cards
and the glossary example captions and which today carries *no* machine
coordinate at all (no `mc_start`/`mc_end`, so no client-side disambiguation is
even possible).

#### 9E — The display convention (the actual M12 deliverable) ✅ done

*`qualifyRange` in `utils/fragmentRange.ts` is the single place the convention
lives; `formatBarRange` replaces the duplicated `common:barRangeMm` template.
Applied on the browse card, the glossary example caption, the fragment detail
header, the info sidebar, and the review queue. Stage sub-ranges are
deliberately left unqualified — they sit under an already-qualified parent.
Listing surfaces keep measure precision (a card is a glance): only the qualifier
logic is shared, not the precision.*

There were three independent bar-range formatters and no shared notion of a
disambiguated label:

| Formatter | Used by | Beat-aware | Knows `repeat_context` |
|---|---|---|---|
| `formatFragmentRange` (`utils/fragmentRange.ts`) | fragment detail, info sidebar, stage sub-ranges | yes | no |
| `common:barRangeMm` → "mm. X–Y" | `FragmentBrowser` cards **and** `ConceptExamples` captions | no | no |
| `review:barRange` → "bars X–Y" | review queue (editor-only) | no | no |

**Consolidate them into one utility** so the convention cannot drift again, and
apply:

- Unambiguous movement, no repeat context → unchanged: `mm. 12–15`.
- Sectioned movement → prefix the section name: `Trio, mm. 12–15`. **Qualify
  both sections**, not only the second — in a sectioned movement an unqualified
  label is itself ambiguous.
- Volta → suffix in prose: `mm. 12–15 (1st ending)`, replacing the raw
  `first_ending` enum in the detail panel. The harmony sidebar's per-event `V1`
  marker stays as it is: it is a compact per-row marker, a different job from a
  fragment-level label. **§ 9A demoted this to a prose fix** — no volta produces
  an ambiguous label in this corpus — but it **stays in Step 9** (decided
  2026-07-25): a raw enum in the UI fails this step's standard whether or not it
  is ambiguous. It gates nothing, so it is the first thing to cut if the step
  runs long.
- Both → `Trio, mm. 12–15 (1st ending)`.
- New i18n keys for `en` and `es`.

**Not in scope, recorded by § 9A and deferred as Track M M16:**
`fragment.bar_start` is an `INTEGER` and cannot hold an X-prefixed `@n`, so a
selection beginning on a split-measure complement — which every second volta
ending in this corpus is — has no faithful human coordinate to store. No such
fragment exists today, so nothing is currently wrong; it is a latent gap for
whoever next touches selection bounds.

#### 9F — The harmony coordinate fix ✅ done (with Step 10)

*Landed 2026-07-25. `_event_in_range` is now the shared membership test behind
`_slice_harmony_events` and `_sources_in_range`: `mc` where the event has one,
the `(mn, volta)` test where it does not. On the frontend,
`HarmonyOverlay._resolveMeasureKey` resolves the measure ghost through the
inverted `mcIndex`.*

**The frontend half was worse than predicted, and its cause was not where this
plan said.** The overlay recomputed `measureGhostKey(event.mn, volta)`, which
returns a **base** key — it is `walkMeasureKeys()` that disambiguates a repeated
key by suffixing the later occurrence (`m12#1`). So the ghost layer *did* hold
the Trio's measures under distinct keys all along; the overlay simply never
asked for them, and every Trio event resolved onto the Menuetto ghost of the
same number. `harmony-score-overlay.md` § Step 1 asserted the opposite
("handles … section-reset numbering") and is corrected.

Switch the fragment harmony slice (`_slice_harmony_events`) and
`sources_in_range` from the `mn` range to an **`mc` range**
(`mc_start <= mc <= mc_end`), which is unambiguous by construction, and switch
the frontend overlay's event→score-position mapping from `(mn, volta)` to `mc`
— that mapping is what currently piles the Trio's events onto Menuetto bars.

Every DCML-ingested event already carries `mc`
(`services/tasks/ingest_analysis.py`), so no migration is needed for corpus
data. Three things to resolve during implementation:

- **`mc` is `int | None` on the harmony API payloads** — a manually inserted
  event may lack it. Decide between requiring `mc` on insert going forward (the
  tagging tool has the MEI in memory and can supply it, exactly as it does for
  fragment coordinates) plus a one-time backfill, versus an `(mn, volta)`
  fallback when `mc` is null. The backfill is unambiguous for every movement
  except the affected ones — check § 9A for whether any manual events exist there.
- **Event identity for edit/delete is `(mn, volta, beat)`** and is ambiguous on
  the same movements. The lookup already cross-checks `mc` when both are present;
  promoting `mc` to the primary identity with the triple as fallback is the
  smaller half of what ADR-015 deferred as "filter by `mc` directly".
- **Why it moved to Step 10.** M6's "harmony sliced to fragment range" bug
  (whole-measure chords instead of the sub-beat slice) lives in the same
  function. The *coordinate* change and the *precision* change should touch that
  function once, coherently — the same reasoning that pairs Steps 11 and 12 on
  the bracket-bounds code.

#### 9G — K282/ii source erratum → **executed in Step 13**

*Split out 2026-07-25 (§ Decisions 7). It is an editorial-data repair on the
corpus, not glossary code, so it rides with the M1/M2 sweep in Part 4 — where
the other corpus-data corrections already live.*

Restarting K282/ii's numbering at Menuet II is a corpus-prep change, and it is
the one part of this step that touches data that is currently *correct by our own
convention*. The coupling to spell out before starting:

- Renumbering the MEI `@n` alone is not enough: the DCML harmony rows keep the
  continuous `mn`, so the sidebar would print bar numbers that disagree with the
  score. **The `@n` renumbering and the harmony `mn` renumbering must land
  together**, in the same prep + re-ingest.
- Any stored fragment on that movement carries `bar_start`/`bar_end` in the old
  numbering; per ADR-015 a deliberate re-ingest that moves `@n` is an editorial
  act requiring a data migration. Confirm from § 9A whether K282/ii has
  fragments; if it does, the migration is part of this sub-step.
- `mc` is untouched throughout, so rendering, fragment ranges, previews, and the
  mc-stability check are unaffected — that is what makes this safe to do at all.

If § 9A turns up more movements in this class, treat them as one batch here
rather than one-off fixes.

#### Verification

**Step 9 proper (§ 9A–9E):**

- The § 9A survey report exists and is referenced from the docs below.
- Labels render as `Trio, mm. 12–15` on a browse card, a glossary example
  caption, and the detail range; `mm. 12–15 (1st ending)` on a K331/i volta
  fragment; unchanged on an unaffected movement.
- Unit tests: the formatter matrix (sectioned × volta × beats × single/multi
  bar), section resolution by `mc` containment, and the detection check firing on
  a restart-without-sections movement.
- **Verified on a real render, not only on tests** (the Component 9 lesson).

**Carried to Step 10 with § 9F:** on staging, on K331/ii, the score shows harmony
on the **Trio** as well as the Menuetto; a Trio fragment's sidebar shows **Trio**
harmonies; a Menuetto fragment's shows only the Menuetto's. Plus unit coverage of
`mc`-range slicing. This is a rendering surface where an audit passes and the
page still looks wrong — confirm it on the overlay, not in a test alone.

#### Docs to update

- ✅ **ADR-015** — corrected: K331/ii is the **Trio** restarting the count (not a
  written-out repeat), the runs are **1–48 and 1–52** (not "1–48 twice"), and the
  volta claim that both endings share `@n` does not hold for this corpus. "No
  data is at risk" narrowed too — the harmony layer keyed on `(mn, volta, beat)`
  *was* at risk; the `mc`-range slice that resolves it lands in Step 10.
- ✅ **`mei-ingest-normalization.md` §6** — corrected to the X-complement shape
  actually present, with the two consequences noted (the "integer `@n`
  required" rule is not enforced in practice; M16).
- ✅ **New ADR** — [ADR-036](../adr/ADR-036-movement-sections-and-bar-label-disambiguation.md)
  records the `movement_section` model, the display convention, and the
  alternatives rejected.
- ✅ **`fragment-schema.md`** — `section_label` documented as a read-resolved
  field rather than a stored column.
- **New ADR** — the `movement_section` model and the display convention (§ 9C,
  § 9E), plus the harmony identity shift toward `mc` (§ 9F) if that is not folded
  into the ADR-015 amendment.
- **`harmony-score-overlay.md`** — the `(mn, volta)` identity it documents
  becomes `mc`.
- **`mei-ingest-normalization.md`** — the structured runs (§ 9B) and the K282/ii
  erratum with its disposition.
- **`fragment-schema.md`** — `repeat_context` display convention; `section_label`
  on the read models.
- **`phase-2.md`** M12, **backlog §3**, **issues-deferred** — struck as they land.

#### The split (decided 2026-07-25)

The investigation grew this well past label formatting: it spans corpus prep, the
normalizer, a new persisted model, editorial data entry, four read models, three
frontend formatters, and the harmony coordinate system. It is therefore split
along its natural seams, each part independently shippable and verifiable:

| Part | Lands in | Why there |
|---|---|---|
| § 9A–9E — survey, detection, `movement_section`, read models, display convention | **Step 9** | The M12 deliverable proper: the public-facing label |
| § 9F — harmony `mc`-coordinate fix | **Step 10** (with M6) | Same function as M6's slice-precision bug; touch it once |
| § 9G — K282/ii renumbering | **Step 13** (with M1/M2) | An editorial corpus-data repair, not glossary code |

The Component-11 exit gate is unchanged: all three must be green before public
switch-on, because all three are things a stranger can see be wrong.

### Step 10 — M6: info-sidebar fixes

The fragment info sidebar (detail view) is public via the glossary's example
expand and the fragment-detail route. Fix, per the issues doc § Info sidebar:

- ✅ **Property order** — show properties in the same order as the create/edit form
  (the ADR-023 group/order the schema-tree query already returns). *The sidebar
  iterated the stored `summary.properties` object, i.e. JSONB insertion order —
  whatever sequence the tagging session happened to write. It now follows the
  schema list the server already sorts, which is exactly what `PropertyForm`
  renders. Properties whose schema is missing keep their order and go last, so a
  value can never disappear (the public path skips the editor-only schema fetch,
  and there this is a no-op).*
- ✅ **Harmony sliced to fragment range** — the sidebar shows whole-measure chords
  instead of the sub-beat-precision slice (already solved on creation; regressed
  here). *The slice was measure-granular server-side. `_event_in_range` now
  clips the boundary measures by `beat_start`/`beat_end` — onset-based,
  exclusive at the end, the rule `fragment-schema.md` already specified and the
  ghost layer and harmony panel already applied. **This also corrects the
  approval gate**, which shares the function and was demanding review of events
  outside the fragment.*
- ✅ **Harmony coordinate — the § 9F fix, and three more surfaces it exposed**
  (2026-07-25/26). The § 9F change fixed the stored-fragment slice and the
  in-score labels, and Francisco's verification on K331/ii found the same defect
  in three places it had not reached. All three are one root cause — **a bar
  number was being used where only `mc` is unique** — and all three are fixed the
  same way:

  1. **The tagging sidebar showed Menuetto harmony for a Trio selection.**
     `HarmonyPanel` queried `GET /analysis/events?bar_start=&bar_end=`. Worse
     than a duplicate match: on this movement the MEI's `@n` and the DCML `mn`
     **disagree outright** — the MEI restarts at the Trio, the annotation numbers
     through 1–101 — so the Trio's notated m. 29 is `mn=77`, and asking for bars
     29–30 returned the Menuetto's bars, or nothing. The endpoint now takes an
     optional `mc_start`/`mc_end` that overrides the bar bounds, and the panel
     sends the committed selection's mc. Its beat clip keys on `mc` too, for the
     same reason.
  2. **A stored fragment's bracket was painted on both passes**, and
  3. **only the Menuetto one was clickable.** `FragmentOverlay.toSelectionRange`
     dropped `mc_start`/`mc_end`, so `effectiveMeasureKeys` fell back to scanning
     the ghost layer for `barN` in range and matched both `m29` and `m29#1`. It
     now supplies `measureKeys` from the fragment's mc interval via
     `measureKeysForMcRange`, which is authoritative and short-circuits that
     scan.

  Verified against the live corpus: Menuetto fragments unchanged (there `mc ==
  mn`), every Trio fragment now returns its own harmony instead of the
  Menuetto's or none.

  The original § 9F item: the slice filtered on the *human* coordinate
  (`bar_start <= mn <= bar_end`) and the overlay maps events to score positions
  by `(mn, volta)`, so on a movement whose bar numbers restart, both passes
  collide: K331/ii renders all harmony on the Menuetto and shows Menuetto
  harmonies for a Trio fragment. Move both to `mc`. **Read § 9F before starting**
  — the coordinate change and the slice-precision fix above are the same
  function, and it should be touched once.
- ✅ **Local-key convention** — show local key only on the first event and when it
  changes (score convention), matching the harmony-panel display. *Applied to the
  harmony list. Deliberately **not** applied to the approval gate's
  unreviewed-events list: that is a list of items needing attention, each read on
  its own, not a running harmonic reading.*
- ✅ **Stage properties shown** — sub-part/stage properties are currently missing
  from the read sidebar. *A stage's properties belong to the stage's concept, so
  the panel now fetches each distinct stage concept's schema tree — the same
  fetch `SubPartForm` makes on the write side — in parallel and independently of
  the parent's, so one stage failing cannot cost the parent its labels.*
- ✅ **Summary key/meter bug** — 279/ii shows "C major / 4/4" irrespective of the
  real key/meter (really F major, 3/4). `phase-2.md` M6 flags this as *possibly a
  real bug* and *glossary-visible*; investigate whether it is a summary-derivation
  or a display bug and fix at the source.

  **A real derivation bug, and corpus-wide (fixed 2026-07-25).** Not specific to
  279/ii: **every fragment in the database** carried `"C major"` / `"4/4"`, which
  happened to be right for the two C-major-4/4 movements and wrong for the other
  six — 51 of 65 fragments. `parseMeiKey`/`parseMeiMeter` read `key.sig` /
  `meter.count` **attributes on the first `<scoreDef>`**; the corpus MEI carries
  no attributes there at all, keeping key and meter in `<keySig>` / `<meterSig>`
  children of `<staffDef>`. Both parses therefore always fell through to their
  defaults. (`parseMeiMeterParts` and `parseMeiMeterUnit` already probed both
  encodings correctly, which is why the beat grid was right while the summary was
  not — the drift between two functions that should have agreed.)

  Fixed at the source, but **not by fixing the parser alone**: the MEI records
  *no mode anywhere*, and `<keySig sig="4f"/>` is A♭ major and F minor alike, so
  the key is not recoverable from the notation however carefully it is parsed.
  `summary.key`/`summary.meter` now come from the **movement record**, served on
  the `mei-url` response the score viewer already fetches; the (now correct)
  MEI parse remains the fallback for a movement with no curated metadata.
  Existing rows repaired by `backend/data_migrations/fix_summary_key_meter.py`
  (idempotent; merges the two keys into the existing JSONB rather than replacing
  it). **No `summary` version bump** — this is a population bug, not a schema
  change, exactly as this plan's § Docs to Update anticipated.

### Step 11 — M7: stage-bracket overflow at sub-beat bounds ✅ done 2026-07-27

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

#### Root cause

Not a clamp that was missing — an invariant that was only half true. The stage
layout frame's grid comes from `chooseStageGrid`, which picks the **coarsest
resolution that seats the stage count**; the fragment's own precision has no say,
so a beat-precise fragment with three measure-fitting stages is laid out on a
measure grid. That is correct and normal. What was wrong is that
`buildStageSlots` applied the selection's beat-precision endpoint filters at beat
and sub-beat resolution only. At measure resolution every slot spanned its whole
measure, so the frame's outer edges were the endpoint *measures* rather than the
selection — and I7 ("first stage start ≡ main bracket start, exactly, at all
resolutions", §6A.4) was quietly false in precisely the case that occurs in the
corpus. `prePopulateStages` had the same gap, hard-coded: `beatStart: null,
beatEnd: null` on every stage it produced.

So the overflow is not only rendered, it is **stored**: the sub-part rows for
279/ii mm. 8–10 and 48–50 carry whole-measure bounds. The sidebar was reading
them faithfully.

#### The fix

- **`buildStageSlots`, measure branch** — clip the two endpoint slots to the
  selection's beat bounds, in geometry (`left`/`right`, read off the sub-beat
  index, falling back to the beat index) *and* in beat coordinates
  (`beatFloat`/`endFloat`), leaving interior slots measure-aligned. An endpoint
  measure the bounds leave uncovered contributes no slot at all — the same
  reduction `formatFragmentRange` already makes for display. A measure with no
  fine ghosts in either index keeps its whole extent rather than vanishing.
  Because every stage bound, every bracket pixel, and every sub-part payload
  derives from this list, one clip fixes rendering, dragging, resizing, and what
  gets written.
- **`prePopulateStages`** — pin the outer edges to the selection's endpoints,
  beats included, exactly as `prePopulateStagesAtGrid` already documented for the
  finer grids. Interior boundaries stay measure-aligned.
- **`chooseStageGrid(stageCount, slotCounts)`** — signature changed to take the
  frame's own slot counts instead of deriving the measure tier from the
  selection's key list. Two reasons: the key count is now the wrong number (an
  uncovered endpoint measure is a key with no slot), and `respondToMainResize`
  had an open-coded copy of the same three-line rule. One rule, fed by the lists
  the brackets render.
- **`frameToAssignments`** — a required stage left with an empty run now carries
  `error: true`. It keeps its committed bounds (nothing is silently lost) but
  `computeStagesComplete` blocks submission, so a required sub-part outside its
  parent cannot be written. This closes a hole the Step 12 clamp change would
  otherwise have widened: it was previously unreachable *because* the clamp
  refused the shrink.
- **`validate_containment`** — the server-side guard that should have caught this
  compared **bar numbers only**, and said so: *"beat-level containment is not
  checked here because beat values are measure-local … their comparison across
  different measures is not meaningful without knowing the meter."* True of beats
  stripped of their measure; false of `(mc, beat)` pairs, which order fine with a
  null beat read as its measure's own edge (∓∞ *within one mc*) and need no meter
  at all. Now compared that way — which also moves the check off bar numbers onto
  `mc`, so a sub-part cannot slip through on a bar number that occurs twice
  (ADR-015). Create and update share one implementation instead of two copies.
  This is defence in depth, not the fix: the frame is what stops it happening.
- **`backend/data_migrations/clamp_subpart_bounds.py`** — repairs the rows
  written before the fix. Deterministic, not editorial: a sub-part is a *part of*
  its parent, so a bound outside the parent's is wrong by definition and its
  correct value is the parent's own. Interior boundaries between stages carry
  real editorial intent and are untouched. Beat pairs are re-normalised
  afterwards so the ADR-005 wire invariant still holds; a sub-part lying entirely
  outside its parent is reported and skipped rather than guessed at. Idempotent,
  `--dry-run` first.

Tests: 6 frame cases (endpoint beat coordinates, clipped geometry, single-measure
double clip, uncovered endpoint measure, no-fine-ghosts fallback, no-beat-precision
no-op), 3 pre-population cases, 7 containment cases including the K331/ii
duplicate-bar case, 24 unit tests on the repair's coordinate logic. Two existing
containment fixtures set `mc_start`/`mc_end` inconsistently with their bar range —
harmless under a bar-only check, meaningless as a movement — and were corrected.

Plus **`e2e/sub-part-brackets.spec.ts`**, the geometry half of the guard: real
Chromium, real Verovio, the public fragment detail. The unit suites can only
check frame arithmetic against a mock layer, but whether a bracket lands on the
right pixel depends on where Verovio actually drew the notehead at the fragment's
start beat. Two cases — clamped bounds render flush inside the parent (I7/I8), and
the *same* fixture with measure-level bounds renders the overflow M7 reported,
which is the control that keeps the first from passing vacuously.

Its fixture, `e2e/fixtures/beat-precise.mei`, is new because `sample.mei` fails
this test three ways, each **silently**: without `xml:id` on measures no bracket
renders at all; without `xml:id` on notes, and without `dur.ppq`, the ghost layer
falls back to one synthetic whole-measure ghost per bar (§6A.7) and every
beat-precise bracket degrades to whole measures — i.e. a fixture missing them
reproduces the bug and calls it success. A fourth trap: a comment placed *before*
the `<mei>` root defeats Verovio's format detection ("no root found") and renders
a blank score. All four are recorded in the fixture's own header.

**Noted, not fixed → M17.** `measure_end_beat` had to pick a compound-meter rule,
and the two existing ones disagree: the ghost layer reads compound as `unit == 8
&& count % 3 == 0` (so 3/8 is *one* dotted beat), `ingest_analysis` additionally
requires `count >= 6` (so 3/8 is three beats). The script follows the ghost layer,
which wrote the values it repairs — correct for this repair, and worth flagging
that it becomes wrong the moment M17 changes the rule, so the M17 fix needs its
own data pass over 3/8 fragments.

Francisco had already seen the consequence from the other end: on **280/iii m. 15**
the harmony record is right (beats 1 and 3) but both labels draw on beat 1, in
dozens of bars of that movement — because under the ghost layer's reading beat 3
does not exist. His view is that 3/8 should behave like 3/4 rather than 6/8, with
the open question being what the rule for "compound" should be at all (perhaps:
disallow one-beat time signatures). Deferred to the post-Component-11 issues
triage by his decision, not resolved here.

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

**Decision (Francisco, 2026-07-27): Option 1.** Implemented with the
`confirmed`/`clamp` decoupling the analysis above anticipated, which is what lets
Option 1 be taken without its first stated cost.

#### As implemented ✅ done 2026-07-27

`StageAssignment` carries two flags where it carried one:

| Flag | Means | Read by |
|---|---|---|
| `confirmed` | The position is settled, not a default awaiting review. Set by a drag **and** by restoring a stored fragment. | limbo warnings, boundary pinning in `respondToMainResize` |
| `anchored` | The annotator placed this bracket in *this* session — dragged its split handle, or re-enabled it from absent. | the hard clamp (`computeResizeClamp`) |

`buildStageAssignmentsFromSubParts` sets `confirmed: true, anchored: false`, so a
restored fragment no longer clamps: the main bracket shrinks as freely as during
creation, and the outermost stages shrink with it (I7 — the frame's edges *are*
the new selection's endpoints).

**Pinning deliberately stays on `confirmed`.** Option 1 reads "treat restored
stages as unconfirmed *for the clamp*", and that qualifier is load-bearing. A
restored stage must not block a shrink, but while its slot survives the resize it
should stay exactly where its annotator put it — and the ghost layer is rebuilt
with a fresh selection object on every re-render, zoom, and progressive page load,
each of which fires the resize-response effect. Pinning on `anchored` would
redistribute a stored fragment's stage boundaries on a plain browser zoom. So:
untouched boundaries hold, boundaries the shrink actually crosses redistribute,
which is "redistribute like creation" where it matters.

This also disposes of Option 1's first listed cost — "optional stages read as
needing re-confirmation until touched" — which only followed from reusing
`confirmed` for the clamp. `confirmed` is untouched, so no restored stage reads as
in limbo. The second cost stands as accepted: a shrink that crosses a boundary
moves it.

Safety: with the clamp gone, a shrink can in principle leave a required stage
without a slot, which `computeStagesComplete` previously allowed through (the
clamp was the only thing preventing it). `frameToAssignments` now flags that
`error: true` — see Step 11.

Tests: 2 clamp cases pinning the new semantics (confirmed-not-anchored does not
clamp; anchoring one restored stage starts clamping), plus the existing clamp
suite re-keyed to `anchored`.

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
  one-time sweep to confirm harmony events so gated concepts have clean, confirmed
  harmony behind their public examples. Ride M2 with M1 since both are
  editorial-data passes over the same fragments.

  > **Correction (2026-07-27).** This bullet said the `harmony_gate`
  > `capture_extensions` entries "already exist on the cadence concepts
  > (`cadences.yaml`)". **They do not.** `cadences.yaml` carries four
  > `capture_extensions` — one `harmony_object` and two `fragment_pointer`s — and
  > no `harmony_gate`; no seed file in any domain contains one. The enforcement
  > code is all there and working (`check_concepts_have_harmony_gate`,
  > `_run_approval_gate`), it simply never fires, because nothing declares the
  > gate. So M2 is *seeding plus sweep*, exactly as its phase-2.md row always
  > said, and the seeding half is unwritten work. See § 13A.
- **K282/ii renumbering — the § 9G repair lands here** (split from Step 9,
  2026-07-25). The NMA text restarts the bar numbers at Menuet II; the DCML
  encoding runs them continuously, so our corpus disagrees with the edition.
  Restart them in corpus prep and section the movement like K331/ii. **Read § 9G
  before starting** — the MEI `@n` and the harmony `mn` must be renumbered in the
  same pass, or the sidebar prints numbers the score does not show; `mc` is
  untouched throughout, which is what makes it safe. It sits here because it is
  an editorial corpus-data repair like the rest of this step, and because § 9A
  may add more movements to the same batch.

**Definition-review pass (Step 2 consumer):** flipping `definition_reviewed` to
`true` for the launch set of concepts is the same kind of editorial content work
and rides alongside M1. Per § Decisions 3 the glossary **may launch with
placeholders** on any unreviewed tail — the review pass is not a code gate.

#### Sub-steps, ownership, and order (drafted 2026-07-27)

Most of this step is **editorial judgement, which is Francisco's and cannot be
delegated to a script**: confirming a harmony event asserts that an editor has
read it and agrees, so a script that flipped `reviewed` in bulk would be
manufacturing that assertion, not recording it. My share is the code and corpus
work that makes his passes possible, fast, and verifiable.

Two constraints set the order:

1. **The gate must be seeded *last*.** `_run_approval_gate` fires at approval
   time and demands every harmony event in the fragment's range be reviewed. Seed
   it before the sweep and every M1 edit becomes un-re-approvable mid-flight.
   Sweep first, seed after.
2. **The K282/ii renumbering needs a re-ingest**, so it must not land in the
   middle of an editorial pass over the same data. It goes first (before the
   editorial work starts) or last (after it finishes) — not between.

| # | Sub-step | Owner | Depends on |
|---|---|---|---|
| 13A | Decide the gate's scope: which concepts declare `harmony_gate` | **Francisco** (decision), me (writes the YAML) | — |
| 13B | K282/ii renumbering: prep + re-ingest + fragment migration (§ 9G) | Me; Francisco confirms the editorial call | — |
| 13C | M1 errata: the nine per-fragment corrections | **Francisco** | Step 12 (done) |
| 13D | M2 sweep: confirm harmony inside each fragment's range | **Francisco** | 13C (same fragments, one sitting) |
| 13E | `definition_reviewed` pass over the launch set | **Francisco** | — (not a code gate) |
| 13F | Seed `harmony_gate`, re-seed the graph, deploy | Me | 13A, 13D |
| 13G | Verification pass | Me | all |

**13A — gate scope. Decided (Francisco, 2026-07-27): `harmony_gate` goes on
`Cadence`.** Every subtype inherits it through `IS_SUBTYPE_OF`, which is how
`check_concepts_have_harmony_gate` already resolves the question — it walks
ancestors — so this is one entry in `cadences.yaml` covering the whole domain,
including the evaded/abandoned/dominant-arrival family. Written in 13F, not now:
seeding it before the sweep would block re-approval of every fragment M1 touches.

**13B — K282/ii (§ 9G; read that section first). Precondition re-checked against
staging 2026-07-27: the movement has no fragments and no sub-parts**, so no
coordinate migration is needed and § 9A's finding still holds. (A first count said
one parent fragment; that was an artefact of my own query — a `LEFT JOIN` with no
match yields one all-null row, and `parent_fragment_id IS NULL` is true of it.
`count(f.id) FILTER (...)` is the right shape.) The MEI `@n` renumbering and
the DCML harmony `mn` renumbering must land in the *same* prep + re-ingest, or the
sidebar prints bar numbers the score does not show. `mc` is untouched throughout,
which is what makes it safe — rendering, fragment ranges, previews, and the
mc-stability check are all unaffected. Then section the movement like K331/ii
(`seed_movement_sections.py`) so "Menuetto I / Menuetto II" qualify the labels.
Any stored fragment on that movement carries `bar_start`/`bar_end` in the old
numbering and needs a migration — § 9A found none, to be re-confirmed against
staging before starting rather than trusted.

**13C — M1 errata (issues doc § Editorial work).** Nine items on 279/i and 279/ii:
harmony corrections (V=64 then V7; a spurious IV6; an extra Final-Tonic), two
commentary typos, an evaded cadence with no text, and two wrong-stage fixes
(279/i m. 93, 279/ii m. 15) that were only editable once Step 12 freed the resize.
One item is already partly resolved: "279/ii m. 3 … summary is generic (C major +
4/4)" was the M6 key/meter bug, repaired corpus-wide by `fix_summary_key_meter.py`
— worth confirming on screen rather than re-fixing. Verify on a real render, per
the standing lesson that audits have blind spots.

**13D — M2 sweep.** Smaller than "confirm the corpus" sounds, for two reasons: the
gate only requires events **inside a fragment's range**, not every event in the
movement, and that range is now beat-precise (Step 10). Locally that is 107 events
across 18 fragments — roughly six per fragment — of which 4 are already reviewed;
staging should scale to a few hundred across its ~90 top-level fragments. The
harmony panel already has a **Confirm all (n)** control scoped to the open
fragment, so the pass is: open fragment → read → confirm all → next. Events are
movement-level, so overlapping fragments do not double the work. Riding this with
13C means each fragment is opened once, not twice.

**13F — seed and deploy.** Add the `harmony_gate` entries decided in 13A, re-seed,
redeploy, and confirm the gate now blocks an unreviewed fragment and passes a
reviewed one.

**13G — verification.** Glossary examples render with confirmed harmony; K282/ii
shows restarted numbers with section labels in both bracket and sidebar; the nine
errata are visibly corrected; `validate_movement_sections.py` and
`validate_graph.py` pass; the approval gate behaves as intended in both directions.

**Where the editorial work happens — settled (Francisco, 2026-07-27): directly on
staging.** The campaign fragments live there, so that is the system of record for
this data; nothing in the deploy flow copies it back to local.

*Already under way.* Between two runs of the sub-part repair on 2026-07-27 the
K279/ii fragments were re-saved through the editor, which rewrites parent and
children transactionally — so the three overflowing sub-parts the first dry-run
found there no longer exist, replaced by correctly bounded ones written by the
Step 11 frontend. Incidental confirmation that the fix works on real data through
the real editor, and a reminder that a dry-run's row list goes stale the moment
someone opens the editor.

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
5. **Index root selection (Step 4b) — group by domain; a root is a concept with
   no `IS_SUBTYPE_OF` parent that is not a `CONTAINS` target.** Decided
   2026-07-23 after staging verification returned seven "domains" for one domain.
   Filtering on `top_level_taggable` was rejected because `Cadence` itself is
   `top_level_taggable: false`. Stage concepts drop out of the index and stay
   reachable as `CONTAINS` relationships on their parent's page;
   `ClosingSection`/`StandingOnTheDominant` remain top-level entries *within* the
   Cadences domain — no invented parent, no taxonomy commitment. The rule is
   applied in the **shared** `get_domain_roots`, so the editor concept tree is
   fixed by the same change.

6. **Count-cache fix shape (Step 8 / M11) — cache graph structure, never
   fragment-derived data.** Decided 2026-07-25 at implementation time. The
   alternative was to keep counts in the cached payload and invalidate it on
   every fragment-lifecycle transition; rejected because it spreads knowledge of
   a graph cache across every fragment mutation path and leaves re-tagging (a
   join-table write, not a status change) easy to miss. Counts are read live
   instead — one grouped PostgreSQL query, on a surface that already queries
   Neo4j. Generalised into a cache-boundary rule in
   `tech-stack-and-database-reference.md` § 5.

7. **Duplicate-`@n` disambiguation (Step 9 / M12) — editorial section marking,
   with structural detection, split across three steps.** Decided 2026-07-25
   after investigation. Sections are named editorially ("Trio", "Menuet II")
   because a derived ordinal ("2nd pass") is musically mute and the affected
   movements are few and alike; automatic run detection rides along for
   *detection only*. Sections are persisted in a **`movement_section` table**,
   not JSONB on `movement` — the read path resolves a section for every fragment
   on a page of browse cards, which is one indexed join rather than a per-row
   JSON scan, and the rows are editorial content worth constraining. Volta
   endings are folded into the same display convention. K331/ii is the **Trio
   restarting the count** — the ADR-015 amendment's account of it is wrong and is
   corrected as part of the step. Two findings are split off to where their code
   already lives: the harmony coordinate bug (events keyed on `(mn, volta, beat)`,
   ambiguous on a restarting movement) → **Step 10** with M6; the K282/ii source
   erratum → **Step 13** with M1/M2. All three still gate switch-on. Full plan in
   § Step 9; the split table is § Step 9 "The split".

Also stated as shipped rather than open: **stubs are not listed in the concept
index** (§ Step 4), only reachable as marked links from a concept page.

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
- **Two defects the § 9A survey surfaced**, both documented and deferred
  2026-07-25 as new Track M rows because neither is public-facing and neither
  blocks the glossary: **M15** — the normalizer's advisories are not persisted
  (`movement.normalization_warnings` is `null` for 52 of 54 movements), so § 9B
  ships its detection as a validation script rather than depending on that
  column; **M16** — `bar_start`/`bar_end` are `INTEGER` and cannot represent an
  X-prefixed `@n`, so a selection beginning on a split-measure complement has no
  faithful human coordinate. No such fragment exists today.
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
- **A taxonomic parent for `ClosingSection` / `StandingOnTheDominant`.** Step 4b
  makes them presentable as top-level entries in the Cadences domain *without*
  deciding whether they should hang off a parent. The candidate is an abstract
  `PostCadentialFunction` (both are `IS_SUBTYPE_OF` it), which would make one
  mechanism — `IS_SUBTYPE_OF` — explain the whole index and is defensible in
  Caplin's terms. It is deferred because the likelier home is the
  **formal-function domain**: both carry `type: FormalUnit`, both are
  post-cadential *functions*, and that domain is currently ten stubs.
  **Trigger for the revisit: designing the Formal Function domain.** Until then
  they stay parentless, which the domain grouping renders honestly.

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
  Step 4  public concept index                  │
  Step 4b index roots: domain grouping +        │ ← also fixes the shared
          CONTAINS filter (shared query)        ┘   editor concept tree
        │
        ▼
Part 2  Glossary frontend                       ← needs Part 1 endpoints
  Step 5  concept page                           ┐ independent of 4b —
  Step 6  inline example fragments               ┘ can proceed in parallel
          (preview → Verovio/MIDI expand)
  Step 7  concept index / browse-by-domain  ←──── MUST follow Step 4b
          + e2e journey                          (consumes its shape)

Part 3  Public-surface fixes                    ┐ parallel with Parts 1–2;
  Step 8  M11 count-cache staleness  ✅ 24afc3f │ all green before switch-on
  Step 9  M12 duplicate-@n disambiguation       │
          (§ 9A survey → 9B detection →         │
           9C movement_section → 9D read        │
           models → 9E display convention)      │
  Step 10 M6 info-sidebar fixes                 │
          + § 9F harmony mc-coordinate  ────────┼── touch the harmony slice
  Step 11 M7 stage-bracket overflow  ───────────┼── ONCE (M6 precision + 9F
        │                                        │   coordinate); bracket-bounds
Part 4  Editor follow-through + editorial sweep  │   code ONCE with Step 12
  Step 12 deferred resize decision + fix  ───────┘   (decision made here)
  Step 13 M1 errata sweep + M2 harmony_gate      ← needs the whole editor (12)
          + § 9G K282/ii renumbering
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
- **`knowledge-graph-design-reference.md`** — record the § Step 4b index-root
  rule ("a browsable root has no `IS_SUBTYPE_OF` parent and is not a `CONTAINS`
  target; browse groups by `domain`, not by taxonomic orphanhood"). It is a
  modelling rule, not a glossary detail: it governs the editor concept tree too,
  and it is the reason a stage concept never appears as a root.
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
