# E1 proposals and open questions

**Date:** 2026-10-08; revised 2026-11-05 with Francisco's answers (§ F) and the staging counts (§ E). Part
of the [E1 review](README.md). Every row of [`concordance.md`](concordance.md)
that is not "Consistent" leads here. Nothing below has been applied yet: the
implementation plan is
[`../../roadmap/track-e-e1-graph-revision.md`](../../roadmap/track-e-e1-graph-revision.md).

Page numbers are Caplin, *Cadence* (2024). Draft wording for definitions and
descriptions is in § C, so the Claude Code pass has text to start from.

---

## Summary

**Status:** all proposals are agreed, as written or with the answer in § F.
Where a row carries a condition, it is stated there.

| # | Proposal | Settles (roadmap E1 list) | Changes | Stage | Status |
|---|---|---|---|---|---|
| P1 | Reaffirm decision 4; add per-concept **expected stages** read by defaults and checks | Decision 4 | YAML field + seed; `cadences-design.md` | E1 → E3, E4 | Agreed |
| P2 | One rule for the contextual family: judge → BOOL; later unit → `FOLLOWS`; data → compute. Add `Elided`; narrow and redescribe `Covered`; retire `Unison`; `post_evasion_harmony` becomes a computed "initiating harmony" | Unison, Covered, elision; capture extensions | YAML; `capture_extensions.md`; Component 15 scope | E1 → E3 | Agreed; the staging count clears `Unison` and `Covered` (§ E) |
| P3 | `ReopeningHalfCadence` also `FOLLOWS DeceptiveCadence` | (concordance) | YAML edge; pointer validator | E1 → E3 | Agreed |
| P4 | DCML → graph mapping policy; Caplin's readings stored as a reference set | DCML mapping | E2 rules; reference fixture | E1 (set), E2 (rules) | Agreed (Q9) |
| P5 | `CadenceFunction`: record the departure, rewrite the value descriptions, four rulings; implement `confidence` | Confidence field | YAML descriptions; tagging guidelines; fragment schema; ADR | E1 → E3 | Agreed; competing reading dropped (Q2); internal HC `Independent` (Q3) |
| P6 | IAC: fix the public definition; keep `IACSopranoDegree` with a corrected description; add `PrinnerCadence` | (concordance) | YAML; E4 test-set text | E1 | Agreed (Q1) |
| P7 | Add "Deceptive Cadence (3̂)" as a BOOL on `DeceptiveCadence` | (concordance) | YAML | E1 | Agreed |
| P8 | Rewrite `EvadedCadence`, `DominantArrival`, `Premature`; also `AbandonedCadence` (Q4) | (concordance) | YAML | E1 | Agreed |
| P9 | Smaller corrections: `HalfCadenceShape` naming, `ECP` criterion, stage 1b VI, `ContrapuntalCadence` name, minor wording | (concordance) | YAML; harmonic-functions stub | E1 | Agreed |
| P10 | **New.** A stage fragment asserts that the stage exists: tag it only where its definition holds, and never widen a stage definition to fit a deviation | Q5 | Tagging guidelines; `CadentialDominant` wording; `expected_stages` values; one tool change | E1 → E3, E4 | Agreed (Q5) |
| P11 | **New.** Write the tagging guidelines, which do not exist yet | (concordance) | New `docs/howto/tagging-guidelines.md` | E1 | Agreed; public version deferred (Q11) |
| P12 | **New.** Stop showing "(Realised)" on the Half Cadence | Francisco's note | YAML and `es.yaml` names | E1 | Agreed (Q10) |

Re-deferred, with reasons, in § D.

---

## A. The decisions the roadmap defers to E1

### P1 — Decision 4 stands; Caplin's requirements become expected stages

**What Caplin says.** For an authentic cadential progression, stages 3 and 4
are required; stage 1 is often missing, stage 2 sometimes; complete and
incomplete progressions are equally strong (p. 60). An HC needs its dominant
as the final, root-position, consonant arrival (pp. 101–103).

**Why structural requiredness still fails.** The deviations are defined by
breaking exactly these stages:

- the evaded cadence has no stage 4 (pp. 169–170);
- the abandoned cadence has a stage 3 that is undermined, inverted or missing
  (pp. 178–184);
- a dominant arrival on a terminal dominant has no cadential progression at all
  (pp. 192–193).

Making `CadentialDominant` or `CadentialFinalTonic` required on a parent would
reject correct tags. Decision 4's portability argument (Baroque,
late-Romantic) is a second reason, not the main one.

**Proposal.** Keep every `CONTAINS` edge `required: false`. Record Caplin's
expectations as data, per concept, in a form the tools can read:

| Concept | Initial Tonic | Pre-dominant | Dominant | Final Tonic |
|---|---|---|---|---|
| PAC, IAC | optional | optional | expected | expected |
| Deceptive | optional | optional | expected | expected (substitute) |
| Evaded | optional | optional | expected | **absent** |
| Abandoned | optional | optional | optional (P10) | **absent** |
| HC (realised, reopening) | optional | optional | expected | — |
| Dominant Arrival | optional | optional | optional (P10) | — |

