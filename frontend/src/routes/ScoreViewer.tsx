import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import FragmentOverlay from '../components/score/FragmentOverlay';
import { useMidiPlayback } from '../hooks/useMidiPlayback';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { fetchMeiUrl } from '../services/scoreApi';
import { buildHighlightSchedule, buildNoteInfoMap, getTimemapTempo, getVerovioToolkit, parseMeiMeterUnit, renderMidi, renderProgressively } from '../services/verovio';
import type { NoteInfo, RenderOptions } from '../services/verovio';
import styles from './ScoreViewer.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Staff size used when no explicit preset is selected. */
const DEFAULT_SCALE = 45 as const;

type ScalePreset = 35 | 45 | 55;

const SCALE_LABELS: Record<ScalePreset, string> = { 35: 'Small', 45: 'Medium', 55: 'Large' };

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
const DEFAULT_PAGE_WIDTH = 1200;

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
 *      centered max-width: 1200px container.
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

  // ── Transport bar display state (Step 18) ─────────────────────────────────
  /**
   * Display position derived from the bar schedule (MEI @n values) rather
   * than Tone.js's raw linear bar counter. Fixes three sub-defects:
   *   1. Pickup bars: MEI @n = 0 → shows "0:beat" not "1:beat".
   *   2. Repeated sections: same barN on both passes instead of linear count.
   *   3. Non-quarter beats: beatDurationMs in denominator unit (e.g. 250 ms
   *      per eighth note for 6/8 at 120 BPM) → 6 beats per 6/8 bar.
   * Falls back to playbackPosition when the bar schedule is empty.
   */
  const [displayPosition, setDisplayPosition] = useState<{ bar: number; beat: number }>({
    bar: 1, beat: 1,
  });

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
  // Note info map from buildNoteInfoMap(), built once after MEI text is loaded.
  // Maps each MEI note/rest xml:id to { barN, beat } derived from @n and @tstamp.
  // Drives the transport bar display so it shows MEI @n (not Tone.js linear bar)
  // and beats in the denominator unit (not quarter notes), fixing all three
  // transport-bar sub-defects: pickup phase drift, repeat bar count, 6/8 beats.
  const noteInfoMapRef = useRef<Map<string, NoteInfo>>(new Map());
  // Beat duration in ms for the denominator unit (e.g. 250 ms for an eighth
  // note at quarter=120 in a 6/8 piece). Computed from the timemap tempo and
  // MEI @meter.unit after each render. Default 500 ms = quarter note at 120 BPM.
  // Used as the timing-based beat fallback when @tstamp is absent (Step 18.3).
  const beatDurationMsRef = useRef<number>(500);
  // Tracks the start of the current bar during playback. Updated whenever barN
  // changes so we can compute beat = floor((timeMs - barStartMs) / beatDurationMs) + 1.
  // Reset to { barN: 1, startMs: 0 } when playback stops or returns to ready/idle.
  const currentBarRef = useRef<{ barN: number; startMs: number }>({ barN: 1, startMs: 0 });

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
    // ── SVG note highlight ───────────────────────────────────────────────────
    const schedule = highlightScheduleRef.current;

    // Clear previous highlights unconditionally so they never get stuck.
    for (const el of highlightedElsRef.current) {
      el.classList.remove('is-playing');
    }
    highlightedElsRef.current = [];

    if (schedule.length > 0) {
      // Binary-search for the latest onset at or before the current time.
      let lo = 0, hi = schedule.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (schedule[mid].timeMs <= timeMs) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }

      if (idx >= 0) {
        for (const id of schedule[idx].ids) {
          const el = document.getElementById(id);
          if (el) {
            el.classList.add('is-playing');
            highlightedElsRef.current.push(el);
          }
        }
      }
    }

    // ── Transport bar display (Step 18) ──────────────────────────────────────
    // Look up the first highlighted element's id in noteInfoMapRef to get the
    // MEI @n bar number and the @tstamp-derived beat (in the time signature's
    // denominator unit). This fixes all three transport-bar sub-defects:
    //
    //   1. Pickup bars: barN = 0 (from MEI @n="0"), beats renumbered from 1.
    //      Tone.js calls the pickup "bar 1" and makes every subsequent bar wrong.
    //
    //   2. Repeats: Step 17 stripped -rendN so the same element is highlighted
    //      on both passes; the map returns the same barN on both passes.
    //      Tone.js would count linearly (bar 9, 10 … instead of 1, 2 …).
    //
    //   3. 6/8 beats: MEI @tstamp is in eighth-note units, so beat 1–6 are
    //      returned directly. Tone.js counts only 3 quarter-note beats.
    //
    // setDisplayPosition is stable (useState setter) — no extra deps needed.
    if (highlightedElsRef.current.length > 0) {
      const info = noteInfoMapRef.current.get(highlightedElsRef.current[0].id);
      if (info) {
        if (info.beat > 0) {
          // @tstamp present — use directly (already in denominator units).
          setDisplayPosition({ bar: info.barN, beat: info.beat });
        } else {
          // @tstamp absent (e.g. OpenScore MEI) — compute beat from timing.
          // When the bar changes, record the new bar and its start time.
          if (info.barN !== currentBarRef.current.barN) {
            currentBarRef.current = { barN: info.barN, startMs: timeMs };
          }
          const elapsed = timeMs - currentBarRef.current.startMs;
          const beat = beatDurationMsRef.current > 0
            ? Math.max(1, Math.floor(elapsed / beatDurationMsRef.current) + 1)
            : 1;
          setDisplayPosition({ bar: info.barN, beat });
        }
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

  // ── displayPosition sync (Step 18) ──────────────────────────────────────

  // When the note info map is empty (e.g. MEI has no @tstamp on notes, or
  // DOMParser is unavailable), fall back to the raw Tone.js position so the
  // transport bar still shows something reasonable rather than staying at 1:1.
  useEffect(() => {
    if (noteInfoMapRef.current.size === 0) {
      setDisplayPosition(playbackPosition);
    }
  }, [playbackPosition]);

  // Reset display position when playback stops or is idle so the transport bar
  // returns to 1:1 (or 0:1 for pickup scores if the bar schedule is populated,
  // but the bar schedule is cleared on re-render so 1:1 is safe as default).
  useEffect(() => {
    if (playbackStatus === 'ready' || playbackStatus === 'idle') {
      setDisplayPosition({ bar: 1, beat: 1 });
      // Also reset currentBarRef so the first bar after resuming gets a fresh
      // startMs rather than inheriting a stale value from a previous playback.
      currentBarRef.current = { barN: 1, startMs: 0 };
    }
  }, [playbackStatus]);

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

          // Regenerate MIDI and highlight schedule to follow new options (Step 14.6).
          // noteInfoMapRef does not need rebuilding — it depends only on MEI text,
          // which is unchanged by scale/transpose/font re-renders.
          const midi = await renderMidi(tkRef.current);
          highlightScheduleRef.current = buildHighlightSchedule(tkRef.current);
          // Recompute beat duration — transposition may change tempo in the timemap.
          const tempo = getTimemapTempo(tkRef.current);
          const meterUnit = parseMeiMeterUnit(meiTextRef.current ?? '');
          beatDurationMsRef.current = (60_000 / tempo) * (4 / meterUnit);
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
      // Reset note info map so stale data from a previous score is not used
      // while the new MEI loads. Rebuilt synchronously after meiText is fetched.
      noteInfoMapRef.current = new Map();

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
        // Build note info map synchronously from MEI (DOMParser, no toolkit needed).
        // Built once per score load; does not need rebuilding on options re-renders.
        noteInfoMapRef.current = buildNoteInfoMap(meiText);

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
              // Compute beat duration for timing-based beat fallback (Step 18.3).
              // beatDurationMs = (60 000 / bpm) × (4 / meterUnit), where meterUnit
              // is the denominator of the time signature (4 for 4/4, 8 for 6/8, etc.)
              const tempo = getTimemapTempo(tk);
              const meterUnit = parseMeiMeterUnit(meiTextRef.current ?? '');
              beatDurationMsRef.current = (60_000 / tempo) * (4 / meterUnit);
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

        {/* Centred controls group — middle column of the 1fr/auto/1fr grid */}
        <div className={styles.toolbarControls}>
          {/* Staff size presets */}
          <div className={styles.staffSizeControl} role="group" aria-label="Staff size">
            <Type
              variant="label-md"
              as="span"
              style={{ color: 'var(--color-on-surface-variant)' }}
            >
              Size
            </Type>
            {([35, 45, 55] as ScalePreset[]).map((s) => (
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
              Its offsetWidth (≤ 1200px via max-width) is what we pass to
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

            {/* Position display: MEI @n bar and beat-in-denominator-unit.
                Uses displayPosition (from bar schedule) when available;
                falls back to playbackPosition (Tone.js counter) via the
                sync effect when the bar schedule is empty. */}
            <Type
              variant="label-md"
              as="span"
              className={styles.positionDisplay}
              aria-live="polite"
              aria-label={`Bar ${displayPosition.bar}, beat ${displayPosition.beat}`}
            >
              {isPlaybackAvailable
                ? `${displayPosition.bar}:${displayPosition.beat}`
                : '—'}
            </Type>
          </>
        )}
      </Surface>
    </div>
  );
}
