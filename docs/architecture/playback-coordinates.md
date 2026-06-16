# Playback Coordinates

This document describes the four coordinate systems used in the score viewer and MIDI playback pipeline, how they relate to each other, and the known edge cases and bugs that affect each layer.

---

## Four coordinate systems

### 1. Human coordinates — `bar_start` / `bar_end`

`bar_start` and `bar_end` store the MEI `<measure @n>` value at the boundary of a fragment. These are the numbers a musician sees on the printed score. They are display-only: the score viewer shows them in fragment labels and API responses, but they are never passed to Verovio or used for MIDI time mapping.

Known fragility (documented in ADR-015):
- Non-integer in some MuseScore-exported MEI files (`X1`, `X2`, etc.)
- Repeats across volta endings (both the first- and second-ending bar share `@n="3"`)
- Pickup bars conventionally use `@n="0"`

None of these cases affect rendering — they are the reason `mc_start`/`mc_end` exist.

### 2. Machine coordinates — `mc_start` / `mc_end`

`mc_start` and `mc_end` are 1-based document-order position indices over `<measure>` elements in the MEI source. They are stored on the fragment row and passed directly to Verovio as `measureRange` operands:

```typescript
tk.select({ measureRange: `${mcStart}-${mcEnd}` });
```

No conversion is needed at render time. The DCML `mc` field and the Verovio position index are the same counter — both are 1-based document-order ranks over the same MEI `<measure>` elements (ADR-015).

Position index `0` does not exist in Verovio; `mc_start` is always ≥ 1.

### 3. Sub-measure beat coordinates — `beat_start` / `beat_end`

Beat positions use the subdivision-aware float encoding defined in ADR-005:

```
beat_position = beat_number + (subbeat_index / subdivisions_per_beat)
```

`beat_number` is 1-indexed (MEI convention). Examples:

| Time sig | Position | Value |
|---|---|---|
| 4/4 | Beat 2 | `2.0` |
| 4/4 | Beat 2, second eighth | `2.5` |
| 6/8 | Beat 1, second eighth | `1.333…` |

These fields are nullable: `null` means "full extent of the measure range", not "data missing". Beat coordinates are not yet consumed by the score viewer or MIDI pipeline — they are stored at tag time for future fragment-level playback and exercise generation.

### 4. MIDI time — milliseconds

`useMidiPlayback` tracks position in milliseconds via `Tone.getTransport().seconds * 1000`. This is the unit consumed by `getElementsAtTime()` (for fallback queries) and the pre-built timemap schedule (the production path).

The timemap schedule is built once after each render by `buildHighlightSchedule()`, which calls `tk.renderToTimemap()`. Each schedule entry maps a millisecond onset to the set of MEI element IDs sounding at that time. During playback, `handlePositionUpdate` binary-searches this schedule at ~60 fps and applies the `.is-playing` CSS class to matching DOM elements without React state updates.

---

## Coordinate chain

```
fragment.mc_start / mc_end
        │
        ▼  tk.select({ measureRange })   ← constrains the rendered SVG only
Verovio render
        │
        ▼  tk.renderToMIDI()       tk.renderToTimemap()
base64 MIDI                     timemap schedule
 (whole movement)               (whole movement)
        │                               │
        ▼  buildFragmentPlayback(mc_start, mc_end) windows both to the
        │  fragment's measure span (startMs..endMs) and shifts to 0
        ▼                               ▼
Tone.js transport (ms)  ───────────────►  binary search → DOM .is-playing
        │
        ▼
Tone.Sampler (audio)
```

`fragment.bar_start` / `bar_end` live entirely outside this chain — display only.

> **`select()` does not constrain MIDI or the timemap.** Empirically confirmed
> in Verovio 6.1.0 (Component 9 Step 18): `tk.select({ measureRange }) +
> redoLayout()` constrains `renderToSVG()` but `renderToMIDI()` and
> `renderToTimemap()` return byte-for-byte identical whole-movement output with
> or without an active selection. Fragment playback therefore **windows** the
> whole-movement output to the rendered measure range rather than relying on the
> selection. See §"Fragment-scoped playback" below.

