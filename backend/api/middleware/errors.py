"""Global exception handlers producing the standard error envelope.

These functions are registered with the FastAPI application in ``main.py``
via ``app.add_exception_handler()``. Every error response from the API uses
the shape::

    {
        "error": {
            "code": "SCREAMING_SNAKE_CASE",
            "message": "Human-readable description.",
            "detail": {}
        }
    }

Handler priority (highest to lowest):
1. ``doppia_error_handler`` — typed ``DoppiaError`` subclasses; reads ``exc.code`` directly.
2. ``http_exception_handler`` — bare ``HTTPException`` from middleware (auth, CORS, etc.).
3. ``validation_exception_handler`` — Pydantic ``RequestValidationError``.
4. ``unhandled_exception_handler`` — everything else (500 catch-all).

See ``models/errors.py`` for the full ``ErrorCode`` vocabulary and
``docs/architecture/error-handling.md`` for propagation rules.
"""

from __future__ import annotations

import logging

from errors import DoppiaError, InfrastructureError, NotFoundError
from fastapi import Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from models.errors import ErrorCode, ErrorResponse
from starlette.exceptions import HTTPException

logger = logging.getLogger(__name__)

# Maps DoppiaError subclasses to HTTP status codes.
# Any DoppiaError subclass not listed here falls back to 500.
_DOPPIA_STATUS_MAP: dict[type[DoppiaError], int] = {}

# Populated lazily to avoid circular imports at module load time — all
# concrete subclasses are imported from ``errors`` which imports ``ErrorCode``
# from ``models.errors``.  Registering them here keeps the mapping in one place.
def _build_doppia_status_map() -> dict[type[DoppiaError], int]:
    from errors import (
        AuthorizationError,
        CollectionNotFoundError,
        ComposerNotFoundError,
        ConceptNotFoundError,
        CorpusNotFoundError,
        FragmentAlreadyApprovedError,
        FragmentNotFoundError,
        GraphIntegrityError,
        HarmonyNotReviewedError,
        IngestionError,
        MovementNotFoundError,
        Neo4jUnavailableError,
        PostgresUnavailableError,
        RedisUnavailableError,
        UserNotFoundError,
        WorkNotFoundError,
    )

    return {
        # Infrastructure — 503
        Neo4jUnavailableError: 503,
        PostgresUnavailableError: 503,
        RedisUnavailableError: 503,
        # Not found — 404
        ComposerNotFoundError: 404,
        CorpusNotFoundError: 404,
        WorkNotFoundError: 404,
        MovementNotFoundError: 404,
        FragmentNotFoundError: 404,
        ConceptNotFoundError: 404,
        CollectionNotFoundError: 404,
        UserNotFoundError: 404,
        # Conflict — 409
        FragmentAlreadyApprovedError: 409,
        # Unprocessable — 422
        HarmonyNotReviewedError: 422,
        IngestionError: 422,
        # Auth — 403
        AuthorizationError: 403,
        # Integrity — 500
        GraphIntegrityError: 500,
    }


# Maps bare HTTP status codes to ErrorCodes for non-typed HTTPExceptions
# (auth middleware, framework errors, etc.).  Domain errors from the service
# layer always use doppia_error_handler instead.
_HTTP_STATUS_TO_ERROR_CODE: dict[int, ErrorCode] = {
    400: ErrorCode.VALIDATION_ERROR,
    401: ErrorCode.UNAUTHORIZED,
    403: ErrorCode.FORBIDDEN,
    404: ErrorCode.NOT_FOUND,
    409: ErrorCode.FRAGMENT_STATE_CONFLICT,
    422: ErrorCode.VALIDATION_ERROR,
    429: ErrorCode.RATE_LIMIT_EXCEEDED,
    501: ErrorCode.NOT_IMPLEMENTED,
}


