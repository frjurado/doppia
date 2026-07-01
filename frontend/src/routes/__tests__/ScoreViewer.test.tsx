import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ScoreViewer from '../ScoreViewer';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/verovio', () => ({
  getVerovioToolkit: vi.fn(),
  renderProgressively: vi.fn(),
  renderMidi: vi.fn(),
  buildHighlightSchedule: vi.fn().mockReturnValue([]),
  buildMeasureOnsetIndex: vi.fn().mockReturnValue(new Map()),
  buildNoteInfoMap: vi.fn().mockReturnValue(new Map()),
  collectGraceNoteIds: vi.fn().mockReturnValue(new Set()),
  getTimemapTempo: vi.fn().mockReturnValue(120),
  parseMeiMeterUnit: vi.fn().mockReturnValue(4),
}));

vi.mock('../../services/scoreApi', () => ({
  fetchMeiUrl: vi.fn(),
}));

// Tone.js mock — stable transport object so state persists across getTransport() calls.
const mockTransport = {
  state: 'stopped' as string,
  seconds: 0,
  position: '0:0:0',
  start: vi.fn(function (this: typeof mockTransport) {
    this.state = 'started';
  }),
  stop: vi.fn(function (this: typeof mockTransport) {
    this.state = 'stopped';
  }),
  pause: vi.fn(function (this: typeof mockTransport) {
    this.state = 'paused';
  }),
  cancel: vi.fn(),
  schedule: vi.fn(),
};

/**
 * Default Sampler implementation — calls onload synchronously so instrument
 * loading resolves immediately in tests. Must use a regular function (not an
 * arrow function) because the hook instantiates it with `new Tone.Sampler()`.
 */
function makeSamplerImpl(this: unknown, options?: { onload?: () => void }) {
  const onload = options?.onload;
  if (onload) Promise.resolve().then(onload);
  return {
    toDestination: vi.fn().mockReturnThis(),
    triggerAttackRelease: vi.fn(),
    releaseAll: vi.fn(),
    dispose: vi.fn(),
  };
}

