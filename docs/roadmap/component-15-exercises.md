# Component 15 — Exercises

**Status:** design agreed 2026-07-15 (Phase 2 planning); implementation not
started. This document is the design reference for the exercise system;
`phase-2.md` § Component 15 carries the summary and slot.

## Purpose

Graph-driven exercises over the fragment database: multiple-choice
identification (notation shown) and listening exercises (notation hidden),
with per-user progress tracking recorded at item level from the first answer.
Exercise types are declarative definitions — content authorship without
hand-written graph queries — and activate per concept only when the
underlying data can support them.

**Dependencies:** Component 12 (`exercise_session` / `exercise_result`
tables, registered users), Component 10 public path (fragment rendering,
previews), ADR-024 context modes (first consumer), Track M clear (harmony
data quality — M1/M2/M8).

---

## 1. Exercise-Type Representation

**Decision: YAML authored in git, seeded into PostgreSQL** — the domain-seed
pattern applied to exercises. Definitions live in `backend/seed/exercises/`,
are Pydantic-validated, and are seeded idempotently (MERGE-equivalent upsert)
into an `exercise_type` table. The engine, readiness statistics, and
activation flags read from the database; the YAML is the authored source of
truth with full git history.

Rejected for now: DB rows with an admin authoring UI. Runtime authoring
without deploys only pays off with non-technical content authors, which
Phase 2 does not have; the UI would be a foundation-sized cost for an add-on
sized benefit. It remains a possible later layer on top of the same tables.

### Definition schema (sketch)

```yaml
exercise_types:
  - id: cadence-identification
    name: "Cadence identification"
    task: identify_concept            # answer-input family: MCQ over concepts
    presentation: notation            # notation | listening
    concept_scope:                    # the sibling set questions draw from
      root: Cadence
      include_subtypes: true
    distractor_rule:
      edges: [CONTRASTS_WITH, IS_SUBTYPE_OF_SIBLING]
      count: 3
    context:                          # ADR-024 mode, per exercise type
      mode: bars
      before: 2
      after: 0
    readiness:                        # gates, overriding global defaults
      min_fragments_per_concept: 8
      min_viable_distractors: 3

  - id: cadence-listening
    name: "Cadence identification by ear"
    task: identify_concept
    presentation: listening
    concept_scope: { root: Cadence, include_subtypes: true }
    distractor_rule: { edges: [CONTRASTS_WITH, IS_SUBTYPE_OF_SIBLING], count: 3 }
    context: { mode: none }
    listening:
      transpose_semitones: 2          # random in [-2, +2] per question
      slowdown_aid: true              # available after first full hearing
```

The `task` field names an answer-input family implemented in code
(`identify_concept` is the only Phase 2 family — see § 8); everything else is
data. Field vocabulary is validated by Pydantic models at seed time, same as
domain YAML.

---

## 2. Readiness Gates & Validation

Three validation layers (decided 2026-07-15):

1. **Structural (seed time).** Pydantic: concept references resolve, edge
   names exist in the edge vocabulary, distractor counts sane, context mode
   is a valid ADR-024 mode. Any error aborts the seed.
2. **Statistical (seed time + ongoing).** A readiness report script — sibling
   of `validate_graph.py` — computes, per *(exercise type, concept)* pair:
   eligible fragment count (approved, ADR-009-clean, tagged with the
   concept), viable distractor count *after the correctness rule* (§ 3), and
   listening-pool size. Recomputed whenever a fragment reaches `approved`,
   so readiness improves as the corpus grows.
3. **Human (pre-activation).** An admin-only **preview mode**: play the
   exercise type against a concept exactly as it would be served. Preview
   sessions are flagged and excluded from statistics (§ 6).

**Activation unit is the *(exercise type, concept)* pair** — cadence
identification may be live for PAC and HC while EC is still below threshold.
Flow: pair crosses thresholds → becomes *eligible* (surfaced to admin) →
admin tries the preview → one-click **activation**. First activation is
manual (stats + human testing, as agreed); once active, a pair stays active
and new pairs of an already-trusted type can be auto-activated later if
manual confirmation proves redundant.

---

## 3. Question Generation

- **Correct answer:** a random eligible fragment of the target concept, per
  the repeat-avoidance policy (§ 5).
