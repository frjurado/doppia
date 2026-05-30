/**
 * Selection behavioural layer — the interaction module for the tagging tool.
 *
 * Manages the mousedown/mouseover/mouseup range-select interaction on top of
 * the ghost structural layer (ghosts.ts). Tracks session state with four
 * independent concurrent boolean flags rather than a phase enum.
 *
 * Key departures from the prototype's annotator.js:
 *  - Event delegation on the overlay container, not per-element listeners.
 *  - Highlighted ghosts tracked in a Set, not a full-DOM clearGhosts scan.
 *  - Concurrent flags (fragmentSet / conceptSet / stagesComplete /
 *    propertiesComplete) replace the prototype's phase enum (ADR-011 §2).
 *  - Resolution toggle flips pointer-events on layers; session does not
 *    re-run ghost construction on toggle (ADR-005 §"Resolution toggle").
 *
 * Selection constraints (prototype-tagging-tool.md §"Selection constraints"):
 *  - Backward repeat barlines (:|), da capo, and dal segno clamp the
 *    selection at the barrier measure; it cannot extend past the barline.
 *  - When a selection falls inside a repeat ending, repeat_context is
 *    captured from the ghost's endingN.
 *  - Endpoint re-selection: clicking the first or last ghost of a committed
 *    selection re-anchors the drag from the opposite end.
 *
 * References: prototype-tagging-tool.md, tagging-tool-design.md §2, ADR-005,
 * ADR-011 §2.
 */

import type {
  BeatGhostEntry,
  GhostLayer,
  MeasureGhostEntry,
  ResolutionMode,
  SubBeatGhostEntry,
} from './ghosts';
import { measureGhostKey } from './ghosts';

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * The four concurrent session flags (ADR-011 §2, tagging-tool-design.md §2).
 * Any flag can be set in any order; Submit enables when all four are true.
 */
export interface AnnotationFlags {
  /** Main fragment bracket has been drawn and committed. */
  fragmentSet: boolean;
  /** A concept has been selected from the picker. */
  conceptSet: boolean;
  /**
   * All required stages have spatial assignments, or the concept has no
   * CONTAINS edges (trivially true for stageless concepts).
   */
  stagesComplete: boolean;
  /**
   * All required properties have values, or the concept has no required
   * PropertySchema (trivially true for property-free concepts).
   */
  propertiesComplete: boolean;
}

/**
 * The result of a committed ghost-layer selection.
 * Produced by AnnotationSession; extended with mc_start/mc_end by Step 11.
 */
export interface SelectionRange {
  /** First measure in selection (MEI @n, human bar number). */
  barStart: number;
  /** Last measure in selection (MEI @n, human bar number, inclusive). */
  barEnd: number;
  /**
   * Float-encoded beat start (ADR-005), or null for measure-level selection.
   * 1-indexed beat number, e.g. 2.0 = beat 2; 2.5 = beat 2, second eighth in 4/4.
   */
  beatStart: number | null;
  /**
   * Float-encoded exclusive upper bound for onset-based inclusion, or null.
   * Any note whose onset < beatEnd is included; onset >= beatEnd is excluded.
   */
  beatEnd: number | null;
  /** Ending context when the selection falls inside a written repeat ending. */
  repeatContext: 'first_ending' | 'second_ending' | null;
}

export interface AnnotationSessionOptions {
  /**
   * Measure ghost keys (from measureGhostKey()) whose right barline is a
   * close-repeat (:|) or da capo/dal segno marker. The selection may include
   * a barrier measure but cannot extend past its right barline.
   * Build with buildRepeatBarriers().
   */
  closeRepeatMeasures?: Set<string>;
  /** Initial resolution mode. Defaults to 'measure'. */
  resolution?: ResolutionMode;
}

// ---------------------------------------------------------------------------
// MEI barrier parsing
// ---------------------------------------------------------------------------

