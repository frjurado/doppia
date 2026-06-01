// Side-effect import: includes ghost highlight CSS (.ghost.light / .ghost.dark)
// in the Vite bundle. The ghost elements are created imperatively (not via JSX)
// so the CSS file would otherwise never be bundled.
import './ghosts.module.css';

/**
 * Ghost layer — invisible interactive overlay providing measure, beat, and
 * sub-beat selection regions for the annotation tool.
 *
 * Ghost regions are absolutely-positioned HTML elements layered above the
 * Verovio SVG container. They are never injected into Verovio's SVG output
 * (CLAUDE.md §"Verovio SVG overlay rule").
 *
 * Three layers are always present in the DOM. The resolution toggle
 * (Step 10) flips pointer-events between layers; ghost construction is
 * not re-run on toggle.
 *
 * References: prototype-tagging-tool.md, ADR-005.
 */

// ---------------------------------------------------------------------------
// Flat index encoding (ADR-005 §"Flat index encoding")
// ---------------------------------------------------------------------------

/** Max 99 sub-beats per beat. */
export const BEAT_SCALE = 100;
/** Max 99 beats per measure. */
export const MEASURE_SCALE = 10_000;

export const encodeBeat = (m: number, b: number): number =>
  MEASURE_SCALE * m + BEAT_SCALE * b;

export const encodeSubBeat = (m: number, b: number, sb: number): number =>
  MEASURE_SCALE * m + BEAT_SCALE * b + sb;

export const decodeMeasure = (n: number): number =>
  Math.floor(n / MEASURE_SCALE);

export const decodeBeat = (n: number): number =>
  Math.floor((n % MEASURE_SCALE) / BEAT_SCALE);

export const decodeSubBeat = (n: number): number => n % BEAT_SCALE;

// ---------------------------------------------------------------------------
// Measure ghost key (handles repeat-ending collision, ADR-005 §"Edge cases")
// ---------------------------------------------------------------------------

/**
 * String key for the measureIndex map.
 *
 * Measures inside <ending> elements share the same @n across endings (Doppia
 * convention, mei-ingest-normalization.md §6). Incorporating endingN prevents
 * first-ending and second-ending measures from colliding in the index.
 */
export function measureGhostKey(barN: number, endingN: number | null): string {
  return endingN !== null ? `m${barN}-e${endingN}` : `m${barN}`;
}

// ---------------------------------------------------------------------------
// Compound-meter utilities
// ---------------------------------------------------------------------------

/** True when time signature indicates compound meter (6/8, 9/8, 12/8). */
export function isCompoundMeter(beatCount: number, beatUnit: number): boolean {
  return beatUnit === 8 && beatCount % 3 === 0;
}

/**
 * Number of eighth-note sub-divisions per metric beat.
 * Simple meters: 2 (binary subdivision).
 * Compound meters: 3 (ternary subdivision — the beat is a dotted quarter).
 */
export function subdivisionsPerBeat(beatCount: number, beatUnit: number): number {
  return isCompoundMeter(beatCount, beatUnit) ? 3 : 2;
}

/**
 * Number of beat-level ghost slots to allocate for a measure.
 * In compound meter the beat is the dotted quarter, so 6/8 → 2 beats,
 * 9/8 → 3 beats, 12/8 → 4 beats.
 */
export function beatSlotCount(beatCount: number, beatUnit: number): number {
  return isCompoundMeter(beatCount, beatUnit)
    ? Math.floor(beatCount / 3)
    : beatCount;
}

/**
 * Convert a 0-indexed beat and 0-indexed sub-beat to the float encoding
 * stored in fragment.beat_start / beat_end (ADR-005 §"Data model").
 *
 * Example (4/4, subDiv=2):
 *   beat=0, subBeat=0 → 1.0   (first beat)
 *   beat=0, subBeat=1 → 1.5   (first beat, second eighth)
 *   beat=1, subBeat=0 → 2.0   (second beat)
 *
 * Example (6/8, subDiv=3):
 *   beat=0, subBeat=1 → 1.333…
 *   beat=1, subBeat=2 → 2.667…
 */
export function beatToFloat(
  beat0: number,
  subBeat0: number,
  subDiv: number,
): number {
  // beat_start uses 1-indexed beat numbers (MEI convention).
  return beat0 + 1 + subBeat0 / subDiv;
}

// ---------------------------------------------------------------------------
// Per-measure meter reading (ADR-005 §"Per-measure meter reading")
// ---------------------------------------------------------------------------

/**
 * Read the time signature for one MEI measure element.
 *
 * Checks for a <meterSig count="…" unit="…"/> direct child before falling
 * back to the global scoreDef values. The MEI normalizer inserts <meterSig>
 * children at every meter change (mei-ingest-normalization.md §2), so this
 * check is sufficient for all normalised corpus files.
 *
 * @param meiMeasure     The MEI <measure> DOM element.
 * @param globalBeatCount Global beatCount from the active <scoreDef>.
 * @param globalBeatUnit  Global beatUnit from the active <scoreDef>.
 */
export function getMeterForMeasure(
  meiMeasure: Element,
  globalBeatCount: number,
  globalBeatUnit: number,
): [beatCount: number, beatUnit: number] {
  const localSig = meiMeasure.querySelector('meterSig');
  if (localSig) {
    const count = parseInt(localSig.getAttribute('count') ?? '', 10);
    const unit = parseInt(localSig.getAttribute('unit') ?? '', 10);
    if (!isNaN(count) && !isNaN(unit) && count > 0 && unit > 0) {
      return [count, unit];
    }
  }
  return [globalBeatCount, globalBeatUnit];
}

