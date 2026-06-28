# Accidentals-in-playback Investigation — multi-movement (Component 9 · Band 1 Item 3 · B1–B3)

**Date:** 2026-06-28
**Status:** Root-caused and classified; full-resolution fix decided (ADR-028), not yet implemented
**Scope:** the Cluster B bars from
`docs/reports/component-9-reports/staging-readthrough-issues.md` — K279/ii,
K280/ii, K283/i, K283/ii, K331/ii, K332/ii, K332/iii.

Sibling of the `accid`/clef/tie investigations in this folder. The earlier
accidentals work (ADR-021/022) *stripped* spurious gestural accidentals the
converter added. This investigation is the inverse and broader symptom: an
accidental that **should** sound is **not** realised in MIDI (and, in two bars,
one that should **not** sound still is). Same methodology, more movements.

## Symptom

The SVG render is correct, but MIDI plays the wrong pitch. Francisco grouped the
bars into cross-voice, cross-octave/"backward", and source-errata buckets and
(rightly) asked which are engine bugs and which are bad source data. This
investigation answers that per bar with a fresh prep→normalize→MIDI trace.

## Method

`prepare_dcml_corpus` (`.mscx → .mxl → .mei → recover_measure_start_clefs`) plus
the ingest normalizer were run on each cited movement (the current pipeline —
i.e. what re-ingestion would produce). For every note in the cited measures we
recorded a three-way trace:

- **notated** `@accid` and **gestural** `accid.ges` from the MEI,
- the **realised MIDI pitch** and **onset** via
  `verovio.toolkit().getMIDIValuesForElement(xml:id)` (Verovio 6.1.0),
- the **expected** staff+octave-scoped alteration under Classical convention:
  key signature, overridden by the most-recent *explicitly notated* accidental
  on the exact `(pname, octave)` earlier in the measure, **across all voices of
  the staff**, in onset order.

A note is flagged when **realised ≠ expected**. The probe scripts live in the
session scratchpad; a polished, section-aware tool should be promoted alongside
the fix (see "Tooling", below).

## The engine model (the load-bearing finding)

Established directly against Verovio 6.1.0 with synthetic MEI, and confirmed by
decoding the rendered MIDI byte stream (it matches `getMIDIValuesForElement`):

> **Verovio realises each note's MIDI pitch from that note's own encoded
> `accid` / `accid.ges` only. It does not apply running-accidental inference at
> render time — not within a layer, not across layers, not across octaves — and
> it does not re-derive the key-signature alteration for a note that carries no
> `accid.ges`.**

Consequences, all verified:

- A second-voice note bound only by the *other* voice's accidental sounds
  **natural** — Verovio does **not** staff-scope. (This is the gate question the
  plan posed for B1: *it does not staff-scope*, so the completion pass is needed
  and will work.)
- A bare note (no `accid.ges`, no `@accid`) in a sharp/flat key sounds at its
  **natural** pitch. Real converted MEI normally sounds right only because the
  MusicXML→MEI converter writes `accid.ges` onto **every** affected note,
  including key-signature and within-voice carries.
- Therefore **every** Cluster B symptom is a case where the converter wrote the
  **wrong set** of `accid.ges` — too few (suppression / cross-voice) or too many
  (backward bleed). Verovio is faithful throughout; the defect is in the data.

## Per-bar classification

Onsets confirm direction (carry-forward vs backward); key signatures are read
**per section** (see the K331/ii correction below).

### Add a missing `accid.ges` — suppression & cross-voice (the dominant class)

| Movement | Bars | Heard → correct | Mechanism |
|---|---|---|---|
| K279/ii (F, 1♭) | 51, 52, 67 | B♮ → **B♭** | explicit B♮ in another octave (m51 another *staff*) suppressed the key-sig flat on the B an octave below |
| K280/ii (f, 4♭) | 30 (bass B3), 58 | B♮/E♮ → **B♭/E♭** | same cross-octave key-sig-flat suppression |
| K283/i (G, 1♯) | 49 | C♮ → **C♯** | explicit C♯ in one voice not carried to same-octave C in the other voice |
| K283/ii (C, 0) | 22 | D♮ → **D♯** | within-staff forward carry of an explicit D♯ dropped on a later same-pitch note |
| K331/ii Trio (D, 2♯) | 25 ff. | C♯ → **C♮** | explicit C♮ in one voice not propagated to the key-default C♯ sounding simultaneously in the other voice |
| K332/ii (B♭, 2♭) | 9, 10, 13, 14 | E♭ → **E♮** | explicit E♮ in one voice not propagated; the same-octave other-voice E keeps the key-sig flat |
| K332/iii (F, 1♭) | 22, 27, 232, 237 | B♮ → **B♭** | cross-octave key-sig-flat suppression (these were tentatively filed as B3 errata — they are not; the B♭ is diatonic, merely suppressed) |

Note the alteration can point either way: K331/ii and K332/ii are cases where the
*correct* value is a **natural** overriding a key-signature sharp/flat in another
voice. The fix is identical — recompute the staff+octave-scoped expectation and
write the matching `accid.ges` (here `accid.ges="n"`).

### Strip a spurious `accid.ges` — backward bleed

