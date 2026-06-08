"""Movement analysis API routes: harmony event correction and fragment list.

Routes:
    GET    /api/v1/movements/{movement_id}/fragments                 — list stored fragments (cursor-paginated)
    GET    /api/v1/movements/{movement_id}/analysis/events           — read events (slice by bar range)
    POST   /api/v1/movements/{movement_id}/analysis/events           — insert a new event
    POST   /api/v1/movements/{movement_id}/analysis/events/delete    — delete an event
    PATCH  /api/v1/movements/{movement_id}/analysis/events/boundary  — move an event's beat position
    PATCH  /api/v1/movements/{movement_id}/analysis/events/chord     — edit chord fields
    POST   /api/v1/movements/{movement_id}/analysis/events/confirm   — mark reviewed=True

All routes require the ``editor`` role. Move-boundary and edit-chord are
deliberately separate endpoints; the UI must never conflate them.

See docs/roadmap/component-5-tagging-tool.md § Step 7.
See docs/roadmap/component-7-fragment-database.md § Step 7.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from api.dependencies import AppUser, get_current_user, get_neo4j, require_role
from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import Response
from models.analysis import (
    HarmonyEventConfirm,
    HarmonyEventDeleteRequest,
    HarmonyEventEditChord,
    HarmonyEventInsert,
    HarmonyEventMoveBoundary,
    HarmonyEventOut,
)
from models.base import get_db
from models.fragment import FragmentListResponse
from neo4j import AsyncDriver
from services.analysis import MovementAnalysisService
from services.fragments import FragmentService
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/movements", tags=["Movements"])


def get_analysis_service(
    db: AsyncSession = Depends(get_db),
) -> MovementAnalysisService:
    """FastAPI dependency that constructs a :class:`~services.analysis.MovementAnalysisService`.

    Args:
        db: Async SQLAlchemy session (injected by ``get_db``).

    Returns:
        A :class:`~services.analysis.MovementAnalysisService` bound to the session.
    """
    return MovementAnalysisService(db)


def get_fragment_service(
    db: AsyncSession = Depends(get_db),
    driver: AsyncDriver = Depends(get_neo4j),
) -> FragmentService:
    """FastAPI dependency that constructs a :class:`~services.fragments.FragmentService`.

    Args:
        db: Async SQLAlchemy session (injected by ``get_db``).
        driver: Async Neo4j driver (injected by ``get_neo4j``).

    Returns:
        A :class:`~services.fragments.FragmentService` bound to both databases.
    """
    return FragmentService(db, driver)


@router.get(
    "/{movement_id}/fragments",
    response_model=FragmentListResponse,
    dependencies=[require_role("editor")],
    summary="List stored fragments for a movement",
    response_description=(
        "Cursor-paginated list of top-level fragments for the movement, each "
        "with sub-parts nested one level deep. Status visibility is enforced "
        "at the service layer: editors see their own drafts plus all "
        "submitted/approved/rejected; admins see all."
    ),
)
async def list_movement_fragments(
    movement_id: uuid.UUID = Path(
        ..., description="UUID of the movement whose fragments to list"
    ),
    cursor: str | None = Query(
        None,
        description=(
            "Opaque pagination cursor from a prior response. Omit to start "
            "from the first fragment (ordered by mc_start, then id)."
        ),
    ),
    page_size: int = Query(
        100,
        ge=1,
        le=500,
        description="Maximum number of top-level fragments to return per page.",
    ),
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> FragmentListResponse:
    """Return a cursor-paginated list of fragments tagged on a movement.

    Returns only top-level fragments (no ``parent_fragment_id``); their
    sub-parts are nested inside each item. Pagination is ordered by
    ``(mc_start ASC, id ASC)`` for stable, position-ordered traversal.

    The status filter is enforced at the service layer and cannot be
    bypassed by a direct API call. Editors see their own drafts plus all
    submitted/approved/rejected fragments. A different annotator's drafts
    are invisible.

    This endpoint answers "what is tagged on this score." The concept-tag
    browse query ("all PACs in the corpus") is Component 8.

    Args:
        movement_id: UUID of the movement to query.
        cursor: Opaque cursor from ``next_cursor`` in a prior response.
        page_size: Maximum top-level items per page (1–500, default 100).
        service: Fragment service (injected).
        user: Authenticated caller (injected).

    Returns:
        :class:`~models.fragment.FragmentListResponse` with ``items`` and
        an optional ``next_cursor``.

    Raises:
        422: Cursor string is malformed.
    """
    return await service.list_for_movement(
        movement_id,
        caller_id=user.id,
        caller_role=user.role,
        cursor=cursor,
        page_size=page_size,
    )


@router.get(
    "/{movement_id}/analysis/events",
    response_model=list[HarmonyEventOut],
    dependencies=[require_role("editor")],
    summary="Read harmony events for a movement",
    response_description="List of harmony events, optionally filtered by bar range.",
)
async def get_harmony_events(
    movement_id: uuid.UUID = Path(
        ..., description="UUID of the movement whose analysis to read"
    ),
    bar_start: int | None = Query(
        None, ge=0, description="Inclusive lower bound on notated bar number (mn)"
    ),
    bar_end: int | None = Query(
        None, ge=0, description="Inclusive upper bound on notated bar number (mn)"
    ),
    service: MovementAnalysisService = Depends(get_analysis_service),
) -> list[HarmonyEventOut]:
    """Return harmony events for a movement, optionally sliced by bar range.

    The ``bar_start`` / ``bar_end`` filters are inclusive and match on ``mn``
    (the human-readable notated bar number). Omit both to return all events.

    Args:
        movement_id: UUID of the movement to read.
        bar_start: Inclusive lower bound on notated bar number.
        bar_end: Inclusive upper bound on notated bar number.
        service: Analysis service (injected).

    Returns:
        List of :class:`~models.analysis.HarmonyEventOut` in (mn, volta, beat) order.
    """
    events = await service.get_events(movement_id, bar_start=bar_start, bar_end=bar_end)
    return [HarmonyEventOut.model_validate(ev) for ev in events]


@router.post(
    "/{movement_id}/analysis/events",
    response_model=HarmonyEventOut,
    status_code=201,
    dependencies=[require_role("editor")],
    summary="Insert a new harmony event",
    response_description="The newly inserted event with provenance flags set.",
)
async def insert_harmony_event(
    payload: HarmonyEventInsert,
    movement_id: uuid.UUID = Path(..., description="UUID of the movement to modify"),
    service: MovementAnalysisService = Depends(get_analysis_service),
) -> HarmonyEventOut:
    """Insert a new harmony event at the given (mn, volta, beat) position.

    The event is inserted in sorted order. Provenance flags are set to
    ``source="manual"``, ``auto=False``, ``reviewed=True``.

    Args:
        payload: Beat position and chord fields for the new event.
        movement_id: UUID of the movement to modify.
        service: Analysis service (injected).

    Returns:
        The created :class:`~models.analysis.HarmonyEventOut`.
    """
    event = await service.insert_event(movement_id, payload)
    return HarmonyEventOut.model_validate(event)


@router.post(
    "/{movement_id}/analysis/events/delete",
    status_code=204,
    response_class=Response,
    dependencies=[require_role("editor")],
    summary="Delete a harmony event",
    response_description="No content — event removed successfully.",
)
async def delete_harmony_event(
    payload: HarmonyEventDeleteRequest,
    movement_id: uuid.UUID = Path(..., description="UUID of the movement to modify"),
    service: MovementAnalysisService = Depends(get_analysis_service),
) -> Response:
    """Remove the harmony event identified by (mn, volta, beat).

    The event immediately preceding the removed one automatically extends
    through the vacated slot (change-event model semantics).

    Args:
        payload: Identity of the event to remove.
        movement_id: UUID of the movement to modify.
        service: Analysis service (injected).

    Returns:
        Empty 204 response.
    """
    await service.delete_event(movement_id, payload)
    return Response(status_code=204)


@router.patch(
    "/{movement_id}/analysis/events/boundary",
    response_model=HarmonyEventOut,
    dependencies=[require_role("editor")],
    summary="Move an event's beat position",
    response_description="The updated event with new beat and provenance flags.",
)
async def move_harmony_boundary(
    payload: HarmonyEventMoveBoundary,
    movement_id: uuid.UUID = Path(..., description="UUID of the movement to modify"),
    service: MovementAnalysisService = Depends(get_analysis_service),
) -> HarmonyEventOut:
    """Move an event's beat position without altering chord identity fields.

    This endpoint changes WHEN a harmony begins, not WHAT it is. It is
    categorically distinct from ``PATCH .../chord``, which changes chord
    fields but never moves the beat. Provenance flags are set.

    Args:
        payload: Current identity (mn, volta, beat) and target beat (new_beat).
        movement_id: UUID of the movement to modify.
        service: Analysis service (injected).

    Returns:
        The updated :class:`~models.analysis.HarmonyEventOut`.
    """
    event = await service.move_boundary(movement_id, payload)
    return HarmonyEventOut.model_validate(event)


@router.patch(
    "/{movement_id}/analysis/events/chord",
    response_model=HarmonyEventOut,
    dependencies=[require_role("editor")],
    summary="Edit chord fields on an existing event",
    response_description="The updated event with new chord fields and provenance flags.",
)
async def edit_harmony_chord(
    payload: HarmonyEventEditChord,
    movement_id: uuid.UUID = Path(..., description="UUID of the movement to modify"),
    service: MovementAnalysisService = Depends(get_analysis_service),
) -> HarmonyEventOut:
    """Update chord fields on an existing event without moving its beat position.

    This endpoint changes WHAT a harmony is, not WHEN it begins. It is
    categorically distinct from ``PATCH .../boundary``, which moves the beat
    but never changes chord fields. Fields left as ``null`` in the payload are
    not modified. Provenance flags are set.

    Args:
        payload: Event identity plus the chord fields to change (null = no change).
        movement_id: UUID of the movement to modify.
        service: Analysis service (injected).

    Returns:
        The updated :class:`~models.analysis.HarmonyEventOut`.
    """
    event = await service.edit_chord(movement_id, payload)
    return HarmonyEventOut.model_validate(event)


@router.post(
    "/{movement_id}/analysis/events/confirm",
    response_model=HarmonyEventOut,
    dependencies=[require_role("editor")],
    summary="Confirm a harmony event as reviewed",
    response_description="The event with reviewed=True; no other field changed.",
)
async def confirm_harmony_event(
    payload: HarmonyEventConfirm,
    movement_id: uuid.UUID = Path(..., description="UUID of the movement to modify"),
    service: MovementAnalysisService = Depends(get_analysis_service),
) -> HarmonyEventOut:
    """Mark an event ``reviewed=True`` without changing any other field.

    This is the common-case action for DCML events that are correct as
    imported and need no corrections. Unlike the other write operations it
    does NOT update ``source`` or ``auto``.

    Args:
        payload: Identity of the event to confirm.
        movement_id: UUID of the movement to modify.
        service: Analysis service (injected).

    Returns:
        The :class:`~models.analysis.HarmonyEventOut` with ``reviewed=True``.
    """
    event = await service.confirm_event(movement_id, payload)
    return HarmonyEventOut.model_validate(event)
