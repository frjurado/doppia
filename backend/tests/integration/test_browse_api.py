"""Integration tests for the corpus browse API (Component 2, Step 5).

Tests the four browse endpoints against a real PostgreSQL instance seeded
with a minimal Mozart fixture (one work, two movements).  A unique composer
slug is used per test run to avoid interference with staging data.

Requires ``docker compose up`` (PostgreSQL + MinIO) to be running.

See docs/roadmap/component-2-corpus-browsing.md §Step 5.
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

pytestmark = pytest.mark.integration
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

_FIXTURES = Path(__file__).parent.parent / "fixtures"
_MEI_DIR = _FIXTURES / "mei"

# ---------------------------------------------------------------------------
# Fixture metadata
# ---------------------------------------------------------------------------

_COMPOSER_SLUG = "browse-test-mozart"

_METADATA: dict[str, Any] = {
    "composer": {
        "slug": _COMPOSER_SLUG,
        "name": "Wolfgang Amadeus Mozart",
        "sort_name": "Mozart, Wolfgang Amadeus",
        "birth_year": 1756,
        "death_year": 1791,
        "nationality": "Austrian",
    },
    "corpus": {
        "slug": "piano-sonatas",
        "title": "Piano Sonatas (browse test fixture)",
        "analysis_source": "DCML",
        "licence": "CC-BY-SA-4.0",
        "source_repository": "DCMLab/mozart_piano_sonatas",
        "source_commit": "abc1234",
        "works": [
            {
                "slug": "k331",
                "title": "Piano Sonata No. 11 in A major",
                "catalogue_number": "K. 331",
                "year_composed": 1783,
                "movements": [
                    {
                        "slug": "movement-1",
                        "movement_number": 1,
                        "title": "Tema con Variazioni",
                        "tempo_marking": "Andante grazioso",
                        "key_signature": "A major",
                        "meter": "6/8",
                        "mei_filename": "mei/k331/movement-1.mei",
                        "harmonies_filename": "harmonies/k331/movement-1.tsv",
                    },
                    {
                        "slug": "movement-2",
                        "movement_number": 2,
                        "title": "Menuetto",
                        "key_signature": "A major",
                        "meter": "3/4",
                        "mei_filename": "mei/k331/movement-2.mei",
                        "harmonies_filename": "harmonies/k331/movement-2.tsv",
                    },
                ],
            },
        ],
    },
}

# Minimal DCML harmonies TSV row (required by the ingestion validator).
_HARMONIES_TSV = (
    "mc\tmn\tquarterbeats\tduration_qb\tkeysig\ttimesig\tact_dur\t"
    "mc_onset\tmn_onset\tevent\ttimesig_num\tvolta\tchord_tones\tadded_tones\t"
    "root_roman\tbass_note\tglobalkey\tlocalkey\tpedal\tchord\tnumeral\tform\t"
    "figbass\tchanges\trelativeroot\tpedalend\tphraseend\tchord_tones_num\tadded_tones_num\n"
    "1\t1\t0\t4\t0\t4/4\t4/4\t0\t0\tI\t4\tNaN\t(0, 4, 7)\t()\tI\t0\t"
    "A\tI\tNaN\tI\tI\tM\t\tNaN\tNaN\tNaN\tNaN\t3\t0\n"
)


# ---------------------------------------------------------------------------
# ZIP builder
# ---------------------------------------------------------------------------


def _build_zip() -> bytes:
    """Build a minimal corpus upload ZIP using the K331 MEI fixtures."""
    mei_1 = (_MEI_DIR / "k331-movement-1.mei").read_bytes()
    mei_2 = (_MEI_DIR / "k331-movement-2.mei").read_bytes()
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata.yaml", yaml.safe_dump(_METADATA))
        zf.writestr("mei/k331/movement-1.mei", mei_1)
        zf.writestr("mei/k331/movement-2.mei", mei_2)
        zf.writestr("harmonies/k331/movement-1.tsv", _HARMONIES_TSV)
        zf.writestr("harmonies/k331/movement-2.tsv", _HARMONIES_TSV)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# DB cleanup
# ---------------------------------------------------------------------------


async def _delete_test_composer(session: AsyncSession) -> None:
    """Delete the browse-test composer and all descendant rows."""
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
        {"slug": _COMPOSER_SLUG},
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
        {"slug": _COMPOSER_SLUG},
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
        {"slug": _COMPOSER_SLUG},
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
        {"slug": _COMPOSER_SLUG},
    )
    await session.execute(
        text("DELETE FROM composer WHERE slug = :slug"),
        {"slug": _COMPOSER_SLUG},
    )
    await session.commit()


# ---------------------------------------------------------------------------
# Test class
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestBrowseApi:
    """Integration tests for GET /api/v1/composers, /corpora, /works, /movements."""

    @pytest_asyncio.fixture(autouse=True)
    async def _seed_and_cleanup(
        self,
        integration_test_client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """Upload the browse-test Mozart corpus before each test; clean up after."""
        # Suppress Celery task dispatch — no broker running in CI.
        with (
            patch("services.ingestion.generate_incipit"),
            patch("services.ingestion.ingest_movement_analysis"),
        ):
            resp = await integration_test_client.post(
                f"/api/v1/composers/{_COMPOSER_SLUG}/corpora/piano-sonatas/upload",
                headers={"Authorization": "Bearer dev-token"},
                files={"archive": ("corpus.zip", _build_zip(), "application/zip")},
            )
        assert resp.status_code == 201, resp.text

        yield

        await _delete_test_composer(db_session)

    # ------------------------------------------------------------------
    # GET /api/v1/composers
    # ------------------------------------------------------------------

    async def test_list_composers_includes_fixture(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """The seeded composer appears in the composer list."""
        resp = await integration_test_client.get(
            "/api/v1/composers",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        slugs = [item["slug"] for item in data]
        assert _COMPOSER_SLUG in slugs

    async def test_list_composers_returns_required_fields(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """Each composer item has all required response fields."""
        resp = await integration_test_client.get(
            "/api/v1/composers",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200
        item = next(
            i for i in resp.json() if i["slug"] == _COMPOSER_SLUG
        )
        assert item["name"] == "Wolfgang Amadeus Mozart"
        assert item["sort_name"] == "Mozart, Wolfgang Amadeus"
        assert item["birth_year"] == 1756
        assert item["death_year"] == 1791
        assert "id" in item

    async def test_list_composers_requires_auth(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """Unauthenticated requests are rejected with 401."""
        resp = await integration_test_client.get("/api/v1/composers")
        assert resp.status_code == 401

    # ------------------------------------------------------------------
    # GET /api/v1/composers/{slug}/corpora
    # ------------------------------------------------------------------

    async def test_list_corpora_returns_corpus(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """The seeded corpus appears for the seeded composer."""
        resp = await integration_test_client.get(
            f"/api/v1/composers/{_COMPOSER_SLUG}/corpora",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        corpus = data[0]
        assert corpus["slug"] == "piano-sonatas"
        assert corpus["title"] == "Piano Sonatas (browse test fixture)"
        assert corpus["work_count"] == 1
        assert corpus["licence"] == "CC-BY-SA-4.0"

    async def test_list_corpora_404_unknown_composer(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """Unknown composer slug returns 404."""
        resp = await integration_test_client.get(
            "/api/v1/composers/nonexistent-composer/corpora",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 404

    # ------------------------------------------------------------------
    # GET /api/v1/composers/{slug}/corpora/{slug}/works
    # ------------------------------------------------------------------

    async def test_list_works_returns_work(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """The seeded work appears in the works list with movement_count."""
        resp = await integration_test_client.get(
            f"/api/v1/composers/{_COMPOSER_SLUG}/corpora/piano-sonatas/works",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        work = data[0]
        assert work["slug"] == "k331"
        assert work["catalogue_number"] == "K. 331"
        assert work["movement_count"] == 2

    async def test_list_works_404_unknown_corpus(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """Unknown corpus slug returns 404."""
        resp = await integration_test_client.get(
            f"/api/v1/composers/{_COMPOSER_SLUG}/corpora/nonexistent/works",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 404

    async def test_list_works_404_unknown_composer(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """Unknown composer slug returns 404."""
        resp = await integration_test_client.get(
            "/api/v1/composers/nonexistent/corpora/piano-sonatas/works",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 404

    # ------------------------------------------------------------------
    # GET /api/v1/works/{work_id}/movements
    # ------------------------------------------------------------------

    async def _get_work_id(self, client: AsyncClient) -> str:
        """Fetch the work ID for K331 via the works endpoint."""
        resp = await client.get(
            f"/api/v1/composers/{_COMPOSER_SLUG}/corpora/piano-sonatas/works",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200
        return resp.json()[0]["id"]

    async def test_list_movements_returns_two_movements(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """Both seeded movements are returned, ordered by movement_number."""
        work_id = await self._get_work_id(integration_test_client)
        resp = await integration_test_client.get(
            f"/api/v1/works/{work_id}/movements",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 2
        assert data[0]["movement_number"] == 1
        assert data[1]["movement_number"] == 2
        assert data[0]["slug"] == "movement-1"
        assert data[0]["title"] == "Tema con Variazioni"

    async def test_list_movements_incipit_null_when_not_generated(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """Movements without a generated incipit return incipit_ready=false."""
        work_id = await self._get_work_id(integration_test_client)
        resp = await integration_test_client.get(
            f"/api/v1/works/{work_id}/movements",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200
        # Celery was mocked during seed, so no incipits were generated.
        for movement in resp.json():
            assert movement["incipit_ready"] is False
            assert movement["incipit_url"] is None

    async def test_list_movements_incipit_url_present_when_generated(
        self,
        integration_test_client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """Movements with incipit_object_key set return a non-null incipit_url."""
        work_id = await self._get_work_id(integration_test_client)

        # Manually set incipit_object_key for movement-1 directly in the DB.
        fake_key = f"{_COMPOSER_SLUG}/piano-sonatas/k331/movement-1/incipit.svg"
        await db_session.execute(
            text(
                """
                UPDATE movement SET incipit_object_key = :key
                WHERE slug = 'movement-1'
                  AND work_id = :work_id
                """
            ),
            {"key": fake_key, "work_id": work_id},
        )
        await db_session.commit()

        resp = await integration_test_client.get(
            f"/api/v1/works/{work_id}/movements",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200
        movement_1 = next(m for m in resp.json() if m["slug"] == "movement-1")
        assert movement_1["incipit_ready"] is True
        assert movement_1["incipit_url"] is not None
        # The URL should be a MinIO pre-signed URL pointing to the key.
        assert fake_key.split("/")[-2] in movement_1["incipit_url"]

    async def test_list_movements_404_unknown_work(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """Unknown work UUID returns 404."""
        resp = await integration_test_client.get(
            f"/api/v1/works/{uuid.uuid4()}/movements",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 404

    async def test_list_movements_required_fields(
        self,
        integration_test_client: AsyncClient,
    ) -> None:
        """Each movement item has all required response fields."""
        work_id = await self._get_work_id(integration_test_client)
        resp = await integration_test_client.get(
            f"/api/v1/works/{work_id}/movements",
            headers={"Authorization": "Bearer dev-token"},
        )
        assert resp.status_code == 200
        m = resp.json()[0]
        for field in (
            "id",
            "slug",
            "movement_number",
            "title",
            "tempo_marking",
            "key_signature",
            "meter",
            "duration_bars",
            "incipit_url",
            "incipit_ready",
        ):
            assert field in m, f"Missing field: {field}"
