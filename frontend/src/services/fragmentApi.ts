/**
 * Fragment write API client — Component 5 Step 18.
 *
 * Covers the producer-side write surface (Step 6):
 *   POST   /api/v1/fragments             — create draft
 *   PATCH  /api/v1/fragments/{id}        — update draft
 *   POST   /api/v1/fragments/{id}/submit — draft → submitted
 *
 * Type definitions mirror the Python Pydantic models in
 * backend/models/fragment.py. The summary JSONB schema follows
 * fragment-schema.md version 1.
 *
 * References:
 *   docs/roadmap/component-5-tagging-tool.md §§ Step 6, Step 18
 *   docs/architecture/fragment-schema.md §"The summary JSONB schema"
 *   backend/models/fragment.py
 */

import { apiFetch } from './api';

// ---------------------------------------------------------------------------
// Payload types
// ---------------------------------------------------------------------------

/**
 * Versioned summary JSONB (v1). Maps to Python FragmentSummary.
 *
 * Phase 1 DCML-only path: music21_version is null / "none"; actual_key is
 * seeded from DCML local_key with auto=false, reviewed=true (option b,
 * "Decisions taken into this plan").
 */
export interface FragmentSummaryPayload {
  version: 1;
  key: string;
  meter: string;
  music21_version?: string | null;
  /** Concept IDs in the tag list; primary concept first. */
  concepts: string[];
  actual_key?: {
    value: string;
    auto: boolean;
    reviewed: boolean;
    confidence?: number | null;
  } | null;
  /** Schema-id → value; BOOL schemas serialised as "true"/"false". */
  properties?: Record<string, string | string[]>;
  concept_extensions?: Record<string, unknown>;
}

/** One concept tag in a fragment write request. */
export interface ConceptTagPayload {
  concept_id: string;
  /** Must be true for exactly one tag per fragment. */
  is_primary: boolean;
}

/** Write model for a child (stage) fragment. */
export interface SubPartPayload {
  bar_start: number;
  bar_end: number;
  mc_start: number;
  mc_end: number;
  beat_start?: number | null;
  beat_end?: number | null;
  repeat_context?: string | null;
  summary: FragmentSummaryPayload;
  prose_annotation?: string | null;
  concept_tags: ConceptTagPayload[];
}

/** POST /api/v1/fragments body. */
export interface FragmentCreatePayload {
  movement_id: string;
  bar_start: number;
  bar_end: number;
  mc_start: number;
  mc_end: number;
  beat_start?: number | null;
  beat_end?: number | null;
  repeat_context?: string | null;
  summary: FragmentSummaryPayload;
  prose_annotation?: string | null;
  concept_tags: ConceptTagPayload[];
  sub_parts?: SubPartPayload[];
}

/** PATCH /api/v1/fragments/{id} body — all mutable fields, no movement_id. */
export interface FragmentUpdatePayload {
  bar_start: number;
  bar_end: number;
  mc_start: number;
  mc_end: number;
  beat_start?: number | null;
  beat_end?: number | null;
  repeat_context?: string | null;
  summary: FragmentSummaryPayload;
  prose_annotation?: string | null;
  concept_tags: ConceptTagPayload[];
  sub_parts?: SubPartPayload[];
}

/** Response shape from all fragment write endpoints. */
export interface FragmentApiResponse {
  id: string;
  movement_id: string;
  bar_start: number;
  bar_end: number;
  mc_start: number;
  mc_end: number;
  beat_start: number | null;
  beat_end: number | null;
  repeat_context: string | null;
  parent_fragment_id: string | null;
  summary: Record<string, unknown>;
  prose_annotation: string | null;
  data_licence: string | null;
  status: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Create a new draft fragment with an atomic parent+child write.
 *
 * @throws ApiError on validation failure, auth error, or network error.
 */
export async function createFragment(
  payload: FragmentCreatePayload,
): Promise<FragmentApiResponse> {
  return apiFetch<FragmentApiResponse>('/api/v1/fragments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

/**
 * Replace all mutable fields of a draft fragment.
 *
 * @param id UUID of the draft to update.
 * @throws ApiError when the fragment is not found, not in draft status,
 *         or the caller is not the creator.
 */
export async function updateFragment(
  id: string,
  payload: FragmentUpdatePayload,
): Promise<FragmentApiResponse> {
  return apiFetch<FragmentApiResponse>(`/api/v1/fragments/${id}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

/**
 * Transition a draft fragment to submitted status.
 *
 * The server re-validates concept existence before transitioning.
 *
 * @param id UUID of the draft to submit.
 * @throws ApiError when the fragment is not in draft status or server
 *         validation fails (e.g. concept ID vanished from the graph).
 */
export async function submitFragment(
  id: string,
): Promise<FragmentApiResponse> {
  return apiFetch<FragmentApiResponse>(`/api/v1/fragments/${id}/submit`, {
    method: 'POST',
  });
}
