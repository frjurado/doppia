# ADR-012 — MIDI Player Library

**Status:** Accepted
**Date:** 2026-04-15

---

## Context

The score viewer requires browser-side MIDI playback of Verovio-generated MIDI output. The player must satisfy three requirements:

1. **Playback controls** — play, pause, stop, scrub, tempo control.
2. **Playback position synchronisation** — the player must emit per-note timing events so the score viewer can call `verovio.getElementsAtTime()` and highlight the currently sounding element in the SVG overlay.
3. **Forward-compatibility with real audio** — see `docs/architecture/real-audio-playback-research.md`. The playback position interface must be abstractable behind a single callback (`onPositionUpdate(bar, beat)`) so that switching between MIDI synthesis and real audio playback is a configuration change, not a refactor.

Three options were evaluated:

**`html-midi-player`** (via Magenta.js / Magenta SoundFont) — the simplest integration. Accepts a MIDI URL or base64 string, renders a built-in play/pause/stop UI, and handles SoundFont synthesis via Magenta. The limitation that disqualifies it: it does not expose low-level note-onset events. Playback position synchronisation with Verovio requires intercepting individual note events; `html-midi-player` wraps these away. Achieving synchronisation requires patching or replacing Magenta's internals, which defeats the simplicity argument.

**`MIDI.js`** — exposes per-note callbacks and supports SoundFont synthesis. However, the library has not been actively maintained since 2018, has unresolved issues with modern browser audio contexts, and requires non-trivial setup for SoundFont loading. Its per-note event API is what is needed, but the maintenance situation makes it a poor long-term choice.

**`@tonejs/midi` + Tone.js** — `@tonejs/midi` is a small, actively maintained library that parses Standard MIDI files into a structured note schedule (tracks, notes with onset time, duration, and pitch). Tone.js is a widely used Web Audio framework with a Transport abstraction that schedules notes with sample-accurate timing and fires callbacks at note onsets. Together they give complete control over the note schedule and precise per-note timing events, without any dependency on Magenta or outdated audio libraries.

---

## Decision

Use **`@tonejs/midi`** to parse Verovio-generated MIDI and **Tone.js** for scheduling and playback.

The integration works as follows:

1. After `verovio.renderToMIDI()` produces a base64-encoded MIDI string, decode it and pass the binary buffer to `@tonejs/midi`'s `Midi` constructor to obtain a structured note schedule.
2. Load a SoundFont into Tone.js (via `Tone.Sampler` or a compatible SoundFont loader). Host the SoundFont from Cloudflare R2 or a CDN; do not bundle it with the frontend.
3. Schedule notes onto the Tone.js Transport. At each note onset, fire:
   ```javascript
   onPositionUpdate({ bar: noteBar, beat: noteBeat });
   ```
4. The score viewer's `onPositionUpdate` handler calls `verovio.getElementsAtTime()` to identify the sounding SVG element and applies the highlight class.

**The `onPositionUpdate(bar, beat)` callback is the sole interface between the playback layer and the score viewer.** Neither the MIDI player nor the real audio player (if added in a later phase) calls into the score viewer directly. This abstraction is mandatory from day one.

Mapping from MIDI ticks to `(bar, beat)` uses the time signature and tempo data in the parsed MIDI file, supplemented by `verovio.getTimesForElement()` where measure correspondence needs to be confirmed.

---

## Consequences

**Positive**

- Fine-grained note-event control. Tone.js fires callbacks at note onsets with sample-accurate timing; synchronising the Verovio SVG highlight is straightforward.
- Modern, actively maintained stack. Both `@tonejs/midi` and Tone.js are in active development with strong community support.
- The `onPositionUpdate` abstraction makes the real audio upgrade path (documented in `real-audio-playback-research.md`) a drop-in replacement: the audio element fires the same callback on `timeupdate` using the stored alignment time-map, and the score viewer is unchanged.
- Tone.js's Transport supports tempo control, pause/resume with correct position tracking, and scrubbing — the full set of playback controls required.

**Negative**

- More integration work than `html-midi-player`. The SoundFont loading, Transport scheduling, and note mapping must be implemented rather than delegated to a component. This is a one-time cost estimated at 1–2 days.
- SoundFont selection is a separate decision. Tone.js works with any SoundFont loadable via `Tone.Sampler`; a piano SoundFont (e.g., from the Midi.js SoundFont collection or Musopen's piano samples) must be chosen, compressed, and hosted.

**Neutral**

- Tone.js is a full audio framework. Only the Transport and Sampler subsystems are used for this feature; the rest of the library is unused but present in the bundle. Tree-shaking with the Tone.js ESM build mitigates this.

---

## Alternatives considered

**`html-midi-player`.** Rejected because it does not expose note-onset events. Playback position synchronisation requires intercepting individual note events; `html-midi-player` abstracts these away and provides no supported hook for them. The simplicity argument disappears once synchronisation is required.

**`MIDI.js`.** Rejected due to maintenance status. The library has not had a significant update since 2018, has open issues with Safari's Web Audio context, and its API predates the modern Web Audio conventions used by Tone.js. The per-note callback capability that makes it technically viable is not sufficient to offset the maintenance risk.
