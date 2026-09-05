/**
 * Fragment overlay — data layer, projection, and stored-bracket rendering.
 *
 * Combines two distinct overlay layers:
 *
 *  1. **Live annotation overlays** (children) — StageBrackets
 *     are passed from ScoreViewer and rendered inside this component unchanged.
 *
 *  2. **Stored-fragment brackets** — fetched fragments are projected from
 *     logical bar/beat coordinates onto the ghost spatial index at render time
 *     (same approach as StageBrackets) so they survive zoom,
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
import { useTranslation } from 'react-i18next';
import type { GhostLayer, ResolutionMode } from './ghosts';
import { resolveSegments, serifSides } from './bracketSegments';
import type { BracketSegment } from './bracketSegments';
import type { FragmentListItem } from '../../services/fragmentApi';
import type { SelectionRange } from './annotator';
import { measureKeysForMcRange } from './selection';
import {
  ABOVE_STORED as STORED_BRACKET_ABOVE_SYSTEM_PX,
  BELOW_SUB_PART as SUB_BRACKET_BELOW_STAFF_GAP,
  STORED_BRACKET_H,
  SUB_BRACKET_H,
} from './bracketLanes';
import styles from './FragmentOverlay.module.css';
import bracketStyles from './StoredBrackets.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/* Every offset below comes from the shared lane table (M5). Two of them used
   to be local constants that had drifted into collisions: stored brackets sat
   3px under the live bracket, close enough to read as one two-tone bar, and
   stored sub-parts deliberately matched StageBrackets' BELOW_STAFF_GAP and so
   landed in the live stage lane. See bracketLanes.ts. */

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
  /** Live annotation overlays (StageBrackets). */
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
   * measureKey → mc, from buildMcIndex(). Used to resolve each stored
   * fragment's measures from its `mc` interval rather than by scanning bar
   * numbers, which are not unique on a movement whose numbering restarts (see
   * toSelectionRange). Omitting it falls back to the bar-number scan.
   */
  mcIndex?: Map<string, number> | null;
  /**
   * Called when a stored bracket's click target is activated (Step 12 side
   * panel).  id is the fragment UUID.  When provided, clicking the bracket
   * both toggles collapse (if the fragment has sub-parts) and opens the panel.
   */
  onBracketClick?: (fragmentId: string) => void;
  /**
   * True while a live selection or edit is on screen. Every stored bracket
   * recedes, because none of them is the subject (M5 ask 2) — focus by
   * quieting the rest rather than by emphasising the subject.
   */
  dimmed?: boolean;
  /**
   * The stored fragment currently open in the side panel, if any.
   *
   * Two things follow from it, and both used to be wrong because they were
   * tracked separately from selection:
   *
   *  - **Its sub-parts are the expanded ones, and only its.** Expansion was
   *    a per-fragment toggle independent of selection, so opening B left A's
   *    stages on screen, and clicking A a second time selected it while
   *    switching its stages *off*.
   *  - **Everything else dims**, so the selected fragment is legible among
   *    its neighbours.
   */
  selectedFragmentId?: string | null;
  /** Test hook. Defaults to 'fragment-overlay'. */
  'data-testid'?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a FragmentListItem's coordinate fields to the SelectionRange shape
 * expected by resolveSegments.
 *
 * **Supplies `measureKeys` from the fragment's stored `mc` interval whenever an
 * mc index is available**, because that list is authoritative and short-circuits
 * `effectiveMeasureKeys`. Without it that helper falls back to scanning the
 * ghost layer for `barN` within `[barStart, barEnd]` — and a bar number is not
 * unique. On K331/ii, whose Trio renumbers from 1, a Trio fragment at "mm.
 * 29–30" matched the Menuetto's bars 29–30 as well, so the bracket was painted
 * over **both** passes and the interactive one was whichever came first in the
 * index (M6 / ADR-036). `mc` is document-order and unique, so keying on it
 * paints exactly the measures the fragment occupies.
 */
function toSelectionRange(
  item: FragmentListItem,
  mcIndex?: Map<string, number> | null
): SelectionRange {
  const repeatContext = item.repeat_context as SelectionRange['repeatContext'];
  return {
    barStart: item.bar_start,
    barEnd: item.bar_end,
    beatStart: item.beat_start,
    beatEnd: item.beat_end,
    repeatContext,
    measureKeys: mcIndex
      ? measureKeysForMcRange(mcIndex, item.mc_start, item.mc_end, repeatContext)
      : undefined,
  };
}

/**
 * Finest ghost resolution a stored fragment's beat coordinates require.
 *
 * Sub-beat-precise endpoints (non-integer beat floats) must project against the
 * sub-beat index: projecting them at 'beat' snaps each onto a whole-beat ghost,
 * which in compound meter (6/8 — two beats per bar) makes adjacent stages
 * sharing a measure collapse to the same beat extent and overlap. Integer-beat
 * coordinates use 'beat'; measure-only fragments use 'measure'.
 */
