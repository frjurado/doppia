# ADR-028: MEI Accidental Normalization — Full Gestural Resolution (Pass 9)

**Date:** 2026-06-28
**Status:** Accepted — implemented
**Supersedes:** ADR-022 (and, transitively, ADR-021 — kept as incident history)

---

## Context

The Component 9 staging read-through (Cluster B in
`docs/reports/component-9-reports/staging-readthrough-issues.md`) surfaced a
family of playback bugs: the SVG renders the correct pitch but MIDI plays a
wrong one. The investigation
(`docs/investigations/accidentals-k279-mvt1/accidentals-playback-findings.md`)
traced every cited bar across seven movements and established the load-bearing
fact about the engine:

> **Verovio 6.1.0 realises each note's MIDI pitch from that note's own encoded
> `accid` / `accid.ges` only.** It does not staff-scope, does not run
> accidentals within a layer, and does not re-derive the key signature at render
> time for a note that carries no `accid.ges`. (Proven on synthetic MEI and by
> decoding the rendered MIDI byte stream.)

So correct MIDI depends entirely on the MusicXML→MEI converter writing the right
set of `accid.ges`. It does not, in **two opposite directions**:

1. **Missing `accid.ges`** — the note plays natural when it should be altered:
   - *cross-octave / cross-staff suppression*: an explicit natural on a pitch in
     one octave makes the converter drop the key-signature `accid.ges` on the
     same pitch class in another octave or staff (K279/ii 51·52·67, K280/ii
     30·58, K332/iii 22·27·232·237);
   - *cross-voice carry*: an explicit accidental in one voice is never written
     onto the same-pitch note sounding in another voice of the staff (K283/i 49,
     K283/ii 22, K331/ii 25 ff., K332/ii 9–14).
2. **Spurious `accid.ges`** — the note plays altered when it should be natural:
   a notated accidental is propagated as `accid.ges` onto a same-pitch note
   **earlier in onset** in a different interleaved voice (K279/ii m70, K280/ii
   m30 treble).

ADR-022's Pass 9 (`_strip_spurious_gestural_accidentals`) only ever **strips**,
and only inspects notes that already carry an `accid.ges` with no `@accid`. It
therefore cannot fix the *missing*-`accid.ges` cases at all, and it misses the
backward bleeds because it walks **document order** — with interleaved voices,
the later-onset notated accidental in layer 1 is recorded as a "prior carry"
before the earlier-onset note in layer 2 is reached, so the spurious gestural is
judged legitimate and kept.

Two pieces of ADR-022 machinery are correct and reused unchanged:

