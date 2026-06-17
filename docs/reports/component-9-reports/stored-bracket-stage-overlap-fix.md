# Stored-fragment stage brackets render at whole-measure / off-beat-1 (fix)

**Status:** Fixed
**Date:** 2026-06-17
**Surfaces:** whole-score viewer (`ScoreViewer` → `FragmentOverlay`), the fragment
viewer (`FragmentDetail`), and the review/edit flow (`ScoreViewer` live
`StageBrackets`).
**Anchor cases:** K331/i; reproduced in **3/4** as well — *not* compound-meter
specific.

## Symptom

For an already-stored fragment whose stages (sub-parts) use beat/sub-beat
resolution, the stage brackets render over whole measures and overlap, or a stage
that doesn't start on beat 1 starts at the bar's left edge. The recorded
coordinates are correct; the stored-coordinate → pixel projection was wrong. The
*live* tagging stage brackets (creating new stages) were already correct.

There are three stored-bracket surfaces, with three different defects:

1. **Whole-score lane — `FragmentOverlay.tsx`.** Resolution was chosen as
   `beat_start !== null ? 'beat' : 'measure'`; it never selected `'subbeat'`, so
   sub-beat stages collapsed onto whole-beat ghosts. **Fixed** by picking the
   finest resolution the stored coordinates require (`storedResolution()`), plus
   a sub-part label fallback (`alias ?? name ?? "Part N"`) so the lane is never
   nameless (required adding `primary_concept_name` to the `FragmentListItem`
   list response, mirroring `ConceptBrowseItem`). *Confirmed working.*

2. **Fragment viewer — `FragmentDetail.tsx`.** `readFragmentGeometry` collected
   note onsets by reading each note's MEI `@tstamp`. **The corpus MEI carries no
   `@tstamp` on notes** — it is present only on control events (`<dynam>`,
   `<harm>`, `<dir>`, `<fermata>`, `<tempo>`). So no onsets were collected,
   `computeBracketSegments` never refined the bracket edges, and every stage
   rendered as a whole measure. **Fixed** by deriving onsets from
   `buildGhosts()` — whose onset times come from `@dur.ppq` accumulation, the
   same meter-independent source the working whole-score lane uses — and feeding
   them into the existing edge-refinement (`note.beatFloat` in the ADR-005 scale).

3. **Review / edit — `ScoreViewer.tsx` live `StageBrackets`.** Opening a stored
   fragment for review/edit restores its stages via
   `buildStageAssignmentsFromSubParts`, but the edit branch of
   `handleConceptChange` never raised the active `resolution` to the stages' beat
   grid (the auto-pre-populate branch does). At the default `'measure'`
   resolution, `buildStageSlots` builds whole-measure slots and `findStartSlot`
   snaps an off-beat-1 stage start to the measure slot. **Fixed** by raising the
   resolution to the finest grid the restored fragment + sub-parts require
   (`finestBeatResolution()`).

None of these involves compound meter; the `@tstamp` divergence theory from the
first pass was wrong — notes don't carry `@tstamp` at all.

## Fix summary (minimal, per-surface)

- `FragmentOverlay.tsx` — `storedResolution()` + sub-part label fallback.
- `FragmentDetail.tsx` — note onsets from `buildGhosts().subBeatIndex` instead of
  MEI `@tstamp`; `computeBracketSegments` unchanged (already compares on
  `beatFloat`).
- `ScoreViewer.tsx` — `finestBeatResolution()` raise in the edit-restore branch.
- Backend — additive `primary_concept_name` on `FragmentListItem`.

No new ADR — rendering bugs within existing geometry rules (bracket ≡ committed
range, ADR-005 beat encoding, ADR-011 two-level display).

## Follow-up: cross-barline / outer-edge stage beats nulled on submit

**Date:** 2026-06-18. Separately reproduced (in 3/4) on K283/i mm.14–16 with
2-beat stages: one stage crossing the barline (m.14 beat 3 → m.15 beat 2)
rendered over whole bars and overlapped, in *both* the review queue and the
fragment viewer, while single-measure siblings were fine.

Cause: a **submit-time data-corruption** bug, not a renderer bug. The sub-part
payload builder (`ScoreViewer.buildPayload`) kept a stage's beats only when
`beatStart < beatEnd`. For a cross-bar stage the beats are 1-indexed within their
own measures, so `beatStart` (3.0) legitimately exceeds `beatEnd` (2.0); the guard
failed and **both beats were stored as null** → whole-measures → overlap. The same
guard nulled measure-aligned **outer-edge** stages (one side null + a beat on the
other). The backend already allows cross-bar beats (only enforces ordering when
`bar_start == bar_end`).

**Fixed** by `normalizeStageBeats` ([stageBeats.ts](../../../frontend/src/components/score/stageBeats.ts)):
both-null stays measure-level; otherwise the measure-aligned side is filled
(start → 1.0; end → the measure's exclusive end via `measureExclusiveEndBeat`,
from the ghost layer's `endFloat` with a global-meter fallback), so beats survive;
only a degenerate single-bar pair falls back to measure-level. Also the tagging
**sidebar** stage cards now show beats (`StageList.boundsLabel` → shared
`formatFragmentRange`) instead of bar numbers only.

> **Re-tag needed:** fragments already submitted before this fix carry the nulled
> beats and must be re-tagged to recover them (pre-campaign, low cost).

## Verification

- Unit: two sub-beat stages sharing a measure render abutting, not overlapping
  (`FragmentOverlay.test.tsx`); sub-part name fallback; cross-bar/outer-edge beat
  normalization (`stageBeats.test.ts`); sidebar beat display (`StageList.test.tsx`).
  Full frontend suite, `tsc`, ESLint, and backend `black`/`isort`/`ruff` clean.
- Manual (required — geometry depends on a real Verovio render): in the score
  viewer (incl. opening a fragment for review/edit), the fragment viewer, and the
  whole-score lane, confirm stage brackets start/stop at their beat positions,
  named, with no overlap — in 3/4 and 6/8. Spot-check a measure-aligned fragment
  for no regression.
