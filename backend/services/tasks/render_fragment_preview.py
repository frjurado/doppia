"""Celery task: render a fragment's bar range as an SVG preview and persist it.

The task is enqueued when a fragment transitions to ``submitted`` status (Step 6).
Re-enqueuing on bar-range revision or MEI correction overwrites the previous SVG
in place — the storage key is stable for the lifetime of the fragment row (ADR-008).

Only ``submitted`` and ``approved`` fragments are processed.  ``draft`` and
``rejected`` fragments are silently discarded via :exc:`~celery.exceptions.Ignore`.

Verovio ``select`` approach (same as ``generate_incipit``):
    ``tk.select({"measureRange": "{mc_start}-{mc_end}"})`` followed by
    ``tk.redoLayout()``.  ``mc_start`` / ``mc_end`` are 1-based document-order
    position indices written by the tagging tool at tag time (ADR-015); they map
    directly to Verovio's ``measureRange`` operand without any conversion.
    Pickup bars, repeats, and volta endings are handled the same way as in
    client-side rendering — see the Component 3 spike notes in
    ``docs/architecture/mei-ingest-normalization.md``.

Server-side Verovio is pinned to ``verovio==6.1.0`` in ``requirements.txt``
(ADR-008 negative consequence: client and server versions must be kept in sync).

On failure, ``preview_object_key`` and ``preview_generated_at`` remain null.
The list endpoint returns ``preview_url: null`` and the frontend renders a
placeholder card until the task completes (ADR-008 fallback).

See docs/roadmap/component-8-fragment-browsing.md §Step 5 and ADR-008.
"""

from __future__ import annotations

import asyncio
import logging
import os
import re

import verovio
from celery.exceptions import Ignore
from services.celery_app import celery_app
from services.object_storage import fragment_preview_key, make_storage_client
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

logger = logging.getLogger(__name__)

_ACTIVE_STATUSES: frozenset[str] = frozenset({"submitted", "approved"})


def _verovio_resource_path() -> str | None:
    """Return the verovio data directory bundled with the Python package.

    Verovio needs its font resources (Bravura, Leipzig) to render SVG.  When
    run from a working directory that is not the package root, the toolkit
    cannot find them unless the path is set explicitly.

    Returns:
        Absolute path to the ``data/`` directory inside the verovio package,
        or ``None`` if it cannot be located.
    """
    candidate = os.path.join(os.path.dirname(os.path.abspath(verovio.__file__)), "data")
    return candidate if os.path.isdir(candidate) else None


# ---------------------------------------------------------------------------
# Inner async implementation (exposed for direct invocation in tests)
# ---------------------------------------------------------------------------


