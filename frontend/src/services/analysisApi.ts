/**
 * Analysis API service — harmony event CRUD for Component 5 Step 16.
 *
 * Wrappers for the six harmony event endpoints introduced in Step 7:
 *   GET    /api/v1/movements/{id}/analysis/events
 *   POST   /api/v1/movements/{id}/analysis/events           (201)
 *   POST   /api/v1/movements/{id}/analysis/events/delete    (204)
 *   PATCH  /api/v1/movements/{id}/analysis/events/boundary
 *   PATCH  /api/v1/movements/{id}/analysis/events/chord
 *   POST   /api/v1/movements/{id}/analysis/events/confirm
 *
 * All response shapes are Zod-validated at the boundary.
 * The delete endpoint returns 204 (no body); apiFetch handles this via the
 * 204-skip added to api.ts.
 *
 * References: fragment-schema.md § "Harmonic analysis", backend/models/analysis.py,
 * backend/api/routes/movements.py.
 */

import { z } from 'zod';
import { apiFetch } from './api';

const BASE = '/api/v1';

// ---------------------------------------------------------------------------
// Zod schema — mirrors HarmonyEventOut from backend/models/analysis.py
// ---------------------------------------------------------------------------

const HarmonyEventOutSchema = z.object({
  mc: z.number().nullable().optional(),
  mn: z.number(),
  volta: z.number().nullable().optional(),
  beat: z.number(),
  local_key: z.string().nullable().optional(),
  root: z.number().nullable().optional(),
  quality: z.string().nullable().optional(),
  inversion: z.number().nullable().optional(),
  numeral: z.string().nullable().optional(),
  root_accidental: z.string().nullable().optional(),
  applied_to: z.string().nullable().optional(),
  extensions: z.array(z.string()).default([]),
  bass_pitch: z.string().nullable().optional(),
  soprano_pitch: z.string().nullable().optional(),
  source: z.string(),
  auto: z.boolean(),
  reviewed: z.boolean(),
});

export type HarmonyEventOut = z.infer<typeof HarmonyEventOutSchema>;

const HarmonyEventListSchema = z.array(HarmonyEventOutSchema);

// ---------------------------------------------------------------------------
// Payload types — mirror backend Pydantic request models
// ---------------------------------------------------------------------------

export interface HarmonyEventDeletePayload {
  mn: number;
  volta?: number | null;
  beat: number;
  mc?: number | null;
}

export interface HarmonyEventMoveBoundaryPayload {
  mn: number;
  volta?: number | null;
  beat: number;
  mc?: number | null;
  new_beat: number;
}

export type HarmonyQuality =
  | 'major'
  | 'minor'
  | 'diminished'
  | 'augmented'
  | 'half-diminished'
  | 'dominant-seventh';

export interface HarmonyEventEditChordPayload {
  mn: number;
  volta?: number | null;
  beat: number;
  mc?: number | null;
  local_key?: string | null;
  root?: number | null;
  quality?: HarmonyQuality | null;
  inversion?: number | null;
  numeral?: string | null;
  root_accidental?: 'flat' | 'sharp' | null;
  applied_to?: string | null;
  extensions?: string[] | null;
}

export interface HarmonyEventInsertPayload {
  mn: number;
  volta?: number | null;
  beat: number;
  mc?: number | null;
  local_key?: string | null;
  root: number;
  quality: HarmonyQuality;
  inversion?: number;
  numeral: string;
  root_accidental?: 'flat' | 'sharp' | null;
  applied_to?: string | null;
  extensions?: string[];
}

export interface HarmonyEventConfirmPayload {
  mn: number;
  volta?: number | null;
  beat: number;
  mc?: number | null;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch harmony events for a movement, sliced by notated bar range.
 *
 * @param movementId UUID of the movement.
 * @param barStart Inclusive lower bound on notated bar number (mn).
 * @param barEnd Inclusive upper bound on notated bar number (mn).
 */
export async function getHarmonyEvents(
  movementId: string,
  barStart: number,
  barEnd: number,
): Promise<HarmonyEventOut[]> {
  const params = new URLSearchParams({
    bar_start: String(barStart),
    bar_end: String(barEnd),
  });
  return apiFetch(
    `${BASE}/movements/${encodeURIComponent(movementId)}/analysis/events?${params}`,
    undefined,
    HarmonyEventListSchema,
  );
}

/**
 * Insert a new harmony event at the given (mn, beat) position.
 * Sets source="manual", auto=False, reviewed=True on the backend.
 */
export async function insertHarmonyEvent(
  movementId: string,
  payload: HarmonyEventInsertPayload,
): Promise<HarmonyEventOut> {
  return apiFetch(
    `${BASE}/movements/${encodeURIComponent(movementId)}/analysis/events`,
    { method: 'POST', body: JSON.stringify(payload) },
    HarmonyEventOutSchema,
  );
}

/**
 * Delete the harmony event identified by (mn, volta, beat). Returns void (204).
 * The preceding event automatically extends through the vacated slot.
 */
export async function deleteHarmonyEvent(
  movementId: string,
  payload: HarmonyEventDeletePayload,
): Promise<void> {
  await apiFetch(
    `${BASE}/movements/${encodeURIComponent(movementId)}/analysis/events/delete`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
}

/**
 * Move an event's beat position without changing any chord fields.
 * The current beat identifies the event; new_beat is the target.
 */
export async function moveHarmonyBoundary(
  movementId: string,
  payload: HarmonyEventMoveBoundaryPayload,
): Promise<HarmonyEventOut> {
  return apiFetch(
    `${BASE}/movements/${encodeURIComponent(movementId)}/analysis/events/boundary`,
    { method: 'PATCH', body: JSON.stringify(payload) },
    HarmonyEventOutSchema,
  );
}

/**
 * Edit chord fields on an existing event without moving its beat position.
 * Fields omitted or null are not modified.
 */
export async function editHarmonyChord(
  movementId: string,
  payload: HarmonyEventEditChordPayload,
): Promise<HarmonyEventOut> {
  return apiFetch(
    `${BASE}/movements/${encodeURIComponent(movementId)}/analysis/events/chord`,
    { method: 'PATCH', body: JSON.stringify(payload) },
    HarmonyEventOutSchema,
  );
}

/**
 * Mark a harmony event as reviewed=True without changing any other field.
 * The common case for DCML events that are correct as imported.
 */
export async function confirmHarmonyEvent(
  movementId: string,
  payload: HarmonyEventConfirmPayload,
): Promise<HarmonyEventOut> {
  return apiFetch(
    `${BASE}/movements/${encodeURIComponent(movementId)}/analysis/events/confirm`,
    { method: 'POST', body: JSON.stringify(payload) },
    HarmonyEventOutSchema,
  );
}
