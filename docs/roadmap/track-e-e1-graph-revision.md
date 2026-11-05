# Track E — E1: Graph Revision — Implementation Plan

This document turns the reviewed Caplin proposals into a sequenced set of tasks.
It does not restate them: the reasoning, page references and draft wording are
in
[`../investigations/caplin-graph-review/proposals.md`](../investigations/caplin-graph-review/proposals.md)
(cited here as **P1**–**P12** and **Q1**–**Q11**). The track is defined in
[`track-e-editorial-acceleration.md`](track-e-editorial-acceleration.md).

**Status:** ready, 2026-11-05. All questions are answered (`proposals.md` § F).
This plan details stage E1 of the track document; it does not replace it.

---

## Four facts that shape the steps

- **The seed script never deletes.** `scripts/seed.py` only uses `MERGE`, and
  `backend/graph/queries/seed.py` has no delete. Removing a `HAS_PROPERTY_SCHEMA`
  edge from the YAML leaves it in Neo4j, so retiring `Unison` and moving
  `Covered` need an explicit removal step on every environment (Step 5).
  The orphan guard in `seed.py` protects concept ids only.
- **The glossary is bilingual.** `backend/seed/translations/es.yaml` overlays
  definitions and names, so every rewritten public text changes in both
  languages (Step 8).
- **The local database is not the campaign.** It holds 21 top-level fragments.
  The counts that gate this work must come from staging (Step 1).
- **The tool refuses a child-less fragment.** Q5 needs one case of it, a Dominant
  Arrival on a terminal dominant. The guard is small and frontend-only (Step 14).

---

## Part 1 — Facts

### Step 1 — Staging counts

Run `scripts/e1_staging_facts.py` (read-only) for the checks in `proposals.md` § E,
with the staging connection string in the git-ignored `private/staging.env`.

**Gates:** `Unison` retires only if its count is zero, or the values are migrated
first. `Covered` moves only if no non-realised cadence carries it. The other
counts size Step 15.

---

## Part 2 — Seed pass (`seed(cadences):`)

Branch: this one (`feature/track-e-e1-caplin-review`), or a new
`feature/track-e-e1-seed` if the review docs merge first. Pre-commit needs the
backend venv on `PATH` for seed YAML commits.

### Step 2 — Public definitions

Rewrite from § C: `ImperfectAuthenticCadence`, `EvadedCadence`,
`DominantArrival`, `AbandonedCadence`, `CadentialDominant`. Francisco approves the
text in this step; anything not approved goes back to `definition_reviewed: false`.

Optional wording from P9: `Cadence`, `HalfCadenceRealised`.

### Step 3 — Schema and value descriptions

Rewrite: `CadenceFunction` with its three value descriptions, `Covered`, `ECP`,
`Premature`, `HalfCadenceShape`, `ReinterpretedAsHC`, `IACSopranoDegree`. Rename
`Basic` to "Simple (I–V)" (id unchanged).

### Step 4 — New properties

- `Elided` (BOOL) on `AuthenticCadence`.
- `PrinnerCadence` (BOOL) on `ImperfectAuthenticCadence`.
- A BOOL on `DeceptiveCadence`, named "Deceptive Cadence (3̂)".
- A stage-1b value on `Stage1Components`, with a `TonicSubstitute` stub in
  `harmonic-functions.yaml`.

Group the rare BOOLs with the existing "other" group (Component 12 Step 16).

### Step 5 — Removals and moves

- Retire `Unison`, subject to Step 1.
- Move `Covered` from `Cadence` to `AuthenticCadenceRealised`, subject to Step 1.
- Remove the `post_evasion_harmony` capture extension from `EvadedCadence`, and
  `harmony_object` from `backend/seed/schemas.py` with its tests.
- Write one idempotent script that deletes the stale edges and the `Unison`
  nodes, and run it on local and staging after seeding. It belongs in
  `scripts/`, with a note in `docs/deployment.md`.

### Step 6 — Edges and names

- `ReopeningHalfCadence` `FOLLOWS DeceptiveCadence`; widen the `prior_ac_pointer`
  description; add the alias "Reopened HC".
- `ContrapuntalCadence`: name "Prolongational Closure", alias "Contrapuntal
  Cadence" (`prolongation.yaml`).
- Swap the Half Cadence names (P12).

### Step 7 — `expected_stages`

- Add the field to the concept model in `backend/seed/schemas.py` and to the
  seed, then fill in the P1 table.
- Store it so E3 and E4 can read it, inherited down `IS_SUBTYPE_OF` and
  overridable by a subtype. Nothing reads it in E1.

### Step 8 — Spanish

Update `es.yaml` for every changed definition, description and name, and add the
new properties. Definitions are editorial text, so Francisco reviews these too.

### Step 9 — Verification

- `python scripts/seed.py --domain cadences` (and `prolongation`,
  `harmonic-functions`).
- `python scripts/validate_graph.py`.
- `python scripts/visualize_domain.py --domain cadences`, then **confirm the
  structure by eye** before committing.
- `DOPPIA_RUN_INTEGRATION=1 pytest backend/tests/graph/`. Expected changes: the
  inherited-schema counts in `test_schema_inheritance.py`.
