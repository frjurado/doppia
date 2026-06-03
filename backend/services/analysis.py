"""Movement analysis service: harmony event editing primitives.

Owns all mutations on ``movement_analysis.events`` (JSONB). Route handlers
delegate here; no handler touches the database directly.

Four editing primitives (separate endpoints — never conflated):
- insert_event    — add a new event at (mn, volta, beat)
- delete_event    — remove an event; the prior event extends through its slot
- move_boundary   — change beat position without altering chord identity
- edit_chord      — change chord fields without moving beat position

Plus a confirm action:
- confirm_event   — flip reviewed=True without changing any other field

Every edit (insert/delete/move/chord) sets source="manual", auto=False,
reviewed=True. confirm sets only reviewed=True.

Event identity: (mn, volta, beat) is the universal key across all sources.
The optional ``mc`` field is an additional cross-check for DCML events.

See docs/roadmap/component-5-tagging-tool.md § Step 7.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from errors import HarmonyEventNotFoundError, MovementNotFoundError
from models.analysis import (
    HarmonyEventConfirm,
    HarmonyEventDeleteRequest,
    HarmonyEventEditChord,
    HarmonyEventInsert,
    HarmonyEventMoveBoundary,
    MovementAnalysis,
)
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import flag_modified

# Chord fields that edit_chord may update (excludes identity and provenance fields).
_CHORD_FIELDS: tuple[str, ...] = (
    "local_key",
    "root",
    "quality",
    "inversion",
    "numeral",
    "root_accidental",
    "applied_to",
    "extensions",
)


class MovementAnalysisService:
    """Business logic for harmony event corrections.

    Args:
        db: Scoped async SQLAlchemy session (from ``get_db`` dependency).
    """

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def get_events(
        self,
        movement_id: uuid.UUID,
        bar_start: int | None = None,
        bar_end: int | None = None,
    ) -> list[dict]:
        """Return harmony events for a movement, optionally filtered by bar range.

        The ``bar_start`` / ``bar_end`` filter is inclusive on both ends and
        matches against the event's ``mn`` (human notated bar number).

        Args:
            movement_id: UUID of the movement whose analysis to read.
            bar_start: Inclusive lower bound on ``mn``.
            bar_end: Inclusive upper bound on ``mn``.

        Returns:
            List of event dicts from ``movement_analysis.events``.

        Raises:
            MovementNotFoundError: No analysis record for this movement.
        """
        analysis = await self._load(movement_id)
        events: list[dict] = analysis.events
        if bar_start is not None:
            events = [ev for ev in events if ev.get("mn", 0) >= bar_start]
        if bar_end is not None:
            events = [ev for ev in events if ev.get("mn", 0) <= bar_end]
        return events

    async def insert_event(
        self,
        movement_id: uuid.UUID,
        payload: HarmonyEventInsert,
    ) -> dict:
        """Insert a new harmony event in sorted position.

        The event is inserted in (mn, volta, beat) sort order. Provenance
        flags are set to source="manual", auto=False, reviewed=True.

        Args:
            movement_id: UUID of the movement to modify.
            payload: Validated insert payload.

        Returns:
            The newly inserted event dict.

        Raises:
            MovementNotFoundError: No analysis record for this movement.
        """
        async with self._db.begin():
            analysis = await self._load(movement_id)
            events: list[dict] = list(analysis.events)

            new_event: dict = {
                "mc": payload.mc,
                "mn": payload.mn,
                "volta": payload.volta,
                "beat": payload.beat,
                "local_key": payload.local_key,
                "root": payload.root,
                "quality": payload.quality,
                "inversion": payload.inversion,
                "numeral": payload.numeral,
                "root_accidental": payload.root_accidental,
                "applied_to": payload.applied_to,
                "extensions": payload.extensions,
                "bass_pitch": None,
                "soprano_pitch": None,
                **_manual_provenance(),
            }

            events.append(new_event)
            events.sort(key=_event_sort_key)
            self._persist(analysis, events)

        return new_event

    async def delete_event(
        self,
        movement_id: uuid.UUID,
        payload: HarmonyEventDeleteRequest,
    ) -> None:
        """Remove a harmony event from the movement's timeline.

        The event immediately preceding the removed one automatically extends
        through the vacated slot — this is a read-time consequence of the
        change-event model and requires no explicit action here.

        Args:
            movement_id: UUID of the movement to modify.
            payload: Identity of the event to remove.

        Raises:
            MovementNotFoundError: No analysis record for this movement.
            HarmonyEventNotFoundError: No event matches (mn, volta, beat).
        """
        async with self._db.begin():
            analysis = await self._load(movement_id)
            events: list[dict] = list(analysis.events)

            idx = _find_event(
                events, payload.mn, payload.volta, payload.beat, payload.mc
            )
            events.pop(idx)
            self._persist(analysis, events)

    async def move_boundary(
        self,
        movement_id: uuid.UUID,
        payload: HarmonyEventMoveBoundary,
    ) -> dict:
        """Change an event's beat position without altering chord identity fields.

        Distinct from edit_chord: this operation changes WHEN the harmony
        begins, not WHAT the harmony is. Sets provenance flags.

        Args:
            movement_id: UUID of the movement to modify.
            payload: Current identity (mn, volta, beat) plus the target beat.

        Returns:
            The updated event dict.

        Raises:
            MovementNotFoundError: No analysis record for this movement.
            HarmonyEventNotFoundError: No event matches (mn, volta, beat).
        """
        async with self._db.begin():
            analysis = await self._load(movement_id)
            events: list[dict] = list(analysis.events)

            idx = _find_event(
                events, payload.mn, payload.volta, payload.beat, payload.mc
            )
            event = dict(events[idx])
            event["beat"] = payload.new_beat
            event.update(_manual_provenance())
            events[idx] = event
            # Re-sort: new_beat may place the event in a different position.
            events.sort(key=_event_sort_key)
            self._persist(analysis, events)

        return event

    async def edit_chord(
        self,
        movement_id: uuid.UUID,
        payload: HarmonyEventEditChord,
    ) -> dict:
        """Update chord fields on an existing event without moving its beat position.

        Distinct from move_boundary: this operation changes WHAT the harmony
        is, not WHEN it begins. Fields set to None in the payload are not
        changed. Sets provenance flags.

        Args:
            movement_id: UUID of the movement to modify.
            payload: Event identity plus the chord fields to change.

        Returns:
            The updated event dict.

        Raises:
            MovementNotFoundError: No analysis record for this movement.
            HarmonyEventNotFoundError: No event matches (mn, volta, beat).
        """
        async with self._db.begin():
            analysis = await self._load(movement_id)
            events: list[dict] = list(analysis.events)

            idx = _find_event(
                events, payload.mn, payload.volta, payload.beat, payload.mc
            )
            event = dict(events[idx])

            for field in _CHORD_FIELDS:
                value = getattr(payload, field)
                if value is not None:
                    event[field] = value

            event.update(_manual_provenance())
            events[idx] = event
            self._persist(analysis, events)

        return event

    async def confirm_event(
        self,
        movement_id: uuid.UUID,
        payload: HarmonyEventConfirm,
    ) -> dict:
        """Mark an event reviewed=True without changing any other field.

        This is the common-case action for DCML events that are correct as
        imported and require no corrections. Does NOT update source or auto.

        Args:
            movement_id: UUID of the movement to modify.
            payload: Identity of the event to confirm.

        Returns:
            The updated event dict.

        Raises:
            MovementNotFoundError: No analysis record for this movement.
            HarmonyEventNotFoundError: No event matches (mn, volta, beat).
        """
        async with self._db.begin():
            analysis = await self._load(movement_id)
            events: list[dict] = list(analysis.events)

            idx = _find_event(
                events, payload.mn, payload.volta, payload.beat, payload.mc
            )
            event = dict(events[idx])
            event["reviewed"] = True
            events[idx] = event
            self._persist(analysis, events)

        return event

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _load(self, movement_id: uuid.UUID) -> MovementAnalysis:
        """Load the analysis record or raise MovementNotFoundError.

        Raises:
            MovementNotFoundError: No ``movement_analysis`` row for this
                movement (either the movement doesn't exist or hasn't been
                analysed yet).
        """
        result = await self._db.execute(
            select(MovementAnalysis).where(MovementAnalysis.movement_id == movement_id)
        )
        analysis = result.scalar_one_or_none()
        if analysis is None:
            raise MovementNotFoundError(
                f"No analysis record found for movement '{movement_id}'.",
                detail={"movement_id": str(movement_id)},
            )
        return analysis

    def _persist(
        self,
        analysis: MovementAnalysis,
        events: list[dict],
    ) -> None:
        """Write the mutated events list back and bump updated_at.

        ``flag_modified`` is called alongside the attribute reassignment to
        ensure SQLAlchemy detects the JSONB change even if it uses equality
        rather than identity comparison internally.
        """
        analysis.events = events
        flag_modified(analysis, "events")
        analysis.updated_at = datetime.now(tz=timezone.utc)
        self._db.add(analysis)


# ---------------------------------------------------------------------------
# Module-level pure helpers
# ---------------------------------------------------------------------------


def _manual_provenance() -> dict:
    """Provenance flags applied to any manually edited event."""
    return {"source": "manual", "auto": False, "reviewed": True}


def _event_sort_key(ev: dict) -> tuple:
    """Sort key: (mn, volta resolved to 0 if null, beat)."""
    return (ev.get("mn", 0), ev.get("volta") or 0, ev.get("beat", 0.0))


def _find_event(
    events: list[dict],
    mn: int,
    volta: int | None,
    beat: float,
    mc: int | None,
) -> int:
    """Find the index of an event by its universal identity (mn, volta, beat).

    The optional ``mc`` is a cross-check for DCML events: if supplied and
    the candidate event has a non-null ``mc`` that does not match, the
    candidate is skipped.

    Args:
        events: Full events list from ``movement_analysis``.
        mn: Notated measure number.
        volta: Ending/volta number, or None.
        beat: 1-indexed beat within the bar.
        mc: Optional DCML machine-count cross-check.

    Returns:
        Zero-based index of the matching event.

    Raises:
        HarmonyEventNotFoundError: No event matches the identity.
    """
    for i, ev in enumerate(events):
        if ev.get("mn") == mn and ev.get("volta") == volta and ev.get("beat") == beat:
            if mc is not None and ev.get("mc") is not None and ev.get("mc") != mc:
                continue
            return i
    raise HarmonyEventNotFoundError(
        f"No harmony event found at mn={mn}, volta={volta}, beat={beat}.",
        detail={"mn": mn, "volta": volta, "beat": beat},
    )
