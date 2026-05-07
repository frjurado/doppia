/**
 * Unit tests for frontend/src/services/verovio.ts.
 *
 * The Verovio toolkit is never loaded — all tests use a mock toolkit object
 * constructed locally. The functions under test (renderFragment, renderPage,
 * renderProgressively) accept the toolkit as an argument, so no module mock
 * is needed.
 *
 * For WASM client-side verification of edge cases (mc=1, volta endings), see
 * verovio-fragment.wasm-spike.test.ts (run with VEROVIO_WASM_SPIKE=1).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  renderFragment,
  renderPage,
  renderProgressively,
  type RenderOptions,
} from '../verovio';

// ---------------------------------------------------------------------------
// Mock toolkit factory
// ---------------------------------------------------------------------------

function makeMockToolkit() {
  return {
    setOptions: vi.fn(),
    loadData: vi.fn().mockReturnValue(true),
    select: vi.fn().mockReturnValue(true),
    redoLayout: vi.fn(),
    getPageCount: vi.fn().mockReturnValue(1),
    renderToSVG: vi.fn().mockReturnValue('<svg/>'),
    renderToMIDI: vi.fn().mockReturnValue('base64midi=='),
    renderToTimemap: vi.fn().mockReturnValue('[]'),
    getElementsAtTime: vi.fn().mockReturnValue('{}'),
  };
}

const BASE_OPTIONS: RenderOptions = {
  scale: 35,
  transpose: '',
  font: 'Bravura',
  pageWidth: 2200,
};

// ---------------------------------------------------------------------------
// renderFragment
// ---------------------------------------------------------------------------

describe('renderFragment', () => {
  let tk: ReturnType<typeof makeMockToolkit>;

  beforeEach(() => {
    tk = makeMockToolkit();
  });

  it('calls setOptions with the correct fragment options', async () => {
    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(tk.setOptions).toHaveBeenCalledOnce();
    expect(tk.setOptions).toHaveBeenCalledWith({
      scale: 35,
      transpose: '',
      pageWidth: 2200,
      font: 'Bravura',
      adjustPageHeight: true,
      breaks: 'none',
      pageMarginTop: 0,
      pageMarginBottom: 0,
    });
  });

  it('does NOT pass scaleToPageSize to fragment renders', async () => {
    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    const opts = tk.setOptions.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).not.toHaveProperty('scaleToPageSize');
  });

  it('follows the correct call sequence: setOptions → loadData → select → redoLayout → renderToSVG', async () => {
    const order: string[] = [];
    tk.setOptions.mockImplementation(() => order.push('setOptions'));
    tk.loadData.mockImplementation(() => { order.push('loadData'); return true; });
    tk.select.mockImplementation(() => { order.push('select'); return true; });
    tk.redoLayout.mockImplementation(() => order.push('redoLayout'));
    tk.renderToSVG.mockImplementation(() => { order.push('renderToSVG'); return '<svg/>'; });

    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(order).toEqual(['setOptions', 'loadData', 'select', 'redoLayout', 'renderToSVG']);
  });

  it('does NOT call getPageCount (fragment always renders page 1 directly)', async () => {
    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(tk.getPageCount).not.toHaveBeenCalled();
  });

  describe('measureRange string formatting', () => {
    it('formats mcStart=1, mcEnd=4 as "1-4"', async () => {
      await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
      expect(tk.select).toHaveBeenCalledWith({ measureRange: '1-4' });
    });

    it('formats mcStart=3, mcEnd=7 as "3-7"', async () => {
      await renderFragment(tk, '<mei/>', 3, 7, BASE_OPTIONS);
      expect(tk.select).toHaveBeenCalledWith({ measureRange: '3-7' });
    });

    it('formats a single-measure fragment (mcStart=1, mcEnd=1) as "1-1"', async () => {
      await renderFragment(tk, '<mei/>', 1, 1, BASE_OPTIONS);
      expect(tk.select).toHaveBeenCalledWith({ measureRange: '1-1' });
    });
  });

  it('always calls renderToSVG(1), not the page count', async () => {
    // getPageCount returns 3 — renderToSVG must still receive 1, not 3.
    tk.getPageCount.mockReturnValue(3);
    await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(tk.renderToSVG).toHaveBeenCalledWith(1);
  });

  it('resolves with the SVG string returned by renderToSVG', async () => {
    tk.renderToSVG.mockReturnValue('<svg id="test"/>');
    const result = await renderFragment(tk, '<mei/>', 1, 4, BASE_OPTIONS);
    expect(result).toBe('<svg id="test"/>');
  });
});

// ---------------------------------------------------------------------------
// renderPage — contrast test to document fragment/full-score option differences
// ---------------------------------------------------------------------------

describe('renderPage', () => {
  let tk: ReturnType<typeof makeMockToolkit>;

  beforeEach(() => {
    tk = makeMockToolkit();
  });

  it('passes scaleToPageSize: true and breaks: "smart" (unlike renderFragment)', async () => {
    await renderPage(tk, '<mei/>', BASE_OPTIONS, 1);
    const opts = tk.setOptions.mock.calls[0][0] as Record<string, unknown>;
    expect(opts).toHaveProperty('scaleToPageSize', true);
    expect(opts).toHaveProperty('breaks', 'smart');
  });

  it('renders the requested page number', async () => {
    await renderPage(tk, '<mei/>', BASE_OPTIONS, 3);
    expect(tk.renderToSVG).toHaveBeenCalledWith(3);
  });

  it('does not call select or redoLayout', async () => {
    await renderPage(tk, '<mei/>', BASE_OPTIONS, 1);
    expect(tk.select).not.toHaveBeenCalled();
    expect(tk.redoLayout).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// renderProgressively
// ---------------------------------------------------------------------------

describe('renderProgressively', () => {
  let tk: ReturnType<typeof makeMockToolkit>;

  beforeEach(() => {
    tk = makeMockToolkit();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onPage for each page and onComplete with the total', async () => {
    tk.getPageCount.mockReturnValue(3);
    tk.renderToSVG.mockImplementation((page: number) => `<svg page="${page}"/>`);

    const onPage = vi.fn();
    const onComplete = vi.fn();

    const promise = renderProgressively(tk, '<mei/>', BASE_OPTIONS, onPage, onComplete);

    // Page 1 is synchronous — fires before any timer
    expect(onPage).toHaveBeenCalledTimes(1);
    expect(onPage).toHaveBeenNthCalledWith(1, '<svg page="1"/>', 1);

    // Flush the setTimeout(0) yields for pages 2 and 3
    await vi.runAllTimersAsync();
    await promise;

    expect(onPage).toHaveBeenCalledTimes(3);
    expect(onPage).toHaveBeenNthCalledWith(2, '<svg page="2"/>', 2);
    expect(onPage).toHaveBeenNthCalledWith(3, '<svg page="3"/>', 3);
    expect(onComplete).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(3);
  });

  it('fires onPage once and onComplete immediately for a single-page score', async () => {
    tk.getPageCount.mockReturnValue(1);
    const onPage = vi.fn();
    const onComplete = vi.fn();

    await renderProgressively(tk, '<mei/>', BASE_OPTIONS, onPage, onComplete);
    expect(onPage).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledWith(1);
  });
});