- `pytest` for the seed-schema unit tests.
- Open the tagging tool on a PAC, an IAC, a deceptive and an evaded cadence, and
  check the form shows the right properties.

---

## Part 3 — Records

### Step 10 — Design documents and ADR

- `cadences-design.md`: amend decision 4 ("optional in structure, expected in
  data"), update the BOOL list in decision 7, record the `CadenceFunction`
  departure, record decision 8's shape, drop the planned Contrapuntal split.
- ADR-042 (expected stages and the stage rule): written 2026-11-05. Step 7 records
  the final field shape as an amendment.
- `capture_extensions.md`: `harmony_object` removed; `post_evasion_harmony` as a
  computed lookup.
- `component-15-exercises.md`, `phase-2.md` decisions log: capture work moves to
  E3 (P2).
- `knowledge-graph-design-reference.md`: the three-way rule from P2.
- `formal-function-design-notes.md`: a pointer to the re-deferred items (§ D).
- `track-e-editorial-acceleration.md`: mark the E1 decisions settled.

### Step 11 — Tagging guidelines

Write `docs/howto/tagging-guidelines.md` (P11), including the `CadenceFunction`
rulings, the stage rule, and the bounds rule for a terminal-dominant DA. Add it to
the CLAUDE.md documentation table.

### Step 12 — Prose guidelines

The document says to revisit after E1. Add: any `confidence` below *secure* needs
the argument; the galant-habit and denied-way-station cases name themselves in
prose; the prior AC of a reopened HC names the reopening (Q8).

### Step 13 — Reference annotations

Turn `corpus-test-cases.md` into a machine-readable fixture under
`backend/tests/fixtures/`: movement, bars, concept label(s), page reference,
and a flag for Caplin's own open ambiguities. **Labels and bar numbers only**
(Q9), because the repository is public. Check bar numbers against the MEI `mn`
values before E2 relies on them.

---

## Part 4 — Tool change

### Step 14 — Allow a fragment with every stage absent

Needed before a terminal-dominant DA can be tagged (P10). Commit type `feat:`, on
its own, separate from the seed commits.

- Drop the last-active guard in `toggleStageAbsent`
  (`frontend/src/components/score/stages.ts`).
- Drop `isLastActive` from `StageList.tsx`, and the `stageList.cannotRemoveLast`
  key from both `score.json` locales.
- Unit tests: removing the last stage leaves zero active and no error;
  `computeStagesComplete` holds; re-enabling from zero places the stage across the
  selection.
- Check the path in a browser: tag, submit, re-open and edit a child-less fragment.
  This is a rendering and form flow, so unit tests alone are not enough.
- `tagging-tool-design.md` §§ 4 and 7.3: all stages may be absent; contiguity
  applies to the stages present.

The backend needs no change (`sub_parts` defaults to empty).

---

## Part 5 — Existing fragments

### Step 15 — Audit list

List the fragments on staging that the decisions touch, from the Step 1 queries:
deviations with a stage that breaks P10, half cadences that break the Q3 ruling,
evaded fragments that do not end at their dominant stage, `Covered` values to
re-check against the new meaning. Corrections are editorial: Francisco makes them
in the tool, one by one (ADR-041). No bulk rewrite of fragments, and no prose
backfill (P5). If the list is long, it goes through the E4 flags instead of being
cleared here.

---

## Handed to later stages

| Item | Stage |
|---|---|
| Expected-shape defaults; `Cadential64` and component preselection; `ECP` hint; shape preselection from the bass | E3 |
| Initiating-harmony lookup; pointer confirmation UI, accepting a deceptive target | E3 |
| `confidence` field (three values, default *secure*), with `fragment-schema.md` and its ADR | E3 |
| Mapping rules (P4) and the fourth bucket; Caplin as a third reader | E2 |
| Flags: `WayStation` on a PAC, `ClosesTransition` on a PAC, `Elided` on evaded, `Covered` without `Elided`, SD5, IAC-target closing section, fragment ending deep in a prolonged V, missing prose on low `confidence` | E4 |
| Texture flag (replaces `Unison`) | E4 |

---

## Deferred

- **Public "how we analyse" page (Q11):** built from the tagging guidelines, in
  both languages, alongside the production launch (recorded in the track document).
- Everything in `proposals.md` § D.

---

## Sequencing

```
Step 1 (staging counts) → Steps 2–8 → Step 9 → Steps 10–13 → Step 15
                          Step 14 (independent; before any terminal-dominant DA is tagged)
```

Steps 2–4 and 6 can start before Step 1, because they add or reword and remove
nothing. Step 5 cannot.

**Staging:** the seed and the Step 5 script run after the PR merges, then the
glossary is checked on staging in both languages.

---

## Exit

From the roadmap: every graph concept and property has a status, and every
deferred E1 decision is taken or explicitly re-deferred. In practice:

- graph validation and graph tests green, and the visual check done;
- stale edges gone on staging;
- documents in Part 3 updated in the same PR;
- a child-less fragment can be tagged, submitted and re-opened;
- audit list delivered.
