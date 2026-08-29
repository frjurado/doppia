"""The authenticated caller's own account (``/api/v1/users/me``).

Every route here is gated on *authentication*, not on a role: every registered
user has a profile, and ``registered`` is implicit in holding an account
(ADR-037). ``get_current_user`` supplies the 401 for a tokenless request; there
is nothing here for ``require_role`` to enforce.

Writes go through the verification gate in the service layer — an unverified
account can read its profile but not change it
(``roles-and-permissions.md`` § 3).

The data-export route is deliberately *not* verification-gated: exporting is a
data right, and withholding someone's own data because they have not confirmed
an address would be a strange reading of it.
"""

from __future__ import annotations

from typing import Annotated

from api.dependencies import AppUser, get_current_user
from api.rate_limiting import WRITE, limiter
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from models.base import get_db
from models.profile import ProfileResponse, ProfileUpdateRequest
from services import users as users_service
from services.data_export import build_export
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/users", tags=["Users"])


@router.get(
    "/me",
    response_model=ProfileResponse,
    summary="Read the authenticated caller's own profile",
    response_description="The caller's account, with their granted roles.",
)
async def read_own_profile(
    user: Annotated[AppUser, Depends(get_current_user)],
    db: AsyncSession = Depends(get_db),
) -> ProfileResponse:
    """Return the caller's account.

    Args:
        user: The authenticated caller.
        db: Async database session.

    Returns:
        The caller's :class:`~models.profile.ProfileResponse`.
    """
    return await users_service.get_profile(db, user)


@router.patch(
    "/me",
    response_model=ProfileResponse,
    summary="Update the authenticated caller's own profile",
    response_description="The updated account.",
)
async def update_own_profile(
    payload: ProfileUpdateRequest,
    user: Annotated[AppUser, Depends(get_current_user)],
    db: AsyncSession = Depends(get_db),
) -> ProfileResponse:
    """Apply a partial edit to the caller's account.

    Only the fields present in the request body are touched, so an omitted
    field is left alone while an explicit ``null`` clears it.

    Args:
        payload: The partial edit.
        user: The authenticated caller.
        db: Async database session.

    Returns:
        The updated :class:`~models.profile.ProfileResponse`.

    Raises:
        EmailNotVerifiedError: 403 if the caller's address is unconfirmed.
    """
    return await users_service.update_profile(db, user, payload)


@router.get(
    "/me/export",
    response_model=None,
    summary="Export everything this account owns as one JSON document",
    response_description=(
        "A JSON document containing the caller's profile, exercise history, "
        "and reading history. Editorial contributions are excluded — they "
        "belong to the platform record, not to the account."
    ),
)
@limiter.limit(WRITE)
async def export_own_data(
    request: Request,
    user: Annotated[AppUser, Depends(get_current_user)],
    db: AsyncSession = Depends(get_db),
) -> JSONResponse:
    """Return the caller's complete personal data as one document.

    Rate-limited in the write category rather than the read one: it is cheap
    per call but assembles every row a user owns, so it should not be pollable
    at read frequency.

    Args:
        request: The incoming request (used by the rate limiter).
        user: The authenticated caller.
        db: Async database session.

    Returns:
        A :class:`~fastapi.responses.JSONResponse` carrying the export
        document, with a ``Content-Disposition`` filename so a direct fetch
        saves as a sensible file.

    Raises:
        UserNotFoundError: 404 if the account does not exist.
    """
    document = await build_export(db, user.id)
    return JSONResponse(
        content=document,
        headers={
            "Content-Disposition": (
                'attachment; filename="doppia-export-'
                f'{document["generated_at"][:10]}.json"'
            )
        },
    )
