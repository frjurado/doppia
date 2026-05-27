/**
 * Concept API service — Component 5 Step 12.
 *
 * Wrappers for the two concept endpoints used by the tagging tool:
 *   GET /api/v1/concepts/search?q=&domain=&cursor=   (Step 3 backend)
 *   GET /api/v1/concepts/{id}/schemas                (Step 4 backend)
 *
 * All response shapes are validated with Zod at the API boundary.
 *
 * References: tagging-tool-design.md §7.1 (picker), §7.2 (Type Refinement),
 * ADR-011 §5 (stub / top_level_taggable filter), ADR-011 §7 (refinement).
 */

import { z } from 'zod';
import { apiFetch } from './api';

const BASE = '/api/v1';

// ---------------------------------------------------------------------------
// Zod schemas — shapes mirror the backend Pydantic models exactly
// ---------------------------------------------------------------------------

const PropertyValueSchema = z.object({
  id: z.string(),
  name: z.string(),
  referenced_concept: z
    .object({ id: z.string(), name: z.string(), definition: z.string().nullable() })
    .nullable()
    .optional(),
});

const PropertySchemaSchema = z.object({
  id: z.string(),
  name: z.string(),
  cardinality: z.enum(['ONE_OF', 'MANY_OF', 'BOOL']),
  required: z.boolean(),
  description: z.string().nullable().optional(),
  values: z.array(PropertyValueSchema),
});

/** A CONTAINS stage edge as returned by the backend (flat target_id / target_name). */
const ContainsStageSchema = z.object({
  target_id: z.string(),
  target_name: z.string(),
  order: z.number(),
  required: z.boolean(),
  display_mode: z.enum(['stage', 'segment']),
  containment_mode: z.enum(['contiguous', 'free']),
  default_weight: z.number(),
});

/**
 * A direct IS_SUBTYPE_OF child included in the Type Refinement section.
 * The backend only populates this list when children's CONTAINS structures
 * diverge (ADR-011 §7).  The child's own stage structure is fetched by calling
 * getConceptSchemas(child.id) when the annotator selects a refinement (Step 14).
 */
const TypeRefinementChildSchema = z.object({
  id: z.string(),
  name: z.string(),
  definition: z.string().nullable(),
});

const ConceptSchemaTreeSchema = z.object({
  concept_id: z.string(),
  /** All PropertySchemas applicable to the concept (inherited via IS_SUBTYPE_OF). */
  schemas: z.array(PropertySchemaSchema),
  /** All CONTAINS stages, ordered by order ascending. */
  stages: z.array(ContainsStageSchema),
  /**
   * Type Refinement metadata.  show=true and non-empty children when the
   * concept has IS_SUBTYPE_OF children whose CONTAINS structures differ
   * (tagging-tool-design.md §7.2).
   */
  type_refinement: z.object({
    show: z.boolean(),
    children: z.array(TypeRefinementChildSchema),
  }),
});

const ConceptSearchHitSchema = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  /**
   * Ancestor names in IS_SUBTYPE_OF order, not including the concept itself.
   * e.g. ["Cadence", "Authentic Cadence"] for PerfectAuthenticCadence.
   * Empty for top-level concepts.
   */
  hierarchy_path: z.array(z.string()),
  definition: z.string().nullable(),
});

const ConceptSearchPageSchema = z.object({
  items: z.array(ConceptSearchHitSchema),
  next_cursor: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// TypeScript types (inferred from Zod)
// ---------------------------------------------------------------------------

export type PropertyValue = z.infer<typeof PropertyValueSchema>;
export type PropertySchema = z.infer<typeof PropertySchemaSchema>;
export type ContainsStage = z.infer<typeof ContainsStageSchema>;
export type TypeRefinementChild = z.infer<typeof TypeRefinementChildSchema>;
export type ConceptSchemaTree = z.infer<typeof ConceptSchemaTreeSchema>;
export type ConceptSearchHit = z.infer<typeof ConceptSearchHitSchema>;
export type ConceptSearchPage = z.infer<typeof ConceptSearchPageSchema>;

// ---------------------------------------------------------------------------
// API functions
// ---------------------------------------------------------------------------

/**
 * Full-text search over concept names and aliases (the `concept_search` Neo4j
 * index). The server filters to stub=false AND top_level_taggable=true;
 * the client must never re-introduce excluded nodes.
 *
 * @param q      Search string. An empty string returns an empty hit list.
 * @param domain Optional domain filter, e.g. "cadences".
 * @param cursor Opaque cursor from a previous page's next_cursor field.
 */
export async function searchConcepts(
  q: string,
  domain?: string | null,
  cursor?: string | null,
): Promise<ConceptSearchPage> {
  const params = new URLSearchParams({ q });
  if (domain) params.set('domain', domain);
  if (cursor) params.set('cursor', cursor);
  return apiFetch(
    `${BASE}/concepts/search?${params.toString()}`,
    undefined,
    ConceptSearchPageSchema,
  );
}

/**
 * Fetch the full schema tree for a concept: inherited property schemas, stage
 * structure (CONTAINS edges), and structural type-refinement options.
 *
 * The response is used by:
 *  - TypeRefinement section (type_refinement.show → show radio group)
 *  - Dynamic property form (Step 13)
 *  - Stage bracket pre-population (Step 14)
 */
export async function getConceptSchemas(id: string): Promise<ConceptSchemaTree> {
  return apiFetch(
    `${BASE}/concepts/${encodeURIComponent(id)}/schemas`,
    undefined,
    ConceptSchemaTreeSchema,
  );
}
