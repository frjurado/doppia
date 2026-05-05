import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { fetchMeiUrl } from '../services/scoreApi';
import { getVerovioToolkit, renderProgressively } from '../services/verovio';
import type { RenderOptions } from '../services/verovio';
import styles from './ScoreViewer.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Staff size used when no explicit preset is selected. */
const DEFAULT_SCALE = 35 as const;

type ScalePreset = 25 | 35 | 45;

const SCALE_LABELS: Record<ScalePreset, string> = { 25: 'Small', 35: 'Medium', 45: 'Large' };

/**
 * Transposition intervals mapped to Verovio transposition string format.
 * Empty string = no transposition (identity).
 * All display-only — the MEI file is never modified.
 */
const TRANSPOSE_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'No transposition', value: '' },
  { label: 'Up a semitone', value: 'd2' },
  { label: 'Up a tone', value: 'M2' },
  { label: 'Up a major third', value: 'M3' },
  { label: 'Down a semitone', value: '-d2' },
  { label: 'Down a tone', value: '-M2' },
  { label: 'Down a major third', value: '-M3' },
  { label: 'Up an octave', value: 'P8' },
  { label: 'Down an octave', value: '-P8' },
];

/** Music notation fonts available in Verovio 6.1.0. Default: Bravura. */
const FONT_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'Bravura', value: 'Bravura' },
  { label: 'Leipzig', value: 'Leipzig' },
  { label: 'Leland', value: 'Leland' },
];

const DEFAULT_FONT = 'Bravura';

/**
 * Fallback page width (pixels) used before the container is measured.
 * The ResizeObserver and explicit measurement replace this on first render.
 */
const DEFAULT_PAGE_WIDTH = 1400;

/**
 * Minimum page width passed to Verovio (pixels). Below this, the score panel
 * scrolls horizontally rather than compressing notation further.
 */
const MIN_PAGE_WIDTH = 480;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ViewerStatus = 'loading' | 'ready' | 'error';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Score viewer route — `/scores/:movementId`.
 *
 * Three-zone layout:
 *   1. Toolbar (container-high, scrolls with page): back link, staff size,
 *      transposition, and music font controls.
 *   2. Score panel: Verovio SVG pages rendered progressively inside a
 *      centered max-width: 1400px container.
 *   3. Playback bar (container-highest, fixed bottom): Step 14 placeholder.
 *
 * Loading sequence on mount:
 *   fetchMeiUrl() → fetch MEI text → getVerovioToolkit() → renderProgressively()
 *
 * Options changes (scale / transpose / font) debounce 200 ms then re-render
 * in the background; the previous SVG stays visible under a translucent
 * overlay until the new render is complete.
 *
 * Container width measurement:
 *   A ResizeObserver watches the .scoreContent element. On resize (debounced
 *   300 ms, >4px threshold) it updates pageWidthRef and triggers a re-render.
 *   The initial render reads offsetWidth synchronously before the first await.
 *   If the container is narrower than MIN_PAGE_WIDTH (480px), pageWidth is
 *   clamped and a notice is shown beneath the toolbar.
 */
