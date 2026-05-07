/**
 * Browse API service.
 *
 * Thin wrappers over the four corpus browse endpoints. Each function maps
 * to one endpoint in the Composer → Corpus → Work → Movement hierarchy.
 * All responses are validated against Zod schemas at the API boundary.
 *
 * Endpoints (all require editor role in Phase 1):
 *   GET /api/v1/composers
 *   GET /api/v1/composers/{composerSlug}/corpora
 *   GET /api/v1/composers/{composerSlug}/corpora/{corpusSlug}/works
 *   GET /api/v1/works/{workId}/movements
 */

import { z } from 'zod';
import { apiFetch } from './api';
import {
  ComposerSchema,
  CorpusSchema,
  MovementSchema,
  WorkSchema,
} from '../types/browse';
import type {
  ComposerResponse,
  CorpusResponse,
  MovementResponse,
  WorkResponse,
} from '../types/browse';

const BASE = '/api/v1';

/**
 * Fetch all composers, ordered alphabetically by sort_name.
 */
export async function fetchComposers(): Promise<ComposerResponse[]> {
  return apiFetch(`${BASE}/composers`, undefined, z.array(ComposerSchema));
}

/**
 * Fetch all corpora for the given composer.
 *
 * @throws ApiError with status 404 if the composer slug is not found.
 */
export async function fetchCorpora(composerSlug: string): Promise<CorpusResponse[]> {
  return apiFetch(
    `${BASE}/composers/${encodeURIComponent(composerSlug)}/corpora`,
    undefined,
    z.array(CorpusSchema),
  );
}

/**
 * Fetch all works in the given corpus, ordered by catalogue_number.
 *
 * @throws ApiError with status 404 if the composer or corpus slug is not found.
 */
export async function fetchWorks(
  composerSlug: string,
  corpusSlug: string,
): Promise<WorkResponse[]> {
  return apiFetch(
    `${BASE}/composers/${encodeURIComponent(composerSlug)}/corpora/${encodeURIComponent(corpusSlug)}/works`,
    undefined,
    z.array(WorkSchema),
  );
}

/**
 * Fetch all movements for the given work, ordered by movement_number.
 *
 * Includes signed incipit URLs (valid 15 minutes) where available.
 *
 * @throws ApiError with status 404 if the work ID is not found.
 */
export async function fetchMovements(workId: string): Promise<MovementResponse[]> {
  return apiFetch(
    `${BASE}/works/${encodeURIComponent(workId)}/movements`,
    undefined,
    z.array(MovementSchema),
  );
}
