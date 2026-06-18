/**
 * In-score harmony chord label overlay — Component 7 Step 16 (G6.3).
 *
 * Renders movement_analysis events as absolutely-positioned HTML labels below
 * each system in the score. Labels are positioned by mapping each event's
 * (mn, volta, beat) to a pixel x-coordinate via the ghost beat spatial index,
 * exactly as documented in docs/architecture/harmony-score-overlay.md.
 *
 * This module is display-only. All event editing remains in HarmonyPanel.
 * Active only in tag mode — ScoreViewer gates construction.
 *
 * References:
 *   docs/architecture/harmony-score-overlay.md — full design spec
 *   docs/adr/ADR-005-sub-measure-precision.md  — beat float encoding
 */

import type { GhostLayer } from './ghosts';
import { encodeBeat, encodeSubBeat, measureGhostKey } from './ghosts';
import type { HarmonyEventOut } from '../../services/analysisApi';
import styles from './harmonyOverlay.module.css';

/** Vertical gap between the staff bottom and the harmony lane baseline (px). */
const LANE_OFFSET_PX = 6;

/**
 * Label font size at the smallest staff-size preset, and the Verovio scale that
 * preset maps to. Label font scales linearly with the staff size so labels stay
 * proportional to the engraving (12px at the "Small" preset, larger above it).
 */
const LABEL_FONT_BASE_PX = 12;
const LABEL_FONT_BASE_SCALE = 35;

/** Resolve the label font size (px) for a given Verovio staff-size scale. */
function labelFontPx(scale: number | undefined): number {
  if (!scale || scale <= 0) return LABEL_FONT_BASE_PX;
  return Math.round((LABEL_FONT_BASE_PX * scale) / LABEL_FONT_BASE_SCALE * 10) / 10;
}

export interface HarmonyOverlayOptions {
  /** The score container element (position: relative required). */
  container: HTMLElement;
  /** Current ghost layer from buildGhosts(). */
  ghostLayer: GhostLayer;
  /** measureKey → 1-based mc, from buildMcIndex(). */
  mcIndex: Map<string, number>;
  /** All movement_analysis events for the movement (not selection-scoped). */
  events: HarmonyEventOut[];
  /**
   * Current Verovio staff-size scale (e.g. 35 / 45 / 55). Label font size scales
   * linearly with it; defaults to the base preset when omitted.
   */
  scale?: number;
  /**
   * Optional callback fired when an in-score label is clicked (click-to-focus).
   * When provided, labels render with pointer-events: auto and a pointer cursor.
   * ScoreViewer forwards this to HarmonyPanel to scroll/focus the matching event.
   */
  onLabelClick?: (mn: number, volta: number | null, beat: number) => void;
}

/**
 * Recognised figbass figures (the inversion suffix baked into the numeral by the
 * DCML ingest's _build_numeral). A whole-corpus survey of the Mozart piano sonatas
 * confirms exactly these seven values; each splits into single-digit stacked rows.
 * See docs/architecture/harmony-score-overlay.md §"Stacked figures (Step 22)".
 */
const FIGBASS_FIGURES = new Set(['6', '7', '2', '65', '43', '64']);

