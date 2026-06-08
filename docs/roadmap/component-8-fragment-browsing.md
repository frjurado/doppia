# Phase 1 — Component 8: Fragment Browsing — Implementation Plan

This document translates Component 8 of `docs/roadmap/phase-1.md` into a concrete, sequenced set of implementation tasks. It follows the model of the Component 7 plan (`docs/roadmap/component-7-fragment-database.md`): it does not restate settled design, it sequences implementation and pins the integration boundaries the design docs leave open, and where it reaches a decision those docs do not record it flags it rather than baking it in silently.

Component 8 is the *concept-scoped* read surface. Component 7 answered "what is tagged on the score I am looking at" — its reads are movement-scoped, and they project stored fragments onto the live ghost index of an already-open score. Component 8 answers the orthogonal question, "show me all PACs in the corpus": it browses the fragment database by concept tag across movements, lists the matching fragments with lightweight rendered previews, and opens any single fragment in isolation with its own Verovio render and MIDI. Where Component 7 read a fragment *in the context of its movement*, Component 8 reads a fragment *out of context*, on its own.

It is also the first consumer of two pieces of design that have so far only existed on paper. Server-side fragment-preview generation (ADR-008) was deferred out of Component 5 and Component 7 with a note "Component 8"; the list view is the feature that needs it, so the Celery preview task is built here. And the per-fragment `data_licence` derivation (ADR-009) — the CC BY-SA 4.0 ShareAlike obligation that attaches to DCML-sourced harmony — first becomes visible to a user in the browse list and detail view, so the licence serialiser is wired into the read path here even though the *public* (unauthenticated) API that strictly requires it is a Phase 2 surface.

**No carry-ins this time.** Component 7 folded the post-Component-5 tagging-tool fixes into its Part 1 because deferring them would have let annotators build muscle memory against wrong stage geometry. There is no equivalent forcing function here: the minor issues surfaced since Component 7 shipped are not yet documented well enough to scope, and browsing is a read surface that writes no data, so a deferred polish item costs nothing downstream. Those issues wait until they are written up properly (the per-issue reports under `docs/reports/` remain the canonical backlog); this plan stays entirely on the Component 8 scope.

Component 6 (the music21 preprocessing pipeline) is still deferred. Its absence touches Component 8 in exactly one place: a fragment detail view that displays harmony shows `bass_pitch`/`soprano_pitch` as "not computed" for DCML-sourced events, identically to the Component 7 harmony panel. Previews and the list view are unaffected — they render notation and metadata, not derived pitch fields.

Component 8 has five parts:

1. **Concept-tag browsing backend** — the downward `IS_SUBTYPE_OF` subtree traversal, the concept-scoped fragment list endpoint with its Redis subtree cache, the service-layer status filter, and the `data_licence` serialiser (ADR-009).
2. **Fragment preview generation** — the ADR-008 server-side static SVG previews: the Celery task at submission time, the regeneration triggers, and reconciliation of the preview storage key.
3. **Hierarchical tag browser and fragment list view** — the concept-tree navigator (Cadence → Authentic Cadence → PAC) and the preview-card list it drives.
4. **Individual fragment detail view** — the isolated Verovio render + MIDI constrained to the fragment's range, the full record display, and the rendering-context API contract (the `context_bars` forward-compat note, reconsidered).
5. **Tests, CI, and docs.**

The ordering across parts: the browsing backend (Part 1) and preview generation (Part 2) land first because the frontend (Parts 3–4) consumes both and should never be blocked on a mock; Part 2 can proceed in parallel with Part 1 since the preview task is independent of the browse query. The tag browser (Part 3) precedes the detail view (Part 4) only loosely — they share no critical path and can be built in parallel once Parts 1–2 settle, but the list view is the more load-bearing surface and is sequenced first. Tests and docs (Part 5) trail the feature work.

All code, migration, and seed work below is executed in **Claude Code**; this Cowork project edits docs only. This document, and the architecture-doc/ADR/phase-1 edits it calls for, are the only artefacts edited here. Where a draft of a code-adjacent artefact is useful before handoff (an API contract sketch, a fixture list), it can land under `docs/seed-drafts/` and be copied into the tree via Claude Code.

---

## Prerequisites

Component 8 assumes the Component 7 hard gates have passed (per `docs/roadmap/component-7-fragment-database.md` § "Hard Gates Before Component 8 Begins"):

- The Part 1 stage fixes are verified against fixtures: pre-population auto-drops to the finest fitting grid; a main resize redistributes default stages, preserves active ones, and hard-clamps before force-disappearing any active stage; stage brackets honour beat/sub-beat extents without rounding or bounce-back; the "Stages complete" checklist row appears only when the concept has stages.
- The CRUD backend is complete and tested: read (single + movement list with role-scoped status visibility), update with the confirmed revision semantics, and delete with the permission matrix and cascade-confirm guard. No route handler touches a database directly; the status filter holds at the service layer.
- Stored fragments display on the score (brackets, alias labels, collapsed/expanded sub-parts, the click-to-open side panel) and the review loop is exercisable end to end in the UI.
- `pytest -m integration` (Component 7 surfaces) and `npm test` (stage geometry + overlay projection) pass in CI.

