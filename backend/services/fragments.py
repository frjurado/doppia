"""Fragment service: create, update, and submit fragment records.

Owns the transaction that atomically writes a parent fragment and all its
sub-parts. No route handler touches a database directly — all PostgreSQL
and Neo4j access goes through this service.

Cross-database referential integrity (concept_id existence in Neo4j) is
verified before the transaction opens. The data_licence is derived from
movement_analysis events in the fragment's bar range per ADR-009.

See docs/roadmap/component-5-tagging-tool.md § Step 6.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from errors import FragmentNotFoundError, FragmentValidationError
from models.analysis import MovementAnalysis
from models.fragment import (
    Fragment,
    FragmentConceptTag,
    FragmentCreate,
    FragmentUpdate,
    SubPartFragmentCreate,
)
from neo4j import AsyncDriver
from services.fragment_validation import (
    validate_concept_existence,
    validate_containment,
)
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession


class FragmentService:
    """Business logic for the fragment write surface.

    Args:
        db: Scoped async SQLAlchemy session (from ``get_db`` dependency).
        driver: Application-scoped async Neo4j driver (from ``get_neo4j``).
    """

    def __init__(self, db: AsyncSession, driver: AsyncDriver) -> None:
        self._db = db
        self._driver = driver

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def create_draft(
        self,
        payload: FragmentCreate,
        creator_id: str,
    ) -> Fragment:
        """Create a new ``draft`` fragment with an atomic parent+child write.

        Validation order:
        1. Sub-part bar containment (service layer; no DB constraint).
        2. Concept existence in Neo4j (cross-database referential integrity).
        3. Data-licence derivation from movement_analysis events.
        4. Atomic INSERT: parent row → flush → concept tags → sub-parts.

        If any child write fails the whole transaction rolls back.

        Args:
            payload: Validated ``FragmentCreate`` payload from the route handler.
            creator_id: String UUID of the authenticated caller.

        Returns:
            The newly created parent :class:`~models.fragment.Fragment` ORM row,
            with ``status = 'draft'``.

        Raises:
            FragmentValidationError: Concept id missing in graph, sub-part out
                of range, or other semantic constraint failure.
        """
        validate_containment(payload, payload.sub_parts)
        await self._check_all_concepts(payload)

        async with self._db.begin():
            data_licence = await self._derive_data_licence(
                payload.movement_id, payload.bar_start, payload.bar_end
            )
            parent = self._make_fragment_orm(
                payload,
                creator_id=uuid.UUID(creator_id),
                data_licence=data_licence,
                status="draft",
            )
            self._db.add(parent)
            await self._db.flush()

            self._add_concept_tags(parent.id, payload.concept_tags)

            for sp in payload.sub_parts:
                child = self._make_subpart_orm(
                    sp, parent.id, payload.movement_id, data_licence
                )
                self._db.add(child)
                await self._db.flush()
                self._add_concept_tags(child.id, sp.concept_tags)

        return parent

    async def update_draft(
        self,
        fragment_id: uuid.UUID,
        payload: FragmentUpdate,
        caller_id: str,
        caller_role: str,
    ) -> Fragment:
        """Replace all mutable fields of a draft fragment atomically.

        Only the creating annotator or an admin may update a draft. The
        movement_id is immutable; all other fields (coordinates, summary,
        tags, sub-parts) are replaced wholesale from the payload.

        Args:
            fragment_id: UUID of the fragment to update.
            payload: Validated ``FragmentUpdate`` payload.
            caller_id: String UUID of the authenticated caller.
            caller_role: Role of the authenticated caller (``"editor"`` or
                ``"admin"``).

        Returns:
            The updated :class:`~models.fragment.Fragment` ORM row.

        Raises:
            FragmentNotFoundError: Fragment does not exist.
            FragmentValidationError: Not a draft, caller lacks permission, or
                concept id missing in graph.
        """
        validate_containment_for_update(payload)
        await self._check_all_concepts_for_update(payload)

        async with self._db.begin():
            fragment = await self._get_draft(fragment_id)
            self._check_edit_permission(fragment, caller_id, caller_role)

            data_licence = await self._derive_data_licence(
                fragment.movement_id, payload.bar_start, payload.bar_end
            )

            # Update scalar fields on the parent row.
            fragment.bar_start = payload.bar_start
            fragment.bar_end = payload.bar_end
            fragment.mc_start = payload.mc_start
            fragment.mc_end = payload.mc_end
            fragment.beat_start = payload.beat_start
            fragment.beat_end = payload.beat_end
            fragment.repeat_context = payload.repeat_context
            fragment.summary = payload.summary.model_dump()
            fragment.prose_annotation = payload.prose_annotation
            fragment.data_licence = data_licence
            fragment.updated_at = datetime.now(tz=timezone.utc)
            self._db.add(fragment)

            # Delete and re-insert concept tags for the parent.
            await self._db.execute(
                delete(FragmentConceptTag).where(
                    FragmentConceptTag.fragment_id == fragment_id
                )
            )
            self._add_concept_tags(fragment_id, payload.concept_tags)

            # Delete existing sub-parts (cascade deletes their tags).
            await self._db.execute(
                delete(Fragment).where(Fragment.parent_fragment_id == fragment_id)
            )

            # Re-insert sub-parts.
            for sp in payload.sub_parts:
                child = self._make_subpart_orm(
                    sp, fragment_id, fragment.movement_id, data_licence
                )
                self._db.add(child)
                await self._db.flush()
                self._add_concept_tags(child.id, sp.concept_tags)

        return fragment

    async def submit(self, fragment_id: uuid.UUID) -> Fragment:
        """Transition a draft fragment to ``submitted``.

        The server re-validates concept existence before transitioning —
        never trust that client-side checks are sufficient.

        Args:
            fragment_id: UUID of the fragment to submit.

        Returns:
            The updated :class:`~models.fragment.Fragment` ORM row with
            ``status = 'submitted'``.

        Raises:
            FragmentNotFoundError: Fragment does not exist.
            FragmentValidationError: Not a draft, or a concept id has been
                removed from the graph since the draft was saved.
        """
        async with self._db.begin():
            fragment = await self._get_draft(fragment_id)

            # Re-validate concept existence server-side (inside tx so the
            # status transition and the re-validation are atomic).
            result = await self._db.execute(
                select(FragmentConceptTag.concept_id).where(
                    FragmentConceptTag.fragment_id == fragment_id
                )
            )
            concept_ids = list(result.scalars().all())
            await validate_concept_existence(concept_ids, self._driver)

            fragment.status = "submitted"
            fragment.updated_at = datetime.now(tz=timezone.utc)
            self._db.add(fragment)

        return fragment

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    async def _get_draft(self, fragment_id: uuid.UUID) -> Fragment:
        """Load a fragment and assert it is in ``draft`` status.

        Raises:
            FragmentNotFoundError: No fragment with this id exists.
            FragmentValidationError: Fragment exists but is not a draft.
        """
        result = await self._db.execute(
            select(Fragment).where(Fragment.id == fragment_id)
        )
        fragment = result.scalar_one_or_none()
        if fragment is None:
            raise FragmentNotFoundError(
                f"No fragment with id '{fragment_id}' exists.",
                detail={"fragment_id": str(fragment_id)},
            )
        if fragment.status != "draft":
            raise FragmentValidationError(
                f"Fragment '{fragment_id}' has status '{fragment.status}' and "
                "cannot be modified. Only drafts may be updated or submitted.",
                detail={
                    "fragment_id": str(fragment_id),
                    "current_status": fragment.status,
                },
            )
        return fragment

    @staticmethod
    def _check_edit_permission(
        fragment: Fragment, caller_id: str, caller_role: str
    ) -> None:
        """Assert that the caller may edit this draft.

        Raises:
            FragmentValidationError: Caller is not the creator and not an admin.
        """
        is_creator = (
            fragment.created_by is not None and str(fragment.created_by) == caller_id
        )
        if not is_creator and caller_role != "admin":
            raise FragmentValidationError(
                "Only the creating annotator or an admin may update a draft.",
                detail={
                    "fragment_id": str(fragment.id),
                    "caller_id": caller_id,
                    "creator_id": (
                        str(fragment.created_by) if fragment.created_by else None
                    ),
                },
            )

    async def _check_all_concepts(self, payload: FragmentCreate) -> None:
        """Collect concept IDs across parent and sub-parts and validate all."""
        ids: list[str] = [t.concept_id for t in payload.concept_tags]
        for sp in payload.sub_parts:
            ids.extend(t.concept_id for t in sp.concept_tags)
        await validate_concept_existence(ids, self._driver)

    async def _check_all_concepts_for_update(self, payload: FragmentUpdate) -> None:
        """Collect concept IDs across parent and sub-parts and validate all."""
        ids: list[str] = [t.concept_id for t in payload.concept_tags]
        for sp in payload.sub_parts:
            ids.extend(t.concept_id for t in sp.concept_tags)
        await validate_concept_existence(ids, self._driver)

    async def _derive_data_licence(
        self,
        movement_id: uuid.UUID,
        bar_start: int,
        bar_end: int,
    ) -> str | None:
        """Derive the effective data_licence from movement_analysis events.

        Inspects the ``source`` field of every event in the fragment's bar
        range.  A fragment containing any DCML-sourced event is classified
        as CC BY-SA 4.0 per ADR-009.  Returns ``None`` when no
        movement_analysis record exists (pre-analysis upload state) or when
        all events in range carry non-DCML sources.

        Args:
            movement_id: The movement this fragment belongs to.
            bar_start: Human ``@n`` measure number of the fragment start.
            bar_end: Human ``@n`` measure number of the fragment end.

        Returns:
            ``"CC BY-SA 4.0"`` if any in-range event has ``source == "DCML"``,
            otherwise ``None``.
        """
        result = await self._db.execute(
            select(MovementAnalysis.events).where(
                MovementAnalysis.movement_id == movement_id
            )
        )
        events = result.scalar_one_or_none()
        if not events:
            return None

        for ev in events:
            mn = ev.get("mn")
            if mn is not None and bar_start <= int(mn) <= bar_end:
                if ev.get("source") == "DCML":
                    return "CC BY-SA 4.0"
        return None

    def _make_fragment_orm(
        self,
        payload: FragmentCreate,
        *,
        creator_id: uuid.UUID,
        data_licence: str | None,
        status: str,
    ) -> Fragment:
        """Construct a parent Fragment ORM object from a create payload."""
        return Fragment(
            movement_id=payload.movement_id,
            bar_start=payload.bar_start,
            bar_end=payload.bar_end,
            mc_start=payload.mc_start,
            mc_end=payload.mc_end,
            beat_start=payload.beat_start,
            beat_end=payload.beat_end,
            repeat_context=payload.repeat_context,
            summary=payload.summary.model_dump(),
            prose_annotation=payload.prose_annotation,
            data_licence=data_licence,
            status=status,
            created_by=creator_id,
        )

    def _make_subpart_orm(
        self,
        sp: SubPartFragmentCreate,
        parent_id: uuid.UUID,
        movement_id: uuid.UUID,
        data_licence: str | None,
    ) -> Fragment:
        """Construct a child Fragment ORM object from a sub-part payload."""
        return Fragment(
            movement_id=movement_id,
            bar_start=sp.bar_start,
            bar_end=sp.bar_end,
            mc_start=sp.mc_start,
            mc_end=sp.mc_end,
            beat_start=sp.beat_start,
            beat_end=sp.beat_end,
            repeat_context=sp.repeat_context,
            parent_fragment_id=parent_id,
            summary=sp.summary.model_dump(),
            prose_annotation=sp.prose_annotation,
            data_licence=data_licence,
            status="draft",
        )

    def _add_concept_tags(
        self,
        fragment_id: uuid.UUID,
        tags: list,
    ) -> None:
        """Add FragmentConceptTag rows for the given fragment and tag list."""
        for tag in tags:
            self._db.add(
                FragmentConceptTag(
                    fragment_id=fragment_id,
                    concept_id=tag.concept_id,
                    is_primary=tag.is_primary,
                )
            )


def validate_containment_for_update(payload: FragmentUpdate) -> None:
    """Run bar-range containment check on a FragmentUpdate payload.

    Mirrors :func:`~services.fragment_validation.validate_containment` but
    accepts a :class:`~models.fragment.FragmentUpdate` instead of
    :class:`~models.fragment.FragmentCreate`, since the two share sub-part
    semantics but differ at the top-level type.
    """
    from errors import FragmentValidationError

    for idx, child in enumerate(payload.sub_parts):
        if child.bar_start < payload.bar_start or child.bar_end > payload.bar_end:
            raise FragmentValidationError(
                f"Sub-part {idx} bar range [{child.bar_start}, {child.bar_end}] "
                f"falls outside the parent fragment's range "
                f"[{payload.bar_start}, {payload.bar_end}]. "
                "Every sub-part must be contained within its parent.",
                detail={
                    "sub_part_index": idx,
                    "child_bar_start": child.bar_start,
                    "child_bar_end": child.bar_end,
                    "parent_bar_start": payload.bar_start,
                    "parent_bar_end": payload.bar_end,
                },
            )
