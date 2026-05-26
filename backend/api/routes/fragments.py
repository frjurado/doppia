"""Fragment API routes: create, update, and submit fragment records.

Routes:
    POST  /api/v1/fragments              — create a draft fragment
    PATCH /api/v1/fragments/{id}         — update a draft (resume a session)
    POST  /api/v1/fragments/{id}/submit  — transition draft → submitted

All routes require the ``editor`` role. List/read/delete endpoints are
out of scope for Component 5 and will be added in Component 7.

See docs/roadmap/component-5-tagging-tool.md § Step 6.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from api.dependencies import AppUser, get_current_user, get_neo4j, require_role
from fastapi import APIRouter, Depends, Path
from models.base import get_db
from models.fragment import FragmentCreate, FragmentResponse, FragmentUpdate
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
