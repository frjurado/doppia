-- Initialise extensions for the Doppia database.
-- This script runs once when the PostgreSQL container is first created.

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector: prose embedding layer (Phase 3)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";  -- gen_random_uuid() fallback
