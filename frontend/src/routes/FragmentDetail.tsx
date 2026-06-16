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
 * Component 9 Step 15 (fragment viewer remediation):
 *   - Centered, wider layout; header restructured into distinct groups
 *     (concept identity / work / location / source+licence).
 *   - Measure/beat display rule via formatFragmentRange(): beats render only
 *     within their measure's context, never for complete-measure fragments.
 *   - Default staff size Medium (scale 45).
 *   - System breaks allowed (breaks:'smart' at measured container width)
 *     instead of one long system with horizontal scrolling; vertical space is
 *     reserved so brackets are never clipped.
 *   - The main fragment bracket always renders above the score: the rendered
 *     excerpt (whole measures) is not necessarily the significant fragment
 *     (which may be beat-precise, and which future ADR-024 context modes may
 *     embed in surrounding music).
 *
 * Overlay rule (CLAUDE.md): all bracket overlays are absolutely-positioned HTML
 * elements above the SVG; Verovio's SVG is never modified. The one exception is
 * the .is-playing CSS class toggled on SVG note elements during playback — it
 * adds no nodes and is cleared automatically when Verovio re-renders.
 *
 * Bracket geometry (ADR-011 two-level display limit for sub-parts): after the
 * SVG renders, readFragmentGeometry() walks the MEI DOM to find each measure's
 * xml:id, queries the SVG DOM for its bounding rect and its parent system's
 * rect, and collects per-onset note rects. computeBracketSegments() projects a
 * bar/beat range onto that geometry, emitting one segment per system row (the
 * same approach as the tagging tool's MainBracket). Beat-precise endpoints
 * mirror the tagging tool's onset filter: onsets >= beat_start in the start
 * bar, onsets < beat_end in the end bar (beat_end is the exclusive bound —
 * see annotator.ts).
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
  buildFragmentPlayback,
  buildNoteInfoMap,
  getTimemapTempo,
  getVerovioToolkit,
  parseMeiMeterUnit,
  renderFragment,
  renderMidi,
} from '../services/verovio';
import type { FragmentTimeWindow, NoteInfo } from '../services/verovio';
import { formatFragmentRange } from '../utils/fragmentRange';
import styles from './FragmentDetail.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

type ScalePreset = 35 | 45 | 55;
const SCALE_LABELS: Record<ScalePreset, string> = { 35: 'S', 45: 'M', 55: 'L' };
/** Default staff size: Medium (Component 9 Step 15). */
const DEFAULT_SCALE: ScalePreset = 45;

/** Verovio pageWidth fallback when the container cannot be measured (px). */
const FALLBACK_PAGE_WIDTH = 1080;
/** Minimum pageWidth — mirrors ScoreViewer's clamp for narrow containers. */
const MIN_PAGE_WIDTH = 480;

/** Bracket bar height (px) — matches the tagging tool's MainBracket. */
const BRACKET_H = 5;
/** Distance the main bracket sits above its system top: height + small gap. */
const MAIN_BRACKET_ABOVE_SYSTEM_PX = BRACKET_H + 4;
/** Gap below the system bottom before the sub-part bracket top (px). */
const SUB_BRACKET_BELOW_STAFF_GAP = 20;

// ---------------------------------------------------------------------------
// SVG geometry for bracket projection
// ---------------------------------------------------------------------------

interface MeasureRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** Container-relative top of the measure's parent <g class="system">. */
  systemTop: number;
  /** Container-relative bottom of the measure's parent <g class="system">. */
  systemBottom: number;
}

/** One onset's horizontal extent, for beat-precise bracket endpoints. */
interface NoteEdge {
  barN: number;
  tstamp: number;
  left: number;
  right: number;
}

interface FragmentGeometry {
  /** @n (integer bar number) → container-relative measure + system rect. */
  measures: Map<number, MeasureRect>;
  /** Onset rects for note/rest/chord elements carrying @tstamp. */
  notes: NoteEdge[];
}

const EMPTY_GEOMETRY: FragmentGeometry = { measures: new Map(), notes: [] };

