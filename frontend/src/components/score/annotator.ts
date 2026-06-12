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
 * Selection constraints (tagging-tool-design.md §6A.2, ADR-025):
 *  - Repeat barlines are NOT selection boundaries; drags cross them freely.
 *  - Da capo / dal segno markers are hard gates: the selection clamps at the
 *    marker measure and cannot extend past it (buildDirectiveBarriers).
 *  - Sibling volta endings are hard gates with effective-range exclusion:
 *    a selection never has endpoints in two sibling endings, never extends a
 *    non-final-ending anchor past its group, and skips excluded sibling
 *    endings it spans (computeSelectionKeys, §6A.3).
 *  - repeat_context derives from the effective range (deriveRepeatContext).
 *  - Endpoint re-selection: clicking the first or last ghost of a committed
 *    selection re-anchors the drag from the opposite end.
 *
 * References: prototype-tagging-tool.md, tagging-tool-design.md §§2, 6A,
 * ADR-005, ADR-011 §2, ADR-025.
 */

import type {
  BeatGhostEntry,
  GhostBounds,
  GhostLayer,
  MeasureGhostEntry,
  ResolutionMode,
  SubBeatGhostEntry,
} from './ghosts';
import { walkMeasureKeys } from './ghosts';

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
  /**
   * Component 9 Step 3 (§6A.1) — the committed effective range as the ordered
   * list of physical-measure ghost keys, excluded sibling endings omitted.
   * This is the single source of truth every derived surface (bracket
   * geometry, mc coordinates, stage frame) consumes; barStart/barEnd above are
   * display projections of it. Optional only because restore paths (stored
   * fragments) may reconstruct it from the human coordinates + repeatContext.
   */
  measureKeys?: string[];
}

export interface AnnotationSessionOptions {
  /**
   * Measure ghost keys carrying a da capo / dal segno directive. The selection
   * may include a barrier measure but cannot extend past it (§6A.2, ADR-025 —
   * repeat barlines are NOT barriers and must not be included here).
   * Build with buildDirectiveBarriers().
   */
  barrierMeasures?: Set<string>;
  /**
   * Volta group index for the ending gates and effective-range exclusions
   * (§6A.3). Build with buildVoltaIndex(meiText). When omitted, a fallback is
   * derived from the ghost layer (voltaIndexFromLayer) — correct for the gate
   * rules, but with unknown jump targets, so wholly-contained groups always
   * take the conservative row-4 path.
   */
  voltaIndex?: VoltaIndex;
  /** Initial resolution mode. Defaults to 'measure'. */
  resolution?: ResolutionMode;
  /**
   * G1.3 — committed selection to re-project after a ghost-layer rebuild
   * (zoom / resize / font change). The ghost elements are re-highlighted from
   * the logical coordinates so endpoint re-anchor continues to work after the
   * SVG geometry changes. Requires `resolution` to be set to the active mode.
   */
  initialSelection?: SelectionRange;
  /**
   * G1.3 — non-geometry flags to restore alongside `initialSelection`.
   * `fragmentSet` is derived automatically from `initialSelection`; do not
   * include it here.
   */
  initialFlags?: {
    conceptSet?: boolean;
    stagesComplete?: boolean;
    propertiesComplete?: boolean;
  };
  /**
   * Component 7 Step 3 — minimum bar range derived from confirmed stage bounds
   * (computeResizeClamp).  When set, the main-bracket drag is hard-clamped so
   * the selection barStart cannot rise above minBarStart and barEnd cannot fall
   * below maxBarEnd.  Update dynamically via setMinBarRange() when stage
   * assignments change.
   */
  minBarRange?: { minBarStart: number; maxBarEnd: number } | null;
}

// ---------------------------------------------------------------------------
// MEI barrier and volta parsing (ADR-025, tagging-tool-design.md §6A.2–6A.3)
// ---------------------------------------------------------------------------

/**
 * Parse a normalised MEI document and return the set of measure ghost keys
 * that act as hard selection barriers: measures carrying a da capo or dal
 * segno directive. At those markers the jump always fires — there is no final
 * pass that proceeds directly into the following bar — so a selection may end
 * on the marker measure but cannot extend past it (§6A.2).
 *
 * Repeat barlines (rptend/rptboth/rptstart) are deliberately NOT barriers:
 * ADR-025 removed the repeat-end gate rather than mirroring it. "To Coda" and
 * "Fine" marks are not gates either.
 *
 * Keys come from walkMeasureKeys(), the same derivation buildGhosts() uses,
 * so barrier keys always match measureIndex keys (G2.3, §6A.1).
 */
export function buildDirectiveBarriers(meiText: string): Set<string> {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');
  const barriers = new Set<string>();

  for (const info of walkMeasureKeys(doc)) {
    const dirs = info.el.getElementsByTagName('dir');
    for (let j = 0; j < dirs.length; j++) {
      const text = dirs[j]?.textContent ?? '';
      if (
        text.includes('D.C.') ||
        text.includes('D.S.') ||
        text.includes('da capo') ||
        text.includes('dal segno')
      ) {
        barriers.add(info.key);
        break;
      }
    }
  }

  return barriers;
}

/** One volta group: a contiguous run of <ending> measures (§6A.3). */
export interface VoltaGroupInfo {
  /** Ordered measure ghost keys per ending number. */
  endings: Map<number, string[]>;
  /** Ordered keys of every measure in the group (document order). */
  allKeys: string[];
  /** Highest ending number — the final (continuation) ending. */
  finalN: number;
  /**
   * Ghost key of the repeat-start measure the group's repeat jumps back to
   * (the measure with @left="rptstart", or the one after @right="rptboth"/
   * "rptstart"; the first measure of the piece when no repeat-start exists).
   * Null when unknown (layer-derived index) — treated as outside any
   * selection, i.e. the conservative §6A.3 row-4 reading.
   */
  jumpTargetKey: string | null;
}