It additionally assumes the following docs are settled and authoritative; they are the *inputs* to this plan and it does not duplicate them:

- `docs/architecture/fragment-schema.md` — the `fragment`, `fragment_concept_tag`, `fragment_review`, and `movement_analysis` definitions; the `summary` JSONB v1 schema; the status state machine; the status-filter-at-service-layer rule; the harmony slice read path; the per-fragment `data_licence` derivation from in-range event `source` values.
- `docs/architecture/knowledge-graph-design-reference.md` — the three-layer graph, the `IS_SUBTYPE_OF*0..` traversal pattern, the hierarchy-path subquery, and the concept-search/`get_concepts_by_ids` helpers Component 8's subtree query joins onto.
- `docs/adr/ADR-008-fragment-preview-generation.md` — server-side static SVG previews generated by a Celery task at `submitted` transition, stored in R2, served as a URL; the `preview_url: null` transient fallback; the regeneration-on-revision and regeneration-on-MEI-correction obligations.
- `docs/adr/ADR-009-dcml-licensing-constraint.md` — the per-fragment effective `data_licence` derived from in-range event `source` values; the `harmony_sources` transparency field; the ABC-corpus public-API exclusion; that this is a *public read path* obligation (Phase 2) being scaffolded into the read serialiser now.
- `docs/adr/ADR-002-file-storage.md` — the slug-based S3 object-key convention the preview key follows.
- `docs/adr/ADR-003-score-display-mode.md` and `docs/roadmap/component-3-score-viewer.md` — the Verovio rendering architecture, the overlay rule, the `onPositionUpdate(bar, beat)` playback abstraction, and the **`select`-option spike** (Component 3 § Fragment Rendering): Verovio's measure-range `select` behaviour with repeats, first/second endings, and mid-system starts. Component 8's detail view (Part 4) depends on that spike's results; if it has not been run and documented in `docs/architecture/mei-ingest-normalization.md`, running it is the first task of Step 11.
- `docs/architecture/corpus-and-analysis-sources.md` — the source priority and the corpora in scope (which DCML corpora are CC BY-SA 4.0, which is the excluded ABC corpus).

### Decisions taken into this plan

Several scoping decisions are baked in. The first four are sensible defaults consistent with the design docs; the fifth — the rendering-context contract — is the substantive one, confirmed with Francisco and recorded as ADR-024 (it amends a forward-compatibility note already written into `phase-1.md`). All are now settled; see "Decisions Confirmed" below.

- **Browsing is annotator-facing in Phase 1; the public read path stays Phase 2.** Every Component 8 read endpoint is `require_role("editor")`, exactly as Component 7's reads were. The concept-tag browse defaults to `status=approved` (the canonical "browse the finished corpus" case) but accepts a status filter so an editor can browse their own in-progress work; the filter is applied at the service layer and is not bypassable by a direct API call. The ADR-009 `data_licence` serialiser is built and exercised here so it is ready when the unauthenticated public endpoint is switched on in Phase 2 — but no unauthenticated endpoint ships in Component 8.
- **The concept-scoped list reuses the Component 7 list machinery.** Component 7 Step 13 deliberately wrote the review-queue list query as a reusable service function "so Component 8 calls the same shape with a concept filter instead of a status filter." Component 8 honours that: `list_by_concept` shares the cursor-pagination, role-scoped status visibility, and list-item projection of `list_for_movement`/`list_for_review` rather than forking a parallel implementation.
- **Subtree results are cached in Redis.** `phase-1.md` § Component 8 calls for caching the `IS_SUBTYPE_OF` subtree expansion in Redis (available from day one as the Celery broker). The cache is keyed by `(concept_id, include_subtypes)`, holds the resolved id set, and is invalidated on seed (a graph re-seed can change the subtree); a stale cache after a seed is the one correctness hazard and the seed script (or a cache-version stamp tied to the seed run) clears it.
- **Previews are SVG, generated at `submitted`, server-side (ADR-008 as written).** No re-litigation of the client-vs-server question; ADR-008 settled it. Component 8 implements the accepted decision and reconciles the storage-key discrepancy noted in "Current code state."
- **Rendering context for the detail view is a structured contract, not a bare `context_bars` integer (default behaviour unchanged).** The detail view still defaults to "containing measures only" — Phase 1 renders no surrounding context. But rather than freezing the API at a single symmetric `context_bars` int (which cannot express asymmetric or fragment-relative context without a breaking change), the contract is designed now as a small discriminated `context` object that future modes extend additively. The Phase 1 implementation accepts the parameter and honours only the default; non-default modes are validated-and-ignored until their consuming feature is built. This is the same "design the contract now, implement it later" intent as the original note — corrected for the asymmetry and the richer context semantics. Confirmed and recorded as ADR-024; see Step 12 and "Decisions Confirmed."

The Phase-1 deferrals from the design hold: `free` containment mode and deeper sub-part nesting remain deferred (ADR-011 §3, the two-level display limit); the display filter UI (`show`/`category_filter`) remains Phase 2 though the overlay was built filter-ready in Component 7.

### Current code state (verified)

Read from the tree at the time of writing, so Part boundaries land on real seams rather than assumed ones:

