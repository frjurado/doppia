# Security Model

## Doppia — Open Music Analysis Repository

This document covers the security controls that sit alongside authentication (see ADR-001). It addresses CORS policy, rate limiting, input sanitisation, signed URL lifecycle, and the development auth bypass. It is written at Phase 1 scope and notes explicitly what changes at Phase 2.

Read ADR-001 first — this document assumes familiarity with the Supabase Auth JWT model and the `AUTH_MODE` / `ENVIRONMENT` variable convention.

---

## Contents

1. [CORS policy](#1-cors-policy)
2. [Rate limiting](#2-rate-limiting)
3. [Input sanitisation beyond Pydantic](#3-input-sanitisation-beyond-pydantic)
4. [Signed URL lifecycle for R2](#4-signed-url-lifecycle-for-r2)
5. [The development auth bypass](#5-the-development-auth-bypass)
6. [Phase 2 additions](#6-phase-2-additions)

---

## 1. CORS policy

### Why CORS matters here

In local development, Vite's dev server proxies all `/api/*` requests to FastAPI. From the browser's perspective, frontend and API share the same origin, so CORS never triggers. In staging and production, the frontend bundle is served from one host (a Fly.io app or CDN) and the FastAPI API from another, so the browser enforces cross-origin rules on every request.

FastAPI does not add CORS headers by default. Without explicit middleware configuration, every API call from the deployed frontend will be blocked by the browser.

### Configuration

CORS is configured via FastAPI's `CORSMiddleware` in the application factory. The allowed-origins list is driven by the `ENVIRONMENT` environment variable:

```python
# backend/api/app.py

from fastapi.middleware.cors import CORSMiddleware
import os

_ALLOWED_ORIGINS: dict[str, list[str]] = {
    "local": [
        "http://localhost:5173",   # Vite dev server
        "http://localhost:4173",   # Vite preview
    ],
    "staging": [
        "https://doppia-staging.fly.dev",
    ],
    "production": [
        "https://doppia.app",      # replace with actual production domain
    ],
}

def create_app() -> FastAPI:
    app = FastAPI(...)
    environment = os.environ["ENVIRONMENT"]
    origins = _ALLOWED_ORIGINS.get(environment, [])
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["Authorization", "Content-Type"],
    )
    return app
```

**Rules:**

- **Never use `allow_origins=["*"]` with `allow_credentials=True`**. This combination is rejected by all browsers and would silently break authentication. If a wildcard origin is ever needed (e.g. for a public read-only endpoint in Phase 2), that route must either disable credentials or be served from a separate API prefix.
- The allowed-origins list is an explicit allowlist, not a regex or wildcard pattern. Adding a new environment (e.g. a preview deployment for a pull request) requires adding the origin to `_ALLOWED_ORIGINS` — not widening the pattern.
- `allow_methods` covers the HTTP verbs actually used by the API. `PUT` is not listed because the API uses `PATCH` for partial updates; add it only when a `PUT` route is introduced.
- `allow_headers` must include `Authorization` (the JWT bearer token) and `Content-Type` (JSON bodies). Any custom headers added later (e.g. `X-Request-ID` for tracing) must be added here.

### R2 and CORS

Cloudflare R2 is currently accessed server-side only: the API fetches MEI files for processing, or generates signed URLs that the frontend uses to fetch files directly. When the frontend uses a signed URL to fetch from R2 directly, that is a cross-origin request from the browser to `*.r2.cloudflarestorage.com`. R2 CORS rules must be configured at the bucket level for this to work.

The current architecture serves MEI files to the frontend via signed R2 URLs (see [section 4](#4-signed-url-lifecycle-for-r2)). The R2 bucket must therefore carry a CORS rule allowing `GET` requests from the frontend origin:

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

This rule is set once in the Cloudflare dashboard (R2 → bucket → Settings → CORS Policy) and is separate from the FastAPI middleware. It does not affect server-side access from the API.

---

## 2. Rate limiting

### Phase 1 position

Phase 1 is an internal tool with a small, fixed team of annotators and administrators. No public traffic; no anonymous users. Hard rate limits are not operationally necessary in Phase 1, and implementing them before there is any traffic to calibrate against risks setting limits that are too tight for legitimate use.

**Phase 1 decision: no programmatic rate limiting is enforced.** Fly.io applies basic DDoS protection at the infrastructure layer by default. The staging URL is not published; it is shared directly with team members. This is sufficient for Phase 1.

### Phase 2 design (implement before public launch)

Phase 2 introduces public users and anonymous visitors. Rate limiting becomes necessary to protect expensive endpoints — primarily those that trigger knowledge graph traversal and those that accept writes. The following plan should be implemented before Phase 2 traffic arrives.

**Tool:** `slowapi` — the standard rate-limiting library for FastAPI, backed by Redis. It integrates with the Redis instance already in the stack (Upstash in production) and adds no new service dependency.

```python
# backend/api/rate_limiting.py

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
```

**Proposed limits by endpoint category (Phase 2 starting values — tune with observed traffic):**

| Endpoint category | Authenticated limit | Anonymous limit | Notes |
|---|---|---|---|
| Read endpoints (fragments, concepts) | 300 / minute | 60 / minute | Generous; these are cheap |
| Write endpoints (fragment create/patch) | 60 / minute | — (auth required) | Editor role only |
| Graph traversal (concept neighbourhood, prerequisites) | 60 / minute | 30 / minute | More expensive; Neo4j |
| Exercise generation | 120 / minute | 30 / minute | Hits graph + PostgreSQL |
| File upload (MEI) | 20 / minute | — (admin only) | Rare; prevent runaway ingestion |

**Key identification:** In Phase 2, prefer per-user rate limiting (keyed on the JWT `sub` claim) over per-IP limiting for authenticated endpoints. Per-IP is used for anonymous routes where no user identity is available. This prevents a single bad actor from affecting other users behind the same NAT.

```python
def get_user_or_ip(request: Request) -> str:
    user = getattr(request.state, "user", None)
    if user:
        return f"user:{user.id}"
    return get_remote_address(request)
```

**Rate limit responses** return `429 Too Many Requests` with a `Retry-After` header. The error response follows the standard error envelope:

```json
{
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests. Please retry after 60 seconds.",
    "detail": { "retry_after_seconds": 60 }
  }
}
```

---

## 3. Input sanitisation beyond Pydantic

Pydantic enforces type correctness, field presence, and format constraints at write time. It does not protect against injection or traversal attacks. The following controls address the gaps.

### 3.1 Cypher injection (Neo4j)

The Neo4j official Python driver uses parameterised queries exclusively. String interpolation into Cypher is never necessary and is always wrong.

```python
# Correct — parameterised
result = await session.run(
    "MATCH (c:Concept {id: $id}) RETURN c",
    id=concept_id,
)

# Wrong — never do this
result = await session.run(
    f"MATCH (c:Concept {{id: '{concept_id}'}}) RETURN c"  # ← injection risk
)
```

**Rule:** All Cypher queries in `backend/graph/` must use driver parameters (`$param_name`). No string formatting or `.format()` calls are permitted in Cypher strings. This is enforced by code review and can be caught by a linter rule flagging f-strings in `session.run()` calls.

The `neomodel` ORM, used for routine concept CRUD, generates parameterised queries internally. Raw Cypher is only written in `backend/graph/queries/`.

### 3.2 SQL injection (PostgreSQL)

SQLAlchemy's ORM and Core both parameterise queries automatically. Raw `text()` constructs are the only surface where injection is possible, and they are already protected by SQLAlchemy's bound-parameter syntax (`:param`).

**Rule:** `text()` constructs that incorporate runtime values must use bound parameters:

```python
# Correct
stmt = text("SELECT * FROM fragment WHERE key = :key").bindparams(key=key_value)

# Wrong
stmt = text(f"SELECT * FROM fragment WHERE key = '{key_value}'")
```

SQLAlchemy will raise an error if a `text()` construct references a parameter name that has no binding, which catches many mistakes at development time.

### 3.3 Object key path traversal (R2 / MinIO)

The `mei_object_key` column in the `movement` table stores an S3 object key (`{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei`). Fragments resolve the key via `movement.mei_object_key` (there is no `mei_file` column on `fragment`). If this value were accepted directly from user input and used to construct a key for an R2 operation without validation, a malicious actor could craft a value like `../../admin-only/credentials.txt` and attempt to read or write outside the intended path space.

**Rule:** Object keys are never accepted directly from API request bodies as arbitrary strings. They are always constructed by the application from validated, typed components:

```python
def build_object_key(
    composer_slug: str, corpus_slug: str, work_slug: str, movement_slug: str
) -> str:
    """Construct a canonical object key from validated components.

    Each component is validated against a strict pattern before being
    assembled. Path traversal sequences (../) are structurally impossible
    because the components are separately validated, not concatenated from
    a user-supplied path string.
    """
    slug_pattern = re.compile(r'^[a-z0-9][a-z0-9\-]{0,63}$')
    assert slug_pattern.match(composer_slug), f"Invalid composer_slug: {composer_slug}"
    assert slug_pattern.match(corpus_slug),   f"Invalid corpus_slug: {corpus_slug}"
    assert slug_pattern.match(work_slug),     f"Invalid work_slug: {work_slug}"
    assert slug_pattern.match(movement_slug), f"Invalid movement_slug: {movement_slug}"
    return f"{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei"
```

When an existing key is read from the database (rather than constructed from request input), it must still be validated against the expected pattern before use, as an additional defence against corrupted database values:

```python
_VALID_KEY = re.compile(
    r'^[a-z0-9][a-z0-9\-]{0,63}'    # composer_slug
    r'/[a-z0-9][a-z0-9\-]{0,63}'   # corpus_slug
    r'/[a-z0-9][a-z0-9\-]{0,63}'   # work_slug
    r'/[a-z0-9][a-z0-9\-]{0,63}'   # movement_slug
    r'\.(mei|svg)$'
)

def validate_object_key(key: str) -> None:
    if not _VALID_KEY.match(key):
        raise ValueError(f"Object key fails validation: {key!r}")
```

### 3.4 XSS in prose content

Prose fields — fragment annotations, concept definitions, blog post content — are stored as plain text or as structured rich-text output (TipTap serialises to HTML). React's JSX escapes dynamic values by default, which prevents XSS in standard rendering paths. The risk arises only when HTML is rendered raw.

**Two surfaces to control:**

**TipTap blog editor output.** TipTap serialises editor content to HTML. When that HTML is stored and later rendered in a reader view, it must not be passed directly to `dangerouslySetInnerHTML` without sanitisation. Use `DOMPurify` before any raw HTML render:

```typescript
import DOMPurify from 'dompurify';

// In the blog post reader component
<div
  dangerouslySetInnerHTML={{
    __html: DOMPurify.sanitize(post.body_html, {
      ALLOWED_TAGS: ['p', 'h2', 'h3', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'blockquote'],
      ALLOWED_ATTR: ['href', 'target', 'rel'],
    })
  }}
/>
```

The tag and attribute allowlist should be conservative. The blog editor's toolbar should already enforce a matching set — if the editor cannot produce a `<script>` tag, the sanitiser is a belt-and-suspenders check, not the primary defence.

**Concept definitions and fragment annotations.** These are plain text stored in Neo4j and PostgreSQL respectively. They are rendered via React state (JSX), not as raw HTML. No sanitisation step is required as long as they are never passed to `dangerouslySetInnerHTML`. If a Markdown rendering path is introduced in Phase 2 (e.g. for fragment annotations), treat Markdown output the same as TipTap HTML and sanitise before raw render.

### 3.5 MEI file content (XML parsing)

MEI files are XML and are parsed server-side by music21 and Verovio. The primary concern with XML parsing is XML External Entity (XXE) injection: a maliciously crafted XML file that declares an external entity pointing to a local file or remote URL, causing the parser to read it.

**music21** uses Python's `xml.etree.ElementTree` under the hood, which does not resolve external entities by default in Python 3.8+. This is safe without additional configuration.

**Verovio** (Python bindings and WASM) parses MEI internally in C++. Verovio does not expose a general-purpose XML parser interface and processes MEI structure, not arbitrary XML. XXE via Verovio is not a documented attack surface.

**For belt-and-suspenders confidence:** MEI files should be validated against the MEI schema (using `lxml` with schema validation) before being stored or processed. A validating parse with `lxml` in secure mode (`resolve_entities=False`) catches malformed or injected entity declarations before the file reaches music21 or Verovio:

```python
from lxml import etree

def validate_mei_file(content: bytes) -> None:
    """Parse and basic-validate MEI XML before storing.

    Raises ValueError if the content is not well-formed XML or contains
    entity declarations. Does not enforce the full MEI schema (that would
    require an XSD or RNG; deferred to Phase 2 if needed).
    """
    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
    )
    try:
        etree.fromstring(content, parser)
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"MEI file failed XML validation: {exc}") from exc
```

This validation runs during corpus ingestion, before the file is written to R2.

---

## 4. Signed URL lifecycle for R2

### What is stored vs. what is served

The `mei_object_key` column in the `movement` table stores an S3 **object key** — a stable, permanent identifier of the form `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei`. Fragments inherit their MEI source by way of `movement_id`; no key is stored on the fragment itself. Object keys are stored; URLs are never stored. (See ADR-002.)

Signed URLs are generated on demand at request time, used, and discarded. Nothing that expires is persisted.

### TTL policy

| Access pattern | TTL | Rationale |
|---|---|---|
| Client-facing: frontend fetching MEI for rendering | **1 hour** | Long enough for any reasonable rendering or playback session; short enough to limit exposure if a URL leaks |
| Client-facing: fragment SVG preview images | **1 hour** | Same reasoning |
| Backend-to-backend: music21 processing | **15 minutes** | Used immediately in a background task; a short TTL reduces exposure without affecting functionality |
| Backend-to-backend: Verovio server-side rendering | **15 minutes** | Same |

The 1-hour TTL for client-facing URLs means a URL embedded in an API response remains valid for the full duration of a user session. If the frontend caches URLs locally (e.g. in React state), they should be treated as session-scoped and not persisted to localStorage or similar. A page reload will re-request the URL from the API, which generates a fresh one.

### Signed URL generation

```python
import aioboto3
import os
from datetime import timedelta

_S3_CLIENT = None

async def get_s3_client():
    global _S3_CLIENT
    if _S3_CLIENT is None:
        session = aioboto3.Session()
        _S3_CLIENT = await session.client(
            "s3",
            endpoint_url=os.environ["R2_ENDPOINT_URL"],
            aws_access_key_id=os.environ["R2_ACCESS_KEY_ID"],
            aws_secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
        ).__aenter__()
    return _S3_CLIENT

async def generate_signed_url(
    object_key: str,
    ttl_seconds: int = 3600,
) -> str:
    """Generate a pre-signed GET URL for an R2 object.

    Args:
        object_key: Validated S3 object key (see section 3.3).
        ttl_seconds: URL lifetime in seconds. Default: 1 hour.

    Returns:
        A pre-signed URL valid for ttl_seconds.
    """
    validate_object_key(object_key)   # always validate before use
    client = await get_s3_client()
    url = await client.generate_presigned_url(
        "get_object",
        Params={
            "Bucket": os.environ["R2_BUCKET_NAME"],
            "Key": object_key,
        },
        ExpiresIn=ttl_seconds,
    )
    return url
```

### Share links in Phase 2

When Phase 2 introduces shareable collection and fragment links, those links must reference the fragment's **UUID** (or a slug), not a signed URL. The signed URL is resolved when the shared link is visited, not when it is generated. This ensures:

- Share links never expire (the fragment UUID is permanent).
- Signed URLs rotate on every page load, limiting the window of exposure.
- No signed URL ever appears in a user-visible URL bar, email, or clipboard.

---

## 5. The development auth bypass

### What it is

ADR-001 describes a development-only auth bypass for local development: when `AUTH_MODE=local`, the FastAPI JWT middleware accepts a fixed token (e.g. `dev-token`) without validating it against Supabase. This allows developers to call the API without a real Supabase project configured locally.

The `.env.example` makes the constraint explicit:

```
AUTH_MODE=supabase   # local | supabase  (local only valid when ENVIRONMENT=local)
```

### The guarantee that it is inert in production

The guarantee rests on two independent checks, both of which must be true for the bypass to activate. Neither alone is sufficient.

**Check 1 — `ENVIRONMENT` must equal `"local"`:**

```python
# backend/middleware/auth.py

import os
from fastapi import Request, HTTPException

_DEV_TOKEN = "dev-token"

async def validate_auth(request: Request) -> AuthenticatedUser:
    environment = os.environ.get("ENVIRONMENT", "production")
    auth_mode   = os.environ.get("AUTH_MODE", "supabase")

    if auth_mode == "local":
        # Guard: only allow the bypass when ENVIRONMENT is explicitly local.
        # If AUTH_MODE=local is ever accidentally set in staging or production,
        # this check prevents the bypass from activating.
        if environment != "local":
            raise RuntimeError(
                "AUTH_MODE=local is set but ENVIRONMENT is not 'local'. "
                "This configuration is invalid and the application will not start. "
                f"ENVIRONMENT={environment!r}"
            )
        # Extract the token and assign a synthetic dev user.
        token = request.headers.get("Authorization", "").removeprefix("Bearer ").strip()
        if token != _DEV_TOKEN:
            raise HTTPException(status_code=401, detail="Invalid dev token.")
        return AuthenticatedUser(id="dev-user", role="admin", email="dev@local")

    # Normal path: validate the JWT against Supabase.
    return await validate_supabase_jwt(request)
```

Note the `RuntimeError` on misconfiguration: the application **refuses to start** if `AUTH_MODE=local` is combined with any non-local environment. This makes the misconfiguration loud and immediately visible rather than silently dangerous.

**Check 2 — `AUTH_MODE` is not set in non-local deployments:**

The staging and production `fly secrets` do not include an `AUTH_MODE` variable. The variable therefore defaults to `"supabase"` in all deployed environments (via `os.environ.get("AUTH_MODE", "supabase")`). An attacker who gains access to the Fly.io dashboard could inject `AUTH_MODE=local`, but the first check — `environment != "local"` — would still prevent the bypass from activating, because `ENVIRONMENT` is `"staging"` or `"production"`.

The bypass is therefore only reachable if **both** `ENVIRONMENT=local` **and** `AUTH_MODE=local` are set. This combination cannot occur in any deployed environment without deliberate, multi-step configuration changes that would be visible in the Fly.io audit log.

### What `ENVIRONMENT=production` does

The `deployment.md` note that "`ENVIRONMENT=production` disables the local auth bypass unconditionally" is implemented by the first check above — `environment != "local"` raises `RuntimeError` before the bypass code executes. `ENVIRONMENT=production` is therefore not a special case in the code; it is simply a non-`"local"` value, and any non-`"local"` value blocks the bypass.

### The `dev-token` value itself

The specific string `"dev-token"` has no special significance in production. Even if the bypass check were somehow defeated, a production user would need to know the exact value. It is not a secret — it is in the README — but it is also not meaningful without the environment preconditions. Changing it periodically provides no additional security; the environment checks are the actual controls.

---

## 6. Phase 2 additions

The following controls are out of scope for Phase 1 (internal tool, no public traffic) but should be implemented before Phase 2 launches.

**Rate limiting.** Implement `slowapi` with per-user limits on expensive endpoints, as described in [section 2](#2-rate-limiting). Wire Redis (Upstash) as the rate-limit state store. Define the starting limits before load testing and tune after.

**Content Security Policy.** Add a `Content-Security-Policy` response header to the FastAPI application. In Phase 1 the tagging tool is internal and CSP is belt-and-suspenders; in Phase 2, with public users and author-uploaded HTML content, it is a meaningful control. A restrictive starting policy:

```
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  connect-src 'self' https://*.supabase.co https://*.r2.cloudflarestorage.com;
  worker-src blob:;
  frame-ancestors 'none'
```

The `worker-src blob:` entry is required for Verovio's WASM module. Adjust `connect-src` to include any third-party endpoints actually contacted from the frontend.

**`Strict-Transport-Security`.** Set `Strict-Transport-Security: max-age=63072000; includeSubDomains` once the production domain is confirmed. Fly.io serves HTTPS by default; this header is a belt-and-suspenders control to prevent HTTP downgrade attacks.

**`X-Content-Type-Options`.** Set `X-Content-Type-Options: nosniff` on all responses. This prevents browsers from MIME-sniffing response content (relevant if MEI or SVG files are ever served with an ambiguous content type).

**MEI schema validation.** Upgrade the XML parse check in [section 3.5](#35-mei-file-content-xml-parsing) to full MEI schema validation using an RNG or XSD file. The lxml parse with `resolve_entities=False` is sufficient for Phase 1; full schema validation catches malformed MEI that would cause silent rendering errors.

**CORS: pull request preview environments.** If Fly.io preview deployments are introduced for pull requests (each PR gets its own preview URL), the CORS allowlist must accommodate dynamic origins. The recommended approach is a backend startup check that reads a comma-separated `ALLOWED_ORIGINS` environment variable, falling back to the static allowlist. This avoids hardcoding preview URLs in code.

**Dependency scanning.** Add `pip-audit` (Python) and `npm audit` (JavaScript) to the CI pipeline. Both are low-noise and catch known CVEs in third-party packages before they reach production.
