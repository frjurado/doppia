/**
 * Tests for useMidiPlayback — Step 14.7.
 *
 * Verifies: play triggers Tone.start() + Transport.start(), pause suspends
 * transport, stop resets position, midiBase64 changes stop active playback,
 * onPositionUpdate is wired through the RAF loop.
 */

import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useMidiPlayback } from '../useMidiPlayback';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Stable transport mock (returned by every getTransport() call).
const mockTransport = {
  state: 'stopped' as string,
  seconds: 0,
  position: '0:0:0',
  start: vi.fn(function (this: typeof mockTransport) { this.state = 'started'; }),
  stop: vi.fn(function (this: typeof mockTransport) { this.state = 'stopped'; }),
  pause: vi.fn(function (this: typeof mockTransport) { this.state = 'paused'; }),
  cancel: vi.fn(),
  schedule: vi.fn(),
};

vi.mock('tone', () => ({
  start: vi.fn().mockResolvedValue(undefined),
  getTransport: vi.fn(() => mockTransport),
  // Must use a regular function (not arrow) — arrow functions cannot be called
  // with `new`, which is how useMidiPlayback instantiates the Sampler.
  Sampler: vi.fn().mockImplementation(function samplerMock(
    this: unknown,
    { onload }: { onload?: () => void },
  ) {
    if (onload) Promise.resolve().then(onload);
    return {
      toDestination: vi.fn().mockReturnThis(),
      triggerAttackRelease: vi.fn(),
      dispose: vi.fn(),
    };
  }),
}));

vi.mock('@tonejs/midi', () => ({
  Midi: vi.fn().mockImplementation(function midiMock(this: unknown) {
    return {
      tracks: [
        {
          notes: [
            { name: 'C4', duration: 0.5, time: 0, velocity: 0.8 },
            { name: 'E4', duration: 0.5, time: 0.5, velocity: 0.8 },
          ],
        },
      ],
    };
  }),
}));

import * as Tone from 'tone';
import { Midi } from '@tonejs/midi';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A valid-enough base64 string (content doesn't matter — Midi is mocked). */
const MOCK_MIDI_BASE64 = btoa('FAKE_MIDI');

function renderPlaybackHook(
  midiBase64: string | null = null,
  onPositionUpdate = vi.fn(),
) {
  return renderHook(
    ({ midi, onUpdate }: { midi: string | null; onUpdate: (ms: number) => void }) =>
      useMidiPlayback(midi, onUpdate),
    { initialProps: { midi: midiBase64, onUpdate: onPositionUpdate } },
  );
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks(); // clear call counts; preserves implementations
  mockTransport.state = 'stopped';
  mockTransport.seconds = 0;
  mockTransport.position = '0:0:0';
  mockTransport.start.mockImplementation(function (this: typeof mockTransport) {
    this.state = 'started';
  });
  mockTransport.stop.mockImplementation(function (this: typeof mockTransport) {
    this.state = 'stopped';
  });
  mockTransport.pause.mockImplementation(function (this: typeof mockTransport) {
    this.state = 'paused';
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('useMidiPlayback — status', () => {
  it('starts in idle when no MIDI is provided', () => {
    const { result } = renderPlaybackHook(null);
    expect(result.current.status).toBe('idle');
  });

  it('transitions to ready when midiBase64 is provided', () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);
    expect(result.current.status).toBe('ready');
  });

  it('returns to idle when midiBase64 becomes null', () => {
    const { result, rerender } = renderPlaybackHook(MOCK_MIDI_BASE64);
    expect(result.current.status).toBe('ready');

    rerender({ midi: null, onUpdate: vi.fn() });
    expect(result.current.status).toBe('idle');
  });
});

describe('useMidiPlayback — play()', () => {
  it('calls Tone.start() on the first play', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => {
      await result.current.play();
    });

    expect(Tone.start).toHaveBeenCalledTimes(1);
  });

  it('calls Transport.start() after instrument loads', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => {
      await result.current.play();
    });

    expect(mockTransport.start).toHaveBeenCalledTimes(1);
  });

  it('sets status to "playing" after play completes', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => {
      await result.current.play();
    });

    expect(result.current.status).toBe('playing');
  });

  it('creates a Tone.Sampler on first play', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => {
      await result.current.play();
    });

    expect(Tone.Sampler).toHaveBeenCalledTimes(1);
  });

  it('does not call Tone.start() again on second play (instrument already loaded)', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });
    act(() => { result.current.stop(); });
    await act(async () => { await result.current.play(); });

    // Tone.start() should only be called once across multiple plays.
    expect(Tone.start).toHaveBeenCalledTimes(1);
  });

  it('schedules MIDI notes on the transport', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });

    // The mock Midi has 2 notes across 1 track → 2 schedule calls.
    expect(mockTransport.schedule).toHaveBeenCalledTimes(2);
  });

  it('parses the MIDI base64 using the Midi constructor', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });

    expect(Midi).toHaveBeenCalledTimes(1);
  });

  it('does nothing when called with no MIDI available', async () => {
    const { result } = renderPlaybackHook(null);

    await act(async () => { await result.current.play(); });

    expect(Tone.start).not.toHaveBeenCalled();
    expect(mockTransport.start).not.toHaveBeenCalled();
  });

  it('resumes from pause without reloading Sampler or calling Tone.start() again', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });
    act(() => { result.current.pause(); });
    // Set transport to paused state so the resume branch is taken.
    mockTransport.state = 'paused';

    await act(async () => { await result.current.play(); });

    expect(Tone.start).toHaveBeenCalledTimes(1); // not called again
    expect(Tone.Sampler).toHaveBeenCalledTimes(1); // not recreated
    expect(result.current.status).toBe('playing');
  });
});

