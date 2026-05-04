/**
 * Zod schemas and inferred TypeScript types for the corpus browse API.
 *
 * Mirrors the Pydantic response models in backend/models/browse.py.
 * Use the schema variants with apiFetch for runtime validation at the API
 * boundary. All types are derived via z.infer — do not hand-write interfaces.
 */

import { z } from 'zod';

export const ComposerSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  sort_name: z.string(),
  birth_year: z.number().nullable(),
  death_year: z.number().nullable(),
});
export type ComposerResponse = z.infer<typeof ComposerSchema>;

export const CorpusSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  source_repository: z.string().nullable(),
  licence: z.string(),
  work_count: z.number(),
});
export type CorpusResponse = z.infer<typeof CorpusSchema>;

export const WorkSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  title: z.string(),
  catalogue_number: z.string().nullable(),
  year_composed: z.number().nullable(),
  movement_count: z.number(),
});
export type WorkResponse = z.infer<typeof WorkSchema>;

export const MovementSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  movement_number: z.number(),
  title: z.string().nullable(),
  tempo_marking: z.string().nullable(),
  key_signature: z.string().nullable(),
  meter: z.string().nullable(),
  duration_bars: z.number().nullable(),
  incipit_url: z.string().nullable(),
  incipit_ready: z.boolean(),
});
export type MovementResponse = z.infer<typeof MovementSchema>;
