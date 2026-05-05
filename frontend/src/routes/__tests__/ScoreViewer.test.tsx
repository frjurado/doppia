import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ScoreViewer from '../ScoreViewer';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../../services/verovio', () => ({
  getVerovioToolkit: vi.fn(),
  renderProgressively: vi.fn(),
}));

vi.mock('../../services/scoreApi', () => ({
  fetchMeiUrl: vi.fn(),
}));

import * as verovioService from '../../services/verovio';
import * as scoreApi from '../../services/scoreApi';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_MOVEMENT_ID = 'aaaaaaaa-0000-0000-0000-000000000001';

/** Render ScoreViewer at /scores/:movementId using a MemoryRouter. */
function renderScoreViewer(movementId = TEST_MOVEMENT_ID) {
  return render(
    <MemoryRouter initialEntries={[`/scores/${movementId}`]}>
      <Routes>
        <Route path="/scores/:movementId" element={<ScoreViewer />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** A minimal SVG string that the DOM can parse. */
const MOCK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" data-testid="score-page"><rect /></svg>';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScoreViewer', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Restore the real fetch after any test that replaces it.
    vi.restoreAllMocks();
  });

  it('shows a loading label while the MEI is being fetched', () => {
    // fetchMeiUrl never resolves → component stays in 'loading' state.
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));
    vi.mocked(verovioService.getVerovioToolkit).mockResolvedValue({} as never);
    vi.mocked(verovioService.renderProgressively).mockResolvedValue(undefined);

    renderScoreViewer();

    expect(screen.getByText(/loading score/i)).toBeInTheDocument();
  });

  it('shows a renderer loading label while the WASM is initialising', async () => {
    // MEI URL and text resolve immediately; WASM never resolves.
    vi.mocked(scoreApi.fetchMeiUrl).mockResolvedValue({ url: 'https://example.test/test.mei' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<mei>test</mei>'),
    } as Response);
    vi.mocked(verovioService.getVerovioToolkit).mockReturnValue(new Promise(() => {}));

    renderScoreViewer();

    // After MEI is fetched the label changes to the renderer message.
    await waitFor(() => {
      expect(screen.getByText(/loading score renderer/i)).toBeInTheDocument();
    });
  });

  it('renders SVG pages in the DOM once loading completes', async () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockResolvedValue({ url: 'https://example.test/test.mei' });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      text: () => Promise.resolve('<mei>test</mei>'),
    } as Response);
    vi.mocked(verovioService.getVerovioToolkit).mockResolvedValue({} as never);

    // renderProgressively calls onPage once then onComplete.
    vi.mocked(verovioService.renderProgressively).mockImplementation(
      async (_tk, _mei, _opts, onPage, onComplete) => {
        onPage(MOCK_SVG, 1);
        onComplete(1);
      },
    );

    renderScoreViewer();

    // The SVG injected by dangerouslySetInnerHTML should appear in the DOM.
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

    vi.mocked(verovioService.renderProgressively).mockImplementation(
      async (_tk, _mei, _opts, onPage, onComplete) => {
        onPage('<svg data-testid="page-1"><rect /></svg>', 1);
        onPage('<svg data-testid="page-2"><rect /></svg>', 2);
        onComplete(2);
      },
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

    renderScoreViewer();

    await waitFor(() => {
      expect(screen.getByText(/mei fetch failed/i)).toBeInTheDocument();
    });
  });

  it('renders the toolbar with staff size, transposition, and font controls', async () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));

    renderScoreViewer();

    // Controls are in the toolbar, which renders immediately (before loading completes).
    expect(screen.getByText('Small')).toBeInTheDocument();
    expect(screen.getByText('Medium')).toBeInTheDocument();
    expect(screen.getByText('Large')).toBeInTheDocument();
    expect(screen.getByLabelText(/transpose/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/music font/i)).toBeInTheDocument();
  });

  it('renders a back-to-browse link in the toolbar', () => {
    vi.mocked(scoreApi.fetchMeiUrl).mockReturnValue(new Promise(() => {}));

    renderScoreViewer();

    expect(screen.getByText(/browse/i)).toBeInTheDocument();
  });
});