function storedResolution(beatStart: number | null, beatEnd: number | null): ResolutionMode {
  // Only a fragment with *neither* endpoint constrained is a measure-level one.
  // Keying this off beatStart alone painted a stage with a null start and a
  // beat-precise end — the ordinary shape of a last stage, since
  // prePopulateStages pins beats on the outer edges only — across both of its
  // whole measures, so a Final Tonic ran to the end of its bar and adjacent
  // stages overlapped (Component 11 triage item 5).
  if (beatStart === null && beatEnd === null) return 'measure';
  const isSubBeat = (v: number | null): boolean => v !== null && !Number.isInteger(v);
  return isSubBeat(beatStart) || isSubBeat(beatEnd) ? 'subbeat' : 'beat';
}

/**
 * Display label for a stored sub-part bracket: the primary concept alias, then
 * its full name, then a positional fallback — mirroring the fragment viewer
 * (FragmentDetail) so the whole-score stage lane is never nameless.
 */
function subPartLabel(item: FragmentListItem, index: number): string {
  return item.primary_concept_alias ?? item.primary_concept_name ?? `Part ${index + 1}`;
}

/**
 * Return a CSS module class name for a fragment status.
 */
function statusClass(status: FragmentListItem['status']): string {
  switch (status) {
    case 'draft':
      return bracketStyles.statusDraft;
    case 'submitted':
      return bracketStyles.statusSubmitted;
    case 'approved':
      return bracketStyles.statusApproved;
    case 'rejected':
      return bracketStyles.statusRejected;
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
  mcIndex,
  onBracketClick,
  dimmed = false,
  selectedFragmentId = null,
  'data-testid': testId,
}: FragmentOverlayProps) {
  const { t } = useTranslation('score');

  // ── Per-fragment display state (filter-ready + collapse) ─────────────────
  //
  // Keyed by fragment id.  Entries are written when the user interacts
  // (collapse toggle; Phase 2 filter panel).  Missing entries fall back to
  // the default below, so newly fetched fragments are always visible without
  // an initialisation step.
  // `show` and `category_filter` are read by the Phase 2 filter UI; `collapsed`
  // is no longer part of this state, being derived from `selectedFragmentId`.
  const [displayState] = useState<Map<string, StoredFragmentDisplayState>>(new Map());

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
        label: string;
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
        label: string;
        segments: SubPartSegment[];
      }>;
    }> = [];

    for (const frag of fragments) {
      // Honour per-fragment show flag (Phase 2 filter; defaults to true).
      const state = displayState.get(frag.id);
      if (state !== undefined && !state.show) continue;

      const sel = toSelectionRange(frag, mcIndex);
      // Project at the finest resolution the stored beat coordinates require so
      // the bracket aligns with the matching ghost bounds — matching the live
      // selection bracket at the same precision (G3.2). Sub-beat endpoints must
      // use the sub-beat index or they collapse onto whole-beat ghosts and
      // overlap in compound meter (see storedResolution).
      const resolution = storedResolution(frag.beat_start, frag.beat_end);
      const segments = resolveSegments(sel, ghostLayer, resolution);
      if (!segments) continue;

      // Two-level display limit (ADR-011): render frag.sub_parts but not
      // sub_parts.sub_parts.  The data model preserves the full depth; only
      // the display is flattened at one visible level.
      const subPartProjections = frag.sub_parts
        .map((sp, idx) => {
          const spSel = toSelectionRange(sp, mcIndex);
          const spRes = storedResolution(sp.beat_start, sp.beat_end);
          const spSegments = resolveSegments(spSel, ghostLayer, spRes);
          if (!spSegments) return null;
          // Augment with systemBottom so sub-parts can be placed below the staff.
          const augmented: SubPartSegment[] = spSegments.map((seg) => ({
            ...seg,
            systemBottom: getSystemBottom(seg.systemTop, ghostLayer),
          }));
          return {
            id: sp.id,
            status: sp.status,
            label: subPartLabel(sp, idx),
            segments: augmented,
          };
        })
        .filter((sp): sp is NonNullable<typeof sp> => sp !== null);

      result.push({
        id: frag.id,
        status: frag.status,
        // `alias ?? name`, never alias alone. Six of the ten taggable cadence
        // concepts declare no alias, so an alias-only label left their brackets
        // silently nameless. The sub-part path in this same file has always
        // fallen back — its docstring says "the whole-score stage lane is never
        // nameless"; the parent path never got the same treatment (Component 11
        // triage item 14).
        alias: frag.primary_concept_alias ?? frag.primary_concept_name,
        hasSubParts: frag.sub_parts.length > 0,
        segments,
        subPartProjections,
      });
    }

    return result;
  }, [fragments, ghostLayer, mcIndex, displayState]);

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={styles.overlay} aria-hidden="true" data-testid={testId ?? 'fragment-overlay'}>
      {/* Layer 1+2: live annotation overlays (StageBrackets). */}
      {children}

      {/* Layer 5: stored-fragment brackets.
          Each fragment projects to one bracket segment per SVG system row.
          Sub-part brackets appear below the staff when the fragment is expanded. */}
      {projected.flatMap(({ id, status, alias, hasSubParts, segments, subPartProjections }) => {
        // A boundary carries one serif, drawn by whichever bracket begins
        // there. Decided per fragment: a parent's own segments never abut each
        // other (they are one per system row), but its sub-parts tile it.
        const parentSerifs = serifSides(
          segments.map((seg) => ({ left: seg.left, right: seg.right, lane: seg.systemTop }))
        );
        const subSpans = subPartProjections.flatMap(({ segments: spSegs }) =>
          spSegs.map((seg) => ({ left: seg.left, right: seg.right, lane: seg.systemBottom }))
        );
        const subSerifs = serifSides(subSpans);
        let subIdx = -1;
        // Derived, not toggled: the open fragment is the expanded one.
        const collapsed = id !== selectedFragmentId;
        // A selection focuses one fragment, so the others recede; a live edit
        // focuses none of them, so they all do.
        const recede = dimmed || (selectedFragmentId !== null && id !== selectedFragmentId);

        // ── Parent bracket segments ─────────────────────────────────────────
        const parentElements = segments.map((seg, i) => {
          const top = seg.systemTop - STORED_BRACKET_ABOVE_SYSTEM_PX;
          const width = seg.right - seg.left;
          if (width <= 0) return null;
          return (
            <div
              key={`${id}-seg${i}`}
              className={[
                bracketStyles.storedBracket,
                statusClass(status),
                recede ? bracketStyles.dimmed : '',
                parentSerifs[i]?.right === false ? bracketStyles.noSerifRight : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ left: seg.left, top, width, height: STORED_BRACKET_H }}
              data-fragment-id={id}
              data-testid={i === 0 ? `stored-bracket-${id}` : `stored-bracket-${id}-${i}`}
            >
              {/* Alias label at the left edge of the first segment. */}
              {seg.isFirst && alias !== null && (
                <span className={bracketStyles.aliasLabel} aria-hidden="true">
                  {alias}
                </span>
              )}

              {/* Click target: renders when the fragment has sub-parts (collapse
                  toggle) OR when a side-panel handler is wired (Step 12).
                  Covers the full bracket width for easy targeting of the thin bar.
                  A single click both toggles collapse (if sub-parts exist) and
                  opens the side panel (if onBracketClick is provided).

                  On *every* segment, not just the first: a fragment crossing a
                  system break used to be clickable only on its opening system,
                  so the rest of its own bracket did nothing. Continuation
                  segments are hidden from assistive tech and skipped by the tab
                  order — one fragment should reach the keyboard once, however
                  many systems it happens to span. */}
              {(hasSubParts || onBracketClick !== undefined) && (
                <button
                  type="button"
                  className={bracketStyles.clickTarget}
                  onClick={(e) => {
                    e.stopPropagation();
                    // Selecting is the only thing a click does now. Expansion
                    // follows from it, so there is nothing to toggle — that
                    // second, independent toggle is what let one fragment's
                    // stages stay on screen while another was selected.
                    if (onBracketClick !== undefined) onBracketClick(id);
                  }}
                  {...(seg.isFirst ? {} : { tabIndex: -1, 'aria-hidden': true })}
                  aria-label={
                    hasSubParts
                      ? collapsed
                        ? t('overlay.expandFragment')
                        : t('overlay.collapseFragment')
                      : t('overlay.openDetails')
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
              ({ id: spId, status: spStatus, label: spLabel, segments: spSegs }) =>
                spSegs.map((seg, i) => {
                  subIdx += 1;
                  const top = seg.systemBottom + SUB_BRACKET_BELOW_STAFF_GAP;
                  const width = seg.right - seg.left;
                  if (width <= 0) return null;
                  return (
                    <div
                      key={`${spId}-sub-seg${i}`}
                      className={[
                        bracketStyles.subPartBracket,
                        statusClass(spStatus),
                        recede ? bracketStyles.dimmed : '',
                        subSerifs[subIdx]?.right === false ? bracketStyles.noSerifRight : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                      style={{ left: seg.left, top, width, height: SUB_BRACKET_H }}
                      data-fragment-id={spId}
                      data-testid={
                        i === 0 ? `stored-bracket-${spId}` : `stored-bracket-${spId}-${i}`
                      }
                    >
                      {seg.isFirst && (
                        <span className={bracketStyles.aliasLabel} aria-hidden="true">
                          {spLabel}
                        </span>
                      )}
                    </div>
                  );
                })
            );

        return [...parentElements, ...subPartElements];
      })}
    </div>
  );
}
