"""The authenticated caller's own account (``/api/v1/users/me``).

Both routes are gated on *authentication*, not on a role: every registered user
has a profile, and ``registered`` is implicit in holding an account (ADR-037).
``get_current_user`` supplies the 401 for a tokenless request; there is nothing
here for ``require_role`` to enforce.

Writes go through the verification gate in the service layer — an unverified
account can read its profile but not change it
(``roles-and-permissions.md`` § 3).
"""

from __future__ import annotations

from typing import Annotated

from api.dependencies import AppUser, get_current_user
from fastapi import APIRouter, Depends
from models.base import get_db
from models.profile import ProfileResponse, ProfileUpdateRequest
from services import users as users_service
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
