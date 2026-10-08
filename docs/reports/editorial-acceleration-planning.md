# Editorial Acceleration — Planning Report

**Status:** pre-decision report, 2026-10-08. Written after Component 12 closed
and before Component 13 begins, from a design discussion with Francisco on the
same day. It captures the problem, what the repository shows today, the
positions reached in the discussion, a coarse plan, and how that plan sits
against `../roadmap/phase-2.md`. **Nothing here is decided yet.** Once
Francisco answers § 7, this report becomes the input to a roadmap doc under
`docs/roadmap/` and to one ADR (§ 4.9). This file then stays as the record of
how the decisions were reached.

> **Update 2026-10-08 (same day).** Decisions 1, 2 and 7 taken (Track E
> placement; provenance rule → ADR-041; prose policy in `docs/howto/`), and the
> production launch postponed. The rest are deferred to the stage named in
> `docs/roadmap/track-e-editorial-acceleration.md` § Decisions. One correction
> found while drafting E0: hard-locked decision 8's annotator `confidence`
> field (cited in § 3 as ambiguity's "home") was specified but **never
> implemented**. It is now an E1/E3 item.

---

## 1. The problem

All the infrastructure is in place: corpus, renderer, knowledge graph, tagging
tool, review workflow, public read path, user infrastructure. The bottleneck is
now **editorial throughput**. The tagging interface has a lot of friction from
repetition, and it cannot be designed away entirely:

- the campaign has barely left the first three of the 18 sonatas (54
  movements);
- 50+ fragments are waiting in the review queue;
- with a single active editor, review largely means Francisco re-reading his
  own work (the admin self-review bypass in `roles-and-permissions.md` § 2
  exists for exactly this reason).

The aim is **not** to hand analytical judgement to a machine. It is to remove
repetition, so that human time goes to the cases that need judgement. Those
hard cases are also the most valuable ones, both for the repository and for
teaching.

The phase plan sets AI aside: Phase 2 is "non-AI user features" and the AI
layer is Phase 3 (a tutor that *consumes* the data). This report proposes
machine assistance on the *production* side of the data, now. Most of it is
deterministic tooling (built with AI help, but with no model running in the
loop). A smaller part is model-based.

---

## 2. Framing

Analytical work on a fragment falls into three layers. Each has a different
epistemic status and calls for a different kind of tooling.

1. **Derivable given an analysis.** Bass degree, soprano at the arrival,
   whether stages are present, stage components, the cadential 6-4. These are
   not "facts in the notes": choosing which note counts is already analytical.
   But once a harmonic analysis and stage boundaries exist, the remaining
   problem is narrow and largely mechanical. **Tooling: deterministic code.**
2. **Labelling relative to a theory.** A cadence type, a cadence function, a
   property value. There is no absolute ground truth, but expert agreement can
   be measured and disagreement clusters in a tail of cases. **Tooling:
   candidates, defaults, consistency checks; later, model proposals.**
3. **Interpretation.** Ambiguous formal function, the analytical argument, the
   prose. No label is "correct", but some arguments are better than others.
   **Tooling: review and critique, not generation.**

The knowledge graph acts as a **partial verifier** across layers 2 and 3. The
controlled vocabulary, the property schemas and the `CONTAINS` structure make
many analytical claims checkable against the notes and the harmony events.
That is what makes machine proposals reviewable rather than merely plausible.

---

## 3. What the repository shows today (verified 2026-10-08)

- **The DCML cadence labels are not ingested.** The DCML annotation standard
  carries cadence labels (PAC, IAC, HC, EC, DC, PC) on the onset of the arrival
  harmony. `backend/services/tasks/ingest_analysis.py` reads `phraseend` but
  has no `cadence` column handling. The test fixture
  (`backend/tests/fixtures/dcml-subset/harmonies/K331-1.harmonies.tsv`) has no
  `cadence` column either, so whether the corpus version `prepare_dcml_corpus.py`
  consumes carries it **is unverified** (§ 8).
- **Phrase markers are already treated as pre-suggestions** in the docs
  (`corpus-and-analysis-sources.md`: "passed to annotator as pre-suggestions,
  not committed automatically"). The principle this report extends is already
  on record.
- **No general soprano property exists.** The graph has `IACSopranoDegree`
  (ONE_OF SD3/SD5, optional, IAC only). A PAC implies SD1 by definition.
  *Doc drift:* `fragment-schema.md`'s v1 example uses a `SopranoPosition`
  property that the graph does not define.
- **`capture_extensions` inventory** (`backend/seed/domains/cadences.yaml`):
  - `harmony` (`harmony_gate`) on `Cadence`, inherited by every subtype; seeded
    and live (Track M2);
  - `post_evasion_harmony` (`harmony_object`) on `EvadedCadence`;
  - `prior_ac_pointer` (`fragment_pointer`) on `ReopeningHalfCadence`;
  - `prior_cadence_pointer` (`fragment_pointer`) on `ClosingSection` and
    `StandingOnTheDominant`.

  Building the two capturing types is scheduled in Component 15
  (`phase-2.md`, decisions log, 2026-08-26).
- **Stage absence is described in prose, not in structure.**
  `CadentialFinalTonic`'s definition says it is "absent in Half Cadences and in
  Evaded or Abandoned Authentic Cadences". This is deliberate: **hard-locked
  decision 4** in `../seed-drafts/cadences-design.md` makes every `CONTAINS`
  edge optional, with "morphological commitment in prose, not in structural
  required-ness".
- **Derivable properties are currently hand-entered.** `Stage1Components`,
  `Stage2Components` and `Cadential64` follow almost directly from the DCML
  numerals in the stage range. `ECP` is partly derivable (stage durations
  against a contextual norm).
- **`Covered` and `Unison`** are BOOL properties grouped under "other" as rare
  (Component 11 triage item 9). **Elision** exists nowhere in the graph. Phrase
  overlap is listed under the hypermeter area "under exploration" in
  `knowledge-graph-domain-map.md`.
- **Stage defaults** are laid out proportionally by `default_weight`
  (`tagging-tool-design.md` § 4). They do not use the harmony data.
- **Ambiguity already has a home:** hard-locked decision 8, a `confidence`
  field plus prose, not double-tagging. This is directly usable for review
  triage (§ 4.7, § 4.8).
- **Inter-fragment identity relations are explicitly excluded from scope**
  (`knowledge-graph-domain-map.md` § "Explicitly Excluded: Thematic and
  Motivic Relationships"). This bears directly on § 4.6.

---

## 4. Positions reached in the discussion

### 4.1 Bass and soprano

The objection holds: in practice, the notes do not settle structural bass or
soprano. The chord or inversion changes within a stage, ornamental and
structural notes coexist, and piano texture blurs the voices. The resolution
is to derive *given the analysis*, not from the notes alone.

- **Granularity is per event, not per stage.** The datum belongs on
  `movement_analysis` events (where Component 6 already placed
  `bass_pitch`/`soprano_pitch`). A stage's bass is then the sequence obtained
  by slicing, for example V6/4–5/3, not a single value to adjudicate.
- **The bass is mostly derivable without reading notes.** Numeral, `figbass`
  and local key give the bass degree *of the chord as analysed*. The notes
  serve to confirm, and to catch pedals, passing 6/4s and figurations.
- **The soprano is the real problem**, but the cadential arrival is the most
  favourable spot in the score. The target is a chord tone of the labelled
  chord, in the top voice, within a bounded window, and the texture usually
  thins there. Appoggiaturas and delayed resolutions move the structural note
  inside the final stage, but the chord being sought is known.
- **Output is a candidate plus a confidence**, never a committed value.
- **Test set:** every authentic cadence already tagged carries an implicit
  arrival soprano. PAC means SD1; IAC with `IACSopranoDegree` gives SD3/SD5.
  (Correction to the discussion: there is no hand-tagged soprano property
  across all fragments.) An extractor can be measured against these before
  anyone sees its output.

### 4.2 Capture extensions

- **`post_evasion_harmony` is computable.** Francisco's point: for an evaded
  cadence, the evasion is by definition the harmony immediately after the
  cadence fragment ends. So the value is a lookup of the first
  `movement_analysis` event at or after the fragment's end. The only open case
  is when no DCML label falls at that onset (the evasion is subtler than the
  label grid); that case is flagged for review rather than guessed.
  Consequences:
  - the field should not be annotator input;
  - if anything is stored, it is a reference to the event, `(mn, volta, beat)`,
    not a copy of the harmony object. A copy diverges from `movement_analysis`
    as soon as a chord is corrected.
- **The `fragment_pointer` fields are already designed to pre-populate** from
  the nearest preceding fragment of the `FOLLOWS` target
  (`capture_extensions.md`). They need confirmation UI, not inference.
- **Net effect on Component 15:** the capturing work shrinks. `harmony_object`
  may lose its only user, and the pointer UI is editorial tooling, not
  exercise tooling. Proposal: review all capture extensions in E1 and re-home
  what remains to Track E (§ 5, § 6).

### 4.3 Graph review against Caplin, before scaling

Agreed. This is the cheapest moment: concept `id`s are immutable, and property
changes on a populated corpus mean migrations. Method:

- **Read the source, not memory.** Work from Caplin, *Cadence* (the
  classical-style part), in passes. Output is a concordance:

  > graph concept or property ↔ section/pages in Caplin ↔ status ↔ note

  It gives page references and paraphrase, not transcription.
- **Three statuses, kept apart:**
  - contradiction;
  - deliberate departure (recorded in `cadences-design.md` or ADR-020, or newly
    recorded);
  - loose end (an undecided gap).

  The graph is not meant to be Caplin verbatim.
- **Read with cases in hand.** The queued fragments and the cases that caused
  hesitation during tagging are the test material.
- **A criterion for "should X be a property?"** All three must hold:
  1. it distinguishes instances meaningfully within the theory;
  2. someone would query or compare by it (research, an exercise);
  3. it is not derivable.

  Applied provisionally:
  - **`Unison`** passes 1–2 weakly and partly fails 3. Unison texture is
    detectable from the notes; "harmonic content implicit by context" is
    already in the harmony analysis. Candidate for a computed field or for
    removal.
  - **`Covered`** passes 3: deciding which voice is the melody is analytical.
  - **Elision** concerns the cadence's relation to what follows, not its
    morphology. It belongs to the same family as `post_evasion_harmony`,
    `ReopeningHalfCadence` and `StandingOnTheDominant`: information that lives
    outside the fragment's bounds. If formal-function units are ever tagged,
    elision becomes derivable from boundary overlap. Until then a BOOL is the
    honest stopgap. **The contextual family should be treated as one design
    question in the review, not case by case.**
- **"Definitional" rules vs. hard-locked decision 4.** "Evaded has no final
  tonic" is definitional in theory. But decision 4 deliberately keeps
  structural `CONTAINS` optional. The review should either reaffirm decision 4
  and route such rules into the defaults layer (§ 4.5, kind 1), or revisit it
  explicitly. Either way, the outcome is recorded.

### 4.4 DCML cadence labels as a second annotator

Agreed. DCML is treated as an independent annotator, not as truth to import.
Reconciling it with existing fragments gives three buckets:

| Bucket | Meaning | Action |
|---|---|---|
| Agreement | DCML label and Doppia fragment match (by arrival position, with tolerance; by coarse type) | none; mutual validation |
| DCML only | a DCML cadence with no Doppia fragment | candidate for the tagging queue |
| Disagreement | existence or type differs | review list. These are likely the most interesting cases in the corpus |

The work already done is not lost: it is the human half of the first agreement
study. **The mapping is not one-to-one.** DCML is coarser than the domain (it
does not separate evaded from abandoned, among others). It also includes the
plagal cadence, which Caplin does not count as a cadence in the classical
style. The mapping needs an explicit policy for these cases, set after the
Caplin review.

### 4.5 Defaults

There are three kinds, each with a different home:

1. **Expected structure.** Example: `EvadedCadence`/`AbandonedCadence` and
   `HalfCadence` with the final tonic absent. Under decision 4 these are
   expected-shape defaults applied at pre-population (the stage arrives
   toggled absent), not structural requirements. To be confirmed in the Caplin
   review (§ 4.3).
2. **Typicality.** Example: evaded and deceptive cadences are usually
   `WayStation`. This is statistics, not theory, and must stay out of the
   definitional graph. Proposed policy:
   - **Cold start:** editorial hints in a separate config file, not in the
     graph, e.g. `backend/seed/defaults/<domain>.yaml` (concept → property →
     typical value). These encode Francisco's or Caplin's "typically".
   - **Warm state:** the hint gives way to the corpus distribution over
     *approved* fragments once a minimum count is reached.
   - **Threshold:** preselect a value only when its share is clearly dominant
     (placeholders: ≥ 80 % with n ≥ 15). Below that, show the distribution as a
     non-preselecting hint ("WayStation 60 % · Independent 40 %"). A 60–40
     split is not a default; it is information.
   - **Feedback loop:** a default that biases tags which then reinforce the
     default. Mitigations:
     - record per property whether the stored value was a **preselected
       default accepted unchanged** or **actively chosen**, and compute the
       statistics over chosen values only;
     - keep defaults visually distinct, as unconfirmed stages already are;
     - use the blind sample (§ 4.8).
3. **Derived from the harmony data.** Stage presence, stage boundaries snapped
   to harmonic-function changes rather than proportional weights, relative
   durations, `Stage1Components`, `Stage2Components`, `Cadential64`, an
   `ECP` hint. Deterministic, and no epistemic cost. **This is the
   highest-value, lowest-risk item in the report.**

### 4.6 Passage correspondence (recurrence-aware tagging)

Agreed in principle. The rule is **"pre-populate with the differences
highlighted; never propagate silently"**. Corresponding notes do not imply
corresponding analysis: recapitulations rewrite transitions and their cadential
goals, and formal context can change a label.

**Detection is tractable.** Roman numerals relative to the local key are
already transposition-invariant: exposition and recapitulation yield the same
DCML numeral sequence in different keys. Matching numeral sequences with their
metric positions is tolerant string matching. A note-level check (intervals and
rhythm after transposition) yields a similarity score. Ornamented or
re-registered recurrences score lower but still match. K331/i (theme and
variations) is the natural test case: same harmonic skeleton, different
surface.

**Open design questions** (Francisco's, to settle in a design spike before
building, in the style of the M5 exploration):

- *Trigger:* proactive, reactive or both. Proactive means an offline list of
  "untagged passages corresponding to approved fragments", with no UI change.
  Reactive means that on committing a selection, the tool reports a match.
  Proposed staging: proactive first (cheap, informative), reactive second.
- *Showing the source:* side-by-side score views are expensive. A v1 could show
  a card in the form panel with the source fragment's concept, properties,
  stage layout and preview image, plus a link that opens it in another tab.
- *Partial overlap:* offer to snap the selection to the corresponding span, or
  to apply only concept and properties, never the stage geometry.
- *Diff display:* which harmony events and which notes differ, inline.

**Persistence: two distinct relations, not one.**

- **(a) Correspondence between score spans.** For example, "mm. 1–12 ≈
  mm. 98–109, transposed by a 4th, similarity 0.93". This is a fact about the
  score, independent of any tags. It is computed and reviewable, and it lives
  at movement/span level, not on fragments. It persists even when the tags on
  either side change.
- **(b) Provenance of a fragment.** "Pre-populated from fragment X." This is
  audit data on the fragment.

When a fragment is edited, fragments on corresponding spans get a **review
flag** (propagation as an alert, not as a write). The "see the corresponding
cadence" reference in prose is rendered from (a)/(b), **outside** the prose
text.

**Scope tension to decide explicitly.** (a) resembles the
inter-fragment identity relations that `knowledge-graph-domain-map.md`
excludes. The proposed line: (a) is an *editorial* relation, mechanically
detected recurrence between score spans used for tooling and provenance. It is
not an analytical claim about thematic identity, variation or development, and
it is not annotated. Exposing it on public surfaces would be a separate,
conscious decision.

### 4.7 Prose annotation policy

Agreed. **Prose says what the structured fields cannot say:**

1. the argument in doubtful cases (why this label and not the neighbouring
   one); expected especially where `confidence` is low (decision 8);
2. relation to context: what the cadence closes or defers, and its dialogue
   with nearby cadences and form;
3. what is notable or pedagogically salient.

Restating morphology (type, soprano, elaborations) is redundant, and it goes
stale: correcting a property silently contradicts the prose. A repeated cadence
refers to its counterpart, and the reference lives outside the prose (§ 4.6);
the prose notes only what differs.

The policy also gives machine review a rubric:

- prose that restates fields;
- prose that contradicts fields or harmony events;
- missing argument on low-confidence or low-agreement cases.

The elementary layer (typos, capitalisation, terminology) works almost like a
linter. The graph and `backend/seed/translations` are the controlled glossary,
in both languages.

**Deliverable:** a policy doc in `docs/` (proposed
`docs/howto/prose-annotation-guidelines.md`, or under `docs/handbook/` if that
fits Francisco's knowledge system better). It serves both the human annotator
and the machine critic.

### 4.8 Model-based pre-analysis: documented, deferred

Agreed to defer the fine-grained proposal step: a model proposing the domain's
fine typology (`ReopeningHalfCadence`, `StandingOnTheDominant`, evaded vs.
abandoned, function) with a justification. The DCML reconciliation (§ 4.4) is
**not** this step; it is cheap, deterministic and early.

When the deferred step comes, it ships with a **blind-sample protocol**. For a
random 10–15 % of candidates the proposal is hidden; Francisco tags them from
scratch, and the results are compared. This gives a calibrated agreement rate,
keeps the annotator's eye trained, and tells how far the rest can be trusted.
The same protocol is applied to statistical defaults (§ 4.5).

### 4.9 The provenance rule (ADR)

The ADR should be narrower than "use AI". Its core rule: **no
machine-originated value reaches approved status without a human action, and
origin is recorded on the fragment.** For example, a fragment-level
`origin: dcml_candidate | correspondence | model_proposal | human`, plus the
per-property "default accepted vs. chosen" flag (§ 4.5). The event level
already has `source`/`auto`/`reviewed`. The ADR also amends the Phase 2 "no
AI" statement: machine assistance is permitted on the **editorial** side;
user-facing AI remains Phase 3.

The difference between proposal and approval, once recorded, is probably the
most valuable dataset the project will produce: an error model of each
proposer, and a measure of the annotator's own criteria.

---

## 5. Proposed plan — Track E (Editorial Acceleration)

Named as a track, following the Track M precedent. Sizes are relative (S/M/L).
They are not dates.

| Stage | Content | Depends on | Size | Output |
|---|---|---|---|---|
| **E0 — Groundwork** | Provenance ADR (§ 4.9); prose annotation policy (§ 4.7); this report → roadmap doc | — | S | ADR-041, policy doc, `docs/roadmap/track-e-editorial-acceleration.md` |
| **E1 — Graph review against Caplin** | Concordance; contradiction/departure/loose-end triage; property criterion applied (`Unison`, `Covered`, elision, contextual family); decision 4 reaffirmed or revisited; full capture-extension review (§ 4.2); DCML→graph mapping policy | E0 (loosely); the book | M–L (reading-bound) | `docs/investigations/caplin-graph-review/`; `seed(cadences):` changes via Claude Code; possible ADR amendments |
| **E2 — DCML reconciliation** | Verify the `cadence` column in the corpus version; ingest it (as event-level data, not fragments); agreement report against existing fragments; candidate list | Mechanical part: none. Mapping part: E1 | S–M | agreement report under `docs/reports/`; candidates as a list (no UI yet) |
| **E3 — Harmony-derived and expected-shape defaults** | Stage boundaries snapped to harmonic-function changes; derived properties (`Stage1/2Components`, `Cadential64`, `ECP` hint); expected-shape defaults (§ 4.5 kind 1); `post_evasion_harmony` computed; pointer confirmation UI | E1 (what is rule vs. default vs. computed) | M | tagging-tool changes; `tagging-tool-design.md` § 4 updated |
| **E4 — Consistency checks and review triage** | Deterministic checks: concept vs. harmony events (HC arrival is V; PAC soprano extractor vs. SD1; stage bounds vs. harmony changes; properties vs. events); prose lint (terminology, capitalisation, field restatement); review queue ordered by flags | E3 for some checks; soprano extractor (§ 4.1) | M | checks module; flagged review queue |
| **E5 — Passage correspondence** | Design spike (§ 4.6 questions); offline detection over DCML sequences + note-level similarity; span-correspondence storage; proactive list; then reactive at-tagging pre-population; edit-time review flags | E0 (ADR); scope decision (§ 7) | M–L | exploration report; then implementation |
| **E6 — Model critique** | LLM review of fragment + properties + prose + graph definitions against the policy rubric; flags and arguments, no writes | E0 (policy), E4 (flag surface) | M | critique pass integrated into the flagged queue |
| *Deferred* | Model pre-analysis of fine typology (§ 4.8), with blind sampling; statistical defaults beyond cold-start hints (§ 4.5 kind 2), which need enough approved data | E2–E4 in use for a while | L | later roadmap item |

**Suggested order:** E0 → E1 (with E2's mechanical part in parallel) → E3 →
E4 → E5 → E6. E1 is the critical path: what counts as property, rule, default
or computed field shapes E3 and E4 and the E2 mapping.

---

## 6. Ordering relative to `phase-2.md`

Current state: Components 10–12 are closed; Component 13 (Collections) is next.
The production-launch report (`production-launch-planning.md`) is open.

**Proposed ordering:**

```
12. User infrastructure                 ── closed
    │
    ▼
Track E — Editorial acceleration        ── NEW; E0–E4 before Component 13
    │   (E5–E6 may interleave with 13–14)
    ▼
13. Collections                          ── unchanged scope
14. Presentation Mode                    ── unchanged
15. Exercises                            ── capture-extension scope reduced (§ 4.2)
16. Blog with scrollytelling             ── unchanged

Track M (parallel) continues; target "clear before 15" unchanged.
Production launch                        ── postponed (Francisco, 2026-10-08)
```

**Rationale.** Components 13–16 all consume approved fragments. Collections,
exercises (with per-pair activation gates that are statistical by design) and
the blog are starved without editorial throughput. Track E is upstream of the
pedagogical components, not parallel to them. The cheap deterministic stages
(E2, E3, E4) pay off immediately in the tagging campaign.

**What changes in `phase-2.md` if adopted:**

- *Component Order & Dependencies:* insert Track E between 12 and 13.
- *Purpose / What Phase 2 Delivers:* amend "No AI layer" to "no user-facing AI
  layer; editorial-side machine assistance per ADR-041".
- *Component 15:* capture-extension scope is re-homed to Track E after the E1
  review. The decisions-log row of 2026-08-26 gets a successor row.
- *Track M:* **M8** (harmony panel refinements: degree vs. root semantics,
  local-key pre-population) touches the same data E3 reads. It is worth
  pulling into or alongside E3.
- *Decisions log:* new rows for Track E placement, the provenance rule and the
  passage-correspondence scope line.

**Production launch.** Postponing it postpones colleagues' access to the site
(the report's aim 1). It does not affect the Component 13 registration
dependency, which is unchanged. The production report stays open as written.

---

## 7. Decisions to take

1. **Adopt Track E** and its placement before Component 13 (E0–E4), with E5–E6
   allowed to interleave.
2. **Provenance rule** as in § 4.9, and its ADR number and scope.
3. **Decision 4** (all `CONTAINS` optional): reaffirm and route expected shape
   into defaults, or revisit. To be settled during E1.
4. **Statistical defaults policy:** the threshold placeholders (≥ 80 %, n ≥ 15),
   the cold-start hint file location, the per-property
   "default accepted vs. chosen" flag.
5. **Passage correspondence scope line** (§ 4.6): editorial span relation,
   computed, not annotated, not public. Or a different line.
6. **Capture extensions:** re-home from Component 15 to Track E after E1;
   `post_evasion_harmony` becomes computed (an event reference or derived on
   read).
7. **Prose policy location:** `docs/howto/` or `docs/handbook/`.
8. **Production launch:** confirm postponement, and whether the
   staging/production split (which protects the environment of record) should
   still be done early on its own.

---

## 8. Facts to verify before the roadmap doc

- Whether the DCML `mozart_piano_sonatas` version used by
  `prepare_dcml_corpus.py` carries a `cadence` column, and its exact label
  inventory.
- The current counts: fragments by status and by movement on staging, and the
  number of authentic cadences with an arrival soprano known (PAC + IAC with
  `IACSopranoDegree`). These form the E2/E4 test sets.
- How many approved or queued fragments sit on spans with an obvious
  recurrence (exposition/recapitulation in the six K279/K280 movements). This
  sizes E5's payoff.
- `fragment-schema.md` example drift (`SopranoPosition`): fix in E0.

---

## References

- `../roadmap/phase-2.md` — component order, Track M, decisions log
- `../roadmap/component-15-exercises.md` — current home of capture extensions
- `../architecture/tagging-tool-design.md` § 4 — stage pre-population
- `../architecture/capture_extensions.md` — extension types and pointer pattern
- `../architecture/corpus-and-analysis-sources.md` — DCML ingestion,
  phrase markers as pre-suggestions
- `../architecture/fragment-schema.md` — `summary` v1, `auto`/`reviewed` provenance
- `../architecture/knowledge-graph-domain-map.md` — excluded thematic relations
- `../seed-drafts/cadences-design.md` — hard-locked decisions (4, 8, 9)
- `production-launch-planning.md` — the postponed front
- Cadence labels in the DCML Mozart annotations: Hu et al., *The
  Batik-plays-Mozart Corpus* (arXiv 2309.02399), § on the Annotated Mozart
  Sonatas.
