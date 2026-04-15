# Tagging Tool — Multi-Level Design Reference

**Status:** Active  
**Date:** 2026-04-15  
**Supersedes:** `docs/architecture/multi-level-tagging-draft.md`  
**See also:** `docs/architecture/prototype-tagging-tool.md` (prototype analysis, ghost layer architecture), `docs/adr/ADR-005-sub-measure-precision.md` (selection grid and sub-beat encoding)

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

### Grid snapping

Default positions are computed in score-space coordinates and then **snapped to the currently active selection grid** (see §5). The stage bracket boundaries align to the nearest grid position — beat boundaries if the grid is at beat resolution, eighth-note boundaries if at sub-beat resolution. This means a stage that by raw proportion would end at beat 2.3 snaps to beat 2 or beat 2.5 depending on the active grid.

Snapping resolves left-to-right: each stage is snapped in sequence, with the right boundary of stage N becoming the left boundary of stage N+1. The rightmost stage's right boundary is pinned to the main bracket's right boundary, absorbing any rounding remainder.

### Required stages

Required stages (`required: true` on the `CONTAINS` edge) appear as **solid, fully-interactive brackets**. They are immediately draggable. They must have spatial assignments before the tag can be submitted.

### Optional stages

Optional stages (`required: false`) appear as **dashed brackets** at their proportional default positions. They behave as required brackets by default — the user drags them to confirm and refine their bounds. Making a stage solid by dragging it is the primary way to confirm an optional stage is present.

An **absent toggle** in the stage list in the form panel (§7.3) lets the user explicitly mark an optional stage as not present in this instance. Toggling absent:

- Collapses the stage bracket to zero width (it disappears from the track).
- In `contiguous` mode, the absent stage's proportional share is redistributed to its neighbours, shifting the split handle between them.
- The bracket reappears (at its neighbours' current boundary) if the user re-enables the stage, and the neighbours' shared boundary shifts back to accommodate it.

An optional stage that has not been explicitly marked absent and has not been dragged from its default position is in a limbo state — neither confirmed present nor absent. **Submission is blocked while any optional stage is in this limbo state.** The submission checklist (§7.5) flags this explicitly. The user must either drag the bracket (confirming presence and refining its bounds) or toggle it absent.

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

### Concept change after stages are committed

If the user changes the selected concept after stage brackets have been drawn, the system attempts to preserve as much work as possible:

- Stages whose concept ID exists in the new concept's `CONTAINS` structure are kept at their current spatial positions.
- Stages from the old concept with no counterpart in the new structure are shown as **orphaned** — greyed out with a warning icon — until the user explicitly dismisses them (they are not submitted).
- Required stages from the new concept with no matching existing bracket receive default pre-populated placeholders (§4).

Type Refinement changes (§7.2) follow the same logic: sub-stage brackets that survive the structural change are preserved; those that do not are orphaned.

### Main bracket change after stages are committed

If the user extends the main bracket, the outermost stage brackets (first and last in order) auto-extend to fill the new space.

If the user contracts the main bracket so that it no longer fully contains a stage bracket, the affected stage brackets are shown in an error state (a distinct visual style — e.g. red border). Submission is blocked until the user either expands the main bracket to re-contain all stages, or trims the affected stage brackets to fit within the new main bounds.

### Bidirectional linking (score ↔ form)

- When the user drags or clicks a stage bracket in the score, the corresponding stage card in the form panel scrolls into view and highlights.
- When the user clicks a stage card in the form panel, the score view centres on that bracket and highlights it briefly.

---

## 7. Form Panel

### 7.1 Concept picker

The concept picker sits at the top of the form panel. It provides:

- A **search box** with fuzzy matching against concept names and aliases.
- A **hierarchy browser** (expandable tree of `IS_SUBTYPE_OF` relationships) for navigating unfamiliar areas of the graph.
- **Domain facets** (`Cadence`, `Sequence`, `Schema`, `Formal Function`, etc.) for narrowing results.

The picker only surfaces concepts where `stub: false` and `top_level_taggable: true` (see `knowledge-graph-design-reference.md`). Stub nodes and nodes that exist only as stage targets are excluded.

### 7.2 Type Refinement section

Shown **only** when the selected concept has direct `IS_SUBTYPE_OF` children whose `CONTAINS` structures differ from one another (i.e. choosing among the children changes which stage brackets appear). Shown at the top of the form, before properties, because the choice reshapes everything below it.

Rendered as a compact radio group or segmented button labelled with the child concept names (e.g. "Simple / Compound" for `PreDominant`). Selecting a child:

- Updates the active concept for stage-panel purposes (the selected concept in the picker stays as the parent; the refinement is a display-layer decision).
- Re-evaluates which stage brackets are shown (§6, "Concept change after stages are committed").
- The Type Refinement choice is stored in the submission payload alongside the concept ID, so the server can record which subtype was identified.

If the children differ only in property values (not in stage structure), Type Refinement is not shown — the variation is handled via the property form.

### 7.3 Stage list

Shown when the selected concept (including any Type Refinement) has `CONTAINS` edges. One card per stage, ordered by `order` edge property.

Each card shows:

- Stage concept name and colour swatch (matching its bracket track colour).
- Required / optional indicator.
- Current spatial bounds, updated live as the user drags (`bar 4 b2 – bar 5 b1`).
- For **optional stages**: an absent toggle. Toggling absent collapses the bracket and redistributes space in contiguous mode (§4). Toggling back expands the bracket at the shared boundary, robbing space from the neighbours.
- For **compound stages**: the card expands to show the sub-stage segment labels and their individual bounds.

Clicking anywhere on a stage card highlights and centres the corresponding bracket in the score.

### 7.4 Property form

Generated dynamically from the selected concept's `HAS_PROPERTY_SCHEMA` edges, traversed up the `IS_SUBTYPE_OF` hierarchy. Schema nodes inherited from ancestors are included; they do not need to be re-attached to each subtype.

Layout within the property form:

1. **Required properties** (PropertySchema with `required: true`) — displayed first. A missing value here blocks submission.
2. **Optional properties** (PropertySchema with `required: false`) — displayed after, visually separated.

Control type by PropertySchema `cardinality`:

- `ONE_OF` → radio group (≤ 5 values) or select dropdown (> 5 values).
- `MANY_OF` → checkbox group or multiselect.

For PropertyValues that carry a `VALUE_REFERENCES` edge: an inline info-link (ⓘ) opens a tooltip or inline panel showing the referenced concept's name and definition. This is helpful for elaboration types (e.g. distinguishing Cadential 6-4 from Applied Dominant from within the CadentialElaboration property).

### 7.5 Submission checklist

A small, always-visible checklist at the bottom of the form panel. Updates live:

| Item | Blocking? |
|---|---|
| Fragment drawn | Yes |
| Concept selected | Yes |
| Type Refinement set (if applicable) | Yes |
| Required stages all assigned | Yes |
| Optional stages all confirmed present or absent | Yes |
| Required properties all set | Yes |
| Stage bounds within main bracket | Yes |
| Stage gaps / overlaps (free containment mode only) | Warning only |

Items with warnings (non-blocking) are listed with a ⚠ icon. Items blocking submission show ✗. The Submit button is disabled until all blocking items are resolved.

---

## 8. Stageless Concepts

Concepts with no `CONTAINS` edges — a Topic (Hunting Horn), a Rhetorical Figure (Lamento), a Sequence type — follow a simpler flow: draw fragment, select concept, fill property form, submit. Layer 4 (stage bracket track) never activates. The form panel shows only the concept picker and property form. The stage list and Type Refinement section are not rendered.

The state machine simplifies accordingly: `stagesComplete` is trivially true for any stageless concept, so submission requires only `fragmentSet`, `conceptSet`, and `propertiesComplete`.

---

## 9. Validation and Save States

**Save Draft** commits the current annotation state to the database with `status: 'draft'`. All fields may be incomplete. The annotation is saved exactly as-is, including partially-assigned stages and missing properties. Drafts can be resumed in a later session.

**Submit for Review** requires all blocking checklist items to be resolved. Sets `status: 'submitted'`.

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