// ---------------------------------------------------------------------------
// Beat boundary computation
// ---------------------------------------------------------------------------

/** Pixel margin subtracted from notehead x to give the ghost's left edge. */
const NOTEHEAD_MARGIN = 4;

/** Input per note for beat boundary inference. */
export interface NotePositionInput {
  /** Pixel x of the leftmost part of the notehead, relative to the container. */
  xLeft: number;
  /**
   * Score-time onset in quarter-note units, relative to the measure start.
   * 0 = first beat of the measure; 1 = one quarter note in, etc.
   */
  scoreTimeOnset: number;
  /**
   * Score-time duration in quarter-note units.
   * 0 = grace note (these are skipped).
   */
  scoreTimeDuration: number;
}

export interface BeatBoundaryOutput {
  /** Number of beat-level slots after compound correction. */
  numBeats: number;
  /** Pixel x of the left edge of each beat (0-indexed, length = numBeats). */
  beatLefts: number[];
  /** Pixel x of the right edge of each beat (0-indexed, length = numBeats). */
  beatRights: number[];
  /**
   * Sub-beat left edges: beatRights[b][sb] is beat b, sub-beat sb.
   * Dimensions: numBeats × subDiv.
   */
  subBeatLefts: number[][];
  /** Sub-beat right edges. Same dimensions as subBeatLefts. */
  subBeatRights: number[][];
  /** 0-indexed set of beats that have at least one note onset. */
  struckBeats: Set<number>;
  /**
   * 0-indexed set of (beat×100+subBeat) pairs that have at least one onset.
   * Use encodedSubBeatKey(b, sb) = b * 100 + sb.
   */
  struckSubBeats: Set<number>;
}

/**
 * Infer pixel beat boundaries for one measure from notehead positions.
 *
 * Algorithm (from prototype-tagging-tool.md §"Beat boundary computation"):
 *  1. beatLefts[0] = mLeft (first beat begins at measure left edge, already
 *     adjusted past system decorations by the caller).
 *  2. For each note: convert score-time onset to a beat index; track the
 *     leftmost notehead x in each beat (minus NOTEHEAD_MARGIN).
 *  3. Beat N's right boundary = the left boundary of the next struck beat;
 *     the last struck beat extends to mRight.
 *  4. Grace notes (duration=0) and tied continuations (negative
 *     measureLocalOnset → out-of-range beatIdx) are silently skipped.
 *
 * @param mLeft            Adjusted left edge of the measure (px, container-relative).
 * @param mRight           Right edge of the measure (px, container-relative).
 * @param measureStartTime Score-time onset of the measure (quarter-note units).
 * @param beatCount        Raw MEI beatCount (e.g. 6 for 6/8).
 * @param beatUnit         Raw MEI beatUnit (e.g. 8 for 6/8).
 * @param notes            Notehead positions and Verovio timing info.
 */
export function computeBeatBoundaries(
  mLeft: number,
  mRight: number,
  measureStartTime: number,
  beatCount: number,
  beatUnit: number,
  notes: NotePositionInput[],
): BeatBoundaryOutput {
  const compound = isCompoundMeter(beatCount, beatUnit);
  const subDiv = subdivisionsPerBeat(beatCount, beatUnit);
  const numBeats = beatSlotCount(beatCount, beatUnit);

  // Initialise all left-boundaries to mRight (sentinel) and right-boundaries
  // to mRight; first beat unconditionally starts at mLeft.
  const beatLefts: number[] = new Array(numBeats).fill(mRight);
  const beatRights: number[] = new Array(numBeats).fill(mRight);
  const subBeatLefts: number[][] = Array.from({ length: numBeats }, () =>
    new Array(subDiv).fill(mRight),
  );
  const subBeatRights: number[][] = Array.from({ length: numBeats }, () =>
    new Array(subDiv).fill(mRight),
  );

  beatLefts[0] = mLeft;
  if (subBeatLefts[0]) subBeatLefts[0][0] = mLeft;

  const struckBeats = new Set<number>();
  const struckSubBeats = new Set<number>();

  for (const note of notes) {
    // Skip grace notes (duration == 0).
    if (note.scoreTimeDuration === 0) continue;

    const measureLocalOnset = note.scoreTimeOnset - measureStartTime;

    // Convert to raw slot index (eighth-note grid for compound, denominator grid for simple).
    const rawSlot = Math.floor(measureLocalOnset * beatUnit / 4.0);

    // Beat-level index with compound-meter correction.
    const beatIdx = compound ? Math.floor(rawSlot / subDiv) : rawSlot;

    // Skip tied continuations (negative onset → beatIdx < 0) and
    // any value outside the expected range.
    if (beatIdx < 0 || beatIdx >= numBeats) continue;

    // Sub-beat index within the beat (0-indexed).
    const subBeatIdx = compound
      ? rawSlot % subDiv
      : Math.max(
          0,
          Math.min(
            subDiv - 1,
            Math.floor((measureLocalOnset * beatUnit / 4.0 - beatIdx) * subDiv),
          ),
        );

    // Track leftmost notehead x per beat and per sub-beat.
    const x = note.xLeft - NOTEHEAD_MARGIN;
    if (beatIdx > 0 && x < beatLefts[beatIdx]) {
      // beatLefts[0] is anchored to mLeft; only update for beats ≥ 1.
      beatLefts[beatIdx] = x;
    }
    if (subBeatIdx > 0 || beatIdx > 0) {
      const sbLefts = subBeatLefts[beatIdx];
      if (sbLefts && x < sbLefts[subBeatIdx]) {
        sbLefts[subBeatIdx] = x;
      }
    }

    struckBeats.add(beatIdx);
    struckSubBeats.add(beatIdx * 100 + subBeatIdx);
  }

  // Right boundaries: beat N's right = left of the next struck beat.
  const struckList = [...struckBeats].sort((a, b) => a - b);
  for (let i = 0; i < struckList.length; i++) {
    const curr = struckList[i];
    const next = struckList[i + 1];
    beatRights[curr] = next !== undefined ? beatLefts[next] : mRight;
  }

  // Sub-beat right boundaries: next struck sub-beat within the same beat,
  // or the beat's right edge if no subsequent sub-beat exists.
  for (const b of struckBeats) {
    for (let sb = 0; sb < subDiv; sb++) {
      if (!struckSubBeats.has(b * 100 + sb)) continue;
      let nextLeft = beatRights[b];
      for (let nsb = sb + 1; nsb < subDiv; nsb++) {
        if (struckSubBeats.has(b * 100 + nsb)) {
          nextLeft = subBeatLefts[b]![nsb];
          break;
        }
      }
      subBeatRights[b]![sb] = nextLeft;
    }
  }

  return {
    numBeats,
    beatLefts,
    beatRights,
    subBeatLefts,
    subBeatRights,
    struckBeats,
    struckSubBeats,
  };
}

