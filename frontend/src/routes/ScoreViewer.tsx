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

/** Page width in Verovio's internal units. 1400 suits a widescreen score panel. */
const PAGE_WIDTH = 1400;

/** Default staff size (Verovio `scale` option). Medium = 35. */
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
 *      transposition controls.
 *   2. Score panel: Verovio SVG pages rendered progressively.
 *   3. Playback bar (container-highest, fixed bottom): Step 14 placeholder.
 *
 * Loading sequence on mount:
 *   fetchMeiUrl() → fetch MEI text → getVerovioToolkit() → renderProgressively()
 *
 * Options changes (scale / transpose) debounce 200 ms then re-render in the
 * background; the previous SVG stays visible under a translucent overlay
 * until the new render is complete.
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

  // ── Controls state ───────────────────────────────────────────────────────
  const [scale, setScale] = useState<ScalePreset>(DEFAULT_SCALE);
  const [transpose, setTranspose] = useState('');

  // ── Refs (stable across renders, safe to read inside async callbacks) ────
  // Verovio toolkit singleton acquired after WASM loads.
  const tkRef = useRef<Awaited<ReturnType<typeof getVerovioToolkit>> | null>(null);
  // MEI text cached for re-renders; never passed directly to JSX.
  const meiTextRef = useRef<string | null>(null);
  // Debounce timer for options-change re-renders.
  const rerenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of scale / transpose in refs so the debounced callback always reads
  // the latest value without needing them in its dependency list.
  const scaleRef = useRef<ScalePreset>(DEFAULT_SCALE);
  const transposeRef = useRef('');

  // ── Initial load ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!movementId) return;
    let cancelled = false;

    const load = async () => {
      setStatus('loading');
      setLoadingLabel('Loading score…');
      setSvgPages([]);
      setErrorMessage(null);

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
          pageWidth: PAGE_WIDTH,
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

  // ── Re-render (triggered by options changes) ─────────────────────────────
  /**
   * Schedule a debounced re-render with the given options. Rapid changes
   * within the 200 ms window coalesce into a single render call.
   *
   * The previous SVG stays visible while re-rendering; a translucent overlay
   * signals the in-progress render without a blank-screen flash.
   */
  const scheduleRerender = useCallback(
    (newScale: ScalePreset, newTranspose: string) => {
      if (rerenderTimerRef.current) clearTimeout(rerenderTimerRef.current);
      rerenderTimerRef.current = setTimeout(async () => {
        if (!tkRef.current || !meiTextRef.current) return;
        setIsRerendering(true);
        const collectedPages: string[] = [];
        try {
          await renderProgressively(
            tkRef.current,
            meiTextRef.current,
            { scale: newScale, transpose: newTranspose, pageWidth: PAGE_WIDTH },
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

  // ── Control handlers ─────────────────────────────────────────────────────

  const handleScaleChange = (newScale: ScalePreset) => {
    setScale(newScale);
    scaleRef.current = newScale;
    scheduleRerender(newScale, transposeRef.current);
  };

  const handleTransposeChange = (newTranspose: string) => {
    setTranspose(newTranspose);
    transposeRef.current = newTranspose;
    scheduleRerender(scaleRef.current, newTranspose);
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
        <div className={styles.transposeControl}>
          <label htmlFor="transpose-select" className={styles.transposeLabel}>
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
            className={styles.transposeSelect}
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
      </Surface>

      {/* ── Score panel ─────────────────────────────────────────────────── */}
      <div className={styles.scorePanelWrapper}>
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

        {status === 'ready' && (
          <div className={styles.scorePanel}>
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
        )}

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
