/**
 * useMidiPlayback — MIDI playback hook via Tone.js + @tonejs/midi.
 *
 * This hook is the **sole interface between the playback layer and the score
 * viewer** (docs/roadmap/component-3-score-viewer.md §14.4). The score viewer
 * calls `play()`, `pause()`, and `stop()`. It receives the current MIDI time
 * (milliseconds) via `onPositionUpdate`, which it uses to binary-search a
 * pre-built timemap schedule (from `buildHighlightSchedule`) and update the
 * SVG playback highlight. The timemap approach is used instead of
 * `getElementsAtTime` because `renderToTimemap` correctly expands repeats:
 * each note appears once per pass at the appropriate timestamp, so volta
 * brackets highlight the right ending on each pass.
 *
 * SoundFont setup (Step 14.2):
 *   Set VITE_SOUNDFONT_BASE_URL in .env to the MinIO or R2 base URL. The
 *   sampler loads files at `{base}/soundfonts/piano/{note}.mp3`. File names
 *   use Tone.js note convention: C4.mp3, Ds4.mp3 (D#4), Fs4.mp3 (F#4), etc.
 *   If VITE_SOUNDFONT_BASE_URL is not set, the sampler will attempt to load
 *   from '' and fail silently — the status stays 'loading-instrument'.
 *
 * Autoplay policy (Step 14.1):
 *   `Tone.start()` is called inside `play()`, which is triggered by a user
 *   gesture (the play button). AudioContext is never started on mount.
 *
 * midiBase64 lifecycle:
 *   - null: no MIDI available (score not loaded). Play is disabled.
 *   - string: base64 MIDI from Verovio renderToMIDI(). When this changes
 *     (e.g. after transposition), the hook stops playback and prepares to
 *     reschedule on the next `play()` call.
 *
 * Fragment window (Component 9 Step 18):
 *   `options.window` constrains playback to a time span of the supplied MIDI.
 *   Verovio's renderToMIDI() ignores the fragment `select()`, so the fragment
 *   viewer passes the *whole-movement* MIDI plus the fragment's
 *   `{ startMs, endMs }` window (from `buildFragmentPlayback`). The hook
 *   schedules only the notes inside the window, shifted so the fragment starts
 *   at transport time 0, and schedules an automatic stop at the window's end so
 *   playback never spills past the fragment. With no window (the full score
 *   viewer) playback is unchanged. `options.onEnded` fires when playback
 *   reaches the window's end, letting the caller clear its own highlights.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Tone from 'tone';
import { Midi } from '@tonejs/midi';
import type { FragmentTimeWindow } from '../services/verovio';

// ---------------------------------------------------------------------------
// SoundFont configuration
// ---------------------------------------------------------------------------

/**
 * Base URL for SoundFont audio files (MinIO in dev, Cloudflare R2 in prod).
 * Convention: `{SOUNDFONT_BASE_URL}/soundfonts/piano/{note}.mp3`
 * Note names: C4.mp3, Ds4.mp3 (D#4), Fs4.mp3 (F#4), A4.mp3, etc.
 */
const SOUNDFONT_BASE_URL: string = import.meta.env['VITE_SOUNDFONT_BASE_URL'] ?? '';

/**
 * Compact piano sample map. Keys are Tone.js note names (must use `#` for
 * sharps); values are filenames using the `s`-suffix convention (URL-safe).
 * Tone.Sampler pitch-shifts between provided samples to cover the full MIDI
 * keyboard range (C1–C7).
 *
 * Key  = Tone.js note name, e.g. "D#4"  (sharp with `#`)
 * Value = filename,         e.g. "Ds4.mp3" (sharp with `s`, URL-safe)
 */
