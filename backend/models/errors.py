"""Error codes and the standard error response envelope.

Every error response from the API uses the shape::

    {
        "error": {
            "code": "SCREAMING_SNAKE_CASE",
            "message": "Human-readable description.",
            "detail": {}
        }
    }

See CONTRIBUTING.md § Error response envelope and docs/architecture/error-handling.md.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any

from pydantic import BaseModel


class ErrorCode(StrEnum):
    """Canonical error codes returned in the ``error.code`` field."""

    # Generic
    INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR"
    NOT_IMPLEMENTED = "NOT_IMPLEMENTED"
    RATE_LIMIT_EXCEEDED = "RATE_LIMIT_EXCEEDED"

    # Auth
    UNAUTHORIZED = "UNAUTHORIZED"
    FORBIDDEN = "FORBIDDEN"
    INVALID_TOKEN = "INVALID_TOKEN"

    # Resources
    FRAGMENT_NOT_FOUND = "FRAGMENT_NOT_FOUND"
    CONCEPT_NOT_FOUND = "CONCEPT_NOT_FOUND"
    MOVEMENT_NOT_FOUND = "MOVEMENT_NOT_FOUND"
    WORK_NOT_FOUND = "WORK_NOT_FOUND"
    CORPUS_NOT_FOUND = "CORPUS_NOT_FOUND"
    COMPOSER_NOT_FOUND = "COMPOSER_NOT_FOUND"
    USER_NOT_FOUND = "USER_NOT_FOUND"

    # MEI validation
    INVALID_XML = "INVALID_XML"
    SCHEMA_VIOLATION = "SCHEMA_VIOLATION"
    MEASURE_NUMBER_ERROR = "MEASURE_NUMBER_ERROR"
    STAFF_COUNT_MISMATCH = "STAFF_COUNT_MISMATCH"
    ENCODING_EMPTY = "ENCODING_EMPTY"

    # Validation / state
    VALIDATION_ERROR = "VALIDATION_ERROR"
    INVALID_MEI = "INVALID_MEI"
    INVALID_OBJECT_KEY = "INVALID_OBJECT_KEY"
    DUPLICATE_CATALOGUE_NUMBER = "DUPLICATE_CATALOGUE_NUMBER"
    FRAGMENT_STATE_CONFLICT = "FRAGMENT_STATE_CONFLICT"
    UNREVIEWED_HARMONY = "UNREVIEWED_HARMONY"
    SELF_REVIEW_FORBIDDEN = "SELF_REVIEW_FORBIDDEN"


class ErrorDetail(BaseModel):
    """Optional structured detail accompanying an error."""

    model_config = {"extra": "allow"}


class ErrorBody(BaseModel):
    """The ``error`` object nested inside the response envelope."""

    code: ErrorCode
    message: str
    detail: dict[str, Any] = {}


class ErrorResponse(BaseModel):
    """Top-level error response envelope.

    Example::

        {
            "error": {
                "code": "FRAGMENT_NOT_FOUND",
                "message": "No fragment with id 'abc123' exists.",
                "detail": {}
            }
        }
    """

    error: ErrorBody

    @classmethod
    def make(
        cls,
        code: ErrorCode,
        message: str,
        detail: dict[str, Any] | None = None,
    ) -> "ErrorResponse":
        """Convenience constructor.

        Args:
            code: The error code enum value.
            message: Human-readable error message.
            detail: Optional structured context.

        Returns:
            A fully formed ErrorResponse.
        """
        return cls(error=ErrorBody(code=code, message=message, detail=detail or {}))
