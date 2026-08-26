# Four External Services

## What they are
Doppia uses four cloud services in production. Each replaces a local Docker container with a managed, hosted version of the same technology — no code changes required, just different environment variables.

---

## Supabase (Authentication)
**What it is:** A hosted authentication platform. Think of it as a login service you rent instead of build.

**What it does:** When a user logs in, Supabase issues a signed JWT (a tamper-proof token). Every API request includes that token. The backend (`api/middleware/auth.py`) checks the signature and extracts the user's ID and role. In local dev, a literal string `dev-token` bypasses this entirely.

---

## Cloudflare R2 (File Storage)
**What it is:** S3-compatible blob storage — like a hard drive in the cloud — provided by Cloudflare.

**What it does:** Stores MEI musical notation files (originals for audit, normalized copies for processing) and Verovio-rendered SVG previews. Files are referenced by a structured key like `mozart/k331/movement-1.mei`. The backend (`services/object_storage.py`) generates time-limited signed URLs so the frontend can fetch files directly without going through the API. Locally, MinIO plays the same role.

---

## Neo4j AuraDB (Knowledge Graph)
**What it is:** A hosted graph database — a database where the relationships between items are first-class data, not just foreign keys.

**What it does:** Stores the music theory knowledge graph: concepts (cadences, harmonies, forms), their hierarchical types, and relationships like "is a subtype of", "is a prerequisite for", or "resolves to". This graph drives concept tagging, pedagogical ordering, and eventually exercise generation. Locally, a plain Neo4j 5 container stands in.

---

## Upstash Redis (Task Queue)
**What it is:** A hosted Redis instance. Redis is an in-memory store used here as a message broker.

**What it does:** When a MEI file is uploaded, the API drops a job into a Celery task queue backed by Redis. A background worker picks it up and runs music21 analysis off the request path — so the API returns immediately and heavy processing happens asynchronously. Locally, a Docker Redis container does the same job.

---

## Environment pattern
All four services are configured purely through environment variables (`R2_ENDPOINT_URL`, `NEO4J_URI`, `REDIS_URL`, `SUPABASE_URL`, etc.). The same codebase runs locally against Docker containers and in production against managed cloud services — no branching, no environment-specific code paths.
