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

from api.dependencies import get_storage, require_role
from errors import (
    ComposerNotFoundError,
    CorpusNotFoundError,
    MovementNotFoundError,
    WorkNotFoundError,
)
from fastapi import APIRouter, Depends
from models.base import get_db
from models.browse import (
    ComposerResponse,
    CorpusResponse,
    MeiUrlResponse,
    MovementResponse,
    WorkResponse,
)
from services.browse import (
    get_movement_mei_url,
    list_composers,
    list_corpora,
    list_movements,
    list_works,
)
from services.object_storage import StorageClient
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
        ComposerNotFoundError: 404 if the composer slug is not found.
    """
    result = await list_corpora(composer_slug=composer_slug, db=db)
    if result is None:
        raise ComposerNotFoundError(
            f"Composer '{composer_slug}' not found.",
            detail={"slug": composer_slug},
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
        CorpusNotFoundError: 404 if the composer or corpus slug is not found.
    """
    result = await list_works(
        composer_slug=composer_slug,
        corpus_slug=corpus_slug,
        db=db,
    )
    if result is None:
        raise CorpusNotFoundError(
            f"Composer '{composer_slug}' or corpus '{corpus_slug}' not found.",
            detail={"composer_slug": composer_slug, "corpus_slug": corpus_slug},
        )
    return result


@router.get(
    "/movements/{movement_id}/mei-url",
    response_model=MeiUrlResponse,
    dependencies=[require_role("editor")],
    summary="Get a signed MEI URL for a movement",
    response_description=(
        "A short-lived signed URL for the movement's normalised MEI file."
    ),
)
async def get_mei_url(
    movement_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    storage: StorageClient = Depends(get_storage),
) -> MeiUrlResponse:
    """Return a fresh signed URL for the movement's MEI file.

    The URL is valid for 15 minutes. Clients must fetch the MEI text
    immediately and use the text for rendering — the URL itself should not
    be stored or reused.

    Args:
        movement_id: UUID primary key of the movement.
        db: Async database session (injected).
        storage: Object storage client (injected).

    Returns:
        :class:`~models.browse.MeiUrlResponse` with the signed URL.

    Raises:
        MovementNotFoundError: 404 if the movement ID is not found.
    """
    result = await get_movement_mei_url(movement_id=movement_id, db=db, storage=storage)
    if result is None:
        raise MovementNotFoundError(
            f"Movement '{movement_id}' not found.",
            detail={"movement_id": str(movement_id)},
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
    storage: StorageClient = Depends(get_storage),
) -> list[MovementResponse]:
    """Return all movements for the work, ordered by ``movement_number``.

    Includes a signed incipit URL (valid 15 minutes) when the incipit has
    been generated.  Movements where incipit generation is pending return
    ``incipit_url: null`` and ``incipit_ready: false``.

    Args:
        work_id: UUID primary key of the work.
        db: Async database session (injected).
        storage: Object storage client (injected).

    Returns:
        List of :class:`~models.browse.MovementResponse` items.

    Raises:
        WorkNotFoundError: 404 if the work ID is not found.
    """
    result = await list_movements(work_id=work_id, db=db, storage=storage)
    if result is None:
        raise WorkNotFoundError(
            f"Work '{work_id}' not found.",
            detail={"work_id": str(work_id)},
        )
    return result
