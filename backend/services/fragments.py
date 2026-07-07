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

import asyncio
import base64
import hashlib
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

from errors import (
    FragmentNotFoundError,
    FragmentValidationError,
    HarmonyNotReviewedError,
    SelfReviewForbiddenError,
)
from graph.queries.concepts import (
    check_concepts_have_harmony_gate,
    get_concepts_by_ids,
    get_subtype_ids_async,
)
from models.analysis import MovementAnalysis
from models.fragment import (
    ConceptBrowseItem,
    ConceptBrowseResponse,
    ConceptTagDetail,
    Fragment,
    FragmentConceptTag,
    FragmentCreate,
    FragmentDetailResponse,
    FragmentListItem,
    FragmentListResponse,
    FragmentReview,
    FragmentSummary,
    FragmentUpdate,
    ReviewQueueItem,
    ReviewQueueResponse,
    SubPartFragmentCreate,
)
from models.music import Composer, Corpus, Movement, Work
from neo4j import AsyncDriver
from redis.asyncio import Redis
from services.cache import get_subtree_cache, set_subtree_cache
from services.fragment_validation import (
    validate_concept_existence,
    validate_containment,
)
from services.object_storage import StorageClient
from services.task_dispatch import dispatch_task
from services.tasks.render_fragment_preview import render_fragment_preview
from sqlalchemy import and_, delete, func, or_, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

# ADR-006 §4: a fragment's English prose annotation is mirrored into
# fragment_annotation_translation as the canonical ('en', authoritative) record,
# so the overlay/staleness machinery is uniform across languages. Upsert keyed
# on (fragment_id, language); a null annotation deletes the row.
_UPSERT_ANNOTATION_TRANSLATION = text(
    """
    INSERT INTO fragment_annotation_translation
        (fragment_id, language, prose_annotation, status, source_hash, translated_at)
    VALUES (:fragment_id, 'en', :prose, 'authoritative', :source_hash, now())
    ON CONFLICT (fragment_id, language) DO UPDATE SET
        prose_annotation = EXCLUDED.prose_annotation,
        status           = EXCLUDED.status,
        source_hash      = EXCLUDED.source_hash,
        translated_at    = EXCLUDED.translated_at
    """
)
_DELETE_ANNOTATION_TRANSLATION = text(
    "DELETE FROM fragment_annotation_translation "
    "WHERE fragment_id = :fragment_id AND language = 'en'"
)


@dataclass
class FragmentUpdateResult:
    """Result of :meth:`FragmentService.update` carrying revision metadata.

    The route handler uses ``previous_status`` and ``status_changed`` to
    populate :class:`~models.fragment.FragmentUpdateResponse` so the UI can
    surface 'this edit re-opened review' without comparing states itself.
    """

    fragment: Fragment
    previous_status: str

    @property
    def status_changed(self) -> bool:
        """True when the edit triggered a status transition."""
        return self.fragment.status != self.previous_status


@dataclass
class FragmentDeleteResult:
    """Result of :meth:`FragmentService.delete`.

    ``child_count`` is the number of sub-part children removed by the cascade
    (or that *would* be removed when ``dry_run=True``).
    """

    fragment_id: uuid.UUID
    child_count: int
    dry_run: bool


# Phase 1 approval threshold: one non-creator approving review is sufficient.
_APPROVAL_THRESHOLD: int = 1

# Maps the fragment.repeat_context string to the movement_analysis event volta integer.
_REPEAT_CONTEXT_TO_VOLTA: dict[str, int] = {
    "first_ending": 1,
    "second_ending": 2,
    "third_ending": 3,
}

# Maps the data_licence short string to its canonical URL (ADR-009).
_LICENCE_URL_MAP: dict[str, str] = {
    "CC BY-SA 4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
}


def _sources_in_range(
    events: list[dict],
    bar_start: int,
    bar_end: int,
    repeat_context: str | None,
) -> list[str]:
    """Return sorted distinct source values for events in a fragment's bar range.

    Mirrors the filtering logic of :meth:`FragmentService._slice_harmony_events`
    but collects ``source`` values rather than full event dicts.  Used to
    populate ``harmony_sources`` on list and detail read responses (ADR-009).

    Args:
        events: The full ``movement_analysis.events`` array for a movement.
        bar_start: Inclusive lower bound (notated bar number).
        bar_end: Inclusive upper bound (notated bar number).
        repeat_context: Fragment repeat context string, or ``None``.

    Returns:
        Sorted list of distinct ``source`` strings found in the range.
        Empty list when no events fall in range or no events carry a source.
    """
    volta_filter = _REPEAT_CONTEXT_TO_VOLTA.get(repeat_context or "", None)
    sources: set[str] = set()
    for ev in events:
        mn = ev.get("mn")
        if mn is None:
            continue
        if not (bar_start <= int(mn) <= bar_end):
            continue
        if volta_filter is not None and ev.get("volta") != volta_filter:
            continue
        src = ev.get("source")
        if src:
            sources.add(src)
    return sorted(sources)


def _encode_cursor(mc_start: int, fragment_id: uuid.UUID) -> str:
    """Encode an (mc_start, id) pair as a URL-safe base64 pagination cursor."""
    return base64.urlsafe_b64encode(f"{mc_start}:{fragment_id}".encode()).decode()


def _decode_cursor(cursor: str) -> tuple[int, uuid.UUID]:
    """Decode a pagination cursor back to (mc_start, fragment_id).

    Raises:
        ValueError: Cursor string is malformed or cannot be decoded.
    """
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        mc_str, id_str = raw.split(":", 1)
        return int(mc_str), uuid.UUID(id_str)
    except Exception as exc:
        raise ValueError(f"Invalid pagination cursor: {cursor!r}") from exc


def _encode_time_cursor(updated_at: datetime, fragment_id: uuid.UUID) -> str:
    """Encode a (updated_at ISO, id) pair as a cursor for time-ordered pagination."""
    return base64.urlsafe_b64encode(
        f"{updated_at.isoformat()}|{fragment_id}".encode()
    ).decode()


def _decode_time_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    """Decode a time-ordered pagination cursor back to (updated_at, fragment_id).

    Raises:
        ValueError: Cursor string is malformed or cannot be decoded.
    """
    try:
        raw = base64.urlsafe_b64decode(cursor.encode()).decode()
        ts_str, id_str = raw.split("|", 1)
        return datetime.fromisoformat(ts_str), uuid.UUID(id_str)
    except Exception as exc:
        raise ValueError(f"Invalid pagination cursor: {cursor!r}") from exc


