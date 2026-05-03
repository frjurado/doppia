"""Application-defined exception hierarchy for the Doppia backend.

All application exceptions inherit from ``DoppiaError``. The full hierarchy is
described in ``docs/architecture/error-handling.md`` § 2.

Exception handlers registered in ``backend/api/middleware/errors.py`` map each
class to an HTTP status code and an ``ErrorCode`` value.  Route handlers and
service functions raise these exceptions; they never call ``HTTPException``
directly for domain errors.

Usage::

    from errors import ComposerNotFoundError, IngestionError
    from models.errors import ErrorCode

    # In a route handler:
    raise ComposerNotFoundError(
        f"Composer '{slug}' not found.",
        detail={"slug": slug},
    )

    # In the ingestion service:
    raise IngestionError(
        code=ErrorCode.INVALID_ZIP,
        message=f"Archive is not a valid ZIP file: {exc}",
    )
"""

from __future__ import annotations

from models.errors import ErrorCode


class DoppiaError(Exception):
    """Base class for all application-defined exceptions.

    Args:
        message: Human-readable description of the error.
        detail: Optional structured context (safe to include in responses).
    """

    # Concrete subclasses define ``code`` as a class attribute.
    # ``IngestionError`` overrides it at instance level instead.
    code: ErrorCode

    def __init__(self, message: str, detail: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.detail = detail or {}


# ── Infrastructure failures ───────────────────────────────────────────────────


class InfrastructureError(DoppiaError):
    """A backend service (database, cache) is unavailable or misbehaving."""


class Neo4jUnavailableError(InfrastructureError):
    """Neo4j could not be reached or timed out."""

    code = ErrorCode.GRAPH_SERVICE_UNAVAILABLE


class PostgresUnavailableError(InfrastructureError):
    """PostgreSQL could not be reached or timed out."""

    code = ErrorCode.DATABASE_UNAVAILABLE


class RedisUnavailableError(InfrastructureError):
    """Redis could not be reached or timed out."""

    code = ErrorCode.CACHE_SERVICE_UNAVAILABLE


# ── Not-found errors ──────────────────────────────────────────────────────────


class NotFoundError(DoppiaError):
    """A requested resource does not exist."""


class ComposerNotFoundError(NotFoundError):
    """The requested composer slug does not exist."""

    code = ErrorCode.COMPOSER_NOT_FOUND


class CorpusNotFoundError(NotFoundError):
    """The requested corpus slug does not exist."""

    code = ErrorCode.CORPUS_NOT_FOUND


class WorkNotFoundError(NotFoundError):
    """The requested work does not exist."""

    code = ErrorCode.WORK_NOT_FOUND


class MovementNotFoundError(NotFoundError):
    """The requested movement does not exist."""

    code = ErrorCode.MOVEMENT_NOT_FOUND


class FragmentNotFoundError(NotFoundError):
    """The requested fragment does not exist."""

    code = ErrorCode.FRAGMENT_NOT_FOUND


class ConceptNotFoundError(NotFoundError):
    """The requested concept does not exist in the knowledge graph."""

    code = ErrorCode.CONCEPT_NOT_FOUND


class CollectionNotFoundError(NotFoundError):
    """The requested collection does not exist."""

    code = ErrorCode.COLLECTION_NOT_FOUND


class UserNotFoundError(NotFoundError):
    """The requested user does not exist."""

    code = ErrorCode.USER_NOT_FOUND


# ── Conflict errors ───────────────────────────────────────────────────────────


class ConflictError(DoppiaError):
    """The operation conflicts with current resource state."""


class FragmentAlreadyApprovedError(ConflictError):
    """The fragment has already been approved and cannot be modified."""

    code = ErrorCode.FRAGMENT_ALREADY_APPROVED


class HarmonyNotReviewedError(ConflictError):
    """The harmony analysis has not been reviewed and cannot be approved."""

    code = ErrorCode.HARMONY_NOT_REVIEWED


# ── Auth errors ───────────────────────────────────────────────────────────────


class AuthorizationError(DoppiaError):
    """The caller is authenticated but lacks the required role."""

    code = ErrorCode.FORBIDDEN


# ── Integrity errors ──────────────────────────────────────────────────────────


class GraphIntegrityError(DoppiaError):
    """An invariant of the knowledge graph has been violated.

    Distinct from ``ConceptNotFoundError`` (a client-input problem).
    ``GraphIntegrityError`` means data already in the system is inconsistent —
    for example, a fragment tag referencing a concept that was removed without
    going through the proper deprecation path.
    """

    code = ErrorCode.GRAPH_INTEGRITY_ERROR


# ── Corpus ingestion errors ───────────────────────────────────────────────────


class IngestionError(DoppiaError):
    """A corpus ingestion validation or coherence failure.

    Maps to ``422 Unprocessable Entity``.  The specific ``ErrorCode`` is passed
    at construction time because the ingestion service raises several distinct
    codes (``INVALID_ZIP``, ``METADATA_PARSE_ERROR``, ``CORPUS_COHERENCE_ERROR``,
    ``INVALID_MEI``).

    Args:
        code: The specific ingestion error code.
        message: Human-readable description.
        detail: Optional structured context.
    """

    def __init__(
        self, code: ErrorCode, message: str, detail: dict | None = None
    ) -> None:
        super().__init__(message, detail)
        self.code = code
