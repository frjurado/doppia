# Phase 1 — Component 9: Corpus Population, Hardening & Phase-1 Close-out — Implementation Plan

This document translates Component 9 of `docs/roadmap/phase-1.md` into a concrete, sequenced set of implementation tasks, following the model of the Component 7 and 8 plans. Component 9 as originally scoped is "Initial Corpus Population & Testing": ingest a coherent corpus, tag 50–100 fragments, exercise every code path end to end, and document everything that breaks. This plan keeps that purpose at its centre and extends it with four scope additions agreed with Francisco (2026-06-11):

1. **The accumulated issue backlog** (`docs/reports/component-9-reports/various-issues.md` plus `ingestion-warnings.json`) is triaged and resolved here, not deferred again — most prominently the tagging-tool selection/stages bugs, which are fixed *before* the tagging campaign begins.
2. **Spanish translation** lands at the "infrastructure complete + Spanish UI strings" level: the ADR-006 Phase-1 items that were scaffolded but never finished are completed, the frontend is internationalised, and the UI ships in Spanish. Concept/definition translation is deferred.
3. **The full Mozart piano sonatas corpus** is ingested: all 18 sonatas, 54 movements (15 are already in).
4. **A full project review** — docs, code, security, tests, cleanup — closes the component and serves as the Phase 1 → Phase 2 gate.

The component's character is therefore different from 5–8: it builds one genuinely new feature surface (i18n) and several bounded enhancements (caret, harmonic label display, nav), but most of its weight is *hardening* — making the tooling trustworthy enough that the tagging campaign produces data nobody has to re-do, and making the corpus final so fragment coordinates never shift underneath it.

All code, migration, and seed work below is executed in **Claude Code**; this Cowork project edits docs only. Where a draft of a code-adjacent artefact is useful before handoff, it lands under `docs/seed-drafts/`.

---

## Prerequisites

Component 9 assumes the Component 8 hard gates have passed (per `component-8-fragment-browsing.md` § "Hard Gates Before Component 9 Begins"): concept-tag browsing works end to end with the Redis subtree cache, server-side previews regenerate on submit/range-edit/MEI-correction, the detail view renders fragments in isolation against the documented `select` spike behaviour, and the ADR-024 context contract is published.

The plan's inputs — authoritative, not duplicated here:

- `docs/reports/component-9-reports/various-issues.md` — the canonical issue backlog this plan triages. Every bullet in it maps to a step below or to an explicit deferral (§ "Issue Traceability").
- `docs/reports/component-9-reports/ingestion-warnings.json` — the structured ingestion report for the 15 movements currently in (note: `various-issues.md` references it as `ingestion-warnings.md`; the JSON is the actual artefact).
- `docs/architecture/tagging-tool-design.md` — §§ 4–6 (stage pre-population, selection grid, interaction model) are the base the Part 1 spec extends.
- `docs/architecture/playback-coordinates.md` and `docs/adr/ADR-015-dual-measure-coordinate-system.md` — the four coordinate systems and the mc/mn split; the frame in which the selection bugs and the re-ingestion risk are reasoned about.
- `docs/architecture/harmony-score-overlay.md` — the in-score chord label overlay (Part 6 modifies its rendering; Part 6 also revisits its mode gating).
- `docs/adr/ADR-006-internationalisation-strategy.md` — the i18n architecture Part 7 finishes implementing.
- `docs/architecture/corpus-and-analysis-sources.md` — the DCML `mozart_piano_sonatas` pipeline (all 18 sonatas, `.mscx` → MEI, `harmonies/*.tsv`).
- `docs/mockups/opus_urtext/DESIGN.md` — authoritative for all Part 4 UI work.

### Decisions taken into this plan

Confirmed with Francisco on 2026-06-11:

- **Spec + fix before tagging.** The selection/stages bugs are a hard blocker for the campaign. The interaction-model specification is written first, the fixes are verified against a fixture matrix, and only then does volume tagging start. No fragments are tagged against known-broken stage geometry.
- **Corpus is final before the campaign.** Normalizer changes (Part 2) can alter measure structure, and `mc_start`/`mc_end` are document-order indices — re-ingesting a movement after fragments exist risks silently shifting every fragment in it. So: correctness fixes → full ingestion (including re-ingestion of the existing 15 movements if the normalizer changed) → *then* tagging. Fragments already tagged before Component 9 must be checked for mc drift if their movements are re-ingested (Step 9).
- **Spanish scope = infra + UI strings.** ADR-006's "Phase 1 (immediately)" list is completed (it is currently only partially built — see "Current state"), the frontend adopts i18next, and all UI strings ship in Spanish. Concept names/definitions, prose annotations, the translation editorial UI, and the staleness job stay deferred per ADR-006's "before launching a second language" list — with the pragmatic exception that UI-string translation does not need that machinery (i18next resource files are versioned in git, not in the translation tables).
- **All four wishlist features are in scope:** playback caret, play-from-position, harmonic label display upgrade, nav bar redesign with login entry point.
- **The full review closes the component.** It audits the final state once, after all fixes and the campaign, and doubles as the Phase 1 → Phase 2 gate.
- **Component 6 (music21 preprocessing) stays deferred.** "Exercise every code path" explicitly excludes the music21 fallback and the bass/soprano top-up pass; DCML harmonies cover the corpus in scope. `bass_pitch`/`soprano_pitch` remain "not computed" through Phase 1.

