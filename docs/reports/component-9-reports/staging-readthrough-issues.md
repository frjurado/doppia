# Staging Read-Through — Issue Triage (Component 9)

**Date:** 2026-06-23
**Author:** Francisco (raw list) · investigation & triage drafted in Cowork
**Source:** a full read/listen pass over the 15 re-ingested movements on staging, after Step 9 (re-ingestion of the existing 15) but before Part 3 (full corpus), Part 8 (campaign), and Part 9 (review).
**Status:** investigation complete; dispositions proposed, several flagged for a decision with Francisco before any code lands.

This report does for the staging read-through what `various-issues.md` did for the pre-component backlog: it is the canonical surface for this batch. Every raw bullet is grouped, given a *grounded* explanation where the code or data supports one, assessed for feasibility, and assigned a disposition (fix in an existing Step, a new sub-step, a decision-first item, or a Phase-2 deferral). Nothing here is a patch instruction — it is the map that should precede the patches.

## How to read this

Each cluster carries a **confidence** tag on its explanation:

- **Confirmed** — traced to specific code/data in this repo; cited inline.
- **Grounded hypothesis** — strongly supported by code/data we *can* see, but the decisive artefact (the re-ingested MEI in MinIO, or live Verovio MIDI output) was not run here. These need one confirmation pass before a fix is committed.
- **Open question** — the mechanism is genuinely undetermined; the disposition is "investigate," not "fix."

The single most important finding up front: **a large share of the new ingestion symptoms are regressions or side-effects of the Step 6–9 normalizer/recovery work, not pre-existing damage.** Francisco's instinct ("some might be older, but others might be artifacts of the solutions implemented in normalization") is correct, and the clef cluster in particular points straight back at `recover_measure_start_clefs`. That reframes Step 9: re-ingestion did not just *propagate* fixes, it introduced new clef artefacts that must be caught before the full-corpus ingest (Step 10) multiplies them across 39 more movements.

---

## Staging re-verification after the Band-1 re-ingest (2026-06-30)

Francisco read through the 15 re-ingested movements again after Band 1 (Items 2–6) landed and the local re-ingest ran. **Verified fixed: A2, B1, B2, B3.** **Still broken (re-opened): A1, A3, C2-playback, D1-labels** — plus one new symptom (K331/ii incipit slurs). The decisive new evidence is Francisco's clef census of K331/ii across NMA / DCML-in-MuseScore / Doppia. Grounded root causes from inspecting the *actually-ingested* MEI (pulled from MinIO) and the recovery code:

