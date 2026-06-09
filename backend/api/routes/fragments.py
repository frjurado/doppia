"""Fragment API routes: create, read, update, submit, review, and delete.

Routes:
    GET    /api/v1/fragments                  — concept-scoped browse list
    GET    /api/v1/fragments/{id}             — read one fragment (full detail)
    POST   /api/v1/fragments                  — create a draft fragment
    PATCH  /api/v1/fragments/{id}             — update at any status (revision semantics)
    DELETE /api/v1/fragments/{id}             — delete with permission checks and cascade
    POST   /api/v1/fragments/{id}/submit      — transition draft → submitted
    POST   /api/v1/fragments/{id}/approve     — record an approval; gate → approved
    POST   /api/v1/fragments/{id}/reject      — record a rejection → rejected

All routes require the ``editor`` role. The movement-scoped list endpoint
(GET /api/v1/movements/{id}/fragments) is registered on the movements router.

See docs/roadmap/component-5-tagging-tool.md §§ Step 6, Step 8.
See docs/roadmap/component-7-fragment-database.md §§ Step 7, Step 8, Step 9.
See docs/roadmap/component-8-fragment-browsing.md § Step 2.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from api.dependencies import (
    AppUser,
    get_current_user,
    get_neo4j,
    get_redis,
    get_storage,
    require_role,
)
from fastapi import APIRouter, Depends, Path, Query
from models.base import get_db
from models.fragment import (
    ConceptBrowseResponse,
    FragmentCreate,
    FragmentDeleteResponse,
    FragmentDetailResponse,
    FragmentResponse,
    FragmentUpdate,
    FragmentUpdateResponse,
    ReviewRequest,
)
from neo4j import AsyncDriver
from redis.asyncio import Redis
from services.fragments import FragmentService
from services.object_storage import StorageClient
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/fragments", tags=["Fragments"])


def get_fragment_service(
    db: AsyncSession = Depends(get_db),
    driver: AsyncDriver = Depends(get_neo4j),
    redis: Redis | None = Depends(get_redis),
    storage: StorageClient = Depends(get_storage),
) -> FragmentService:
    """FastAPI dependency that constructs a :class:`~services.fragments.FragmentService`.

    Separated from the route handler so tests can override any dependency
    via ``app.dependency_overrides``.

    Args:
        db: Async SQLAlchemy session (injected by ``get_db``).
        driver: Async Neo4j driver (injected by ``get_neo4j``).
        redis: Async Redis client for the subtree cache (injected by ``get_redis``).
            ``None`` when Redis is unavailable; the service degrades gracefully.
        storage: Object storage client for resolving preview signed URLs.

    Returns:
        A :class:`~services.fragments.FragmentService` bound to all backends.
    """
    return FragmentService(db, driver, redis, storage)


@router.get(
    "",
    response_model=ConceptBrowseResponse,
    dependencies=[require_role("editor")],
    summary="Browse fragments by concept tag",
    response_description=(
        "Cursor-paginated list of top-level fragments whose concept tags include "
        "the requested concept (and its subtypes when ``include_subtypes=true``). "
        "Each item carries the movement label, primary concept alias, stored "
        "``data_licence``, and a ``preview_url`` (null until Step 5 generates "
        "the SVG)."
    ),
)
async def list_fragments_by_concept(
    concept_id: str = Query(
        ...,
        description=(
            "Neo4j Concept id to browse (e.g. ``AuthenticCadence``). "
            "Required — the concept-scoped browse endpoint always needs a root."
        ),
    ),
    include_subtypes: bool = Query(
        True,
        description=(
            "When true (default), include fragments tagged with any non-stub "
            "subtype of the concept as well as the concept itself. "
            "When false, return only exact-concept matches."
        ),
    ),
    status: str = Query(
        "approved",
        description=(
            "Fragment status to browse. One of ``draft``, ``submitted``, "
            "``approved`` (default), ``rejected``. Visibility rules apply: "
            "editors see their own drafts and all non-draft statuses. "
            "An invalid value falls back to ``approved``."
        ),
    ),
    cursor: str | None = Query(
        None,
        description="Opaque pagination cursor from a prior response's ``next_cursor``.",
    ),
    page_size: int = Query(
        50,
        ge=1,
        le=200,
        description="Maximum items per page (1–200, default 50).",
    ),
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> ConceptBrowseResponse:
    """Browse fragments by concept tag across the full corpus.

    Returns a cursor-paginated list of top-level fragments whose
    ``fragment_concept_tag`` rows include the requested concept (or any of its
    non-stub subtypes when ``include_subtypes=true``).

    A fragment appears under **any** concept it is tagged with, not only its
    primary (``is_primary=true``) concept, so cross-referenced fragments surface
    under every relevant concept.  Fragments with multiple in-set tags appear
    exactly once.

    **Status visibility** is enforced at the service layer:

    * Editors see their own drafts plus all submitted/approved/rejected
      fragments; the ``status`` filter further scopes within that visible set.
    * Admins see all fragments of the requested status.
    * A spoofed ``status=draft`` returns only the caller's own drafts regardless
      of role (editor), because the visibility rule gates draft access to creators.

    The subtree expansion (``include_subtypes=true``) is cached in Redis per
    concept and invalidated when the knowledge graph is re-seeded.

    Args:
        concept_id: Neo4j Concept id (e.g. ``"AuthenticCadence"``).
        include_subtypes: Include subtype fragments in the result.
        status: Fragment status filter (default ``approved``).
        cursor: Opaque cursor from a prior response for pagination.
        page_size: Items per page (1–200).
        service: Fragment service (injected).
        user: Authenticated caller (injected).

    Returns:
        :class:`~models.fragment.ConceptBrowseResponse` with items, a
        ``next_cursor``, and the echoed ``concept_id``/``include_subtypes``.

    Raises:
        422: ``cursor`` is malformed.
    """
    return await service.list_by_concept(
        concept_id=concept_id,
        include_subtypes=include_subtypes,
        status_filter=status,
        caller_id=user.id,
        caller_role=user.role,
        cursor=cursor,
        page_size=page_size,
    )


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
    response_model=FragmentUpdateResponse,
    dependencies=[require_role("editor")],
    summary="Update a fragment (draft, submitted, or approved)",
    response_description=(
        "The updated fragment with revision metadata. "
        "``status_changed=true`` means the edit triggered a status transition "
        "(e.g. ``approved`` → ``submitted``); ``previous_status`` names the "
        "status before the edit so the UI can surface 'this edit re-opened review'."
    ),
)
async def update_fragment(
    payload: FragmentUpdate,
    fragment_id: uuid.UUID = Path(..., description="UUID of the fragment to update"),
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> FragmentUpdateResponse:
    """Replace mutable fields of a fragment at any status.

    The endpoint accepts fragments in ``draft``, ``rejected``, ``submitted``,
    or ``approved`` status. The creator and admins may edit; non-creators are
    rejected with a 422.

    **Revision semantics (analytic edit — coordinates, summary, concept tags,
    or sub-parts changed):**

    * ``draft`` → stays ``draft``.
    * ``rejected`` → transitions to ``draft``.
    * ``submitted`` → stays ``submitted``; all prior ``fragment_review`` rows
      are cleared (the thing reviewed has changed).
    * ``approved`` → transitions to ``submitted``; all prior
      ``fragment_review`` rows are cleared.

    **Prose-only edit** (only ``prose_annotation`` changed, all analytic fields
    identical to stored state): update is applied in place with no status
    change and no review-row clearing.

    The ``movement_id`` is immutable after creation. All concept tags and
    sub-parts in the payload replace any previously stored values atomically.

    Args:
        payload: Replacement payload (all mutable fields; no ``movement_id``).
        fragment_id: UUID of the fragment to update.
        service: Fragment service (injected).
        user: Authenticated caller (injected).

    Returns:
        :class:`~models.fragment.FragmentUpdateResponse` with the updated
        fragment and ``status_changed`` / ``previous_status`` revision fields.

    Raises:
        404 ``FRAGMENT_NOT_FOUND``: Fragment does not exist.
        422 ``FRAGMENT_VALIDATION_ERROR``: Caller is not the creator/admin,
            a concept id is missing from the graph, or a sub-part is out of range.
    """
    result = await service.update(
        fragment_id=fragment_id,
        payload=payload,
        caller_id=user.id,
        caller_role=user.role,
    )
    base = FragmentResponse.model_validate(result.fragment)
    return FragmentUpdateResponse(
        **base.model_dump(),
        previous_status=result.previous_status,
        status_changed=result.status_changed,
    )


@router.delete(
    "/{fragment_id}",
    response_model=FragmentDeleteResponse,
    dependencies=[require_role("editor")],
    summary="Delete a fragment with permission checks and cascade to sub-parts",
    response_description=(
        "The deleted fragment's UUID, the number of sub-part children removed "
        "(or would-be-removed when ``dry_run=true``), and the ``dry_run`` flag."
    ),
)
async def delete_fragment(
    fragment_id: uuid.UUID = Path(..., description="UUID of the fragment to delete"),
    confirm_cascade: bool = Query(
        False,
        description=(
            "Set to true to authorise deleting the parent and all its sub-parts. "
            "Required when the fragment has sub-parts; ignored when it has none. "
            "The request is refused (422) with the child count when this is false "
            "and sub-parts exist."
        ),
    ),
    dry_run: bool = Query(
        False,
        description=(
            "If true, return the cascade child_count without executing any delete. "
            "Use this to preview the cascade before confirming."
        ),
    ),
    service: FragmentService = Depends(get_fragment_service),
    user: Annotated[AppUser, Depends(get_current_user)] = None,
) -> FragmentDeleteResponse:
    """Delete a fragment, its sub-parts, and their concept tags.

    **Permission matrix:**

    * Creators may delete their own ``draft``, ``submitted``, or ``rejected``
      fragments.
    * ``approved`` fragments cannot be deleted by annotators — only admins
      may delete them.
    * Non-creators (other than admins) cannot delete any fragment.

    **Cascade guard:** if the fragment has sub-parts and ``confirm_cascade``
    is ``false``, the request is refused (422) with the child count in
    ``detail.child_count``. Pass ``confirm_cascade=true`` to proceed.

    **Dry run:** pass ``dry_run=true`` to preview the cascade count without
    deleting anything. Permission checks still run.

    ``movement_analysis`` rows are never removed — they are movement-level,
    not fragment-owned.

    Args:
        fragment_id: UUID of the fragment to delete.
        confirm_cascade: Authorise the cascade deletion when sub-parts exist.
        dry_run: Return child_count without deleting.
        service: Fragment service (injected).
        user: Authenticated caller (injected).

    Returns:
        :class:`~models.fragment.FragmentDeleteResponse` with the fragment UUID,
        the child count, and the ``dry_run`` flag.

    Raises:
        404 ``FRAGMENT_NOT_FOUND``: Fragment does not exist.
        422 ``FRAGMENT_VALIDATION_ERROR``: Caller lacks delete permission, or
            the fragment has sub-parts and ``confirm_cascade=false``.
    """
    result = await service.delete(
        fragment_id=fragment_id,
        caller_id=user.id,
        caller_role=user.role,
        confirm_cascade=confirm_cascade,
        dry_run=dry_run,
    )
    return FragmentDeleteResponse(
        fragment_id=result.fragment_id,
        child_count=result.child_count,
        dry_run=result.dry_run,
    )


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