### Current state (verified, 2026-06-11)

- **Corpus:** 5 sonatas / 15 movements ingested (K279, K280, K283, K331, K332), zero rejections. All 15 required normalization changes (73 in K279/i alone, mostly ADR-021/022 accidental strips). Warning families in the report: 51 duplicate-`@n` warnings on K331/ii (minuet + trio renumbering), unparseable `@n='X1'`/`'X2'`/`'X3'` on measures inside `<ending>`, `<measure>` outside `<ending>` adjacency warnings, non-sequential `<ending @n>`, and two unpaired `rptend`.
- **i18n:** migration `0003_i18n_scaffolding` created the translation tables, but that is *all* that exists. There is no service-layer translation overlay, no `Accept-Language` handling, no English records seeded into the translation tables (the seeding script does not write them), and no frontend i18n library. ADR-006's "Phase 1 (immediately)" checklist is roughly one-sixth done; Part 7 owns the gap.
- **Interaction model:** `tagging-tool-design.md` § 6 specifies the happy paths (non-ordered flow, split-handle, endpoint re-selection, handle-affordance lock) but is silent on exactly the cases that are failing: repeat barlines and volta endings as selection boundaries, partial-measure pairs at beat/sub-beat resolution, and the collapse/redistribution rules when a stage handle is dragged to extinction.
- **Known bug signature:** the `GET .../analysis/events?bar_start=NaN` 422 in the Fly logs indicates an mc→mn (or ghost→human coordinate) lookup returning `undefined` for partial-bar selections after repeat barlines — one concrete anchor for Part 1's investigation.

---

## Part 1 — Selection & Stages: Interaction Model Spec, Then Fixes

The issues doc is explicit: "more than start solving them right away, I think a clearer map of the expected behavior is necessary." Part 1 honours that. Nothing in Part 1 is patched before the behaviour it should exhibit is written down.

### Step 1 — Symptom catalogue and fixture matrix

Reproduce every selection/stages symptom in `various-issues.md` §§ "Basic fragment selection" and "Stages" against the live corpus, and record each as: score location, resolution (measure/beat/sub-beat), action sequence, observed result, suspected coordinate layer (ghost index / bracket geometry / human-coordinate lookup / API). The outcome is a fixture matrix over the structural cases the corpus actually contains: pickup bars, repeat-start and repeat-end barlines, partial-measure pairs around repeats (both sides), first/second endings (including the `@n='X1'` measures), and the Alla turca's section boundaries. K279/i, K331/iii, and at least one movement with volta endings are the anchor fixtures. The G2.3 partial-barline limitation (Verovio not rendering a partial-after measure as a separate SVG group — no ghost, not clickable) gets its corpus verification here too.

### Step 2 — Interaction-model specification

Extend `docs/architecture/tagging-tool-design.md` (or a companion spec section within it — not a competing document) to cover what § 6 currently leaves open. The spec is written in terms of the ADR-015 coordinate model and must pin, at minimum:

- **The bracket–ghost invariant.** The committed ghost range is the single source of truth; the bracket renders exactly that range, always. Half the Step 1 symptoms (bracket ≠ ghost, bracket extending over distant partial bars, bracket covering the whole movement) are violations of an invariant that is currently implicit. Make it explicit, then make every fix converge on it.
- **Repeat barlines as boundaries.** Today repeat-end is a hard gate and repeat-start is not ("asymmetrical", per the issues doc). Decide the rule — the natural candidate is symmetry: both are gates at measure resolution, and partial-measure pairs around either are selectable as the spec for ADR-015 partial bars already implies — and document the decision with its rationale. This is a design decision; flag it to Francisco before the spec lands.
- **Volta endings.** What a selection that touches a first ending means; why a selection must never silently absorb all second endings movement-wide (the current behaviour); what the annotator sees when a range is ambiguous (`repeat_context` exists on the schema for exactly this).
- **Stage collapse and redistribution rules.** Which neighbour absorbs space when a handle drags a stage to zero width, in both directions and at every resolution; when a collapse toggles the stage off vs. clamps; what "bounce-back" cases are legal (answer: none — a drag either commits or visibly clamps). The hybrid main-resize behaviour from Component 7 Part 1 is the precedent to extend, not replace.
- **Overlap prohibition.** Stages never overlap, at any resolution; the snapping rules that guarantee it.

