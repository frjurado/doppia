# Phase 1 — Component 7: Fragment Database — CRUD & Display — Implementation Plan

This document translates Component 7 of `docs/roadmap/phase-1.md` into a concrete, sequenced set of implementation tasks. It follows the model of the Component 5 plan (`docs/roadmap/component-5-tagging-tool.md`): it does not restate settled design, it sequences implementation and pins the integration boundaries the design docs leave open, and where it reaches a decision those docs do not record it flags it rather than baking it in silently.

Component 7 is the *consumer* side of the fragment data model. Component 5 built the producer write path — an annotator can take a blank score to a `submitted` (and, via API, approvable) fragment record. Component 7 wires up everything that reads those records back: the read/list/update/delete CRUD endpoints with their permission rules, the on-score display of stored fragments, and the reviewer-facing review loop UI (the state machine and approval gate already ship at the service layer from Component 5 Step 8). It adds no columns and no tables — the schema is locked by the foundation migration and documented in `docs/architecture/fragment-schema.md`.

Component 6 (the music21 preprocessing pipeline) is deferred. Its absence is felt only where this plan notes it: `bass_pitch`/`soprano_pitch` remain `null` for the DCML corpus, and the harmony panel renders that absence as "not computed" rather than waiting on a top-up pass.

Because Component 5 shipped and has been exercised against the live corpus, a set of follow-up issues surfaced in use. Component 6 being deferred, they are folded into this plan rather than spun into a second remediation document. They are tagging-tool refinements — stage-bracket behaviour at beat/sub-beat resolution, the submission checklist, the first-system title bracket — plus the two harmony items (G6.2, G6.3) left pending from `docs/reports/component-5-reports/component-5-remediation-plan.md`. They land first (Part 1 and Part 5's harmony work), for the same reason Component 5's accidentals carry-in landed first: an annotator should not build muscle memory against a tool whose stage geometry writes wrong data.

Component 7 has six parts:

1. **Tagging-tool carry-in fixes** — the stage-bracket cluster (checklist semantics, pre-population grid, main-resize response, beat/sub-beat geometry, handle-affordance lock) and the score-title first-system bracket nudge.
2. **Fragment read & CRUD backend** — the read/list/update/delete endpoints the display and review surfaces call, with the delete-permission rules and parent cascade.
3. **On-score display of stored fragments** — the bracket overlays, alias labels, collapsed/expanded sub-part rendering, and the click-to-open side panel, built filter-ready for Phase 2.
4. **Review loop UI** — the reviewer work-queue and the approve/reject controls in the side panel, closing the submit → find → approve loop end to end in the UI.
5. **Harmony panel completion** — G6.2 (panel clarity) and G6.3 (in-score chord labels, tag-mode only), the last items from the Component 5 remediation plan.
6. **Tests, CI, and docs.**

The ordering across parts: the tagging carry-in (Part 1) lands first so the live tool stops writing wrong stage data; the CRUD backend (Part 2) lands next so the display and review surfaces have real endpoints from line one; on-score display (Part 3) precedes the review loop (Part 4) because the reviewer reads a fragment through the same side panel a browser does; the harmony work (Part 5) follows because its in-score overlay reuses the ghost x-position index and the re-projection signal that Parts 1 and 3 keep healthy; tests and docs (Part 6) trail the feature work.

All code, migration, and seed work below is executed in **Claude Code**; this Cowork project edits docs only. This document and the architecture-doc/ADR edits it calls for are the only artefacts edited here. Where a draft of a code-adjacent artefact is useful before handoff (an API contract sketch, a fixture list), it can land under `docs/seed-drafts/` and be copied into the tree via Claude Code.

---

## Prerequisites

Component 7 assumes the Component 5 hard gates have passed (per `docs/roadmap/component-5-tagging-tool.md` § "Hard Gates Before Component 6 / Component 7 Begins"):

- An annotator can take a blank rendered score to a `submitted` fragment record entirely through the UI: select, classify, fill required properties, tag at least one sub-part, review harmony, write prose, and submit.
- The atomic parent+child write is proven: a multi-sub-part submission writes all rows or none.
- `mc_start`/`mc_end` written by the tool match the DCML `mc` for the same physical measures on a sample movement.
- The four ghost correctness fixes are verified against fixtures (compound meter, mid-piece meter change, repeat-ending non-collision, tied-across-barline), and the G2/G3 remediation fixes have shipped (symmetric repeat barrier, ending-aware ghost keys, handle ghosts outside the selection, bracket pixel bounds from the beat/sub-beat ghost index).
- The review state machine and approval gate behave per `fragment-schema.md` at the service layer: creator exclusion, threshold, `actual_key` review, and harmony-event review for harmony-capturing concepts; approve returns a 422 with specifics when the gate fails.

It additionally assumes the following docs are settled and authoritative; they are the *inputs* to this plan and it does not duplicate them:

- `docs/architecture/fragment-schema.md` — the `fragment`, `fragment_concept_tag`, `fragment_review`, and `movement_analysis` definitions; the `summary` JSONB v1 schema; the dual `mc`/`mn` coordinate system; the approval-and-harmony-review gate; the delete/cascade and status-filter rules.
- `docs/architecture/tagging-tool-design.md` — the five overlay layers, stage pre-population and the contiguous split-handle, the form panel, the submission checklist, the bidirectional score↔form linking, and the save/submit semantics.
- `docs/adr/ADR-005-sub-measure-precision.md` — the selection grid (Measure/Beat/Sub-beat), the `beat_start`/`beat_end` float encoding, the resolution toggle, and the edge-case table.
- `docs/adr/ADR-011-multi-level-tagging-design.md` — the two-level display limit, the concurrent-flag interaction model, `containment_mode`/`display_mode`/`default_weight`, `stub`/`top_level_taggable`, and Type Refinement as a subtype split.
- `docs/adr/ADR-015-dual-measure-coordinate-system.md` — `mc_start`/`mc_end` (machine) vs `bar_start`/`bar_end` (human) and why the tool writes both.
- `docs/adr/ADR-008-fragment-preview-generation.md` and `docs/adr/ADR-009-dcml-licensing-constraint.md` — server-side preview generation (a Component 8 concern) and the per-fragment `data_licence`.
- `docs/reports/component-5-reports/component-5-remediation-plan.md` — the G0–G7 remediation work; G6.2 and G6.3 are the only items not yet shipped and are completed here in Part 5.

### Decisions taken into this plan

Five scoping decisions are baked in. Four were confirmed with Francisco before drafting; the fifth (fragment-edit revision semantics) is taken as a sensible default and surfaced in "Decisions to confirm" for veto.

- **Stage response to main-fragment resize: hybrid (proportional + clamp), protecting active stages.** On a main-bracket resize, stages still sitting at their *default* (unconfirmed) positions are re-distributed proportionally by `default_weight` across the new range, snapped to the active grid; stages the annotator has manually dragged or confirmed ("active" stages, required or optional) are preserved in place. The resize hard-clamps before it would force any **active** stage below its minimum width — so an active optional stage is never silently force-disappeared by a resize, which would be unexpected. The auto-drop to a finer grid (next decision) is the escape valve applied before the clamp engages. This removes the current behaviour where a shrink sometimes makes a stage vanish (without un-toggling it in the sidebar) and sometimes raises an "outside main bracket" warning.
- **Stage pre-population when the selection is too short for N stages: auto-drop to the finest needed grid.** When the selection cannot fit N stages at the current resolution (e.g. two bars, four stages, measure resolution), pre-population automatically chooses the finest resolution (beat, then sub-beat) that fits and switches the resolution toggle to match, so stages are always placeable; the UI signals why the grid changed.
- **The review loop ships in full in Component 7.** Both the reviewer work-queue (browse-by-status to find submitted fragments) and the approve/reject controls land here, so the submit → find → approve cycle is exercisable end to end through the UI at the close of Component 7 — not split across Components 7 and 8.
- **In-score harmony chord labels (G6.3) render in tag mode only.** The `V65`-style labels under each system appear while tagging; read-only `view` mode stays clean (score + MIDI only). This narrows the remediation plan's "default to both modes" recommendation.
- **Fragment-edit revision semantics: editing analytic content of an `approved` fragment returns it to `submitted` and clears prior reviews (default — confirm).** A content edit invalidates the prior analytical approval, so the fragment re-enters the review queue and its `fragment_review` rows are cleared. Edits to a `draft` keep it a draft. This is the least-surprising default but is a workflow choice; it is flagged in "Decisions to confirm."

The Phase-1 deferrals from the design hold: `free` containment mode and deeper sub-part nesting remain deferred (ADR-011 §3, the two-level display limit); concept-tag browsing, list-view previews, and the isolated fragment detail view are Component 8.

### Current code state (verified)

- `backend/api/routes/fragments.py` mounts five endpoints: `POST /api/v1/fragments` (create draft), `PATCH /api/v1/fragments/{id}` (update draft), `POST .../submit`, `POST .../approve`, `POST .../reject`. There is **no** read (`GET`), **no** list, and **no** `DELETE` route yet — those are this component.
- `backend/services/fragments.py` defines `create_draft`, `update_draft`, `submit`, `approve`, `reject`. There is **no** `get`, `list`, `update` (beyond draft), or `delete` method yet.
- `backend/api/routes/movements.py` mounts the harmony-event surface: `GET /api/v1/movements/{id}/analysis/events` plus the insert/delete/boundary/chord/confirm primitives (Component 5 Step 7). The in-score harmony overlay (G6.3) reads through the same `GET` path.
- `frontend/src/components/score/` contains the live tagging modules: `annotator.ts`, `ghosts.ts`, `selection.ts`, `stages.ts`, `MainBracket.tsx`, `StageBrackets.tsx`, `StageList.tsx`, `FormPanel.tsx`, `SubmissionChecklist.tsx`, `HarmonyPanel.tsx`, `ConceptPicker.tsx`, `PropertyForm.tsx`, `TypeRefinement.tsx`, `SubPartForm.tsx`, `ResolutionIcons.tsx`. `FragmentOverlay.tsx` is still the small static overlay from before Component 5 — Part 3 grows it into the stored-fragment display layer.
- `frontend/src/services/` has `fragmentApi.ts`, `analysisApi.ts`, `scoreApi.ts`, `conceptApi.ts`, `browseApi.ts`. `fragmentApi.ts` currently calls only the write endpoints; Part 2's read/list/delete endpoints extend it.
- `frontend/src/routes/ScoreViewer.tsx` owns the `'view' | 'tag'` mode introduced in G1.1 and the panel layout; it is the mount point for the stored-fragment overlay (Part 3), the review-queue entry (Part 4), and the harmony overlay (Part 5).

---

## Part 1 — Tagging-Tool Carry-In Fixes

The follow-ups discovered after Component 5 shipped, all in the now-live tagging tool. The stage cluster is data-correctness as much as polish: a stage bracket that rounds to the wrong measure or silently disappears writes a wrong child-fragment range. They land first so no annotator builds habits against the broken geometry. All files named below are edited in Claude Code; the design-doc updates are made here.

---

### Step 1 — "Stages complete" checklist semantics

**Issue.** On entering tagging mode (or selecting a tag), the submission checklist shows "Stages complete" already ticked, which reads as "you have finished the stages" when in fact no concept — and therefore no stages — has been chosen yet.

**Diagnosis.** `stagesComplete` is, by design, *trivially true* for a concept with no `CONTAINS` edges and before any concept is selected (`tagging-tool-design.md` §8; ADR-011). The flag is correct; the *checklist row* is the problem — it renders a satisfied green item for a step that does not yet apply.

**Change.** In `SubmissionChecklist.tsx` (and the concurrent-flag state it reads), make the stages row *conditional on the selected concept actually having stages*:

- Before a concept is selected, do not show a "Stages complete" row at all.
- When a concept with `CONTAINS` edges is selected, show the row and bind it to the real `stagesComplete` state (required stages assigned, optional stages confirmed-or-absent).
- For a stageless concept, omit the row entirely rather than showing it pre-satisfied. The internal trivially-true value is unchanged; it simply has no checklist representation.

Document the rule in `tagging-tool-design.md` §7.5: the stages checklist item is present only when the active concept declares stages.

**Verification.** Entering tag mode with no concept shows no stages row; selecting a PAC adds a stages row that is *unchecked* until the stages are assigned; selecting a stageless concept (e.g. Hemiola) shows no stages row; the existing concurrent-flag tests still pass.

---

### Step 2 — Stage pre-population grid (auto-drop to finest needed resolution)

**Issue.** When the selection is shorter than the stage count (e.g. two bars, four stages, at measure resolution) the initial stage values are wrong — there is no room to place N measure-wide stages, and the result is unusable. The annotator also "can't really resize stages from the very first beginning or last end."

**Decision applied.** Auto-drop to the finest needed grid (confirmed). At pre-population, `stages.ts` computes the smallest resolution (Measure → Beat → Sub-beat) at which N stages fit within the committed selection, switches the resolution toggle to that grid, and distributes the stages by `default_weight` on it.

**Change.**

- In `stages.ts`, add a `chooseStageGrid(selection, stageCount)` helper that returns the coarsest of {measure, beat, sub-beat} on which `stageCount` slots fit, falling through to sub-beat. Pre-population uses this grid; the resolution toggle (shared with `selection.ts`) is set to match, and the change is surfaced to the annotator (a brief inline note, e.g. "switched to beat resolution to fit 4 stages") so the grid change is not silent.
- Clarify the by-design pinning of the outer edges: in `contiguous` mode the first stage's left edge **is** the main bracket's left edge and the last stage's right edge **is** the main bracket's right edge — those outer boundaries are not independently draggable; only the internal split handles move. State this explicitly in `tagging-tool-design.md` §4 so it is understood as intended, not a missing affordance. (Changing the outer extent is done by resizing the main bracket — Step 3.)
- If even sub-beat cannot fit N stages, fall back to the clamp behaviour from Step 3 (the selection is too short for this concept's stage structure) and surface a blocking checklist message rather than placing overlapping stages.

**Verification.** Selecting a two-bar PAC (four stages) auto-switches to beat resolution and places four contiguous stages snapped to beats; a four-bar PAC stays at measure resolution; the grid-change note appears; the first/last stage outer edges are pinned to the main bracket and only internal handles drag.

---

### Step 3 — Stage response to main-fragment resize (hybrid, active-stage clamp)

**Issue.** Resizing the main fragment into "problematic stage situations" is not well handled. Normal shrink/grow works, but at beat/sub-beat resolution the stage bracket rounds to a whole measure; and when a shrink collapses a first/last stage, the stage sometimes disappears (without un-toggling in the sidebar) and sometimes raises an "outside main bracket" warning. Behaviour was undecided.

**Decision applied.** The hybrid, protecting active stages (confirmed with Francisco's refinement):

- **Default-position stages re-distribute proportionally.** Any stage still at its pre-populated default (not manually dragged, not confirmed) is re-laid-out by `default_weight` across the new main range, snapped to the active grid. This is the common case and keeps the layout sensible without annotator effort.
- **Active stages are preserved.** A stage the annotator has dragged or confirmed (required, or an activated optional) keeps its position and width through the resize.
- **The resize hard-clamps to protect active stages.** The main-bracket drag cannot shrink past the point that would force any *active* stage below its minimum width on the active grid (one grid unit). The clamp engages only after the finer-grid escape valve (below) is exhausted. An active optional stage is therefore never force-disappeared by a resize.
- **Auto-drop to a finer grid is the escape valve.** Before clamping, if the shrunk range can still hold all active stages at a finer resolution, drop to it (reusing Step 2's `chooseStageGrid`) and re-snap, rather than clamping.
- **No silent disappearance, no limbo from resize.** The "outside main bracket" warning is reserved for genuine orphaning (e.g. a structural concept change that removes a stage's slot — handled in the existing reactive-structural-change path), not for ordinary resizes.

**Change.** Implement the resize handler in `stages.ts` (geometry) coordinated with `selection.ts`/`annotator.ts` (the main-bracket drag) and `StageBrackets.tsx`/`StageList.tsx` (render + sidebar sync). The single source of truth for stage state (`present`/`absent`/`limbo` + bounds) is `stages.ts` (the G4.3 store); both the brackets and the sidebar read and dispatch to it, so a clamp or redistribution reflects in the sidebar immediately. The resize path must use the same `selectionPixelBounds()` helper (G3.2) so stage and main geometry stay coincident.

**Verification.** Vitest: growing the main bracket redistributes default stages and leaves dragged stages put; shrinking redistributes default stages; shrinking toward an active optional stage drops to a finer grid, then hard-clamps the drag rather than collapsing that stage; the sidebar toggle state always matches the bracket state; no stage silently disappears on resize.

---

### Step 4 — Stage beat/sub-beat geometry: no measure-rounding, no collapse bounce-back

**Issue.** With resolution = measure, stage behaviour is correct. At beat or sub-beat: (a) the stage bracket rounds to a whole measure rather than honouring the beat/sub-beat extent, and (b) trying to collapse a bracket makes it bounce back to its original position.

**Diagnosis.** Both are the snapping/extent math keying off measure boundaries instead of the active beat/sub-beat ghost index. The bounce-back is a minimum-width floor that refuses the collapse-to-absent transition and snaps the handle back.

**Change (`stages.ts`, `StageBrackets.tsx`).**

- Source stage bracket extents from the beat/sub-beat ghost index at the active resolution (the same index the main selection uses), never from the enclosing measure ghost. A stage boundary at beat resolution must land on a beat boundary; at sub-beat, on a sub-beat boundary. This is the stage-side application of the G3.2 "bracket matches ghost to beat/sub-beat precision" fix.
- Distinguish "drag a split handle to a smaller width" (allowed down to one grid unit) from "collapse to absent" (an explicit toggle, or dragging a split handle past the zero-width threshold for an *optional* stage in contiguous mode → mark absent and redistribute). Collapsing an optional stage must reach the `absent` state instead of bouncing back; collapsing a required stage is refused at the minimum-width floor (it cannot be made absent), and the handle stops there rather than bouncing.

**Verification.** Vitest: at beat resolution a stage boundary snaps to beats and the rendered bracket ends on the beat (not the bar); collapsing an optional stage at beat/sub-beat resolution sets it absent and redistributes (no bounce-back); a required stage stops at minimum width without bouncing.

---

### Step 5 — Disable main-ghost handle affordance during a stage resize

**Issue.** While resizing a stage (drag on a stage split handle), the cursor commonly passes over the main ghost — it sits right next to the stage brackets — and the main bracket's "show handles" hover affordance fires, which is distracting and does nothing useful mid-stage-drag.

**Change (`annotator.ts`, `ghosts.ts`, `StageBrackets.tsx`).** Introduce a modal lock: while a stage-resize drag is in progress, suppress the main-bracket handle hover/show affordance (and the handle ghosts' hover response). Re-enable it the instant the stage drag ends. The lock is a single boolean on the interaction state (e.g. `stageDragActive`) that the main-ghost hover handler checks before showing handles. Hovering the main ghost works normally when no stage resize is underway.

**Verification.** Interaction test: starting a stage-handle drag and moving the cursor over the main ghost shows no main handle affordance; releasing the stage drag restores normal main-ghost hover; the lock does not leak across drags.

---

### Step 6 — Score-title first-system bracket vertical offset

**Issue.** After the G7 title rebuild, the first-system bracket sits a little low and occasionally collides with the tempo marking. A small upward nudge is enough.

**Change.** In the title/header rendering touched by G7 (`ScoreViewer.tsx` and/or the header component, per the G7 fix), raise the first-system bracket's vertical anchor enough to clear the tempo marking, consistent across movements and zoom levels. Per the Verovio overlay rule, adjust the overlay's vertical anchor in HTML, not by editing Verovio's SVG. Keep the `DESIGN.md` type treatment unchanged.

**Verification.** The first-system bracket clears the tempo marking on the movements where the collision was seen (K. 331 movements, and a tempo-marked movement in another work); no regression to the G7 title rendering; stable across zoom levels.

---

## Part 2 — Fragment Read & CRUD Backend

The consumer-side endpoints the display (Part 3) and review (Part 4) surfaces call. Build them first so the frontend is never blocked on a mock. All routes are `/api/v1/`-prefixed; all role enforcement is `require_role()` (no inline checks); no route handler touches a database directly (the fragment service owns the joins); every write passes through a Pydantic model. The schema is fixed — these steps add no columns and no tables.

---

### Step 7 — Fragment read endpoints (single record + movement-scoped list)

**Powers the on-score display (Part 3) and the side panel (Step 12).**

Two reads, both on the existing `fragments`/`movements` routers, both `require_role("editor")` for now (Phase 1 is annotator-only; the public read path is Phase 2):

- `GET /api/v1/fragments/{id}` — the full record for one fragment: the `fragment` row (bar/beat/mc range, `repeat_context`, `status`, `data_licence`, audit fields), its `fragment_concept_tag` rows hydrated with each concept's `name`, `alias`, and hierarchy path from Neo4j (the cross-database join, in the service layer), the `summary`, the `prose_annotation`, the harmony events sliced from `movement_analysis` over the fragment's range, and the nested sub-part (stage) child fragments. This is the single source the side panel renders.
- `GET /api/v1/movements/{movement_id}/fragments` — every fragment on a given movement, for the on-score overlay. Cursor-paginated per the API conventions; status-filtered at the service layer (an `editor` sees their own drafts plus all `submitted`/`approved`/`rejected`; a future public reader sees only `approved`). Returns top-level fragments with their sub-parts nested (or a `parent_fragment_id` the client can group on), each with the minimum the overlay needs: `mc_start`/`mc_end`, `bar_start`/`bar_end`, `beat_start`/`beat_end`, `repeat_context`, primary `concept_id` + `alias`, and `status`.

**Boundary note.** This is *movement-scoped* read ("fragments on this score"). The *concept-tag* browse (`GET /api/v1/fragments?concept_id=...&include_subtypes=true`), the list-view previews, and the isolated fragment detail view are Component 8 (`phase-1.md` § Component 8). Keep the two boundaries distinct: Component 7 answers "what is tagged on the score I am looking at," Component 8 answers "show me all PACs in the corpus."

Add `FragmentService.get()` and `FragmentService.list_for_movement()` to `backend/services/fragments.py` (the service owns the Neo4j concept hydration and the `movement_analysis` slice; route handlers call the service), the Pydantic response models, and the routes. The concept hydration reuses the Component 5 concept-search/schema-tree query helpers in `backend/graph/queries/concepts.py`; the harmony slice reuses the Step 7 (Component 5) read path. Extend `frontend/src/services/fragmentApi.ts` with the two calls.

**Verification.** Integration tests against test Postgres + Neo4j: `GET /fragments/{id}` returns the parent with its stage children, concept names/aliases resolved, and the correctly sliced harmony events; `GET /movements/{id}/fragments` returns all fragments for the movement, paginates by cursor, and a non-creator does not see another annotator's drafts.

---

### Step 8 — Fragment update beyond draft (edit + revision semantics)

**The edit path behind the side panel's Edit button (Step 12).**

Component 5's `PATCH /api/v1/fragments/{id}` updates a `draft` only (creator or admin, while `status = 'draft'`). Component 7 extends editing to `submitted` and `approved` fragments and pins what a content edit does to the review state.

**Revision semantics (default — see "Decisions to confirm").** Editing the analytic content (concept tags, `summary`, properties, stages, beat/bar range, harmony review state) of:

- a `draft` → stays `draft`;
- a `submitted` fragment → stays `submitted` (still in the queue), and any `fragment_review` rows recorded so far are cleared, since the thing reviewed has changed;
- an `approved` fragment → transitions back to `submitted`, clears its `fragment_review` rows, and re-opens the approval gate. Prior analytical approval does not survive a change to the analysis.

Edits to non-analytic fields that cannot invalidate a review (e.g. fixing a typo in `prose_annotation`) may be allowed in place without a status change; the service decides per-field. Who may edit: the creator and admins. The atomic parent+child write from Component 5 Step 6 is reused so an edit that changes stages rewrites the child fragments transactionally; the service-layer containment check runs first.

Add `FragmentService.update()` (the beyond-draft path; `update_draft` stays for the draft case or is folded in with a status guard), extend the `PATCH` route to accept non-draft statuses with the revision logic, and surface the resulting status change in the response so the UI can reflect "this edit re-opened review."

**Verification.** Integration tests: editing an `approved` fragment's properties returns it to `submitted` and removes its `fragment_review` rows; editing a `submitted` fragment clears its reviews but keeps it `submitted`; a `prose_annotation`-only edit on an `approved` fragment does not change status; a non-creator non-admin edit is rejected.

---

### Step 9 — Fragment delete with permissions and parent cascade

**The delete path behind the side panel's Delete button (Step 12).**

`DELETE /api/v1/fragments/{id}`, `require_role("editor")`, with the permission rules from `phase-1.md` § "Delete Permissions" and `fragment-schema.md`:

- The creating annotator may delete their own `draft` fragments.
- `approved` fragments cannot be deleted by annotators; only admins can delete them. (`submitted`/`rejected` follow the same creator-or-admin rule as draft; pin the exact matrix in the service and in `fragment-schema.md` if it is not already explicit.)
- Deleting a parent cascades to all child (sub-part) fragments via the existing `ON DELETE CASCADE` on `parent_fragment_id`. Because the cascade can remove many sub-parts, the API requires explicit confirmation: the request carries a `confirm_cascade: true` flag (or a two-step `?dry_run=1` that returns the count of affected children first), and the service refuses to cascade-delete a parent without it. The response returns the number of child fragments removed.
- Harmony events in `movement_analysis` are **not** deleted — they are movement-level, not fragment-owned (`fragment-schema.md`). Deleting a fragment removes the fragment and its sub-parts only.

Add `FragmentService.delete()` (ownership/status/role checks, cascade count, the confirm guard), the route, and the `fragmentApi.ts` call.

**Verification.** Integration tests: a creator deletes their own draft; a creator cannot delete an approved fragment (403/422 envelope); an admin can; deleting a parent without `confirm_cascade` is refused and reports the child count; with confirmation it removes parent + children and leaves `movement_analysis` untouched.

---

## Part 3 — On-Score Display of Stored Fragments

The score viewer grows from "render + tag" to "render + tag + show what is already tagged." This is the read-side counterpart of the Component 5 overlay work, and it reuses the same projection machinery: stored fragments carry *logical* coordinates (`mc`/`bar`/`beat` + `repeat_context`) and are projected onto the live ghost index, never pixel-anchored, so they survive zoom and re-render exactly like the live selection (G1.3).

---

### Step 10 — Stored-fragment overlay data layer and projection

Grow `frontend/src/components/score/FragmentOverlay.tsx` from the small static stub into the real display layer. On score load (and on the G1.3 `reproject()` signal), it:

- fetches the movement's fragments via `GET /api/v1/movements/{id}/fragments` (Step 7);
- projects each fragment's logical coordinates onto the ghost spatial index using the shared `selectionPixelBounds()` helper (G3.2), so stored brackets and live selection brackets are derived from one source of truth and stay coincident at any resolution;
- rebuilds on every Verovio re-render via the shared `reproject()` routine, per the Verovio overlay rule (absolutely-positioned HTML, re-derived after each render — never edit the SVG).

Build the layer **filter-ready** from day one (`phase-1.md` § "Display filtering (Phase 2)"): each fragment bracket carries `show: boolean` and `category_filter: string[]` props and a `collapsed | expanded` state prop. The Phase 2 filter UI is not built here, but the data model and render path must not need refactoring to add it. The overlay must also coexist with the live tagging overlay without z-index or hit-target conflicts: stored brackets are display-only (`pointer-events` limited to a click target that opens the side panel), and they do not intercept the ghost drag-select interactions when in tag mode.

**Verification.** Vitest/interaction: a movement with several stored fragments renders their brackets at the correct measures/beats; zooming and resizing re-projects them with no drift; the committed logical coordinates are unchanged; stored brackets do not block a fresh drag-select in tag mode.

---

### Step 11 — Bracket rendering, alias labels, collapsed/expanded sub-parts

Render each stored fragment per `phase-1.md` § "On-Score Visual Indicators":

- A bracket above the relevant measures (SVG-overlay HTML, not inside Verovio's SVG).
- A short **alias label** at the bracket's left edge — the concept's abbreviated name (e.g. "PAC", "IAC", "HC"), the `alias` field on the Concept node in Neo4j, returned by the Step 7 read. If a concept has no `alias`, fall back to a truncated `name`.
- **Default state (collapsed):** top-level brackets only; sub-part (stage) brackets hidden.
- **Active/selected state (expanded):** when a bracket is clicked/selected, render its sub-part brackets within its bounds. The `collapsed | expanded` prop (Step 10) drives whether the overlay renderer draws the sub-brackets — the same architecture the Phase 2 filter UI needs.
- **Status styling:** distinguish `draft` / `submitted` / `approved` / `rejected` visually (e.g. tonal weight per `DESIGN.md` — depth through tonal layering, 0px radius, no 1px dividers) so a reviewer can see at a glance what state a bracket is in. Distinguish stored brackets from the live in-progress selection so the two overlays are never confused.

Sub-part rendering honours the two-level display limit (ADR-011): one visible level of sub-parts; deeper nesting is flattened visually even though the data model preserves it.

**Verification.** A collapsed movement shows only top-level brackets with alias labels; clicking one expands its stage brackets within bounds; clicking again collapses; status styling is legible and matches `DESIGN.md`; an approved and a draft fragment are visually distinguishable.

---

### Step 12 — Fragment side panel (record view, edit, delete)

Clicking a stored bracket opens a side panel with the full fragment record (`phase-1.md` § "On-Score Visual Indicators"): concept name and hierarchy path, property values (rendered read-only via the existing `PropertyForm` components in a display configuration), the music21/DCML `summary` (notated key/meter, `actual_key` with its review state), the harmony events sliced over the fragment's range, the prose annotation, and the status.

For editors, the panel carries:

- **Edit** — re-enters the tagging/edit flow for this fragment (loads its logical selection, concept, stages, and properties back into the form panel and overlay), and on save calls the Step 8 update path with the revision semantics. Editing surfaces the resulting status change ("this edit returned the fragment to review").
- **Delete** — calls the Step 9 delete path; for a parent with sub-parts, shows the cascade confirmation (the child count from the dry-run) before deleting.

The panel is read-only for non-editors and in `view` mode. It reuses the `FormPanel`/`PropertyForm`/`HarmonyPanel` components rather than duplicating render logic; the difference between the tagging panel and the display panel is configuration (editable vs read-only), not a separate component tree.

**Verification.** Clicking a bracket opens the panel with the correct record; Edit loads the fragment back into an editable session and a save re-opens review on an approved fragment; Delete on a parent shows the cascade count and confirmation; the panel is read-only in view mode and for non-editors.

---

## Part 4 — Review Loop UI

The review state machine and approval gate ship at the service layer in Component 5 Step 8 (`approve`/`reject` endpoints, creator exclusion, threshold, `actual_key` and harmony-event gates). Component 7 builds the UI that makes the loop usable end to end — both the queue to *find* submitted work and the controls to *act* on it — per the decision to ship the full loop here.

---

### Step 13 — Reviewer work-queue (browse-by-status)

A view listing fragments awaiting review: `status = 'submitted'`, excluding the viewer's own fragments (a creator cannot approve their own work — the gate already enforces this, and the queue should not surface what the viewer cannot action). Admins see all submitted work.

- **Backend:** a status-filtered list endpoint — either `GET /api/v1/fragments?status=submitted&exclude_creator=me` or a dedicated `GET /api/v1/reviews/queue`. Whichever is chosen, the status and creator-exclusion filters are applied at the service layer, never UI-only (`fragment-schema.md`: the status filter cannot be bypassable by a direct API call). Cursor pagination. Return enough per row to triage: movement (composer/work/movement label), primary concept + alias, bar range, creator, submitted-at.
- **Frontend:** a queue view reachable from the top bar; selecting a row opens the movement's score with that fragment focused (re-using the Part 3 overlay + side panel), so review happens in context, not in an abstract list.

This is the browse-by-status surface, and it is the structural precursor to Component 8's concept-tag browsing — write the list query as a reusable service function (the forward-compat note in `phase-1.md` about the browse query) so Component 8 calls the same shape with a concept filter instead of a status filter.

**Verification.** The queue lists only `submitted` fragments not created by the viewer; an admin sees all; selecting a row opens the score with the fragment focused; the status filter holds at the service layer (a direct API call with a spoofed filter cannot retrieve a draft).

---

### Step 14 — Approve / reject in the side panel, with gate feedback

When the side panel (Step 12) shows a `submitted` fragment and the viewer is an eligible reviewer (an editor who is not the creator, or an admin), it shows **Approve** and **Reject** (with a comment field) controls wired to the Component 5 `POST /api/v1/fragments/{id}/approve` and `.../reject` endpoints.

- **Approval-gate feedback.** When approve returns a 422 (the gate failed), surface the structured reasons as actionable items, not a generic error: list the unreviewed `actual_key` and the specific unreviewed `movement_analysis` events in the fragment's range (for harmony-capturing concepts), and link each to the place it is reviewed — the harmony panel event (Step 15 / Component 5 Step 7 confirm primitive). A reviewer should be able to clear the gate from the panel without hunting.
- **Reject** moves `submitted → rejected` with the comment; the creator can revise and resubmit (`rejected → draft → submitted`), and the revision path is the Step 8 edit flow.
- **Event-level review.** Because harmony review is per-event in `movement_analysis`, a reviewer's confirmations satisfy the gate for any later overlapping fragment (`fragment-schema.md`); the panel should make clear that confirming an event is a movement-level act, not a fragment-local one.

This closes the submit → find (Step 13) → review-in-context → approve/reject loop entirely in the UI.

**Verification.** A non-creator editor can approve a fully-reviewed submitted fragment (status flips to `approved`); approving one with an unreviewed in-range harmony event returns a 422 whose specifics render as actionable links, and approval succeeds once the events are confirmed; reject with a comment moves the fragment to `rejected` and the creator can resubmit; the creator never sees approve/reject for their own fragment.

---

## Part 5 — Harmony Panel Completion (G6.2, G6.3)

The last two items from the Component 5 remediation plan. G6.1 (resizable panel) shipped; these complete the harmony surface. They depend on the beat-ghost x-position index being trustworthy — which G2/G3 stabilised — so they land after Parts 1 and 3 keep that index and the `reproject()` signal healthy.

---

### Step 15 — G6.2: clarify the harmony panel content

**Issue.** The displayed harmony information is "somewhat confusing."

**Change (`HarmonyPanel.tsx`).** Tighten the per-event display established in Component 5 Step 16:

- Lead with the human label: `numeral` (e.g. `V65`) and `local_key`; show `root`/`quality`/`inversion` as secondary detail.
- Render `bass_pitch`/`soprano_pitch` as "not computed" rather than empty or zero — they are `null` for DCML-sourced events until Component 6's music21 top-up pass (`fragment-schema.md` § Phase 1 note). Do not imply a value that does not exist.
- Keep `source`/`auto`/`reviewed` state visible but visually quiet (per `DESIGN.md` tonal layering), so review status is legible without dominating.
- Group events by measure for scannability.
- Speak the same vocabulary as the in-score labels (Step 16) — the panel and the score overlay must read identically (`V65` in both).

**Verification.** A DCML passage shows clear `V65`-style labels keyed to measure/beat; null bass/soprano read as "not computed"; review state is legible but quiet; events group by measure; panel and in-score labels use identical vocabulary.

---

### Step 16 — G6.3: in-score chord labels (tag mode only)

**Issue.** Show the chord information (`V65`, etc.) *in the score*, under the relevant system, at the metrically correct position — the single most useful reading aid.

**Why it is tractable.** The ghost layer already computes exact x-positions for every beat, keyed by `(measure, beat)`; harmony events carry `(mn, beat)` (and `mc`). Mapping an event to a pixel x is the *same* beat-ghost lookup the selection uses — no independent geometry.

**Decision applied.** Tag mode only (confirmed). The labels render while `ScoreViewer` mode is `'tag'`; read-only `view` mode stays clean. (This narrows the remediation plan's "default to both modes, toggleable" recommendation; if a view-mode reading aid is wanted later, the same overlay can be ungated.)

**Design doc first.** Before coding, write **`docs/architecture/harmony-score-overlay.md`** (per the remediation plan G6.3) covering:

- **Data source:** `movement_analysis` events sliced to the visible systems, via the service layer (no cross-DB call in a route), reusing the Step 7 (Component 5) / Step 7 (this component) read path.
- **Positioning:** for each event resolve `(mn, beat)` → beat-ghost x via the existing ghost spatial index; place an absolutely-positioned HTML label below the system, `pointer-events: none`, per the Verovio overlay rule (never edit Verovio SVG). Vertical placement: a harmony lane beneath each system's staves, computed from the system bounding box.
- **Re-render behaviour:** rebuild on every Verovio re-render via the shared G1.3 `reproject()` signal — the labels are an overlay layer, like the ghosts and brackets.
- **Ending/volta:** filter events by `volta` against `repeat_context` the same way the approval gate does (the `(mn, volta)` identity), using the ending-aware ghost keys from G2.2.
- **Mode gating:** render only in tag mode (this component's decision); state this in the doc so the gate is intentional and discoverable.
- **Source of truth:** the in-score label is a *display* of `movement_analysis`; editing still happens in the panel (the Step 7 primitives). The label is read-only; clicking one may scroll/focus the corresponding panel event (nice-to-have).

**Change (Claude Code).** A new overlay module `frontend/src/components/score/harmonyOverlay.ts` (+ `.module.css`) that consumes the ghost index from `ghosts.ts` and the sliced events from `analysisApi.ts`/`scoreApi.ts`, is mounted by `ScoreViewer.tsx` only in tag mode, and shares the `reproject()` signal from G1.3.

**Verification.** In tag mode on a DCML-annotated movement, `V65`/etc. appear under the correct system at the beat x-position of the event; labels track zoom/resize via reproject; volta filtering places ending labels correctly; the panel and in-score labels agree; the labels do not appear in view mode.

---

## Part 6 — Tests, CI, and Docs

Turns Component 7 from "works on my machine" to "protected against regression."

---

### Step 17 — Backend tests

Beyond the per-step tests above, cover the new read/write/delete surfaces: the single-fragment read (concept hydration, harmony slice, nested sub-parts); the movement-scoped list (pagination, status visibility per role); the update revision semantics (approved → submitted on content edit, review-row clearing, prose-only edits not changing status, non-creator rejection); the delete permission matrix and the cascade-confirm guard (and that `movement_analysis` is untouched); and the review-queue list query (status + creator-exclusion at the service layer, not bypassable). Unit-level where possible (no Docker); integration-marked where a real Neo4j/Postgres is required, per the Component 4/5 marker convention.

**Verification.** `pytest backend/tests/unit/` green; `pytest -m integration` green against the service containers; coverage on the new service methods and routes meets the project bar.

---

### Step 18 — Frontend tests

Vitest coverage for the correctness-critical logic, with the stage-geometry and overlay-projection tests the highest value (they guard the data the database stores and reads back):

- the Part 1 stage fixes: pre-population grid auto-drop (`chooseStageGrid`), the main-resize hybrid (default redistribution vs active-stage preservation vs clamp), beat/sub-beat stage geometry (no measure-rounding, collapse-to-absent without bounce-back), and the handle-affordance lock during stage resize;
- the checklist semantics (stages row present only when the concept has stages);
- the stored-fragment overlay: logical-coordinate projection and reproject across zoom/resize, collapsed/expanded sub-part rendering, status styling, and non-interference with live drag-select;
- the side panel record view and the edit/delete affordances;
- the harmony overlay positioning (`(mn, beat)` → beat-ghost x, volta filtering, tag-mode gating).

**Verification.** `npm test` green; the stage-resize and overlay-projection fixtures specifically assert correct geometry across resolutions and across re-render.

---

### Step 19 — CI integration and doc updates

Wire the new suites into CI alongside the Component 4/5 jobs. Update the docs whose area this component touches, per CLAUDE.md's Definition of Done (these are docs, edited here in Cowork):

- **New `docs/architecture/harmony-score-overlay.md`** (Step 16) — the in-score harmony label overlay design.
- `docs/architecture/tagging-tool-design.md` — the Part 1 stage-resize behaviour (hybrid, active-stage clamp), the auto-drop pre-population grid and the by-design outer-edge pinning (§4), the checklist stages-row semantics (§7.5), the handle-affordance lock; and an "Implemented in Component 7" note mapping the on-score display and review-loop UI to the shipped modules.
- `docs/architecture/fragment-schema.md` — make the delete-permission matrix and the edit-revision/status-reset rule explicit if they are not already; confirm the status-filter-at-service-layer wording covers the read/list/queue endpoints.
- `docs/roadmap/phase-1.md` § Component 7 — a short note that the review loop UI ships here in full (not split with Component 8) and that Component 6 deferral leaves `bass_pitch`/`soprano_pitch` null.
- `docs/reports/component-5-reports/component-5-remediation-plan.md` — mark G6.2 and G6.3 as completed in Component 7 (cross-reference), closing the remediation list.
- **Root files via Claude Code only:** any `CLAUDE.md`/`CONTRIBUTING.md` testing-section additions or new conventions — flag in the handoff, do not edit here.

**Verification.** CI runs the backend and frontend Component 7 suites on every PR; the touched docs reflect the shipped behaviour; the handoff note lists the root-file edits left for Claude Code.

---

## Decisions to Confirm

- **Fragment-edit revision semantics (Step 8).** This plan takes the default that editing analytic content of an `approved` fragment returns it to `submitted` and clears its `fragment_review` rows (and a `submitted` edit clears reviews but keeps the status), while a prose-only edit on an approved fragment does not change status. This is the least-surprising behaviour, but it is a workflow choice — confirm before Step 8, or specify a different rule (e.g. approved fragments are immutable and must be deleted-and-recreated, or edits create a new versioned revision rather than mutating in place).

The four scoping decisions surfaced before drafting (stage-resize behaviour, stage-grid auto-drop, the full review loop in Component 7, harmony labels tag-mode-only) are recorded under "Decisions taken into this plan" and are not re-opened here.

---

## Deferred to Later Components

Stated explicitly so the boundary is a decision, not a gap:

- **Concept-tag browsing** (`GET /api/v1/fragments?concept_id=...&include_subtypes=true`), the hierarchical tag browser, the fragment **list-view previews** (server-side static SVG at submit time, ADR-008), and the **isolated fragment detail view** with its own Verovio render + MIDI. Component 8 (`phase-1.md` § Component 8). Component 7's reads are movement-scoped; Component 8's are concept-scoped.
- **Display filter UI** (the `show` / `category_filter` controls). Phase 2 — the overlay is built filter-ready here (Step 10) but the filter UI is not.
- **music21 auto-analysis and the bass/soprano top-up pass.** Component 6; until then `movement_analysis` is DCML-sourced and `bass_pitch`/`soprano_pitch` are null, rendered as "not computed."
- **`mc`-range harmony query simplification** (filtering events by `mc` instead of `(mn, volta)`), noted as deferred in `fragment-schema.md`/ADR-015; the read and gate paths keep the `(mn, volta, beat)` identity.
- **`free` containment mode and deeper sub-part nesting.** Phase-1-deferred by the design (ADR-011 §3; two-level display limit). The on-score display flattens beyond two visible levels (Step 11) while the data model preserves the true depth.
- **`movement_harmony_audit` table** for concurrent harmony corrections — built the first time a disagreement matters, not speculatively (`fragment-schema.md`).
- **A public (non-editor) read path.** All Component 7 reads are `require_role("editor")`; the `approved`-only public view is Phase 2.

---

## Sequencing

Part 1 (the tagging carry-in) runs first because it stops the live tool writing wrong stage data. Part 2 (CRUD backend) is independent of the frontend display work and proceeds in parallel once Part 1's stage store changes settle; Parts 3–4 depend on Part 2's endpoints; Part 5 follows Parts 1 and 3 (it reuses the stabilised ghost index and reproject signal); Part 6 trails the feature work. The frontend (Parts 1, 3, 4, 5) and backend (Part 2) are the natural parallel split if two work-streams are available.

```
Day 1:      Step 1 (checklist semantics) + Step 6 (title bracket nudge)   ← small, unblock quickly
Day 2-3:    Step 2 (stage pre-population grid auto-drop)
Day 4-6:    Step 3 (stage response to main resize — the hybrid)            ← richest Part 1 item
Day 7:      Step 4 (beat/sub-beat stage geometry) + Step 5 (handle lock)
Day 8-9:    Step 7 (fragment read endpoints)                               ← parallel with Part 1
Day 10:     Step 8 (update + revision semantics)
Day 11:     Step 9 (delete + cascade)
Day 12-13:  Step 10 (stored-fragment overlay projection)
Day 14:     Step 11 (brackets, alias labels, collapsed/expanded)
Day 15-16:  Step 12 (fragment side panel: view, edit, delete)
Day 17:     Step 13 (reviewer work-queue)
Day 18:     Step 14 (approve/reject in panel + gate feedback)
Day 19:     Step 15 (G6.2 harmony panel clarity)
Day 20-21:  Step 16 (G6.3 in-score harmony overlay + design doc)
Day 22-23:  Step 17 (backend tests) + Step 18 (frontend tests)
Day 24:     Step 19 (CI + doc updates)
```

Step 3 is Part 1's critical path and highest-risk item (the stage geometry interacts with resolution, pre-population, and the sidebar store); start it early and lean on the shared `selectionPixelBounds()`/`reproject()` helpers rather than re-deriving geometry. Step 10 is the display critical path for the same reason — projection must reuse the live-selection machinery, not a parallel implementation.

---

## Hard Gates Before Component 8 Begins

1. The Part 1 stage fixes are verified against fixtures: pre-population auto-drops to the finest fitting grid; a main resize redistributes default stages, preserves active ones, and hard-clamps before force-disappearing any active stage; stage brackets honour beat/sub-beat extents without rounding to measure or bouncing back on collapse; the main-ghost handle affordance is suppressed during a stage resize. The "Stages complete" checklist row appears only when the concept has stages.
2. The CRUD backend is complete and tested: read (single + movement list with role-scoped status visibility), update with the confirmed revision semantics, and delete with the permission matrix and cascade-confirm guard. No route handler touches a database directly; the status filter holds at the service layer.
3. Stored fragments display on the score: brackets with alias labels project from logical coordinates and survive zoom/re-render; collapsed/expanded sub-parts render per the two-level limit; clicking a bracket opens the side panel with the full record; editors can edit (re-opening review on approved fragments) and delete (with cascade confirmation).
4. The review loop is exercisable end to end in the UI: a reviewer finds submitted work in the queue, opens it in context, and approves or rejects it; the approval-gate 422 renders as actionable links to the unreviewed entries; the creator cannot approve their own fragment.
5. The harmony surface is complete: the panel reads clearly (G6.2) and in-score chord labels appear in tag mode at the correct beat x-positions, tracking re-render and volta (G6.3); G6.2 and G6.3 are marked closed in the remediation plan.
6. `pytest -m integration` (Component 7 surfaces) and `npm test` (stage geometry + overlay projection) pass in CI.
7. `docs/architecture/harmony-score-overlay.md` exists; `tagging-tool-design.md`, `fragment-schema.md`, and `phase-1.md` reflect the shipped behaviour; the handoff note lists the root-file edits (CLAUDE.md/CONTRIBUTING.md) left for Claude Code.
