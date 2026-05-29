/**
 * Harmony summary panel — Component 5 Step 16.
 *
 * Reads movement_analysis events for the committed selection range and lets
 * the annotator confirm, edit, insert, and delete harmony events. Visible
 * once a selection has been drawn (fragmentSet = true).
 *
 * DCML-only (Phase 1):
 *   - bass_pitch / soprano_pitch are null for the Mozart corpus; rendered as
 *     "not computed" rather than empty/zero (fragment-schema.md).
 *   - The inferred key header is derived from the first event's local_key —
 *     this value will seed actual_key.value in the fragment summary on submit.
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
 * source of truth", docs/roadmap/component-5-tagging-tool.md § Step 16.
 */

import { useCallback, useEffect, useState } from 'react';
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

const QUALITY_OPTIONS: { value: HarmonyQuality; label: string }[] = [
  { value: 'major',            label: 'Major'     },
  { value: 'minor',            label: 'Minor'     },
  { value: 'diminished',       label: 'Dim'       },
  { value: 'augmented',        label: 'Aug'       },
  { value: 'half-diminished',  label: 'Half-dim'  },
  { value: 'dominant-seventh', label: 'Dom 7'     },
];

const INVERSION_OPTIONS = [
  { value: '0', label: 'Root' },
  { value: '1', label: '1st (6)'   },
  { value: '2', label: '2nd (6/4)' },
  { value: '3', label: '3rd'       },
];

const ROOT_ACCIDENTAL_OPTIONS = [
  { value: '',      label: '—'        },
  { value: 'flat',  label: '♭ Flat'  },
  { value: 'sharp', label: '♯ Sharp' },
];

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
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function eventKey(e: HarmonyEventOut): string {
  return `${e.mn}:${e.volta ?? ''}:${e.beat}`;
}

function positionLabel(e: HarmonyEventOut): string {
  const volta = e.volta != null ? `v${e.volta}` : '';
  const beatStr = e.beat % 1 === 0
    ? String(e.beat)
    : e.beat.toFixed(2).replace(/\.?0+$/, '');
  return `m.${e.mn}${volta} b${beatStr}`;
}