/** Volta lookup structure consumed by computeSelectionKeys(). */
export interface VoltaIndex {
  /** Measure ghost key → owning group index + ending number. */
  byKey: Map<string, { groupIdx: number; endingN: number }>;
  groups: VoltaGroupInfo[];
}

/**
 * Parse a normalised MEI document into a VoltaIndex: volta groups (contiguous
 * runs of measures inside <ending> elements), their ending membership, and
 * each group's repeat-start jump target.
 */
export function buildVoltaIndex(meiText: string): VoltaIndex {
  const doc = new DOMParser().parseFromString(meiText, 'text/xml');
  const byKey = new Map<string, { groupIdx: number; endingN: number }>();
  const groups: VoltaGroupInfo[] = [];

  const infos = walkMeasureKeys(doc);
  let current: VoltaGroupInfo | null = null;
  // Jump target of the open repeat in force; defaults to the piece start.
  let jumpTargetKey: string | null = infos[0]?.key ?? null;
  let nextIsJumpTarget = false;

  for (const info of infos) {
    if (nextIsJumpTarget) {
      jumpTargetKey = info.key;
      nextIsJumpTarget = false;
    }
    if (info.el.getAttribute('left') === 'rptstart') {
      jumpTargetKey = info.key;
    }
    const right = info.el.getAttribute('right');
    if (right === 'rptboth' || right === 'rptstart') {
      nextIsJumpTarget = true;
    }

    if (info.endingN === null) {
      current = null;
      continue;
    }

    if (current === null) {
      current = {
        endings: new Map(),
        allKeys: [],
        finalN: info.endingN,
        jumpTargetKey,
      };
      groups.push(current);
    }

    const groupIdx = groups.length - 1;
    current.allKeys.push(info.key);
    current.finalN = Math.max(current.finalN, info.endingN);
    const list = current.endings.get(info.endingN) ?? [];
    list.push(info.key);
    current.endings.set(info.endingN, list);
    byKey.set(info.key, { groupIdx, endingN: info.endingN });
  }

  return { byKey, groups };
}

/**
 * Derive a VoltaIndex from an already-built ghost layer's measure index.
 *
 * Fallback used when the AnnotationSession is constructed without an
 * MEI-derived index (tests, callers without the MEI text). Groups are runs of
 * consecutive ending-bearing entries, split when the ending number resets;
 * jump targets are unknown (null), which makes wholly-contained groups take
 * the conservative §6A.3 row-4 path (non-final endings excluded).
 */
export function voltaIndexFromLayer(
  measureIndex: Map<string, MeasureGhostEntry>,
): VoltaIndex {
  const byKey = new Map<string, { groupIdx: number; endingN: number }>();
  const groups: VoltaGroupInfo[] = [];
  let current: VoltaGroupInfo | null = null;
  let prevEndingN: number | null = null;

  for (const entry of measureIndex.values()) {
    if (entry.endingN === null) {
      current = null;
      prevEndingN = null;
      continue;
    }
    if (current === null || (prevEndingN !== null && entry.endingN < prevEndingN)) {
      current = { endings: new Map(), allKeys: [], finalN: entry.endingN, jumpTargetKey: null };
      groups.push(current);
    }
    const groupIdx = groups.length - 1;
    current.allKeys.push(entry.key);
    current.finalN = Math.max(current.finalN, entry.endingN);
    const list = current.endings.get(entry.endingN) ?? [];
    list.push(entry.key);
    current.endings.set(entry.endingN, list);
    byKey.set(entry.key, { groupIdx, endingN: entry.endingN });
    prevEndingN = entry.endingN;
  }

  return { byKey, groups };
}

// ---------------------------------------------------------------------------
// Ghost identification helpers
// ---------------------------------------------------------------------------

/**
 * Find the nearest .ghost ancestor from a mouse event target.
 * Returns null when the target is not within any ghost.
 */
export function ghostFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const el = target.closest('.ghost');
  return el instanceof HTMLElement ? el : null;
}

/**
 * Return the .ghost-handle element from a mouse event target, or null.
 * Handle ghosts are direct siblings of the selection layers in the overlay;
 * they carry data-handle="left"|"right" and class .ghost-handle but NOT .ghost,
 * so ghostFromTarget correctly returns null for them.
 */
export function handleFromTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  const el = target.closest('.ghost-handle');
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
 * Clamping is symmetric (G2.1):
 * - Forward drag (anchor ≤ current): the selection may include the barrier
 *   measure but cannot extend past its right barline into later measures.
 * - Backward drag (anchor > current): the barrier's right barline blocks
 *   passage in both directions; the selection is confined to measures on the
 *   anchor's side of the barrier (barrier+1 … anchor).
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

  if (anchorIdx <= currentIdx) {
    // Forward drag: clamp at the first barrier from anchor toward current.
    let endIdx = currentIdx;
    for (let i = anchorIdx; i < endIdx; i++) {
      if (barriers.has(orderedKeys[i]!)) {
        endIdx = i;
        break;
      }
    }
    return orderedKeys.slice(anchorIdx, endIdx + 1);
  } else {
    // Backward drag: clamp at the first barrier between anchor and current
    // (scanning from anchor-1 toward current). The selection stays on the
    // anchor's side of the barrier — never resets to the opposite side.
    let startIdx = currentIdx;
    for (let i = anchorIdx - 1; i >= startIdx; i--) {
      if (barriers.has(orderedKeys[i]!)) {
        startIdx = i + 1;
        break;
      }
    }
    return orderedKeys.slice(startIdx, anchorIdx + 1);
  }
}

