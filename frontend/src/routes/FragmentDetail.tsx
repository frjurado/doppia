/**
 * Fragment detail page — isolated Verovio render + MIDI + record display.
 *
 * Component 8 Steps 11–12:
 *   Step 11: isolated Verovio render constrained to the fragment's mc_start/mc_end
 *     via renderFragment(), MIDI playback via useMidiPlayback, and sub-part bracket
 *     overlays positioned from SVG measure geometry.
 *   Step 12: full record display (summary, properties, harmony events with
 *     bass/soprano pitch, prose annotation, sub-parts, data licence) using
 *     FragmentDetailPanel in standalone mode. Rendering-context contract
 *     published as ADR-024 on the backend (GET /fragments/{id}?context.mode=).
 *
 * Overlay rule (CLAUDE.md): all bracket overlays are absolutely-positioned HTML
 * elements above the SVG; Verovio's SVG is never modified. The one exception is
 * the .is-playing CSS class toggled on SVG note elements during playback — it
 * adds no nodes and is cleared automatically when Verovio re-renders.
 *
 * Sub-part brackets (ADR-011 two-level display limit): after the SVG renders,
 * readMeasureRects() walks the MEI DOM to find each measure's xml:id and
 * queries the SVG DOM for its bounding rect. Sub-part bar_start/bar_end (@n
 * values) index into that map to compute bracket left/right/top positions.
 * This mirrors the approach used by buildGhosts() in the score viewer but
 * without creating ghost DOM elements (the annotation affordances are not
 * needed in the detail view).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import FragmentDetailPanel from '../components/score/FragmentDetailPanel';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { useMidiPlayback } from '../hooks/useMidiPlayback';
import { ApiError } from '../services/api';
import type { FragmentDetailResponse } from '../services/fragmentApi';
import { getFragment } from '../services/fragmentApi';
import {
  buildHighlightSchedule,
  buildNoteInfoMap,
  getTimemapTempo,
  getVerovioToolkit,
  parseMeiMeterUnit,
  renderFragment,
  renderMidi,
} from '../services/verovio';
import type { NoteInfo } from '../services/verovio';
import styles from './FragmentDetail.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type ScalePreset = 35 | 45 | 55;
const SCALE_LABELS: Record<ScalePreset, string> = { 35: 'S', 45: 'M', 55: 'L' };

/** Verovio pageWidth for fragment renders. Wide enough to ensure all selected
 *  measures fit on a single line with breaks:"none". The actual SVG is narrower
 *  (naturally sized to content); see docs/architecture/mei-ingest-normalization.md. */
const FRAGMENT_PAGE_WIDTH = 2200;

/** Gap below the last staff bottom before the sub-part bracket top (px). */
const SUB_BRACKET_BELOW_STAFF_GAP = 20;

// ---------------------------------------------------------------------------
// Measure geometry for sub-part bracket projection
// ---------------------------------------------------------------------------

interface MeasureRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Read measure bounding rects from the rendered SVG by correlating MEI
 * xml:id values with SVG element IDs.
 *
 * Used exclusively for sub-part bracket positioning in the isolated detail
 * view. For annotation ghost infrastructure use buildGhosts() instead.
 *
 * @param container - The score content element (position: relative).
 * @param meiText   - Normalized MEI content string for the loaded fragment.
 * @returns Map from @n (integer bar number) to container-relative rect.
 */