const PIANO_SAMPLE_URLS: Record<string, string> = {
  C1: 'C1.mp3',
  'D#1': 'Ds1.mp3',
  'F#1': 'Fs1.mp3',
  A1: 'A1.mp3',
  C2: 'C2.mp3',
  'D#2': 'Ds2.mp3',
  'F#2': 'Fs2.mp3',
  A2: 'A2.mp3',
  C3: 'C3.mp3',
  'D#3': 'Ds3.mp3',
  'F#3': 'Fs3.mp3',
  A3: 'A3.mp3',
  C4: 'C4.mp3',
  'D#4': 'Ds4.mp3',
  'F#4': 'Fs4.mp3',
  A4: 'A4.mp3',
  C5: 'C5.mp3',
  'D#5': 'Ds5.mp3',
  'F#5': 'Fs5.mp3',
  A5: 'A5.mp3',
  C6: 'C6.mp3',
  'D#6': 'Ds6.mp3',
  'F#6': 'Fs6.mp3',
  A6: 'A6.mp3',
  C7: 'C7.mp3',
  'D#7': 'Ds7.mp3',
  'F#7': 'Fs7.mp3',
  A7: 'A7.mp3',
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Playback lifecycle states exposed to the score viewer. */
export type PlaybackStatus =
  | 'idle' // No MIDI available; play button disabled.
  | 'loading-instrument' // SoundFont loading on first play click.
  | 'instrument-error' // SoundFont failed to load (404, timeout, etc.). Retryable.
  | 'ready' // MIDI available, not playing. Play enabled.
  | 'playing' // Transport running.
  | 'paused'; // Transport paused at current position.

/** 1-indexed bar and beat position, updated during playback via RAF. */
export interface PlaybackPosition {
  /** 1-indexed measure number. */
  bar: number;
  /** 1-indexed beat within the measure. */
  beat: number;
}

/** Optional behaviour modifiers for fragment-scoped playback (Step 18). */
export interface MidiPlaybackOptions {
  /**
   * Constrain playback to a window of the supplied MIDI (whole-movement) so
   * only the fragment sounds. `null`/omitted plays the entire MIDI.
   */
  window?: FragmentTimeWindow | null;
  /** Called when playback reaches the window end (auto-stop). */
  onEnded?: () => void;
  /**
   * Play-from-position origin (Component 9 Step 20): start playback at this
   * offset (ms) into the supplied MIDI, shifted so the origin is transport time
   * 0. `0`/omitted starts at the beginning. Composes with `window` by taking the
   * later of the two starts; the window end (if any) still bounds playback.
   *
   * The caller's `onPositionUpdate` handler must add `originMs` back when
   * querying an *absolute* (whole-movement) schedule/caret track, since the
   * transport time it receives is origin-relative.
   */
  originMs?: number;
}

export interface UseMidiPlaybackResult {
  /** Current playback lifecycle state. */
  status: PlaybackStatus;
  /** Current bar and beat (1-indexed), updated at ~60fps during playback. */
  position: PlaybackPosition;
  /**
   * Start (or resume) playback.
   * - On first call: starts AudioContext, loads SoundFont, schedules MIDI.
   * - On subsequent calls (after pause): resumes the transport.
   * - Always triggers from a user gesture — never called on mount.
   */
  play: () => Promise<void>;
  /** Pause at current position. Resumable via play(). */
  pause: () => void;
  /** Stop and reset to beginning. Clears all scheduled events. */
  stop: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Lead time (seconds) given to a freshly-started transport before its first
 * scheduled event fires (Component 9 F2). A note scheduled at transport-
 * relative time 0 — the origin note of a play-from-position, or simply the
 * first note of the piece — races `transport.start()`: the Web Audio clock's
 * lookahead loop hasn't started ticking yet when `start()` returns
 * synchronously, so an event due at time 0 can be silently dropped. Starting
 * the transport `START_LOOKAHEAD_SEC` in the future (not touching any note's
 * scheduled offset) gives the lookahead loop a chance to see it; every
 * relative offset scheduled via `transport.schedule()`/`scheduleOnce()` stays
 * correct regardless of when transport time 0 lands in real time, so this
 * shifts the whole playback later by a barely-perceptible, uniform amount
 * rather than desyncing individual notes.
 */
const START_LOOKAHEAD_SEC = 0.05;

/**
 * Decode a base64 string (from Verovio renderToMIDI()) to a Uint8Array
 * suitable for the @tonejs/midi Midi constructor.
 */
function base64ToUint8Array(base64: string): Uint8Array {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  return bytes;
}

/**
 * Parse a Tone.js position string ("BBB:BB:SSS", 0-indexed) to a
 * 1-indexed PlaybackPosition for display.
 */
function parseTransportPosition(posStr: string): PlaybackPosition {
  const parts = posStr.split(':').map(Number);
  return {
    bar: (parts[0] ?? 0) + 1,
    beat: (parts[1] ?? 0) + 1,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * React hook for MIDI playback. See module-level doc for full context.
 *
 * @param midiBase64 - Base64-encoded MIDI from Verovio renderToMIDI(), or
 *   null when the score is not yet rendered or MIDI generation failed.
 * @param onPositionUpdate - Called on each animation frame during playback
 *   with the current MIDI time in milliseconds. The score viewer uses it to
 *   drive the playback caret (Step 19) from the pre-built timemap schedule /
 *   caret track, and to update the transport bar. No Verovio calls happen at
 *   playback time.
 */
export function useMidiPlayback(
  midiBase64: string | null,
  onPositionUpdate: (timeMs: number) => void,
  options: MidiPlaybackOptions = {}
): UseMidiPlaybackResult {
  const [status, setStatus] = useState<PlaybackStatus>('idle');
  const [position, setPosition] = useState<PlaybackPosition>({ bar: 1, beat: 1 });

  // Refs: stable identities, safe to read inside async callbacks.
  const samplerRef = useRef<Tone.Sampler | null>(null);
  const samplerLoadedRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  // Keep onPositionUpdate current without making it a play() dep.
  const onPositionUpdateRef = useRef(onPositionUpdate);
  // Keep midiBase64 current without making it a play() dep.
  const midiBase64Ref = useRef(midiBase64);
  // Fragment window + end callback, read at play() time (no play() deps).
  const windowRef = useRef<FragmentTimeWindow | null>(options.window ?? null);
  const onEndedRef = useRef<MidiPlaybackOptions['onEnded']>(options.onEnded);
  // Play-from-position origin (Step 20), read at play() time (no play() deps).
  const originMsRef = useRef<number>(options.originMs ?? 0);

  useEffect(() => {
    onPositionUpdateRef.current = onPositionUpdate;
  }, [onPositionUpdate]);

  useEffect(() => {
    midiBase64Ref.current = midiBase64;
  }, [midiBase64]);

  useEffect(() => {
    windowRef.current = options.window ?? null;
  }, [options.window]);

  useEffect(() => {
    onEndedRef.current = options.onEnded;
  }, [options.onEnded]);

  useEffect(() => {
    originMsRef.current = options.originMs ?? 0;
  }, [options.originMs]);

  // ── RAF position tracking ──────────────────────────────────────────────────

  const stopTracking = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  const startTracking = useCallback(() => {
    stopTracking();
    const tick = () => {
      const transport = Tone.getTransport();
      // Notify the score viewer with current MIDI time for SVG highlight.
      onPositionUpdateRef.current(transport.seconds * 1000);
      // Update position display for the playback bar.
      setPosition(parseTransportPosition(transport.position.toString()));
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [stopTracking]);

  // ── midiBase64 changes (e.g. transposition) ──────────────────────────────

  /**
   * When MIDI changes, stop playback so the next play() call reschedules from
   * the new MIDI. Events are cleared in play() (not here) so that the
   * transport is in a clean state before the new schedule is applied.
   * Status 14.6: "If playback is in progress, stop it first."
   */
  useEffect(() => {
    const transport = Tone.getTransport();
    if (transport.state === 'started' || transport.state === 'paused') {
      transport.stop();
      transport.cancel();
    }
    stopTracking();
    setPosition({ bar: 1, beat: 1 });
    if (midiBase64 !== null) {
      // Don't interrupt 'loading-instrument' — play() will advance status.
      setStatus((prev) => (prev !== 'loading-instrument' ? 'ready' : prev));
    } else {
      setStatus('idle');
    }
  }, [midiBase64, stopTracking]);

  // ── Transport controls ─────────────────────────────────────────────────────

  /**
   * Reset transport to the fragment start and return to 'ready' when playback
   * reaches the window end. Held in a ref so the transport-scheduled callback
   * always calls the latest closure. Mirrors stop() but also fires onEnded so
   * the caller can clear its own highlight state.
   */
  const endPlaybackRef = useRef<() => void>(() => {});
  endPlaybackRef.current = () => {
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();
    transport.position = '0:0:0';
    // Release any notes still sounding at the window boundary (F1): the
    // sampler holds a note until explicitly released, and transport.cancel()
    // only drops *future* scheduled events, not an already-triggered voice.
    samplerRef.current?.releaseAll();
    stopTracking();
    setPosition({ bar: 1, beat: 1 });
    setStatus(midiBase64Ref.current !== null ? 'ready' : 'idle');
    onEndedRef.current?.();
  };

  /**
   * Start playback. On the first call, starts the AudioContext (requires user
   * gesture) and loads the SoundFont. On subsequent calls after pause, resumes.
   * Always reschedules MIDI from the beginning (except when resuming a pause).
   */
  const play = useCallback(async () => {
    const midi64 = midiBase64Ref.current;
    if (!midi64) return;

    const transport = Tone.getTransport();

    // Resume from pause: events already scheduled, just restart transport.
    if (transport.state === 'paused' && samplerLoadedRef.current) {
      transport.start();
      setStatus('playing');
      startTracking();
      return;
    }

    // First play: start AudioContext (browser autoplay policy) and load SoundFont.
    if (!samplerLoadedRef.current) {
      setStatus('loading-instrument');
      await Tone.start();

      const loadResult = await new Promise<'ok' | 'error'>((resolve) => {
        // Tone.js calls onerror for each sample that fails to fetch (e.g. 404).
        // We resolve 'error' on the first failure; subsequent calls are no-ops
        // on the already-settled promise.
        // A 10 s timeout guards against silently hanging when the URL is
        // reachable but returns nothing (e.g. VITE_SOUNDFONT_BASE_URL unset →
        // requests go to the Vite dev server which never 404s synchronously).
        let settled = false;
        const timer = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve('error');
          }
        }, 10_000);

        samplerRef.current = new Tone.Sampler({
          urls: PIANO_SAMPLE_URLS,
          baseUrl: `${SOUNDFONT_BASE_URL}/soundfonts/piano/`,
          onload: () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve('ok');
            }
          },
          onerror: () => {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve('error');
            }
          },
        }).toDestination();
      });

      if (loadResult === 'error') {
        setStatus('instrument-error');
        return;
      }
      samplerLoadedRef.current = true;
    }

    // Clear any previous schedule and reset to beginning.
    transport.cancel();
    transport.stop();
    transport.position = '0:0:0';

    // Parse MIDI and schedule all note events on the transport.
    const bytes = base64ToUint8Array(midi64);
    const midiData = new Midi(bytes.buffer as ArrayBuffer);

    // Fragment window (Step 18) + play-from-position origin (Step 20): only the
    // notes between startSec and endSec sound, shifted so the start is transport
    // time 0. startSec is the later of the fragment window start and the
    // play-from-position origin; with neither set, startSec=0 / endSec=∞
    // reproduces whole-movement playback exactly.
    const win = windowRef.current;
    const startSec = Math.max(win?.startMs ?? 0, originMsRef.current) / 1000;
    const endSec = win && Number.isFinite(win.endMs) ? win.endMs / 1000 : Number.POSITIVE_INFINITY;
    const EPS_SEC = 1e-4;

    // Sync the Tone.js Transport tempo and time signature with the actual MIDI
    // header so the position display counts bars and beats at the correct
    // musical rate. Without this, the transport always assumes 120 BPM and 4/4,
    // making the position display wrong for any other tempo or meter.
    //
    // Multiple tempo changes are scheduled via bpm.setValueAtTime() so a ritard
    // or accelerando mid-piece is reflected in the position display. Within a
    // window, the initial BPM is the tempo in force at the fragment start and
    // later changes are shifted into fragment-relative time.
    // Tone.js supports only a single static time signature — mid-piece meter
    // changes are not tracked in the display (acceptable limitation).
    const tempos = midiData.header?.tempos ?? [];
    const timeSignatures = midiData.header?.timeSignatures ?? [];
    if (tempos.length > 0) {
      transport.bpm.cancelScheduledValues(0);
      // Initial BPM = the last tempo at or before the window start.
      let initialBpm = tempos[0].bpm;
      for (const t of tempos) {
        if ((t.time ?? 0) <= startSec + EPS_SEC) initialBpm = t.bpm;
      }
      transport.bpm.value = initialBpm;
      for (const t of tempos) {
        const tt = t.time ?? 0;
        if (tt > startSec + EPS_SEC && tt < endSec) {
          transport.bpm.setValueAtTime(t.bpm, tt - startSec);
        }
      }
    }
    if (timeSignatures.length > 0) {
      transport.timeSignature = timeSignatures[0].timeSignature;
    }

    midiData.tracks.forEach((track) => {
      track.notes.forEach((note) => {
        if (note.time < startSec - EPS_SEC || note.time >= endSec - EPS_SEC) return;
        transport.schedule((audioTime) => {
          samplerRef.current?.triggerAttackRelease(
            note.name,
            note.duration,
            audioTime,
            note.velocity
          );
        }, note.time - startSec);
      });
    });

    // Auto-stop at the window end so playback never spills past the fragment.
    if (Number.isFinite(endSec)) {
      transport.scheduleOnce(() => {
        endPlaybackRef.current();
      }, endSec - startSec);
    }

    // Lookahead-delayed start (F2) — see START_LOOKAHEAD_SEC. Only the fresh-
    // schedule path needs it; resuming from pause (above) doesn't reschedule
    // anything at time 0, so it isn't subject to the same race.
    transport.start(`+${START_LOOKAHEAD_SEC}`);
    setStatus('playing');
    startTracking();
  }, [startTracking]);

  /** Pause at the current position. Call play() to resume. */
  const pause = useCallback(() => {
    Tone.getTransport().pause();
    // Release any notes still sounding (F1): pausing the transport stops
    // *future* scheduled attacks but does not release an already-triggered
    // voice, so a note struck just before the pause point rings indefinitely.
    samplerRef.current?.releaseAll();
    stopTracking();
    setStatus('paused');
  }, [stopTracking]);

  /**
   * Stop playback and reset to the beginning. Clears all scheduled events.
   * The SVG highlight is cleared separately by the score viewer's handleStop
   * wrapper (which has access to the highlightedElRef).
   */
  const stop = useCallback(() => {
    const transport = Tone.getTransport();
    transport.stop();
    transport.cancel();
    transport.position = '0:0:0';
    // Release any notes still sounding (F1) — see pause() for why this is
    // needed in addition to transport.stop()/cancel().
    samplerRef.current?.releaseAll();
    stopTracking();
    setPosition({ bar: 1, beat: 1 });
    // If MIDI is available, return to ready (not idle) after stop.
    setStatus(midiBase64Ref.current !== null ? 'ready' : 'idle');
  }, [stopTracking]);

  // ── Cleanup on unmount ─────────────────────────────────────────────────────

  useEffect(() => {
    return () => {
      stopTracking();
      const transport = Tone.getTransport();
      transport.cancel();
      transport.stop();
      if (samplerRef.current) {
        samplerRef.current.dispose();
        samplerRef.current = null;
        samplerLoadedRef.current = false;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // intentionally empty — runs only on unmount

  return { status, position, play, pause, stop };
}
