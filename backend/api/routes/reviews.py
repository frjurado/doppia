"""Review workflow API routes.

Routes:
    GET /api/v1/reviews/queue — list submitted fragments awaiting review

The review state machine (approve/reject) lives on the fragments router.
This router owns the *discovery* surface: finding work that can be reviewed.

See docs/roadmap/component-7-fragment-database.md § Step 13.
"""

from __future__ import annotations

from typing import Annotated

from api.dependencies import AppUser, get_current_user, require_role
from api.routes.fragments import get_fragment_service
from fastapi import APIRouter, Depends, Query
from models.fragment import ReviewQueueResponse
from services.fragments import FragmentService

router = APIRouter(prefix="/reviews", tags=["Reviews"])


@router.get(
    "/queue",
    response_model=ReviewQueueResponse,
    dependencies=[require_role("editor")],
    summary="List fragments awaiting review",
    response_description=(
        "Cursor-paginated list of submitted top-level fragments not created by "
        "the caller. Admins see all submitted fragments. Ordered by submission "
        "time descending (most recently submitted first)."
    ),
)
async def get_review_queue(
    cursor: str | None = Query(
        None,
        description="Opaque pagination cursor returned by the previous response.",
    ),
    page_size: int = Query(
        50,
        ge=1,
        le=200,
        description="Maximum number of fragments to return.",
    ),
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> ReviewQueueResponse:
    """Return submitted fragments the caller is eligible to review.

    Visibility rules enforced at the service layer:
    - Only ``submitted`` top-level fragments are returned.
    - Editors do not see their own submissions (a creator cannot approve
      their own work; the queue surfaces only what the viewer can action).
    - Admins see all submitted fragments regardless of creator.

    The status filter and creator-exclusion are applied in the service and
    cannot be bypassed by a direct API call.
    """
    return await service.list_for_review(
        caller_id=user.id,
        caller_role=user.role,
        cursor=cursor,
        page_size=page_size,
    )