export default function ScoreViewer() {
  const { movementId } = useParams<{ movementId: string }>();
  usePageTitle('Score Viewer — Doppia');

  // ── Viewer state ────────────────────────────────────────────────────────
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [loadingLabel, setLoadingLabel] = useState('Loading score…');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [svgPages, setSvgPages] = useState<string[]>([]);
  const [isRerendering, setIsRerendering] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);

  // ── Controls state ───────────────────────────────────────────────────────
  const [scale, setScale] = useState<ScalePreset>(DEFAULT_SCALE);
  const [transpose, setTranspose] = useState('');
  const [font, setFont] = useState<string>(DEFAULT_FONT);

  // ── Refs (stable across renders, safe to read inside async callbacks) ────
  // Verovio toolkit singleton acquired after WASM loads.
  const tkRef = useRef<Awaited<ReturnType<typeof getVerovioToolkit>> | null>(null);
  // MEI text cached for re-renders; never passed directly to JSX.
  const meiTextRef = useRef<string | null>(null);
  // Debounce timer for options-change re-renders (200 ms).
  const rerenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirrors of controls in refs so debounced/observer callbacks read latest
  // values without needing them in dependency lists.
  const scaleRef = useRef<ScalePreset>(DEFAULT_SCALE);
  const transposeRef = useRef('');
  const fontRef = useRef<string>(DEFAULT_FONT);
  // Measured content width of .scoreContent; passed to Verovio as pageWidth.
  const pageWidthRef = useRef<number>(DEFAULT_PAGE_WIDTH);
  // Ref to the .scoreContent element for width measurement.
  const scorePanelRef = useRef<HTMLDivElement | null>(null);

  // ── Re-render (triggered by options changes or container resize) ──────────
  /**
   * Schedule a debounced re-render using the latest control values and the
   * current measured pageWidth. Rapid changes within the 200 ms window
   * coalesce into a single render call.
   *
   * The previous SVG stays visible while re-rendering; a translucent overlay
   * signals the in-progress render without a blank-screen flash.
   *
   * pageWidth is read from pageWidthRef at timer-fire time so that a resize
   * which arrives within the debounce window is automatically picked up.
   */
  const scheduleRerender = useCallback(
    (newScale: ScalePreset, newTranspose: string, newFont: string) => {
      if (rerenderTimerRef.current) clearTimeout(rerenderTimerRef.current);
      rerenderTimerRef.current = setTimeout(async () => {
        if (!tkRef.current || !meiTextRef.current) return;
        setIsRerendering(true);
        const collectedPages: string[] = [];
        try {
          await renderProgressively(
            tkRef.current,
            meiTextRef.current,
            {
              scale: newScale,
              transpose: newTranspose,
              font: newFont,
              pageWidth: pageWidthRef.current,
            },
            (svg) => {
              collectedPages.push(svg);
            },
            () => {
              // Atomically swap all pages once rendering is complete, so the
              // score never shows a partial mix of old and new pages.
              setSvgPages([...collectedPages]);
              setIsRerendering(false);
            },
          );
        } catch {
          setIsRerendering(false);
        }
      }, 200);
    },
    [],
  );

  // ── ResizeObserver: re-render when the score panel width changes ─────────
  // Defined after scheduleRerender so it can reference it in the dep array.
  useEffect(() => {
    const el = scorePanelRef.current;
    if (!el) return;

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const rawWidth = entry.contentRect.width;
      const newWidth = Math.max(rawWidth, MIN_PAGE_WIDTH);

      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const prevWidth = pageWidthRef.current;
        if (Math.abs(newWidth - prevWidth) > 4) {
          pageWidthRef.current = newWidth;
          setIsNarrow(rawWidth < MIN_PAGE_WIDTH);
          if (tkRef.current && meiTextRef.current) {
            scheduleRerender(scaleRef.current, transposeRef.current, fontRef.current);
          }
        }
      }, 300);
    });

    observer.observe(el);
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
    };
  }, [scheduleRerender]);

  // ── Initial load ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!movementId) return;
    let cancelled = false;

    const load = async () => {
      setStatus('loading');
      setLoadingLabel('Loading score…');
      setSvgPages([]);
      setErrorMessage(null);

      // Measure container width before any await — DOM is synchronously
      // available at effect time. This value is used for the initial render;
      // the ResizeObserver will re-render if the width changes later.
      const containerWidth = scorePanelRef.current?.offsetWidth ?? DEFAULT_PAGE_WIDTH;
      const initialPageWidth = Math.max(containerWidth, MIN_PAGE_WIDTH);
      pageWidthRef.current = initialPageWidth;
      setIsNarrow(containerWidth < MIN_PAGE_WIDTH);

      try {
        // 1. Resolve MEI object key → signed URL → MEI text.
        const { url } = await fetchMeiUrl(movementId);
        if (cancelled) return;

        const meiResponse = await fetch(url);
        if (!meiResponse.ok) {
          throw new Error(`MEI fetch failed (HTTP ${meiResponse.status})`);
        }
        const meiText = await meiResponse.text();
        if (cancelled) return;
        meiTextRef.current = meiText;

        // 2. Load Verovio WASM (singleton — loads at most once per session).
        setLoadingLabel('Loading score renderer…');
        const tk = await getVerovioToolkit();
        if (cancelled) return;
        tkRef.current = tk;

        // 3. Render pages progressively. Page 1 fires the 'ready' transition
        //    so the first system appears within ~300 ms of MEI load completing.
        const options: RenderOptions = {
          scale: scaleRef.current,
          transpose: transposeRef.current,
          font: fontRef.current,
          pageWidth: pageWidthRef.current,
        };

        let firstPageReceived = false;
        await renderProgressively(
          tk,
          meiText,
          options,
          (svg) => {
            if (cancelled) return;
            if (!firstPageReceived) {
              firstPageReceived = true;
              setStatus('ready');
              setSvgPages([svg]);
            } else {
              setSvgPages((prev) => [...prev, svg]);
            }
          },
          () => {
            // All pages rendered — no additional action needed.
          },
        );
      } catch (err) {
        if (!cancelled) {
          setErrorMessage(err instanceof Error ? err.message : 'Failed to load score');
          setStatus('error');
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, [movementId]);

  // ── Control handlers ─────────────────────────────────────────────────────

  const handleScaleChange = (newScale: ScalePreset) => {
    setScale(newScale);
    scaleRef.current = newScale;
    scheduleRerender(newScale, transposeRef.current, fontRef.current);
  };

  const handleTransposeChange = (newTranspose: string) => {
    setTranspose(newTranspose);
    transposeRef.current = newTranspose;
    scheduleRerender(scaleRef.current, newTranspose, fontRef.current);
  };

  const handleFontChange = (newFont: string) => {
    setFont(newFont);
    fontRef.current = newFont;
    scheduleRerender(scaleRef.current, transposeRef.current, newFont);
  };

  // ── Render ───────────────────────────────────────────────────────────────

  return (
    <div className={styles.viewer}>
      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <Surface layer="container-high" className={styles.toolbar}>
        <Link to="/" className={styles.backLink}>
          <Type variant="label-md" as="span">← Browse</Type>
        </Link>

        <div className={styles.toolbarSeparator} />

        {/* Staff size presets */}
        <div className={styles.staffSizeControl} role="group" aria-label="Staff size">
          <Type
            variant="label-md"
            as="span"
            style={{ color: 'var(--color-on-surface-variant)' }}
          >
            Size
          </Type>
          {([25, 35, 45] as ScalePreset[]).map((s) => (
            <button
              key={s}
              type="button"
              className={[
                styles.sizeButton,
                scale === s ? styles.sizeButtonActive : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => handleScaleChange(s)}
              aria-pressed={scale === s}
            >
              <Type variant="label-sm" as="span">{SCALE_LABELS[s]}</Type>
            </button>
          ))}
        </div>

        {/* Transposition select */}
        <div className={styles.toolbarSelectControl}>
          <label htmlFor="transpose-select" className={styles.toolbarSelectLabel}>
            <Type
              variant="label-md"
              as="span"
              style={{ color: 'var(--color-on-surface-variant)' }}
            >
              Transpose
            </Type>
          </label>
          <select
            id="transpose-select"
            className={styles.toolbarSelect}
            value={transpose}
            onChange={(e) => handleTransposeChange(e.target.value)}
          >
            {TRANSPOSE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Music font select */}
        <div className={styles.toolbarSelectControl}>
          <label htmlFor="font-select" className={styles.toolbarSelectLabel}>
            <Type
              variant="label-md"
              as="span"
              style={{ color: 'var(--color-on-surface-variant)' }}
            >
              Music font
            </Type>
          </label>
          <select
            id="font-select"
            className={styles.toolbarSelect}
            value={font}
            onChange={(e) => handleFontChange(e.target.value)}
          >
            {FONT_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </Surface>

      {/* Narrow-screen notice — shown when container is below 480px */}
      {isNarrow && (
        <div className={styles.narrowNotice}>
          <Type
            variant="label-md"
            as="span"
            style={{ color: 'var(--color-on-surface-variant)' }}
          >
            Score is best viewed at wider widths.
          </Type>
        </div>
      )}

      {/* ── Score panel ─────────────────────────────────────────────────── */}
      <div className={styles.scorePanelWrapper}>
        {/* Status overlays: sit above the score panel during loading/error.
            The score panel itself stays in the DOM so scorePanelRef can
            measure the container width even before the first render. */}
        {status === 'loading' && (
          <Surface layer="base" className={styles.statusPanel}>
            <Type variant="label-md" as="p">{loadingLabel}</Type>
          </Surface>
        )}

        {status === 'error' && (
          <Surface layer="base" className={styles.statusPanel}>
            <Type variant="body-lg" as="p">
              {errorMessage ?? 'Failed to load score'}
            </Type>
          </Surface>
        )}

        {/* Score panel: always rendered so scorePanelRef.current is available
            for width measurement even before the first successful render. */}
        <div className={styles.scorePanel}>
          {/* .scoreContent is the measured element: ResizeObserver watches it.
              Its offsetWidth (≤ 1400px via max-width) is what we pass to
              Verovio as pageWidth, so the SVG fills the container exactly. */}
          <div ref={scorePanelRef} className={styles.scoreContent}>
            {svgPages.map((svg, i) => (
              <div
                key={i}
                className={styles.svgPage}
                // Verovio SVG output is generated by the trusted Verovio
                // WASM engine from MEI files stored in object storage —
                // it is not derived from user input.
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            ))}
          </div>
        </div>

        {/* Re-render overlay: sits above SVG pages while options change */}
        {isRerendering && (
          <div className={styles.rerenderOverlay} role="status" aria-live="polite">
            <Type variant="label-md" as="span">Re-rendering…</Type>
          </div>
        )}
      </div>

      {/* ── Playback bar (Step 14 placeholder) ──────────────────────────── */}
      <Surface layer="container-highest" className={styles.playbackBar}>
        <Type
          variant="label-md"
          as="span"
          style={{ color: 'var(--color-on-surface-variant)' }}
        >
          MIDI playback — Step 14
        </Type>
      </Surface>
    </div>
  );
}