/** Walk up a MEI DOM element to find the containing <ending @n>, if any. */
function endingNFromEl(el: Element): number | null {
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
 * Parse a normalised MEI document and return the set of measure ghost keys
 * that act as hard selection barriers (prototype-tagging-tool.md
 * §"Selection constraints — Backward repeat barlines as selection barriers").
 *
 * A barrier measure may be the last measure of a selection, but the
 * selection cannot extend past it: the close-repeat barline is a hard stop.
 */
export function buildRepeatBarriers(meiText: string): Set<string> {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');
  const barriers = new Set<string>();

  const measures = doc.getElementsByTagName('measure');
  for (let i = 0; i < measures.length; i++) {
    const m = measures[i]!;
    let isBarrier = false;

    const right = m.getAttribute('right');
    if (right === 'rptend' || right === 'rptboth') {
      isBarrier = true;
    }

    if (!isBarrier) {
      const dirs = m.getElementsByTagName('dir');
      for (let j = 0; j < dirs.length; j++) {
        const text = dirs[j]?.textContent ?? '';
        if (
          text.includes('D.C.') ||
          text.includes('D.S.') ||
          text.includes('da capo') ||
          text.includes('dal segno')
        ) {
          isBarrier = true;
          break;
        }
      }
    }

    if (isBarrier) {
      const barN = parseInt(m.getAttribute('n') ?? `${i + 1}`, 10);
      barriers.add(measureGhostKey(barN, endingNFromEl(m)));
    }
  }

  return barriers;
}

// ---------------------------------------------------------------------------
// Ghost identification helpers
// ---------------------------------------------------------------------------

/**
 * Find the nearest .ghost ancestor from a mouse event target.
 * The event may fire on a .ghost-edge or .ghost-gradient child because the
 * ghost element itself is the interactive container; we walk up via closest().
 * Returns null when the target is not within any ghost.
 */
export function ghostFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const el = target.closest('.ghost');
  return el instanceof HTMLElement ? el : null;
}

function ghostDataKey(el: HTMLElement): string | null {
  return el.dataset['key'] ?? null;
}

// ---------------------------------------------------------------------------
// CSS class helpers (add / rmv pattern from prototype-tagging-tool.md)
// ---------------------------------------------------------------------------

function addClass(el: HTMLElement, cls: string): void {
  el.classList.add(cls);
}

function removeClass(el: HTMLElement, cls: string): void {
  el.classList.remove(cls);
}

// ---------------------------------------------------------------------------
// Range computation
// ---------------------------------------------------------------------------

/**
 * Return the ordered slice of measure ghost keys between anchor and current,
 * clamped at the first close-repeat barrier encountered in the drag direction.
 *
 * orderedKeys must be in MEI document order (the insertion order of
 * GhostLayer.measureIndex, which mirrors buildGhosts()'s traversal order).
 *
 * Clamping rule: a barrier key means the selection may include that measure
 * but cannot include any measure that comes after it in the ordered list.
 */
export function measureKeyRange(
  anchorKey: string,
  currentKey: string,
  orderedKeys: string[],
  barriers: Set<string>,
): string[] {
  const anchorIdx = orderedKeys.indexOf(anchorKey);
  const currentIdx = orderedKeys.indexOf(currentKey);
  if (anchorIdx === -1) return [];
  if (currentIdx === -1) return anchorKey ? [anchorKey] : [];

  const startIdx = Math.min(anchorIdx, currentIdx);
  let endIdx = Math.max(anchorIdx, currentIdx);

  // Clamp: if any measure between start (exclusive) and end has a barrier on
  // its right barline, the selection cannot extend past it.
  for (let i = startIdx; i < endIdx; i++) {
    if (barriers.has(orderedKeys[i]!)) {
      endIdx = i;
      break;
    }
  }

  return orderedKeys.slice(startIdx, endIdx + 1);
}

/**
 * Return the ordered slice of numeric beat/sub-beat keys covering [lo, hi]
 * (both inclusive). orderedKeys must be sorted ascending.
 */
