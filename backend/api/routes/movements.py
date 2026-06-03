"""Movement analysis API routes: harmony event correction endpoints.

Routes:
    GET    /api/v1/movements/{movement_id}/analysis/events           — read events (slice by bar range)
    POST   /api/v1/movements/{movement_id}/analysis/events           — insert a new event
    POST   /api/v1/movements/{movement_id}/analysis/events/delete    — delete an event
    PATCH  /api/v1/movements/{movement_id}/analysis/events/boundary  — move an event's beat position
    PATCH  /api/v1/movements/{movement_id}/analysis/events/chord     — edit chord fields
    POST   /api/v1/movements/{movement_id}/analysis/events/confirm   — mark reviewed=True

All routes require the ``editor`` role. Move-boundary and edit-chord are
deliberately separate endpoints; the UI must never conflate them.

See docs/roadmap/component-5-tagging-tool.md § Step 7.
"""

from __future__ import annotations

import uuid

from api.dependencies import require_role
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
from services.analysis import MovementAnalysisService
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
