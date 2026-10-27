# ADR-041 — Editorial Machine Assistance and Fragment Provenance

**Status:** Accepted (rule and shape). Column names and value sets are
indicative until the first stage that writes them (Track E, E2 or E3); that
stage records the final names as an amendment here.
**Date:** 2026-10-08
**See also:** `docs/reports/editorial-acceleration-planning.md` (the
discussion this ADR records, § 4.9), `docs/roadmap/track-e-editorial-acceleration.md`
(the track that implements it), `docs/architecture/fragment-schema.md`
(`fragment` table; `actual_key` and event-level `auto`/`reviewed`),
`docs/architecture/corpus-and-analysis-sources.md` (per-event `source`),
`docs/adr/ADR-006-internationalisation-strategy.md` (§ 7 — the
`machine`/`reviewed`/`authoritative` precedent for translations),
`docs/roadmap/phase-2.md` (the "no AI layer" statement this ADR amends)

---

## Context

The bottleneck in Doppia is now editorial throughput, not infrastructure. The
campaign has covered a small part of the 18 sonatas, the review queue holds
50+ fragments, and with a single active editor "review" largely means
re-reading one's own work. Track E proposes tools that reduce repetition:
DCML cadence labels as candidates, defaults derived from the harmony data,
pre-population from recurring passages, consistency checks and, later,
model-based critique and proposals.

Each of these puts **values that a machine proposed** into the editorial
workflow. The repository tracks provenance today only at the **event** level:
`movement_analysis.events[*]` carries `source`, `auto` and `reviewed`, and
`summary.actual_key` carries `auto`/`reviewed`/`confidence`. Nothing records,
at fragment level, how a fragment came to exist. Nothing records, at value
level, whether a property value or a stage boundary was chosen by the
annotator or accepted as preselected.

Two things are at stake without that record.

1. **The repository's claim.** An approved fragment is a statement that an
   expert judged this passage this way. Once machines propose, the claim holds
   only if a human action stands between every proposal and approval, and if
   the record shows which values were proposed.
2. **Statistics that feed back into tooling.** Typicality defaults (§ 4.5 of
   the report) are computed from approved data. If accepted defaults are
   indistinguishable from active choices, the statistics measure the tool's
   own suggestions, and the loop is invisible.

The Phase 2 roadmap says "No AI layer; that remains Phase 3." The Phase 3 layer
is a user-facing tutor that consumes the data. What Track E proposes is
different in kind: assistance on the production side, used only by editors.
The phase boundary needs restating so the two are not confused.

---

## Decision

### 1. Scope: editorial-side assistance is permitted from Phase 2

Machine assistance in editorial work is permitted from Phase 2 onward. This
means any value proposed by code or by a model that enters the tagging,
editing or review workflow. It covers deterministic tooling (DCML candidates,
harmony-derived defaults, correspondence detection, consistency checks) and
model-based tooling (critique; later, proposals) alike.

**User-facing AI remains Phase 3.** No model output is shown to anonymous or
registered users, and no user data (accounts, collections, exercise history)
is sent to a model by editorial tooling.

### 2. The rule: machines propose; only human actions produce approved data

No machine-originated value reaches `approved` status without a human action
on it. Concretely, machine output may enter the workflow only in three forms:

- **(a) A candidate.** A pointer to a passage with a proposed concept, kept in
  a list *outside* the `fragment` table. A candidate becomes a fragment only
  when an editor opens it and commits a selection in the tagging tool.
  Machines never create `fragment` rows, not even drafts. A draft keeps
  meaning "an editor started this", and machine output does not inflate the
  drafts list or the review queue.
- **(b) A preselected value** in the tagging form: a property value, a stage
  boundary, a capture-extension value. It is shown as preselected, visually
  distinct from values the editor set, until the editor touches it. Submitting
  is the human action. What was accepted unchanged is recorded (§ 4).
- **(c) A flag** on a fragment in the review queue: a consistency-check
  result or a model critique. A flag writes nothing to the fragment. Resolving
  it, by editing or by dismissing it, is a human action.

Computed read-time derivations (for example a harmony looked up from
`movement_analysis` by position) are not proposals. They are not stored as
fragment data and carry no provenance of their own.

### 3. Fragment-level origin

`fragment` gains two columns (names indicative, see Status):

