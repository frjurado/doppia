"""Celery task: render a movement's incipit SVG and persist it to object storage.

The task is dispatched by the ingestion pipeline immediately after each movement's
DB transaction commits (alongside ``ingest_movement_analysis``).  It is fire-and-
forget: its success or failure does not affect the ingestion report returned to
the caller.

Approach (Finding 5, docs/architecture/mei-ingest-normalization.md):
    Use the smart-break page-1 strategy — set ``breaks="smart"`` with a narrow
    ``pageWidth`` so Verovio fits the first system on page 1, then render that
    single page.  This naturally includes pickup bars (measure ``@n="0"``) without
    any ``@n`` addressing logic.

On failure, ``incipit_object_key`` and ``incipit_generated_at`` remain null.
The browse API (Component 2 Step 5) handles the null case gracefully by returning
``incipit_ready: false``.

See docs/roadmap/component-2-corpus-browsing.md §Step 3.
"""

from __future__ import annotations

import asyncio
import logging
import os

import verovio
from celery.exceptions import Ignore
from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from services.celery_app import celery_app
from services.object_storage import incipit_key, make_storage_client

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Module-level lazy async engine — initialised once per Celery worker process.
# ---------------------------------------------------------------------------

_engine: AsyncEngine | None = None
_session_factory: async_sessionmaker[AsyncSession] | None = None


def _get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Return (lazily initialised) async session factory for Celery worker DB access."""
    global _engine, _session_factory
    if _session_factory is None:
        _engine = create_async_engine(
            os.environ["DATABASE_URL"],
            pool_pre_ping=True,
            pool_size=2,
            max_overflow=2,
        )
        _session_factory = async_sessionmaker(
            _engine, class_=AsyncSession, expire_on_commit=False
        )
    return _session_factory


# ---------------------------------------------------------------------------
# Inner async implementation (exposed for direct invocation in tests)
# ---------------------------------------------------------------------------


async def _generate_incipit_async(movement_id: str) -> None:
    """Fetch MEI, render incipit SVG via Verovio, and persist to object storage.

    Updates ``movement.incipit_object_key`` and ``movement.incipit_generated_at``
    on success.  Raises :exc:`celery.exceptions.Ignore` if the movement row does
    not exist (guards against race conditions during test teardown).

    Args:
        movement_id: UUID string of the target movement row.

    Raises:
        celery.exceptions.Ignore: When no movement row matches ``movement_id``.
        RuntimeError: When Verovio fails to load the MEI data.
    """
    factory = _get_session_factory()
    async with factory() as session:
        row = (
            await session.execute(
                text(
                    """
                    SELECT mv.mei_object_key,
                           mv.slug           AS movement_slug,
                           w.slug            AS work_slug,
                           c.slug            AS corpus_slug,
                           comp.slug         AS composer_slug
                    FROM   movement  mv
                    JOIN   work      w    ON mv.work_id     = w.id
                    JOIN   corpus    c    ON w.corpus_id    = c.id
                    JOIN   composer  comp ON c.composer_id  = comp.id
                    WHERE  mv.id = :movement_id
                    """
                ),
                {"movement_id": movement_id},
            )
        ).one_or_none()

    if row is None:
        logger.warning("generate_incipit: movement %s not found — ignoring", movement_id)
        raise Ignore()

    storage = make_storage_client()
    mei_bytes = await storage.get_mei(row.mei_object_key)

    tk = verovio.toolkit()
    tk.setOptions(
        {
            "pageWidth": 800,
            "pageHeight": 800,
            "adjustPageHeight": True,
            "breaks": "smart",
            "scale": 35,
        }
    )
    ok = tk.loadData(mei_bytes.decode("utf-8"))
    if not ok:
        raise RuntimeError(
            f"Verovio failed to load MEI for movement {movement_id}. "
            f"Log: {tk.getLog()}"
        )
    svg = tk.renderToSVG(1)

    key = incipit_key(
        row.composer_slug,
        row.corpus_slug,
        row.work_slug,
        row.movement_slug,
    )
    await storage.put_svg(key, svg)

    async with factory() as session:
        async with session.begin():
            await session.execute(
                text(
                    """
                    UPDATE movement
                    SET    incipit_object_key   = :key,
                           incipit_generated_at = NOW()
                    WHERE  id = :movement_id
                    """
                ),
                {"key": key, "movement_id": movement_id},
            )

    logger.info("generate_incipit: stored %s for movement %s", key, movement_id)


# ---------------------------------------------------------------------------
# Celery task entry point
# ---------------------------------------------------------------------------


@celery_app.task(name="generate_incipit", bind=True, max_retries=3)
def generate_incipit(self, movement_id: str) -> None:  # type: ignore[override]
    """Render the first page of a movement as an SVG incipit and store it.

    Triggered immediately after a successful movement ingest (alongside
    ``ingest_movement_analysis``).  Retries up to three times on Verovio or
    storage failures; silently discards the task if the movement row does not
    exist.

    Args:
        movement_id: UUID string of the target movement row.
    """
    try:
        asyncio.run(_generate_incipit_async(movement_id))
    except Ignore:
        raise  # movement not found — discard silently, no retry
    except Exception as exc:
        logger.exception(
            "generate_incipit: failed for movement %s (attempt %d/%d)",
            movement_id,
            self.request.retries + 1,
            self.max_retries + 1,
        )
        raise self.retry(exc=exc, countdown=60)
