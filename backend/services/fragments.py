"""Fragment service: create, update, submit, and review fragment records.

Owns the transaction that atomically writes a parent fragment and all its
sub-parts. No route handler touches a database directly — all PostgreSQL
and Neo4j access goes through this service.

Cross-database referential integrity (concept_id existence in Neo4j) is
verified before the transaction opens. The data_licence is derived from
movement_analysis events in the fragment's bar range per ADR-009.

Review state machine (Step 8):
  draft → submitted → approved
                   ↘ rejected → draft  (creator revises via PATCH)

See docs/roadmap/component-5-tagging-tool.md §§ Step 6, Step 8.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from errors import (
    FragmentNotFoundError,
    FragmentValidationError,
    HarmonyNotReviewedError,
    SelfReviewForbiddenError,
)
from graph.queries.concepts import check_concepts_have_harmony_gate
from models.analysis import MovementAnalysis
from models.fragment import (
    Fragment,
    FragmentConceptTag,
    FragmentCreate,
    FragmentReview,
    FragmentUpdate,
    SubPartFragmentCreate,
)
from neo4j import AsyncDriver
from services.fragment_validation import (
    validate_concept_existence,
    validate_containment,
)
from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

# Phase 1 approval threshold: one non-creator approving review is sufficient.
_APPROVAL_THRESHOLD: int = 1

# Maps the fragment.repeat_context string to the movement_analysis event volta integer.
_REPEAT_CONTEXT_TO_VOLTA: dict[str, int] = {
    "first_ending": 1,
    "second_ending": 2,
    "third_ending": 3,
}


class FragmentService:
    """Business logic for the fragment write surface and review state machine.

    Args:
        db: Scoped async SQLAlchemy session (from ``get_db`` dependency).
        driver: Application-scoped async Neo4j driver (from ``get_neo4j``).
    """

    def __init__(self, db: AsyncSession, driver: AsyncDriver) -> None:
        self._db = db
        self._driver = driver

    # ------------------------------------------------------------------
    # Public interface — write path
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

        try:
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
        except IntegrityError as exc:
            raise FragmentValidationError(
                "Fragment references a missing related record (user or movement).",
                detail={"integrity_error": str(exc.orig)},
            ) from exc

        return parent

    async def update_draft(
        self,
        fragment_id: uuid.UUID,
        payload: FragmentUpdate,
        caller_id: str,
        caller_role: str,
    ) -> Fragment:
        """Replace all mutable fields of a draft or rejected fragment atomically.

        Accepts fragments in ``draft`` or ``rejected`` status.  A ``rejected``
        fragment transitions back to ``draft`` when saved, enabling the
        ``rejected → draft → submitted`` revision cycle.

        Only the creating annotator or an admin may update a fragment. The
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
            FragmentValidationError: Not a draft or rejected fragment, caller
                lacks permission, or concept id missing in graph.
        """
        validate_containment_for_update(payload)
        await self._check_all_concepts_for_update(payload)

        try:
            async with self._db.begin():
                fragment = await self._get_editable(fragment_id)
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
                # Transition rejected → draft when the creator saves edits.
                if fragment.status == "rejected":
                    fragment.status = "draft"
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
        except IntegrityError as exc:
            raise FragmentValidationError(
                "Fragment references a missing related record (user or movement).",
                detail={"integrity_error": str(exc.orig)},
            ) from exc

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
    # Public interface — review state machine
    # ------------------------------------------------------------------

    async def approve(
        self,
        fragment_id: uuid.UUID,
        reviewer_id: str,
        reviewer_role: str,
        comment: str | None = None,
    ) -> Fragment:
        """Record an approval and transition to ``approved`` if all gates pass.

        Two-phase approach so the review row is committed even when the
        approval gate fails (allowing the creator to fix the issues without
        the reviewer needing to re-vote):

        Phase 1 (transaction): assert fragment is ``submitted``, check
        self-review rule, upsert the review row.

        Phase 2 (after commit): count approvals, check approval gate.
        If threshold met and gate passes → second transaction to flip
        ``status`` to ``approved``.  If gate fails → 422 with specifics.

        Admins bypass both the self-review rule and the approval threshold
        (a single admin approval is unconditional).

        Args:
            fragment_id: UUID of the submitted fragment.
            reviewer_id: String UUID of the authenticated reviewer.
            reviewer_role: Role of the reviewer (``"editor"`` or ``"admin"``).
            comment: Optional comment to record alongside the review decision.

        Returns:
            The :class:`~models.fragment.Fragment` row after processing.
            ``status`` is ``"approved"`` only when the gate passed; otherwise
            ``"submitted"`` (review recorded, threshold not yet met or gate
            failed — caller should inspect the returned status).

        Raises:
            FragmentNotFoundError: Fragment does not exist.
            FragmentValidationError: Fragment is not in ``submitted`` status.
            SelfReviewForbiddenError: Non-admin reviewer is the fragment creator.
            HarmonyNotReviewedError: Threshold met but approval gate failed;
                ``detail`` carries ``unreviewed_actual_key`` and/or
                ``unreviewed_harmony_events`` describing the blocking items.
        """
        reviewer_uuid = uuid.UUID(reviewer_id)

        # Phase 1: validate and record the review.
        async with self._db.begin():
            fragment = await self._get_submitted(fragment_id)
            if reviewer_role != "admin":
                _check_not_creator(fragment, reviewer_id)
            await self._upsert_review(fragment_id, reviewer_uuid, "approved", comment)

        # Phase 2: threshold + gate check (reads only; no active transaction).
        if reviewer_role == "admin":
            meets_threshold = True
        else:
            approval_count = await self._count_approvals(
                fragment_id, fragment.created_by
            )
            meets_threshold = approval_count >= _APPROVAL_THRESHOLD

        if not meets_threshold:
            return fragment  # Review recorded; awaiting more approvers.

        gate_failures = await self._run_approval_gate(fragment)
        if gate_failures:
            raise HarmonyNotReviewedError(
                "Approval gate failed: some required reviews are incomplete. "
                "Check 'unreviewed_actual_key' and 'unreviewed_harmony_events' "
                "in the error detail for the specific blocking items.",
                detail=gate_failures,
            )

        # Phase 3: flip the fragment to approved.
        # The Phase 2 reads auto-started a transaction (autobegin=True); add
        # Phase 3 writes to that same transaction and commit explicitly.
        result = await self._db.execute(
            select(Fragment).where(Fragment.id == fragment_id)
        )
        fragment = result.scalar_one_or_none()
        if fragment is None:
            raise FragmentNotFoundError(
                f"No fragment with id '{fragment_id}' exists.",
                detail={"fragment_id": str(fragment_id)},
            )
        # Guard: concurrent approver may have already flipped the status.
        if fragment.status == "submitted":
            fragment.status = "approved"
            fragment.updated_at = datetime.now(tz=timezone.utc)
            self._db.add(fragment)
        await self._db.commit()

        return fragment

    async def reject(
        self,
        fragment_id: uuid.UUID,
        reviewer_id: str,
        reviewer_role: str,
        comment: str | None = None,
    ) -> Fragment:
        """Record a rejection and transition the fragment to ``rejected``.

        A single rejection immediately moves the fragment to ``rejected``
        regardless of any prior approval votes.  The creator may revise and
        resubmit via PATCH (which transitions ``rejected → draft``) followed by
        POST ``.../submit``.

        Admins bypass the self-review rule and may reject their own fragments.

        Args:
            fragment_id: UUID of the submitted fragment.
            reviewer_id: String UUID of the authenticated reviewer.
            reviewer_role: Role of the reviewer (``"editor"`` or ``"admin"``).
            comment: Optional comment to record alongside the review decision.

        Returns:
            The :class:`~models.fragment.Fragment` row with ``status = "rejected"``.

        Raises:
            FragmentNotFoundError: Fragment does not exist.
            FragmentValidationError: Fragment is not in ``submitted`` status.
            SelfReviewForbiddenError: Non-admin reviewer is the fragment creator.
        """
        reviewer_uuid = uuid.UUID(reviewer_id)

        async with self._db.begin():
            fragment = await self._get_submitted(fragment_id)
            if reviewer_role != "admin":
                _check_not_creator(fragment, reviewer_id)
            await self._upsert_review(fragment_id, reviewer_uuid, "rejected", comment)
            fragment.status = "rejected"
            fragment.updated_at = datetime.now(tz=timezone.utc)
            self._db.add(fragment)

        return fragment

    # ------------------------------------------------------------------
    # Internal helpers — status-gated loaders
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
                "cannot be submitted. Only drafts may be submitted.",
                detail={
                    "fragment_id": str(fragment_id),
                    "current_status": fragment.status,
                },
            )
        return fragment

    async def _get_editable(self, fragment_id: uuid.UUID) -> Fragment:
        """Load a fragment that is in ``draft`` or ``rejected`` status.

        Used by ``update_draft``.  A ``rejected`` fragment transitions back to
        ``draft`` when saved, enabling the ``rejected → draft → submitted``
        revision cycle.

        Raises:
            FragmentNotFoundError: No fragment with this id exists.
            FragmentValidationError: Fragment exists but is not draft/rejected.
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
        if fragment.status not in ("draft", "rejected"):
            raise FragmentValidationError(
                f"Fragment '{fragment_id}' has status '{fragment.status}' and "
                "cannot be modified. Only drafts and rejected fragments may be updated.",
                detail={
                    "fragment_id": str(fragment_id),
                    "current_status": fragment.status,
                },
            )
        return fragment

    async def _get_submitted(self, fragment_id: uuid.UUID) -> Fragment:
        """Load a fragment and assert it is in ``submitted`` status.

        Raises:
            FragmentNotFoundError: No fragment with this id exists.
            FragmentValidationError: Fragment exists but is not submitted.
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
        if fragment.status != "submitted":
            raise FragmentValidationError(
                f"Fragment '{fragment_id}' has status '{fragment.status}'. "
                "Only submitted fragments may be approved or rejected.",
                detail={
                    "fragment_id": str(fragment_id),
                    "current_status": fragment.status,
                },
            )
        return fragment

    # ------------------------------------------------------------------
    # Internal helpers — review
    # ------------------------------------------------------------------

    async def _upsert_review(
        self,
        fragment_id: uuid.UUID,
        reviewer_id: uuid.UUID,
        decision: str,
        comment: str | None,
    ) -> None:
        """Insert a new review row or update the reviewer's existing row.

        ``UNIQUE (fragment_id, reviewer_id)`` prevents multiple rows per
        reviewer per fragment; a reviewer who changes their mind replaces
        their earlier decision.

        Must be called inside an open transaction.
        """
        result = await self._db.execute(
            select(FragmentReview).where(
                FragmentReview.fragment_id == fragment_id,
                FragmentReview.reviewer_id == reviewer_id,
            )
        )
        existing = result.scalar_one_or_none()
        now = datetime.now(tz=timezone.utc)
        if existing is not None:
            existing.decision = decision
            existing.comment = comment
            existing.reviewed_at = now
            self._db.add(existing)
        else:
            self._db.add(
                FragmentReview(
                    fragment_id=fragment_id,
                    reviewer_id=reviewer_id,
                    decision=decision,
                    comment=comment,
                    reviewed_at=now,
                )
            )

    async def _count_approvals(
        self,
        fragment_id: uuid.UUID,
        created_by: uuid.UUID | None,
    ) -> int:
        """Count approving reviews for a fragment, excluding the creator.

        Args:
            fragment_id: The fragment whose reviews to count.
            created_by: The UUID of the fragment's creator.  Reviews by this
                user are excluded from the count per the approval-gate spec.
                ``None`` means no creator is recorded; no rows are excluded.

        Returns:
            Count of ``approved`` ``fragment_review`` rows from non-creators.
        """
        stmt = select(func.count()).where(
            FragmentReview.fragment_id == fragment_id,
            FragmentReview.decision == "approved",
        )
        if created_by is not None:
            stmt = stmt.where(FragmentReview.reviewer_id != created_by)
        result = await self._db.execute(stmt)
        return result.scalar_one()

    async def _run_approval_gate(self, fragment: Fragment) -> dict:
        """Check all approval gate conditions and return a dict of failures.

        Two gate checks per fragment-schema.md § "Fragment approval and
        harmony review":

        1. ``actual_key``: if ``auto: true`` and ``reviewed: false``, block.
        2. Harmony events: if any of the fragment's concepts declare a
           ``harmony_gate`` capture extension, every ``movement_analysis``
           event in the fragment's bar range must have ``reviewed: true``.
           Events are filtered by ``volta`` when the fragment has a
           ``repeat_context``.

        Args:
            fragment: The fragment to gate-check (must be ``submitted``).

        Returns:
            Empty dict if all gates pass.  Non-empty dict with keys
            ``"unreviewed_actual_key"`` and/or ``"unreviewed_harmony_events"``
            when the gate fails.
        """
        failures: dict = {}

        # Gate 1: actual_key review.
        actual_key = fragment.summary.get("actual_key")
        if actual_key and actual_key.get("auto") and not actual_key.get("reviewed"):
            failures["unreviewed_actual_key"] = actual_key

        # Gate 2: harmony events (only when concepts declare harmony_gate).
        result = await self._db.execute(
            select(FragmentConceptTag.concept_id).where(
                FragmentConceptTag.fragment_id == fragment.id
            )
        )
        concept_ids = list(result.scalars().all())

        async with self._driver.session() as neo_session:
            has_gate = await check_concepts_have_harmony_gate(neo_session, concept_ids)

        if has_gate:
            result = await self._db.execute(
                select(MovementAnalysis.events).where(
                    MovementAnalysis.movement_id == fragment.movement_id
                )
            )
            events = result.scalar_one_or_none()
            if events:
                volta_filter = _REPEAT_CONTEXT_TO_VOLTA.get(
                    fragment.repeat_context or "", None
                )
                unreviewed = []
                for ev in events:
                    mn = ev.get("mn")
                    if mn is None:
                        continue
                    if not (fragment.bar_start <= int(mn) <= fragment.bar_end):
                        continue
                    if volta_filter is not None and ev.get("volta") != volta_filter:
                        continue
                    if not ev.get("reviewed"):
                        unreviewed.append(ev)
                if unreviewed:
                    failures["unreviewed_harmony_events"] = unreviewed

        return failures

    # ------------------------------------------------------------------
    # Internal helpers — permission check
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Internal helpers — concept validation
    # ------------------------------------------------------------------

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

    # ------------------------------------------------------------------
    # Internal helpers — data derivation and ORM construction
    # ------------------------------------------------------------------

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


# ---------------------------------------------------------------------------
# Module-level helpers
# ---------------------------------------------------------------------------


def _check_not_creator(fragment: Fragment, reviewer_id: str) -> None:
    """Assert the reviewer is not the fragment's creator.

    Called before recording a review row.  Admins bypass this check.

    Args:
        fragment: The fragment being reviewed.
        reviewer_id: String UUID of the authenticated reviewer.

    Raises:
        SelfReviewForbiddenError: Reviewer is the creator.
    """
    is_creator = (
        fragment.created_by is not None and str(fragment.created_by) == reviewer_id
    )
    if is_creator:
        raise SelfReviewForbiddenError(
            "A fragment's creator may not review their own work. "
            "Ask a different annotator to review this fragment.",
            detail={
                "fragment_id": str(fragment.id),
                "reviewer_id": reviewer_id,
            },
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