- **Where:** a small `expected_stages` map on the concept in `cadences.yaml`
  (stage concept id → `expected` / `absent`; unlisted = optional), inherited
  down `IS_SUBTYPE_OF` and overridable by a subtype. This is theory, so it
  belongs in the graph, not in the cold-start typicality file (report § 4.5
  keeps those two apart).
- **Used by:** E3 pre-population (an `absent` stage arrives toggled off, an
  `expected` one toggled on) and E4 checks (flag an expected stage missing or
  an absent stage present). It never blocks a submission.
- **Record:** an amendment to decision 4 in `cadences-design.md`, not a
  reversal: "optional in structure, expected in data."

**Alternatives considered.** (a) A rule list in code: invisible to the editor
and duplicates the prose. (b) Prose only, as today: E3 and E4 cannot read it.

### P2 — The contextual family under one rule

The report asked for `Unison`, `Covered`, elision and the capture extensions to
be treated as one design question. Caplin's syntactic / rhetorical distinction
(§ 2.11, pp. 50–54) and his treatment of each case give the rule:

> **Information about a cadence's relation to its surroundings is stored in
> one of three ways.**
>
> 1. **A judgement about the arrival itself → a BOOL on the cadence.** Only
>    one fragment is involved, and the notes do not settle it.
> 2. **A relation to a later unit that is itself tagged → `FOLLOWS` plus a
>    backward pointer** (decision 9).
> 3. **A fact already present in the analysis data or the notes → computed,**
>    never typed by the annotator. If stored, stored as a reference to the
>    data, not a copy.

Applied:

| Item | Group | Proposal | Grounds |
|---|---|---|---|
| **Elision** | 1 | **Add `Elided`** (BOOL) on `AuthenticCadence`. | Glossary p. 586. It separates readings Caplin weighs again and again: elided DC vs evaded (pp. 169, 209–211), elided AC vs evaded (pp. 211–214), covered PAC vs evaded (pp. 214–217). It also feeds hypermeter (pp. 137–138). Not derivable until formal units are tagged; then it becomes boundary overlap, and the flag can be checked against it. E4 flag: `Elided` on an evaded cadence (an evaded arrival groups forward only). |
| **Covered** | 1 | **Keep; move to `AuthenticCadenceRealised`; rewrite the description** (§ C). | pp. 140–142; glossary p. 585. A covered cadence is an *elided PAC* that looks like an IAC; the inverse (an IAC covered by 1) also exists. Choosing which voice is the melody is a judgement, so the criterion holds. E4 flag: `Covered` without `Elided` (allowed, Caplin has an accompaniment variant, but worth a look). |
| `ReinterpretedAsHC` | 1 | Keep (description refinement only). | pp. 121–124. |
| `ReopeningHalfCadence`, `ClosingSection`, `StandingOnTheDominant` | 2 | Keep; see P3 for one edge. | Already in the right shape. |
| **Unison** | 3 | **Retire the schema** and compute a texture flag at the arrival (monophony or doubled monophony) with the E4 soprano extractor. | Caplin's term is the *unison half cadence* (p. 114; glossary p. 592); a unison PAC needs a bass-line melody (p. 114). Texture is rhetorical (p. 139) and visible in the notes. No uses on staging (§ E), so removal needs no data migration. |
| **`post_evasion_harmony`** | 3 | **Remove the capture extension; compute it.** Display it as Caplin's **initiating harmony**: the first `movement_analysis` event at the onset where the final tonic was expected (the end of the dominant stage). Store nothing, or an event reference `(mn, volta, beat)`. If no harmony label falls at that onset, raise a review flag. | pp. 169–174; glossary p. 587. Francisco's point stands (report § 4.2). One caution from Caplin: the harmony does not decide the type. The same V⁴₂–I⁶ makes a deceptive or an evaded cadence depending on grouping (p. 171), so the field is information, never a classifier. |
| Metric position of the arrival | 3 | Compute when needed (beat of the stage-4 onset, or of the HC dominant). The ratio model (arrival duration : unit length) waits for formal units. | § 3.4.1, pp. 129–138: meter is rhetorical. |

**Consequences for capture extensions.** `harmony_object` loses its only user
and can leave the type list. The two `fragment_pointer` fields need a
confirmation UI (E3), not inference. The capture-extension work scheduled in
Component 15 (`phase-2.md` decisions log, 2026-08-26) therefore moves to E3 as
pointer UI plus one computed lookup; Component 15 keeps nothing of it.
Record in `capture_extensions.md` and the Component 15 roadmap when the YAML
change lands.

### P3 — `ReopeningHalfCadence` also follows a deceptive cadence

