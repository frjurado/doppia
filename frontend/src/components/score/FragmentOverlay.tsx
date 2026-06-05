/**
 * Fragment overlay — data layer, projection, and stored-bracket rendering.
 *
 * Combines two distinct overlay layers:
 *
 *  1. **Live annotation overlays** (children) — MainBracket and StageBrackets
 *     are passed from ScoreViewer and rendered inside this component unchanged.
 *
 *  2. **Stored-fragment brackets** — fetched fragments are projected from
 *     logical bar/beat coordinates onto the ghost spatial index at render time
 *     (same approach as MainBracket/StageBrackets) so they survive zoom,
 *     resize, and font changes without any extra wiring.
 *
 * Step 11 adds the full visual treatment:
 *  - Alias labels (e.g. "PAC") at the left edge of each parent bracket.
 *  - Collapse/expand: clicking a bracket shows/hides its sub-part brackets.
 *  - Sub-part brackets rendered below the staff when the parent is expanded,
 *    reusing the ghost system-bottom for y-placement (same as StageBrackets).
 *  - Per-status colour classes distinguish draft / submitted / approved / rejected.
 *
 * Architecture rules (CLAUDE.md §"Verovio SVG overlay rule"):
 *  - All overlays are absolutely-positioned HTML elements above the SVG; never
 *    modify Verovio's SVG output.
 *  - pointer-events: none on the container; individual children re-enable it.
 *  - Re-projection is automatic: pixel bounds are derived from ghostLayer at
 *    render time, so when ScoreViewer rebuilds ghostLayer after any SVG
 *    re-render the next React render picks up fresh pixel bounds.
 *
 * Filter-ready architecture (Phase 2):
 *  Per-fragment `show` and `category_filter` fields are tracked in
 *  `displayState` from day one.  The Phase 2 filter UI will update that state
 *  without touching the projection or rendering paths.
 *
 * Two-level display limit (ADR-011):
 *  Only `fragment.sub_parts` are rendered when expanded; sub_parts.sub_parts
 *  are not shown even though the data model preserves full depth.
 *
 * References:
 *  docs/roadmap/component-7-fragment-database.md §Step 10, §Step 11
 *  docs/architecture/tagging-tool-design.md §"Overlay layers"
 *  docs/adr/ADR-011-multi-level-tagging-design.md §"Two-level display limit"
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

/** Stored parent-bracket height in pixels (thinner than the live bracket at 5px). */
const STORED_BRACKET_H = 4;

/**
 * Distance stored brackets sit above systemTop.  Slightly higher than the live
 * bracket (BRACKET_ABOVE_SYSTEM_PX = 9) so stored brackets and the live
 * selection bracket are visually distinct layers and do not overlap.
 */
const STORED_BRACKET_ABOVE_SYSTEM_PX = 16;

/** Sub-part bracket height in pixels. */
const SUB_BRACKET_H = 4;

/** Gap below the last staff-line bottom before the sub-part bracket top (px).
 *  Matches StageBrackets.tsx BELOW_STAFF_GAP so stored sub-parts sit in the
 *  same lane as live stage brackets. */
const SUB_BRACKET_BELOW_STAFF_GAP = 6;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/** BracketSegment extended with systemBottom for below-staff y-placement. */
interface SubPartSegment extends BracketSegment {
  systemBottom: number;
}

// ---------------------------------------------------------------------------
// Per-fragment display state
// ---------------------------------------------------------------------------

/**
 * Per-fragment display state — filter-ready (Phase 2) + collapse (Step 11).
 *
 * `show` and `category_filter` are Phase 2 hooks: the Phase 2 filter UI will
 * flip `show` to false for fragments that don't match the active filter.
 * `collapsed` drives the Step 11 expand/collapse interaction: true = top-level only.
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
   * panel).  id is the fragment UUID.  When provided, clicking the bracket
   * both toggles collapse (if the fragment has sub-parts) and opens the panel.
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
 * Return a CSS module class name for a fragment status.
 */
function statusClass(status: FragmentListItem['status']): string {
  switch (status) {
    case 'draft':     return bracketStyles.statusDraft;
    case 'submitted': return bracketStyles.statusSubmitted;
    case 'approved':  return bracketStyles.statusApproved;
    case 'rejected':  return bracketStyles.statusRejected;
  }
}

/**
 * Return the pixel y-coordinate of the bottom of the staff system whose
 * systemTop matches the given value.
 *
 * Derived from the measure ghost entries: each entry's bounds.top + height
 * is the staff bottom for its system.  When no entry matches (should not
 * happen in practice) a 60px fallback keeps rendering consistent.
 */
