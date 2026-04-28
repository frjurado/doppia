# ADR-002 — File Storage

**Status:** Accepted
**Date:** 2026-03-27

---

## Context

The system stores MEI files as the authoritative, archival representation of each score. These files are uploaded at corpus ingestion time and subsequently fetched by the backend for preprocessing (music21 analysis, Verovio server-side rendering) and by the frontend for client-side rendering. The fragment database stores a pointer to each MEI file, not the file content itself.

The `mei_object_key` column in the `movement` table must reference MEI files by a stable, environment-agnostic identifier. Fragments inherit the MEI source through their `movement_id` foreign key — there is no `mei_file` column on the fragment table. Absolute filesystem paths are not environment-agnostic and break between local development and any deployed environment.

MEI files are text (XML), typically 50KB–2MB per movement. Storage volume at Phase 1 scale is modest (hundreds of files); it grows with the corpus but does not approach the scale where per-GB cost is a primary concern.

The practical options evaluated were:

**Local filesystem with Docker volume mount** — zero configuration, available immediately, not viable in production without additional tooling (shared volume or NFS mount for multi-instance deployments). Creates a structural divergence between local and production environments.

**AWS S3** — the reference implementation for S3-compatible object storage. Mature, well-documented, generous ecosystem support. Egress costs are non-trivial at scale; free tier is limited.

**Cloudflare R2** — S3-compatible API, so application code is identical to S3. Zero egress fees (files served from R2 do not incur per-GB egress charges when accessed from the application backend or via public URL). Storage cost is comparable to S3. No free tier, but costs at Phase 1 volume are negligible.

**MinIO** — S3-compatible open-source object store designed for self-hosting and local development. Not a production service on its own, but an exact S3-compatible API replacement suitable for Docker Compose.

The requirement is an approach that: (a) is identical in application code between local and production environments, (b) requires no migration when moving between environments, and (c) is low-cost at Phase 1 and Phase 2 scale.

---

## Decision

Use **Cloudflare R2** for production and staging file storage, and **MinIO** as the local development equivalent.

Both expose the same S3-compatible API. The application interacts with file storage exclusively through the `boto3`/`aioboto3` S3 client, configured via environment variables (`R2_ENDPOINT_URL`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`). Switching between MinIO and R2 requires only changing environment variable values; no application code changes.

The `mei_object_key` column stores an **S3 object key** — not a URL, not a path. The format is:

```
{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei
```

Example: `mozart/piano-sonatas/k331/movement-1.mei`

The four-component path mirrors the Composer → Corpus → Work → Movement browsing hierarchy.

The application layer resolves object keys to signed URLs at request time when the frontend needs to fetch a file directly, or fetches the file to a temporary path for backend processing. Nothing stores a resolved URL — URLs expire; object keys do not.

---

## Consequences

**Positive**

- Application code is environment-agnostic. The same code path runs against MinIO locally and R2 in staging and production.
- No migration when moving from development to staging: the corpus must be re-uploaded to the staging bucket (a one-time seeding operation), but no code changes or schema migrations are required.
- R2's zero egress cost is advantageous for a system where MEI files are fetched on every score render — egress costs on S3 would accumulate proportionally with corpus size and user activity.
- Object keys are stable identifiers. Renaming a bucket, switching regions, or changing providers requires updating the endpoint configuration, not the stored keys.

**Negative**

- MinIO must be included in the Docker Compose stack from day one, adding a service even though it is not load-bearing in Phase 1. This is a small overhead.
- R2 has no free tier. At Phase 1 volume (hundreds of MEI files, low traffic) the cost is negligible, but it is not zero.
- Signed URL generation adds a step to the request path when the frontend needs to fetch a file directly. This is a minor operational overhead, not a correctness concern.

**Neutral**

- The S3-compatible API is stable and well-supported across tooling. `aioboto3` (async) is the Python client used throughout; no R2-specific SDK is required.
- Static SVG assets (Verovio-rendered incipits and fragment previews) are stored in the same bucket as MEI files. The full key inventory is:
  - **Normalized MEI** — `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei`
  - **Original MEI** — `originals/{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei` (preserved pre-normalisation copy; see ADR-014)
  - **Incipit SVG** — `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/incipit.svg` (per-movement first-page render for the browse view; written by the `generate_incipit` Celery task)
  - **Fragment preview SVG** — `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/fragments/{fragment_id}.svg` (per-fragment thumbnail; written at submission time per ADR-008; Component 4+)

  The same `aioboto3` client and key-resolution logic applies to all four asset types. `services/object_storage.py` documents the full set.

---

## Alternatives considered

**Local filesystem with Docker volume.** Rejected because it creates a structural environment divergence that must be resolved before production anyway. Solving it at the start costs less than solving it later after some data has been stored with absolute-path references.

**AWS S3.** Rejected in favour of R2 on cost grounds. The APIs are identical; R2's zero egress fee is strictly better for a system that serves files on every render request. If R2 becomes unavailable or inadequate, migrating to S3 is a configuration change, not a code change.

**Storing files in PostgreSQL (large object or bytea).** Rejected. PostgreSQL is the wrong tool for binary file storage at this volume. It would bloat the database, complicate backups, and perform worse than object storage for the random-access read pattern (fetching one movement's MEI file per render).
