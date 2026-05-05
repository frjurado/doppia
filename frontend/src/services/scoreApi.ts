/**
 * Score viewer API service.
 *
 * Thin wrapper for the score viewer's MEI URL endpoint. Components never call
 * the fetch directly — they go through this service so the URL structure and
 * Zod validation are centralised.
 *
 * Endpoint (requires editor role in Phase 1):
 *   GET /api/v1/movements/{movementId}/mei-url
 */

import { z } from 'zod';
import { apiFetch } from './api';

const BASE = '/api/v1';

const MeiUrlSchema = z.object({ url: z.string() });
type MeiUrlResponse = z.infer<typeof MeiUrlSchema>;

/**
 * Fetch a fresh signed URL for a movement's normalised MEI file.
 *
 * The URL is valid for 15 minutes. Callers must fetch the MEI text
 * immediately via the returned URL — the URL itself should not be
 * stored or reused across sessions.
 *
 * @param movementId - UUID of the movement.
 * @returns Object with the signed `url` string.
 * @throws ApiError with status 404 if the movement is not found.
 */
export async function fetchMeiUrl(movementId: string): Promise<MeiUrlResponse> {
  return apiFetch(
    `${BASE}/movements/${encodeURIComponent(movementId)}/mei-url`,
    undefined,
    MeiUrlSchema,
  );
}
