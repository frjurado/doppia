"""End-to-end integration tests for the corpus upload + DCML analysis pipeline.

Exercises the full Component 1 pipeline:
    POST /api/v1/composers/{composer_slug}/corpora/{corpus_slug}/upload
    → ingest_corpus() service
    → DB writes (composer / corpus / work / movement)
    → MinIO writes (normalized MEI + original)
    → _dcml_branch() analysis ingestion (called directly; Celery broker not required)
    → movement_analysis.events in PostgreSQL

Requires ``docker compose up`` (PostgreSQL + MinIO) to be running.

See docs/roadmap/component-1-mei-corpus-ingestion.md §Step 9.
"""

from __future__ import annotations

import io
import zipfile
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest
import pytest_asyncio
import yaml
from httpx import AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration

# ---------------------------------------------------------------------------
# Fixtures directory
# ---------------------------------------------------------------------------

_FIXTURES = Path(__file__).parent.parent / "fixtures"
_MEI_DIR = _FIXTURES / "mei"
_HARMONIES_DIR = _FIXTURES / "dcml-subset" / "harmonies"

# ---------------------------------------------------------------------------
# Synthetic volta TSV
# ---------------------------------------------------------------------------

_VOLTA_TSV = (
    "mc\tmn\tquarterbeats\tduration_qb\tkeysig\ttimesig\tact_dur\t"
    "mc_onset\tmn_onset\tevent\ttimesig_num\tvolta\tchord_tones\tadded_tones\t"
    "root_roman\tbass_note\tglobalkey\tlocalkey\tpedal\tchord\tnumeral\tform\t"
    "figbass\tchanges\trelativeroot\tpedalend\tphraseend\tchord_tones_num\tadded_tones_num\n"
    "1\t1\t0\t4\t0\t4/4\t4/4\t0\t0\tI\t4\tNaN\t(0, 4, 7)\t()\tI\t0\t"
    "C\tI\tNaN\tI\tI\tM\t\tNaN\tNaN\tNaN\tNaN\t3\t0\n"
    "2\t2\t0\t4\t0\t4/4\t4/4\t0\t0\tV\t4\t1\t(7, 11, 2)\t()\tV\t7\t"
    "C\tI\tNaN\tV\tV\tM\t\tNaN\tNaN\tNaN\tNaN\t3\t0\n"
    "3\t2\t0\t4\t0\t4/4\t4/4\t0\t0\tIV\t4\t2\t(5, 9, 0)\t()\tIV\t5\t"
    "C\tI\tNaN\tIV\tIV\tM\t\tNaN\tNaN\tNaN\tNaN\t3\t0\n"
    "4\t3\t0\t4\t0\t4/4\t4/4\t0\t0\tI\t4\tNaN\t(0, 4, 7)\t()\tI\t0\t"
    "C\tI\tNaN\tI\tI\tM\t\tNaN\tNaN\tNaN\tNaN\t3\t0\n"
)

# ---------------------------------------------------------------------------
# Metadata template for the main fixture (K331 movements 1–2)
# ---------------------------------------------------------------------------

_MAIN_METADATA: dict[str, Any] = {
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
        "title": "Piano Sonatas (integration test fixture)",
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
                    {
                        "slug": "movement-2",
                        "movement_number": 2,
                        "title": "Menuetto",
                        "mei_filename": "mei/k331/movement-2.mei",
                        "harmonies_filename": "harmonies/k331/movement-2.tsv",
                    },
                ],
            },
        ],
    },
}