function getSystemBottom(systemTop: number, layer: GhostLayer): number {
  let bottom = systemTop + 60;
  let found = false;
  for (const entry of layer.measureIndex.values()) {
    if (entry.systemTop === systemTop) {
      const entryBottom = entry.bounds.top + entry.bounds.height;
      if (!found || entryBottom > bottom) {
        bottom = entryBottom;
        found = true;
      }
    }
  }
  return bottom;
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
  // Keyed by fragment id.  Entries are written when the user interacts
  // (collapse toggle; Phase 2 filter panel).  Missing entries fall back to
  // the default below, so newly fetched fragments are always visible without
  // an initialisation step.
  const [displayState, setDisplayState] =
    useState<Map<string, StoredFragmentDisplayState>>(new Map());

  // ── Collapse toggle ───────────────────────────────────────────────────────

  const toggleCollapsed = (id: string) => {
    setDisplayState(prev => {
      const current = prev.get(id) ??
        { show: true, category_filter: [], collapsed: true };
      const next = new Map(prev);
      next.set(id, { ...current, collapsed: !current.collapsed });
      return next;
    });
  };

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
      alias: string | null;
      hasSubParts: boolean;
      segments: BracketSegment[];
      subPartProjections: Array<{
        id: string;
        status: FragmentListItem['status'];
        alias: string | null;
        segments: SubPartSegment[];
      }>;
    }>
  >(() => {
    if (!ghostLayer || fragments.length === 0) return [];

    const result: Array<{
      id: string;
      status: FragmentListItem['status'];
      alias: string | null;
      hasSubParts: boolean;
      segments: BracketSegment[];
      subPartProjections: Array<{
        id: string;
        status: FragmentListItem['status'];
        alias: string | null;
        segments: SubPartSegment[];
      }>;
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
      if (!segments) continue;

      // Two-level display limit (ADR-011): render frag.sub_parts but not
      // sub_parts.sub_parts.  The data model preserves the full depth; only
      // the display is flattened at one visible level.
      const subPartProjections = frag.sub_parts
        .map(sp => {
          const spSel = toSelectionRange(sp);
          const spRes = sp.beat_start !== null ? 'beat' : 'measure';
          const spSegments = resolveSegments(spSel, ghostLayer, spRes);
          if (!spSegments) return null;
          // Augment with systemBottom so sub-parts can be placed below the staff.
          const augmented: SubPartSegment[] = spSegments.map(seg => ({
            ...seg,
            systemBottom: getSystemBottom(seg.systemTop, ghostLayer),
          }));
          return {
            id: sp.id,
            status: sp.status,
            alias: sp.primary_concept_alias,
            segments: augmented,
          };
        })
        .filter((sp): sp is NonNullable<typeof sp> => sp !== null);

      result.push({
        id: frag.id,
        status: frag.status,
        alias: frag.primary_concept_alias,
        hasSubParts: frag.sub_parts.length > 0,
        segments,
        subPartProjections,
      });
    }

    return result;
  }, [fragments, ghostLayer, displayState]);

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
          Sub-part brackets appear below the staff when the fragment is expanded. */}
      {projected.flatMap(({ id, status, alias, hasSubParts, segments, subPartProjections }) => {
        const state = displayState.get(id);
        const collapsed = state?.collapsed ?? true;

        // ── Parent bracket segments ─────────────────────────────────────────
        const parentElements = segments.map((seg, i) => {
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
              {/* Alias label at the left edge of the first segment. */}
              {seg.isFirst && alias !== null && (
                <span
                  className={bracketStyles.aliasLabel}
                  aria-hidden="true"
                >
                  {alias}
                </span>
              )}

              {/* Click target: renders when the fragment has sub-parts (collapse
                  toggle) OR when a side-panel handler is wired (Step 12).
                  Covers the full bracket width for easy targeting of the thin bar.
                  A single click both toggles collapse (if sub-parts exist) and
                  opens the side panel (if onBracketClick is provided). */}
              {seg.isFirst && (hasSubParts || onBracketClick !== undefined) && (
                <button
                  type="button"
                  className={bracketStyles.clickTarget}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (hasSubParts) toggleCollapsed(id);
                    if (onBracketClick !== undefined) onBracketClick(id);
                  }}
                  aria-label={
                    hasSubParts
                      ? collapsed
                        ? 'Expand fragment'
                        : 'Collapse fragment'
                      : 'Open fragment details'
                  }
                />
              )}
            </div>
          );
        });

        // ── Sub-part brackets (below staff, visible only when expanded) ─────
        //
        // Two-level limit enforced here: subPartProjections only contains the
        // direct children of this fragment, never grandchildren (ADR-011).
        const subPartElements = collapsed
          ? []
          : subPartProjections.flatMap(
              ({ id: spId, status: spStatus, alias: spAlias, segments: spSegs }) =>
                spSegs.map((seg, i) => {
                  const top = seg.systemBottom + SUB_BRACKET_BELOW_STAFF_GAP;
                  const width = seg.right - seg.left;
                  if (width <= 0) return null;
                  return (
                    <div
                      key={`${spId}-sub-seg${i}`}
                      className={`${bracketStyles.subPartBracket} ${statusClass(spStatus)}`}
                      style={{ left: seg.left, top, width, height: SUB_BRACKET_H }}
                      data-fragment-id={spId}
                      data-testid={
                        i === 0
                          ? `stored-bracket-${spId}`
                          : `stored-bracket-${spId}-${i}`
                      }
                    >
                      {seg.isFirst && spAlias !== null && (
                        <span
                          className={bracketStyles.aliasLabel}
                          aria-hidden="true"
                        >
                          {spAlias}
                        </span>
                      )}
                    </div>
                  );
                }),
            );

        return [...parentElements, ...subPartElements];
      })}
    </div>
  );
}
