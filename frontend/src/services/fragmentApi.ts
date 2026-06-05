/**
 * Fragment API client — write surface (Component 5) and read surface (Component 7).
 *
 * Write endpoints (Step 6, Component 5):
 *   POST   /api/v1/fragments             — create draft
 *   PATCH  /api/v1/fragments/{id}        — update draft
 *   POST   /api/v1/fragments/{id}/submit — draft → submitted
 *
 * Read endpoints (Step 7, Component 7):
 *   GET    /api/v1/fragments/{id}                      — full fragment detail
 *   GET    /api/v1/movements/{id}/fragments            — movement-scoped list
 *
 * Type definitions mirror the Python Pydantic models in
 * backend/models/fragment.py. The summary JSONB schema follows
 * fragment-schema.md version 1.
 *
 * References:
 *   docs/roadmap/component-5-tagging-tool.md §§ Step 6, Step 18
 *   docs/roadmap/component-7-fragment-database.md § Step 7
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
// Read response types (Component 7 Step 7)
// ---------------------------------------------------------------------------

/** A concept tag hydrated with Neo4j name, alias, and hierarchy path. */
export interface ConceptTagDetail {
  concept_id: string;
  is_primary: boolean;
  /** Concept name from Neo4j. */
  name: string;
  /** First alias (abbreviated label, e.g. "PAC"), or null if none. */
  alias: string | null;
  /** IS_SUBTYPE_OF path from root to the concept (root first). */
  hierarchy_path: string[];
}

/** Full fragment record returned by GET /api/v1/fragments/{id}. */
export interface FragmentDetailResponse {
  id: string;
  movement_id: string;
  parent_fragment_id: string | null;
  bar_start: number;
  bar_end: number;
  mc_start: number;
  mc_end: number;
  beat_start: number | null;
  beat_end: number | null;
  repeat_context: string | null;
  summary: Record<string, unknown>;
  prose_annotation: string | null;
  data_licence: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  created_by: string | null;
  created_at: string;
  updated_at: string;
  concept_tags: ConceptTagDetail[];
  /** Harmony events sliced from movement_analysis over this fragment's bar range. */
  harmony_events: Record<string, unknown>[];
  /** Sub-part (stage) fragments nested one level deep (ADR-011 two-level limit). */
  sub_parts: FragmentDetailResponse[];
}

/**
 * Lightweight fragment entry for the movement-scoped overlay list.
 * Sub-parts are nested one level deep.
 */
export interface FragmentListItem {
  id: string;
  movement_id: string;
  parent_fragment_id: string | null;
  mc_start: number;
  mc_end: number;
  bar_start: number;
  bar_end: number;
  beat_start: number | null;
  beat_end: number | null;
  repeat_context: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  /** Concept id of the primary concept tag, or null if none. */
  primary_concept_id: string | null;
  /** First alias of the primary concept (e.g. "PAC"), or null. */
  primary_concept_alias: string | null;
  sub_parts: FragmentListItem[];
}

/** Cursor-paginated list response for GET /api/v1/movements/{id}/fragments. */
export interface FragmentListResponse {
  items: FragmentListItem[];
  /** Opaque cursor to pass as `cursor` to fetch the next page. Null on last page. */
  next_cursor: string | null;
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

/**
 * Fetch the full record for one fragment, including hydrated concept tags,
 * harmony events sliced over its bar range, and nested sub-parts.
 *
 * Draft fragments are visible only to their creator. A draft owned by
 * another annotator is returned as 404 by the server.
 *
 * @param id UUID of the fragment to read.
 * @throws ApiError on 404 (not found / not visible) or auth errors.
 */
export async function getFragment(id: string): Promise<FragmentDetailResponse> {
  return apiFetch<FragmentDetailResponse>(`/api/v1/fragments/${id}`);
}

/**
 * Fetch a cursor-paginated list of top-level fragments tagged on a movement.
 *
 * Each item includes sub-parts nested one level deep. Status visibility is
 * enforced by the server: the caller sees their own drafts plus all
 * submitted/approved/rejected fragments.
 *
 * @param movementId UUID of the movement.
 * @param cursor Opaque cursor from a prior response's `next_cursor`, or
 *   undefined to start from the first fragment.
 * @param pageSize Maximum top-level items per page (1–500, default 100).
 * @throws ApiError on auth errors or a malformed cursor.
 */
export async function listMovementFragments(
  movementId: string,
  cursor?: string,
  pageSize?: number,
): Promise<FragmentListResponse> {
  const params = new URLSearchParams();
  if (cursor !== undefined) params.set('cursor', cursor);
  if (pageSize !== undefined) params.set('page_size', String(pageSize));
  const qs = params.size > 0 ? `?${params}` : '';
  return apiFetch<FragmentListResponse>(
    `/api/v1/movements/${movementId}/fragments${qs}`,
  );
}
