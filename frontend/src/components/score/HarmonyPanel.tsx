/**
 * Harmony summary panel — Component 5 Step 16, clarified in Component 7 Step 15 (G6.2).
 *
 * Reads movement_analysis events for the committed selection range and lets
 * the annotator confirm, edit, insert, and delete harmony events. Visible
 * once a selection has been drawn (fragmentSet = true).
 *
 * Display (G6.2):
 *   - Events grouped by measure (mn, volta) for scannability.
 *   - Each card leads with the human label (numeral + local_key); root/quality/
 *     inversion appear as secondary detail below.
 *   - Review status (source + unreviewed warning) is visible but visually quiet.
 *   - bass_pitch / soprano_pitch are null for the DCML corpus until Component 6;
 *     a single footer note says "not computed" rather than leaving per-event blanks.
 *
 * Edit semantics (tagging-tool-design.md § Step 16):
 *   - Confirm: marks reviewed=True, source/auto unchanged (common case for
 *     DCML events that are correct as imported).
 *   - Edit: if beat changed → moveHarmonyBoundary; if chord fields changed →
 *     editHarmonyChord. If both changed, chord edit runs first (preserving the
 *     original beat as identity) then boundary move.
 *   - Insert: creates a new event at a specified (mn, beat) position.
 *   - Delete: removes an event; prior event extends through the vacated slot.
 *
 * References: fragment-schema.md § "Harmonic analysis: movement-level single
 * source of truth", docs/roadmap/component-5-tagging-tool.md § Step 16,
 * docs/roadmap/component-7-fragment-database.md § Step 15.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SelectionRange } from './annotator';
import {
  confirmHarmonyEvent,
  deleteHarmonyEvent,
  editHarmonyChord,
  getHarmonyEvents,
  insertHarmonyEvent,
  moveHarmonyBoundary,
} from '../../services/analysisApi';
import type {
  HarmonyEventOut,
  HarmonyEventInsertPayload,
  HarmonyQuality,
} from '../../services/analysisApi';
import Type from '../ui/Type';
import styles from './HarmonyPanel.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const QUALITY_OPTIONS: { value: HarmonyQuality; labelKey: string }[] = [
  { value: 'major',            labelKey: 'harmony.quality.major'           },
  { value: 'minor',            labelKey: 'harmony.quality.minor'           },
  { value: 'diminished',       labelKey: 'harmony.quality.diminished'      },
  { value: 'augmented',        labelKey: 'harmony.quality.augmented'       },
  { value: 'half-diminished',  labelKey: 'harmony.quality.halfDiminished'  },
  { value: 'dominant-seventh', labelKey: 'harmony.quality.dominantSeventh' },
];

const INVERSION_OPTIONS = [
  { value: '0', labelKey: 'harmony.inversion.root'   },
  { value: '1', labelKey: 'harmony.inversion.first'  },
  { value: '2', labelKey: 'harmony.inversion.second' },
  { value: '3', labelKey: 'harmony.inversion.third'  },
];

const ROOT_ACCIDENTAL_OPTIONS = [
  { value: '',      labelKey: 'harmony.rootAccidental.none'  },
  { value: 'flat',  labelKey: 'harmony.rootAccidental.flat'  },
  { value: 'sharp', labelKey: 'harmony.rootAccidental.sharp' },
];

// Display maps for secondary detail (G6.2) — same vocabulary as the in-score labels (Step 16)
const QUALITY_DISPLAY: Record<string, string> = {
  'major': 'major',
  'minor': 'minor',
  'diminished': 'dim',
  'augmented': 'aug',
  'half-diminished': 'ø',
  'dominant-seventh': 'dom7',
};

const INVERSION_DISPLAY: Record<number, string> = {
  0: 'root pos',
  1: '1st inv',
  2: '2nd inv',
  3: '3rd inv',
};

// ---------------------------------------------------------------------------
// Local types
// ---------------------------------------------------------------------------

interface EditForm {
  originalMn: number;
  originalVolta: number | null;
  originalBeat: number;
  originalMc: number | null;
  beat: string;
  numeral: string;
  localKey: string;
  root: string;
  quality: string;
  inversion: string;
  rootAccidental: string;
  appliedTo: string;
  extensions: string;
}

interface InsertForm {
  mn: string;
  beat: string;
  numeral: string;
  localKey: string;
  root: string;
  quality: string;
  inversion: string;
  rootAccidental: string;
  appliedTo: string;
  extensions: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface HarmonyPanelProps {
  movementId: string;
  selectionRange: SelectionRange | null;
  /**
   * Called after any successful mutation (confirm, edit, insert, delete) so
   * the in-score overlay can refresh its cached event list (Step 16 / G6.3).
   */
  onHarmonyUpdated?: () => void;
  /**
   * Event key to scroll into view and briefly highlight — set by ScoreViewer
   * when the annotator clicks an in-score label (click-to-focus, Step 16).
   * Format: "${mn}:${volta ?? ''}:${beat}" — matches eventKey().
   */
  focusedEventKey?: string | null;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function eventKey(e: HarmonyEventOut): string {
  return `${e.mn}:${e.volta ?? ''}:${e.beat}`;
}

