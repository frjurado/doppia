# Tagging Tool — Multi-Level Design Reference

**Status:** Active  
**Date:** 2026-04-15  
**See also:** `docs/architecture/prototype-tagging-tool.md` (prototype analysis, ghost layer architecture), `docs/adr/ADR-005-sub-measure-precision.md` (selection grid and sub-beat encoding), `docs/adr/ADR-015-dual-measure-coordinate-system.md` (coordinate model), `docs/adr/ADR-025-repeat-barlines-and-volta-selection-boundaries.md` (selection boundary rules)

---

## Overview

This document specifies the design of the Doppia tagging tool beyond the prototype: the multi-level annotation flow that handles concepts with internal stage structure (`CONTAINS` edges), the property form generated from the knowledge graph, and the interaction model that ties them together.

The ghost overlay architecture, beat boundary inference algorithm, and sub-beat encoding from the prototype carry forward unchanged. This document describes what is built on top of that foundation.

---

## 1. Screen Layout

The tagging interface has three zones:

**Score zone (centre)** — the Verovio-rendered score with SVG overlay layers. All spatial selection happens here. The zone is scrollable horizontally across systems.

**Form panel (right)** — concept picker, type refinement, stage list, property form, and submission checklist. Stateless except for what the user has committed in the current session. Updates reactively as the user interacts with the score.

**Toolbar (top)** — Save Draft, Submit for Review, and Discard. Always reachable regardless of annotation completeness.

---

## 2. State Model

The prototype used a `phase` string (`waiting`, `frgmSel`, `ptrnSel`) to drive all listener behaviour as a sequential state machine. The new model replaces this with four independent boolean flags, because the multi-stage annotation flow does not have a single correct ordering:

| Flag | Meaning |
|---|---|
| `fragmentSet` | Main fragment bracket has been drawn and committed |
| `conceptSet` | A concept has been selected from the picker |
| `stagesComplete` | All required stages have spatial assignments, OR the concept has no `CONTAINS` edges |
| `propertiesComplete` | All required properties have values, OR the concept has no required `PropertySchema` |

**Submit enables** when all four flags are true. Any flag can become true in any order. The form panel and score overlay both render reactively against this state.

Each flag can also become false again — the user can change the concept, resize the main bracket, or clear a property value at any time. The consequences of doing so are described in §8.

---

## 3. Score Overlay Layers

Five layers stack on top of the Verovio render. Layers 1 and 2 carry over directly from the prototype. Layers 3–5 are new.

**Layer 1 — Base render.** The Verovio-rendered SVG. Never redrawn during a tagging session; all interaction targets the ghost layers above it.

**Layer 2 — Measure / beat / sub-beat ghost layer.** The transparent SVG ghost overlay from the prototype: measure ghosts for the main fragment selection, beat and sub-beat ghosts for sub-measure precision. Governed by the resolution toggle (see §5). Sits over the staff.

**Layer 3 — Main bracket track.** A single coloured bracket rendered above the staff once `fragmentSet` is true. Has gradient-zone drag handles at both endpoints (from the prototype). Colour is fixed across all annotations (e.g. system accent colour).

**Layer 4 — Stage bracket track.** Rendered below the staff once `conceptSet` is true and the concept has `CONTAINS` edges. One bracket per stage, each in a distinct colour keyed to the stage concept. See §4 for pre-population and §6 for the split-handle interaction.

**Layer 5 — Active-stage beat ghost sub-selection.** When the user is refining the boundary of a specific stage at sub-beat precision, beat ghosts activate within the bounds of that stage's current bracket only — suppressed outside them. This requires passing the active stage's current `[barStart, barEnd, beatStart, beatEnd]` bounds to `addSuperGhosts` (or a new `activateBeatGhostsInRange` variant). Only one stage can be in this active-refinement mode at a time; the others remain visible but not in sub-beat mode.

**Layer interaction:** layers 3 and 4 are always present once their conditions are met. Layer 5 is activated only during active sub-beat refinement of a stage and deactivated on mouseup.

---

## 4. Stage Pre-Population

When the user selects a concept with `CONTAINS` edges, stage brackets are **immediately pre-populated** in the stage bracket track. The user gets real handles to adjust rather than an empty panel requiring them to draw from scratch.

### Default positions

Stage brackets are distributed across the main fragment's spatial extent using `default_weight` values on the `CONTAINS` edges (see `edge-vocabulary-reference.md`). Each stage's default width is proportional to its weight relative to the sum of all sibling weights:

```
stage_width = (stage.default_weight / sum_of_weights) × main_bracket_width
```

If no `default_weight` is set on any sibling edge, equal distribution applies (all weights implicitly 1.0).

### Grid snapping and auto-resolution drop

Default positions are distributed by `default_weight` and snapped to the active selection grid (see §5).

**Auto-drop when the selection is too short for measure-level placement.** If the committed selection cannot accommodate N stages at measure resolution (fewer bars than stages), pre-population automatically selects the finest resolution at which the stages fit — Measure → Beat → Sub-beat — and switches the resolution toggle to match. The annotator is shown a brief inline note ("switched to beat resolution to fit 4 stages") so the grid change is not silent.

If even sub-beat resolution cannot fit the required number of stages (e.g. a one-beat selection for a four-stage concept), no brackets are placed; submission remains blocked until the annotator extends the main selection or reduces the stage count.

Snapping resolves left-to-right: each stage is snapped in sequence, with the right boundary of stage N becoming the left boundary of stage N+1.

### Outer-edge pinning in contiguous mode

In `contiguous` mode the **first stage's left edge is always the main bracket's left edge**, and the **last stage's right edge is always the main bracket's right edge**. These outer boundaries are not independently draggable — they are by design fixed to the main selection. The only draggable boundaries are the internal split handles between adjacent stages.

Changing the outer extent of the stage group is done by resizing the main bracket (§6, "Main bracket change after stages are committed").

### Required stages