export function numericKeyRange(
  anchorKey: number,
  currentKey: number,
  orderedKeys: number[],
): number[] {
  const lo = Math.min(anchorKey, currentKey);
  const hi = Math.max(anchorKey, currentKey);

  const startIdx = orderedKeys.findIndex(k => k >= lo);
  if (startIdx === -1) return [];
  // If the first candidate key is already above hi, nothing falls in [lo, hi].
  if (orderedKeys[startIdx]! > hi) return [];

  let endIdx = startIdx;
  while (endIdx + 1 < orderedKeys.length && orderedKeys[endIdx + 1]! <= hi) {
    endIdx++;
  }
  return orderedKeys.slice(startIdx, endIdx + 1);
}

// ---------------------------------------------------------------------------
// Repeat-context resolution
// ---------------------------------------------------------------------------

function repeatContextFromEndingN(
  endingN: number | null,
): SelectionRange['repeatContext'] {
  if (endingN === 1) return 'first_ending';
  if (endingN !== null && endingN >= 2) return 'second_ending';
  return null;
}

// ---------------------------------------------------------------------------
// AnnotationSession
// ---------------------------------------------------------------------------

/**
 * Manages a single annotation session: ghost-layer interaction, concurrent
 * flags, and the committed selection range.
 *
 * Lifecycle: construct after buildGhosts() resolves; call destroy() before
 * the score re-renders or the ghost layer is destroyed.
 */
export class AnnotationSession {
  private readonly _layer: GhostLayer;
  private readonly _barriers: Set<string>;

  // Ordered key arrays (cached from layer indexes at construction time).
  // measureIndex insertion order = MEI document order (Maps preserve insertion).
  private readonly _orderedMeasureKeys: string[];
  private readonly _orderedBeatKeys: number[];
  private readonly _orderedSubBeatKeys: number[];

  // Current resolution mode.
  private _resolution: ResolutionMode;

  // Drag state.
  private _dragging = false;
  private _anchorMeasureKey: string | null = null;
  private _anchorBeatKey: number | null = null;
  private _anchorSubBeatKey: number | null = null;

  // Highlighted ghost tracking — Set-based, never a full-DOM scan.
  private readonly _litGhosts = new Set<HTMLElement>();
  private readonly _darkGhosts = new Set<HTMLElement>();
  private _hoverGhost: HTMLElement | null = null;

  // Current committed selection (updated on mouseup).
  private _selection: SelectionRange | null = null;

  // Cleanup functions for removeEventListener.
  private readonly _cleanup: Array<() => void> = [];

  // Subscriber callbacks.
  private _onSelectionChange: ((sel: SelectionRange | null) => void) | null = null;
  private _onFlagsChange: ((flags: AnnotationFlags) => void) | null = null;

  // Concurrent flags.
  private _flags: AnnotationFlags = {
    fragmentSet: false,
    conceptSet: false,
    stagesComplete: false,
    propertiesComplete: false,
  };

  constructor(layer: GhostLayer, options: AnnotationSessionOptions = {}) {
    this._layer = layer;
    this._barriers = options.closeRepeatMeasures ?? new Set();
    this._resolution = options.resolution ?? 'measure';

    this._orderedMeasureKeys = [...layer.measureIndex.keys()];
    this._orderedBeatKeys = [...layer.beatIndex.keys()].sort((a, b) => a - b);
    this._orderedSubBeatKeys = [...layer.subBeatIndex.keys()].sort((a, b) => a - b);

    // Activate the initial resolution layer.
    this._layer.setResolution(this._resolution);
    this._attachListeners();
  }

  // ── Public read API ────────────────────────────────────────────────────────

  get flags(): Readonly<AnnotationFlags> {
    return { ...this._flags };
  }

  get selection(): SelectionRange | null {
    return this._selection;
  }

  // ── Public write API ───────────────────────────────────────────────────────

  /**
   * Switch the active ghost layer. Delegates to GhostLayer.setResolution()
   * (which flips pointer-events) and cancels any in-progress drag. The
   * committed selection is preserved — only the in-progress drag is cleared.
   * Ghost construction is NOT re-run (ADR-005 §"Resolution toggle").
   */
  setResolution(mode: ResolutionMode): void {
    if (mode === this._resolution) return;
    this._resolution = mode;
    this._layer.setResolution(mode);
    this._cancelDrag();
  }