async def _render_fragment_preview_async(fragment_id: str) -> None:
    """Fetch MEI, render fragment bar range via Verovio, and persist the SVG.

    Updates ``fragment.preview_object_key`` and ``fragment.preview_generated_at``
    on success.  Raises :exc:`celery.exceptions.Ignore` when the fragment row
    does not exist or its status is not in ``_ACTIVE_STATUSES``.

    A fresh SQLAlchemy engine is created and disposed within this coroutine
    for the same reason as in ``generate_incipit._generate_incipit_async``:
    Celery tasks run inside ``asyncio.run()``, creating a new event loop per
    invocation, so a module-level cached engine would hold connections bound
    to a closed loop.

    Args:
        fragment_id: UUID string of the target fragment row.

    Raises:
        celery.exceptions.Ignore: When no fragment row matches ``fragment_id``
            or the fragment's status is not ``submitted`` or ``approved``.
        RuntimeError: When Verovio fails to load the MEI data.
    """
    engine = create_async_engine(
        os.environ["DATABASE_URL"],
        pool_size=1,
        max_overflow=0,
        pool_pre_ping=False,
        # Supabase uses PgBouncer in transaction pooling mode, which does not
        # support asyncpg prepared statements.
        connect_args={"statement_cache_size": 0},
    )
    try:
        async with AsyncSession(engine) as session:
            row = (
                await session.execute(
                    text(
                        """
                        SELECT f.mc_start,
                               f.mc_end,
                               f.status,
                               mv.mei_object_key,
                               mv.slug            AS movement_slug,
                               w.slug             AS work_slug,
                               c.slug             AS corpus_slug,
                               comp.slug          AS composer_slug
                        FROM   fragment  f
                        JOIN   movement  mv   ON f.movement_id  = mv.id
                        JOIN   work      w    ON mv.work_id     = w.id
                        JOIN   corpus    c    ON w.corpus_id    = c.id
                        JOIN   composer  comp ON c.composer_id  = comp.id
                        WHERE  f.id = :fragment_id
                        """
                    ),
                    {"fragment_id": fragment_id},
                )
            ).one_or_none()

        if row is None:
            logger.warning(
                "render_fragment_preview: fragment %s not found — ignoring",
                fragment_id,
            )
            raise Ignore()

        if row.status not in _ACTIVE_STATUSES:
            logger.info(
                "render_fragment_preview: fragment %s has status %r — skipping",
                fragment_id,
                row.status,
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
                "pageWidth": 2200,
                "adjustPageHeight": True,
                "breaks": "none",
                "scale": 35,
            }
        )
        # Strip XML comments before loading — Verovio's XML parser does not
        # handle comments between the XML declaration and the root element.
        mei_text = re.sub(r"<!--.*?-->", "", mei_bytes.decode("utf-8"), flags=re.DOTALL)
        ok = tk.loadData(mei_text)
        if not ok:
            raise RuntimeError(
                f"Verovio failed to load MEI for fragment {fragment_id}. "
                f"Log: {tk.getLog()}"
            )

        # mc_start / mc_end are 1-based document-order measure indices (ADR-015)
        # and map directly to Verovio's measureRange operand without conversion.
        tk.select({"measureRange": f"{row.mc_start}-{row.mc_end}"})
        tk.redoLayout()
        svg = tk.renderToSVG(1)

        key = fragment_preview_key(
            row.composer_slug,
            row.corpus_slug,
            row.work_slug,
            row.movement_slug,
            fragment_id,
        )
        await storage.put_svg(key, svg)

        async with AsyncSession(engine) as session:
            async with session.begin():
                await session.execute(
                    text(
                        """
                        UPDATE fragment
                        SET    preview_object_key   = :key,
                               preview_generated_at = NOW()
                        WHERE  id = :fragment_id
                        """
                    ),
                    {"key": key, "fragment_id": fragment_id},
                )

        logger.info(
            "render_fragment_preview: stored %s for fragment %s", key, fragment_id
        )

    finally:
        await engine.dispose()


# ---------------------------------------------------------------------------
# Celery task entry point
# ---------------------------------------------------------------------------


@celery_app.task(name="render_fragment_preview", bind=True, max_retries=3)
def render_fragment_preview(self, fragment_id: str) -> None:  # type: ignore[override]
    """Render a fragment's bar range as an SVG preview and store it in R2.

    Enqueued when a fragment transitions to ``submitted`` status (Step 6).
    Re-runs overwrite the previous preview in place; the storage key is stable
    for the lifetime of the fragment (ADR-008).  Retries up to three times on
    Verovio or storage failures; silently discards non-active fragments.

    Args:
        fragment_id: UUID string of the target fragment row.
    """
    try:
        asyncio.run(_render_fragment_preview_async(fragment_id))
    except Ignore:
        raise  # not found or wrong status — discard silently, no retry
    except Exception as exc:
        logger.exception(
            "render_fragment_preview: failed for fragment %s (attempt %d/%d)",
            fragment_id,
            self.request.retries + 1,
            self.max_retries + 1,
        )
        raise self.retry(exc=exc, countdown=60)
