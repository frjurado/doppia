# Real Audio Playback — Research Summary

**Status:** Research note (future consideration)
**Date:** 2026-04-15

---

## Overview

This note summarises the viability of using real audio recordings instead of MIDI synthesis for score playback, across three dimensions: open-licence recording availability, score-audio synchronisation technology, and architectural implications.

The short conclusion: real audio is a viable enhancement for a constrained subset of the repertoire, not a replacement for MIDI synthesis across the whole corpus. MIDI remains the guaranteed baseline; real audio is an optional upgrade tier when a suitable recording exists.

---

## 1. Open-Licence Recording Availability

Classical compositions are generally public domain, but performance recordings carry separate performer and producer rights lasting 50–70 years from the recording date (with variation by jurisdiction). Professionally produced, openly-licensed classical recordings are therefore structurally scarce.

**Primary sources:**

- **Musopen** — the most significant organisation in this space. A US 501(c)(3) non-profit that commissions new recordings specifically for public domain release, funded partly through Kickstarter campaigns. Coverage includes Beethoven symphonies (Czech Philharmonic), all four Brahms symphonies, Schubert piano sonatas, and Chopin's complete works. Best coverage is in solo piano repertoire; orchestral and chamber music is thinner. Licensing varies per recording: filter explicitly for CC0 or CC-BY before use.
- **Open Goldberg Variations** (Bach BWV 988) and **Open Well-Tempered Clavier** — CC0, professionally recorded by Kimiko Ishizaka on a Bösendorfer 290 Imperial. The model for what purpose-built open recordings can be, but covering only a handful of works.
- **Internet Archive / Free Music Archive** — large volume, but licensing is often unclear; requires per-item verification.

**For our core repertoire** (Mozart piano sonatas, Haydn keyboard works, Bach, Corelli), coverage exists but is far from complete movement-by-movement. Any corpus expansion strategy that follows theoretical repertoire rather than what happened to get crowd-funded will encounter gaps.

---

## 2. Score-Audio Synchronisation

This is a well-studied MIR problem. The technology is mature for solo piano music.

### How it works

The standard offline approach:

1. Synthesise the score as MIDI, then compute **chroma features** from both the MIDI synthesis and the real recording. Chroma features (12-dimensional pitch-class energy vectors) provide a timbre-independent harmonic representation comparable across synthesis and recording.
2. Apply **Dynamic Time Warping (DTW)** to find the optimal alignment path between the two feature sequences.
3. Invert the path to produce a **time-map**: a mapping from audio timestamp → (bar, beat) score position.

For solo piano music, state-of-the-art systems achieve over 95% of note onsets detected with sub-100ms precision. More recent transformer-based models outperform DTW in the presence of heavy rubato and ornaments.

### Python toolchain

A complete open-source pipeline is available:

- **partitura** — score/MIDI I/O and note-level data structures
- **parangonar** — Python package (pip-installable) with offline and online note alignment algorithms, including `DualDTWNoteMatcher` (SOTA for standard alignment), `TheGlueNoteMatcher` (neural network, for large mismatches), and `OnlineTransformerMatcher` (real-time use)
- **Parangonada** — web-based alignment visualisation and correction tool; accepts CSV exports from partitura/parangonar; supports human review of automatic alignments
- **librosa / madmom** — audio feature extraction

The **ASAP / (n)ASAP dataset** (JKU) provides 222 scores aligned with 1,068 performances (over 92 hours of Western classical piano) with note-level alignments, and is a useful benchmark and training resource.

### Automation ceiling

| Case | Reliability |
|---|---|
| Solo piano, moderate tempo flexibility | High — beat-level alignment is near-fully automatic |
| Solo piano, heavy rubato or ornaments | Medium — automatic with human QC |
| Chamber music, small ensemble | Medium — polyphonic texture adds noise |
| Orchestral music | Lower — requires more manual correction |
| Pieces with unscripted repeats or structural deviations | Needs special handling |

A practical workflow: run parangonar automatically, flag alignments below a confidence threshold for human review via a Parangonada-style interface, store reviewed alignments with provenance metadata.

---

## 3. Architectural Implications