---

## Pickup bar handling

The MEI normalizer assigns `@n="0"` and `@metcon="false"` to anacrusis (pickup) measures at ingest (see `docs/architecture/mei-ingest-normalization.md` §6). Its position index is therefore `mc=1`, so a fragment that begins on the pickup bar has `mc_start=1`.

Display implications:
- `bar_start=0` is valid and means "pickup bar". The score viewer must not treat 0 as a sentinel; it is a real bar.
- The playback bar's position display (`bar:beat`) will show `0:1` during the pickup bar. This is correct but may look odd; a future label pass can substitute "pickup" when `bar=0`.

Beat coordinates in the pickup bar: because `@metcon="false"`, the pickup measure contains fewer beats than the nominal meter. Ghost construction must not exceed the actual number of note onsets; the range-check described in ADR-005 ("Tied notes across barlines" edge case) applies here for the same reason — `beat_start` values relative to the anacrusis start will be smaller than `beat_number=1` when converted naively from score-time.

---

## Repeat policy

Verovio expands all repeats (first/second endings, da capo, dal segno) in MIDI and timemap output by default as of Verovio 6.0 (ADR-013 §"Breaking-area changes"). This is the desired behaviour for playback:

- Both passes of a repeated section are played in the audio.
- `renderToTimemap()` produces two entries at different millisecond offsets for the same MEI element IDs — one per pass. `buildHighlightSchedule` preserves both entries; the binary search selects the correct one at playback time.
- `getElementsAtTime()` is **not** used for highlights in the production path. The timemap schedule is preferred because `getElementsAtTime` can return structural element IDs (barlines, render elements) at repeat boundaries, causing stale highlights between note onsets.

Fragment rendering uses `mc_start`/`mc_end`, which identify a specific physical measure (including which volta variant). A fragment that spans a first ending has `mc_start`/`mc_end` values pointing unambiguously into the first-ending measures. Its playback covers that measure range only — but because `renderToMIDI()` ignores the selection, the range is enforced by **windowing** the whole-movement MIDI (see §"Fragment-scoped playback" below), not by the selection.

**Fragments containing unpaired repeat structure (ADR-025).** Selections may cross repeat barlines (but not D.C./D.S. markers or volta-ending boundaries), so a fragment can contain a `:|` whose paired `|:` lies outside the fragment. Honouring it would jump playback out of the fragment, so it is ignored: fragment playback uses **final-pass semantics** — no jump, the fragment plays once, straight through its effective range, as the music sounds the last time through. Volta endings need no playback special-casing: when a truncated repeat has endings, the non-final endings are already excluded from the fragment's effective range at the selection layer. A repeat structure wholly contained in the fragment (including its `|:`) expands normally, both passes. A D.C./D.S. directive can only sit on a fragment's last bar and is ignored. Full-movement playback is unaffected. **As implemented (Step 18, revised), the time-window selection delivers these semantics** by reading the *expanded* measure-onset sequence from the timemap and choosing the window from the **last** onset of `mc_start` that is entered from *outside* `[mc_start, mc_end]` up to the first onset that leaves the range (see §"Fragment-scoped playback"). A naïve "first onset of `mc_start` → first onset after `mc_end`" window does **not** work: when a repeat-end inside the fragment jumps to a `|:` before it, that span sweeps up the jump and replays the section — the exact bug this rule fixes. The last-entry-from-outside rule lands on the final pass for a truncated repeat while still starting at the first onset for a wholly-contained repeat (whose internal jump re-enters from *inside* the range). Normative statement: `tagging-tool-design.md` §6A.6.

---

## Non-quarter-meter beat normalization

