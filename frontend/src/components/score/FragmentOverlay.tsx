/**
 * Fragment overlay — data layer, projection, and stored-bracket rendering.
 *
 * This component is the Step 10 data-layer upgrade of the earlier static
 * container stub.  It combines two distinct overlay layers:
 *
 *  1. **Live annotation overlays** (children) — MainBracket and StageBrackets
 *     are passed from ScoreViewer and rendered inside this component unchanged.
 *
 *  2. **Stored-fragment brackets** — fetched fragments are projected from
 *     logical bar/beat coordinates onto the ghost spatial index at render time
 *     (same approach as MainBracket/StageBrackets) so they survive zoom,
 *     resize, and font changes without any extra wiring.  Step 11 adds the
 *     full visual treatment (alias labels, per-status colour, collapse/expand
 *     interaction); Step 10 renders projection-correct bracket bars.
 *
 * Architecture rules (CLAUDE.md §"Verovio SVG overlay rule"):
 *  - All overlays are absolutely-positioned HTML elements above the SVG; never
 *    modify Verovio's SVG output.
 *  - pointer-events: none on the container; the per-bracket click target
 *    (Step 12) sets pointer-events: auto on itself alone so ghost drag-select
 *    still reaches the ghost layer.
 *  - Re-projection is automatic: pixel bounds are derived from ghostLayer at
 *    render time, so when ScoreViewer rebuilds the ghost layer after any SVG
 *    re-render the next React render automatically picks up fresh pixel bounds.
 *
 * Filter-ready architecture (Phase 2):
 *  Per-fragment `show` and `category_filter` fields are tracked in
 *  `displayState` from day one.  The Phase 2 filter UI will update that state
 *  without touching the projection or rendering paths.
 *
 * References:
 *  docs/roadmap/component-7-fragment-database.md §Step 10, §Step 11
 *  docs/architecture/tagging-tool-design.md §"Overlay layers"
 */

import { useMemo, useState } from 'react';
import type { GhostLayer } from './ghosts';
import { resolveSegments } from './MainBracket';
import type { BracketSegment } from './MainBracket';
import type { FragmentListItem } from '../../services/fragmentApi';
import type { SelectionRange } from './annotator';
import styles from './FragmentOverlay.module.css';
import bracketStyles from './StoredBrackets.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Stored bracket height in pixels (thinner than the live bracket at 5px). */
const STORED_BRACKET_H = 4;

/**
 * Distance stored brackets sit above systemTop.  Slightly higher than the live
 * bracket (BRACKET_ABOVE_SYSTEM_PX = 9) so stored brackets and the live
 * selection bracket are visually distinct layers and do not overlap.
 */
const STORED_BRACKET_ABOVE_SYSTEM_PX = 16;

// ---------------------------------------------------------------------------
// Per-fragment display state
// ---------------------------------------------------------------------------

/**
 * Per-fragment display state — filter-ready (Phase 2) + collapse (Step 11).
 *
 * `show` and `category_filter` are Phase 2 hooks: the Phase 2 filter UI will
 * flip `show` to false for fragments that don't match the active filter.
 * `collapsed` is the Step 11 collapse/expand toggle: true = top-level only.
 *
 * Defaults: { show: true, category_filter: [], collapsed: true }.
 */
