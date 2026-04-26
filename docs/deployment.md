# Deployment

## Overview

The system runs in two non-local environments: **staging** and **production**. Both use the same production-grade managed services; staging differs only in scale tier and access restrictions. There is no environment-specific code path — the application reads its configuration from environment variables and behaves identically in both.

Phase 1 has no public-facing product. Staging in Phase 1 is an internal environment accessible to the team (annotators and developers) only. Access is controlled by Supabase Auth; there is no public registration.

---

## Service mapping

| Local (Docker Compose) | Staging / Production | Notes |
|---|---|---|
| `neo4j` container | Neo4j AuraDB | Free tier for development and staging; AuraDB Professional when production load warrants it |
| `postgres` container | Supabase | Includes pgvector, Supabase Auth, and a management UI — no separate auth service needed |
| `minio` container | Cloudflare R2 | S3-compatible; significantly cheaper egress than AWS S3 |
| `redis` container | Upstash | Serverless Redis; billed per request, low cost at Phase 1 traffic volumes |
| `api` container | Fly.io | Stateless FastAPI; scales independently of the databases |
| `frontend` dev server | Fly.io (same app or separate) | Static build served via Fly or a CDN |

All credentials are injected as environment variables. No credentials appear in code, Docker Compose files, or committed configuration. The environment variable names are identical across local, staging, and production; only the values differ.

---

## Environment variables

The full set of required variables is in `.env.example` at the repository root. Every variable has a comment. The canonical list:

```
# Application
ENVIRONMENT=staging         # local | staging | production
AUTH_MODE=supabase          # local | supabase  (local only valid when ENVIRONMENT=local)

# Neo4j AuraDB
NEO4J_URI=neo4j+s://<instance-id>.databases.neo4j.io
NEO4J_USER=neo4j
NEO4J_PASSWORD=<auradb-password>

# Supabase (PostgreSQL + Auth)
DATABASE_URL=postgresql+asyncpg://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_ANON_KEY=<anon-key>
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>

# Cloudflare R2
R2_ACCOUNT_ID=<account-id>
R2_ACCESS_KEY_ID=<access-key-id>
R2_SECRET_ACCESS_KEY=<secret-access-key>
R2_BUCKET_NAME=doppia-<environment>
R2_ENDPOINT_URL=https://<account-id>.r2.cloudflarestorage.com

# Upstash Redis
# Use the Redis protocol URL from the Upstash console (redis:// or rediss://).
# Not the REST API URL (https://). All three vars point to the same connection URL.
REDIS_URL=redis://default:<password>@<host>:<port>
CELERY_BROKER_URL=redis://default:<password>@<host>:<port>
CELERY_RESULT_BACKEND=redis://default:<password>@<host>:<port>

# OpenAI (Phase 3; wire in now)
OPENAI_API_KEY=<key>
```

Secrets are stored in Fly.io's secret store (`fly secrets set KEY=value`) and are never written to files in the deployment environment. For local development, they live in a `.env` file that is gitignored.

---

## Staging: first-time setup

### 1. Neo4j AuraDB