# Metadata variant that adds a second work with the volta fixture movement.
_VOLTA_METADATA: dict[str, Any] = {
    "composer": _MAIN_METADATA["composer"],
    "corpus": {
        **_MAIN_METADATA["corpus"],
        "works": [
            {
                "slug": "volta-work",
                "title": "Volta handling test work",
                "movements": [
                    {
                        "slug": "movement-1",
                        "movement_number": 1,
                        "mei_filename": "mei/volta-work/movement-1.mei",
                        "harmonies_filename": "harmonies/volta-work/movement-1.tsv",
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
        metadata_dict: Python dict that will be serialised as ``metadata.yaml``.
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
    # movement_analysis.movement_id has ON DELETE CASCADE from movement,
    # but work/corpus/composer use RESTRICT — delete bottom-up.
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
# Test class
# ---------------------------------------------------------------------------


@pytest.mark.asyncio(loop_scope="session")
class TestCorpusIngestion:
    """End-to-end tests for the corpus upload + DCML analysis ingestion pipeline."""

    @pytest_asyncio.fixture(autouse=True)
    async def _cleanup(self, db_session: AsyncSession) -> None:  # type: ignore[override]
        """Delete test composer and all descendant rows after each test."""
        yield

        # Use rollback to discard any uncommitted state from the test body
        # (autobegin may already have started a transaction), then run the
        # deletes in a clean autobegin transaction and commit.
        await db_session.rollback()
        await _delete_test_composer(db_session, "test-mozart")
        await db_session.commit()

    # ------------------------------------------------------------------
    # Test 1 — full pipeline
    # ------------------------------------------------------------------

    async def test_full_pipeline(
        self,
        integration_test_client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """Upload ZIP → DB rows → MinIO → movement_analysis.events populated.

        Verifies:
        - 201 response with both movements accepted.
        - composer / corpus / work / movement rows in DB.
        - Normalized and original MEI readable from MinIO.
        - movement.duration_bars correct.
        - movement_analysis.events populated with DCML source, correct spot-checks.
        - movement.key_signature back-filled from TSV globalkey.
        - harmony_alignment_warnings absent (TSV and MEI are aligned).
        """
        from services.tasks.ingest_analysis import _dcml_branch

        mei1 = (_MEI_DIR / "k331-movement-1.mei").read_bytes()
        mei2 = (_MEI_DIR / "k331-movement-2.mei").read_bytes()
        tsv1 = (_HARMONIES_DIR / "K331-1.tsv").read_bytes()
        tsv2 = (_HARMONIES_DIR / "K331-2.tsv").read_bytes()

        archive = _build_zip(
            _MAIN_METADATA,
            {
                "mei/k331/movement-1.mei": mei1,
                "mei/k331/movement-2.mei": mei2,
                "harmonies/k331/movement-1.tsv": tsv1,
                "harmonies/k331/movement-2.tsv": tsv2,
            },
        )

        # ── POST upload, capturing Celery dispatch args ────────────────
        dispatch_calls: list[dict[str, Any]] = []

        def _capture_delay(**kwargs: Any) -> None:
            dispatch_calls.append(kwargs)

        with (
            patch("services.ingestion.ingest_movement_analysis") as mock_task,
            patch("services.ingestion.generate_incipit") as mock_incipit,
        ):
            mock_task.delay = MagicMock(side_effect=_capture_delay)
            mock_incipit.delay = MagicMock()
            response = await integration_test_client.post(
                "/api/v1/composers/test-mozart/corpora/piano-sonatas/upload",
                files={"archive": ("corpus.zip", archive, "application/zip")},
                headers={"Authorization": "Bearer dev-token"},
            )

        # ── Assert 201 report ─────────────────────────────────────────
        assert response.status_code == 201, response.text
        report = response.json()
        assert report["corpus"] == {
            "composer_slug": "test-mozart",
            "corpus_slug": "piano-sonatas",
        }
        accepted_slugs = [m["movement_slug"] for m in report["movements_accepted"]]
        assert "k331/movement-1" in accepted_slugs
        assert "k331/movement-2" in accepted_slugs
        assert report["movements_rejected"] == []
        assert report["source_commit"] == "abc1234"

        # Celery was called once per movement for both tasks
        assert mock_task.delay.call_count == 2
        assert mock_incipit.delay.call_count == 2

        # ── Assert DB hierarchy ────────────────────────────────────────
        composer_row = (
            await db_session.execute(
                text("SELECT id FROM composer WHERE slug = 'test-mozart'")
            )
        ).one()
        composer_id = composer_row.id

        corpus_row = (
            await db_session.execute(
                text(
                    "SELECT id FROM corpus "
                    "WHERE composer_id = :cid AND slug = 'piano-sonatas'"
                ),
                {"cid": composer_id},
            )
        ).one()
        corpus_id = corpus_row.id

        work_row = (
            await db_session.execute(
                text("SELECT id FROM work " "WHERE corpus_id = :wid AND slug = 'k331'"),
                {"wid": corpus_id},
            )
        ).one()
        work_id = work_row.id

        mov1_row = (
            await db_session.execute(
                text(
                    "SELECT id, duration_bars, mei_object_key, key_signature, "
                    "normalization_warnings "
                    "FROM movement "
                    "WHERE work_id = :wid AND slug = 'movement-1'"
                ),
                {"wid": work_id},
            )
        ).one()
        mov2_row = (
            await db_session.execute(
                text(
                    "SELECT id, duration_bars FROM movement "
                    "WHERE work_id = :wid AND slug = 'movement-2'"
                ),
                {"wid": work_id},
            )
        ).one()

        # duration_bars = max @n in the fixture MEI files
        assert (
            mov1_row.duration_bars == 6
        ), f"Expected duration_bars=6 for movement-1, got {mov1_row.duration_bars}"
        assert (
            mov2_row.duration_bars == 5
        ), f"Expected duration_bars=5 for movement-2, got {mov2_row.duration_bars}"

        # MEI object key convention
        assert mov1_row.mei_object_key == (
            "test-mozart/piano-sonatas/k331/movement-1.mei"
        )

        # ── Assert MinIO: normalized + original MEI exist ─────────────
        from services.object_storage import make_storage_client

        storage = make_storage_client()
        norm_bytes = await storage.get_mei(
            "test-mozart/piano-sonatas/k331/movement-1.mei"
        )
        assert b"<mei" in norm_bytes

        orig_bytes = await storage.get_mei(
            "originals/test-mozart/piano-sonatas/k331/movement-1.mei"
        )
        assert b"<mei" in orig_bytes

        # ── Run _dcml_branch for both movements ────────────────────────
        # Build a lookup: movement_id → tsv_content from captured Celery calls.
        dispatch_by_movement: dict[str, str] = {
            c["movement_id"]: c["harmonies_tsv_content"] for c in dispatch_calls
        }

        movement_id_1 = str(mov1_row.id)
        movement_id_2 = str(mov2_row.id)

        await _dcml_branch(movement_id_1, dispatch_by_movement[movement_id_1])
        await _dcml_branch(movement_id_2, dispatch_by_movement[movement_id_2])

        # ── Assert movement_analysis.events ───────────────────────────
        # K331-1.tsv: 1 phrase-open row excluded → 6 chord events
        ma1_row = (
            await db_session.execute(
                text(
                    "SELECT events, music21_version "
                    "FROM movement_analysis "
                    "WHERE movement_id = :mid"
                ),
                {"mid": movement_id_1},
            )
        ).one()
        events1: list[dict[str, Any]] = ma1_row.events
        assert (
            len(events1) == 6
        ), f"Expected 6 events for K331 movement-1, got {len(events1)}"
        assert ma1_row.music21_version, "music21_version must be non-empty"

        # Spot-check: mc=2 → V7 from DCML
        mc2_events = [e for e in events1 if e.get("mc") == 2]
        assert (
            len(mc2_events) == 1
        ), f"Expected exactly 1 event at mc=2, got {mc2_events}"
        mc2 = mc2_events[0]
        assert (
            mc2["numeral"] == "V7"
        ), f"Expected numeral='V7' at mc=2, got {mc2['numeral']}"
        assert mc2["source"] == "DCML"
        assert mc2["auto"] is False
        assert mc2["reviewed"] is False

        # K331-2.tsv: 1 phrase-open row excluded → 5 chord events
        ma2_row = (
            await db_session.execute(
                text("SELECT events FROM movement_analysis WHERE movement_id = :mid"),
                {"mid": movement_id_2},
            )
        ).one()
        events2: list[dict[str, Any]] = ma2_row.events
        assert (
            len(events2) == 5
        ), f"Expected 5 events for K331 movement-2, got {len(events2)}"

        # Spot-check bVII in movement-2 (mc=4 in K331-2.tsv)
        mc4_events = [e for e in events2 if e.get("mc") == 4]
        assert len(mc4_events) == 1
        assert mc4_events[0]["root_accidental"] == "flat"
        assert mc4_events[0]["numeral"] == "VII"

        # ── key_signature back-filled from globalkey ──────────────────
        updated_mov1 = (
            await db_session.execute(
                text(
                    "SELECT key_signature, normalization_warnings "
                    "FROM movement WHERE id = :mid"
                ),
                {"mid": movement_id_1},
            )
        ).one()
        assert (
            updated_mov1.key_signature == "A major"
        ), f"Expected key_signature='A major', got {updated_mov1.key_signature!r}"

        # ── harmony_alignment_warnings must be absent / empty ─────────
        norm_warn = updated_mov1.normalization_warnings or {}
        harmony_warn = norm_warn.get("harmony_alignment_warnings", [])
        assert (
            harmony_warn == []
        ), f"Expected empty harmony_alignment_warnings, got: {harmony_warn}"

    # ------------------------------------------------------------------
    # Test 2 — idempotent re-upload
    # ------------------------------------------------------------------

    async def test_idempotent_reupload(
        self,
        integration_test_client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """Re-uploading the same ZIP must not create duplicate rows.

        Verifies:
        - Exactly one row per entity after two uploads.
        - movement.ingested_at advances on the second upload.
        - movement_analysis.updated_at advances on the second analysis run.
        - Event count is unchanged after the second run.
        """
        from services.tasks.ingest_analysis import _dcml_branch

        mei1 = (_MEI_DIR / "k331-movement-1.mei").read_bytes()
        tsv1 = (_HARMONIES_DIR / "K331-1.tsv").read_bytes()

        # Single-movement metadata for brevity.
        metadata = {
            "composer": _MAIN_METADATA["composer"],
            "corpus": {
                **{k: v for k, v in _MAIN_METADATA["corpus"].items() if k != "works"},
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
        archive = _build_zip(
            metadata,
            {
                "mei/k331/movement-1.mei": mei1,
                "harmonies/k331/movement-1.tsv": tsv1,
            },
        )

        async def _upload_and_run() -> tuple[str, str]:
            """Upload the archive and run _dcml_branch; return (movement_id, tsv)."""
            dispatch_calls: list[dict[str, Any]] = []

            def _capture(**kwargs: Any) -> None:
                dispatch_calls.append(kwargs)

            with (
                patch("services.ingestion.ingest_movement_analysis") as mock_task,
                patch("services.ingestion.generate_incipit") as mock_incipit,
            ):
                mock_task.delay = MagicMock(side_effect=_capture)
                mock_incipit.delay = MagicMock()
                resp = await integration_test_client.post(
                    "/api/v1/composers/test-mozart/corpora/piano-sonatas/upload",
                    files={"archive": ("corpus.zip", archive, "application/zip")},
                    headers={"Authorization": "Bearer dev-token"},
                )
            assert resp.status_code == 201, resp.text
            call = dispatch_calls[0]
            await _dcml_branch(call["movement_id"], call["harmonies_tsv_content"])
            return call["movement_id"], call["harmonies_tsv_content"]

        # ── First upload ──────────────────────────────────────────────
        movement_id, tsv_content = await _upload_and_run()

        ingested_at_1 = (
            await db_session.execute(
                text("SELECT ingested_at FROM movement WHERE id = :mid"),
                {"mid": movement_id},
            )
        ).scalar_one()
        ma_updated_at_1 = (
            await db_session.execute(
                text(
                    "SELECT updated_at FROM movement_analysis WHERE movement_id = :mid"
                ),
                {"mid": movement_id},
            )
        ).scalar_one()
        events_count_1 = len(
            (
                await db_session.execute(
                    text(
                        "SELECT events FROM movement_analysis WHERE movement_id = :mid"
                    ),
                    {"mid": movement_id},
                )
            )
            .one()
            .events
        )

        # ── Second upload ─────────────────────────────────────────────
        await _upload_and_run()

        ingested_at_2 = (
            await db_session.execute(
                text("SELECT ingested_at FROM movement WHERE id = :mid"),
                {"mid": movement_id},
            )
        ).scalar_one()
        ma_updated_at_2 = (
            await db_session.execute(
                text(
                    "SELECT updated_at FROM movement_analysis WHERE movement_id = :mid"
                ),
                {"mid": movement_id},
            )
        ).scalar_one()
        events_count_2 = len(
            (
                await db_session.execute(
                    text(
                        "SELECT events FROM movement_analysis WHERE movement_id = :mid"
                    ),
                    {"mid": movement_id},
                )
            )
            .one()
            .events
        )

        # Exactly one row per entity
        composer_count = (
            await db_session.execute(
                text("SELECT COUNT(*) FROM composer WHERE slug = 'test-mozart'")
            )
        ).scalar_one()
        corpus_count = (
            await db_session.execute(
                text(
                    "SELECT COUNT(*) FROM corpus "
                    "WHERE slug = 'piano-sonatas' "
                    "AND composer_id = (SELECT id FROM composer WHERE slug = 'test-mozart')"
                )
            )
        ).scalar_one()
        assert composer_count == 1, f"Expected 1 composer row, got {composer_count}"
        assert corpus_count == 1, f"Expected 1 corpus row, got {corpus_count}"

        # Timestamps advanced
        assert (
            ingested_at_2 >= ingested_at_1
        ), "movement.ingested_at should advance on re-upload"
        assert (
            ma_updated_at_2 >= ma_updated_at_1
        ), "movement_analysis.updated_at should advance on re-analysis"

        # Event count unchanged
        assert (
            events_count_2 == events_count_1
        ), f"Event count changed after re-upload: {events_count_1} → {events_count_2}"

    # ------------------------------------------------------------------
    # Test 3 — volta handling
    # ------------------------------------------------------------------

    async def test_volta_handling(
        self,
        integration_test_client: AsyncClient,
        db_session: AsyncSession,
    ) -> None:
        """Volta events carry distinct volta values; alignment warnings are empty.

        Uses a synthetic MEI with <ending n="1"> and <ending n="2">, each
        containing a measure with n="2".  The matching TSV has four events:
        mc=1 (mn=1, volta=None), mc=2 (mn=2, volta=1), mc=3 (mn=2, volta=2),
        mc=4 (mn=3, volta=None).

        All four (mn, volta) pairs must resolve in the MEI → no alignment warnings.
        Events at mn=2 must carry volta=1 and volta=2 respectively.
        """
        from services.tasks.ingest_analysis import _dcml_branch

        mei_volta = (_MEI_DIR / "volta-movement.mei").read_bytes()

        archive = _build_zip(
            _VOLTA_METADATA,
            {
                "mei/volta-work/movement-1.mei": mei_volta,
                "harmonies/volta-work/movement-1.tsv": _VOLTA_TSV,
            },
        )

        dispatch_calls: list[dict[str, Any]] = []

        def _capture(**kwargs: Any) -> None:
            dispatch_calls.append(kwargs)

        with (
            patch("services.ingestion.ingest_movement_analysis") as mock_task,
            patch("services.ingestion.generate_incipit") as mock_incipit,
        ):
            mock_task.delay = MagicMock(side_effect=_capture)
            mock_incipit.delay = MagicMock()
            response = await integration_test_client.post(
                "/api/v1/composers/test-mozart/corpora/piano-sonatas/upload",
                files={"archive": ("corpus.zip", archive, "application/zip")},
                headers={"Authorization": "Bearer dev-token"},
            )

        assert response.status_code == 201, response.text
        assert response.json()["movements_rejected"] == []
        assert mock_task.delay.call_count == 1
        assert mock_incipit.delay.call_count == 1

        call = dispatch_calls[0]
        movement_id = call["movement_id"]
        await _dcml_branch(movement_id, call["harmonies_tsv_content"])

        # ── Assert events ─────────────────────────────────────────────
        ma_row = (
            await db_session.execute(
                text("SELECT events FROM movement_analysis WHERE movement_id = :mid"),
                {"mid": movement_id},
            )
        ).one()
        events: list[dict[str, Any]] = ma_row.events

        assert len(events) == 4, f"Expected 4 events, got {len(events)}: {events}"

        # Two events at mn=2 with distinct volta values
        mn2_events = [e for e in events if e["mn"] == 2]
        assert len(mn2_events) == 2, f"Expected 2 events at mn=2, got {mn2_events}"
        volta_values = {e["volta"] for e in mn2_events}
        assert volta_values == {
            1,
            2,
        }, f"Expected volta values {{1, 2}} at mn=2, got {volta_values}"

        # Verify the specific numerals
        by_volta = {e["volta"]: e for e in mn2_events}
        assert by_volta[1]["numeral"] == "V"
        assert by_volta[2]["numeral"] == "IV"

        # ── No alignment warnings ──────────────────────────────────────
        norm_warn_row = (
            await db_session.execute(
                text("SELECT normalization_warnings FROM movement WHERE id = :mid"),
                {"mid": movement_id},
            )
        ).one()
        norm_warn = norm_warn_row.normalization_warnings or {}
        harmony_warn = norm_warn.get("harmony_alignment_warnings", [])
        assert (
            harmony_warn == []
        ), f"Expected no harmony_alignment_warnings, got: {harmony_warn}"


# ---------------------------------------------------------------------------
# Standalone regression test: per-invocation engine (Issue 1)
# ---------------------------------------------------------------------------


def test_dcml_branch_runs_twice_in_same_process() -> None:
    """asyncio.run(_dcml_branch) called twice in the same process must not crash.

    Regression test for the engine-caching bug described in Report 2 Issue 1.
    The old ``_get_session_factory()`` cached the SQLAlchemy engine at module
    level.  The second ``asyncio.run()`` call creates a new event loop, but the
    cached asyncpg connections are bound to the *previous* (now-closed) loop,
    causing ``RuntimeError: Event loop is closed``.

    With the per-invocation engine pattern (mirroring ``generate_incipit``),
    each call creates and disposes its own engine, so both calls succeed —
    they raise ``ValueError`` (movement not found for the fake UUID) rather
    than a ``RuntimeError``.

    Requires a live PostgreSQL instance (same as other integration tests).
    """
    import asyncio

    import pytest
    from services.tasks.ingest_analysis import _dcml_branch

    fake_id = "00000000-0000-0000-0000-000000000099"

    # First call: loop A opens and closes.
    with pytest.raises(ValueError, match="no movement found"):
        asyncio.run(_dcml_branch(fake_id, ""))

    # Second call: loop B.  With a cached engine bound to loop A this raises
    # RuntimeError('Event loop is closed').  With per-invocation engines it
    # raises the same ValueError as the first call.
    with pytest.raises(ValueError, match="no movement found"):
        asyncio.run(_dcml_branch(fake_id, ""))