  /** Mark a concept as selected (or unselected). */
  setConceptSet(value: boolean): void {
    this._setFlag('conceptSet', value);
  }

  /** Mark all required stages as assigned (or unassigned). */
  setStagesComplete(value: boolean): void {
    this._setFlag('stagesComplete', value);
  }

  /** Mark all required properties as filled (or unfilled). */
  setPropertiesComplete(value: boolean): void {
    this._setFlag('propertiesComplete', value);
  }

  /** Subscribe to selection changes. Replaces any prior subscriber. */
  onSelectionChange(cb: (sel: SelectionRange | null) => void): void {
    this._onSelectionChange = cb;
  }

  /** Subscribe to flag changes. Replaces any prior subscriber. */
  onFlagsChange(cb: (flags: AnnotationFlags) => void): void {
    this._onFlagsChange = cb;
  }

  /** Remove all event listeners and clear visual highlights. */
  destroy(): void {
    for (const remove of this._cleanup) remove();
    this._cleanup.length = 0;
    if (this._hoverGhost) {
      removeClass(this._hoverGhost, 'light');
      this._hoverGhost = null;
    }
    this._clearAllHighlights();
  }

  // ── Private: flag management ──────────────────────────────────────────────

  private _setFlag(key: keyof AnnotationFlags, value: boolean): void {
    if (this._flags[key] === value) return;
    this._flags = { ...this._flags, [key]: value };
    this._onFlagsChange?.(this.flags);
  }

  // ── Private: listener attachment ──────────────────────────────────────────

  private _attachListeners(): void {
    const overlay = this._layer.overlay;

    const onMouseDown = (e: MouseEvent) => this._handleMouseDown(e);
    const onMouseOver = (e: MouseEvent) => this._handleMouseOver(e);
    const onMouseLeave = () => this._handleMouseLeave();
    const onMouseUp = () => this._handleMouseUp();

    overlay.addEventListener('mousedown', onMouseDown);
    overlay.addEventListener('mouseover', onMouseOver);
    overlay.addEventListener('mouseleave', onMouseLeave);
    // mouseup on document catches pointer releases outside the overlay.
    document.addEventListener('mouseup', onMouseUp);

    this._cleanup.push(
      () => overlay.removeEventListener('mousedown', onMouseDown),
      () => overlay.removeEventListener('mouseover', onMouseOver),
      () => overlay.removeEventListener('mouseleave', onMouseLeave),
      () => document.removeEventListener('mouseup', onMouseUp),
    );
  }

  // ── Private: event handlers ────────────────────────────────────────────────

  private _handleMouseDown(e: MouseEvent): void {
    if (this._hoverGhost) {
      removeClass(this._hoverGhost, 'light');
      this._hoverGhost = null;
    }
    const ghost = ghostFromTarget(e.target);
    if (!ghost) return;
    const key = ghostDataKey(ghost);
    if (key === null) return;

    e.preventDefault();

    if (this._resolution === 'measure') {
      if (!ghost.classList.contains('ghost-measure')) return;
      this._startMeasureDrag(key);
    } else if (this._resolution === 'beat') {
      if (!ghost.classList.contains('ghost-beat')) return;
      const numKey = parseInt(key, 10);
      if (!isNaN(numKey)) this._startBeatDrag(numKey);
    } else {
      if (!ghost.classList.contains('ghost-subbeat')) return;
      const numKey = parseInt(key, 10);
      if (!isNaN(numKey)) this._startSubBeatDrag(numKey);
    }
  }