Required stages (`required: true` on the `CONTAINS` edge) appear as **solid, fully-interactive brackets**. They are immediately draggable. They must have spatial assignments before the tag can be submitted.

### Optional stages

Optional stages (`required: false`) appear as **dashed brackets** at their proportional default positions. They behave as required brackets by default — the user drags them to confirm and refine their bounds. Making a stage solid by dragging it is the primary way to confirm an optional stage is present.

An **absent toggle** in the stage list in the form panel (§7.3) lets the user explicitly mark an optional stage as not present in this instance. Toggling absent:

- Collapses the stage bracket to zero width (it disappears from the track).
- In `contiguous` mode, the absent stage's proportional share is redistributed to its neighbours, shifting the split handle between them.
- The bracket reappears (at its neighbours' current boundary) if the user re-enables the stage, and the neighbours' shared boundary shifts back to accommodate it.

An optional stage at its pre-populated default position is valid data and counts toward submission — the annotator is not required to drag it. The user can refine the bounds by dragging (which sets `confirmed = true` on the stage assignment) or toggle it absent; both are optional actions. The only way an optional stage blocks submission is if it has an error state (bounds outside the main bracket). See §7.5.

### Compound stages and segmentation

A stage concept whose sub-stages carry `display_mode: segment` on their `CONTAINS` edges does not generate a new row of brackets. Instead, its stage bracket is divided internally by a split handle, producing segments within the same track row. Each segment is labelled with its sub-stage concept name. The outer edges of the compound stage bracket behave as a unit; the internal handle controls the boundary between sub-stages.

Sub-stages using `display_mode: stage` — if they occur at depth ≥ 3 — would create a third bracket row, which is not supported. The graph modelling constraint is that concepts tagged with `display_mode: stage` on their parent's `CONTAINS` edge must not themselves have children with `display_mode: stage`. This constraint is enforced during graph seeding.

---

## 5. Selection Grid and Snapping

The selection grid — three resolution modes (Measure / Beat / Sub-beat), meter-dependent boundary values, segmented-control toggle, and ghost-layer switching mechanism — is fully specified in ADR-005. That document is the authoritative reference for the grid itself.

This section covers only what the grid means for stage brackets specifically.

**Snapping.** The active grid mode governs not only main-bracket selection but also the quantisation of all bracket boundaries — including the pre-populated stage defaults described in §4. Default positions are computed in score-space coordinates and then snapped to the nearest boundary in the current grid before being drawn.

**Minimum width.** A stage bracket cannot be dragged narrower than one grid unit at the current resolution. This is the minimum meaningful spatial extent for a stage. It applies both to optional stages being expanded from zero width and to any bracket being squeezed by a neighbour's split handle.

**Grid changes after brackets are drawn.** Changing the resolution toggle does not retroactively re-snap committed bracket boundaries. The new grid applies only to subsequent drag interactions. This matches the standard DAW behaviour: grid changes affect new edits, not existing ones.

---

## 6. Interaction Model

### Non-ordered flow

No interaction is gated on completing a prior step. At any point in a session the user can:

- Draw or resize the main bracket
- Select or change the concept
- Make a Type Refinement choice (§7.2)
- Drag any stage bracket boundary
- Mark an optional stage absent or present
- Set or change any property value

The form panel and score overlay update reactively in response to any of these actions.

### Contiguous containment and the split-handle

When a concept's `CONTAINS` edges carry `containment_mode: contiguous` (see `edge-vocabulary-reference.md`), adjacent stage brackets share a single boundary. Rather than two independent bracket endpoints that the user must manually align, there is one **split handle** between each pair of adjacent stages. Dragging the split handle moves the shared boundary simultaneously — the right edge of stage N and the left edge of stage N+1 are the same object.

This eliminates gaps and overlaps by construction. The user cannot produce an invalid spatial configuration in contiguous mode.

When a concept's stages carry `containment_mode: free`, each bracket has independent left and right endpoints. Gap and overlap warnings appear in the submission checklist if boundaries violate containment.

### Endpoint re-selection

Inherited from the prototype: clicking within the gradient zone of any bracket endpoint re-anchors the drag from the opposite end, allowing boundary adjustment without discarding and redrawing. This applies to the main bracket endpoints and to the outer endpoints of each stage bracket.

### Delete / re-selection workflow

After a fragment is committed (`fragmentSet` true), clicking on empty ghost space does **not** start a new selection. The only permitted action on the ghost layer is endpoint re-anchor (above). This prevents accidental overwriting of committed work.

If the annotator needs to change the bar range entirely, the workflow is:

1. Click **Delete** in the sidebar header (appears once `fragmentSet` is true).
2. The session resets completely: selection, concept, Type Refinement, properties, and all stage brackets are cleared. There is **no** partial "clear selection only" — Delete is always a full reset.
3. Draw a new selection from scratch.

The Delete control is always accessible in the sidebar while a fragment is committed, regardless of how far the annotator has progressed through the checklist. Clearing the ghost layer via Delete is the *only* way to restart selection; the drag handler ignores mousedown on committed ghost space.

**Note on saved drafts:** if Save Draft was called before Delete, the previously saved draft persists on the backend with `status: 'draft'` and is not automatically removed. The local session simply loses the reference. A future delete endpoint will allow explicit removal of orphaned drafts.

### Concept change after stages are committed

If the user changes the selected concept after stage brackets have been drawn, the system attempts to preserve as much work as possible:

- Stages whose concept ID exists in the new concept's `CONTAINS` structure are kept at their current spatial positions.
- Stages from the old concept with no counterpart in the new structure are shown as **orphaned** — greyed out with a warning icon — until the user explicitly dismisses them (they are not submitted).
- Required stages from the new concept with no matching existing bracket receive default pre-populated placeholders (§4).

Type Refinement changes (§7.2) follow the same logic: sub-stage brackets that survive the structural change are preserved; those that do not are orphaned.

### Main bracket change after stages are committed

When the annotator resizes the main bracket, stage positions update using a **hybrid redistribution + clamp** policy (Component 7 Step 3):

- **Default-position stages redistribute proportionally.** Any stage still at its pre-populated default (not manually dragged, not confirmed) is re-laid out by `default_weight` across the new main range, snapped to the active grid.
- **Active stages are preserved.** A stage the annotator has dragged or confirmed (required, or an activated optional) keeps its position and width through the resize.
- **Auto-drop to a finer grid is the escape valve.** Before clamping, if the shrunken range can still fit all active stages at a finer resolution, the grid is dropped (reusing `chooseStageGrid`) and stages are re-snapped.
- **The resize hard-clamps to protect active stages.** The main-bracket drag cannot shrink past the point that would force any active stage below one grid unit. The clamp fires only after the finer-grid escape valve is exhausted.
- **No silent disappearance.** Active optional stages are never force-disappeared by a resize. The "outside main bracket" error state is reserved for genuine orphaning (e.g. a structural concept change that removes a stage's slot) — not for ordinary resizes.

*As implemented (Component 9 Step 4):* `respondToMainResize()` in `stageFrame.ts`, recomputed from the committed state on the new selection's slot frame (§6A.4/§6A.5). Note the Component 7 implementation additionally kept default-position stages frozen when they all still fit inside the resized range; that deviation from the first bullet is removed — default stages now always re-lay out proportionally, which also makes repeated resizes idempotent (§6A.5 third post-condition).

### Handle-affordance lock during stage resize

While a stage-split-handle drag is in progress, the main-bracket handle hover affordance is suppressed. The main ghost sits immediately adjacent to the stage brackets; without the lock, the cursor routinely crosses the main ghost mid-drag and triggers the show-handles animation, which is distracting and serves no purpose during an active stage resize. The lock is a single `stageDragActive` boolean on the interaction state; it is cleared the instant the drag ends. Normal main-ghost hover behaviour resumes immediately after the stage drag completes.

### Bidirectional linking (score ↔ form)

- When the user drags or clicks a stage bracket in the score, the corresponding stage card in the form panel scrolls into view and highlights.
- When the user clicks a stage card in the form panel, the score view centres on that bracket and highlights it briefly.

---

## 6A. Selection and Stage Geometry — Normative Rules

**Added in Component 9 Step 2.** This section pins the interaction-model semantics that §§5–6 left implicit. It is written in the ADR-015 coordinate vocabulary — committed ghost range (selection state), bracket geometry (rendering), human coordinates (`bar_*`/`beat_*`, for display and the API), machine coordinates (`mc_*`, for Verovio) — and is the normative reference for the Component 9 selection and stage fixes (Steps 3–4). Each fixture in `docs/reports/component-9-reports/step-1-fixture-matrix.md` maps to a rule here (§6A.8).

### 6A.1 Single source of truth

A selection session has exactly one piece of committed spatial state: the **committed ghost range** — the set of ghost entries (measure, beat, or sub-beat keys) between the two committed endpoints, at the precision each endpoint was committed at.

Everything else is derived from it, by pure functions, on every render:

```
committed ghost range
   ├─→ bracket geometry      (px extents of every bracket segment)
   ├─→ machine coordinates   (mc_start / mc_end, via render-order index)
   ├─→ human coordinates     (bar_start/end, beat_start/end, repeat_context,
   │                          via the measure map: mc → (@n raw, volta))
   └─→ stage layout frame    (the coordinate space stages distribute over)
```

No derived surface computes its extent independently, caches it across edits, or repairs it from another derived surface. Three invariants follow:

- **I1 — Bracket ≡ ghost.** The bracket renders exactly the committed ghost range — same first measure, same last measure, same beat/sub-beat endpoints — at every resolution, after every action. There is no state in which the bracket may legitimately cover more or less than the ghost range; any divergence is a derivation bug, never an acceptable rendering approximation.
- **I2 — Total coordinate derivation.** The human-coordinate lookup is total over selectable ghosts: every ghost entry that can be committed maps to finite `bar`/`beat` values. A payload containing `NaN` or an unresolvable bar number must be impossible to construct from a committed range, and the client validates coordinates before emitting any API request. ("Request validation failed" reaching the annotator is two bugs at once: the lookup failed, and the failed value was emitted anyway.)
- **I3 — Resolution changes never mutate committed state.** Switching the resolution toggle changes which ghost layer accepts *subsequent* input and nothing else. The committed ghost range, the bracket, and all stage boundaries are untouched. This strengthens §5 ("grid changes affect new edits, not existing ones"): the toggle must not inflate the bracket to match the ghost, deflate the ghost to match the bracket, or re-snap anything.

### 6A.2 Selection boundaries

**Repeat barlines are not boundaries** (ADR-025). A selection drag crosses repeat-end barlines (`:|`), repeat-start barlines (`|:`), and section boundaries freely, at every resolution. The previous hard gate at backward repeat barlines (ADR-005 edge-case table) is removed, not mirrored onto repeat-start. Rationale: the bars on either side of a repeat-end *are* heard in succession on the final pass, so a fragment spanning one is musically meaningful; the tool trusts the annotator. Playback consequences are in §6A.6.

**Sibling volta endings are a hard gate.** A selection may never have one endpoint inside ending N and the other inside a sibling ending M ≠ N of the same volta group; and a selection anchored inside a non-final ending may not extend past the end of that ending's group (a first ending closes into the repeat jump, never into the continuation). Those bars are never heard in succession in any pass, so a fragment there denotes no performable music. The drag visibly clamps at the gate (I9).

**Da capo and dal segno markers are a hard gate.** A selection may not cross a D.C. or D.S. marker: at those points the jump *always* fires — there is no final pass that proceeds directly into the following bar, so the bars on either side are never heard in succession. This is the difference from a repeat-end barline, which is crossable precisely because its final pass goes straight on. "To Coda" marks and "Fine" marks are **not** gates — the first pass proceeds directly past both. No separate rule is needed for coda sections: a selection from pre-coda material into a coda necessarily crosses the D.C./D.S. marker and is gated there.

The unifying principle behind all the rules above (rationale, not an additional rule): **a selection is valid iff its effective measure sequence occurs as a contiguous run in at least one pass of the performed (repeat-expanded) score.** Crossing a repeat-end is contiguous on the final pass; entering exactly one ending is contiguous on that ending's pass; first-ending → second-ending succession occurs in no pass, and neither does the succession across a D.C./D.S. marker.

### 6A.3 Volta endings and `repeat_context`

| Selection shape | Valid? | `repeat_context` | Effective range |
|---|---|---|---|
| Entirely outside any volta group | valid | null | the mc interval |
| Enters (or lies wholly inside) exactly one ending | valid | that ending | mc interval minus all sibling-ending measures |
| Group wholly contained, **including** its repeat-start (the jump target) | valid | null | full mc interval, all endings included — the repeat structure is performable in full from within the fragment |
| Group wholly contained, but its repeat-start lies **outside** the selection | valid | final ending | mc interval minus non-final-ending measures — the jump back is unreachable from within the fragment, so the non-final endings never sound |
| One endpoint in ending N, the other in sibling ending M | **invalid — hard gate** | — | — |
| Anchored in a non-final ending, extended past its group | **invalid — hard gate** | — | — |

Note the two wholly-contained rows differ only in whether the repeat-start is inside the selection. A selection that starts *before* the volta group's repeat-start and runs past the group keeps both endings (row 3); one that starts *after* the repeat-start excludes the first ending exactly as if it had entered the second ending directly (row 4) — there is no configuration in which a fragment carries a first ending it cannot reach.

- **Effective range.** When sibling endings are excluded (rows 2 and 4), their measures leave the fragment's effective range even where they fall inside the raw mc interval (entering a second ending from the body necessarily spans the first ending's mc values). The committed ghost range, the bracket, the stage layout frame, the harmony-event query (via `repeat_context`, see `fragment-schema.md`), and fragment playback all operate on the effective range.
- **Discontiguous rendering.** Where the effective range skips an excluded ending, the bracket renders as segments with a visible gap over the excluded measures. A bracket painted continuously across an excluded ending — or extended over *other* endings elsewhere in the movement — is an I1 violation. Ghost keys are per-physical-measure (`m${n}-e${endingN}` measure keys and render-order beat encoding, ADR-005 G2 addendum); no derivation may aggregate ending measures by shared `@n`.
- **Stages** distribute over the effective range. A stage that straddles an excluded ending renders segmented, like the main bracket.
- **Repeat signs inside endings.** A first ending almost always closes with a `:|` barline; that barline is part of the volta group's structure, not a free-standing repeat. The rules in this section (and the playback rules in §6A.6) govern it via the group; the barline itself is never separately a selection gate (§6A.2), and no repeat-barline handling may shortcut the per-ending ghost keys. In particular, the clamp an annotator hits when extending a first-ending-anchored selection is the *ending-boundary* gate — the co-located `:|` is incidental.

### 6A.4 Stage geometry — hard rules

These hold at every resolution, in `contiguous` containment mode (the shipped mode for all current concepts); `free` mode differs only where stated.

- **I6 — One moving boundary.** A split-handle drag moves exactly one shared boundary. Every other stage boundary — and both main-bracket edges — holds its committed value for the duration of the gesture. Space freed by the shrinking stage is absorbed entirely by the stage on the growing side of the dragged handle; a far-side stage absorbing it is a bug.
- **I7 — Outer-edge pinning, exact.** First stage start ≡ main bracket start; last stage end ≡ main bracket end. Exactly — same ghost entry, not "within a grid unit" — at all resolutions, after every operation (drag, collapse, absent toggle, main resize, resolution change). Drift between a stage endpoint and the main ghost endpoint is a bug. (Restates §4 outer-edge pinning as a post-condition of *every* operation, not only pre-population.)
- **I8 — Containment by construction.** Stage bounds never exit the main bracket in contiguous mode. The "outside main bracket" checklist error (§7.5) exists for structural orphaning only (§6, concept change) — it is not a reachable state of any drag or resize.
- **Overlap prohibition.** Adjacent stages share a single boundary object holding a single grid-snapped value; both stages' geometry derives from that one value at every resolution. Overlap (and gap) is therefore impossible by construction in contiguous mode — including at beat and sub-beat resolution, where the shared value is a beat/sub-beat ghost key, not a pixel position. In `free` mode, overlap remains a checklist warning (§7.5), unchanged.
- **I9 — Commit or clamp; never bounce.** On mouseup, a drag commits the dragged boundary to the nearest legal grid-snapped position. If the cursor is in illegal territory (past a clamp limit, past a hard gate), the boundary clamps at the last legal snapped position — visibly, during the drag, not on release. A handle never reverts to its pre-drag position.
- **I10 — Minimum width and collapse.** Minimum stage width is one grid unit at the active resolution (§5). A drag squeezing a **required** stage clamps there (I9). A drag squeezing an **optional** stage past its minimum collapses it to absent — equivalent to the §4 absent toggle: its bracket disappears, the freed extent goes to the growing stage, and the gesture continues against the next boundary. Within the same gesture, dragging back past the collapse point restores the stage; the collapse commits only on mouseup.
- **I11 — Cross-system drags.** In a multi-system fragment a split handle reaches every system of the selection: the drag's target system is resolved from the **cursor's y position on every tick** (nearest system band — the switchover sits midway between adjacent systems), and x then resolves to the nearest boundary on that system. A handle is never confined to the system it started on. *(Added 2026-07-07, Component 9 Part 8 item 2 — the original implementation froze the drag-start system, and since that system always offers a candidate, cross-system targets were unreachable.)*

*As implemented (Component 9 Step 4, `stageFrame.ts`):* the stage layout frame is a **slot list** — one slot per grid unit of the selection's effective measure-key range at the active resolution (`buildStageSlots()`), with the selection's beat-precision endpoint filters applied, so the frame's ends are the main bracket's exact endpoints. K active stages are a partition of the slot list by K−1 interior boundary indices: the boundary index *is* the single shared value of the overlap-prohibition rule, and I7/I8 are properties of the partition rather than re-established post-conditions. `moveBoundary()` implements I6/I9/I10 as a total pure function (every cursor position maps to a legal clamped boundary vector; overtaken optional boundaries ride along with the drag; required stages bound the target by one slot). `StageBrackets` re-derives the displayed assignments from the gesture's *initial* frame on every drag tick, which is what makes mid-gesture collapse restoration (I10) automatic. Stage geometry, like the main bracket's, never consults `@n` intervals: a stage's bounds carry the physical measure keys of both boundaries (`StageBounds.keyStart`/`keyEnd`), and duplicate bar numbers elsewhere in the movement contribute nothing to a stage's pixels (STG-10) or its sub-part `mc` payload.

### 6A.5 Main-bracket resize with stages

The hybrid redistribution + clamp policy (§6, "Main bracket change after stages are committed") is retained and extended with three post-conditions:

- After redistribution, **I7 holds exactly**: the recomputed stage frame's outer edges coincide with the new main range, with no off-by-one-grid-unit drift at any resolution.
- A confirmed/active stage on the side **opposite** the dragged main handle keeps its absolute bounds, except where the hard-clamp + finer-grid escape-valve sequence forces proportional resizing — and then I7/I8 still hold.
- Redistribution is recomputed from the committed state, not incrementally from the previous render; repeated resizes must not accumulate error.

*As implemented (Component 9 Step 4):* `respondToMainResize()` (`stageFrame.ts`) rebuilds the slot frame from the new selection, pins every boundary flanked by a confirmed stage to its surviving slot (matched by measure key + beat onset — a resize on one side cannot move a confirmed stage on the other), redistributes unconfirmed runs by `default_weight` inside the gaps the anchors leave, and normalises the boundary vector so each required stage keeps one slot. I7 needs no outer-edge sync step: the frame's edges *are* the new selection's endpoints.

### 6A.6 Playback of fragments containing repeat structure

Because selections may cross repeat barlines (ADR-025), a fragment can contain a repeat directive whose jump target lies outside the fragment. The rule:

- A repeat structure **wholly inside** the fragment's effective range — repeat-start, repeat-end, and any endings — plays expanded: both passes, endings honoured, exactly as in full-movement playback (§6A.3 row 3).
- A repeat-end whose **paired repeat-start lies outside** the fragment is **ignored**: playback uses **final-pass semantics** — no jump, the fragment plays once, straight through its effective range, as the music sounds the last time through. When the truncated repeat has volta endings, this is already settled at the selection layer: §6A.3 row 4 excludes the non-final endings from the effective range, so playback simply plays what remains (the final ending), with no further special-casing.
- Da capo / dal segno: a selection cannot cross a D.C./D.S. marker (§6A.2), so the only reachable case is a fragment whose last bar carries the directive. The directive is ignored; playback ends at the fragment boundary.

This is a fragment-playback rule only; full-movement playback is unchanged (`playback-coordinates.md` § Repeat policy).

**Play-from-position in tag mode (Step 20).** `Alt`-click (Option-click) on a measure is reserved for measure-level play-from-position and is **never** a selection action: the annotator bails out of the selection drag on an `Alt`-modified mousedown and hands the enclosing measure key to the play-from-position handler (a beat / sub-beat ghost resolves up to its measure). Plain click is unchanged. This is the same gesture the read-only score viewer uses, so it works identically whether or not tagging is active. Full spec: `playback-coordinates.md` § Play-from-position.

### 6A.7 Edge-case register

- **Partial bars (split measures, `@metcon="false"`).** Each half is an ordinary, independently selectable measure at every resolution; an endpoint on either half is legal; the bracket covers exactly the committed half. Unique per-physical-measure ghost keys (render-order index, G2.3) are the mechanism; any geometry keyed on `@n` alone will paint unrelated partial bars and violates I1.
- **Pickup bar.** `@n="0"`, `mc=1`; an ordinary measure, selectable at all resolutions; `bar_start=0` is valid (see `playback-coordinates.md` § Pickup bar handling).
- **Unparseable `@n` (MuseScore `X1`-style excluded-measure numbers).** The normalizer flags these but cannot auto-correct them (`mei-ingest-normalization.md`), so the live corpus contains them (K331/iii, K279/iii). The client's bar-number derivation is guarded: such a measure adopts the nearest preceding finite `@n` as its display bar (the DCML mn-sharing convention — the half-bar displays under the bar it completes), with the deduplicated per-physical-measure key (`#N` suffix) keeping it a distinct, independently selectable measure and `mc` keeping the exact machine coordinate. `parseInt(@n) → NaN` flowing into coordinates was the root cause of the SEL-04/SEL-05 family; under I2 it can no longer be constructed. The display-bar ambiguity disappears when Step 8 renumbers these measures corpus-side (the §7 normalization convention already mandates unique sequential integers).
- **Empty measure (no note onsets).** At measure resolution: a normal ghost. At beat/sub-beat resolution the only-struck-beats rule (ADR-005) would leave an unselectable hole; the spec adds a **synthetic whole-measure ghost** — one selectable unit spanning the measure — so a range can pass through or terminate there. An endpoint in an empty measure is measure-precise: as a start it contributes `beat_start = 1.0`; as an end it contributes the measure's full extent.
- **Sub-beat endpoints.** The bracket ends exactly at the committed sub-beat boundary: no rounding up to complete the beat, no dropping the final measure when the endpoint is that measure's first sub-beat. (Both are I1 violations.)
- **Resolution mismatch states.** None exist. Per I3, the toggle can never produce a state where bracket and ghost disagree, so SEL-02's "repair by clicking another resolution" behaviours disappear along with the bug they repaired.
- **Stage initialisation.** Stage brackets pre-populate immediately on concept select (§4). A state where stages exist in the model but render only after a main-fragment resize is a bug — covered by §6A.1's derive-on-every-render discipline.

### 6A.8 Fixture → rule map

| Fixture(s) | Governing rule |
|---|---|
| SEL-01, SEL-03, SEL-08 | I1 + partial-bar ghost keys (§6A.7) |
| SEL-02 | I3 |
| SEL-04, SEL-05, SEL-07 | I2 (+ I1 for the bracket symptoms) |
| SEL-06 | Empty-measure synthetic ghost (§6A.7) |
| SEL-09, SEL-10, SEL-14 | I1 sub-beat endpoints (§6A.7) |
| SEL-11 | Obsolete — ADR-025 removes repeat-barline gates entirely |
| SEL-12, SEL-13 | §6A.3 effective range + per-ending ghost keys |
| STG-01, STG-03 | I6 |
| STG-04 | I9 |
| STG-06, STG-07 | I7 + §6A.5 |
| STG-08 | §6A.5 opposite-side preservation |
| STG-09 | §6A.7 stage initialisation |
| STG-10 | Overlap prohibition + I8 |

---

## 7. Form Panel

### 7.1 Concept picker

The concept picker sits at the top of the form panel. It provides:

- A **search box** with fuzzy matching against concept names and aliases.
- A **hierarchy browser** (expandable tree of `IS_SUBTYPE_OF` relationships) for navigating unfamiliar areas of the graph.
- **Domain facets** (`Cadence`, `Sequence`, `Schema`, `Formal Function`, etc.) for narrowing results.

The picker only surfaces concepts where `stub: false` and `top_level_taggable: true` (see `knowledge-graph-design-reference.md`). Stub nodes and nodes that exist only as stage targets are excluded.

**Result ordering (G5.3 / ADR-020):** the server returns results pre-sorted by `(complexity_rank, prereq_depth, score DESC, name ASC)`. The client renders them in the order received and never re-sorts by score.

- `complexity_rank` — `foundational` < `intermediate` < `advanced` < unset. Foundational concepts always appear at the top of any search result, regardless of full-text score.
- `prereq_depth` — count of distinct ancestor concepts that have a `PREREQUISITE_FOR` path leading to this concept. Within a complexity band, a concept that is a prerequisite for others (depth 0 or lower) sorts before its dependents. For example, PAC (prerequisite for IAC, prereq_depth=0) appears before IAC (prereq_depth=1) within the foundational band.
- `score DESC` — full-text relevance; tiebreaker within same band and prereq_depth.
- `name ASC` — alphabetical final tiebreaker.

### 7.2 Type Refinement section

Shown **only** when the selected concept has direct `IS_SUBTYPE_OF` children whose `CONTAINS` structures differ from one another (i.e. choosing among the children changes which stage brackets appear). Shown at the top of the form, before properties, because the choice reshapes everything below it.

Rendered as a compact radio group or segmented button labelled with the child concept names. Selecting a child:

- Updates the active concept for stage-panel purposes (the selected concept in the picker stays as the parent; the refinement is a display-layer decision).
- Re-evaluates which stage brackets are shown (§6, "Concept change after stages are committed").
- The Type Refinement choice is stored in the submission payload alongside the concept ID, so the server can record which subtype was identified.

If the children differ only in property values (not in stage structure), Type Refinement is not shown — the variation is handled via the property form.

### 7.3 Stage list

Shown when the selected concept (including any Type Refinement) has `CONTAINS` edges. One card per stage, **ordered by physical position in the score** (bar, then beat; absent stages grouped last) — not by the abstract `order` edge property (Component 9 G2). During a split-handle drag the display order **freezes** at its pre-drag state, resorting once on release, so cards never jump around mid-gesture (Component 9 Part 8 item 4).

Each card shows *(trimmed to essentials, Part 8 item 4 — the "Stages" interaction explanation lives behind an (i) hover affordance on the section heading rather than a permanent paragraph)*:

- Stage concept name and colour swatch (matching its bracket track colour; colour keyed to the schema `order` so it is stable as position moves the card).
- Required / optional indicator.
- For **optional stages**: an absent toggle. Toggling absent collapses the bracket and redistributes space in contiguous mode (§4). Toggling back expands the bracket at the shared boundary, robbing space from the neighbours.
- Status labels only when needed: absent, orphaned, or bounds-error. Spatial bounds are **not** repeated on the card — they are visible on the score brackets themselves (changed in Part 8 item 4; the card previously mirrored the live bounds).
- For **compound stages**: the card expands to show the sub-stage segment labels.

Clicking anywhere on a stage card highlights and centres the corresponding bracket in the score.

#### Stage-level property form

Each stage concept may carry `HAS_PROPERTY_SCHEMA` edges of its own. Every present stage card (not absent, not orphaned) shows an **always-open** inline property form generated from those schemas — using the same control types as the main property form (§7.4): radio groups or selects for `ONE_OF`, checkboxes or multiselects for `MANY_OF`, toggles for `BOOL`. *(Changed in Component 9 Part 8 item 4: the form previously opened only while its card was active, which was tedious — every stage needs the form — and easy to overlook entirely. Activation now only highlights.)*

Every stage confirmed as present (required, or optional and not toggled absent) becomes a **child fragment** on submission, whether or not its property form was filled. Stage schemas are `required: false`; property completion is not a prerequisite for the child fragment to be created. A child fragment's `summary.properties` will be an empty object if no stage properties were recorded — the fragment's existence is the assertion of presence and location; the properties are optional enrichment.

No concept picker is shown. The child fragment's `concept_id` is the stage concept's own id (e.g. `CadentialPreDominant`), implicit from the stage bracket's graph metadata. The atomic write described in §9 covers the parent cadence fragment and all stage child fragments in one transaction.

### 7.4 Property form

Generated dynamically from the selected concept's `HAS_PROPERTY_SCHEMA` edges, traversed up the `IS_SUBTYPE_OF` hierarchy. Schema nodes inherited from ancestors are included; they do not need to be re-attached to each subtype.

Layout within the property form:

1. **Required properties** (PropertySchema with `required: true`) — displayed first. A missing value here blocks submission.
2. **Optional properties** (PropertySchema with `required: false`) — displayed after, visually separated.

Control type by PropertySchema `cardinality` (threshold applies to both):

- `ONE_OF` → radio group (≤ 2 values) or compact single-select popover (> 2 values).
- `MANY_OF` → checkbox group (≤ 2 values) or compact multi-select popover (> 2 values).
- `BOOL` → binary on/off toggle. Starts `null` (never-touched; valid to submit for optional schemas). After first interaction cycles `true ↔ false` and never returns to null. Both `null` and `false` render with the same "off" visual; the distinction is preserved in the payload for optional-field semantics.

The stage property form (§6, inline card) uses the same control types.

For PropertyValues that carry a `VALUE_REFERENCES` edge: an inline info-link (ⓘ) opens a tooltip or inline panel showing the referenced concept's name and definition. This is helpful for elaboration types (e.g. distinguishing Cadential 6-4 from Applied Dominant from within the CadentialElaboration property).

### 7.5 Submission checklist

A small, always-visible checklist at the bottom of the form panel. Updates live:

| Item | Blocking? |
|---|---|
| Fragment drawn | Yes |
| Concept selected | Yes |
| Type Refinement set (if applicable) | Yes |
| Stages complete (if applicable — see note) | Yes |
| Required properties all set | Yes |
| Stage bounds within main bracket | Yes |
| Stage gaps / overlaps (free containment mode only) | Warning only |

Items with warnings (non-blocking) are listed with a ⚠ icon. Items blocking submission show ✗. The Submit button is disabled until all blocking items are resolved.

**Stages row conditionality.** The "Stages complete" row is shown only when **both** of these are true:
1. The selected concept has `CONTAINS` edges (`conceptHasStages = schemaTree.stages.length > 0`).
2. The main fragment bracket has been drawn (`flags.fragmentSet = true`), meaning stages have been pre-populated.

Before a concept is selected, for stageless concepts, or before a fragment bracket is drawn (stages not yet pre-populated), the row is suppressed entirely.

**Semantics of "Stages complete."** The row is checked when all non-orphaned, non-absent stages have valid bounds and no error flag:
- **Required stages**: auto-satisfied by `prePopulateStages()` — they always get bounds.
- **Optional stages**: pre-populated positions are valid data; dragging to refine is optional, not required for submission. Toggling absent is the way to mark a stage not present.
- **Error state** (`bounds` outside the main bracket): blocks the row regardless of stage type.

In practice the row is checked immediately after pre-population unless a stage has been dragged outside the main bracket. Implemented via `computeStagesComplete()` in `stages.ts`; the `confirmed` flag on a stage assignment is preserved for visual/tracking purposes but does not gate the checklist item. See Component 7 Step 1.

---

## 8. Stageless Concepts

Concepts with no `CONTAINS` edges — a Topic (Hunting Horn), a Rhetorical Figure (Lamento), a Sequence type — follow a simpler flow: draw fragment, select concept, fill property form, submit. Layer 4 (stage bracket track) never activates. The form panel shows only the concept picker and property form. The stage list and Type Refinement section are not rendered.

The state machine simplifies accordingly: `stagesComplete` is trivially true for any stageless concept, so submission requires only `fragmentSet`, `conceptSet`, and `propertiesComplete`.

---

## 9. Validation and Save States

**Save Draft** commits the current annotation state to the database with `status: 'draft'`. All fields may be incomplete. The annotation is saved exactly as-is, including partially-assigned stages and missing properties. Drafts can be resumed in a later session. **The working state is preserved** — selection, ghosts, concept, stages, and properties all stay on screen so the annotator can keep editing — and the feedback is deliberately quiet: a persistent "Draft saved" note under the checklist.

**Submit for Review** requires all blocking checklist items to be resolved. Sets `status: 'submitted'`. **On success the surface resets to its initial blank state** (selection cleared, ghosts removed, form remounted) and an unmissable confirmation banner is raised over the score. This is the post-condition that distinguishes Submit from Save Draft: a submitted fragment is immutable until a reviewer acts, so there is nothing left to edit, and the annotator must be left in no doubt that the submission landed before starting the next one.

**As implemented (Component 9 Step 5).** Submit and Save Draft previously converged on the same end state — a brief "Draft saved" flash, no reset — which left annotators unsure whether a submission had succeeded. They are now differentiated as above. The reset is `resetAnnotation()` in `ScoreViewer.tsx`, shared with the Delete control (§6 G1.2); the confirmation is a `submitSuccess` banner owned by `ScoreViewer` (so it survives the form remount), auto-dismissed after a few seconds, cleared the moment a new selection begins, and manually dismissible. The intermediate "Draft saved" note is suppressed while a Submit is in flight (`SubmissionChecklist.tsx`), since Submit creates/updates the draft as an internal step and the note would otherwise flash mid-submit; the Submit button's own "Submitting…" state is the feedback during that window. The banner uses the submitted-status token family (`secondary`), per the Step 17 status-colour mapping.

The server writes parent and all child fragment records atomically in a single transaction. Partial submissions are not possible — if any child write fails, the transaction is rolled back.

**Containment constraint enforcement**: the server validates that every child fragment's spatial bounds fall within the parent fragment's bounds. This is a service-layer check (not a database constraint) applied before the transaction begins.

---

## 10. Relation to ghost.js / annotator.js

The ghost overlay architecture carries over as described in `docs/architecture/prototype-tagging-tool.md`. The two-file structural/behavioural split is preserved.

What is new relative to the prototype:

- **Layer 4 (stage bracket track)** is a new SVG group layer, created dynamically when `conceptSet` becomes true. It is not a ghost layer — no pre-built spatial index is needed, because stage brackets are constrained to the main bracket bounds and their count is small. Stage bracket elements are created and removed imperatively.
- **Layer 5 (active-stage beat sub-selection)** requires `addSuperGhosts` (or a new variant) to accept a range constraint, activating beat ghosts only within a specified bar/beat window rather than the full main bracket.
- **The `Annotation` class** in annotator.js is substantially replaced: the new state model (§2) and the form panel coupling (§7) require a richer session object. The prototype's `Annotation` class can serve as a reference for the mousedown/enter/up interaction pattern but not as a structural base.
- **Event delegation** replaces the prototype's per-element `addListeners` pattern, as noted in the prototype analysis transfer table.

---

## 11. Implemented in Component 5

This section maps each design section above to the shipped modules. It is updated as implementation lands; use it to navigate to the relevant source when the design and code diverge.

| Design section | Shipped module(s) |
|---|---|
| §2 State model (concurrent flags) | `frontend/src/components/score/selection.ts` |
| §3 Layer 2 — Ghost overlay | `frontend/src/components/score/ghosts.ts` |
| §3 Layer 3 — Main bracket track | `frontend/src/components/score/MainBracket.tsx` |
| §3 Layer 4 — Stage bracket track | `frontend/src/components/score/StageBrackets.tsx` |
| §4 Stage pre-population and grid snapping | `frontend/src/components/score/stages.ts` |
| §5 Selection grid (resolution toggle) | `frontend/src/components/score/ghosts.ts` (layer switching), `frontend/src/components/score/annotator.ts` (toggle handler) |
| §6 Interaction model (drag, split-handle, endpoint re-selection) | `frontend/src/components/score/annotator.ts` |
| §7.1 Concept picker | `frontend/src/components/score/ConceptPicker.tsx` |
| §7.2 Type Refinement | `frontend/src/components/score/TypeRefinement.tsx` |
| §7.3 Stage list and absent toggle | `frontend/src/components/score/StageList.tsx` |
| §7.3 Stage-level property form | `frontend/src/components/score/SubPartForm.tsx` |
| §7.4 Property form (ONE_OF / MANY_OF / BOOL) | `frontend/src/components/score/PropertyForm.tsx`, `frontend/src/components/score/propertyFormHelpers.ts` |
| §7.5 Submission checklist | `frontend/src/components/score/SubmissionChecklist.tsx` |
| §9 Validation and save states | `frontend/src/components/score/FormPanel.tsx` (client); `backend/services/fragment_validation.py`, `backend/services/fragments.py` (server) |
| §10 Form panel (aggregates all panels) | `frontend/src/components/score/FormPanel.tsx` |
| Harmony summary panel (Step 16) | `frontend/src/components/score/HarmonyPanel.tsx` |
| Backend — concept search (Step 3) | `backend/services/concepts.py`, `backend/api/routes/concepts.py` |
| Backend — schema-tree endpoint (Step 4) | `backend/services/concepts.py`, `backend/api/routes/concepts.py` |
| Backend — write validation (Step 5) | `backend/services/fragment_validation.py` |
| Backend — fragment submission endpoints (Step 6) | `backend/services/fragments.py`, `backend/api/routes/fragments.py` |
| Backend — harmony-event correction (Step 7) | `backend/services/analysis.py`, `backend/api/routes/movements.py` |
| Backend — review state machine (Step 8) | `backend/services/fragments.py`, `backend/api/routes/fragments.py` |

---

## 12. Implemented in Component 7

Component 7 shipped the tagging-tool carry-in fixes (§§4–6 behaviour), the CRUD backend, the on-score stored-fragment display, the review loop UI, and the harmony panel completion (G6.2 / G6.3). The table below maps those additions to their shipped modules.

| Design area / step | Shipped module(s) |
|---|---|
| §4 Stage pre-population auto-drop grid (Step 2) | `frontend/src/components/score/stages.ts` (`chooseStageGrid`) |
| §6 Hybrid main-resize / active-stage clamp (Step 3) | `frontend/src/components/score/stages.ts`, `frontend/src/components/score/StageBrackets.tsx`, `frontend/src/components/score/StageList.tsx` |
| §6 Beat/sub-beat stage geometry (Step 4) | `frontend/src/components/score/stages.ts`, `frontend/src/components/score/StageBrackets.tsx` |
| §6 Handle-affordance lock during stage resize (Step 5) | `frontend/src/components/score/annotator.ts`, `frontend/src/components/score/ghosts.ts`, `frontend/src/components/score/StageBrackets.tsx` |
| §7.5 Stages checklist row conditionality (Step 1) | `frontend/src/components/score/SubmissionChecklist.tsx` |
| Score-title first-system bracket nudge (Step 6) | `frontend/src/routes/ScoreViewer.tsx` |
| Backend — fragment read endpoints (Step 7) | `backend/services/fragments.py`, `backend/api/routes/fragments.py`, `backend/api/routes/movements.py` |
| Backend — fragment update + revision semantics (Step 8) | `backend/services/fragments.py`, `backend/api/routes/fragments.py` |
| Backend — fragment delete + cascade (Step 9) | `backend/services/fragments.py`, `backend/api/routes/fragments.py` |
| On-score stored-fragment overlay — projection layer (Step 10) | `frontend/src/components/score/FragmentOverlay.tsx` |
| On-score stored-fragment overlay — brackets, labels, collapsed/expanded (Step 11) | `frontend/src/components/score/FragmentOverlay.tsx` |
| Fragment side panel — record view, edit, delete (Step 12) | `frontend/src/routes/ScoreViewer.tsx`, `frontend/src/components/score/FragmentDetailPanel.tsx` |
| Review queue (Step 13) | `backend/api/routes/reviews.py`, `frontend/src/routes/ReviewQueue.tsx` |
| Approve/reject in side panel + gate feedback (Step 14) | `frontend/src/components/score/FragmentDetailPanel.tsx` |
| G6.2 Harmony panel clarity (Step 15) | `frontend/src/components/score/HarmonyPanel.tsx` |
| G6.3 In-score chord label overlay (Step 16) | `frontend/src/components/score/harmonyOverlay.ts`, `frontend/src/components/score/harmonyOverlay.module.css` |