- **Distractor correctness rule (hard invariant):** a distractor drawn via
  the definition's edges must not also be a *true* concept tag of the shown
  fragment (any tag, not only `is_primary`). Enforced by the generator; if
  filtering leaves fewer than `count` distractors, the question is not
  servable with that fragment — this feeds the viable-distractor statistic.
- **Context** is rendered per the exercise type's ADR-024 mode. Cadence
  identification needs little or none (`bars(before: 2, after: 0)` at most).
  The `enclosing_fragment` mode becomes valuable once the Formal Function
  domain is modelled and tagged — a soft dependency that reinforces Formal
  Function's position as the second domain (`knowledge-graph-domain-map.md`).
- Generation is deterministic given (fragment, distractor draw, option
  order) — all three are recorded on the result row, so any question can be
  reconstructed for review or difficulty analysis.

---

## 4. Listening Exercises

Same generator, notation hidden; presentation differences only:

- **Transposition:** random shift within the definition's range (default
  ±2 semitones), applied to the decoded MIDI note schedule before Tone.js
  scheduling. Prevents recognition-by-memory of specific fragments; no
  rendering change needed since notation is hidden.
- **Slow-down aid:** a Tone.js Transport tempo scale (artifact-free — MIDI
  synthesis, not audio), offered **after the first full hearing**. An aid,
  not a default.
- **Aid usage is recorded, not penalised** (v1): listen count and
  slowed-playback flag go on the result row. The difficulty model will want
  this signal; the v1 score ignores it.
- Unlimited listens in v1, all counted.

---

## 5. Session Model

- **Fixed length: 8 questions.** Small enough to discourage shallow
  grinding, large enough that the outcome is not noise. No adaptive
  stopping in v1.
- **Interleaved, not blocked:** a session is one exercise type + one concept
  scope, with questions mixed across the sibling set (PAC/IAC/HC/DC in one
  session). Interleaving is what trains discrimination, and the
  `CONTRASTS_WITH`/sibling structure provides it for free.
- **Scoring — display and data decoupled:**
  - *Shown to the user:* the plain session fraction (7/8) and
    streak/completion counts (per `project-architecture.md` § Exercises).
    No points, no XP — gamification is wrong-toned for the platform.
  - *Stored:* everything raw at item level (§ 6). Per-concept rolling
    accuracy (last-k window or EWMA — pick at implementation) is computed
    from raw results and is the number the future mastery tracker and
    review queue consume.
- **Repeat avoidance:** no fragment repeats within a session; across
  sessions, without-replacement cycling per *(user, concept)* with reset on
  pool exhaustion. Aggressive exclusion windows are ruled out by pool
  reality (~50–100 fragments total in the early corpus). Every exposure is
  recorded, so the future SM-2 review queue (`extended-features.md`)
  inherits a complete exposure history rather than starting cold.

---

## 6. Data Model (sketch — final shape at Component 12/15 implementation)

Supersedes the "shape open" note in `tech-stack-and-database-reference.md`
§ User infrastructure tables.

```sql
CREATE TABLE exercise_type (          -- seeded from YAML
    id            TEXT PRIMARY KEY,   -- 'cadence-identification'
    definition    JSONB NOT NULL,     -- validated YAML payload
    seeded_at     TIMESTAMPTZ NOT NULL
);

CREATE TABLE exercise_activation (    -- the (type, concept) gate
    exercise_type_id TEXT NOT NULL REFERENCES exercise_type(id),
    concept_id       TEXT NOT NULL,   -- Neo4j concept id (immutable join key)
    status           TEXT NOT NULL,   -- below_threshold | eligible | active | disabled
    activated_by     UUID REFERENCES app_user(id),
    activated_at     TIMESTAMPTZ,
    PRIMARY KEY (exercise_type_id, concept_id)
);

CREATE TABLE exercise_session (
    id               UUID PRIMARY KEY,
    user_id          UUID NOT NULL REFERENCES app_user(id),
    exercise_type_id TEXT NOT NULL REFERENCES exercise_type(id),
    mode             TEXT NOT NULL DEFAULT 'standard',  -- standard | preview
    started_at       TIMESTAMPTZ NOT NULL,
    completed_at     TIMESTAMPTZ
);

CREATE TABLE exercise_result (        -- one row per question answered
    id               BIGSERIAL PRIMARY KEY,
    session_id       UUID NOT NULL REFERENCES exercise_session(id),
    fragment_id      UUID NOT NULL,   -- no FK cascade; results outlive fragments
    concept_id       TEXT NOT NULL,   -- the correct answer
    distractors      JSONB NOT NULL,  -- concept ids + option order as shown
    response         TEXT,            -- concept id chosen (null = skipped)
    correct          BOOLEAN NOT NULL,
    latency_ms       INTEGER,
    aids             JSONB,           -- {listens: 3, slowed: true, transpose: -1}
    answered_at      TIMESTAMPTZ NOT NULL
);
```

