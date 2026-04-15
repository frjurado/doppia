# ADR-007 — Prose Annotation Vectorisation

**Status:** Accepted  
**Date:** 2026-04-13

---

## Context

Fragment records include expert-authored prose annotations stored in `fragment.prose_annotation`. These annotations describe what is theoretically significant about a fragment and are the primary form of natural-language knowledge in the system. A potential Phase 3 reasoning layer would use them for semantic retrieval (RAG) — finding annotations relevant to a query by vector similarity rather than keyword matching.

Vector retrieval requires two things: a populated table of text chunks with pre-computed embeddings, and a vector-capable store to query against. Both have non-trivial setup costs:

- The embedding dimension is fixed at table creation time. Changing it requires dropping and recreating the vector column and re-embedding the entire corpus — an operation that scales with corpus size and costs money.
- Embedding generation requires calling an external API (OpenAI or equivalent) for every annotation, which is a Phase 3 concern: there is no RAG in Phase 1 or Phase 2.

The question is how much of this infrastructure to put in place during Phase 1, before any of it is needed.

Three options:

**Scaffold nothing.** Do not create any vector-related tables or columns in Phase 1. Defer all of this to Phase 3 when it is actually needed. Simpler now; requires a data migration in Phase 3 to extract and embed annotations that were written during Phase 2.

**Scaffold the table; store raw text; defer embeddings.** Create the `prose_chunk` table with its vector column (dimension fixed) and the `fragment.prose_annotation` text column from Phase 1. Store raw prose annotations as they are written. Leave the `embedding` column null. Generate embeddings in Phase 3 via a one-time backfill and ongoing background tasks.

**Generate embeddings from Phase 1.** Store and embed annotations immediately when they are submitted. Requires the OpenAI API key and embedding pipeline from day one.

The key asymmetry: storing raw text is free; the embedding dimension must be chosen before the table is created; and annotations written during Phase 1 and Phase 2 are the most valuable part of the corpus — losing them to a migration would be a real cost.

---

## Decision

Scaffold the `prose_chunk` table and the `fragment.prose_annotation` text column in Phase 1. Store prose annotations as they are written. Leave `embedding` null. Generate embeddings in Phase 3.

The embedding model is pinned now: **OpenAI `text-embedding-3-small`**, 1536 dimensions. This fixes the vector column dimension at table creation.

```sql
CREATE TABLE prose_chunk (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    content_type    TEXT NOT NULL
                        CHECK (content_type IN ('concept_annotation', 'fragment_annotation', 'blog_post')),
    source_id       TEXT NOT NULL,
    chunk_text      TEXT NOT NULL,
    embedding       vector(1536),       -- null until Phase 3
    created_at      TIMESTAMPTZ DEFAULT now()
);
-- IVFFlat index created in Phase 3 once embeddings are populated:
-- CREATE INDEX prose_chunk_embedding_idx
--     ON prose_chunk USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

The `prose_chunk` table is populated from three sources: `fragment.prose_annotation`, concept node definitions, and blog post body text. In Phase 1, only fragment annotations are being written; the table will contain rows with null embeddings for those annotations. The Phase 3 backfill generates embeddings for all existing rows and switches to populating `embedding` immediately on new inserts.

---

## Consequences

**Positive**

- No data migration in Phase 3. Annotations written during Phase 1 and Phase 2 are already in the `prose_chunk` table, ready to be embedded. The backfill is a background job, not an archaeology project.
- The embedding model and dimension are a documented, version-controlled decision rather than a choice made under time pressure during Phase 3.
- pgvector runs inside the existing PostgreSQL instance (Supabase). No additional managed service is needed.
- Raw text in `fragment.prose_annotation` is queryable by simple `LIKE` or `pg_trgm` full-text search from Phase 2, before any embedding is generated. This is useful for editorial tooling independent of any future reasoning layer.

**Negative**

- The embedding dimension (1536) is fixed at table creation. If a better embedding model with a different dimension supersedes `text-embedding-3-small` before Phase 3, changing models requires dropping and recreating the column and re-embedding the entire corpus. The cost of this operation scales with corpus size.
- The `prose_chunk` table will have null `embedding` values for its entire Phase 1 and Phase 2 lifetime. This is intentional but requires that any Phase 3 code reading the table checks for null before attempting similarity queries.

**Neutral**

- The IVFFlat index is not created until Phase 3. Creating it on a table of mostly-null vectors would be wasteful and would need to be recreated once the corpus is populated. The commented-out `CREATE INDEX` statement in the schema is a reminder, not dead code.
- `text-embedding-3-small` at 1536 dimensions is the practical default as of this decision. It can be replaced by any model that produces 1536-dimensional vectors without touching the schema. A model that produces a different dimension requires a schema migration.

---

## Alternatives considered

**Scaffold nothing; defer to Phase 3.** Rejected because annotations written during Phases 1 and 2 are the highest-value content in the system — expert prose about specific fragments is not recoverable from the MEI files themselves. A Phase 3 migration would require identifying all prose annotations written to date, re-importing them into the vector store, and verifying completeness. Storing raw text from day one avoids this entirely.

**Generate embeddings from Phase 1.** Rejected. The OpenAI API key and the embedding background task are Phase 3 concerns. Adding them to Phase 1 adds operational complexity and ongoing API costs before any consumer of embeddings exists. The marginal benefit — slightly more populated embeddings at Phase 3 launch — does not justify the cost.