- `backend/api/routes/fragments.py` (prefix `/fragments`) mounts `GET /{id}`, `POST`, `PATCH /{id}`, `DELETE /{id}`, and the `submit`/`approve`/`reject` actions. There is **no** concept-scoped list endpoint (`GET /api/v1/fragments?concept_id=...`) — that is this component. The single-fragment `GET` is the read the detail view extends.
- `backend/services/fragments.py` defines `get`, `list_for_movement`, `list_for_review`, `create_draft`, `update_draft`, `update`, `submit`, `approve`, `reject`, `delete`, plus the cursor helpers (`_encode_cursor`/`_encode_time_cursor`), the harmony slice (`_slice_harmony_events`), and the licence derivation (`_derive_data_licence`). There is **no** `list_by_concept` yet. `_derive_data_licence` already exists (it was needed for the create/read path) — Part 1 surfaces its output through the list and detail serialisers rather than re-implementing it.
- `backend/graph/queries/concepts.py` has the *upward* `IS_SUBTYPE_OF*0..` ancestor walks (inherited schemas, hierarchy path), `search_concepts`, `get_concepts_by_ids`, and `get_type_refinement_children` (direct children, one hop, line ~204). There is **no** *downward* subtree expansion (all transitive subtypes of a concept) — Part 1 adds `get_subtype_ids`.
- `backend/services/tasks/` contains `generate_incipit.py` (the per-movement incipit, Component 2) and `ingest_analysis.py`. There is **no** fragment-preview task. `backend/services/object_storage.py` documents a preview key as `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/preview.svg` — a *movement-level* key — which does **not** match ADR-008's per-fragment key `.../fragments/{fragment_id}.svg`. Part 2 builds the task and reconciles the key (ADR-008 is authoritative; the per-fragment key wins).
- `backend/services/submit` does not currently enqueue any preview task — preview-on-submit is wired in Part 2.
- `backend/api/routes/browse.py` serves the corpus hierarchy (composers/corpora/works/movements/mei, Component 2); `backend/api/routes/reviews.py` serves the review queue (Component 7). Concept-tag browse is new; it mounts on the `fragments` router (the `?concept_id=` list) plus a small concept-tree read for the navigator.
- `frontend/src/services/` has `browseApi.ts` (corpus browse), `fragmentApi.ts`, `scoreApi.ts` (only `fetchMeiUrl`/`ScoreTitle` today), `conceptApi.ts`, `analysisApi.ts`. The concept-browse calls and the fragment-detail render calls are new.
- `frontend/src/routes/` has `CorpusBrowser.tsx`, `ReviewQueue.tsx`, `ScoreViewer.tsx`, `Login.tsx`. There is **no** fragment-browser route or fragment-detail route — Parts 3 and 4 add them. `frontend/src/components/score/FragmentDetailPanel.tsx` (the Component 7 side-panel record view) is reused for the detail view's record display rather than duplicated.

---

## Part 1 — Concept-Tag Browsing Backend

The concept-scoped read the list view and tag browser call. Build it first so the frontend is never blocked on a mock. All routes are `/api/v1/`-prefixed; all role enforcement is `require_role()`; no route handler touches a database directly (the fragment service owns the cross-database join); the schema is fixed — these steps add no columns and no tables.

---

### Step 1 — Downward subtype subtree traversal (`get_subtype_ids`)

**Powers `include_subtypes=true` browsing (Step 2).**

`backend/graph/queries/concepts.py` has only upward and single-hop-downward walks. Add a named Cypher helper that, given a concept id, returns the set of all concept ids in its `IS_SUBTYPE_OF` subtree *downward* (the concept itself plus every transitive subtype), so a browse on "Authentic Cadence" returns PAC, IAC, and any further refinements:

```cypher
MATCH (descendant:Concept)-[:IS_SUBTYPE_OF*0..]->(root:Concept {id: $concept_id})
RETURN collect(DISTINCT descendant.id) AS ids
```

The traversal includes the root (`*0..`) so `include_subtypes=false` is just the singleton `{concept_id}` and the two modes share one code path. Stub concepts are excluded by `WHERE NOT descendant.stub` if a stub should never be a browse target (confirm against the domain map — a stub has no fragments tagged against it in Phase 1, so it is harmless either way, but excluding keeps the id set tight). Use the relationship-type constant from `backend/graph/queries/relationships.py`; no magic strings.

**Verification.** Unit test against a seeded test graph: `get_subtype_ids("AuthenticCadence")` returns `{AuthenticCadence, PerfectAuthenticCadence, ImperfectAuthenticCadence}` (and any seeded refinements); `get_subtype_ids("PerfectAuthenticCadence")` returns the singleton; a leaf with no subtypes returns itself only.

---

### Step 2 — Concept-scoped fragment list endpoint with Redis subtree cache

**The browse query behind the list view (Step 8).**

