/**
 * THROWAWAY SPIKE — Component 10 Step 12 (Part 5).
 *
 * Renders one whole movement as a SINGLE HORIZONTAL SYSTEM (Verovio
 * `breaks: 'none'`) and drives horizontal auto-scroll from MIDI playback
 * position, to learn — before Component 16 (scrollytelling) depends on it —
 * whether Verovio fights us at movement length: does single-system layout
 * hold, does horizontal scroll stay in sync with playback, and what are the
 * performance / layout-stability limits.
 *
 * This is NOT production code. It is a dev-only route (`/spike/horizontal`,
 * gated behind `import.meta.env.DEV` in App.tsx) whose only deliverable is the
 * findings report at `docs/reports/component-10-horizontal-rendering-spike.md`.
 * It deliberately reuses the real infrastructure — `getVerovioToolkit`,
 * `buildHighlightSchedule`, `useMidiPlayback` — so the findings reflect the
 * actual rendering/playback path Component 16 would build on.
 *
 * The CLAUDE.md SVG-overlay rule is respected for the moving caret (an
 * absolutely-positioned HTML element above the SVG). The note highlight toggles
 * a class on the Verovio group purely for spike visibility; it is safe here
 * only because the score is rendered once and never re-rendered during
 * playback (a re-render would discard it) — see the report's caveats.
 */

/* eslint-disable i18next/no-literal-string -- throwaway dev-only spike, not translated */

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildHighlightSchedule, getVerovioToolkit } from '../../services/verovio';
import { fetchMeiUrl } from '../../services/scoreApi';
import { useMidiPlayback } from '../../hooks/useMidiPlayback';

type Toolkit = Awaited<ReturnType<typeof getVerovioToolkit>>;
type Schedule = Array<{ timeMs: number; ids: string[] }>;

interface Metrics {
  measureCount: number;
  renderMs: number;
  midiMs: number;
  timemapMs: number;
  svgWidthPx: number;
  svgHeightPx: number;
  scheduleLen: number;
}

