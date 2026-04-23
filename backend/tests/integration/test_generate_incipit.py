"""Integration tests for the generate_incipit Celery task.

Tests exercise ``_generate_incipit_async`` directly (no Celery broker required).
Each test class method:

1. Uploads the K331 movement-1 fixture via the ingestion endpoint (which creates
   the movement row and writes the normalised MEI to MinIO).
2. Calls ``_generate_incipit_async(movement_id)`` directly.
3. Asserts the expected DB state and MinIO object.

Requires ``docker compose up`` (PostgreSQL + MinIO) to be running.

See docs/roadmap/component-2-corpus-browsing.md §Step 3.
"""

from __future__ import annotations

import io
import uuid
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import pytest_asyncio
import yaml
from celery.exceptions import Ignore
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from services.object_storage import make_storage_client
from services.tasks.generate_incipit import _generate_incipit_async

# ---------------------------------------------------------------------------
# Fixtures directory
# ---------------------------------------------------------------------------

_FIXTURES = Path(__file__).parent.parent / "fixtures"
_MEI_DIR = _FIXTURES / "mei"
_HARMONIES_DIR = _FIXTURES / "dcml-subset" / "harmonies"

# ---------------------------------------------------------------------------
# Metadata template (single movement for brevity)
# ---------------------------------------------------------------------------

_METADATA: dict[str, Any] = {
    "composer": {
        "slug": "test-mozart",
        "name": "Wolfgang Amadeus Mozart",
        "sort_name": "Mozart, Wolfgang Amadeus",
        "birth_year": 1756,
        "death_year": 1791,
        "nationality": "Austrian",
    },
    "corpus": {
        "slug": "piano-sonatas",
        "title": "Piano Sonatas (incipit integration test fixture)",
        "analysis_source": "DCML",
        "licence": "CC-BY-SA-4.0",
        "source_commit": "abc1234",
        "works": [
            {
                "slug": "k331",
                "title": "Piano Sonata in A major, K. 331",
                "catalogue_number": "K. 331",
                "movements": [
                    {
                        "slug": "movement-1",
                        "movement_number": 1,
                        "title": "Andante grazioso",
                        "mei_filename": "mei/k331/movement-1.mei",
                        "harmonies_filename": "harmonies/k331/movement-1.tsv",
                    },
                ],
            },
        ],
    },
}


# ---------------------------------------------------------------------------
# ZIP builder
# ---------------------------------------------------------------------------


def _build_zip(metadata_dict: dict[str, Any], files: dict[str, bytes | str]) -> bytes:
    """Assemble an in-memory corpus upload ZIP.

    Args:
        metadata_dict: Python dict serialised as ``metadata.yaml``.
        files: Mapping of ZIP-internal path → content (bytes or str).

    Returns:
        Raw ZIP bytes suitable for posting to the upload endpoint.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata.yaml", yaml.safe_dump(metadata_dict))
        for path, content in files.items():
            if isinstance(content, bytes):
                zf.writestr(path, content.decode("utf-8"))
            else:
                zf.writestr(path, content)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# DB cleanup helper
# ---------------------------------------------------------------------------


async def _delete_test_composer(session: AsyncSession, slug: str) -> None:
    """Delete a test composer and all descendant rows (RESTRICT FKs → manual order).

    Args:
        session: Open async session with an active transaction.
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


# ---------------------------------------------------------------------------
# Helper: fetch movement ID from DB
# ---------------------------------------------------------------------------


async def _get_movement_id(
    session: AsyncSession,
    movement_slug: str = "movement-1",
    work_slug: str = "k331",
) -> str:
    """Return the UUID string for the given movement slug.

    Args:
        session: Open async session.
        movement_slug: Movement slug to look up.
        work_slug: Work slug to disambiguate.

    Returns:
        UUID string for the movement row.
    """
    row = (
        await session.execute(
            text(
                """
                SELECT mv.id
                FROM   movement mv
                JOIN   work w ON mv.work_id = w.id
                WHERE  mv.slug = :ms AND w.slug = :ws
                """
            ),
            {"ms": movement_slug, "ws": work_slug},
        )
    ).one()
    return str(row.id)


