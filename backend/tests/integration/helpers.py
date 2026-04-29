"""Shared helper functions for integration tests.

These are plain async functions (not pytest fixtures) that can be imported
and called by any integration test module.
"""

from __future__ import annotations

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def delete_test_composer(session: AsyncSession, slug: str) -> None:
    """Delete a test composer and all descendant rows (RESTRICT FKs → manual order).

    Args:
        session: Open async session.  The caller is responsible for committing
            or rolling back after this function returns.
        slug: Composer slug to delete.
    """
    await session.execute(
        text(
            """
            DELETE FROM movement_analysis
            WHERE movement_id IN (
                SELECT m.id FROM movement m
                JOIN work w ON m.work_id = w.id
                JOIN corpus c ON w.corpus_id = c.id
                JOIN composer co ON c.composer_id = co.id
                WHERE co.slug = :slug
            )
            """
        ),
        {"slug": slug},
    )
    await session.execute(
        text(
            """
            DELETE FROM movement
            WHERE work_id IN (
                SELECT w.id FROM work w
                JOIN corpus c ON w.corpus_id = c.id
                JOIN composer co ON c.composer_id = co.id
                WHERE co.slug = :slug
            )
            """
        ),
        {"slug": slug},
    )
    await session.execute(
        text(
            """
            DELETE FROM work
            WHERE corpus_id IN (
                SELECT c.id FROM corpus c
                JOIN composer co ON c.composer_id = co.id
                WHERE co.slug = :slug
            )
            """
        ),
        {"slug": slug},
    )
    await session.execute(
        text(
            """
            DELETE FROM corpus
            WHERE composer_id IN (
                SELECT id FROM composer WHERE slug = :slug
            )
            """
        ),
        {"slug": slug},
    )
    await session.execute(
        text("DELETE FROM composer WHERE slug = :slug"),
        {"slug": slug},
    )