`GET /api/v1/fragments?concept_id={id}&include_subtypes={bool}&status={status}`, `require_role("editor")`, cursor-paginated per the API conventions. The two-step cross-database join is the canonical pattern from `fragment-schema.md`: (1) resolve the concept id set via `get_subtype_ids` (Step 1), (2) query PostgreSQL for fragments whose `fragment_concept_tag.concept_id` is in that set. The match is on **any** of a fragment's tags, not only its primary (`is_primary`) one (confirmed): a fragment cross-referenced to a concept surfaces when browsing that concept as well as when browsing its driving concept, which is the intended discovery behaviour. `DISTINCT` the fragment rows so a fragment with multiple in-set tags appears once. The join is owned by the service layer; the route handler calls the service.

- **Status filter at the service layer.** Default `status=approved`. An editor may pass `status=submitted`/`draft`/etc. but the visibility rules from Component 7 still hold in the service (an editor sees their own drafts plus all submitted/approved/rejected; the filter is never UI-only). The `approved`-only public reader is Phase 2.
- **Redis subtree cache.** Cache the `get_subtype_ids` result keyed by `(concept_id, include_subtypes)`. Reuse the Celery Redis connection (`backend/services/celery_app.py` config) or a thin cache client; invalidate on seed via a cache-version stamp bumped by `scripts/seed.py` (a re-seed can change the subtree, and a stale id set would silently mis-scope a browse). The PostgreSQL fragment query is not cached — only the Neo4j subtree expansion.
- **List-item projection.** Each row returns what the card needs: `fragment_id`, primary `concept_id` + `alias` (+ `name` fallback), `bar_start`/`bar_end` (human coordinates), the movement label (composer / work / movement, joined from the corpus tables), `status`, `preview_url` (Step 5; `null` until generated), the effective `data_licence` and `harmony_sources` (Step 3), and `created_by`/`updated_at`. Reuse the Component 7 list-item shape; extend it with the licence fields rather than forking it.

Add `FragmentService.list_by_concept()` (sharing the cursor/visibility/projection machinery of `list_for_review`/`list_for_movement`), the Pydantic response model, the route, and the `fragmentApi.ts` call. Write the query as a reusable service function — Phase 3's AI retrieval issues the same shape (`phase-1.md` § Forward-Compatibility, "Fragment browsing as the precursor to AI retrieval").

**Verification.** Integration tests against test Postgres + Neo4j: a browse on a parent concept with `include_subtypes=true` returns fragments tagged with any subtype; `include_subtypes=false` returns only exact-concept matches; cursor pagination is stable; `status=approved` is the default and an editor cannot retrieve another annotator's draft via a spoofed `status`; the subtree cache hits on the second call and is cleared after a re-seed.

---

### Step 3 — `data_licence` derivation in the read serialiser (ADR-009)

**The licence surface for the list and detail views.**

`_derive_data_licence` already exists in the service; Step 3 ensures its output is present and correct on both the list rows (Step 2) and the single-fragment read (Step 11), and that the companion fields ship:

- `data_licence` — the effective per-fragment licence, derived from the `source` values of the `movement_analysis` events in the fragment's bar/beat range (any DCML-sourced event ⇒ `CC BY-SA 4.0`; otherwise the mix's appropriate licence per the ADR-009 mapping table).
- `data_licence_url` — the canonical licence URL.
- `harmony_sources` — the set of in-range event `source` values, for transparency and Phase-2 filtering, distinct from the derived `data_licence`.

This is read-path only — no write, no schema change (`fragment-schema.md` and ADR-009 are explicit that the per-event `source` is already populated and the licence is derived at query time). The ABC-corpus exclusion (ADR-009 §2) is **not** enforced here because Component 8 ships no unauthenticated endpoint; record it as the Phase-2 launch blocker it already is, and ensure the derivation logic is the single place that will gate it later.

**Verification.** Unit tests on the serialiser: a fragment whose range covers a DCML event resolves `CC BY-SA 4.0` with the correct URL; a fragment over only `manual`/`music21_auto` events resolves the unrestricted licence; `harmony_sources` lists the exact set of in-range sources; the fields appear identically on a list row and on the single-fragment read.

---

## Part 2 — Fragment Preview Generation

The ADR-008 server-side static SVG previews the list view needs. Independent of Part 1's browse query, so it proceeds in parallel. Built in Claude Code; the ADR is authoritative and unchanged — this part implements it and reconciles one storage-key discrepancy.

---

### Step 4 — Reconcile the preview storage key

**Issue.** `object_storage.py` documents a *movement-level* preview key (`.../{movement_slug}/preview.svg`), while ADR-008 specifies a *per-fragment* key (`.../{movement_slug}/fragments/{fragment_id}.svg`). One fragment per movement would collide on the movement-level key, and ADR-008 explicitly distinguishes the per-fragment preview from the per-movement incipit (`.../incipit.svg`).

**Change.** Adopt the ADR-008 per-fragment key as authoritative. Update the key-builder in `object_storage.py` (and any reference to the old movement-level `preview.svg`) to `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/fragments/{fragment_id}.svg`. Confirm the incipit key (`.../incipit.svg`, Component 2) is untouched and remains distinct. This is a key-format fix, not a schema change.

**Verification.** Unit test on the key builder: two fragments on the same movement produce distinct preview keys; the incipit key is unchanged; the key matches the ADR-008 pattern exactly.

---

### Step 5 — Fragment-preview Celery task

**The preview producer.**

