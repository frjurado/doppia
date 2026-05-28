# Phase 1 — Component 5: Tagging Tool — Implementation Plan

This document translates Component 5 of `docs/roadmap/phase-1.md` into a concrete, sequenced set of implementation tasks. It absorbs one carry-in from Component 4 — the over-eager pass 8 in the MEI normaliser (ADR-021) that strips legitimate key-signature-implied gestural accidentals along with the spurious cross-staff ones it was meant to catch — and otherwise goes straight to the tagging tool itself.

Component 5 is the most technically complex component in Phase 1. Almost all of its design is already settled in four documents — `docs/adr/ADR-005-sub-measure-precision.md` (selection grid, beat/sub-beat encoding, edge cases), `docs/adr/ADR-011-multi-level-tagging-design.md` (the seven multi-level design decisions), `docs/architecture/tagging-tool-design.md` (the full multi-level UI specification), and `docs/architecture/prototype-tagging-tool.md` (the ghost-overlay architecture and the prototype transfer table). This plan does not restate that design; it sequences its implementation and pins down the integration boundaries the design docs leave open. Where it reaches a decision those docs do not record, it flags it in "Decisions to confirm" rather than baking it in silently.

Component 5 has five deliverables (the four originally scoped, plus the carry-in):

1. **Accidentals regression fix** — re-implement pass 8 of `mei_normalizer.py` with key-signature awareness, so notes whose `accid.ges` is set because the active key signature implies the alteration are preserved instead of stripped. Write ADR-022 with the corrected algorithm and mark ADR-021 as superseded.
2. **Backend write surface** — the endpoints the tagging UI calls to read the graph (concept search, schema tree) and to persist its work (fragment create/update/submit, harmony-event corrections, the review state machine). This is the *producer* side of the fragment data model only; the *consumer* side (browsing, on-score display of stored fragments, edit/delete CRUD, the reviewer work-queue) stays in Component 7.
3. **Score selection** — the ghost-overlay architecture adapted from the prototype: measure/beat/sub-beat ghosts, the drag-select interaction model, the resolution toggle, and the four correctness fixes ADR-005 marks "not yet handled."
4. **Classification and multi-level tagging** — concept picker, Type Refinement, dynamic property form, the stage bracket track with weighted pre-population and the split-handle, and one visible level of sub-part tagging.
5. **Summary, prose, submission** — the DCML-sourced harmony summary panel with its event-edit primitives, the prose annotation field, the submission checklist, and the concurrent-flag session state that gates Submit.

The ordering across parts matters: the accidentals carry-in (Part 1) lands first so no annotator builds muscle memory against MIDI whose pitches are wrong in key-signature-bearing movements; the backend write surface (Part 2) lands next so the UI has real endpoints to build against from line one; the ghost overlay (Part 3) lands before classification (Part 4) because every classification interaction is anchored to a committed selection; the summary/submission wiring (Part 5) lands last because it depends on a complete fragment object existing in session state.

---

## Prerequisites

Component 5 assumes the following Component 4 hard gates have passed (per `docs/roadmap/component-4-knowledge-graph.md` § "Hard gates before Component 5 begins"):

- The cadence domain seeds cleanly into staging Neo4j and `python scripts/validate_graph.py` reports zero hard failures.
- The concept full-text index (`concept_search`, over `name` and `aliases`) is created and a sample query returns the expected concepts. **Component 5's concept picker depends on this index existing; Component 5 does not create it.**
- The Bloom perspective opens against staging AuraDB. The AuraDB free tier restricts Bloom to the default perspective — the saved cadence perspective committed in Component 4 Step 13 remains as a JSON artefact for the eventual paid-tier or self-hosted environment, and the default perspective is sufficient for the structural inspection Component 5 needs during YAML iteration. `scripts/visualize_domain.py` is the working substitute when richer per-domain views are needed.
- `pytest -m integration backend/tests/graph/` passes in CI.
- The fragment data layer has ≥80% test coverage on `models/fragment.py` (Component 4 Step 4). The schema this component writes against — `Fragment`, `FragmentConceptTag`, `FragmentReview`, `movement_analysis` — is locked in by those tests before any tagging code writes a row.
- `docs/architecture/playback-coordinates.md` exists and the three score-viewer GitHub issues are closed against its rules.

It additionally assumes the following architecture docs are settled and authoritative; they are the *inputs* to this plan, and it does not duplicate them:

