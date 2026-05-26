# ADR-022: MEI Accidental Normalization — Key-Signature-Aware Pass 8

**Date:** 2026-05-26  
**Status:** Accepted  
**Supersedes:** ADR-021

---

## Context

ADR-021 introduced pass 8 (`_strip_spurious_gestural_accidentals`) to fix the
K. 279 mvt 1 cross-staff propagation bug: the MuseScore-to-MEI converter was
marking same-pitch-class notes in unrelated staves with `accid.ges` they did
not deserve, making MIDI play sharps where the score shows naturals. The fix
worked for that case but generated a regression for the rest of the Mozart
corpus.

**Regression introduced by ADR-021:** The rule classified every `<accid>` with
`accid.ges` set and `accid` absent as either "within-staff same-octave carry
from a prior explicit `@accid`" (preserved) or "spurious" (stripped). That
binary misses the most common legitimate case in real scores: notes whose
`accid.ges` is set *because the active key signature implies the alteration.*
In any movement not in C major / A minor every key-signature-implied accidental
was silently stripped on ingest, and MIDI played naturals where the key
signature requires sharps or flats.

**Scope of regression:**
- Any note in a non-C-major / non-A-minor movement whose pitch alteration is
  key-signature-implied (e.g. F♯ in G major, B♭ in F major, F♯/C♯/G♯ in A
  major) was incorrectly stripped. Pre-fix totals in the corpus include K. 283
  mvt 1 (183 stripped, all wrong) and K. 331 mvt 3 (361 stripped, all wrong).
- Corpus-wide, the regression affected every movement with a key signature.

**Second regression discovered after initial fix (K. 331 mvt 3 — section-boundary
key change):** After the initial key-signature-aware algorithm was deployed, the
Rondo alla Turca (K. 331 mvt 3) still produced 361 spurious strips. The root
cause: the `_build_measure_key_sigs` pre-pass accumulated per-staff key-sig
state from the initial `<scoreDef>` block (where `<staffDef n="1"><keySig
sig="0"/></staffDef>` set per-staff entries for A minor), but when the
mid-piece `<scoreDef>` between `<section>` siblings declared the global key
change to A major via `<keySig sig="3s"/>` (no per-staff `<staffDef>`
children), those stale per-staff entries shadowed the new global for every
subsequent measure — so all F♯/C♯/G♯ in the A-major sections were still
stripped. The fixture `keysig_midpiece_change.mei` (which the Step 2 suite
used) did not trigger this bug because the initial `<scoreDef>` in that fixture
sets the key via a `key.sig` *attribute* (not a `<staffDef><keySig/>` child),
so no per-staff entries were created. The real corpus uses `<staffDef><keySig
sig="..."/></staffDef>` children, which always sets per-staff entries.

---

## Decision

Replace the ADR-021 binary rule with a three-source legitimacy test.

### Algorithm

For each `<accid>` element where `accid.ges` is set and `@accid` is absent,
determine whether the gestural alteration is expected at that point in the
score. Three sources of "expected" cover every legitimate case:

| Expected from key sig? | Prior `@accid` carry? | `accid.ges` matches? | Action |
|---|---|---|---|
| Yes | — | Yes | **Keep** (key-signature carry) |
| — | Yes (same `pname`, `oct`, staff, measure) | Yes | **Keep** (within-staff carry) |
| No | No | — | **Strip** `accid.ges` and `glyph.auth` |
| Yes or carry | — | No (mismatch) | **Warn and strip** — converter noise; report discrepancy in `changes_applied` for corpus audit |

Within-staff carry takes precedence over the key signature (a natural sign
written in the measure overrides the key-sig alteration for its octave).

### Key-signature index construction (`_build_measure_key_sigs`)

A pre-pass walks the document in element order, maintaining a global and per-
staff key-signature state, and snapshots it at each `<measure>`. Two
implementation rules ensure correctness:

1. **`<scoreDef>` processed as a complete unit.** When a `<scoreDef>` is
   encountered, all of its descendant `<staffDef>` elements are inspected
   immediately (look-ahead into the subtree) to collect per-staff overrides.
   If the `<scoreDef>` declares a new global key (via `key.sig` attribute or
   `<keySig>` direct child) and a staff is *not* explicitly overridden by a
   `<staffDef>` in the same `<scoreDef>`, any existing per-staff entry for
   that staff is removed so it falls through to the new global. Without this,
   per-staff entries set by the initial `<staffDef>` block (the K. 331-mvt-3
   encoding form) would permanently shadow global key changes.