function chordSummary(e: HarmonyEventOut): string {
  const parts: string[] = [];
  if (e.numeral) parts.push(e.numeral);
  if (e.applied_to) parts.push(`/${e.applied_to}`);
  if (e.local_key) parts.push(`(${e.local_key})`);
  return parts.join(' ') || '—';
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

export default function HarmonyPanel({ movementId, selectionRange }: HarmonyPanelProps) {
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

  // ── Fetch events ─────────────────────────────────────────────────────────

  const fetchEvents = useCallback(async () => {
    if (!selectionRange) {
      setEvents([]);
      setLoadState('idle');
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
      setLoadError(err instanceof Error ? err.message : 'Failed to load harmony events');
    }
  }, [movementId, selectionRange]);

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
      } catch {
        // Fall back to full refetch on failure
        await fetchEvents();
      } finally {
        setBusyKeys(prev => { const s = new Set(prev); s.delete(key); return s; });
      }
    },
    [movementId, fetchEvents],
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
  }, [events, movementId]);

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
      setEditError('Beat must be a positive number');
      return;
    }
    const rootInt = parseInt(editForm.root, 10);
    if (!editForm.root || isNaN(rootInt) || rootInt < 1 || rootInt > 7) {
      setEditError('Root must be a number 1–7');
      return;
    }
    if (!editForm.quality) {
      setEditError('Quality is required');
      return;
    }
    if (!editForm.numeral.trim()) {
      setEditError('Numeral is required');
      return;
    }
    const invInt = parseInt(editForm.inversion, 10);
    if (isNaN(invInt) || invInt < 0 || invInt > 3) {
      setEditError('Inversion must be 0–3');
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
    } catch (err) {
      setEditError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setEditSaving(false);
    }
  }, [editForm, movementId, fetchEvents]);

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
      } catch {
        // Keep event in list on failure
      } finally {
        setBusyKeys(prev => { const s = new Set(prev); s.delete(key); return s; });
      }
    },
    [movementId, fetchEvents],
  );

  // ── Insert ────────────────────────────────────────────────────────────────

  const handleInsertSave = useCallback(async () => {
    const mnInt = parseInt(insertForm.mn, 10);
    if (isNaN(mnInt) || mnInt < 0) { setInsertError('Bar number required'); return; }

    const beatFloat = parseFloat(insertForm.beat);
    if (isNaN(beatFloat) || beatFloat <= 0) { setInsertError('Beat must be > 0'); return; }

    const rootInt = parseInt(insertForm.root, 10);
    if (!insertForm.root || isNaN(rootInt) || rootInt < 1 || rootInt > 7) {
      setInsertError('Root must be 1–7');
      return;
    }
    if (!insertForm.quality) { setInsertError('Quality required'); return; }
    if (!insertForm.numeral.trim()) { setInsertError('Numeral required'); return; }

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
    } catch (err) {
      setInsertError(err instanceof Error ? err.message : 'Insert failed');
    } finally {
      setInsertSaving(false);
    }
  }, [insertForm, movementId, selectionRange, fetchEvents]);

  // ── Derived state ─────────────────────────────────────────────────────────

  const unreviewedCount = events.filter(e => !e.reviewed).length;
  // Inferred key: first event's local_key seeds actual_key.value in the summary
  const inferredKey = events.length > 0 ? (events[0].local_key ?? null) : null;

  // ── Render ────────────────────────────────────────────────────────────────

  if (!selectionRange) return null;

  return (
    <div className={styles.panel}>
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className={styles.header}>
        {inferredKey && (
          <Type variant="label-sm" as="span" className={styles.inferredKey}>
            Key: {inferredKey}
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
              Confirm all ({unreviewedCount})
            </Type>
          </button>
        )}
      </div>

      {/* ── Loading / error ──────────────────────────────────────────────── */}
      {loadState === 'loading' && (
        <Type variant="label-sm" as="p" className={styles.statusText}>
          Loading…
        </Type>
      )}
      {loadState === 'error' && (
        <Type variant="label-sm" as="p" className={styles.errorText} role="alert">
          {loadError ?? 'Failed to load harmony events.'}
          {' '}
          <button type="button" className={styles.retryLink} onClick={fetchEvents}>
            Retry
          </button>
        </Type>
      )}

      {/* ── Event list ───────────────────────────────────────────────────── */}
      {loadState === 'idle' && events.length === 0 && (
        <Type variant="label-sm" as="p" className={styles.statusText}>
          No harmony events in this range.
        </Type>
      )}

      {events.length > 0 && (
        <ul className={styles.eventList} role="list">
          {events.map(event => {
            const key = eventKey(event);
            const isEditing = editingKey === key;
            const isBusy = busyKeys.has(key);

            return (
              <li key={key} className={styles.eventCard}>
                {/* ── Event row ──────────────────────────────────────── */}
                <div className={styles.eventRow}>
                  <span className={styles.position}>
                    <Type variant="label-sm" as="span">{positionLabel(event)}</Type>
                  </span>
                  <span className={styles.chord}>
                    <Type variant="label-sm" as="span">{chordSummary(event)}</Type>
                  </span>
                  <span
                    className={
                      event.reviewed ? styles.badgeReviewed : styles.badgeUnreviewed
                    }
                  >
                    <Type variant="label-sm" as="span">
                      {event.source}
                      {event.reviewed ? ' ✓' : ' ⚠'}
                    </Type>
                  </span>
                  <div className={styles.actions}>
                    {!event.reviewed && (
                      <button
                        type="button"
                        className={styles.actionConfirm}
                        title="Confirm as reviewed"
                        disabled={isBusy}
                        onClick={() => handleConfirm(event)}
                      >
                        ✓
                      </button>
                    )}
                    <button
                      type="button"
                      className={styles.actionEdit}
                      title={isEditing ? 'Close editor' : 'Edit event'}
                      disabled={isBusy}
                      onClick={() => isEditing ? handleEditCancel() : handleEditOpen(event)}
                      aria-pressed={isEditing}
                    >
                      ✎
                    </button>
                    <button
                      type="button"
                      className={styles.actionDelete}
                      title="Delete event"
                      disabled={isBusy}
                      onClick={() => handleDelete(event)}
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* ── Inline edit form ───────────────────────────────── */}
                {isEditing && editForm && (
                  <div className={styles.editForm}>
                    <div className={styles.formGrid}>
                      <label className={styles.fieldLabel}>
                        <Type variant="label-sm" as="span">Beat</Type>
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
                        <Type variant="label-sm" as="span">Numeral</Type>
                        <input
                          type="text"
                          className={styles.textInput}
                          value={editForm.numeral}
                          onChange={e => setEditForm(f => f && { ...f, numeral: e.target.value })}
                        />
                      </label>
                      <label className={styles.fieldLabel}>
                        <Type variant="label-sm" as="span">Local key</Type>
                        <input
                          type="text"
                          className={styles.textInput}
                          placeholder="e.g. G, d, f#"
                          value={editForm.localKey}
                          onChange={e => setEditForm(f => f && { ...f, localKey: e.target.value })}
                        />
                      </label>
                      <label className={styles.fieldLabel}>
                        <Type variant="label-sm" as="span">Root (1–7)</Type>
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
                        <Type variant="label-sm" as="span">Quality</Type>
                        <select
                          className={styles.selectInput}
                          value={editForm.quality}
                          onChange={e => setEditForm(f => f && { ...f, quality: e.target.value })}
                        >
                          <option value="">— select —</option>
                          {QUALITY_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.fieldLabel}>
                        <Type variant="label-sm" as="span">Inversion</Type>
                        <select
                          className={styles.selectInput}
                          value={editForm.inversion}
                          onChange={e => setEditForm(f => f && { ...f, inversion: e.target.value })}
                        >
                          {INVERSION_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.fieldLabel}>
                        <Type variant="label-sm" as="span">Root acc.</Type>
                        <select
                          className={styles.selectInput}
                          value={editForm.rootAccidental}
                          onChange={e => setEditForm(f => f && { ...f, rootAccidental: e.target.value })}
                        >
                          {ROOT_ACCIDENTAL_OPTIONS.map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className={styles.fieldLabel}>
                        <Type variant="label-sm" as="span">Applied to</Type>
                        <input
                          type="text"
                          className={styles.textInput}
                          placeholder="e.g. V"
                          value={editForm.appliedTo}
                          onChange={e => setEditForm(f => f && { ...f, appliedTo: e.target.value })}
                        />
                      </label>
                      <label className={`${styles.fieldLabel} ${styles.fieldFull}`}>
                        <Type variant="label-sm" as="span">Extensions (comma-separated)</Type>
                        <input
                          type="text"
                          className={styles.textInput}
                          placeholder="e.g. 7, 9"
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
                          {editSaving ? 'Saving…' : 'Save'}
                        </Type>
                      </button>
                      <button
                        type="button"
                        className={styles.cancelButton}
                        onClick={handleEditCancel}
                        disabled={editSaving}
                      >
                        <Type variant="label-sm" as="span">Cancel</Type>
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {/* ── Insert form / Add button ─────────────────────────────────────── */}
      {insertOpen ? (
        <div className={styles.insertCard}>
          <Type variant="label-sm" as="p" className={styles.insertHeading}>
            Add event
          </Type>
          <div className={styles.formGrid}>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">Bar (mn)</Type>
              <input
                type="number"
                min="0"
                className={styles.textInput}
                value={insertForm.mn}
                onChange={e => setInsertForm(f => ({ ...f, mn: e.target.value }))}
              />
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">Beat</Type>
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
              <Type variant="label-sm" as="span">Numeral *</Type>
              <input
                type="text"
                className={styles.textInput}
                placeholder="e.g. V"
                value={insertForm.numeral}
                onChange={e => setInsertForm(f => ({ ...f, numeral: e.target.value }))}
              />
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">Local key</Type>
              <input
                type="text"
                className={styles.textInput}
                placeholder="e.g. G, d"
                value={insertForm.localKey}
                onChange={e => setInsertForm(f => ({ ...f, localKey: e.target.value }))}
              />
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">Root * (1–7)</Type>
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
              <Type variant="label-sm" as="span">Quality *</Type>
              <select
                className={styles.selectInput}
                value={insertForm.quality}
                onChange={e => setInsertForm(f => ({ ...f, quality: e.target.value }))}
              >
                <option value="">— select —</option>
                {QUALITY_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">Inversion</Type>
              <select
                className={styles.selectInput}
                value={insertForm.inversion}
                onChange={e => setInsertForm(f => ({ ...f, inversion: e.target.value }))}
              >
                {INVERSION_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">Root acc.</Type>
              <select
                className={styles.selectInput}
                value={insertForm.rootAccidental}
                onChange={e => setInsertForm(f => ({ ...f, rootAccidental: e.target.value }))}
              >
                {ROOT_ACCIDENTAL_OPTIONS.map(o => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className={styles.fieldLabel}>
              <Type variant="label-sm" as="span">Applied to</Type>
              <input
                type="text"
                className={styles.textInput}
                placeholder="e.g. V"
                value={insertForm.appliedTo}
                onChange={e => setInsertForm(f => ({ ...f, appliedTo: e.target.value }))}
              />
            </label>
            <label className={`${styles.fieldLabel} ${styles.fieldFull}`}>
              <Type variant="label-sm" as="span">Extensions (comma-separated)</Type>
              <input
                type="text"
                className={styles.textInput}
                placeholder="e.g. 7, 9"
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
                {insertSaving ? 'Inserting…' : 'Insert'}
              </Type>
            </button>
            <button
              type="button"
              className={styles.cancelButton}
              onClick={() => { setInsertOpen(false); setInsertError(null); }}
              disabled={insertSaving}
            >
              <Type variant="label-sm" as="span">Cancel</Type>
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
          <Type variant="label-sm" as="span">+ Add event</Type>
        </button>
      )}

      {/* ── DCML-only note ────────────────────────────────────────────────── */}
      <Type variant="label-sm" as="p" className={styles.dcmlNote}>
        Bass and soprano voices: not computed (Phase 1)
      </Type>
    </div>
  );
}
