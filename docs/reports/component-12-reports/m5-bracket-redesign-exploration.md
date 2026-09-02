# M5 — Bracket redesign: design exploration

**Component 12, Step 14 (the M5 half). Exploration only — no production code
changed by this document.** The roadmap asks for design thinking before
executing (`phase-2.md` § Track M, row M5), and for this exploration to say
whether the redesign wants the **bracket-geometry unification** pulled forward
from the Phase-2 backlog (`component-12-user-infrastructure.md` § Deferred).

The four asks, from `component-9-reports/issues-deferred-for-phase-2.md`
§ Score:

1. Square brackets — "little downward handles at the ends" — on main fragments
   **already created**, not necessarily during creation/editing.
2. Differentiate better: the fragment being edited vs the rest, and sub-stage
   vs main brackets.
3. Above- and below-staff brackets "frequently collide or even cross".
4. Sub-bracket text collides ("Dominant" with "Final Tonic").

Plus one carried in from Step 12: **sub-part label scaling**
(`DESIGN.md` § 7.7 item 2).

---

## 1. Diagnosis

Measured, not estimated: a sandbox route reproduced the real lane geometry
using the production constants and the production CSS modules over a synthetic
staff, so the failures could be seen rather than argued about. Every number
below is copied from source.

### The lane table, as it actually is

Above the staff (distance above `systemTop`):

| Element | Top | Height | Label |
|---|---|---|---|
| Stored parent bracket | −16 | 4 | alias, `top: 100%` → hangs **downward** into −10…+1 |
| Live selection bracket | −9 | 5 | none |

Below the staff (distance below `systemBottom`):

| Element | Top | Height | Label |
|---|---|---|---|
| Harmony label lane | +6 | ~12 | — |
| Live stage brackets | +20 | 6 | `top: 100%` → +28…+39 |
| Stored sub-part brackets | **+20** | 4 | same lane, same label offset |

### The four failures, and why they are structural

- **Above-staff collision (ask 3).** The stored bracket's alias label hangs
  *downward* into exactly the live bracket's lane. Not an occasional overlap —
  the two occupy the same 11px band by construction.
- **The two brackets are 3px apart** (stored occupies −16…−12, live −9…−4).
  At that spacing they read as **one thick two-tone bar**, not two brackets.
  This is visible the moment they are put side by side, and it is the reason
  ask 2 ("differentiate the one being edited") is felt as a problem: the
  current differentiation is 1px of height and a gradient end.