The Tone.js transport accepts a single static time signature. For mid-piece meter changes, `useMidiPlayback` sets `transport.timeSignature` from the first entry in `midiData.header.timeSignatures` only. Subsequent meter changes are not tracked in the bar:beat position display (acceptable limitation for Phase 1; the audio is always correct because Verovio's MIDI is pre-rendered).

For compound meters (6/8, 9/8, 12/8), the `beat_start`/`beat_end` encoding uses the dotted-quarter as the beat unit, not the eighth. `subdivisionsPerBeat = 3` for compound meters. The tagging tool must detect compound meter per measure from the MEI node before falling back to the global `scoreDef`:

```javascript
const isCompound = (beatUnit === 8) && (beatCount % 3 === 0);
const subdivisionsPerBeat = isCompound ? 3 : 2;
```

The Tone.js position display does not know about compound meters — it reports eighth-note beats unless the transport time signature is explicitly set to the compound grouping. This is a display-only inaccuracy; the MIDI audio follows the score exactly.

---

## Transposition

### The current bug — `d2` is not a semitone

The `TRANSPOSE_OPTIONS` array in `ScoreViewer.tsx` currently maps "Up a semitone" to the Verovio string `"d2"`. This is wrong.

In Verovio's interval notation, `d2` means **diminished second** — the interval between two adjacent staff positions where the upper note is lowered by an accidental (e.g. C → D♭♭). A diminished second is enharmonically equivalent to a unison: the pitch class does not change. The result is that "Up a semitone" produces the same notes as the original but re-spelled into an enharmonically absurd key signature (G major → A♭♭ major with seven double flats). MIDI playback confirms that no actual pitch shift occurs — the audio is identical to the un-transposed version.

The correct Verovio interval for a **chromatic semitone** (one semitone up with reasonable enharmonic spelling) is `"A1"` (augmented unison) for pitch-only transposition, but the preferred interval for key-aware transposition in this context is `"m2"` (minor second) — this transposes both the notes and the key signature by a diatonic step, producing a playable key (G major → A♭ major, not A♭♭ major).

The full intended interval set for the dropdown, in Verovio string notation:

| Display label | Verovio string | Semitones |
|---|---|---|
| Minor 2nd up | `"m2"` | +1 |
| Minor 2nd down | `"-m2"` | −1 |
| Major 2nd up | `"M2"` | +2 |
| Major 2nd down | `"-M2"` | −2 |
| Minor 3rd up | `"m3"` | +3 |
| Minor 3rd down | `"-m3"` | −3 |
| Major 3rd up | `"M3"` | +4 |
| Major 3rd down | `"-M3"` | −4 |
| Perfect 4th up | `"P4"` | +5 |
| Perfect 4th down | `"-P4"` | −5 |
| Tritone up | `"A4"` | +6 |
| Tritone down | `"-A4"` | −6 |

### Enharmonic normalization

Transposing can produce key signatures with extreme accidental counts. Apply the following normalization rule before displaying a transposed key name or building the dropdown label:

- More than 6 sharps → respell as the enharmonic flat equivalent (e.g. D♯ major → E♭ major, G♯ major → A♭ major).
- More than 6 flats → respell as the enharmonic sharp equivalent (e.g. G♭ major → F♯ major, C♭ major → B major).

This applies to display only — the Verovio string passed to `setOptions` is always the diatonic interval string above; Verovio handles its own internal enharmonic choices.

### Dropdown ordering and key display

Dropdown items should alternate up/down pairs, with no-transposition first:

```
No transposition
Minor 2nd up (A♭ major)    ← key in parentheses, derived from fragment.summary.key
Minor 2nd down (F♯ major)
Major 2nd up (B♭ major)
Major 2nd down (F major)
Minor 3rd up (B♭ minor)
Minor 3rd down (E minor)
Major 3rd up (C minor)
Major 3rd down (E♭ major)
Perfect 4th up (C major)
Perfect 4th down (D major)
Tritone up (D♭ major)
Tritone down (D major)
```

The key shown in parentheses is computed at render time from `fragment.summary.key` (for the fragment browser) or `movement.key` (for the full score viewer, once that field is available). The computation is:

1. Parse the key string into a root pitch class and mode (major/minor).
2. Apply the semitone offset for the selected interval.
3. Apply the enharmonic normalization rule (>6 sharps or >6 flats → respell).
4. Format as `"<root> <mode>"` using Unicode accidentals (♯, ♭, ♯♯, ♭♭).

When the source key is not known (e.g. the score viewer before a fragment is selected), show only the interval name without the parenthetical key.

### MIDI and transposition

After a transposition change, the re-render path in `ScoreViewer` calls `renderMidi(tk)` against the already-transposed toolkit state. Verovio's `renderToMIDI()` outputs MIDI with the transposed pitches, so the audio matches the transposed notation exactly. No MIDI pitch adjustment is done in JavaScript — the source of truth is Verovio's internal model after `setOptions({ transpose: "…" })` and `loadData()`.

The timemap (used for the highlight schedule) is also regenerated after each re-render for the same reason: element onset times may shift slightly if transposition changes the accidental layout and causes Verovio to reflow.

---

## Fragment-scoped playback

Implemented in Component 9 Step 18 for the fragment detail view (`FragmentDetail.tsx`).

`renderToMIDI()` and `renderToTimemap()` ignore the fragment `select()` and always emit the whole movement (see §"Coordinate chain"). So fragment playback keeps the whole-movement MIDI/timemap — which preserves Verovio's running clef/key/meter/tempo context at `mc_start` that an MEI slice would lose — and **windows** it to the rendered measure range:

1. `buildFragmentPlayback(tk, meiText, mc_start, mc_end)` (`services/verovio.ts`) reads the whole-movement timemap with `includeMeasures: true`. The `measureOn` field carries each `<measure>`'s xml:id at its onset, so the timemap yields the *expanded* playback measure-onset sequence (repeats unrolled — a measure played twice appears twice, and on the second pass Verovio suffixes the id with `-rendN`, stripped here before mapping back to `mc`). The window is selected on that sequence (ADR-025 final-pass semantics): **`startMs`** = the last onset of `mc_start` entered from *outside* `[mc_start, mc_end]` (preceding measure `< mc_start` or `> mc_end`, or the very first onset); **`endMs`** = the first onset thereafter whose measure leaves the range, or `+∞` when the fragment runs to the movement end. A wholly-contained repeat keeps both passes (its internal backward jump stays in range, so the second `mc_start` onset is *not* chosen and the window spans both passes); a truncated repeat-end resolves to the final pass. It also returns the highlight schedule clipped to `[startMs, endMs)` and shifted so the fragment starts at 0 ms.
2. `useMidiPlayback(midi, onUpdate, { window, onEnded })` schedules only the notes inside the window, shifted by `-startMs`, and registers a `Transport.scheduleOnce` auto-stop at the window length so audio never spills past the fragment. With no window (the full score viewer) playback is unchanged.

The window is keyed on the **rendered** measure range (`mc_start`/`mc_end`), not the beat-precise tagged range — playback follows what the viewer renders (whole measures). This is deliberate: the rendered excerpt and the significant (possibly beat-precise) fragment are not the same thing (see the fragment-bracket note in `FragmentDetail.tsx`).

### Forward-compatibility hooks

The following items remain deferred:

- **Beat-level scrubbing**: `beat_start`/`beat_end` are stored but not yet used as playback start points. `Tone.getTransport().position` can be set to a beat offset derived from the timemap schedule before `transport.start()` — the natural extension point for Step 20 (play-from-position).
- **Timemap + transposition**: the fragment viewer rebuilds the schedule on every render via `buildFragmentPlayback(tk, …)` (which calls `renderToTimemap`), so a future transpose control there would already pick up the new timing. The fragment viewer does not yet expose transposition (`transpose: ''`); when it does, confirm the window onsets still align after the reflow.
- **`getElementsAtTime` fallback removal**: The `VerovioToolkitInstance` interface still declares `getElementsAtTime`. It is no longer called in the production highlight path (replaced by the timemap schedule). Remove it from the interface once the timemap schedule has been validated across the full corpus — the dead declaration is a maintenance hazard.
