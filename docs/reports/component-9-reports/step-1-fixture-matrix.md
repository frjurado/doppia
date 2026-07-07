# Step 1 — Selection & Stages: Symptom Catalogue and Fixture Matrix

Fixture matrix for Part 1 of Component 9 (see `component-9-corpus-population-and-hardening.md` § Step 1).

Each row captures one observable symptom from `various-issues.md` §§ "Basic fragment selection" and "Stages". Columns are filled in through live reproduction against the corpus; blank cells (`—`) are left for Francisco (or the reproducing session) to complete.

**Coordinate layer vocabulary** (per Step 1 spec):  
`ghost-index` · `bracket-geometry` · `human-coord-lookup` · `api`

**Status vocabulary:**  
`to reproduce` · `reproduced` · `spec'd` · `fixed` · `verified` · `obsolete` (resolved by a spec decision rather than a fix)

> **Step 2 note (2026-06-12):** all reproduced fixtures are now governed by explicit rules in `tagging-tool-design.md` §6A (see the fixture → rule map in §6A.8); statuses advanced to `spec'd`. SEL-11 is `obsolete`: ADR-025 removes repeat-barline gates entirely, so the observed repeat-start behaviour is now the specified behaviour for both barline directions (the repeat-end gate is removed in Step 3).
>
> **Step 3 note (2026-06-12):** the main-selection fixes are implemented and unit-tested; all SEL fixtures advance to `fixed`. The shared root cause was geometry and coordinate derivation keyed on `@n` intervals plus `parseInt(@n) → NaN` for X-numbered measures; the fix derives everything from the committed measure-key list (§6A.1): `walkMeasureKeys()` (guarded `barN`, deduplicated keys, mc) feeds ghosts, barriers, volta index, and mc index from one walk; `computeSelectionKeys()` implements the §6A.2 gates and §6A.3 effective-range exclusions; `resolveSegments()` renders key-based, discontiguous bracket segments; `commitSelection()` rejects any non-finite coordinate (I2) and `HarmonyPanel` guards the request. Sub-beat endpoints use per-entry `endFloat` (SEL-09/10/14); empty measures get a synthetic whole-measure ghost (SEL-06).
>
> **Verification (2026-06-12):** Francisco re-checked every SEL fixture against the live corpus at the K283/K331/K279/K332 fixture locations; all pass. Statuses advanced to `verified`.
>
> **Step 4 note (2026-06-13):** the stage-interaction fixes are implemented and unit-tested; STG fixtures advance to `fixed`. The interaction core is rebuilt as a **stage layout frame** (`stageFrame.ts`, §6A.4 as-implemented): the selection's effective key range becomes a slot list, stages partition it via shared boundary indices, and `moveBoundary()` is a total commit-or-clamp function. That makes the fixes structural rather than per-symptom — STG-01/03 (the old collapse path routed through `toggleStageAbsent`'s left-first absorption regardless of drag direction; freed space now goes to the growing side by construction), STG-04 (the drag pipeline had "return unchanged" escape paths plus a snap-tolerance failure that the UI re-committed as the drag-start state; the new pipeline has no such sentinel and the collapse no longer kills the gesture mid-drag), STG-06/07/08 (`respondToMainResize()` rebuilds the frame from committed state with confirmed boundaries pinned by slot identity; outer edges are the new selection's endpoints, so I7 drift is unrepresentable), STG-10 (stage geometry was keyed on `@n` intervals like the pre-Step-3 main bracket; slots derive from committed keys, and overlap is impossible in the partition). `prePopulateStages`/`chooseStageGrid` count effective keys instead of bar spans, and sub-part `mc` payloads resolve through the bounds' measure keys. STG-09 was never reproduced; the frame derives stage geometry from props on every render, so the suspected stale-until-resize state has no mechanism left — kept at `to reproduce` pending corpus verification. Spec tests: `stageFrame.test.ts` (34 cases encoding the §6A.4 collapse table and §6A.5 redistribution post-conditions).
>
> **Verification (2026-06-13):** Francisco re-checked every STG fixture against the live corpus at the K279/i mm. 1–4, K332/i mm. 18–20, and K331/i fixture locations; all pass. Statuses advanced to `verified`.

---

## Section 1 — Basic Fragment Selection

| ID | Summary | Score location | Resolution | Action sequence | Observed result | Suspected layer(s) | Status |
|---|---|---|---|---|---|---|---|
| SEL-01 | Partial-bar endpoint + repeat-end: bracket avoids the partial bar at sub-beat, but not at measure/beat | K283 mvt. 1, m. 51-53 & m. 118-120 (before repeat barlines) | sub-beat (measure/beat OK) | Choose sub-beat resolution; select a fragment whose end falls on a partial bar immediately before a repeat-end barline (selecting & then changing to sub-beat resolution looks ok)  | Ghost covers full intended range; bracket stops short of the partial bar | `bracket-geometry` | verified |
| SEL-02 | From SEL-01 state: clicking measure resolution inflates bracket to ghost; clicking beat resolution deflates ghost to bracket | (same as SEL-01) | sub-beat → measure / sub-beat → beat | From the SEL-01 mismatched state, switch to measure resolution; then from the same state switch to beat resolution | Measure click: bracket expands to ghost range. Beat click: ghost shrinks to bracket range | `bracket-geometry`, `ghost-index` | verified |
| SEL-03 | K331/iii (Alla turca): bracket extends over ALL partial bars after a repeat barline, not just the selected one | K331 mvt. 3, m. 6-8 (before repeat barline), m. 22-24, etc. | beat/sub-beat (measure OK) | Select a fragment ending on a partial bar before a repeat barline | Ghost correct; bracket stretches to cover all subsequent partial bars after repeat barlines (not the initial pickup) | `bracket-geometry` | verified |
| SEL-04 | Initial partial bar after repeat sign: bracket absent, harmony panel shows "Request validation failed"; NaN in API request | K331 mvt. 3, m. 8-10; K279 mvt. 3, m. 56-58 | measure | Select a fragment that starts on the partial bar immediately after a repeat-start barline, plus some following bars | Ghost visible; bracket not rendered; harmony panel: "Request validation failed"; Fly logs: `GET …/analysis/events?bar_start=NaN&bar_end=<n>` → 422 | `human-coord-lookup`, `api` | verified |
| SEL-05 | Alla turca variant of SEL-04: bracket covers the entire movement | K331 mvt. 3, m. 8-10; K279 mvt. 3, m. 56-58 | beat/sub-beat | Same as SEL-04 | Bracket rendered over the whole movement; same failure shown in sidebar, same logs | `bracket-geometry`, `human-coord-lookup` | verified |
| SEL-06 | Empty bar gets no beat or sub-beat ghost | K283 mvt. 1, m. 53-55 | beat & sub-beat | Select beat or sub-beat resolution; select a fragment including a completely empty measure (53 after repeat barline) | The measure is un-selectable | `ghosts` (unintended consequence of no-note-no-ghost rule) | verified |
| SEL-07 | Including a second repeat bar triggers "Request validation failed" | K331 mvt. 1, m. 98 (2nd ending)-99 | all | Extend a selection to include a second repeat measure | Harmony panel: "Request validation failed"; as in SEL-04/05, in measure resolution there is no bracket, in beat/sub-beat the bracket covers all movement | `human-coord-lookup`, `api` | verified |
| SEL-08 | Pickup + subsequent bars: bracket appears on the selected fragment AND on all separate partial bars after barlines | K331 mvt. 3, m. 0-2 | beat or sub-beat (not measure) | At beat or sub-beat resolution, select a fragment starting on the pickup bar and extending into the main body | Ghost correct; bracket painted on selection plus every unrelated partial-after-barline segment in the movement | `bracket-geometry` | verified |
| SEL-09 | Sub-beat selection ending on the first sub-beat of a measure: bracket fails to reach that last measure | K279 mvt. 1, m. 2-4 | sub-beat | Select a range whose last point is the first sub-beat of a measure | Ghost reaches the measure; bracket stops one sub-beat short | `bracket-geometry` | verified |
| SEL-10 | Variant of SEL-09: sub-beat selection ending on the third sub-beat of a measure: bracket over-reaches to the next sub-beat (completes the beat) | K279 mvt. 1, m. 2-4 | sub-beat | Select a range whose last point is the third sub-beat of a measure (this is the one I found, not sure being the third one is relevant) | Ghost works ok; bracket extends one extra sub-beat | `bracket-geometry` | verified |
| SEL-11 | Repeat-start is not a selection barrier (asymmetric with repeat-end) | Any movement with a repeat-start barline | any | Drag selection across a repeat-start barline | Selection crosses repeat-start freely; repeat-end blocks | `ghost-index` (boundary rule absent) | obsolete (ADR-025: no repeat-barline gates either side; repeat-end gate removed in Step 3) |
| SEL-12 | Beat/sub-beat selection entering a first-ending bar: bracket extends to both endings plus all subsequent second endings | K331 mvt. 1, m. 97-98 | beat or sub-beat | At beat or sub-beat resolution, start or end a selection inside a first-ending measure | Bracket covers first ending, second ending(s), and second endings elsewhere in the movement | `bracket-geometry`, `human-coord-lookup` | verified |
| SEL-13 | Any selection in a score with 1st/2nd endings absorbs all second endings | K331 mvt. 1 | beat or sub-beat | Make any selection in a score that has first/second endings | All second-ending measures are included in the bracket regardless of the intended range | `bracket-geometry`, `human-coord-lookup` | verified |
| SEL-14 | Selection with sub-beat resolution leaves the final bar without bracket | K332 mvt. 1, m. 18-20 | sub-beat | Make a selection ending on bar 20 second beat | Ghost works ok, bracket stops in the previous bar | `bracket-geometry` | verified |

---

## Section 2 — Stages

| ID | Summary | Score location | Resolution | Action sequence | Observed result | Suspected layer(s) | Status |
|---|---|---|---|---|---|---|---|
| STG-01 | Collapse direction wrong when dragging backward: the stage on the other side absorbs the freed space | K279 mvt. 1, m. 1-4 | measure | With ≥3 stages visible, drag a handle backward until a stage collapses | The stage being grown (the one on the growing side of the dragged handle) does NOT absorb the freed space; instead a stage on the far side expands. When growing stage 2 against a collapsing stage 1, correct behavior (there is no stage 0 to absorb the space) | stage state-model (redistribution rule) | verified |
| STG-02 | Dragging forward collapses sensibly (positive control for STG-01) | Same as STG-01 | measure | Drag a handle forward until a stage collapses | The adjacent stage on the growing side absorbs the freed space correctly | stage state-model | verified |
| STG-03 | Beat/sub-beat backward drag: wrong collapse direction (mirrors STG-01) | Same as STG-01 | beat or sub-beat | With ≥3 stages, drag a handle backward at beat or sub-beat resolution until a stage collapses | Same wrong-neighbour absorption as STG-01 | stage state-model | verified |
| STG-04 | Beat/sub-beat forward drag: handle bounces back to original position instead of committing | Same as STG-01 | beat or sub-beat | Drag a handle forward at beat or sub-beat resolution | Handle does not stay at the new position; it snaps back | stage state-model, `bracket-geometry` | verified |
| STG-05 | Main-fragment resize with stages present works correctly (positive control) | Same as STG-01 | any | With stages visible, resize the main fragment from either end | If dragging would collapse a stage, all stages resize proportionally; resolution changes are preserved | — (works as expected) | verified |
| STG-06 | Resizing main fragment without threatening a collapse: last stage drifts from main-fragment ghost | Same as STG-01 | sub-beat | Resize the main fragment by a small amount that would not collapse any stage (only got to reproduce it reducing the last bar/stage to one beat) | Main-fragment ghost endpoint and the last stage's endpoint diverge: ghost works ok, stage bracket remains unchanged | stage state-model, `bracket-geometry` | verified |
| STG-07 | Resizing main fragment over the collapsing threshold | Same as STG-01 | sub-beat | Reduce the main fragment from the start just beyond the beginning of stage 2 | Main-fragment ghost startpoint/main bracket and the first stage's startpoint diverge: there is some proportional resizing of stages, but the exact starting points diverge | stage state-model, `bracket-geometry` | verified |
| STG-08 | Resizing main fragment on one side moves a stage on the opposite side | K332 mvt. 1, m. 18-20 | beat | Resize the main fragment from one end, a resize that would imply resizing the stages as well | The stage on the other end shifts unexpectedly beyond th main bracket | stage state-model | verified |
| STG-09 | Selecting a concept with pre-defined stages: stages do not appear until a fragment resize | — | — | Select a concept that has associated stages; do not resize | Stage brackets absent; appear after any resize of the main fragment | stage initialisation | to reproduce (not able to reproduce it) |
| STG-10 | Small fragments at beat or sub-beat resolution: stages overlap and/or extend absurdly | K331 mvt. 1 | beat or sub-beat | Tag a short fragment at sub-beat resolution | Stages extend along most of the score, brackets overlap (seems related to SEL-13) | stage state-model (overlap prohibition absent) | verified |

---

## Structural Cases to Cover

Per Step 1, at least the following structural cases must be represented in reproduced fixtures before the spec is written:

| Structural case | Anchor movement(s) | Covered by | Status |
|---|---|---|---|
| Pickup bar | K331 mvt. 3 mm. 0–2 | SEL-08 | verified |
| Repeat-end barline (partial bar before) | K283 mvt. 1 mm. 51–53, 118–120; K331 mvt. 3 mm. 6–8, 22–24 | SEL-01, SEL-02, SEL-03 | verified |
| Repeat-start barline (partial bar after) | K331 mvt. 3 mm. 8–10; K279 mvt. 3 mm. 56–58 | SEL-04, SEL-05 | verified |
| Repeat-start as selection boundary (asymmetric with repeat-end) | — (no isolated repeat-start found in current corpus) | SEL-11 | obsolete (ADR-025) |
| Partial-measure pairs around repeats (both sides) | K283 mvt. 1; K331 mvt. 3 | SEL-01–SEL-05, SEL-08 | verified |
| First/second endings | K331 mvt. 1 mm. 97–99 | SEL-07, SEL-12, SEL-13 | verified |
| Section boundaries (Alla turca) | K331 mvt. 3 | SEL-03, SEL-04, SEL-05 | verified |
| Empty/rest-only measure after repeat barline (G2.3 ghost gap candidate) | K283 mvt. 1 m. 53 | SEL-06 | verified |
| Sub-beat endpoint under-reaches (stops short of last measure) | K279 mvt. 1 mm. 2–4; K332 mvt. 1 mm. 18–20 | SEL-09, SEL-14 | verified |
| Sub-beat endpoint over-reaches (extends one sub-beat past intended end) | K279 mvt. 1 mm. 2–4 | SEL-10 | verified |
| Stage collapse direction and redistribution | K279 mvt. 1 mm. 1–4 | STG-01–STG-04 | verified |
| Stage / main-fragment ghost drift after resize | K279 mvt. 1 mm. 1–4; K332 mvt. 1 mm. 18–20 | STG-06, STG-07, STG-08 | verified |
| Stage overlap at beat/sub-beat | K331 mvt. 1 | STG-10 | verified |
| Stage initialisation on concept select (stages absent until resize) | — | STG-09 | to reproduce (no mechanism left after Step 4 — see Step 4 note) |
