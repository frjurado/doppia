"""Public (anonymous) read-only API routes — the Phase 2 public read path.

Routes:
    GET /api/v1/public/fragments                — browse approved fragments by concept
    GET /api/v1/public/fragments/{fragment_id}  — read one approved fragment

These routes carry **no** ``require_role()`` dependency: they are served to
anonymous callers.  ``AuthMiddleware`` sets ``request.state.user = None`` for
tokenless requests, and nothing here reads it.

The ``approved``-only guarantee is structural, not parametric:

* The browse route has no ``status`` query parameter — the service is called
  with ``status_filter="approved"`` hard-pinned, and the service layer
  additionally forces ``approved`` for any anonymous caller
  (``caller_id=None``), so a spoofed ``?status=`` has no effect and no future
  code path can widen the filter.
* The detail route returns 404 for any non-``approved`` fragment, with the
  same error body as a nonexistent id, so a fragment's existence or review
  status is never leaked through the public surface.

The routers here reuse the Component 8 service methods — the cross-database
join, cursor pagination, and ADR-009 licence serialisation are identical to
the editor browse; only the fixed status and the CORS/rate-limit posture of
the ``/api/v1/public/`` prefix differ.  The CORS posture (broad-origin,
no-credentials) is applied per-prefix in ``main.py`` — see
``api.middleware.cors`` and ``docs/architecture/security-model.md`` § 1.

See docs/roadmap/component-10-foundations-public-read-path.md § Step 3.
"""

from __future__ import annotations

import uuid

from api.routes.fragments import get_fragment_service
from errors import FragmentNotFoundError
from fastapi import APIRouter, Depends, Path, Query
from models.fragment import ConceptBrowseResponse, FragmentDetailResponse
from services.fragments import FragmentService

router = APIRouter(prefix="/public", tags=["Public"])


@router.get(
    "/fragments",
    response_model=ConceptBrowseResponse,
    summary="Browse approved fragments by concept tag (anonymous)",
    response_description=(
        "Cursor-paginated list of approved top-level fragments whose concept "
        "tags include the requested concept (and its subtypes when "
        "``include_subtypes=true``). Identical shape to the editor browse, "
        "but only ``approved`` fragments are ever returned."
    ),
)
async def public_list_fragments_by_concept(
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
) -> ConceptBrowseResponse:
    """Browse approved fragments by concept tag, anonymously.

    The public counterpart of ``GET /api/v1/fragments``: same service method,
    same response shape, but no authentication and no ``status`` parameter —
    the status is hard-pinned to ``approved`` here and re-enforced for
    anonymous callers inside the service layer.

    Args:
        concept_id: Neo4j Concept id (e.g. ``"AuthenticCadence"``).
        include_subtypes: Include subtype fragments in the result.
        cursor: Opaque cursor from a prior response for pagination.
        page_size: Items per page (1–200).
        service: Fragment service (injected).

    Returns:
        :class:`~models.fragment.ConceptBrowseResponse` with approved items, a
        ``next_cursor``, and the echoed ``concept_id``/``include_subtypes``.

    Raises:
        422: ``cursor`` is malformed.
    """
    return await service.list_by_concept(
        concept_id=concept_id,
        include_subtypes=include_subtypes,
        status_filter="approved",
        caller_id=None,
        caller_role="anonymous",
        cursor=cursor,
        page_size=page_size,
    )


@router.get(
    "/fragments/{fragment_id}",
    response_model=FragmentDetailResponse,
    summary="Read one approved fragment (anonymous, full detail)",
    response_description=(
        "Full fragment record for an approved fragment: coordinates, concept "
        "tags hydrated with Neo4j name/alias/hierarchy, harmony events, "
        "licence provenance, signed MEI/preview URLs, and nested sub-parts."
    ),
)
async def public_get_fragment(
    fragment_id: uuid.UUID = Path(..., description="UUID of the fragment to read"),
    service: FragmentService = Depends(get_fragment_service),
) -> FragmentDetailResponse:
    """Return the full record for one approved fragment, anonymously.

    Any fragment that is not ``approved`` — draft, submitted, or rejected —
    returns the same 404 as a nonexistent id, so the public surface never
    leaks the existence or review status of unpublished work.

    Args:
        fragment_id: UUID of the fragment to read.
        service: Fragment service (injected).

    Returns:
        :class:`~models.fragment.FragmentDetailResponse` with concept tags,
        sliced harmony events, and nested sub-parts.

    Raises:
        404 ``FRAGMENT_NOT_FOUND``: Fragment does not exist or is not
            ``approved``.
    """
    result = await service.get(fragment_id, caller_id=None, caller_role="anonymous")
    if result.status != "approved":
        # Same message and detail as the service's nonexistent-id error so the
        # two cases are indistinguishable to an anonymous caller.
        raise FragmentNotFoundError(
            f"No fragment with id '{fragment_id}' exists.",
            detail={"fragment_id": str(fragment_id)},
        )
    return result
