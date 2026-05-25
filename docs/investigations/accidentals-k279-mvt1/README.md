# Accidentals Investigation — K. 279 mvt 1 (Step 20 artefacts)

**Branch:** `fix/accidentals-k279-mvt1`  
**Date:** 2026-05-25 (revised 2026-05-26)  
**Status:** Reproduced, classified, and fixed (→ ADR-021)

---

## Evidence

| File | Description |
|---|---|
| `k279-mvt1-normalised.mei` | Normalised MEI from MinIO (`mozart/piano-sonatas/k279/movement-1.mei`) |
| `k279-mvt1-original.mei` | Original pre-normalisation MEI (`originals/mozart/piano-sonatas/k279/movement-1.mei`) |
| `measure-5-excerpt.xml` | Raw `<measure n="5">` block extracted with lxml |
| `k279-mvt1.mid` | MIDI rendered by `verovio.toolkit().renderToMIDI()` from the normalised MEI |
| `midi-note-dump.json` | Full note-on event list (abs\_tick, measure, beat, MIDI note, pitch name) for both tracks |

---

## Reproduction: measure 5

The first observable discrepancy is in **measure 5** (MEI `@n="5"`).

### Correct notes (per DCML source `.mscx`)

The Alberti bass in measures 5–6 is built on a C major triad (C4–G4–E4–G4).
The bass C4 notes are **C natural** — confirmed by direct inspection of the
DCML MuseScore source files and their audio playback in MuseScore.

### MEI encoding found

Three distinct patterns appear for accidentals in this file:

| Pattern | Example element | Meaning |
|---|---|---|
| `<accid accid="s" accid.ges="s"/>` | treble C#5, beat 3 | Notated **and** gestural sharp — displayed in score and played in MIDI |
| `<accid accid.ges="s" glyph.auth="smufl"/>` | bass C4, beats 1–2 | Gestural sharp **only** — played in MIDI as C#, **not** displayed — **WRONG DATA** |
| `<accid/>` (empty) | all other notes | No accidental — natural both visually and in MIDI |

### Three-way diff: MEI → SVG → MIDI

| Note | MEI `accid` | MEI `accid.ges` | SVG glyph | MIDI pitch | Correct? |
|---|---|---|---|---|---|
| Treble C5 beat 1 (`u1r7xpo5`) | — | — | no sharp | 72 = C5 nat. | ✓ |
| Treble C5 beat 2 (`f1f4q4op`) | — | — | no sharp | 72 = C5 nat. | ✓ |
| **Treble C#5 beat 3 (`k18ozkr2`)** | `s` | `s` | #E262 sharp | 73 = C#5 | ✓ |
| **Bass C4 beat 1 (`uvwj816`)** | — | **`s`** | no sharp | **61 = C#4** | ✗ MIDI wrong |
| **Bass C4 beat 2 (`d8t6641`)** | — | **`s`** | no sharp | **61 = C#4** | ✗ MIDI wrong |

**The discrepancy:** bass C4 notes at beats 1–2 display as C natural in the
SVG (correct), but play as C# in MIDI (wrong). The user sees the correct note
but hears the wrong pitch.

Verovio's behaviour is correct on both paths:
- MIDI path: reads `accid.ges="s"` → plays C#4. ✓ (per spec — the data is wrong, not Verovio)
- SVG path: reads `accid` (absent) → draws no sharp glyph. ✓ (per spec)

### SVG rendering confirmation

Verovio renders SMuFL glyph `#E262` (accidentalSharp) only when `accid` is set
on the `<accid>` child element. Notes with only `accid.ges` produce no visible
accidental glyph — only the notehead `#E0A4`.

---

## Root cause: MEI conversion artefact

### Original vs. normalised

The original and normalised MEI files are **byte-identical** for measure 5.
The normaliser does not currently touch `<accid>` elements; the defect
originates in the MuseScore-to-MEI **conversion pipeline**, not in the DCML
source data.

### Mechanism

The MEI converter incorrectly propagates accidentals across staves and octaves.
When the treble has C#5 (with `accid="s" accid.ges="s"`), the converter marks
the bass C4 with `accid.ges="s" glyph.auth="smufl"` — treating the accidental
as if it applied across staves and octaves. This violates standard notation
rules: an accidental applies only to the same pitch name, same octave, same
staff, within a measure.

The `glyph.auth="smufl"` attribute is a diagnostic marker: it appears only on
spurious elements. Its presence without `accid` means the glyph-authority
declaration is orphaned (no glyph will be rendered).

### Scope across the movement

Verified across all 100 measures:

- **153** `<accid>` elements with `accid.ges` + `glyph.auth="smufl"` but no `accid`
- **163** `<accid>` elements with both `accid` + `accid.ges` (correctly notated)
- **0** `<accid>` elements with `accid.ges` alone (without `glyph.auth`)

The 153 suspicious elements split into two groups:

1. **Spurious cross-staff propagation** — same pitch class, different staff
   from the triggering accidental, no prior explicit accidental in the affected
   staff/measure/octave. MIDI pitch is wrong. → **must be stripped**

2. **Legitimate within-staff carry** — same pitch class, same octave, same
   staff as a prior `accid`-bearing note in the same measure. MIDI pitch is
   correct (the note genuinely sounds with the accidental due to carry).
   → **must be preserved**

---

## Classification: Bucket 2 — MEI conversion artefact

The DCML MuseScore sources are correct. The conversion pipeline introduces
`accid.ges="s"` on notes that should be natural, causing wrong MIDI pitch
without affecting SVG display.

Buckets considered:

- **Bucket 1 (Verovio MIDI bug):** Ruled out — Verovio reads `accid.ges`
  correctly; the problem is the data, not the renderer.
- **Bucket 2 (MEI data defect):** Confirmed. The `accid.ges="s"` on bass C4
  is wrong data from the conversion pipeline.
- **Bucket 3 (normalisation regression):** Ruled out — original and normalised
  files are identical; the normaliser was not touching `<accid>` elements.

---

## Fix (→ ADR-021)

Pass 8 added to `backend/services/mei_normalizer.py`:
`_strip_spurious_gestural_accidentals`.

For each `<accid>` with `accid.ges` + `glyph.auth="smufl"` but no `accid`,
check if the same staff/measure/octave had a prior note with explicit `accid`.
If not (spurious), strip `accid.ges` and `glyph.auth`. If yes (legitimate
within-staff carry), leave untouched.

**Regression test:** `backend/tests/unit/test_mei_normalizer.py::TestSpuriousGesturalAccidentals` — 5 cases.

**Full decision record:** `docs/adr/ADR-021-mei-accidental-normalization.md`