/**
 * Compute the effective selection key list between anchor and current
 * (tagging-tool-design.md §6A.2–6A.3, ADR-025).
 *
 * Three layers, applied in order:
 *  1. D.C./D.S. barrier clamp — measureKeyRange() semantics: the drag cannot
 *     pass a directive barrier in either direction.
 *  2. Volta gate clamp — when the interval (anchor, current) is invalid
 *     (endpoints in sibling endings, or a non-final-ending endpoint with the
 *     other endpoint past the group's end), the moving end retreats toward the
 *     anchor until the interval is legal. The clamp is position-by-position,
 *     so a drag that passes *through* an illegal region (e.g. backward from
 *     ending 2 across ending 1 into the body) becomes legal again once the
 *     moving end leaves the sibling ending.
 *  3. Effective-range exclusion — sibling endings the legal interval spans
 *     but cannot perform are filtered out (§6A.3 rows 2 and 4); a wholly
 *     contained group keeps all endings only when its repeat-start jump
 *     target lies inside the interval (row 3).
 *
 * The result is ordered in document order and may be discontiguous in
 * document-order terms (gaps over excluded endings).
 */
export function computeSelectionKeys(
  anchorKey: string,
  currentKey: string,
  orderedKeys: string[],
  barriers: Set<string>,
  volta: VoltaIndex | null,
): string[] {
  const anchorIdx = orderedKeys.indexOf(anchorKey);
  if (anchorIdx === -1) return [];

  // 1. Directive barrier clamp (also handles currentKey not in orderedKeys).
  const clamped = measureKeyRange(anchorKey, currentKey, orderedKeys, barriers);
  if (clamped.length === 0) return [];
  let lo = orderedKeys.indexOf(clamped[0]!);
  let hi = orderedKeys.indexOf(clamped[clamped.length - 1]!);

  if (!volta || volta.groups.length === 0) {
    return orderedKeys.slice(lo, hi + 1);
  }

  const pos = new Map<string, number>();
  orderedKeys.forEach((k, i) => pos.set(k, i));

  /** Endpoint's volta context iff it belongs to the given group. */
  const endpointIn = (idx: number, groupIdx: number) => {
    const ctx = volta.byKey.get(orderedKeys[idx]!);
    return ctx && ctx.groupIdx === groupIdx ? ctx : null;
  };

  const isLegal = (loIdx: number, hiIdx: number): boolean => {
    for (let gi = 0; gi < volta.groups.length; gi++) {
      const g = volta.groups[gi]!;
      const gLo = pos.get(g.allKeys[0]!);
      const gHi = pos.get(g.allKeys[g.allKeys.length - 1]!);
      if (gLo === undefined || gHi === undefined) continue;
      if (gHi < loIdx || gLo > hiIdx) continue;

      const loIn = endpointIn(loIdx, gi);
      const hiIn = endpointIn(hiIdx, gi);
      // Endpoints in two sibling endings: never performable.
      if (loIn && hiIn && loIn.endingN !== hiIn.endingN) return false;
      // Starts inside a non-final ending and extends past the group's end:
      // a non-final ending closes into the repeat jump, never the continuation.
      if (loIn && !hiIn && hiIdx > gHi && loIn.endingN !== g.finalN) return false;
    }
    return true;
  };

  // 2. Volta gate clamp: retreat the moving end toward the anchor until legal.
  // The anchor is always one end of the clamped interval; the other end moves.
  if (anchorIdx === lo) {
    while (hi > anchorIdx && !isLegal(lo, hi)) hi--;
  } else {
    while (lo < anchorIdx && !isLegal(lo, hi)) lo++;
  }

  // 3. Effective-range exclusion of unreachable sibling endings.
  const excluded = new Set<string>();
  for (let gi = 0; gi < volta.groups.length; gi++) {
    const g = volta.groups[gi]!;
    const gLo = pos.get(g.allKeys[0]!);
    const gHi = pos.get(g.allKeys[g.allKeys.length - 1]!);
    if (gLo === undefined || gHi === undefined) continue;
    if (gHi < lo || gLo > hi) continue;

    const loIn = endpointIn(lo, gi);
    const hiIn = endpointIn(hi, gi);
    const endpointN = loIn?.endingN ?? hiIn?.endingN ?? null;

    if (endpointN !== null) {
      // Row 2: an endpoint fixes the performed ending; siblings are excluded.
      for (const [n, keys] of g.endings) {
        if (n === endpointN) continue;
        for (const k of keys) {
          const p = pos.get(k);
          if (p !== undefined && p >= lo && p <= hi) excluded.add(k);
        }
      }
    } else {
      // Group wholly contained. Row 3 (jump target inside: all endings
      // performable) vs row 4 (jump target outside: non-final endings
      // unreachable from within the fragment).
      const jtPos = g.jumpTargetKey !== null ? pos.get(g.jumpTargetKey) : undefined;
      const jumpInside = jtPos !== undefined && jtPos >= lo && jtPos <= hi;
      if (!jumpInside) {
        for (const [n, keys] of g.endings) {
          if (n === g.finalN) continue;
          for (const k of keys) {
            const p = pos.get(k);
            if (p !== undefined && p >= lo && p <= hi) excluded.add(k);
          }
        }
      }
    }
  }

  const slice = orderedKeys.slice(lo, hi + 1);
  return excluded.size === 0 ? slice : slice.filter(k => !excluded.has(k));
}

