/**
 * Fragment API client — write surface (Component 5), read surface (Component 7),
 * and concept-scoped browse (Component 8 Step 2).
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
 * Browse endpoint (Step 2, Component 8):
 *   GET    /api/v1/fragments?concept_id={id}           — concept-scoped browse
 *
 * Delete endpoint (Step 9, Component 7):
 *   DELETE /api/v1/fragments/{id}        — delete with permission checks and cascade
 *
 * Review queue (Step 13, Component 7):
 *   GET    /api/v1/reviews/queue         — submitted fragments awaiting review
 *
 * Review actions (Step 14, Component 7):
 *   POST   /api/v1/fragments/{id}/approve — record approval vote + gate check
 *   POST   /api/v1/fragments/{id}/reject  — reject with optional comment
 *
 * Type definitions mirror the Python Pydantic models in
 * backend/models/fragment.py. The summary JSONB schema follows
 * fragment-schema.md version 1.
 *
 * References:
 *   docs/roadmap/component-5-tagging-tool.md §§ Step 6, Step 18
 *   docs/roadmap/component-7-fragment-database.md §§ Step 7, Step 8, Step 9
 *   docs/roadmap/component-8-fragment-browsing.md §§ Step 2, Step 3
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
  /** Effective per-fragment data licence (ADR-009), e.g. "CC BY-SA 4.0". */
  data_licence: string | null;
  /** Canonical URL for data_licence, e.g. "https://creativecommons.org/licenses/by-sa/4.0/". */
  data_licence_url: string | null;
  /** Sorted distinct source values from in-range harmony events (ADR-009). */
  harmony_sources: string[];
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  created_by: string | null;
  created_at: string;
  updated_at: string;
  concept_tags: ConceptTagDetail[];
  /** Harmony events sliced from movement_analysis over this fragment's bar range. */
  harmony_events: Record<string, unknown>[];
  /** Sub-part (stage) fragments nested one level deep (ADR-011 two-level limit). */
  sub_parts: FragmentDetailResponse[];
  // Movement context — populated on top-level fragments; null on sub-parts (Step 9).
  composer_name: string | null;
  work_title: string | null;
  work_catalogue_number: string | null;
  movement_number: number | null;
  movement_title: string | null;
  // Signed URLs resolved at request time (ADR-002); never stored (Step 9).
  mei_url: string | null;
  preview_url: string | null;
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
  /** Full name of the primary concept (label fallback when no alias), or null. */
  primary_concept_name: string | null;
  sub_parts: FragmentListItem[];
}

/** Cursor-paginated list response for GET /api/v1/movements/{id}/fragments. */
export interface FragmentListResponse {
  items: FragmentListItem[];
  /** Opaque cursor to pass as `cursor` to fetch the next page. Null on last page. */
  next_cursor: string | null;
}

/**
 * One row in the reviewer work-queue (GET /api/v1/reviews/queue).
 *
 * Includes movement context so a reviewer can triage without fetching each
 * fragment individually. `submitted_at` is `fragment.updated_at` at read time
 * (the last write transitioned the fragment to submitted).
 */
export interface ReviewQueueItem {
  id: string;
  movement_id: string;
  bar_start: number;
  bar_end: number;
  mc_start: number;
  mc_end: number;
  beat_start: number | null;
  beat_end: number | null;
  repeat_context: string | null;
  status: 'submitted';
  primary_concept_id: string | null;
  /** Abbreviated concept label, e.g. "PAC". Null when no alias is set. */
  primary_concept_alias: string | null;
  created_by: string | null;
  /** ISO datetime of the last status transition (approximates submission time). */
  submitted_at: string;
  composer_name: string;
  work_title: string;
  work_catalogue_number: string | null;
  movement_number: number;
  movement_title: string | null;
}