2. **`<staffDef>` elements consumed by a `<scoreDef>` block are not
   re-processed** when the main `root.iter()` loop reaches them.

Key-signature declarations are read at three levels of precedence (most
specific wins):

- Per-staff `<staffDef n="X">` key (from `key.sig` attribute or `<keySig>`
  child) overrides the global default for staff X.
- Score-level `<scoreDef>` global key (from `key.sig` attribute or `<keySig>`
  direct child) applies to all staves not explicitly overridden.
- Mid-piece `<scoreDef>` or `<staffDef>` elements between `<section>` or
  `<measure>` siblings are processed in document order; their effect is
  reflected in the snapshot for all measures that follow.

Both the `key.sig="Xs"/"Xf"` shorthand form and the `<keySig sig="Xs"/>` /
`<keySig><keyAccid pname="..." accid="..."/></keySig>` explicit forms are
supported.

### `glyph.auth="smufl"` as evidence, not rule

`glyph.auth="smufl"` is a useful diagnostic signal (today's converter emits it
almost exclusively on cross-staff propagations), but the algorithm does not use
it as a trigger. A future converter version could legitimately emit `accid.ges`
without `glyph.auth`, and stripping based on `glyph.auth` alone would
reintroduce the regression in mirror form. The decision is driven entirely by
key-signature and carry logic; `glyph.auth` is recorded in `changes_applied`
as evidence when present.

---

## Evidence

**K. 279 mvt 1 (original cross-staff case):** 153 notes stripped before this
fix; 73 after (the reduction from 153 to 73 reflects within-staff carry notes
that ADR-021 was incorrectly stripping because the carry rule was also applied
in the wrong direction). The cross-staff propagation bug is still correctly
caught.

**K. 283 mvt 1 (G major, 1 sharp):** 183 stripped under ADR-021; 17 after this
fix. The 17 remaining are genuine cross-staff propagations; the 166 reduction
are F♯ notes correctly preserved as key-signature carry.

**K. 331 mvt 3 (Rondo alla Turca, alternating A minor / A major):** 361
stripped under ADR-021 (all wrong — every accid.ges in the A-major sections);
0 after this fix (no genuine cross-staff propagations in this movement).

**Reference fixtures:**

| Fixture | What it tests |
|---|---|
| `normalizer/spurious_gestural_accidentals.mei` | Original cross-staff case (K. 279 pattern) |
| `normalizer/keysig_sharp_carry.mei` | G major: key-sig-implied F♯ preserved |
| `normalizer/keysig_flat_carry.mei` | F major: key-sig-implied B♭ preserved |
| `normalizer/keysig_midpiece_change.mei` | `<scoreDef key.sig="1s"/>` between measures; C-major note stripped, G-major note preserved |
| `normalizer/keysig_carry_coexist.mei` | G major: written natural in measure; within-staff carry of natural takes precedence over key sig |
| `normalizer/keysig_cross_staff_before_trigger.mei` | Spurious note precedes its trigger in document order; still stripped correctly |
| `normalizer/keysig_element_sig_attr.mei` | `<staffDef><keySig sig="1s"/></staffDef>` form (Verovio/MuseScore corpus encoding) |
| `normalizer/keysig_section_boundary_change.mei` | K. 331-mvt-3 encoding: `<staffDef><keySig sig="0"/></staffDef>` initial state + `<scoreDef><keySig sig="3s"/></scoreDef>` between sections; A-major accidentals preserved |

---

## Consequences

- **MIDI playback corrected** across the full Mozart corpus: key-signature-
  implied gestural accidentals are no longer stripped; cross-staff propagations
  are still stripped.
- **Regression suite expanded** from 5 to 14 cases in
  `TestSpuriousGesturalAccidentals` (all in
  `backend/tests/unit/test_mei_normalizer.py`).
- **`glyph.auth="smufl"` demoted** from classifier to diagnostic evidence; the
  algorithm can correctly handle MEI files that use `accid.ges` without
  `glyph.auth`.
- **ADR-021 superseded.** ADR-021 is preserved as the diagnostic record of the
  original cross-staff propagation incident and the within-staff carry rule that
  remains correct. Read this ADR for the current algorithm; read ADR-021 for
  the incident history.