// ---------------------------------------------------------------------------
// Ghost element types
// ---------------------------------------------------------------------------

export interface GhostBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Entry stored in the measure index. */
export interface MeasureGhostEntry {
  el: HTMLElement;
  barN: number;
  endingN: number | null;
  key: string;
  /** Ghost bounds — top/height span the staff lines only (not note content). */
  bounds: GhostBounds;
  /** Min rawTop across the system, including note content above the staff.
   *  Used by MainBracket to anchor the bracket above the highest note. */
  systemTop: number;
}

/** Entry stored in the beat index. */
export interface BeatGhostEntry {
  el: HTMLElement;
  barN: number;
  endingN: number | null;
  /**
   * The deduplicated measure ghost key for this beat's parent measure.
   * Equal to measureGhostKey(barN, endingN) in the common case, but may carry
   * a '#N' suffix when two measures share the same @n (section-reset numbering).
   * Used by the annotator barrier check to call measureKeyRange() without
   * recomputing the key from barN+endingN (which would miss duplicates).
   */
  measureKey: string;
  /** 0-indexed beat within the measure (after compound correction). */
  beatIdx: number;
  /**
   * Encoded key: encodeBeat(renderOrder, beatIdx).
   * Uses the measure's document-order render index (not barN) so that measures
   * sharing the same @n due to section-reset numbering produce distinct keys.
   */
  encodedKey: number;
  /** Float encoding for fragment.beat_start / beat_end (1-indexed). */
  beatFloat: number;
  bounds: GhostBounds;
}

/** Entry stored in the sub-beat index. */
export interface SubBeatGhostEntry {
  el: HTMLElement;
  barN: number;
  endingN: number | null;
  /** The deduplicated measure ghost key (see BeatGhostEntry.measureKey). */
  measureKey: string;
  beatIdx: number;
  subBeatIdx: number;
  /** Encoded key: encodeSubBeat(renderOrder, beatIdx, subBeatIdx). */
  encodedKey: number;
  beatFloat: number;
  bounds: GhostBounds;
}

/** Which ghost layer receives pointer events (resolution toggle, ADR-005). */
export type ResolutionMode = 'measure' | 'beat' | 'subbeat';

/** Fixed width (px) of each drag handle ghost element placed outside the selection. */
export const HANDLE_GHOST_W = 32;


// ---------------------------------------------------------------------------
// GhostLayer class
// ---------------------------------------------------------------------------

/**
 * Manages three ghost layers (measure, beat, sub-beat) and their spatial
 * indexes. Created by buildGhosts() after a score page is rendered.
 */
export class GhostLayer {
  /** Map from measureGhostKey() string to measure ghost entry. */
  readonly measureIndex = new Map<string, MeasureGhostEntry>();
  /** Map from encodeBeat(barN, beatIdx) to beat ghost entry. */
  readonly beatIndex = new Map<number, BeatGhostEntry>();
  /** Map from encodeSubBeat(barN, beatIdx, subBeatIdx) to sub-beat ghost entry. */
  readonly subBeatIndex = new Map<number, SubBeatGhostEntry>();

  private readonly _overlay: HTMLElement;
  private readonly _measureLayer: HTMLElement;
  private readonly _beatLayer: HTMLElement;
  private readonly _subBeatLayer: HTMLElement;

  // Drag handle ghosts — positioned outside the committed selection boundary,
  // within the staves. Both visual affordance and hit-target for endpoint
  // re-anchor (G3.1). Hidden by default; shown/moved by AnnotationSession after
  // each commit, hidden when a drag starts or the session resets.
  private readonly _leftHandle: HTMLElement;
  private readonly _rightHandle: HTMLElement;
  // Active opacity for handles — set per resolution so the solid gradient end
  // matches the adjacent dark ghost opacity. Updated each positionHandles() call.
  private _handleOpacity = 0.55;