Add `backend/services/tasks/render_fragment_preview.py`: a Celery task that, given a `fragment_id`, fetches the movement MEI, renders the fragment's `bar_start`/`bar_end` range to SVG via the Verovio Python bindings (the same bindings as `generate_incipit.py`, using Verovio's measure-range `select` option), and writes the SVG to R2 under the Step 4 key. Pin the server-side Verovio version to the client version (ADR-008 negative consequence) and record it where the incipit task records its version, so a version drift is detectable.

- **Output:** SVG (ADR-008), for scalability and small size at 2–8 bar lengths.
- **Range selection:** the same Verovio `select` measure-range used client-side; the repeat/ending/pickup edge cases from the Component 3 spike apply equally (ADR-008 neutral consequence) — reuse the spike's documented workarounds.
- **`draft` fragments get no preview** (ADR-008 neutral): the task runs only for `submitted` and above.

**Verification.** Integration test (Verovio bindings available): the task renders a known fragment to SVG, writes it under the correct key, and the SVG contains the expected measure count; a re-run overwrites in place.

---

### Step 6 — Preview generation and regeneration triggers

**Wiring the task to the lifecycle.**

- **On `submitted`.** `FragmentService.submit()` enqueues the Step 5 task on the `draft → submitted` transition. Resubmission after a revision (`rejected → … → submitted`, or an edit that re-opens review) re-enqueues and overwrites the previous SVG (ADR-008 trigger).
- **On bar-range revision.** An edit (Component 7 Step 8 `update`) that changes `bar_start`/`bar_end`/`beat_start`/`beat_end` on a `submitted`/`approved` fragment invalidates the preview; enqueue regeneration. (An edit that re-opens review already passes through the submit-equivalent path; ensure a content edit that changes the range but stays `submitted` also re-enqueues.)
- **On MEI correction.** The Component 1 correction workflow must enqueue preview regeneration for every fragment on the corrected movement (ADR-008 negative consequence). Component 8 owns the fragment-side regeneration entry point; flag in the handoff that the correction workflow must call it (a root/Component-1 concern, not edited here).
- **`preview_url: null` fallback.** The list endpoint returns `null` when the SVG is not yet present (task still queued); the frontend (Step 8) renders a placeholder. This is transient and only affects an annotator's own just-submitted fragments.

**Verification.** Integration: submitting a fragment enqueues the task and the list row's `preview_url` becomes non-null once it completes; a bar-range edit re-enqueues and the SVG is regenerated; a list request before generation returns `preview_url: null`.

---

## Part 3 — Hierarchical Tag Browser and Fragment List View

The frontend that turns the Part 1 endpoints into a browsing experience: navigate the concept hierarchy, then see the fragments tagged at the selected node.

---

### Step 7 — Concept-tree navigator

A navigable tree of the concept hierarchy (Cadence → Authentic Cadence → PAC, …) driven by the `IS_SUBTYPE_OF` structure. Selecting a node browses the fragments tagged with it (Step 8), with an `include_subtypes` toggle so a parent node can show the whole subtree or only exact matches.

- **Backend:** a small concept-tree read — either extend the concept read surface with `GET /api/v1/concepts/tree?root={id}` returning the subtype tree (ids, names, aliases, hierarchy paths, child counts), or build the tree client-side from the existing `search_concepts`/hierarchy-path helpers. Prefer a dedicated tree read so the navigator does not over-fetch; reuse the hierarchy-path subquery already in `concepts.py`. Cache the tree in Redis alongside the Step 2 subtree cache (same invalidation).
- **Frontend:** a `conceptApi.ts` call for the tree and a tree component in a new `FragmentBrowser.tsx` route, reachable from the top bar. Per `DESIGN.md` (Henle Blue / Urtext Cream, Newsreader/Public Sans, 0px radius, tonal layering, no 1px dividers). Show each node's fragment count where cheap to compute.

**Verification.** The tree renders the cadence hierarchy with correct nesting and aliases; selecting a node browses its fragments; the `include_subtypes` toggle changes the result set; the tree read is cached and invalidates on re-seed.

---

### Step 8 — Fragment list view with preview cards

The list that renders the Step 2 result set as preview cards.

- Each card shows the Step 5 **preview SVG** (served from its URL, not rendered client-side — ADR-008), the concept alias/name, the movement label (composer / work / movement), the bar range, and the status. On `preview_url: null`, render a placeholder (Step 6 fallback), not a blank.
- The `data_licence` (Step 3) is shown unobtrusively per card or in a detail affordance (DESIGN.md tonal layering — present but quiet), so the ShareAlike provenance is visible without dominating.
- Cursor pagination per the API conventions; status styling consistent with the Component 7 on-score brackets so `draft`/`submitted`/`approved`/`rejected` read the same way across surfaces.
- Selecting a card opens the fragment detail view (Step 11/12).

This is the surface ADR-008 was built for: a page of N previews costs N image fetches, not N Verovio renders.

**Verification.** A concept with several approved fragments renders a card grid with previews at the correct bars; a just-submitted fragment shows the placeholder until its preview lands; pagination advances by cursor; selecting a card opens the detail view; licence provenance is legible but quiet.

---