async def enqueue_preview_regeneration_for_movement(
    db: AsyncSession, movement_id: uuid.UUID
) -> int:
    """Re-dispatch preview rendering for every active fragment on a movement.

    ADR-008's MEI-correction trigger: re-ingesting a movement replaces its
    normalized MEI, which invalidates the cached SVG previews of every
    fragment on it. This is the entry point the ingest path calls after an
    upsert commits (a movement ingested for the first time has no fragments,
    so the call is a harmless no-op there).

    Only ``submitted`` and ``approved`` fragments are dispatched — the same
    statuses the preview task itself accepts; ``draft``/``rejected`` fragments
    render no preview by design.

    Module-level (not a service method) so the ingest service can call it with
    just its session, without constructing a FragmentService (which requires a
    Neo4j driver the ingest path has no other use for).
    :meth:`FragmentService.enqueue_preview_regeneration_for_movement` wraps it.

    Args:
        db: Async database session.
        movement_id: UUID of the re-ingested movement.

    Returns:
        Number of fragments whose preview regeneration was dispatched.
    """
    result = await db.execute(
        select(Fragment.id)
        .where(
            Fragment.movement_id == movement_id,
            Fragment.status.in_(("submitted", "approved")),
        )
        .order_by(Fragment.mc_start)
    )
    fragment_ids = list(result.scalars().all())
    for fragment_id in fragment_ids:
        dispatch_task(render_fragment_preview, fragment_id=str(fragment_id))
    if fragment_ids:
        logger.info(
            "enqueue_preview_regeneration_for_movement: dispatched %d preview "
            "task(s) for movement %s",
            len(fragment_ids),
            movement_id,
        )
    return len(fragment_ids)


