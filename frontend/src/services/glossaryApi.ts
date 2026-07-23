/**
 * Glossary API client — Component 11 Step 5.
 *
 * Wraps the public (anonymous) concept surface added in Part 1:
 *   GET /api/v1/public/concepts/{id}            — concept-page payload (Step 1)
 *   GET /api/v1/public/concepts/{id}/examples   — example draw (Step 3, Step 6)
 *   GET /api/v1/public/concepts                 — browse index (Step 4, Step 7)
 *
 * Only the concept-detail wrapper exists so far; the examples and index
 * wrappers land with the frontend steps that consume them.
 *
 * Sibling to `publicApi.ts`: same anonymous posture (the shared `apiFetch`
 * attaches a Bearer token only when a session exists, so an anonymous reader
 * sends no Authorization header). Responses are validated with Zod at the API
 * boundary, as `conceptApi.ts` does for the editor concept surface.
 *
 * References:
 *   docs/roadmap/component-11-concept-glossary.md § Steps 1, 5
 *   backend/api/routes/public_concepts.py
 *   backend/models/concepts.py (ConceptDetailResponse)
 */

import { z } from 'zod';
import { apiFetch } from './api';

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