Caplin's reopened HC follows an authentic cadence *or a substitute deceptive
cadence* (glossary p. 589); his K458 example reaches an inverted tonic first
(p. 127). Proposal: add a second edge, `FOLLOWS DeceptiveCadence`, and widen
the `prior_ac_pointer` description to "authentic or deceptive cadence". Two
edges are better than retargeting to `AuthenticCadence`, which would admit
evaded and abandoned cadences; they have no final event to reopen. The
validator ("the target carries the edge's target concept") must accept either
target. Also rename it "Reopened Half Cadence", alias "HC (reopened)", which is
Caplin's term and matches the Spanish (the id stays `ReopeningHalfCadence`).

Rare in the corpus; no passage from the eighteen sonatas is discussed under
this heading. Low priority, cheap.

### P4 — DCML → graph mapping policy (applied in E2)

DCML is a second annotator (report § 4.4). Caplin settles what each DCML label
can and cannot mean. The label inventory is to be verified at the start of E2;
the rules assume the standard set PAC, IAC, HC, DC, EC, PC.

| DCML label | Candidate concept(s) | Rule or flag |
|---|---|---|
| PAC | PAC | Flag a possible `Covered` when the next unit starts at the arrival with a higher melodic pitch (pp. 140–142). Consecutive PACs: the later one is a candidate codetta with `LimitedScope` (§ 2.8.5, pp. 44–46). |
| IAC | IAC | Flag a possible covered PAC (elided arrival, 1 in an inner voice). |
| HC | HC (realised) / Dominant Arrival | Root-position triad at the arrival → HC. V⁷, or an inverted dominant → DA candidate (pp. 187–193). Matching should also accept an authentic cadence tagged `ReinterpretedAsHC`. |
| DC | Deceptive / Evaded | Both shown when the substitute starts a new unit: elided DC vs evaded is a grouping call (pp. 209–211). |
| EC | Evaded / Abandoned | DCML has no abandoned label. If the last dominant before the label is inverted, or there is none, propose Abandoned; otherwise Evaded. |
| PC | **never a cadence concept** | Caplin: no plagal cadence in the classical style (p. 24; pp. 146–149). Count these in their own bucket, "non-cadential (DCML PC)", outside the three agreement buckets. If one follows a PAC, note it as a closing-section (codetta) candidate; otherwise as prolongational closure. |

**A fourth bucket.** Doppia tags of types DCML cannot express (Dominant
Arrival, Abandoned, Reopened HC, `LimitedScope` gestures) are not
disagreements. Count them as "Doppia-only, outside the DCML vocabulary" so the
disagreement list stays meaningful.

**Caplin as a third reader.** For the corpus passages Caplin analyses
(`corpus-test-cases.md`), his reading is a reference annotation. E2 can report
agreement against it as well, with his own declared ambiguities counted as
"either reading agrees".

### P5 — `CadenceFunction`, and the `confidence` field

**The departure.** Caplin defines independent and way-station only for IACs
and authentic deviations, relative to an expected PAC (pp. 93–96, 157–167,
175–177; glossary pp. 587, 592). Limited scope is his too (pp. 36–37).
Doppia requires the property on every cadence, and its "Independent" means
"closes a unit in its own right". This works: it gives every fragment a
function, and Caplin's PACs and HCs fall under independent (in the wider
sense) or limited scope, with one exception he names himself: a reopened HC
acting as a way station (Haydn Op. 55/1, p. 128). It should be recorded as a deliberate departure in
`cadences-design.md`, and the value descriptions should say what each value
means in Doppia's sense (§ C).

**Four rulings for cases Caplin names.**

| Case | Caplin | Proposed tag |
|---|---|---|
| An IAC that ends a complete main theme (galant habit; Haydn and the young Mozart, p. 98) | Neither independent (p. 94 n. 115) nor way station (p. 98) | `Independent` + `ClosesMainTheme`; the prose names the galant habit. A fourth value is not worth it for a habit Caplin dates to before ca. 1780. |
| An internal HC (or dominant arrival) in a subordinate theme | Explicitly not a way station, for three stated reasons (p. 119) | `Independent`, with no `ThemeClosure` (subordinate-theme part 1 is a deferred value). |
| A way station that is denied (no PAC follows, or an HC follows instead) | Still a way station by its context; the denial is a further event (pp. 162–164, 175–176) | `WayStation`; the prose says it is denied. This matches the design doc's "a WayStation may be unfulfilled". |
| Independent vs way station left open | Caplin leaves it open (K332/iii mm. 21–32, p. 165) | One value + `confidence` (below). |

**Prose for these rulings.** The galant-habit and denied-way-station rulings
rely on the prose. Francisco expects it is often missing on existing fragments,
so this is a rule going forward, not a backfill sweep: E4 raises a flag where
the prose is absent, and the fix happens in review.

E4 checks follow from the departure: `WayStation` on a PAC (or on an HC that
is not a reopened HC), and a PAC with
`ClosesTransition` (Caplin: a transition never ends with a PAC; that is
fusion, pp. 80–82), are flags.