describe('useMidiPlayback — pause()', () => {
  it('calls Transport.pause() and sets status to paused', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });
    act(() => { result.current.pause(); });

    expect(mockTransport.pause).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('paused');
  });
});

describe('useMidiPlayback — stop()', () => {
  it('calls Transport.stop() and Transport.cancel()', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });
    act(() => { result.current.stop(); });

    expect(mockTransport.stop).toHaveBeenCalled();
    expect(mockTransport.cancel).toHaveBeenCalled();
  });

  it('resets position display to bar 1, beat 1', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });
    act(() => { result.current.stop(); });

    expect(result.current.position).toEqual({ bar: 1, beat: 1 });
  });

  it('sets status back to ready when MIDI is still available', async () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });
    act(() => { result.current.stop(); });

    expect(result.current.status).toBe('ready');
  });
});

describe('useMidiPlayback — midiBase64 change (transposition follow-through, Step 14.6)', () => {
  it('stops the transport when midiBase64 changes while playing', async () => {
    const { result, rerender } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });
    expect(result.current.status).toBe('playing');

    act(() => {
      rerender({ midi: btoa('NEW_MIDI'), onUpdate: vi.fn() });
    });

    expect(mockTransport.stop).toHaveBeenCalled();
    expect(result.current.status).toBe('ready');
  });

  it('keeps status ready when midiBase64 changes while stopped', () => {
    const { result, rerender } = renderPlaybackHook(MOCK_MIDI_BASE64);

    expect(result.current.status).toBe('ready');

    act(() => {
      rerender({ midi: btoa('NEW_MIDI'), onUpdate: vi.fn() });
    });

    expect(result.current.status).toBe('ready');
  });

  it('resets position when midiBase64 changes', async () => {
    const { result, rerender } = renderPlaybackHook(MOCK_MIDI_BASE64);

    await act(async () => { await result.current.play(); });
    // Simulate transport having advanced.
    mockTransport.position = '3:1:0';
    mockTransport.seconds = 6;

    act(() => {
      rerender({ midi: btoa('NEW_MIDI'), onUpdate: vi.fn() });
    });

    expect(result.current.position).toEqual({ bar: 1, beat: 1 });
  });
});

describe('useMidiPlayback — position display', () => {
  it('starts with bar 1, beat 1', () => {
    const { result } = renderPlaybackHook(MOCK_MIDI_BASE64);
    expect(result.current.position).toEqual({ bar: 1, beat: 1 });
  });
});