/** Largest schedule index whose timeMs <= t (binary search; -1 if none). */
function activeIndex(schedule: Schedule, t: number): number {
  let lo = 0;
  let hi = schedule.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (schedule[mid]!.timeMs <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

export default function HorizontalRenderSpike() {
  const [movementId, setMovementId] = useState('');
  const [pageWidth, setPageWidth] = useState(30000);
  const [scale, setScale] = useState(40);
  const [leadFraction, setLeadFraction] = useState(0.33); // caret rest position
  const [status, setStatus] = useState('Enter a movement id and Load.');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [midiBase64, setMidiBase64] = useState<string | null>(null);
  const [fps, setFps] = useState(0);
  const [maxJumpPx, setMaxJumpPx] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLDivElement | null>(null);
  const tkRef = useRef<Toolkit | null>(null);
  const scheduleRef = useRef<Schedule>([]);
  const lastIdxRef = useRef<number>(-1);
  const lastActiveElRef = useRef<Element | null>(null);
  // FPS + jank instrumentation.
  const frameTimesRef = useRef<number[]>([]);
  const lastScrollLeftRef = useRef<number>(0);

  const load = useCallback(async () => {
    const id = movementId.trim();
    if (!id) {
      setStatus('Enter a movement id first.');
      return;
    }
    setStatus('Loading MEI…');
    setMetrics(null);
    setMidiBase64(null);
    try {
      const { url } = await fetchMeiUrl(id);
      const meiText = await (await fetch(url)).text();

      setStatus('Rendering single system (breaks: none)…');
      const tk = await getVerovioToolkit();
      tkRef.current = tk;

      const t0 = performance.now();
      tk.setOptions({
        scale,
        pageWidth,
        pageHeight: 6000,
        adjustPageHeight: true,
        breaks: 'none', // ← the whole point: one horizontal system, no wrapping
        header: 'none',
        footer: 'none',
        pageMarginTop: 0,
        pageMarginBottom: 0,
        pageMarginLeft: 0,
        pageMarginRight: 0,
        font: 'Bravura',
      });
      tk.loadData(meiText);
      const svg = tk.renderToSVG(1);
      const renderMs = performance.now() - t0;

      const t1 = performance.now();
      const midi = tk.renderToMIDI();
      const midiMs = performance.now() - t1;

      const t2 = performance.now();
      const schedule = buildHighlightSchedule(tk);
      const timemapMs = performance.now() - t2;
      scheduleRef.current = schedule;

      // Inject the SVG (dev-only; no CSP in the Vite dev server).
      const host = scrollRef.current!;
      host.innerHTML = svg;
      const svgEl = host.querySelector('svg');
      const svgWidthPx = svgEl
        ? svgEl.getBoundingClientRect().width || Number(svgEl.getAttribute('width')) || 0
        : 0;
      const svgHeightPx = svgEl ? svgEl.getBoundingClientRect().height : 0;
      const measureCount = host.querySelectorAll('g.measure').length;

      lastIdxRef.current = -1;
      lastActiveElRef.current = null;
      host.scrollLeft = 0;

      setMidiBase64(midi); // renderToMIDI() already returns raw base64
      setMetrics({
        measureCount,
        renderMs,
        midiMs,
        timemapMs,
        svgWidthPx,
        svgHeightPx,
        scheduleLen: schedule.length,
      });
      setStatus(
        `Rendered. ${measureCount} measures, SVG ${Math.round(svgWidthPx)}×${Math.round(
          svgHeightPx
        )}px. Press Play to test scroll-sync.`
      );
    } catch (err) {
      setStatus(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, [movementId, pageWidth, scale]);

  // Playback position → highlight + horizontal scroll follow.
  const onPositionUpdate = useCallback(
    (timeMs: number) => {
      const schedule = scheduleRef.current;
      const host = scrollRef.current;
      if (!host || schedule.length === 0) return;

      // FPS + jank instrumentation.
      const now = performance.now();
      const ft = frameTimesRef.current;
      ft.push(now);
      while (ft.length > 0 && ft[0]! < now - 1000) ft.shift();
      setFps(ft.length);

      const idx = activeIndex(schedule, timeMs);
      if (idx < 0 || idx === lastIdxRef.current) return;
      lastIdxRef.current = idx;

      const id = schedule[idx]!.ids[0];
      if (!id) return;
      const el = host.querySelector(`#${CSS.escape(id)}`);
      if (!el) return;

      // Highlight (class toggle — spike only; safe because no re-render here).
      lastActiveElRef.current?.classList.remove('spike-active');
      el.classList.add('spike-active');
      lastActiveElRef.current = el;

      // Content-space x of the note center.
      const elRect = el.getBoundingClientRect();
      const contRect = host.getBoundingClientRect();
      const contentX = elRect.left - contRect.left + host.scrollLeft + elRect.width / 2;

      // Scroll so the caret rests at `leadFraction` from the left edge.
      const target = contentX - host.clientWidth * leadFraction;
      const jump = Math.abs(target - lastScrollLeftRef.current);
      setMaxJumpPx((m) => (jump > m ? jump : m));
      lastScrollLeftRef.current = target;
      host.scrollLeft = target;

      // Position the fixed caret overlay (HTML element above the SVG).
      if (caretRef.current) {
        caretRef.current.style.left = `${host.clientWidth * leadFraction}px`;
      }
    },
    [leadFraction]
  );

  const {
    status: pbStatus,
    position,
    play,
    pause,
    stop,
  } = useMidiPlayback(midiBase64, onPositionUpdate);

  useEffect(() => {
    if (pbStatus !== 'playing') {
      frameTimesRef.current = [];
      setFps(0);
    }
  }, [pbStatus]);

  return (
    <div style={{ padding: 16, fontFamily: 'Public Sans, sans-serif', color: '#1c2b36' }}>
      <style>{`.spike-active, .spike-active * { fill: #c1440e !important; }`}</style>
      <h1 style={{ fontSize: 18, marginBottom: 8 }}>
        Horizontal single-system rendering spike (throwaway — Step 12)
      </h1>

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label>
          Movement id
          <br />
          <input
            value={movementId}
            onChange={(e) => setMovementId(e.target.value)}
            placeholder="UUID of a movement"
            style={{ width: 320, padding: 4 }}
          />
        </label>
        <label>
          pageWidth
          <br />
          <input
            type="number"
            value={pageWidth}
            onChange={(e) => setPageWidth(Number(e.target.value))}
            style={{ width: 100, padding: 4 }}
          />
        </label>
        <label>
          scale
          <br />
          <input
            type="number"
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            style={{ width: 70, padding: 4 }}
          />
        </label>
        <label>
          caret lead
          <br />
          <input
            type="number"
            step="0.05"
            min="0"
            max="0.9"
            value={leadFraction}
            onChange={(e) => setLeadFraction(Number(e.target.value))}
            style={{ width: 70, padding: 4 }}
          />
        </label>
        <button onClick={() => void load()} style={{ padding: '6px 12px' }}>
          Load
        </button>
        <button onClick={() => void play()} disabled={!midiBase64} style={{ padding: '6px 12px' }}>
          ▶ Play
        </button>
        <button onClick={pause} style={{ padding: '6px 12px' }}>
          ❚❚ Pause
        </button>
        <button onClick={stop} style={{ padding: '6px 12px' }}>
          ■ Stop
        </button>
      </div>

      <p style={{ fontSize: 13, margin: '10px 0' }}>{status}</p>

      <div
        style={{
          display: 'flex',
          gap: 18,
          fontSize: 12,
          fontVariantNumeric: 'tabular-nums',
          marginBottom: 8,
        }}
      >
        <span>playback: {pbStatus}</span>
        <span>
          bar {position.bar} · beat {position.beat}
        </span>
        <span>fps: {fps}</span>
        <span>max scroll jump: {Math.round(maxJumpPx)}px</span>
        {metrics && (
          <>
            <span>measures: {metrics.measureCount}</span>
            <span>render: {metrics.renderMs.toFixed(0)}ms</span>
            <span>midi: {metrics.midiMs.toFixed(0)}ms</span>
            <span>timemap: {metrics.timemapMs.toFixed(0)}ms</span>
            <span>
              svg: {Math.round(metrics.svgWidthPx)}×{Math.round(metrics.svgHeightPx)}px
            </span>
            <span>schedule: {metrics.scheduleLen}</span>
          </>
        )}
      </div>

      <div style={{ position: 'relative' }}>
        {/* Fixed caret overlay — HTML above the SVG (overlay rule). */}
        <div
          ref={caretRef}
          style={{
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: 2,
            background: 'rgba(193,68,14,0.6)',
            pointerEvents: 'none',
            zIndex: 2,
            left: '33%',
          }}
        />
        <div
          ref={scrollRef}
          style={{
            overflowX: 'auto',
            overflowY: 'hidden',
            border: '1px solid #b9c6d0',
            background: '#fbf9f0',
            minHeight: 260,
            whiteSpace: 'nowrap',
          }}
        />
      </div>

      <p style={{ fontSize: 12, color: '#5a6b78', marginTop: 8 }}>
        Try a short movement and a long one. Watch: does the single system render at all (or does
        Verovio wrap / choke)? Is scroll-follow smooth or janky? Note the render time, SVG width,
        and fps. Record observations in the findings report.
      </p>
    </div>
  );
}
