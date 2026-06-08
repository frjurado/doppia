# Component 5 — Post-Implementation Remediation Plan

**Status:** Complete. All G0–G7 items shipped. G6.2 and G6.3 (the last open items) closed in Component 7 Steps 15–16.
**Scope:** The issue list raised after Component 5 Parts 1–5 shipped. Grouped, sequenced, and pinned to concrete files and docs.
**Workflow note:** Every code, YAML, and migration change below is done in **Claude Code**. This document and the ADR/architecture-doc edits it calls for are the only artefacts edited in Cowork.

---

## 0. How this is grouped and ordered

The raw list mixes a hard blocker, several correctness bugs that write wrong data, and a set of UX/affordance refinements. The plan reorders them by *risk and dependency*, not by the order they were reported:

| Order | Group | Why here |
|---|---|---|
| **G0** | Save/Submit 500 (blocker) | Nothing else is verifiable end-to-end until a fragment can persist. Fix first. |
| **G1** | Entry-mode gating (TAG button) + delete/re-selection workflow + re-render invalidation | These define *when* the tool is live and *how a fragment's lifecycle begins and ends*. Every other interaction sits inside this state machine, so settle it before polishing the interactions. |
| **G2** | Selection-tool correctness (repeat barlines, endings, partial barlines, re-render desync) | These write wrong coordinates or corrupt the active selection — data-correctness, not cosmetics. |
| **G3** | Ghost & bracket affordance (handles, hover/drag, bracket↔ghost sync, accidental x-position) | Visible-but-correct layer. Depends on G1/G2 being stable. |
| **G4** | Stages / sub-fragment brackets (beat control, bracket↔toggle sync, optional-delete, accidental x) | Builds on the same ghost/bracket machinery as G3. |
| **G5** | Properties & picker ordering (edge `order`, implicit stage order, complexity-sorted picker, optional-delete, multi-select dropdowns) | Mostly data-model + form-rendering; independent of the geometry groups, can run in parallel. |
| **G6** | Harmony panel (resizable, clarity, in-score chord overlay) | Largest net-new surface; depends on the ghost x-position index from G2/G3 being trustworthy. Lands last. |
| **G7** | Score title (#22) | Self-contained cosmetic/render fix; can land any time. |

G5 and G7 are parallelisable against the geometry track (G1→G4). G6 should follow G2/G3 because its in-score overlay reuses the beat-ghost x-position index those groups stabilise.

---

## G0 — Save / Submit 500 (blocker)

### Symptom
`POST http://localhost:5173/api/v1/fragments 500 (Internal Server Error)` on both Save and Submit, from `FormPanel.tsx → ScoreViewer.tsx → fragmentApi.ts → api.ts`.

### Diagnosis
A 500 (not 422) means an **unhandled** exception. The project maps every `DoppiaError` (including `FragmentValidationError`) to a structured non-500 response via `doppia_error_handler`; only a non-`DoppiaError` exception reaches `unhandled_exception_handler` and surfaces as 500. So the failure is *below* the validation layer — almost certainly at the database write.

The prime suspect is a **foreign-key violation on `fragment.created_by`**:

- `Fragment.created_by` is `ForeignKey("app_user.id")` (`backend/models/fragment.py:316-318`).
- The local dev auth bypass attaches a synthetic user with `id="00000000-0000-0000-0000-000000000001"` (`backend/api/middleware/auth.py`), and `create_draft` writes that id into `created_by` (`services/fragments.py:110, 725`).
- There is **no runtime seed** that inserts those synthetic dev users into `app_user` (they exist only in `backend/tests/integration/conftest.py`, which doesn't run in dev). So in a fresh local DB `app_user` has no matching row, the INSERT raises `IntegrityError`, and FastAPI returns 500.

This explains *"none of these work"* — it fails for every fragment regardless of content, on the very first write, which is exactly the reported behaviour.

Two secondary suspects to rule out while confirming, in priority order:
1. **`movement_id` FK** (`ForeignKey("movement.id")`) — only fails if the open score's movement row is missing; would be intermittent, not universal, so lower probability than `created_by`.
2. **RLS** (`0005_enable_rls.py`) — default-deny only affects non-owner roles; FastAPI connects as the table-owner superuser, which bypasses RLS, so this is *not* the cause unless local dev is misconfigured to connect as a non-owner role. Worth a one-line check of the dev DB URL, no more.

### How to confirm (do this first)
Read the actual traceback from the API server log (the `uvicorn` terminal). The exception type names the cause directly: `ForeignKeyViolation`/`IntegrityError` on `fragment_created_by_fkey` confirms the diagnosis above.

### Fix (Claude Code)
1. **Seed the dev users into `app_user`.** Add a small idempotent dev seed that inserts the two synthetic users (`…0001` editor, `…0002` admin, matching `auth.py`) using `INSERT … ON CONFLICT (id) DO NOTHING`. Preferred form: a dedicated `scripts/seed_dev_users.py` invoked in the local bootstrap, *or* a data-only migration guarded to dev. Do **not** insert them in a production migration path. Record the chosen mechanism in `docs/architecture/security-model.md` under the dev-bypass section so the bypass identity and its DB row are documented together.
2. **Stop the FK violation from masquerading as a 500.** Catch `sqlalchemy.exc.IntegrityError` in `FragmentService.create_draft`/`update_draft` and re-raise as a `FragmentValidationError` (or a new `ReferentialIntegrityError` in `backend/errors.py`) with a `SCREAMING_SNAKE` code and the offending column in `detail`, so a missing `app_user`/`movement` FK returns a 422 envelope the UI can show — never a bare 500.

### Verification
- With `app_user` seeded, `POST /api/v1/fragments` with the dev token returns `201` and the row persists; `…/submit` then returns `200`.
- A deliberately bogus `movement_id` returns a 422 envelope (`{"error": {"code": …}}`), not a 500.
- Add an integration test that exercises the create→submit happy path under the dev user, so this regression can't silently return.

### Docs to update
- `docs/architecture/security-model.md` — document the dev users' DB seed alongside the bypass tokens.
- `docs/architecture/error-handling.md` — add the IntegrityError→envelope mapping to the cross-database failure cases section.

---

## G1 — Entry mode, fragment lifecycle, re-render invalidation

### G1.1 — "TAG mode" gating
**Issue:** Opening a score drops the user straight into tagging mode (ghosts live, sidebar showing the picker). Desired: read-only on open — no sidebar, ghosts inert — with a single **TAG** button in the top bar. Clicking TAG activates the ghost layer *and* mounts the sidebar/concept-picker together.

**Files:** `frontend/src/routes/ScoreViewer.tsx` (owns layout + which panels mount), `annotator.ts` (ghost listener attach/detach), `ghosts.ts` (layer build can stay; only `pointer-events`/listeners gate), `FormPanel.tsx` (sidebar mount).

**Change:**
- Introduce an explicit top-level mode in `ScoreViewer`: `'view' | 'tag'` (default `'view'`). Persisting it is unnecessary; it resets to `'view'` on each score open.
- In `'view'`: do not mount `FormPanel`; do not attach annotator listeners; ghost layer either not built or built with `pointer-events: none` and no hover/drag handlers. The score + MIDI player are fully usable.
- Render a **TAG** button in the top bar. On click → `mode = 'tag'`: attach the annotator listeners (the existing `_attachListeners()` path) and mount the sidebar. Provide a matching exit affordance (e.g. the same button toggling to "Done"/"Exit tagging") that detaches listeners and unmounts the sidebar — confirm-on-exit only if an uncommitted fragment exists.
- This makes the existing `annotator` lifecycle explicit rather than "always on". Keep ghost *construction* lazy or gated so a view-only reader pays nothing.

**Verify:** Opening a score shows no sidebar and inert ghosts; clicking TAG reveals the sidebar and makes ghosts interactive; exiting tagging restores the inert state and tears down listeners (no leaked handlers across re-renders).

### G1.2 — Delete / re-selection workflow (decision: **clear everything**)
**Issue:** Re-selecting from scratch over an existing fragment is disallowed. The two permitted paths are (a) drag from an existing endpoint to resize, or (b) explicitly delete the fragment and start again. **Decision taken:** deleting a fragment is a *full reset* — selection, concept, Type Refinement, properties, and stages all clear to a blank slate.

**Files:** `ScoreViewer.tsx` (owns the session/fragment state object), `annotator.ts`/`selection.ts` (selection state + endpoint re-anchor), `FormPanel.tsx` + the concurrent-flag state (`fragmentSet`/`conceptSet`/`stagesComplete`/`propertiesComplete`).

**Change:**
- Once `fragmentSet` is true, a fresh mousedown on empty ghost space must **not** start a new selection. Only the two endpoint gradient zones (endpoint re-anchor, already in `_startMeasureDrag`'s `_darkGhosts.size >= 2` branch) accept a drag.
- Add an explicit **Delete fragment** control (sidebar header and/or a keyboard affordance). It clears the committed selection, all four concurrent flags, the main bracket, all stage brackets, the property form, and the chosen concept/refinement — resetting the session to the post-TAG empty state. This is the *single* reset path; there is no partial "clear selection only".
- Document the rule in `tagging-tool-design.md` (selection section): "After commit, the only ways to change the geometry are endpoint re-anchor (resize) or full delete-and-restart; click-to-reselect-from-scratch is intentionally disabled."

**Verify:** With a fragment committed, clicking elsewhere does nothing; dragging an endpoint resizes; Delete returns the tool to the blank post-TAG state with no residual concept/property/stage data.

### G1.3 — Re-render invalidation
**Issue:** If a fragment is selected and the score re-renders (zoom, window resize, Verovio re-layout), the active ghost/bracket stays at the *old* pixel position — out of phase with the new SVG. It should be re-projected, not left stale.

**Files:** `ghosts.ts` (rebuild on layout change), `annotator.ts`/`selection.ts` (re-derive pixel rects from the committed *logical* selection), `MainBracket.tsx`, `StageBrackets.tsx`, `ScoreViewer.tsx` (re-render trigger / resize observer).

**Change:**
- Treat the committed selection as **logical** (`bar/beat/mc` + `repeat_context`), never pixel-anchored. On any Verovio re-render, rebuild the ghost spatial index from the new SVG, then **re-project** the committed selection's logical coordinates onto the fresh ghost positions and redraw the main bracket and stage brackets from that re-projection.
- Drive this off a single re-render signal (a `ResizeObserver` on the score container plus the existing zoom handler), debounced, calling one `reproject()` routine. Per the project's Verovio overlay rule, overlays are absolutely-positioned HTML re-derived after each render — this is that rule applied to the live selection.
- The decision is "re-calculate", not "delete": the logical selection survives a re-render; only its projection is rebuilt. (This is cleaner than discarding, and avoids punishing a zoom with lost work.)

**Verify:** Select a fragment, then zoom and resize: the bracket and ghosts track the new layout exactly; the committed logical coordinates are unchanged; stage brackets re-project with the parent.

---

## G2 — Selection-tool correctness

These are the data-correctness bugs. ADR-005 and `prototype-tagging-tool.md` are the authorities; several "handled" claims there are not holding in the live build.

### G2.1 — Repeat barline must be a symmetric hard gate
**Issue:** A close-repeat barline correctly hard-gates a *forward* drag, but dragging *backward* through it merely resets the selection. Behaviour must be symmetric: the close-repeat barline is a hard barrier in **both** directions.

**Files:** `selection.ts` / `annotator.ts` (the clamp logic in the drag-update handlers).

**Change:** Factor the repeat-barrier test into one direction-agnostic `clampAcrossRepeatBarrier(anchor, cursor)` used by both the forward and backward branches of `_updateMeasureDrag`/`_updateBeatDrag`/`_updateSubBeatDrag`. Backward drags must clamp at the barrier exactly as forward drags do — never reset. Cross-reference the by-design barrier rule in `prototype-tagging-tool.md`.

**Verify:** Vitest: a drag that starts after a close-repeat and moves backward through it clamps at the barrier; the existing forward-clamp test still passes; neither direction resets the selection.

### G2.2 — First/second ending + key-change anomalies (incl. Alla Turca)
**Issue:** Around 1st/2nd endings the selection behaves erratically; a specific break was seen in K.331 mvt 3 (Alla Turca) at a repetition-end / key-change / repetition-begin junction, where the fragment "breaks in a weird way".

**Files:** `ghosts.ts` (ending-aware ghost IDs — Step 9 fix #4: `m${n}-e${endingN}`), `selection.ts` (range walk across ending boundaries), and the meter/key context reading.

**Change:**
- Confirm the **repeat-ending ghost-index collision fix** (ADR-005 fix #4) actually shipped: ghosts in first/second endings sharing integer `@n` must carry distinct index keys incorporating ending context, derived by walking up the DOM `<ending>` during ghost construction. The Alla Turca break is the classic symptom of two ending measures colliding on the same key.
- Ensure the selection range-walk treats an ending boundary as a structural edge (it cannot silently span from inside a first ending into a second ending), and that `repeat_context` is captured when a selection lands inside an ending (Step 10/11).
- Verify this interacts correctly with the section-boundary key change already fixed in the normalizer (component-5 plan §"Fixed — Mid-Movement Key Signature Changes"): the *geometry* bug here is independent of the *pitch* fix there, but Alla Turca is the shared fixture — use it for both.

**Verify:** Build the Alla Turca junction as a Vitest fixture: selecting across/within its endings produces stable, non-colliding ghost keys and a correctly clamped range; `repeat_context` is set inside endings.

### G2.3 — Partial barlines after a repetition
**Issue:** Partial barlines following a repetition break the selection, which then reappears in a different, seemingly random position.

**Files:** `ghosts.ts` (measure enumeration must not mis-key a partial/anacrusis measure), `selection.ts`.

**Change:** A partial measure (pickup/continuation after a repeat) must get a well-defined, unique ghost key and a defined width; the "random reappearance" is the selection re-projecting onto a mis-identified or duplicate key. Treat the partial bar like any other measure in the flat index (the prototype already handles pickup bars in its "handled" list — confirm that path covers post-repeat partials specifically). This is closely related to G2.2 and G1.3; fix them as one pass over the ghost index keys.

**Verify:** A fixture with a partial bar immediately after a close-repeat: selecting across it stays put across re-renders and commits a contiguous range.

> **G2 grouping note:** G2.2, G2.3, and G1.3 all reduce to *"ghost index keys must be unique and stable, and the committed selection must re-project from logical coordinates."* Implement them together against a shared set of fixtures (Alla Turca, partial-bar-after-repeat, written-out repeat) rather than as three separate patches.

---

## G3 — Ghost & bracket affordance

### G3.1 — Move drag handles outside the main ghost
**Issue:**
- The gradient/handle affordance "is there, mostly works, but isn't visible" (documented as Bug B in `issue-ghost-hover-and-drag-affordance.md`; Bug A — hover/drag class inversion — is already fixed).
- On beat/sub-beat resolution the in-ghost gradient zones are *tiny* because they are width-constrained by a very narrow ghost.
- The gradient merges visually with the ghost body (same hue), so the draggable-edge affordance is not legible regardless of size.

**Decision/direction (from Francisco):** Replace the in-ghost gradient zones with **a pair of fixed-width gradient ghost elements rendered just outside the selection boundary**, within the staves — one to the left of the leftmost selected ghost, one to the right of the rightmost selected ghost. These handle ghosts are owned by the ghost layer (not the bracket), live at staff level, and are fully independent of selection ghost width. Both the visible affordance *and* the hit-target for endpoint re-anchor move to these outside handle ghosts; the in-ghost `.ghost-gradient` children serve no further purpose and should be removed.

**Files:** `ghosts.ts` (create and position the handle ghost pair on commit; rebuild on re-projection), `ghosts.module.css` (style the handle ghosts; remove now-unused `.ghost-gradient` rules), `annotator.ts` (wire endpoint re-anchor drag to the handle ghosts as hit-targets, replacing the old gradient-zone path).

**Change:**
- **Handle ghosts:** on commit, insert two fixed-width ghost elements in the overlay — a left handle placed immediately to the left of the selection's leftmost ghost, and a right handle immediately to the right of the rightmost ghost. Each renders as a gradient fading from solid (at the selection edge) to transparent (outward), giving a clear directional affordance. Width is fixed (e.g. one standard ghost width or a design-system constant), so a one-sub-beat selection still gets full-size handles.
- **Hit-target and endpoint re-anchor:** `annotator.ts` treats the handle ghosts as the drag targets for endpoint re-anchor — mousedown on the left handle begins a backward drag; mousedown on the right handle begins a forward drag. This replaces the current gradient-zone hit-target path inside the selection ghosts entirely.
- **Remove in-ghost gradient zones:** `.ghost-gradient-left` / `.ghost-gradient-right` children inside each ghost element no longer serve a visual or interactive purpose. Remove them from the ghost DOM construction in `ghosts.ts` and remove their CSS rules from `ghosts.module.css`. Clean up the `MainBracket.module.css` comment that referenced the gradient zones as the source of interactive affordance.
- **Lifecycle:** on drag-start from a handle ghost, hide it so the live drag edge is legible; on commit, reposition and re-show both handle ghosts at the new extremes. On re-projection (G1.3), rebuild handle positions along with the rest of the ghost layer.

**Verify:** With a committed selection, two gradient handle ghosts appear just outside the selection boundary at staff level, visible at any resolution including one-sub-beat; dragging either handle re-anchors the corresponding endpoint; handle ghosts hide during drag and reappear at the new extremes; no in-ghost gradient zones remain in the DOM; re-projection after zoom/resize correctly repositions the handles; existing selection-state Vitest tests continue to pass.

### G3.2 — Main bracket must match the ghost to beat/sub-beat precision
**Issue:** The above-staff bracket and the selected-fragment ghost don't always coincide — notably the bracket doesn't reach beat/sub-beat precision.

**Files:** `MainBracket.tsx` (reads selection extremes), `selection.ts`/`ghosts.ts` (the pixel extents for a beat/sub-beat selection).

**Change:** The bracket's left/right pixels must be derived from the **same** beat/sub-beat ghost rects the selection occupies, not from the enclosing measure ghost. Source the bracket extents from one `selectionPixelBounds()` helper keyed on the committed logical coordinates at the active resolution, so bracket and ghosts are guaranteed coincident. The handle ghost positions (G3.1) are derived from the same helper — bracket, selection ghosts, and handle ghosts all share one source of truth. This also closes the loop with G1.3 (re-projection uses the same helper).

**Verify:** A beat-level selection draws a bracket whose ends sit on the beat boundaries, not the bar boundaries; switching resolution re-derives the bracket from the corresponding ghost layer.

---

## G4 — Stages / sub-fragment brackets

### G4.1 — Stages need beat/sub-beat control
**Issue:** Stage brackets are not subject to the beat/sub-beat resolution control; they should be, exactly like the main selection.

**Files:** `stages.ts` (snapping/pre-population math), `StageBrackets.tsx` (split-handle drag), shares the resolution toggle from G2/`selection.ts`.

**Change:** Stage split-handles must snap to the active resolution grid (measure/beat/sub-beat), reusing the same ghost index and `selectionPixelBounds()` helper as the main bracket. Pre-population (`default_weight` distribution) snaps to the active grid; Layer-5 active-stage sub-selection already implies beat ghosts within the stage — wire the stage handles to the same grid so a stage boundary can land on a beat/sub-beat, not just a barline.

**Verify:** With Beat resolution active, a stage split handle snaps to beat boundaries; with Sub-beat, to sub-beat boundaries; pre-populated stages snap to the active grid.

### G4.2 — Accidentals ignored for beat-X position (leftmost notehead wins)
**Issue:** On beat/sub-beat ghosts, the x-position is being thrown off by accidentals; it should key off the **leftmost notehead**, not the accidental glyph that precedes it.

**Files:** `ghosts.ts` (beat-boundary inference from `getTimesForElement`/notehead positions).

**Change:** When computing a beat's x-position from the SVG, use the notehead's x, explicitly excluding any preceding `accid`/accidental glyph bounding box. Verovio places accidentals to the left of the notehead; the beat boundary is the note onset = notehead left edge. Audit the prototype-ported inference to confirm it reads the notehead element, not the chord/note group bbox (which includes the accidental). This affects both the main selection and stages (shared inference), so fix once in `ghosts.ts`.

**Verify:** A fixture with an accidental on a downbeat note places the beat ghost at the notehead, not shifted left by the accidental; beat alignment matches across notes with and without accidentals.

### G4.3 — Bracket ↔ sidebar toggle sync
**Issue:** Brackets (on the score) and the stage toggles (in the sidebar `StageList`) are not in sync — collapsing a stage on the brackets should un-toggle it in the sidebar, and vice versa. "Many issues on adjusting; it just doesn't work properly."

**Files:** `StageBrackets.tsx` (score-side), `StageList.tsx` (sidebar-side), `stages.ts` (the single source of stage state), `FormPanel.tsx` (mediates).

**Change:** Make `stages.ts` the **single source of truth** for each stage's state (`present` / `absent` / `limbo`, plus bounds). Both `StageBrackets` and `StageList` render from it and dispatch to it; neither holds its own copy. Collapsing a stage bracket to zero width sets `absent` in the store → the sidebar toggle reflects `absent` immediately; toggling `absent` in the sidebar collapses the bracket and redistributes its share to neighbours (contiguous mode). This is the bidirectional score↔form linking of `tagging-tool-design.md` §6 applied to stages. The current breakage is almost certainly two divergent state copies — collapse them to one.

**Verify:** Collapsing a bracket un-checks the sidebar toggle and redistributes neighbour widths; un-toggling in the sidebar collapses the bracket; an optional stage left in limbo shows as limbo in both places and blocks submission.

### G4.4 — Resolution-toggle icons (low priority)
**Issue:** The measure/beat/sub-beat toggle should carry meaningful icons: a tiny two-barline staff for *measure*; actual note values (quarter, eighth) for *beat*/*sub-beat*.

**Files:** the toggle component (in `FormPanel.tsx` or a dedicated control) + assets.

**Change:** Replace text/abstract labels with small SMuFL/inline-SVG glyphs: barline-staff for measure, quarter-note for beat, eighth-note for sub-beat. Cosmetic; schedule after G4.1–G4.3. Keep accessible labels (`aria-label`).

**Verify:** Toggle renders the three glyphs; tooltips/labels intact.

---

## G5 — Properties & picker ordering

### G5.1 — Deterministic property ordering via edge `order` (decision: **order on edges**)
**Issue:** Property order in the form is non-deterministic; related properties should stay together in a meaningful order.

**Decision taken:** add a numeric **`order`** to `HAS_PROPERTY_SCHEMA` edges (the way `CONTAINS` already carries `order`), plus an optional **`group`** label so related schemas cluster. Schema-driven — no hardcoded concept logic in the frontend.

**This needs an ADR** (new design decision per CLAUDE.md Definition of Done #2). Write **`docs/adr/ADR-023-property-and-value-ordering.md`**: decision = `order` (int) on `HAS_PROPERTY_SCHEMA` and on `HAS_VALUE` edges, optional `group` (string) on `HAS_PROPERTY_SCHEMA`; unset `order` sorts last, ties broken by name; the form renders by (`group`, `order`, `name`) — required vs optional does not affect sort position and is signalled by a `*` marker only, so related required and optional properties can cluster together under the same group. Reference `edge-vocabulary-reference.md` and `knowledge-graph-design-reference.md`.

**Files (Claude Code):**
- `backend/seed/domains/cadences.yaml` — add `order` (and `group` where useful) to each `property_schemas`/value declaration. *Note:* the YAML currently lists `property_schemas` as a bare id list; this becomes a list of `{schema, order, group}` objects (or `order` is read from the schema-definition block). Confirm the seed-loader shape with the existing `contains:` precedent.
- `backend/scripts/seed.py` / loader — persist `order`/`group` onto the edges (MERGE, never CREATE — CLAUDE.md invariant).
- `backend/graph/queries/concepts.py` — the schema-tree query (Step 4) returns `order`/`group`.
- `frontend/src/components/score/PropertyForm.tsx` + `propertyFormHelpers.ts` — sort by (`group`, `order`, `name`). Required status is indicated by a `*` marker and does not affect sort position.
- `docs/architecture/edge-vocabulary-reference.md`, `knowledge-graph-design-reference.md`, `fragment-schema.md` (schema-tree payload), `tagging-tool-design.md` §7.4 — document the ordering contract.

**Verify:** `validate_graph.py` still passes; the schema-tree endpoint returns ordered schemas; the form renders them in declared order with groups contiguous; `visualize_domain.py --domain cadences` confirms structure (per CLAUDE.md, run after the YAML change).

### G5.2 — Stage property order is implicit and must be honoured
**Issue:** Stage properties are implicitly ordered (e.g. *tonic* then *applied dominant* in `Stage1Components`) and should render in that order.

**Files:** same as G5.1 — this is the *same mechanism* applied to the stage concepts' `HAS_PROPERTY_SCHEMA`/`HAS_VALUE` edges (`Stage1Components`, `Stage2Components`, etc.). In `cadences.yaml`, the values under `Stage1Components` (`Stage1Tonic`, `Stage1AppliedDominant`) and `Stage2Components` get explicit `order`. The inline stage property form (Step 15) reads the same ordered payload.

**Verify:** `Stage1Components` renders Tonic before Applied Dominant; `Stage2Components` renders SD4 before raised-SD4.

### G5.3 — Cadence picker ordered by complexity, then prerequisites (decision: **`complexity` then prerequisites**)
**Issue:** Concept-picker results should be ordered sensibly — foundational first, advanced last.

**Good news:** the seed *already* carries a `complexity` field on cadence concepts (`foundational` / `intermediate` / `advanced`) and `PREREQUISITE_FOR` edges. No new field needed; we use `complexity` as the primary sort key and prerequisite order as the tiebreaker within a complexity band.

**Files (Claude Code):**
- `backend/graph/queries/concepts.py` — the `concept_search` query currently `ORDER BY score DESC`. Change to order by a `complexity_rank` (`foundational`=0, `intermediate`=1, `advanced`=2; unset = 99), then by prerequisite topological position within the band, then by `score`/`name`. Compute `complexity_rank` via a `CASE` on `node.complexity`. The prerequisite tiebreaker can be a precomputed depth along `PREREQUISITE_FOR` (a concept that is a prerequisite for others sorts before its dependents).
- `frontend/src/components/score/ConceptPicker.tsx` — render in server order; do not re-sort by score on the client.
- Document the rule in `tagging-tool-design.md` §7.1 and reference `ADR-020-cadence-prerequisite-edges.md`.

**Sketch of the resulting order** (taggable cadence concepts; `top_level_taggable: true`):

| complexity | concept | prereq note |
|---|---|---|
| foundational | Perfect Authentic Cadence (PAC) | prereq for IAC → first |
| foundational | Imperfect Authentic Cadence (IAC) | depends on PAC |
| foundational | Half Cadence (Realised) (HC) | authentic-realised is prereq |
| intermediate | Deceptive Cadence (DC) | |
| intermediate | Evaded Cadence | |
| advanced | Abandoned Cadence | |
| advanced | Dominant Arrival | depends on HC |
| advanced | Reopening Half Cadence | depends on HC; cross-fragment |

- **Search "cadence"** (matches every name/alias containing "cadence") → PAC, IAC, Half Cadence (Realised), Deceptive, Evaded, Abandoned, Reopening Half Cadence. (*Dominant Arrival* has no "cadence" in its name/aliases, so a literal "cadence" full-text query won't surface it — expected.)
- **Search "half"** → Half Cadence (Realised) *first* (foundational), then Reopening Half Cadence (advanced).

This is exactly the foundational-first ordering requested; the complexity field already in the YAML makes it deterministic, with prerequisites only needed to break the within-band ties (PAC before IAC; HC's branch ordering).

**Verify:** `GET /api/v1/concepts/search?q=cadence` returns the band order above; `q=half` returns HC before Reopening HC; an integration test pins the order.

### G5.4 — "Optional" delete in stages too (required = `*`)
**Issue:** The optional-tag delete affordance exists for properties but should also apply within stages; mark required with `*`.

**Files:** `StageList.tsx` / `SubPartForm.tsx` (stage cards), `PropertyForm.tsx` (the `*` convention).

**Change:** Stage cards get the same optional-delete/clear control as optional properties; required stages/properties show a `*` marker. Note all *stage* schemas are `required: false` (Step 15), so within a stage card every property is optional and individually clearable. Keep the required-vs-optional visual split consistent between the main property form and stage cards.

**Verify:** An optional property/stage can be cleared back to unset; required items show `*` and cannot be cleared; clearing leaves `summary.properties` without that key (not an empty-string value).

### G5.5 — "All-one-of-many" multi-selects become dropdowns
**Issue:** Multi-select option groups (e.g. *Phrase Closure*) should be dropdowns, not expanded checkbox lists, to stop the menu becoming huge.

**Files:** `PropertyForm.tsx`, `propertyFormHelpers.ts`.

**Change:** Adjust the control-type mapping from Step 13: `MANY_OF` renders as a compact **multi-select dropdown** (chips/checklist inside a popover) rather than an always-expanded checkbox group, at least above a small value-count threshold. `ONE_OF` keeps radio (≤5) / select (>5). `BOOL` stays a single toggle. This is a rendering change only — the payload shape (`MANY_OF` → array) is unchanged. Update `tagging-tool-design.md` §7.4's control table.

**Verify:** *Phrase Closure* renders as a dropdown multi-select; selected values still serialise as an array; the sidebar height stays bounded with many properties.

---

## G6 — Harmony panel

### G6.1 — Resizable right panel
**Issue:** The right (harmony) panel should be resizable.

**Approach (as scoped):** a drag-to-resize handle on the panel's left edge; persist width in `localStorage` so it survives sessions. Pure CSS + a small interaction module; no backend.

**Files:** `HarmonyPanel.tsx` + `HarmonyPanel.module.css` (or the panel container in `ScoreViewer.tsx`).

**Change:** Add a left-edge drag handle that adjusts panel width within min/max bounds; store the width under a namespaced key (e.g. `doppia.harmonyPanel.width`) and restore on mount.
> **Note (artifact storage rule):** `localStorage` is fine in the real frontend app. It is only forbidden inside chat *artifacts*. The Doppia frontend is a normal Vite app, so `localStorage` is the right tool here.

**Verify:** Dragging the edge resizes within bounds; width persists across reloads; layout doesn't break the score area.

### G6.2 — Clarify the panel content
**Issue:** The displayed harmony info is "somewhat confusing."

**Files:** `HarmonyPanel.tsx`.

**Change:** Tighten the per-event display (Step 16): lead with the human label (`numeral`, e.g. `V65`) and `local_key`; show `root`/`quality`/`inversion` as secondary; render `bass_pitch`/`soprano_pitch` as "not computed" (DCML-only, per the plan) rather than empty/zero; keep `source`/`auto`/`reviewed` state visible but visually quiet. Group events by measure for scannability. (Pair this with G6.3 — the in-score labels and the panel should speak the same vocabulary.)

**Verify:** A DCML passage shows clear `V65`-style labels keyed to measure/beat; null bass/soprano read as "not computed"; review state legible but not noisy.

> **Status: Completed in Component 7 Step 15.** See `frontend/src/components/score/HarmonyPanel.tsx`.

### G6.3 — In-score chord labels under each system (net-new; full plan)
**Issue:** Show the chord info (`V65` etc.) *in the score*, under the relevant system, at the metrically correct position — the single most useful aid.

**Why it's tractable now:** the ghost layer already computes exact x-positions for every beat, keyed by `(measure, beat)`. Harmony events carry `(mn, beat)` (and `mc`) coordinates. The mapping from a harmony event to a pixel x is therefore the *same* beat-ghost lookup the selection uses — no independent geometry.

**Design (write it down before coding):** add **`docs/architecture/harmony-score-overlay.md`** (or an ADR if it introduces a lasting structural decision) covering:
- **Data source:** `movement_analysis` events sliced to the visible systems, via the service layer (no cross-DB call in a route), reusing the Step 7/16 read path.
- **Positioning:** for each event, resolve `(mn, beat)` → beat-ghost x via the existing ghost spatial index (the same `(measure, beat)` identity); place an absolutely-positioned HTML label below the system, `pointer-events: none`, per the Verovio overlay rule (never edit Verovio SVG). Vertical placement: a harmony lane beneath each system's staves, computed from the system's bounding box.
- **Re-render behaviour:** rebuild on every Verovio re-render exactly like the ghosts and brackets (shares the G1.3 `reproject()` signal). The labels are an overlay layer, not part of the render.
- **Ending/volta:** filter events by `volta` against `repeat_context` the same way the approval gate does (`_REPEAT_CONTEXT_TO_VOLTA` in `services/fragments.py`); first/second-ending measures use the ending-aware ghost keys from G2.2.
- **Independence from tagging mode:** decide whether labels show in `'view'` mode too (recommended: yes — they're a reading aid, not a tagging affordance). Confirm with Francisco if unsure; default to showing in both modes, toggleable.
- **Source-of-truth:** these are *display* of `movement_analysis`; editing still happens in the panel (Step 7 primitives). The in-score label is read-only; clicking one may scroll/focus the corresponding panel event (nice-to-have).

**Files (Claude Code):** a new overlay module `frontend/src/components/score/harmonyOverlay.ts` + `.module.css`; consumes the ghost index from `ghosts.ts` and the sliced events from `scoreApi.ts`; mounted by `ScoreViewer.tsx`; shares the re-projection signal from G1.3.

**Verify:** On a DCML-annotated movement, `V65`/etc. appear under the correct system at the beat x-position of the event; labels track zoom/resize; volta filtering places ending labels correctly; the panel and the in-score labels agree.

> **Status: Completed in Component 7 Step 16 (tag mode only).** The open decision on view-mode visibility was resolved: labels render in tag mode only (narrowing this plan's "default to both modes" recommendation). Design reference: `docs/architecture/harmony-score-overlay.md`. Shipped modules: `frontend/src/components/score/harmonyOverlay.ts`, `frontend/src/components/score/harmonyOverlay.module.css`.

---

## G7 — Score title (#22)

**Issue (GitHub #22):** Delete the current title rendering, recreate it from movement metadata, give it a consistent style, and kill the "absurdly high bracket on the first system."

**Files:** wherever the title is injected over/above the score (`ScoreViewer.tsx` and/or a header component; check whether the title is Verovio-rendered or an HTML overlay). The "high bracket on the first system" is likely a Verovio system bracket or a stray overlay element above system 1.

**Change:**
- Render the title from movement metadata (composer/work/movement) as a styled **HTML header**, not from whatever Verovio emits, so styling is consistent and under our control (Newsreader display per `DESIGN.md`).
- Suppress Verovio's own title block if it's the source of duplication (Verovio option to not render `<titlePage>`/`<pgHead>`), or hide it via the overlay.
- Investigate the "absurdly high bracket on the first system": determine whether it's a Verovio staff-group bracket extending too high or a mis-positioned overlay; if Verovio, adjust the render options / spacing; if overlay, fix its vertical anchor. Per the overlay rule, fix overlay geometry in HTML, not by editing SVG.

**Verify:** Title shows once, from metadata, in the `DESIGN.md` type style; no oversized bracket above the first system; consistent across movements and zoom levels.

---

## Cross-cutting: docs to update (Cowork)

Per CLAUDE.md Definition of Done #1–#2, the following docs change alongside the code:

- **New ADR-023** — property/value ordering (`order`/`group` on `HAS_PROPERTY_SCHEMA`/`HAS_VALUE`). (G5.1/G5.2)
- **New `docs/architecture/harmony-score-overlay.md`** (or ADR) — in-score harmony label overlay. (G6.3)
- `docs/architecture/tagging-tool-design.md` — selection lifecycle/delete rule (G1.2), TAG-mode gating (G1.1), re-projection on re-render (G1.3), handle-outside-ghost affordance (G3.1), stage beat control + bracket↔toggle sync (G4.1/G4.3), property/value ordering + multi-select dropdown (G5.1/G5.5), picker ordering (G5.3).
- `docs/architecture/edge-vocabulary-reference.md` + `knowledge-graph-design-reference.md` — `order`/`group` edge properties.
- `docs/architecture/fragment-schema.md` — schema-tree payload carries `order`/`group`.
- `docs/architecture/security-model.md` — dev-user DB seed alongside the bypass tokens (G0).
- `docs/architecture/error-handling.md` — IntegrityError→envelope mapping (G0).
- `docs/adr/ADR-005-sub-measure-precision.md` — note the accidental-x (leftmost-notehead) clarification and confirm the four "not yet handled" fixes' status (G2.2/G2.3/G4.2). If ADR-005's "handled" claims were inaccurate, add a short addendum rather than rewriting the accepted record.
- **Root files via Claude Code only:** any `CLAUDE.md`/`CONTRIBUTING.md` testing-section additions — flag in the handoff, do not edit here.

---

## Suggested sequencing

```
1.  G0   Save/Submit 500            ← blocker; confirm via server traceback, then fix
2.  G1   TAG mode + delete + re-render invalidation   (state machine everything sits in)
3.  G2   Selection correctness      (ghost-key uniqueness + logical re-projection; shared fixtures)
4.  G3   Ghost/bracket affordance   (Bug A/B + handles outside ghost + bracket precision)
5.  G4   Stages                     (beat control, accidental-x, bracket↔toggle sync, icons)
        ── parallel track ──
   G5   Properties & picker order   (ADR-023 + seed order + complexity sort)   ← independent of geometry
   G7   Score title #22             (self-contained)
6.  G6   Harmony panel              (resizable + clarity + in-score overlay)   ← after G2/G3 stabilise the x-index
```

G5 and G7 can run in parallel with G1–G4 (different files, no shared state). G6's in-score overlay depends on the beat-ghost x-position index being trustworthy, so it follows G2/G3. Within the geometry track, G1 → G2 → G3 → G4 is a hard order because each builds on the previous layer's stability.

---

## Decisions confirmed (this round)

1. **Delete = full reset.** Deleting a fragment clears selection, concept, refinement, properties, and stages. (G1.2)
2. **Picker order = `complexity`, then prerequisites.** Uses the existing `complexity` field; prerequisites break within-band ties. (G5.3)
3. **Property ordering = `order` on edges** (+ optional `group`), via ADR-023. (G5.1/G5.2)
4. **Harmony in-score overlay = full plan now** (G6.3), designed in a dedicated doc before coding.

## Decisions still open (flag during implementation)

- **Re-render: confirmed "re-calculate" not "delete"** — but verify the reproject cost is acceptable at large zoom; if not, debounce or cache the ghost index.
- **In-score harmony labels in `'view'` mode** — default recommendation is to show them in both view and tag modes (toggleable). Confirm before building if you'd rather gate them to tag mode.
- **`cadences.yaml` `property_schemas` shape** — moving from a bare id list to `{schema, order, group}` objects touches the seed loader; confirm the loader change is in scope for G5 (it should be).