| Movement | Bars | Heard → correct | Mechanism |
|---|---|---|---|
| K279/ii | 70 | G♯ → **G♮** | a g4 at beat 1 (onset earlier) carries `accid.ges="s"` propagated **backward** from a notated G♯ later in the bar, in the other voice |
| K280/ii | 30 (treble g5) | G♭ → **G♮** | first g5 carries `accid.ges="f"` from a notated G♭ that appears *after* it |

Pass 9 already targets exactly this (an `accid.ges` not explained by key sig, a
*prior* explicit accidental, or a tie) but misses these two because it walks
**document order** — and with interleaved voices, L1's later-onset G♯ precedes
L2's earlier-onset g4 in document order, so it is wrongly treated as a prior
explaining accidental. The strip needs to reason in **onset order**.

### Source errata — data wrong independently of the engine (overlay, B3)

| Movement | Bars | Note |
|---|---|---|
| K332/ii | 24 | **Not flagged** — sounds exactly as encoded; the encoded accidental itself is editorially wrong. Pure B3. |
| K279/ii | 51–52 | Playback is fixed by the completion pass (B♭ restored). Whether to also add a *cautionary printed* flat (the original edition shows one; MuseScore omits it) is an editorial/B3 question, not a playback bug. |

## Root cause

A single mechanism with two faces, both in the MuseScore→MEI conversion (not the
DCML source, not Verovio, not the existing normalizer passes):

1. **Octave/voice over-reach of an explicit *natural*.** When a measure contains
   an explicit natural (or any accidental) on a pitch, the converter sometimes
   drops the key-signature `accid.ges` on the **same pitch class in another
   octave or voice**, naturalising a note that should keep its diatonic
   alteration. → the *add-missing* class.
2. **Backward/cross-voice over-reach of an explicit *accidental*.** A notated
   accidental is propagated as `accid.ges` onto a same-pitch note **earlier in
   time** (a different interleaved voice). → the *strip-spurious* class.

Both violate the convention that an accidental binds **same pitch name, same
octave, the whole staff, for the rest of the measure, forward only**.

## Recommended fix (design — for approval before implementing)

Extend the accidental normalization (ADR-022 lineage, Pass 9) into a
**staff+octave-scoped gestural-accidental *resolution*** that, per
`(staff, measure)`:

- computes each note's correct alteration from the **per-section** key signature
  overridden by the most-recent explicitly notated accidental on the exact
  `(pname, octave)` earlier **in onset order across all voices**, tie-aware;
- **sets/ corrects `accid.ges`** to match — which both *adds* the missing
  gestural accidental (fixing every suppression and cross-voice case) and
  *strips/overrides* a spurious one (fixing the backward bleeds), printing
  nothing (`@accid` untouched, so SVG is unchanged).

This subsumes Pass 9's current strip-only behaviour symmetrically. Two
properties are mandatory and are both lessons already paid for elsewhere in
Component 9:

- **Section/key-change awareness.** K331/ii proved it: the movement carries three
  key signatures (3♯ Menuetto → 2♯ Trio → 3♯) over five sections; resolving trio
  measures against the Menuetto key invents false sharps. Mirror the clef A3
  section-aware indexing.
- **Onset ordering, not document order.** Required to get cross-voice and
  backward cases right; the normalizer is presently pure-lxml/document-order, so
  this needs per-layer beat positions computed from `@dur` (no Verovio
  dependency in the normalizer).

**Design question — resolved (2026-06-28): full resolution.** The pass
*overrides* a present-but-wrong `accid.ges` (and removes spurious ones), not
add-only — strictly faithful to the notation, fixing the backward bleeds in the
same pass. Recorded in **ADR-028** (supersedes ADR-022).

Two implementation facts, confirmed while reading the normalizer:

- **The section-aware key index already exists.** ADR-022's
  `_build_measure_key_sigs` is per-section, per-staff, per-measure (it solved the
  K331-mvt3 mid-piece key change). The resolver reuses it; only the *scratchpad
  probe* lacked section awareness (the source of the K331/ii false positives).
- **Onsets come from `@dur.ppq`.** Every converted note carries `@dur.ppq`
  (tuplet-correct; `0` for grace notes), so cross-voice onset ordering is a
  per-layer cumulative sum — no `@dur`/dots/tuplet math and no Verovio dependency
  in the normalizer.

Source errata (B3: K332/ii m24; the K279/ii m51–52 cautionary flat) go to the
**corrections overlay** (ADR-027), not the normalizer — the normalizer realises
the notation faithfully; wrong notation stays wrong until an errata entry fixes
it, which keeps source drift visible.

## Tooling

The scratchpad classifier (staff+octave-scoped expected vs realised MIDI) is the
right verification instrument for Item 6 and for the fix's regression tests. It
should be promoted to `scripts/` as `accidental_trace.py` — analogous to
`scripts/clef_audit.py` — once the **per-section key signature** handling is in
(the scratchpad version reads only the first `keySig`, which is what produced the
K331/ii false positives before they were caught).

## Verification status

- Engine model: proven on Verovio 6.1.0 (synthetic + decoded MIDI).
- Per-bar classification: traced on freshly prepped+normalized real DCML sources
  for all seven movements.
- Fix: **designed, not implemented.** Implementation, an ADR note (Pass 9
  extension), and the promoted tool + regression tests are the next sub-step,
  pending approval of the design question above. Corpus-wide re-application is
  Band 1 Item 6.
