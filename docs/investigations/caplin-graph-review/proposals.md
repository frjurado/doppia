# E1 proposals and open questions

**Date:** 2026-10-08. Part of the [E1 review](README.md). Every row of
[`concordance.md`](concordance.md) that is not "Consistent" leads here.
Nothing below has been applied. Each proposal says what would change, where,
and in which Track E stage; the decisions are Francisco's.

Page numbers are Caplin, *Cadence* (2024). Draft wording for definitions and
descriptions is in § C, so the Claude Code pass has text to start from.

---

## Summary

| # | Proposal | Settles (roadmap E1 list) | Changes | Stage |
|---|---|---|---|---|
| P1 | Reaffirm decision 4; add per-concept **expected stages** read by defaults and checks | Decision 4 | YAML field + seed; `cadences-design.md` | E1 → E3, E4 |
| P2 | One rule for the contextual family: judge → BOOL; later unit → `FOLLOWS`; data → compute. Add `Elided`; narrow and redescribe `Covered`; retire `Unison`; `post_evasion_harmony` becomes a computed "initiating harmony" | Unison, Covered, elision; capture extensions | YAML; `capture_extensions.md`; Component 15 scope | E1 → E3 |
| P3 | `ReopeningHalfCadence` also `FOLLOWS DeceptiveCadence` | (concordance) | YAML edge; pointer validator | E1 → E3 |
| P4 | DCML → graph mapping policy | DCML mapping | E2 rules | E2 |
| P5 | `CadenceFunction`: record the departure, rewrite the value descriptions, four rulings; implement `confidence` with an optional competing reading | Confidence field | YAML descriptions; tagging guide; fragment schema; ADR | E1 → E3 |
| P6 | IAC: fix the public definition; correct `IACSopranoDegree`'s description (or remove it, see Q1); consider `PrinnerCadence` | (concordance) | YAML; E4 test-set text | E1 |
| P7 | Add "deceptive cadence (3̂)" as a BOOL on `DeceptiveCadence` | (concordance) | YAML | E1 |
| P8 | Rewrite `EvadedCadence`, `DominantArrival`, `Premature` | (concordance) | YAML | E1 |
| P9 | Smaller corrections: `HalfCadenceShape` naming, `ECP` criterion, stage 1b VI, `ContrapuntalCadence` name, minor wording | (concordance) | YAML; harmonic-functions stub | E1 |

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
| Abandoned | optional | optional | optional (see Q5) | **absent** |
| HC (realised, reopening) | optional | optional | expected | — |
| Dominant Arrival | optional | optional | see Q5 | — |

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
| **Unison** | 3 | **Retire the schema** and compute a texture flag at the arrival (monophony or doubled monophony) with the E4 soprano extractor. | Caplin's term is the *unison half cadence* (p. 114; glossary p. 592); a unison PAC needs a bass-line melody (p. 114). Texture is rhetorical (p. 139) and visible in the notes. Zero uses in 91 fragments (Component 11 triage, item 9), so removal needs no migration if that still holds (§ E). |
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
target. Also add the alias "Reopened HC" (Caplin's term).

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
Arrival, Abandoned, Reopening HC, `LimitedScope` gestures) are not
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
| An internal HC in a subordinate theme | Explicitly not a way station, for three stated reasons (p. 119) | `Independent`, with no `ThemeClosure` (subordinate-theme part 1 is a deferred value). |
| A way station that is denied (no PAC follows, or an HC follows instead) | Still a way station by its context; the denial is a further event (pp. 162–164, 175–176) | `WayStation`; the prose says it is denied. This matches the design doc's "a WayStation may be unfulfilled". |
| Independent vs way station left open | Caplin leaves it open (K332/iii mm. 21–32, p. 165) | One value + `confidence` (below). |

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
- **Add an optional "competing reading"**: one concept id (and, if needed, one
  property value) naming the alternative. This is not double tagging: there is
  still one fragment and one primary concept. It makes Caplin's ambiguity pairs
  queryable (evaded / elided deceptive; evaded / PAC; evaded / HC; abandoned /
  deceptive; HC / premature DA), which is exactly what Component 15 exercises
  and a research query want. Whether this stretches decision 8 too far is
  **Q2**.
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
- **`IACSopranoDegree`.** With SD5 that rare, the schema records SD3 almost
  every time. Two options:
  - **(a) Keep it, with a corrected description** (recommended): SD5 is
    highly exceptional in the classical style and should come with an argument
    in the prose. Genuine cases exist (one in Caplin's classical set, three
    nineteenth-century ones, p. 93 n. 113), the graph's aim is portability, and
    keeping it needs no migration. An E4 flag on SD5 sends each one to review
    as a possible covered PAC.
  - **(b) Remove it.** The E4 soprano test set is unaffected (PAC implies
    SD1, IAC implies SD3), but a genuine IAC on 5 then has only prose.