/**
 * Read measure, system, and onset bounding rects from the rendered SVG by
 * correlating MEI xml:id values with SVG element IDs.
 *
 * Used exclusively for bracket positioning in the isolated detail view. For
 * annotation ghost infrastructure use buildGhosts() instead.
 *
 * @param container - The score content element (position: relative).
 * @param meiText   - Normalized MEI content string for the loaded fragment.
 * @returns Geometry maps; partial on parse/DOM error.
 */
function readFragmentGeometry(
  container: HTMLElement,
  meiText: string,
): FragmentGeometry {
  const measures = new Map<number, MeasureRect>();
  const notes: NoteEdge[] = [];
  try {
    const cr = container.getBoundingClientRect();
    const meiDoc = new DOMParser().parseFromString(meiText, 'text/xml');

    // xml:id may be namespace-qualified in some encodings.
    const getId = (el: Element): string | null =>
      el.getAttribute('xml:id') ??
      el.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id');

    const meiMeasures = meiDoc.getElementsByTagName('measure');
    for (let mi = 0; mi < meiMeasures.length; mi++) {
      const m = meiMeasures[mi]!;
      const xmlId = getId(m);
      if (!xmlId) continue;
      const svgEl = container.querySelector(`[id="${CSS.escape(xmlId)}"]`);
      if (!svgEl) continue;
      const barN = parseInt(m.getAttribute('n') ?? `${mi + 1}`, 10);
      if (isNaN(barN)) continue;
      // Deduplicate: first occurrence wins (first/second ending share @n).
      // Onset rects are collected only for the kept measure for the same reason.
      if (measures.has(barN)) continue;

      const r = svgEl.getBoundingClientRect();
      // System row geometry: brackets anchor above/below the whole system,
      // not the individual measure's content bbox (which varies with ledger
      // lines and dynamics). Fall back to the measure rect if Verovio's
      // .system group is not found.
      const sysEl = svgEl.closest('g.system') ?? svgEl;
      const sr = sysEl.getBoundingClientRect();
      measures.set(barN, {
        left:         r.left   - cr.left,
        right:        r.right  - cr.left,
        top:          r.top    - cr.top,
        bottom:       r.bottom - cr.top,
        systemTop:    sr.top    - cr.top,
        systemBottom: sr.bottom - cr.top,
      });

      // Onset rects: note/rest/chord elements carrying @tstamp (notes inside
      // chords inherit the chord's onset; the chord rect covers them).
      for (const tag of ['note', 'rest', 'chord']) {
        const els = m.getElementsByTagName(tag);
        for (let i = 0; i < els.length; i++) {
          const el = els[i]!;
          const tsAttr = el.getAttribute('tstamp');
          if (tsAttr === null) continue;
          const tstamp = parseFloat(tsAttr);
          if (Number.isNaN(tstamp)) continue;
          const id = getId(el);
          if (!id) continue;
          const noteEl = container.querySelector(`[id="${CSS.escape(id)}"]`);
          if (!noteEl) continue;
          const nr = noteEl.getBoundingClientRect();
          notes.push({
            barN,
            tstamp,
            left:  nr.left  - cr.left,
            right: nr.right - cr.left,
          });
        }
      }
    }
  } catch {
    // Return partial geometry on parse / DOM error.
  }
  return { measures, notes };
}

/** One bracket segment per SVG system row covered by a bar/beat range. */
interface BracketSegment {
  left: number;
  right: number;
  systemTop: number;
  systemBottom: number;
}

/**
 * Project a bar/beat range onto the rendered SVG, one segment per system row.
 *
 * Measure-resolution bounds come from the measure rects, grouped by system.
 * Beat-precise endpoints refine the first segment's left edge and the last
 * segment's right edge from onset rects, mirroring the tagging tool's filter
 * (annotator.ts): onsets >= beatStart in the start bar are included; onsets
 * >= beatEnd in the end bar are excluded (beat_end is the exclusive bound).
 * When no onset matches (e.g. rects unavailable), the measure edge is kept.
 */
