import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import FragmentDetailPanel from '../components/score/FragmentDetailPanel';
import FragmentOverlay from '../components/score/FragmentOverlay';
import MainBracket from '../components/score/MainBracket';
import StageBrackets from '../components/score/StageBrackets';
import PlaybackCaret from '../components/score/PlaybackCaret';
import {
  applyCaretPlacement,
  buildCaretTrack,
  CARET_INTERPOLATE,
  hideCaretEl,
  resolveCaret,
} from '../components/score/caret';
import type { CaretTrack } from '../components/score/caret';
import { buildGhosts, measureGhostKey } from '../components/score/ghosts';
import type { GhostLayer, ResolutionMode } from '../components/score/ghosts';
import { measureExclusiveEndBeat, normalizeStageBeats } from '../components/score/stageBeats';
import {
  AnnotationSession,
  buildDirectiveBarriers,
  buildVoltaIndex,
} from '../components/score/annotator';
import type {
  AnnotationFlags,
  AnnotationSessionOptions,
  SelectionRange,
} from '../components/score/annotator';
import {
  buildMcIndex,
  commitSelection,
  measureKeysForMcRange,
} from '../components/score/selection';
import type { CommittedSelection } from '../components/score/selection';
import type {
  BeatSlot,
  StageBounds,
  StageAssignment,
  SubPartTag,
} from '../components/score/stages';
import {
  chooseStageGrid,
  computeResizeClamp,
  computeStagesComplete,
  prePopulateStages,
  prePopulateStagesAtGrid,
  reconcileWithNewConcept,
  toggleStageAbsent,
} from '../components/score/stages';
import { buildStageSlots, respondToMainResize } from '../components/score/stageFrame';
import FormPanel from '../components/score/FormPanel';
import type { FormSubmitData } from '../components/score/FormPanel';
import type { PropertyFormValues } from '../components/score/PropertyForm';
import { useMidiPlayback } from '../hooks/useMidiPlayback';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { fetchMeiUrl } from '../services/scoreApi';
import type { ScoreTitle } from '../services/scoreApi';
import {
  buildHighlightSchedule,
  buildMeasureOnsetIndex,
  buildNoteInfoMap,
  collectGraceNoteIds,
  getTimemapTempo,
  getVerovioToolkit,
  parseMeiMeterUnit,
  renderMidi,
  renderProgressively,
} from '../services/verovio';
import type { NoteInfo, RenderOptions } from '../services/verovio';
import styles from './ScoreViewer.module.css';
import { transposeKey } from '../utils/transposeKey';
import type {
  ContainsStage,
  ConceptSchemaTree,
  ConceptSearchHit,
  TypeRefinementChild,
} from '../services/conceptApi';
import { getConceptSchemas } from '../services/conceptApi';
import {
  createFragment,
  updateFragment,
  submitFragment,
  deleteFragment,
} from '../services/fragmentApi';
import { getHarmonyEvents } from '../services/analysisApi';
import type { HarmonyEventOut } from '../services/analysisApi';
import { HarmonyOverlay } from '../components/score/harmonyOverlay';
import type {
  FragmentDetailResponse,
  FragmentUpdatePayload,
  SubPartPayload,
} from '../services/fragmentApi';
import { parseMeiKey, parseMeiMeter, parseMeiMeterParts } from '../utils/meiParsing';
import { ResolutionIcon } from '../components/score/ResolutionIcons';
import { ApiError } from '../services/api';
import { useStoredFragments } from '../hooks/useStoredFragments';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Staff size used when no explicit preset is selected. */
const DEFAULT_SCALE = 45 as const;

type ScalePreset = 35 | 45 | 55;

/** i18n keys (score namespace) for the staff-size preset labels. */
const SCALE_LABEL_KEYS: Record<ScalePreset, string> = {
  35: 'viewer.scale.small',
  45: 'viewer.scale.medium',
  55: 'viewer.scale.large',
};

/**
 * Transposition intervals mapped to Verovio transposition string format.
 * Empty string = no transposition (identity).
 * All display-only — the MEI file is never modified.
 *
 * Ordered as up/down pairs by ascending interval size, per
 * docs/architecture/playback-coordinates.md § Dropdown ordering.
 */
const TRANSPOSE_OPTIONS: ReadonlyArray<{ labelKey: string; value: string }> = [
  { labelKey: 'viewer.transposeOptions.none', value: '' },
  { labelKey: 'viewer.transposeOptions.m2up', value: 'm2' },
  { labelKey: 'viewer.transposeOptions.m2down', value: '-m2' },
  { labelKey: 'viewer.transposeOptions.maj2up', value: 'M2' },
  { labelKey: 'viewer.transposeOptions.maj2down', value: '-M2' },
  { labelKey: 'viewer.transposeOptions.m3up', value: 'm3' },
  { labelKey: 'viewer.transposeOptions.m3down', value: '-m3' },
  { labelKey: 'viewer.transposeOptions.maj3up', value: 'M3' },
  { labelKey: 'viewer.transposeOptions.maj3down', value: '-M3' },
  { labelKey: 'viewer.transposeOptions.p4up', value: 'P4' },
  { labelKey: 'viewer.transposeOptions.p4down', value: '-P4' },
  { labelKey: 'viewer.transposeOptions.tritoneUp', value: 'A4' },
  { labelKey: 'viewer.transposeOptions.tritoneDown', value: '-A4' },
];

/** Pinned music notation font for all Verovio renders. */
const DEFAULT_FONT = 'Bravura';

/** Env var name shown verbatim in the audio-unavailable notice (not translated). */
const SOUNDFONT_ENV_VAR = 'VITE_SOUNDFONT_BASE_URL';

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

/**
 * Numeric rank for each resolution mode (higher = finer).
 * Used to decide whether a pre-population grid change is a genuine
 * auto-drop to a finer resolution or an unwanted coarsening of a
 * resolution the annotator already set (Step 3 / Component 7).
 */
const GRID_RANK: Record<ResolutionMode, number> = { measure: 0, beat: 1, subbeat: 2 };

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
 *      and transposition controls. Music font is pinned to Bravura.
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
 * Playback caret (Step 14.4; caret since Step 19):
 *   useMidiPlayback fires onPositionUpdate(timeMs) on each animation frame.
 *   handlePositionUpdate binary-searches a pre-built schedule (from
 *   buildHighlightSchedule / renderToTimemap) and drives a moving caret overlay
 *   (PlaybackCaret) via direct style mutation (not React state — avoids
 *   re-render at RAF frequency). The caret track (buildCaretTrack) maps the
 *   schedule's onsets to pixel anchors; resolveCaret interpolates between them.
 *   The timemap-derived schedule correctly expands repeats so the caret retraces
 *   repeated sections. See docs/architecture/playback-coordinates.md §"Playback
 *   caret". The caret is an HTML overlay above the SVG (CLAUDE.md overlay rule),
 *   never injected into Verovio's output.
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
  options: ReadonlyArray<{ labelKey: string; value: string }>;
  value: string;
  onChange: (v: string) => void;
  /** Source key signature (e.g. "G major"). When provided, each option shows
   *  the resultant key in parentheses with a faint colour. */
  sourceKey: string | null;
}

