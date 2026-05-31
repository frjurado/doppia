import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import FragmentOverlay from '../components/score/FragmentOverlay';
import MainBracket from '../components/score/MainBracket';
import StageBrackets from '../components/score/StageBrackets';
import { buildGhosts } from '../components/score/ghosts';
import type { GhostLayer, ResolutionMode } from '../components/score/ghosts';
import { AnnotationSession, buildRepeatBarriers } from '../components/score/annotator';
import type { AnnotationFlags, SelectionRange } from '../components/score/annotator';
import { buildMcIndex, commitSelection } from '../components/score/selection';
import type { CommittedSelection } from '../components/score/selection';
import type { StageAssignment, SubPartTag } from '../components/score/stages';
import {
  computeStagesComplete,
  prePopulateStages,
  reconcileWithNewConcept,
  reconcileWithSelection,
  toggleStageAbsent,
} from '../components/score/stages';
import FormPanel from '../components/score/FormPanel';
import { useMidiPlayback } from '../hooks/useMidiPlayback';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { fetchMeiUrl } from '../services/scoreApi';
import { buildHighlightSchedule, buildNoteInfoMap, getTimemapTempo, getVerovioToolkit, parseMeiMeterUnit, renderMidi, renderProgressively } from '../services/verovio';
import type { NoteInfo, RenderOptions } from '../services/verovio';
import styles from './ScoreViewer.module.css';
import { transposeKey } from '../utils/transposeKey';
import type { ConceptSchemaTree, ConceptSearchHit, TypeRefinementChild } from '../services/conceptApi';
import { getConceptSchemas } from '../services/conceptApi';

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
 *
 * Ordered as up/down pairs by ascending interval size, per
 * docs/architecture/playback-coordinates.md § Dropdown ordering.
 */