### Keeping testing usage out of difficulty data (decided 2026-07-15)

The contamination risk is *testing behaviour*, not *who* is playing — an
admin genuinely practising produces valid data (and the eventual Elo/IRT
model accounts for user ability anyway). So the flag is on the **session,
not the role**:

- The admin preview tool (§ 2) always creates sessions with
  `mode = 'preview'`. Preview results are stored (useful for debugging) but
  excluded from all aggregate statistics, rolling accuracy, and future
  difficulty fitting.
- As a belt-and-braces measure, the user's roles at answer time can be
  snapshotted onto the session row, so later analysis *can* also filter by
  role — but role filtering is a fallback, not the mechanism.

---

## 7. Progress Dashboard

Minimal v1, per `project-architecture.md`: per-exercise-type accuracy,
streaks, completion counts, and a per-concept accuracy view (the seed of the
future mastery tracker). Reads exclusively from `exercise_result` with
`mode = 'standard'` sessions. Registered users only; a user sees only their
own data.

---

## 8. Future Exercise Families (out of scope, recorded)

Phase 2 implements one answer-input family: `identify_concept` (MCQ), in two
presentations (notation, listening). Recorded for later, mostly from
`extended-features.md`:

- **Localization tasks** — "click where the cadence arrival (final tonic)
  is" — a different input family (score-click), likely wanting richer
  context modes. Raised 2026-07-15; not MCQ, not v1.
- **Error detection, comparative analysis, sequencing/ordering** — see
  `extended-features.md` § Analytical Practice.
- **Melodic dictation scaffolding, comparative listening** — see
  `extended-features.md` § Listening-Focused Practice.
- **Adaptive difficulty (Elo/IRT)** — Phase 3, gated on accumulated
  `exercise_result` data; enabled by the item-level recording above.

**Capture-extensions triage:** the unimplemented capture-extensions concept
(`../architecture/capture_extensions.md`; needed by evaded cadence, closing
section, standing on the dominant) may constrain which concepts are cleanly
exercisable — triage during implementation of this component.

---

## Decisions Log

| Decision | Resolution |
|---|---|
| Representation | YAML in `backend/seed/exercises/`, seeded into PostgreSQL (`exercise_type`); no authoring UI in v1 |
| Validation | Three layers: Pydantic (structural) + readiness report script (statistical, recomputed on fragment approval) + admin preview (human) |
| Activation | Per *(exercise type, concept)* pair; thresholds in the definition with global defaults; first activation manual after preview |
| Distractor correctness | Distractor must not be a true tag (any tag) of the shown fragment — generator invariant |
| Rendering context | Per-type ADR-024 mode in the definition; cadence ID uses `none`/small `bars`; `enclosing_fragment` awaits Formal Function |
| Listening | ±2-semitone random transposition; slow-down aid after first full hearing; aids recorded, not penalised; unlimited counted listens |
| Session | Fixed 8 questions, interleaved across the sibling set; no adaptive stopping in v1 |
| Scoring | Display plain fraction + streaks; store raw item-level data; per-concept rolling accuracy computed, not stored as score |
| Repeat avoidance | None within session; without-replacement cycling per (user, concept) across sessions, reset on exhaustion; all exposures recorded |
| Testing-data integrity | `mode = 'preview'` on sessions created by the admin preview tool, excluded from all statistics; role snapshot as fallback filter |
| v1 scope | One family (`identify_concept`), two presentations (notation, listening) |