**The prep-level audits had blind spots — that is why these shipped marked "fixed."** `scripts/clef_audit.py` only detects *within-measure* doubles and per-voice scope, so it cannot see a clef that is **misplaced** (a single valid-looking clef in the wrong measure) or **missing** (absence isn't flagged). `scripts/staff_audit.py` only checks `<staffDef>`/`<instrDef>` labels, so it never saw the group-level labels. Both reported clean while the symptoms persisted. Any "fixed on prep" claim that rests on these audits must be re-confirmed on a render, not just the MEI.

### A1 + A3 are ONE bug (K331/ii), and not the originally-hypothesised one

The original A1 explanation (recovery's first-child idempotency guard stacking a second `<clef>`) is **wrong** — the ingested K331/ii MEI contains **no** duplicated `<clef>` in any measure. What actually happens, confirmed by instrumenting the recovery on K331-2:

- **`recover_measure_start_clefs` is a complete no-op here.** `_extract_measure_start_clefs` returns **0** changes even though the `.mscx` bass staff has **22** `<Clef>` elements. Cause: MuseScore encodes a measure-start clef change at the **end of the previous measure** (after the notes — exactly Francisco's "shown before the barline" placement), but the extractor only accepts a clef that appears **before** any `<Chord>`/`<Rest>` (`not seen_note`), so it classifies all 22 as mid-measure and recovers none. The "section-aware index (A3)" can't help either: Verovio collapses the movement into a **single** MEI `<section>` (`_mei_top_sections` returns 1, not the minuet+trio 2), so it always falls to flat indexing.
- **So the misplaced/missing clefs are converter artefacts, not ours.** With the recovery inert, the clefs in the MEI are whatever MuseScore's MusicXML export + Verovio import produced. Francisco's census shows the tell: the spurious **minuet** clefs (m7, m25, m37, m43) are exactly the **trio's** measure-start clefs (his trio `*` rows m7/m25/m37/m43), and the trio itself is left with essentially none (the ingested MEI has one trio clef, at the very end). The minuet/trio **restarting measure numbers** make the trio's clef changes collide onto the minuet measures of the same number on import. A3 ("trio clefs vanish") and A1 ("spurious/double minuet clefs") are two faces of this one collision.
- **Direction for a fix — VALIDATED (2026-06-30):** the collision is in **Verovio's MusicXML importer keying clef placement on the measure number**. Proof: rewriting the `.mxl` so every measure carries a *unique* `number` before import restores **all 22** `.mscx` clefs at their correct document-order measures (the trio clefs at idx 52–98 return; the stray menuet n=24/n=42 clefs vanish) — 14 → 23 clefs in the MEI. The fix is therefore **B2**: renumber the MusicXML measures uniquely for the import, then restore the true restarting `@n` on the MEI afterward (safe — `@n` is display-only and `mc` is document-order; see Phase B and the mc/mn note below). This **supersedes** the earlier "trailing-clef recovery must override the converter" direction.

### The other "double clef" cases are mid-measure changes in two-voice regions (2026-06-30, corrected)

The earlier framing — that these are measure-start doubles with a "resolved in MEI" bucket — was **wrong** (Francisco, on render). Every A1 "double" is **one musical clef change inside a region where the staff carries two voices**: none are measure-start, and none are resolved.

| Location | What the render shows | Onset |
|---|---|---|
| 283/ii m.19, m.25 · 332/iii m.210 | two glyphs | mid-bar (m19 beat 3, m25 beat 2, m210 beat 2 of compound) |
| 279/i m.86 | two glyphs; the affected note still prints as if in F | real clef at beat 3 + a spurious one a 16th later |
| 279/iii m.72 | two glyphs | real clef on the 2nd eighth + a spurious one on beat 2 |

Inspecting the raw converter MEI, the converter scatters that single clef change across the staff's layers as inconsistent fragments:

| Fragment the converter emits | Effect | Seen at |
|---|---|---|
| a real `<clef>` in a layer with **no notes after it** (only `<space>`) | a spurious glyph that positions nothing | 283/ii m19 L6, 279/i m86 L5 |
| `<clef sameas="#…">` restating another layer's clef | Pass 10 resolves it to shape/line → a **2nd drawn** glyph | 283/ii m19/m25 L6 |
| the two layers' clefs at **different onsets** | glyphs spaced apart → a visible double | 279/i m86, 279/iii m72 |
| a `<clef>` **nested inside a `<beam>`** | a note *before* it stays in the old clef | 279/i m86 L6 |

Verovio probes (synthetic 2-voice renders) settle which levers exist:

- `visible="false"` on a clef is **ignored** — Verovio draws it anyway. Glyph suppression is not available.
- Two **identical** clefs at the **same onset overlap** at one x (render as one glyph); the *visible* doubles are exactly the cases where the converter placed them at **different** onsets.
- A `<clef>` as a direct **`<staff>` child** draws **one** glyph and repositions **all** voices — but only at a measure boundary (it carries no mid-bar onset), so it does not help these mid-measure cases.
- A clef **in one layer only** repositions that layer only (this *is* A2); a clef **in every layer** repositions all voices but draws N glyphs. There is **no** in-layer encoding that is simultaneously single-glyph and all-voices mid-measure.

So the fix is **dedup + onset-alignment, in-layer** — not a measure-start clef-scope change. (A2's "inject into every layer" recovery is therefore a latent double-generator on any multi-voice measure-start, and is folded into Phase A below.)

### Disposition: a two-phase clef workstream (decisions recorded 2026-06-30)

**Phase A — per-voice / mid-measure doubles (low risk; ADR-031).** A normalizer reconciliation (extend Pass 10) that, per staff: (1) **drops a `<clef>` from any layer with no note/chord after it** (kills the spurious glyphs); (2) **collapses a `sameas` restatement** that duplicates another layer's clef at the same onset (Pass 10 is the pass turning a silent `sameas` into a drawn double); (3) **onset-aligns** the clefs of a genuine co-active two-voice change to the same offset so the glyphs overlap into one, and **hoists a beam-nested clef** to its voice's correct position. Re-settles A2. Also switch the **measure-start recovery** — currently injects into *every* layer, a latent double-generator — to a single whole-staff encoding (a `<staff>`-child clef or running `<scoreDef>`, both proven single-glyph + all-voices at a barline).

**D3 — courtesy clef placement: BEFORE the barline, always (decided with Francisco, 2026-06-30; ADR-031).** The natural convention and Francisco's preference. Place a recovered/normalised measure-start clef as the **trailing clef of the previous measure** (the courtesy-before-barline position MuseScore itself uses), not at the head of the new measure. Solve it now, designed *with* Phase A's clef handling. (Note: a trailing clef is layer-scoped like any in-layer clef, so the same dedup/onset-alignment from Phase A applies to it.)

**Phase B — K331/ii multi-section / restarting `@n` (B2, VALIDATED; higher risk, chosen with Francisco 2026-06-30; ADR-032).** Chosen over a local clef-only repair because the restarting number is the common root of the clef loss and (very likely) the C2 repeat-expansion and incipit-slur symptoms — fix it once at the source. **Mechanism proven** (see the A1+A3 section above): **renumber the MusicXML measures uniquely before the Verovio import, then restore the true restarting `@n` on the resulting MEI.** Safe by construction — `@n` is the display-only human coordinate (ADR-015) and `mc` is document-order, so the restored restart preserves both `mc` and the displayed numbering. **Gate before building:** confirm on a fresh prep + live re-ingest that (a) all 22 K331/ii clefs return at the right measures, (b) `mc` is unchanged (document order is untouched) and the 15-movement mc-stability check passes, (c) repeat / volta / ending handling is preserved or improved (the C2 playback symptom), and (d) the restored `@n` still satisfies the ADR-015 duplicate-`@n` (Step 8) disposition. Likely lands as a new corpus-prep step between `convert_mscx_to_mxl` and `convert_mxl_to_mei`, with `mc`/`@n` round-trip unit coverage.

#### Why duplicate `@n` is a problem *here* but not for our data model (the mc/mn question)

`mc` (measure count = Verovio position index) is **always unique** — a 1-based document-order rank over `<measure>` elements (ADR-015). Fragment coordinates live on `mc_start`/`mc_end`, so duplicate display numbers never threaten machine identity. `@n` / `mn` (the notated bar number) **legitimately restarts** at the Trio — correct, matches the NMA, and we keep it. **So duplicate `@n` is not a defect in our model**, and Francisco is right that it "shouldn't" be a problem. The problem is confined to **Verovio's MusicXML→MEI importer**, which keys clef placement on the measure *number*: when the Trio reuses the Menuetto's numbers, the importer routes the Trio's measure-start clefs onto the Menuetto bar of the same number and drops the mid-measure ones. **B2 removes the duplication only for the importer's benefit and restores the correct restarting `@n` immediately after** — displayed numbering and `mc` are both untouched.

### C2 — visual fixed, playback still wrong

The overlay erratum landed: the ingested K331/ii MEI has `@left="rptstart"` on the trio's second strain (`e65xqli`, mc65), and the score now shows it. But playback still expands **both** trio repeats back to the minuet's `|:` (m19) — even the strain that now has its own start-repeat. Hypothesis (needs a Verovio repeat-expansion trace): the trio's **first** strain ends with a `rptend` (mc64) that has no opening `rptstart` by design (a new section's opening repeat is implicit), and that unmatched close plus the single-section / restarting-number structure derails Verovio's whole repeat expansion for the trio. This is a Verovio/structure issue, separate from the (correct) overlay data fix.

### D1 — brace/bar.thru fixed, instrument labels NOT

Pass 11 correctly braces the grand staff and sets `bar.thru`, but the labels Francisco still sees ("Piano" on K331/i; "Piano, Piano right" + "Pno." on later systems for K331/ii–iii, K332/i, K332/iii) are `<label>` / `<labelAbbr>` **children of the `<staffGrp>`** — and Pass 11 only strips labels from `<staffDef>` and `<instrDef>`. The ADR-029 conclusion that "the current converter emits no labels" was **wrong**: it rested on `staff_audit`, which doesn't check group-level labels or `<labelAbbr>`. The converter *does* emit them for movements whose `.mscx` carries a track name (K331 all three; K332/i, /iii; K279/K280/K283 carry none — hence the inconsistency). Fix (not yet done): Pass 11 strips `<label>`/`<labelAbbr>` from the leaf `<staffGrp>` too; the audit checks them.

### K331/ii is the epicentre — Francisco's grouping is right

A1, A3, C2-playback, the "blank space", the giant caret (E1), and the **new** incipit symptom (enormous slurs on both staves) all cluster on the one movement with restarting/duplicate measure numbers. The incipit slurs are most likely slurs whose `endid` falls outside the incipit's 4-measure window (Verovio draws them open-ended to the edge), aggravated by the duplicate `@n`. These should be investigated together as a **multi-section / restarting-numbers** workstream rather than piecemeal. The single-MEI-`<section>` collapse (Verovio importing minuet+trio as one section) is a strong common suspect worth confirming first — it would explain the clef collision, the repeat mis-expansion, and the `@n` ambiguity at once.

---

## Cluster A — Clefs: double clefs and per-voice clef scope (highest priority)

This is the largest, most coherent cluster and the one with the clearest causal story. The raw items:

- 279/i m. 86: "two G clefs"; 279/iii m. 72: "two consecutive G clefs (only the first is legitimate)"; 283/ii m. 19 & 25: "two redundant F clefs"; 331/i m. 98: "double G clef"; 331/ii m. 6: "two F clefs"; 332/iii m. 210: "double F clef" — **double-clef family.**
- 279/iii m. 110, 280/i m. 46, 280/ii m. 24, 331/ii m. 24–25: voice two "way above the real one / written as if in F clef, even though there's a clef there; the clef only affects voice one" — **per-voice clef-scope family.**
- 331/ii Trio (after m. 48): "no clef changes anymore (there should be several in the second staff)" — **multi-section recovery failure** (see also Cluster C).
- 279/i m. 5 / 279/iii m. 5–11: courtesy-clef placement (clef before vs after the barline) — **cosmetic, separate** (see Cluster D).

### Explanation — double clefs (Grounded hypothesis)

The Step 6 fix `recover_measure_start_clefs` (`scripts/prepare_dcml_corpus.py`, ~L487–541) re-injects measure-start clef changes that MuseScore's MusicXML exporter drops. Its idempotency guard is too narrow:

```python
layer = staff.find(f"{{{_MEI_NS}}}layer")            # L528 — FIRST layer only
first = next((c for c in layer if isinstance(c.tag, str)), None)
if first is not None and first.tag == f"{{{_MEI_NS}}}clef":
    continue  # a measure-start clef already exists — leave it (idempotent)  L531–533
```

It only skips when a clef is the **first child** of the layer. But in this corpus a genuine clef change can sit **mid-layer** (after a beam/rest), exactly as observed in the retained K279/i MEI: at m. 86, staff 2 / layer 5 the `<clef shape="G" line="2">` is *not* the first child (the first child is a `<beam>`). When the `.mscx` also reports a measure-start clef there, the guard does not fire, and a second `<clef>` is inserted at position 0 — producing the two-glyph render Francisco sees. Pass 10 (`_resolve_clef_sameas`) compounds this independently: the converter emits per-voice clef restatements as `<clef sameas="#…"/>`, and resolving them to explicit shape/line turns a silent duplicate into a *visible* second glyph.

So "double clef" has two contributing mechanisms, both introduced/triggered by the Step 6–7 work: the recovery's first-child-only idempotency check, and `sameas` resolution making per-voice restatements render.

### Explanation — per-voice clef scope (Confirmed mechanism, hypothesis on the trigger)

In MEI a `<clef>` inside a `<layer>` is **layer-scoped**: it changes the clef for that voice only. The retained K279/i MEI confirms multi-voice bass measures encode the clef in just one layer (m. 86: layer 5 carries `G/2`, layer 6 carries no clef and its first child is a `<note>`). Verovio renders layer 6 under the *previous* staff clef — which is precisely "voice two written as if in F clef, even though there's a clef there." This is a real property of the converter output and would exist with or without the recovery pass.

The recovery pass makes it worse, not better: it injects the recovered clef into `staff.find("layer")` — **the first layer element only** (L528). So when a staff has two voices, the recovered measure-start clef lands on one layer and the other voice is left in the old clef. A correct fix must inject the clef into *every* layer of the staff (or hoist it to staff scope), and Pass 10 must likewise ensure both voices end up clef-consistent.

### Explanation — Trio clefs vanish (Grounded hypothesis)

`recover_measure_start_clefs` matches the `.mscx` measure index to MEI by document-order position: `measures[measure_index - 1]` (L520–525), skipping when `measure_index > len(measures)`. K331/ii is the multi-section minuet+trio file with 51 duplicate-`@n` warnings and restarting numbering; its document-order index and the `.mscx` per-section measure index can diverge, so recovery either skips the trio's clefs or would mis-place them and bails. That matches "no clef changes anymore after m. 48." (Confidence is a hypothesis because the `.mscx`→MEI index alignment for that specific file was not re-run here.)

### Feasibility & disposition

All three are tractable normalizer/recovery fixes, none architectural:

1. **Idempotency guard:** check for *any* existing clef in the layer at the same musical position, not just first-child, before injecting. (Confirmed-safe direction.)
2. **Per-voice scope:** inject the recovered clef into every `<layer>` of the staff (or to a single staff-level clef Verovio applies to all voices), and make Pass 10's `sameas` resolution converge voices rather than duplicate them.
3. **Multi-section index alignment:** make the `.mscx`↔MEI measure mapping section-aware (or key on `@n`+section rather than raw document order) so the trio is covered.

**Disposition: reopen Step 6** (clef rendering) — it was marked done after the K279/i investigation, but that investigation only validated the *missing-clef* direction on a single-voice reduction; the double-clef and multi-voice cases were not in its fixture set. Add multi-voice and multi-section measures (279/iii m. 110, 280/i m. 46, 331/ii trio) to the render spot-check list. **This must precede Step 10** — otherwise the same recovery bug is replicated across 39 more movements, several of which have far more multi-voice writing than K279.

---

## Cluster B — Accidentals in playback: cross-voice, cross-octave, and source errata

The raw items, by sub-type:

- **Cross-voice within a staff/measure** (an accidental in one voice should bind a same-pitch note in another voice, but doesn't in MIDI): 279/ii m. 51–52 (LH ornament B♮); 283/ii m. 17 (two C♯ sound natural — "preceding sharp is in another voice"); 331/ii m. 25 ff. (C♮ collides with C♯, natural should apply to both; B♭ in m. 29); 332/ii m. 9–10, 13–14 (E♮ then a same-octave-different-voice note sounds flat/natural wrongly).
- **Cross-octave bleed** (an accidental wrongly carried into a different octave): 279/ii m. 67 (B3♮ affects B4♭ — should stay flat); 280/ii m. 30 & 58 (notes naturalised by an accidental in another octave); 279/ii m. 70 & 283/ii m. 22 (a sharp affecting a note **earlier** in the bar / a different voice).
- **Source errata** (the data itself is wrong, independently of any engine): 332/ii m. 24 ("accidental errata from the source"); 279/ii m. 51–52 ("the original edition DCML references has an explicit flat, but it isn't in MuseScore"); 332/iii m. 22/27/232/237 (a B♭ played natural).
- **Playback-only naturals where nothing is shown:** several of the above — SVG correct, MIDI wrong.

### Explanation (Grounded hypothesis + Open question, deliberately split)

This is **not** the same defect as ADR-021/022. That pass *strips* spurious gestural accidentals the converter added; these symptoms are the opposite — an accidental that *should* sound is **not** realised in MIDI. Two distinct mechanisms, plus a third class that is neither:

1. **Verovio's MIDI running-accidental scope is per-layer.** When a second-voice note carries no `accid.ges` of its own, Verovio infers its gestural pitch from that *layer's* running state, which does not include the other voice's accidental. Classical engraving convention is that an accidental binds the whole **staff** for the rest of the measure (same pitch, same octave) regardless of voice — so the cross-voice cases are a genuine convention/engine mismatch. The normalizer's Pass 9 already reasons about carry **per staff** keyed on `(pname, oct)` (`_strip_spurious_gestural_accidentals`, ~L1287–1361), so the *data model* supports staff-scoped carry — but Pass 9 only *removes* accidentals; nothing *adds* an `accid.ges` to the cross-voice note that needs one for MIDI. A new "accidental completion" pass (the inverse of Pass 9: propagate an explicit accidental's alteration onto later same-`(pname,oct)`-same-staff notes within the measure that lack one, as `accid.ges`, printing nothing) would make MIDI honour the convention. **Grounded hypothesis** — feasible, and architecturally symmetric with the passes already there, but it must be verified against live Verovio MIDI on the re-ingested files before committing, because if Verovio *is* already staff-scoping in some builds we'd be double-correcting.

2. **Cross-octave / backward cases** point at either a converter `accid.ges` artefact (the "backward" ones almost certainly are — an accidental cannot legitimately bind an earlier note) or an octave-insensitive inference. Pass 9 keys carry by `(pname, oct)`, i.e. octave-correct, so the *normalizer* is not the cause; the question is what Verovio's MIDI does with these specific encodings. **Open question** — needs a per-note three-way trace (MEI `accid`/`accid.ges` → SVG glyph → MIDI pitch), exactly the methodology in `docs/investigations/accidentals-k279-mvt1/`.

3. **Source errata** are upstream DCML/MuseScore data errors. Francisco flags several explicitly and raises the right meta-question — *twice* — "how to deal with mistakes from the source data?" This needs a **policy**, not a per-note fix (see Cluster C's repeat-errata for the same question on a different field).

### Feasibility & disposition

- **Open a dedicated accidentals-in-playback investigation** extending the existing `accidentals-k279-mvt1/` folder, covering cross-voice and cross-octave with a fresh MIDI dump from the re-ingested corpus. Classify each cited bar into the three buckets above. This is the prerequisite to any normalizer change. **New sub-step under Part 2 (Step 7b), gated before Step 10** for the same reason as clefs — a normalizer change here should ship once, before the full ingest.
- **Source-errata policy** is a cross-cutting decision (see Cluster C). Recommendation going in: an explicit, versioned **corrections overlay** (a small per-movement patch list applied in the normalizer, audited and attributed), rather than silent edits — consistent with ADR-014 original retention and ADR-009's DCML constraints. **Decision-first.**

---

## Cluster C — Multi-section movements & coordinate NaNs (K331/ii and friends)

Raw items: K331/ii trio "weird stuff" (da capo with `<i>`, no start-repeat on trio, blank space at m. 40, caret absurdly high until m. 19); the first/second repeat in the trio jumping back to the minuet's repeat (m. 19/17); "second repeat has no start-repeat — that's a DCML error"; transport shows `NaN` as bar number at 283/ii m. 14 (2nd ending), 331/i m. 98, 279/ii m. 28 ("NaN:1" on the partial-after-repeat), "every similar case as well as in second endings."

### Explanation (Confirmed + Grounded hypothesis)

These are all facets of **human-coordinate ambiguity in multi-section / volta / partial-measure structure** — the exact territory ADR-015 and the Step 8 duplicate-`@n` decision (accept + downgrade, 2026-06-16) already carved out for *machine* coordinates. What's surfacing now is the **display** side that was deferred:

- The `NaN` transport readout is the same root as the known `bar_start=NaN` Fly-log 422 (Step 3), but on a different surface: the bar:beat readout maps playback time → measure → `@n`, and for partial-after-repeat and `X`-suffixed ending measures the `@n` is non-integer/duplicated, so the human-bar lookup yields `NaN`. The transport-display path (`useMidiPlayback`'s `parseTransportPosition`) and the mc→mn display index both need the same guard Step 3 puts on the selection path. **Confirmed family**, distinct surface.
- The trio repeat jumping to the minuet's `|:` is a real structural consequence of restarting numbering plus a **missing start-repeat in the source** (Francisco identifies the DCML error at m. 17). ADR-025 already chose "no repeat-barline gates" for *selection*; **playback** repeat expansion is Verovio's, and a missing `|:` in the data makes it jump to the previous one. This is a **source-errata** instance again — same policy question as Cluster B.
- "Caret absurdly high until m. 19" is the caret-height issue (Cluster E), amplified by the trio's section break.

### Feasibility & disposition

- **NaN transport/display:** fold into **Step 3** (the same mc↔mn guard) and verify on the 2nd-ending and partial-after-repeat cases here. Small, confirmed.
- **Trio structure / missing start-repeat:** **source-errata policy** (Cluster B decision) plus a verification that the Step 8 multi-section disposition covers the *display* of K331/ii, not just its warnings. The Step 8 decision explicitly deferred "display disambiguation" to Step 15 — these items are that deferred work surfacing. **Route to Step 15** (measure/section display) + the errata decision.
- The `<i>` in the da-capo label and the m. 40 blank space are render-cosmetic (Cluster D).

---

## Cluster D — Other rendering (cosmetic / Verovio-layout)

Raw items: instrument names on piano (sometimes absent, "Piano", or "Piano, Piano right"); brace present on some scores but not 332/i & ii; barlines not crossing the system in 332/ii; 279/ii "ugly" triplets (hidden in MuseScore, shown in Verovio; worse when tied to a partially-hidden second voice — m. 6, 7, 10); 279/ii dashed slurs; 332/iii m. 190–195 "super weird slur spanning 6 measures"; courtesy-clef placement (clef after vs before the barline — 279/i m. 5, 279/iii m. 5–11); da-capo label containing `<i>`.

### Explanation (Confirmed for labels/brace; Grounded hypothesis for the rest)

- **Instrument labels & brace are not normalized at all.** The retained K279/i MEI has `staffDef/@label = None` and `staffGrp/@symbol = None` (no brace), with `bar.thru="true"` on the inner group only. The normalizer has no pass touching `staffGrp/@symbol`, `@bar.thru`, or `staffDef/@label`, so whatever the converter emits per file survives — hence the inconsistency Francisco sees ("nothing" vs "Piano" vs "Piano, Piano right"; brace on some, not on 332). **Confirmed: converter variance, unnormalized.** A small normalizer pass can standardise piano scores: drop redundant instrument labels (a single-instrument piano score needs none), force `staffGrp/@symbol="brace"` and `@bar.thru="true"` across the grand staff. Low risk, high tidiness payoff, and it improves every incipit. (Exact per-file current state should be re-checked on the re-ingested MEI, but the *absence of any normalizing pass* is confirmed.)
- **Triplets, dashed slurs, 6-measure slur** are Verovio engraving of constructs MuseScore hides or draws differently. The "hidden in MuseScore, shown in Verovio" triplets are tuplet brackets whose `@bracket.visible`/visibility flags don't survive export; the 6-measure slur is almost certainly a slur whose `@endid` resolved to the wrong note (the same endpoint-resolution failure family as the lost tie in ADR-026, but for `<slur>`). **Grounded hypothesis**, per-construct; each needs a quick MEI inspection. Tuplet-bracket suppression and slur-endpoint sanity could become normalizer passes, but the payoff is cosmetic.
- **Courtesy-clef placement** (clef rendered after the barline instead of as a courtesy before it) is a Verovio layout choice driven by where the clef sits relative to the measure boundary. Francisco asks if it can be normalised — plausibly yes (move a measure-initial clef to the end of the previous measure as a courtesy), but it interacts directly with the Cluster A recovery logic and should be designed *with* it, not separately.

### Feasibility & disposition

- **Labels + brace + bar.thru standardisation:** **new sub-step under Step 8b** (it already owns "strip movement title from incipit renders" and already requires a regeneration pass — bundle the staff-presentation normalisation into the same pass so incipits regenerate once). Low risk. **Done (2026-06-28, ADR-029):** normalizer Pass 11 (`_normalize_staff_presentation`) braces the leaf grand-staff group, sets `bar.thru="true"`, and strips redundant labels for a single-instrument piano (conservative no-op on multi-instrument scores). A fresh prep showed the defect in exactly 5/54 movements (K332/i, K332/ii, K576/i–iii) and **no labels at all** on the current converter — the "Piano" / "Piano, Piano right" strings were from the older staging ingest. `scripts/staff_audit.py --all` reports 0 warnings across all 54 normalized movements. Incipits regenerate from the normalised MEI at the Band 1 Item 6 re-ingest (no renderer change).
- **Triplets / slurs:** **investigate, likely Phase-2 cosmetic.** Add to the render spot-check list; fix only the cheap, clearly-wrong ones (the 6-measure slur if it's a mis-resolved endpoint). Do not block the campaign.
- **Courtesy clefs:** **design with Cluster A**, defer the courtesy-placement nicety to Phase 2 unless it falls out of the clef-scope fix for free.

---

## Cluster E — Playback caret (Step 19 follow-ups)

Raw items: caret size should use exact system-height + margins, not the per-system element bbox; ignore ornament notes in the time map (they dislocate the caret); "fishy" behaviour at repeat signs — the caret sweeps fast to the end of the system before jumping back to the repeat start.

### Explanation (Confirmed)

All three are confirmed in `frontend/src/components/score/caret.ts`:

1. **Size:** `buildCaretTrack` sets each system's height from `sysEl.getBoundingClientRect()` where `sysEl = el.closest('g.system')` (L196–220); `height = s.bottom - s.top` is the SVG bounding box of the whole system group, which **expands with ledger lines, slurs, dynamics, and the trio's section label** — exactly "depending on actual elements on each system." Francisco's fix is right: derive height from the staff extents (top of the top staff to bottom of the bottom staff) plus fixed margins, uniform per system. This also explains "caret absurdly high until m. 19" in K331/ii (Cluster C) — the trio header inflates the early systems' bbox.
2. **Ornaments dislocate the caret:** anchors are one-per-schedule-entry, and the schedule is the Verovio timemap, which includes ornament/grace onsets. These crowd extra anchors at near-zero spacing, so the caret lurches. Filtering grace/ornament note ids out of the anchor set (or the schedule) fixes it — **confirmed mechanism, feasible**, the cost is mapping note ids → grace status from the MEI/timemap.
3. **Repeat-seam sweep is a precedence bug, confirmed.** `resolveCaret` checks the **system-break** branch (`b.system !== a.system`) at L146 *before* the **backward-x repeat-seam** branch (`b.x < a.x`) at L151. The documented intent (`playback-coordinates.md` §"Interpolation") is that a backward jump *holds*; but when the repeat return also crosses a system boundary (the `|:` is on an earlier system than the `:|`), the system-break branch wins and sweeps the caret to `aSys.rightEdge` before jumping back — precisely "interpolates a fast movement up to the end of the system before going back." The fix is to test the backward-x case first (or detect a backward repeat jump independent of system). Clean, low-risk, and it should ship with a caret.test.ts case for the system-break-and-backward combination, which the current suite misses.

### Feasibility & disposition

All three are **bounded refinements to Step 19**, no architectural change. **Reopen Step 19** as a short follow-up; the repeat-seam precedence fix is the highest-value and smallest.

---

## Cluster F — Playback (audio/transport)

Raw items: spacebar to play (collisions?); ornament rhythmic value (too slow at the main note's value, too fast when the main note is short); Stop/pause should send a global note-off (hanging notes); scroll-follow the caret (with the "fighting the score" risk); a simple playback-speed control; the first note/chord sometimes not heard when playing from position.

### Explanation & feasibility

- **Global note-off on stop/pause — Confirmed gap.** `useMidiPlayback.stop()` and `pause()` call `transport.stop()/cancel()` but never release the sampler (no `samplerRef.current.releaseAll()`). Notes fired with `triggerAttackRelease` keep their scheduled release, so a sounding voice rings out after Stop. Harmless on a fast-decaying piano (as Francisco notes), but a real hang on a sustained instrument. **Fix:** call `samplerRef.current?.releaseAll()` in both `stop()` and `pause()`. Small, confirmed.
- **First note not heard from position — Grounded hypothesis.** In `play()` (L429–441), windowed/origin playback shifts notes by `-startSec` and schedules at transport time 0, then calls `transport.start()` immediately (L450). A note at exactly t=0 races the audio-context start and can be dropped by Tone.js. **Fix candidates:** start with a small lookahead (`transport.start("+0.02")`) or offset the schedule by a few ms. Needs a quick repro to confirm, but the race is the textbook cause.
- **Spacebar — Open question, feasible with guards.** No keyboard play binding exists today (no `keydown` handler in the score views). It's addable, but must ignore events when focus is in an input/textarea/contenteditable and not collide with tag-mode gestures; in the fragment viewer it's unambiguous. **Investigate + design the guard set.**
- **Playback speed — Grounded caveat.** `transport.bpm` is set from the MIDI header. A speed control would scale bpm, **but** the caret/highlight schedule is in absolute ms from Verovio's tempo and the caret clock is `transport.seconds*1000`; scaling bpm alone desyncs the caret. A correct control must scale the schedule clock too (or scale `onPositionUpdate`). Feasible for "debugging," but not free. **Investigate; likely Phase-2** unless a debug-only control is wanted now.
- **Scroll-follow — feasible, design-gated.** `scrollIntoView` on the caret's system is easy; the "fighting the score" risk Francisco names is real and needs user-scroll detection (suspend auto-follow for N seconds after a manual scroll). **Design note, Phase-2-leaning.**
- **Ornament rhythmic value — Open question.** Ornament/grace MIDI duration is Verovio's realisation, with little app-side control; the symptom (too slow / too fast relative to the main note) is Verovio's grace-note timing model. Tied to the caret ornament-filtering work (Cluster E). **Investigate; expect limited control → document the limitation.**

### Disposition

Note-off and first-note are **fix-now under Step 18/20** (they're defects in the shipped playback layer). The rest are **investigate / Phase-2**, except the note-off which should not wait — hanging notes will annoy reviewers during the campaign.

---

## Cluster G — Tagging (display & interaction)

Raw items: stages should always be ordered (per position) in any list view; the beat-resolution "when the fragment ends" is confusing — (a) end is exclusive (a half-note from beat 1 of 4/4 "ends on beat 3", but a musician says beat 2), and (b) decimals are unmusical (beat 2.667 should read "2 2/3"); tactile/touch tagging is currently impossible.

### Explanation & feasibility

- **Fractional beats & end-exclusive display — Confirmed, belongs to Step 15.** The decimals come straight from the ADR-005 float encoding (`beat = beat_number + subbeat/subdivisions`, so 2 + 2/3 = 2.667). Step 15 already owns "fix the measure/beat display rule." Extend its scope to: (a) render fractional beats as musical fractions (2 2/3, 1 ½) rather than decimals, and (b) decide the inclusive-vs-exclusive end convention. Both are display-only over data that's already correct. (b) is a small **musical-semantics decision** — recommendation: show the musician-inclusive last sounding beat, not the exclusive boundary. **Route to Step 15.**
- **Stage ordering — Grounded hypothesis, needs surface check.** `StageList` already sorts by the CONTAINS-edge `order` (`StageList.tsx` L83). "Ordered in *any* list view" implies a *different* surface (review queue, fragment detail) renders stages unsorted or by insertion order. **Verify which component**, then apply the same position sort. Small once located.
- **Tactile tagging — Open question.** The annotator is mouse/pointer-event driven (`annotator.ts`); touch support (tap-to-select, drag handles with touch) is a real feature, not a tweak. **Investigate feasibility; Phase-2** unless scoped down.

### Disposition

Fractional/inclusive beats → **Step 15**. Stage ordering → **small fix after surface check** (could ride with Part 1's stage work). Tactile → **Phase-2 investigation**.

---

## Cluster H — Sidebar harmony scope

Raw item: the harmony labels in the sidebar should show "only within the fragment," but appear to show whole measures.

### Explanation (Grounded hypothesis)

Harmony events are fetched per movement and filtered by measure range; the events endpoint is keyed on `(mc, mn, volta, beat)` (`analysisApi.ts` schema). A beat-precise fragment whose boundaries fall mid-measure will still pull every event in the boundary measures, because the slice is by measure, not by beat — so the boundary measures' out-of-range chords appear. The ghost/selection layer *does* apply beat filtering (`annotator.ts` L896–898 clips by `beatFloat` against `beatStart`/`beatEnd`); the harmony panel does not appear to apply the same clip. **Grounded hypothesis** — confirm which component renders the panel list and whether it receives the beat bounds. **Disposition:** fold into **Step 21/23** (harmony display), apply the same beat clip the ghost layer uses.

---

## Cluster I — Login & nav

Raw items: "Token has expired" is not translated; when logged out there is no "Login" button (only "account").

### Explanation & disposition (Confirmed direction)

Both are already in-scope but incompletely delivered. The login entry point is **Step 12** (nav redesign explicitly includes "a login button wired to the existing `/login` view") — the logged-out state needs the button, not just "account." The untranslated string is a **Part 7 / Step 25** gap (a hardcoded or un-extracted string); the i18n extraction pass should catch it, and it's a good test that the extraction is complete. **Route: login button → Step 12; "Token has expired" → Step 25** (add to the extraction checklist).

---

## Cluster J — Corpus browser duplicate names

Raw items: composer shows "Wolfgang Amadeus Mozart" and (all-caps) "Mozart, Wolfgang Amadeus" — a duplicate; the work shows "Piano Sonata No. 1 in C major, K. 279" and then (all-caps) "K. 279" — catalogue shown twice.

### Explanation (Confirmed)

- **Composer duplicate:** two name fields rendered in two places. `CorpusBrowser.tsx` L96 shows `c.sort_name` ("Mozart, Wolfgang Amadeus", CSS-uppercased); `BrowseAccordion.tsx` L101 shows `c.name` ("Wolfgang Amadeus Mozart"). Both are correct data, shown together. **Fix:** pick one per surface (display name in headings, sort name only where sorting context matters), or show sort name only on hover/secondary.
- **Catalogue duplicate:** `CorpusBrowser.tsx` L154 renders `w.title` (which already contains "K. 279") and L156–162 renders `w.catalogue_number` ("K. 279") as a separate line. **Fix:** when `catalogue_number` is present and the title ends with it, strip the trailing catalogue from the displayed title (a conditional display transform — no data change). Francisco already diagnosed this exactly; it's a one-line display helper.

### Disposition

Both → **Step 13** (corpus browser), as display-only fixes. Confirmed and cheap.

---

## Source-errata policy (Decision 1, detailed)

**Resolved with Francisco (2026-06-24): adopt a versioned corrections overlay; ratify as an ADR (proposed ADR-027) before the first correction lands.** This section expands the recommendation and answers the upstream-PR question Francisco raised.

### What the overlay is

A **corrections overlay** is a data file (not code) — one entry per known source error — applied by a dedicated normalizer pass *after* conversion and *before* the correctness passes that depend on the data being right. Each entry is a structured record, not a free-text note:

| Field | Purpose |
|---|---|
| `target` | A stable locator for the affected element — preferably the MEI `xml:id`, with `(mc, staff, layer, beat, pname, oct)` as a human-readable fallback. |
| `field` | What is being corrected (`accid`, `accid.ges`, `repeat-start`, `tie`, …). |
| `expected` | The **current wrong value** in the source (the pre-state). Load-bearing — see merge-back below. |
| `corrected` | The value to write. |
| `rationale` | Why this is an error, with the **reference edition** cited (e.g. "NMA / Henle has an explicit flat; DCML/MuseScore omits it"). |
| `class` | `errata` (objective error vs. a reference edition) **or** `editorial` (a defensible variant we prefer). Only `errata` is PR-worthy upstream. |
| `upstream` | Status: `none` / `submitted` (+ PR URL) / `merged` / `superseded`. |
| `source_sha` | The DCML source git SHA the entry was authored against (the prep script already records this via `get_git_sha`). |
| `added` | Date + author. |

### Why an overlay rather than silent edits

It satisfies the project's existing invariants instead of fighting them. ADR-014 (original-MEI retention) stays intact — the original and the DCML source are never mutated; the correction is a transparent, reviewable, reversible layer. It is **idempotent and auditable**: the normalizer report lists every applied correction, so a reviewer sees exactly what differs from the source and why. And because it is *data*, growing the list of corrections never touches normalizer logic — the same reason the seed YAMLs are data, not code.

A licensing flag, not a blocker: whether we may redistribute *corrected MEI* (vs. only the correction list as our own derived, attributed data) must be checked against **ADR-009 (DCML licensing constraint)** when ADR-027 is written. The correction list itself — locations + rationale + citations — is our own authorship and is unproblematic to keep and to share upstream.

### The upstream-PR dynamic (Francisco's question)

The overlay is, by construction, **exactly the dataset you would file upstream**: every `class: errata` entry is a precise, located, reference-cited error report against the DCML `mozart_piano_sonatas` repo. So the overlay does double duty — it is both our local fix mechanism *and* a ready-made upstream-contribution queue. Documenting errata in this structured form is therefore strictly more useful than patching quietly: it converts a private workaround into a shareable correction, and the `rationale` + reference citation is most of the PR body already written.

This is a real benefit and worth doing deliberately: filtering on `class: errata` produces the PR backlog; `class: editorial` entries stay local (they are our preference, not an objective fix, and should not be pushed onto the source).

### How merge-back is handled (what to do if upstream merges)

The risk Francisco names — upstream merges our correction, then on the next re-ingest our overlay double-corrects or conflicts — is neutralised by the `expected` (pre-state) field. The correction pass acts **only when it sees the expected wrong value**:

1. **Element already holds `corrected`** (upstream fixed it, our way) → **no-op**, logged as `superseded — upstream resolved`. No double-correction is even possible, because the pass never fires when the value is already right.
2. **Element still holds `expected`** → apply the correction as before.
3. **Element holds neither** (upstream fixed it *differently* — e.g. a different enharmonic spelling — or the location drifted) → **skip + warn** (`pre-state mismatch — needs review`). A human decides whether to retire the entry (upstream's fix is acceptable) or update it.

The retirement workflow then is simply: when an entry logs `superseded`, confirm against the re-ingest, set `upstream: merged`, bump `source_sha`, and move the entry from the active overlay to a `corrections-changelog`. The overlay stays minimal and the source-of-truth drift is always visible. Pinning `source_sha` per entry means an upstream version bump automatically re-validates the whole overlay through the pre-state checks above — no separate audit needed.

**Net:** documenting source errors this way is not just compatible with sending upstream PRs, it is the mechanism that makes them cheap; and the pre-state check makes "upstream merged it" a safe, self-retiring no-op rather than a conflict. (C2's missing trio start-repeat is the first `errata` candidate; B3's accidental errata are the next.)

### Decisions 2–4 (resolved 2026-06-24, per Francisco)

2. **Accidental completion pass (B1) — agreed.** The normalizer will *add* `accid.ges` for staff-scoped, same-octave carry so MIDI honours Classical convention, rather than relying on Verovio. **Gate:** confirm live Verovio MIDI behaviour on the re-ingested files first (Step 7b investigation) — if Verovio already staff-scopes in our pinned build, the pass narrows or drops.
3. **"Part 2 reopened" block before Step 10 — agreed.** Clusters A, B, and D1 change the normalizer and run as a reopened-Part-2 block; **Step 10 (full ingest) slips behind them.** Ingesting now and re-ingesting later is the mc-drift risk the plan exists to avoid.
4. **Beat-end display (G1) — agreed.** Show the musician-inclusive last sounding beat (not the exclusive boundary), and render fractional beats as fractions (2 2/3), not decimals.

---

## Issue tracking (by family)

One row per concrete symptom, with its score locations, so each can be re-checked on staging after a fix and marked off. **Status legend:** `☐ open` · `◐ in progress` · `☑ fixed (unverified on staging)` · `✔ verified on staging`. Confidence: **C** = confirmed in code/data · **H** = grounded hypothesis (needs one confirmation pass) · **?** = open question (investigate first).

The **sequencing/interlock** for these around the Component 9 Steps — in particular what must happen before vs. after Step 10 — lives in its own document: `docs/roadmap/component-9-staging-readthrough-plan.md`.

### A — Clefs (reopen Step 6; gate before Step 10)

> **2026-07-05 — A-cluster closed corpus-wide (ADR-031 amendment).** Preparing
> the remaining 39 movements surfaced 10 further A1b occurrences (K309/ii m77,
> K310/ii m70, K333/iii m7/47/118, K570/ii m12, K570/iii m56, K283/iii
> m56/m227, K331/i mX1). A root-cause investigation of all 15 known
> occurrences (traces + Verovio probes; see
> `docs/investigations/accidentals-k279-mvt1/clefs-findings.md` § 2026-07-05)
> found the whole family reduces to one pattern — the converter scatters a
> single staff-level clef change across voices, and our own `sameas`
> resolution + per-voice trailing injections turned the copies into drawn
> doubles. Pass 10 now keeps restatements **silent** (unresolved `sameas`
> positions without drawing — probed), courtesy groups keep one bar-end copy,
> the recovery injects a single trailing courtesy (leading after repeat
> barlines, per NMA), and a `CLEF_SAMEAS_DANGLING` invariant guards the
> original Step-6 missing-clef direction. `clef_audit` across **all 54
> movements: 0 clef warnings**; render pass over all 19 spots (15 doubles +
> K279/i m5/m9/m91 recovery + K533/iii m118) published for review.

| ID | Symptom & score locations | Conf. | Fix target | Status |
|---|---|---|---|---|
| A1 | Double/extra clefs — all are **mid-measure clef changes in a two-voice region** (2026-06-30, corrected): (a) **per-voice scatter** (spurious clef in a noteless layer · `sameas` restated · two layers' clefs at different onsets · clef nested in a beam): 283/ii m.19, m.25 · 332/iii m.210 · 279/i m.86 · 279/iii m.72; (b) **multi-section collision** (trio clefs lost/mis-placed by the importer): 331/ii · 331/i m.98 | C | (a) **Phase A — Pass 10 reconciliation** (drop noteless-layer/`sameas` duplicates + onset-align, beam-aware, invisible-`<space>` split); (b) **Phase B (B2)** | ◐ **(a) FIXED in Pass 10** — render-verified one glyph on all 5 (283/ii m19/m25, 279/i m86, 279/iii m72, 332/iii m210; ADR-031). **Verified LIVE on the 2026-07-01 re-ingest** (13 clef drops + 4 onset-aligns; stored MEI shows one glyph per bar; all 15 mc-STABLE; 15 incipits + 15 analyses regenerated). **Refinement (2026-07-01):** the surviving glyph is now pulled to the **earliest** (musically-correct) onset, so 279/i m86 sits on beat 3 and its `f4` is re-clefed under G (Francisco caught the glyph a 16th late); beam-nested clefs are hoisted. Idempotent, 732 tests pass. **m86 refinement verified LIVE at the 2026-07-01 final re-ingest** (5 onset-aligns + 13 drops; m86 glyph now at beat 3; all 15 mc-STABLE). **Measure-start recovery→trailing/D3 DONE (2026-07-01; see D3 row). (b) multi-section collision DONE — Phase B / ADR-032 (2026-07-01, see A3 row): the importer now emits the Trio's clefs correctly, so the stray Menuetto clefs vanish and the Trio's ~16 return; render-verified one glyph per bar, all 15 mc-STABLE.** |
| A2 | Clef affects voice 1 only; voice 2 in old (F) clef — 279/iii m.110 · 280/i m.46 · 280/ii m.24 · 331/ii m.24–25 | C | Step 6 — **revisit in Phase A**: "inject into every layer" is a latent double-generator; converge to single-glyph + all-voices | ✔ verified on staging (2026-06-30) — **revisit with A1 Phase A** |
| A3 | Trio clef changes absent — 331/ii Trio (none in Doppia; ~16 expected) | C | **Phase B (B2)** — unique-number import restores all trio clefs (validated offline: 14 → 23) | ✔ **DONE — verified LIVE (2026-07-01, ADR-032).** `renumber_mxl_for_import` renumbers the `.mxl` uniquely before import (only K331/ii triggers it across all 15/54 movements), `restore_measure_numbers` puts the restarting `@n` back. Stored K331/ii MEI now carries all **22** `.mscx` clefs (6 Menuetto + **16 Trio**); render check: **0 missing, 0 doubled** — every Trio clef present at its correct document-order measure (mc 52,54,56…). Recovery is a clean no-op here now (the importer emits them). |

> **⚠ SUPERSEDED (2026-06-30):** the claim below that A1–A3 were fixed on 2026-06-28 is wrong — see the re-verification section above. A1 is mid-measure two-voice scatter (→ Phase A); A3 + the 331 collision are a Verovio-importer measure-number bug (→ Phase B / B2, validated offline). The 2026-06-28 note is retained only for history.
>
> **A1–A3 "fixed" (2026-06-28, superseded)** in `recover_measure_start_clefs` (`scripts/prepare_dcml_corpus.py`): widened idempotency guard (equivalent clef anywhere in the layer, not just first-child), per-voice injection into every `<layer>`, and section-aware `.mscx`↔MEI index with a diagnostic-logged fallback. Unit-covered in `test_prepare_dcml_corpus.py` (`TestClefRecovery*`). On-staging re-verification against the real K331/ii source is Band 1 Item 6; the render spot-check list to use is in `docs/investigations/accidentals-k279-mvt1/clefs-findings.md`. (Note: the A1 `sameas`-convergence sub-point — making Pass 10 collapse per-voice restatements rather than render two glyphs — was not in scope here; the double-clef cases observed trace to the recovery guard, and Pass 10 `_resolve_clef_sameas` already only resolves references without duplicating. Revisit only if a `sameas`-sourced double survives re-verification.)

### B — Accidentals in playback (new Step 7b; gate before Step 10)

| ID | Symptom & score locations | Conf. | Fix target | Status |
|---|---|---|---|---|
| B1 | Cross-voice accidental not realised in MIDI — 279/ii m.51–52 · 283/ii m.17 · 331/ii m.25 ff., m.29 · 332/ii m.9–10, 13–14 | H | Step 7b — gestural-accidental resolution pass | ✔ **verified on staging** (ADR-028; 2026-06-30) |
| B2 | Cross-octave / backward accidental — 279/ii m.67, m.70 · 280/ii m.30, m.58 · 283/ii m.22 · 283/i m.49 | ? → resolved | Step 7b — same pass (add + onset-aware strip) | ✔ **verified on staging** (ADR-028; 2026-06-30) |
| B3 | Source accidental errata — 332/ii m.24 · 279/ii m.51–52 (cautionary flat) · ~~332/iii m.22, 27, 232, 237~~ (reclassified B2) | C (errata) | Corrections overlay (ADR-027) | ✔ **verified on staging** (overlay; 2026-06-30) |

> **B1–B2 traced & classified (2026-06-28)** — see `docs/investigations/accidentals-k279-mvt1/accidentals-playback-findings.md`. The engine question is settled: **Verovio realises each note's MIDI pitch from its own encoded `accid`/`accid.ges` only** — it does not staff-scope, run within a layer, or re-derive the key signature at render time. So every Cluster B symptom is a converter `accid.ges` error, in two directions: (1) a **missing** gestural accidental — cross-octave/cross-staff suppression of a key-sig alteration by an explicit natural elsewhere, and cross-voice carries that never reach the second voice (279/ii 51/52/67, 280/ii 30·58, 283/i 49, 283/ii 22, 331/ii 25ff, 332/ii 9–14, **332/iii 22/27/232/237** — these last were B3, but the B♭ is diatonic and merely suppressed, so they are B2); (2) a **spurious** gestural accidental propagated **backward** in onset order across voices (279/ii m70, 280/ii m30 treble). Fix landed: Pass 9 rewritten as `_resolve_gestural_accidentals` (ADR-028) — a **staff+octave-scoped, section-aware, onset-ordered** gestural-accidental *resolution* that sets/overrides/removes `accid.ges` and prints nothing, subsuming the ADR-022 strip-only behaviour. The design question was resolved as **full resolution** (override present-but-wrong, not add-only). Verified: 81 normalizer unit tests pass; `scripts/accidental_trace.py` reports 0 mismatches on all seven normalized movements (27 on the raw pre-resolver output) with a Verovio MIDI cross-check. True B3 errata remaining: 332/ii m24 and the 279/ii m51–52 cautionary flat → overlay. K331/ii confirmed the pass must be per-section key-sig aware (3♯ Menuetto → 2♯ Trio) — handled by reusing ADR-022's `_build_measure_key_sigs`.

> **Overlay locator moved to COORDINATES (2026-07-01, ADR-027/030 amendments).** The 2026-07-01 re-ingest found all three entries logging `CORRECTION_TARGET_MISSING`: Verovio's `xmlIdChecksum` ids are deterministic run-to-run but were reassigned across the authoring→re-ingest toolchain gap, so the pinned ids silently stopped resolving. Pass 0 now locates targets by `mc` (+ `staff/layer/pname/oct/occurrence` for notes) — invariant under a re-encode. The 3 entries were re-authored as coordinates and **verified LIVE at the 2026-07-01 final re-ingest** — all three applied with **zero `CORRECTION_*` warnings**; stored MEI shows mc65 `@left=rptstart`, K332/ii mc24 C5 order `[None, s, n, None]` (3rd → natural, carried to the last), K279/ii mc53 LH B4 `[f, None, None]`.
>
> **Phase B / B2 built & verified LIVE (2026-07-01, ADR-032)** — `scripts/prepare_dcml_corpus.py` gains a renumber-for-import step between `convert_mscx_to_mxl` and `convert_mxl_to_mei`: `renumber_mxl_for_import` unzips the `.mxl`, rewrites every `<measure number>` to a unique 1..N document-order value (a no-op unless the movement restarts its numbering — only **K331/ii** triggers across all 54 sonata movements), then `restore_measure_numbers` remaps the resulting MEI's `@n` back to the true restarting sequence by document-order position (1:1, length-checked). `clef_audit` runs the same step so its report reflects the ingested state. **All five ADR-032 gates pass on the fresh prep + live re-ingest:** (1) all **22** K331/ii clefs return at the right document-order measures (6 Menuetto + 16 Trio; render check 0 missing / 0 doubled; recovery a clean no-op); (2) **mc-STABLE** — 8 prior-stored movements incl. K331/ii (101 measures) fingerprint-identical, no drift; (3) repeat structure coherent — Trio `rptend@64 ↔ rptstart@65 ↔ rptend@100`, warning set unchanged from D3; (4) restored `@n` still raises `MEASURE_N_MULTI_SECTION_DUPLICATE` (runs [48, 51]) per the Step-8 disposition; (5) K331/ii incipit slurs bounded (7 slurs, none wider than the viewport). Unit coverage: `TestRenumberMusicxml` / `TestRenumberMxlForImport` / `TestRestoreMeasureNumbers` in `test_prepare_dcml_corpus.py`; 741 backend unit tests pass; black/isort/ruff clean.
>
> **B3 + C2 errata authored (2026-06-29, ADR-027 first entries; ADR-030)** — `backend/seed/corrections/mozart__piano-sonatas.yaml`. Three entries, originally located by deterministic xml:id (ADR-030 enabled Verovio `xmlIdChecksum` in corpus-prep — see the locator note above for why this was superseded). All cite the NMA (which the DCML corpus follows). **C2** — K331/ii Trio second-strain start-repeat (mc65, `e65xqli`): `repeat-start` null→`rptstart`. Only the *second* strain is an erratum; the Trio's first measure legitimately has no `|:` (a new section, implicit opening repeat) per Francisco. **B3 K332/ii m24** — the beat-4 C5 (`c106gvd1`) prints no accidental in DCML so the beat-2 C♯ carries forward; the NMA prints a natural. `accid` null→`n`; the bar's last C5 then inherits the natural. **B3 K279/ii m51** — first LH B4 (`g1mnbfyc`) cautionary flat the NMA prints and DCML omits: `accid` null→`f`. Both accidental entries are single printed-accidental corrections: Pass 9 now **drops a gestural that contradicts a corrected printed `@accid`** (ADR-028 amendment), so the MIDI follows the print without a paired `accid.ges` entry. Verified end-to-end on a fresh prep: all three fire with no `CORRECTION_*` warnings, and Verovio MIDI plays the corrected pitches (m24 beat-4/last C = natural; m51 LH B = B♭). 104 normalizer + overlay unit tests pass. *Passing on staging is confirmed at Band 1 Item 6.*

### C — Multi-section & coordinate NaNs

| ID | Symptom & score locations | Conf. | Fix target | Status |
|---|---|---|---|---|
| C1 | `NaN` bar number in transport — 279/ii m.28 · 283/ii m.14 (2nd ending) · 331/i m.98; "every similar case + 2nd endings" | C | Step 3 — same mc↔mn guard on the display path | ☑ **DONE (2026-07-01, Band 2).** Root cause found in `verovio.ts` `buildNoteInfoMap` — `parseInt(nAttr)` on an X-prefixed `@n` (ADR-015 volta-ending disposition) is `NaN`, with no fallback (unlike `ghosts.ts`'s `walkMeasureKeys`, which already carries the last finite `@n` forward). Applied the same carry-forward guard. Unit-tested (`verovio.test.ts`). |
| C2 | Trio repeat structure — first repeat jumps to minuet `|:` (m.19); missing start-repeat; da-capo `<i>`; blank space m.40 | C | Overlay (start-repeat, ✔ visual) + **playback likely fixed by Phase B (B2)** — same restarting-`@n` root as the clef collision; verify at B2 + Step 15 (display) | ◐ **repeat structure now coherent (2026-07-01, ADR-032).** With unique-number import the repeat marks land on the right measures: Menuetto `|: mc1-18 :| |: mc19-48 :|`; **Trio `rptend@mc64 ↔ rptstart@mc65 (C2 errata) ↔ rptend@mc100`** — the Trio repeat now closes on the *Trio's* own start-repeat, not the Menuetto's `rptstart@mc19` (the "jumps to minuet" symptom). Warning set unchanged from the D3 ingest (no regression). **Trio "blank space" (the stray extra space around m.40) is GONE** — confirmed on the 2026-07-01 live render, another facet of the duplicate-`@n` import collision resolved by the renumber. **Playback FIXED — ADR-033 (2026-07-01):** root cause was Verovio building the MIDI `<expansion>` at *import* time and pairing each Trio `:|` with the Menuetto's `|:` (mc19), because the source omits the Trio strains' opening `|:` (mc49, mc65). The C2 overlay erratum couldn't fix it (post-import edit can't change the already-frozen expansion). Fix moved pre-import: `repair_section_opening_repeats` supplies both strain-opening `|:` before import, so the expansion is generated correctly (`A A B B C C D(1) D(2) A B`, render-verified). Francisco confirmed in-app the Trio repeats no longer jump to the Menuetto. Both mc49 & mc65 now show `|:` (accepted engraving deviation; the C2 overlay entry is retired). Da-capo `<i>` → Step 15 / multi-section cluster. |

### D — Other rendering

| ID | Symptom & score locations | Conf. | Fix target | Status |
|---|---|---|---|---|
| D1 | Instrument labels vary ("", "Piano", "Piano, Piano right" + "Pno." on later systems); brace; barlines cross system | C | Pass 11 — **also strip `<label>`/`<labelAbbr>` from the leaf `<staffGrp>`** | ◐ **brace/bar.thru fixed; labels NOT** (2026-06-30) — group-level labels survive on K331 all + K332/i,iii; Pass 11 only stripped staffDef/instrDef labels. ADR-029 "no labels" was wrong (audit blind spot). |
| D2 | Tuplet brackets shown though hidden in MuseScore (279/ii m.6, 7, 10); dashed slurs (279/ii); 6-measure slur (332/iii m.190–195); **NEW: 331/ii incipit shows enormous slurs on both staves** | H | Spot-check; mis-resolved/out-of-window slur endpoint; rest → P2 | ◐ **331/ii incipit slurs FIXED — verified LIVE (2026-07-01, ADR-032).** Regenerated K331/ii incipit has 7 slurs, all within the viewport (max slur width 1828 vs 13190 viewBox; **0 wider than viewport**) — the runaway slurs were a facet of the duplicate-`@n` import collision, gone once numbering is unique. Tuplet brackets / dashed slurs / 332/iii 6-measure slur remain open → P2 cosmetic. |
| D3 | Courtesy-clef placement (clef after vs before barline) — 279/i m.5 · 279/iii m.5–11 (cf. correct 279/ii m.10, 47–49) | C | **Phase A** — place measure-start clefs as the trailing courtesy clef of the *previous* measure | ☑ **DONE (2026-07-01, ADR-031):** `recover_measure_start_clefs` now hosts each recovered change as the last child of the previous measure (renders before the barline; synthetic render confirms x < barline), same-section only (a section's opening clef falls back to leading), and a single courtesy covers all next-measure voices via the staff running clef (verified on 279/iii m110). Prep unit tests updated; `clef_audit` gains an A1b cross-layer-double guard. **Verified LIVE (2026-07-01 re-ingest):** all 11 K279/i recovered clefs stored as the last child of the previous measure; all 15 mc-STABLE; 3 corrections still applied (0 warnings); the 5 A1 doubles still one glyph. |

### E — Playback caret (reopen Step 19)

| ID | Symptom | Conf. | Fix target | Status |
|---|---|---|---|---|
| E1 | Caret height from per-system element bbox; use staff extents + fixed margins | C | Step 19 — `buildCaretTrack` height | ☑ **DONE (2026-07-01, Band 2).** `buildCaretTrack` reused the ghost/bracket layer's proven technique (`ghosts.ts` `staffLineBounds`): a new `systemStaffLineBounds` derives each system's top/bottom from the direct `<path>` children of `<g class="staff">` (the staff lines only), excluding slurs/dynamics/ledger-lines/section labels that previously ballooned the raw `g.system` bbox. No added margin — matches the ghost measure box height exactly for pixel alignment. Manual-verification only (jsdom returns zero rects, same as the rest of this geometry layer). |
| E2 | Ornament/grace onsets dislocate the caret | C | Step 19 — filter grace ids from anchors | ☑ **DONE (2026-07-01, Band 2).** New `collectGraceNoteIds(meiText)` in `verovio.ts` (same `dur.ppq===0` convention `ghosts.ts` uses to skip grace notes) returns a `Set` of grace xml:ids; `buildCaretTrack` gained an optional `graceIds` param and skips them when choosing each schedule entry's anchor x — an all-grace entry now contributes no anchor. Wired into both ScoreViewer.tsx and FragmentDetail.tsx (both build their own caret track). Unit-tested (`verovio.test.ts`). |
| E3 | Repeat-seam: sweeps to system right edge before jumping back | C | Step 19 — test backward-x before system-break in `resolveCaret` (+ test) | ☑ **DONE (2026-07-01, Band 2).** `resolveCaret` checked `b.system !== a.system` (sweep to right edge) *before* checking backward-x, so a repeat seam that also crossed a system boundary took the forward-sweep branch instead of holding. Reordered: backward is now checked first, using system order (`b.system < a.system`) for the cross-system case since raw x isn't reliably comparable across systems. Unit-tested (`caret.test.ts`, new describe block). |

### F — Playback (audio/transport)

| ID | Symptom | Conf. | Fix target | Status |
|---|---|---|---|---|
| F1 | No global note-off on stop/pause (hanging notes) | C | **Fix-now** — `releaseAll()` in `stop()`/`pause()` | ☑ **DONE (2026-07-01, Band 2).** `samplerRef.current?.releaseAll()` added to `pause()`, `stop()`, and the fragment-window auto-stop path in `useMidiPlayback.ts` — `transport.stop()`/`.cancel()` only affect future scheduled events, not an already-triggered voice. Unit-tested. |
| F2 | First note/chord missed when playing from position | H | Step 20 — start lookahead / schedule offset (repro first) | ☑ **DONE (2026-07-01, Band 2).** Diagnosed (not just patched): the origin note of a play-from-position (or simply the first note of the piece) is scheduled at transport-relative time exactly 0, and `transport.start()` with no lead time races the Web Audio lookahead clock — the event can be silently dropped. Fixed by starting the transport `+0.05s` in the future (`START_LOOKAHEAD_SEC`) instead of touching any note's scheduled offset, so every relative timing stays exactly correct and only the whole playback shifts later by an imperceptible, uniform amount. Resuming from pause is unaffected (nothing is rescheduled at time 0). Unit-tested. |
| F3 | Spacebar to play (collision guards) | ? | Investigate + guard design | ☐ open |
| F4 | Playback speed control (caret resync caveat) | H | Investigate; likely P2 | ☐ open |
| F5 | Scroll-follow caret (anti-"fighting") | — | Design note; P2-leaning | ☐ open |
| F6 | Ornament MIDI rhythmic value | ? | Investigate; document Verovio limit | ☐ open |

### G — Tagging

| ID | Symptom | Conf. | Fix target | Status |
|---|---|---|---|---|
| G1 | Beat display: decimals (2.667) + exclusive end confusing | C | Step 15 — fractions + inclusive last beat | ☑ **DONE (2026-07-01, Band 2).** `formatBeat` now renders common subdivision fractions as glyphs (2.667 → "2⅔"). End-beat semantics decided with Francisco: a *whole-number* `beat_end` steps back to the last included beat (exclusive bound 3 → "beat 2"), collapsing to a single-beat label when that equals `beatStart`; a *fractional* `beat_end` displays as-is ("beats 1–2½") — contradictory-looking but the phrasing a musician reads naturally. Also handles the multi-measure case where `beat_end=1` means the last measure is *not* covered at all (steps back a full measure, fully covered) and collapses to the bare `mm. N–M` form when both ends reduce to whole measures. `formatBeat` reused in `FragmentDetailPanel`'s harmony-position label too. Unit-tested (`fragmentRange.test.ts`, expanded); downstream `StageList`/`FragmentDetail` fixtures updated for the new semantics. |
| G2 | Stages not always ordered by position in list views | H | Verify surface, then position sort | ☑ **DONE (2026-07-01, Band 2).** Confirmed real: `StageList` sorted by the CONTAINS-edge schema `order`, not physical bar/beat position. Now sorts by `(barStart, beatStart)` with absent (unbounded) stages grouped after positioned ones. Bracket/swatch colour (`stageColor`) decoupled from the (now position-based) iteration index — keyed on `assignment.order` directly in both `StageList.tsx` and `StageBrackets.tsx` — so a stage's colour stays stable as bounds move it around the list. Unit-tested. |
| G3 | Tactile/touch tagging impossible | ? | Investigate; P2 | ☐ open |

### H / I / J — Sidebar, login, browser

| ID | Symptom | Conf. | Fix target | Status |
|---|---|---|---|---|
| H1 | Harmony sidebar shows whole measures, not just the fragment's beat range | H | Step 21/23 — apply the ghost layer's beat clip | ☑ **DONE (2026-07-01, Band 2).** Confirmed: `HarmonyPanel.fetchEvents` sliced by measure (mn) range only, with no beat filtering. Now applies the same clip `annotator.ts`'s `_highlightSelection` uses: drop events before `beatStart` in the first measure, and at/after the exclusive `beatEnd` in the last measure; middle measures unconstrained. |
| I1 | No Login button when logged out (only "account") | C | Step 12 | ☑ **DONE (2026-07-01, Band 2) — root cause was different than filed.** `NavBar.tsx` already had the login-link branch (landed with Step 12). The real bug: `services/auth.ts` `getSession()` never checks token expiry — any non-empty localStorage token reads as authenticated, so an expired session still shows the account badge, never Login. Fixed at the source (see I2): a 401 now clears the stored token, so the next NavBar render correctly falls through to the login link. |
| I2 | "Token has expired" untranslated | C | Step 25 — add to extraction checklist | ☑ **DONE (2026-07-01, Band 2) — same root cause as I1.** The backend's `INVALID_TOKEN` messages (`auth.py`) are raw English strings by design (several distinct causes, e.g. "Token has expired.", "Token is invalid…") — never meant for verbatim display. `apiFetch` (`services/api.ts`) now special-cases `code === 'INVALID_TOKEN'`: clears the stored token and substitutes a translated `auth:sessionExpired` string (en/es) before throwing, so every one of the 7 call sites that render `ApiError.message` gets a localized message with no per-site changes. |
| J1 | Composer name shown twice (`name` vs `sort_name`) | C | Step 13 — one field per surface | ☑ **DONE (2026-07-01, Band 2).** `CorpusBrowser.tsx`'s Composers column showed both `c.name` and `c.sort_name` stacked — `sort_name` is the lexicographic sort key ("Mozart, Wolfgang Amadeus"), not a distinct display fact. Removed the secondary line; `name` only. (`BrowseAccordion.tsx`'s mobile equivalent already only showed `name` — no fix needed there.) |
| J2 | Catalogue shown twice (in title + as field) | C | Step 13 — strip trailing catalogue from title | ☑ **DONE (2026-07-01, Band 2).** Root cause: DCML corpus-prep titles already embed the catalogue number ("Piano Sonata No. 11 in A major, K. 331"), and every surface *also* rendered `catalogue_number` as its own field/badge — literal duplication (worst case, `FragmentBrowser`'s card, concatenated the two into one string: "…, K. 331 K. 331"). New shared `utils/workTitle.ts` `stripEmbeddedCatalogue()` strips a trailing `, {catalogue}`/` {catalogue}` from the title before display. Applied across every surface with the bug: `CorpusBrowser` (desktop + `BrowseAccordion` mobile), `FragmentBrowser` card, `FragmentDetail` header line, `ReviewQueue` list label. Unit-tested (`workTitle.test.ts`). |