### Step 3 — Main-selection fixes

Implement against the spec, verified case by case on the Step 1 fixture matrix: bracket geometry for partial-bar endpoints (both sides of repeat barlines); the `bar_start=NaN` lookup failure (guard the mc→mn mapping and fix the underlying lookup; the API correctly 422s — the frontend should never emit the request); the all-second-endings inclusion bug; the whole-movement bracket; the repeat-start rule as specced. The "Request validation failed" path gets a regression test pinning the request that used to contain `NaN`.

### Step 4 — Stage-interaction fixes

Same discipline: collapse direction, redistribution, forward-drag bounce, main-resize/stage divergence, stages not appearing until a resize, and overlap — each tied to a spec clause and a fixture. Frontend unit tests (Vitest, extending the existing ghost-geometry/state-model suites) encode the spec's collapse/redistribution tables.

### Step 5 — Sidebar submission feedback

Study current Save draft / Submit for review behaviour, then implement the spec'd difference: Submit resets form and ghosts to initial state with an unmissable success confirmation; Save draft preserves the working state with quieter feedback. Small, but it ships with Part 1 because it is part of the same "annotators trust the tool" goal.

---

## Part 2 — Rendering & Ingestion Correctness

These precede full ingestion (Part 3) so the corpus is ingested once, with the fixed normalizer.

### Step 6 — Clef changes not rendered

