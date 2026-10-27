# Phase 2 — Track E: Editorial Acceleration — Roadmap

**Status:** adopted 2026-10-08. This document turns
[`../reports/editorial-acceleration-planning.md`](../reports/editorial-acceleration-planning.md)
(the discussion and its rationale) into a track: stages, order, dependencies,
and which decisions are taken and which are deferred to a named stage. It does
not restate the report's reasoning; read the report for the *why*.
Implementation plans are drafted per stage as each one begins, following the
component-plan model (`component-12-user-infrastructure.md`).

**Governing decisions:**

- [`../adr/ADR-041-editorial-machine-assistance-and-provenance.md`](../adr/ADR-041-editorial-machine-assistance-and-provenance.md):
  machines propose; only human actions produce approved data; provenance is
  recorded at fragment and value level.
- [`../howto/prose-annotation-guidelines.md`](../howto/prose-annotation-guidelines.md):
  what fragment commentary contains, and the review checklist applied to it.

---

## Purpose

Raise editorial throughput, both tagging and review, by removing repetition,
so that the editor's time goes to the cases that need judgement. The track sits
**upstream** of the pedagogical components (13–16): they consume approved
fragments, and the corpus is the constraint. Most stages are deterministic
tooling. Model-based work is confined to critique (E6) until the conditions in
ADR-041 § 6 are met.

---

## Placement

```
12. User infrastructure                 ── closed
    │
    ▼
Track E — E0 → E1 (‖ E2 mechanical) → E3 → E4
    │       E5, E6 may interleave with 13–14
    ▼
13. Collections → 14. Presentation → 15. Exercises → 16. Blog   (order unchanged)

Track M continues in parallel; target "clear before 15" unchanged.
Production launch: postponed (2026-10-08).
```

**Critical path: E1.** What the Caplin review settles as property, rule,
default or computed field shapes E3 and E4 and the DCML→graph mapping in E2.

---

## Decisions

### Taken (2026-10-08)

| Decision | Resolution | Recorded in |
|---|---|---|
| Track placement | Track E before Component 13 for E0–E4; E5–E6 may interleave with 13–14 | this doc; `phase-2.md` |
| Machine output and provenance | ADR-041: candidates, preselected values and flags only; `origin` per fragment; `value_provenance` per value | ADR-041 |
| Phase boundary | Editorial-side machine assistance from Phase 2; user-facing AI stays Phase 3 | ADR-041 § 1; `phase-2.md` |
| Prose policy | Adopted, in `docs/howto/` | `prose-annotation-guidelines.md` |
| DCML cadence labels | A second annotator, not truth to import; reconcile into agreement / DCML-only / disagreement | report § 4.4 |
| Recurring passages | Pre-populate with differences highlighted; never propagate silently; an edit raises review flags on corresponding fragments | report § 4.6 |
| Model pre-analysis of fine typology | Deferred; needs the blind-sample protocol first | ADR-041 § 6 |
| Production launch | Postponed; `production-launch-planning.md` stays open as written | `phase-2.md` |

### Deferred to a named stage

| Question | Settled in | Notes |
|---|---|---|
| Hard-locked decision 4 (all `CONTAINS` optional): reaffirm, routing expected shape into defaults, or revisit | E1 | report § 4.3, § 4.5 kind 1 |
| Property status of `Unison`, `Covered`; elision; the "contextual" feature family as one design question | E1 | criterion in report § 4.3 |
| Capture extensions: re-home from Component 15; `post_evasion_harmony` as a computed lookup | E1 (decision), E3 (build) | report § 4.2 |
| DCML→graph mapping policy (plagal cadences; evaded vs. abandoned; HC variants) | E1, applied in E2 | report § 4.4 |
| Annotator `confidence` field (hard-locked decision 8, **specified but never implemented**) | E1 (still wanted? shape?), E3 (build) | `cadences-design.md` Open items |
| Statistical defaults: threshold, minimum n, cold-start hint file | after E3, when enough approved data exists | report § 4.5 kind 2; placeholders ≥ 80 %, n ≥ 15 |
| Passage-correspondence scope line vs. the excluded thematic relations | E5 design spike | report § 4.6; `knowledge-graph-domain-map.md` |

---

## Stages

Sizes are relative (S/M/L), not dates.

### E0 — Groundwork *(S)* — done 2026-10-08

- ✅ ADR-041.
- ✅ Prose annotation guidelines (`docs/howto/`).
- ✅ This roadmap; `phase-2.md` updated (order, "no AI" line, decisions log).
- ✅ `fragment-schema.md` example drift fixed (`SopranoPosition` → real
  schemas).

### E1 — Graph review against Caplin *(M–L, reading-bound)*

**Input:** Caplin, *Cadence* (the classical-style part), kept under the
git-ignored `/private/sources/`; `backend/seed/domains/cadences.yaml`;
`../seed-drafts/cadences-design.md`; queued and hesitated-over fragments as
test cases.

**Work:**

- a concordance: graph concept/property ↔ Caplin section/pages ↔ status
  (contradiction / deliberate departure / loose end) ↔ note. It gives page
  references and paraphrase, not transcription;
- the property criterion applied (report § 4.3);
- the deferred decisions above that are marked E1.

