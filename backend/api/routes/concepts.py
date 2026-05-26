"""Concept API routes: search and schema-tree lookup.

Routes:
    GET /api/v1/concepts/search   — full-text search with cursor pagination

All routes require the ``editor`` role.

See docs/roadmap/component-5-tagging-tool.md § Step 3.
"""

from __future__ import annotations

from api.dependencies import get_neo4j, require_role
from fastapi import APIRouter, Depends, Query
from models.concepts import ConceptSearchResponse
from neo4j import AsyncDriver
from services.concepts import ConceptService

router = APIRouter(prefix="/concepts", tags=["Concepts"])


def get_concept_service(driver: AsyncDriver = Depends(get_neo4j)) -> ConceptService:
    """FastAPI dependency that constructs a :class:`~services.concepts.ConceptService`.

    Separated from the route handler so tests can override it via
    ``app.dependency_overrides[get_concept_service]``.

    Args:
        driver: Async Neo4j driver (injected by ``get_neo4j``).

    Returns:
        A :class:`~services.concepts.ConceptService` bound to the driver.
    """
    return ConceptService(driver)


@router.get(
    "/search",
    response_model=ConceptSearchResponse,
    dependencies=[require_role("editor")],
    summary="Search concepts by name or alias",
    response_description=(
        "Matching taggable concepts ordered by relevance, with hierarchy paths "
        "and an optional cursor for the next page."
    ),
)
async def search_concepts(
    q: str = Query(..., min_length=1, description="Full-text search query"),
    domain: str | None = Query(None, description="Filter by domain name"),
    cursor: str | None = Query(
        None, description="Pagination cursor from a previous response"
    ),
    service: ConceptService = Depends(get_concept_service),
) -> ConceptSearchResponse:
    """Search the concept graph for taggable concepts matching *q*.

    Only concepts with ``stub=false`` and ``top_level_taggable=true`` are
    returned — the same filter the concept picker in the tagging UI enforces.
    For each hit the response includes the full IS_SUBTYPE_OF hierarchy path
    from the domain root down to the concept so the picker can render its
    breadcrumb without a second round-trip.

    Results are ordered by relevance score descending.  Use ``cursor`` to page
    through results when ``next_cursor`` is present in the response.

    Args:
        q: Lucene full-text query (e.g. ``"perfect authentic"`` or ``"PAC"``).
        domain: Restrict results to a single domain (e.g. ``"cadences"``).
        cursor: Opaque cursor from a previous response's ``next_cursor`` field.
        service: Concept service (injected).

    Returns:
        :class:`~models.concepts.ConceptSearchResponse` with ordered hits and
        an optional ``next_cursor``.
    """
    return await service.search(q=q, domain=domain, cursor=cursor)