  constructor(container: HTMLElement) {
    this._overlay = document.createElement('div');
    this._overlay.className = 'ghost-overlay';
    this._overlay.setAttribute('aria-hidden', 'true');
    Object.assign(this._overlay.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
      zIndex: '20',
    });

    this._measureLayer = this._createLayer('ghost-layer-measure');
    this._beatLayer = this._createLayer('ghost-layer-beat');
    this._subBeatLayer = this._createLayer('ghost-layer-subbeat');

    this._overlay.appendChild(this._measureLayer);
    this._overlay.appendChild(this._beatLayer);
    this._overlay.appendChild(this._subBeatLayer);

    // Handle ghosts live directly in the overlay (not in any selection layer)
    // and always have pointer-events: auto so clicks bubble to overlay listeners.
    this._leftHandle = this._createHandleEl('left');
    this._rightHandle = this._createHandleEl('right');
    this._overlay.appendChild(this._leftHandle);
    this._overlay.appendChild(this._rightHandle);

    container.appendChild(this._overlay);
  }

  private _createLayer(className: string): HTMLElement {
    const layer = document.createElement('div');
    layer.className = className;
    Object.assign(layer.style, {
      position: 'absolute',
      inset: '0',
      pointerEvents: 'none',
    });
    return layer;
  }

  private _createHandleEl(side: 'left' | 'right'): HTMLElement {
    const el = document.createElement('div');
    el.className = `ghost-handle ghost-handle-${side}`;
    el.dataset['handle'] = side;
    Object.assign(el.style, {
      position: 'absolute',
      display: 'none',
      width: `${HANDLE_GHOST_W}px`,
      boxSizing: 'border-box',
      pointerEvents: 'auto',
    });
    return el;
  }

  /**
   * Position both drag handle ghosts and make them interactive-but-invisible
   * (opacity: 0, pointer-events: auto).
   *
   * Left and right handles are positioned independently so each sits within its
   * own system's staff row when the selection spans multiple systems. The left
   * handle's solid (right) edge touches leftEdge; the right handle's solid
   * (left) edge touches rightEdge.
   *
   * The opacity parameter must match the active dark ghost opacity so the
   * gradient's solid end blends seamlessly with the adjacent selection ghost:
   * 0.45 for measure/subbeat, 0.55 for beat.
   *
   * Call showHandles() to make them visible on hover.
   */
  positionHandles(
    leftEdge: number, leftTop: number, leftHeight: number,
    rightEdge: number, rightTop: number, rightHeight: number,
    opacity: number,
  ): void {
    this._handleOpacity = opacity;
    Object.assign(this._leftHandle.style, {
      left: `${leftEdge - HANDLE_GHOST_W}px`,
      top: `${leftTop}px`,
      height: `${leftHeight}px`,
      display: '',
      opacity: '0',
      pointerEvents: 'auto',
    });
    Object.assign(this._rightHandle.style, {
      left: `${rightEdge}px`,
      top: `${rightTop}px`,
      height: `${rightHeight}px`,
      display: '',
      opacity: '0',
      pointerEvents: 'auto',
    });
  }

  /** Make both drag handle ghosts visible at the stored resolution opacity. */
  showHandles(): void {
    const op = String(this._handleOpacity);
    this._leftHandle.style.opacity = op;
    this._rightHandle.style.opacity = op;
  }

  /**
   * Hide both drag handle ghosts without removing pointer events.
   *
   * Handles remain interactive at opacity 0 so that direct hover over
   * the handle area (without first entering a dark ghost) still fires
   * mouseover events and can trigger showHandles(). Call deactivateHandles()
   * for a full shutdown that removes pointer events too.
   */
  hideHandles(): void {
    this._leftHandle.style.opacity = '0';
    this._rightHandle.style.opacity = '0';
  }

  /**
   * Fully deactivate both drag handle ghosts (display: none).
   * Called when no selection is committed or after a full session reset.
   * Unlike hideHandles(), this removes pointer events entirely.
   */
  deactivateHandles(): void {
    Object.assign(this._leftHandle.style, { display: 'none', opacity: '' });
    Object.assign(this._rightHandle.style, { display: 'none', opacity: '' });
  }

  /**
   * Switch which ghost layer accepts pointer events.
   * All layers remain in the DOM — only pointer-events changes (ADR-005
   * §"Resolution toggle": "ghost construction is not re-run on toggle").
   */
  setResolution(mode: ResolutionMode): void {
    const active = (layer: HTMLElement) => { layer.style.pointerEvents = 'auto'; };
    const inactive = (layer: HTMLElement) => { layer.style.pointerEvents = 'none'; };

    if (mode === 'measure') {
      active(this._measureLayer);
      inactive(this._beatLayer);
      inactive(this._subBeatLayer);
    } else if (mode === 'beat') {
      inactive(this._measureLayer);
      active(this._beatLayer);
      inactive(this._subBeatLayer);
    } else {
      inactive(this._measureLayer);
      inactive(this._beatLayer);
      active(this._subBeatLayer);
    }
  }

  /**
   * The ghost overlay container element.
   * Exposed so the selection behavioural layer (annotator.ts) can attach
   * delegated event listeners. Events from active-layer ghost elements bubble
   * through this element even though its own pointer-events is 'none'.
   */
  get overlay(): HTMLElement {
    return this._overlay;
  }

  /** Remove the overlay from the DOM and clear all indexes. */
  destroy(): void {
    this._overlay.remove();
    this.measureIndex.clear();
    this.beatIndex.clear();
    this.subBeatIndex.clear();
  }

  /** Append a ghost element to the correct layer. */
  _appendMeasureGhost(el: HTMLElement): void {
    this._measureLayer.appendChild(el);
  }

  _appendBeatGhost(el: HTMLElement): void {
    this._beatLayer.appendChild(el);
  }

  _appendSubBeatGhost(el: HTMLElement): void {
    this._subBeatLayer.appendChild(el);
  }
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function applyGhostBounds(el: HTMLElement, bounds: GhostBounds): void {
  Object.assign(el.style, {
    position: 'absolute',
    left: `${bounds.left}px`,
    top: `${bounds.top}px`,
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
    boxSizing: 'border-box',
    cursor: 'pointer',
  });
}