  private _handleMouseOver(e: MouseEvent): void {
    const ghost = ghostFromTarget(e.target);

    if (!this._dragging) {
      if (ghost !== this._hoverGhost) {
        if (this._hoverGhost) removeClass(this._hoverGhost, 'light');
        this._hoverGhost = ghost;
        if (ghost) addClass(ghost, 'light');
      }
      return;
    }

    if (!ghost) return;
    const key = ghostDataKey(ghost);
    if (key === null) return;

    if (this._resolution === 'measure') {
      if (!ghost.classList.contains('ghost-measure')) return;
      this._updateMeasureDrag(key);
    } else if (this._resolution === 'beat') {
      if (!ghost.classList.contains('ghost-beat')) return;
      const numKey = parseInt(key, 10);
      if (!isNaN(numKey)) this._updateBeatDrag(numKey);
    } else {
      if (!ghost.classList.contains('ghost-subbeat')) return;
      const numKey = parseInt(key, 10);
      if (!isNaN(numKey)) this._updateSubBeatDrag(numKey);
    }
  }

  private _handleMouseLeave(): void {
    if (this._hoverGhost) {
      removeClass(this._hoverGhost, 'light');
      this._hoverGhost = null;
    }
  }

  private _handleMouseUp(): void {
    if (!this._dragging) return;
    this._commitDrag();
  }

  // ── Private: measure-level drag ────────────────────────────────────────────

  private _startMeasureDrag(key: string): void {
    // Endpoint re-selection: if the user clicks the first or last measure of
    // the committed selection, re-anchor the drag from the opposite end
    // (prototype-tagging-tool.md §"Endpoint re-selection").
    if (this._darkGhosts.size >= 2) {
      const darkMeasureKeys = this._orderedMeasureKeys.filter(k => {
        const entry = this._layer.measureIndex.get(k);
        return entry !== undefined && this._darkGhosts.has(entry.el);
      });
      if (darkMeasureKeys.length >= 2) {
        const firstKey = darkMeasureKeys[0]!;
        const lastKey = darkMeasureKeys[darkMeasureKeys.length - 1]!;
        if (key === lastKey) {
          this._dragging = true;
          this._anchorMeasureKey = firstKey;
          this._updateMeasureDrag(key);
          return;
        }
        if (key === firstKey) {
          this._dragging = true;
          this._anchorMeasureKey = lastKey;
          this._updateMeasureDrag(key);
          return;
        }
      }
    }

    this._clearAllHighlights();
    this._dragging = true;
    this._anchorMeasureKey = key;
    this._updateMeasureDrag(key);
  }

  private _updateMeasureDrag(currentKey: string): void {
    if (!this._anchorMeasureKey) return;

    const range = measureKeyRange(
      this._anchorMeasureKey,
      currentKey,
      this._orderedMeasureKeys,
      this._barriers,
    );

    this._clearDark();
    for (const k of range) {
      const entry = this._layer.measureIndex.get(k);
      if (entry) {
        addClass(entry.el, 'dark');
        this._darkGhosts.add(entry.el);
      }
    }
  }

  private _commitMeasureDrag(): void {
    if (!this._anchorMeasureKey) return;

    // Collect the currently dark measure ghosts in document order.
    const entries: MeasureGhostEntry[] = [];
    for (const el of this._darkGhosts) {
      const key = ghostDataKey(el);
      if (key !== null) {
        const entry = this._layer.measureIndex.get(key);
        if (entry) entries.push(entry);
      }
    }
    if (entries.length === 0) return;

    entries.sort(
      (a, b) =>
        this._orderedMeasureKeys.indexOf(a.key) -
        this._orderedMeasureKeys.indexOf(b.key),
    );

    const first = entries[0]!;
    const last = entries[entries.length - 1]!;

    this._clearDark();
    for (const entry of entries) {
      addClass(entry.el, 'dark');
      this._darkGhosts.add(entry.el);
    }

    let repeatContext: SelectionRange['repeatContext'] = null;
    for (const entry of entries) {
      if (entry.endingN !== null) {
        repeatContext = repeatContextFromEndingN(entry.endingN);
        break;
      }
    }

    this._selection = {
      barStart: first.barN,
      barEnd: last.barN,
      beatStart: null,
      beatEnd: null,
      repeatContext,
    };

    this._setFlag('fragmentSet', true);
    this._onSelectionChange?.(this._selection);
  }