## Part 4 — Individual Fragment Detail View

The isolated single-fragment surface: the same Verovio + MIDI infrastructure as the score viewer, constrained to one fragment's bars, with the full record and the rendering-context contract.

---

### Step 9 — Detail-view read

The single-fragment read for the detail view extends the existing `GET /api/v1/fragments/{id}` (Component 7) rather than adding an endpoint: it already returns the hydrated concept tags, the `summary`, the harmony events sliced over the range, the prose annotation, the sub-parts, and (Step 3) `data_licence`/`harmony_sources`. Confirm it returns everything the isolated view needs — in particular the movement label and the MEI object key (resolved to a signed URL at request time, never stored) so the client can fetch the MEI to render the range. If a field is missing, add it to the existing read's response model; do not fork a second read.

**Verification.** `GET /fragments/{id}` returns the full record plus the movement/MEI handle the isolated render needs; the harmony slice and `data_licence` match what the list row reported.

---

### Step 10 — Verovio `select` spike confirmation (if not already done)

The detail view renders only the fragment's measures via Verovio's `select` option. Component 3 § Fragment Rendering flagged this as a spike that **must** be verified before fragment rendering is relied upon — `select` behaviour with repeats, first/second endings, and mid-system starts is under-documented and has regressed across Verovio versions. If the spike has been run and its results live in `docs/architecture/mei-ingest-normalization.md`, reuse them. If not, run it against the Mozart corpus first and document the results and workarounds there (a doc edited here in Cowork once Claude Code produces the findings). The preview task (Step 5) and the detail view (Step 11) both depend on the same `select` behaviour, so a single spike serves both.

**Verification.** The documented spike covers a fragment that starts mid-system, one inside a repeat, and one spanning a first/second ending; the workarounds are reflected in both the preview task and the detail render.

---

### Step 11 — Isolated render and MIDI

A new `FragmentDetail.tsx` route renders one fragment on its own:

- **Notation:** Verovio render constrained to `bar_start`/`bar_end` via `select` (Step 10), reusing `verovio.ts`/`scoreApi.ts` — not a parallel renderer. Sub-parts, if any, render as nested brackets within the fragment per the two-level display limit (ADR-011), reusing the Component 7 stored-bracket overlay components (`StoredBrackets`/`FragmentOverlay`) against the isolated render.
- **MIDI:** playback over the fragment's range using the Component 3 `@tonejs/midi` + Tone.js path and the `onPositionUpdate(bar, beat)` abstraction — the single interface to the renderer (ADR-012, Component 3). No new playback code; the same callback drives highlight on the isolated render.
- **Overlay rule:** all brackets are absolutely-positioned HTML over the SVG, re-derived on re-render; never edit Verovio's SVG.

**Verification.** A fragment opens in isolation with only its measures rendered; MIDI plays the fragment and the playback highlight tracks via `onPositionUpdate`; sub-part brackets render nested within bounds; zoom/re-render keeps overlays aligned.

---

### Step 12 — Fragment record display and the rendering-context contract

- **Record display.** Below/beside the render, show the full record — concept name and hierarchy path, property values (read-only via the existing `PropertyForm` display configuration), the `summary` (notated key/meter, `actual_key` with review state), the harmony events over the range (with `bass_pitch`/`soprano_pitch` as "not computed" for DCML events — the Component 6 deferral), the prose annotation, the status, and the `data_licence`/`harmony_sources`. Reuse `FragmentDetailPanel.tsx` (the Component 7 side-panel record view) in a standalone configuration rather than building a second record renderer — the difference between the on-score side panel and the isolated detail page is layout, not the record component.
- **Rendering-context API contract.** `phase-1.md` § Component 8 specifies an optional `context_bars` integer (default 0) so a future feature can render additional surrounding bars without a data-model change. The intent is right; the *shape* is too narrow — a single symmetric int cannot express the contexts that are actually wanted (more bars *before* than *after*; the enclosing container fragment; the stretch since the previous same-domain fragment). Replace the bare int with a structured, default-preserving `context` parameter on the detail read:

  ```
  GET /api/v1/fragments/{id}?context.mode=none            (default — containing measures only)
                            ?context.mode=bars&before=N&after=M
                            ?context.mode=enclosing_fragment   (render the parent container fragment)
                            ?context.mode=previous_same_domain (from after the prior same-domain fragment)
  ```

  Phase 1 **implements only `mode=none`** (the current behaviour). The other modes are accepted, validated, and otherwise ignored — the contract is published now so the consuming features (blog embeds, MCQ exercises, "show the theme this cadence closes") add a mode value, not a breaking parameter change. The data the richer modes need already exists or is cheap: `enclosing_fragment` reads `parent_fragment_id` (already on the table); `previous_same_domain` needs the concept's domain (derivable from the graph) plus the ordering of same-domain fragments on the movement by `mc_start` (already stored). No schema change is required to *design* the contract; only the eventual implementations touch the read path.

  **Confirmed (ADR-024).** Francisco accepted the structured contract over the `context_bars` int; it is recorded in `docs/adr/ADR-024-fragment-rendering-context.md` and the `phase-1.md` § Component 8 note is updated to match. Phase 1 implements `mode=none`; the other modes are accepted, validated, and ignored.

