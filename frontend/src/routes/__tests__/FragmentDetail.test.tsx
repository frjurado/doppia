/**
 * FragmentDetail tests — Component 8 Step 14.
 *
 * Coverage:
 *  - Loading and error states.
 *  - Concept identity section: label (alias), hierarchy path, bar range,
 *    data_licence (as link), harmony_sources, secondary tags.
 *  - Verovio select spike fixtures: renderFragment is called with the correct
 *    mc_start/mc_end for linear (mid-system start), pickup-bar, and volta
 *    first/second-ending fragments (WASM Findings 1–3 from
 *    docs/architecture/mei-ingest-normalization.md §"WASM spike").
 *  - Rendering-context contract: getFragment called with only the id (mode=none
 *    default, ADR-024 — Phase 1 implements only this mode).
 *  - Scale controls: S/M/L buttons rendered; M (45) is the default (Component 9
 *    Step 15); selecting S re-renders at scale 35.
 *  - Measure/beat display rule (Component 9 Step 15): beats only within their
 *    measure's context; no beats for complete-measure fragments.
 *  - Playback controls: play button disabled while idle; enabled after MIDI loads.
 *  - FragmentDetailPanel rendered in standalone mode (record component shared
 *    with Component 7 side panel).
 *  - Sub-part bracket overlay: not rendered when measureRects is empty (jsdom
 *    limitation — SVG getBoundingClientRect always returns zeros, so readMeasureRects
 *    returns an empty map and the overlay guard fires false; tested explicitly).
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../services/api';
import * as conceptApi from '../../services/conceptApi';
import * as fragmentApi from '../../services/fragmentApi';
import type { FragmentDetailResponse } from '../../services/fragmentApi';
import * as verovioService from '../../services/verovio';
import * as Tone from 'tone';
import FragmentDetail from '../FragmentDetail';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/fragmentApi');
vi.mock('../../services/conceptApi');

vi.mock('../../services/verovio', () => ({
  getVerovioToolkit: vi.fn(),
  renderFragment: vi.fn(),
  renderMidi: vi.fn(),
  buildFragmentPlayback: vi.fn().mockReturnValue({
    window: { startMs: 0, endMs: Number.POSITIVE_INFINITY },
    schedule: [],
  }),
  buildNoteInfoMap: vi.fn().mockReturnValue(new Map()),
  collectGraceNoteIds: vi.fn().mockReturnValue(new Set()),
  getTimemapTempo: vi.fn().mockReturnValue(120),
  parseMeiMeterUnit: vi.fn().mockReturnValue(4),
}));

// Stable transport object whose state persists across getTransport() calls.
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

/** Sampler calls onload synchronously (via Promise.resolve) so instrument
 *  loading resolves in the same test tick without real audio. */
function makeSamplerImpl(this: unknown, options?: { onload?: () => void }) {
  const onload = options?.onload;
  if (onload) Promise.resolve().then(onload);
  return {
    toDestination: vi.fn().mockReturnThis(),
    triggerAttackRelease: vi.fn(),
    dispose: vi.fn(),
  };
}

vi.mock('tone', () => ({
  start: vi.fn().mockResolvedValue(undefined),
  getTransport: vi.fn(() => mockTransport),
  Sampler: vi.fn().mockImplementation(makeSamplerImpl),
}));