function TransposeSelect({ id, options, value, onChange, sourceKey }: TransposeSelectProps) {
  const { t } = useTranslation('score');
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onPointerDown = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, []);

  const selected = options.find((o) => o.value === value) ?? options[0];
  const selectedResultKey = sourceKey && value ? transposeKey(sourceKey, value) : null;

  return (
    <div ref={containerRef} className={styles.transposeContainer}>
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        className={styles.transposeButton}
        onClick={() => setOpen((prev) => !prev)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      >
        <span>{t(selected.labelKey)}</span>
        {selectedResultKey && (
          <span className={styles.transposeKeyHint}> ({selectedResultKey})</span>
        )}
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label={t('viewer.transpositionAria')}
          className={styles.transposeDropdown}
        >
          {options.map((opt) => {
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
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
              >
                <span>{t(opt.labelKey)}</span>
                {resultKey && <span className={styles.transposeKeyHint}> ({resultKey})</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auto-grid pre-population helpers (Component 7 Step 2)
// ---------------------------------------------------------------------------

/**
 * Choose the finest grid that fits stageCount stages, compute beat/sub-beat
 * positions from the ghost layer, and return the pre-populated assignments.
 *
 * Positions derive from the stage layout frame's slot builder (§6A.1) — the
 * selection's effective measure-key range with beat-precision endpoint
 * filters — so pre-population, the split-handle frame, and the main bracket
 * all agree on the same grid, including across duplicate `@n` values and
 * excluded sibling endings.
 *
 * blocked is true when the selection cannot fit stages even at sub-beat
 * resolution — the caller should surface a UI note and keep assignments empty.
 */
function computeAutoPrePopulate(
  stages: ContainsStage[],
  selection: SelectionRange,
  ghostLayer: GhostLayer | null
): { assignments: StageAssignment[]; grid: ResolutionMode; blocked: boolean } {
  const beatPositions: BeatSlot[] = [];
  const subBeatPositions: BeatSlot[] = [];

  if (ghostLayer) {
    for (const s of buildStageSlots(selection, ghostLayer, 'beat')) {
      beatPositions.push({ barN: s.barN, beatFloat: s.beatFloat ?? 1.0, measureKey: s.measureKey });
    }
    for (const s of buildStageSlots(selection, ghostLayer, 'subbeat')) {
      subBeatPositions.push({
        barN: s.barN,
        beatFloat: s.beatFloat ?? 1.0,
        measureKey: s.measureKey,
      });
    }
  }

  const grid = chooseStageGrid(
    selection,
    stages.length,
    beatPositions.length,
    subBeatPositions.length
  );

  const measureSlots = selection.measureKeys?.length ?? selection.barEnd - selection.barStart + 1;
  const blocked =
    stages.length > 0 &&
    measureSlots < stages.length &&
    beatPositions.length < stages.length &&
    subBeatPositions.length < stages.length;

  if (blocked) return { assignments: [], grid, blocked: true };

  let assignments: StageAssignment[];
  if (grid === 'measure') {
    assignments = prePopulateStages(stages, selection);
  } else if (grid === 'beat') {
    assignments = prePopulateStagesAtGrid(stages, selection, beatPositions);
  } else {
    assignments = prePopulateStagesAtGrid(stages, selection, subBeatPositions);
  }

  return { assignments, grid, blocked: false };
}

/**
 * Restore stage assignments from a fragment's sub-parts (Component 7 Step 12
 * edit flow). Matches each sub-part to its stage by primary concept_id →
 * CONTAINS edge target_id. Sub-parts with no matching stage are silently
 * dropped; stages with no matching sub-part get null bounds (absent for
 * optional, effectively unset for required).
 */
function buildStageAssignmentsFromSubParts(
  subParts: FragmentDetailResponse['sub_parts'],
  stages: ContainsStage[],
  mcIndex: Map<string, number> | null
): StageAssignment[] {
  const subPartMap = new Map<string, FragmentDetailResponse['sub_parts'][number]>();
  for (const sp of subParts) {
    const primary = sp.concept_tags.find((t) => t.is_primary);
    if (primary) subPartMap.set(primary.concept_id, sp);
  }

  return stages.map((stage) => {
    const sp = subPartMap.get(stage.target_id);
    // Recover the physical measure keys from the stored mc interval (§6A.1)
    // so restored bounds project exactly even across duplicate bar numbers.
    let keyStart: string | undefined;
    let keyEnd: string | undefined;
    if (sp && mcIndex) {
      const ctx =
        sp.repeat_context === 'first_ending' || sp.repeat_context === 'second_ending'
          ? sp.repeat_context
          : null;
      const keys = measureKeysForMcRange(mcIndex, sp.mc_start, sp.mc_end, ctx);
      keyStart = keys[0];
      keyEnd = keys[keys.length - 1];
    }
    const bounds: StageBounds | null = sp
      ? {
          barStart: sp.bar_start,
          beatStart: sp.beat_start,
          barEnd: sp.bar_end,
          beatEnd: sp.beat_end,
          keyStart,
          keyEnd,
        }
      : null;
    return {
      stageId: stage.target_id,
      stageName: stage.target_name,
      order: stage.order,
      required: stage.required,
      displayMode: stage.display_mode,
      containmentMode: stage.containment_mode,
      defaultWeight: stage.default_weight,
      bounds,
      // Treat restored stages as confirmed so they don't trigger "limbo" warnings.
      confirmed: bounds !== null,
      absent: bounds === null && !stage.required,
      orphaned: false,
      error: false,
    } satisfies StageAssignment;
  });
}

/**
 * Parse a stored `summary.properties` map into PropertyForm values, converting
 * the serialised "true"/"false" strings back to booleans (mirrors the create
 * flow's serialisation in buildPayload). String and string[] values pass
 * through unchanged; nulls/other types are dropped.
 */
function parseStoredProperties(raw: unknown): PropertyFormValues {
  const values: PropertyFormValues = {};
  if (raw && typeof raw === 'object') {
    for (const [schemaId, val] of Object.entries(raw as Record<string, unknown>)) {
      if (val === 'true') values[schemaId] = true;
      else if (val === 'false') values[schemaId] = false;
      else if (typeof val === 'string' || Array.isArray(val)) {
        values[schemaId] = val as string | string[];
      }
    }
  }
  return values;
}

/**
 * Rebuild the per-stage sub-part tag map from a fragment's stored sub-parts
 * (edit flow). Keyed by stageId = the sub-part's primary concept_id, which is
 * the CONTAINS-edge target_id the stage list keys on. The schema tree is left
 * null so each SubPartForm fetches it on mount and merges these restored
 * property values — without this the stage cards render with empty forms even
 * though the geometry (brackets) restores correctly.
 */
function buildSubPartTagsFromSubParts(
  subParts: FragmentDetailResponse['sub_parts']
): Record<string, SubPartTag> {
  const tags: Record<string, SubPartTag> = {};
  for (const sp of subParts) {
    const primary = sp.concept_tags.find((t) => t.is_primary);
    if (!primary) continue;
    const properties = (sp.summary as Record<string, unknown>)?.properties;
    tags[primary.concept_id] = {
      schemaTree: null,
      propertyValues: parseStoredProperties(properties),
    };
  }
  return tags;
}

/**
 * Finest ghost resolution required by a set of stored beat coordinates: sub-beat
 * for any non-integer endpoint, beat for an integer beat endpoint, else measure.
 *
 * Used when restoring a fragment for edit/review so its beat-precise stage
 * bounds project at their own precision. Without it the active resolution stays
 * at its default ('measure') and findStartSlot snaps an off-beat-1 stage start
 * to the whole-measure slot — the stage renders from the bar's left edge.
 */
function finestBeatResolution(
  coords: ReadonlyArray<{ beat_start: number | null; beat_end: number | null }>
): ResolutionMode {
  const isSubBeat = (v: number | null): boolean => v !== null && !Number.isInteger(v);
  let rank = 0; // measure
  for (const c of coords) {
    if (isSubBeat(c.beat_start) || isSubBeat(c.beat_end)) return 'subbeat';
    if (c.beat_start !== null || c.beat_end !== null) rank = Math.max(rank, 1);
  }
  return rank === 1 ? 'beat' : 'measure';
}

export default function ScoreViewer() {
  const { t } = useTranslation(['score', 'common']);
  const { movementId } = useParams<{ movementId: string }>();
  const [searchParams] = useSearchParams();
  /** Source key from the ?key= query param, e.g. "G major". Null if not provided. */
  const sourceKey = searchParams.get('key');
  /** Fragment UUID from ?fragmentId= — set by the review queue to auto-open a fragment. */
  const focusFragmentId = searchParams.get('fragmentId');
  usePageTitle(t('score:viewer.pageTitle'));

  // ── Viewer state ────────────────────────────────────────────────────────
  const [status, setStatus] = useState<ViewerStatus>('loading');
  const [loadingLabel, setLoadingLabel] = useState(() => t('score:viewer.loadingScore'));
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [svgPages, setSvgPages] = useState<string[]>([]);
  const [isRerendering, setIsRerendering] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);
  // G7: title sourced from MEI <meiHead> and rendered as an HTML block above
  // the score, replacing Verovio's suppressed <pgHead> output.
  const [scoreTitle, setScoreTitle] = useState<ScoreTitle | null>(null);

  // ── Tagging mode (G1.1) ──────────────────────────────────────────────────
  // 'view' = score-only; ghost layer inert, FormPanel not mounted.
  // 'tag'  = ghost layer interactive, annotator live, FormPanel mounted.
  // Resets to 'view' on each score open (movementId change).
  const [tagMode, setTagMode] = useState<'view' | 'tag'>('view');

  // ── Controls state ───────────────────────────────────────────────────────
  const [scale, setScale] = useState<ScalePreset>(DEFAULT_SCALE);
  const [transpose, setTranspose] = useState('');

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
    bar: 1,
    beat: 1,
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
  // Playback caret (Step 19): the overlay element, driven imperatively, and the
  // caret track rebuilt after each render. Using refs avoids React re-renders at
  // RAF frequency — the caret's transform is mutated directly per frame.
  const caretElRef = useRef<HTMLDivElement | null>(null);
  const caretTrackRef = useRef<CaretTrack | null>(null);
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
  // Grace-note xml:ids from collectGraceNoteIds(), built alongside
  // noteInfoMapRef. Excludes ornament onsets from the caret track so the
  // caret doesn't jump ahead and back around an ornamented note (E2).
  const graceIdsRef = useRef<Set<string>>(new Set());
  // Beat duration in ms for the denominator unit (e.g. 250 ms for an eighth
  // note at quarter=120 in a 6/8 piece). Computed from the timemap tempo and
  // MEI @meter.unit after each render. Default 500 ms = quarter note at 120 BPM.
  // Used as the timing-based beat fallback when @tstamp is absent (Step 18.3).
  const beatDurationMsRef = useRef<number>(500);
  // Tracks the start of the current bar during playback. Updated whenever barN
  // changes so we can compute beat = floor((timeMs - barStartMs) / beatDurationMs) + 1.
  // Reset to { barN: 1, startMs: 0 } when playback stops or returns to ready/idle.
  const currentBarRef = useRef<{ barN: number; startMs: number }>({ barN: 1, startMs: 0 });
  // ── Play-from-position (Step 20) ─────────────────────────────────────────
  // The armed playback origin (ms into the whole-movement MIDI). 0 = top of the
  // movement (default). Set by Alt-click on a measure; reset to 0 by Rewind.
  // originMsRef mirrors it for the RAF-frequency handlePositionUpdate and the
  // useMidiPlayback play() read, neither of which should depend on React state.
  const [playbackOriginMs, setPlaybackOriginMs] = useState<number>(0);
  const originMsRef = useRef<number>(0);
  // mc → first-onset ms index over the whole-movement timemap, rebuilt with the
  // highlight schedule after each render. Maps an Alt-clicked measure to its
  // playback origin. Whole-movement (score viewer) only — never set in the
  // fragment detail viewer, which keeps its Step 18 fragment-from-top playback.
  const measureOnsetIndexRef = useRef<Map<number, number>>(new Map());
  // True while the Alt (Option) key is held: gates the play-from-here hover
  // affordance (data-armable on .scoreContent). Tracked globally so it clears on
  // window blur even if the keyup is missed.
  const [altHeld, setAltHeld] = useState(false);

  // ── Ghost layer + annotation session (Step 11) ───────────────────────────
  // The ghost layer and annotation session are imperative objects managed
  // outside React state (they interact with the DOM directly). Their lifecycle
  // is tied to the SVG render cycle: rebuilt whenever svgPages changes so that
  // ghost positions match the currently rendered score geometry.
  const ghostLayerRef = useRef<GhostLayer | null>(null);
  const annotationSessionRef = useRef<AnnotationSession | null>(null);
  // ── Harmony overlay (Component 7 Step 16 / G6.3) ─────────────────────────
  // Imperative overlay; lifecycle mirrors ghost layer (rebuilt on reproject).
  const harmonyOverlayRef = useRef<HarmonyOverlay | null>(null);
  // Cached full-movement events for the overlay. Updated by fetchAllHarmonyEvents
  // and pushed to the overlay via setEvents(); also seed new HarmonyOverlay on
  // every ghost rebuild so the overlay starts populated, not blank.
  const allHarmonyEventsRef = useRef<HarmonyEventOut[]>([]);
  // Precomputed barN → mc mapping for the currently loaded MEI.
  const mcIndexRef = useRef<Map<string, number> | null>(null);
  // G1.3: tracks the (movementId, tagMode) context of the last ghost build so
  // the svgPages effect can distinguish SVG re-renders of the same score
  // (preserve annotator state) from new-score loads or mode changes (full reset).
  const prevScoreKeyRef = useRef<string | null>(null);

  // ── Annotation state (Step 11) ────────────────────────────────────────────
  // Exposed to React render tree so MainBracket and future Part 4/5 panels
  // can react to selection and flag changes.
  const [ghostLayer, setGhostLayer] = useState<GhostLayer | null>(null);
  const [selectionRange, setSelectionRange] = useState<SelectionRange | null>(null);
  // Populated at every commit; consumed by Part 5 submission handlers (Step 18).
  const [committedSelection, setCommittedSelection] = useState<CommittedSelection | null>(null);
  const [annotationFlags, setAnnotationFlags] = useState<AnnotationFlags>({
    fragmentSet: false,
    conceptSet: false,
    stagesComplete: false,
    propertiesComplete: false,
  });

  // ── Ghost resolution toggle (Step 10) ────────────────────────────────────
  const [resolution, setResolution] = useState<ResolutionMode>('measure');
  // Mirrors resolution in a ref so the ghost/session effect can read the
  // current value without needing resolution in its dependency array
  // (adding it would rebuild the session on every resolution change).
  const resolutionRef = useRef<ResolutionMode>('measure');
  // Global meter parsed from the loaded MEI — drives the beat/sub-beat icons
  // (G4.4). Defaults to [4, 4] until the MEI finishes loading.
  const [globalMeter, setGlobalMeter] = useState<[number, number]>([4, 4]);

  // ── Stage state (Step 14) ─────────────────────────────────────────────────
  // Stage assignments are owned here (not in FormPanel) because they must be
  // shared between the StageBrackets overlay (Layer 4) and the FormPanel stage
  // list. The schema tree for the currently-active concept/refinement is cached
  // so it can be re-applied when the main bracket changes.
  const [stageAssignments, setStageAssignments] = useState<StageAssignment[]>([]);
  const [activeStageId, setActiveStageId] = useState<string | null>(null);
  // True while a split-handle drag is in progress — mirrored from
  // StageBrackets so the sidebar stage list freezes its display order for
  // the gesture (Part 8 item 4).
  const [stageDragActive, setStageDragActive] = useState(false);
  // The schema tree for the currently active concept (or its refinement child).
  // Cached so reconcileWithNewConcept can compute brand-new default placements.
  const activeSchemaTreeRef = useRef<ConceptSchemaTree | null>(null);

  // Mirrors stageAssignments in a ref so callbacks can check current length
  // without adding stageAssignments to their dependency arrays.
  const stageAssignmentsRef = useRef<StageAssignment[]>([]);
  // True when the committed selection is too short for the chosen concept's
  // stages even at sub-beat resolution (Step 2 auto-grid; Step 3 will clamp).
  const [stageGridBlocked, setStageGridBlocked] = useState(false);
  // Brief inline note shown when pre-population auto-switches the resolution.
  const [gridAutoSwitchNote, setGridAutoSwitchNote] = useState<string | null>(null);
  const gridNoteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // ── Fragment lifecycle (G1.2) ─────────────────────────────────────────────
  // Passed as `key` to FormPanel so it remounts to a clean state on delete.
  const [fragmentResetKey, setFragmentResetKey] = useState(0);

  // ── Submission state (Step 18) ────────────────────────────────────────────
  // fragmentDraftId: UUID of the in-progress draft, set after the first
  // successful create. Subsequent saves use PATCH; null = not yet saved.
  const [fragmentDraftId, setFragmentDraftId] = useState<string | null>(null);
  // ── Edit session (Component 10 Step 16 — editing a stored fragment) ───────
  // Non-null only while editing an existing stored fragment (not a fresh
  // create). Carries the status so the submission controls can be status-aware
  // (draft/rejected → Save draft + Submit; submitted/approved → single Save
  // changes via PATCH, since POST /submit rejects non-drafts), and the sub-part
  // count so the delete confirmation can name the cascade. Cleared by
  // resetAnnotation (cancel, delete, or a completed save).
  const [editSession, setEditSession] = useState<{
    id: string;
    status: FragmentDetailResponse['status'];
    subPartCount: number;
  } | null>(null);
  const [isSavingChanges, setIsSavingChanges] = useState(false);
  // ── Harmony click-to-focus (Step 16 / G6.3) ──────────────────────────────
  // Set when the annotator clicks an in-score chord label; forwarded to
  // FormPanel → HarmonyPanel to scroll/focus the matching event card.
  const [harmonyFocusKey, setHarmonyFocusKey] = useState<string | null>(null);
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Step 5 — unmissable post-submit confirmation. Owned here (not in FormPanel)
  // so it survives the form remount that the success reset triggers. Auto-
  // dismisses after a generous delay and is cleared as soon as the annotator
  // starts a new fragment; the banner is also manually dismissible.
  const [submitSuccess, setSubmitSuccess] = useState(false);
  // i18n key for the confirmation banner text — differs for a submit vs a
  // status-aware "Save changes" revision (Step 16).
  const [submitSuccessKey, setSubmitSuccessKey] = useState('score:viewer.submitSuccess');
  const submitSuccessTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Stored-fragment overlay (Component 7 Step 10) ─────────────────────────
  // Fetches all stored fragments for the current movement so the overlay can
  // project and display them.  refresh() is called after a successful submit
  // so the newly submitted fragment appears immediately.
  const { fragments: storedFragments, refresh: refreshStoredFragments } =
    useStoredFragments(movementId);

  // While a stored fragment is being edited (fragmentDraftId is its id, set by
  // the session-build effect), hide its stored bracket so it does not render
  // twice — once as the live editing MainBracket and once as the stored overlay
  // bracket, which sat at a slightly different height and duplicated the label.
  const overlayFragments = useMemo(
    () =>
      fragmentDraftId ? storedFragments.filter((f) => f.id !== fragmentDraftId) : storedFragments,
    [storedFragments, fragmentDraftId]
  );

  // ── Fragment detail panel (Component 7 Step 12) ──────────────────────────
  // selectedFragmentId: UUID of the stored fragment whose detail panel is open.
  // Clicking a stored bracket sets this; close button / Edit clears it.
  const [selectedFragmentId, setSelectedFragmentId] = useState<string | null>(null);

  // Auto-open detail panel when ?fragmentId= is present (Step 13: review queue navigation).
  // Fires once storedFragments resolves so the fragment is known to exist on this movement.
  useEffect(() => {
    if (focusFragmentId && storedFragments.some((f) => f.id === focusFragmentId)) {
      setSelectedFragmentId(focusFragmentId);
    }
  }, [focusFragmentId, storedFragments]);
  // Incremented to force a session rebuild when the edit flow is triggered
  // while already in tag mode (tagMode change alone wouldn't fire the effect).
  const [sessionRebuildKey, setSessionRebuildKey] = useState(0);
  // Refs consumed by the session build effect and handleConceptChange during
  // the edit flow.  Using refs avoids adding them to effect dependency arrays.
  const editPrefillRef = useRef<FragmentDetailResponse | null>(null);
  const editSubPartsRef = useRef<FragmentDetailResponse['sub_parts'] | null>(null);
  // Passed as editPrefill to FormPanel on remount so it initialises with the
  // edit fragment's concept and property values.
  const [editPrefillFormData, setEditPrefillFormData] = useState<{
    concept: ConceptSearchHit;
    propertyValues: PropertyFormValues;
  } | null>(null);

  // ── Position update callback (Step 14.4; caret since Step 19) ────────────
  /**
   * Called by useMidiPlayback on each animation frame. Binary-searches the
   * timemap-derived highlight schedule for the latest onset ≤ timeMs, drives the
   * playback caret (Step 19) from the caret track, and updates the transport bar.
   *
   * The schedule is built from renderToTimemap() after each render, which
   * expands repeats correctly: both passes of a repeated section have entries
   * with the same element IDs but different timeMs values. No Verovio calls
   * at playback time.
   */
  const handlePositionUpdate = useCallback((timeMs: number) => {
    const schedule = highlightScheduleRef.current;

    // Play-from-position (Step 20): when an origin is armed, useMidiPlayback
    // shifts playback so the origin is transport time 0, making `timeMs`
    // origin-relative. The schedule and caret track are absolute (whole
    // movement), so add the origin back to query them. originMs = 0 (no origin /
    // after Rewind) makes this the identity — every path below is unchanged.
    const t = timeMs + originMsRef.current;

    // ── Playback caret (Step 19) ─────────────────────────────────────────────
    // Drive the caret overlay imperatively from the caret track. resolveCaret
    // interpolates x between onsets within a system and jumps at system breaks /
    // repeat seams. Hidden before the first onset and when no track is built.
    const caretEl = caretElRef.current;
    if (caretEl) {
      const placement = caretTrackRef.current
        ? resolveCaret(caretTrackRef.current, t, CARET_INTERPOLATE)
        : null;
      if (placement) applyCaretPlacement(caretEl, placement);
      else hideCaretEl(caretEl);
    }

    // ── Transport bar display (Step 18) ──────────────────────────────────────
    // Look up the current onset's first note id in noteInfoMapRef to get the
    // MEI @n bar number and the @tstamp-derived beat (in the time signature's
    // denominator unit). This fixes all three transport-bar sub-defects:
    //
    //   1. Pickup bars: barN = 0 (from MEI @n="0"), beats renumbered from 1.
    //      Tone.js calls the pickup "bar 1" and makes every subsequent bar wrong.
    //
    //   2. Repeats: Step 17 stripped -rendN so the same id resolves on both
    //      passes; the map returns the same barN on both passes.
    //      Tone.js would count linearly (bar 9, 10 … instead of 1, 2 …).
    //
    //   3. 6/8 beats: MEI @tstamp is in eighth-note units, so beat 1–6 are
    //      returned directly. Tone.js counts only 3 quarter-note beats.
    //
    // setDisplayPosition is stable (useState setter) — no extra deps needed.
    if (schedule.length > 0) {
      // Binary-search for the latest onset at or before the current time
      // (absolute, origin-adjusted).
      let lo = 0,
        hi = schedule.length - 1,
        idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (schedule[mid].timeMs <= t) {
          idx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }

      const firstId = idx >= 0 ? schedule[idx].ids[0] : undefined;
      const info = firstId ? noteInfoMapRef.current.get(firstId) : undefined;
      if (info) {
        if (info.beat > 0) {
          // @tstamp present — use directly (already in denominator units).
          setDisplayPosition({ bar: info.barN, beat: info.beat });
        } else {
          // @tstamp absent (e.g. OpenScore MEI) — compute beat from timing.
          // When the bar changes, record the new bar and its start time.
          if (info.barN !== currentBarRef.current.barN) {
            currentBarRef.current = { barN: info.barN, startMs: t };
          }
          const elapsed = t - currentBarRef.current.startMs;
          const beat =
            beatDurationMsRef.current > 0
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
  } = useMidiPlayback(midiBase64, handlePositionUpdate, { originMs: playbackOriginMs });

  // Keep originMsRef in sync for the RAF handler and the hook's play() read.
  useEffect(() => {
    originMsRef.current = playbackOriginMs;
  }, [playbackOriginMs]);

  // Track the Alt (Option) key for the play-from-here hover affordance (Step 20).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(true);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Alt') setAltHeld(false);
    };
    const onBlur = () => setAltHeld(false);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  // ── Play-from-position helpers (Step 20) ─────────────────────────────────

  /**
   * Resolve the transport-bar display (MEI @n bar + beat) for an absolute
   * whole-movement time, by the same schedule/noteInfo lookup the RAF handler
   * uses. Returns 1:1 before the first onset or when the schedule is empty.
   */
  const displayPositionForAbsMs = useCallback((absMs: number): { bar: number; beat: number } => {
    const schedule = highlightScheduleRef.current;
    if (schedule.length === 0 || absMs <= 0) return { bar: 1, beat: 1 };
    let lo = 0,
      hi = schedule.length - 1,
      idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (schedule[mid].timeMs <= absMs) {
        idx = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const firstId = idx >= 0 ? schedule[idx].ids[0] : undefined;
    const info = firstId ? noteInfoMapRef.current.get(firstId) : undefined;
    if (info) return { bar: info.barN, beat: info.beat > 0 ? info.beat : 1 };
    return { bar: 1, beat: 1 };
  }, []);

  /**
   * Park a static caret at the armed origin (no playback). Hidden when the
   * origin is 0 (top of movement) or no caret track is built yet.
   */
  const parkCaretAtOrigin = useCallback(() => {
    const el = caretElRef.current;
    if (!el) return;
    const o = originMsRef.current;
    const track = caretTrackRef.current;
    const placement = o > 0 && track ? resolveCaret(track, o, CARET_INTERPOLATE) : null;
    if (placement) applyCaretPlacement(el, placement);
    else hideCaretEl(el);
  }, []);

  /**
   * Stop playback and return the caret to the armed origin (Step 20: Stop →
   * origin, for easy replay-from-here). Hides the caret when origin is 0.
   * Wraps the hook's stop() because it has no access to caretElRef / origin.
   */
  const handleStop = useCallback(() => {
    stop();
    parkCaretAtOrigin();
  }, [stop, parkCaretAtOrigin]);

  /**
   * Arm a measure as the playback origin (Step 20). Called on Alt-click of a
   * measure in either mode. Sets the origin, parks a static caret there, and
   * updates the transport readout — but does not start playback (set-then-play).
   * If playback is in progress it is stopped first so the new origin takes
   * effect cleanly (the transport resets and the offset query stays consistent).
   */
  const onPlayFromMeasure = useCallback(
    (mc: number) => {
      const ms = measureOnsetIndexRef.current.get(mc);
      if (ms === undefined) return;
      if (playbackStatus === 'playing' || playbackStatus === 'paused') stop();
      originMsRef.current = ms;
      setPlaybackOriginMs(ms);
      const disp = displayPositionForAbsMs(ms);
      setDisplayPosition(disp);
      currentBarRef.current = { barN: disp.bar, startMs: ms };
      parkCaretAtOrigin();
    },
    [playbackStatus, stop, displayPositionForAbsMs, parkCaretAtOrigin]
  );
  // Measure-key entry point used by the annotator (tag mode) and the view-mode
  // controller: resolve a measure ghost key → mc → arm the origin. Held in a ref
  // so those long-lived imperative objects always call the latest closure.
  const playFromMeasureKey = useCallback(
    (measureKey: string) => {
      const mc = mcIndexRef.current?.get(measureKey);
      if (mc !== undefined) onPlayFromMeasure(mc);
    },
    [onPlayFromMeasure]
  );
  const playFromMeasureKeyRef = useRef(playFromMeasureKey);
  useEffect(() => {
    playFromMeasureKeyRef.current = playFromMeasureKey;
  }, [playFromMeasureKey]);

  /**
   * Rewind the playback origin to the top of the movement (Step 20). Resets the
   * caret and transport readout. Disabled while playing or already at the top.
   */
  const handleRewind = useCallback(() => {
    originMsRef.current = 0;
    setPlaybackOriginMs(0);
    hideCaretEl(caretElRef.current);
    setDisplayPosition({ bar: 1, beat: 1 });
    currentBarRef.current = { barN: 1, startMs: 0 };
  }, []);

  // ── Caret track (Step 19) ────────────────────────────────────────────────
  // Rebuild the caret track once the geometry (ghostLayer) and the highlight
  // schedule are both ready — and again on every re-render (scale/transpose/
  // resize change both signals), so the caret survives Verovio re-renders that
  // discard overlay geometry. ghostLayer is set after the SVG is laid out;
  // midiBase64 is set right after the schedule is built.
  useEffect(() => {
    const container = scorePanelRef.current;
    if (!container || highlightScheduleRef.current.length === 0) {
      caretTrackRef.current = null;
      return;
    }
    caretTrackRef.current = buildCaretTrack(
      container,
      highlightScheduleRef.current,
      graceIdsRef.current
    );
  }, [ghostLayer, midiBase64]);

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
      // Step 20: return to the armed origin (not 1:1) so Stop shows the
      // play-from-here point; 1:1 when no origin is armed.
      const o = originMsRef.current;
      const disp = o > 0 ? displayPositionForAbsMs(o) : { bar: 1, beat: 1 };
      setDisplayPosition(disp);
      // Also reset currentBarRef so the first bar after resuming gets a fresh
      // startMs rather than inheriting a stale value from a previous playback.
      currentBarRef.current = { barN: disp.bar, startMs: o };
    }
  }, [playbackStatus, displayPositionForAbsMs]);

  // Reset the play-from-position origin whenever the MIDI changes (score load,
  // transpose, scale/font, resize). A stale origin must never survive a
  // re-render whose timemap/geometry differ; the user re-arms on the new render.
  useEffect(() => {
    originMsRef.current = 0;
    setPlaybackOriginMs(0);
  }, [midiBase64]);

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
            () => {}
          );
          // Atomically swap SVG pages once all are collected.
          setSvgPages([...collectedPages]);

          // Regenerate MIDI and highlight schedule to follow new options (Step 14.6).
          // noteInfoMapRef does not need rebuilding — it depends only on MEI text,
          // which is unchanged by scale/transpose/font re-renders.
          const midi = await renderMidi(tkRef.current);
          highlightScheduleRef.current = buildHighlightSchedule(tkRef.current);
          // mc → onset index for play-from-position (Step 20), rebuilt with the
          // schedule so an armed origin always matches the current timemap.
          measureOnsetIndexRef.current = buildMeasureOnsetIndex(
            tkRef.current,
            meiTextRef.current ?? ''
          );
          // Recompute beat duration — transposition may change tempo in the timemap.
          const tempo = getTimemapTempo(tkRef.current);
          const meterUnit = parseMeiMeterUnit(meiTextRef.current ?? '');
          beatDurationMsRef.current = (60_000 / tempo) * (4 / meterUnit);
          setMidiBase64(midi);

          // Hide the caret — its track is rebuilt against the new geometry by
          // the caret-track effect (keyed on ghostLayer + midiBase64).
          hideCaretEl(caretElRef.current);
        } catch {
          // Keep existing pages on render failure.
        } finally {
          setIsRerendering(false);
        }
      }, 200);
    },
    []
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

  // Mirror stageAssignments into a ref so callbacks can read .length without
  // adding stageAssignments to their dependency arrays.
  useEffect(() => {
    stageAssignmentsRef.current = stageAssignments;
  }, [stageAssignments]);

  // Show a brief inline note when pre-population auto-drops the resolution.
  const showGridNote = useCallback(
    (grid: ResolutionMode, stageCount: number) => {
      if (gridNoteTimerRef.current) clearTimeout(gridNoteTimerRef.current);
      const label =
        grid === 'beat'
          ? t('score:viewer.resolutionLabel.beat')
          : grid === 'subbeat'
            ? t('score:viewer.resolutionLabel.subbeat')
            : t('score:viewer.resolutionLabel.measure');
      setGridAutoSwitchNote(t('score:viewer.gridAutoSwitch', { label, count: stageCount }));
      gridNoteTimerRef.current = setTimeout(() => setGridAutoSwitchNote(null), 4000);
    },
    [t]
  );
  // Clear the timer on unmount.
  useEffect(
    () => () => {
      if (gridNoteTimerRef.current) clearTimeout(gridNoteTimerRef.current);
    },
    []
  );

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
      setSubPartResetKey((k) => k + 1);

      if (!concept || !schemaTree || schemaTree.stages.length === 0) {
        setStageAssignments([]);
        setStageGridBlocked(false);
        setActiveStageId(null);
        return;
      }

      // Edit flow: if editing a stored fragment, restore stage assignments from
      // its sub_parts instead of running auto-pre-population (ADR-011).
      const editSubParts = editSubPartsRef.current;
      if (editSubParts !== null) {
        editSubPartsRef.current = null; // consume
        setStageAssignments(
          buildStageAssignmentsFromSubParts(editSubParts, schemaTree.stages, mcIndexRef.current)
        );
        // Restore each stage's stored sub-part property values (setSubPartTags({})
        // above cleared them) so the sidebar stage forms are prefilled, not just
        // the geometry. Keyed by stageId; SubPartForm fetches the schema on mount.
        setSubPartTags(buildSubPartTagsFromSubParts(editSubParts));
        setStageGridBlocked(false);
        // Raise the active resolution to the finest grid the restored fragment
        // needs, so beat/sub-beat stage bounds render at their own precision.
        // (The auto-pre-populate branch below does the same for fresh stages.)
        const editFragment = editPrefillRef.current;
        const grid = finestBeatResolution(
          editFragment ? [editFragment, ...editSubParts] : editSubParts
        );
        if ((GRID_RANK[grid] ?? 0) > (GRID_RANK[resolutionRef.current] ?? 0)) {
          resolutionRef.current = grid;
          setResolution(grid);
        }
        return;
      }

      if (stageAssignmentsRef.current.length === 0) {
        if (!selectionRange) {
          setStageAssignments([]);
          setStageGridBlocked(false);
          return;
        }
        const { assignments, grid, blocked } = computeAutoPrePopulate(
          schemaTree.stages,
          selectionRange,
          ghostLayerRef.current
        );
        setStageAssignments(assignments);
        setStageGridBlocked(blocked);
        if (!blocked && (GRID_RANK[grid] ?? 0) > (GRID_RANK[resolutionRef.current] ?? 0)) {
          resolutionRef.current = grid;
          setResolution(grid);
          showGridNote(grid, schemaTree.stages.length);
        }
      } else {
        setStageGridBlocked(false);
        setStageAssignments((prev) =>
          reconcileWithNewConcept(prev, schemaTree.stages, selectionRange)
        );
      }
    },
    [selectionRange, showGridNote]
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
      setSubPartResetKey((k) => k + 1);

      if (!option) {
        // No refinement selected — fall back to the parent concept's stages.
        const parentTree = activeSchemaTreeRef.current;
        if (!parentTree || parentTree.stages.length === 0) {
          setStageAssignments([]);
          setStageGridBlocked(false);
          return;
        }
        setStageGridBlocked(false);
        setStageAssignments((prev) =>
          reconcileWithNewConcept(prev, parentTree.stages, selectionRange)
        );
        return;
      }
      try {
        const childTree = await getConceptSchemas(option.id);
        activeSchemaTreeRef.current = childTree;
        if (childTree.stages.length === 0) {
          setStageAssignments([]);
          setStageGridBlocked(false);
          return;
        }

        if (stageAssignmentsRef.current.length === 0) {
          if (!selectionRange) {
            setStageAssignments([]);
            setStageGridBlocked(false);
            return;
          }
          const { assignments, grid, blocked } = computeAutoPrePopulate(
            childTree.stages,
            selectionRange,
            ghostLayerRef.current
          );
          setStageAssignments(assignments);
          setStageGridBlocked(blocked);
          if (!blocked && (GRID_RANK[grid] ?? 0) > (GRID_RANK[resolutionRef.current] ?? 0)) {
            resolutionRef.current = grid;
            setResolution(grid);
            showGridNote(grid, childTree.stages.length);
          }
        } else {
          setStageGridBlocked(false);
          setStageAssignments((prev) =>
            reconcileWithNewConcept(prev, childTree.stages, selectionRange)
          );
        }
      } catch {
        // Schema fetch failure: keep existing assignments unchanged.
      }
    },
    [selectionRange, showGridNote]
  );

  /** Called by StageBrackets on every split handle drag tick. */
  const handleSplitHandleMove = useCallback((updated: StageAssignment[]) => {
    setStageAssignments(updated);
  }, []);

  /** Called by StageList and StageBrackets for bidirectional linking. */
  const handleStageActivate = useCallback((stageId: string | null) => {
    setActiveStageId(stageId);
  }, []);

  /** Called by StageList absent toggle. */
  const handleToggleAbsent = useCallback((stageId: string, absent: boolean) => {
    setStageAssignments((prev) => toggleStageAbsent(prev, stageId, absent));
  }, []);

  /** Called by SubPartForm when a stage's sub-part tag is created or updated. */
  const handleSubPartTagUpdate = useCallback((stageId: string, tag: SubPartTag | null) => {
    setSubPartTags((prev) => ({ ...prev, [stageId]: tag }));
  }, []);

  // ── Delete fragment handler (G1.2) ──────────────────────────────────────
  /**
   * Full reset of the current in-progress annotation. Clears selection, all
   * four concurrent flags, stage assignments, sub-part tags, prose annotation,
   * and remounts FormPanel to a blank concept/property state.
   *
   * This is the single reset path after fragmentSet is true — there is no
   * partial "clear selection only" (tagging-tool-design.md §6).
   *
   * Any previously saved draft persists on the backend (no DELETE request is
   * made); it becomes an orphaned draft until a future delete endpoint removes it.
   */
  /**
   * Return the annotation surface to its initial blank state: clears the
   * selection, all four concurrent flags, stage assignments, sub-part tags,
   * prose annotation, and remounts FormPanel to a blank concept/property
   * state. Shared by Delete (G1.2) and the post-submit reset (Step 5).
   *
   * Does not touch the backend: Delete leaves any saved draft orphaned, and
   * the submit path has already persisted the fragment by the time it calls
   * this. submitSuccess is intentionally left untouched so the caller controls
   * the confirmation banner independently of the reset.
   */
  const resetAnnotation = useCallback(() => {
    annotationSessionRef.current?.reset();
    setSelectionRange(null);
    setCommittedSelection(null);
    setStageAssignments([]);
    setStageGridBlocked(false);
    if (gridNoteTimerRef.current) clearTimeout(gridNoteTimerRef.current);
    setGridAutoSwitchNote(null);
    setActiveStageId(null);
    setSubPartTags({});
    setSubPartResetKey((k) => k + 1);
    setProseAnnotation('');
    setFragmentDraftId(null);
    activeSchemaTreeRef.current = null;
    // Clear any pending edit prefill and its refs. Without this, the
    // fragmentResetKey bump below remounts FormPanel which re-consumes the stale
    // editPrefillFormData — re-populating the concept (but not the stages, whose
    // ref was already consumed) instead of resetting to a blank form.
    setEditPrefillFormData(null);
    editPrefillRef.current = null;
    editSubPartsRef.current = null;
    setEditSession(null);
    setSubmitError(null);
    setFragmentResetKey((k) => k + 1);
  }, []);

  const handleDeleteFragment = useCallback(() => {
    resetAnnotation();
  }, [resetAnnotation]);

  // ── Post-submit confirmation (Step 5) ──────────────────────────────────────
  /**
   * Raise the success banner and arm its auto-dismiss timer. The i18n key
   * varies so a "Save changes" revision reads differently from a fresh submit.
   */
  const showSubmitSuccess = useCallback((messageKey = 'score:viewer.submitSuccess') => {
    if (submitSuccessTimerRef.current) clearTimeout(submitSuccessTimerRef.current);
    setSubmitSuccessKey(messageKey);
    setSubmitSuccess(true);
    submitSuccessTimerRef.current = setTimeout(() => setSubmitSuccess(false), 6000);
  }, []);

  // Clear the pending auto-dismiss timer on unmount.
  useEffect(
    () => () => {
      if (submitSuccessTimerRef.current) clearTimeout(submitSuccessTimerRef.current);
    },
    []
  );

  // Dismiss the confirmation the moment the annotator starts a new fragment —
  // the banner has served its purpose once a fresh selection exists.
  useEffect(() => {
    if (selectionRange && submitSuccess) setSubmitSuccess(false);
  }, [selectionRange, submitSuccess]);

  // ── Fragment detail panel handlers (Component 7 Step 12) ────────────────

  /**
   * Called when the user clicks Edit in the detail panel.
   *
   * Rebuilds the annotation session seeded with the stored fragment's bar/beat
   * selection.  FormPanel is remounted with editPrefill so it restores the
   * concept and property values.  Stage assignments are restored in
   * handleConceptChange via editSubPartsRef.
   */
  const handleEditFragment = useCallback(
    (fragment: FragmentDetailResponse) => {
      // Close the detail panel first.
      setSelectedFragmentId(null);

      // Seed refs consumed by the session build effect and handleConceptChange.
      editPrefillRef.current = fragment;
      editSubPartsRef.current = fragment.sub_parts;

      // Build a ConceptSearchHit from the primary concept tag.
      const primaryTag = fragment.concept_tags.find((t) => t.is_primary);
      if (!primaryTag) return;
      const concept: ConceptSearchHit = {
        id: primaryTag.concept_id,
        name: primaryTag.name,
        aliases: primaryTag.alias ? [primaryTag.alias] : [],
        hierarchy_path: primaryTag.hierarchy_path,
        definition: null,
      };

      // Build property values: convert stored "true"/"false" strings to booleans.
      const propertyValues = parseStoredProperties(
        (fragment.summary as Record<string, unknown>)?.properties
      );

      // Record the edit session so the submission controls become status-aware
      // and Cancel/Delete know the target (Step 16).
      setEditSession({
        id: fragment.id,
        status: fragment.status,
        subPartCount: fragment.sub_parts.length,
      });

      // Set prefill data (passed to FormPanel on remount) and restore prose.
      setEditPrefillFormData({ concept, propertyValues });
      setProseAnnotation(fragment.prose_annotation ?? '');
      // Remount FormPanel so it consumes the editPrefill on mount.
      setFragmentResetKey((k) => k + 1);

      // Trigger session rebuild to seed the selection on the score.
      if (tagMode === 'tag') {
        setSessionRebuildKey((k) => k + 1);
      } else {
        setTagMode('tag');
      }
    },
    [tagMode]
  );

  /**
   * Called when the detail panel's delete flow completes successfully.
   * Clears the panel and refreshes the overlay list so the deleted bracket
   * disappears immediately.
   */
  const handleDeleteStoredFragment = useCallback(
    (fragmentId: string) => {
      void fragmentId; // consumed by the API call inside FragmentDetailPanel
      setSelectedFragmentId(null);
      refreshStoredFragments();
    },
    [refreshStoredFragments]
  );

  /**
   * Called when the detail panel's approve or reject flow completes.
   * Keeps the panel open so the reviewer sees the updated status badge,
   * and refreshes the overlay so the bracket colour updates immediately.
   */
  const handleReviewDone = useCallback(
    (fragmentId: string) => {
      void fragmentId;
      refreshStoredFragments();
    },
    [refreshStoredFragments]
  );

  // ── Submission handlers (Step 18) ────────────────────────────────────────

  /**
   * Resolve a bar number (MEI @n) to its 1-based document-order mc position.
   * Falls back to the plain barN key when no ending context is needed, which
   * covers the vast majority of sub-part bounds (within the main selection).
   */
  const resolveBarToMc = useCallback((barN: number): number | null => {
    const idx = mcIndexRef.current;
    if (!idx) return null;
    // Try with no ending context first; sub-parts inherit the parent's
    // ending context indirectly through their bar range.
    const mc = idx.get(measureGhostKey(barN, null));
    return mc ?? null;
  }, []);

  /**
   * Build the mutable fragment fields from the current UI state.
   *
   * Returns a FragmentUpdatePayload (no movement_id) so it can be used
   * directly for PATCH requests. The create handler spreads movement_id
   * in when constructing the FragmentCreatePayload.
   *
   * Returns null when required coordinates or concept data are missing.
   */
  const buildPayload = useCallback(
    (formData: FormSubmitData, meiText: string): FragmentUpdatePayload | null => {
      if (!committedSelection) return null;

      const key = parseMeiKey(meiText);
      const meter = parseMeiMeter(meiText);

      // Serialize property values: omit nulls, booleans become "true"/"false".
      const properties: Record<string, string | string[]> = {};
      for (const [schemaId, val] of Object.entries(formData.propertyValues)) {
        if (val === null || val === undefined) continue;
        if (typeof val === 'boolean') {
          properties[schemaId] = val ? 'true' : 'false';
        } else {
          properties[schemaId] = val;
        }
      }

      // Build sub-parts from non-absent, non-orphaned, non-error stages that
      // have committed bounds (Step 15, atomic parent+child write).
      const subParts: SubPartPayload[] = [];
      for (const a of stageAssignments) {
        if (a.absent || a.orphaned || a.error || !a.bounds) continue;

        // mc by physical measure key when the bounds carry one (§6A.1) — bar
        // numbers are ambiguous across endings, split measures, and section
        // resets. barN lookup remains the fallback for restored bounds.
        const mcStart =
          (a.bounds.keyStart !== undefined
            ? (mcIndexRef.current?.get(a.bounds.keyStart) ?? null)
            : null) ?? resolveBarToMc(a.bounds.barStart);
        const mcEnd =
          (a.bounds.keyEnd !== undefined
            ? (mcIndexRef.current?.get(a.bounds.keyEnd) ?? null)
            : null) ?? resolveBarToMc(a.bounds.barEnd);
        if (mcStart === null || mcEnd === null) continue;

        const stageProps: Record<string, string | string[]> = {};
        const tag = subPartTags[a.stageId];
        if (tag) {
          for (const [sid, val] of Object.entries(tag.propertyValues)) {
            if (val === null || val === undefined) continue;
            stageProps[sid] = typeof val === 'boolean' ? (val ? 'true' : 'false') : val;
          }
        }

        // ADR-005 beat pair: both null (measure-level) or both non-null. A
        // beat-precise stage that is measure-aligned on one side has its null
        // side filled with the measure boundary so the stored extent matches
        // what was tagged; a cross-bar pair (beatStart may exceed beatEnd, beats
        // being 1-indexed per measure) is preserved. See normalizeStageBeats.
        const { beat_start, beat_end } = normalizeStageBeats(
          a.bounds.beatStart,
          a.bounds.beatEnd,
          a.bounds.barStart,
          a.bounds.barEnd,
          measureExclusiveEndBeat(ghostLayerRef.current, a.bounds.keyEnd, meiText)
        );

        subParts.push({
          bar_start: a.bounds.barStart,
          bar_end: a.bounds.barEnd,
          mc_start: mcStart,
          mc_end: mcEnd,
          beat_start,
          beat_end,
          repeat_context: committedSelection.repeat_context,
          summary: {
            version: 1,
            key,
            meter,
            music21_version: null,
            concepts: [a.stageId],
            properties: stageProps,
            concept_extensions: {},
          },
          concept_tags: [{ concept_id: a.stageId, is_primary: true }],
        });
      }

      return {
        bar_start: committedSelection.bar_start,
        bar_end: committedSelection.bar_end,
        mc_start: committedSelection.mc_start,
        mc_end: committedSelection.mc_end,
        beat_start: committedSelection.beat_start,
        beat_end: committedSelection.beat_end,
        repeat_context: committedSelection.repeat_context,
        summary: {
          version: 1,
          key,
          meter,
          music21_version: null,
          concepts: [formData.conceptId],
          properties,
          concept_extensions: {},
        },
        prose_annotation: proseAnnotation || null,
        concept_tags: [{ concept_id: formData.conceptId, is_primary: true }],
        sub_parts: subParts,
      };
    },
    [committedSelection, stageAssignments, subPartTags, proseAnnotation, resolveBarToMc]
  );

  /** Save the current annotation as a draft (incompleteness allowed). */
  const handleSaveDraft = useCallback(
    async (formData: FormSubmitData) => {
      const mei = meiTextRef.current;
      if (!mei || !committedSelection || !movementId) return;

      setIsSavingDraft(true);
      setSubmitError(null);

      try {
        const fields = buildPayload(formData, mei);
        if (!fields) throw new Error(t('score:viewer.incompleteSave'));

        if (fragmentDraftId) {
          await updateFragment(fragmentDraftId, fields);
        } else {
          const response = await createFragment({ ...fields, movement_id: movementId });
          setFragmentDraftId(response.id);
        }
      } catch (err) {
        setSubmitError(err instanceof ApiError ? err.message : t('score:viewer.saveDraftError'));
      } finally {
        setIsSavingDraft(false);
      }
    },
    [committedSelection, movementId, fragmentDraftId, buildPayload, t]
  );

  /**
   * Save the annotation and transition it to submitted status.
   * Creates or updates the draft first, then calls POST .../submit.
   * The server re-validates before accepting (never trust the client).
   */
  const handleSubmitFragment = useCallback(
    async (formData: FormSubmitData) => {
      const mei = meiTextRef.current;
      if (!mei || !committedSelection || !movementId) return;

      setIsSubmitting(true);
      setSubmitError(null);

      try {
        const fields = buildPayload(formData, mei);
        if (!fields) throw new Error(t('score:viewer.incompleteSubmit'));

        let draftId = fragmentDraftId;
        if (draftId) {
          await updateFragment(draftId, fields);
        } else {
          const response = await createFragment({ ...fields, movement_id: movementId });
          draftId = response.id;
          setFragmentDraftId(response.id);
        }

        await submitFragment(draftId);
        // Refresh stored-fragment overlay so the newly submitted fragment
        // appears immediately (Component 7 Step 10).
        refreshStoredFragments();
        // Step 5 — Submit returns the surface to its initial state (form and
        // ghosts both cleared; the submitted fragment is immutable until a
        // reviewer acts) and raises an unmissable confirmation. This replaces
        // the old "draft saved" flash that left the annotator unsure whether
        // the submission landed. resetAnnotation clears fragmentDraftId too.
        resetAnnotation();
        showSubmitSuccess();
      } catch (err) {
        setSubmitError(err instanceof ApiError ? err.message : t('score:viewer.submitError'));
      } finally {
        setIsSubmitting(false);
      }
    },
    [
      committedSelection,
      movementId,
      fragmentDraftId,
      buildPayload,
      refreshStoredFragments,
      resetAnnotation,
      showSubmitSuccess,
      t,
    ]
  );

  /**
   * Save an analytic edit of an already-reviewed fragment (submitted/approved).
   *
   * These statuses cannot go through POST /submit (that only accepts drafts).
   * A PATCH applies the backend's revision semantics: an analytic edit clears
   * prior reviews and re-opens review (approved → submitted). This is the whole
   * save — there is no separate submit step — so on success the surface resets
   * and a "changes saved / review re-opened" banner confirms it.
   */
  const handleSaveChanges = useCallback(
    async (formData: FormSubmitData) => {
      const mei = meiTextRef.current;
      if (!mei || !committedSelection || !editSession) return;

      setIsSavingChanges(true);
      setSubmitError(null);
      try {
        const fields = buildPayload(formData, mei);
        if (!fields) throw new Error(t('score:viewer.incompleteSubmit'));
        await updateFragment(editSession.id, fields);
        refreshStoredFragments();
        resetAnnotation();
        showSubmitSuccess('score:viewer.saveChangesSuccess');
      } catch (err) {
        setSubmitError(err instanceof ApiError ? err.message : t('score:viewer.saveDraftError'));
      } finally {
        setIsSavingChanges(false);
      }
    },
    [
      committedSelection,
      editSession,
      buildPayload,
      refreshStoredFragments,
      resetAnnotation,
      showSubmitSuccess,
      t,
    ]
  );

  /**
   * Cancel an edit session: discard the in-progress changes and return to
   * viewing the stored fragment (its detail panel), leaving the DB untouched.
   */
  const handleCancelEdit = useCallback(() => {
    const id = editSession?.id ?? null;
    resetAnnotation();
    if (id) setSelectedFragmentId(id);
  }, [editSession, resetAnnotation]);

  /**
   * Delete the fragment currently being edited (real DB delete with cascade to
   * its sub-parts), then clear the surface. The inline confirmation lives in
   * FormPanel; this runs only after the annotator confirms.
   */
  const handleDeleteEditingFragment = useCallback(async () => {
    if (!editSession) return;
    await deleteFragment(editSession.id, editSession.subPartCount > 0);
    refreshStoredFragments();
    resetAnnotation();
  }, [editSession, refreshStoredFragments, resetAnnotation]);

  // Mirror stageAssignments into a ref so callbacks can read .length without
  // Keep stagesComplete in sync with assignments and session.
  // Blocked state overrides: if the selection cannot fit the concept's stages,
  // stagesComplete is false regardless of the (empty) assignment list.
  useEffect(() => {
    const session = annotationSessionRef.current;
    if (!session) return;
    const complete = stageGridBlocked ? false : computeStagesComplete(stageAssignments);
    session.setStagesComplete(complete);
  }, [stageAssignments, stageGridBlocked]);

  // Component 7 Step 3 — keep the annotator's hard-clamp in sync with the
  // current confirmed stage bounds.  Fires whenever assignments change so
  // the clamp is always up to date (e.g. after a split-handle drag confirms
  // a stage or after an absent-toggle frees space).
  useEffect(() => {
    const clamp = computeResizeClamp(stageAssignments);
    annotationSessionRef.current?.setMinBarRange(clamp);
  }, [stageAssignments]);

  // When the committed selection changes, reconcile stage assignments with
  // the new main bracket bounds or (re-)attempt auto-grid pre-population.
  useEffect(() => {
    if (!selectionRange) return;
    const stages = activeSchemaTreeRef.current?.stages;
    if (stageAssignmentsRef.current.length === 0 && stages?.length) {
      // First selection after concept chosen, or retry after a blocked selection
      // was extended — attempt auto-grid pre-population.
      const { assignments, grid, blocked } = computeAutoPrePopulate(
        stages,
        selectionRange,
        ghostLayerRef.current
      );
      setStageAssignments(assignments);
      setStageGridBlocked(blocked);
      if (!blocked && (GRID_RANK[grid] ?? 0) > (GRID_RANK[resolutionRef.current] ?? 0)) {
        resolutionRef.current = grid;
        setResolution(grid);
        showGridNote(grid, stages.length);
      }
    } else {
      if (stageAssignmentsRef.current.length === 0) return;

      // Component 9 Step 4 — hybrid resize response on the stage layout
      // frame (§6A.5): the new selection's slot list is rebuilt from the
      // committed state, confirmed boundaries keep their surviving slots,
      // unconfirmed runs redistribute by weight, and the frame's outer edges
      // are the new selection's exact endpoints (I7).
      const { assignments, droppedGrid, blocked } = respondToMainResize(
        stageAssignmentsRef.current,
        selectionRange,
        resolutionRef.current,
        ghostLayerRef.current
      );

      setStageAssignments(assignments);
      setStageGridBlocked(blocked);

      if (!blocked && droppedGrid && droppedGrid !== resolutionRef.current) {
        resolutionRef.current = droppedGrid;
        setResolution(droppedGrid);
        const total = assignments.filter((a) => !a.absent && !a.orphaned).length;
        showGridNote(droppedGrid, total);
      }
    }
  }, [selectionRange, showGridNote]);

  // ── Ghost layer + annotation session lifecycle (Step 11) ─────────────────
  //
  // Rebuilt on every svgPages change so ghost positions stay aligned with the
  // rendered SVG geometry. On each rebuild the previous session and layer are
  // destroyed first, then new ones are built over the fresh SVG.
  //
  // G1.3 — re-projection: when the rebuild is a re-render of the same score
  // (zoom / resize / font change), any committed selection and its associated
  // state survive. The new session is seeded with the logical coordinates from
  // the old session so it re-highlights the ghosts on the new geometry and
  // MainBracket / StageBrackets re-derive their pixel bounds automatically.
  // A full reset happens only when the score changes (movementId or tagMode).
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

    const mei = meiTextRef.current;
    const container = scorePanelRef.current;

    // Determine whether this rebuild is a re-render of the same score
    // (same movementId AND same tagMode → SVG-only change) or a context
    // change (new score, or tagging mode entered/exited).
    const scoreKey = `${movementId ?? ''}:${tagMode}`;
    const isSameContext = prevScoreKeyRef.current === scoreKey;
    prevScoreKeyRef.current = scoreKey;

    // Edit flow: consume editPrefillRef before computing shouldReproject.
    // When the user clicks Edit on a stored fragment, handleEditFragment sets
    // this ref.  We read and clear it here so the session is seeded with the
    // stored fragment's selection rather than the current FormPanel selection.
    const editFragment = editPrefillRef.current;
    if (editFragment !== null) editPrefillRef.current = null;

    // Edit flow: raise the active resolution to the finest grid the stored
    // fragment (and its stage sub-parts) needs, so the restored selection and
    // stage bounds project at their own precision from the first paint. Done
    // here — not only in handleConceptChange — because the session reads
    // resolutionRef at construction, before the async concept restore runs, and
    // because the fragment's own off-beat start may be finer than any sub-part.
    if (editFragment !== null) {
      const grid = finestBeatResolution([editFragment, ...editFragment.sub_parts]);
      if ((GRID_RANK[grid] ?? 0) > (GRID_RANK[resolutionRef.current] ?? 0)) {
        resolutionRef.current = grid;
        setResolution(grid);
      }
    }

    // Read committed selection state from the React state closure.
    // We deliberately do NOT snapshot from annotationSessionRef.current here
    // because React runs the previous effect's cleanup (which nulls the ref)
    // BEFORE this effect body executes. For re-renders that add SVG pages
    // progressively the cleanup destroys the session from the previous page
    // before this run can read it. The closure values (selectionRange,
    // annotationFlags) are captured at the render that triggered this effect
    // and are unaffected by cleanup — they remain the committed selection until
    // setSelectionRange(null) is explicitly called.
    const hadFragment = annotationFlags.fragmentSet;
    const prevSelection = selectionRange;
    const prevFlags = annotationFlags;
    // Edit flow always forces a full reset so FormPanel starts clean.
    // The new session is then seeded with the stored fragment's selection.
    const shouldReproject = editFragment === null && isSameContext && hadFragment;

    // Teardown: destroy the previous session, ghost layer, and harmony overlay.
    annotationSessionRef.current?.destroy();
    ghostLayerRef.current?.destroy();
    harmonyOverlayRef.current?.destroy();
    annotationSessionRef.current = null;
    ghostLayerRef.current = null;
    harmonyOverlayRef.current = null;

    if (!shouldReproject) {
      // Full reset — new score, tagMode change, no committed fragment, or edit.
      // State resets are batched with the subsequent setGhostLayer call so
      // MainBracket sees a single coherent update.
      setSelectionRange(null);
      setCommittedSelection(null);
      setAnnotationFlags({
        fragmentSet: false,
        conceptSet: false,
        stagesComplete: false,
        propertiesComplete: false,
      });
      setStageAssignments([]);
      setActiveStageId(null);
      setSubPartTags({});
      setSubPartResetKey((k) => k + 1);
      // Edit flow: set fragmentDraftId to the stored fragment's id so subsequent
      // saves PATCH the existing record rather than creating a duplicate.
      if (editFragment !== null) {
        setFragmentDraftId(editFragment.id);
      } else {
        setFragmentDraftId(null);
      }
    }
    // When shouldReproject is true the following state all survives the rebuild:
    //   selectionRange / committedSelection — logical bar/beat coordinates
    //   annotationFlags — concept, stage, property completion state
    //   stageAssignments — StageBounds are logical barN coords, not pixels
    //   subPartTags — keyed by stageId (stable strings)
    //   proseAnnotation — free text, independent of geometry
    //   fragmentDraftId — API draft UUID, still valid for the same fragment
    // MainBracket and StageBrackets re-derive pixel positions from the fresh
    // ghostLayer on the next render automatically.

    // Build the new ghost layer over the currently rendered SVG.
    const layer = buildGhosts(container, mei);
    ghostLayerRef.current = layer;
    setGhostLayer(layer);

    // Precompute the barN → mc index for the current MEI (used by
    // commitSelection to derive mc_start / mc_end at commit time).
    const mcIdx = buildMcIndex(mei);
    mcIndexRef.current = mcIdx;

    // View-mode play-from-position controller cleanup (Step 20), if attached.
    let viewModeCleanup: (() => void) | null = null;

    // Create the annotation session only in tag mode. In view mode the ghost
    // layer is built but the selection layers keep pointer-events: none, so the
    // score stays interactive for reading and MIDI playback with no selection
    // affordances — except for the Alt-click play-from-position handler below.
    if (tagMode === 'tag') {
      // ADR-025: barriers are D.C./D.S. directives only; volta gates and
      // effective-range exclusions come from the MEI-derived volta index.
      const barriers = buildDirectiveBarriers(mei);
      const volta = buildVoltaIndex(mei);
      const sessionOpts: AnnotationSessionOptions = {
        barrierMeasures: barriers,
        voltaIndex: volta,
        resolution: resolutionRef.current,
        // Step 20: Alt-click arms play-from-position (via the stable ref) instead
        // of starting a selection — same gesture as view mode.
        onPlayFromMeasure: (key) => playFromMeasureKeyRef.current(key),
      };

      // Seed the session's initial selection either from an edit prefill
      // (stored fragment) or from the current React selection (G1.3 reproject).
      if (editFragment !== null) {
        // Edit flow: restore the stored fragment's bar/beat selection on the
        // score so the bracket appears immediately when FormPanel mounts.
        // The effective key list is reconstructed from the stored machine
        // interval (mc is exact where @n values repeat — §6A.1).
        const repeatContext = editFragment.repeat_context as SelectionRange['repeatContext'];
        sessionOpts.initialSelection = {
          barStart: editFragment.bar_start,
          barEnd: editFragment.bar_end,
          beatStart: editFragment.beat_start,
          beatEnd: editFragment.beat_end,
          repeatContext,
          measureKeys: measureKeysForMcRange(
            mcIdx,
            editFragment.mc_start,
            editFragment.mc_end,
            repeatContext
          ),
        };
        // No flags — FormPanel will set them as the user confirms concept/stages.
        sessionOpts.initialFlags = {
          conceptSet: false,
          stagesComplete: false,
          propertiesComplete: false,
        };
      } else if (shouldReproject && prevSelection && prevFlags) {
        // G1.3: seed the new session with the logical selection so ghosts are
        // re-highlighted on the fresh geometry without firing React callbacks.
        sessionOpts.initialSelection = prevSelection;
        sessionOpts.initialFlags = {
          conceptSet: prevFlags.conceptSet,
          stagesComplete: prevFlags.stagesComplete,
          propertiesComplete: prevFlags.propertiesComplete,
        };
      }

      const session = new AnnotationSession(layer, sessionOpts);
      annotationSessionRef.current = session;

      // Subscribe: resolve mc coordinates at commit time and surface to React.
      session.onSelectionChange((sel) => {
        setSelectionRange(sel);
        setCommittedSelection(sel ? commitSelection(sel, mcIdx) : null);
      });

      session.onFlagsChange((flags) => {
        setAnnotationFlags({ ...flags });
      });

      // Edit flow: _restoreSelection set the session's internal selection and
      // fragmentSet but deliberately fired no callbacks (its contract is the
      // G1.3 reproject path, where React state already holds them). The full
      // reset above cleared the React mirrors, so push the restored selection
      // and fragmentSet back into React state now — otherwise the editing
      // bracket never draws, "Fragment drawn" reads off and cannot be toggled,
      // and the fragmentSet-gated Harmony and Commentary panels stay hidden.
      if (editFragment !== null && session.selection) {
        setSelectionRange(session.selection);
        setCommittedSelection(commitSelection(session.selection, mcIdx));
        setAnnotationFlags((f) => ({ ...f, fragmentSet: true }));
      }

      // Restore the active resolution so the correct ghost layer accepts
      // pointer events (resolutionRef mirrors the resolution state without
      // needing resolution itself in this effect's dependency array).
      session.setResolution(resolutionRef.current);

      // G6.3: mount the in-score harmony overlay. Seeded with the most recently
      // fetched full-movement events so it starts populated on re-renders.
      harmonyOverlayRef.current = new HarmonyOverlay({
        container,
        ghostLayer: layer,
        mcIndex: mcIdx,
        events: allHarmonyEventsRef.current,
        scale: scaleRef.current,
        onLabelClick: (mn, volta, beat) => {
          setHarmonyFocusKey(`${mn}:${volta ?? ''}:${beat}`);
        },
      });
    } else {
      // View mode (Step 20): no annotation session, but Alt-click still arms
      // play-from-position. Activate the measure ghost layer for pointer events
      // (the ghosts stay invisible until the data-armable hover affordance) and
      // route Alt-clicks to the play-from-measure handler. Plain clicks remain
      // inert — view mode has no selection.
      layer.setResolution('measure');
      const overlay = layer.overlay;
      const onViewMouseDown = (e: MouseEvent) => {
        if (!e.altKey) return;
        const target = e.target as HTMLElement | null;
        const ghost = target?.closest('.ghost-measure');
        const key = ghost instanceof HTMLElement ? ghost.dataset['key'] : undefined;
        if (key) {
          e.preventDefault();
          playFromMeasureKeyRef.current(key);
        }
      };
      overlay.addEventListener('mousedown', onViewMouseDown);
      viewModeCleanup = () => overlay.removeEventListener('mousedown', onViewMouseDown);
    }

    return () => {
      // DOM cleanup only — setState calls on unmounted components are
      // ignored by React 18 without warning, but avoiding them keeps
      // intent clear. The refs are nulled to prevent stale-closure access.
      viewModeCleanup?.();
      annotationSessionRef.current?.destroy();
      ghostLayerRef.current?.destroy();
      harmonyOverlayRef.current?.destroy();
      annotationSessionRef.current = null;
      ghostLayerRef.current = null;
      harmonyOverlayRef.current = null;
    };
    // svgPages changes on every SVG rebuild (scale/font/transpose/resize).
    // tagMode entering 'tag' creates the session; leaving destroys it.
    // status gates the effect from running during loading.
    // sessionRebuildKey is incremented by handleEditFragment when already in tag
    // mode so the edit selection is seeded without toggling tagMode.
    // movementId is intentionally read from the closure (not the dep array):
    // route changes always co-occur with status/tagMode/svgPages changes, so
    // adding movementId would fire the effect before the new SVG is ready.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, svgPages, tagMode, sessionRebuildKey]);

  // Forward resolution changes to the active annotation session (Step 10).
  // The session handles the no-op case when the mode is unchanged, and cancels
  // any in-progress drag so a mid-drag toggle does not leave highlight state.
  useEffect(() => {
    annotationSessionRef.current?.setResolution(resolution);
  }, [resolution]);

  // ── Harmony overlay event data (Step 16 / G6.3) ───────────────────────────
  // Fetch all movement events (unfenced — not selection-scoped) whenever the
  // viewer enters tag mode for a loaded movement.  The overlay needs the full
  // movement so it can label every visible system, not just the selection range.
  useEffect(() => {
    if (tagMode !== 'tag' || !movementId) {
      allHarmonyEventsRef.current = [];
      return;
    }
    let cancelled = false;
    getHarmonyEvents(movementId, 1, 99999)
      .then((evs) => {
        if (cancelled) return;
        allHarmonyEventsRef.current = evs;
        harmonyOverlayRef.current?.setEvents(evs);
      })
      .catch(() => {
        // Non-fatal: overlay stays empty until the next successful fetch.
      });
    return () => {
      cancelled = true;
    };
  }, [tagMode, movementId]);

  /**
   * Called by FormPanel → HarmonyPanel after any successful harmony mutation
   * (confirm, edit, insert, delete). Re-fetches the full movement event list
   * and pushes it to the in-score overlay so labels stay in sync.
   */
  const handleHarmonyUpdated = useCallback(() => {
    if (!movementId || tagMode !== 'tag') return;
    getHarmonyEvents(movementId, 1, 99999)
      .then((evs) => {
        allHarmonyEventsRef.current = evs;
        harmonyOverlayRef.current?.setEvents(evs);
      })
      .catch(() => {});
  }, [movementId, tagMode]);

  // ── Initial load ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!movementId) return;
    setTagMode('view');
    let cancelled = false;

    const load = async () => {
      setStatus('loading');
      setLoadingLabel(t('score:viewer.loadingScore'));
      setSvgPages([]);
      setScoreTitle(null);
      setErrorMessage(null);
      setMidiBase64(null);
      // Reset note info map so stale data from a previous score is not used
      // while the new MEI loads. Rebuilt synchronously after meiText is fetched.
      noteInfoMapRef.current = new Map();
      graceIdsRef.current = new Set();

      // Measure container width before any await — DOM is synchronously
      // available at effect time. This value is used for the initial render;
      // the ResizeObserver will re-render if the width changes later.
      const containerWidth = scorePanelRef.current?.offsetWidth ?? DEFAULT_PAGE_WIDTH;
      const initialPageWidth = Math.max(containerWidth, MIN_PAGE_WIDTH);
      pageWidthRef.current = initialPageWidth;
      setIsNarrow(containerWidth < MIN_PAGE_WIDTH);

      try {
        // 1. Resolve MEI object key → signed URL → MEI text.
        // Title metadata arrives in the same response, no extra round-trip.
        const { url, ...titleData } = await fetchMeiUrl(movementId);
        if (cancelled) return;
        setScoreTitle(titleData);

        const meiResponse = await fetch(url);
        if (!meiResponse.ok) {
          throw new Error(`MEI fetch failed (HTTP ${meiResponse.status})`);
        }
        const meiText = await meiResponse.text();
        if (cancelled) return;
        meiTextRef.current = meiText;
        setGlobalMeter(parseMeiMeterParts(meiText));
        // Build note info map synchronously from MEI (DOMParser, no toolkit needed).
        // Built once per score load; does not need rebuilding on options re-renders.
        noteInfoMapRef.current = buildNoteInfoMap(meiText);
        graceIdsRef.current = collectGraceNoteIds(meiText);

        // 2. Load Verovio WASM (singleton — loads at most once per session).
        setLoadingLabel(t('score:viewer.loadingRenderer'));
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
          () => {}
        );

        // 4. Generate MIDI and build highlight schedule from the toolkit's
        //    timemap (Step 14.3 / 14.4). renderToTimemap() expands repeats
        //    correctly, so both passes of a repeated section are covered.
        if (!cancelled) {
          try {
            const midi = await renderMidi(tk);
            if (!cancelled) {
              highlightScheduleRef.current = buildHighlightSchedule(tk);
              // mc → onset index for play-from-position (Step 20).
              measureOnsetIndexRef.current = buildMeasureOnsetIndex(tk, meiTextRef.current ?? '');
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
          setErrorMessage(err instanceof Error ? err.message : t('score:viewer.failedLoadScore'));
          setStatus('error');
        }
      }
    };

    load();
    return () => {
      cancelled = true;
    };
    // Re-run only when the movement changes; `t` is read for loading/error labels
    // but a language switch should not reload the score.
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ── Render ───────────────────────────────────────────────────────────────

  const isPlaybackAvailable = midiBase64 !== null;
  const isPlaying = playbackStatus === 'playing';
  const isLoadingInstrument = playbackStatus === 'loading-instrument';
  const isInstrumentError = playbackStatus === 'instrument-error';

  return (
    <div className={styles.viewer}>
      {/* Visually-hidden h1 for screen readers: provides a page landmark
          without affecting the visual toolbar layout. */}
      <Type variant="headline" as="h1" className={styles.srOnly}>
        {t('score:viewer.srTitle')}
      </Type>

      {/* ── Toolbar ─────────────────────────────────────────────────────── */}
      <Surface layer="container-high" className={styles.toolbar}>
        <Link to="/" className={styles.backLink}>
          <Type variant="label-md" as="span">
            {t('score:viewer.backToBrowse')}
          </Type>
        </Link>

        {/* Centred controls group — middle column of the 1fr/auto/1fr grid */}
        <div className={styles.toolbarControls}>
          {/* Staff size presets */}
          <div className={styles.staffSizeControl} role="group" aria-label={t('common:staffSize')}>
            <Type variant="label-md" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
              {t('score:viewer.size')}
            </Type>
            {([35, 45, 55] as ScalePreset[]).map((s) => (
              <button
                key={s}
                type="button"
                className={[styles.sizeButton, scale === s ? styles.sizeButtonActive : '']
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => handleScaleChange(s)}
                aria-pressed={scale === s}
              >
                <Type variant="label-sm" as="span">
                  {t(`score:${SCALE_LABEL_KEYS[s]}`)}
                </Type>
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
                {t('score:viewer.transpose')}
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

          {/* Resolution toggle — visible only in tag mode (G1.1) */}
          {tagMode === 'tag' && (
            <div
              className={styles.resolutionControl}
              role="group"
              aria-label={t('score:viewer.selectionResolutionAria')}
            >
              <Type
                variant="label-md"
                as="span"
                style={{ color: 'var(--color-on-surface-variant)' }}
              >
                {t('score:viewer.selectLabel')}
              </Type>
              {(['measure', 'beat', 'subbeat'] as ResolutionMode[]).map((resMode) => {
                const ARIA_LABELS: Record<ResolutionMode, string> = {
                  measure: t('score:viewer.resolutionAria.measure'),
                  beat: t('score:viewer.resolutionAria.beat'),
                  subbeat: t('score:viewer.resolutionAria.subbeat'),
                };
                return (
                  <button
                    key={resMode}
                    type="button"
                    className={[
                      styles.resolutionButton,
                      resolution === resMode ? styles.resolutionButtonActive : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      resolutionRef.current = resMode;
                      setResolution(resMode);
                    }}
                    aria-pressed={resolution === resMode}
                    aria-label={ARIA_LABELS[resMode]}
                    title={ARIA_LABELS[resMode]}
                  >
                    <ResolutionIcon
                      mode={resMode}
                      beatCount={globalMeter[0]}
                      beatUnit={globalMeter[1]}
                    />
                  </button>
                );
              })}
            </div>
          )}
          {/* Brief note shown when pre-population auto-drops the resolution grid. */}
          {gridAutoSwitchNote && tagMode === 'tag' && (
            <Type
              variant="label-sm"
              as="span"
              className={styles.gridAutoSwitchNote}
              aria-live="polite"
            >
              {gridAutoSwitchNote}
            </Type>
          )}
        </div>

        {/* TAG / Done button — enters and exits annotation mode (G1.1).
            Hidden while the score is loading so it can't be clicked before
            the ghost layer is ready. */}
        {status === 'ready' && (
          <div className={styles.toolbarRight}>
            <button
              type="button"
              className={[styles.tagButton, tagMode === 'tag' ? styles.tagButtonActive : '']
                .filter(Boolean)
                .join(' ')}
              onClick={() => setTagMode(tagMode === 'view' ? 'tag' : 'view')}
              aria-pressed={tagMode === 'tag'}
            >
              <Type variant="label-sm" as="span">
                {tagMode === 'tag' ? t('score:viewer.done') : t('score:viewer.tag')}
              </Type>
            </button>
          </div>
        )}
      </Surface>

      {/* Narrow-screen notice — shown when container is below 480px */}
      {isNarrow && (
        <div className={styles.narrowNotice}>
          <Type variant="label-md" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
            {t('score:viewer.narrowNotice')}
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
            <Type variant="label-md" as="p">
              {loadingLabel}
            </Type>
          </Surface>
        )}

        {status === 'error' && (
          <Surface layer="base" className={styles.statusPanel}>
            <Type variant="body-lg" as="p">
              {errorMessage ?? t('score:viewer.failedLoadScore')}
            </Type>
          </Surface>
        )}

        {/* Score panel: always rendered so scorePanelRef.current is available
            for width measurement even before the first successful render. */}
        <div className={styles.scorePanel}>
          {/* .scoreContent is the measured element: ResizeObserver watches it.
              Its offsetWidth (≤ 1200px via max-width) is what we pass to
              Verovio as pageWidth, so the SVG fills the container exactly. */}
          <div
            ref={scorePanelRef}
            className={styles.scoreContent}
            data-armable={altHeld && isPlaybackAvailable ? 'true' : undefined}
          >
            {/* G7: HTML title block sourced from the DB via the mei-url response.
                Replaces Verovio's suppressed <pgHead> output. Rendered here
                so the score SVG starts at the top of the container and the
                main bracket's systemTop is anchored to music, not the title.
                Three lines (all centered): composer → work title → movement. */}
            {scoreTitle && (
              <div className={styles.scoreTitle}>
                <Type variant="label-md" as="p" className={styles.scoreTitleComposer}>
                  {scoreTitle.composer_name}
                </Type>
                <Type variant="headline" as="h2" className={styles.scoreTitleWork}>
                  {scoreTitle.work_title}
                </Type>
                {scoreTitle.movement_title && (
                  <Type variant="title" as="p" className={styles.scoreTitleMovement}>
                    {`${scoreTitle.movement_number}. ${scoreTitle.movement_title}`}
                  </Type>
                )}
              </div>
            )}
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
            <FragmentOverlay
              fragments={overlayFragments}
              ghostLayer={ghostLayer}
              onBracketClick={setSelectedFragmentId}
            >
              <MainBracket
                selection={selectionRange}
                layer={ghostLayer}
                fragmentSet={annotationFlags.fragmentSet}
                resolution={resolution}
              />
              <StageBrackets
                assignments={stageAssignments}
                selection={selectionRange}
                layer={ghostLayer}
                visible={annotationFlags.conceptSet && stageAssignments.length > 0}
                resolution={resolution}
                activeStageId={activeStageId}
                onStageActivate={handleStageActivate}
                onSplitHandleMove={handleSplitHandleMove}
                session={annotationSessionRef.current}
                onDragActiveChange={setStageDragActive}
              />
            </FragmentOverlay>

            {/* Playback caret (Step 19): a moving overlay bar driven imperatively
                by handlePositionUpdate. Sibling of the fragment overlay so it
                shares the .scoreContent coordinate origin. */}
            <PlaybackCaret ref={caretElRef} />
          </div>
        </div>

        {/* Detail panel — shown when a stored bracket is clicked (Step 12).
            Occupies the same layout slot as FormPanel (mutual exclusion). */}
        {selectedFragmentId !== null && (
          <FragmentDetailPanel
            fragmentId={selectedFragmentId}
            onClose={() => setSelectedFragmentId(null)}
            onEdit={handleEditFragment}
            onDeleteDone={handleDeleteStoredFragment}
            onReviewDone={handleReviewDone}
            tagMode={tagMode}
          />
        )}

        {/* Form panel — mounted only in tag mode with no detail panel open (G1.1).
            Mounting is gated so the score is fully usable for reading and
            MIDI playback without the sidebar. The concurrent-flag model
            still applies within the mounted panel. */}
        {tagMode === 'tag' && selectedFragmentId === null && (
          <FormPanel
            key={fragmentResetKey}
            session={annotationSessionRef.current}
            onDeleteFragment={handleDeleteFragment}
            flags={annotationFlags}
            onConceptChange={handleConceptChange}
            onRefinementChange={handleRefinementChange}
            assignments={stageAssignments}
            activeStageId={activeStageId}
            onStageActivate={handleStageActivate}
            onToggleAbsent={handleToggleAbsent}
            stageDragActive={stageDragActive}
            subPartTags={subPartTags}
            onSubPartTagUpdate={handleSubPartTagUpdate}
            subPartResetKey={subPartResetKey}
            movementId={movementId}
            selectionRange={selectionRange}
            proseAnnotation={proseAnnotation}
            onProseChange={setProseAnnotation}
            onSaveDraft={handleSaveDraft}
            onSubmitFragment={handleSubmitFragment}
            isSavingDraft={isSavingDraft}
            isSubmitting={isSubmitting}
            submitError={submitError}
            draftId={fragmentDraftId}
            editPrefill={editPrefillFormData}
            editStatus={editSession?.status ?? null}
            editSubPartCount={editSession?.subPartCount ?? 0}
            onCancelEdit={handleCancelEdit}
            onDeleteEditingFragment={handleDeleteEditingFragment}
            onSaveChanges={handleSaveChanges}
            isSavingChanges={isSavingChanges}
            onHarmonyUpdated={handleHarmonyUpdated}
            harmonyFocusKey={harmonyFocusKey}
          />
        )}

        {/* Re-render overlay: sits above both panels while options change */}
        {isRerendering && (
          <div className={styles.rerenderOverlay} role="status" aria-live="polite">
            <Type variant="label-md" as="span">
              {t('score:viewer.rerendering')}
            </Type>
          </div>
        )}

        {/* Post-submit confirmation (Step 5): an unmissable banner shown after
            a fragment is submitted and the surface has reset to blank. Uses the
            submitted-status token family (secondary). Auto-dismisses after a
            few seconds, clears on the next selection, and is dismissible. */}
        {submitSuccess && (
          <div className={styles.submitSuccessBanner} role="status" aria-live="assertive">
            <Type variant="label-md" as="span" className={styles.submitSuccessText}>
              {t(submitSuccessKey)}
            </Type>
            <button
              type="button"
              className={styles.submitSuccessDismiss}
              onClick={() => setSubmitSuccess(false)}
              aria-label={t('score:viewer.dismissConfirmationAria')}
            >
              <Type variant="label-sm" as="span">
                {t('score:viewer.dismiss')}
              </Type>
            </button>
          </div>
        )}
      </div>

      {/* ── Playback bar (Step 14.5) ─────────────────────────────────────── */}
      <Surface layer="container-highest" className={styles.playbackBar}>
        {isLoadingInstrument ? (
          <Type variant="label-md" as="span" className={styles.loadingInstrumentLabel}>
            {t('common:loadingInstrument')}
          </Type>
        ) : isInstrumentError ? (
          <Type variant="label-md" as="span" className={styles.instrumentErrorLabel}>
            {t('score:viewer.audioUnavailablePre')}
            <code>{SOUNDFONT_ENV_VAR}</code>
            {t('score:viewer.audioUnavailablePost')}
            <button type="button" className={styles.retryButton} onClick={play}>
              {t('common:retry')}
            </button>
          </Type>
        ) : (
          <>
            {/* Rewind to top (Step 20): clears an armed play-from-position
                origin so the next Play starts at the movement top. Disabled
                while playing or already at the top. */}
            <button
              type="button"
              className={styles.transportButton}
              onClick={handleRewind}
              disabled={!isPlaybackAvailable || isPlaying || playbackOriginMs === 0}
              aria-label={t('score:viewer.rewindAria')}
              title={t('score:viewer.rewindAria')}
            >
              ⏮
            </button>

            {/* Play / Pause */}
            <button
              type="button"
              className={styles.transportButton}
              onClick={isPlaying ? pause : play}
              disabled={!isPlaybackAvailable || isLoadingInstrument}
              aria-label={isPlaying ? t('common:pause') : t('common:play')}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>

            {/* Stop */}
            <button
              type="button"
              className={styles.transportButton}
              onClick={handleStop}
              disabled={
                !isPlaybackAvailable || playbackStatus === 'ready' || playbackStatus === 'idle'
              }
              aria-label={t('common:stop')}
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
              aria-label={t('score:viewer.positionAria', {
                bar: displayPosition.bar,
                beat: displayPosition.beat,
              })}
            >
              {isPlaybackAvailable ? `${displayPosition.bar}:${displayPosition.beat}` : '—'}
            </Type>
          </>
        )}
      </Surface>
    </div>
  );
}
