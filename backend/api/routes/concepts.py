"""Concept API routes: search and schema-tree lookup.

Routes:
    GET /api/v1/concepts/search              — full-text search with cursor pagination
    GET /api/v1/concepts/{concept_id}/schemas — schema tree for a taggable concept

All routes require the ``editor`` role.

See docs/roadmap/component-5-tagging-tool.md § Steps 3–4.
"""

from __future__ import annotations

from api.dependencies import get_neo4j, require_role
from fastapi import APIRouter, Depends, Path, Query
from models.concepts import ConceptSchemaTreeResponse, ConceptSearchResponse
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


@router.get(
    "/{concept_id}/schemas",
    response_model=ConceptSchemaTreeResponse,
    dependencies=[require_role("editor")],
    summary="Get schema tree for a concept",
    response_description=(
        "Property schemas (with hydrated values), CONTAINS stage structure, "
        "and Type Refinement metadata for the concept."
    ),
)
async def get_concept_schemas(
    concept_id: str = Path(
        ..., description="Immutable concept identifier (e.g. 'PerfectAuthenticCadence')"
    ),
    service: ConceptService = Depends(get_concept_service),
) -> ConceptSchemaTreeResponse:
    """Return everything the form panel needs to render for a concept.

    A single call returns:

    - **Property schemas** — all schemas applicable to the concept (inherited
      via ``IS_SUBTYPE_OF``), each hydrated with its value list.  For each
      value carrying a ``VALUE_REFERENCES`` edge the referenced concept's id,
      name, and definition are included so the form can render an inline ⓘ
      without a second round-trip.  ``BOOL`` schemas have an empty values list.
    - **Stage structure** — all ``CONTAINS`` stages (inherited), ordered by
      ``order``, with ``display_mode``, ``containment_mode``, and
      ``default_weight`` for the tagging UI's bracket pre-population.
    - **Type Refinement** — when the concept has ``IS_SUBTYPE_OF`` children
      whose resolved ``CONTAINS`` structures differ, ``type_refinement.show``
      is ``true`` and the children list is populated so the UI can render the
      radio group.  Re-calling this endpoint with a child id provides the
      child's stage structure.

    Returns HTTP 404 when ``concept_id`` is unknown.

    Args:
        concept_id: Immutable concept identifier.
        service: Concept service (injected).

    Returns:
        :class:`~models.concepts.ConceptSchemaTreeResponse`.
    """
    return await service.get_schema_tree(concept_id)