- `_build_measure_key_sigs` — the section-aware, per-staff, per-measure
  key-signature index (this already solves mid-movement key changes such as
  K331/ii's 3♯ Menuetto → 2♯ Trio).
- `_build_tie_targets` — tie continuations inherit their predecessor's pitch
  (ADR-026) and must never be rewritten.

## Decision

Generalise Pass 9 from a strip-only filter into a **staff- and octave-scoped,
section-aware, onset-ordered gestural-accidental *resolution*** that computes
each note's expected alteration under Classical convention and writes
`accid.ges` to match — **full resolution**: it *adds* a missing gestural
accidental, *overrides* a present-but-wrong one, and *removes* a spurious one.
`@accid` (the printed glyph) is never touched, so SVG is unchanged; only MIDI
realisation is corrected.

The override-vs-add-only choice (the investigation's open question) is resolved
in favour of **full resolution / override**: it is strictly faithful to the
notation, it fixes the backward bleeds in the same pass instead of a second
onset-aware strip, and it subsumes ADR-022's behaviour rather than running
beside it.

### Onset model

Every converted note carries `@dur.ppq` (duration in PPQ ticks, already
tuplet-correct and `0` for grace notes). A note's onset within its measure is
the cumulative sum of `@dur.ppq` of the preceding timed events **in its own
layer**, where a `<chord>` counts once for all its notes and grace notes
(`dur.ppq="0"`) do not advance the clock. No `@dur`/dots/tuplet arithmetic and
no Verovio dependency are needed in the normalizer.

### Algorithm (per `<staff>` within each `<measure>`)

1. Resolve the active key signature from `_build_measure_key_sigs` (+ inline
   `<staffDef>`/`<scoreDef>` changes), exactly as today.
2. Compute each note's onset (above) and order all of the staff's notes by
   `(onset, tiebreak)`. **Tiebreak: at equal onset, notes carrying an explicit
   `@accid` sort before gestural-only notes**, so an explicit accidental governs
   a simultaneous same-pitch note in another voice (this is what makes K331/ii's
   "C♮ should apply to both voices" resolve correctly).
3. Maintain `running[(pname, oct)] → alteration`, reset per measure, default =
   the key-signature alteration for `pname` (natural if none).
4. Walk notes in that order:
   - **Explicit `@accid`** → set `running[(pname, oct)] = @accid`; the note is
     authoritative and left untouched (its own glyph and gestural value stand).
   - **Tie continuation** (an `@endid` target whose start carries an alteration)
     → leave untouched (ADR-026).
   - **Otherwise** the expected alteration is
     `running.get((pname, oct), keysig)`:
     - expected is an alteration (sharp/flat/double) → **set
       `accid.ges`** to it (adds when absent, overrides when wrong);
     - expected is natural → **remove** any `accid.ges` (and orphaned
       `glyph.auth`) so the note plays natural with no glyph — byte-for-byte the
       output ADR-022 produced for a legitimate strip.
5. Every add / override / strip is recorded in `changes_applied` (tagged so a
   corpus audit can separate the three) with the note `xml:id`, measure, staff,
   and the reason (key-sig, carry, or spurious).

The pass remains **idempotent**: explicit `@accid` and ties are never altered,
and the gestural value is set deterministically from key-sig + onset-ordered
carry, so a second run is a no-op.

### What this pass deliberately does **not** do

- It never edits `@accid`, pitch, octave, duration, `xml:id`, or any printed
  content — SVG is invariant.
- It does **not** correct **source errata** (a wrong or missing *notated*
  accidental in the DCML/MuseScore data — K332/ii m24; the K279/ii m51–52
  cautionary flat). The pass realises the notation faithfully; wrong notation
  stays wrong until a corrections-overlay errata entry fixes it (ADR-027), which
  keeps source drift visible rather than silently "improving" the data.

## Consequences

- **MIDI corrected for the whole Cluster-B family** in one pass, both
  directions, across all seven traced movements; the existing ADR-022 strip
  cases remain fixed (they are the "expected = natural" branch).
- **`_strip_spurious_gestural_accidentals` was renamed/rewritten** to
  `_resolve_gestural_accidentals` (Pass 9); module docstring updated. All 14
  ADR-022 regression cases pass unchanged against the resolver (their strip
  behaviour is the "expected = natural" branch), plus three new fixtures —
  `accid_cross_octave_suppression`, `accid_cross_voice_carry`,
  `accid_backward_bleed` — each with an idempotence test.
- **Document-order → onset-order** is the one behavioural risk surface; covered
  by the `accid_backward_bleed` multi-voice regression (whose document order is
  deliberately the reverse of its onset order) and an idempotence test. Onsets
  are accumulated from `@dur.ppq`; note that lxml hands out fresh proxy objects
  per traversal, so the onset walk **captures and reuses** note references
  rather than keying a side table by `id(note)`.
- **Edge case — conflicting simultaneous explicit accidentals** (two voices, the
  same `(pname, oct)`, different `@accid`, identical onset): both notated notes
  keep their own `@accid` (each is authoritative for its own pitch); the
  tiebreak only governs how an explicit accidental seeds `running` for
  *gestural-only* neighbours. This is vanishingly rare in the corpus and is
  logged if encountered.
- **Verification tool.** `scripts/accidental_trace.py` (promoted from the
  investigation scratchpad, made per-section key-sig aware) is the spot-check /
  regression instrument, analogous to `scripts/clef_audit.py`; corpus-wide
  re-application is Band 1 Item 6.
- **ADR-022 superseded.** Read this ADR for the current algorithm; read ADR-022
  for the key-signature index design (reused here) and ADR-021 for the original
  cross-staff incident.