/**
 * Derive repeat_context from an effective key list (§6A.3).
 *
 * The first volta group represented by exactly one ending number decides the
 * context (row 2 / row 4); a group represented by two or more endings is the
 * fully-performable row-3 shape and contributes null. No ending measures →
 * null.
 */
export function deriveRepeatContext(
  selectedKeys: readonly string[],
  volta: VoltaIndex | null,
): SelectionRange['repeatContext'] {
  if (!volta) return null;

  const present = new Map<number, Set<number>>();
  for (const k of selectedKeys) {
    const ctx = volta.byKey.get(k);
    if (!ctx) continue;
    const set = present.get(ctx.groupIdx) ?? new Set<number>();
    set.add(ctx.endingN);
    present.set(ctx.groupIdx, set);
  }

  for (const ns of present.values()) {
    if (ns.size === 1) {
      const n = [...ns][0]!;
      return n === 1 ? 'first_ending' : 'second_ending';
    }
  }
  return null;
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
// AnnotationSession
// ---------------------------------------------------------------------------

/**
 * Manages a single annotation session: ghost-layer interaction, concurrent
 * flags, and the committed selection range.
 *
 * Selection boundaries follow §6A.2/§6A.3: D.C./D.S. directive barriers clamp
 * the drag; volta gates and effective-range exclusions are applied by
 * computeSelectionKeys() from the volta index (caller-supplied or derived
 * from the ghost layer).
 *
 * Lifecycle: construct after buildGhosts() resolves; call destroy() before
 * the score re-renders or the ghost layer is destroyed.
 */
export class AnnotationSession {
  private readonly _layer: GhostLayer;
  private readonly _barriers: Set<string>;
  private readonly _volta: VoltaIndex;

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

  // True once positionHandles() has been called with valid coordinates so that
  // _handleMouseOver knows it is safe to call showHandles() on hover.
  private _handlesReady = false;

  /**
   * Component 7 Step 3 — hard-clamp derived from confirmed stage bounds.
   * Null when no confirmed stages exist (no minimum enforced).
   * The selection barStart must stay ≤ minBarStart; barEnd must stay ≥ maxBarEnd.
   * Set/updated via setMinBarRange(); the lock fires during live handle drags.
   */
  private _minBarRange: { minBarStart: number; maxBarEnd: number } | null = null;

  /**
   * Component 7 Step 5 — modal lock while a stage split-handle drag is active.
   * When true, the main-ghost hover handler does not show the handle affordance
   * (the handles sit right next to stage brackets and the affordance is
   * distracting mid-stage-drag). Re-enabled the instant the stage drag ends.
   */
  private _stageDragActive = false;

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

    // §6A.2: the barrier set is D.C./D.S. directives only (ADR-025 — no
    // repeat-barline gates). Volta ending gates and exclusions are handled by
    // computeSelectionKeys() from the volta index, not by barrier clamping.
    this._barriers = options.barrierMeasures ?? new Set<string>();
    this._volta = options.voltaIndex ?? voltaIndexFromLayer(layer.measureIndex);

    this._resolution = options.resolution ?? 'measure';
    this._minBarRange = options.minBarRange ?? null;

    this._orderedMeasureKeys = [...layer.measureIndex.keys()];
    this._orderedBeatKeys = [...layer.beatIndex.keys()].sort((a, b) => a - b);
    this._orderedSubBeatKeys = [...layer.subBeatIndex.keys()].sort((a, b) => a - b);

    // Activate the initial resolution layer.
    this._layer.setResolution(this._resolution);
    this._attachListeners();

    // G1.3: re-project a committed selection from a previous ghost build.
    // Called after _attachListeners so the DOM elements are live, but before
    // any subscriber callbacks are registered — the restoring code sets state
    // directly without firing onSelectionChange/onFlagsChange.
    if (options.initialSelection) {
      this._restoreSelection(options.initialSelection);
    }
    if (options.initialFlags) {
      const { conceptSet, stagesComplete, propertiesComplete } = options.initialFlags;
      if (conceptSet !== undefined)        this._flags = { ...this._flags, conceptSet };
      if (stagesComplete !== undefined)    this._flags = { ...this._flags, stagesComplete };
      if (propertiesComplete !== undefined) this._flags = { ...this._flags, propertiesComplete };
    }
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
   * (which flips pointer-events). Any in-progress drag is cancelled without
   * firing callbacks. If a selection is committed, it is preserved: dark ghosts
   * are re-projected onto the new resolution's layer so handle drags work
   * correctly at the new granularity (the handle re-anchor paths rely on
   * _darkGhosts containing elements from the active resolution index). Ghost
   * construction is NOT re-run (ADR-005 §"Resolution toggle").
   */
  setResolution(mode: ResolutionMode): void {
    if (mode === this._resolution) return;
    this._resolution = mode;
    this._layer.setResolution(mode);
    this._cancelDrag();
    if (this._flags.fragmentSet && this._selection) {
      this._clearDark();
      this._reprojectSelection();
      this._updateHandleGhosts();
    }
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

  /**
   * Component 7 Step 3 — update the hard-clamp for the main-bracket drag.
   *
   * Pass the result of computeResizeClamp(stageAssignments) here whenever
   * confirmed stage bounds change.  While a drag is in progress the new
   * range takes effect on the next mouseover tick.  Passing null removes the
   * clamp (e.g. when all stages are unconfirmed).
   */
  setMinBarRange(range: { minBarStart: number; maxBarEnd: number } | null): void {
    this._minBarRange = range;
  }

  /**
   * Component 7 Step 5 — notify the session that a stage split-handle drag is
   * starting (active=true) or has ended (active=false).
   *
   * While active, the main-ghost hover handler suppresses its handle-show
   * affordance so the handles do not flicker while the cursor passes over
   * the main ghost during a stage resize. Re-enabling (active=false) restores
   * the affordance immediately on the next mouseover tick.
   */
  setStageDragActive(active: boolean): void {
    this._stageDragActive = active;
    if (!active) {
      // Eagerly hide handles — they will be re-shown on the next valid hover
      // rather than appearing abruptly at the cursor's current position.
      this._layer.hideHandles();
    }
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

  /**
   * Full session reset: clear the committed selection, all four concurrent
   * flags, drag state, and visual highlights. Event listeners are preserved —
   * the session stays live and ready for a new selection after reset.
   *
   * This is the single reset path after fragmentSet becomes true. There is no
   * partial "clear selection only". See tagging-tool-design.md §6.
   */
  reset(): void {
    this._cancelDrag();
    this._clearAllHighlights();
    this._handlesReady = false;
    this._layer.deactivateHandles();
    this._selection = null;
    const anySet =
      this._flags.fragmentSet ||
      this._flags.conceptSet ||
      this._flags.stagesComplete ||
      this._flags.propertiesComplete;
    this._flags = {
      fragmentSet: false,
      conceptSet: false,
      stagesComplete: false,
      propertiesComplete: false,
    };
    if (anySet) this._onFlagsChange?.(this.flags);
    this._onSelectionChange?.(null);
  }

  // ── Private: flag management ──────────────────────────────────────────────

  private _setFlag(key: keyof AnnotationFlags, value: boolean): void {
    if (this._flags[key] === value) return;
    this._flags = { ...this._flags, [key]: value };
    this._onFlagsChange?.(this.flags);
  }

  // ── Private: G1.3 re-projection ───────────────────────────────────────────

  /**
   * Resolve a SelectionRange to its effective measure-key list (§6A.1).
   *
   * Uses sel.measureKeys when present (commit and G1.3 reproject paths).
   * Otherwise reconstructs it from the human coordinates: bar range filtered
   * by the repeat_context exclusion (a 'first_ending'/'second_ending' context
   * excludes the sibling endings; null keeps everything — §6A.3 rows 1/3).
   */
  private _effectiveKeysFor(sel: SelectionRange): string[] {
    if (sel.measureKeys && sel.measureKeys.length > 0) return sel.measureKeys;
    return this._orderedMeasureKeys.filter(k => {
      const e = this._layer.measureIndex.get(k);
      if (!e) return false;
      if (!(e.barN >= sel.barStart && e.barN <= sel.barEnd)) return false;
      if (e.endingN !== null) {
        if (sel.repeatContext === 'first_ending' && e.endingN !== 1) return false;
        if (sel.repeatContext === 'second_ending' && e.endingN === 1) return false;
      }
      return true;
    });
  }

  /**
   * Highlight the ghosts of a selection on the active resolution layer.
   *
   * Measure level uses the effective key list directly. Beat/sub-beat levels
   * include entries whose parent measure key is in the effective set, with
   * the beat-precision constraints applied only to the first and last
   * measure of the selection (by key, not by barN — duplicate @n values must
   * not truncate middle bars).
   */
  private _highlightSelection(sel: SelectionRange): void {
    const keys = this._effectiveKeysFor(sel);
    if (keys.length === 0) return;

    if (this._resolution === 'measure') {
      for (const k of keys) {
        const entry = this._layer.measureIndex.get(k);
        if (entry) {
          addClass(entry.el, 'dark');
          this._darkGhosts.add(entry.el);
        }
      }
      return;
    }

    const keySet = new Set(keys);
    const firstKey  = keys[0]!;
    const lastKey   = keys[keys.length - 1]!;
    const beatStart = sel.beatStart;
    const beatEnd   = sel.beatEnd;
    const index =
      this._resolution === 'beat' ? this._layer.beatIndex : this._layer.subBeatIndex;

    for (const entry of index.values()) {
      if (!keySet.has(entry.measureKey)) continue;
      if (
        beatStart !== null &&
        entry.measureKey === firstKey &&
        entry.beatFloat < beatStart
      ) continue;
      if (
        beatEnd !== null &&
        entry.measureKey === lastKey &&
        entry.beatFloat >= beatEnd
      ) continue;
      addClass(entry.el, 'dark');
      this._darkGhosts.add(entry.el);
    }
  }

  /**
   * Re-project a committed SelectionRange onto the freshly rebuilt ghost layer.
   *
   * Called from the constructor when `options.initialSelection` is provided
   * (SVG re-render path: zoom / resize / font change; edit flow for stored
   * fragments). Sets _selection (with the effective key list materialised)
   * and re-highlights the matching ghosts as dark so endpoint re-anchor (G1.2)
   * continues to work after the geometry change.
   *
   * Callbacks are NOT fired — the React state in ScoreViewer already holds
   * the preserved selection and flags, so there is nothing to notify.
   */
  private _restoreSelection(sel: SelectionRange): void {
    const keys = this._effectiveKeysFor(sel);
    this._selection = { ...sel, measureKeys: keys };
    this._highlightSelection(this._selection);
    this._flags = { ...this._flags, fragmentSet: true };
    this._updateHandleGhosts();
  }

  /**
   * Re-project the committed selection onto the current resolution's ghost
   * layer. Called from setResolution() when fragmentSet is true so that the
   * handle re-anchor paths (_startHandleDrag, _sortedDark*Keys) always find
   * elements from the active resolution index in _darkGhosts. Does NOT modify
   * _selection or _flags (§6A.1 I3 — resolution changes never mutate
   * committed state).
   */
  private _reprojectSelection(): void {
    if (!this._selection) return;
    this._highlightSelection(this._selection);
  }

  // ── Private: min-bar-range clamp helpers (Component 7 Step 3) ───────────

  /**
   * Given a target measureKey being dragged toward, return the clamped key
   * that respects _minBarRange.
   *
   * For a shrink-from-the-left drag (anchor is the rightmost key): the
   * resulting barStart must stay ≤ minBarStart, so the current key cannot
   * move to a barN > minBarStart.
   *
   * For a shrink-from-the-right drag (anchor is the leftmost key): the
   * resulting barEnd must stay ≥ maxBarEnd, so the current key cannot move
   * to a barN < maxBarEnd.
   */
  private _clampMeasureKey(currentKey: string, anchorKey: string): string {
    if (!this._minBarRange) return currentKey;

    const { minBarStart, maxBarEnd } = this._minBarRange;
    const anchorEntry  = this._layer.measureIndex.get(anchorKey);
    const currentEntry = this._layer.measureIndex.get(currentKey);
    if (!anchorEntry || !currentEntry) return currentKey;

    // Dragging left (shrinking from the left): anchor is to the right.
    if (currentEntry.barN < anchorEntry.barN) {
      if (currentEntry.barN > minBarStart) {
        // Clamp: find the key with barN = minBarStart.
        for (const [k, e] of this._layer.measureIndex) {
          if (e.barN === minBarStart) return k;
        }
      }
      return currentKey;
    }

    // Dragging right (shrinking from the right): anchor is to the left.
    if (currentEntry.barN > anchorEntry.barN) {
      if (currentEntry.barN < maxBarEnd) {
        // Clamp: find the key with barN = maxBarEnd.
        for (const [k, e] of this._layer.measureIndex) {
          if (e.barN === maxBarEnd) return k;
        }
      }
      return currentKey;
    }

    return currentKey;
  }

  /**
   * Clamp a beat/sub-beat key to respect _minBarRange.
   * Uses the numeric key index to resolve bar membership.
   */
  private _clampBeatKey(
    currentKey: number,
    anchorKey: number,
    index: Map<number, { barN: number }>,
  ): number {
    if (!this._minBarRange) return currentKey;

    const { minBarStart, maxBarEnd } = this._minBarRange;
    const anchorEntry  = index.get(anchorKey);
    const currentEntry = index.get(currentKey);
    if (!anchorEntry || !currentEntry) return currentKey;

    // Dragging left (anchor barN > current barN): clamp barStart ≤ minBarStart.
    if (currentEntry.barN < anchorEntry.barN && currentEntry.barN > minBarStart) {
      // Find the numerically smallest key whose barN === minBarStart.
      let bestKey: number | null = null;
      for (const [k, e] of index) {
        if (e.barN === minBarStart && (bestKey === null || k < bestKey)) bestKey = k;
      }
      if (bestKey !== null) return bestKey;
    }

    // Dragging right (anchor barN < current barN): clamp barEnd ≥ maxBarEnd.
    if (currentEntry.barN > anchorEntry.barN && currentEntry.barN < maxBarEnd) {
      // Find the numerically largest key whose barN === maxBarEnd.
      let bestKey: number | null = null;
      for (const [k, e] of index) {
        if (e.barN === maxBarEnd && (bestKey === null || k > bestKey)) bestKey = k;
      }
      if (bestKey !== null) return bestKey;
    }

    return currentKey;
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

    // Handle ghost click: endpoint re-anchor from outside the selection boundary.
    // Must be checked before ghostFromTarget — handle ghosts have class .ghost-handle,
    // not .ghost, so ghostFromTarget would incorrectly return null for them.
    const handle = handleFromTarget(e.target);
    if (handle) {
      e.preventDefault();
      this._startHandleDrag(handle);
      return;
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
      // Light hover is only meaningful before a selection is committed.
      // Once fragmentSet is true, clicking a non-dark ghost does nothing, so
      // showing the hover affordance would imply an incorrect interaction model.
      if (!this._flags.fragmentSet) {
        if (ghost !== this._hoverGhost) {
          if (this._hoverGhost) removeClass(this._hoverGhost, 'light');
          this._hoverGhost = ghost;
          if (ghost) addClass(ghost, 'light');
        }
      }
      // Handles are hover-only: show when over a dark ghost or a handle element;
      // hide otherwise so they don't clutter a non-hovered committed selection.
      // Step 5: suppress during an active stage split-handle drag — the cursor
      // frequently crosses the main ghost mid-drag and the affordance is distracting.
      if (this._handlesReady && !this._stageDragActive) {
        const overDark = ghost !== null && this._darkGhosts.has(ghost);
        const overHandle = handleFromTarget(e.target) !== null;
        if (overDark || overHandle) {
          this._layer.showHandles();
        } else {
          this._layer.hideHandles();
        }
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
    this._layer.hideHandles();
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

    // A fragment is already committed — only endpoint re-anchor (above) is
    // permitted. Fresh selection requires the Delete control. §6.
    if (this._flags.fragmentSet) return;

    this._clearAllHighlights();
    this._dragging = true;
    this._anchorMeasureKey = key;
    this._updateMeasureDrag(key);
  }

  private _updateMeasureDrag(currentKey: string): void {
    if (!this._anchorMeasureKey) return;

    // Component 7 Step 3: hard-clamp the drag so confirmed stage bounds
    // are never forced outside the resulting selection.
    const effectiveKey = this._clampMeasureKey(currentKey, this._anchorMeasureKey);

    const range = computeSelectionKeys(
      this._anchorMeasureKey,
      effectiveKey,
      this._orderedMeasureKeys,
      this._barriers,
      this._volta,
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

    const measureKeys = entries.map(e => e.key);

    this._selection = {
      barStart: first.barN,
      barEnd: last.barN,
      beatStart: null,
      beatEnd: null,
      repeatContext: deriveRepeatContext(measureKeys, this._volta),
      measureKeys,
    };

    this._setFlag('fragmentSet', true);
    this._onSelectionChange?.(this._selection);
    this._updateHandleGhosts();
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

    if (this._flags.fragmentSet) return;

    this._clearAllHighlights();
    this._dragging = true;
    this._anchorBeatKey = key;
    this._updateBeatDrag(key);
  }

  private _updateBeatDrag(currentKey: number): void {
    if (this._anchorBeatKey === null) return;

    // Component 7 Step 3: clamp beat drag to the min-bar-range.
    const effectiveBeatKey = this._clampBeatKey(currentKey, this._anchorBeatKey, this._layer.beatIndex);

    // G2.3 / §6A.2: enforce measure-level boundaries at beat resolution —
    // directive barriers clamp, volta gates clamp, and excluded sibling
    // endings are filtered out of the reachable measure set, in all
    // resolution modes alike.
    //
    // Skip the filter when the measure index is unpopulated (empty ordered
    // list) or when the anchor's measureKey is not in the ordered list — that
    // signals a test fixture or a score where ghost building was not run, so
    // there is no boundary information to apply.
    const anchorEntry  = this._layer.beatIndex.get(this._anchorBeatKey);
    const currentEntry = this._layer.beatIndex.get(effectiveBeatKey);
    const allowedMeasureRange =
      anchorEntry && currentEntry && this._orderedMeasureKeys.length > 0
        ? computeSelectionKeys(
            anchorEntry.measureKey,
            currentEntry.measureKey,
            this._orderedMeasureKeys,
            this._barriers,
            this._volta,
          )
        : null;
    const allowedMeasureKeys: Set<string> | null =
      allowedMeasureRange !== null && allowedMeasureRange.length > 0
        ? new Set(allowedMeasureRange)
        : null;

    const range = numericKeyRange(
      this._anchorBeatKey,
      effectiveBeatKey,
      this._orderedBeatKeys,
    );

    this._clearDark();
    for (const k of range) {
      const entry = this._layer.beatIndex.get(k);
      if (!entry) continue;
      if (allowedMeasureKeys && !allowedMeasureKeys.has(entry.measureKey)) continue;
      addClass(entry.el, 'dark');
      this._darkGhosts.add(entry.el);
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

    // beat_end is the exclusive upper bound for onset-based inclusion: the
    // last entry's own end float (its grid step, or the measure's full extent
    // for a synthetic empty-measure ghost) — never estimated from neighbours.
    const beatEnd = last.endFloat;

    this._clearDark();
    for (const entry of entries) {
      addClass(entry.el, 'dark');
      this._darkGhosts.add(entry.el);
    }

    // Effective measure-key list in document order (entries are sorted by
    // encodedKey, which encodes render order).
    const measureKeys: string[] = [];
    for (const entry of entries) {
      if (measureKeys[measureKeys.length - 1] !== entry.measureKey) {
        measureKeys.push(entry.measureKey);
      }
    }

    this._selection = {
      barStart: first.barN,
      barEnd: last.barN,
      beatStart: first.beatFloat,
      beatEnd,
      repeatContext: deriveRepeatContext(measureKeys, this._volta),
      measureKeys,
    };

    this._setFlag('fragmentSet', true);
    this._onSelectionChange?.(this._selection);
    this._updateHandleGhosts();
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

    if (this._flags.fragmentSet) return;

    this._clearAllHighlights();
    this._dragging = true;
    this._anchorSubBeatKey = key;
    this._updateSubBeatDrag(key);
  }

  private _updateSubBeatDrag(currentKey: number): void {
    if (this._anchorSubBeatKey === null) return;

    // Component 7 Step 3: clamp sub-beat drag to the min-bar-range.
    const effectiveSubBeatKey = this._clampBeatKey(currentKey, this._anchorSubBeatKey, this._layer.subBeatIndex);

    // G2.3 / §6A.2: same boundary enforcement as beat resolution.
    const anchorEntry  = this._layer.subBeatIndex.get(this._anchorSubBeatKey);
    const currentEntry = this._layer.subBeatIndex.get(effectiveSubBeatKey);
    const allowedMeasureRange =
      anchorEntry && currentEntry && this._orderedMeasureKeys.length > 0
        ? computeSelectionKeys(
            anchorEntry.measureKey,
            currentEntry.measureKey,
            this._orderedMeasureKeys,
            this._barriers,
            this._volta,
          )
        : null;
    const allowedMeasureKeys: Set<string> | null =
      allowedMeasureRange !== null && allowedMeasureRange.length > 0
        ? new Set(allowedMeasureRange)
        : null;

    const range = numericKeyRange(
      this._anchorSubBeatKey,
      effectiveSubBeatKey,
      this._orderedSubBeatKeys,
    );

    this._clearDark();
    for (const k of range) {
      const entry = this._layer.subBeatIndex.get(k);
      if (!entry) continue;
      if (allowedMeasureKeys && !allowedMeasureKeys.has(entry.measureKey)) continue;
      addClass(entry.el, 'dark');
      this._darkGhosts.add(entry.el);
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

    // The last entry's own end float — exact at every endpoint (§6A.7).
    // The previous neighbour-difference estimate produced wrong (even
    // negative) steps when the last two entries sat in different beats or
    // measures (fixtures SEL-09/SEL-14).
    const beatEnd = last.endFloat;

    this._clearDark();
    for (const entry of entries) {
      addClass(entry.el, 'dark');
      this._darkGhosts.add(entry.el);
    }

    const measureKeys: string[] = [];
    for (const entry of entries) {
      if (measureKeys[measureKeys.length - 1] !== entry.measureKey) {
        measureKeys.push(entry.measureKey);
      }
    }

    this._selection = {
      barStart: first.barN,
      barEnd: last.barN,
      beatStart: first.beatFloat,
      beatEnd,
      repeatContext: deriveRepeatContext(measureKeys, this._volta),
      measureKeys,
    };

    this._setFlag('fragmentSet', true);
    this._onSelectionChange?.(this._selection);
    this._updateHandleGhosts();
  }

  // ── Private: handle ghost drag ────────────────────────────────────────────

  /**
   * Start an endpoint re-anchor drag initiated from a drag handle ghost (G3.1).
   *
   * The left handle re-anchors from the right end of the committed selection;
   * the right handle re-anchors from the left end. This is identical to the
   * in-ghost endpoint re-anchor path but does not require the mouse to be over
   * a selection ghost, so it works at any resolution even on narrow beat ghosts.
   */
  private _startHandleDrag(handle: HTMLElement): void {
    const side = handle.dataset['handle'] as 'left' | 'right' | undefined;
    if (side !== 'left' && side !== 'right') return;
    if (!this._flags.fragmentSet) return;

    this._layer.hideHandles();

    if (this._resolution === 'measure') {
      const darkMeasureKeys = this._orderedMeasureKeys.filter(k => {
        const entry = this._layer.measureIndex.get(k);
        return entry !== undefined && this._darkGhosts.has(entry.el);
      });
      if (darkMeasureKeys.length === 0) return;
      const firstKey = darkMeasureKeys[0]!;
      const lastKey = darkMeasureKeys[darkMeasureKeys.length - 1]!;
      this._dragging = true;
      if (side === 'left') {
        this._anchorMeasureKey = lastKey;
        this._updateMeasureDrag(firstKey);
      } else {
        this._anchorMeasureKey = firstKey;
        this._updateMeasureDrag(lastKey);
      }
    } else if (this._resolution === 'beat') {
      const sorted = this._sortedDarkBeatKeys();
      if (sorted.length === 0) return;
      this._dragging = true;
      if (side === 'left') {
        this._anchorBeatKey = sorted[sorted.length - 1]!;
        this._updateBeatDrag(sorted[0]!);
      } else {
        this._anchorBeatKey = sorted[0]!;
        this._updateBeatDrag(sorted[sorted.length - 1]!);
      }
    } else {
      const sorted = this._sortedDarkSubBeatKeys();
      if (sorted.length === 0) return;
      this._dragging = true;
      if (side === 'left') {
        this._anchorSubBeatKey = sorted[sorted.length - 1]!;
        this._updateSubBeatDrag(sorted[0]!);
      } else {
        this._anchorSubBeatKey = sorted[0]!;
        this._updateSubBeatDrag(sorted[sorted.length - 1]!);
      }
    }
  }

  /**
   * Compute handle positions from the first and last dark ghost in document
   * order and call GhostLayer.positionHandles(). The handles are NOT shown —
   * _handleMouseOver shows them when the user hovers over the selection.
   *
   * Using first/last in document order (not global min-left / max-right) places
   * each handle at the correct system edge for multi-system fragments instead of
   * at opposite page extremes. Reads bounds from index entries (not inline
   * styles) so it works in jsdom test fixtures.
   */
  private _updateHandleGhosts(): void {
    if (!this._flags.fragmentSet || this._darkGhosts.size === 0) {
      this._handlesReady = false;
      this._layer.deactivateHandles();
      return;
    }

    let firstBounds: GhostBounds | null = null;
    let lastBounds: GhostBounds | null = null;

    if (this._resolution === 'measure') {
      for (const k of this._orderedMeasureKeys) {
        const entry = this._layer.measureIndex.get(k);
        if (!entry || !this._darkGhosts.has(entry.el)) continue;
        if (!firstBounds) firstBounds = entry.bounds;
        lastBounds = entry.bounds;
      }
    } else if (this._resolution === 'beat') {
      for (const k of this._orderedBeatKeys) {
        const entry = this._layer.beatIndex.get(k);
        if (!entry || !this._darkGhosts.has(entry.el)) continue;
        if (!firstBounds) firstBounds = entry.bounds;
        lastBounds = entry.bounds;
      }
    } else {
      for (const k of this._orderedSubBeatKeys) {
        const entry = this._layer.subBeatIndex.get(k);
        if (!entry || !this._darkGhosts.has(entry.el)) continue;
        if (!firstBounds) firstBounds = entry.bounds;
        lastBounds = entry.bounds;
      }
    }

    if (!firstBounds || !lastBounds) {
      this._handlesReady = false;
      this._layer.deactivateHandles();
      return;
    }

    // Opacity must match the adjacent dark ghost so the gradient's solid end
    // blends seamlessly at the selection boundary.
    const handleOpacity = this._resolution === 'beat' ? 0.55 : 0.45;

    this._layer.positionHandles(
      firstBounds.left, firstBounds.top, firstBounds.height,
      lastBounds.left + lastBounds.width, lastBounds.top, lastBounds.height,
      handleOpacity,
    );
    this._handlesReady = true;
    // Handles are positioned at opacity 0 (interactive but invisible) —
    // showHandles() is called from _handleMouseOver when the user hovers
    // over a dark ghost or directly over a handle element.
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