K279/i has mid-staff clef changes (m. 5 G clef, m. 9 F clef on the bass staff) present in the source MEI but absent in the app's render, while K279/ii's render them fine. Diagnose where they are lost: normalizer stripping, Verovio version behaviour (check against ADR-013's pinned version), or an encoding difference between the two files (`<clef>` element vs. `@clef.*` attributes on `<staffDef>`). Fix at the right layer; add the failing measure to the render spot-check list.

### Step 7 — Lost tie and consequent accidental (K279/i, mm. 13–14)

A flat note tied across the barline loses its tie in the app (visible in MuseScore), which also makes the continuation note render natural — consistent with the tie loss happening before Verovio's accidental logic runs. Given the heavy ADR-021/022 accidental normalization applied to exactly this file (73 changes, including `accid.ges` strips on B♭s in mm. 12–14), the first suspect is the normalizer interacting with tie continuation. Diagnose against the retained original (ADR-014), fix, and extend `docs/investigations/accidentals-k279-mvt1/` with the findings.

### Step 8 — Ingestion warning triage and duplicate-`@n` policy

Work through `ingestion-warnings.json` family by family and classify each: normalize (fix in the normalizer), accept (legitimate encoding; document and silence or downgrade), or defer (needs a corpus-source fix upstream). The known families:

- **Duplicate `@n` outside endings (K331/ii, 51 warnings).** Legitimate: minuet + trio with restarting numbering. ADR-015 means machine coordinates are unaffected; the question is purely about human coordinates (`bar_start`/`bar_end`, labels, the harmony overlay's `(mn, volta)` keying). Decide the policy — candidates: accept duplicates and disambiguate display with a section qualifier; or treat as a recognised "multi-section movement" pattern the validator accepts without per-measure warnings. Whatever is decided lands in `mei-ingest-normalization.md` and, if it touches coordinate semantics, as an ADR-015 amendment.
- **Unparseable `@n='X1'/'X2'/'X3'` inside endings.** Already tolerated; confirm the ending-aware handling is correct and downgrade the warning if it is expected encoding.
- **Non-sequential `<ending @n>` and `<measure> outside <ending>` adjacency warnings.** Verify against the sources; these may be flagging the same volta structures Part 1 must handle — reconcile the two views.
- **Unpaired `rptend`.** Per the normalization spec these are flagged, not auto-corrected; verify the two cases are musically real (final-bar repeats) or source defects.

### Step 8b — Strip movement title from incipit renders *(deferred — must precede Step 9)*

The incipit SVG currently includes the movement title ("Allegro", "Andante", etc.) as a rendered text element above the first system. This consumes vertical space in the incipit viewport without adding information the card UI already provides, effectively reducing the visible score content at fixed thumbnail height. The fix is a normalizer or Verovio render-option change that suppresses the title element before SVG generation.

**Deferred** past the current Step 13 UI work because it requires re-ingesting (or regenerating incipits for) all movements. It must land before Step 9 so that the re-ingestion of the existing 15 movements and the full corpus ingest in Step 10 both produce title-free incipits; doing it afterwards would require a third full regeneration pass.

### Step 9 — Normalizer update and re-ingestion of the existing 15 movements

If Steps 6–8 change the normalizer, re-ingest all 15 existing movements so the whole corpus is processed identically. Re-ingestion obligations, all already specified but easy to miss: re-enqueue analysis ingestion (ADR-004), regenerate incipits and fragment previews (ADR-008's MEI-correction trigger), and — critically — verify mc stability for any existing fragments. If document-order measure positions shift, affected fragments must be migrated or flagged for re-validation, and the incident documented; this risk is the reason the tagging campaign waits for Part 3.

---

## Part 3 — Full Corpus Ingestion

### Step 10 — Prepare and ingest the remaining 13 sonatas

Run the `prepare_dcml_corpus.py` pipeline for the 39 remaining movements (`.mscx` → MEI plus `harmonies.tsv`), then bulk-ingest. Expect the warning families of Step 8 to recur (more multi-section movements, more voltas); the triage decisions made there apply automatically. DCML harmonic events ingest per the established source-priority path.

### Step 11 — Post-ingestion verification

Review the full ingestion report against the Step 8 classification (anything new gets triaged the same way); spot-check renders for every movement (clefs, ties, voltas, pickups — the Part 2 regression list); confirm incipits generated; run the corpus coherence checks; record the final report under `docs/reports/component-9-reports/`. After this step the corpus is frozen for Phase 1: any later MEI correction follows the full ADR-004/ADR-008 re-ingestion protocol with fragment-pointer verification.

---

## Part 4 — UI/UX Remediation

Bounded fixes from the issues list, all governed by `DESIGN.md`. Independent of Parts 1–3; can run in parallel.

### Step 12 — Navigation bar redesign

Redesign the top bar: Doppia wordmark/logo, left-or-center-aligned primary links without the arrow affordance, space reserved for the future user dropdown, and a login button wired to the existing `/login` view. Design-system constraints apply (no border-radius, tonal layering, Public Sans labels).

### Step 13 — Corpus browser

Previews ~25% larger and left-aligned in their column (then iterate visually); resolve the over-wide fourth column by adopting the fragment-browser layout approach for column width balance.

### Step 14 — Fragment browser

Concepts column shows the available concepts by default instead of an empty search bar (the concept tree from Component 8's navigator is the natural source). Preview height set to a useful size (thumbnail-height single system; hover-scroll chosen and implemented — same pattern as the corpus browser MovementCard). Draft-and-document the future multi-domain filter (design note only — no implementation until a second domain is seeded).

**Multi-domain filter — deferred design note:**
Once more than one domain is seeded (e.g. Cadences + Sequences), the current single-root URL pattern (`?root=<concept-id>`) becomes limiting — a user studying a passage tagged with concepts from two domains must navigate each domain separately. The future filter should:

1. Replace the single `?root` URL param with a multi-value `?domains` param listing active domain roots.
2. Render each domain as a collapsible labelled section in the concepts column, with per-domain toggle affordances.
3. Accumulate checked concepts across domains into the fragment query — OR within a domain (subtypes), AND across domains (fragment must match all active domains).
4. Display a pill strip of active domain filters above the fragment list, with individual-remove and clear-all controls.
5. Preserve the existing `includeSubtypes` toggle per domain (not globally).

No implementation until a second domain is seeded and the interaction can be validated against real multi-domain data. The URL schema change is a breaking change to bookmarked URLs; plan a redirect from the old `?root` form.

### Step 15 — Fragment viewer (detail view)

The largest cluster: widen and center the layout; restructure the header so concept hierarchy, work/composer, location, and source/license read as distinct groups (typography and ordering per design system; source + license grouped); fix the measure/beat display rule — beats render only within their measure's context, and not at all when the fragment spans complete measures; default size Medium; allow system breaks instead of forcing one system, and reserve vertical space so brackets are never clipped (no vertical scroll to discover them); always render the fragment bracket above the score (the rendered excerpt ≠ the significant fragment); remove the duplicated license/source block below the score. The scrollytelling caveat from the issues doc is noted in the component docs as a Phase-2 rendering-mode concern (ADR-024 context modes are the hook), not implemented.

### Step 16 — Score viewer

Remove the Music Font selector (dev-only tool). The chosen font becomes the pinned default; note it in the component-3 doc.

### Step 17 — Cross-surface design coherence review

Audit the three browse/list surfaces (corpus browser, fragment browser, review queue) plus the detail views against each other and `DESIGN.md`: one list-layout vocabulary, one preview treatment, one header treatment. Produce a short findings note; implement the convergence changes that are cheap now; record the rest as Phase-2 design debt. This step runs after Steps 12–16 so it reviews the corrected state.

---

## Part 5 — Playback: Fragment Range, Caret, Play-from-Position

### Step 18 — Fragment playback constrained to the fragment

In the fragment detail view, the play button currently plays the whole movement from the top. Fix: generate/slice MIDI for the rendered range only (Verovio `renderToMIDI` on the `select`-constrained render should already yield the fragment's MIDI — verify against the spike notes), so playback starts at the fragment and stops at its end. This is a bug fix and lands before the caret work builds on the playback layer.

### Step 19 — Playback caret

Replace note highlighting with a moving caret. Research first, then implement if the assessment holds: the caret is an absolutely-positioned overlay element (overlay rule — never inside Verovio's SVG) driven by the existing `onPositionUpdate(bar, beat)` callback, interpolating x-position between `getElementsAtTime()` anchors within a system and jumping at system breaks. Document the design (including the interpolation/jump behaviour and repeat-section handling, where the same notation plays twice) in `docs/architecture/playback-coordinates.md` before implementation. If the research surfaces disproportionate complexity (e.g. tempo-curve interpolation artifacts), fall back to caret-without-interpolation (discrete steps per event) and record the trade-off.

### Step 20 — Play-from-position

Design the interaction first, then implement: candidate models are click-a-measure (coarse, simple — Tone.js Transport seek to the measure's first event) vs. reusing the tagging tool's ghost layer in view mode for beat-precision starts. Decide with Francisco after a short options note; the recommendation going in is measure-level click-to-start as Phase 1 scope (ghosts stay a tagging-mode concept), with beat precision deferred. Includes the obvious complement: playback started mid-score still drives the caret correctly (depends on Step 19).

---

## Part 6 — Harmonic Label Display

### Step 21 — Label font and alignment

Increase the in-score harmony label font size (small, immediate). Investigate notehead alignment: labels currently align to the ghost's x-position; the target is the notehead of the event's beat. The `(mn, volta, beat)` → x mapping in `harmony-score-overlay.md` already finds beat positions; assess whether the notehead x is recoverable from the same Verovio geometry the ghosts use, and implement if it is not disproportionate.

### Step 22 — Stacked-figure rendering

Roman numeral + stacked inversion/figure digits (e.g. V with 6/5 stacked) instead of linear text. Survey the actual label inventory in the ingested DCML data to enumerate the cases (plain RN, single figure, two stacked figures, applied chords with slashes, added/suspension figures); implement the common cases as a small SVG/HTML composite in the overlay; anything outside the implemented grammar falls back to the current linear rendering, by design.

### Step 23 — Harmony in the fragment viewer — decision

The fragment viewer shows harmonic data in the record below but not on the score, while the score viewer shows in-score labels only in tag mode (an intentional gate per `harmony-score-overlay.md`). Resolve the incongruence deliberately: the options are (a) keep the asymmetry (viewer is a reading surface; labels are an annotator aid), (b) show labels in the fragment viewer only (a fragment is a study object — harmony is part of what it teaches), or (c) add a user toggle in both. The leaning going in is (b) with a toggle defaulting to on for fragments — the fragment viewer exists precisely to study the tagged phenomenon — but this is a product decision: write the short options note, decide with Francisco, record the outcome in `harmony-score-overlay.md` § Mode gating, and implement.

**Decision (2026-06-19, with Francisco): option (b).** Score viewer keeps its tag-mode-only gate; the fragment viewer shows in-score labels on load with a "Harmony" toggle defaulting to on. Recorded in `harmony-score-overlay.md` § Mode gating; implemented in `FragmentDetail.tsx` (reuses the response's sliced `harmony_events` and the bracket ghost layer; non-interactive labels).

---

## Part 7 — Spanish: i18n Completion + UI Translation

### Step 24 — Backend: finish ADR-006 Phase-1 infrastructure

Close the gap between ADR-006's "Phase 1 (immediately)" list and reality: the seeding script writes English records into `concept_translation` / `property_schema_translation` / `property_value_translation` for every node it seeds (re-run for the existing cadence domain); the service layer applies the translation overlay on all concept-returning reads; `Accept-Language` (or explicit `language` param) is honoured API-wide with the documented fallback (`translation_missing: true`, never an error or empty string); valid languages become `{'en', 'es'}`. Verify the `fragment.language` column exists per migration 0003 and is written on create.

### Step 25 — Frontend internationalisation

Adopt `i18next` (per ADR-006 § 2); extract every hardcoded UI string in `frontend/src` into resource files; wire the language selection (user preference, persisted; document where it lives pre-auth-profile — likely localStorage plus the `Accept-Language` default). No string remains hardcoded in a component; add a lint/test guard if practical.

### Step 26 — Spanish UI strings

Translate the extracted resource file to Spanish, reviewed by Francisco (domain-correct Spanish musical terminology where UI strings touch theory vocabulary — "compás", "cadencia", etc.); add a visible language switcher (nav bar — coordinate with Step 12). Concept names/definitions remain English (the overlay returns English with `translation_missing: true` for `es` — which also exercises the fallback path end to end, deliberately).

---

## Part 8 — Tagging Campaign & Pipeline Validation

The original Component 9. Gated on Parts 1–3 (stable tool, frozen corpus).

### Step 27 — Campaign

Execute the phase-1.md test-target table against the full corpus: 50–100 fragments across the cadence domain (10+ each of PAC, IAC, HC, DC at minimum), 10+ fragments with at least one sub-part/stages, five full peer-review cycles including the reject → revise → resubmit path, concept search checks for every cadence-domain node, and browse verification for all four cadence types (subtree-inclusive). Deliberately include the hard structural cases the fixture matrix identified — fragments at pickup bars, around repeat barlines, inside voltas — so the Part 1 fixes are exercised by real annotation, not only by tests.

### Step 28 — Bug capture

Everything that surfaces is recorded as a per-issue report under `docs/reports/component-9-reports/` (the canonical backlog surface), triaged: fix-now (small, in-component), or carry to the Phase-2 backlog. The campaign is not "done" while a fix-now item is open.

**First batch triaged (2026-07-07):** `docs/reports/component-9-reports/part-8-campaign-triage.md` — the mid-campaign issue batch from Francisco's full-corpus tagging pass, folding in `preview-regeneration-gap.md`. Eight fix-now items (headlined by the preview-pipeline/worker gap, which silently leaves campaign fragments without previews), two answered investigations (harmony confirmation workflow — `harmony_gate` seeding verified safe to defer; fragment edit lifecycle), and six Phase-2 deferrals with their mechanisms recorded.

**All eight fix-now items landed (2026-07-07):** ADR-034 in-process task dispatch + ADR-008 preview regeneration + free-tier keep-alive (`0e829c0`, `71b3853`); cross-system stage-handle drag (`e8fb2f3`); `sub_parts` in score order (`c8e4015`); tagging-sidebar batch — (i)-hints, lean stage cards, always-open forms, drag-stable order (`b93ccb8`); F2 play-from-position clamp + caret margin (`cd2d0d1`); any-401 translation + JWT-expiry session check (`8f3ee29`). The batch's remaining content is Phase-2 backlog (G1 beat-display rework, caret-at-repeat-barline, pickup beat numbering, `harmony_gate` seeding, fragment-edit UI) and the two investigation answers — none in-component. Per this step's gate, the fix-now backlog for this batch is closed; further campaign findings open a new report.

---

## Part 9 — Full Project Review & Phase-1 Close-out

The closing gate. Run after everything above has landed, so it audits the state Phase 2 will actually inherit.

### Step 29 — Documentation audit

Every file in `docs/architecture/` and `docs/adr/` checked against shipped reality: stale statements fixed, ADR statuses confirmed, the phase-1.md Component sections updated to "as built" (this plan's outcomes folded in), cross-references linted (`scripts/lint_doc_crossrefs.py`), and orphaned docs (e.g. superseded mockups, the prototype docs) marked as historical or pruned.

### Step 30 — Code, test, and dependency review

Conventions sweep (type hints, docstrings, async rules, no magic relationship strings, error envelope, cursor pagination); dead-code and TODO sweep; invariants spot-audit (immutable concept ids, `MERGE`-only seeds, Pydantic-before-write, `require_role()` only, summary versioning, object-key-not-URL); test-coverage review against the campaign's exercised paths; dependency audit (outdated/vulnerable packages, `npm audit` / `pip-audit`); Verovio version policy check (ADR-013).

**Done (2026-07-09):** `docs/reports/component-9-reports/step-30-code-test-dependency-review.md`. Conventions, invariants, and ADR-013 all pass; two stale comments fixed; npm vulnerabilities 8 → 0 (lockfile-only); three safe backend security bumps applied and test-verified (786 + 827 green). Decided with Francisco: the fastapi/starlette + lxml bumps and the pip-audit/CI wiring land as a **pre-Step-32 batch** post-campaign; the PyJWT migration (python-jose/ecdsa unfixables) is Phase-2 backlog.

### Step 31 — Security review

Verify `security-model.md` against the deployed reality: CORS policy, rate limiting, signed-URL lifecycle and expiry, dev auth bypass demonstrably off in staging/production, JWT handling (ADR-016), RLS policies from migration 0005 actually enforced, role checks on every Component 7–9 endpoint (including that service-layer status filtering cannot be bypassed), and secrets hygiene (nothing committed, `.env.example` current). Findings are fixed in-component if small, or recorded with severity and a Phase-2 deadline if not.

### Step 32 — Cleanup and close-out

Repo cleanup (stale branches, spike outputs, unused fixtures); `CONTRIBUTING.md` and `CLAUDE.md` refreshed against actual practice; a short Phase-1 close-out section appended to `phase-1.md` recording what shipped, what is deferred (with pointers), and the Phase-2 entry state.

---

## Issue Traceability

Every item in `various-issues.md`, mapped:

| Issue (section — item) | Disposition | Where |
|---|---|---|
| General — nav bar redesign, login button | Implement | Step 12 |
| Fragment browser — concepts column default list | Implement | Step 14 |
| Fragment browser — multi-domain filter | Design note only | Step 14 |
| Fragment browser — tiny preview | Implement | Step 14 |
| Fragment viewer — width/centering | Implement | Step 15 |
| Fragment viewer — header typography/grouping/order | Implement | Step 15 |
| Fragment viewer — measure/beat display rule | Implement | Step 15 |
| Fragment viewer — default Medium | Implement | Step 15 |
| Fragment viewer — allow system breaks; reserve vertical space | Implement | Step 15 |
| Fragment viewer — bracket always shown above | Implement | Step 15 |
| Fragment viewer — harmonic info incongruence | Decide, then implement | Step 23 |
| Fragment viewer — play fragment only | Implement | Step 18 |
| Fragment viewer — duplicated license/source | Implement | Step 15 |
| Review queue — design variety across surfaces | Review + cheap convergence | Step 17 |
| Browser — preview size/alignment | Implement | Step 13 |
| Browser — over-wide column | Implement | Step 13 |
| Score viewer — remove Music Font selector | Implement | Step 16 |
| Ingestion — clef changes not rendered | Investigate + fix | Step 6 |
| Ingestion — lost tie K279/i mm. 13–14 | Investigate + fix | Step 7 |
| Ingestion — K331/ii duplicate `@n` (minuet+trio) | Policy decision + handling | Step 8 |
| Ingestion — warning list revision | Triage all families | Step 8 |
| Playback — moving caret | Research + implement | Step 19 |
| Playback — play from position | Design + implement (measure-level) | Step 20 |
| Tagging sidebar — draft/submit feedback | Implement | Step 5 |
| Harmonic labels — font size | Implement | Step 21 |
| Harmonic labels — notehead alignment | Investigate + implement | Step 21 |
| Harmonic labels — stacked figures | Implement common cases + fallback | Step 22 |
| Tagging tool — G2.3 partial-barline ghost gap | Corpus verification | Step 1 |
| Selection — all eight bullet symptoms | Spec, then fix | Steps 1–3 |
| Stages — all seven bullet symptoms | Spec, then fix | Steps 1–2, 4 |

---

## Decisions To Be Confirmed During the Component

Flagged now so they are raised at the right moment rather than baked in silently:

1. **Repeat-start as a selection boundary** (Step 2) — the symmetry rule is the recommendation; confirm before the spec lands. **Resolved 2026-06-12, against the recommendation:** no repeat-barline gates at all (either direction); the hard gates are sibling volta-ending crossings and D.C./D.S. markers — the places where the music never proceeds directly. Recorded in ADR-025; spec in `tagging-tool-design.md` §6A.
2. **Duplicate-`@n` policy for multi-section movements** (Step 8) — display disambiguation vs. recognised-pattern acceptance; may amend ADR-015. **Resolved 2026-06-16: accept + downgrade.** All five firing warning families are reclassified to `info` severity (no corpus surgery): the K331/ii duplicate `@n` is collapsed to one `MEASURE_N_MULTI_SECTION_DUPLICATE` advisory and ADR-015 is amended (duplicate `@n` is an accepted human-coordinate ambiguity; `mc` is authoritative; display disambiguation deferred to Step 15); the `X`-prefixed `@n` (inside and outside endings) and unpaired-beyond-first `rptend` are accepted as `info`; the non-sequential-ending check is made volta-group-aware. Dispositions recorded in `mei-ingest-normalization.md` § Warning severity and dispositions. The normalizer warning channel gained a severity field (`NormalizationIssue`) to express the downgrade.
3. **Re-ingestion fragment-drift handling** (Step 9) — only if mc positions actually shift; the protocol is decided when the diff is visible.
4. **Play-from-position interaction model** (Step 20) — measure-level click is the recommendation. **Resolved 2026-06-18:** `Alt`-click (Option-click) a measure to arm a playback origin; **set-then-play** (arming parks a static caret and updates the transport readout but does not auto-play); **Stop → origin** with a transport **Rewind** (`⏮`) to clear it; measure resolution; works in **both** view and tag mode (the modifier never collides with plain-click selection); **score viewer only** (the fragment viewer keeps Step 18 play-from-top). Beat precision and second-pass-of-a-repeat targeting stay deferred. Spec in `playback-coordinates.md` § Play-from-position; tag-mode gesture note in `tagging-tool-design.md` §6A.6.
5. **Harmony labels in the fragment viewer** (Step 23) — option (b) with a default-on toggle is the recommendation.
6. **Language preference storage pre-auth-profile** (Step 25) — localStorage + `Accept-Language` default is the recommendation.

Each follows the house rule: short options note, decide with Francisco, record (ADR or architecture-doc amendment) before implementation.

---

## Deferred — Explicitly Out of Component 9

- **Component 6** (music21 auto-analysis, bass/soprano top-up). Still deferred; "not computed" remains the rendered state.
- **Concept/definition/prose Spanish translation**, the translation editorial UI, the staleness job, and the translator permission (ADR-006 "before launching a second language" — except as already noted, UI strings don't need them).
- **Multi-domain filter in the fragment browser** — designed (Step 14), not built, until a second domain is seeded.
- **Beat-precision play-from-position** (if the Step 20 decision lands on measure-level).
- **Scrollytelling/one-system fragment rendering modes** — Phase 2, via ADR-024 context modes.
- **Public (unauthenticated) endpoints and ADR-009 enforcement** — Phase 2, unchanged.
- **Phase-2 design-debt items** from the Step 17 coherence review that exceed cheap convergence.

---

## Sequencing

```
Stream A (tool hardening — critical path to the campaign):
  Step 1 (symptom catalogue + fixtures)
  → Step 2 (interaction spec; decisions 1)
  → Steps 3–4 (selection + stage fixes)   → Step 5 (sidebar)

Stream B (corpus — second gate for the campaign):
  Steps 6–8 (clefs, tie, warning triage; decision 2)
  → Step 9 (normalizer + re-ingest existing 15)
  → Step 10 (ingest remaining 39) → Step 11 (verify; corpus frozen)

Stream C (parallel, independent):
  Steps 12–17 (UI/UX)  ·  Steps 18–20 (playback)  ·  Steps 21–23 (harmony labels)
  Steps 24–26 (i18n + Spanish)

Campaign:   Step 27–28  ← gated on A and B complete (C need not block, but
                          Step 18 should land first so reviewers can audition fragments)

Close-out:  Steps 29–32 ← gated on everything above
```

Streams A and B are the two hard gates for the campaign and can run in parallel with each other (they share the volta/partial-bar structural analysis from Step 1 — do that first). Stream C is elastic filler between the two. The full review runs strictly last.

---

## Hard Gates Before Phase 2 Begins

1. The selection/stages interaction model is specified in `tagging-tool-design.md`, and every fixture in the Step 1 matrix passes against it — including partial bars on both sides of repeat barlines, volta endings, and pickup selections. The bracket–ghost invariant holds everywhere; no input sequence can emit a `NaN` coordinate request.
2. All 18 sonatas / 54 movements are ingested, verified, and frozen; every ingestion warning family has a recorded disposition; the K331/ii-style multi-section case has a documented policy; the clef and tie rendering defects are fixed corpus-wide.
3. 50–100 fragments are tagged and peer-reviewed per the phase-1.md test-target table, including fragments over the hard structural cases; every bug surfaced is reported under `docs/reports/` and either fixed or triaged to Phase 2.
4. The UI ships in English and Spanish: ADR-006 Phase-1 infrastructure is complete (overlay, `Accept-Language`, English translation records seeded), no UI string is hardcoded, and the `translation_missing` fallback is exercised end to end.
5. The wishlist surfaces work: fragment playback is range-constrained, the caret follows playback, play-from-position works at the decided granularity, harmonic labels render at the upgraded size/alignment with stacked figures (fallback documented), and the nav bar matches `DESIGN.md` with a login entry point.
6. The full review is complete: docs match shipped reality, the invariants audit passes, the security checklist is verified against staging/production, and findings are fixed or recorded with severity and owner.
7. `pytest` (unit + integration) and `npm test` pass in CI; `validate_graph.py` is clean; the Phase-1 close-out section is appended to `phase-1.md`.
