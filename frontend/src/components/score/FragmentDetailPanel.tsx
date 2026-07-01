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
import { useTranslation } from 'react-i18next';
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
import { formatFragmentRange, formatBeat } from '../../utils/fragmentRange';
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

function isSummaryV1(s: unknown): s is SummaryV1 {
  if (typeof s !== 'object' || s === null) return false;
  const r = s as Record<string, unknown>;
  return r['version'] === 1 && typeof r['key'] === 'string' && typeof r['meter'] === 'string';
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
  /** Component 6 deferral: null for DCML-sourced events until music21 top-up pass. */
  bass_pitch: string | null;
  soprano_pitch: string | null;
}

function toHarmonyRow(e: Record<string, unknown>): HarmonyRow {
  return {
    mn:            typeof e.mn            === 'number'  ? e.mn            : 0,
    beat:          typeof e.beat          === 'number'  ? e.beat          : 0,
    volta:         typeof e.volta         === 'number'  ? e.volta         : null,
    numeral:       typeof e.numeral       === 'string'  ? e.numeral       : null,
    applied_to:    typeof e.applied_to    === 'string'  ? e.applied_to    : null,
    local_key:     typeof e.local_key     === 'string'  ? e.local_key     : null,
    reviewed:      typeof e.reviewed      === 'boolean' ? e.reviewed      : null,
    bass_pitch:    typeof e.bass_pitch    === 'string'  ? e.bass_pitch    : null,
    soprano_pitch: typeof e.soprano_pitch === 'string'  ? e.soprano_pitch : null,
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
  return `m.${e.mn}${v} b${formatBeat(e.beat)}`;
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

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
  /**
   * Called when the close button is activated (panel mode only).
   * Optional — not used in standalone mode.
   */
  onClose?: () => void;
  /**
   * Called when Edit is activated (panel mode only). ScoreViewer receives the
   * full fragment detail and restores it into the tagging form.
   * Optional — not used in standalone mode.
   */
  onEdit?: (fragment: FragmentDetailResponse) => void;
  /**
   * Called after a successful delete (panel mode only). ScoreViewer closes
   * the panel and refreshes the stored-fragment overlay.
   * Optional — not used in standalone mode.
   */
  onDeleteDone?: (fragmentId: string) => void;
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
   * Irrelevant in standalone mode (all actions are hidden).
   */
  tagMode: 'view' | 'tag';
  /** Test hook. Defaults to 'fragment-detail-panel'. */
  'data-testid'?: string;
  /**
   * When true, render as an inline record section without panel chrome,
   * close button, or action buttons. Used by the Fragment Detail page
   * (Component 8 Step 12) to embed the record below the Verovio render.
   */
  standalone?: boolean;
  /**
   * Pre-fetched fragment data. When provided alongside ``standalone=true``,
   * the internal ``getFragment`` call is skipped; only ``getConceptSchemas``
   * is fetched to resolve property schema names for display.
   */
  initialFragment?: FragmentDetailResponse;
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
  standalone = false,
  initialFragment,
}: FragmentDetailPanelProps) {
  const { t } = useTranslation(['score', 'common']);
  const { width: panelWidth, onMouseDown: onHandleMouseDown } = usePanelResize();

  // ── Data state ─────────────────────────────────────────────────────────────
  // Pre-seed from initialFragment when in standalone mode to avoid a duplicate
  // getFragment fetch (the detail page already has the data).
  const [fragment, setFragment] = useState<FragmentDetailResponse | null>(
    standalone && initialFragment ? initialFragment : null,
  );
  const [schemas, setSchemas] = useState<PropertySchema[] | null>(null);
  const [loading, setLoading] = useState(!(standalone && initialFragment));
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

    // In standalone mode with a pre-fetched fragment, skip the getFragment
    // call entirely.  Only reset non-data state so the schema fetch still runs.
    if (standalone && initialFragment) {
      setFragment(initialFragment);
      setSchemas(null);
      setLoading(true);

      const primary = initialFragment.concept_tags.find(tag => tag.is_primary);
      if (primary) {
        getConceptSchemas(primary.concept_id)
          .then(tree => { if (!cancelled) setSchemas(tree.schemas); })
          .catch(() => { /* fall back to raw schema IDs */ })
          .finally(() => { if (!cancelled) setLoading(false); });
      } else {
        setLoading(false);
      }

      return () => { cancelled = true; };
    }

    // Panel mode: full fetch.
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
        const primary = frag.concept_tags.find(tag => tag.is_primary);
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
          setLoadError(err instanceof ApiError ? err.message : t('score:detailPanel.loadError'));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  // standalone and initialFragment are intentionally excluded from deps:
  // we only re-run when fragmentId changes (standalone props don't change).
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      onDeleteDone?.(fragment.id);
    } catch (err) {
      setDeleteError(err instanceof ApiError ? err.message : t('score:detailPanel.deleteError'));
      setDeleteState('idle');
    }
  }, [fragment, onDeleteDone, t]);

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
          err instanceof ApiError ? err.message : t('score:detailPanel.approvalError'),
        );
        setReviewPhase('idle');
      }
    }
  }, [fragment, onReviewDone, t]);

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
        err instanceof ApiError ? err.message : t('score:detailPanel.rejectionError'),
      );
      setReviewPhase('rejecting');
    }
  }, [fragment, rejectComment, onReviewDone, t]);

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

  const primaryTag = fragment?.concept_tags.find(tag => tag.is_primary);
  const summary = fragment && isSummaryV1(fragment.summary) ? fragment.summary : null;

  // Map schema id → human name; falls back to the raw id when schemas unavailable.
  const schemaMap = new Map(schemas?.map(s => [s.id, s.name]) ?? []);

  const harmonyRows = (fragment?.harmony_events ?? []).map(
    e => toHarmonyRow(e as Record<string, unknown>),
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  const Wrapper = standalone ? 'div' : 'aside';

  return (
    <Wrapper
      className={standalone ? styles.standaloneRecord : styles.panel}
      style={standalone ? undefined : { width: panelWidth }}
      aria-label={t('score:detailPanel.fragmentDetailsAria')}
      data-testid={testId ?? 'fragment-detail-panel'}
    >
      {/* Resize handle — panel mode only */}
      {!standalone && (
        <div
          className={styles.resizeHandle}
          onMouseDown={onHandleMouseDown}
          aria-hidden="true"
        />
      )}

      {/* ── Loading ──────────────────────────────────────────────────────── */}
      {loading && (
        <div className={styles.stateContainer}>
          <Type variant="label-md" as="p" className={styles.stateText}>{t('common:loading')}</Type>
        </div>
      )}

      {/* ── Load error ───────────────────────────────────────────────────── */}
      {!loading && loadError && (
        <div className={styles.stateContainer}>
          <Type variant="body-sm" as="p" className={styles.errorText}>{loadError}</Type>
          {onClose && (
            <button type="button" className={styles.closeInlineButton} onClick={onClose}>
              <Type variant="label-sm" as="span">{t('common:close')}</Type>
            </button>
          )}
        </div>
      )}

      {/* ── Fragment content ─────────────────────────────────────────────── */}
      {!loading && !loadError && fragment && (
        <>
          {/* ── Header: status + concept name + close (panel mode only) ── */}
          {!standalone && (
            <header className={styles.header}>
              <div className={styles.headerMeta}>
                <span className={`${styles.statusBadge} ${statusClass(fragment.status)}`}>
                  <Type variant="label-sm" as="span">{t(`score:detailPanel.status.${fragment.status}`)}</Type>
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
                aria-label={t('score:detailPanel.closePanelAria')}
              >
                ×
              </button>
            </header>
          )}

          {/* ── Range (panel mode only — already shown in detail page header) */}
          {!standalone && (
            <section className={styles.section}>
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>{t('score:detailPanel.sectionRange')}</Type>
              {/* Measure/beat display rule (Component 9 Step 15): beats render
                  only within their measure's context, and not at all when the
                  fragment spans complete measures. */}
              <Type variant="body-sm" as="p" className={styles.rangeText}>
                {formatFragmentRange(
                  fragment.bar_start, fragment.bar_end,
                  fragment.beat_start, fragment.beat_end,
                )}
              </Type>
              {fragment.repeat_context && (
                <Type variant="label-sm" as="p" className={styles.repeatContext}>
                  {t('score:detailPanel.repeatContext', { context: fragment.repeat_context })}
                </Type>
              )}
            </section>
          )}

          {/* ── Summary ────────────────────────────────────────────────── */}
          {summary && (
            <section className={styles.section}>
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>{t('score:detailPanel.sectionSummary')}</Type>
              <dl className={styles.dataList}>
                <div className={styles.dataRow}>
                  <dt><Type variant="label-sm" as="span">{t('score:detailPanel.key')}</Type></dt>
                  <dd><Type variant="body-sm" as="span">{summary.key}</Type></dd>
                </div>
                <div className={styles.dataRow}>
                  <dt><Type variant="label-sm" as="span">{t('score:detailPanel.meter')}</Type></dt>
                  <dd><Type variant="body-sm" as="span">{summary.meter}</Type></dd>
                </div>
                {summary.actual_key != null && (
                  <div className={styles.dataRow}>
                    <dt><Type variant="label-sm" as="span">{t('score:detailPanel.actualKey')}</Type></dt>
                    <dd>
                      <Type variant="body-sm" as="span">{summary.actual_key.value}</Type>
                      {summary.actual_key.reviewed
                        ? <span className={styles.reviewedMark} aria-label={t('score:detailPanel.reviewedAria')}> ✓</span>
                        : <span className={styles.unreviewedMark} aria-label={t('score:detailPanel.unreviewedAria')}>{t('score:detailPanel.unreviewedMark')}</span>
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
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>{t('score:detailPanel.sectionProperties')}</Type>
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
                          : val === 'true' ? t('common:yes') : val === 'false' ? t('common:no') : val
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
                {t('score:detailPanel.harmonyCount', { count: harmonyRows.length })}
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
                        aria-label={row.reviewed ? t('score:detailPanel.reviewedAria') : t('score:detailPanel.unreviewedAria')}
                      >
                        <Type variant="label-sm" as="span">
                          {row.reviewed ? '✓' : '○'}
                        </Type>
                      </span>
                    )}
                    {/* Bass / soprano pitch (Component 6 deferral: null until
                        music21 auto-analysis top-up pass is implemented). */}
                    <span className={styles.harmonyPitches}>
                      <Type variant="label-sm" as="span">
                        {row.bass_pitch ?? '—'} / {row.soprano_pitch ?? '—'}
                      </Type>
                    </span>
                  </li>
                ))}
              </ol>
            </section>
          )}

          {/* ── Prose annotation ───────────────────────────────────────── */}
          {fragment.prose_annotation && (
            <section className={styles.section}>
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>{t('score:detailPanel.sectionCommentary')}</Type>
              <Type variant="body-sm" as="p" className={styles.proseText}>
                {fragment.prose_annotation}
              </Type>
            </section>
          )}

          {/* ── Sub-parts ──────────────────────────────────────────────── */}
          {fragment.sub_parts.length > 0 && (
            <section className={styles.section}>
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>
                {t('score:detailPanel.subPartsCount', { count: fragment.sub_parts.length })}
              </Type>
              <ol className={styles.subPartsList}>
                {fragment.sub_parts.map(sp => {
                  const spPrimary = sp.concept_tags.find(tag => tag.is_primary);
                  return (
                    <li key={sp.id} className={styles.subPartItem}>
                      <Type variant="label-sm" as="span" className={styles.subPartName}>
                        {spPrimary?.name ?? t('score:detailPanel.subPartFallback')}
                      </Type>
                      <Type variant="body-sm" as="span" className={styles.subPartRange}>
                        {' '}
                        {formatFragmentRange(
                          sp.bar_start, sp.bar_end,
                          sp.beat_start, sp.beat_end,
                        )}
                      </Type>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {/* ── Data licence / harmony sources (ADR-009, Component 8 Step 12) ─
              Panel mode only: the detail page (standalone) already groups
              source + licence in its header (Component 9 Step 15). */}
          {!standalone && (fragment.data_licence || fragment.harmony_sources.length > 0) && (
            <section className={styles.section}>
              <Type variant="label-sm" as="h3" className={styles.sectionHeading}>
                {t('score:detailPanel.dataLicence')}
              </Type>
              {fragment.data_licence && (
                <Type variant="body-sm" as="p" className={styles.licenceText}>
                  {fragment.data_licence_url ? (
                    <a href={fragment.data_licence_url} target="_blank" rel="noreferrer">
                      {fragment.data_licence}
                    </a>
                  ) : (
                    fragment.data_licence
                  )}
                </Type>
              )}
              {fragment.harmony_sources.length > 0 && (
                <ul className={styles.sourcesList}>
                  {fragment.harmony_sources.map(src => (
                    <li key={src} className={styles.sourceChip}>
                      <Type variant="label-sm" as="span">{src}</Type>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── Review actions (Step 14) — shown for submitted fragments (panel only) */}
          {!standalone && fragment.status === 'submitted' && reviewPhase !== 'gate-failed' && (
            <div className={styles.reviewSection}>
              <Type variant="label-sm" as="h3" className={styles.reviewHeading}>
                {t('score:detailPanel.sectionReview')}
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
                        {reviewPhase === 'approving' ? t('score:detailPanel.approving') : t('score:detailPanel.approve')}
                      </Type>
                    </button>
                    <button
                      type="button"
                      className={styles.rejectOpenButton}
                      onClick={handleRejectClick}
                      disabled={reviewPhase === 'approving'}
                    >
                      <Type variant="label-sm" as="span">{t('score:detailPanel.reject')}</Type>
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
                    placeholder={t('score:detailPanel.rejectPlaceholder')}
                    rows={3}
                    disabled={reviewPhase === 'rejecting-sending'}
                    aria-label={t('score:detailPanel.rejectionReasonAria')}
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
                        {reviewPhase === 'rejecting-sending' ? t('score:detailPanel.sending') : t('score:detailPanel.sendRejection')}
                      </Type>
                    </button>
                    <button
                      type="button"
                      className={styles.cancelButton}
                      onClick={handleRejectCancel}
                      disabled={reviewPhase === 'rejecting-sending'}
                    >
                      <Type variant="label-sm" as="span">{t('common:cancel')}</Type>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* ── Approval gate failure (Step 14, panel only) ───────────────── */}
          {!standalone && fragment.status === 'submitted' && reviewPhase === 'gate-failed' && gateDetail && (
            <div className={styles.gateFailed}>
              <Type variant="label-sm" as="p" className={styles.gateFailedIntro}>
                {t('score:detailPanel.gateIntro')}
              </Type>

              {gateDetail.unreviewed_actual_key && (
                <div className={styles.gateItem}>
                  <Type variant="label-sm" as="span" className={styles.gateItemLabel}>
                    {t('score:detailPanel.gateActualKey')}
                  </Type>
                  <Type variant="body-sm" as="span">
                    {t('score:detailPanel.gateActualKeyDetail', {
                      value: gateDetail.unreviewed_actual_key.value,
                    })}
                  </Type>
                </div>
              )}

              {gateDetail.unreviewed_harmony_events &&
                gateDetail.unreviewed_harmony_events.length > 0 && (
                  <>
                    <Type variant="label-sm" as="p" className={styles.gateItemLabel}>
                      {t('score:detailPanel.gateUnconfirmedEvents')}
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
                      {t('score:detailPanel.gateNote')}
                    </Type>
                  </>
                )}

              <div className={styles.reviewActions}>
                <button
                  type="button"
                  className={styles.approveButton}
                  onClick={runApprove}
                >
                  <Type variant="label-sm" as="span">{t('score:detailPanel.tryAgain')}</Type>
                </button>
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={handleGateBack}
                >
                  <Type variant="label-sm" as="span">{t('common:back')}</Type>
                </button>
              </div>
            </div>
          )}

          {/* ── Delete confirmation (panel only) ──────────────────────────── */}
          {!standalone && deleteState === 'confirming' && (
            <div className={styles.deleteConfirm}>
              <Type variant="body-sm" as="p" className={styles.deleteConfirmText}>
                {fragment.sub_parts.length > 0
                  ? t('score:detailPanel.deleteConfirmWithSubparts', {
                      count: fragment.sub_parts.length,
                    })
                  : t('score:detailPanel.deleteConfirm')}
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
                  <Type variant="label-sm" as="span">{t('score:detailPanel.confirmDelete')}</Type>
                </button>
                <button
                  type="button"
                  className={styles.cancelButton}
                  onClick={handleDeleteCancel}
                >
                  <Type variant="label-sm" as="span">{t('common:cancel')}</Type>
                </button>
              </div>
            </div>
          )}

          {!standalone && deleteState === 'deleting' && (
            <div className={styles.deleteConfirm}>
              <Type variant="label-sm" as="p" className={styles.stateText}>{t('score:detailPanel.deleting')}</Type>
            </div>
          )}

          {/* ── Footer: Edit + Delete (tag mode only; panel only) ─────────── */}
          {!standalone && tagMode === 'tag' && deleteState === 'idle' && (
            <footer className={styles.footer}>
              <button
                type="button"
                className={styles.editButton}
                onClick={() => onEdit?.(fragment)}
              >
                <Type variant="label-sm" as="span">{t('common:edit')}</Type>
              </button>
              <button
                type="button"
                className={styles.deleteButton}
                onClick={handleDeleteClick}
              >
                <Type variant="label-sm" as="span">{t('common:delete')}</Type>
              </button>
            </footer>
          )}
        </>
      )}
    </Wrapper>
  );
}