function readMeasureRects(
  container: HTMLElement,
  meiText: string,
): Map<number, MeasureRect> {
  const map = new Map<number, MeasureRect>();
  try {
    const cr = container.getBoundingClientRect();
    const meiDoc = new DOMParser().parseFromString(meiText, 'text/xml');
    const meiMeasures = meiDoc.getElementsByTagName('measure');
    for (let mi = 0; mi < meiMeasures.length; mi++) {
      const m = meiMeasures[mi]!;
      // xml:id may be namespace-qualified in some encodings.
      const xmlId =
        m.getAttribute('xml:id') ??
        m.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id');
      if (!xmlId) continue;
      const svgEl = container.querySelector(`[id="${CSS.escape(xmlId)}"]`);
      if (!svgEl) continue;
      const r = svgEl.getBoundingClientRect();
      const barN = parseInt(m.getAttribute('n') ?? `${mi + 1}`, 10);
      if (isNaN(barN)) continue;
      // Deduplicate: first occurrence wins (first/second ending share @n).
      if (!map.has(barN)) {
        map.set(barN, {
          left:   r.left   - cr.left,
          right:  r.right  - cr.left,
          top:    r.top    - cr.top,
          bottom: r.bottom - cr.top,
        });
      }
    }
  } catch {
    // Return partial map on parse / DOM error.
  }
  return map;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Fragment detail page — `/fragments/:fragmentId`.
 *
 * Loading sequence:
 *   getFragment() → fragment record (mei_url, mc_start/mc_end from Step 9)
 *   → fetch MEI text → getVerovioToolkit() → renderFragment() → setSvgString
 *   → renderMidi() → buildHighlightSchedule() → useMidiPlayback ready
 *
 * Sub-part brackets build after svgString updates: readMeasureRects() queries
 * the live SVG DOM (requestAnimationFrame ensures post-paint) and stores
 * a barN → rect map used to position bracket overlays.
 */
export default function FragmentDetail() {
  usePageTitle('Fragment — Doppia');
  const { fragmentId } = useParams<{ fragmentId: string }>();
  const navigate = useNavigate();

  // ── Fragment fetch ──────────────────────────────────────────────────────
  const [fragment, setFragment] = useState<FragmentDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!fragmentId) return;
    setIsLoading(true);
    getFragment(fragmentId)
      .then(setFragment)
      .catch((err) => { if (err instanceof ApiError) setError(err); })
      .finally(() => setIsLoading(false));
  }, [fragmentId]);

  // ── Render state ────────────────────────────────────────────────────────
  const [svgString, setSvgString] = useState<string | null>(null);
  const [midiBase64, setMidiBase64] = useState<string | null>(null);
  const [renderStatus, setRenderStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [renderError, setRenderError] = useState<string | null>(null);
  const [scale, setScale] = useState<ScalePreset>(35);
  const [measureRects, setMeasureRects] = useState<Map<number, MeasureRect>>(new Map());
  const [displayPosition, setDisplayPosition] = useState({ bar: 1, beat: 1 });

  // ── Stable refs ─────────────────────────────────────────────────────────
  const tkRef        = useRef<Awaited<ReturnType<typeof getVerovioToolkit>> | null>(null);
  const meiTextRef   = useRef<string | null>(null);
  // Tracks which fragment's MEI is currently cached, so scale changes skip
  // the fetch and re-render from meiTextRef.current instead.
  const lastFragIdRef          = useRef<string | null>(null);
  const highlightScheduleRef   = useRef<Array<{ timeMs: number; ids: string[] }>>([]);
  const highlightedElsRef      = useRef<Element[]>([]);
  const noteInfoMapRef         = useRef<Map<string, NoteInfo>>(new Map());
  const scoreContainerRef      = useRef<HTMLDivElement | null>(null);
  const currentBarRef          = useRef<{ barN: number; startMs: number }>({ barN: 1, startMs: 0 });
  const beatDurationMsRef      = useRef<number>(500);
  // Mirror scale into a ref so the async render function always sees the
  // value that was current when the effect triggered (no stale closure).
  const scaleRef = useRef<ScalePreset>(35);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  // ── MEI fetch + Verovio render ──────────────────────────────────────────
  useEffect(() => {
    if (!fragment) return;
    if (!fragment.mei_url || fragment.mc_start == null || fragment.mc_end == null) {
      setRenderStatus('error');
      setRenderError('MEI URL unavailable for this fragment.');
      return;
    }

    let cancelled = false;
    setRenderStatus('loading');

    async function run() {
      let meiText = meiTextRef.current;
      let tk = tkRef.current;

      // Re-fetch MEI only when the fragment changes; reuse cache on scale change.
      if (lastFragIdRef.current !== fragment!.id || !meiText || !tk) {
        [meiText, tk] = await Promise.all([
          fetch(fragment!.mei_url!).then((r) => r.text()),
          getVerovioToolkit(),
        ]);
        if (cancelled) return;
        meiTextRef.current = meiText;
        tkRef.current      = tk;
        lastFragIdRef.current = fragment!.id;
        noteInfoMapRef.current = buildNoteInfoMap(meiText);
      }

      const svg = await renderFragment(
        tk, meiText,
        fragment!.mc_start, fragment!.mc_end,
        { scale: scaleRef.current, transpose: '', font: 'Bravura', pageWidth: FRAGMENT_PAGE_WIDTH },
      );
      if (cancelled) return;
      setSvgString(svg);

      const midi = await renderMidi(tk);
      if (cancelled) return;
      highlightScheduleRef.current = buildHighlightSchedule(tk);
      const tempo     = getTimemapTempo(tk);
      const meterUnit = parseMeiMeterUnit(meiText);
      beatDurationMsRef.current = (60_000 / tempo) * (4 / meterUnit);

      // Clear any stale playback highlight from a previous fragment.
      for (const el of highlightedElsRef.current) el.classList.remove('is-playing');
      highlightedElsRef.current = [];

      setMidiBase64(midi);
      setRenderStatus('ready');
    }

    run().catch((err) => {
      if (!cancelled) {
        setRenderError(String(err));
        setRenderStatus('error');
      }
    });

    return () => { cancelled = true; };
  // fragment is accessed inside run() via the closure, but we only want to
  // re-run when these specific fields change — using optional chaining on
  // individual fields rather than fragment object identity is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment?.id, fragment?.mei_url, fragment?.mc_start, fragment?.mc_end, scale]);

  // ── Sub-part bracket geometry ───────────────────────────────────────────
  // Rebuild measure rects after each SVG render (post-paint via RAF).
  useEffect(() => {
    if (!svgString || !scoreContainerRef.current || !meiTextRef.current) {
      setMeasureRects(new Map());
      return;
    }
    const container = scoreContainerRef.current;
    const meiText   = meiTextRef.current;
    const raf = requestAnimationFrame(() => {
      setMeasureRects(readMeasureRects(container, meiText));
    });
    return () => cancelAnimationFrame(raf);
  }, [svgString]);

  // ── Playback highlight (mirrors ScoreViewer.handlePositionUpdate) ────────
  const handlePositionUpdate = useCallback((timeMs: number) => {
    // Clear previous highlights unconditionally so they never stick.
    for (const el of highlightedElsRef.current) el.classList.remove('is-playing');
    highlightedElsRef.current = [];

    const schedule = highlightScheduleRef.current;
    if (schedule.length > 0) {
      let lo = 0, hi = schedule.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (schedule[mid].timeMs <= timeMs) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (idx >= 0) {
        for (const id of schedule[idx].ids) {
          const el = document.getElementById(id);
          if (el) { el.classList.add('is-playing'); highlightedElsRef.current.push(el); }
        }
      }
    }

    // Update transport bar display from MEI @n / @tstamp (not Tone.js linear bar).
    if (highlightedElsRef.current.length > 0) {
      const info = noteInfoMapRef.current.get(highlightedElsRef.current[0].id);
      if (info) {
        if (info.beat > 0) {
          setDisplayPosition({ bar: info.barN, beat: info.beat });
        } else {
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

  const {
    status:   playbackStatus,
    position: playbackPosition,
    play, pause, stop,
  } = useMidiPlayback(midiBase64, handlePositionUpdate);

  const handleStop = useCallback(() => {
    stop();
    for (const el of highlightedElsRef.current) el.classList.remove('is-playing');
    highlightedElsRef.current = [];
  }, [stop]);

  // Reset transport display when playback returns to idle/ready.
  useEffect(() => {
    if (playbackStatus === 'ready' || playbackStatus === 'idle') {
      setDisplayPosition({ bar: 1, beat: 1 });
      currentBarRef.current = { barN: 1, startMs: 0 };
    }
  }, [playbackStatus]);

  // Fallback: when noteInfoMap is empty, display Tone.js raw position.
  useEffect(() => {
    if (noteInfoMapRef.current.size === 0) setDisplayPosition(playbackPosition);
  }, [playbackPosition]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const primaryTag    = fragment?.concept_tags.find((t) => t.is_primary) ?? null;
  const conceptLabel  = primaryTag?.alias ?? primaryTag?.name ?? '—';
  const secondaryTags = fragment?.concept_tags.filter((t) => !t.is_primary) ?? [];

  const movementLabel = fragment
    ? [
        fragment.composer_name,
        [
          fragment.work_title,
          fragment.work_catalogue_number ? `(${fragment.work_catalogue_number})` : null,
        ].filter(Boolean).join(' '),
        fragment.movement_number != null
          ? [
              `mvt. ${fragment.movement_number}`,
              fragment.movement_title,
            ].filter(Boolean).join(' — ')
          : null,
      ].filter(Boolean).join(' — ')
    : null;

  // ── JSX ─────────────────────────────────────────────────────────────────
  return (
    <Surface layer="base" className={styles.page}>
      {/* Nav strip */}
      <Surface layer="container-lowest" className={styles.pageNav}>
        <button
          type="button"
          className={styles.navBack}
          onClick={() => navigate(-1)}
        >
          <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
            ← Fragment Browser
          </Type>
        </button>
        {fragment && (
          <span className={styles.statusBadge} data-status={fragment.status}>
            <Type variant="label-sm" as="span">{fragment.status}</Type>
          </span>
        )}
      </Surface>

      {isLoading && (
        <div className={styles.centered}>
          <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
            Loading…
          </Type>
        </div>
      )}

      {error && (
        <div className={styles.centered}>
          <Type variant="label-sm" as="span" style={{ color: 'var(--color-error)' }}>
            {error.message}
          </Type>
        </div>
      )}

      {fragment && (
        <div className={styles.body}>

          {/* ── Concept identity ─────────────────────────────────────────── */}
          <Surface layer="container-lowest" className={styles.section}>
            <Type variant="title" as="h1" className={styles.conceptTitle}>
              {conceptLabel}
            </Type>
            {primaryTag && primaryTag.hierarchy_path.length > 0 && (
              <Type variant="label-sm" as="p" style={{ color: 'var(--color-on-surface-variant)', margin: 0 }}>
                {primaryTag.hierarchy_path.join(' → ')}
              </Type>
            )}
            {movementLabel && (
              <Type variant="label-sm" as="p" style={{ color: 'var(--color-on-surface-variant)', margin: 0 }}>
                {movementLabel}
              </Type>
            )}
            <Type variant="label-sm" as="p" style={{ color: 'var(--color-on-surface-variant)', margin: 0 }}>
              mm. {fragment.bar_start}–{fragment.bar_end}
              {fragment.beat_start != null
                ? ` · beat ${fragment.beat_start}–${fragment.beat_end}`
                : ''}
            </Type>
            {fragment.data_licence && (
              <Type
                variant="label-sm"
                as="p"
                style={{ color: 'var(--color-on-surface-variant)', opacity: 0.7, margin: 0 }}
              >
                {fragment.data_licence_url ? (
                  <a
                    href={fragment.data_licence_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {fragment.data_licence}
                  </a>
                ) : (
                  fragment.data_licence
                )}
              </Type>
            )}
            {fragment.harmony_sources.length > 0 && (
              <Type
                variant="label-sm"
                as="p"
                style={{ color: 'var(--color-on-surface-variant)', opacity: 0.7, margin: 0 }}
              >
                Sources: {fragment.harmony_sources.join(', ')}
              </Type>
            )}
          </Surface>

          {/* ── Notation area ─────────────────────────────────────────────── */}
          <Surface layer="container-low" className={styles.notationSection}>

            {/* Scale toggle */}
            <div className={styles.scoreControls}>
              <div className={styles.scaleGroup} role="group" aria-label="Staff size">
                {([35, 45, 55] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={scale === s
                      ? `${styles.scaleBtn} ${styles.scaleBtnActive}`
                      : styles.scaleBtn}
                    aria-pressed={scale === s}
                    onClick={() => setScale(s)}
                  >
                    <Type variant="label-sm" as="span">{SCALE_LABELS[s]}</Type>
                  </button>
                ))}
              </div>
            </div>

            {/* Score content (position: relative for overlays) */}
            <div className={styles.scoreContent} ref={scoreContainerRef}>
              {renderStatus === 'loading' && (
                <div className={styles.renderState}>
                  <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
                    Loading notation…
                  </Type>
                </div>
              )}
              {renderStatus === 'error' && (
                <div className={styles.renderState}>
                  <Type variant="label-sm" as="span" style={{ color: 'var(--color-error)' }}>
                    {renderError ?? 'Could not render notation.'}
                  </Type>
                </div>
              )}
              {svgString && (
                <div
                  className={styles.svgPage}
                  dangerouslySetInnerHTML={{ __html: svgString }}
                />
              )}

              {/* Sub-part bracket overlays — ADR-011 two-level display limit.
                  Positioned after SVG renders using SVG measure bounding rects.
                  pointer-events: none; brackets are informational only. */}
              {fragment.sub_parts.length > 0 && measureRects.size > 0 && (
                <div className={styles.subPartOverlayLayer} aria-hidden="true">
                  {fragment.sub_parts.map((sp, idx) => {
                    const spPrimary = sp.concept_tags.find((t) => t.is_primary);
                    const label = spPrimary?.alias ?? spPrimary?.name ?? `Part ${idx + 1}`;
                    const startR = measureRects.get(sp.bar_start);
                    const endR   = measureRects.get(sp.bar_end);
                    if (!startR || !endR) return null;
                    const bracketTop = Math.max(startR.bottom, endR.bottom) + SUB_BRACKET_BELOW_STAFF_GAP;
                    return (
                      <div
                        key={sp.id}
                        className={styles.subPartBracket}
                        data-status={sp.status}
                        style={{
                          left:  startR.left,
                          width: endR.right - startR.left,
                          top:   bracketTop,
                        }}
                      >
                        <span className={styles.subPartLabel}>{label}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Playback bar */}
            <div className={styles.playbackBar}>
              <button
                type="button"
                className={styles.transportButton}
                disabled={playbackStatus === 'idle' || playbackStatus === 'loading-instrument'}
                aria-label={playbackStatus === 'playing' ? 'Pause' : 'Play'}
                onClick={() => {
                  if (playbackStatus === 'playing') pause();
                  else void play();
                }}
              >
                {playbackStatus === 'playing' ? '⏸' : '▶'}
              </button>
              <button
                type="button"
                className={styles.transportButton}
                disabled={playbackStatus === 'idle'}
                aria-label="Stop"
                onClick={handleStop}
              >
                ⏹
              </button>
              {(playbackStatus === 'playing' || playbackStatus === 'paused') && (
                <Type variant="label-sm" as="span" className={styles.positionDisplay}>
                  {displayPosition.bar}:{displayPosition.beat}
                </Type>
              )}
              {playbackStatus === 'loading-instrument' && (
                <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
                  Loading instrument…
                </Type>
              )}
              {playbackStatus === 'instrument-error' && (
                <Type variant="label-sm" as="span" style={{ color: 'var(--color-error)' }}>
                  Instrument unavailable
                </Type>
              )}
            </div>
          </Surface>

          {/* ── Additional concept tags ────────────────────────────────────── */}
          {secondaryTags.length > 0 && (
            <Surface layer="container-lowest" className={styles.section}>
              <Type
                variant="label-sm"
                as="h2"
                style={{ color: 'var(--color-on-surface-variant)', margin: 0 }}
              >
                Also tagged
              </Type>
              <div className={styles.tagList}>
                {secondaryTags.map((t) => (
                  <span key={t.concept_id} className={styles.tagChip}>
                    <Type variant="label-sm" as="span">{t.alias ?? t.name}</Type>
                  </span>
                ))}
              </div>
            </Surface>
          )}

          {/* ── Full fragment record (Component 8 Step 12) ────────────────── */}
          {/* Summary, properties, harmony events (with bass/soprano pitch),
              prose annotation (Commentary), sub-parts, and data licence.
              Reuses FragmentDetailPanel in standalone mode — no panel chrome
              or action buttons, skips the internal getFragment fetch. */}
          <FragmentDetailPanel
            fragmentId={fragment.id}
            initialFragment={fragment}
            tagMode="view"
            standalone
          />

        </div>
      )}
    </Surface>
  );
}
