"""Browse API routes: Composer → Corpus → Work → Movement hierarchy.

All four endpoints require the ``editor`` role in Phase 1. When the public
reader role is introduced in Phase 2, the role requirement is relaxed by
changing the ``require_role`` argument — no other code change is needed.

Routes:
    GET /api/v1/composers
    GET /api/v1/composers/{composer_slug}/corpora
    GET /api/v1/composers/{composer_slug}/corpora/{corpus_slug}/works
    GET /api/v1/works/{work_id}/movements

See docs/roadmap/component-2-corpus-browsing.md §Step 5.
"""

from __future__ import annotations

import uuid

from api.dependencies import require_role
from fastapi import APIRouter, Depends, HTTPException, status
from models.base import get_db
from models.browse import (
    ComposerResponse,
    CorpusResponse,
    MovementResponse,
    WorkResponse,
)
from services.browse import list_composers, list_corpora, list_movements, list_works
from services.object_storage import make_storage_client
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(tags=["Browse"])


@router.get(
    "/composers",
    response_model=list[ComposerResponse],
    dependencies=[require_role("editor")],
    summary="List all composers",
    response_description="Composers ordered alphabetically by sort_name.",
)
async def get_composers(
    db: AsyncSession = Depends(get_db),
) -> list[ComposerResponse]:
    """Return all composers in alphabetical order by ``sort_name``.

    Args:
        db: Async database session (injected).

    Returns:
        List of :class:`~models.browse.ComposerResponse` items.
    """
    return await list_composers(db)


@router.get(
    "/composers/{composer_slug}/corpora",
    response_model=list[CorpusResponse],
    dependencies=[require_role("editor")],
    summary="List corpora for a composer",
    response_description="Corpora for the given composer with work counts.",
)
async def get_corpora(
    composer_slug: str,
    db: AsyncSession = Depends(get_db),
) -> list[CorpusResponse]:
    """Return all corpora for the given composer, with ``work_count``.

    Args:
        composer_slug: URL-safe composer identifier.
        db: Async database session (injected).

    Returns:
        List of :class:`~models.browse.CorpusResponse` items.

    Raises:
        HTTPException: 404 if the composer slug is not found.
    """
    result = await list_corpora(composer_slug=composer_slug, db=db)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Composer '{composer_slug}' not found.",
        )
    return result


@router.get(
    "/composers/{composer_slug}/corpora/{corpus_slug}/works",
    response_model=list[WorkResponse],
    dependencies=[require_role("editor")],
    summary="List works in a corpus",
    response_description="Works in the corpus ordered by catalogue_number.",
)
async def get_works(
    composer_slug: str,
    corpus_slug: str,
    db: AsyncSession = Depends(get_db),
) -> list[WorkResponse]:
    """Return all works in the corpus ordered by ``catalogue_number``.

    Args:
        composer_slug: URL-safe composer identifier.
        corpus_slug: URL-safe corpus identifier.
        db: Async database session (injected).

    Returns:
        List of :class:`~models.browse.WorkResponse` items.

    Raises:
        HTTPException: 404 if the composer or corpus slug is not found.
    """
    result = await list_works(
        composer_slug=composer_slug,
        corpus_slug=corpus_slug,
        db=db,
    )
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=(f"Composer '{composer_slug}' or corpus '{corpus_slug}' not found."),
        )
    return result


@router.get(
    "/works/{work_id}/movements",
    response_model=list[MovementResponse],
    dependencies=[require_role("editor")],
    summary="List movements for a work",
    response_description=(
        "Movements ordered by movement_number, with signed incipit URLs."
    ),
)
async def get_movements(
    work_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> list[MovementResponse]:
    """Return all movements for the work, ordered by ``movement_number``.

    Includes a signed incipit URL (valid 15 minutes) when the incipit has
    been generated.  Movements where incipit generation is pending return
    ``incipit_url: null`` and ``incipit_ready: false``.

    Args:
        work_id: UUID primary key of the work.
        db: Async database session (injected).

    Returns:
        List of :class:`~models.browse.MovementResponse` items.

    Raises:
        HTTPException: 404 if the work ID is not found.
    """
    storage = make_storage_client()
    result = await list_movements(work_id=work_id, db=db, storage=storage)
    if result is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Work '{work_id}' not found.",
        )
    return result