- `docs/adr/ADR-005-sub-measure-precision.md` — the selection grid (Measure/Beat/Sub-beat), the `beat_start`/`beat_end` float encoding, the flat index encoding, and the edge-case table.
- `docs/adr/ADR-011-multi-level-tagging-design.md` — the two-level display limit, the concurrent-flag interaction model, `containment_mode`/`display_mode`/`default_weight`, `stub`/`top_level_taggable`, and Type Refinement as a subtype split.
- `docs/architecture/tagging-tool-design.md` — the five overlay layers, stage pre-population, the form panel, the submission checklist, and the save/submit semantics.
- `docs/architecture/prototype-tagging-tool.md` — the ghost-layer architecture, the beat-boundary inference algorithm, and the prototype transfer table (Keep / Replace / Drop / Doesn't apply).
- `docs/architecture/fragment-schema.md` — the `fragment`, `fragment_concept_tag`, `fragment_review`, and `movement_analysis` definitions; the `summary` JSONB v1 schema; the dual `mc`/`mn` coordinate system; the approval-and-harmony-review gate; and the harmony-edit primitives.
- `docs/adr/ADR-015-dual-measure-coordinate-system.md` — `mc_start`/`mc_end` (machine) vs `bar_start`/`bar_end` (human) and why the tagging tool writes both at tag time.
- `docs/adr/ADR-009-dcml-licensing-constraint.md` — the per-fragment `data_licence` field set at write time.
- `docs/adr/ADR-021-mei-accidental-normalization.md` — superseded by ADR-022 in Part 1 Step 2; subsequent steps assume ADR-022's algorithm. ADR-021 is retained as the diagnostic record of the original cross-staff incident.

### Decisions taken into this plan

Six scoping decisions are baked into this plan; the first three before drafting, the next three during initial review of the draft.

- **Harmonic source: DCML only; music21 deferred.** The Mozart corpus already carries DCML harmonies in `movement_analysis` (Component 1). Component 5's summary panel reads and corrects those events; it does **not** build the music21 auto-analysis fallback or the bass/soprano top-up pass. Those are Component 6.
- **Backend scope: write path only.** Component 5 builds everything an annotator needs to take a blank score to a `submitted` (and reviewable) fragment record. The read/browse side — on-score display of stored fragments, the side-panel record view, edit/delete of existing fragments, the reviewer's work-queue UI, and server-side fragment-preview generation — is Component 7/8. The explicit deferral list is in "Deferred to later components."
- **One carry-in cleanup item.** Component 4 closed clean except for the accidentals-normaliser regression discovered after the fact (the corrected pass 8 strips key-signature-implied gestural accidentals along with the spurious ones). Part 1 of this plan addresses it before any tagging-tool work runs against the corrected MIDI.
- **`summary.actual_key` and `summary.music21_version` under DCML-only: option (b).** With music21 deferred, `summary.actual_key.value` is seeded from the DCML `local_key` at the fragment's start with `auto: false`, `reviewed: true`, and no `confidence`; `summary.music21_version` stores a sentinel (`"none"` or `null`) so the field is always present. `fragment-schema.md` § "The summary JSONB schema" gets a one-line relaxation of the "required" wording ("required when any auto field is present"); that edit happens alongside Step 5 (write validation).
- **Component 5 / Component 7 boundary: split confirmed.** Component 5 ships the review state machine and the approval gate at the service layer (Step 8) but not the reviewer-facing browse/queue UI; finding submitted work to review remains Component 7. The full review *loop* — submit, find, approve — is therefore not exercisable through the UI until Component 7 closes; the loop is exercisable via API (and tests) from the close of Component 5.
- **ADR-021 supersession: ADR-022.** The corrected algorithm lands in a new ADR-022 rather than as an in-place revision of ADR-021. ADR-021 is left intact (its cross-staff diagnosis is still the right diagnosis) and gets a `Status: Superseded by ADR-022` header plus a one-paragraph pointer to the corrected rule. This follows the project's existing convention that ADRs are immutable after Accepted and that revisions are new records, not edits. Decided after initial review; Step 2 reflects this choice.

`free` containment mode and deeper sub-part nesting remain Phase-1-deferred per the design (ADR-011 §3 and the two-level display limit); the plan honours those deferrals and flags them in "Deferred to later components" rather than treating them as open questions.

### Current code state (verified)

- `backend/graph/queries/concepts.py` already contains `get_inherited_schema_ids()` (the `IS_SUBTYPE_OF*0..` → `HAS_PROPERTY_SCHEMA` traversal). The concept *search* query and the full schema-tree assembly do **not** yet exist.
- `backend/api/router.py` mounts `health`, `corpora`, `browse`, `admin`. There is **no** `concepts` route and **no** `fragments` route yet.
- `backend/services/` has `browse`, `ingestion`, `mei_*`, `object_storage`, and the Celery tasks. There is **no** concept service, fragment service, or tagging service yet.
- `backend/models/fragment.py` and `backend/models/analysis.py` exist; a `FragmentSummary(BaseModel)` is already defined in `fragment.py` (line 64). Step 5 extends that model — it does not create a new one. `require_role()` is defined in `backend/api/dependencies.py`, so every new route reuses it.
- `frontend/src/components/score/` has only `FragmentOverlay.tsx` (a small static overlay). There is **no** ghost layer, no annotation behavioural module, and no tagging route. `frontend/src/services/verovio.ts` (large) owns rendering + MIDI and is the home of the existing `getTimesForElement` usage the ghost layer will reuse.
- `backend/services/mei_normalizer.py` pass 8 (`_strip_spurious_gestural_accidentals`) lands as ADR-021 specifies; the carry-in (Part 1) is its corrective revision, not a re-introduction.

All code/YAML/migration work below is executed in **Claude Code**; this Cowork project edits docs only. Where a draft of a code-adjacent artefact is useful before handoff (an API contract sketch, a fixture list), it can land under `docs/seed-drafts/` and be copied into the tree via Claude Code.

---

## Part 1 — Carry-In: Accidentals Regression Fix

Component 4 Step 21 introduced pass 8 of `mei_normalizer.py` (`_strip_spurious_gestural_accidentals`, ADR-021) to fix the K. 279 mvt 1 cross-staff propagation bug: the MuseScore-to-MEI converter was marking same-pitch-class notes in unrelated staves with `accid.ges` they did not deserve, making MIDI play sharps where the score (correctly) showed naturals. The fix worked for that case but classifies *everything* with `accid.ges` and no `accid` as either "within-staff same-octave carry from a prior explicit `@accid`" (preserved) or "spurious" (stripped). That binary misses the most common legitimate case in real scores: notes whose `accid.ges` is set **because the active key signature implies the alteration**. In any movement not in C major / A minor, every key-signature-implied accidental is now silently stripped on ingest, and MIDI plays naturals where the key signature requires sharps or flats.

The cross-staff diagnosis itself was sound, but the rule it generated was too narrow on the "legitimate" side. Two specific gaps:

1. **Key-signature carry was never modelled.** A note in G major sounding F♯ carries `accid.ges="s"` with no `accid` — the sharp comes from the key signature, not from a prior in-measure accidental. The current algorithm sees "no prior explicit `@accid` in this staff/measure for this pitch" and strips. The same logic affects every flat-side movement (B♭ in F major, E♭ in B♭ major), every sharp-side movement (F♯ in G major, C♯ in D major), and every modulation away from C major / A minor.
2. **The spurious propagation can land before the trigger in document order.** Per the conversation that surfaced this regression, the converter sometimes writes the spurious `accid.ges` onto a bass-staff note *earlier* in document order than the treble-staff `@accid` that "caused" it. The current document-order walk happens to classify these correctly (no prior explicit accidental → strip), but the reasoning is wrong: the algorithm thinks it is catching a case the rule already covers, when in fact it is catching one the rule never modelled. Once key-signature awareness is added, "no prior explicit accidental in document order" can no longer carry the full classification weight — the algorithm must reason about the key signature in effect at the note's position, independent of document order.

This must be fixed before Part 3 (the score selection layer) reads `getElementsAtTime` against the corrected MIDI, and before any annotator builds tagging muscle memory against playback whose pitches are wrong outside C major. The fix lives in `mei_normalizer.py` (code via Claude Code); the doc-side writes ADR-022 with the corrected algorithm and marks ADR-021 as superseded.

---

### Step 1 — Re-implement pass 8 with key-signature awareness

The corrected algorithm answers one question per note carrying `accid.ges` without `accid`: *Is this gestural alteration expected at this point in the score?* Two sources of "expected" cover every legitimate case:

1. **The active key signature for the staff at this position alters the pitch class.** Read the active `<keySig>` (or `<scoreDef>`/`<staffDef>` `key.sig`/`key.mode` shortcut form, and any inline `<keyAccid>` children for non-standard signatures). The lookup is `(staff, pname) → expected alteration ∈ {none, "s", "f", "x", "ff", "n"}`, valid for each measure given the most recently seen key declaration. Mid-piece key changes are propagated the same way pass 2 propagates meter changes — patch the lookup at each `<scoreDef>` or `<staffDef>` encountered in document order, scoped to the staves the patch applies to.
2. **A prior `<accid>`-bearing note in the same staff, same measure, same octave** carries the same `(pname, oct)`. This is the existing within-staff carry rule, unchanged in semantics.

The decision per `<accid>` element with `accid.ges` set and `accid` absent:

| Expected from key sig? | Prior `@accid` carry? | `accid.ges` matches expected alteration? | Action |
|---|---|---|---|
| Yes | — | Yes | **Keep** (key-signature carry) |
| — | Yes (same `pname`, `oct`, staff, measure) | Yes | **Keep** (within-staff carry) |
| No | No | — | **Strip** `accid.ges` and `glyph.auth` (spurious) |
| Yes or carry | — | **No** (e.g. key sig says sharp, `accid.ges` says flat) | **Warn and strip** — a mismatch is converter noise; report in `changes_applied` with the discrepancy so the corpus owner can audit |

Two implementation notes:

- **`glyph.auth="smufl"` is no longer a sufficient classifier.** It is a useful *signal* (today's converter only emits it on cross-staff propagations, per the K. 279 mvt 1 investigation), but the algorithm must not depend on it: a future converter version could legitimately emit `accid.ges` without `glyph.auth`, and stripping based on `glyph.auth` alone reintroduces today's regression in mirror form. The decision is driven by "is this gestural alteration expected at this position?"; `glyph.auth` becomes evidence in the `changes_applied` log, not the rule.
- **Key signatures live in `scoreDef`/`staffDef` and can be patched mid-movement.** Read at three levels of precedence (most specific wins): per-measure `<staffDef>` patches inside `<scoreDef>`, score-level `<scoreDef>` defaults, the initial `<scoreDef>` at the file head. MEI 5 allows `<keySig>` as a child of `<scoreDef>` or `<staffDef>`; both forms must be parsed. The `key.sig` shorthand (`"3s"`, `"2f"`) and the explicit `<keySig>` child carrying `<keyAccid>` children must both resolve to the same `(pname → alteration)` table.

**Code change in Claude Code** (`backend/services/mei_normalizer.py`); the doc-side writes ADR-022 and edits the ADR-021 header (Step 2) — both live in this Cowork project. The existing function name (`_strip_spurious_gestural_accidentals`) and its position in `normalize_mei`'s pass order are preserved so re-runs of the normalizer remain idempotent against already-processed files.

**Verification.** The regression suite (Step 2) is the primary check. End-to-end: a re-render of K. 279 mvt 1 still strips the original 153 spurious notes; a re-render of a sharp-key movement from the Mozart corpus (any movement in G, D, or A major — e.g. K. 283 mvt 1 in G major) preserves every key-signature-implied `accid.ges`; a flat-key movement (F, B♭, or E♭ major) does likewise.

---

### Step 2 — Expand the regression suite and write ADR-022 (supersedes ADR-021)

The existing five-case regression test (`TestSpuriousGesturalAccidentals` in `backend/tests/unit/test_mei_normalizer.py`) covers strip / within-staff carry / preserve-explicit / changes-recorded / idempotent. None of those exercise the key-signature case — which is exactly how the regression slipped through. Add at least the following fixtures alongside the existing five:

1. **Key-signature carry, sharp side.** A movement in G major (one sharp) with multiple F's that should sound F♯; after normalisation each F still carries `accid.ges="s"`, `accid` still absent.
2. **Key-signature carry, flat side.** A movement in F major (one flat) with B's that should sound B♭; after normalisation each B still carries `accid.ges="f"`.
3. **Key change mid-movement.** A `<scoreDef>` patch inside a measure that changes the key (e.g. C major → G major); notes before the patch follow the old signature, notes after follow the new one.
4. **Key-signature + same-staff carry coexist.** In G major, a note with explicit `accid="n"` (natural sign cancelling the key-sig F♯) followed in the same measure by a same-octave F: the second note carries `accid.ges="n"` legitimately (the natural carries within the measure), even though the key signature would otherwise have it sharp.
5. **Cross-staff spurious in document order before the trigger.** The case the user described directly: the spurious `accid.ges` lands on a bass-staff note *earlier* in document order than the treble-staff `accid` that the converter mis-propagated from. With key-signature awareness the bass note is correctly identified as not-key-signature-implied and stripped, irrespective of document order.
6. **Idempotence under the new algorithm.** Re-running the normalizer on an already-normalised file (now including key-signature-implied accidentals) produces byte-identical output. The existing idempotence case stays; this one extends it to key-bearing files.

Write **`docs/adr/ADR-022-mei-accidental-normalization-keysig-aware.md`**, modelled on ADR-021's structure:

- **Status:** Accepted. **Date:** the day this step lands. **Supersedes:** ADR-021.
- **Context.** Short summary of the regression: ADR-021's rule was too narrow on the "legitimate" side because it modelled only within-staff carry, missing key-signature-implied `accid.ges`; affected scope is every movement not in C major / A minor — i.e. nearly the entire Mozart corpus. Cross-reference the conversation that surfaced it.
- **Decision.** The corrected rule, stated as in Step 1's table: strip when `accid.ges` is set, `accid` is absent, and the gestural alteration is **neither key-signature-implied nor a within-staff/measure/octave carry from a prior explicit `accid`**. Include the four-row decision table and the implementation notes on key-signature reading and `glyph.auth="smufl"` as evidence-not-rule.
- **Consequences.** The 153-note figure for K. 279 mvt 1 from ADR-021 remains correct (cross-staff propagations are still stripped under the new rule); the new consequence is that key-signature-implied notes across the corpus are now preserved. Note that the regression suite is the structural guard against any future re-narrowing of the rule.
- **Evidence.** Reference the K. 279 mvt 1 fixture (from ADR-021) and the new sharp-key / flat-key / mid-piece key-change fixtures by path.

Then edit **ADR-021** minimally — only the header — to record the supersession:

- Change `Status: Accepted` to `Status: Superseded by ADR-022` and add the date.
- Add a one-paragraph pointer at the top of the document: *"This ADR is preserved as the diagnostic record of the original cross-staff propagation incident. The algorithm it specifies is incomplete — it strips key-signature-implied gestural accidentals — and is superseded by ADR-022, which retains the cross-staff diagnosis and adds key-signature awareness. Read ADR-022 for the current rule; read ADR-021 for the incident history."*
- Do not edit the Decision, Evidence, or Consequences sections — they remain a faithful record of what was decided at the time.

**Verification.** `pytest backend/tests/unit/test_mei_normalizer.py::TestSpuriousGesturalAccidentals` covers all eleven cases (the original five plus the new six), green. A re-ingest of K. 279 mvt 1 still corrects the 153 spurious notes; a re-ingest of at least one sharp-key and one flat-key movement from the Mozart corpus shows correct MIDI pitches in the affected staves. ADR-022 is in place with status Accepted; ADR-021's header shows `Superseded by ADR-022` with the pointer paragraph; the rest of ADR-021 is byte-identical to before.

---

### ~~Known Carry-Forward~~ Fixed — Mid-Movement Key Signature Changes (K.331 mvt 3)

**Resolved 2026-05-26.** The Rondo alla Turca (K.331 mvt 3) now normalises
correctly: 0 spurious strips (previously 361), and A-major sections play with
the correct F♯, C♯, G♯ pitches.

**Root cause (confirmed).** The K.331 corpus uses `<staffDef n="X"><keySig
sig="0"/></staffDef>` children on the initial `<scoreDef>` block, which set
per-staff key-sig entries `{"1": {}, "2": {}}` in the normalizer's state. When
a mid-piece `<scoreDef>` between `<section>` siblings declared the global key
change to A major via `<keySig sig="3s"/>` (no per-staff `<staffDef>` children),
the old algorithm updated only `global_ks`; the stale per-staff entries from the
initial staffDef block shadowed the new global for every subsequent measure,
so every F♯/C♯/G♯ in the A-major sections was classified as spurious and stripped.

**Fix applied.** `_build_measure_key_sigs` now processes each `<scoreDef>` as a
complete unit: it collects per-staff overrides from all descendant `<staffDef>`
elements upfront, and when a global key change is declared without per-staff
counterparts, removes the stale per-staff entries so they fall through to the
new global. See ADR-022 (§ "Key-signature index construction") for the full
algorithm.

**Artefacts:**
- `backend/services/mei_normalizer.py` — `_build_measure_key_sigs` patched
- `backend/tests/fixtures/mei/normalizer/keysig_section_boundary_change.mei` — new regression fixture mirroring the K.331 corpus encoding
- `backend/tests/unit/test_mei_normalizer.py` — two new cases (`test_keysig_section_boundary_change`, `test_keysig_section_boundary_change_idempotent`)
- `docs/adr/ADR-022-mei-accidental-normalization-keysig-aware.md` — written; documents both the key-sig-awareness fix (Step 1) and this section-boundary fix
- `docs/adr/ADR-021-mei-accidental-normalization.md` — header updated to `Superseded by ADR-022`
- All 15 corpus movements re-normalised and re-uploaded to MinIO

---

## Part 2 — Backend Write Surface

The endpoints the tagging UI depends on. Build these first so the frontend is never blocked on a mock. All routes are `/api/v1/`-prefixed; all role enforcement is `require_role()` (no inline checks); every write passes through a Pydantic model before it reaches a database (CLAUDE.md invariants).

---

### Step 3 — Concept search endpoint

**Powers the concept picker (§7.1 of the design).**

Add a search query to `backend/graph/queries/concepts.py` that calls the `concept_search` full-text index created in Component 4:

```cypher
CALL db.index.fulltext.queryNodes("concept_search", $q)
YIELD node, score
WHERE node.stub = false AND node.top_level_taggable = true
  AND ($domain IS NULL OR node.domain = $domain)
RETURN node, score
ORDER BY score DESC
```

The `stub = false AND top_level_taggable = true` filter is the picker-inclusion rule from ADR-011 §5 — enforce it in the query, not the client. For each hit, compute the hierarchy path (`PAC > Authentic Cadence > Cadence`) by walking `IS_SUBTYPE_OF` upward; return `id`, `name`, `aliases`, hierarchy path, and a definition summary.

Wire a `ConceptService.search()` (new `backend/services/concepts.py`) and the route `GET /api/v1/concepts/search?q=&domain=&cursor=` in a new `backend/api/routes/concepts.py`, mounted in `api/router.py`. Cursor-based pagination per the API conventions; `require_role("editor")`.

**Verification.** `GET /api/v1/concepts/search?q=perfect%20authentic` returns PAC ranked first; a stub or `top_level_taggable=false` concept never appears; `domain=cadences` narrows correctly.

---

### Step 4 — Concept schema-tree endpoint

**Powers the dynamic property form (§7.4), the Type Refinement section (§7.2), and the stage bracket track (§4).**

`GET /api/v1/concepts/{id}/schemas` returns everything the UI needs to render the right-hand panel for a concept, in one call:

- **Property schemas** — reuse `get_inherited_schema_ids()`, then hydrate each schema with `cardinality` (`ONE_OF`/`MANY_OF`/`BOOL`), `required`, `description`, and its `PropertyValue` list. For each value carrying a `VALUE_REFERENCES` edge, include the referenced concept's `name` and definition so the form can render the ⓘ info-link without a second round-trip.
- **Stage structure** — the concept's `CONTAINS` edges (direct and inherited), each with `target`, `order`, `required`, `display_mode`, `containment_mode`, and `default_weight`. This is what pre-populates the stage brackets.
- **Type Refinement** — the direct `IS_SUBTYPE_OF` children whose `CONTAINS` structures differ from one another (per ADR-011 §7, refinement is shown only when the choice changes which stage brackets appear). Return enough to render the radio group and to re-fetch the chosen child's stage structure.

Add the supporting Cypher to `graph/queries/concepts.py`, the assembly logic to `ConceptService`, and the route to `concepts.py`. The schema tree mirrors `knowledge-graph-design-reference.md`; this endpoint is the single source the form reads.

**Verification.** `GET /api/v1/concepts/PerfectAuthenticCadence/schemas` returns the inherited cadence schemas (including the BOOL schemas with no values), the four cadence stages in `order` with their `default_weight`s, and any applicable refinement. A `pytest` integration test asserts inheritance resolves identically to the `test_schema_inheritance.py` fixture from Component 4 Step 14.

---

### Step 5 — Fragment write validation layer

**The guardrail that locks the `summary` JSONB and the cross-system concept contract before the first row is written.**

Define the Pydantic write models in `backend/models/`, extending the existing `FragmentSummary` in `fragment.py` (it already exists — do not create a duplicate `summary.py`). The validation layer enforces, before any write:

1. **`summary` schema v1** — `version == 1` required; `key`, `meter` required; `concepts` non-empty with the primary concept first; `properties` values valid against the applicable schemas (ONE_OF → string, MANY_OF → array, every value a real `PropertyValue.id`); `required: true` schemas present. See `fragment-schema.md` § "The summary JSONB schema." Under the DCML-only decision (option b), `actual_key.value` is seeded from the DCML `local_key` at the fragment's start with `auto: false`, `reviewed: true`, no `confidence`; `music21_version` stores `"none"` (or `null`); and `fragment-schema.md` gets the one-line relaxation `required when any auto field is present` applied alongside this step.
2. **Concept existence** — every `concept_id` in the tag list exists in Neo4j (the cross-database referential-integrity check; there is no DB FK). Reject with a descriptive error if not. This is the only mechanism guarding `fragment_concept_tag.concept_id`.
3. **Beat constraints** (ADR-005) — `floor(beat_start) >= bar_start`, `ceil(beat_end) <= bar_end`, `beat_start < beat_end`; null beats allowed (measure-level selection).
4. **Containment** — each child fragment's `[bar_start, beat_start] .. [bar_end, beat_end)` falls within its parent's range. Service-layer check, not a DB constraint (`tagging-tool-design.md` §9).
5. **`data_licence`** — set per ADR-009 at write time.

**Verification.** Unit tests: a write referencing a non-existent `concept_id` (Neo4j mocked) is rejected; a `summary` missing a required property fails; an out-of-range child is rejected; beat constraints reject `beat_start >= beat_end`. No Docker.

---

### Step 6 — Fragment submission endpoints (draft → submitted)

**The producer write path.** Three operations, all `require_role("editor")`:

- `POST /api/v1/fragments` — create a `draft`. Accepts the full annotation payload: `movement_id`, `bar_start`/`bar_end`, `mc_start`/`mc_end`, `beat_start`/`beat_end`, `repeat_context`, `summary`, `prose_annotation`, the concept tag list (with `is_primary`), and a nested list of sub-part fragments. The tagging tool computes `mc_start`/`mc_end` from the in-memory MEI at tag time (ADR-015) and sends both coordinate pairs.
- `PATCH /api/v1/fragments/{id}` — update a `draft` (resume a saved session). Only the creating annotator or an admin; only while `status = 'draft'`.
- `POST /api/v1/fragments/{id}/submit` — transition `draft → submitted` once all blocking checklist items are satisfied server-side.

**Atomic parent + child write** (`tagging-tool-design.md` §9): the parent fragment and all sub-part fragments are written in a single transaction. If any child write fails, the whole transaction rolls back — no partial submissions. The containment check (Step 5) runs before the transaction opens.

Add `backend/services/fragments.py` (the fragment service owns the transaction and the cross-database concept validation; no route handler touches a DB), the Pydantic request/response models, and `backend/api/routes/fragments.py` mounted in the router. List/read/update-beyond-draft/delete are **out of scope** (Component 7).

**Verification.** Integration tests against test Postgres: a create with two sub-parts writes three rows atomically; a forced child failure leaves zero rows; submit is rejected if a required property is missing; a non-creator editing a draft is rejected.

---

### Step 7 — Harmony-event correction endpoints

**The tagging UI edits harmony in place; the approval gate depends on those events being reviewed.** Because `movement_analysis` is the single source of truth for harmony (`fragment-schema.md`), corrections write back to the movement, not to the fragment.

Expose the four edit primitives from `fragment-schema.md` § "Harmonic rhythm and event durations", scoped to a movement and `require_role("editor")`:

- **Insert** an event at a beat; **Delete** an event (the prior event extends through its slot); **Move boundary** (change an event's `beat`); **Edit chord** (change `root`/`quality`/`inversion`/`numeral`/… without moving the beat). Moving a boundary and editing a chord are categorically different operations and must be separate endpoints/payloads — the UI must not conflate them.
- A **confirm/review** action that flips an event's `reviewed: true` without other changes (the common case for DCML events that are correct as imported).

Every edit finds the event by `(mn, volta, beat)` (the universal identity across sources; `mc` is an additional cross-check for DCML events), sets `source: "manual"`, `auto: false`, `reviewed: true`, and applies last-reviewer-wins concurrency (Phase 1 policy; no audit table built speculatively). Add the logic to a `movement_analysis` service (extend `services/ingestion.py`'s analysis path or a new `services/analysis.py`) and routes under `/api/v1/movements/{id}/analysis/...`.

**DCML-only consequence:** `bass_pitch`/`soprano_pitch` remain `null` for the Mozart corpus until Component 6's top-up pass. The summary panel must render their absence gracefully (Step 16), not show empty/zero values.

**Verification.** Integration tests: each primitive mutates `events` correctly and sets the provenance flags; a move-boundary does not alter chord identity; a confirm action flips only `reviewed`. A range slice returns the corrected event on the next read.

---

### Step 8 — Review state machine and approval gate

**The state machine is scoped to the tagging tool (`phase-1.md` §5.6); the reviewer-facing browse/queue UI is not (Component 7/8).** This step builds the service-layer state machine and its endpoints so the data model is correct from the first submission; finding submitted work to review is deferred.

- `POST /api/v1/fragments/{id}/approve` and `.../reject` (with comment), `require_role("editor")`. A reviewer who is **not** the fragment's creator records a row in `fragment_review` (`UNIQUE (fragment_id, reviewer_id)`; re-deciding updates the row). Admins approve/reject unilaterally.
- The **approval-gate service function** (`fragment-schema.md` § "Fragment approval and harmony review"): counts approving reviews excluding the creator against a configurable threshold (Phase 1 = 1); requires every `actual_key` with `auto: true` to be `reviewed: true`; and, for fragments whose concepts declare a `harmony` capture extension, requires every `movement_analysis` event in the fragment's range to be `reviewed: true`. Concepts that do not capture harmony (e.g. a Hemiola) skip the harmony check. Approve returns `422` with the specific unreviewed entries when the gate fails.
- Reject moves `submitted → rejected`; the creator can revise and resubmit (`rejected → draft → submitted`). All `status` filtering is enforced at the service layer, never UI-only.

**Verification.** Integration tests: creator cannot approve own fragment; an approval below threshold does not flip `status`; approval is blocked (422) while a harmony event in range is unreviewed for a harmony-capturing concept, and succeeds once reviewed; the same review satisfies the gate for a later overlapping fragment (event-level review, not fragment-level).

---

## Part 3 — Score Selection (Ghost Overlay)

The hardest part of the tagging tool. The architecture is proven (the prototype) and fully specified (ADR-005, `prototype-tagging-tool.md`); this part is its disciplined re-implementation with the four correctness fixes done up front, because wrong beat boundaries write wrong data, not just wrong pixels.

---

### Step 9 — Ghost structural layer

Port the prototype's `ghost.js` as a typed module (e.g. `frontend/src/components/score/ghosts.ts`) that builds an invisible SVG overlay of measure, beat, and sub-beat ghosts over the Verovio render and exposes the flat spatial indexes. Carry over verbatim (per the transfer table): the ghost anatomy (main/edge/gradient rects), the beat-boundary inference from notehead positions via `getTimesForElement` (reuse the existing call site in `verovio.ts`), the measure-local onset conversion, and the gradient edge zones as drag affordance.

Make explicit what the prototype left implicit, and implement the four ADR-005 "not yet handled" fixes — all correctness, not cosmetics:

1. **Named flat-index encoding** — define `encodeBeat`/`encodeSubBeat`/`decodeMeasure`/`decodeBeat`/`decodeSubBeat` as named constants (`BEAT_SCALE = 100`, `MEASURE_SCALE = 10000`), not inline arithmetic (ADR-005 § "Flat index encoding").
2. **Compound-meter beat count** — for 6/8, 9/8, 12/8 allocate `beatCount / subdivisionsPerBeat` beat slots (2, 3, 4) and divide the raw slot by `subdivisionsPerBeat`; use the raw slot directly for sub-beat ghosts. Must be correct before any compound-meter score is tagged.
3. **Per-measure meter reading** — `getMeterForMeasure()` reads a `<meterSig>` inside each measure before falling back to the global `scoreDef`. Prerequisite for sub-beat precision being meaningful across mid-movement meter changes (the MEI normalizer already copies a `<meterSig>` into affected measures, per `phase-1.md` § Component 1).
4. **Repeat-ending ghost-index collision** — first/second-ending measures share the same integer `@n` (Doppia convention, `mei-ingest-normalization.md` §6). Incorporate ending context into ghost IDs and index keys (`m${n}-e${endingN}`); detect `<ending>` context by walking up the DOM during ghost construction.

Skip grace notes (`scoreTimeDuration[0] == 0`), range-check `beat >= 0 && beat < beatCount` to drop tied-in continuations, and adjust `mLeft` past clef/key/time at system starts — all per the prototype's "handled" list.

**Verification.** Vitest fixtures: a 4/4 bar yields correct beat ghosts; a 6/8 bar yields 2 beat ghosts and 6 sub-beat ghosts; a movement with a mid-piece meter change reads each meter correctly; a fixture with a written-out repeat does not collide first/second-ending ghosts; a tied-across-barline note does not corrupt boundaries.

---

### Step 10 — Selection behavioural layer

Port the prototype's `annotator.js` interaction logic as a typed module, replacing per-element listeners with **event delegation** on a container and tracking highlighted ghosts in a `Set` (not a full-DOM `clearGhosts` scan), per the transfer table. Keep the mousedown/mouseenter/mouseup range-select model, the `add`/`rmv` class-toggle visual state (`light`/`dark`), and endpoint re-selection (clicking a gradient zone re-anchors the drag from the opposite end).

Two deliberate departures from the prototype:

- **Concurrent flags, not a phase enum** (ADR-011 §2, `tagging-tool-design.md` §2). The session tracks `fragmentSet`, `conceptSet`, `stagesComplete`, `propertiesComplete` independently; no interaction is gated on completing a prior one.
- **Resolution toggle** (ADR-005 § "Resolution toggle") — a segmented control switching Measure/Beat/Sub-beat. All ghost layers stay in the DOM; the toggle flips `pointer-events` and visual emphasis; ghost construction is not re-run.

Implement the by-design selection constraints from `prototype-tagging-tool.md`: backward repeat barlines, da capo, and dal segno clamp the selection (a fragment may begin a repeated section and extend into the first ending, but the close-repeat barline is a hard barrier); when a selection lands inside an ending, capture `repeat_context`. Onset-based inclusion (a note's onset inside `[beat_start, beat_end)` includes it regardless of duration) is the rule the committed coordinates encode.

**Verification.** Vitest/interaction tests: drag across three measures commits `[bar_start, bar_end]`; dragging a left endpoint re-anchors from the right; a selection clamps at a close-repeat barline; switching the resolution toggle changes which layer receives events without rebuilding ghosts.

---

### Step 11 — Main bracket track and selection commit

Render Layer 3 (the single main bracket above the staff) once `fragmentSet` is true, with gradient drag handles at both endpoints (`tagging-tool-design.md` §3). On commit, resolve the selection to the full coordinate set the write API expects: `bar_start`/`bar_end` (human `@n`), `mc_start`/`mc_end` (1-based document-order position index, computed from the in-memory MEI per ADR-015), `beat_start`/`beat_end` (float encoding, null at measure resolution), and `repeat_context` if inside an ending.

This is the contract between the overlay and Step 6's `POST /api/v1/fragments`. Pin it as a typed selection object so Part 4 and Part 5 build against a stable shape.

**Verification.** A committed selection over a known Mozart passage produces the expected `mc_start`/`mc_end` (cross-check against the same movement's DCML `mc` values) and the expected `bar_start`/`bar_end`; a selection inside a first ending sets `repeat_context = "first_ending"`.

---

## Part 4 — Classification and Multi-Level Tagging

With a committed selection, the annotator classifies it. Every interaction here is reactive against the concurrent-flag state and updates both the form panel and the score overlay (the bidirectional score↔form linking of `tagging-tool-design.md` §6).

---

### Step 12 — Concept picker and Type Refinement

Build the form-panel concept picker (§7.1): a search box (debounced calls to Step 3), a hierarchy browser (expandable `IS_SUBTYPE_OF` tree), and domain facets. The picker shows only `stub: false AND top_level_taggable: true` concepts (the server already filters; the client must not re-introduce excluded nodes). Selecting a concept sets `conceptSet` and fetches its schema tree (Step 4).

Render the **Type Refinement** section (§7.2, ADR-011 §7) only when the concept has `IS_SUBTYPE_OF` children with differing `CONTAINS` structure. It sits above the property form because the choice reshapes the stage brackets below it. The chosen refinement is display-layer (the picker keeps the parent selected) but is recorded in the submission payload so the server knows which subtype was identified. A structural choice is always a subtype split, never a property value — if a property value would change the stage layout, that is a graph-modelling bug, not a UI case.

**Verification.** Searching surfaces the right concept with its hierarchy path; selecting a concept with structurally-divergent children shows the refinement radio group; selecting one whose children differ only in properties does not.

---

### Step 13 — Dynamic property form

Generate the form from the schema tree (Step 4), per `tagging-tool-design.md` §7.4: required properties first (a missing one blocks submission), optional after, visually separated. `ONE_OF` → radio group (≤5 values) or select (>5); `MANY_OF` → checkbox group or multiselect. `BOOL` schemas (ADR-019) render as a single toggle with no value list. Values carrying `VALUE_REFERENCES` show an inline ⓘ that reveals the referenced concept's name and definition (already in the Step 4 payload).

Implement form-state carryover (§5.3 of `phase-1.md`, §7.4): when the annotator changes the selected concept, values for schemas shared via inheritance carry over; values for schemas no longer applicable are discarded. The form has no hardcoded concept-specific logic — it is entirely schema-driven, so new domains produce correct forms with no frontend change (the PropertySchema-extensibility forward-compat note in `phase-1.md`). Completed required properties set `propertiesComplete`.

**Verification.** A PAC renders its inherited cadence schemas including the BOOL toggles; switching from PAC to IAC keeps shared values and drops inapplicable ones; submission is blocked while a required property is empty.

---

### Step 14 — Stage bracket track

The richest interaction. Render Layer 4 (stage brackets below the staff) once `conceptSet` is true and the concept has `CONTAINS` edges (`tagging-tool-design.md` §4, §6; ADR-011 §1, §3, §6). Implement:

- **Pre-population** — distribute stage brackets across the main fragment by `default_weight` (equal if unset), snapped to the active selection grid; resolve snapping left-to-right with the rightmost stage absorbing the remainder.
- **Contiguous split-handle** — for `containment_mode: contiguous` (the cadence default), adjacent stages share one boundary object; dragging the split handle moves both edges, making gaps/overlaps impossible. `free` mode (independent endpoints with gap/overlap warnings) is defined but **not implemented in Phase 1**.
- **Required vs optional** — required stages are solid and must be assigned; optional stages are dashed at their defaults and enter "confirmed" state when dragged. The **absent toggle** (in the stage list, §7.3) collapses an optional stage to zero width and redistributes its share to neighbours in contiguous mode. An optional stage that is neither dragged nor toggled is in *limbo* and **blocks submission** — the checklist flags it.
- **Compound/segment** — a stage whose sub-stages carry `display_mode: segment` is divided internally by a split handle (segments in the same row), not given a new row. `display_mode: stage` at depth ≥3 is rejected at seeding (the two-level limit); the UI never has to render a third row.
- **Layer 5** — active-stage beat sub-selection: beat ghosts activate only within the active stage's bounds during sub-beat refinement, suppressed elsewhere; one stage active at a time.
- **Reactive structural change** — on concept/refinement change, keep stages whose IDs survive, orphan (grey + warn, not submitted) those that don't, and pre-populate new required stages; on main-bracket contraction that orphans a stage spatially, show the error state and block submission until resolved.

`stagesComplete` becomes true when all required stages are assigned and all optional stages are confirmed-or-absent (and trivially true for stageless concepts, §8).

**Verification.** Selecting a PAC pre-populates four stages by weight, snapped to the grid; the split handle moves a shared boundary with no gap; marking an optional stage absent redistributes space; an optional stage left in limbo blocks Submit; changing concept orphans non-surviving stages rather than deleting silently.

---

### Step 15 — Stage child fragments and inline property forms

Every stage confirmed as present — required, dragged from its default position, or not explicitly toggled absent — becomes a child fragment linked by `parent_fragment_id` (`fragment-schema.md`). No concept picker is involved: the concept is implicit from the stage bracket's graph metadata (`CadentialInitialTonic`, `CadentialPreDominant`, `CadentialDominant`, `CadentialFinalTonic`). Child fragments are created for all confirmed stages on submission, regardless of whether stage properties were filled.

**Inline stage property form.** When a stage card is active in the form panel, it expands to show an inline property form generated from the stage concept's `HAS_PROPERTY_SCHEMA` edges — same control types as Step 13. All stage schemas are `required: false`. The submission checklist does not gate on stage properties being filled. Values are stored in the child fragment's `summary.properties`; an unfilled stage produces a child fragment with `summary.properties: {}`.

The atomic parent+child write (Step 6) covers the parent cadence fragment and all stage child fragments in one transaction. The service-layer containment check confirms that every child's spatial bounds fall within the parent's range.

**Verification.** Tagging a PAC with no stage properties filled produces four child fragments (one per confirmed stage) each with `parent_fragment_id` set, the correct stage `concept_id`, and `summary.properties: {}`; submitting writes all atomically. Filling in `Stage2Components` on the Pre-Dominant card stores the selected values in that child's `summary.properties`. A stage bracket pushed outside the parent's range is rejected at submission.

---

> **Implementation note — Step 15 revision.** Steps 1–15 were implemented before the stage storage model was finalised. The original Step 15 included a concept selector opened by a "tag analytically" toggle on each stage card. That selector should be removed. The backend — child fragment creation via `parent_fragment_id`, atomic write in the Step 6 service, containment check — can stay unchanged; the child fragment's `concept_id` should be the stage's own concept id, implicit from the graph, not a user selection. The frontend change is: remove the concept picker from the stage interaction entirely and replace it with the inline stage property form described above. Child fragments already written with a `concept_id` matching the correct stage concept id are valid as-is; those written with an annotator-selected id should be reviewed.

---

## Part 5 — Summary, Prose, and Submission

The panels that complete the record and the session state that gates Submit.

---

### Step 16 — Harmony summary panel (DCML-sourced)

Render the structured summary the annotator reviews (`phase-1.md` §5.5, `fragment-schema.md`). The harmony portion reads `movement_analysis` sliced by the fragment's range (via the service layer — no cross-DB call in the route) and displays the per-event timeline: `numeral`, `local_key`, `root`/`quality`/`inversion`, with each event's `source`, `auto`, and `reviewed` state visible. The four edit primitives and the confirm action wire to Step 7.

DCML-only consequences to handle in the UI:

- `bass_pitch`/`soprano_pitch` are `null` for the Mozart corpus (no music21 top-up until Component 6). Render their absence as "not computed," not as empty/zero. The IAC soprano-degree and half-cadence-shape facts are *annotator-entered property values* (Step 13), not derived from these fields, so tagging is unaffected.
- `actual_key.value` is seeded from the DCML `local_key` at the fragment's start with `auto: false, reviewed: true` (option b, taken in "Decisions taken into this plan"). The panel lets the annotator confirm or correct it; `music21_version` displays as `"none"` (or is omitted from the visible summary).

The notated `key`/`meter` (high-reliability, from MEI) display without review flags.

**Verification.** Opening a fragment over a DCML-annotated passage shows the correct sliced events; correcting a chord flips its provenance and persists; bass/soprano render as "not computed"; the harmony review state matches what the approval gate (Step 8) checks.

---

### Step 17 — Prose annotation field

A free-text area writing to `fragment.prose_annotation` (raw text now; embeddings generated in Phase 3 against the scaffolded `prose_chunk` table — ADR-007). No processing in Phase 1 beyond persistence. This is the expert commentary that becomes the RAG corpus, so it is stored on the fragment from day one to avoid a later data-archaeology migration.

**Verification.** Prose round-trips through create/draft-resume/submit unchanged; it is never stored inside `summary`.

---

### Step 18 — Submission checklist and save/submit wiring

Implement the always-visible checklist (`tagging-tool-design.md` §7.5) bound to the concurrent-flag state: fragment drawn, concept selected, Type Refinement set (if applicable), required stages assigned, optional stages confirmed-or-absent, required properties set, stage bounds within the main bracket — all blocking; free-mode gaps/overlaps warning-only (and N/A in Phase 1, since `free` is unimplemented). Submit is disabled until every blocking item clears.

- **Save Draft** persists the current state as `status: 'draft'` with any incompleteness allowed (calls `POST`/`PATCH` from Step 6); drafts resume in a later session.
- **Submit for Review** requires all blocking items and calls `POST .../submit`; the server re-validates (never trust the client) and performs the atomic parent+child write.

**Verification.** Submit stays disabled until the last blocking item clears; Save Draft persists a partial annotation that reloads faithfully; the server rejects a submit that passes the client checklist but fails server validation (e.g. a concept_id that vanished from the graph).

---

## Part 6 — Tests, CI, and Docs

Turns the tagging tool from "works on my machine" to "protected against regression."

---

### Step 19 — Backend tests

Beyond the per-step tests above, add coverage for the integration surfaces: concept search ranking and the picker filter; the schema-tree endpoint including inheritance and Type-Refinement detection; the full fragment write path (validation, atomic parent+child, containment, concept-existence); the harmony primitives and provenance flags; and the approval gate's every branch (creator exclusion, threshold, `actual_key` review, harmony-event review for harmony-capturing concepts, the 422 payload). Unit-level where possible (no Docker); integration-marked where a real Neo4j/Postgres is required, per the Component 4 marker convention.

**Verification.** `pytest backend/tests/unit/` green; `pytest -m integration` green against the service containers; coverage on the new services and routes meets the project bar.

---

### Step 20 — Frontend tests

Vitest coverage for the correctness-critical logic: beat-boundary inference across 4/4, 6/8 (compound), mid-piece meter change, pickup bar, and repeat-ending fixtures; the flat index encode/decode round-trip; the selection state model (concurrent flags, endpoint re-selection, repeat-barrier clamp); the `mc_start`/`mc_end` derivation; stage pre-population and split-handle math; and dynamic-form generation from a schema-tree fixture. The ghost geometry tests are the highest-value ones — they guard the data the database stores.

**Verification.** `npm test` green; the compound-meter and repeat-ending fixtures specifically assert correct beat counts and non-colliding index keys.

---

### Step 21 — CI integration and doc updates

Wire the new test suites into CI alongside the Component 4 graph jobs. Update the architecture docs whose area this component touches, per CLAUDE.md's Definition of Done (these are docs and so are edited here in Cowork): the one-line `fragment-schema.md` relaxation around `music21_version` (already noted under Step 5 — confirm it landed); a short "Implemented in Component 5" note added to `tagging-tool-design.md` mapping its sections to the shipped modules; ADR-022 and the ADR-021 supersession header (Part 1 Step 2) are already in place by the time this step runs. The CLAUDE.md/CONTRIBUTING.md edits (testing-section additions, any new conventions) are **root-level files and must be made via Claude Code** — flag them in the handoff, do not edit them here.

**Verification.** CI runs the backend and frontend tagging suites on every PR; the touched docs reflect the shipped behaviour; the handoff note lists the root-file edits left for Claude Code.

---

## Decisions to Confirm

None outstanding. The original draft surfaced three (`actual_key`/`music21_version`, the Component 5/7 boundary, and `free`-mode/deeper-nesting deferral) and the initial review surfaced one more (ADR-021 supersession strategy); all four are recorded above under "Decisions taken into this plan." This section is preserved as a placeholder so any new question that arises during implementation has an obvious home.

---

## Deferred to Later Components

Stated explicitly so the boundary is a decision, not a gap:

- **On-score display of stored fragments** — the bracket overlays, alias labels, collapsed/expanded sub-part rendering, and the click-to-open side panel for *existing* fragments. Component 7 (`phase-1.md` § "On-Score Visual Indicators").
- **Fragment read/browse CRUD and edit/delete** of stored records, with the delete-permission rules and parent-cascade confirmation. Component 7.
- **Reviewer work-queue / browse-by-status UI.** Component 7/8 (the state machine and gate ship here in Step 8).
- **Server-side fragment-preview generation** (Celery + Verovio Python bindings, ADR-008). Component 8.
- **music21 auto-analysis fallback and the bass/soprano top-up pass.** Component 6; until then `movement_analysis` is DCML-sourced and `bass_pitch`/`soprano_pitch` are null.
- **`free` containment mode and deeper sub-part nesting.** Phase-1-deferred by the design (ADR-011 §3; two-level display limit). The plan honours both deferrals.
- **The `mc`-range harmony query simplification** noted as deferred in `fragment-schema.md` (filtering events by `mc` instead of `(mn, volta)`); Step 7/8 use the `(mn, volta, beat)` identity as the docs currently specify.

---

## Sequencing

Part 1 (the accidentals carry-in) runs first because subsequent steps assume corrected MIDI. Part 2 is independent of Parts 3–5 and proceeds in parallel with the ghost-overlay work once Part 1 is done; Parts 4–5 depend on Part 3; Part 6 trails the feature work. The frontend (Parts 3–5) and backend (Part 2) are the natural parallel split if two work-streams are available.

```
Day 1-2:   Step 1 (pass 8 re-implementation with key-signature awareness)
Day 3:     Step 2 (regression suite + ADR-022 + ADR-021 supersession header)
Day 4-5:   Step 3 (concept search) + Step 4 (schema-tree endpoint)
Day 6:     Step 5 (write validation layer)
Day 7-8:   Step 6 (submission endpoints, atomic parent+child)
Day 9:     Step 7 (harmony-event correction endpoints)
Day 10:    Step 8 (review state machine + approval gate)
Day 11-13: Step 9 (ghost structural layer + the four correctness fixes)   ← parallel with Part 2
Day 14-15: Step 10 (selection behavioural layer) + Step 11 (main bracket + commit)
Day 16:    Step 12 (concept picker + Type Refinement)
Day 17:    Step 13 (dynamic property form)
Day 18-20: Step 14 (stage bracket track — the richest interaction)
Day 21:    Step 15 (sub-part tagging)
Day 22:    Step 16 (harmony summary panel) + Step 17 (prose field)
Day 23:    Step 18 (submission checklist + save/submit wiring)
Day 24-25: Step 19 (backend tests) + Step 20 (frontend tests)
Day 26:    Step 21 (CI + doc updates)
```

Step 9 is the schedule's critical path and its highest-risk item; start it on Day 11 in parallel with the backend so a slip there does not stall the whole component. Steps 12–18 are a tight reactive-UI loop and will surface design questions worth resolving against `tagging-tool-design.md` as they arise.

---

## Hard Gates Before Component 6 / Component 7 Begins

1. Pass 8 of `mei_normalizer.py` correctly preserves key-signature-implied gestural accidentals while still stripping cross-staff propagations; the regression suite covers both sides; ADR-022 is Accepted and ADR-021 carries the `Superseded by ADR-022` header with the pointer paragraph.
2. An annotator can take a blank rendered score to a `submitted` fragment record entirely through the UI: select (measure, beat, and sub-beat), classify, fill required properties, tag at least one sub-part, review harmony, write prose, and submit.
3. The atomic parent+child write is proven: a multi-sub-part submission writes all rows or none.
4. `mc_start`/`mc_end` written by the tool match the DCML `mc` for the same physical measures on a sample movement (the dual-coordinate contract holds end to end).
5. The four ghost correctness fixes are verified against fixtures: compound meter, mid-piece meter change, repeat-ending non-collision, tied-across-barline.
6. The review state machine and approval gate behave per `fragment-schema.md`: creator exclusion, threshold, `actual_key` review, and harmony-event review for harmony-capturing concepts; approve returns a 422 with specifics when the gate fails.
7. `pytest -m integration` (tagging surfaces) and `npm test` (ghost geometry + state model) pass in CI.
8. The `fragment-schema.md` one-line relaxation around `music21_version` (option b) is in place.
9. The handoff note lists the root-file edits (CLAUDE.md/CONTRIBUTING.md) left for Claude Code.
