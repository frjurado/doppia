/**
 * TypeScript types for the corpus browse API.
 *
 * Mirrors the Pydantic response models in backend/models/browse.py.
 * All fields are read-only; these types are used only for API responses.
 */

export interface ComposerResponse {
  id: string;
  slug: string;
  name: string;
  sort_name: string;
  birth_year: number | null;
  death_year: number | null;
}

export interface CorpusResponse {
  id: string;
  slug: string;
  title: string;
  source_repository: string | null;
  licence: string;
  work_count: number;
}

export interface WorkResponse {
  id: string;
  slug: string;
  title: string;
  catalogue_number: string | null;
  year_composed: number | null;
  movement_count: number;
}

export interface MovementResponse {
  id: string;
  slug: string;
  movement_number: number;
  title: string | null;
  tempo_marking: string | null;
  key_signature: string | null;
  meter: string | null;
  duration_bars: number | null;
  incipit_url: string | null;
  incipit_ready: boolean;
}