The current architecture accommodates real audio with contained additions. No existing design decisions need to be revisited.

### New data model additions

Two new PostgreSQL tables:

```sql
CREATE TABLE audio_recording (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    movement_id      UUID REFERENCES movement(id),
    performer        TEXT,
    ensemble         TEXT,
    recording_year   INTEGER,
    source           TEXT,
    source_url       TEXT,
    license          TEXT,              -- SPDX: CC0-1.0, CC-BY-4.0, etc.
    audio_object_key TEXT NOT NULL,    -- R2/S3 key
    alignment_status TEXT DEFAULT 'pending', -- pending | aligned | needs_review | failed
    created_at       TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE audio_score_alignment (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    audio_id         UUID REFERENCES audio_recording(id),
    alignment_data   JSONB NOT NULL,   -- time-map (see below)
    alignment_method TEXT,             -- e.g. "parangonar-DualDTW"
    confidence       FLOAT,
    reviewed_by      UUID REFERENCES app_user(id),
    reviewed_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ DEFAULT now()
);
```

The `alignment_data` JSONB stores a time-map in the same coordinate system already used throughout the system:

```json
{
  "version": 1,
  "resolution": "beat",
  "entries": [
    { "audio_secs": 0.00, "bar": 1, "beat": 1.0 },
    { "audio_secs": 0.54, "bar": 1, "beat": 2.0 },
    { "audio_secs": 1.07, "bar": 2, "beat": 1.0 }
  ]
}
```

Note that `bar` + `beat` (float, 1-indexed) is the same coordinate system as `bar_start`/`beat_start` in the fragment data model. No translation layer is needed.

### Alignment pipeline

Mirrors the music21 preprocessing pipeline already planned:

```
Audio uploaded to R2 → Celery job dispatched
  → Fetch audio; fetch MEI → convert to MIDI (music21)
  → Run parangonar DTW alignment
  → Store time-map with confidence score
  → If confidence < threshold → flag needs_review
  → If confidence ≥ threshold → mark aligned
```

### Client-side playback

Playback switches from Verovio-generated MIDI + SoundFont synthesis to an HTML5 Audio element, with score-following driven by the stored time-map:

```javascript
audioElement.addEventListener('timeupdate', () => {
  const position = interpolateAlignment(alignmentMap, audioElement.currentTime);
  const elements = getElementsAtBarBeat(position.bar, position.beat);
  highlight(elements);
});
```

Nothing in the rendering layer changes. MEI → Verovio → SVG is unaffected. Audio is purely additive.

### What to do now (forward-compatibility at negligible cost)

**Abstract the playback position source.** The handler that triggers score highlighting should fire on `onPositionUpdate(bar, beat)` rather than directly on a MIDI tick event. Both MIDI and real audio call the same interface. This makes switching between playback modes a configuration change rather than a refactor.

**Keep (bar, beat) primary throughout.** Do not introduce MIDI-tick-dependent coordinates anywhere in fragment boundaries, playback position, or the tagging interface. The float-beat coordinate system is already the right choice and the natural lingua franca between MIDI and audio-alignment outputs.

**Model `AudioRecording` as optional.** A movement always has a MIDI playback path (Verovio-generated). An `AudioRecording` is an enhancement when a suitable open-licence recording exists. Students get MIDI by default; audio is an upgrade. No feature should be gated on the existence of a real recording.

**Track license at SPDX precision.** The blog, exercise, and AI tutor layers may surface audio; they need to know what terms apply.

---

## Summary

| Dimension | Assessment |
|---|---|
| Open audio availability | Thin but real; Musopen is the primary source; concentrated in solo piano; expect gaps in ensemble and less standard repertoire |
| Alignment technology | Mature for solo piano; parangonar gives a complete open-source Python pipeline; beat-level accuracy is near-fully automatic; note-level needs occasional human QC |
| Architectural cost of planning for it | Very low — coordinate system is already correct; pipeline pattern already exists; addition is two new tables and a client-side abstraction |
| When to pursue it | When the corpus covers works with available open recordings (Bach keyboard, Beethoven sonatas, Chopin) — plausibly Phase 2 or early Phase 3 |
