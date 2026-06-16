/**
 * Playback caret geometry — Component 9 Step 19.
 *
 * The playback indicator is a moving caret: an absolutely-positioned overlay
 * element layered over the Verovio SVG (never inside it — CLAUDE.md §"Verovio
 * SVG overlay rule"). It is driven by the existing `onPositionUpdate(timeMs)`
 * signal and the timemap-derived highlight schedule (the same source the retired
 * `.is-playing` highlight consumed).
 *
 * Two concerns live here:
 *   - {@link resolveCaret} — a pure resolver (no DOM), unit-tested in
 *     `__tests__/caret.test.ts`.
 *   - {@link buildCaretTrack} — a DOM-dependent builder that resolves the
 *     schedule's note ids to container-relative pixel anchors.
 *
 * See `docs/architecture/playback-coordinates.md` §"Playback caret".
 */

import { noteheadLeftEdge } from './ghosts';

// ---------------------------------------------------------------------------
// Mode switch
// ---------------------------------------------------------------------------

/**
 * Whether the caret interpolates between note onsets (smooth motion) or snaps
 * to each onset (discrete steps). Interpolation is the chosen Step 19 default;
 * flip to `false` to fall back to caret-without-interpolation if interpolation
 * artifacts surface. See the doc §"Fallback (caret without interpolation)".
 */
export const CARET_INTERPOLATE = true;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single onset anchor: the playhead x at a known time, on a known system. */
export interface CaretAnchor {
  /** Onset time in ms (same clock as the highlight schedule). */
  timeMs: number;
  /** Container-relative x of the onset (px). */
  x: number;
  /** Index into {@link CaretTrack.systems} of the system this onset sits on. */
  system: number;
}

/** One staff-system row's vertical extent and right edge (container px). */
export interface CaretSystem {
  index: number;
  /** Container-relative y of the system top (px). */
  top: number;
  /** System height (px) — spans the whole system, both staves of a grand staff. */
  height: number;
  /** Container-relative x of the system's right edge (px). */
  rightEdge: number;
}

/**
 * Pre-computed caret track for one render. `anchors` are sorted ascending by
 * `timeMs`; `systems` are ordered top→bottom and indexed by `CaretAnchor.system`.
 */
export interface CaretTrack {
  anchors: CaretAnchor[];
  systems: CaretSystem[];
}

/** Resolved caret placement at a point in time (all container-relative px). */
export interface CaretPlacement {
  x: number;
  top: number;
  height: number;
}

/** One highlight-schedule entry: an onset time and the note ids sounding then. */
interface ScheduleEntry {
  timeMs: number;
  ids: string[];
}

// ---------------------------------------------------------------------------
// Pure resolver
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Resolve the caret placement at time `t` from a caret track.
 *
 * Behaviour (see `playback-coordinates.md` §"Playback caret"):
 *  - Before the first anchor → `null` (caret hidden).
 *  - At/after the last anchor → pinned at the last anchor.
 *  - Forward within one system → x linearly interpolated between the bracketing
 *    anchors.
 *  - System break (next anchor on a different system) → x sweeps toward the
 *    current system's right edge over the interval, then jumps to the next
 *    anchor at its onset time. No interpolation across the break.
 *  - Backward x (repeat seam `:|`→`|:`, where the same notation replays) → hold
 *    at the current anchor until the next onset. Never sweep backwards.
 *
 * @param track       Pre-built caret track.
 * @param t           Current playback time (ms, same clock as the schedule).
 * @param interpolate When false, snap to the current anchor (discrete steps) —
 *                    the documented caret-without-interpolation fallback.
 * @returns Placement, or `null` when the caret should be hidden.
 */
export function resolveCaret(
  track: CaretTrack,
  t: number,
  interpolate: boolean = CARET_INTERPOLATE
): CaretPlacement | null {
  const { anchors, systems } = track;
  if (anchors.length === 0) return null;

  // Binary search: latest anchor with timeMs <= t.
  let lo = 0;
  let hi = anchors.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid]!.timeMs <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (idx < 0) return null; // before the first onset — caret hidden

  const a = anchors[idx]!;
  const aSys = systems[a.system];
  if (!aSys) return null;

  const b = anchors[idx + 1];

  // At/after the last anchor, or snapping in fallback mode: pin to the anchor.
  if (!b || !interpolate) {
    return { x: a.x, top: aSys.top, height: aSys.height };
  }

  const span = b.timeMs - a.timeMs;
  const frac = span > 0 ? Math.min(1, Math.max(0, (t - a.timeMs) / span)) : 0;

  // System break: sweep toward the current system's right edge, then jump at b.
  if (b.system !== a.system) {
    return { x: lerp(a.x, aSys.rightEdge, frac), top: aSys.top, height: aSys.height };
  }

  // Repeat seam (backward x): hold at a until the next onset, never sweep back.
  if (b.x < a.x) {
    return { x: a.x, top: aSys.top, height: aSys.height };
  }

  // Forward within the same system: interpolate.
  return { x: lerp(a.x, b.x, frac), top: aSys.top, height: aSys.height };
}