**The `confidence` field (decision 8).** Caplin's practice is the case for it.
He keeps several readings in play and says outright that the aim is to weigh
the factors, not reach a verdict (§ 4.6, pp. 209–222; four readings of
K310/i mm. 1–10, pp. 218–220). He also notes that classifying an HC subtype is
not always an interesting act (p. 112). A tagger who must pick one concept
needs somewhere to say "this is a contested call". Proposal:

- **Keep decision 8 and build it in E3**, on the fragment base schema (not per
  concept): an ordinal with three values, e.g. *secure / probable /
  contested*. Default: secure.
- **No "competing reading" field** (Q2). Ambiguity stays as `confidence` plus
  prose. The price is known and accepted: Caplin's ambiguity pairs (evaded /
  elided deceptive; evaded / PAC; evaded / HC; abandoned / deceptive; HC /
  premature DA) are not queryable as pairs. A low `confidence` still finds
  them, and the prose names the alternative.
- **Prose rule:** any value other than *secure* needs the argument in the
  commentary (prose guidelines § 2, "argument"); an E4 mechanical check.
- **Record:** `fragment-schema.md` and an ADR when E3 builds it.

---

## B. Other changes the concordance calls for

### P6 — The IAC

- **Definition (public): contradiction of emphasis.** The graph presents the
  IAC on 5 as an ordinary minority option. Caplin defines the IAC as ending on
  3 (p. 83; glossary p. 587). Of five apparent classical IACs on 5 he accepts
  one as genuine, explains another motivically, rereads one as ending on 3 and
  offers covered-PAC readings for two (pp. 90–93); he calls the case highly
  exceptional and normally explained some other way (p. 219). Rewrite (§ C).
- **`IACSopranoDegree`: keep, with a corrected description** (Q1; § C). SD5 is
  highly exceptional in the classical style and comes with an argument in the
  prose. Genuine cases exist (one in Caplin's classical set, three
  nineteenth-century ones, p. 93 n. 113), the graph's aim is portability, and
  keeping it needs no migration. An E4 flag on SD5 sends each one to review as
  a possible covered PAC.
- **`PrinnerCadence`: add, as a BOOL on the IAC** (Q1; § C). Caplin treats the
  Prinner cadence as a genuine IAC variant (pp. 85–86; glossary p. 587), and it
  matters for the galant sonatas: K282/i closes its main theme with one
  (p. 98). This does not conflict with Q7. The property records one cadence
  type; it does not open the melodic-pattern schemata, which stay out of scope.
  It may be cross-checked once the E4 soprano extractor exists. MacKay rejects
  the type as cadential (p. 86 n. 94); Doppia follows Caplin.

### P7 — "Deceptive cadence (3̂)"

Caplin labels a deceptive cadence whose melody ends on 3 as the deviation of
an implied IAC, not a PAC, and uses the label throughout (pp. 158–160,
164–166; glossary p. 585). It bears on the function reading: several of his DC(3̂) examples close an
antecedent-like opening phrase where no PAC is yet expected (independent,
pp. 164–166); in K332/iii m. 26, the corpus case, he leaves independent vs way
station open (p. 165). Proposal: a BOOL on `DeceptiveCadence`, named "Deceptive Cadence
(3̂)". The soprano extractor (E4) can preselect it later.

### P8 — Three public definitions to rewrite

- **`EvadedCadence`**: keep the interruption (the final tonic does not come),
  drop "unrelated harmony", and state the grouping condition that separates it
  from the deceptive cadence: the event in the final-tonic position groups
  forward, with the next unit (pp. 169–174; glossary p. 586).
- **`DominantArrival`**: state the two conditions (seventh on a final
  dominant; terminal dominant of a prolongational or sequential progression,
  possibly inverted) and let it admit the premature consonant triad
  (pp. 187–202; glossary p. 585).
- **`Premature`** (tagging-tool description, not public): replace "before the
  expected cadential progression is complete" with Caplin's criterion (before
  the melodic, phrase-structural and textural processes have run their
  course; pp. 193–202; glossary p. 589). Tagging consequence: a premature
  arrival on a root-position triad is `DominantArrival` + `Premature`, not
  `HalfCadenceRealised`. Caplin's clear case is K464/iv (pp. 194–195); the
  corpus case, K332/i mm. 31–40 (p. 194), is one he leaves between HC and
  PDA, so it needs `confidence`.

- **`AbandonedCadence`** (added by Q4): keep the content, and state that there
  may be no single moment of arrival. Both Caplin's abandoned cadence and his
  abandoned cadential progression (pp. 178, 182–187) are tagged with this
  concept. The fragment ends where the progression is given up, which is the
  end of the last genuine cadential harmony. The event that gives it up (the
  shift to an inversion, say) lies just after the fragment, so it can be
  computed, as with the evaded cadence's initiating harmony.