**Verification.** The record renders read-only and complete, with null pitches shown as "not computed"; the detail read accepts the `context` parameter, returns containing-measures-only for `mode=none`, and validates-but-ignores the other modes (a non-default mode does not error and does not change the render); the record component is shared with the Component 7 side panel.

---

## Part 5 — Tests, CI, and Docs

Turns Component 8 from "works on my machine" to "protected against regression."

---

### Step 13 — Backend tests

Beyond the per-step tests above: the downward subtree traversal (`get_subtype_ids` across a multi-level hierarchy and a leaf); the concept-scoped list (subtype inclusion/exclusion, cursor pagination, role-scoped status visibility not bypassable, the Redis cache hit and its post-seed invalidation); the `data_licence` serialiser (DCML vs unrestricted mixes, `harmony_sources` set, identical output on list and detail); the preview task (key format, SVG render, overwrite-on-rerun) and its triggers (submit, range-edit, the MEI-correction entry point); and the detail read's `context` parameter (default render, non-default modes accepted-and-ignored). Unit-level where possible (no Docker); integration-marked where a real Neo4j/Postgres/Verovio is required, per the Component 4/5 marker convention.

**Verification.** `pytest backend/tests/unit/` green; `pytest -m integration` green against the service containers; coverage on the new service methods, the graph query, the preview task, and the routes meets the project bar.

---

### Step 14 — Frontend tests

Vitest coverage for the browse and detail surfaces: the concept-tree navigator (nesting, `include_subtypes` toggle drives the result set); the list view (preview cards, `preview_url: null` placeholder, status styling, cursor pagination, licence display); and the detail view (isolated render constrained to range, sub-part nesting within the two-level limit, MIDI highlight via `onPositionUpdate`, the record component shared with the Component 7 panel, the `context` parameter defaulting to containing-measures-only). The detail render and the preview both depend on the Verovio `select` behaviour — assert against the spike fixtures (mid-system start, repeat, first/second ending).

**Verification.** `npm test` green; the `select`-range and list-rendering fixtures specifically assert correct measure selection and preview/placeholder behaviour.

---

### Step 15 — CI integration and doc updates

Wire the new suites into CI alongside the Component 4/5/7 jobs. Update the docs whose area this component touches, per CLAUDE.md's Definition of Done (these are docs, edited here in Cowork):

- **`docs/adr/ADR-024-fragment-rendering-context.md`** (done) — the structured `context.mode` contract replacing the `context_bars` int (Step 12). Added to the `phase-1.md` Decisions Log table.
- `docs/roadmap/phase-1.md` § Component 8 (done) — the `context_bars` forward-compat note is replaced with the structured `context` contract referencing ADR-024; the tag-browsing section records that a fragment surfaces under any of its tags (not only `is_primary`). Still to add when the work lands: a short note that browsing ships annotator-facing (editor-role) in Phase 1 with the public `approved`-only path deferred to Phase 2, and that the `data_licence` serialiser is built here ahead of that public path.
- `docs/architecture/fragment-schema.md` — confirm the status-filter-at-service-layer wording covers the new concept-scoped list/browse endpoints; note the concept-scoped browse query as the reusable shape Phase 3 retrieval reuses (cross-reference the forward-compat note) and that the browse matches **any** tag (not only `is_primary`), `DISTINCT`-ing fragments.
- `docs/adr/ADR-008-fragment-preview-generation.md` — add an implementation note recording the per-fragment storage key as authoritative and the `object_storage.py` key reconciliation (Step 4), and the regeneration entry point the Component 1 correction workflow must call.
- `docs/architecture/mei-ingest-normalization.md` — the Verovio `select` spike results and workarounds (Step 10), if not already recorded from Component 3.
- **Root files via Claude Code only:** any `CLAUDE.md`/`CONTRIBUTING.md` testing-section additions or new conventions, and the Component 1 correction-workflow change to enqueue preview regeneration — flag in the handoff, do not edit here.

**Verification.** CI runs the backend and frontend Component 8 suites on every PR; the touched docs reflect the shipped behaviour; the handoff note lists the root-file and Component-1 edits left for Claude Code.

---

## Decisions Confirmed

The three decisions surfaced during drafting were resolved with Francisco and are now baked in:

- **Rendering-context contract (Step 12) — structured `context.mode`, recorded as ADR-024.** The published `context_bars` integer (`phase-1.md` § Component 8) is replaced with a structured `context` object carrying a `mode` (`none` default; `bars` with asymmetric `before`/`after`; `enclosing_fragment`; `previous_same_domain`), of which Phase 1 implements only `none`; the others are accepted, validated, and ignored. The rationale — a symmetric int cannot express asymmetric or fragment-relative context without a later breaking change — and the full mode table are in `docs/adr/ADR-024-fragment-rendering-context.md`, and the `phase-1.md` note is updated to match.
- **Browse surfaces a fragment under any of its tags (Step 2).** The concept-scoped browse matches on `fragment_concept_tag.concept_id` regardless of `is_primary`, so a fragment appears under every concept it is tagged with, not only its driving concept. Rows are `DISTINCT`-ed so a fragment with multiple in-set tags appears once. This is the intended discovery behaviour; result counts reflect all relevant tags.
- **Public read path stays out of Component 8.** All reads are `require_role("editor")`; the ADR-009 `data_licence` serialiser and ABC-corpus exclusion are built/recorded but the unauthenticated `approved`-only endpoint is Phase 2. Browsing is annotator-facing only in Phase 1, consistent with Component 7.

