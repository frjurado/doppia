/**
 * Fragment API client — write surface (Component 5) and read surface (Component 7).
 *
 * Write endpoints (Step 6, Component 5):
 *   POST   /api/v1/fragments             — create draft
 *   PATCH  /api/v1/fragments/{id}        — update at any status (revision semantics)
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
 *   docs/roadmap/component-7-fragment-database.md §§ Step 7, Step 8
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

/** Response shape from create, submit, approve, and reject endpoints. */
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

/**
 * Response shape for PATCH /api/v1/fragments/{id}.
 *
 * Extends the base response with revision metadata so the UI can surface
 * "this edit re-opened review" when an approved fragment transitions back to
 * submitted, or when a submitted fragment's prior reviews are cleared.
 */
export interface FragmentUpdateApiResponse extends FragmentApiResponse {
  /** The fragment's status before this edit was applied. */
  previous_status: string;
  /**
   * True when the edit triggered a status transition
   * (e.g. approved → submitted). False for prose-only edits and draft edits.
   */
  status_changed: boolean;
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
 * Replace mutable fields of a fragment at any status (revision semantics).
 *
 * The server applies revision semantics based on the current status:
 * - draft/rejected: update in place (rejected transitions to draft).
 * - submitted/approved (analytic edit): clears prior reviews; approved
 *   transitions back to submitted.
 * - submitted/approved (prose-only): updates prose_annotation in place with
 *   no status change and no review clearing.
 *
 * Check `status_changed` in the response to surface "this edit re-opened
 * review" in the UI.
 *
 * @param id UUID of the fragment to update.
 * @throws ApiError when the fragment is not found, the caller lacks
 *         permission, or a concept id is missing from the graph.
 */
export async function updateFragment(
  id: string,
  payload: FragmentUpdatePayload,
): Promise<FragmentUpdateApiResponse> {
  return apiFetch<FragmentUpdateApiResponse>(`/api/v1/fragments/${id}`, {
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
