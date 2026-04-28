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

See ``models/errors.py`` for the full ``ErrorCode`` vocabulary and
``docs/architecture/error-handling.md`` for propagation rules.
"""

from __future__ import annotations

import logging

from fastapi import Request, status
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from models.errors import ErrorCode, ErrorResponse
from starlette.exceptions import HTTPException

logger = logging.getLogger(__name__)

# Maps common HTTP status codes to the closest semantic ErrorCode.
# Unmapped codes fall back to INTERNAL_SERVER_ERROR.
_HTTP_STATUS_TO_ERROR_CODE: dict[int, ErrorCode] = {
    400: ErrorCode.VALIDATION_ERROR,
    401: ErrorCode.UNAUTHORIZED,
    403: ErrorCode.FORBIDDEN,
    404: ErrorCode.INTERNAL_SERVER_ERROR,
    409: ErrorCode.FRAGMENT_STATE_CONFLICT,
    422: ErrorCode.VALIDATION_ERROR,
    429: ErrorCode.RATE_LIMIT_EXCEEDED,
    501: ErrorCode.NOT_IMPLEMENTED,
}


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
    message = exc.detail if isinstance(exc.detail, str) else str(exc.detail)
    body = ErrorResponse.make(code=code, message=message)
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