1. Create an account at [console.neo4j.io](https://console.neo4j.io).
2. Create a new AuraDB Free instance. Choose the nearest region.
3. Download the generated credentials file immediately — the password is shown only once.
4. Note the connection URI (format: `neo4j+s://<instance-id>.databases.neo4j.io`).
5. Set `NEO4J_URI`, `NEO4J_USER`, and `NEO4J_PASSWORD` in Fly.io secrets.

**Seed the graph after first deploy:**

```bash
fly ssh console --app doppia-staging
python scripts/seed.py --domain cadences
python scripts/validate_graph.py
```

The seed script uses `MERGE` and is idempotent; it is safe to re-run after any YAML change.

### 2. Supabase

1. Create a project at [supabase.com](https://supabase.com). Choose the nearest region.
2. From the project dashboard → Settings → Database, copy the connection string. Use the "Transaction" pooler URI for application connections (`postgresql+asyncpg://...`).
3. From Settings → API, copy the project URL, anon key, and service role key.
4. Enable the pgvector extension: Dashboard → Database → Extensions → search "vector" → enable.
5. Set all four Supabase variables in Fly.io secrets.

**JWT verification — no extra secret needed for new projects.** New Supabase projects sign JWTs with ES256 (asymmetric). The application fetches the JWKS automatically at startup from `SUPABASE_URL/auth/v1/.well-known/jwks.json` and caches it on `app.state`. No `SUPABASE_JWT_SECRET` variable is required. Legacy projects using HS256 (symmetric) should set `SUPABASE_JWT_SECRET` instead; the middleware detects which is present.

**Run database migrations after first deploy:**

```bash
fly ssh console --app doppia-staging -C "alembic upgrade head"
```

Note: the `-C` flag on `fly ssh console` execs the command directly — shell builtins like `cd` are not available. The `WORKDIR` in the Dockerfile is `/app`, so commands run there by default. For compound commands use `sh -c`:

```bash
fly ssh console --app doppia-staging -C "sh -c 'alembic upgrade head && echo done'"
```

Alembic applies all pending migrations in order. This creates all PostgreSQL tables including `prose_chunk` (scaffolded now, populated in Phase 3).

**Create the first admin user.** Account creation is admin-only; there is no self-registration. After first deploy, create a user via the Supabase dashboard (Authentication → Users → Add user), then set their role in `app_metadata` using the service role key:

```bash
# Replace <project-ref>, <user-id>, and <service-role-key> with real values.
curl -X PUT https://<project-ref>.supabase.co/auth/v1/admin/users/<user-id> \
  -H "apikey: <service-role-key>" \
  -H "Authorization: Bearer <service-role-key>" \
  -H "Content-Type: application/json" \
  -d '{"app_metadata": {"role": "admin"}}'
```

Valid role values are `admin` and `editor`. The role is read from `app_metadata.role` in the JWT payload by the auth middleware.

**Getting a bearer token for API calls.** Sign in with email and password against the Supabase auth endpoint:

```bash
curl -X POST "https://<project-ref>.supabase.co/auth/v1/token?grant_type=password" \
  -H "apikey: <anon-key>" \
  -H "Content-Type: application/json" \
  -d '{"email": "user@example.com", "password": "password"}'
```

The response contains `access_token`. Tokens expire after one hour; repeat this call to refresh. Pass the token as `Authorization: Bearer <token>` on all authenticated API requests.

**Seeding the browser with a token (Phase 1 only).** Until a login page is built, paste the token into the browser console on the staging URL:

```javascript
localStorage.setItem('doppia_access_token', 'paste-access-token-here')
```

Then reload the page. The corpus browser and tagging tool will use this token until it expires or is cleared.

### 3. Cloudflare R2

1. In the Cloudflare dashboard → R2 → Create bucket. Name it `doppia-staging`.
2. Under Manage R2 API Tokens, create a token with "Object Read & Write" permission scoped to the bucket.
3. Note the Account ID from the R2 overview page.
4. Set all four R2 variables in Fly.io secrets.
5. Configure the bucket's CORS policy (R2 → bucket → Settings → CORS Policy). The frontend fetches MEI files directly from R2 via signed URLs, so the bucket must allow `GET` requests from the frontend origin:

```json
[
  {
    "AllowedOrigins": ["https://doppia-staging.fly.dev"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

Update `AllowedOrigins` for each environment. See `docs/architecture/security-model.md` § "R2 and CORS" for the full rationale.

### 4. Upstash Redis

1. Create an account at [upstash.com](https://upstash.com).
2. Create a new Redis database. Choose the nearest region.
3. From the database console → **Connect**, copy the **Redis URL** (starts with `redis://` or `rediss://`). This is the connection string for the Redis protocol — not the REST API URL (`https://...`), which is for the Upstash HTTP client only.
4. Set `REDIS_URL`, `CELERY_BROKER_URL`, and `CELERY_RESULT_BACKEND` all to the same Redis connection URL in Fly.io secrets:

```bash
fly secrets set \
  REDIS_URL="redis://default:<password>@<host>:<port>" \
  CELERY_BROKER_URL="redis://default:<password>@<host>:<port>" \
  CELERY_RESULT_BACKEND="redis://default:<password>@<host>:<port>" \
  --app doppia-staging
```

`REDIS_URL` is used by the application for caching. `CELERY_BROKER_URL` and `CELERY_RESULT_BACKEND` are used by Celery for task queuing. All three must point to the Redis connection URL, not the REST API URL.

Redis is wired in from day one but is not load-bearing in Phase 1. If the Upstash connection is unavailable, the Celery task dispatch (music21 analysis, incipit generation) logs a warning and the upload continues — the core ingestion (MEI validation, R2 storage, PostgreSQL records) is unaffected. Cache misses are acceptable in Phase 1; Redis is required for correctness only from Phase 2 onward.

**Note: no Celery worker is deployed in Phase 1 staging.** Tasks are enqueued into Redis but not executed. Background work (music21 analysis, incipit generation) must be triggered manually or deferred until a worker is deployed.

### 5. Fly.io

1. Install the Fly CLI: `brew install flyctl` (macOS) or follow [fly.io/docs/hands-on/install-flyctl](https://fly.io/docs/hands-on/install-flyctl/).
2. Authenticate: `fly auth login`.
3. From the repository root:

```bash
fly apps create doppia-staging
fly secrets set \
  NEO4J_URI=<uri> \
  NEO4J_USER=neo4j \
  NEO4J_PASSWORD=<password> \
  DATABASE_URL=<supabase-connection-string> \
  SUPABASE_URL=<url> \
  SUPABASE_ANON_KEY=<key> \
  SUPABASE_SERVICE_ROLE_KEY=<key> \
  R2_ACCOUNT_ID=<id> \
  R2_ACCESS_KEY_ID=<key> \
  R2_SECRET_ACCESS_KEY=<secret> \
  REDIS_URL=<redis-connection-url> \
  CELERY_BROKER_URL=<redis-connection-url> \
  CELERY_RESULT_BACKEND=<redis-connection-url> \
  --app doppia-staging
fly deploy --app doppia-staging
```

Non-secret environment variables (`ENVIRONMENT`, `AUTH_MODE`, `R2_BUCKET_NAME`, `R2_ENDPOINT_URL`, `PORT`) are set in `fly.toml` under `[env]` and committed to the repository — no secrets needed for these.

**Build architecture.** The `fly.toml` uses a multi-stage `backend/Dockerfile` with build context set to the repository root (`context = "."`). Stage 1 (Node) builds the React SPA; stage 2 (Python) installs backend dependencies and copies the built frontend into `/app/static/`. FastAPI serves the static files at runtime via `StaticFiles`. There is a single Fly app — no separate frontend deployment.

**Restricting staging access:** Supabase Auth is the access control layer. In Phase 1, user registration is disabled — accounts are created manually by an admin via the Supabase dashboard or the admin API. Only `editor` and `admin` role accounts exist in staging. The staging URL is not published; it is shared directly with the team.

---

## Deploying an update

The standard deployment flow from `main`:

```bash
# Ensure local tests pass before deploying
pytest
python scripts/validate_graph.py

# Deploy
fly deploy --app doppia-staging
```

If the update includes database migrations:

```bash
fly ssh console --app doppia-staging -C "alembic upgrade head"
```

Run migrations before deploying the new application version if the migration adds columns that the existing code can tolerate (additive). Run migrations after deploying if the new code must be live before the schema change takes effect (rare). When in doubt, deploy in a maintenance window: take the app offline briefly, run the migration, redeploy.

If the update includes knowledge graph YAML changes:

```bash
fly ssh console --app doppia-staging -C "python scripts/seed.py --domain cadences"
fly ssh console --app doppia-staging -C "python scripts/validate_graph.py"
```

**Note:** the knowledge graph seeding script and YAML domain files are not yet implemented (Component 4). These commands will work once Component 4 is built.

## Uploading a corpus

Corpus upload requires an `admin` bearer token (see "Getting a bearer token" above). The upload ZIP must contain a `metadata.yaml` sidecar plus the MEI files and (for DCML corpora) harmonies TSV files referenced by it. See `scripts/prepare_dcml_corpus.py` for how to produce a compliant ZIP from a DCML repository.

```bash
curl -X POST https://doppia-staging.fly.dev/api/v1/composers/<composer_slug>/corpora/<corpus_slug>/upload \
  -H "Authorization: Bearer <admin-token>" \
  -F "archive=@/path/to/corpus.zip"
```

The response is a structured ingestion report listing accepted movements (with any normalisation warnings) and rejected movements (with validation errors). All movements are processed independently; a rejection of one does not block others.

Background tasks (music21 analysis, incipit generation) are enqueued after a successful upload but require a running Celery worker to execute. In Phase 1 staging these tasks are logged as warnings and skipped gracefully — the corpus data and MEI files are stored regardless.

---

## Summary JSONB migrations

If a `summary` JSONB schema version bump is required (see `docs/architecture/fragment-schema.md` for the versioning policy), the migration script must be run as a separate step, not as part of an Alembic migration. Alembic handles the PostgreSQL schema; JSONB content migrations are Python scripts.

```bash
fly ssh console --app doppia-staging
python scripts/migrations/summary_v1_to_v2.py --dry-run   # inspect changes first
python scripts/migrations/summary_v1_to_v2.py             # apply
python scripts/migrations/summary_v1_to_v2.py --verify    # confirm no v1 records remain
exit
```

Each migration script must implement `--dry-run` and `--verify` modes. Never run a JSONB migration without a dry run first.

---

## Rollback

### Application rollback

Fly.io retains previous release images. To roll back to the previous version:

```bash
fly releases --app doppia-staging   # list recent releases
fly deploy --image registry.fly.io/doppia-staging:<version> --app doppia-staging
```

### Database rollback

**PostgreSQL (Alembic):**

```bash
fly ssh console --app doppia-staging
alembic downgrade -1   # roll back one migration
```

Alembic downgrade scripts must be written for every migration. Do not skip the `downgrade()` function.

**Neo4j:** The graph has no Alembic equivalent. The rollback strategy is:
1. Restore from the most recent AuraDB backup (AuraDB takes automatic daily backups).
2. Re-seed from YAML using the previous commit's seed files: check out the previous tag, run `python scripts/seed.py`.

Because the seeding script uses `MERGE`, re-seeding from an earlier YAML state does not delete nodes that were added in the newer version — it only updates nodes that changed. If a seed rollback requires *removing* nodes, those deletions must be handled manually via Cypher in the Neo4j console. Document the steps when they arise.

**Summary JSONB:** Each migration script's `--verify` mode confirms all records are at the new version. If a rollback is needed, re-run the inverse migration (`v2_to_v1`) if one has been written, or restore from a PostgreSQL backup via the Supabase dashboard.

---

## Monitoring and logs

**Application logs:**

```bash
fly logs --app doppia-staging
```

Logs are structured JSON (FastAPI + uvicorn configured for JSON output). Filter by level or route in the Fly.io dashboard or pipe to `jq`.

**Neo4j query logs:** available in the AuraDB console under the instance's "Logs" tab. Enable query logging for performance investigation; it is off by default.

**Supabase logs:** available in the Supabase dashboard under Logs → Postgres. Slow queries appear in the "Slow Queries" view.

**Upstash:** connection counts and throughput visible in the Upstash dashboard. No action required in Phase 1.

---

## Production

Production setup is identical to staging. The differences:

- App name: `doppia-production`
- Bucket name: `doppia-production`
- AuraDB: upgrade to Professional tier when free tier limits are reached
- Fly.io: configure autoscaling and at least two instances for availability
- `ENVIRONMENT=production` disables the local auth bypass unconditionally

Production is not stood up until Phase 2, when there are public-facing features. The staging environment is sufficient for Phase 1.

When production is stood up, mirror the staging setup exactly and promote the staging application image rather than building from scratch:

```bash
fly deploy --image registry.fly.io/doppia-staging:<release-tag> \
           --app doppia-production
```

This ensures what goes to production is exactly what was validated in staging.