// ---------------------------------------------------------------------------
// DOM-dependent track builder
// ---------------------------------------------------------------------------

/**
 * Build a {@link CaretTrack} by resolving a highlight schedule's note ids to
 * container-relative pixel anchors against the rendered SVG.
 *
 * Each schedule entry becomes one anchor: its x is the minimum notehead left
 * edge across the entry's ids (so accidentals don't pull the onset left), and
 * its system is the enclosing `g.system`, grouped by container-relative top.
 *
 * Must run after the SVG is laid out (post-paint), against the same container
 * the brackets/ghosts measure from (`.scoreContent`, `position: relative`), so
 * the anchor coordinates share the overlay's origin.
 *
 * @param container - The score content element (position: relative).
 * @param schedule  - Timemap-derived `{ timeMs, ids }` entries (see
 *                    `buildHighlightSchedule` / `buildFragmentPlayback`).
 * @returns The caret track; partial/empty on DOM error or missing geometry.
 */
export function buildCaretTrack(container: HTMLElement, schedule: ScheduleEntry[]): CaretTrack {
  // Anchors keyed by system top (rounded) during collection, remapped to a
  // contiguous index afterwards.
  const raw: Array<{ timeMs: number; x: number; key: number }> = [];
  const systemByKey = new Map<number, { top: number; bottom: number; right: number }>();

  try {
    const cr = container.getBoundingClientRect();
    for (const entry of schedule) {
      let x = Infinity;
      let sysEl: Element | null = null;
      for (const id of entry.ids) {
        const el = container.querySelector(`[id="${CSS.escape(id)}"]`);
        if (!el) continue;
        const left = noteheadLeftEdge(el, cr.left);
        if (left < x) {
          x = left;
          sysEl = el.closest('g.system') ?? el;
        }
      }
      if (!Number.isFinite(x) || !sysEl) continue;

      const sr = sysEl.getBoundingClientRect();
      const top = sr.top - cr.top;
      const key = Math.round(top);
      if (!systemByKey.has(key)) {
        systemByKey.set(key, { top, bottom: sr.bottom - cr.top, right: sr.right - cr.left });
      }
      raw.push({ timeMs: entry.timeMs, x, key });
    }
  } catch {
    // Partial track on DOM error — playback degrades to a hidden caret.
  }

  // Order systems top→bottom and assign contiguous indexes.
  const sortedKeys = [...systemByKey.keys()].sort((p, q) => p - q);
  const keyToIndex = new Map<number, number>();
  const systems: CaretSystem[] = sortedKeys.map((k, i) => {
    keyToIndex.set(k, i);
    const s = systemByKey.get(k)!;
    return { index: i, top: s.top, height: s.bottom - s.top, rightEdge: s.right };
  });

  const anchors: CaretAnchor[] = raw
    .map((r) => ({ timeMs: r.timeMs, x: r.x, system: keyToIndex.get(r.key)! }))
    .sort((p, q) => p.timeMs - q.timeMs);

  return { anchors, systems };
}

// ---------------------------------------------------------------------------
// Imperative DOM application
// ---------------------------------------------------------------------------

/**
 * Apply a caret placement to its overlay element via `transform` + `height`.
 * Called on the 60 fps playback path — no React state update.
 */
export function applyCaretPlacement(el: HTMLElement, placement: CaretPlacement): void {
  el.style.transform = `translate(${placement.x}px, ${placement.top}px)`;
  el.style.height = `${placement.height}px`;
  el.style.visibility = 'visible';
}

/** Hide the caret (playback stopped, ended, or position before the first onset). */
export function hideCaretEl(el: HTMLElement | null): void {
  if (el) el.style.visibility = 'hidden';
}