async def doppia_error_handler(
    request: Request,
    exc: DoppiaError,
) -> JSONResponse:
    """Convert a typed ``DoppiaError`` to the standard error envelope.

    Reads ``exc.code``, ``exc.message``, and ``exc.detail`` directly — no
    status-code guessing required.  Log level is chosen by error category:
    infrastructure and integrity errors are ``ERROR``; not-found and conflict
    are ``INFO``; authorization is ``WARNING``.

    Args:
        request: The request that triggered the exception.
        exc: The raised ``DoppiaError`` subclass instance.

    Returns:
        A ``JSONResponse`` with the error envelope and the appropriate status.
    """
    status_map = _build_doppia_status_map()
    # Walk the MRO so subclasses not explicitly listed fall back to parent mapping.
    http_status = 500
    for cls in type(exc).__mro__:
        if cls in status_map:
            http_status = status_map[cls]
            break

    if isinstance(exc, InfrastructureError) or http_status == 500:
        logger.error(
            "DoppiaError on %s %s: %s",
            request.method,
            request.url.path,
            exc.message,
            exc_info=exc,
        )
    elif isinstance(exc, NotFoundError):
        logger.info(
            "Not found on %s %s: %s",
            request.method,
            request.url.path,
            exc.message,
        )
    else:
        logger.warning(
            "DoppiaError on %s %s: [%s] %s",
            request.method,
            request.url.path,
            exc.code,
            exc.message,
        )

    return JSONResponse(
        status_code=http_status,
        content={
            "error": {
                "code": exc.code,
                "message": exc.message,
                "detail": exc.detail,
            }
        },
    )


async def http_exception_handler(
    request: Request,
    exc: HTTPException,
) -> JSONResponse:
    """Convert a FastAPI ``HTTPException`` to the standard error envelope.

    Args:
        request: The request that triggered the exception.
        exc: The raised ``HTTPException``.

    Returns:
        A ``JSONResponse`` with the error envelope and the original status code.
    """
    code = _HTTP_STATUS_TO_ERROR_CODE.get(
        exc.status_code, ErrorCode.INTERNAL_SERVER_ERROR
    )
    if isinstance(exc.detail, str):
        message = exc.detail
        extra_detail: dict | None = None
    elif isinstance(exc.detail, dict):
        message = exc.detail.get("message", "HTTP error occurred.")
        extra_detail = exc.detail
    else:
        message = str(exc.detail)
        extra_detail = None
    body = ErrorResponse.make(code=code, message=message, detail=extra_detail)
    headers: dict[str, str] = getattr(exc, "headers", None) or {}
    return JSONResponse(
        status_code=exc.status_code,
        content=body.model_dump(),
        headers=headers,
    )


async def validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    """Convert a Pydantic ``RequestValidationError`` to the standard error envelope.

    The ``detail`` field contains the structured Pydantic error list so clients
    can identify which fields failed validation.

    Args:
        request: The request that triggered the exception.
        exc: The raised ``RequestValidationError``.

    Returns:
        A 422 ``JSONResponse`` with ``VALIDATION_ERROR`` code and field-level details.
    """
    body = ErrorResponse.make(
        code=ErrorCode.VALIDATION_ERROR,
        message="Request validation failed.",
        detail={"errors": exc.errors()},
    )
    return JSONResponse(
        status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        content=body.model_dump(),
    )


async def unhandled_exception_handler(
    request: Request,
    exc: Exception,
) -> JSONResponse:
    """Catch-all handler for unhandled exceptions.

    Logs the full traceback internally but returns no stack trace to callers.

    Args:
        request: The request that triggered the exception.
        exc: The unhandled exception.

    Returns:
        A 500 ``JSONResponse`` with ``INTERNAL_SERVER_ERROR`` code.
    """
    logger.exception("Unhandled exception on %s %s", request.method, request.url.path)
    body = ErrorResponse.make(
        code=ErrorCode.INTERNAL_SERVER_ERROR,
        message="An unexpected error occurred.",
    )
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content=body.model_dump(),
    )