class FragmentService:
    """Business logic for the fragment write surface and review state machine.

    Args:
        db: Scoped async SQLAlchemy session (from ``get_db`` dependency).
        driver: Application-scoped async Neo4j driver (from ``get_neo4j``).
    """

    def __init__(
        self,
        db: AsyncSession,
        driver: AsyncDriver,
        redis: Redis | None = None,
        storage: StorageClient | None = None,
    ) -> None:
        self._db = db
        self._driver = driver
        self._redis = redis
        self._storage = storage

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

                await self._sync_annotation_translations(parent.id)
        except IntegrityError as exc:
            logger.error("Fragment write IntegrityError: %s", exc.orig)
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

                await self._sync_annotation_translations(fragment_id)
        except IntegrityError as exc:
            logger.error("Fragment write IntegrityError: %s", exc.orig)
            raise FragmentValidationError(
                "Fragment references a missing related record (user or movement).",
                detail={"integrity_error": str(exc.orig)},
            ) from exc

        return fragment

    async def update(
        self,
        fragment_id: uuid.UUID,
        payload: FragmentUpdate,
        caller_id: str,
        caller_role: str,
    ) -> FragmentUpdateResult:
        """Update a fragment at any status with revision semantics.

        The revision behaviour is decided per-status and per-field type:

        * **draft**: update all fields, keep ``draft`` status.
        * **rejected**: update all fields, transition ``rejected → draft``.
        * **submitted** (analytic edit): replace fields, keep ``submitted``,
          clear all ``fragment_review`` rows (the thing reviewed has changed).
        * **approved** (analytic edit): replace fields, transition
          ``approved → submitted``, clear ``fragment_review`` rows.
        * **submitted / approved** (prose-only edit): update only
          ``prose_annotation`` in place; status and reviews are untouched.

        An edit is *prose-only* when the payload's analytic fields (coordinates,
        summary, concept tags, sub-part coordinates and tags) are identical to
        the stored state and only ``prose_annotation`` differs.

        The atomic parent+child write is reused for analytic edits so that a
        stage change rewrites child fragments transactionally.

        Args:
            fragment_id: UUID of the fragment to update.
            payload: Validated :class:`~models.fragment.FragmentUpdate` payload.
            caller_id: String UUID of the authenticated caller.
            caller_role: Role of the authenticated caller (``"editor"`` or
                ``"admin"``).

        Returns:
            :class:`FragmentUpdateResult` with the updated fragment and the
            status it held before the edit.

        Raises:
            FragmentNotFoundError: Fragment does not exist.
            FragmentValidationError: Caller lacks permission, concept id
                missing from the graph, or sub-part out of range.
        """
        validate_containment_for_update(payload)
        await self._check_all_concepts_for_update(payload)

        _should_regenerate_preview = False
        try:
            async with self._db.begin():
                # Load the fragment at any status; revision logic handles transitions.
                result = await self._db.execute(
                    select(Fragment).where(Fragment.id == fragment_id)
                )
                fragment = result.scalar_one_or_none()
                if fragment is None:
                    raise FragmentNotFoundError(
                        f"No fragment with id '{fragment_id}' exists.",
                        detail={"fragment_id": str(fragment_id)},
                    )

                self._check_edit_permission(fragment, caller_id, caller_role)
                previous_status = fragment.status

                # Load existing concept tags for analytic comparison.
                tags_result = await self._db.execute(
                    select(FragmentConceptTag).where(
                        FragmentConceptTag.fragment_id == fragment_id
                    )
                )
                existing_tags = list(tags_result.scalars().all())

                # Load existing sub-parts and their concept tags.
                subs_result = await self._db.execute(
                    select(Fragment)
                    .where(Fragment.parent_fragment_id == fragment_id)
                    .order_by(Fragment.mc_start.asc(), Fragment.id.asc())
                )
                existing_subs = list(subs_result.scalars().all())

                existing_sub_tags: dict[uuid.UUID, list[FragmentConceptTag]] = {}
                if existing_subs:
                    sub_ids = [sp.id for sp in existing_subs]
                    sub_tags_result = await self._db.execute(
                        select(FragmentConceptTag).where(
                            FragmentConceptTag.fragment_id.in_(sub_ids)
                        )
                    )
                    for tag in sub_tags_result.scalars().all():
                        existing_sub_tags.setdefault(tag.fragment_id, []).append(tag)

                analytic_changed = self._analytic_fields_changed(
                    fragment, existing_tags, existing_subs, existing_sub_tags, payload
                )

                if not analytic_changed:
                    # Prose-only edit: update annotation in place; reviews unchanged.
                    fragment.prose_annotation = payload.prose_annotation
                    fragment.updated_at = datetime.now(tz=timezone.utc)
                    self._db.add(fragment)
                else:
                    # Analytic edit: full field replacement with revision semantics.
                    # Check for measure-range change before overwriting coordinates
                    # (ADR-008: a range edit on submitted/approved invalidates the preview).
                    if previous_status in ("submitted", "approved") and (
                        fragment.mc_start != payload.mc_start
                        or fragment.mc_end != payload.mc_end
                    ):
                        _should_regenerate_preview = True

                    data_licence = await self._derive_data_licence(
                        fragment.movement_id, payload.bar_start, payload.bar_end
                    )

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

                    # Status transition and review-row clearing.
                    if fragment.status == "rejected":
                        fragment.status = "draft"
                    elif fragment.status in ("submitted", "approved"):
                        if fragment.status == "approved":
                            fragment.status = "submitted"
                        # Clear prior reviews — the content they approved has changed.
                        await self._db.execute(
                            delete(FragmentReview).where(
                                FragmentReview.fragment_id == fragment_id
                            )
                        )
                    # draft status is unchanged.

                    self._db.add(fragment)

                    # Replace concept tags.
                    await self._db.execute(
                        delete(FragmentConceptTag).where(
                            FragmentConceptTag.fragment_id == fragment_id
                        )
                    )
                    self._add_concept_tags(fragment_id, payload.concept_tags)

                    # Replace sub-parts (cascade deletes their tags via FK).
                    await self._db.execute(
                        delete(Fragment).where(
                            Fragment.parent_fragment_id == fragment_id
                        )
                    )
                    for sp in payload.sub_parts:
                        child = self._make_subpart_orm(
                            sp, fragment_id, fragment.movement_id, data_licence
                        )
                        self._db.add(child)
                        await self._db.flush()
                        self._add_concept_tags(child.id, sp.concept_tags)

                # Sync the English annotation overlay for whichever branch ran
                # (prose-only or analytic), covering parent and sub-parts.
                await self._sync_annotation_translations(fragment_id)

        except IntegrityError as exc:
            logger.error("Fragment write IntegrityError: %s", exc.orig)
            raise FragmentValidationError(
                "Fragment references a missing related record (user or movement).",
                detail={"integrity_error": str(exc.orig)},
            ) from exc

        # Dispatch after commit so the task reads the updated mc_start/mc_end
        # (ADR-008: bar-range edit on submitted/approved re-triggers preview generation).
        if _should_regenerate_preview:
            dispatch_task(render_fragment_preview, fragment_id=str(fragment_id))

        return FragmentUpdateResult(fragment=fragment, previous_status=previous_status)

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

            # Ensure the canonical English annotation record exists at submit
            # time (ADR-006 §4: English records seeded when annotations are
            # submitted), covering parent and sub-parts.
            await self._sync_annotation_translations(fragment_id)

        # Dispatch after the transaction commits so the task reads committed state
        # (ADR-008: preview is generated at the draft → submitted transition).
        dispatch_task(render_fragment_preview, fragment_id=str(fragment_id))
        return fragment

    async def enqueue_preview_regeneration_for_movement(
        self, movement_id: uuid.UUID
    ) -> int:
        """Re-dispatch preview rendering for the movement's active fragments.

        Service-level entry point named by ADR-008; delegates to the
        module-level :func:`enqueue_preview_regeneration_for_movement`, which
        the ingest path calls directly with its session.

        Args:
            movement_id: UUID of the re-ingested/corrected movement.

        Returns:
            Number of fragments whose preview regeneration was dispatched.
        """
        return await enqueue_preview_regeneration_for_movement(self._db, movement_id)

    # ------------------------------------------------------------------
    # Public interface — read path (Component 7 Step 7)
    # ------------------------------------------------------------------

    async def get(
        self,
        fragment_id: uuid.UUID,
        caller_id: str,
        caller_role: str,
    ) -> FragmentDetailResponse:
        """Return the full fragment record with hydrated concept tags, harmony
        events, and nested sub-parts.

        Visibility rule: draft fragments are visible only to their creator or
        an admin. All other statuses are visible to any editor.  A draft owned
        by another annotator is returned as a 404 to avoid leaking its
        existence.

        Args:
            fragment_id: UUID of the fragment to read.
            caller_id: String UUID of the authenticated caller.
            caller_role: Role of the authenticated caller.

        Returns:
            :class:`~models.fragment.FragmentDetailResponse` with concept tags
            hydrated from Neo4j, harmony events sliced from
            ``movement_analysis``, sub-parts nested one level deep, movement
            context (composer / work / movement label), a signed ``mei_url``
            for Verovio and MIDI rendering, and a ``preview_url`` (null until
            the preview task completes).

        Raises:
            FragmentNotFoundError: Fragment does not exist or is a draft not
                owned by the caller (non-admin).
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

        # Draft visibility: only the creator or an admin may read a draft.
        if fragment.status == "draft" and caller_role != "admin":
            is_creator = (
                fragment.created_by is not None
                and str(fragment.created_by) == caller_id
            )
            if not is_creator:
                raise FragmentNotFoundError(
                    f"No fragment with id '{fragment_id}' exists.",
                    detail={"fragment_id": str(fragment_id)},
                )

        # Load concept tags for the parent.
        tags_result = await self._db.execute(
            select(FragmentConceptTag).where(
                FragmentConceptTag.fragment_id == fragment_id
            )
        )
        parent_tags = list(tags_result.scalars().all())

        # Load sub-parts (top-level only — ADR-011 two-level limit).
        sub_result = await self._db.execute(
            select(Fragment)
            .where(Fragment.parent_fragment_id == fragment_id)
            .order_by(Fragment.mc_start.asc(), Fragment.id.asc())
        )
        sub_parts = list(sub_result.scalars().all())

        # Load concept tags for all sub-parts in one query.
        sub_tags_by_fragment: dict[uuid.UUID, list[FragmentConceptTag]] = {}
        if sub_parts:
            sub_ids = [sp.id for sp in sub_parts]
            sub_tags_result = await self._db.execute(
                select(FragmentConceptTag).where(
                    FragmentConceptTag.fragment_id.in_(sub_ids)
                )
            )
            for tag in sub_tags_result.scalars().all():
                sub_tags_by_fragment.setdefault(tag.fragment_id, []).append(tag)

        # Batch Neo4j hydration — collect all unique concept IDs at once.
        all_concept_ids = list(
            {t.concept_id for t in parent_tags}
            | {t.concept_id for tags in sub_tags_by_fragment.values() for t in tags}
        )
        concept_map: dict[str, dict] = {}
        if all_concept_ids:
            async with self._driver.session() as neo_session:
                for c in await get_concepts_by_ids(neo_session, all_concept_ids):
                    concept_map[c["id"]] = c

        def _hydrate_tag(tag: FragmentConceptTag) -> ConceptTagDetail:
            data = concept_map.get(tag.concept_id, {})
            aliases: list[str] = data.get("aliases", [])
            return ConceptTagDetail(
                concept_id=tag.concept_id,
                is_primary=tag.is_primary,
                name=data.get("name", tag.concept_id),
                alias=aliases[0] if aliases else None,
                hierarchy_path=data.get("hierarchy_path", []),
            )

        # Slice harmony events from movement_analysis.
        harmony_events = await self._slice_harmony_events(
            fragment.movement_id,
            fragment.bar_start,
            fragment.bar_end,
            fragment.repeat_context,
        )

        # Derive licence fields from harmony events and the stored licence string.
        harmony_sources = sorted(
            {ev.get("source") for ev in harmony_events if ev.get("source")}
        )
        data_licence_url = (
            _LICENCE_URL_MAP.get(fragment.data_licence)
            if fragment.data_licence
            else None
        )

        # Resolve movement context (label) and signed URLs for MEI and preview.
        # Movement context is needed by the isolated detail view to show composer/
        # work/movement labels and to fetch the MEI for Verovio + MIDI rendering.
        ctx_result = await self._db.execute(
            select(
                Movement.movement_number,
                Movement.title.label("movement_title"),
                Movement.mei_object_key,
                Movement.updated_at.label("movement_updated_at"),
                Work.title.label("work_title"),
                Work.catalogue_number.label("work_catalogue_number"),
                Composer.name.label("composer_name"),
            )
            .join(Work, Movement.work_id == Work.id)
            .join(Corpus, Work.corpus_id == Corpus.id)
            .join(Composer, Corpus.composer_id == Composer.id)
            .where(Movement.id == fragment.movement_id)
        )
        ctx = dict(ctx_result.mappings().one_or_none() or {})

        mei_url: str | None = None
        if self._storage is not None and ctx.get("mei_object_key"):
            mei_url = await self._storage.signed_url(
                ctx["mei_object_key"], version=ctx.get("movement_updated_at")
            )

        preview_url: str | None = None
        if self._storage is not None and fragment.preview_object_key:
            preview_url = await self._storage.signed_url(
                fragment.preview_object_key, version=fragment.preview_generated_at
            )

        # Assemble sub-part responses (no harmony events on sub-parts;
        # two-level limit means sub-parts have no further sub_parts).
        sub_part_responses = [
            FragmentDetailResponse(
                id=sp.id,
                movement_id=sp.movement_id,
                parent_fragment_id=sp.parent_fragment_id,
                bar_start=sp.bar_start,
                bar_end=sp.bar_end,
                mc_start=sp.mc_start,
                mc_end=sp.mc_end,
                beat_start=sp.beat_start,
                beat_end=sp.beat_end,
                repeat_context=sp.repeat_context,
                summary=sp.summary,
                prose_annotation=sp.prose_annotation,
                data_licence=sp.data_licence,
                data_licence_url=(
                    _LICENCE_URL_MAP.get(sp.data_licence) if sp.data_licence else None
                ),
                harmony_sources=[],
                status=sp.status,
                created_by=sp.created_by,
                created_at=sp.created_at,
                updated_at=sp.updated_at,
                concept_tags=[
                    _hydrate_tag(t) for t in sub_tags_by_fragment.get(sp.id, [])
                ],
                harmony_events=[],
                sub_parts=[],
            )
            for sp in sub_parts
        ]

        return FragmentDetailResponse(
            id=fragment.id,
            movement_id=fragment.movement_id,
            parent_fragment_id=fragment.parent_fragment_id,
            bar_start=fragment.bar_start,
            bar_end=fragment.bar_end,
            mc_start=fragment.mc_start,
            mc_end=fragment.mc_end,
            beat_start=fragment.beat_start,
            beat_end=fragment.beat_end,
            repeat_context=fragment.repeat_context,
            summary=fragment.summary,
            prose_annotation=fragment.prose_annotation,
            data_licence=fragment.data_licence,
            data_licence_url=data_licence_url,
            harmony_sources=harmony_sources,
            status=fragment.status,
            created_by=fragment.created_by,
            created_at=fragment.created_at,
            updated_at=fragment.updated_at,
            concept_tags=[_hydrate_tag(t) for t in parent_tags],
            harmony_events=harmony_events,
            sub_parts=sub_part_responses,
            composer_name=ctx.get("composer_name"),
            work_title=ctx.get("work_title"),
            work_catalogue_number=ctx.get("work_catalogue_number"),
            movement_number=ctx.get("movement_number"),
            movement_title=ctx.get("movement_title"),
            mei_url=mei_url,
            preview_url=preview_url,
        )

    async def list_for_movement(
        self,
        movement_id: uuid.UUID,
        caller_id: str,
        caller_role: str,
        cursor: str | None = None,
        page_size: int = 100,
    ) -> FragmentListResponse:
        """Return a cursor-paginated list of top-level fragments for a movement.

        Visibility rule (enforced at the service layer):
        - Editors see their own drafts plus all submitted/approved/rejected.
        - Admins see all fragments regardless of status.

        Sub-parts are nested one level deep inside each top-level item (ADR-011
        two-level display limit).  Sub-parts are not separately paginated;
        all sub-parts of each page's top-level fragments are returned.

        The cursor encodes ``(mc_start, id)``; results are ordered by
        ``(mc_start ASC, id ASC)`` for stable, position-ordered pagination.

        Args:
            movement_id: UUID of the movement to query.
            caller_id: String UUID of the authenticated caller.
            caller_role: Role of the authenticated caller.
            cursor: Opaque pagination cursor from a prior response.
            page_size: Maximum top-level fragments per page (1–500).

        Returns:
            :class:`~models.fragment.FragmentListResponse` with items and an
            optional ``next_cursor`` for the following page.

        Raises:
            ValueError: Cursor string is malformed.
        """
        stmt = (
            select(Fragment)
            .where(
                Fragment.movement_id == movement_id,
                Fragment.parent_fragment_id.is_(None),
            )
            .order_by(Fragment.mc_start.asc(), Fragment.id.asc())
        )

        # Status visibility — enforced at the service layer, not in the route.
        if caller_role != "admin":
            caller_uuid = uuid.UUID(caller_id)
            stmt = stmt.where(
                or_(
                    Fragment.status.in_(["submitted", "approved", "rejected"]),
                    and_(
                        Fragment.status == "draft",
                        Fragment.created_by == caller_uuid,
                    ),
                )
            )

        # Cursor: filter to rows after (mc_start, id).
        if cursor is not None:
            cursor_mc, cursor_id = _decode_cursor(cursor)
            stmt = stmt.where(
                or_(
                    Fragment.mc_start > cursor_mc,
                    and_(
                        Fragment.mc_start == cursor_mc,
                        Fragment.id > cursor_id,
                    ),
                )
            )

        # Fetch one extra to detect whether a next page exists.
        result = await self._db.execute(stmt.limit(page_size + 1))
        rows = list(result.scalars().all())

        has_next = len(rows) > page_size
        page = rows[:page_size]

        if not page:
            return FragmentListResponse(items=[], next_cursor=None)

        page_ids = [f.id for f in page]

        # Load concept tags for all top-level fragments in one query.
        tags_result = await self._db.execute(
            select(FragmentConceptTag).where(
                FragmentConceptTag.fragment_id.in_(page_ids)
            )
        )
        tags_by_frag: dict[uuid.UUID, list[FragmentConceptTag]] = {}
        for tag in tags_result.scalars().all():
            tags_by_frag.setdefault(tag.fragment_id, []).append(tag)

        # Load all sub-parts for this page in one query.
        sub_result = await self._db.execute(
            select(Fragment)
            .where(Fragment.parent_fragment_id.in_(page_ids))
            .order_by(Fragment.mc_start.asc(), Fragment.id.asc())
        )
        sub_by_parent: dict[uuid.UUID, list[Fragment]] = {}
        for sp in sub_result.scalars().all():
            sub_by_parent.setdefault(sp.parent_fragment_id, []).append(sp)

        # Load concept tags for all sub-parts in one query.
        all_sub_ids = [sp.id for sps in sub_by_parent.values() for sp in sps]
        sub_tags_by_frag: dict[uuid.UUID, list[FragmentConceptTag]] = {}
        if all_sub_ids:
            sub_tags_result = await self._db.execute(
                select(FragmentConceptTag).where(
                    FragmentConceptTag.fragment_id.in_(all_sub_ids)
                )
            )
            for tag in sub_tags_result.scalars().all():
                sub_tags_by_frag.setdefault(tag.fragment_id, []).append(tag)

        # Batch Neo4j hydration for all concept IDs on this page.
        all_concept_ids = list(
            {t.concept_id for tags in tags_by_frag.values() for t in tags}
            | {t.concept_id for tags in sub_tags_by_frag.values() for t in tags}
        )
        alias_map: dict[str, str | None] = {}
        name_map: dict[str, str | None] = {}
        if all_concept_ids:
            async with self._driver.session() as neo_session:
                for c in await get_concepts_by_ids(neo_session, all_concept_ids):
                    aliases: list[str] = c.get("aliases", [])
                    alias_map[c["id"]] = aliases[0] if aliases else None
                    name_map[c["id"]] = c.get("name", c["id"])

        def _primary(
            frag_id: uuid.UUID, tmap: dict
        ) -> tuple[str | None, str | None, str | None]:
            for tag in tmap.get(frag_id, []):
                if tag.is_primary:
                    return (
                        tag.concept_id,
                        alias_map.get(tag.concept_id),
                        name_map.get(tag.concept_id),
                    )
            return None, None, None

        def _list_item(f: Fragment, tmap: dict, sp_tmap: dict) -> FragmentListItem:
            p_id, p_alias, p_name = _primary(f.id, tmap)
            return FragmentListItem(
                id=f.id,
                movement_id=f.movement_id,
                parent_fragment_id=f.parent_fragment_id,
                mc_start=f.mc_start,
                mc_end=f.mc_end,
                bar_start=f.bar_start,
                bar_end=f.bar_end,
                beat_start=f.beat_start,
                beat_end=f.beat_end,
                repeat_context=f.repeat_context,
                status=f.status,
                primary_concept_id=p_id,
                primary_concept_alias=p_alias,
                primary_concept_name=p_name,
                sub_parts=[
                    FragmentListItem(
                        id=sp.id,
                        movement_id=sp.movement_id,
                        parent_fragment_id=sp.parent_fragment_id,
                        mc_start=sp.mc_start,
                        mc_end=sp.mc_end,
                        bar_start=sp.bar_start,
                        bar_end=sp.bar_end,
                        beat_start=sp.beat_start,
                        beat_end=sp.beat_end,
                        repeat_context=sp.repeat_context,
                        status=sp.status,
                        primary_concept_id=_primary(sp.id, sp_tmap)[0],
                        primary_concept_alias=_primary(sp.id, sp_tmap)[1],
                        primary_concept_name=_primary(sp.id, sp_tmap)[2],
                        sub_parts=[],
                    )
                    for sp in sub_by_parent.get(f.id, [])
                ],
            )

        items = [_list_item(f, tags_by_frag, sub_tags_by_frag) for f in page]

        next_cursor = (
            _encode_cursor(page[-1].mc_start, page[-1].id) if has_next else None
        )
        return FragmentListResponse(items=items, next_cursor=next_cursor)

    async def list_for_review(
        self,
        caller_id: str,
        caller_role: str,
        cursor: str | None = None,
        page_size: int = 50,
    ) -> ReviewQueueResponse:
        """Return a cursor-paginated list of submitted fragments awaiting review.

        Visibility rules (enforced at the service layer):
        - Status filter: only ``submitted`` top-level fragments are returned.
        - Creator exclusion: editors do not see their own submissions (a
          creator cannot approve their own work — the approval gate enforces
          this, and the queue should not surface what the viewer cannot action).
        - Admins see all ``submitted`` fragments regardless of creator.

        Results are ordered ``(updated_at DESC, id ASC)`` — most recently
        submitted first, with a stable tie-break on fragment id.  The cursor
        encodes ``(updated_at ISO, id)`` to support time-ordered pagination.

        Movement context (composer, work, movement label) is resolved by
        a single batch JOIN query after the page is fetched, so the caller
        can triage without fetching each fragment individually.

        This method is designed for reuse in Component 8: the caller can apply
        additional filters (e.g. concept_id) before calling this method by
        extending the service or passing extra ``where`` clauses.

        Args:
            caller_id: String UUID of the authenticated caller.
            caller_role: Role of the authenticated caller.
            cursor: Opaque pagination cursor from a prior response.
            page_size: Maximum fragments per page (1–200).

        Returns:
            :class:`~models.fragment.ReviewQueueResponse` with items and an
            optional ``next_cursor`` for the following page.

        Raises:
            ValueError: Cursor string is malformed.
        """
        stmt = (
            select(Fragment)
            .where(
                Fragment.parent_fragment_id.is_(None),
                Fragment.status == "submitted",
            )
            .order_by(Fragment.updated_at.desc(), Fragment.id.asc())
        )

        # Creator exclusion: editors do not see their own submitted fragments.
        if caller_role != "admin":
            caller_uuid = uuid.UUID(caller_id)
            stmt = stmt.where(Fragment.created_by != caller_uuid)

        # Time-ordered cursor: filter to rows strictly older than the cursor.
        if cursor is not None:
            cursor_ts, cursor_id = _decode_time_cursor(cursor)
            stmt = stmt.where(
                or_(
                    Fragment.updated_at < cursor_ts,
                    and_(
                        Fragment.updated_at == cursor_ts,
                        Fragment.id > cursor_id,
                    ),
                )
            )

        result = await self._db.execute(stmt.limit(page_size + 1))
        rows = list(result.scalars().all())

        has_next = len(rows) > page_size
        page = rows[:page_size]

        if not page:
            return ReviewQueueResponse(items=[], next_cursor=None)

        page_ids = [f.id for f in page]
        movement_ids = list({f.movement_id for f in page})

        # Load concept tags for the page.
        tags_result = await self._db.execute(
            select(FragmentConceptTag).where(
                FragmentConceptTag.fragment_id.in_(page_ids)
            )
        )
        tags_by_frag: dict[uuid.UUID, list[FragmentConceptTag]] = {}
        for tag in tags_result.scalars().all():
            tags_by_frag.setdefault(tag.fragment_id, []).append(tag)

        # Batch Neo4j concept hydration.
        all_concept_ids = list(
            {t.concept_id for tags in tags_by_frag.values() for t in tags}
        )
        alias_map: dict[str, str | None] = {}
        if all_concept_ids:
            async with self._driver.session() as neo_session:
                for c in await get_concepts_by_ids(neo_session, all_concept_ids):
                    aliases: list[str] = c.get("aliases", [])
                    alias_map[c["id"]] = aliases[0] if aliases else None

        # Batch movement context: one JOIN query for all unique movement_ids.
        ctx_result = await self._db.execute(
            select(
                Movement.id.label("movement_id"),
                Movement.movement_number,
                Movement.title.label("movement_title"),
                Work.title.label("work_title"),
                Work.catalogue_number.label("work_catalogue_number"),
                Composer.name.label("composer_name"),
            )
            .join(Work, Movement.work_id == Work.id)
            .join(Corpus, Work.corpus_id == Corpus.id)
            .join(Composer, Corpus.composer_id == Composer.id)
            .where(Movement.id.in_(movement_ids))
        )
        movement_ctx: dict[uuid.UUID, dict] = {}
        for row in ctx_result.mappings().all():
            movement_ctx[row["movement_id"]] = dict(row)

        def _primary_for(frag_id: uuid.UUID) -> tuple[str | None, str | None]:
            for tag in tags_by_frag.get(frag_id, []):
                if tag.is_primary:
                    return tag.concept_id, alias_map.get(tag.concept_id)
            return None, None

        items: list[ReviewQueueItem] = []
        for f in page:
            p_id, p_alias = _primary_for(f.id)
            ctx = movement_ctx.get(f.movement_id, {})
            items.append(
                ReviewQueueItem(
                    id=f.id,
                    movement_id=f.movement_id,
                    bar_start=f.bar_start,
                    bar_end=f.bar_end,
                    mc_start=f.mc_start,
                    mc_end=f.mc_end,
                    beat_start=f.beat_start,
                    beat_end=f.beat_end,
                    repeat_context=f.repeat_context,
                    status=f.status,
                    primary_concept_id=p_id,
                    primary_concept_alias=p_alias,
                    created_by=f.created_by,
                    submitted_at=f.updated_at,
                    composer_name=ctx.get("composer_name", ""),
                    work_title=ctx.get("work_title", ""),
                    work_catalogue_number=ctx.get("work_catalogue_number"),
                    movement_number=ctx.get("movement_number", 0),
                    movement_title=ctx.get("movement_title"),
                )
            )

        next_cursor = (
            _encode_time_cursor(page[-1].updated_at, page[-1].id) if has_next else None
        )
        return ReviewQueueResponse(items=items, next_cursor=next_cursor)

    async def list_by_concept(
        self,
        concept_id: str,
        include_subtypes: bool,
        status_filter: str,
        caller_id: str,
        caller_role: str,
        cursor: str | None = None,
        page_size: int = 50,
    ) -> ConceptBrowseResponse:
        """Return a cursor-paginated browse list of fragments for a concept.

        The two-step cross-database join (ADR pattern):
        1. Resolve the concept id set from Neo4j (downward IS_SUBTYPE_OF subtree
           when ``include_subtypes=True``; singleton set otherwise).
        2. Query PostgreSQL for top-level fragments whose
           ``fragment_concept_tag.concept_id`` is in that set.

        A fragment matches on **any** of its tags (not only ``is_primary``), so
        a cross-referenced fragment surfaces under every concept it is tagged
        with.  Fragments with multiple matching tags appear exactly once (the
        subquery uses DISTINCT on fragment_id).

        The subtree expansion is cached in Redis keyed by ``concept_id`` when
        ``include_subtypes=True``; the singleton case is never cached because it
        is free.  The cache is invalidated by ``scripts/seed.py`` after every
        re-seed.

        Status visibility rules (service layer, not bypassable via the route):
        - Admins see all fragments matching the requested ``status_filter``.
        - Editors see their own drafts plus all submitted/approved/rejected, then
          additionally filtered to the requested ``status_filter``.

        Results are ordered ``(updated_at DESC, id ASC)`` so the most recently
        edited fragment appears first across all movements in the result set.

        Args:
            concept_id: Neo4j Concept id to browse (the root of the subtree).
            include_subtypes: When True, include all non-stub subtypes of the
                concept; when False, return only exact-concept matches.
            status_filter: Limit results to this fragment status.  One of
                ``draft``, ``submitted``, ``approved``, ``rejected``.  Defaults
                to ``approved`` when an invalid value is supplied.
            caller_id: String UUID of the authenticated caller.
            caller_role: Role of the authenticated caller.
            cursor: Opaque time-ordered pagination cursor from a prior response.
            page_size: Maximum items per page (1–200).

        Returns:
            :class:`~models.fragment.ConceptBrowseResponse` with items and an
            optional ``next_cursor`` for the following page.

        Raises:
            ValueError: Cursor string is malformed.
        """
        concept_ids = await self._resolve_subtree(concept_id, include_subtypes)
        if not concept_ids:
            return ConceptBrowseResponse(
                items=[],
                next_cursor=None,
                concept_id=concept_id,
                include_subtypes=include_subtypes,
            )

        # Subquery: distinct fragment_ids that carry any matching concept tag.
        matching_ids_sq = (
            select(FragmentConceptTag.fragment_id)
            .where(FragmentConceptTag.concept_id.in_(concept_ids))
            .distinct()
            .subquery()
        )

        stmt = (
            select(Fragment)
            .where(
                Fragment.parent_fragment_id.is_(None),
                Fragment.id.in_(select(matching_ids_sq.c.fragment_id)),
            )
            .order_by(Fragment.updated_at.desc(), Fragment.id.asc())
        )

        # Status visibility — enforced at the service layer.
        valid_statuses = frozenset({"draft", "submitted", "approved", "rejected"})
        effective_status = (
            status_filter if status_filter in valid_statuses else "approved"
        )

        if caller_role != "admin":
            caller_uuid = uuid.UUID(caller_id)
            # Base visibility: own drafts + all non-draft.
            stmt = stmt.where(
                or_(
                    Fragment.status.in_(["submitted", "approved", "rejected"]),
                    and_(
                        Fragment.status == "draft",
                        Fragment.created_by == caller_uuid,
                    ),
                )
            )

        # Further scope to the requested status.
        stmt = stmt.where(Fragment.status == effective_status)

        # Time-ordered cursor: filter to rows strictly older than the cursor.
        if cursor is not None:
            cursor_ts, cursor_id = _decode_time_cursor(cursor)
            stmt = stmt.where(
                or_(
                    Fragment.updated_at < cursor_ts,
                    and_(
                        Fragment.updated_at == cursor_ts,
                        Fragment.id > cursor_id,
                    ),
                )
            )

        result = await self._db.execute(stmt.limit(page_size + 1))
        rows = list(result.scalars().all())

        has_next = len(rows) > page_size
        page = rows[:page_size]

        if not page:
            return ConceptBrowseResponse(
                items=[],
                next_cursor=None,
                concept_id=concept_id,
                include_subtypes=include_subtypes,
            )

        page_ids = [f.id for f in page]
        movement_ids = list({f.movement_id for f in page})

        # Load primary concept tags for the page fragments.
        tags_result = await self._db.execute(
            select(FragmentConceptTag).where(
                FragmentConceptTag.fragment_id.in_(page_ids),
                FragmentConceptTag.is_primary.is_(True),
            )
        )
        primary_tag_by_frag: dict[uuid.UUID, FragmentConceptTag] = {}
        for tag in tags_result.scalars().all():
            primary_tag_by_frag[tag.fragment_id] = tag

        # Batch Neo4j concept hydration for primary concept IDs.
        primary_concept_ids = list({t.concept_id for t in primary_tag_by_frag.values()})
        concept_name_map: dict[str, str] = {}
        concept_alias_map: dict[str, str | None] = {}
        if primary_concept_ids:
            async with self._driver.session() as neo_session:
                for c in await get_concepts_by_ids(neo_session, primary_concept_ids):
                    aliases: list[str] = c.get("aliases", [])
                    concept_name_map[c["id"]] = c.get("name", c["id"])
                    concept_alias_map[c["id"]] = aliases[0] if aliases else None

        # Batch movement context.
        ctx_result = await self._db.execute(
            select(
                Movement.id.label("movement_id"),
                Movement.movement_number,
                Movement.title.label("movement_title"),
                Work.title.label("work_title"),
                Work.catalogue_number.label("work_catalogue_number"),
                Composer.name.label("composer_name"),
            )
            .join(Work, Movement.work_id == Work.id)
            .join(Corpus, Work.corpus_id == Corpus.id)
            .join(Composer, Corpus.composer_id == Composer.id)
            .where(Movement.id.in_(movement_ids))
        )
        movement_ctx: dict[uuid.UUID, dict] = {
            row["movement_id"]: dict(row) for row in ctx_result.mappings().all()
        }

        # Batch movement_analysis events for harmony_sources derivation (ADR-009).
        analysis_result = await self._db.execute(
            select(MovementAnalysis.movement_id, MovementAnalysis.events).where(
                MovementAnalysis.movement_id.in_(movement_ids)
            )
        )
        movement_events: dict[uuid.UUID, list[dict]] = {
            row.movement_id: row.events or [] for row in analysis_result
        }

        # Resolve preview signed URLs concurrently for all fragments that have
        # a stored preview_object_key (ADR-008: null until Celery task completes).
        async def _resolve_preview(
            frag_id: uuid.UUID, key: str | None, version: datetime | None
        ) -> tuple[uuid.UUID, str | None]:
            if self._storage is None or key is None:
                return frag_id, None
            return frag_id, await self._storage.signed_url(key, version=version)

        preview_url_map: dict[uuid.UUID, str | None] = dict(
            await asyncio.gather(
                *[
                    _resolve_preview(f.id, f.preview_object_key, f.preview_generated_at)
                    for f in page
                ]
            )
        )

        items: list[ConceptBrowseItem] = []
        for f in page:
            ptag = primary_tag_by_frag.get(f.id)
            p_concept_id = ptag.concept_id if ptag else None
            ctx = movement_ctx.get(f.movement_id, {})
            evs = movement_events.get(f.movement_id, [])
            h_sources = _sources_in_range(evs, f.bar_start, f.bar_end, f.repeat_context)
            dl_url = _LICENCE_URL_MAP.get(f.data_licence) if f.data_licence else None
            items.append(
                ConceptBrowseItem(
                    id=f.id,
                    movement_id=f.movement_id,
                    bar_start=f.bar_start,
                    bar_end=f.bar_end,
                    beat_start=f.beat_start,
                    beat_end=f.beat_end,
                    repeat_context=f.repeat_context,
                    status=f.status,
                    primary_concept_id=p_concept_id,
                    primary_concept_alias=(
                        concept_alias_map.get(p_concept_id) if p_concept_id else None
                    ),
                    primary_concept_name=(
                        concept_name_map.get(p_concept_id) if p_concept_id else None
                    ),
                    data_licence=f.data_licence,
                    data_licence_url=dl_url,
                    harmony_sources=h_sources,
                    preview_url=preview_url_map.get(f.id),
                    created_by=f.created_by,
                    updated_at=f.updated_at,
                    composer_name=ctx.get("composer_name", ""),
                    work_title=ctx.get("work_title", ""),
                    work_catalogue_number=ctx.get("work_catalogue_number"),
                    movement_number=ctx.get("movement_number", 0),
                    movement_title=ctx.get("movement_title"),
                )
            )

        next_cursor = (
            _encode_time_cursor(page[-1].updated_at, page[-1].id) if has_next else None
        )
        return ConceptBrowseResponse(
            items=items,
            next_cursor=next_cursor,
            concept_id=concept_id,
            include_subtypes=include_subtypes,
        )

    # ------------------------------------------------------------------
    # Public interface — delete
    # ------------------------------------------------------------------

    async def delete(
        self,
        fragment_id: uuid.UUID,
        caller_id: str,
        caller_role: str,
        confirm_cascade: bool = False,
        dry_run: bool = False,
    ) -> FragmentDeleteResult:
        """Delete a fragment and its sub-part children via ON DELETE CASCADE.

        Permission matrix (fragment-schema.md § "Delete Permissions"):

        +-----------+----------+--------------------+-------+
        | Status    | Creator  | Non-creator editor | Admin |
        +-----------+----------+--------------------+-------+
        | draft     | allowed  | denied             | allowed |
        | submitted | allowed  | denied             | allowed |
        | rejected  | allowed  | denied             | allowed |
        | approved  | denied   | denied             | allowed |
        +-----------+----------+--------------------+-------+

        Cascade guard: if the parent has sub-parts and ``confirm_cascade`` is
        ``False``, the delete is refused and the child count is reported.
        Pass ``dry_run=True`` to get the child count without deleting.

        ``movement_analysis`` rows are never deleted — they are movement-level,
        not fragment-owned.

        Args:
            fragment_id: UUID of the fragment to delete.
            caller_id: String UUID of the authenticated caller.
            caller_role: Role of the authenticated caller.
            confirm_cascade: Set ``True`` to authorise deleting parent + all
                sub-parts when sub-parts exist.
            dry_run: If ``True``, return the cascade child count without
                executing any delete.

        Returns:
            :class:`FragmentDeleteResult` with the fragment UUID, the child
            count (deleted or would-be-deleted), and the ``dry_run`` flag.

        Raises:
            FragmentNotFoundError: Fragment does not exist.
            FragmentValidationError: Caller lacks delete permission, or the
                fragment has sub-parts and ``confirm_cascade=False``.
        """
        # Reads use the session's implicit autobegin transaction.
        result = await self._db.execute(
            select(Fragment).where(Fragment.id == fragment_id)
        )
        fragment = result.scalar_one_or_none()
        if fragment is None:
            raise FragmentNotFoundError(
                f"No fragment with id '{fragment_id}' exists.",
                detail={"fragment_id": str(fragment_id)},
            )

        self._check_delete_permission(fragment, caller_id, caller_role)

        count_result = await self._db.execute(
            select(func.count()).where(Fragment.parent_fragment_id == fragment_id)
        )
        child_count = count_result.scalar_one()

        if dry_run:
            return FragmentDeleteResult(
                fragment_id=fragment_id, child_count=child_count, dry_run=True
            )

        if child_count > 0 and not confirm_cascade:
            raise FragmentValidationError(
                f"Fragment '{fragment_id}' has {child_count} sub-part(s). "
                "Pass confirm_cascade=true to delete the parent and all its sub-parts, "
                "or use dry_run=true to preview the cascade without deleting.",
                detail={
                    "fragment_id": str(fragment_id),
                    "child_count": child_count,
                    "requires_confirm_cascade": True,
                },
            )

        # Delete the parent; ON DELETE CASCADE on parent_fragment_id removes children.
        # fragment_concept_tag and fragment_review rows cascade via their own FKs.
        await self._db.execute(delete(Fragment).where(Fragment.id == fragment_id))
        await self._db.commit()

        return FragmentDeleteResult(
            fragment_id=fragment_id, child_count=child_count, dry_run=False
        )

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

    async def _slice_harmony_events(
        self,
        movement_id: uuid.UUID,
        bar_start: int,
        bar_end: int,
        repeat_context: str | None,
    ) -> list[dict]:
        """Slice harmony events from movement_analysis for a fragment's bar range.

        Applies volta filtering when ``repeat_context`` names a specific ending.
        Events with a null ``mn`` are skipped.

        Args:
            movement_id: The movement whose analysis to query.
            bar_start: Inclusive lower bound (notated bar number).
            bar_end: Inclusive upper bound (notated bar number).
            repeat_context: Fragment repeat context string (e.g. ``"first_ending"``),
                or ``None`` for no volta filter.

        Returns:
            Subset of event dicts in the fragment's bar range, in their original
            ``movement_analysis.events`` array order.
        """
        result = await self._db.execute(
            select(MovementAnalysis.events).where(
                MovementAnalysis.movement_id == movement_id
            )
        )
        events = result.scalar_one_or_none()
        if not events:
            return []
        volta_filter = _REPEAT_CONTEXT_TO_VOLTA.get(repeat_context or "", None)
        sliced: list[dict] = []
        for ev in events:
            mn = ev.get("mn")
            if mn is None:
                continue
            if not (bar_start <= int(mn) <= bar_end):
                continue
            if volta_filter is not None and ev.get("volta") != volta_filter:
                continue
            sliced.append(ev)
        return sliced

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
            in_range = await self._slice_harmony_events(
                fragment.movement_id,
                fragment.bar_start,
                fragment.bar_end,
                fragment.repeat_context,
            )
            unreviewed = [ev for ev in in_range if not ev.get("reviewed")]
            if unreviewed:
                failures["unreviewed_harmony_events"] = unreviewed

        return failures

    # ------------------------------------------------------------------
    # Internal helpers — permission check
    # ------------------------------------------------------------------

    @staticmethod
    def _check_delete_permission(
        fragment: Fragment, caller_id: str, caller_role: str
    ) -> None:
        """Assert that the caller may delete this fragment.

        Raises:
            FragmentValidationError: Caller is not the creator and not an admin,
                or caller is the creator but the fragment is ``approved``.
        """
        if caller_role == "admin":
            return
        is_creator = (
            fragment.created_by is not None and str(fragment.created_by) == caller_id
        )
        if not is_creator:
            raise FragmentValidationError(
                "Only the creating annotator or an admin may delete this fragment.",
                detail={
                    "fragment_id": str(fragment.id),
                    "caller_id": caller_id,
                    "creator_id": (
                        str(fragment.created_by) if fragment.created_by else None
                    ),
                },
            )
        if fragment.status == "approved":
            raise FragmentValidationError(
                "Approved fragments cannot be deleted by annotators. "
                "Only an admin may delete an approved fragment.",
                detail={
                    "fragment_id": str(fragment.id),
                    "status": fragment.status,
                },
            )

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
    # Internal helpers — analytic change detection (Step 8)
    # ------------------------------------------------------------------

    @staticmethod
    def _analytic_fields_changed(
        fragment: Fragment,
        existing_tags: list[FragmentConceptTag],
        existing_subs: list[Fragment],
        existing_sub_tags: dict[uuid.UUID, list[FragmentConceptTag]],
        payload: FragmentUpdate,
    ) -> bool:
        """Return True if the payload changes any analytic field vs. stored state.

        ``prose_annotation`` is the only non-analytic field — all others
        (coordinates, summary, concept tags, sub-part coordinates/tags)
        invalidate prior analytical approval if changed.

        Returns False only when the payload is purely a prose-annotation edit,
        so the caller may update ``prose_annotation`` in place without clearing
        reviews or transitioning status.

        Args:
            fragment: Stored parent fragment ORM row.
            existing_tags: Stored concept tags for the parent fragment.
            existing_subs: Stored child (sub-part) fragment rows, ordered by
                ``(mc_start, id)`` ascending.
            existing_sub_tags: Stored concept tags keyed by sub-part fragment id.
            payload: Incoming :class:`~models.fragment.FragmentUpdate` payload.

        Returns:
            True when at least one analytic field differs; False for prose-only.
        """
        if (
            fragment.bar_start != payload.bar_start
            or fragment.bar_end != payload.bar_end
            or fragment.mc_start != payload.mc_start
            or fragment.mc_end != payload.mc_end
            or fragment.beat_start != payload.beat_start
            or fragment.beat_end != payload.beat_end
            or fragment.repeat_context != payload.repeat_context
        ):
            return True

        # Normalize both sides through FragmentSummary so that optional fields
        # absent from older stored dicts (pre-existing rows missing None-valued
        # keys) compare equal to a freshly serialised Pydantic model.
        stored_summary = FragmentSummary.model_validate(fragment.summary).model_dump()
        if stored_summary != payload.summary.model_dump():
            return True

        existing_tag_pairs = frozenset(
            (t.concept_id, t.is_primary) for t in existing_tags
        )
        payload_tag_pairs = frozenset(
            (t.concept_id, t.is_primary) for t in payload.concept_tags
        )
        if existing_tag_pairs != payload_tag_pairs:
            return True

        if len(existing_subs) != len(payload.sub_parts):
            return True

        # Compare sub-parts pairwise sorted by mc_start (the write path preserves
        # insertion order by mc_start; ties broken by UUID are stable within a run).
        for sp, psp in zip(
            sorted(existing_subs, key=lambda s: (s.mc_start, str(s.id))),
            sorted(payload.sub_parts, key=lambda p: p.mc_start),
        ):
            stored_sp_summary = FragmentSummary.model_validate(sp.summary).model_dump()
            if (
                sp.bar_start != psp.bar_start
                or sp.bar_end != psp.bar_end
                or sp.mc_start != psp.mc_start
                or sp.mc_end != psp.mc_end
                or sp.beat_start != psp.beat_start
                or sp.beat_end != psp.beat_end
                or sp.repeat_context != psp.repeat_context
                or stored_sp_summary != psp.summary.model_dump()
            ):
                return True

            sp_tag_pairs = frozenset(
                (t.concept_id, t.is_primary) for t in existing_sub_tags.get(sp.id, [])
            )
            psp_tag_pairs = frozenset(
                (t.concept_id, t.is_primary) for t in psp.concept_tags
            )
            if sp_tag_pairs != psp_tag_pairs:
                return True

        return False

    # ------------------------------------------------------------------
    # Internal helpers — subtree resolution (Component 8 Step 2)
    # ------------------------------------------------------------------

    async def _resolve_subtree(
        self,
        concept_id: str,
        include_subtypes: bool,
    ) -> set[str]:
        """Resolve the set of concept ids for a browse query.

        When ``include_subtypes=False`` returns the singleton ``{concept_id}``
        immediately (no Neo4j or Redis access needed).

        When ``include_subtypes=True`` checks the Redis subtree cache first; on
        a miss, runs the downward IS_SUBTYPE_OF traversal via Neo4j and
        populates the cache for subsequent requests.

        Args:
            concept_id: The root concept to resolve.
            include_subtypes: When False, return only the root.

        Returns:
            Set of concept ids to match against ``fragment_concept_tag``.
        """
        if not include_subtypes:
            return {concept_id}

        if self._redis is not None:
            cached = await get_subtree_cache(self._redis, concept_id)
            if cached is not None:
                return cached

        async with self._driver.session() as neo_session:
            ids = await get_subtype_ids_async(neo_session, concept_id)

        if self._redis is not None:
            await set_subtree_cache(self._redis, concept_id, ids)

        return ids

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
            language="en",  # Phase 1: all annotations authored in English (ADR-006)
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
            language="en",  # Phase 1: all annotations authored in English (ADR-006)
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

    async def _sync_annotation_translations(self, parent_id: uuid.UUID) -> None:
        """Mirror canonical English prose into ``fragment_annotation_translation``.

        Reads the current prose of the parent fragment and all its sub-parts
        from the session (so it reflects the writes already flushed in this
        transaction) and upserts the ('en', authoritative) record for each, or
        deletes it when the prose is cleared. Idempotent — safe to call once at
        the end of any mutating fragment operation (ADR-006 §4).

        Must be invoked inside the caller's transaction so the translation
        rows commit atomically with the fragment write.

        Args:
            parent_id: The parent fragment id; its sub-parts are synced too.
        """
        result = await self._db.execute(
            select(Fragment.id, Fragment.prose_annotation).where(
                or_(
                    Fragment.id == parent_id,
                    Fragment.parent_fragment_id == parent_id,
                )
            )
        )
        for fragment_id, prose in result.all():
            if prose is None:
                await self._db.execute(
                    _DELETE_ANNOTATION_TRANSLATION, {"fragment_id": fragment_id}
                )
            else:
                await self._db.execute(
                    _UPSERT_ANNOTATION_TRANSLATION,
                    {
                        "fragment_id": fragment_id,
                        "prose": prose,
                        "source_hash": hashlib.sha256(
                            prose.encode("utf-8")
                        ).hexdigest(),
                    },
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