The rewritten public definitions (IAC, Evaded, Dominant Arrival, Abandoned and
`CadentialDominant`) carry `definition_reviewed: true`.
The new text is either approved by Francisco in this pass, or the flag goes back to
`false` until it is. Their `es.yaml` translations change with them, because
the glossary shows both languages.

### P9 — Smaller corrections

| Item | Change | Grounds |
|---|---|---|
| `HalfCadenceShape` | Rename value `Basic` → name "Simple (I–V)" (id unchanged). Rewrite the description with the bass criterion for each shape. Preselect in E3 from the stage-2 bass (no stage 2 → simple; rising to ⑤ → converging; falling → expanding). Keep MANY_OF. | pp. 105–116; hybrids pp. 115–116 |
| `ECP` | Rewrite the description with Caplin's rule of thumb (§ C); E3 preselects it from the stage bounds by type; the annotator confirms where real and notated bars differ. | pp. 223–224 n. 4; pp. 257–259, 274 |
| `Stage1Components` | Add a value for the stage-1b tonic substitute (VI), with a new `TonicSubstitute` stub in `harmonic-functions.yaml`. Low frequency; non-breaking. | p. 57 |
| `ContrapuntalCadence` stub | Name "Prolongational Closure", alias "Contrapuntal Cadence" (id unchanged). Drop the planned Soprano / Tenor / Alto split from `cadences-design.md`: the book gives it no basis. | pp. 142–146; glossary p. 589 |
| `ReinterpretedAsHC` | Description: an authentic cadence that closes in the dominant key area and, because the home key comes straight back, is heard in retrospect as a half cadence in the home key. | p. 121; glossary p. 589 |
| `HalfCadenceRealised` | Optional addition: the dominant ends its group and is heard as the goal, not as a penultimate harmony; a seventh or inversion *after* the arrival does not cancel the HC. | pp. 101–103; p. 23 n. 70 |
| `Cadence` | Optional: "phrase, theme, or section" → "theme or theme-level phrase" (Caplin denies cadences above the theme, pp. 17–20). | § 2.2.2 |

### P10 — Stages assert existence

**The rule.** A stage fragment says "this stage is here". So tag a stage only
where its definition holds, and never widen a stage definition to fit a
deviation. Where the stage is missing, leave it absent: for a deviation, the
missing stage *is* the analysis.

**Applied.**

| Case | Caplin | Stages |
|---|---|---|
| Abandoned, type 1: root-position V shifts to V⁶ or V⁶₅ | The dominant is cadential, then undermined (p. 178) | `CadentialDominant` on the root-position span. The fragment ends there; the inversion lies just after it |
| Abandoned, with a cadential 6-4 that never reaches V (Ex. 4.43) | The 6-4 signals the onset of stage 3 (p. 179) | `CadentialDominant` with `Cadential64` on the 6-4; the fragment ends there |
| Abandoned, type 2: the dominant arrives inverted | It never attains cadential status (p. 178) | No stage 3. The fragment ends with the pre-dominant |
| Abandoned, type 3: the pre-dominant leads to no dominant | No cadential dominant (p. 178) | No stage 3 |
| Abandoned progression with no arrival (Q4) | Same three mechanisms | Same; stages 1–2 as far as they are genuine |
| Dominant Arrival on a **final** dominant (V⁷ ending a cadential progression) | A cadential progression exists (pp. 187–192) | Stages as in an HC, with `CadentialDominant` on the V⁷ |
| Premature DA on a root-position triad that ends a cadential progression | As above (pp. 193–202) | Stages as in an HC |
| Dominant Arrival on a **terminal** dominant, root position or inverted | No half cadential progression leads to it (p. 192) | **No stages.** The arrival is the last harmony event in the fragment |

**Why this and not "tag it and let the definition admit the deviation".**

1. **Caplin's axiom.** Stage 3 is root position throughout, in every genuine
   cadence and in the deceptive and evaded deviations (p. 179). Admitting an
   inverted dominant turns the stage into "whatever dominant is around".
2. **The graph already works this way.** `CadentialFinalTonic` is declared
   absent for evaded and abandoned cadences, and the evaded cadence's
   initiating harmony sits in the stage-4 slot without being stage 4. Treating
   stage 3 the same way is consistency, not a new idea.
3. **It keeps the data useful.** "Every `CadentialDominant`" stays a clean set
   for exercises and browsing. E3 gets a simple rule (root-position dominant →
   stage 3), and E4 can check it. Under the alternative, both lose their rule.
4. **It agrees with P1.** Expected stages are data; absence is a legitimate,
   queryable state rather than a gap.

**Costs.**

- A terminal-dominant DA has no child fragment, so its arrival is not marked
  separately. It is the last harmony event in the range, which is enough for
  E4 and the display.
- Its bounds need a rule, because there is no cadential function to measure:
  the fragment spans the last prolongational or sequential link into the
  dominant. Proposed for the tagging guidelines.