export interface StoredFragmentDisplayState {
  show: boolean;
  category_filter: string[];
  collapsed: boolean;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FragmentOverlayProps {
  /** Live annotation overlays (MainBracket, StageBrackets). */
  children?: React.ReactNode;
  /**
   * Top-level stored fragments for the current movement.  Populated by
   * useStoredFragments in ScoreViewer; empty before the fetch completes.
   * Sub-parts are nested inside each item (FragmentListItem.sub_parts).
   */
  fragments?: FragmentListItem[];
  /**
   * Ghost spatial index rebuilt after each Verovio re-render.  When this
   * changes the component re-renders automatically, re-deriving pixel bounds
   * from the new geometry — this is the re-projection mechanism.
   */
  ghostLayer?: GhostLayer | null;
  /**
   * Called when a stored bracket's click target is activated (Step 12 side
   * panel).  id is the fragment UUID.  Not yet wired to a side panel in
   * Step 10; the target is rendered so Step 12 can connect it without
   * changing the component interface.
   */
  onBracketClick?: (fragmentId: string) => void;
  /** Test hook. Defaults to 'fragment-overlay'. */
  'data-testid'?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a FragmentListItem's coordinate fields to the SelectionRange shape
 * expected by resolveSegments.
 */
function toSelectionRange(item: FragmentListItem): SelectionRange {
  return {
    barStart: item.bar_start,
    barEnd: item.bar_end,
    beatStart: item.beat_start,
    beatEnd: item.beat_end,
    repeatContext: item.repeat_context as SelectionRange['repeatContext'],
  };
}

/**
 * Return a CSS module class name for a fragment status (Step 11 colours).
 * Step 10 provides the hook; Step 11 fills in the actual colour rules.
 */
function statusClass(status: FragmentListItem['status']): string {
  switch (status) {
    case 'draft':     return bracketStyles.statusDraft;
    case 'submitted': return bracketStyles.statusSubmitted;
    case 'approved':  return bracketStyles.statusApproved;
    case 'rejected':  return bracketStyles.statusRejected;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FragmentOverlay({
  children,
  fragments = [],
  ghostLayer,
  onBracketClick,
  'data-testid': testId,
}: FragmentOverlayProps) {

  // ── Per-fragment display state (filter-ready + collapse) ─────────────────
  //
  // Keyed by fragment id.  Entries are written when the user interacts (Step
  // 11 collapse toggle; Phase 2 filter panel).  Missing entries fall back to
  // the default shown below, so newly fetched fragments are always visible
  // without an initialisation step.
  const [displayState, setDisplayState] =
    useState<Map<string, StoredFragmentDisplayState>>(new Map());

  // ── Projection ────────────────────────────────────────────────────────────
  //
  // Convert each visible fragment's logical coordinates to per-system pixel
  // bracket segments at render time.  Deriving bounds from ghostLayer here
  // (rather than in an effect) means re-projection is fully automatic:
  // whenever ScoreViewer rebuilds ghostLayer after a Verovio re-render, the
  // new ghostLayer reference triggers a React re-render, and the memo picks up
  // the fresh pixel geometry.  The logical coordinates stored in `fragments`
  // are unchanged — only the pixel output changes.
  const projected = useMemo<
    Array<{
      id: string;
      status: FragmentListItem['status'];
      segments: BracketSegment[];
    }>
  >(() => {
    if (!ghostLayer || fragments.length === 0) return [];

    const result: Array<{
      id: string;
      status: FragmentListItem['status'];
      segments: BracketSegment[];
    }> = [];

    for (const frag of fragments) {
      // Honour per-fragment show flag (Phase 2 filter; defaults to true).
      const state = displayState.get(frag.id);
      if (state !== undefined && !state.show) continue;

      const sel = toSelectionRange(frag);
      // Use beat resolution when the fragment carries beat coordinates so the
      // projected bracket aligns with beat ghost bounds — matching the live
      // selection bracket at the same precision (G3.2).
      const resolution = frag.beat_start !== null ? 'beat' : 'measure';
      const segments = resolveSegments(sel, ghostLayer, resolution);
      if (segments) {
        result.push({ id: frag.id, status: frag.status, segments });
      }
    }

    return result;
  }, [fragments, ghostLayer, displayState]);

  // ── Phase 2 / Step 11 toggle helpers (wired in later steps) ──────────────

  /**
   * Toggle the collapsed state for one fragment.  Called by the bracket click
   * handler in Step 11 once sub-part rendering is in place.
   *
   * Exported via the ref pattern if needed by a parent, but the primary
   * surface in Step 11 is the per-bracket onClick.
   */
  const _toggleCollapsed = (id: string) => {
    setDisplayState(prev => {
      const current = prev.get(id) ??
        { show: true, category_filter: [], collapsed: true };
      const next = new Map(prev);
      next.set(id, { ...current, collapsed: !current.collapsed });
      return next;
    });
  };

  // Keep the lint warning at bay — _toggleCollapsed is used in Step 11.
  void _toggleCollapsed;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      className={styles.overlay}
      aria-hidden="true"
      data-testid={testId ?? 'fragment-overlay'}
    >
      {/* Layer 1+2: live annotation overlays (MainBracket, StageBrackets). */}
      {children}

      {/* Layer 5: stored-fragment brackets.
          Each fragment projects to one bracket segment per SVG system row.
          Step 10: projection-correct bars with click targets.
          Step 11: alias labels, per-status colour, collapse/expand. */}
      {projected.map(({ id, status, segments }) =>
        segments.map((seg, i) => {
          const top = seg.systemTop - STORED_BRACKET_ABOVE_SYSTEM_PX;
          const width = seg.right - seg.left;
          if (width <= 0) return null;
          return (
            <div
              key={`${id}-seg${i}`}
              className={`${bracketStyles.storedBracket} ${statusClass(status)}`}
              style={{ left: seg.left, top, width, height: STORED_BRACKET_H }}
              data-fragment-id={id}
              data-testid={i === 0 ? `stored-bracket-${id}` : `stored-bracket-${id}-${i}`}
            >
              {/* Click target — only on the first segment (leftmost) and only
                  when a handler is wired (Step 12 connects it to the side
                  panel).  pointer-events: auto so it receives clicks without
                  blocking ghost drag-select on the bracket bar area. */}
              {seg.isFirst && onBracketClick !== undefined && (
                <button
                  type="button"
                  className={bracketStyles.clickTarget}
                  onClick={(e) => {
                    e.stopPropagation();
                    onBracketClick(id);
                  }}
                  aria-label="Open fragment details"
                />
              )}
            </div>
          );
        }),
      )}
    </div>
  );
}
