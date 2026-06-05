"""Fragment API routes: create, read, update, submit, and review fragment records.

Routes:
    GET   /api/v1/fragments/{id}             — read one fragment (full detail)
    POST  /api/v1/fragments                  — create a draft fragment
    PATCH /api/v1/fragments/{id}             — update a draft or rejected fragment
    POST  /api/v1/fragments/{id}/submit      — transition draft → submitted
    POST  /api/v1/fragments/{id}/approve     — record an approval; gate → approved
    POST  /api/v1/fragments/{id}/reject      — record a rejection → rejected

All routes require the ``editor`` role. The movement-scoped list endpoint
(GET /api/v1/movements/{id}/fragments) is registered on the movements router.

See docs/roadmap/component-5-tagging-tool.md §§ Step 6, Step 8.
See docs/roadmap/component-7-fragment-database.md § Step 7.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from api.dependencies import AppUser, get_current_user, get_neo4j, require_role
from fastapi import APIRouter, Depends, Path
from models.base import get_db
from models.fragment import (
    FragmentCreate,
    FragmentDetailResponse,
    FragmentResponse,
    FragmentUpdate,
    ReviewRequest,
)
from neo4j import AsyncDriver
from services.fragments import FragmentService
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/fragments", tags=["Fragments"])


def get_fragment_service(
    db: AsyncSession = Depends(get_db),
    driver: AsyncDriver = Depends(get_neo4j),
) -> FragmentService:
    """FastAPI dependency that constructs a :class:`~services.fragments.FragmentService`.

    Separated from the route handler so tests can override either dependency
    via ``app.dependency_overrides``.

    Args:
        db: Async SQLAlchemy session (injected by ``get_db``).
        driver: Async Neo4j driver (injected by ``get_neo4j``).

    Returns:
        A :class:`~services.fragments.FragmentService` bound to both databases.
    """
    return FragmentService(db, driver)


@router.get(
    "/{fragment_id}",
    response_model=FragmentDetailResponse,
    dependencies=[require_role("editor")],
    summary="Read one fragment (full detail)",
    response_description=(
        "Full fragment record: coordinates, concept tags hydrated with Neo4j "
        "name/alias/hierarchy, harmony events sliced from movement_analysis, "
        "and nested sub-parts one level deep."
    ),
)
async def get_fragment(
    fragment_id: uuid.UUID = Path(..., description="UUID of the fragment to read"),
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> FragmentDetailResponse:
    """Return the full record for one fragment.

    Draft fragments are visible only to their creator and admins.  All other
    statuses (submitted, approved, rejected) are visible to any editor.
    Requesting a draft that belongs to a different annotator returns 404.

    Args:
        fragment_id: UUID of the fragment to read.
        service: Fragment service (injected).
        user: Authenticated caller (injected).

    Returns:
        :class:`~models.fragment.FragmentDetailResponse` with concept tags,
        sliced harmony events, and nested sub-parts.

    Raises:
        404 ``FRAGMENT_NOT_FOUND``: Fragment does not exist or is a
            draft not owned by the caller.
    """
    return await service.get(fragment_id, caller_id=user.id, caller_role=user.role)


@router.post(
    "",
    response_model=FragmentResponse,
    status_code=201,
    dependencies=[require_role("editor")],
    summary="Create a draft fragment",
    response_description=(
        "The newly created fragment in ``draft`` status, with its assigned UUID."
    ),
)
async def create_fragment(
    payload: FragmentCreate,
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> FragmentResponse:
    """Create a new ``draft`` fragment with an atomic parent+child write.

    The payload must include coordinates (bar, mc, and optional beat ranges),
    a versioned ``summary`` JSONB, at least one concept tag, and an optional
    list of sub-part fragments. All concept IDs are validated against the
    knowledge graph before any row is written.

    The parent fragment and all sub-parts are written in a single transaction.
    If any part of the write fails, no rows are persisted.

    Args:
        payload: Full annotation payload including coordinates, concept tags,
            summary, prose, and optional sub-parts.
        service: Fragment service (injected).
        user: Authenticated caller (injected).

    Returns:
        The created :class:`~models.fragment.FragmentResponse`.
    """
    fragment = await service.create_draft(payload, creator_id=user.id)
    return FragmentResponse.model_validate(fragment)


@router.patch(
    "/{fragment_id}",
    response_model=FragmentResponse,
    dependencies=[require_role("editor")],
    summary="Update a draft fragment",
    response_description="The updated fragment.",
)
async def update_fragment(
    payload: FragmentUpdate,
    fragment_id: uuid.UUID = Path(
        ..., description="UUID of the draft fragment to update"
    ),
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> FragmentResponse:
    """Replace all mutable fields of a ``draft`` fragment.

    Only the annotator who created the draft (or an admin) may call this
    endpoint. The ``movement_id`` cannot change after creation. All concept
    tags and sub-parts in the payload replace any previously stored values.

    Args:
        payload: Replacement payload (all mutable fields; no ``movement_id``).
        fragment_id: UUID of the draft to update.
        service: Fragment service (injected).
        user: Authenticated caller (injected).

    Returns:
        The updated :class:`~models.fragment.FragmentResponse`.
    """
    fragment = await service.update_draft(
        fragment_id=fragment_id,
        payload=payload,
        caller_id=user.id,
        caller_role=user.role,
    )
    return FragmentResponse.model_validate(fragment)


@router.post(
    "/{fragment_id}/submit",
    response_model=FragmentResponse,
    dependencies=[require_role("editor")],
    summary="Submit a draft fragment for review",
    response_description="The fragment in ``submitted`` status.",
)
async def submit_fragment(
    fragment_id: uuid.UUID = Path(
        ..., description="UUID of the draft fragment to submit"
    ),
    service: FragmentService = Depends(get_fragment_service),
) -> FragmentResponse:
    """Transition a ``draft`` fragment to ``submitted``.

    The server re-validates concept existence before transitioning — the
    checklist the client enforces is not trusted. Only ``draft`` fragments
    may be submitted; already-submitted or approved fragments return 422.

    Args:
        fragment_id: UUID of the draft to submit.
        service: Fragment service (injected).

    Returns:
        The :class:`~models.fragment.FragmentResponse` in ``submitted`` status.
    """
    fragment = await service.submit(fragment_id)
    return FragmentResponse.model_validate(fragment)


@router.post(
    "/{fragment_id}/approve",
    response_model=FragmentResponse,
    dependencies=[require_role("editor")],
    summary="Approve a submitted fragment",
    response_description=(
        "The fragment after processing the approval. Status is ``approved`` "
        "when the gate passed; ``submitted`` when the threshold was not yet met."
    ),
)
async def approve_fragment(
    payload: ReviewRequest,
    fragment_id: uuid.UUID = Path(
        ..., description="UUID of the submitted fragment to approve"
    ),
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> FragmentResponse:
    """Record an approval decision and apply the approval gate.

    The reviewer's vote is always persisted, even when the gate fails (422).
    This allows the creator to fix blocking items without the reviewer needing
    to re-vote.

    The gate checks (from ``fragment-schema.md`` § "Fragment approval and
    harmony review"):

    * Every ``actual_key`` with ``auto: true`` must have ``reviewed: true``.
    * For concepts that declare a ``harmony_gate`` capture extension, every
      ``movement_analysis`` event in the fragment's bar range must have
      ``reviewed: true``.

    Admins bypass the self-review rule and the approval threshold.

    Args:
        payload: Optional comment to accompany the review decision.
        fragment_id: UUID of the submitted fragment.
        service: Fragment service (injected).
        user: Authenticated caller (injected).

    Returns:
        The updated :class:`~models.fragment.FragmentResponse`.

    Raises:
        422 ``SELF_REVIEW_FORBIDDEN``: Reviewer is the fragment's creator.
        422 ``HARMONY_NOT_REVIEWED``: Gate failed; detail contains blocking items.
    """
    fragment = await service.approve(
        fragment_id=fragment_id,
        reviewer_id=user.id,
        reviewer_role=user.role,
        comment=payload.comment,
    )
    return FragmentResponse.model_validate(fragment)


@router.post(
    "/{fragment_id}/reject",
    response_model=FragmentResponse,
    dependencies=[require_role("editor")],
    summary="Reject a submitted fragment",
    response_description="The fragment in ``rejected`` status.",
)
async def reject_fragment(
    payload: ReviewRequest,
    fragment_id: uuid.UUID = Path(
        ..., description="UUID of the submitted fragment to reject"
    ),
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> FragmentResponse:
    """Record a rejection decision and transition the fragment to ``rejected``.

    A single rejection immediately flips the status, regardless of any prior
    approval votes.  The creating annotator may revise by PATCHing the
    fragment (which transitions ``rejected → draft``) and then resubmitting.

    Admins bypass the self-review rule and may reject their own fragments.

    Args:
        payload: Optional comment explaining the rejection.
        fragment_id: UUID of the submitted fragment.
        service: Fragment service (injected).
        user: Authenticated caller (injected).

    Returns:
        The :class:`~models.fragment.FragmentResponse` in ``rejected`` status.

    Raises:
        422 ``SELF_REVIEW_FORBIDDEN``: Reviewer is the fragment's creator.
    """
    fragment = await service.reject(
        fragment_id=fragment_id,
        reviewer_id=user.id,
        reviewer_role=user.role,
        comment=payload.comment,
    )
    return FragmentResponse.model_validate(fragment)
