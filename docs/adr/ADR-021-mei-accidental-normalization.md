# ADR-021: MEI Accidental Normalization — Stripping Spurious Gestural Accidentals

**Date:** 2026-05-26  
**Status:** Accepted  
**Branch:** `fix/accidentals-k279-mvt1`

---

## Context

### Discovery

During the Step 20 accidentals investigation on K. 279 mvt 1, measure 5 was
identified as the first measure where MIDI playback and SVG display disagree.
The original diagnosis was inverted (see §Evidence below): the SVG display was
correct, and the MIDI pitch was wrong.

**Symptom:** In the Alberti bass of measure 5, C4 is displayed as C natural
(correct), but the MIDI renders it as C# (MIDI 61, wrong). The correct note is
C natural (MIDI 60), confirmed against the DCML MuseScore source files
(`.mscx`), which show and play C natural in both the MuseScore score display
and audio.

### MEI encoding

The OpenScore MEI files use child `<accid>` elements on `<note>` to encode
accidentals. Three attributes are relevant:

| Attribute | Role |
|---|---|
| `accid` | Notated accidental — triggers SVG glyph rendering in Verovio |
| `accid.ges` | Gestural accidental — used by Verovio for MIDI/audio pitch |
| `glyph.auth` | Glyph authority for the rendered glyph (only meaningful when `accid` is set) |

The bug pattern found in the MEI files:

```xml
<!-- Treble C#5: first occurrence, correctly notated -->
<note pname="c" oct="5">
  <accid accid="s" accid.ges="s"/>
</note>

<!-- Bass C4: should be C natural, but converter set accid.ges="s" -->
<note pname="c" oct="4">
  <accid accid.ges="s" glyph.auth="smufl"/>
</note>
```

Verovio's behaviour on these elements is correct per the MEI spec:
- SVG path: reads `accid` (absent on bass C4) → draws no sharp glyph. ✓
- MIDI path: reads `accid.ges="s"` on bass C4 → plays C#4. ✗ (wrong pitch)

### Root cause

The bug originates in the MuseScore-to-MEI conversion pipeline, not in the
OpenScore source data (`.mscx`) and not in Verovio. The converter
incorrectly propagates accidentals from one staff to same-pitch-class notes
in other staves and other octaves within the same measure.

When the treble has C#5 (with `accid="s" accid.ges="s"`), the converter
marks the bass C4 with `accid.ges="s" glyph.auth="smufl"` — apparently
treating the accidental as if it applied across staves and octaves. This
violates standard notation rules: an accidental applies only to the same
pitch name in the same octave in the same staff within a measure.

The `glyph.auth="smufl"` attribute is diagnostic: it appears only on these
spurious elements, never on legitimately notated accidentals. Its presence
without a corresponding `accid` attribute means the glyph-authority
declaration is orphaned (no glyph will be rendered).

### Scope

The pattern was verified across the full K. 279 mvt 1 movement (100 measures):
- 153 `<accid>` elements with `accid.ges` + `glyph.auth="smufl"` but no `accid`
- 163 `<accid>` elements with both `accid` + `accid.ges` (correctly notated)
- 0 `<accid>` elements with `accid.ges` alone (without `glyph.auth`)

The 153 suspicious elements split into two groups:
1. **Spurious cross-staff propagation** — same pitch class, different staff from
   the triggering accidental, no prior explicit accidental in the affected
   staff/measure/octave. These play wrong pitch in MIDI. Must be fixed.
2. **Legitimate within-staff carry** — same pitch class, same octave, same
   staff as a prior `accid`-bearing note in the same measure. These correctly
   encode that the note sounds with the accidental due to intra-measure carry.
   Must be preserved.

---

## Decision

Add **pass 8** (`_strip_spurious_gestural_accidentals`) to
`backend/services/mei_normalizer.py`.

For each `<accid>` element with `accid.ges` set, `accid` absent, and
`glyph.auth="smufl"`:

- Walk all `<note>` elements in the same `<staff>` in the same `<measure>` in
  document order, maintaining a set of `(pname, oct)` tuples that have carried
  an explicit `@accid`.
- If `(pname, oct)` of the current note IS in that set: within-staff carry —
  **do not touch**.
- If `(pname, oct)` of the current note is NOT in that set: spurious
  propagation — **strip `accid.ges` and `glyph.auth`**.

After stripping, the `<accid/>` element is left with only `xml:id` (if
present), which is the correct MEI encoding for a natural note with no
accidental.

### Why the normalizer, not an upstream patch

The upstream source (DCML corpus `.mscx` files) is correct. The conversion
pipeline that produces MEI files is outside Doppia's control. Fixing the
conversion tool would require forking or patching third-party infrastructure;
normalizing on ingest is consistent with the existing approach for other
structural artefacts (passes 1–7) and keeps the fix reproducible and
auditable.

### Why not add `accid` instead of stripping `accid.ges`

The earlier (incorrect) hypothesis was that the fix should be to copy
`accid.ges` into `accid`, making the sharp visible. The DCML source
establishes that the bass notes are genuinely C natural — the `accid.ges="s"`
is wrong data, not a missing display flag. Stripping corrects the audio pitch;
adding `accid` would create a new visual and audio error.

---

## Evidence

Reference fixture: `docs/investigations/accidentals-k279-mvt1/`

| Note | MEI `accid` | MEI `accid.ges` | SVG glyph | MIDI pitch | Correct? |
|---|---|---|---|---|---|
| Treble C#5 beat 3 (`k18ozkr2`) | `s` | `s` | #E262 sharp | 73 = C#5 | ✓ |
| Bass C4 beat 1 (`uvwj816`) | — | `s` | no glyph | 61 = C#4 | ✗ MIDI wrong |
| Bass C4 beat 2 (`d8t6641`) | — | `s` | no glyph | 61 = C#4 | ✗ MIDI wrong |

After normalization:

| Note | MEI `accid` | MEI `accid.ges` | SVG glyph | MIDI pitch | Correct? |
|---|---|---|---|---|---|
| Bass C4 beat 1 | — | — | no glyph | 60 = C4 nat. | ✓ |
| Bass C4 beat 2 | — | — | no glyph | 60 = C4 nat. | ✓ |

---

## Consequences

- **MIDI playback corrected** for all 153 affected notes in K. 279 mvt 1;
  the same pattern is expected in other movements of the DCML Mozart corpus.
- **SVG display unchanged** — was already correct before this fix.
- **Normalizer docstring updated** to note that pass 8 is the one exception to
  the "normalizer never touches musical content" rule; it removes wrong data
  introduced by the conversion pipeline.
- **Regression test** added:
  `backend/tests/unit/test_mei_normalizer.py::TestSpuriousGesturalAccidentals`
  (5 cases: strip spurious, preserve carry, preserve explicit, change recorded,
  idempotent).
