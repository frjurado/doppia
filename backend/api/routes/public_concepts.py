"""Public (anonymous) concept routes — the Phase 2 glossary read path.

Routes:
    GET /api/v1/public/concepts/{concept_id}  — full concept-page payload

Like ``api.routes.public`` (the public fragment routes), these carry **no**
``require_role()`` dependency: they are served to anonymous callers under the
``/api/v1/public/`` prefix, which ``PathScopedCORSMiddleware`` gives a
broad-origin, no-credentials, GET-only CORS posture (see
``api.middleware.cors``). They are rate-limited with ``GRAPH_ANONYMOUS`` — the
public graph-traversal bucket (``security-model.md`` § 2) — because the payload
is assembled from Neo4j traversals.

The concept-detail payload is read-only knowledge-graph content (definitions,
hierarchy, typed relationships); nothing here is gated on fragment status, so
there is no ``approved``-only concern as there is on the fragment routes. The
raw ``definition`` prose is returned together with a ``definition_reviewed``
flag so the frontend can substitute an "under editorial review" placeholder for
unreviewed prose (Component 11 Step 2).

See docs/roadmap/component-11-concept-glossary.md § Step 1.
"""

from __future__ import annotations

from api.dependencies import get_neo4j
from api.rate_limiting import GRAPH_ANONYMOUS, limiter
from fastapi import APIRouter, Depends, Path, Request
from models.concepts import ConceptDetailResponse
from neo4j import AsyncDriver
from services.concepts import ConceptService

router = APIRouter(prefix="/public/concepts", tags=["Public"])


def get_public_concept_service(
    driver: AsyncDriver = Depends(get_neo4j),
) -> ConceptService:
    """Construct a :class:`~services.concepts.ConceptService` for the public path.

    Separated from the route handler so tests can override it via
    ``app.dependency_overrides[get_public_concept_service]``. The public concept
    detail is English-only and touches only Neo4j, so neither the SQLAlchemy
    session (translation overlay / fragment counts) nor Redis is wired in.

    Args:
        driver: Async Neo4j driver (injected by ``get_neo4j``).

    Returns:
        A :class:`~services.concepts.ConceptService` bound to the driver.
    """
    return ConceptService(driver)


@router.get(
    "/{concept_id}",
    response_model=ConceptDetailResponse,
    summary="Read one concept's public glossary page (anonymous)",
    response_description=(
        "The concept's identity and prose, its place in the IS_SUBTYPE_OF "
        "hierarchy (path, parent, children), and its typed relationships to "
        "other concepts. Stub concepts return a valid payload flagged as such."
    ),
)
@limiter.limit(GRAPH_ANONYMOUS)
async def public_get_concept(
    request: Request,
    concept_id: str = Path(
        ...,
        description=(
            "Immutable Concept id (e.g. ``AuthenticCadence``). This is the "
            "stable public URL key — concept ids never change once seeded."
        ),
    ),
    service: ConceptService = Depends(get_public_concept_service),
) -> ConceptDetailResponse:
    """Return the full public glossary payload for one concept, anonymously.

    Args:
        request: The incoming request (used by the rate limiter).
        concept_id: The immutable concept id to read.
        service: Public concept service (injected).

    Returns:
        :class:`~models.concepts.ConceptDetailResponse` with the concept's
        definition, hierarchy, and typed relationships.

    Raises:
        404 ``CONCEPT_NOT_FOUND``: No concept with ``concept_id`` exists.
    """
    return await service.get_public_detail(concept_id)