function createGhostEl(
  className: string,
  bounds: GhostBounds,
  dataKey: string,
): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  el.dataset['key'] = dataKey;
  applyGhostBounds(el, bounds);
  return el;
}

// ---------------------------------------------------------------------------
// MEI XML helpers
// ---------------------------------------------------------------------------

const XML_NS = 'http://www.w3.org/XML/1998/namespace';

function getMeiId(el: Element): string | null {
  return el.getAttribute('xml:id') ?? el.getAttributeNS(XML_NS, 'id');
}

/**
 * Walk up the MEI DOM to find the containing <ending @n>, if any.
 * Returns the @n integer or null.
 */
function getEndingN(el: Element): number | null {
  let cursor: Element | null = el.parentElement;
  while (cursor) {
    if (cursor.tagName === 'ending') {
      const n = cursor.getAttribute('n');
      if (n !== null) {
        const v = parseInt(n, 10);
        return isNaN(v) ? null : v;
      }
      return null;
    }
    cursor = cursor.parentElement;
  }
  return null;
}

/**
 * Parse the global time signature from the first <scoreDef> in the MEI doc.
 * Returns [4, 4] if not found.
 */
function parseGlobalMeter(meiDoc: Document): [number, number] {
  // Check meter.count/meter.unit attributes on scoreDef or staffDef.
  for (const tag of ['scoreDef', 'staffDef']) {
    const els = meiDoc.getElementsByTagName(tag);
    for (let i = 0; i < els.length; i++) {
      const count = parseInt(els[i].getAttribute('meter.count') ?? '', 10);
      const unit = parseInt(els[i].getAttribute('meter.unit') ?? '', 10);
      if (!isNaN(count) && !isNaN(unit) && count > 0 && unit > 0) {
        return [count, unit];
      }
    }
  }
  // Fall back to <meterSig> children.
  const sigs = meiDoc.getElementsByTagName('meterSig');
  for (let i = 0; i < sigs.length; i++) {
    const count = parseInt(sigs[i].getAttribute('count') ?? '', 10);
    const unit = parseInt(sigs[i].getAttribute('unit') ?? '', 10);
    if (!isNaN(count) && !isNaN(unit) && count > 0 && unit > 0) {
      return [count, unit];
    }
  }
  return [4, 4];
}

/**
 * Extract the PPQ-per-quarter-note resolution from the MEI document.
 *
 * MuseScore's MEI export sets @ppq on every <staffDef>. The ghost layer reads
 * this once and uses it to convert accumulated @dur.ppq values into
 * quarter-note onset positions — no Verovio API calls required.
 *
 * Fallback: infer from the first rhythmic element that carries both @dur and
 * @dur.ppq (ppqPerQn = dur.ppq × dur / 4).
 */
function parsePpqPerQn(meiDoc: Document): number {
  const staffDefs = meiDoc.getElementsByTagName('staffDef');
  for (let i = 0; i < staffDefs.length; i++) {
    const ppq = parseInt(staffDefs[i].getAttribute('ppq') ?? '', 10);
    if (!isNaN(ppq) && ppq > 0) return ppq;
  }
  for (const tag of ['note', 'chord', 'rest']) {
    const els = meiDoc.getElementsByTagName(tag);
    for (let i = 0; i < els.length; i++) {
      const dur    = parseInt(els[i].getAttribute('dur')     ?? '', 10);
      const durPpq = parseInt(els[i].getAttribute('dur.ppq') ?? '', 10);
      if (!isNaN(dur) && dur > 0 && !isNaN(durPpq) && durPpq > 0) {
        return Math.round(durPpq * dur / 4);
      }
    }
  }
  return 8; // conservative fallback
}

// ---------------------------------------------------------------------------
// Adjusted mLeft: skip system decorations
// ---------------------------------------------------------------------------

/**
 * Move mLeft past any clef, key-signature, or meter-signature groups that
 * appear at the start of a system (the first measure on each staff row).
 * At system starts these decorations appear before the first note and would
 * otherwise give a ghost that starts too far to the left.
 */
function adjustedMLeft(
  measureSvgEl: Element,
  rawMLeft: number,
  containerLeft: number,
): number {
  let adjusted = rawMLeft;
  for (const cls of ['clef', 'keySig', 'meterSig']) {
    const decoEls = measureSvgEl.querySelectorAll(
      `:scope > g.${cls}, :scope > g[class*="${cls}"], ` +
      `g.staff > g.${cls}, g.staff > g[class*="${cls}"]`,
    );
    for (const deco of decoEls) {
      const r = deco.getBoundingClientRect();
      const decoRight = r.right - containerLeft;
      if (decoRight > adjusted) adjusted = decoRight + 2;
    }
  }
  return adjusted;
}