const TRANSPOSE_OPTIONS: ReadonlyArray<{ label: string; value: string }> = [
  { label: 'No transposition',  value: ''    },
  { label: 'Minor 2nd up',      value: 'm2'  },
  { label: 'Minor 2nd down',    value: '-m2' },
  { label: 'Major 2nd up',      value: 'M2'  },
  { label: 'Major 2nd down',    value: '-M2' },
  { label: 'Minor 3rd up',      value: 'm3'  },
  { label: 'Minor 3rd down',    value: '-m3' },
  { label: 'Major 3rd up',      value: 'M3'  },
  { label: 'Major 3rd down',    value: '-M3' },
  { label: 'Perfect 4th up',    value: 'P4'  },
  { label: 'Perfect 4th down',  value: '-P4' },
  { label: 'Tritone up',        value: 'A4'  },
  { label: 'Tritone down',      value: '-A4' },
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

// ---------------------------------------------------------------------------
// TransposeSelect — custom dropdown to support two-tone option text
// ---------------------------------------------------------------------------

interface TransposeSelectProps {
  id: string;
  options: ReadonlyArray<{ label: string; value: string }>;
  value: string;
  onChange: (v: string) => void;
  /** Source key signature (e.g. "G major"). When provided, each option shows
   *  the resultant key in parentheses with a faint colour. */
  sourceKey: string | null;
}

function TransposeSelect({ id, options, value, onChange, sourceKey }: TransposeSelectProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const selected = options.find(o => o.value === value) ?? options[0];
  const selectedResultKey = sourceKey && value ? transposeKey(sourceKey, value) : null;

  return (
    <div ref={containerRef} className={styles.transposeContainer}>
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={styles.transposeButton}
        onClick={() => setOpen(prev => !prev)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
      >
        <span>{selected.label}</span>
        {selectedResultKey && (
          <span className={styles.transposeKeyHint}> ({selectedResultKey})</span>
        )}
      </button>
      {open && (
        <ul role="listbox" aria-label="Transposition" className={styles.transposeDropdown}>
          {options.map(opt => {
            const resultKey = sourceKey && opt.value ? transposeKey(sourceKey, opt.value) : null;
            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={opt.value === value}
                className={
                  opt.value === value
                    ? `${styles.transposeOption} ${styles.transposeOptionSelected}`
                    : styles.transposeOption
                }
                onClick={() => { onChange(opt.value); setOpen(false); }}
              >
                <span>{opt.label}</span>
                {resultKey && (
                  <span className={styles.transposeKeyHint}> ({resultKey})</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export default function ScoreViewer() {
  const { movementId } = useParams<{ movementId: string }>();
  const [searchParams] = useSearchParams();
  /** Source key from the ?key= query param, e.g. "G major". Null if not provided. */
  const sourceKey = searchParams.get('key');
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

  // ── Ghost layer + annotation session (Step 11) ───────────────────────────
  // The ghost layer and annotation session are imperative objects managed
  // outside React state (they interact with the DOM directly). Their lifecycle
  // is tied to the SVG render cycle: rebuilt whenever svgPages changes so that
  // ghost positions match the currently rendered score geometry.
  const ghostLayerRef = useRef<GhostLayer | null>(null);
  const annotationSessionRef = useRef<AnnotationSession | null>(null);
  // Precomputed barN → mc mapping for the currently loaded MEI.
  const mcIndexRef = useRef<Map<string, number> | null>(null);

  // ── Annotation state (Step 11) ────────────────────────────────────────────
  // Exposed to React render tree so MainBracket and future Part 4/5 panels
  // can react to selection and flag changes.
  const [ghostLayer, setGhostLayer] = useState<GhostLayer | null>(null);
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null);
  // Populated at every commit; consumed by Part 4/5 form panels (Steps 12–18).
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [committedSelection, setCommittedSelection] = useState<CommittedSelection | null>(null);
  const [annotationFlags, setAnnotationFlags] = useState<AnnotationFlags>({
    fragmentSet: false,
    conceptSet: false,
    stagesComplete: false,
    propertiesComplete: false,
  });

  // ── Ghost resolution toggle (Step 10) ────────────────────────────────────
  const [resolution, setResolution] = useState<ResolutionMode>('measure');

  // ── Stage state (Step 14) ─────────────────────────────────────────────────
  // Stage assignments are owned here (not in FormPanel) because they must be
  // shared between the StageBrackets overlay (Layer 4) and the FormPanel stage
  // list. The schema tree for the currently-active concept/refinement is cached
  // so it can be re-applied when the main bracket changes.
  const [stageAssignments, setStageAssignments] = useState<StageAssignment[]>([]);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  // The schema tree for the currently active concept (or its refinement child).
  // Cached so reconcileWithNewConcept can compute brand-new default placements.
  const activeSchemaTreeRef = useRef<ConceptSchemaTree | null>(null);

  // ── Sub-part tags (Step 15) ───────────────────────────────────────────────
  // Keyed by stageId; null means the stage has no sub-part tag yet.
  // Cleared (and subPartResetKey incremented) when the main concept changes so
  // sub-part forms reset to empty state automatically.
  const [subPartTags, setSubPartTags] = useState<Record<string, SubPartTag | null>>({});
  const [subPartResetKey, setSubPartResetKey] = useState(0);

  // ── Prose annotation (Step 17) ────────────────────────────────────────────
  // Owned here so the submission payload (Step 18) can read it alongside the
  // selection, concept, and stage data.
  const [proseAnnotation, setProseAnnotation] = useState<string>('');

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

  // ── Stage handlers (Step 14) ─────────────────────────────────────────────

  /**
   * Called from FormPanel when the concept (or refinement) changes.
   * Reconciles existing stage assignments with the new concept's stage list,
   * or pre-populates fresh assignments if none exist.
   * When schemaTree.stages is empty the stage track does not render (§8).
   */
  const handleConceptChange = useCallback(
    (concept: ConceptSearchHit | null, schemaTree: ConceptSchemaTree | null) => {
      activeSchemaTreeRef.current = schemaTree;
      // Clear sub-part tags and reset all SubPartForms whenever the parent
      // concept changes — stage structure may be entirely different.
      setSubPartTags({});
      setSubPartResetKey(k => k + 1);

      if (!concept || !schemaTree || schemaTree.stages.length === 0) {
        setStageAssignments([]);
        setActiveStageId(null);
        return;
      }
      setStageAssignments(prev => {
        if (prev.length === 0) {
          return selectionRange
            ? prePopulateStages(schemaTree.stages, selectionRange)
            : [];
        }
        return reconcileWithNewConcept(prev, schemaTree.stages, selectionRange);
      });
    },
    [selectionRange],
  );

  /**
   * Called from FormPanel when a Type Refinement option is selected or cleared.
   * Fetches the child concept's schema tree and reconciles stage assignments
   * with the child's CONTAINS structure (ADR-011 §7).
   * Passing null clears refinement and re-applies the parent concept's stages.
   */
  const handleRefinementChange = useCallback(
    async (option: TypeRefinementChild | null) => {
      // A refinement change can alter the stage structure, so clear sub-part
      // tags and reset all SubPartForms to avoid stale concept/property data.
      setSubPartTags({});
      setSubPartResetKey(k => k + 1);

      if (!option) {
        // No refinement selected — fall back to the parent concept's stages.
        const parentTree = activeSchemaTreeRef.current;
        if (!parentTree || parentTree.stages.length === 0) {
          setStageAssignments([]);
          return;
        }
        setStageAssignments(prev =>
          reconcileWithNewConcept(prev, parentTree.stages, selectionRange),
        );
        return;
      }
      try {
        const childTree = await getConceptSchemas(option.id);
        activeSchemaTreeRef.current = childTree;
        if (childTree.stages.length === 0) {
          setStageAssignments([]);
          return;
        }
        setStageAssignments(prev => {
          if (prev.length === 0) {
            return selectionRange
              ? prePopulateStages(childTree.stages, selectionRange)
              : [];
          }
          return reconcileWithNewConcept(prev, childTree.stages, selectionRange);
        });
      } catch {
        // Schema fetch failure: keep existing assignments unchanged.
      }
    },
    [selectionRange],
  );

  /** Called by StageBrackets when a split handle drag completes. */
  const handleSplitHandleMove = useCallback((updated: StageAssignment[]) => {
    setStageAssignments(updated);
  }, []);

  /** Called by StageList and StageBrackets for bidirectional linking. */
  const handleStageActivate = useCallback((stageId: string | null) => {
    setActiveStageId(stageId);
  }, []);

  /** Called by StageList absent toggle. */
  const handleToggleAbsent = useCallback((stageId: string, absent: boolean) => {
    setStageAssignments(prev => toggleStageAbsent(prev, stageId, absent));
  }, []);

  /** Called by SubPartForm when a stage's sub-part tag is created or updated. */
  const handleSubPartTagUpdate = useCallback(
    (stageId: string, tag: SubPartTag | null) => {
      setSubPartTags(prev => ({ ...prev, [stageId]: tag }));
    },
    [],
  );

  // Keep stagesComplete in sync with assignments and session.
  useEffect(() => {
    const session = annotationSessionRef.current;
    if (!session) return;
    const complete = computeStagesComplete(stageAssignments);
    session.setStagesComplete(complete);
  }, [stageAssignments]);

  // When the committed selection changes, reconcile stage assignments with
  // the new main bracket bounds.
  useEffect(() => {
    if (!selectionRange) return;
    setStageAssignments(prev => {
      if (prev.length === 0 && activeSchemaTreeRef.current?.stages.length) {
        // First selection after concept was already chosen: pre-populate now.
        return prePopulateStages(activeSchemaTreeRef.current.stages, selectionRange);
      }
      if (prev.length === 0) return prev;
      return reconcileWithSelection(prev, selectionRange);
    });
  }, [selectionRange]);

  // ── Ghost layer + annotation session lifecycle (Step 11) ─────────────────
  //
  // Rebuilt on every svgPages change so ghost positions stay aligned with the
  // rendered SVG geometry. On each rebuild the previous session and layer are
  // destroyed first and the selection state is reset — the user starts a new
  // annotation after any re-render (scale/font/transpose change). This is
  // acceptable for Phase 1; Component 7 can add ghost-position persistence.
  //
  // The effect depends on `svgPages` (array reference changes on each update)
  // rather than `svgPages.length` because the final page addition produces a
  // new array instance that triggers the correct rebuild. Intermediate pages
  // during progressive load produce wasted rebuilds (N−1 extra for N pages),
  // but are correct and acceptable for Phase 1 Mozart scores (2–4 pages).
  useEffect(() => {
    // Require a fully rendered, ready score and all the data it needs.
    if (
      status !== 'ready' ||
      svgPages.length === 0 ||
      !scorePanelRef.current ||
      !meiTextRef.current ||
      !tkRef.current
    ) {
      return;
    }

    const mei       = meiTextRef.current;
    const container = scorePanelRef.current;

    // Teardown: destroy the previous session and layer before building new
    // ones. State resets are batched with the subsequent setGhostLayer call so
    // MainBracket sees a single coherent update.
    annotationSessionRef.current?.destroy();
    ghostLayerRef.current?.destroy();
    annotationSessionRef.current = null;
    ghostLayerRef.current        = null;

    setSelectionRange(null);
    setCommittedSelection(null);
    setAnnotationFlags({
      fragmentSet: false, conceptSet: false,
      stagesComplete: false, propertiesComplete: false,
    });
    // Reset stage state so the ghost layer rebuild starts clean.
    // Stage positions are pixel-anchored to the current render; stale positions
    // would be wrong after a scale/transpose/font change.
    setStageAssignments([]);
    setActiveStageId(null);
    // Reset sub-part tags alongside stages — the stage IDs they reference may
    // have changed, and any stored bounds are tied to the previous render.
    setSubPartTags({});
    setSubPartResetKey(k => k + 1);

    // Build the new ghost layer over the currently rendered SVG.
    const layer = buildGhosts(container, mei);
    ghostLayerRef.current = layer;
    setGhostLayer(layer);

    // Precompute the barN → mc index for the current MEI (used by
    // commitSelection to derive mc_start / mc_end at commit time).
    const mcIdx = buildMcIndex(mei);
    mcIndexRef.current = mcIdx;

    // Build the annotation session with repeat barriers so the drag cannot
    // cross close-repeat barlines (prototype-tagging-tool.md §"Constraints").
    const barriers = buildRepeatBarriers(mei);
    const session  = new AnnotationSession(layer, { closeRepeatMeasures: barriers });
    annotationSessionRef.current = session;

    // Subscribe: resolve mc coordinates at commit time and surface to React.
    session.onSelectionChange((sel) => {
      setSelectionRange(sel);
      setCommittedSelection(sel ? commitSelection(sel, mcIdx) : null);
    });

    session.onFlagsChange((flags) => {
      setAnnotationFlags({ ...flags });
    });

    return () => {
      // DOM cleanup only — setState calls on unmounted components are
      // ignored by React 18 without warning, but avoiding them keeps
      // intent clear. The refs are nulled to prevent stale-closure access.
      annotationSessionRef.current?.destroy();
      ghostLayerRef.current?.destroy();
      annotationSessionRef.current = null;
      ghostLayerRef.current        = null;
    };
  // svgPages reference changes on every page addition/replace — this is the
  // intended trigger; status gates the effect from running during loading.
  }, [status, svgPages]);

  // Forward resolution changes to the active annotation session (Step 10).
  // The session handles the no-op case when the mode is unchanged, and cancels
  // any in-progress drag so a mid-drag toggle does not leave highlight state.
  useEffect(() => {
    annotationSessionRef.current?.setResolution(resolution);
  }, [resolution]);

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
            <TransposeSelect
              id="transpose-select"
              options={TRANSPOSE_OPTIONS}
              value={transpose}
              onChange={handleTransposeChange}
              sourceKey={sourceKey}
            />
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
          {/* Resolution toggle — Measure / Beat / Sub-beat */}
          <div
            className={styles.resolutionControl}
            role="group"
            aria-label="Selection resolution"
          >
            <Type
              variant="label-md"
              as="span"
              style={{ color: 'var(--color-on-surface-variant)' }}
            >
              Select
            </Type>
            {(['measure', 'beat', 'subbeat'] as ResolutionMode[]).map((mode) => {
              const LABELS: Record<ResolutionMode, string> = {
                measure: 'Measure',
                beat: 'Beat',
                subbeat: 'Sub-beat',
              };
              return (
                <button
                  key={mode}
                  type="button"
                  className={[
                    styles.resolutionButton,
                    resolution === mode ? styles.resolutionButtonActive : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => setResolution(mode)}
                  aria-pressed={resolution === mode}
                >
                  <Type variant="label-sm" as="span">{LABELS[mode]}</Type>
                </button>
              );
            })}
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

      {/* ── Score panel + Form panel ─────────────────────────────────────── */}
      <div className={styles.scorePanelWrapper}>
        {/* Status overlays: sit above both panels during loading/error.
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
            {/* Fragment overlay: houses all annotation visuals (brackets, labels).
                Overlays are always HTML elements above the SVG, never injected
                into Verovio's SVG output (CLAUDE.md §"Verovio SVG overlay rule").
                Step 11: MainBracket (Layer 3) renders once fragmentSet is true.
                Step 14: StageBrackets (Layer 4) renders once conceptSet is true
                         and the concept has CONTAINS edges. */}
            <FragmentOverlay>
              <MainBracket
                selection={selectionRange}
                layer={ghostLayer}
                fragmentSet={annotationFlags.fragmentSet}
              />
              <StageBrackets
                assignments={stageAssignments}
                selection={selectionRange}
                layer={ghostLayer}
                visible={annotationFlags.conceptSet && stageAssignments.length > 0}
                activeStageId={activeStageId}
                onStageActivate={handleStageActivate}
                onSplitHandleMove={handleSplitHandleMove}
              />
            </FragmentOverlay>
          </div>
        </div>

        {/* Form panel (Steps 12–14: concept picker, type refinement, stage list,
            property form). Steps 16–18 add harmony panel, prose field, and
            submission checklist. Always rendered — concurrent-flag model. */}
        <FormPanel
          session={annotationSessionRef.current}
          flags={annotationFlags}
          onConceptChange={handleConceptChange}
          onRefinementChange={handleRefinementChange}
          assignments={stageAssignments}
          activeStageId={activeStageId}
          onStageActivate={handleStageActivate}
          onToggleAbsent={handleToggleAbsent}
          subPartTags={subPartTags}
          onSubPartTagUpdate={handleSubPartTagUpdate}
          subPartResetKey={subPartResetKey}
          movementId={movementId}
          selectionRange={selectionRange}
          proseAnnotation={proseAnnotation}
          onProseChange={setProseAnnotation}
        />

        {/* Re-render overlay: sits above both panels while options change */}
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
