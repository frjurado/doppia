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
from api.rate_limiting import GRAPH_ANONYMOUS, READ_ANONYMOUS, limiter
from api.routes.fragments import get_fragment_service
from fastapi import APIRouter, Depends, Path, Query, Request
from models.base import get_db
from models.concepts import ConceptDetailResponse, ConceptIndexResponse
from models.fragment import ConceptExamplesResponse
from neo4j import AsyncDriver
from services.concepts import ConceptService
from services.fragments import FragmentService
from sqlalchemy.ext.asyncio import AsyncSession

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


def get_public_index_service(
    driver: AsyncDriver = Depends(get_neo4j),
    db: AsyncSession = Depends(get_db),
) -> ConceptService:
    """Construct a :class:`~services.concepts.ConceptService` for the index.

    Unlike the detail service this also wires the SQLAlchemy session, because
    the index attaches approved-fragment counts (a PostgreSQL read). Separated
    so tests can override it independently.

    Args:
        driver: Async Neo4j driver (injected by ``get_neo4j``).
        db: Async SQLAlchemy session (injected by ``get_db``) for counts.

    Returns:
        A :class:`~services.concepts.ConceptService` bound to the driver and db.
    """
    return ConceptService(driver, db=db)


@router.get(
    "",
    response_model=ConceptIndexResponse,
    summary="Browse the concept glossary index by domain (anonymous)",
    response_description=(
        "Every non-stub domain root with its non-stub IS_SUBTYPE_OF subtree "
        "(flat node list, keyed by parent_id) and approved-fragment counts. "
        "The public entry point into the glossary."
    ),
)
@limiter.limit(GRAPH_ANONYMOUS)
async def public_list_concept_index(
    request: Request,
    service: ConceptService = Depends(get_public_index_service),
) -> ConceptIndexResponse:
    """Return the public browse-by-domain concept index, anonymously.

    Args:
        request: The incoming request (used by the rate limiter).
        service: Public index service (injected; driver + db).

    Returns:
        :class:`~models.concepts.ConceptIndexResponse` — one entry per domain
        root, each with its flat subtree and per-concept approved counts.
    """
    return await service.get_public_index()


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


@router.get(
    "/{concept_id}/examples",
    response_model=ConceptExamplesResponse,
    summary="Draw random approved example fragments for a concept (anonymous)",
    response_description=(
        "Up to `limit` (default 3) randomly-drawn approved fragments tagged "
        "with the concept (subtypes included by default), minus the ADR-009 "
        "NonCommercial exclusion. Re-drawn on each call — the glossary shuffle. "
        "Items reuse the browse preview-card shape."
    ),
)
@limiter.limit(READ_ANONYMOUS)
async def public_get_concept_examples(
    request: Request,
    concept_id: str = Path(
        ...,
        description="Immutable Concept id whose example fragments to draw.",
    ),
    include_subtypes: bool = Query(
        True,
        description=(
            "When true (default), include fragments tagged with any non-stub "
            "subtype of the concept as well as the concept itself."
        ),
    ),
    limit: int = Query(
        3,
        ge=1,
        le=12,
        description="Maximum number of example fragments to draw (1–12, default 3).",
    ),
    seed: int | None = Query(
        None,
        description=(
            "Optional integer to make the random draw reproducible. Omit (the "
            "default) to re-draw freshly on each call — the shuffle behaviour."
        ),
    ),
    service: FragmentService = Depends(get_fragment_service),
) -> ConceptExamplesResponse:
    """Draw up to ``limit`` random approved example fragments for a concept.

    The pool is exactly what the anonymous browse would return for this concept
    (``approved`` only, ADR-009 NonCommercial excluded, any tag not only
    ``is_primary``), randomly sampled and capped. An unknown concept id is not an
    error here — it simply resolves to an empty pool and returns no examples.

    Args:
        request: The incoming request (used by the rate limiter).
        concept_id: The immutable concept id whose examples to draw.
        include_subtypes: Include subtype fragments in the pool.
        limit: Maximum number of examples to return (1–12).
        seed: Optional integer for a reproducible draw; ``None`` re-draws freshly.
        service: Fragment service (injected).

    Returns:
        :class:`~models.fragment.ConceptExamplesResponse` with the drawn
        examples (possibly empty).
    """
    return await service.list_examples_by_concept(
        concept_id,
        include_subtypes=include_subtypes,
        limit=limit,
        seed=seed,
    )