/**
 * Clamp mRight to the left edge of the last barLine child element, preventing
 * slurs / ties / beams that extend visually past the closing barline from
 * bloating the ghost into the next measure's space.
 *
 * Verovio renders closing barlines as direct-child <g class="barLine"> of the
 * measure group. Falls back to rawRight when no barLine element is found
 * (final measure of a system, or unexpected Verovio class name).
 */
function rightEdgeFromBarline(
  measureSvgEl: Element,
  rawRight: number,
  containerLeft: number,
): number {
  const barlines = measureSvgEl.querySelectorAll(
    ':scope > g.barLine, :scope > g[class*="barLine"]',
  );
  if (barlines.length === 0) return rawRight;
  const last = barlines[barlines.length - 1]!;
  const barlineLeft = last.getBoundingClientRect().left - containerLeft;
  return Math.min(rawRight, barlineLeft);
}

// ---------------------------------------------------------------------------
// Per-measure data collected before system grouping
// ---------------------------------------------------------------------------

/** Gap threshold (px) between consecutive measure midpoints that signals a
 *  new system row. Within a system midpoints vary by ~20 px; between systems
 *  the jump is 200 px or more at any supported score scale. */
const SYSTEM_GAP_PX = 80;

interface MeasureInfo {
  measureId:        string;
  svgMeasure:       Element;
  meiMeasure:       Element;
  mLeft:            number;
  mRight:           number;
  rawTop:           number;
  rawBottom:        number;
  barN:             number;
  endingN:          number | null;
  /**
   * Deduplicated measure ghost key — equal to measureGhostKey(barN, endingN)
   * unless another earlier-rendered measure shares the same base key, in which
   * case a '#N' suffix disambiguates (G2.3: section-reset @n values).
   */
  key:              string;
  /**
   * 0-indexed position of this measure among all rendered measures (those with
   * a matching SVG element). Used as the measure component of beat/subbeat
   * encoded keys so that measures with duplicate @n values (section-reset
   * numbering) still produce distinct integer keys in the beat/subbeat indexes.
   */
  renderOrder:      number;
  noteInputs:       NotePositionInput[];
  beatCount:        number;
  beatUnit:         number;
  measureStartTime: number;
}

/**
 * Derive the system's staff-line bounds by querying the direct <path> children
 * of <g class="staff"> elements within each measure SVG group.
 *
 * In Verovio's SVG, the five horizontal staff lines are direct <path> children
 * of <g class="staff">. Noteheads, stems, beams, and slurs live inside nested
 * <g> children and are therefore excluded by :scope > path — giving bounds
 * that span exactly from the first staff line to the last, with no note bleed.
 *
 * Falls back to the union of raw measure bounding rects when no staff-line
 * paths are found (e.g. testing fixtures or an unusual Verovio build).
 */
function staffLineBounds(
  measures: MeasureInfo[],
  containerRect: DOMRect,
): { top: number; bottom: number } {
  let top = Infinity;
  let bottom = -Infinity;

  for (const info of measures) {
    const staffEls = info.svgMeasure.querySelectorAll(
      ':scope > g.staff, :scope > g.staffGrp > g.staff',
    );
    for (const staffEl of staffEls) {
      const linePaths = staffEl.querySelectorAll(':scope > path');
      if (linePaths.length === 0) continue;
      const firstRect = linePaths[0]!.getBoundingClientRect();
      const lastRect  = linePaths[linePaths.length - 1]!.getBoundingClientRect();
      top    = Math.min(top,    firstRect.top    - containerRect.top);
      bottom = Math.max(bottom, lastRect.bottom  - containerRect.top);
    }
  }

  if (!isFinite(top) || !isFinite(bottom)) {
    return {
      top:    measures.reduce((mn, m) => Math.min(mn, m.rawTop),    Infinity),
      bottom: measures.reduce((mx, m) => Math.max(mx, m.rawBottom), -Infinity),
    };
  }
  return { top, bottom };
}

// ---------------------------------------------------------------------------
// Per-layer note collection (PPQ accumulation)
// ---------------------------------------------------------------------------

/**
 * Walk the direct children of one MEI <layer> element and collect a
 * NotePositionInput for every real note (grace notes excluded).
 *
 * Uses @dur.ppq on each rhythmic event to accumulate the measure-local onset
 * in PPQ units, then converts to quarter-note units with ppqPerQn. This avoids
 * Verovio toolkit API calls and works with any MEI file that carries @dur.ppq
 * (MuseScore exports always do — @ppq on <staffDef> sets the resolution).
 *
 * Handled containers:
 *   note, chord   — advance accumulator by @dur.ppq; emit NotePositionInput
 *   rest, mRest, space — advance accumulator, emit nothing
 *   beam, tuplet, and all other elements — transparent: recurse into children
 */