function beatLabel(e: HarmonyEventOut): string {
  const beatStr = e.beat % 1 === 0
    ? String(e.beat)
    : e.beat.toFixed(2).replace(/\.?0+$/, '');
  return `b${beatStr}`;
}

// Primary human label: "V65/V (G)" — same vocabulary as in-score harmony overlay (Step 16)
function primaryLabel(e: HarmonyEventOut): string {
  let chord = e.numeral ?? '';
  if (e.applied_to) chord += `/${e.applied_to}`;
  const key = e.local_key ? ` (${e.local_key})` : '';
  return (chord + key) || '—';
}

// Secondary detail: "root 5 · dim · 1st inv · ext 7"
function secondaryDetail(e: HarmonyEventOut): string {
  const parts: string[] = [];
  if (e.root != null) {
    const acc = e.root_accidental === 'flat' ? '♭' : e.root_accidental === 'sharp' ? '♯' : '';
    parts.push(`root ${acc}${e.root}`);
  }
  if (e.quality) parts.push(QUALITY_DISPLAY[e.quality] ?? e.quality);
  if (e.inversion != null) parts.push(INVERSION_DISPLAY[e.inversion] ?? String(e.inversion));
  if (e.extensions && e.extensions.length > 0) parts.push(`ext ${e.extensions.join(', ')}`);
  return parts.join(' · ');
}

function eventToEditForm(e: HarmonyEventOut): EditForm {
  return {
    originalMn: e.mn,
    originalVolta: e.volta ?? null,
    originalBeat: e.beat,
    originalMc: e.mc ?? null,
    beat: String(e.beat),
    numeral: e.numeral ?? '',
    localKey: e.local_key ?? '',
    root: e.root != null ? String(e.root) : '',
    quality: e.quality ?? '',
    inversion: e.inversion != null ? String(e.inversion) : '0',
    rootAccidental: e.root_accidental ?? '',
    appliedTo: e.applied_to ?? '',
    extensions: (e.extensions ?? []).join(', '),
  };
}