- In contiguous mode the last stage always reaches the fragment's end
  (`tagging-tool-design.md` § 4), so these fragments must end at the end of the
  last genuine stage. That is the Q4 rule, so the two fit together.
- Existing fragments may break the rule, for example an inverted dominant
  tagged as stage 3. The staging count decides how many (§ E). None locally.
- **The tool blocks the terminal-dominant case today.** See below.

**The child-less fragment and the tool.** Checked in the code on 2026-11-05. A
terminal-dominant DA needs every stage absent, and the tool does not allow that:
`toggleStageAbsent` refuses to remove the last active stage
(`frontend/src/components/score/stages.ts`), and `StageList.tsx` disables the
toggle with "cannot remove last active stage". This is not a consequence of
contiguous mode. Contiguity governs the stages that are present: adjacent ones
share a boundary, and the outer ones meet the main bracket. With no stages, there
is nothing to constrain. Stageless concepts such as `ClosingSection` already exist.
The guard exists only because no neighbour remains to absorb the space, and in
this case nothing needs to absorb it. The rest of the path is ready:

- the backend accepts an empty `sub_parts` list, and containment passes trivially;
- `computeStagesComplete` already treats all-absent as complete;
- re-enabling from zero already works: `handleToggleAbsent` re-places the wanted
  stages over the selection;
- re-opening a saved fragment with no children marks every optional stage absent.

So the change is to drop the guard and the disabled state. The risk is an editor
removing all stages from a PAC by accident. That is not blocked: E4's
expected-stage flag catches it, which is what P1 is for.

**Wording that follows.** `CadentialDominant` today says "the dominant of a Half
Cadence… must be a triad", which a DA on V⁷ contradicts, since DA is a subtype
of `HalfCadence`. Draft in § C.

### P11 — Tagging guidelines (new document)

**The gap.** Earlier drafts of this review pointed to a "tagging guide". No such
document exists. Rules for *how to tag* are scattered across
`tagging-tool-design.md` (how the tool behaves), `cadences-design.md` (the
theory), `prose-annotation-guidelines.md` (what the commentary says) and
Francisco's practice.

**Proposal.** Write `docs/howto/tagging-guidelines.md`, the sibling of the prose
guidelines, for the editor and for any reviewer, human or machine. It holds:

- fragment bounds = cadential function, not "the cadence chord" (§ 2.5);
- the HC arrival is the first arrival of the dominant through the progression
  (§ 2.9);
- consecutive PACs: the first closes, the second is a codetta with limited
  scope, unless the prose argues otherwise (§ 2.8.5);
- an overhang decides by its first pitch (§ 7.1.4);
- a seventh or inversion *after* the HC arrival does not cancel the HC
  (p. 23 n. 70);
- noncadential deceptive resolutions are not deceptive cadences (pp. 167–169);
- the `CadenceFunction` rulings (P5);
- abandoned cadences and where they end (Q4);
- the stage rule (P10), with the bounds rule for a terminal-dominant DA;
- the reopened HC's prior AC (Q8);
- when to lower `confidence`.

### P12 — "Half Cadence (Realised)"

**Why it looks odd.** "(Realised)" exists to separate the taggable concept from
its abstract parent, `HalfCadence`, which holds the plain name. The authentic
branch has the same pair, but its realised node is not taggable, so editors
only ever see PAC and IAC. The label also reaches public fragment pages, not
just the tagging tool.

**Proposal.** Swap the names, and leave the ids alone (they are immutable):

| id | `name` now | `name` proposed | `es.yaml` proposed |
|---|---|---|---|
| `HalfCadenceRealised` | Half Cadence (Realised) | Half Cadence | Semicadencia |
| `HalfCadence` (abstract) | Half Cadence | Half Cadence (General) | Semicadencia (general) |

The parenthesis moves to the one concept nobody tags, which appears only in the
glossary and the hierarchy. No code changes. Two test fixtures use the old
Spanish name as sample strings and can stay or follow.

**Alternative.** A concept-level `short_name`, like ADR-039's for property
values. It keeps both full names but needs code on every surface that prints a
concept, and those surfaces include the public ones. The swap is simpler and
fixes them all.

---

## C. Draft wording

Drafts in Doppia's register (one paragraph, glossary reader; `cadences-design.md`
§ "Terminology and prose conventions"). Paraphrase, not quotation.

**`ImperfectAuthenticCadence`.** A realised Authentic Cadence whose soprano
arrives on scale degree 3 rather than 1. Weaker than a PAC; characteristic of
the antecedent of a period, or of a Way Station towards a later PAC. An
arrival on scale degree 5 is highly exceptional in the Classical style, and
such a passage can often be heard another way, for instance as a covered PAC.

**`IACSopranoDegree`** (description). The scale degree of the melody at the
arrival of an IAC. Scale degree 3 is the norm. Scale degree 5 is highly
exceptional in the Classical style: consider a covered PAC first, and give the
argument in the commentary.