function collectLayerNotes(
  layerEl: Element,
  ppqPerQn: number,
  container: HTMLElement,
  containerRect: DOMRect,
  out: NotePositionInput[],
): void {
  function processEl(el: Element, ppq: number): number {
    const tag = el.tagName.toLowerCase();

    if (tag === 'note') {
      const durPpq = parseInt(el.getAttribute('dur.ppq') ?? '0', 10);
      if (durPpq > 0) {
        const noteId = getMeiId(el);
        if (noteId) {
          const svgNote = container.querySelector(`[id="${noteId}"]`);
          if (svgNote) {
            const r = svgNote.getBoundingClientRect();
            out.push({
              xLeft:             r.left - containerRect.left,
              scoreTimeOnset:    ppq / ppqPerQn,
              scoreTimeDuration: durPpq / ppqPerQn,
            });
          }
        }
        return ppq + durPpq;
      }
      return ppq; // grace note (dur.ppq = 0 or absent)
    }

    if (tag === 'chord') {
      const durPpq = parseInt(el.getAttribute('dur.ppq') ?? '0', 10);
      if (durPpq > 0) {
        // All notes in the chord share the same onset.
        const childNotes = el.getElementsByTagName('note');
        for (let i = 0; i < childNotes.length; i++) {
          const noteId = getMeiId(childNotes[i]!);
          if (noteId) {
            const svgNote = container.querySelector(`[id="${noteId}"]`);
            if (svgNote) {
              const r = svgNote.getBoundingClientRect();
              out.push({
                xLeft:             r.left - containerRect.left,
                scoreTimeOnset:    ppq / ppqPerQn,
                scoreTimeDuration: durPpq / ppqPerQn,
              });
            }
          }
        }
        return ppq + durPpq;
      }
      return ppq;
    }

    if (tag === 'rest' || tag === 'mrest' || tag === 'space') {
      return ppq + parseInt(el.getAttribute('dur.ppq') ?? '0', 10);
    }

    // Transparent grouping containers (beam, tuplet, etc.): recurse into children.
    let p = ppq;
    for (let i = 0; i < el.children.length; i++) {
      p = processEl(el.children[i]!, p);
    }
    return p;
  }

  let ppq = 0;
  for (let i = 0; i < layerEl.children.length; i++) {
    ppq = processEl(layerEl.children[i]!, ppq);
  }
}

// ---------------------------------------------------------------------------
// buildGhosts — main factory
// ---------------------------------------------------------------------------

/**
 * Build ghost regions over a rendered Verovio score and return a GhostLayer
 * with fully-populated measure, beat, and sub-beat indexes.
 *
 * Must be called after the score SVG is mounted and laid out (requires a real
 * browser layout — not testable with jsdom). For algorithmic correctness
 * testing, the pure functions (computeBeatBoundaries, getMeterForMeasure, etc.)
 * are tested directly.
 *
 * @param container The .scoreContent element (position: relative required).
 * @param meiText   Normalised MEI content string for the loaded score.
 * @param tk        Verovio toolkit instance; getTimesForElement is called per note.
 */
