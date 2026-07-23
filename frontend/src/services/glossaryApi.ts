/**
 * Glossary API client — Component 11 Step 5.
 *
 * Wraps the public (anonymous) concept surface added in Part 1:
 *   GET /api/v1/public/concepts/{id}            — concept-page payload (Step 1)
 *   GET /api/v1/public/concepts/{id}/examples   — example draw (Step 3, Step 6)
 *   GET /api/v1/public/concepts                 — browse index (Step 4, Step 7)
 *
 * The index wrapper lands with Step 7 (it consumes the § Step 4b shape).
 *
 * Sibling to `publicApi.ts`: same anonymous posture (the shared `apiFetch`
 * attaches a Bearer token only when a session exists, so an anonymous reader
 * sends no Authorization header). Responses are validated with Zod at the API
 * boundary, as `conceptApi.ts` does for the editor concept surface.
 *
 * References:
 *   docs/roadmap/component-11-concept-glossary.md § Steps 1, 5, 6
 *   backend/api/routes/public_concepts.py
 *   backend/models/concepts.py (ConceptDetailResponse)
 *   backend/models/fragment.py (ConceptExamplesResponse)
 */

import { z } from 'zod';
import { apiFetch } from './api';
import type { ConceptBrowseItem } from './fragmentApi';

const BASE = '/api/v1/public/concepts';

// ---------------------------------------------------------------------------
// Zod schemas — shapes mirror the backend Pydantic models exactly
// ---------------------------------------------------------------------------

/**
 * A lightweight reference to a concept: a hierarchy neighbour or an edge target.
 *
 * `stub` marks a concept whose domain Doppia has not modelled yet. Stub targets
 * are returned rather than hidden — the page renders them as flagged non-links
 * ("not yet covered") so inbound references stay honest.
 */
const ConceptRefSchema = z.object({
  id: z.string(),
  name: z.string(),
  stub: z.boolean(),
});

/**
 * One typed concept-to-concept relationship from the controlled vocabulary
 * (`docs/architecture/edge-vocabulary-reference.md`). IS_SUBTYPE_OF is not here
 * — the hierarchy is surfaced separately as `parent` / `children`.
 */
const ConceptRelationshipSchema = z.object({
  type: z.string(),
  direction: z.enum(['outgoing', 'incoming']),
  target: ConceptRefSchema,
});

const ConceptDetailSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  definition: z.string().nullable(),
  domain: z.string().nullable(),
  complexity: z.string().nullable(),
  stub: z.boolean(),
  /**
   * False until the annotator-facing prose has passed editorial review
   * (Step 2). The page substitutes an "under editorial review" placeholder —
   * the raw prose is never shown to a public reader.
   */
  definition_reviewed: z.boolean(),
  top_level_taggable: z.boolean(),
  /** Ancestor names from the domain root to this concept, inclusive. */
  hierarchy_path: z.array(z.string()),
  parent: ConceptRefSchema.nullable(),
  children: z.array(ConceptRefSchema),
  relationships: z.array(ConceptRelationshipSchema),
});

// ---------------------------------------------------------------------------
// TypeScript types (inferred from Zod)
// ---------------------------------------------------------------------------

export type ConceptRef = z.infer<typeof ConceptRefSchema>;
export type ConceptRelationship = z.infer<typeof ConceptRelationshipSchema>;
export type ConceptDetail = z.infer<typeof ConceptDetailSchema>;

/**
 * A random draw of approved example fragments for one concept (Step 3).
 *
 * Maps to Python `ConceptExamplesResponse` in backend/models/fragment.py. Not
 * paginated — a fixed-size sample re-drawn on each call, which is what the
 * shuffle control re-requests. The items are `ConceptBrowseItem`s, identical to
 * the anonymous browse's, so the same preview card renders both; they are
 * passed through with that type rather than re-declared as a Zod schema, so the
 * card's contract has exactly one definition (as `publicApi.ts` does for the
 * browse itself).
 */
export interface ConceptExamplesResponse {
  examples: ConceptBrowseItem[];
  concept_id: string;
  include_subtypes: boolean;
}

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Fetch one concept's public glossary page payload, anonymously.
 *
 * The concept `id` is the public URL key (§ Decisions 1): it is immutable, and
 * it is the same key `/public/concepts?concept=<id>` already takes.
 *
 * @param conceptId Immutable Concept id, e.g. "PerfectAuthenticCadence".
 * @throws ApiError with code `CONCEPT_NOT_FOUND` (404) for an unknown id.
 */
export async function getPublicConcept(conceptId: string): Promise<ConceptDetail> {
  return apiFetch(`${BASE}/${encodeURIComponent(conceptId)}`, undefined, ConceptDetailSchema);
}

/**
 * Draw random approved example fragments for a concept, anonymously.
 *
 * Each call re-draws server-side (`ORDER BY random()`), so the glossary's
 * shuffle control is simply another call. An unknown concept id is not an error
 * — it resolves to an empty pool and returns no examples.
 *
 * @param conceptId Immutable Concept id whose examples to draw.
 * @param options.limit           Maximum examples to draw (1–12, default 3).
 * @param options.includeSubtypes Include subtype fragments (default true).
 * @param options.seed            Integer for a reproducible draw; omit to shuffle.
 * @throws ApiError on network failure.
 */
export async function getPublicConceptExamples(
  conceptId: string,
  options: { limit?: number; includeSubtypes?: boolean; seed?: number } = {}
): Promise<ConceptExamplesResponse> {
  const { limit, includeSubtypes, seed } = options;
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(limit));
  if (includeSubtypes !== undefined) params.set('include_subtypes', String(includeSubtypes));
  if (seed !== undefined) params.set('seed', String(seed));
  const query = params.toString();
  return apiFetch<ConceptExamplesResponse>(
    `${BASE}/${encodeURIComponent(conceptId)}/examples${query ? `?${query}` : ''}`
  );
}
