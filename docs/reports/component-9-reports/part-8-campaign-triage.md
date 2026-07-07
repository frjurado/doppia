# Part 8 mid-campaign triage — tagging read-through batch

**Date:** 2026-07-07
**Author:** Francisco (raw list) · investigation & triage in Claude Code
**Source:** Francisco's exploration/tagging pass over the full 54-movement corpus (Part 8, Step 27 in progress), plus the previously filed `preview-regeneration-gap.md`.
**Status:** dispositions **decided with Francisco (2026-07-07)**. Item 1 **done** (0e829c0 + 71b3853: ADR-034 inline dispatch, ADR-008 regeneration entry point, `/health/deep` + keep-alive workflow; staging previews regenerated 16/16 in-process, 2026-07-07). Items 2–8 pending.

This report is the canonical surface for this batch, per Step 28 of
`docs/roadmap/component-9-corpus-population-and-hardening.md`. Every raw item
is grounded in code (cited inline), assigned a disposition — **fix now**
(in-component, before Part 9) or **defer to Phase 2** — and the two
investigation-only questions are answered. Issue codes (E/F/G/I…) refer to the
tracking tables in `staging-readthrough-issues.md`.

---

## Fix now — before Part 9

### 1. Preview pipeline: worker off + regeneration gap (highest priority)

