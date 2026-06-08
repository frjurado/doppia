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
   * Optional callback fired when an in-score label is clicked (click-to-focus).
   * When provided, labels render with pointer-events: auto and a pointer cursor.
   * ScoreViewer forwards this to HarmonyPanel to scroll/focus the matching event.
   */
  onLabelClick?: (mn: number, volta: number | null, beat: number) => void;
}

/** Primary label — kept lexically identical to HarmonyPanel.primaryLabel(). */
function primaryLabel(e: HarmonyEventOut, includeKey = true): string {
  let chord = e.numeral ?? '';
  if (e.applied_to) chord += `/${e.applied_to}`;
  const key = includeKey && e.local_key ? ` (${e.local_key})` : '';
  return (chord + key) || '—';
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

  constructor(options: HarmonyOverlayOptions) {
    this._ghostLayer = options.ghostLayer;
    this._events = options.events;
    this._onLabelClick = options.onLabelClick;

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
  reproject(ghostLayer: GhostLayer, _mcIndex: Map<string, number>): void {
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

      let resolvedBounds: { left: number } | undefined;

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
              resolvedBounds = sbEntry.bounds;
            }
          }
        }
      }

      // Fall back to beat ghost (with walk-back) when no sub-beat slot matched.
      if (!resolvedBounds) {
        let beatEntry = this._ghostLayer.beatIndex.get(encodeBeat(renderOrder, beatIdx));
        if (!beatEntry) {
          for (let b = beatIdx - 1; b >= 0; b--) {
            beatEntry = this._ghostLayer.beatIndex.get(encodeBeat(renderOrder, b));
            if (beatEntry) break;
          }
        }
        if (!beatEntry) continue; // unreachable: beat 0 is always anchored at measure start
        resolvedBounds = beatEntry.bounds;
      }

      // Step 3 — pixel position: x from beat/sub-beat ghost, y from system bottom
      const x = resolvedBounds.left;
      const y = measureEntry.bounds.top + measureEntry.bounds.height + LANE_OFFSET_PX;

      const span = document.createElement('span');
      span.className = clickable ? `${labelCls} ${clickableCls}` : labelCls;
      span.style.left = `${x}px`;
      span.style.top = `${y}px`;
      span.textContent = primaryLabel(event, event.local_key !== lastKey);
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