  // ── Private: beat-level drag ───────────────────────────────────────────────

  private _startBeatDrag(key: number): void {
    if (this._darkGhosts.size >= 2) {
      const sorted = this._sortedDarkBeatKeys();
      if (sorted.length >= 2) {
        const firstKey = sorted[0]!;
        const lastKey = sorted[sorted.length - 1]!;
        if (key === lastKey) {
          this._dragging = true;
          this._anchorBeatKey = firstKey;
          this._updateBeatDrag(key);
          return;
        }
        if (key === firstKey) {
          this._dragging = true;
          this._anchorBeatKey = lastKey;
          this._updateBeatDrag(key);
          return;
        }
      }
    }

    this._clearAllHighlights();
    this._dragging = true;
    this._anchorBeatKey = key;
    this._updateBeatDrag(key);
  }

  private _updateBeatDrag(currentKey: number): void {
    if (this._anchorBeatKey === null) return;
    const range = numericKeyRange(
      this._anchorBeatKey,
      currentKey,
      this._orderedBeatKeys,
    );

    this._clearDark();
    for (const k of range) {
      const entry = this._layer.beatIndex.get(k);
      if (entry) {
        addClass(entry.el, 'dark');
        this._darkGhosts.add(entry.el);
      }
    }
  }

  private _commitBeatDrag(): void {
    if (this._anchorBeatKey === null) return;

    const entries: BeatGhostEntry[] = [];
    for (const el of this._darkGhosts) {
      const key = ghostDataKey(el);
      if (key !== null) {
        const numKey = parseInt(key, 10);
        if (!isNaN(numKey)) {
          const entry = this._layer.beatIndex.get(numKey);
          if (entry) entries.push(entry);
        }
      }
    }
    if (entries.length === 0) return;

    entries.sort((a, b) => a.encodedKey - b.encodedKey);
    const first = entries[0]!;
    const last = entries[entries.length - 1]!;

    const barNs = entries.map(e => e.barN);
    const barStart = Math.min(...barNs);
    const barEnd = Math.max(...barNs);

    // beat_end is the exclusive upper bound for onset-based inclusion:
    // the next beat float after the last selected beat (+1 step).
    const beatEnd = last.beatFloat + 1.0;

    this._clearDark();
    for (const entry of entries) {
      addClass(entry.el, 'dark');
      this._darkGhosts.add(entry.el);
    }

    let repeatContext: SelectionRange['repeatContext'] = null;
    for (const entry of entries) {
      if (entry.endingN !== null) {
        repeatContext = repeatContextFromEndingN(entry.endingN);
        break;
      }
    }

    this._selection = {
      barStart,
      barEnd,
      beatStart: first.beatFloat,
      beatEnd,
      repeatContext,
    };

    this._setFlag('fragmentSet', true);
    this._onSelectionChange?.(this._selection);
  }

  // ── Private: sub-beat-level drag ───────────────────────────────────────────

  private _startSubBeatDrag(key: number): void {
    if (this._darkGhosts.size >= 2) {
      const sorted = this._sortedDarkSubBeatKeys();
      if (sorted.length >= 2) {
        const firstKey = sorted[0]!;
        const lastKey = sorted[sorted.length - 1]!;
        if (key === lastKey) {
          this._dragging = true;
          this._anchorSubBeatKey = firstKey;
          this._updateSubBeatDrag(key);
          return;
        }
        if (key === firstKey) {
          this._dragging = true;
          this._anchorSubBeatKey = lastKey;
          this._updateSubBeatDrag(key);
          return;
        }
      }
    }

    this._clearAllHighlights();
    this._dragging = true;
    this._anchorSubBeatKey = key;
    this._updateSubBeatDrag(key);
  }

  private _updateSubBeatDrag(currentKey: number): void {
    if (this._anchorSubBeatKey === null) return;
    const range = numericKeyRange(
      this._anchorSubBeatKey,
      currentKey,
      this._orderedSubBeatKeys,
    );

    this._clearDark();
    for (const k of range) {
      const entry = this._layer.subBeatIndex.get(k);
      if (entry) {
        addClass(entry.el, 'dark');
        this._darkGhosts.add(entry.el);
      }
    }
  }