The one item that actively corrupts the campaign's output. Staging's
`fly.toml` deliberately runs no Celery worker (`deployment.md` §"No Celery
worker is deployed in Phase 1 staging"): an idle worker polls Upstash
continuously and saturates the metered free tier. Consequence: every
`render_fragment_preview` task enqueued by a fragment submit sits in Redis
forever — **fragments tagged during the campaign get no previews**, silently.
This compounds the already-filed `preview-regeneration-gap.md` (re-ingest
never re-enqueues previews at all).

**Decided (2026-07-07), two moves:**

1. **In-process rendering for the interactive path.** Run
   `render_fragment_preview` (and `generate_incipit`) in-process in the API —
   FastAPI `BackgroundTasks` after commit — for Phase 1 scale. Celery remains
   for bulk-ingest windows, where a worker is run manually per the Step 9
   runbook. This removes the worker dependency from exactly the path the
   campaign exercises and generates no Upstash traffic. **This is a design
   decision → record as an ADR when implemented** (per house rule).
2. **Implement the ADR-008 entry point regardless:**
   `FragmentService.enqueue_preview_regeneration_for_movement(movement_id)`
   called from the ingest service for every upserted-over-existing movement,
   exactly as specced in `preview-regeneration-gap.md` (items 1–4 there,
   including the unit test). Protects every future re-ingest.

**Free-tier operations (same cluster, decided):** schedule keep-alive pings so
Supabase (~1 week idle → project pauses, taking **login** down) and Neo4j Aura
Free (~3 days idle → instance pauses, taking concept search/browse down) never
sleep — e.g. a scheduled job hitting an API health endpoint that touches both
stores. R2 and Fly allowances are comfortable at Phase-1 scale. Add a
"free-tier operations" section to `docs/deployment.md` recording the pause
windows, the ping, and the manual-worker window protocol.

### 2. Stage bracket resize cannot cross systems

Confirmed mechanism: `nearestBoundaryTarget`
(`frontend/src/components/score/StageBrackets.tsx` L131–154) always prefers
boundary candidates on the **drag-start** system (`bestOnSystem` preference),
and at least one on-system candidate always exists, so a slot on another
system can never win. Fix: derive the candidate system from the **cursor's y
position** during the drag rather than freezing `systemBottom` at drag start.
Contained in one function + its unit tests. If the spec
(`tagging-tool-design.md` §6A.4) is silent on multi-system boundary drags,
add the clause in the same change.

**Done (2026-07-07, pending Francisco's in-app verification):**
`nearestSystemBottom` resolves the cursor's system per mousemove tick and
`nearestBoundaryTarget` targets boundaries on *that* system;
`DragState.systemBottom` (the frozen drag-start system) removed. Spec clause
added as §6A.4 **I11**. Unit-tested over two-system slot fixtures
(`StageBrackets.test.ts`), including the pre-fix counterexample (same x,
cursor on system 2 → boundary on system 2, where the old code returned the
system-1 boundary).

### 3. G2 (stage list ordering) — two of three surfaces still unsorted

The Band-2 position sort landed only in the tagging sidebar
(`StageList.tsx` L88–99). Still rendering `fragment.sub_parts` in raw API
order (the orderings Francisco observed):

- `FragmentDetailPanel.tsx` L660 — the score-view / review "Subpartes" panel;
- `FragmentDetail.tsx` L896 — the fragment-viewer overlay labels.

**Fix server-side:** sort `sub_parts` by `(bar_start, beat_start)` where the
fragment detail response is assembled, so every present and future surface
inherits the order. The "stages reorder dynamically during tagging" is the
StageList live position sort reacting to bound edits mid-drag — legal but
jarring; **freeze the display order during an active drag**. (If a *stable*
wrong order is ever observed in the tagging sidebar specifically, capture the
repro — no mechanism found for that.)

### 4. Sidebar batch (tagging speed)

All local to `StageList` / `FormPanel`:

- "Stages" and "Comment" explanatory text moves under an `(i)` affordance,
  shown on hover.
- Drop the measure/beat bounds line from stage cards
  (`StageList.tsx` L197–213) — redundant with the score brackets.
- Stage property forms **always open**: today `SubPartForm` renders only for
  the active card (`StageList.tsx` L218); render it for every present stage,
  with active-state highlight only. (Interacts with the drag-order freeze in
  item 3 — always-open cards make mid-drag reordering more disruptive.)

### 5. F2 (play-from-position first-note race) — residual hole

The Band-2 fix (`transport.start('+0.05')`,
`useMidiPlayback.ts` L473) closed the transport-start race, but the window
filter admits notes down to `startSec − EPS` and schedules them at
`note.time − startSec` (`useMidiPlayback.ts` L451–459) — **slightly negative**
when the origin's timemap ms rounds just below the note's MIDI time. A
negative-offset transport event can be silently dropped, reproducing the
symptom regardless of lookahead. Fix: clamp the scheduled offset to
`Math.max(0, note.time − startSec)`; verify with a repro at a known-failing
origin.

### 6. "Authentication required" untranslated (I2 sibling) + envelope violation

`backend/api/dependencies.py` L75–79 raises a bare `HTTPException` with an
English `detail` and **no error-envelope code** — itself a violation of the
API error convention (flag for the Step 30 conventions sweep). Decided fix,
both ends:

- Backend: give the exception a proper envelope code (e.g. `AUTH_REQUIRED`
  in `backend/models/errors.py`).
- Frontend: `apiFetch` treats **any 401** the way `INVALID_TOKEN` is treated —
  clear the stored token, substitute the translated `auth:sessionExpired`
  string.

### 7. I1 (login button) — minimal patch now

Root cause of the persistence: `getSession()`
(`frontend/src/services/auth.ts` L30–34) is presence-only — an expired token
reads as authenticated until a 401 round-trip *and* a NavBar re-render.
**Minimal patch (decided):** decode the JWT `exp` claim in `getSession()` and
return `null` when expired; the login button then reappears on the next
render/navigation. The full session UX (Supabase client, refresh, user
dropdown) stays Phase 2.

### 8. Caret extra length (small, bundled with 5)

`systemStaffLineBounds` (`caret.ts`) returns bare staff extents — the E1 fix
matches the ghost boxes exactly, with no margin. Extend the caret by ~1.5
staff spaces on each side; the staff-space unit is derivable from the staff
line spacing already measured there.

---

## Investigation answers (no code shipped)

### Harmony confirmation workflow — and the `harmony_gate` decision

The designed workflow (`fragment-schema.md` §"Fragment approval and harmony
review", `capture_extensions.md`): DCML events arrive `reviewed: false`; in
tag mode the annotator **confirms** a chord (sets `reviewed: true`, nothing
else) or **edits** it (`source: manual`, `reviewed: true`); after the H1 fix
the panel and its Confirm-all are clipped to the fragment's beat range.
Review is **event-level** — confirming chords under fragment A satisfies any
later fragment over the same bars.

**Finding:** approval blocks on unreviewed events only when a tagged concept
declares a `harmony_gate` capture extension
(`services/fragments.py` L1910–1930) — and **no concept in the seeded cadence
domain declares one**. Ignoring the confirm tool therefore has zero blocking
consequence today.

**Decision (2026-07-07): defer `harmony_gate` seeding to Phase 2.** Verified
safe: the gate runs **only** inside `approve()` (`fragments.py` L1608) —
never on submit, read, or listing. Adding the extension later affects only
*future* approval attempts: already-approved fragments stay approved and are
never re-checked (unless edited, which returns them to `submitted` by the
normal revision semantics); submitted fragments simply cannot be approved
until their range is confirmed — nothing jumps queues, no data changes. The
one Phase-2 cost: fragments approved before the gate exists will not have
been harmony-certified — a one-time confirmation sweep over their ranges,
cheap because event-level review is shared across fragments.

### Fragment lifecycle (who can do what, where)

Fully documented and built; the gap is discoverability, not semantics.

- **Statuses:** `draft → submitted → approved` (+ `rejected` via review).
- **Edit:** score viewer, tag mode → click a stored fragment bracket → detail
  panel → **Edit** (restores selection, stages, form; saves via `PATCH` with
  revision semantics). Rules (`fragment-schema.md` §"Fragment edit and
  revision semantics"): analytic edits clear all reviews; editing an
  `approved` fragment returns it to `submitted`; prose-only edits touch
  nothing.
- **Who:** creator and admins edit; non-creator editors review but don't
  edit; delete = creator (any status except `approved`) or admin, with the
  cascade-confirm guard for sub-parts. Approval needs the non-creator
  threshold (admin bypasses); self-review forbidden.
- **Reviewers** reach fragments via the review queue (`?fragmentId=`
  deep-link into the score viewer).

**Deferred to Phase 2 (documented here as the issue):** Francisco could not
find the Edit button — a sign the affordances are insufficient for
multi-editor work. Phase-2 items: an Edit entry from the fragment
browser/detail view, visible status badges on fragment surfaces, and a short
"fragment lifecycle" explainer for onboarding editors.

---

## Additional findings (surfaced while fixing, routed onward)

### Integration test not isolated against campaign data → Step 30

`tests/integration/test_review_queue_api.py::TestReviewQueue::test_cursor_pagination`
assumes the review queue contains only the 3 fragments the test inserts, but
the queue endpoint lists **all** submitted fragments in the database. Against
a dev DB carrying real campaign data (verified 2026-07-07: 1 submitted /
10 approved / 44 draft locally) the queue had 4 entries, so page 2 returned 2
items where the test asserts 1. Any DB with at least one real `submitted`
fragment trips it, and it will keep tripping as the campaign adds more —
CI (empty DB) stays green, which is why it never surfaced there.

**Disposition: fix at Step 30 (test review), not now.** The fix is small —
scope the pagination assertions to the inserted fragment ids, or count
relative to the pre-existing queue size captured before insertion — and the
Step 30 sweep should check the other integration suites for the same
empty-database assumption while at it.

| Item | Mechanism / note (so the future fix is cheap) |
|---|---|
| **G1 beat-range display** ("beats 1⅔–1") | Confirmed: `displayEndBeat` (`frontend/src/utils/fragmentRange.ts` L74–76) steps a whole exclusive bound back one beat with no clamp against `beatStart`, so a sub-beat-wide range ending on a whole bound renders end < start. Display-only; stored coordinates correct. Francisco: defer until a permanent convention review rather than another partial patch. The minimal clamp (collapse to `beat {start}` when the stepped-back end < start) is on file if it starts to hurt. |
| **Caret slides to repeat barline** (E3 follow-up) | Current hold-at-last-anchor is correct-if-inelegant. The elegant version needs a synthetic barline anchor per pre-jump measure in `buildCaretTrack` + a `resolveCaret` branch. Cosmetic. |
| **Pickup / partial-bar beat numbering** (transport shows beat 1 for a pickup) | Musically right, but needs meter-aware offsets through the ADR-005 beat encoding and the transport readout, and raises the stored-fragment-coordinate question. ADR-005/ADR-015-adjacent design work, not a patch. |
| **Full session UX** (Supabase client, token refresh, user dropdown) | Minimal `exp` patch ships now (fix-now item 7); the rest is Phase 2 with the real Supabase client. |
| **`harmony_gate` seeding for cadence concepts** | See investigation answer above — deferral verified safe; plan the one-time confirmation sweep when it lands. |
| **Fragment edit/lifecycle UI affordances** | See investigation answer above. |

---

## Sequencing

The fix-now items are Step-28 "fix-now" bugs: per the plan, **the campaign is
not done while any is open**. Item 1 (preview pipeline) lands first — it is
the only one whose absence corrupts campaign output; its move 1 needs an ADR
written with the implementation (direction already decided above). Items 2–4
are the tagging-speed package and should land before the bulk of the 50–100
fragments are tagged. Items 5–8 are independent and small.