**Output:**

- `docs/investigations/caplin-graph-review/` (concordance plus a decisions
  summary);
- `seed(cadences):` changes via Claude Code;
- amendments to `cadences-design.md` and the relevant ADRs.

**Exit:** every graph concept and property has a status, and every deferred E1
decision is taken or explicitly re-deferred.

### E2 — DCML reconciliation *(S–M)*

**Mechanical part (can run alongside E1):**

- verify that the corpus version consumed by `prepare_dcml_corpus.py` carries
  the `cadence` column, and its label inventory;
- ingest the column as event-level data in `movement_analysis`
  (`source: "DCML"`). It produces no fragments (ADR-041 § 5).

**Mapping part (after E1):**

- the agreement report against existing fragments, as three buckets;
- the candidate list (DCML-only cadences) as a list outside `fragment`
  (ADR-041 § 2a). No tagging-tool UI yet.

**Output:** an agreement report under `docs/reports/`, and the candidates.

**Exit:** buckets counted per movement for everything tagged so far;
disagreements listed for review.

### E3 — Harmony-derived and expected-shape defaults *(M)*

**Work:**

- stage boundaries snapped to harmonic-function changes rather than
  `default_weight` proportions;
- derived property preselection (`Stage1Components`, `Stage2Components`,
  `Cadential64`; an `ECP` hint);
- expected-shape defaults per E1's ruling (for example the final tonic
  toggled absent for evaded and abandoned cadences);
- the selection's arrival DCML label used to rank the concept picker;
- `post_evasion_harmony` computed; confirmation UI for the `fragment_pointer`
  fields;
- the ADR-041 migration (`origin`, `origin_ref`, `value_provenance`) and
  preselected-value styling;
- the annotator `confidence` field, if E1 keeps it.

**Pairs with Track M8** (harmony panel: degree vs. root semantics, local-key
pre-population), which touches the same data. Pull it in here.

**Output:** tagging-tool changes. `tagging-tool-design.md` § 4,
`capture_extensions.md` and `fragment-schema.md` updated in the same commits.

**Exit:** on a sample of already-approved fragments, re-tagging from scratch
with the new defaults reproduces the stored stage bounds and derived
properties, or the mismatches are explained.

### E4 — Consistency checks and review triage *(M)*

**Deterministic checks:**

- concept vs. harmony events (an HC arrival is V; a PAC's final stage is I);
- stage bounds vs. harmony changes;
- derived properties vs. stored values;
- a **soprano-at-arrival extractor**, measured against the implicit test set:
  every PAC (SD1) and every IAC with `IACSopranoDegree` (SD3/SD5);
- the mechanical prose checks (guidelines P5–P8; partly P1, P4);
- the DCML-disagreement flag from E2.

The review queue is ordered by flags. Flags write nothing (ADR-041 § 2c).

**Output:** a checks module, a flagged review queue, and the extractor's
accuracy figures in a short report.

**Exit:** the current queue is triaged with flags. Flag precision has been
checked by hand on a sample.

### E5 — Passage correspondence *(M–L)*

**Design spike first** (in the style of the M5 exploration report):

- trigger: proactive list vs. at-selection;
- how the source fragment is shown;
- partial overlap;
- diff display;
- the scope line vs. the excluded thematic relations.

**Then:**

- offline detection over DCML numeral sequences relative to the local key,
  with a note-level similarity score;
- storage of span correspondence (a fact about the score) separate from
  fragment provenance (`origin: correspondence`);
- the proactive list first, at-selection pre-population second;
- edit-time review flags on corresponding fragments;
- migration of the prose interim references (`cf. mm. …`) to links.

**Test cases:** exposition/recapitulation pairs in K279/K280; K331/i (theme
and variations).

### E6 — Model critique *(M)*

**Work:**

- LLM review of fragment, properties, prose and graph definitions against the
  guidelines' checklist (P1–P4 especially) and the graph;
- flags with an argument; no writes; the model id and version stored
  (ADR-041 § 6);
- runs on demand over the review queue.

**Exit:** precision of the flags checked by hand on a sample before the critic
runs by default.

### Deferred beyond Track E

- **Model proposals of fine typology**, behind the blind-sample protocol
  (ADR-041 § 6).
- **Statistical (typicality) defaults** beyond cold-start hints, once approved
  data is sufficient.
- **Component 6 per-event `bass_pitch`/`soprano_pitch`** beyond the E4
  arrival extractor. Its trigger remains the first non-DCML corpus.

---

## Changes to other plans

- **`phase-2.md`:** Track E placed in the order; "No AI layer" amended per
  ADR-041 § 1; decisions-log rows added; production launch marked postponed.
- **Component 15:** its capture-extension scope (decisions log, 2026-08-26)
  moves to Track E once E1 rules on it. Until then the Component 15 text
  stands, with a pointer here.
- **Track M:** M8 pulled into E3. Other rows unchanged.

---

## Facts to verify

Carried from the report § 8:

- the DCML `cadence` column and its inventory (start of E2);
- current fragment counts by status and movement on staging, and the size of
  the PAC/IAC soprano test set (start of E2/E4);
- how many fragments sit on recurring spans in K279/K280 (start of E5).