/** Cursor-paginated response for GET /api/v1/reviews/queue. */
export interface ReviewQueueResponse {
  items: ReviewQueueItem[];
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

// ---------------------------------------------------------------------------
// Concept-scoped browse (Component 8 Step 2)
// ---------------------------------------------------------------------------

/**
 * One fragment card in the concept-scoped browse list.
 * Maps to Python ConceptBrowseItem in backend/models/fragment.py.
 *
 * `preview_url` is null until Step 5 (fragment-preview Celery task) generates
 * the SVG. `data_licence` is the stored per-fragment licence derived from
 * in-range harmony event sources at write time (ADR-009). `data_licence_url`
 * is the canonical URL for that licence. `harmony_sources` is the sorted set
 * of distinct source values from in-range movement_analysis events (ADR-009).
 */
export interface ConceptBrowseItem {
  id: string;
  movement_id: string;
  bar_start: number;
  bar_end: number;
  beat_start: number | null;
  beat_end: number | null;
  repeat_context: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected';
  primary_concept_id: string | null;
  /** First alias of the primary concept (e.g. "PAC"), or null. */
  primary_concept_alias: string | null;
  /** Full name of the primary concept, or null if no primary tag. */
  primary_concept_name: string | null;
  /** Effective per-fragment data licence (ADR-009), e.g. "CC BY-SA 4.0". */
  data_licence: string | null;
  /** Canonical URL for data_licence, e.g. "https://creativecommons.org/licenses/by-sa/4.0/". */
  data_licence_url: string | null;
  /** Sorted distinct source values from in-range harmony events (ADR-009). */
  harmony_sources: string[];
  /** Signed URL for the server-rendered SVG preview (null until Step 5). */
  preview_url: string | null;
  created_by: string | null;
  /** ISO datetime of the last status transition or edit. */
  updated_at: string;
  composer_name: string;
  work_title: string;
  work_catalogue_number: string | null;
  movement_number: number;
  movement_title: string | null;
}

/** Cursor-paginated concept-scoped browse response. */
export interface ConceptBrowseResponse {
  items: ConceptBrowseItem[];
  /** Opaque cursor to pass as `cursor` to fetch the next page. Null on last page. */
  next_cursor: string | null;
  /** Echoed back from the request for result identification. */
  concept_id: string;
  include_subtypes: boolean;
}

/**
 * Browse fragments by concept tag across the full corpus.
 *
 * Returns fragments whose concept tags include the given concept (and, when
 * `includeSubtypes` is true, any of its non-stub subtypes). A fragment
 * matches on any of its tags — not only the primary one — so cross-referenced
 * fragments surface under every relevant concept. Fragments with multiple
 * matching tags appear exactly once.
 *
 * Status visibility is enforced by the server: editors see their own drafts
 * plus all submitted/approved/rejected fragments.
 *
 * @param conceptId   Neo4j Concept id to browse (e.g. "AuthenticCadence").
 * @param options.includeSubtypes  Include subtypes (default true).
 * @param options.status           Fragment status filter (default "approved").
 * @param options.cursor           Opaque cursor from a prior response.
 * @param options.pageSize         Items per page (1–200, default 50).
 * @throws ApiError on auth errors or a malformed cursor.
 */
export async function listByConcept(
  conceptId: string,
  options: {
    includeSubtypes?: boolean;
    status?: 'draft' | 'submitted' | 'approved' | 'rejected';
    cursor?: string;
    pageSize?: number;
  } = {},
): Promise<ConceptBrowseResponse> {
  const {
    includeSubtypes = true,
    status = 'approved',
    cursor,
    pageSize,
  } = options;
  const params = new URLSearchParams({ concept_id: conceptId });
  params.set('include_subtypes', String(includeSubtypes));
  params.set('status', status);
  if (cursor !== undefined) params.set('cursor', cursor);
  if (pageSize !== undefined) params.set('page_size', String(pageSize));
  return apiFetch<ConceptBrowseResponse>(`/api/v1/fragments?${params}`);
}

// ---------------------------------------------------------------------------
// Delete (Component 7 Step 9)
// ---------------------------------------------------------------------------

/**
 * Response from DELETE /api/v1/fragments/{id}.
 *
 * ``child_count`` is the number of sub-part children removed by the cascade
 * (or that *would* be removed when ``dry_run`` is true).
 * ``movement_analysis`` rows are never deleted.
 */
export interface FragmentDeleteResponse {
  fragment_id: string;
  child_count: number;
  dry_run: boolean;
}

/**
 * Preview how many sub-parts would be deleted without deleting anything.
 *
 * Calls DELETE with ``dry_run=true``. Permission checks still run — a 403/422
 * is thrown if the caller lacks delete permission.
 *
 * @param id UUID of the fragment to preview.
 * @throws ApiError on auth errors or permission failure.
 */
export async function previewFragmentDelete(
  id: string,
): Promise<FragmentDeleteResponse> {
  return apiFetch<FragmentDeleteResponse>(
    `/api/v1/fragments/${id}?dry_run=true`,
    { method: 'DELETE' },
  );
}

/**
 * Delete a fragment, its sub-parts, and their concept tags.
 *
 * The server enforces the delete permission matrix:
 * - Creators may delete their own draft / submitted / rejected fragments.
 * - Approved fragments can only be deleted by admins.
 * - Non-creators cannot delete any fragment.
 *
 * When the fragment has sub-parts, pass ``confirmCascade: true`` to authorise
 * the cascade deletion. Without it the server returns 422 with
 * ``detail.child_count`` — use ``previewFragmentDelete`` first if you need
 * the count before prompting the user.
 *
 * @param id UUID of the fragment to delete.
 * @param confirmCascade Set true to authorise deleting sub-parts as well.
 * @throws ApiError on 404 (not found), 422 (permission denied or cascade
 *   confirmation missing), or auth errors.
 */
export async function deleteFragment(
  id: string,
  confirmCascade = false,
): Promise<FragmentDeleteResponse> {
  const params = new URLSearchParams();
  if (confirmCascade) params.set('confirm_cascade', 'true');
  const qs = params.size > 0 ? `?${params}` : '';
  return apiFetch<FragmentDeleteResponse>(`/api/v1/fragments/${id}${qs}`, {
    method: 'DELETE',
  });
}

/**
 * Fetch the reviewer work-queue: submitted fragments the caller is eligible
 * to review (creator-excluded; admins see all).
 *
 * Results are ordered by submission time descending (most recent first).
 * Pass the `next_cursor` from a prior response to paginate.
 *
 * @throws ApiError on auth errors or network failure.
 */
export async function listReviewQueue(
  cursor?: string,
  pageSize = 50,
): Promise<ReviewQueueResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set('cursor', cursor);
  params.set('page_size', String(pageSize));
  return apiFetch<ReviewQueueResponse>(`/api/v1/reviews/queue?${params}`);
}

