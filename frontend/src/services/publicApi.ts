/**
 * Public (anonymous) API client — Component 10 Step 5.
 *
 * Wraps the unauthenticated read surface added in Step 3:
 *   GET /api/v1/public/fragments               — browse approved fragments by concept
 *   GET /api/v1/public/fragments/{id}          — read one approved fragment
 *
 * These go through the shared `apiFetch`, which attaches a Bearer token only
 * when a session exists — so an anonymous caller sends no Authorization header,
 * exactly as the public router expects. The response shapes are identical to
 * the editor read surface (only `approved` fragments are ever returned, and a
 * NonCommercial-corpus fragment is 404), so the existing `ConceptBrowseResponse`
 * / `FragmentDetailResponse` types are reused verbatim.
 *
 * The public browse has no `status` parameter — the status is fixed to
 * `approved` server-side (see backend/api/routes/public.py).
 *
 * References:
 *   docs/roadmap/component-10-foundations-public-read-path.md § Steps 3, 5
 *   backend/api/routes/public.py
 */

import { apiFetch } from './api';
import type { ConceptBrowseResponse, FragmentDetailResponse } from './fragmentApi';

/**
 * Browse approved fragments by concept tag, anonymously.
 *
 * The public counterpart of {@link listByConcept}: same response shape, but no
 * authentication and no `status` filter (the server pins `approved`).
 *
 * @param conceptId  Neo4j Concept id to browse (e.g. "AuthenticCadence").
 * @param options.includeSubtypes  Include subtypes (default true).
 * @param options.cursor           Opaque cursor from a prior response.
 * @param options.pageSize         Items per page (1–200, default 50).
 * @throws ApiError on a malformed cursor or network failure.
 */
export async function listPublicFragmentsByConcept(
  conceptId: string,
  options: {
    includeSubtypes?: boolean;
    cursor?: string;
    pageSize?: number;
  } = {}
): Promise<ConceptBrowseResponse> {
  const { includeSubtypes = true, cursor, pageSize } = options;
  const params = new URLSearchParams({ concept_id: conceptId });
  params.set('include_subtypes', String(includeSubtypes));
  if (cursor !== undefined) params.set('cursor', cursor);
  if (pageSize !== undefined) params.set('page_size', String(pageSize));
  return apiFetch<ConceptBrowseResponse>(`/api/v1/public/fragments?${params}`);
}

/**
 * Fetch one approved fragment, anonymously.
 *
 * Any fragment that is not `approved`, or that belongs to a NonCommercial
 * corpus (ADR-009 § 2), returns a 404 indistinguishable from a nonexistent id.
 *
 * @param id UUID of the fragment to read.
 * @throws ApiError on 404 (not found / not public) or network failure.
 */
export async function getPublicFragment(id: string): Promise<FragmentDetailResponse> {
  return apiFetch<FragmentDetailResponse>(`/api/v1/public/fragments/${id}`);
}