function computeBracketSegments(
  geo: FragmentGeometry,
  barStart: number,
  barEnd: number,
  beatStart: number | null,
  beatEnd: number | null,
): BracketSegment[] {
  const EPS = 1e-6;

  const bySystem = new Map<number, BracketSegment>();
  for (const [barN, r] of geo.measures) {
    if (barN < barStart || barN > barEnd) continue;
    const key = Math.round(r.systemTop);
    const seg = bySystem.get(key);
    if (!seg) {
      bySystem.set(key, {
        left: r.left,
        right: r.right,
        systemTop: r.systemTop,
        systemBottom: r.systemBottom,
      });
    } else {
      seg.left         = Math.min(seg.left, r.left);
      seg.right        = Math.max(seg.right, r.right);
      seg.systemBottom = Math.max(seg.systemBottom, r.systemBottom);
    }
  }
  const segments = [...bySystem.values()].sort((a, b) => a.systemTop - b.systemTop);
  if (segments.length === 0) return [];

  if (beatStart !== null) {
    const xs = geo.notes
      .filter((n) => n.barN === barStart && n.tstamp >= beatStart - EPS)
      .map((n) => n.left);
    if (xs.length > 0) {
      const first = segments[0]!;
      const refined = Math.min(...xs);
      if (refined > first.left && refined < first.right) first.left = refined;
    }
  }
  if (beatEnd !== null) {
    const xs = geo.notes
      .filter((n) => n.barN === barEnd && n.tstamp < beatEnd - EPS)
      .map((n) => n.right);
    if (xs.length > 0) {
      const last = segments[segments.length - 1]!;
      const refined = Math.max(...xs);
      if (refined > last.left && refined < last.right) last.right = refined;
    }
  }

  return segments.filter((s) => s.right - s.left > 0);
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
 * Bracket geometry builds after svgString updates: readFragmentGeometry()
 * queries the live SVG DOM (requestAnimationFrame ensures post-paint) and
 * stores the rect maps used to position the main fragment bracket and the
 * sub-part bracket overlays.
 *
 * Container width: measured synchronously at render-effect time (the effect
 * runs after the score container commits) and re-measured by a debounced
 * ResizeObserver, which triggers a re-render at the new width — the same
 * approach as ScoreViewer's container-width measurement.
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
  const [scale, setScale] = useState<ScalePreset>(DEFAULT_SCALE);
  const [geometry, setGeometry] = useState<FragmentGeometry>(EMPTY_GEOMETRY);
  const [displayPosition, setDisplayPosition] = useState({ bar: 1, beat: 1 });
  // Fragment playback window into the whole-movement MIDI (Step 18). Verovio's
  // renderToMIDI ignores the fragment select(), so playback is constrained by
  // windowing the whole-movement MIDI to the rendered measure range.
  const [fragmentWindow, setFragmentWindow] = useState<FragmentTimeWindow | null>(null);
  // Bumped by the ResizeObserver when the container width changes; a render
  // effect dependency so the SVG re-renders at the new width.
  const [widthEpoch, setWidthEpoch] = useState(0);

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
  const pageWidthRef           = useRef<number>(FALLBACK_PAGE_WIDTH);
  // Mirror scale into a ref so the async render function always sees the
  // value that was current when the effect triggered (no stale closure).
  const scaleRef = useRef<ScalePreset>(DEFAULT_SCALE);
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

    // Measure the container synchronously before any await — the score
    // container is committed by the time this effect runs.
    const measuredWidth = scoreContainerRef.current?.clientWidth ?? 0;
    pageWidthRef.current = Math.max(measuredWidth || FALLBACK_PAGE_WIDTH, MIN_PAGE_WIDTH);

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

      // breaks:'smart' at the measured container width — system breaks are
      // preferable to horizontal scrolling in the detail view (Step 15).
      const svg = await renderFragment(
        tk, meiText,
        fragment!.mc_start, fragment!.mc_end,
        {
          scale: scaleRef.current,
          transpose: '',
          font: 'Bravura',
          pageWidth: pageWidthRef.current,
          breaks: 'smart',
        },
      );
      if (cancelled) return;
      setSvgString(svg);

      const midi = await renderMidi(tk);
      if (cancelled) return;
      // renderToMIDI/renderToTimemap ignore the fragment select(): both emit the
      // whole movement. buildFragmentPlayback windows that output to the rendered
      // measure range (mc_start..mc_end) — note that this is the *rendered*
      // fragment (whole measures), not the beat-precise tagged range — and
      // returns a fragment-relative highlight schedule plus the time window.
      const playback = buildFragmentPlayback(tk, meiText!, fragment!.mc_start, fragment!.mc_end);
      highlightScheduleRef.current = playback.schedule;
      const tempo     = getTimemapTempo(tk);
      const meterUnit = parseMeiMeterUnit(meiText!);
      beatDurationMsRef.current = (60_000 / tempo) * (4 / meterUnit);

      // Clear any stale playback highlight from a previous fragment.
      for (const el of highlightedElsRef.current) el.classList.remove('is-playing');
      highlightedElsRef.current = [];

      setFragmentWindow(playback.window);
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
  }, [fragment?.id, fragment?.mei_url, fragment?.mc_start, fragment?.mc_end, scale, widthEpoch]);

  // ── Container resize → re-render (debounced, >4px threshold) ───────────
  useEffect(() => {
    const el = scoreContainerRef.current;
    if (!el || !fragment || typeof ResizeObserver === 'undefined') return;

    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver((entries) => {
      const newWidth = entries[0]?.contentRect.width ?? 0;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (newWidth > 0 && Math.abs(newWidth - pageWidthRef.current) > 4) {
          setWidthEpoch((e) => e + 1);
        }
      }, 300);
    });
    observer.observe(el);
    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
    };
  // Re-attach when a fragment (and therefore the container) appears.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragment?.id]);

  // ── Bracket geometry ────────────────────────────────────────────────────
  // Rebuild measure/system/onset rects after each SVG render (post-paint via RAF).
  useEffect(() => {
    if (!svgString || !scoreContainerRef.current || !meiTextRef.current) {
      setGeometry(EMPTY_GEOMETRY);
      return;
    }
    const container = scoreContainerRef.current;
    const meiText   = meiTextRef.current;
    const raf = requestAnimationFrame(() => {
      setGeometry(readFragmentGeometry(container, meiText));
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

  // Clear the SVG playback highlight — used both by the Stop button and as the
  // hook's onEnded callback when fragment playback reaches the window end.
  const clearPlaybackHighlights = useCallback(() => {
    for (const el of highlightedElsRef.current) el.classList.remove('is-playing');
    highlightedElsRef.current = [];
  }, []);

  const {
    status:   playbackStatus,
    position: playbackPosition,
    play, pause, stop,
  } = useMidiPlayback(midiBase64, handlePositionUpdate, {
    window: fragmentWindow,
    onEnded: clearPlaybackHighlights,
  });

  const handleStop = useCallback(() => {
    stop();
    clearPlaybackHighlights();
  }, [stop, clearPlaybackHighlights]);

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

  // Header groups (Step 15): work/composer and movement as separate lines.
  const workLine = fragment
    ? [
        fragment.composer_name,
        [
          fragment.work_title,
          fragment.work_catalogue_number ? `(${fragment.work_catalogue_number})` : null,
        ].filter(Boolean).join(' '),
      ].filter(Boolean).join(' — ') || null
    : null;

  const movementLine = fragment
    ? [
        fragment.movement_number != null ? `mvt. ${fragment.movement_number}` : null,
        fragment.movement_title,
      ].filter(Boolean).join(' — ') || null
    : null;

  // Main fragment bracket — always shown above the score (Step 15): the
  // rendered excerpt (whole measures) is not necessarily the significant
  // fragment (which may be beat-precise).
  const mainSegments = fragment && geometry.measures.size > 0
    ? computeBracketSegments(
        geometry,
        fragment.bar_start, fragment.bar_end,
        fragment.beat_start, fragment.beat_end,
      )
    : [];

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
          <div className={styles.bodyInner}>

            {/* ── Header: concept identity / work / location / source+licence ─ */}
            <Surface layer="container-lowest" className={styles.headerSection}>
              <div className={styles.headerIdentity}>
                {primaryTag && primaryTag.hierarchy_path.length > 0 && (
                  <Type variant="label-sm" as="p" className={styles.headerKicker}>
                    {primaryTag.hierarchy_path.join(' → ')}
                  </Type>
                )}
                <Type variant="display-sm" as="h1" className={styles.conceptTitle}>
                  {conceptLabel}
                </Type>
                {workLine && (
                  <Type variant="body-lg" as="p" className={styles.workLine}>
                    {workLine}
                  </Type>
                )}
                {movementLine && (
                  <Type variant="body-sm" as="p" className={styles.movementLine}>
                    {movementLine}
                  </Type>
                )}
              </div>
              <div className={styles.headerMeta}>
                <Type variant="label-md" as="p" className={styles.locationLine}>
                  {formatFragmentRange(
                    fragment.bar_start, fragment.bar_end,
                    fragment.beat_start, fragment.beat_end,
                  )}
                </Type>
                {(fragment.data_licence || fragment.harmony_sources.length > 0) && (
                  <div className={styles.sourceGroup}>
                    {fragment.data_licence && (
                      <Type variant="label-sm" as="p" className={styles.sourceLine}>
                        {fragment.data_licence_url ? (
                          <a
                            href={fragment.data_licence_url}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.sourceLink}
                          >
                            {fragment.data_licence}
                          </a>
                        ) : (
                          fragment.data_licence
                        )}
                      </Type>
                    )}
                    {fragment.harmony_sources.length > 0 && (
                      <Type variant="label-sm" as="p" className={styles.sourceLine}>
                        Sources: {fragment.harmony_sources.join(', ')}
                      </Type>
                    )}
                  </div>
                )}
              </div>
            </Surface>

            {/* ── Notation area ───────────────────────────────────────────── */}
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

              {/* Score content (position: relative for overlays). Vertical
                  padding reserves space so brackets are never clipped — no
                  scrolling required to discover them (Step 15). */}
              <div
                className={fragment.sub_parts.length > 0
                  ? `${styles.scoreContent} ${styles.scoreContentWithSubParts}`
                  : styles.scoreContent}
                ref={scoreContainerRef}
              >
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

                {/* Main fragment bracket — one segment per system row, above
                    the staves. pointer-events: none; informational only. */}
                {mainSegments.length > 0 && (
                  <div className={styles.bracketOverlayLayer} aria-hidden="true">
                    {mainSegments.map((seg, i) => (
                      <div
                        key={i}
                        className={styles.mainBracket}
                        data-testid={i === 0 ? 'fragment-bracket' : `fragment-bracket-${i}`}
                        style={{
                          left:   seg.left,
                          width:  seg.right - seg.left,
                          top:    seg.systemTop - MAIN_BRACKET_ABOVE_SYSTEM_PX,
                          height: BRACKET_H,
                        }}
                      />
                    ))}
                  </div>
                )}

                {/* Sub-part bracket overlays — ADR-011 two-level display limit.
                    One segment per system row, below the staves. */}
                {fragment.sub_parts.length > 0 && geometry.measures.size > 0 && (
                  <div className={styles.subPartOverlayLayer} aria-hidden="true">
                    {fragment.sub_parts.map((sp, idx) => {
                      const spPrimary = sp.concept_tags.find((t) => t.is_primary);
                      const label = spPrimary?.alias ?? spPrimary?.name ?? `Part ${idx + 1}`;
                      const segs = computeBracketSegments(
                        geometry,
                        sp.bar_start, sp.bar_end,
                        sp.beat_start, sp.beat_end,
                      );
                      return segs.map((seg, i) => (
                        <div
                          key={`${sp.id}-${i}`}
                          className={styles.subPartBracket}
                          data-status={sp.status}
                          style={{
                            left:  seg.left,
                            width: seg.right - seg.left,
                            top:   seg.systemBottom + SUB_BRACKET_BELOW_STAFF_GAP,
                          }}
                        >
                          {i === 0 && <span className={styles.subPartLabel}>{label}</span>}
                        </div>
                      ));
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

            {/* ── Additional concept tags ──────────────────────────────────── */}
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

            {/* ── Full fragment record (Component 8 Step 12) ───────────────── */}
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
        </div>
      )}
    </Surface>
  );
}