vi.mock('@tonejs/midi', () => ({
  Midi: vi.fn().mockImplementation(function (this: unknown) {
    return {
      tracks: [
        {
          notes: [
            { name: 'C4', duration: 0.5, time: 0, velocity: 0.8 },
          ],
        },
      ],
    };
  }),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" data-testid="fragment-svg"><rect /></svg>';
const MOCK_MIDI_BASE64 = btoa('MIDI');

function makeFragmentDetail(
  overrides: Partial<FragmentDetailResponse> = {},
): FragmentDetailResponse {
  return {
    id: 'frag-001',
    movement_id: 'mov-001',
    parent_fragment_id: null,
    bar_start: 1,
    bar_end: 4,
    mc_start: 1,
    mc_end: 4,
    beat_start: null,
    beat_end: null,
    repeat_context: null,
    summary: {
      version: 1,
      key: 'C',
      meter: '4/4',
      music21_version: null,
      concepts: ['PerfectAuthenticCadence'],
    },
    prose_annotation: null,
    data_licence: null,
    data_licence_url: null,
    harmony_sources: [],
    status: 'approved',
    created_by: 'user-1',
    created_at: '2024-01-01T00:00:00Z',
    updated_at: '2024-01-01T00:00:00Z',
    concept_tags: [
      {
        concept_id: 'PerfectAuthenticCadence',
        is_primary: true,
        name: 'Perfect Authentic Cadence',
        alias: 'PAC',
        hierarchy_path: ['Cadence', 'Authentic Cadence'],
      },
    ],
    harmony_events: [],
    sub_parts: [],
    composer_name: 'Mozart',
    work_title: 'Piano Sonata',
    work_catalogue_number: 'K. 331',
    movement_number: 1,
    movement_title: 'Andante grazioso',
    mei_url: 'https://mei.test/fragment.mei',
    preview_url: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Render / setup helpers
// ---------------------------------------------------------------------------

function renderDetail(fragmentId = 'frag-001') {
  return render(
    <MemoryRouter initialEntries={[`/fragments/${fragmentId}`]}>
      <Routes>
        <Route path="/fragments/:fragmentId" element={<FragmentDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

/**
 * Set up all mocks for a successfully-loaded fragment detail:
 * getFragment resolves, MEI fetch succeeds, Verovio renders SVG and MIDI.
 */
function setupFullLoad(fragment = makeFragmentDetail()) {
  vi.mocked(fragmentApi.getFragment).mockResolvedValue(fragment);
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    text: () => Promise.resolve('<mei>test</mei>'),
  } as Response);
  vi.mocked(verovioService.getVerovioToolkit).mockResolvedValue(
    {} as Awaited<ReturnType<typeof verovioService.getVerovioToolkit>>,
  );
  vi.mocked(verovioService.renderFragment).mockResolvedValue(MOCK_SVG);
  vi.mocked(verovioService.renderMidi).mockResolvedValue(MOCK_MIDI_BASE64);
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();

  vi.mocked(Tone.Sampler).mockImplementation(makeSamplerImpl as never);

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

  // getConceptSchemas is called by FragmentDetailPanel for property display.
  vi.mocked(conceptApi.getConceptSchemas).mockResolvedValue({
    concept_id: 'PerfectAuthenticCadence',
    schemas: [],
    stages: [],
    type_refinement: { show: false, children: [] },
  });
});

// ---------------------------------------------------------------------------
// Loading and error states
// ---------------------------------------------------------------------------

describe('FragmentDetail — loading and error states', () => {
  it('shows a loading indicator while the fragment is fetching', () => {
    vi.mocked(fragmentApi.getFragment).mockReturnValue(new Promise(() => {}));
    renderDetail();
    expect(screen.getByText(/loading…/i)).toBeInTheDocument();
  });

  it('shows an error message when the fragment fetch fails', async () => {
    vi.mocked(fragmentApi.getFragment).mockRejectedValue(
      new ApiError('NOT_FOUND', 'Fragment not found', 404),
    );
    renderDetail();
    await screen.findByText(/fragment not found/i);
  });
});

// ---------------------------------------------------------------------------
// Concept identity section
// ---------------------------------------------------------------------------

describe('FragmentDetail — concept identity section', () => {
  it('renders the concept label from the primary tag alias', async () => {
    setupFullLoad();
    renderDetail();
    await screen.findByText('PAC');
  });

  it('falls back to concept name when alias is null', async () => {
    setupFullLoad(
      makeFragmentDetail({
        concept_tags: [
          {
            concept_id: 'HalfCadence',
            is_primary: true,
            name: 'Half Cadence',
            alias: null,
            hierarchy_path: ['Cadence'],
          },
        ],
      }),
    );
    renderDetail();
    await screen.findByText('Half Cadence');
  });

  it('renders the hierarchy path', async () => {
    setupFullLoad();
    renderDetail();
    // hierarchy_path is ['Cadence', 'Authentic Cadence'], joined with →
    await screen.findByText(/cadence.*authentic cadence/i);
  });

  it('renders the bar range', async () => {
    setupFullLoad();
    renderDetail();
    await screen.findByText(/mm\. 1.*4/);
  });

  it('renders data_licence as a link when data_licence_url is set', async () => {
    setupFullLoad(
      makeFragmentDetail({
        data_licence: 'CC BY-SA 4.0',
        data_licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
      }),
    );
    renderDetail();

    const link = await screen.findByRole('link', { name: 'CC BY-SA 4.0' });
    expect(link).toHaveAttribute('href', 'https://creativecommons.org/licenses/by-sa/4.0/');
  });

  it('renders data_licence as plain text when data_licence_url is null', async () => {
    setupFullLoad(makeFragmentDetail({ data_licence: 'CC BY-SA 4.0', data_licence_url: null }));
    renderDetail();
    await screen.findByText('CC BY-SA 4.0');
    expect(screen.queryByRole('link', { name: 'CC BY-SA 4.0' })).not.toBeInTheDocument();
  });

  it('renders harmony_sources', async () => {
    setupFullLoad(makeFragmentDetail({ harmony_sources: ['dcml', 'manual'] }));
    renderDetail();
    await screen.findByText(/sources:.*dcml.*manual/i);
  });

  it('renders secondary tags in an "Also tagged" section', async () => {
    setupFullLoad(
      makeFragmentDetail({
        concept_tags: [
          {
            concept_id: 'PerfectAuthenticCadence',
            is_primary: true,
            name: 'Perfect Authentic Cadence',
            alias: 'PAC',
            hierarchy_path: ['Cadence', 'Authentic Cadence'],
          },
          {
            concept_id: 'CadentialSixFour',
            is_primary: false,
            name: 'Cadential Six-Four',
            alias: null,
            hierarchy_path: ['Chord'],
          },
        ],
      }),
    );
    renderDetail();
    await screen.findByText(/also tagged/i);
    expect(screen.getByText('Cadential Six-Four')).toBeInTheDocument();
  });

  it('does not render "Also tagged" when there are no secondary tags', async () => {
    setupFullLoad(); // default fixture has only one tag
    renderDetail();
    await screen.findByText('PAC');
    expect(screen.queryByText(/also tagged/i)).not.toBeInTheDocument();
  });

  it('renders the status badge', async () => {
    setupFullLoad(makeFragmentDetail({ status: 'approved' }));
    renderDetail();
    const badge = await screen.findByText('approved');
    expect(badge.closest('[data-status]')).toHaveAttribute('data-status', 'approved');
  });
});

// ---------------------------------------------------------------------------
// Measure/beat display rule + licence de-duplication (Component 9 Step 15)
// ---------------------------------------------------------------------------

describe('FragmentDetail — measure/beat display rule', () => {
  it('shows no beats for a complete-measure fragment', async () => {
    setupFullLoad(); // default fixture: bars 1–4, beat_start/beat_end null
    renderDetail();
    await screen.findByText('mm. 1–4');
    expect(screen.queryByText(/beat/i)).not.toBeInTheDocument();
  });

  it('attaches each beat to its own measure for beat-precise fragments', async () => {
    setupFullLoad(
      makeFragmentDetail({ bar_start: 3, bar_end: 4, mc_start: 3, mc_end: 4, beat_start: 2, beat_end: 2 }),
    );
    renderDetail();
    // beat_end is an exclusive bound; displayed as the last covered beat
    // (Component 9 G1) — 2 steps back to "beat 1" of m. 4.
    await screen.findByText('m. 3, beat 2 – m. 4, beat 1');
  });

  it('renders the licence exactly once (header only — no duplicated record block)', async () => {
    setupFullLoad(
      makeFragmentDetail({
        data_licence: 'CC BY-SA 4.0',
        data_licence_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
        harmony_sources: ['dcml'],
      }),
    );
    renderDetail();
    await screen.findByText('PAC');
    await waitFor(() => {
      expect(screen.getAllByText('CC BY-SA 4.0')).toHaveLength(1);
      expect(screen.getAllByText(/sources:/i)).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Rendering-context contract (ADR-024 — Phase 1 mode=none default)
// ---------------------------------------------------------------------------

describe('FragmentDetail — rendering-context contract', () => {
  it('calls getFragment with only the fragment id (context mode=none default)', async () => {
    setupFullLoad();
    renderDetail('frag-context-test');

    await waitFor(() => {
      expect(vi.mocked(fragmentApi.getFragment)).toHaveBeenCalledWith('frag-context-test');
      // No additional args — the context parameter defaults to mode=none on the backend.
      expect(vi.mocked(fragmentApi.getFragment)).toHaveBeenCalledTimes(1);
    });
  });
});

// ---------------------------------------------------------------------------
// Verovio select spike fixtures
// (docs/architecture/mei-ingest-normalization.md §"WASM spike findings")
//
// WASM Finding 1: mc_start/mc_end pass through unchanged for linear ranges.
// WASM Finding 2: Position 1 (pickup bar) resolves correctly.
// WASM Finding 3: Volta ending position indices isolate individual endings.
//
// These tests assert that FragmentDetail passes mc_start/mc_end from the
// fragment record directly to renderFragment — no coordinate conversion.
// The actual Verovio select behaviour is validated by the Python/WASM spike
// scripts; here we verify the component's parameter-passing contract.
// ---------------------------------------------------------------------------

describe('FragmentDetail — Verovio select spike fixtures', () => {
  it('WASM Finding 1: passes mc_start/mc_end for a linear mid-system fragment', async () => {
    const fragment = makeFragmentDetail({ mc_start: 3, mc_end: 5, bar_start: 3, bar_end: 5 });
    setupFullLoad(fragment);
    renderDetail();

    await waitFor(() => {
      expect(vi.mocked(verovioService.renderFragment)).toHaveBeenCalledWith(
        expect.anything(),  // toolkit instance
        expect.any(String), // MEI text
        3,                  // mc_start — position index
        5,                  // mc_end
        // Default scale Medium (45); system breaks allowed (Component 9 Step 15).
        expect.objectContaining({ scale: 45, breaks: 'smart' }),
      );
    });
  });

  it('WASM Finding 2: passes mc_start=1/mc_end=2 for a pickup-bar fragment', async () => {
    // bar_start=0 is the pickup bar (@n="0"); mc_start=1 is its position index.
    const fragment = makeFragmentDetail({ mc_start: 1, mc_end: 2, bar_start: 0, bar_end: 1 });
    setupFullLoad(fragment);
    renderDetail();

    await waitFor(() => {
      expect(vi.mocked(verovioService.renderFragment)).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        1,
        2,
        expect.objectContaining({ scale: 45 }),
      );
    });
  });

  it('WASM Finding 3a: passes mc_start=2/mc_end=2 for a volta first-ending fragment', async () => {
    const fragment = makeFragmentDetail({
      mc_start: 2,
      mc_end: 2,
      bar_start: 2,
      bar_end: 2,
      repeat_context: 'first-ending',
    });
    setupFullLoad(fragment);
    renderDetail();

    await waitFor(() => {
      expect(vi.mocked(verovioService.renderFragment)).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        2,
        2,
        expect.objectContaining({ scale: 45 }),
      );
    });
  });

  it('WASM Finding 3b: passes mc_start=3/mc_end=3 for a volta second-ending fragment', async () => {
    const fragment = makeFragmentDetail({
      mc_start: 3,
      mc_end: 3,
      bar_start: 2, // same @n=2, different document-order position
      bar_end: 2,
      repeat_context: 'second-ending',
    });
    setupFullLoad(fragment);
    renderDetail();

    await waitFor(() => {
      expect(vi.mocked(verovioService.renderFragment)).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        3,
        3,
        expect.objectContaining({ scale: 45 }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Scale controls
// ---------------------------------------------------------------------------

describe('FragmentDetail — scale controls', () => {
  it('renders all three scale buttons (S, M, L)', async () => {
    setupFullLoad();
    renderDetail();
    await screen.findByText('PAC'); // wait for fragment to load
    expect(screen.getByRole('button', { name: /^s$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^m$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^l$/i })).toBeInTheDocument();
  });

  it('M scale button is pressed by default (scale 45 — Component 9 Step 15)', async () => {
    setupFullLoad();
    renderDetail();
    await screen.findByText('PAC');
    const mButton = screen.getByRole('button', { name: /^m$/i });
    expect(mButton).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^s$/i })).toHaveAttribute('aria-pressed', 'false');
  });

  it('clicking S re-renders with scale 35', async () => {
    setupFullLoad();
    renderDetail();
    await screen.findByText('PAC');
    vi.mocked(verovioService.renderFragment).mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^s$/i }));

    await waitFor(() => {
      expect(vi.mocked(verovioService.renderFragment)).toHaveBeenCalledWith(
        expect.anything(),
        expect.any(String),
        1,
        4,
        expect.objectContaining({ scale: 35 }),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Harmony label toggle (Component 9 Step 23)
// ---------------------------------------------------------------------------

/** One movement_analysis event in the loose detail-response shape. */
function makeHarmonyEvent(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    mc: 1, mn: 1, volta: null, beat: 1,
    local_key: 'C', numeral: 'I', applied_to: null,
    extensions: [], source: 'dcml', auto: true, reviewed: false,
    ...overrides,
  };
}

describe('FragmentDetail — harmony label toggle (Step 23)', () => {
  it('renders the Harmony toggle, pressed by default, when the fragment has events', async () => {
    setupFullLoad(makeFragmentDetail({ harmony_events: [makeHarmonyEvent()] }));
    renderDetail();
    await screen.findByText('PAC');
    const toggle = screen.getByRole('button', { name: /harmony/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  it('does not render the Harmony toggle when the fragment has no events', async () => {
    setupFullLoad(); // default fixture: harmony_events: []
    renderDetail();
    await screen.findByText('PAC');
    expect(screen.queryByRole('button', { name: /harmony/i })).not.toBeInTheDocument();
  });

  it('flips aria-pressed when the Harmony toggle is clicked', async () => {
    setupFullLoad(makeFragmentDetail({ harmony_events: [makeHarmonyEvent()] }));
    renderDetail();
    await screen.findByText('PAC');
    const toggle = screen.getByRole('button', { name: /harmony/i });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });
});

// ---------------------------------------------------------------------------
// Playback controls
// ---------------------------------------------------------------------------

describe('FragmentDetail — playback controls', () => {
  it('play button is disabled while MIDI has not loaded (idle state)', () => {
    // Never resolves — fragment never loads, no MIDI.
    vi.mocked(fragmentApi.getFragment).mockReturnValue(new Promise(() => {}));
    renderDetail();
    // Only one play/pause button (it's not rendered until fragment loads either,
    // so just verify no enabled play button is present).
    const playBtn = screen.queryByRole('button', { name: /^play$/i });
    if (playBtn) expect(playBtn).toBeDisabled();
  });

  it('play button becomes enabled after MIDI loads', async () => {
    setupFullLoad();
    renderDetail();

    // Wait for the play button to become enabled (MIDI ready → useMidiPlayback → 'ready').
    await waitFor(() => {
      const btn = screen.getByRole('button', { name: /play/i });
      expect(btn).not.toBeDisabled();
    }, { timeout: 3000 });
  });

  it('stop button is disabled before playback starts', async () => {
    setupFullLoad();
    renderDetail();
    await screen.findByText('PAC');
    const stopBtn = screen.getByRole('button', { name: /stop/i });
    expect(stopBtn).toBeDisabled();
  });
});

// ---------------------------------------------------------------------------
// Fragment record panel (Component 7 record component reuse)
// ---------------------------------------------------------------------------

describe('FragmentDetail — fragment record panel', () => {
  it('renders FragmentDetailPanel in standalone mode', async () => {
    setupFullLoad();
    renderDetail();

    // FragmentDetailPanel always renders with data-testid="fragment-detail-panel"
    // unless overridden. In standalone mode it uses a <div> wrapper, not <aside>.
    await screen.findByTestId('fragment-detail-panel');
  });
});

// ---------------------------------------------------------------------------
// Sub-part bracket overlay (jsdom limitation documented)
// ---------------------------------------------------------------------------

describe('FragmentDetail — sub-part bracket overlay', () => {
  it('does not render the overlay when measureRects is empty (jsdom limitation)', async () => {
    // jsdom's getBoundingClientRect always returns zeros, so readMeasureRects
    // returns an empty map and the overlay guard (measureRects.size > 0) is
    // false. Verify the overlay is absent — this is correct behaviour in jsdom.
    const fragment = makeFragmentDetail({
      sub_parts: [
        makeFragmentDetail({
          id: 'sub-001',
          parent_fragment_id: 'frag-001',
          bar_start: 1,
          bar_end: 2,
          mc_start: 1,
          mc_end: 2,
          concept_tags: [
            {
              concept_id: 'SomeStage',
              is_primary: true,
              name: 'Some Stage',
              alias: null,
              hierarchy_path: [],
            },
          ],
        }),
      ],
    });
    setupFullLoad(fragment);
    renderDetail();

    await screen.findByText('PAC');
    // The sub-part overlay layer renders only when measureRects.size > 0.
    // Since jsdom returns zero rects, the overlay is not present. (Exclude the
    // always-present playback caret, which is also aria-hidden — Step 19.)
    expect(
      document.querySelector('[aria-hidden="true"]:not([data-testid="playback-caret"])'),
    ).not.toBeInTheDocument();
  });
});