- **Below-staff collision (ask 3).** Stored sub-parts and live stage brackets
  share lane +20 *by design* — `FragmentOverlay.tsx` says so in a comment
  ("Matches StageBrackets.tsx BELOW_STAFF_GAP so stored sub-parts sit in the
  same lane"). Their labels then share +28 as well.
- **Label collision (ask 4).** Every label is `left: 0; white-space: nowrap`
  from its own bracket's left edge, with **no collision handling of any kind**.
  A stage can be one beat wide (~30px) while its name is ~55px, so a label
  routinely runs over its neighbour's. "Dominant"/"Final Tonic" is the
  reported case; it is the general case.

### Four bracket implementations, not one

`MainBracket.tsx` (H 5, handle 28), `StageBrackets.tsx` (H 6, handle 20, gap
20), `FragmentOverlay.tsx` (stored H 4 at −16, sub-part H 4 at +20), and
`FragmentNotation.tsx` (H 5, gap 20, label 10px) each carry **private copies**
of the geometry. Nothing reconciles them. The `+20` collision above is exactly
what that produces: one file matched another file's constant deliberately, and
the two elements landed on top of each other.

**Decided (Francisco, 2026-09-01): the vertical lane table only.**

**→ This is the trigger the roadmap asked about.** The redesign wants the
*vertical* half of the geometry unification pulled forward: one shared lane
table that every bracket surface consumes, so a lane cannot be double-booked
by two files that each think they are right. It does **not** need the
*horizontal* half (per-system segment projection in `stageFrame.ts` /
`resolveSegments`), which is a larger refactor with real regression surface and
no bearing on these four asks. Recommend pulling forward the lane table only,
and leaving the rest of the backlog item where it is.

---

## 2. The proposal

### 2.1 End treatment encodes editability

The cleanest available answer to ask 1 *and* half of ask 2, because it makes
one visual property carry one meaning:

- **Committed (stored) brackets get square serifs** — a short drop at each end,
  toward the staff. This is the conventional analytical bracket, and it says
  *this span is closed*.
- **Live/editable brackets keep the gradient fade** at each end. A fade says
  *this end is grabbable and provisional* — which is exactly what the ghost
  drag handles behind it do.

A second benefit the sandbox made obvious: with two adjacent stored fragments,
plain bars are ambiguous about where one ends and the next begins. Serifs make
each span's boundaries explicit (panel E).

**Serifs require lane clearance.** At the current −16 the 5px downward serif
lands *inside* the live bracket. The stored lane moves to **−26**, which also
fixes the "one two-tone bar" reading.

### 2.2 Labels move outward, never inward

Every label goes on the far side of its bracket from the staff: above-staff
brackets label **above**, below-staff brackets label **below**. Nothing then
hangs into a neighbouring lane. This alone removes the above-staff collision.

### 2.3 Stored sub-parts get their own lane

Below the stage lane rather than inside it. Costs vertical space; the score
viewer is **desktop-only** (`DESIGN.md` § 7.2), so that is affordable.

### 2.4 Focus by de-emphasis

While a live selection or edit exists, **stored brackets dim** (~35%). The
answer to "differentiate the one being edited" is to quiet everything else
rather than to shout louder — consistent with the system's "quiet authority".

### 2.5 Proposed lane table

Above `systemTop`: live bracket −9 (h 5) · stored bracket −26 (h 4, serifs to
−21) · stored label −39…−28. Headroom needed ≈ 40px.

Below `systemBottom`: harmony +6 · stage brackets +20 (h 6) · stage labels
+28 (see § 3) · stored sub-parts +48 or +62 (h 3, thinner than a parent) ·
sub-part labels below that.

---

## 3. The one open decision: stage labels

Three strategies were built and rendered. This is the only item where the
right answer is a matter of editorial preference rather than of fixing a
defect, so it is the one to decide before implementation.

| | What it does | Cost |
|---|---|---|
| **B · stagger** | Alternate labels onto two rows, so neighbours can never collide. All four names stay readable. | ~15px more vertical space; three consecutive very long names could still touch. |
| **C · clip** | Truncate each label to its bracket's width with an ellipsis. | Weakest of the three — "Pre-domin…" loses the word that matters, *and* labels still abut, because a label that exactly fills its bracket touches the next one. |
| **D · active only** | Show the label only for the active/hovered stage; colour plus the sidebar legend carry the rest. | Cleanest score, cheapest vertically; loses at-a-glance naming. |

**Recommendation: B.** It is the only one that fully removes the collision
class while keeping the information, and the surface is desktop-only so the
vertical cost is affordable. D is the more elegant score but asks the annotator
to hold the colour legend in their head while working.

**Decided (Francisco, 2026-09-01): B, but adaptive** — stagger only the labels
that would actually collide, if that is not over-complex; plain B otherwise.
It was not: the packing is a pure function over measured boxes
(`staggerLabels.ts`, 8 unit tests) and the hook around it does nothing but
measure, call it, and write `data-label-row` back onto the node. Going through
an attribute rather than React state is what keeps it from looping — measuring
a label does not depend on which row it is on.

Adaptive is the better answer for the reason it was asked for: most cadences
have names that fit, and a permanent second row would spend the vertical budget
and look irregular on all of them.

Worth noting either way: **Part 6 Step 15 (triage item 8, short stage-component
names) attacks this at the source.** Whatever is chosen here gets easier once
stage labels are short forms rather than "Pre-dominant on Scale Degree 4
(IV, ii, ii6, …)".

---

## 4. Sub-part label scaling (`DESIGN.md` § 7.7 item 2)

Separate surface, separate fix. `FragmentNotation.module.css .subPartLabel` is
a fixed `10px` while its brackets shrink with `cssScale` to ~60% on a phone, so
the label grows relative to the bracket exactly where space is tightest. This
surface is **Full**-support, so it is a bug.

Fix: scale the label with `cssScale` so the ratio is constant, and verify at
**360px**, not only at desktop width — the § 7.7 note's standing requirement.

---

## 5. Scope check

In: the lane table (vertical geometry unification), serifs on stored brackets,
labels outward, sub-part lane, dimming, the chosen stage-label strategy, and
the sub-part label scaling fix.

Out, deliberately: the horizontal projection refactor (§ 1); the stage-bracket
toggle behaviour question in the same issues section ("clicking another
fragment doesn't turn the old one off — what is the desired behaviour?"), which
is an interaction-model question, not a bracket-rendering one, and is not part
of M5's register row.

Also riding along, since it is the same surface and the same pass: the F12
remainder parked here — segmented controls (`.scaleBtn`, `.sizeButton`,
`.resolutionButton`, `.tagButton`), the two transport rows, the icon buttons,
and the text-link register.


---

## 6. Outcome

Implemented 2026-09-01. `bracketLanes.ts` is the shared lane table; the four
surfaces consume it and no longer carry private copies of the vertical
geometry. Everything in § 5's "in" list landed.

Three things the implementation found that the exploration had not:

- **`Number('480px')` is `NaN`.** The optical-scale measurement read Verovio's
  canvas width with `Number` rather than `parseFloat`, so the ratio silently
  pinned at 1 and sub-part labels did not scale at all. The symptom was
  invisible in a passing suite; it showed up as "labelFontPx: 10px" at a
  viewport where the notation was measurably at 60%.
- **A constant ratio is not the goal — legibility is.** Scaling the label
  faithfully gives 6px at 360px, which is not readable type. The shipped rule
  keeps a floor: `max(8px, 10px × scale)`, still 20% narrower than the fixed
  size that caused the collision.
- **Sub-part labels collide on the fragment-detail surface too**, not only in
  the tagging tool, and worse there because the brackets shrink. The same
  adaptive stagger now runs on both. The exploration had framed label collision
  as a stage-bracket problem; it is a bracket-label problem.

Also added beyond the brief, because the render made the case: **serifs on
sub-part brackets**. Adjacent sub-parts abut, and without an end mark two of
them read as one continuous bar — the same argument that justified serifs on
parents (§ 2.1), which only became visible with two real sub-parts on screen.

Verified on renders at 1280px and 360px on the fragment-detail surface, and on
the shipped `StoredBrackets` CSS for the tagging tool's stored brackets. The
score viewer's live stage lane could not be driven from a stub harness; its
stagger uses the same hook, verified on the other surface.


---

## 7. Second pass (Francisco's read-through, 2026-09-03)

The first pass's serif trick was wrong and the lane work only went half way.
What changed, and why:

### Serifs: one per boundary, not two nudged together

The first attempt outset each serif by 1px so that two abutting ones would
coincide. It failed twice over: the status colours are translucent, so the
overlap **composited darker** than a real serif, and the outset left every
*outer* end sitting visibly proud of its own bracket — including on the parent
bracket, which never had the problem in the first place.

The rule now is Francisco's: **a segment drops its right serif when another
begins where it ends.** The boundary is marked once, by the following bracket's
left serif; every serif is flush; nothing overlaps. `serifSides` in
`bracketSegments.ts`, 7 unit tests.

### Serif direction

Below the staff they point **up**. The rule that came out of it is better than
either half: **a bracket's ends always turn in toward what they enclose** —
down above the staff, up below it.

### The live selection bracket is gone

Confirmed redundant before removing it: `ghosts.css` already fills the
committed selection over the staff (`.ghost.dark`, 45–55% primary) *and*
renders `.ghost-handle-left` / `-right`; `MainBracket`'s own gradient ends were
documented in-source as "purely cosmetic", duplicating exactly those handles.
It restated what was already on screen and charged an above-staff lane for it.

`resolveSegments` and `BracketSegment` moved to `bracketSegments.ts` on the way
out — they were never that component's, being the projection every bracket
surface uses, which is why `FragmentOverlay` imported them from it.

With the lane free, stored brackets moved from −26 back in to **−14**.

### The below-staff lanes merged again

Stored sub-parts share the live stage lane once more — but deliberately this
time, and only because they can no longer both be on screen (below). Separating
them cost ~28px per system to keep apart two things that never co-occur, and
that budget is what pushes a system's brackets into its neighbour.

Above and below together, the stack is ~36px shorter per system than the first
pass left it.

### Stage visibility follows selection

The keystone. `FragmentOverlay` kept a per-fragment `collapsed` flag toggled by
the same click that selected the fragment, so expansion and selection drifted
apart: selecting B left A's stages on screen, and clicking A again selected it
while switching its stages *off*. Expansion is now **derived**
(`collapsed = id !== selectedFragmentId`), which fixes all three symptoms at
once and makes the lane merge safe — entering an annotation clears the
selection, so no stored sub-parts are showing when live stages appear.

Two existing tests asserted the old behaviour and were rewritten to the new
contract, with the reasoning kept in the test bodies.

### Dimming follows focus

A live edit dims every stored bracket; a selection dims every one *except* the
selected fragment.

---

## 8. Logged, not fixed

Three things this pass deliberately leaves open.

1. **Overlapping stored fragments read as one long bracket** with too many
   serifs. Two fragments sharing bars project into the same lane and the eye
   cannot separate them. A real fix needs per-system lane allocation among
   overlapping parents — the label-stagger problem again, but in two
   dimensions and with no natural row limit. Not attempted.

2. **Deselecting from the score is no longer possible.** A click used to toggle
   expansion, so clicking a selected fragment again visibly did *something*.
   Now a click only selects, and the only way back to nothing-selected is the
   sidebar's "X". The score is plainly responsive to clicks, so this may read
   as a dead end. Deliberately not resolved here: the right interaction is not
   obvious (click-again-to-deselect reintroduces a toggle; click-empty-space
   collides with drag-select), and it is worth deciding before coding.

3. **Collision with the *adjacent* system.** The lane work reduces collisions
   *within* a system, but the above- and below-staff stacks of neighbouring
   systems can still meet — and shortening the stacks only postpones it. The
   real lever is Verovio's `spacingSystem`, which we do not currently set, so
   pushing systems apart is available and cheap to try. The catch is that it
   changes engraving on every surface sharing the render path, including the
   pre-rendered preview SVGs (ADR-008), which would need regeneration — and it
   lands exactly where the deferred Verovio regression snapshots are meant to
   guard. Worth its own slot, not a ride-along.