// ---------------------------------------------------------------------------
// Review actions (Component 7 Step 14)
// ---------------------------------------------------------------------------

/**
 * Structured detail returned by 422 HARMONY_NOT_REVIEWED when the approval
 * gate fails. Both fields are optional — one or both may be present.
 *
 * The approval vote is persisted server-side even when the gate fails, so
 * the reviewer does not need to re-vote after the creator fixes the blocking
 * items — they simply retry the approve call.
 *
 * Maps to the `detail` dict in `HarmonyNotReviewedError` (backend/errors.py).
 */
export interface ApprovalGateDetail {
  /** The actual_key with auto: true and reviewed: false, if any. */
  unreviewed_actual_key?: {
    value: string;
    auto: boolean;
    reviewed: boolean;
    confidence?: number | null;
  };
  /** Harmony events in the fragment's bar range that have reviewed: false. */
  unreviewed_harmony_events?: Record<string, unknown>[];
}

/**
 * Record an approval vote for a submitted fragment.
 *
 * The server persists the vote even when the gate fails (422
 * HARMONY_NOT_REVIEWED), so the creator can fix blocking items without the
 * reviewer re-voting. Inspect `ApiError.detail` as `ApprovalGateDetail` when
 * `err.code === 'HARMONY_NOT_REVIEWED'`.
 *
 * On success: returns the fragment in 'approved' status when the gate passed
 * and the approval threshold was met; still 'submitted' when the threshold
 * requires additional reviewers.
 *
 * @param id UUID of the submitted fragment.
 * @param comment Optional comment to accompany the approval.
 * @throws ApiError (HARMONY_NOT_REVIEWED) when gate items block approval.
 * @throws ApiError (SELF_REVIEW_FORBIDDEN) when the caller is the creator.
 */
export async function approveFragment(
  id: string,
  comment?: string,
): Promise<FragmentApiResponse> {
  return apiFetch<FragmentApiResponse>(`/api/v1/fragments/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ comment: comment ?? null }),
  });
}

/**
 * Reject a submitted fragment, transitioning it to 'rejected'.
 *
 * A single rejection immediately flips the status regardless of prior
 * approval votes. The creator can revise by editing the fragment
 * (revision semantics transition rejected → draft) and resubmitting.
 *
 * @param id UUID of the submitted fragment.
 * @param comment Optional comment explaining the rejection.
 * @throws ApiError (SELF_REVIEW_FORBIDDEN) when the caller is the creator.
 */
export async function rejectFragment(
  id: string,
  comment?: string,
): Promise<FragmentApiResponse> {
  return apiFetch<FragmentApiResponse>(`/api/v1/fragments/${id}/reject`, {
    method: 'POST',
    body: JSON.stringify({ comment: comment ?? null }),
  });
}