- **`PrinnerCadence` (candidate, BOOL on IAC).** Caplin treats the Prinner
  cadence as a genuine IAC variant (pp. 85–86; glossary p. 587), relevant to
  the galant sonatas: K282/i closes its main theme with one (p. 98). The
  criterion: (1) yes; (2) yes, for schema pedagogy; (3) partly derivable once
  the soprano line is extracted, not now. Worth adding if Francisco expects to
  use it in exercises; otherwise prose (**Q1**).

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

The four rewritten definitions (with the IAC) carry `definition_reviewed:
true`. Francisco either approves the new text in this pass or the flag goes
back to `false` until he does.

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
| Tagging guide | Add: fragment bounds = cadential function (§ 2.5); HC arrival = first arrival of the dominant through the progression (§ 2.9); consecutive PACs (§ 2.8.5); overhang decides by its first pitch (§ 7.1.4). | as cited |

---

## C. Draft wording

Drafts in Doppia's register (one paragraph, glossary reader; `cadences-design.md`
§ "Terminology and prose conventions"). Paraphrase, not quotation.

**`ImperfectAuthenticCadence`.** A realised Authentic Cadence whose soprano
arrives on scale degree 3 rather than 1. Weaker than a PAC; characteristic of
the antecedent of a period, or of a Way Station towards a later PAC. An
arrival on scale degree 5 is highly exceptional in the Classical style, and
such a passage can often be heard another way, for instance as a covered PAC.

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
*Independent:* the cadence closes its unit, and no PAC is pending in its
place. *Way Station:* the cadence appears where a PAC is expected and puts
that closure off, whether or not the PAC eventually arrives. *Limited Scope:*
the cadence closes only a small unit (a basic idea, a codetta, an idea within
a compound presentation) and has no closing force at the level of the phrase
or theme.

---

## D. Re-deferred

| Item | Why not now | Where it goes |
|---|---|---|
| Medial standing on the dominant; fusion processes; missing closure targets | Formal-function matters | `formal-function-design-notes.md` (add a pointer to this review) |
| Melodic patterns and streams | See Q7 | After the E4 soprano extractor |
| One-more-time flag | Follows almost every evaded expanded cadence (p. 275); low value as a tag | Prose; revisit with E5 (repetition is a correspondence) |
| Metric ratio | Needs tagged formal units | Formal-function domain |
| Statistical defaults | Unchanged from the roadmap | After E3 |

---

## E. Facts to verify before the YAML pass

Counts on staging, needed before any schema is removed or narrowed:

- fragments with `Unison` or `Covered` set (91-fragment local count: zero);
- fragments with `IACSopranoDegree` = SD5;
- `Covered` set on a cadence that is not a realised AC (blocks moving it);
- evaded-cadence fragments: does each end at the end of its dominant stage,
  so that the initiating-harmony lookup is well defined? (Example: the K279/ii
  fragment ending in m. 3, against Caplin's evasion at the downbeat of m. 4,
  p. 171.)

---

## F. Open questions for Francisco

- **Q1.** P6: keep `IACSopranoDegree` with a corrected description (a), or
  remove it (b)?
  And `PrinnerCadence`: a property, or prose?
- **Q2.** P5: is the optional "competing reading" acceptable under decision 8,
  or should ambiguity stay as `confidence` + prose only?
- **Q3.** P5: do the four rulings match how you have been tagging? In
  particular the internal HC as `Independent`.
- **Q4.** Abandoned cadential *progressions* with no moment of arrival (Caplin's
  open bracket, pp. 182–187): tag them as `AbandonedCadence` fragments ending
  where the progression is given up, or tag only abandoned *cadences* with a
  discernible arrival and leave progressions to the prose of the surrounding
  fragment?
- **Q5.** Stage children where the stage concept's own definition does not
  hold: the inverted or missing dominant of an abandoned cadence, and a
  Dominant Arrival on a terminal (possibly inverted) dominant with no cadential
  progression. Tag no stages, or tag the stage and let the definition admit the
  deviation?
- **Q6.** Should final vs terminal dominant be a property of
  `DominantArrival` (ONE_OF), or is the definition enough? It is largely
  derivable from the harmony, which argues for the definition only.
- **Q7.** Melodic patterns (Caplin's streams, the Prinner, the Cudworth): a
  future schema for exercises, or out of scope? Caplin himself calls the
  structural-pitch choice ad hoc (p. 65), so agreement between annotators
  would be low.
- **Q8.** The reopened HC overrides its AC (pp. 124–125): how should the AC
  fragment itself be tagged? Proposed default: tag it as what it is
  morphologically, `CadenceFunction` = `LimitedScope`, with the prose naming
  the reopening.
- **Q9.** P4: may Caplin's readings of the corpus passages be stored as a
  reference annotation set (labels and bar numbers only, with page
  references)? It would be internal test data, not published content.