export function buildGhosts(
  container: HTMLElement,
  meiText: string,
): GhostLayer {
  const layer = new GhostLayer(container);

  const meiDoc = new DOMParser().parseFromString(meiText, 'text/xml');
  const [globalBeatCount, globalBeatUnit] = parseGlobalMeter(meiDoc);
  const ppqPerQn = parsePpqPerQn(meiDoc);
  const containerRect = container.getBoundingClientRect();

  // ── Phase 1: collect per-measure geometry and timing data ─────────────────

  const measureInfos: MeasureInfo[] = [];
  const meiMeasures = meiDoc.getElementsByTagName('measure');

  // G2.3: track seen base keys to detect @n collisions from section-reset
  // measure numbering. When a collision is found, a '#N' suffix disambiguates
  // the key so no two rendered measures share the same ghost key string.
  const seenBaseKeys = new Map<string, number>(); // baseKey → occurrence count
  let renderOrder = 0; // 0-indexed render position among SVG-matched measures

  for (let mi = 0; mi < meiMeasures.length; mi++) {
    const meiMeasure = meiMeasures[mi];
    const measureId  = getMeiId(meiMeasure);
    if (!measureId) continue;

    const svgMeasure = container.querySelector(`[id="${measureId}"]`);
    if (!svgMeasure) continue;

    const measureRect = svgMeasure.getBoundingClientRect();
    const mLeft0    = measureRect.left   - containerRect.left;
    const mRightRaw = measureRect.right  - containerRect.left;
    const rawTop    = measureRect.top    - containerRect.top;
    const rawBottom = measureRect.bottom - containerRect.top;

    // Adjust left past system decorations; clamp right to closing barline.
    const mLeft  = adjustedMLeft(svgMeasure, mLeft0, containerRect.left);
    const mRight = rightEdgeFromBarline(svgMeasure, mRightRaw, containerRect.left);

    const barN    = parseInt(meiMeasure.getAttribute('n') ?? `${mi + 1}`, 10);
    const endingN = getEndingN(meiMeasure);

    // Deduplicated measure ghost key. Measures that share @n due to
    // section-reset numbering get '#1', '#2', … suffixes in encounter order.
    const baseKey   = measureGhostKey(barN, endingN);
    const cnt       = seenBaseKeys.get(baseKey) ?? 0;
    seenBaseKeys.set(baseKey, cnt + 1);
    const key = cnt === 0 ? baseKey : `${baseKey}#${cnt}`;

    const [beatCount, beatUnit] = getMeterForMeasure(
      meiMeasure, globalBeatCount, globalBeatUnit,
    );

    // scoreTimeOnset from PPQ accumulation is 0-indexed from measure start, so
    // measureStartTime = 0 (computeBeatBoundaries subtracts it for localOnset).
    const measureStartTime = 0;

    // Collect note positions from all staves/layers via PPQ accumulation.
    // This reads @dur.ppq on each rhythmic event — no Verovio API call per note.
    const noteInputs: NotePositionInput[] = [];
    const staffEls = meiMeasure.getElementsByTagName('staff');
    for (let si = 0; si < staffEls.length; si++) {
      const layerEls = staffEls[si]!.getElementsByTagName('layer');
      for (let li = 0; li < layerEls.length; li++) {
        collectLayerNotes(layerEls[li]!, ppqPerQn, container, containerRect, noteInputs);
      }
    }

    measureInfos.push({
      measureId, svgMeasure, meiMeasure,
      mLeft, mRight, rawTop, rawBottom,
      barN, endingN, key, renderOrder: renderOrder++,
      noteInputs, beatCount, beatUnit, measureStartTime,
    });
  }

  // ── Phase 2: group measures into system rows ───────────────────────────────
  // Compare midpoint-Y of consecutive measures. A jump > SYSTEM_GAP_PX signals
  // a new system row; within a system midpoints vary by at most ~20 px.

  const systems: MeasureInfo[][] = [];
  let currentSystem: MeasureInfo[] = [];

  for (const info of measureInfos) {
    const midY = (info.rawTop + info.rawBottom) / 2;
    if (currentSystem.length > 0) {
      const prev     = currentSystem[currentSystem.length - 1]!;
      const prevMidY = (prev.rawTop + prev.rawBottom) / 2;
      if (Math.abs(midY - prevMidY) > SYSTEM_GAP_PX) {
        systems.push(currentSystem);
        currentSystem = [];
      }
    }
    currentSystem.push(info);
  }
  if (currentSystem.length > 0) systems.push(currentSystem);

  // ── Phase 3: emit ghost elements with per-system uniform bounds ────────────

  for (const system of systems) {
    // systemTop: min rawTop including note content — anchor for the bracket.
    const systemTop = system.reduce((mn, m) => Math.min(mn, m.rawTop), Infinity);

    // Staff-line bounds: first staff line to last staff line, no note content.
    const sBounds    = staffLineBounds(system, containerRect);
    const ghostHeight = sBounds.bottom - sBounds.top;

    for (const info of system) {
      const { mLeft, mRight, barN, endingN, key: mKey, renderOrder,
              noteInputs, beatCount, beatUnit, measureStartTime } = info;

      // Measure ghost spans staff lines only.
      const msrBounds: GhostBounds = {
        left:   mLeft,
        top:    sBounds.top,
        width:  mRight - mLeft,
        height: ghostHeight,
      };
      const msrEl = createGhostEl('ghost ghost-measure', msrBounds, mKey);
      layer._appendMeasureGhost(msrEl);
      layer.measureIndex.set(mKey, {
        el: msrEl, barN, endingN, key: mKey,
        bounds: msrBounds,
        systemTop,
      });

      const subDiv = subdivisionsPerBeat(beatCount, beatUnit);
      const bb = computeBeatBoundaries(
        mLeft, mRight, measureStartTime, beatCount, beatUnit, noteInputs,
      );

      for (const b of bb.struckBeats) {
        const bLeft  = bb.beatLefts[b];
        const bRight = bb.beatRights[b];
        if (bRight <= bLeft) continue;

        const beatFloat = beatToFloat(b, 0, subDiv);
        // Use renderOrder (not barN) as the measure component so that
        // measures with duplicate @n values (section-reset numbering) produce
        // distinct encoded keys in the beat and sub-beat indexes (G2.3).
        const encKey    = encodeBeat(renderOrder, b);

        const beatBounds: GhostBounds = {
          left: bLeft, top: sBounds.top, width: bRight - bLeft, height: ghostHeight,
        };
        const beatEl = createGhostEl('ghost ghost-beat', beatBounds, `${encKey}`);
        layer._appendBeatGhost(beatEl);
        layer.beatIndex.set(encKey, {
          el: beatEl, barN, endingN, measureKey: mKey,
          beatIdx: b, encodedKey: encKey, beatFloat,
          bounds: beatBounds,
        });

        for (let sb = 0; sb < subDiv; sb++) {
          if (!bb.struckSubBeats.has(b * 100 + sb)) continue;

          const sbLeft  = bb.subBeatLefts[b]?.[sb] ?? bLeft;
          const sbRight = bb.subBeatRights[b]?.[sb] ?? bRight;
          if (sbRight <= sbLeft) continue;

          const sbFloat  = beatToFloat(b, sb, subDiv);
          const sbEncKey = encodeSubBeat(renderOrder, b, sb);

          const sbBounds: GhostBounds = {
            left: sbLeft, top: sBounds.top, width: sbRight - sbLeft, height: ghostHeight,
          };
          const sbEl = createGhostEl('ghost ghost-subbeat', sbBounds, `${sbEncKey}`);
          layer._appendSubBeatGhost(sbEl);
          layer.subBeatIndex.set(sbEncKey, {
            el: sbEl, barN, endingN, measureKey: mKey,
            beatIdx: b, subBeatIdx: sb,
            encodedKey: sbEncKey, beatFloat: sbFloat,
            bounds: sbBounds,
          });
        }
      }
    }
  }

  return layer;
}
