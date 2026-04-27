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
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from services.celery_app import celery_app
from services.object_storage import incipit_key, make_storage_client

logger = logging.getLogger(__name__)


def _verovio_resource_path() -> str | None:
    """Return the verovio data directory bundled with the Python package.

    Verovio needs its font resources (Bravura, Leipzig) to render SVG.  When
    run from a working directory that is not the package root, the toolkit
    cannot find them unless the path is set explicitly.

    Returns:
        Absolute path to the ``data/`` directory inside the verovio package,
        or ``None`` if it cannot be located.
    """
    candidate = os.path.join(
        os.path.dirname(os.path.abspath(verovio.__file__)), "data"
    )
    return candidate if os.path.isdir(candidate) else None


# ---------------------------------------------------------------------------
# Inner async implementation (exposed for direct invocation in tests)
# ---------------------------------------------------------------------------


async def _generate_incipit_async(movement_id: str) -> None:
    """Fetch MEI, render incipit SVG via Verovio, and persist to object storage.

    Updates ``movement.incipit_object_key`` and ``movement.incipit_generated_at``
    on success.  Raises :exc:`celery.exceptions.Ignore` if the movement row does
    not exist (guards against race conditions during test teardown).

    A fresh SQLAlchemy engine is created and disposed within this coroutine.
    This is intentional: Celery tasks run inside ``asyncio.run()``, which
    creates and closes a new event loop per invocation.  A module-level cached
    engine holds asyncpg connections bound to the *previous* (closed) loop and
    raises ``RuntimeError: Event loop is closed`` on reuse.  Creating a
    per-invocation engine avoids this entirely with negligible overhead for an
    internal tool.

    Args:
        movement_id: UUID string of the target movement row.

    Raises:
        celery.exceptions.Ignore: When no movement row matches ``movement_id``.
        RuntimeError: When Verovio fails to load the MEI data.
    """
    engine = create_async_engine(
        os.environ["DATABASE_URL"],
        pool_size=1,
        max_overflow=0,
        pool_pre_ping=False,
        # Supabase uses PgBouncer in transaction pooling mode, which does not
        # support asyncpg prepared statements.  Setting statement_cache_size=0
        # disables the cache and prevents DuplicatePreparedStatementError.
        connect_args={"statement_cache_size": 0},
    )
    try:
        async with AsyncSession(engine) as session:
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
            logger.warning(
                "generate_incipit: movement %s not found — ignoring", movement_id
            )
            raise Ignore()

        storage = make_storage_client()
        mei_bytes = await storage.get_mei(row.mei_object_key)

        tk = verovio.toolkit()
        res_path = _verovio_resource_path()
        if res_path:
            tk.setResourcePath(res_path)
        tk.setOptions(
            {
                "pageWidth": 800,
                "pageHeight": 800,
                "adjustPageHeight": True,
                "breaks": "smart",
                "scale": 35,
            }
        )
        # Strip XML comments before loading: Verovio's XML parser does not
        # handle comments that appear between the XML declaration and the root
        # element, which causes it to miss <music>.  Using re.sub here avoids
        # pulling in lxml as a dependency.
        import re as _re
        mei_text = _re.sub(r"<!--.*?-->", "", mei_bytes.decode("utf-8"), flags=_re.DOTALL)
        ok = tk.loadData(mei_text)
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

        async with AsyncSession(engine) as session:
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

    finally:
        await engine.dispose()


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