# ---------------------------------------------------------------------------
# Test class
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestGenerateIncipit:
    """Integration tests for the generate_incipit task."""

    @pytest_asyncio.fixture(autouse=True)
    async def _setup(
        self,
        integration_test_client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:  # type: ignore[override]
        """Upload corpus fixture and clean up test composer after each test.

        The ingestion endpoint is called with both Celery task dispatches mocked
        so they do not require a broker. After the upload, the MEI is in MinIO
        and the movement row exists in the DB, ready for ``_generate_incipit_async``
        to be called directly by each test.
        """
        mei1 = (_MEI_DIR / "k331-movement-1.mei").read_bytes()
        tsv1 = (_HARMONIES_DIR / "K331-1.tsv").read_bytes()
        archive = _build_zip(
            _METADATA,
            {
                "mei/k331/movement-1.mei": mei1,
                "harmonies/k331/movement-1.tsv": tsv1,
            },
        )

        with patch("services.ingestion.ingest_movement_analysis") as mock_analysis, \
             patch("services.ingestion.generate_incipit") as mock_incipit:
            mock_analysis.delay = MagicMock()
            mock_incipit.delay = MagicMock()
            resp = await integration_test_client.post(
                "/api/v1/composers/test-mozart/corpora/piano-sonatas/upload",
                files={"archive": ("corpus.zip", archive, "application/zip")},
                headers={"Authorization": "Bearer dev-token"},
            )
        assert resp.status_code == 201, resp.text

        yield

        async with db_session.begin():
            await _delete_test_composer(db_session, "test-mozart")

    # ------------------------------------------------------------------
    # Test 1 — DB columns are written
    # ------------------------------------------------------------------

    async def test_incipit_object_key_and_generated_at_set(
        self,
        db_session: AsyncSession,
    ) -> None:
        """Running the task sets incipit_object_key and incipit_generated_at."""
        movement_id = await _get_movement_id(db_session)

        await _generate_incipit_async(movement_id)

        row = (
            await db_session.execute(
                text(
                    "SELECT incipit_object_key, incipit_generated_at "
                    "FROM movement WHERE id = :mid"
                ),
                {"mid": movement_id},
            )
        ).one()

        assert row.incipit_object_key is not None
        assert row.incipit_object_key.endswith("/incipit.svg")
        assert "test-mozart" in row.incipit_object_key
        assert row.incipit_generated_at is not None

    # ------------------------------------------------------------------
    # Test 2 — stored object is valid SVG
    # ------------------------------------------------------------------

    async def test_stored_svg_is_valid(
        self,
        db_session: AsyncSession,
    ) -> None:
        """The object written to MinIO is valid UTF-8 XML starting with <svg."""
        movement_id = await _get_movement_id(db_session)

        await _generate_incipit_async(movement_id)

        key_row = (
            await db_session.execute(
                text("SELECT incipit_object_key FROM movement WHERE id = :mid"),
                {"mid": movement_id},
            )
        ).one()

        storage = make_storage_client()
        svg_bytes = await storage.get_mei(key_row.incipit_object_key)
        svg_text = svg_bytes.decode("utf-8")

        assert svg_text.lstrip().startswith("<svg"), (
            f"Expected SVG output to start with '<svg', got: {svg_text[:120]!r}"
        )

    # ------------------------------------------------------------------
    # Test 3 — idempotent re-run
    # ------------------------------------------------------------------

    async def test_idempotent_rerun(
        self,
        db_session: AsyncSession,
    ) -> None:
        """Calling the task twice overwrites the SVG; incipit_generated_at advances."""
        movement_id = await _get_movement_id(db_session)

        await _generate_incipit_async(movement_id)
        generated_at_1 = (
            await db_session.execute(
                text("SELECT incipit_generated_at FROM movement WHERE id = :mid"),
                {"mid": movement_id},
            )
        ).scalar_one()

        await _generate_incipit_async(movement_id)
        generated_at_2 = (
            await db_session.execute(
                text("SELECT incipit_generated_at FROM movement WHERE id = :mid"),
                {"mid": movement_id},
            )
        ).scalar_one()

        assert generated_at_2 >= generated_at_1, (
            "incipit_generated_at should not regress on re-run"
        )

    # ------------------------------------------------------------------
    # Test 4 — nonexistent movement raises Ignore
    # ------------------------------------------------------------------

    async def test_nonexistent_movement_raises_ignore(self) -> None:
        """A bogus movement_id causes the task to raise Ignore silently."""
        bogus_id = str(uuid.uuid4())
        with pytest.raises(Ignore):
            await _generate_incipit_async(bogus_id)
