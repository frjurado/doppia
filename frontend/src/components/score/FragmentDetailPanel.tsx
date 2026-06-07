/**
 * Fragment detail panel — Component 7 Step 12.
 *
 * Opened when an annotator clicks a stored-fragment bracket on the score.
 * Shows the full fragment record (concept, bar range, summary, properties,
 * harmony events, prose annotation, sub-parts) and provides Edit / Delete
 * actions for editors in tag mode.
 *
 * Architecture:
 *  - Fetches getFragment(id) on mount and when fragmentId changes.
 *  - Fetches getConceptSchemas(primaryConceptId) alongside the fragment to
 *    resolve property schema names for human-readable display.
 *  - Edit calls onEdit(fragment) — ScoreViewer restores the fragment into
 *    the tagging form (selection, concept, stages, properties).
 *  - Delete: inline confirmation → deleteFragment with cascade flag.
 *  - Resizable panel (same resize pattern as FormPanel G6.1).
 *
 * Read-only in view mode — Edit / Delete buttons only appear in tag mode.
 *
 * References:
 *  docs/roadmap/component-7-fragment-database.md § Step 12
 *  docs/architecture/fragment-schema.md § "Delete Permissions"
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PropertySchema } from '../../services/conceptApi';
import { getConceptSchemas } from '../../services/conceptApi';
import {
  approveFragment,
  deleteFragment,
  getFragment,
  rejectFragment,
} from '../../services/fragmentApi';
import type { ApprovalGateDetail, FragmentDetailResponse } from '../../services/fragmentApi';
import { ApiError } from '../../services/api';
import Type from '../ui/Type';
import styles from './FragmentDetailPanel.module.css';

// ---------------------------------------------------------------------------
// Panel resize (mirrors FormPanel G6.1)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'doppia.fragmentDetailPanel.width';
const MIN_WIDTH = 280;
const MAX_WIDTH = 560;
const DEFAULT_WIDTH = 320;

function readStoredWidth(): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return DEFAULT_WIDTH;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) ? Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n)) : DEFAULT_WIDTH;
  } catch {
    return DEFAULT_WIDTH;
  }
}

function usePanelResize() {
  const [width, setWidth] = useState<number>(readStoredWidth);
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: width };

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startX - ev.clientX;
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragState.current.startWidth + delta));
      setWidth(next);
    };

    const onMouseUp = (ev: MouseEvent) => {
      if (!dragState.current) return;
      const delta = dragState.current.startX - ev.clientX;
      const final = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, dragState.current.startWidth + delta));
      dragState.current = null;
      try { localStorage.setItem(STORAGE_KEY, String(final)); } catch { /* ignore */ }
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
  }, [width]);

  return { width, onMouseDown };
}

// ---------------------------------------------------------------------------
// Summary v1 type guard
// ---------------------------------------------------------------------------

interface SummaryV1 {
  version: 1;
  key: string;
  meter: string;
  music21_version: string | null;
  actual_key?: {
    value: string;
    auto: boolean;
    reviewed: boolean;
    confidence?: number | null;
  } | null;
  properties?: Record<string, string | string[]>;
}

function isSummaryV1(s: Record<string, unknown>): s is SummaryV1 {
  return s.version === 1 && typeof s.key === 'string' && typeof s.meter === 'string';
}

// ---------------------------------------------------------------------------
// Harmony event helpers
// ---------------------------------------------------------------------------

interface HarmonyRow {
  mn: number;
  beat: number;
  volta: number | null;
  numeral: string | null;
  applied_to: string | null;
  local_key: string | null;
  reviewed: boolean | null;
}

function toHarmonyRow(e: Record<string, unknown>): HarmonyRow {
  return {
    mn:         typeof e.mn         === 'number'  ? e.mn         : 0,
    beat:       typeof e.beat       === 'number'  ? e.beat       : 0,
    volta:      typeof e.volta      === 'number'  ? e.volta      : null,
    numeral:    typeof e.numeral    === 'string'  ? e.numeral    : null,
    applied_to: typeof e.applied_to === 'string'  ? e.applied_to : null,
    local_key:  typeof e.local_key  === 'string'  ? e.local_key  : null,
    reviewed:   typeof e.reviewed   === 'boolean' ? e.reviewed   : null,
  };
}