---

## Deferred to Later Components

Stated explicitly so the boundary is a decision, not a gap:

- **The public (unauthenticated) browse and detail endpoints**, the ADR-009 ABC-corpus exclusion *enforcement*, and the `data_licence` ShareAlike notice on a public landing page. Phase 2 — Component 8 builds the serialiser and keeps the derivation in one place, but ships no public endpoint.
- **Non-default rendering-context modes** (`bars` asymmetric, `enclosing_fragment`, `previous_same_domain`). The contract is published in Step 12; the implementations land with their consuming features (blog embeds, MCQ exercises, parent-fragment orientation), Phase 2+.
- **Display filter UI** (`show` / `category_filter`). Phase 2 — the on-score overlay was built filter-ready in Component 7; the browse list inherits the same data model.
- **music21 auto-analysis and the bass/soprano top-up pass.** Component 6; until then the detail view renders `bass_pitch`/`soprano_pitch` as "not computed."
- **`free` containment mode and deeper sub-part nesting.** Phase-1-deferred by the design (ADR-011 §3); the detail view flattens beyond two visible levels while the data model preserves the true depth.
- **The post-Component-7 minor issues** ("no carry-ins this time"). They wait until documented as per-issue reports under `docs/reports/`, then are scoped into a later component or a remediation pass — not folded in speculatively here.

---

## Sequencing

Part 1 (browse backend) and Part 2 (preview generation) are independent and run in parallel; together they unblock the frontend so Parts 3–4 are never on a mock. Part 3 (list + tag browser) and Part 4 (detail view) share no critical path and can also be parallelised once Parts 1–2 settle; the list view is sequenced first as the more load-bearing surface. Part 5 trails. The backend (Parts 1–2) and frontend (Parts 3–4) are the natural two-stream split.

```
Day 1:      Step 1 (downward subtype traversal)  +  Step 4 (preview key reconcile)  ← small, unblock quickly
Day 2-3:    Step 2 (concept-scoped list + Redis subtree cache)                       ← Part 1 critical path
Day 4:      Step 3 (data_licence serialiser on read)
Day 4-5:    Step 5 (preview Celery task)                                             ← parallel with Part 1
Day 6:      Step 6 (preview triggers: submit / range-edit / MEI-correction)
Day 7:      Step 10 (Verovio select spike confirmation)                              ← gates Steps 5 & 11
Day 7-8:    Step 7 (concept-tree navigator)
Day 9-10:   Step 8 (fragment list view + preview cards)
Day 11:     Step 9 (detail-view read confirm)
Day 12-13:  Step 11 (isolated Verovio render + MIDI)
Day 14:     Step 12 (record display + rendering-context contract)
Day 15-16:  Step 13 (backend tests) + Step 14 (frontend tests)
Day 17:     Step 15 (CI + doc updates)
```

Step 2 is Part 1's critical path (the cross-database join, the cache, and the status-filter scoping all converge there). Step 10 (the `select` spike) gates both the preview task and the detail render — confirm it early so neither is built on undocumented Verovio behaviour. Step 12's contract decision should be raised with Francisco before its doc edits land.

---

## Hard Gates Before Component 9 Begins

1. Concept-tag browsing works end to end: a downward `IS_SUBTYPE_OF` subtree resolves correctly (cached, invalidated on seed); the concept-scoped list returns subtype-inclusive results matching any of a fragment's tags (`DISTINCT`-ed), with cursor pagination and service-layer status scoping that a spoofed filter cannot bypass.
2. Every fragment in a browse list and every detail view carries a correct `data_licence`/`harmony_sources` derived from in-range event sources (ADR-009), with the derivation in a single place ready for the Phase-2 public path.
3. Server-side previews exist (ADR-008): the Celery task renders a fragment's range to SVG under the per-fragment key, regenerates on submit/range-edit/MEI-correction, and the list serves preview URLs with a graceful `preview_url: null` placeholder.
4. The tag browser and list view are usable: the concept tree navigates the hierarchy with an `include_subtypes` toggle; the list renders preview cards with status styling and quiet licence provenance; selecting a card opens the detail view.
5. The detail view renders one fragment in isolation: Verovio `select` constrained to the range (against documented spike behaviour for repeats/endings/mid-system starts), MIDI over the range via `onPositionUpdate`, sub-parts nested within the two-level limit, and the full read-only record (null pitches shown as "not computed"), reusing the Component 7 record component.
6. The rendering-context contract is settled per ADR-024 and reflected in `phase-1.md`; Phase 1 implements only `mode=none` and validates-but-ignores the rest.
7. `pytest -m integration` (Component 8 surfaces) and `npm test` (browse list + `select`-range fixtures) pass in CI; the touched docs reflect the shipped behaviour; the handoff note lists the root-file and Component-1 edits left for Claude Code.