```sql
origin      TEXT NOT NULL DEFAULT 'manual'
                CHECK (origin IN ('manual', 'dcml_candidate',
                                  'correspondence', 'model_proposal')),
origin_ref  JSONB          -- what the origin points at; null for 'manual'
```

- `origin` records **how the fragment started**, not who edited it last. It is
  set at creation and never changed.
- `origin_ref` identifies the source:
  - `dcml_candidate`: the DCML label position and label;
  - `correspondence`: the source fragment id and the span-correspondence
    record;
  - `model_proposal`: the model identifier and version, and the proposal
    record.
- Existing rows are backfilled `'manual'`. Child (stage) fragments inherit
  their parent's `origin`.

**These are columns, not `summary` fields.** `summary` is a published API
holding analytical content. Provenance is editorial metadata, and putting it
in `summary` would mean a version bump for something that is not analysis. The
change is an ordinary Alembic migration.

### 4. Value-level provenance: "accepted unchanged" vs. "set"

`fragment` gains `value_provenance JSONB`. It records, for each value that was
**preselected by a machine**, where the preselection came from and whether the
editor submitted it unchanged:

```json
{
  "properties": {
    "CadenceFunction": { "from": "default_hint", "accepted_unchanged": true },
    "Cadential64":     { "from": "harmony_derived", "accepted_unchanged": false }
  },
  "bounds": { "from": "harmony_derived", "accepted_unchanged": true }
}
```

- A key that is **absent** means the value was set by the editor with no
  preselection, which is the state of every fragment written so far. No
  backfill is needed.
- `from` takes values such as `default_hint` (editorial cold-start hint),
  `corpus_stat` (typicality from approved data), `harmony_derived`,
  `expected_shape`, `correspondence`, `model_proposal`.
- `bounds` covers a stage child fragment's boundaries, whose pre-populated vs.
  dragged state is not persisted today.
- **Statistics used to generate defaults are computed over values that are not
  `accepted_unchanged`.** This keeps the feedback loop observable and out of
  the numbers.

### 5. Event-level provenance is unchanged

`movement_analysis` events keep `source`/`auto`/`reviewed` exactly as
specified. A DCML cadence label, once ingested, is event-level data with
`source: "DCML"`. It is not a fragment and needs no new provenance mechanism.

### 6. Model-based tooling: additional conditions

- Every model-originated flag or proposal stores the model identifier and
  version, so that the error rate of each can be measured later.
- **Model proposals (form (a) or (b) with `model_proposal`) are not enabled
  until a blind-sample protocol exists.** For a random share of candidates the
  proposal is hidden, the editor tags from scratch, and agreement is measured.
  Model critique (form (c)) does not need this precondition, because it writes
  nothing.

---

## Consequences

- **`phase-2.md` is amended:** "no user-facing AI layer; editorial-side machine
  assistance per ADR-041".
- **One Alembic migration** on `fragment` (three columns), landing with the
  first Track E stage that writes them. `fragment-schema.md` is updated in the
  same commit.
- **Read models are unchanged** for public surfaces. The editorial fragment
  detail and the review queue may surface `origin` and preselection state.
- **The record of proposal vs. final value becomes a dataset.** It gives each
  proposer's error profile and a measure of the editor's own criteria. It is a
  by-product of the rule, not a reason for it.
- **Cost:** every tool that preselects must write `value_provenance`. A tool
  that cannot say where its value came from may not preselect.

---

## Alternatives considered

**Provenance inside `summary`.** Rejected: `summary` is a versioned, published
analytical API. Provenance is not analysis, and it would force a version bump
and a JSONB migration for metadata.

**Fragment-level origin only, no value-level record.** Rejected: most
assistance acts on values inside a fragment the editor created (defaults,
derived properties, stage bounds). Without value-level provenance the
typicality feedback loop is undetectable, and "approved" says nothing about
which values were actively judged.

**Machine-created draft fragments for candidates.** Rejected: it overloads
`draft` with two meanings, inflates the editorial lists with machine output,
and lets machines create `fragment` rows, which the rule in § 2 forbids.

**A full per-edit audit log table.** Heavier than needed now. The decision
requires the origin and the accepted-unchanged state, not every intermediate
edit. It can be added later without contradicting this ADR.