function harmonyChordLabel(e: HarmonyRow): string {
  const parts: string[] = [];
  if (e.numeral) parts.push(e.numeral);
  if (e.applied_to) parts.push(`/${e.applied_to}`);
  if (e.local_key) parts.push(`(${e.local_key})`);
  return parts.join(' ') || '—';
}

function harmonyPositionLabel(e: HarmonyRow): string {
  const v = e.volta != null ? `v${e.volta}` : '';
  const b = e.beat % 1 === 0 ? String(e.beat) : e.beat.toFixed(2).replace(/\.?0+$/, '');
  return `m.${e.mn}${v} b${b}`;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<FragmentDetailResponse['status'], string> = {
  draft:     'Draft',
  submitted: 'In Review',
  approved:  'Approved',
  rejected:  'Rejected',
};

function statusClass(status: FragmentDetailResponse['status']): string {
  switch (status) {
    case 'draft':     return styles.statusDraft;
    case 'submitted': return styles.statusSubmitted;
    case 'approved':  return styles.statusApproved;
    case 'rejected':  return styles.statusRejected;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FragmentDetailPanelProps {
  /** UUID of the fragment to display. Changes trigger a fresh fetch. */
  fragmentId: string;
  /** Called when the close button is activated. */
  onClose: () => void;
  /**
   * Called when Edit is activated. ScoreViewer receives the full fragment
   * detail and restores it into the tagging form.
   */
  onEdit: (fragment: FragmentDetailResponse) => void;
  /**
   * Called after a successful delete. ScoreViewer closes the panel and
   * refreshes the stored-fragment overlay.
   */
  onDeleteDone: (fragmentId: string) => void;
  /**
   * Called after a successful approve or reject. ScoreViewer refreshes the
   * stored-fragment overlay so the bracket status colour updates immediately.
   * The panel stays open and reflects the new status in the header badge.
   */
  onReviewDone?: (fragmentId: string) => void;
  /**
   * Current viewer mode. Edit and Delete are only shown in tag mode
   * (read-only panel in view mode per tagging-tool-design.md §Step 12).
   * Approve / Reject are shown in both modes for submitted fragments.
   */
  tagMode: 'view' | 'tag';
  /** Test hook. Defaults to 'fragment-detail-panel'. */
  'data-testid'?: string;
}

// ---------------------------------------------------------------------------
// Delete state
// ---------------------------------------------------------------------------

type DeleteState = 'idle' | 'confirming' | 'deleting';

// ---------------------------------------------------------------------------
// Review state (Component 7 Step 14)
// ---------------------------------------------------------------------------

type ReviewPhase =
  | 'idle'              // Approve + Reject buttons visible
  | 'rejecting'         // Reject comment textarea visible
  | 'approving'         // Approve API call in flight
  | 'rejecting-sending' // Reject API call in flight
  | 'gate-failed';      // 422 HARMONY_NOT_REVIEWED received; gate detail shown

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function FragmentDetailPanel({
  fragmentId,
  onClose,
  onEdit,
  onDeleteDone,
  onReviewDone,
  tagMode,
  'data-testid': testId,
}: FragmentDetailPanelProps) {
  const { width: panelWidth, onMouseDown: onHandleMouseDown } = usePanelResize();

  // ── Data state ─────────────────────────────────────────────────────────────
  const [fragment, setFragment] = useState<FragmentDetailResponse | null>(null);
  const [schemas, setSchemas] = useState<PropertySchema[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── Delete state ───────────────────────────────────────────────────────────
  const [deleteState, setDeleteState] = useState<DeleteState>('idle');
  const [deleteError, setDeleteError] = useState<string | null>(null);

  // ── Review state (Step 14) ─────────────────────────────────────────────────
  const [reviewPhase, setReviewPhase] = useState<ReviewPhase>('idle');
  const [rejectComment, setRejectComment] = useState('');
  const [gateDetail, setGateDetail] = useState<ApprovalGateDetail | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const harmonySectionRef = useRef<HTMLElement | null>(null);

  // ── Fetch on fragmentId change ─────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setFragment(null);
    setSchemas(null);
    setDeleteState('idle');
    setDeleteError(null);
    setReviewPhase('idle');
    setRejectComment('');
    setGateDetail(null);
    setReviewError(null);

    (async () => {
      try {
        const frag = await getFragment(fragmentId);
        if (cancelled) return;
        setFragment(frag);

        // Fetch schema for property label resolution — non-fatal if it fails.
        const primary = frag.concept_tags.find(t => t.is_primary);
        if (primary) {
          try {
            const tree = await getConceptSchemas(primary.concept_id);
            if (!cancelled) setSchemas(tree.schemas);
          } catch {
            // Fall back to raw schema IDs for property display.
          }
        }
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof ApiError ? err.message : 'Failed to load fragment.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [fragmentId]);

  // ── Delete handlers ────────────────────────────────────────────────────────

  const handleDeleteClick = useCallback(() => {
    setDeleteState('confirming');
    setDeleteError(null);
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!fragment) return;
    setDeleteState('deleting');
    setDeleteError(null);
    try {
      // confirmCascade=true when the fragment has sub-parts; the server requires
      // it to authorise the cascade (fragment-schema.md § "Delete Permissions").
      await deleteFragment(fragment.id, fragment.sub_parts.length > 0);
      onDeleteDone(fragment.id);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : 'Failed to delete fragment.');
      setDeleteState('idle');
    }
  }, [fragment, onDeleteDone]);

  const handleDeleteCancel = useCallback(() => {
    setDeleteState('idle');
    setDeleteError(null);
  }, []);

  // ── Review handlers (Step 14) ──────────────────────────────────────────────

  const runApprove = useCallback(async () => {
    if (!fragment) return;
    setGateDetail(null);
    setReviewError(null);
    setReviewPhase('approving');
    try {
      const result = await approveFragment(fragment.id);
      setFragment(prev =>
        prev ? { ...prev, status: result.status as FragmentDetailResponse['status'] } : prev,
      );
      setReviewPhase('idle');
      onReviewDone?.(fragment.id);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'HARMONY_NOT_REVIEWED') {
        setGateDetail(err.detail as ApprovalGateDetail);
        setReviewPhase('gate-failed');
        // Scroll the harmony events section into view so the reviewer can
        // see which events are blocking — the section is already visible in
        // the panel but may be scrolled out of sight on narrow heights.
        harmonySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      } else {
        setReviewError(
          err instanceof ApiError ? err.message : 'Failed to record approval.',
        );
        setReviewPhase('idle');
      }
    }
  }, [fragment, onReviewDone]);

  const handleRejectClick = useCallback(() => {
    setReviewPhase('rejecting');
    setReviewError(null);
    setRejectComment('');
  }, []);

  const handleRejectSubmit = useCallback(async () => {
    if (!fragment) return;
    setReviewPhase('rejecting-sending');
    try {
      const result = await rejectFragment(fragment.id, rejectComment || undefined);
      setFragment(prev =>
        prev ? { ...prev, status: result.status as FragmentDetailResponse['status'] } : prev,
      );
      setReviewPhase('idle');
      onReviewDone?.(fragment.id);
    } catch (err) {
      setReviewError(
        err instanceof ApiError ? err.message : 'Failed to record rejection.',
      );
      setReviewPhase('rejecting');
    }
  }, [fragment, rejectComment, onReviewDone]);

  const handleRejectCancel = useCallback(() => {
    setReviewPhase('idle');
    setRejectComment('');
    setReviewError(null);
  }, []);

  const handleGateBack = useCallback(() => {
    setGateDetail(null);
    setReviewPhase('idle');
  }, []);

  // ── Derived display values ─────────────────────────────────────────────────

  const primaryTag = fragment?.concept_tags.find(t => t.is_primary);
  const summary = fragment && isSummaryV1(fragment.summary) ? fragment.summary : null;

  // Map schema id → human name; falls back to the raw id when schemas unavailable.
  const schemaMap = new Map(schemas?.map(s => [s.id, s.name]) ?? []);

  const harmonyRows = (fragment?.harmony_events ?? []).map(
    e => toHarmonyRow(e as Record<string, unknown>),
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <aside
      className={styles.panel}
      style={{ width: panelWidth }}
      aria-label="Fragment details"
      data-testid={testId ?? 'fragment-detail-panel'}
    >
      {/* Resize handle (left edge, same as FormPanel G6.1) */}
      <div
        className={styles.resizeHandle}
        onMouseDown={onHandleMouseDown}
        aria-hidden="true"
      />

      {/* ── Loading ──────────────────────────────────────────────────────── */}
      {loading && (
        <div className={styles.stateContainer}>
          <Type variant="label-md" as="p" className={styles.stateText}>Loading…</Type>
        </div>
      )}

      {/* ── Load error ───────────────────────────────────────────────────── */}
      {!loading && loadError && (
        <div className={styles.stateContainer}>
          <Type variant="body-sm" as="p" className={styles.errorText}>{loadError}</Type>
          <button type="button" className={styles.closeInlineButton} onClick={onClose}>
            <Type variant="label-sm" as="span">Close</Type>
          </button>
        </div>
      )}

      {/* ── Fragment content ─────────────────────────────────────────────── */}
      {!loading && !loadError && fragment && (
        <>
          {/* ── Header: status + concept name + close ──────────────────── */}
          <header className={styles.header}>
            <div className={styles.headerMeta}>
              <span className={`${styles.statusBadge} ${statusClass(fragment.status)}`}>
                <Type variant="label-sm" as="span">{STATUS_LABELS[fragment.status]}</Type>
              </span>
              {primaryTag && (
                <Type variant="title" as="h2" className={styles.conceptName}>
                  {primaryTag.name}
                </Type>
              )}
              {primaryTag && primaryTag.hierarchy_path.length > 0 && (
                <Type variant="label-sm" as="p" className={styles.hierarchyPath}>
                  {primaryTag.hierarchy_path.join(' › ')}
                </Type>
              )}
            </div>
            <button
              type="button"
              className={styles.closeButton}
              onClick={onClose}
              aria-label="Close fragment panel"
            >
              ×
            </button>
          </header>

          {/* ── Range ──────────────────────────────────────────────────── */}
          <section className={styles.section}>
            <Type variant="label-sm" as="h3" className={styles.sectionHeading}>Range</Type>
            <Type variant="body-sm" as="p" className={styles.rangeText}>
              {fragment.bar_start === fragment.bar_end
                ? `Bar ${fragment.bar_start}`
                : `Bars ${fragment.bar_start}–${fragment.bar_end}`}
              {fragment.beat_start !== null && (
                <span className={styles.beatRange}>
                  {' '}(beat {fragment.beat_start}
                  {fragment.beat_end !== null ? `–${fragment.beat_end}` : ''})
                </span>
              )}
            </Type>
            {fragment.repeat_context && (
              <Type variant="label-sm" as="p" className={styles.repeatContext}>
                Repeat context: {fragment.repeat_context}
              </Type>
            )}
          </section>

          {/* ── Summary ────────────────────────────────────────────────── */}
          {summary && (
            <section className={styles.section}>
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>Summary</Type>
              <dl className={styles.dataList}>
                <div className={styles.dataRow}>
                  <dt><Type variant="label-sm" as="span">Key</Type></dt>
                  <dd><Type variant="body-sm" as="span">{summary.key}</Type></dd>
                </div>
                <div className={styles.dataRow}>
                  <dt><Type variant="label-sm" as="span">Meter</Type></dt>
                  <dd><Type variant="body-sm" as="span">{summary.meter}</Type></dd>
                </div>
                {summary.actual_key != null && (
                  <div className={styles.dataRow}>
                    <dt><Type variant="label-sm" as="span">Actual key</Type></dt>
                    <dd>
                      <Type variant="body-sm" as="span">{summary.actual_key.value}</Type>
                      {summary.actual_key.reviewed
                        ? <span className={styles.reviewedMark} aria-label="reviewed"> ✓</span>
                        : <span className={styles.unreviewedMark} aria-label="unreviewed"> (unreviewed)</span>
                      }
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {/* ── Properties ─────────────────────────────────────────────── */}
          {summary?.properties && Object.keys(summary.properties).length > 0 && (
            <section className={styles.section}>
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>Properties</Type>
              <dl className={styles.dataList}>
                {Object.entries(summary.properties).map(([id, val]) => (
                  <div key={id} className={styles.dataRow}>
                    <dt>
                      <Type variant="label-sm" as="span">
                        {schemaMap.get(id) ?? id}
                      </Type>
                    </dt>
                    <dd>
                      <Type variant="body-sm" as="span">
                        {Array.isArray(val)
                          ? val.join(', ')
                          : val === 'true' ? 'Yes' : val === 'false' ? 'No' : val
                        }
                      </Type>
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          )}

          {/* ── Harmony events ─────────────────────────────────────────── */}
          {harmonyRows.length > 0 && (
            <section
              className={styles.section}
              ref={harmonySectionRef as React.RefObject<HTMLElement>}
            >
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>
                Harmony ({harmonyRows.length})
              </Type>
              <ol className={styles.harmonyList}>
                {harmonyRows.map((row, i) => (
                  <li key={i} className={styles.harmonyEvent}>
                    <span className={styles.harmonyPosition}>
                      <Type variant="label-sm" as="span">{harmonyPositionLabel(row)}</Type>
                    </span>
                    <span className={styles.harmonyChord}>
                      <Type variant="body-sm" as="span">{harmonyChordLabel(row)}</Type>
                    </span>
                    {row.reviewed !== null && (
                      <span
                        className={row.reviewed ? styles.reviewedMark : styles.unreviewedMark}
                        aria-label={row.reviewed ? 'reviewed' : 'unreviewed'}
                      >
                        <Type variant="label-sm" as="span">
                          {row.reviewed ? '✓' : '○'}
                        </Type>
                      </span>
                    )}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* ── Prose annotation ───────────────────────────────────────── */}
          {fragment.prose_annotation && (
            <section className={styles.section}>
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>Commentary</Type>
              <Type variant="body-sm" as="p" className={styles.proseText}>
                {fragment.prose_annotation}
              </Type>
            </section>
          )}

          {/* ── Sub-parts ──────────────────────────────────────────────── */}
          {fragment.sub_parts.length > 0 && (
            <section className={styles.section}>
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>
                Sub-parts ({fragment.sub_parts.length})
              </Type>
              <ol className={styles.subPartsList}>
                {fragment.sub_parts.map(sp => {
                  const spPrimary = sp.concept_tags.find(t => t.is_primary);
                  return (
                    <li key={sp.id} className={styles.subPartItem}>
                      <Type variant="label-sm" as="span" className={styles.subPartName}>
                        {spPrimary?.name ?? 'Sub-part'}
                      </Type>
                      <Type variant="body-sm" as="span" className={styles.subPartRange}>
                        {' bars '}
                        {sp.bar_start === sp.bar_end
                          ? sp.bar_start
                          : `${sp.bar_start}–${sp.bar_end}`
                        }
                        {sp.beat_start !== null && (
                          ` (b${sp.beat_start}${sp.beat_end !== null ? `–${sp.beat_end}` : ''})`
                        )}
                      </Type>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {/* ── Review actions (Step 14) — shown for submitted fragments ── */}
          {fragment.status === 'submitted' && reviewPhase !== 'gate-failed' && (
            <div className={styles.reviewSection}>
              <Type variant="label-sm" as="h3" className={styles.reviewHeading}>
                Review
              </Type>

              {/* Approve / Reject buttons */}
              {(reviewPhase === 'idle' || reviewPhase === 'approving') && (
                <>
                  <div className={styles.reviewActions}>
                    <button
                      type="button"
                      className={styles.approveButton}
                      onClick={runApprove}
                      disabled={reviewPhase === 'approving'}
                    >
                      <Type variant="label-sm" as="span">
                        {reviewPhase === 'approving' ? 'Approving…' : 'Approve'}
                      </Type>
                    </button>
                    <button
                      type="button"
                      className={styles.rejectOpenButton}
                      onClick={handleRejectClick}
                      disabled={reviewPhase === 'approving'}
                    >
                      <Type variant="label-sm" as="span">Reject</Type>
                    </button>
                  </div>
                  {reviewError && (
                    <Type variant="label-sm" as="p" className={styles.reviewErrorText}>
                      {reviewError}
                    </Type>
                  )}
                </>
              )}

              {/* Reject comment form */}
              {(reviewPhase === 'rejecting' || reviewPhase === 'rejecting-sending') && (
                <>
                  <textarea
                    className={styles.rejectTextarea}
                    value={rejectComment}
                    onChange={e => setRejectComment(e.target.value)}
                    placeholder="Reason for rejection (optional)"
                    rows={3}
                    disabled={reviewPhase === 'rejecting-sending'}
                    aria-label="Rejection reason"
                  />
                  {reviewError && (
                    <Type variant="label-sm" as="p" className={styles.reviewErrorText}>
                      {reviewError}
                    </Type>
                  )}
                  <div className={styles.reviewActions}>
                    <button
                      type="button"
                      className={styles.rejectSendButton}
                      onClick={handleRejectSubmit}
                      disabled={reviewPhase === 'rejecting-sending'}
                    >
                      <Type variant="label-sm" as="span">
                        {reviewPhase === 'rejecting-sending' ? 'Sending…' : 'Send rejection'}
                      </Type>
                    </button>
                    <button
                      type="button"
                      className={styles.cancelButton}
                      onClick={handleRejectCancel}
                      disabled={reviewPhase === 'rejecting-sending'}
                    >
                      <Type variant="label-sm" as="span">Cancel</Type>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Approval gate failure (Step 14) ───────────────────────────── */}
          {fragment.status === 'submitted' && reviewPhase === 'gate-failed' && gateDetail && (
            <div className={styles.gateFailed}>
              <Type variant="label-sm" as="p" className={styles.gateFailedIntro}>
                Approval gate: the items below must be confirmed before approval
                can complete. Your approval vote has been recorded — fix the
                items and try again.
              </Type>

              {gateDetail.unreviewed_actual_key && (
                <div className={styles.gateItem}>
                  <Type variant="label-sm" as="span" className={styles.gateItemLabel}>
                    Actual key:
                  </Type>
                  <Type variant="body-sm" as="span">
                    {gateDetail.unreviewed_actual_key.value} — not confirmed.
                    Confirm it via the Harmony Panel.
                  </Type>
                </div>
              )}

              {gateDetail.unreviewed_harmony_events &&
                gateDetail.unreviewed_harmony_events.length > 0 && (
                  <>
                    <Type variant="label-sm" as="p" className={styles.gateItemLabel}>
                      Unconfirmed harmony events (confirm via Harmony Panel in Tag mode):
                    </Type>
                    <ol className={styles.gateEventList}>
                      {gateDetail.unreviewed_harmony_events.map((ev, i) => {
                        const row = toHarmonyRow(ev as Record<string, unknown>);
                        return (
                          <li key={i} className={styles.gateEventItem}>
                            <Type variant="label-sm" as="span" className={styles.harmonyPosition}>
                              {harmonyPositionLabel(row)}
                            </Type>
                            <Type variant="body-sm" as="span">
                              {harmonyChordLabel(row)}
                            </Type>
                          </li>
                        );
                      })}
                    </ol>
                    <Type variant="label-sm" as="p" className={styles.gateNote}>
                      Confirming a harmony event applies to the whole movement,
                      not just this fragment.
                    </Type>
                  </>
                )}

              <div className={styles.reviewActions}>
                <button
                  type="button"
                  className={styles.approveButton}
                  onClick={runApprove}
                >
                  <Type variant="label-sm" as="span">Try again</Type>
                </button>
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={handleGateBack}
                >
                  <Type variant="label-sm" as="span">Back</Type>
                </button>
              </div>
            </div>
          )}

          {/* ── Delete confirmation (inline) ───────────────────────────── */}
          {deleteState === 'confirming' && (
            <div className={styles.deleteConfirm}>
              <Type variant="body-sm" as="p" className={styles.deleteConfirmText}>
                {fragment.sub_parts.length > 0
                  ? `Delete this fragment and its ${fragment.sub_parts.length} sub-part${
                      fragment.sub_parts.length === 1 ? '' : 's'
                    }? This cannot be undone.`
                  : 'Delete this fragment? This cannot be undone.'
                }
              </Type>
              {deleteError && (
                <Type variant="label-sm" as="p" className={styles.deleteErrorText}>
                  {deleteError}
                </Type>
              )}
              <div className={styles.confirmActions}>
                <button
                  type="button"
                  className={styles.confirmDeleteButton}
                  onClick={handleDeleteConfirm}
                >
                  <Type variant="label-sm" as="span">Confirm delete</Type>
                </button>
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={handleDeleteCancel}
                >
                  <Type variant="label-sm" as="span">Cancel</Type>
                </button>
              </div>
            </div>
          )}

          {deleteState === 'deleting' && (
            <div className={styles.deleteConfirm}>
              <Type variant="label-sm" as="p" className={styles.stateText}>Deleting…</Type>
            </div>
          )}

          {/* ── Footer: Edit + Delete (tag mode only; hidden while confirming) */}
          {tagMode === 'tag' && deleteState === 'idle' && (
            <footer className={styles.footer}>
              <button
                type="button"
                className={styles.editButton}
                onClick={() => onEdit(fragment)}
              >
                <Type variant="label-sm" as="span">Edit</Type>
              </button>
              <button
                type="button"
                className={styles.deleteButton}
                onClick={handleDeleteClick}
              >
                <Type variant="label-sm" as="span">Delete</Type>
              </button>
            </footer>
          )}
        </>
      )}
    </aside>
  );
}