  private _commitSubBeatDrag(): void {
    if (this._anchorSubBeatKey === null) return;

    const entries: SubBeatGhostEntry[] = [];
    for (const el of this._darkGhosts) {
      const key = ghostDataKey(el);
      if (key !== null) {
        const numKey = parseInt(key, 10);
        if (!isNaN(numKey)) {
          const entry = this._layer.subBeatIndex.get(numKey);
          if (entry) entries.push(entry);
        }
      }
    }
    if (entries.length === 0) return;

    entries.sort((a, b) => a.encodedKey - b.encodedKey);
    const first = entries[0]!;
    const last = entries[entries.length - 1]!;

    const barNs = entries.map(e => e.barN);
    const barStart = Math.min(...barNs);
    const barEnd = Math.max(...barNs);

    // Estimate the sub-beat step size from adjacent entries; fall back to 0.5.
    let subBeatStep = 0.5;
    if (entries.length >= 2) {
      subBeatStep = last.beatFloat - entries[entries.length - 2]!.beatFloat;
    }
    const beatEnd = last.beatFloat + subBeatStep;

    this._clearDark();
    for (const entry of entries) {
      addClass(entry.el, 'dark');
      this._darkGhosts.add(entry.el);
    }

    let repeatContext: SelectionRange['repeatContext'] = null;
    for (const entry of entries) {
      if (entry.endingN !== null) {
        repeatContext = repeatContextFromEndingN(entry.endingN);
        break;
      }
    }

    this._selection = {
      barStart,
      barEnd,
      beatStart: first.beatFloat,
      beatEnd,
      repeatContext,
    };

    this._setFlag('fragmentSet', true);
    this._onSelectionChange?.(this._selection);
  }

  // ── Private: commit / cancel ───────────────────────────────────────────────

  private _commitDrag(): void {
    this._dragging = false;

    if (this._resolution === 'measure') {
      this._commitMeasureDrag();
    } else if (this._resolution === 'beat') {
      this._commitBeatDrag();
    } else {
      this._commitSubBeatDrag();
    }

    this._anchorMeasureKey = null;
    this._anchorBeatKey = null;
    this._anchorSubBeatKey = null;
  }

  private _cancelDrag(): void {
    const wasDragging = this._dragging;
    this._dragging = false;
    this._anchorMeasureKey = null;
    this._anchorBeatKey = null;
    this._anchorSubBeatKey = null;
    if (wasDragging) this._clearDark();
  }

  // ── Private: highlight management ─────────────────────────────────────────

  private _clearLight(): void {
    for (const el of this._litGhosts) removeClass(el, 'light');
    this._litGhosts.clear();
  }

  private _clearDark(): void {
    for (const el of this._darkGhosts) removeClass(el, 'dark');
    this._darkGhosts.clear();
  }

  private _clearAllHighlights(): void {
    this._clearLight();
    this._clearDark();
  }

  // ── Private: utilities ────────────────────────────────────────────────────

  private _sortedDarkBeatKeys(): number[] {
    const keys: number[] = [];
    for (const el of this._darkGhosts) {
      const key = ghostDataKey(el);
      if (key !== null) {
        const numKey = parseInt(key, 10);
        if (!isNaN(numKey) && this._layer.beatIndex.has(numKey)) {
          keys.push(numKey);
        }
      }
    }
    return keys.sort((a, b) => a - b);
  }

  private _sortedDarkSubBeatKeys(): number[] {
    const keys: number[] = [];
    for (const el of this._darkGhosts) {
      const key = ghostDataKey(el);
      if (key !== null) {
        const numKey = parseInt(key, 10);
        if (!isNaN(numKey) && this._layer.subBeatIndex.has(numKey)) {
          keys.push(numKey);
        }
      }
    }
    return keys.sort((a, b) => a - b);
  }
}
