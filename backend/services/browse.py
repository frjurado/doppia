"""Browse service: corpus hierarchy traversal queries.

All four browse endpoints delegate to async functions in this module.
No query logic lives in the route handlers.

Each function returns ``None`` when a required slug or ID is not found so
that the route handler can raise the appropriate 404 without importing
SQLAlchemy into the route layer.

See docs/roadmap/component-2-corpus-browsing.md §Step 5.
"""

from __future__ import annotations

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from models.browse import (
    ComposerResponse,
    CorpusResponse,
    MovementResponse,
    WorkResponse,
)
from models.music import Composer, Corpus, Movement, Work
from services.object_storage import StorageClient

# Signed URL lifetime matching MEI URL policy (ADR-002): 15 minutes.
_INCIPIT_URL_TTL_SECONDS = 900


async def list_composers(db: AsyncSession) -> list[ComposerResponse]:
    """Return all composers ordered alphabetically by ``sort_name``.

    Args:
        db: Async database session.

    Returns:
        List of :class:`~models.browse.ComposerResponse` items.
    """
    result = await db.execute(select(Composer).order_by(Composer.sort_name))
    composers = result.scalars().all()
    return [
        ComposerResponse(
            id=c.id,
            slug=c.slug,
            name=c.name,
            sort_name=c.sort_name,
            birth_year=c.birth_year,
            death_year=c.death_year,
        )
        for c in composers
    ]


async def list_corpora(
    composer_slug: str,
    db: AsyncSession,
) -> list[CorpusResponse] | None:
    """Return all corpora for a composer with a ``work_count`` aggregate.

    Args:
        composer_slug: URL-safe composer identifier.
        db: Async database session.

    Returns:
        List of :class:`~models.browse.CorpusResponse` items, or ``None``
        if the composer slug is not found.
    """
    composer_row = await db.execute(
        select(Composer).where(Composer.slug == composer_slug)
    )
    composer = composer_row.scalar_one_or_none()
    if composer is None:
        return None

    work_count_subq = (
        select(func.count(Work.id))
        .where(Work.corpus_id == Corpus.id)
        .correlate(Corpus)
        .scalar_subquery()
    )
    result = await db.execute(
        select(Corpus, work_count_subq.label("work_count"))
        .where(Corpus.composer_id == composer.id)
        .order_by(Corpus.title)
    )
    return [
        CorpusResponse(
            id=corpus.id,
            slug=corpus.slug,
            title=corpus.title,
            source_repository=corpus.source_repository,
            licence=corpus.licence,
            work_count=work_count,
        )
        for corpus, work_count in result.all()
    ]


async def list_works(
    composer_slug: str,
    corpus_slug: str,
    db: AsyncSession,
) -> list[WorkResponse] | None:
    """Return all works in a corpus with a ``movement_count`` aggregate.

    Ordered lexicographically by ``catalogue_number`` (free-form strings).

    Args:
        composer_slug: URL-safe composer identifier.
        corpus_slug: URL-safe corpus identifier.
        db: Async database session.

    Returns:
        List of :class:`~models.browse.WorkResponse` items, or ``None`` if
        the composer or corpus slug is not found.
    """
    composer_row = await db.execute(
        select(Composer).where(Composer.slug == composer_slug)
    )
    composer = composer_row.scalar_one_or_none()
    if composer is None:
        return None

    corpus_row = await db.execute(
        select(Corpus).where(
            Corpus.composer_id == composer.id,
            Corpus.slug == corpus_slug,
        )
    )
    corpus = corpus_row.scalar_one_or_none()
    if corpus is None:
        return None

    movement_count_subq = (
        select(func.count(Movement.id))
        .where(Movement.work_id == Work.id)
        .correlate(Work)
        .scalar_subquery()
    )
    result = await db.execute(
        select(Work, movement_count_subq.label("movement_count"))
        .where(Work.corpus_id == corpus.id)
        .order_by(Work.catalogue_number)
    )
    return [
        WorkResponse(
            id=work.id,
            slug=work.slug,
            title=work.title,
            catalogue_number=work.catalogue_number,
            year_composed=work.year_composed,
            movement_count=movement_count,
        )
        for work, movement_count in result.all()
    ]


async def list_movements(
    work_id: uuid.UUID,
    db: AsyncSession,
    storage: StorageClient,
) -> list[MovementResponse] | None:
    """Return all movements for a work ordered by ``movement_number``.

    Resolves ``incipit_object_key`` to a signed URL at request time.
    Movements without an incipit return ``incipit_url=None`` and
    ``incipit_ready=False``.

    Args:
        work_id: UUID primary key of the work row.
        db: Async database session.
        storage: Object storage client for generating signed URLs.

    Returns:
        List of :class:`~models.browse.MovementResponse` items, or ``None``
        if the work ID is not found.
    """
    work_row = await db.execute(select(Work).where(Work.id == work_id))
    if work_row.scalar_one_or_none() is None:
        return None

    result = await db.execute(
        select(Movement)
        .where(Movement.work_id == work_id)
        .order_by(Movement.movement_number)
    )
    movements = result.scalars().all()

    responses: list[MovementResponse] = []
    for m in movements:
        incipit_url: str | None = None
        if m.incipit_object_key is not None:
            incipit_url = await storage.signed_url(
                m.incipit_object_key, expires_in=_INCIPIT_URL_TTL_SECONDS
            )
        responses.append(
            MovementResponse(
                id=m.id,
                slug=m.slug,
                movement_number=m.movement_number,
                title=m.title,
                tempo_marking=m.tempo_marking,
                key_signature=m.key_signature,
                meter=m.meter,
                duration_bars=m.duration_bars,
                incipit_url=incipit_url,
                incipit_ready=m.incipit_object_key is not None,
            )
        )
    return responses