/** Roman-numeral base + trailing figbass digits (e.g. "V65", "bVII6", "I"). */
const NUMERAL_FIGURE_RE =
  /^([#b]?(?:VII|VI|IV|V|III|II|I|vii|vi|iv|v|iii|ii|i))(\d*)$/;

/**
 * Split a built numeral into its Roman-numeral base and a list of stacked figure
 * rows, when the trailing digits form a recognised figbass figure.
 *
 * Returns ``null`` when the numeral has no figure or the digits are not a
 * recognised figbass value — in which case the numeral renders as plain linear
 * text (Step 22 fallback grammar).
 */
function splitNumeralFigure(
  numeral: string,
): { base: string; rows: string[] } | null {
  const m = NUMERAL_FIGURE_RE.exec(numeral);
  if (!m) return null;
  const base = m[1]!;
  const digits = m[2]!;
  if (!digits || !FIGBASS_FIGURES.has(digits)) return null;
  return { base, rows: digits.split('') };
}

/**
 * Resolve the figure rows for an event, applying the Step 22 grammar:
 *   1. figbass digits in the numeral always win (split to single-digit rows);
 *   2. otherwise, the cadential six-four — a figure-less numeral with
 *      extensions exactly ["64"] — stacks as 6 over 4.
 * Returns the base Roman numeral and the (possibly empty) stacked rows.
 */
function resolveFigure(e: HarmonyEventOut): { base: string; rows: string[] } {
  const numeral = e.numeral ?? '';
  const split = splitNumeralFigure(numeral);
  if (split) return split;
  const ext = e.extensions ?? [];
  if (ext.length === 1 && ext[0] === '64') {
    return { base: numeral, rows: ['6', '4'] };
  }
  return { base: numeral, rows: [] };
}

/**
 * Build a chord label as DOM children of *span*: the Roman-numeral base, an
 * optional stacked-figure column, the applied-chord slash, and the local-key
 * suffix. Kept lexically identical to HarmonyPanel.primaryLabel() in textContent
 * (the figure rows concatenate to the same digits), with the figure stacked
 * vertically via CSS. Falls back to "—" when nothing renders.
 */
function renderLabelInto(
  span: HTMLSpanElement,
  e: HarmonyEventOut,
  includeKey: boolean,
  figureCls: string,
  figureRowCls: string,
): void {
  const { base, rows } = resolveFigure(e);

  let hasContent = false;
  if (base) {
    span.appendChild(document.createTextNode(base));
    hasContent = true;
  }
  if (rows.length > 0) {
    const figureEl = document.createElement('span');
    figureEl.className = figureCls;
    figureEl.setAttribute('data-figure', 'true');
    for (const row of rows) {
      const rowEl = document.createElement('span');
      rowEl.className = figureRowCls;
      rowEl.textContent = row;
      figureEl.appendChild(rowEl);
    }
    span.appendChild(figureEl);
    hasContent = true;
  }
  if (e.applied_to) {
    span.appendChild(document.createTextNode(`/${e.applied_to}`));
    hasContent = true;
  }
  if (includeKey && e.local_key) {
    span.appendChild(document.createTextNode(` (${e.local_key})`));
    hasContent = true;
  }
  if (!hasContent) {
    span.appendChild(document.createTextNode('—'));
  }
}

/**
 * In-score harmony chord label overlay (tag mode only).
 *
 * Lifecycle managed by ScoreViewer:
 *   new HarmonyOverlay(options)       — mounts overlay DOM into container
 *   reproject(ghostLayer, mcIndex)    — rebuilds positions after Verovio re-render
 *   setEvents(events)                 — replaces event list and rebuilds
 *   destroy()                         — removes overlay from DOM
 */
export class HarmonyOverlay {
  private _ghostLayer: GhostLayer;
  private _events: HarmonyEventOut[];
  private readonly _onLabelClick:
    | ((mn: number, volta: number | null, beat: number) => void)
    | undefined;
  private readonly _overlayEl: HTMLDivElement;
  private readonly _fontPx: number;

  constructor(options: HarmonyOverlayOptions) {
    this._ghostLayer = options.ghostLayer;
    this._events = options.events;
    this._onLabelClick = options.onLabelClick;
    this._fontPx = labelFontPx(options.scale);

    this._overlayEl = document.createElement('div');
    this._overlayEl.className = styles['overlay'] ?? 'harmony-overlay';
    this._overlayEl.setAttribute('aria-hidden', 'true');
    options.container.appendChild(this._overlayEl);

    this._buildLabels();
  }

  /**
   * Rebuild all label positions from a fresh ghost layer and mcIndex.
   * Called by ScoreViewer on every reproject() signal (Verovio re-render).
   */
  reproject(ghostLayer: GhostLayer, _mcIndex: Map<string, number>): void { // eslint-disable-line @typescript-eslint/no-unused-vars
    this._ghostLayer = ghostLayer;
    this._buildLabels();
  }

  /**
   * Replace the cached event list and rebuild labels.
   * Called after any harmony edit in HarmonyPanel (insert, edit, delete, confirm).
   */
  setEvents(events: HarmonyEventOut[]): void {
    this._events = events;
    this._buildLabels();
  }

  /** Remove the overlay from the DOM. Call when leaving tag mode or unmounting. */
  destroy(): void {
    this._overlayEl.remove();
  }

  private _buildLabels(): void {
    // Tear down and rebuild — avoids stale nodes for events with no ghost on
    // the current render (harmony-score-overlay.md §"Re-render behaviour").
    this._overlayEl.innerHTML = '';

    const clickable = Boolean(this._onLabelClick);
    const labelCls = styles['label'] ?? 'harmony-label';
    const clickableCls = styles['labelClickable'] ?? 'harmony-label-clickable';
    const figureCls = styles['figure'] ?? 'harmony-figure';
    const figureRowCls = styles['figureRow'] ?? 'harmony-figure-row';

    // Suppress repeated key annotations: show (local_key) only on the first
    // rendered label and whenever the key changes.  Initialised to `undefined`
    // (not `null`) so the very first rendered label always shows its key — no
    // string or null value can equal `undefined`.
    let lastKey: string | null | undefined = undefined;

    for (const event of this._events) {
      const volta = event.volta ?? null;

      // Step 1 — resolve measure ghost (volta-aware key)
      const measureKey = measureGhostKey(event.mn, volta);
      const measureEntry = this._ghostLayer.measureIndex.get(measureKey);
      if (!measureEntry) continue; // system not yet rendered or ending not visible

      // Step 2 — resolve beat or sub-beat ghost via measureEntry.renderOrder.
      // harmony-score-overlay.md §"Step 2 — resolve the beat ghost"
      //
      // When event.beat has a fractional part (e.g. 3.5 = the & of beat 3),
      // we probe subBeatIndex for sb=1 and sb=2 and pick the closest match.
      // Downbeats (subBeatFrac < 0.01) go straight to beatIndex + walk-back.
      const renderOrder = measureEntry.renderOrder;
      const beatIdx = Math.floor(event.beat) - 1; // 1-indexed beat → 0-indexed ghost slot
      const subBeatFrac = event.beat - Math.floor(event.beat);

      // Center-x of the leftmost notehead at the resolved beat/sub-beat (label anchor x).
      let resolvedCenter: number | undefined;

      if (subBeatFrac >= 0.01) {
        // Sub-beat event: probe sb=1 and sb=2 (covers simple subDiv=2 and
        // compound subDiv=3), pick whichever beatFloat is nearest event.beat.
        let bestDist = Infinity;
        for (let sb = 1; sb <= 2; sb++) {
          const sbEntry = this._ghostLayer.subBeatIndex.get(
            encodeSubBeat(renderOrder, beatIdx, sb),
          );
          if (sbEntry) {
            const dist = Math.abs(sbEntry.beatFloat - event.beat);
            if (dist < bestDist) {
              bestDist = dist;
              resolvedCenter = sbEntry.noteheadCenter;
            }
          }
        }
      }

      // Fall back to beat ghost (with walk-back) when no sub-beat slot matched.
      if (resolvedCenter === undefined) {
        let beatEntry = this._ghostLayer.beatIndex.get(encodeBeat(renderOrder, beatIdx));
        if (!beatEntry) {
          for (let b = beatIdx - 1; b >= 0; b--) {
            beatEntry = this._ghostLayer.beatIndex.get(encodeBeat(renderOrder, b));
            if (beatEntry) break;
          }
        }
        if (!beatEntry) continue; // unreachable: beat 0 is always anchored at measure start
        resolvedCenter = beatEntry.noteheadCenter;
      }

      // Step 3 — pixel position: x = leftmost-notehead center (CSS centers the
      // label on it via translateX(-50%)); y from the system bottom. See
      // harmony-score-overlay.md §"Coordinate mapping".
      const x = resolvedCenter;
      const y = measureEntry.bounds.top + measureEntry.bounds.height + LANE_OFFSET_PX;

      const span = document.createElement('span');
      span.className = clickable ? `${labelCls} ${clickableCls}` : labelCls;
      span.style.left = `${x}px`;
      span.style.top = `${y}px`;
      span.style.fontSize = `${this._fontPx}px`;
      renderLabelInto(
        span,
        event,
        event.local_key !== lastKey,
        figureCls,
        figureRowCls,
      );
      lastKey = event.local_key;

      if (clickable && this._onLabelClick) {
        const { mn, beat } = event;
        span.addEventListener('click', () => {
          this._onLabelClick!(mn, volta, beat);
        });
      }

      this._overlayEl.appendChild(span);
    }
  }
}