**`PrinnerCadence`** (new, description). True when an IAC carries a Prinner
melody (scale degrees 6–5–4–3) over a standard cadential bass (4–5–1). Common in
the galant style.

**`AbandonedCadence`.** An Authentic Cadence whose progression is given up
before it reaches its goal: the root-position dominant shifts to an inversion,
the dominant arrives already inverted, or the pre-dominant leads to no cadential
dominant at all. There may be no single moment of arrival, only a point where
the cadential motion stops. Where the Evaded Cadence fails at the arrival, the
Abandoned Cadence fails at the dominant.

**`CadentialDominant`.** Stage 3 of a cadence: the cadential
dominant, a root-position V or V7, optionally preceded by a cadential 6-4. In a
realised Half Cadence it is the arrival point and must be a triad; in an
Authentic Cadence it prepares the final tonic (Stage 4). An inverted dominant is
not cadential, so it is not this stage: an Abandoned Cadence or a Dominant
Arrival built on one has no Stage 3.

**`EvadedCadence`.** An Authentic Cadence whose final tonic never arrives: at
the moment it is expected, a new idea or phrase begins, so the event in that
position belongs to what follows instead of closing what came before. That
event is often I⁶, but almost any harmony can take the place, even a
root-position tonic. An evaded cadence usually prompts a repetition of the
preceding material (the "one more time" technique) that tries again for the
cadence. Not to be confused with a Deceptive Cadence, whose substitute harmony
is heard as the last event of the cadence.

**`DominantArrival`.** A deviation of the Half Cadence: a unit ends on the
dominant without forming a genuine half cadence. Either the final dominant of
a cadential progression carries a seventh, or the dominant is the last
harmony of a progression that prolongs or sequences rather than cadences, in
which case it may even be inverted. When the dominant arrives before the
melody, the phrase structure and the texture have run their course, the
arrival is premature, and then even a root-position triad counts as a
Dominant Arrival.

**`Premature`** (description). True when the dominant arrives before the
prevailing melodic, phrase-structural (for example, fragmentation) and
textural processes have run their course, so the music is held on the
dominant earlier than expected. Applies to final and terminal dominants, and
also to a root-position triad that would otherwise read as a half cadence:
tag that case as Dominant Arrival with Premature.

**`Covered`** (description). True when an elided perfect authentic cadence
is hidden by the first melodic pitch of the next unit (usually scale degree 3
or 5), which sounds above the cadential scale degree 1 and makes the PAC look
like an IAC. Also covers the inverse case: an IAC whose scale degree 3 is
covered by 1.

**`Elided`** (new, description). True when the cadential arrival is also the
first event of the next unit, so that the end of one unit and the beginning of
the next coincide. Applies to realised and deceptive cadences (an elided
deceptive cadence groups both backward and forward). An evaded cadence is
never elided: its would-be arrival belongs only to what follows.

**`ECP`** (description). True when the cadential function spans at least a
full phrase. As a rule of thumb: four real bars or more for authentic and
deceptive cadences, three or more for half and evaded cadences, counting the
final stage as one bar. Preselected from the stage bounds; confirm it where
real and notated bars differ.

**`HalfCadenceShape`** (description). How the bass approaches the dominant.
Simple (I–V): no pre-dominant. Converging: the bass rises to scale degree 5
(through 4 and often ♯4) while the melody falls. Expanding: the bass falls to
5 (from 6 or ♭6) while the melody rises. MANY_OF because a voice exchange can
turn one into the other within the pre-dominant.

**`CadenceFunction`** (value descriptions).
*Independent:* the cadence closes its unit on its own terms and does not stand
in for a PAC. *Way Station:* the cadence appears where a PAC is expected and puts
that closure off, whether or not the PAC eventually arrives. *Limited Scope:*
the cadence closes only a small unit (a basic idea, a codetta, an idea within
a compound presentation) and has no closing force at the level of the phrase
or theme.

The first draft of *Independent* read "no PAC is pending in its place". That
contradicts the internal-HC ruling, because a PAC is always pending in a
subordinate theme (p. 119).

---

## D. Re-deferred

| Item | Why not now | Where it goes |
|---|---|---|
| Medial standing on the dominant; fusion processes; missing closure targets | Formal-function matters | `formal-function-design-notes.md` (add a pointer to this review) |
| Melodic patterns and streams | Out of scope (Q7) | Nowhere for now. The E4 soprano extractor does not reopen this |
| One-more-time flag | Follows almost every evaded expanded cadence (p. 275); low value as a tag | Prose; revisit with E5 (repetition is a correspondence) |
| Metric ratio | Needs tagged formal units | Formal-function domain |
| Statistical defaults | Unchanged from the roadmap | After E3 |

---

## E. Staging counts (2026-11-05)

From `scripts/e1_staging_facts.py`, run read-only against staging. The campaign
stands at 155 top-level fragments (50 approved, 105 submitted) and 417 stage
children. The local database holds 21 and is not a usable sample. The "91
fragments" in the Component 11 triage counted stage children.

