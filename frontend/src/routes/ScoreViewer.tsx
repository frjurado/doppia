import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import FragmentOverlay from '../components/score/FragmentOverlay';
import { useMidiPlayback } from '../hooks/useMidiPlayback';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { fetchMeiUrl } from '../services/scoreApi';
import { buildHighlightSchedule, getVerovioToolkit, renderMidi, renderProgressively } from '../services/verovio';
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
 *   3. Playback bar (container-highest, fixed bottom): transport controls
 *      (Play/Pause, Stop, position display) wired to useMidiPlayback.
 *
 * Loading sequence on mount:
 *   fetchMeiUrl() → fetch MEI text → getVerovioToolkit() → renderProgressively()
 *   → renderMidi() → midiBase64 state → useMidiPlayback ready
 *
 * Options changes (scale / transpose / font) debounce 200 ms then re-render
 * in the background; the previous SVG stays visible under a translucent
 * overlay until the new render is complete. After re-render, renderMidi() is
 * called again so the MIDI follows the transposition (Step 14.6).
 *
 * Playback highlight (Step 14.4):
 *   useMidiPlayback fires onPositionUpdate(timeMs) on each animation frame.
 *   handlePositionUpdate binary-searches a pre-built schedule (from
 *   buildHighlightSchedule / renderToTimemap) and toggles the global
 *   `.is-playing` CSS class on matching SVG elements via direct DOM mutation
 *   (not React state — avoids re-render at RAF frequency). The timemap-derived
 *   schedule correctly expands repeats so both passes are highlighted.
 *   Note: modifying a class on an existing Verovio SVG element is the one
 *   exception to the CLAUDE.md HTML-overlay rule; it adds no new nodes and is
 *   cleared automatically when Verovio re-renders the SVG.
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

  // ── MIDI state (Step 14) ─────────────────────────────────────────────────
  /**
   * Base64-encoded MIDI from Verovio renderToMIDI(). Null until the first
   * render completes. Updated after every re-render (transposition, scale,
   * font) so the MIDI always reflects the currently displayed score.
   */
  const [midiBase64, setMidiBase64] = useState<string | null>(null);

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
  // Currently highlighted SVG elements (is-playing class). One entry per
  // sounding note (multiple staves, chords). Cleared on stop and on each
  // position update. Using a ref avoids React re-renders at RAF freq.
  const highlightedElsRef = useRef<Element[]>([]);
  // Highlight schedule from renderToTimemap(), rebuilt after each render.
  // Sorted { timeMs, ids } entries with repeats fully expanded — the same note
  // IDs appear twice (once per pass) at different timeMs values.
  const highlightScheduleRef = useRef<Array<{ timeMs: number; ids: string[] }>>([]);

  // ── Position update callback (Step 14.4) ─────────────────────────────────
  /**
   * Called by useMidiPlayback on each animation frame. Binary-searches the
   * timemap-derived highlight schedule for the latest onset ≤ timeMs, then
   * applies the `.is-playing` CSS class to matching DOM elements.
   *
   * The schedule is built from renderToTimemap() after each render, which
   * expands repeats correctly: both passes of a repeated section have entries
   * with the same element IDs but different timeMs values. No Verovio calls
   * at playback time.
   */
  const handlePositionUpdate = useCallback((timeMs: number) => {
    const schedule = highlightScheduleRef.current;

    // Clear previous highlights unconditionally so they never get stuck.
    for (const el of highlightedElsRef.current) {
      el.classList.remove('is-playing');
    }
    highlightedElsRef.current = [];

    if (schedule.length === 0) return;

    // Binary-search for the latest onset at or before the current time.
    let lo = 0, hi = schedule.length - 1, idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (schedule[mid].timeMs <= timeMs) { idx = mid; lo = mid + 1; }
      else hi = mid - 1;
    }

    if (idx < 0) return;

    for (const id of schedule[idx].ids) {
      const el = document.getElementById(id);
      if (el) {
        el.classList.add('is-playing');
        highlightedElsRef.current.push(el);
      }
    }
  }, []);

  // ── MIDI playback hook (Step 14) ──────────────────────────────────────────
  const {
    status: playbackStatus,
    position: playbackPosition,
    play,
    pause,
    stop,
  } = useMidiPlayback(midiBase64, handlePositionUpdate);

  /**
   * Stop playback and also clear the SVG highlight immediately.
   * Wraps stop() because the hook's stop() has no access to highlightedElsRef.
   */
  const handleStop = useCallback(() => {
    stop();
    for (const el of highlightedElsRef.current) {
      el.classList.remove('is-playing');
    }
    highlightedElsRef.current = [];
  }, [stop]);

  // ── Re-render (triggered by options changes or container resize) ──────────
  /**
   * Schedule a debounced re-render using the latest control values and the
   * current measured pageWidth. Rapid changes within the 200 ms window
   * coalesce into a single render call.
   *
   * After SVG pages are updated, renderMidi() is called so the MIDI follows
   * the new transposition (Step 14.6). If playback is in progress,
   * useMidiPlayback stops it automatically when midiBase64 changes.
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
            () => {},
          );
          // Atomically swap SVG pages once all are collected.
          setSvgPages([...collectedPages]);

          // Regenerate MIDI and highlight schedule to follow new options
          // (Step 14.6). midiBase64 change stops any in-progress playback.
          const midi = await renderMidi(tkRef.current);
          highlightScheduleRef.current = buildHighlightSchedule(tkRef.current);
          setMidiBase64(midi);

          // Clear stale highlights — SVG element IDs may differ in new render.
          for (const el of highlightedElsRef.current) {
            el.classList.remove('is-playing');
          }
          highlightedElsRef.current = [];
        } catch {
          // Keep existing pages on render failure.
        } finally {
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
      setMidiBase64(null);

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
          () => {},
        );

        // 4. Generate MIDI and build highlight schedule from the toolkit's
        //    timemap (Step 14.3 / 14.4). renderToTimemap() expands repeats
        //    correctly, so both passes of a repeated section are covered.
        if (!cancelled) {
          try {
            const midi = await renderMidi(tk);
            if (!cancelled) {
              highlightScheduleRef.current = buildHighlightSchedule(tk);
              setMidiBase64(midi);
            }
          } catch {
            // MIDI/timemap failure is non-fatal; playback stays disabled.
          }
        }
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

  const isPlaybackAvailable = midiBase64 !== null;
  const isPlaying = playbackStatus === 'playing';
  const isLoadingInstrument = playbackStatus === 'loading-instrument';
  const isInstrumentError = playbackStatus === 'instrument-error';

  return (
    <div className={styles.viewer}>
      {/* Visually-hidden h1 for screen readers: provides a page landmark
          without affecting the visual toolbar layout. */}
      <Type variant="headline" as="h1" className={styles.srOnly}>Score Viewer</Type>

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
            {/* Step 13: fragment overlay slot — empty until Components 7/8.
                Overlays are always HTML elements above the SVG, never injected
                into Verovio's SVG output (see CLAUDE.md §"Verovio SVG overlay rule"). */}
            <FragmentOverlay />
          </div>
        </div>

        {/* Re-render overlay: sits above SVG pages while options change */}
        {isRerendering && (
          <div className={styles.rerenderOverlay} role="status" aria-live="polite">
            <Type variant="label-md" as="span">Re-rendering…</Type>
          </div>
        )}
      </div>

      {/* ── Playback bar (Step 14.5) ─────────────────────────────────────── */}
      <Surface layer="container-highest" className={styles.playbackBar}>
        {isLoadingInstrument ? (
          <Type
            variant="label-md"
            as="span"
            className={styles.loadingInstrumentLabel}
          >
            Loading instrument…
          </Type>
        ) : isInstrumentError ? (
          <Type
            variant="label-md"
            as="span"
            className={styles.instrumentErrorLabel}
          >
            Audio unavailable — set{' '}
            <code>VITE_SOUNDFONT_BASE_URL</code> and upload piano samples.
            <button
              type="button"
              className={styles.retryButton}
              onClick={play}
            >
              Retry
            </button>
          </Type>
        ) : (
          <>
            {/* Play / Pause */}
            <button
              type="button"
              className={styles.transportButton}
              onClick={isPlaying ? pause : play}
              disabled={!isPlaybackAvailable || isLoadingInstrument}
              aria-label={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>

            {/* Stop */}
            <button
              type="button"
              className={styles.transportButton}
              onClick={handleStop}
              disabled={!isPlaybackAvailable || playbackStatus === 'ready' || playbackStatus === 'idle'}
              aria-label="Stop"
            >
              ⏹
            </button>

            {/* Position display: bar and beat, 1-indexed */}
            <Type
              variant="label-md"
              as="span"
              className={styles.positionDisplay}
              aria-live="polite"
              aria-label={`Bar ${playbackPosition.bar}, beat ${playbackPosition.beat}`}
            >
              {isPlaybackAvailable
                ? `${playbackPosition.bar}:${playbackPosition.beat}`
                : '—'}
            </Type>
          </>
        )}
      </Surface>
    </div>
  );
}