function emptyInsertForm(defaultMn?: number): InsertForm {
  return {
    mn: defaultMn != null ? String(defaultMn) : '',
    beat: '1',
    numeral: '',
    localKey: '',
    root: '',
    quality: '',
    inversion: '0',
    rootAccidental: '',
    appliedTo: '',
    extensions: '',
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HarmonyPanel({
  movementId,
  selectionRange,
  onHarmonyUpdated,
  focusedEventKey,
}: HarmonyPanelProps) {
  const { t } = useTranslation(['score', 'common']);
  const [events, setEvents] = useState<HarmonyEventOut[]>([]);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [loadError, setLoadError] = useState<string | null>(null);

  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<EditForm | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const [insertOpen, setInsertOpen] = useState(false);
  const [insertForm, setInsertForm] = useState<InsertForm>(() =>
    emptyInsertForm(selectionRange?.barStart),
  );
  const [insertSaving, setInsertSaving] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);

  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());

  // Ref on the outer panel div used by click-to-focus to querySelector event cards.
  const panelRef = useRef<HTMLDivElement>(null);

  // ── Click-to-focus (Step 16 / G6.3) ─────────────────────────────────────
  // When ScoreViewer emits a focusedEventKey (from an in-score label click),
  // scroll the matching event card into view and apply a brief highlight.
  useEffect(() => {
    if (!focusedEventKey || !panelRef.current) return;
    const el = panelRef.current.querySelector<HTMLElement>(
      `[data-event-key="${focusedEventKey}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.classList.add(styles.eventCardFocused!);
    const t = setTimeout(() => el.classList.remove(styles.eventCardFocused!), 1200);
    return () => clearTimeout(t);
  }, [focusedEventKey]);

  // ── Fetch events ─────────────────────────────────────────────────────────

  const fetchEvents = useCallback(async () => {
    if (!selectionRange) {
      setEvents([]);
      setLoadState('idle');
      return;
    }
    // §6A.1 I2 — the client validates coordinates before emitting any API
    // request. A non-finite bar number can no longer be committed, but no
    // request may ever carry one regardless.
    if (
      !Number.isFinite(selectionRange.barStart) ||
      !Number.isFinite(selectionRange.barEnd)
    ) {
      setEvents([]);
      setLoadState('error');
      setLoadError(t('score:harmony.msg.noBarRange'));
      return;
    }
    setLoadState('loading');
    setLoadError(null);
    try {
      const evs = await getHarmonyEvents(
        movementId,
        selectionRange.barStart,
        selectionRange.barEnd,
      );
      setEvents(evs);
      setLoadState('idle');
    } catch (err) {
      setLoadState('error');
      setLoadError(err instanceof Error ? err.message : t('score:harmony.msg.loadFailed'));
    }
  }, [movementId, selectionRange, t]);

  useEffect(() => {
    fetchEvents();
    // Reset edit/insert state whenever the selection changes
    setEditingKey(null);
    setEditForm(null);
    setInsertOpen(false);
    setInsertForm(emptyInsertForm(selectionRange?.barStart));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchEvents]);

  // ── Confirm ──────────────────────────────────────────────────────────────

  const handleConfirm = useCallback(
    async (event: HarmonyEventOut) => {
      const key = eventKey(event);
      setBusyKeys(prev => new Set([...prev, key]));
      try {
        const updated = await confirmHarmonyEvent(movementId, {
          mn: event.mn,
          volta: event.volta ?? null,
          beat: event.beat,
          mc: event.mc ?? null,
        });
        setEvents(prev => prev.map(e => eventKey(e) === key ? updated : e));
        onHarmonyUpdated?.();
      } catch {
        // Fall back to full refetch on failure
        await fetchEvents();
      } finally {
        setBusyKeys(prev => { const s = new Set(prev); s.delete(key); return s; });
      }
    },
    [movementId, fetchEvents, onHarmonyUpdated],
  );

  const handleConfirmAll = useCallback(async () => {
    const unreviewed = events.filter(e => !e.reviewed);
    if (unreviewed.length === 0) return;

    const keys = new Set(unreviewed.map(eventKey));
    setBusyKeys(keys);

    const results = await Promise.allSettled(
      unreviewed.map(event =>
        confirmHarmonyEvent(movementId, {
          mn: event.mn,
          volta: event.volta ?? null,
          beat: event.beat,
          mc: event.mc ?? null,
        }),
      ),
    );

    const updates: HarmonyEventOut[] = results
      .filter((r): r is PromiseFulfilledResult<HarmonyEventOut> => r.status === 'fulfilled')
      .map(r => r.value);

    setEvents(prev =>
      prev.map(e => updates.find(u => eventKey(u) === eventKey(e)) ?? e),
    );
    setBusyKeys(new Set());
    onHarmonyUpdated?.();
  }, [events, movementId, onHarmonyUpdated]);

  // ── Edit ─────────────────────────────────────────────────────────────────

  const handleEditOpen = useCallback((event: HarmonyEventOut) => {
    setEditingKey(eventKey(event));
    setEditForm(eventToEditForm(event));
    setEditError(null);
  }, []);

  const handleEditCancel = useCallback(() => {
    setEditingKey(null);
    setEditForm(null);
    setEditError(null);
  }, []);

  const handleEditSave = useCallback(async () => {
    if (!editForm) return;

    const beatFloat = parseFloat(editForm.beat);
    if (isNaN(beatFloat) || beatFloat <= 0) {
      setEditError(t('score:harmony.msg.beatPositive'));
      return;
    }
    const rootInt = parseInt(editForm.root, 10);
    if (!editForm.root || isNaN(rootInt) || rootInt < 1 || rootInt > 7) {
      setEditError(t('score:harmony.msg.rootRange'));
      return;
    }
    if (!editForm.quality) {
      setEditError(t('score:harmony.msg.qualityRequired'));
      return;
    }
    if (!editForm.numeral.trim()) {
      setEditError(t('score:harmony.msg.numeralRequired'));
      return;
    }
    const invInt = parseInt(editForm.inversion, 10);
    if (isNaN(invInt) || invInt < 0 || invInt > 3) {
      setEditError(t('score:harmony.msg.inversionRange'));
      return;
    }

    const extensions = editForm.extensions
      ? editForm.extensions.split(',').map(s => s.trim()).filter(Boolean)
      : [];

    const chordPayload = {
      mn: editForm.originalMn,
      volta: editForm.originalVolta,
      beat: editForm.originalBeat,
      mc: editForm.originalMc,
      local_key: editForm.localKey || null,
      root: rootInt,
      quality: editForm.quality as HarmonyQuality,
      inversion: invInt,
      numeral: editForm.numeral.trim(),
      root_accidental: (editForm.rootAccidental as 'flat' | 'sharp') || null,
      applied_to: editForm.appliedTo || null,
      extensions,
    };

    setEditSaving(true);
    setEditError(null);

    try {
      const beatChanged = beatFloat !== editForm.originalBeat;
      // chord edit uses original beat as identity; run before boundary move
      await editHarmonyChord(movementId, chordPayload);
      if (beatChanged) {
        await moveHarmonyBoundary(movementId, {
          mn: editForm.originalMn,
          volta: editForm.originalVolta,
          beat: editForm.originalBeat,
          mc: editForm.originalMc,
          new_beat: beatFloat,
        });
      }
      setEditingKey(null);
      setEditForm(null);
      await fetchEvents();
      onHarmonyUpdated?.();
    } catch (err) {
      setEditError(err instanceof Error ? err.message : t('score:harmony.msg.saveFailed'));
    } finally {
      setEditSaving(false);
    }
  }, [editForm, movementId, fetchEvents, onHarmonyUpdated, t]);

  // ── Delete ────────────────────────────────────────────────────────────────

  const handleDelete = useCallback(
    async (event: HarmonyEventOut) => {
      const key = eventKey(event);
      setBusyKeys(prev => new Set([...prev, key]));
      try {
        await deleteHarmonyEvent(movementId, {
          mn: event.mn,
          volta: event.volta ?? null,
          beat: event.beat,
          mc: event.mc ?? null,
        });
        await fetchEvents();
        onHarmonyUpdated?.();
      } catch {
        // Keep event in list on failure
      } finally {
        setBusyKeys(prev => { const s = new Set(prev); s.delete(key); return s; });
      }
    },
    [movementId, fetchEvents, onHarmonyUpdated],
  );

  // ── Insert ────────────────────────────────────────────────────────────────

  const handleInsertSave = useCallback(async () => {
    const mnInt = parseInt(insertForm.mn, 10);
    if (isNaN(mnInt) || mnInt < 0) { setInsertError(t('score:harmony.msg.barRequired')); return; }

    const beatFloat = parseFloat(insertForm.beat);
    if (isNaN(beatFloat) || beatFloat <= 0) { setInsertError(t('score:harmony.msg.beatGtZero')); return; }

    const rootInt = parseInt(insertForm.root, 10);
    if (!insertForm.root || isNaN(rootInt) || rootInt < 1 || rootInt > 7) {
      setInsertError(t('score:harmony.msg.rootRangeShort'));
      return;
    }
    if (!insertForm.quality) { setInsertError(t('score:harmony.msg.qualityRequiredShort')); return; }
    if (!insertForm.numeral.trim()) { setInsertError(t('score:harmony.msg.numeralRequiredShort')); return; }

    const invInt = parseInt(insertForm.inversion || '0', 10);

    const payload: HarmonyEventInsertPayload = {
      mn: mnInt,
      beat: beatFloat,
      numeral: insertForm.numeral.trim(),
      local_key: insertForm.localKey || null,
      root: rootInt,
      quality: insertForm.quality as HarmonyQuality,
      inversion: invInt,
      root_accidental: (insertForm.rootAccidental as 'flat' | 'sharp') || null,
      applied_to: insertForm.appliedTo || null,
      extensions: insertForm.extensions
        ? insertForm.extensions.split(',').map(s => s.trim()).filter(Boolean)
        : [],
    };

    setInsertSaving(true);
    setInsertError(null);

    try {
      await insertHarmonyEvent(movementId, payload);
      setInsertOpen(false);
      setInsertForm(emptyInsertForm(selectionRange?.barStart));
      await fetchEvents();
      onHarmonyUpdated?.();
    } catch (err) {
      setInsertError(err instanceof Error ? err.message : t('score:harmony.msg.insertFailed'));
    } finally {
      setInsertSaving(false);
    }
  }, [insertForm, movementId, selectionRange, fetchEvents, onHarmonyUpdated, t]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const unreviewedCount = events.filter(e => !e.reviewed).length;
  // Inferred key: first event's local_key seeds actual_key.value in the summary
  const inferredKey = events.length > 0 ? (events[0].local_key ?? null) : null;

  // Events grouped by (mn, volta) for measure-level scannability (G6.2)
  const eventsByMeasure = useMemo(() => {
    const groups = new Map<string, { mn: number; volta: number | null; items: HarmonyEventOut[] }>();
    for (const event of events) {
      const groupKey = `${event.mn}:${event.volta ?? ''}`;
      const existing = groups.get(groupKey);
      if (existing) {
        existing.items.push(event);
      } else {
        groups.set(groupKey, { mn: event.mn, volta: event.volta ?? null, items: [event] });
      }
    }
    return [...groups.values()].sort((a, b) => a.mn - b.mn || (a.volta ?? 0) - (b.volta ?? 0));
  }, [events]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (!selectionRange) return null;

  return (
    <div ref={panelRef} className={styles.panel}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        {inferredKey && (
          <Type variant="label-sm" as="span" className={styles.inferredKey}>
            {t('score:harmony.keyPrefix', { key: inferredKey })}
          </Type>
        )}
        {unreviewedCount > 0 && (
          <button
            type="button"
            className={styles.confirmAllButton}
            onClick={handleConfirmAll}
            disabled={busyKeys.size > 0}
          >
            <Type variant="label-sm" as="span">
              {t('score:harmony.confirmAll', { count: unreviewedCount })}
            </Type>
          </button>
        )}
      </div>

      {/* ── Loading / error ──────────────────────────────────────────────── */}
      {loadState === 'loading' && (
        <Type variant="label-sm" as="p" className={styles.statusText}>
          {t('common:loading')}
        </Type>
      )}
      {loadState === 'error' && (
        <Type variant="label-sm" as="p" className={styles.errorText} role="alert">
          {loadError ?? t('score:harmony.loadFailed')}
          {' '}
          <button type="button" className={styles.retryLink} onClick={fetchEvents}>
            {t('common:retry')}
          </button>
        </Type>
      )}

      {/* ── Event list, grouped by measure ───────────────────────────────── */}
      {loadState === 'idle' && events.length === 0 && (
        <Type variant="label-sm" as="p" className={styles.statusText}>
          {t('score:harmony.noEvents')}
        </Type>
      )}

      {eventsByMeasure.length > 0 && (
        <div className={styles.measureGroups}>
          {eventsByMeasure.map(({ mn, volta, items }) => (
            <div key={`${mn}:${volta ?? ''}`} className={styles.measureGroup}>
              <div className={styles.measureHeader}>
                <Type variant="label-sm" as="span">
                  {volta != null
                    ? t('score:harmony.measureGroupVolta', { mn, volta })
                    : t('score:harmony.measureGroup', { mn })}
                </Type>
              </div>
              <ul className={styles.eventList} role="list">
                {items.map(event => {
                  const key = eventKey(event);
                  const isEditing = editingKey === key;
                  const isBusy = busyKeys.has(key);
                  const secondary = secondaryDetail(event);

                  return (
                    <li key={key} className={styles.eventCard} data-event-key={key}>
                      {/* ── Event row ────────────────────────────────── */}
                      <div className={styles.eventRow}>
                        <span className={styles.beat}>
                          <Type variant="label-sm" as="span">{beatLabel(event)}</Type>
                        </span>
                        <div className={styles.chordBlock}>
                          <span className={styles.eventPrimary}>
                            <Type variant="label-sm" as="span">{primaryLabel(event)}</Type>
                          </span>
                          {secondary && (
                            <span className={styles.eventSecondary}>
                              <Type variant="label-sm" as="span">{secondary}</Type>
                            </span>
                          )}
                        </div>
                        {!event.reviewed && (
                          <span className={styles.badgeUnreviewed}>
                            <Type variant="label-sm" as="span">
                              {event.source} ⚠
                            </Type>
                          </span>
                        )}
                        {event.reviewed && (
                          <span className={styles.badgeReviewed}>
                            <Type variant="label-sm" as="span">{event.source}</Type>
                          </span>
                        )}
                        <div className={styles.actions}>
                          {!event.reviewed && (
                            <button
                              type="button"
                              className={styles.actionConfirm}
                              title={t('score:harmony.confirmReviewedTitle')}
                              disabled={isBusy}
                              onClick={() => handleConfirm(event)}
                            >
                              ✓
                            </button>
                          )}
                          <button
                            type="button"
                            className={styles.actionEdit}
                            title={isEditing ? t('score:harmony.closeEditorTitle') : t('score:harmony.editEventTitle')}
                            disabled={isBusy}
                            onClick={() => isEditing ? handleEditCancel() : handleEditOpen(event)}
                            aria-pressed={isEditing}
                          >
                            ✎
                          </button>
                          <button
                            type="button"
                            className={styles.actionDelete}
                            title={t('score:harmony.deleteEventTitle')}
                            disabled={isBusy}
                            onClick={() => handleDelete(event)}
                          >
                            ✕
                          </button>
                        </div>
                      </div>

                      {/* ── Inline edit form ─────────────────────────── */}
                      {isEditing && editForm && (
                        <div className={styles.editForm}>
                          <div className={styles.formGrid}>
                            <label className={styles.fieldLabel}>
                              <Type variant="label-sm" as="span">{t('score:harmony.field.beat')}</Type>
                              <input
                                type="number"
                                step="0.5"
                                min="0.5"
                                className={styles.textInput}
                                value={editForm.beat}
                                onChange={e => setEditForm(f => f && { ...f, beat: e.target.value })}
                              />
                            </label>
                            <label className={styles.fieldLabel}>
                              <Type variant="label-sm" as="span">{t('score:harmony.field.numeral')}</Type>
                              <input
                                type="text"
                                className={styles.textInput}
                                value={editForm.numeral}
                                onChange={e => setEditForm(f => f && { ...f, numeral: e.target.value })}
                              />
                            </label>
                            <label className={styles.fieldLabel}>
                              <Type variant="label-sm" as="span">{t('score:harmony.field.localKey')}</Type>
                              <input
                                type="text"
                                className={styles.textInput}
                                placeholder={t('score:harmony.placeholder.localKey')}
                                value={editForm.localKey}
                                onChange={e => setEditForm(f => f && { ...f, localKey: e.target.value })}
                              />
                            </label>
                            <label className={styles.fieldLabel}>
                              <Type variant="label-sm" as="span">{t('score:harmony.field.root')}</Type>
                              <input
                                type="number"
                                min="1"
                                max="7"
                                className={styles.textInput}
                                value={editForm.root}
                                onChange={e => setEditForm(f => f && { ...f, root: e.target.value })}
                              />
                            </label>
                            <label className={styles.fieldLabel}>
                              <Type variant="label-sm" as="span">{t('score:harmony.field.quality')}</Type>
                              <select
                                className={styles.selectInput}
                                value={editForm.quality}
                                onChange={e => setEditForm(f => f && { ...f, quality: e.target.value })}
                              >
                                <option value="">{t('score:harmony.selectOption')}</option>
                                {QUALITY_OPTIONS.map(o => (
                                  <option key={o.value} value={o.value}>{t(`score:${o.labelKey}`)}</option>
                                ))}
                              </select>
                            </label>
                            <label className={styles.fieldLabel}>
                              <Type variant="label-sm" as="span">{t('score:harmony.field.inversion')}</Type>
                              <select
                                className={styles.selectInput}
                                value={editForm.inversion}
                                onChange={e => setEditForm(f => f && { ...f, inversion: e.target.value })}
                              >
                                {INVERSION_OPTIONS.map(o => (
                                  <option key={o.value} value={o.value}>{t(`score:${o.labelKey}`)}</option>
                                ))}
                              </select>
                            </label>
                            <label className={styles.fieldLabel}>
                              <Type variant="label-sm" as="span">{t('score:harmony.field.rootAcc')}</Type>
                              <select
                                className={styles.selectInput}
                                value={editForm.rootAccidental}
                                onChange={e => setEditForm(f => f && { ...f, rootAccidental: e.target.value })}
                              >
                                {ROOT_ACCIDENTAL_OPTIONS.map(o => (
                                  <option key={o.value} value={o.value}>{t(`score:${o.labelKey}`)}</option>
                                ))}
                              </select>
                            </label>
                            <label className={styles.fieldLabel}>
                              <Type variant="label-sm" as="span">{t('score:harmony.field.appliedTo')}</Type>
                              <input
                                type="text"
                                className={styles.textInput}
                                placeholder={t('score:harmony.placeholder.appliedTo')}
                                value={editForm.appliedTo}
                                onChange={e => setEditForm(f => f && { ...f, appliedTo: e.target.value })}
                              />
                            </label>
                            <label className={`${styles.fieldLabel} ${styles.fieldFull}`}>
                              <Type variant="label-sm" as="span">{t('score:harmony.field.extensions')}</Type>
                              <input
                                type="text"
                                className={styles.textInput}
                                placeholder={t('score:harmony.placeholder.extensions')}
                                value={editForm.extensions}
                                onChange={e => setEditForm(f => f && { ...f, extensions: e.target.value })}
                              />
                            </label>
                          </div>

                          {editError && (
                            <Type variant="label-sm" as="p" className={styles.formError} role="alert">
                              {editError}
                            </Type>
                          )}

                          <div className={styles.formActions}>
                            <button
                              type="button"
                              className={styles.saveButton}
                              onClick={handleEditSave}
                              disabled={editSaving}
                            >
                              <Type variant="label-sm" as="span">
                                {editSaving ? t('checklist.saving') : t('common:save')}
                              </Type>
                            </button>
                            <button
                              type="button"
                              className={styles.cancelButton}
                              onClick={handleEditCancel}
                              disabled={editSaving}
                            >
                              <Type variant="label-sm" as="span">{t('common:cancel')}</Type>
                            </button>
                          </div>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}

      {/* ── Insert form / Add button ─────────────────────────────────────── */}
      {insertOpen ? (
        <div className={styles.insertCard}>
          <Type variant="label-sm" as="p" className={styles.insertHeading}>
            {t('score:harmony.addHeading')}
          </Type>
          <div className={styles.formGrid}>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.barMn')}</Type>
              <input
                type="number"
                min="0"
                className={styles.textInput}
                value={insertForm.mn}
                onChange={e => setInsertForm(f => ({ ...f, mn: e.target.value }))}
              />
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.beat')}</Type>
              <input
                type="number"
                step="0.5"
                min="0.5"
                className={styles.textInput}
                value={insertForm.beat}
                onChange={e => setInsertForm(f => ({ ...f, beat: e.target.value }))}
              />
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.numeralRequired')}</Type>
              <input
                type="text"
                className={styles.textInput}
                placeholder={t('score:harmony.placeholder.appliedTo')}
                value={insertForm.numeral}
                onChange={e => setInsertForm(f => ({ ...f, numeral: e.target.value }))}
              />
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.localKey')}</Type>
              <input
                type="text"
                className={styles.textInput}
                placeholder={t('score:harmony.placeholder.localKeyShort')}
                value={insertForm.localKey}
                onChange={e => setInsertForm(f => ({ ...f, localKey: e.target.value }))}
              />
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.rootRequired')}</Type>
              <input
                type="number"
                min="1"
                max="7"
                className={styles.textInput}
                value={insertForm.root}
                onChange={e => setInsertForm(f => ({ ...f, root: e.target.value }))}
              />
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.qualityRequired')}</Type>
              <select
                className={styles.selectInput}
                value={insertForm.quality}
                onChange={e => setInsertForm(f => ({ ...f, quality: e.target.value }))}
              >
                <option value="">{t('score:harmony.selectOption')}</option>
                {QUALITY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{t(`score:${o.labelKey}`)}</option>
                ))}
              </select>
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.inversion')}</Type>
              <select
                className={styles.selectInput}
                value={insertForm.inversion}
                onChange={e => setInsertForm(f => ({ ...f, inversion: e.target.value }))}
              >
                {INVERSION_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{t(`score:${o.labelKey}`)}</option>
                ))}
              </select>
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.rootAcc')}</Type>
              <select
                className={styles.selectInput}
                value={insertForm.rootAccidental}
                onChange={e => setInsertForm(f => ({ ...f, rootAccidental: e.target.value }))}
              >
                {ROOT_ACCIDENTAL_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{t(`score:${o.labelKey}`)}</option>
                ))}
              </select>
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.appliedTo')}</Type>
              <input
                type="text"
                className={styles.textInput}
                placeholder={t('score:harmony.placeholder.appliedTo')}
                value={insertForm.appliedTo}
                onChange={e => setInsertForm(f => ({ ...f, appliedTo: e.target.value }))}
              />
            </label>
            <label className={`${styles.fieldLabel} ${styles.fieldFull}`}>
              <Type variant="label-sm" as="span">{t('score:harmony.field.extensions')}</Type>
              <input
                type="text"
                className={styles.textInput}
                placeholder={t('score:harmony.placeholder.extensions')}
                value={insertForm.extensions}
                onChange={e => setInsertForm(f => ({ ...f, extensions: e.target.value }))}
              />
            </label>
          </div>

          {insertError && (
            <Type variant="label-sm" as="p" className={styles.formError} role="alert">
              {insertError}
            </Type>
          )}

          <div className={styles.formActions}>
            <button
              type="button"
              className={styles.saveButton}
              onClick={handleInsertSave}
              disabled={insertSaving}
            >
              <Type variant="label-sm" as="span">
                {insertSaving ? t('score:harmony.inserting') : t('score:harmony.insert')}
              </Type>
            </button>
            <button
              type="button"
              className={styles.cancelButton}
              onClick={() => { setInsertOpen(false); setInsertError(null); }}
              disabled={insertSaving}
            >
              <Type variant="label-sm" as="span">{t('common:cancel')}</Type>
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          className={styles.addEventButton}
          onClick={() => {
            setInsertForm(emptyInsertForm(selectionRange?.barStart));
            setInsertOpen(true);
          }}
        >
          <Type variant="label-sm" as="span">{t('score:harmony.addEvent')}</Type>
        </button>
      )}

      {/* ── DCML-only note ────────────────────────────────────────────────── */}
      <Type variant="label-sm" as="p" className={styles.dcmlNote}>
        {t('score:harmony.dcmlNote')}
      </Type>
    </div>
  );
}
