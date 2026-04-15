# Error Handling Strategy

## Doppia — Open Music Analysis Repository

This document describes how errors are classified, raised, propagated, and translated into HTTP responses across the backend. It is the companion to the error envelope definition in `CONTRIBUTING.md § 5` and the cross-database architecture described in `tech-stack-and-database-reference.md`.

Read this before writing any service-layer function, Pydantic validator, or FastAPI route.

---

## Contents

1. [Philosophy](#1-philosophy)
2. [Exception class hierarchy](#2-exception-class-hierarchy)
3. [Error propagation path](#3-error-propagation-path)
4. [The cross-database error case](#4-the-cross-database-error-case)
5. [Exception handler mapping](#5-exception-handler-mapping)
6. [Logging](#6-logging)
7. [Rules summary](#7-rules-summary)

---

## 1. Philosophy

**Errors are first-class citizens.** Every error that can occur has a named exception class, an `ErrorCode` enum value, and a defined HTTP status. "We'll handle it later" is not a valid design choice.

**Infrastructure failures are not validation failures.** This distinction drives everything. If a concept_id fails because the concept doesn't exist, that is a `422 Unprocessable Entity` — the client sent bad data. If it fails because Neo4j is unreachable, that is a `503 Service Unavailable` — the server is broken and the client should retry. These must never be conflated.

**Integrity over availability.** When Neo4j is down, write operations that require graph validation fail completely. The alternative — skipping graph validation to keep writes flowing — would silently corrupt referential integrity. This is worse than temporary unavailability. Fail loudly; fail cleanly.

**No stack traces to clients.** `500 Internal Server Error` responses contain the `code` and a safe `message`. Stack traces and raw exception strings go to server logs only.

---

## 2. Exception class hierarchy

All application exceptions inherit from `DoppiaError`, which is itself not raised directly. The full hierarchy lives in `backend/errors.py`.

```python
# backend/errors.py

class DoppiaError(Exception):
    """Base class for all application-defined exceptions."""

# ── Infrastructure failures ───────────────────────────────────────────────────

class InfrastructureError(DoppiaError):
    """A backend service (database, cache) is unavailable or misbehaving."""

class Neo4jUnavailableError(InfrastructureError):
    """Neo4j could not be reached or timed out."""

class PostgresUnavailableError(InfrastructureError):
    """PostgreSQL could not be reached or timed out."""

class RedisUnavailableError(InfrastructureError):
    """Redis could not be reached or timed out."""

# ── Application-level errors ──────────────────────────────────────────────────

class NotFoundError(DoppiaError):
    """A requested resource does not exist."""

class FragmentNotFoundError(NotFoundError): ...
class ConceptNotFoundError(NotFoundError): ...
class CollectionNotFoundError(NotFoundError): ...
class UserNotFoundError(NotFoundError): ...

class ConflictError(DoppiaError):
    """The operation conflicts with current state."""

class FragmentAlreadyApprovedError(ConflictError): ...
class HarmonyNotReviewedError(ConflictError): ...

class AuthorizationError(DoppiaError):
    """The caller is authenticated but lacks the required role."""

class GraphIntegrityError(DoppiaError):
    """An invariant of the knowledge graph has been violated.

    This is distinct from ConceptNotFoundError (which is a client input
    problem). GraphIntegrityError means the data already in the system
    is inconsistent — e.g. a fragment tag referencing a concept that has
    since been removed without going through the proper deprecation path.
    Should be treated as a 500.
    """
```

All `DoppiaError` subclasses accept a `message: str` argument and an optional `detail: dict` for structured context:

```python
class DoppiaError(Exception):
    def __init__(self, message: str, detail: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail or {}
```

---

## 3. Error propagation path

```
HTTP Request
    │
    ▼
Route handler  (thin: parse request, call service, return response)
    │
    ▼
Service layer  (business logic; calls repositories and graph service)
    │
    ├──► PostgreSQL repo  ─── asyncpg/SQLAlchemy exceptions
    │                              │
    │                              └── wrapped into PostgresUnavailableError
    │
    └──► Graph service  ──── neo4j driver exceptions
                                   │
                                   └── wrapped into Neo4jUnavailableError
                                       or ConceptNotFoundError
    │
    ▼
DoppiaError subclass raised by service layer
    │
    ▼
FastAPI exception handler (registered at app startup)
    │
    ▼
Structured error response  →  {"error": {"code": ..., "message": ..., "detail": ...}}
```

### Repository layer

Database drivers raise their own exception types. The repository layer wraps all driver exceptions into the appropriate `DoppiaError` subclass. No driver exception ever escapes a repository function.

```python
# backend/graph/queries/concept_queries.py

async def concept_exists(concept_id: str) -> bool:
    """Check whether a concept node exists in the graph.

    Raises:
        Neo4jUnavailableError: If the graph database cannot be reached.
    """
    try:
        async with driver.session() as session:
            result = await session.run(
                "MATCH (c:Concept {id: $id}) RETURN count(c) AS n",
                id=concept_id,
            )
            record = await result.single()
            return record["n"] > 0
    except neo4j.exceptions.ServiceUnavailable as exc:
        raise Neo4jUnavailableError(
            "Neo4j is unavailable. Cannot validate concept reference.",
            detail={"concept_id": concept_id},
        ) from exc
```

```python
# backend/repositories/fragment_repo.py

async def get_by_id(fragment_id: UUID) -> Fragment:
    """Fetch a fragment by primary key.

    Raises:
        FragmentNotFoundError: If no fragment with this id exists.
        PostgresUnavailableError: If PostgreSQL cannot be reached.
    """
    try:
        row = await session.get(Fragment, fragment_id)
    except asyncpg.PostgresConnectionError as exc:
        raise PostgresUnavailableError(
            "PostgreSQL is unavailable.",
            detail={"fragment_id": str(fragment_id)},
        ) from exc
    if row is None:
        raise FragmentNotFoundError(
            f"No fragment with id '{fragment_id}' exists.",
            detail={"fragment_id": str(fragment_id)},
        )
    return row
```

### Service layer

The service layer calls repositories and graph queries. It raises `DoppiaError` subclasses; it does not call `HTTPException` directly. HTTP semantics belong in the route handlers and exception handlers, not in the service layer.

```python
# backend/services/fragment_service.py

async def get_fragments_by_concept(
    concept_id: str,
    include_subtypes: bool,
    status: FragmentStatus,
) -> list[Fragment]:
    """Return fragments tagged with the given concept.

    Raises:
        ConceptNotFoundError: If concept_id does not exist in the graph.
        Neo4jUnavailableError: If the graph database cannot be reached.
        PostgresUnavailableError: If PostgreSQL cannot be reached.
    """
    if not await graph_queries.concept_exists(concept_id):
        raise ConceptNotFoundError(
            f"Concept '{concept_id}' does not exist.",
            detail={"concept_id": concept_id},
        )
    if include_subtypes:
        concept_ids = await graph_queries.get_subtypes(concept_id)
    else:
        concept_ids = [concept_id]
    return await fragment_repo.get_by_concept_ids(concept_ids, status)
```

Note that `graph_queries.concept_exists()` can itself raise `Neo4jUnavailableError`. The service layer does **not** catch it — it propagates up to the exception handler.

### Route handler

Route handlers are thin. They do not catch `DoppiaError` subclasses — that is the exception handler's job. They only call the service and return the result.

```python
# backend/api/routes/fragments.py

@router.get("/fragments/by-concept/{concept_id}")
async def list_fragments_by_concept(
    concept_id: str,
    include_subtypes: bool = False,
    status: FragmentStatus = FragmentStatus.APPROVED,
) -> list[Fragment]:
    return await fragment_service.get_fragments_by_concept(
        concept_id, include_subtypes, status
    )
```

---

## 4. The cross-database error case

### The scenario

`CONTRIBUTING.md` establishes that Pydantic validators may call the graph service to check that a `concept_id` exists before writing to PostgreSQL. This is the standard write-gate:

```python
# backend/models/fragment_models.py

class FragmentTagCreate(BaseModel):
    concept_id: str
    structural_role: str | None = None
    formal_context: str | None = None

    @model_validator(mode="after")
    async def validate_concept_exists(self) -> "FragmentTagCreate":
        """Verify concept_id against the knowledge graph.

        This validator has a graph database dependency. It raises ValueError
        on a missing concept (client error) and lets Neo4jUnavailableError
        propagate as-is (infrastructure error).

        Raises:
            ValueError: If concept_id does not exist in the graph.
            Neo4jUnavailableError: If Neo4j cannot be reached. This exception
                is NOT caught here — it propagates out of Pydantic validation
                and is handled by the FastAPI exception handler as a 503.
        """
        exists = await graph_queries.concept_exists(self.concept_id)
        if not exists:
            raise ValueError(
                f"concept_id '{self.concept_id}' does not exist in the "
                "knowledge graph."
            )
        return self
```

### What happens when Neo4j is down

When `graph_queries.concept_exists()` raises `Neo4jUnavailableError`:

1. The exception is **not** a `ValueError` or `AssertionError`, so Pydantic does not swallow it as a validation error.
2. It propagates naturally out of the Pydantic validator.
3. FastAPI's exception handler catches it and returns `503 Service Unavailable`.

This is correct behavior. The client receives a 503, not a misleading 422. The distinction is preserved.

**The rule:** Pydantic validators that call infrastructure services must only catch and re-raise as `ValueError` the errors that represent bad client input (concept doesn't exist). They must let `InfrastructureError` subclasses propagate untouched.

```python
# Correct — distinguishes client error from infrastructure error
@model_validator(mode="after")
async def validate_concept_exists(self) -> "FragmentTagCreate":
    try:
        exists = await graph_queries.concept_exists(self.concept_id)
    except Neo4jUnavailableError:
        raise  # let it propagate; the exception handler maps it to 503
    if not exists:
        raise ValueError(f"concept_id '{self.concept_id}' does not exist.")
    return self

# Wrong — swallows infrastructure failure as a validation error
@model_validator(mode="after")
async def validate_concept_exists(self) -> "FragmentTagCreate":
    try:
        exists = await graph_queries.concept_exists(self.concept_id)
        if not exists:
            raise ValueError(...)
    except Exception as exc:
        raise ValueError(f"Graph validation failed: {exc}") from exc  # ← DO NOT DO THIS
```

### Write atomicity under partial outage

When Neo4j is down but PostgreSQL is up, write operations that require graph validation fail with 503. The PostgreSQL write never starts, so there is no partial-write to clean up. The client must retry when the service recovers.

This is a deliberate trade-off: temporary unavailability is preferable to silent referential-integrity violations (tags referencing concepts that were never validated). Retryable 503s are safe; corrupted data is not.

---

## 5. Exception handler mapping

All `DoppiaError` subclasses are registered with FastAPI at startup. The mapping is:

| Exception class | HTTP status | `ErrorCode` |
|---|---|---|
| `Neo4jUnavailableError` | 503 | `GRAPH_SERVICE_UNAVAILABLE` |
| `PostgresUnavailableError` | 503 | `DATABASE_UNAVAILABLE` |
| `RedisUnavailableError` | 503 | `CACHE_SERVICE_UNAVAILABLE` |
| `FragmentNotFoundError` | 404 | `FRAGMENT_NOT_FOUND` |
| `ConceptNotFoundError` | 404 | `CONCEPT_NOT_FOUND` |
| `CollectionNotFoundError` | 404 | `COLLECTION_NOT_FOUND` |
| `UserNotFoundError` | 404 | `USER_NOT_FOUND` |
| `FragmentAlreadyApprovedError` | 409 | `FRAGMENT_ALREADY_APPROVED` |
| `HarmonyNotReviewedError` | 422 | `HARMONY_NOT_REVIEWED` |
| `AuthorizationError` | 403 | `FORBIDDEN` |
| `GraphIntegrityError` | 500 | `GRAPH_INTEGRITY_ERROR` |
| (any other `DoppiaError`) | 500 | `INTERNAL_ERROR` |

All responses follow the envelope defined in `CONTRIBUTING.md § 5`:

```json
{
  "error": {
    "code": "CONCEPT_NOT_FOUND",
    "message": "Concept 'ImperfectAuthenticCaden' does not exist in the knowledge graph.",
    "detail": {
      "concept_id": "ImperfectAuthenticCaden"
    }
  }
}
```

The exception handler registration lives in `backend/api/exception_handlers.py` and is called once from the application factory:

```python
# backend/api/exception_handlers.py

from fastapi import Request
from fastapi.responses import JSONResponse
from backend.errors import (
    DoppiaError, InfrastructureError,
    Neo4jUnavailableError, PostgresUnavailableError,
)

_STATUS_MAP: dict[type[DoppiaError], int] = {
    Neo4jUnavailableError: 503,
    PostgresUnavailableError: 503,
    FragmentNotFoundError: 404,
    ConceptNotFoundError: 404,
    CollectionNotFoundError: 404,
    UserNotFoundError: 404,
    FragmentAlreadyApprovedError: 409,
    HarmonyNotReviewedError: 422,
    AuthorizationError: 403,
    GraphIntegrityError: 500,
}

async def doppia_error_handler(request: Request, exc: DoppiaError) -> JSONResponse:
    status_code = _STATUS_MAP.get(type(exc), 500)
    return JSONResponse(
        status_code=status_code,
        content={
            "error": {
                "code": exc.code,        # defined as a class attribute on each subclass
                "message": exc.message,
                "detail": exc.detail,
            }
        },
    )
```

Pydantic `RequestValidationError` (malformed request body, wrong field types) is handled separately and returns `422` with field-level detail in the `detail` object. This is FastAPI's default behavior; it is not overridden.

---

## 6. Logging

Every exception handler logs before returning the response. The log level depends on the error category:

| Error category | Log level | Reason |
|---|---|---|
| `InfrastructureError` | `ERROR` | Operator action may be required |
| `GraphIntegrityError` | `ERROR` | Data corruption; always investigate |
| `NotFoundError` | `INFO` | Normal; no operator action needed |
| `ConflictError` | `INFO` | Normal; client state mismatch |
| `AuthorizationError` | `WARNING` | May indicate probing or misconfigured client |
| `500` catch-all | `ERROR` | Unexpected; always investigate |

Infrastructure error logs must include enough context to diagnose the failure without exposing credentials: the database type, the operation attempted, and any safe `detail` fields from the exception.

```python
logger.error(
    "Neo4j unavailable during concept validation",
    extra={"concept_id": exc.detail.get("concept_id"), "path": request.url.path},
)
```

---

## 7. Rules summary

These rules are requirements, not suggestions.

**Repository layer:**
- Catch all driver/driver-specific exceptions at the repository boundary.
- Re-raise as the appropriate `InfrastructureError` subclass. Never let a raw `neo4j.exceptions.*` or `asyncpg.*` exception escape a repository function.
- Log the raw exception before re-raising so the stack trace is captured.

**Service layer:**
- Raise `DoppiaError` subclasses. Never raise `HTTPException` from the service layer.
- Document all raised exceptions in the function's `Raises:` docstring block.
- Let `InfrastructureError` subclasses propagate — do not catch them unless you can meaningfully recover (e.g. a fallback to cache).

**Pydantic validators calling infrastructure:**
- Only catch and convert to `ValueError` the exceptions that represent bad client input.
- Let `InfrastructureError` subclasses propagate out of the validator. Pydantic will not swallow them; they will reach the exception handler correctly.

**Route handlers:**
- Do not call `HTTPException` directly for application-domain errors. Use `DoppiaError` subclasses.
- `HTTPException` is only appropriate for auth middleware failures before the service layer is reached.

**Exception handlers:**
- Map every `DoppiaError` subclass to exactly one HTTP status code.
- Never expose raw exception messages, stack traces, or internal paths in the response body.
- Always log before returning.