**Gates, all clear.**

| Check | Result | Consequence |
|---|---|---|
| `Unison` set | 0 | Retire it; no data migration |
| `Covered` set | 0 | Move it; no data migration |
| `IACSopranoDegree` = SD5 | 0 of 4 (all SD3) | P6 needs no audit |
| Evaded cadences | 24, each ending on its Dominant stage, none with a Final Tonic | The initiating-harmony lookup is well defined |
| Final Tonic on an HC, DA, evaded or abandoned cadence | 0 | `absent` in P1 matches practice |
| Abandoned cadences | 3 | All follow Q4 and P10 already (below) |
| Prose | 143 of 155 top-level fragments | The rulings' prose may still be missing, but prose in general is not |
| Soprano test set for E4 | 64 PAC + 4 IAC | |

**Abandoned cadences comply.** K279/i mm. 81–82 and K281/iii mm. 32–33 stop at the
pre-dominant with no Dominant stage. K280/ii mm. 53–54 has a Dominant stage with
`Cadential64` on a 6-4 that never reaches V, and ends there. These are the P10
cases as written, tagged before P10 existed.

**Audit list for Step 15.** Harmony labels are DCML's, read from staging. Each item
is Francisco's call.

| Fragment | Status | Now | Question |
|---|---|---|---|
| K281/i m. 27 | submitted | DA, `Premature`, `WayStation`, Dominant stage | Caplin reads this as a slightly premature dominant arrival from an ongoing Prinner, with no cadential progression (p. 176 n. 68), so the concept is right. That makes it a terminal dominant: under P10, remove the stage. Under Q3, `WayStation` becomes `Independent`. Needs Step 14 |
| K281/i m. 96 | submitted | Same | The recapitulation counterpart; same answer |
| K279/ii mm. 37–41 | approved | DA, `ECP`, three stages | The prose rests on the seventh, but the labels show V on beat 1 and V⁷ on beat 2. A seventh added after the arrival does not weaken an HC (p. 23 n. 70; p. 191). HC or DA? |
| K279/i mm. 23–24 | approved | HC, `WayStation`, `ClosesContinuation` | An internal HC, so `Independent` under Q3. See the note below |
| K279/i mm. 77–78 | approved | Same | Same |
| K279/i mm. 85–86 | approved | HC, `WayStation` | `Independent` under Q3 |
| K279/i mm. 34–35 | approved | PAC, `WayStation` | P5 says a PAC is never a way station: which function? |
| K280/i mm. 46–48 | submitted | PAC, `WayStation` | Same |
| K280/i mm. 134–136 | submitted | PAC, `WayStation` | Same |

**A note on K279/i mm. 23–24 and 77–78.** Q3 stands, but these two are the cases
that test it. Caplin's third reason for denying way-station status is that new
material follows an internal HC, while a way station repeats. Here the prose says
the continuation repeats. Two of his three reasons still hold, and
`ClosesContinuation` already points to `Independent`, since that schema is only
meaningful there.

---

## F. Decisions

All answered by Francisco, 2026-11-04 and 2026-11-05. No question remains open.

| Q | Question | Answer | Effect |
|---|---|---|---|
| Q1 | `IACSopranoDegree`; `PrinnerCadence` | Keep with a corrected description; `PrinnerCadence` is a property | P6 |
| Q2 | Optional "competing reading" | No. Ambiguity stays as `confidence` + prose only | P5 |
| Q3 | The four `CadenceFunction` rulings | All four stand, including the internal HC as `Independent`. Prose clarifications may be missing on existing fragments | P5 |
| Q4 | Abandoned cadential progressions with no arrival | Tag as `AbandonedCadence` fragments ending where the progression is given up | P8, P10 |
| Q5 | Stages where the stage definition does not hold | Tag no stage. Accepted on the condition that the tool allows a child-less fragment; it does not yet, so E1 adds that change | P10 |
| Q6 | Final vs terminal dominant as a property | No: definition only | P8 |
| Q7 | Melodic patterns (streams, Prinner, Cudworth) | Out of scope | § D; see P6 for why `PrinnerCadence` still stands |
| Q8 | How to tag the AC that a reopened HC overrides | As proposed: what it is morphologically, `CadenceFunction` = `LimitedScope`, with the prose naming the reopening | P11 |
| Q9 | Store Caplin's readings as a reference set | Yes: labels and bar numbers only, with page references | P4 |
| Q10 | Swap the two Half Cadence names | Yes | P12 |
| Q11 | A public version of the tagging guidelines | Yes, later: a short reader-facing page in both languages, built from `tagging-guidelines.md`, alongside the production launch | P11 |

**A note on Q9.** The repository is public, so a fixture committed here is
readable by anyone even though nothing in the product shows it. Labels, bar
numbers and page references are fine on that basis. The set must not grow into
paraphrased analysis.