vi.mock('tone', () => ({
  start: vi.fn().mockResolvedValue(undefined),
  getTransport: vi.fn(() => mockTransport),
  Sampler: vi.fn().mockImplementation(makeSamplerImpl),
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

import * as verovioService from '../../services/verovio';
import * as scoreApi from '../../services/scoreApi';
import * as Tone from 'tone';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_MOVEMENT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

/** Render ScoreViewer at /scores/:movementId using a MemoryRouter. */
function renderScoreViewer(movementId = TEST_MOVEMENT_ID, qs = '') {
  return render(
    <MemoryRouter initialEntries={[`/scores/${movementId}${qs}`]}>
      <Routes>
        <Route path="/scores/:movementId" element={<ScoreViewer />} />
      </Routes>
    </MemoryRouter>
  );
}

/** A minimal SVG string that the DOM can parse. */
const MOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" data-testid="score-page"><rect /></svg>';

/** A valid-enough base64 string (Verovio renderToMIDI output placeholder). */
const MOCK_MIDI_BASE64 = btoa('MIDI');

/**
 * Sets up all mocks for a fully-loaded score (MEI fetched, WASM ready,
 * pages rendered, MIDI generated).
 */
function setupFullLoad() {
  vi.mocked(scoreApi.fetchMeiUrl).mockResolvedValue({ url: 'https://example.test/test.mei' });
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    text: () => Promise.resolve('<mei>test</mei>'),
  } as Response);
  vi.mocked(verovioService.getVerovioToolkit).mockResolvedValue({
    getElementsAtTime: vi.fn().mockReturnValue('{"notes":[],"chords":[]}'),
  } as never);
  vi.mocked(verovioService.renderProgressively).mockImplementation(
    async (_tk, _mei, _opts, onPage, onComplete) => {
      onPage(MOCK_SVG, 1);
      onComplete(1);
    }
  );
  vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  // clearAllMocks: clears call counts and results but PRESERVES implementations.
  // resetAllMocks would clear the Sampler mock implementation set in vi.mock().
  vi.clearAllMocks();
  // Restore vi.spyOn() spies (e.g. fetch) to their real implementations.
  vi.restoreAllMocks();

  // Re-apply Sampler default implementation in case a previous test overrode it.
  vi.mocked(Tone.Sampler).mockImplementation(makeSamplerImpl as never);

  // Reset transport state between tests.
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
// Tests — loading and error states (Step 12.3)
// ---------------------------------------------------------------------------

describe('ScoreViewer', () => {
  it('shows a loading label while the MEI is being fetched', () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.getVerovioToolkit).mockResolvedValue({} as never);
    vi.mocked(verovioService.renderProgressively).mockResolvedValue(undefined);
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    expect(screen.getByText(/loading score/i)).toBeInTheDocument();
  });

  it('shows a renderer loading label while the WASM is initialising', async () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockResolvedValue({ url: 'https://example.test/test.mei' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<mei>test</mei>'),
    } as Response);
    vi.mocked(verovioService.getVerovioToolkit).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    await waitFor(() => {
      expect(screen.getByText(/loading score renderer/i)).toBeInTheDocument();
    });
  });

  it('renders SVG pages in the DOM once loading completes', async () => {
    setupFullLoad();
    renderScoreViewer();

    await waitFor(() => {
      expect(document.querySelector('[data-testid="score-page"]')).toBeInTheDocument();
    });
  });

  it('renders multiple pages when renderProgressively emits more than one', async () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockResolvedValue({ url: 'https://example.test/test.mei' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<mei>test</mei>'),
    } as Response);
    vi.mocked(verovioService.getVerovioToolkit).mockResolvedValue({} as never);
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    vi.mocked(verovioService.renderProgressively).mockImplementation(
      async (_tk, _mei, _opts, onPage, onComplete) => {
        onPage('<svg data-testid="page-1"><rect /></svg>', 1);
        onPage('<svg data-testid="page-2"><rect /></svg>', 2);
        onComplete(2);
      }
    );

    renderScoreViewer();

    await waitFor(() => {
      expect(document.querySelector('[data-testid="page-1"]')).toBeInTheDocument();
      expect(document.querySelector('[data-testid="page-2"]')).toBeInTheDocument();
    });
  });

  it('shows an error message when the MEI URL fetch fails', async () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockRejectedValue(new Error('Movement not found'));
    vi.mocked(verovioService.getVerovioToolkit).mockResolvedValue({} as never);
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    await waitFor(() => {
      expect(screen.getByText(/movement not found/i)).toBeInTheDocument();
    });
  });

  it('shows an error message when the MEI HTTP fetch fails', async () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockResolvedValue({ url: 'https://example.test/test.mei' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      text: () => Promise.resolve(''),
    } as Response);
    vi.mocked(verovioService.getVerovioToolkit).mockResolvedValue({} as never);
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    await waitFor(() => {
      expect(screen.getByText(/mei fetch failed/i)).toBeInTheDocument();
    });
  });

  it('renders the toolbar with staff size and transposition controls', () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    // Controls are in the toolbar, which renders immediately (before loading completes).
    expect(screen.getByText('Small')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('Large')).toBeInTheDocument();
    expect(screen.getByLabelText(/transpose/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/music font/i)).not.toBeInTheDocument();
  });

  it('transpose options use m2/−m2 (not d2/−d2) for semitone intervals', () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    // The trigger button is labelled by the "Transpose" label element.
    const trigger = screen.getByLabelText(/transpose/i);
    // Default selection is "No transposition".
    expect(trigger).toHaveTextContent(/no transposition/i);
    // The old broken interval strings must not appear anywhere in the DOM.
    expect(document.body.textContent).not.toMatch(/\bd2\b/);
  });

  it('shows interval options including "Minor 2nd up"', async () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    const user = userEvent.setup();
    renderScoreViewer();

    const trigger = screen.getByLabelText(/transpose/i);
    await user.click(trigger);

    expect(screen.getByText(/minor 2nd up/i)).toBeInTheDocument();
    expect(screen.getByText(/perfect 4th up/i)).toBeInTheDocument();
    expect(screen.getByText(/tritone up/i)).toBeInTheDocument();
    // Old labels must not appear.
    expect(screen.queryByText(/up a semitone/i)).toBeNull();
    expect(screen.queryByText(/up a tone/i)).toBeNull();
  });

  it('shows resultant key hint when ?key= query param is present', async () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    const user = userEvent.setup();
    renderScoreViewer(TEST_MOVEMENT_ID, '?key=G%20major');

    const trigger = screen.getByLabelText(/transpose/i);
    await user.click(trigger);

    // "Minor 2nd up" applied to G major → A♭ major
    expect(screen.getByText(/A♭ major/)).toBeInTheDocument();
  });

  it('renders a back-to-browse link in the toolbar', () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    expect(screen.getByText(/browse/i)).toBeInTheDocument();
  });

  it('renders an h1 heading for screen readers', () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    expect(screen.getByRole('heading', { level: 1, name: /score viewer/i })).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Tests — playback bar (Step 14.7)
  // ---------------------------------------------------------------------------

  it('renders the playback bar with play and stop buttons', () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    expect(screen.getByRole('button', { name: /play/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });

  it('disables the play button before the score is loaded', () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);

    renderScoreViewer();

    expect(screen.getByRole('button', { name: /play/i })).toBeDisabled();
  });

  it('enables the play button after MIDI is generated', async () => {
    setupFullLoad();
    renderScoreViewer();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /play/i })).not.toBeDisabled();
    });
  });

  it('calls Tone.start() and Transport.start() when play is clicked', async () => {
    setupFullLoad();
    renderScoreViewer();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /play/i })).not.toBeDisabled();
    });

    await userEvent.click(screen.getByRole('button', { name: /play/i }));

    await waitFor(() => {
      expect(Tone.start).toHaveBeenCalledTimes(1);
      expect(mockTransport.start).toHaveBeenCalledTimes(1);
    });
  });

  it('shows "Loading instrument…" while the SoundFont is loading', async () => {
    setupFullLoad();
    // Override Sampler so onload is never called (simulates slow/missing SoundFont).
    vi.mocked(Tone.Sampler).mockImplementation(function neverLoads(this: unknown) {
      return {
        toDestination: vi.fn().mockReturnThis(),
        triggerAttackRelease: vi.fn(),
        releaseAll: vi.fn(),
        dispose: vi.fn(),
      };
    } as never);

    renderScoreViewer();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /play/i })).not.toBeDisabled();
    });

    // Click play — instrument loading starts but never resolves.
    userEvent.click(screen.getByRole('button', { name: /play/i }));

    await waitFor(() => {
      expect(screen.getByText(/loading instrument/i)).toBeInTheDocument();
    });
  });

  it('switches play button to pause icon while playing', async () => {
    setupFullLoad();
    renderScoreViewer();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /play/i })).not.toBeDisabled();
    });

    await userEvent.click(screen.getByRole('button', { name: /play/i }));

    // After play() resolves, button label should switch to Pause.
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /pause/i })).toBeInTheDocument();
    });
  });

  it('calls Transport.stop() and resets position when stop is clicked', async () => {
    setupFullLoad();
    renderScoreViewer();

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /play/i })).not.toBeDisabled();
    });

    await userEvent.click(screen.getByRole('button', { name: /play/i }));
    await waitFor(() => screen.getByRole('button', { name: /pause/i }));

    await userEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(mockTransport.stop).toHaveBeenCalled();
    expect(mockTransport.cancel).toHaveBeenCalled();
    // Play button should reappear (not paused).
    expect(screen.getByRole('button', { name: /play/i })).toBeInTheDocument();
  });

  it('shows position display in bar:beat format once MIDI is ready', async () => {
    setupFullLoad();
    renderScoreViewer();

    await waitFor(() => {
      // Position display shows "1:1" once MIDI loads and status is ready.
      expect(screen.getByText('1:1')).toBeInTheDocument();
    });
  });
});
