"""Unit tests for backend/services/ingestion.py.

All external I/O (database, object storage, MEI validator, MEI normalizer,
Celery) is mocked so no running infrastructure is required.

Test structure:

    TestZipParsing         — invalid archives, missing/bad metadata.yaml
    TestSlugCoherence      — URL slug vs metadata slug mismatches, ABC deny-list
    TestPerMovementValidation — validation failures: reject-and-continue, all-rejected
    TestCorpusCoherence    — duplicate catalogue_number
    TestObjectKeys         — correct S3 key construction for put_mei / put_mei_original
    TestStorageRollback    — storage failure propagates (DB rolls back implicitly)
    TestTaskDispatch       — Celery task dispatched per movement with correct args
    TestReport             — IngestionReport field correctness
"""

from __future__ import annotations

import io
import uuid
import zipfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
import yaml
from models.ingestion import IngestionReport
from models.normalization import NormalizationReport
from models.validation import ValidationIssue, ValidationReport
from services.ingestion import ingest_corpus

# ---------------------------------------------------------------------------
# Paths to fixtures
# ---------------------------------------------------------------------------

_FIXTURES = Path(__file__).parent.parent / "fixtures"
_ALREADY_CLEAN_MEI = _FIXTURES / "mei" / "normalizer" / "already_clean.mei"
_HARMONIES_TSV = _FIXTURES / "dcml-subset" / "harmonies" / "K331-1.tsv"


# ---------------------------------------------------------------------------
# Helpers: build in-memory ZIPs and metadata YAML dicts
# ---------------------------------------------------------------------------


def _minimal_metadata(
    *,
    composer_slug: str = "mozart",
    corpus_slug: str = "piano-sonatas",
    analysis_source: str = "DCML",
    licence: str = "CC-BY-SA-4.0",
    source_repository: str = "DCMLab/mozart_piano_sonatas",
    source_commit: str = "abc1234",
    works: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a minimal IngestMetadata-compatible dict."""
    if works is None:
        works = [
            {
                "slug": "k331",
                "title": "Piano Sonata No. 11 in A major, K. 331",
                "catalogue_number": "K. 331",
                "year_composed": 1783,
                "movements": [
                    {
                        "slug": "movement-1",
                        "movement_number": 1,
                        "title": "Andante grazioso",
                        "meter": "6/8",
                        "mei_filename": "mei/k331/movement-1.mei",
                        "harmonies_filename": "harmonies/k331/movement-1.tsv",
                    }
                ],
            }
        ]
    return {
        "composer": {
            "slug": composer_slug,
            "name": "Wolfgang Amadeus Mozart",
            "sort_name": "Mozart, Wolfgang Amadeus",
            "birth_year": 1756,
            "death_year": 1791,
            "nationality": "Austrian",
            "wikidata_id": "Q254",
        },
        "corpus": {
            "slug": corpus_slug,
            "title": "Piano Sonatas",
            "source_repository": source_repository,
            "source_commit": source_commit,
            "analysis_source": analysis_source,
            "licence": licence,
            "works": works,
        },
    }


def _build_zip(
    metadata: dict[str, Any],
    mei_bytes: bytes,
    harmonies_bytes: bytes | None = None,
    mei_path: str = "mei/k331/movement-1.mei",
    harmonies_path: str = "harmonies/k331/movement-1.tsv",
) -> bytes:
    """Build and return an in-memory ZIP with metadata.yaml and MEI file."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata.yaml", yaml.dump(metadata))
        zf.writestr(mei_path, mei_bytes)
        if harmonies_bytes is not None:
            zf.writestr(harmonies_path, harmonies_bytes)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# Fixtures: shared mocks
# ---------------------------------------------------------------------------


@pytest.fixture()
def valid_mei_bytes() -> bytes:
    """Return already_clean.mei — a known-good MEI file."""
    return _ALREADY_CLEAN_MEI.read_bytes()


@pytest.fixture()
def harmonies_bytes() -> bytes:
    """Return K331-1.tsv bytes."""
    return _HARMONIES_TSV.read_bytes()


@pytest.fixture()
def mock_db() -> AsyncMock:
    """Return a mock AsyncSession with a working begin() context manager
    and execute() that returns a scalar UUID per call."""
    db = AsyncMock()

    # Each execute() call returns a mock result whose scalar_one() is a new UUID.
    db.execute = AsyncMock(
        side_effect=lambda *a, **kw: MagicMock(
            scalar_one=MagicMock(return_value=uuid.uuid4())
        )
    )

    @asynccontextmanager
    async def _begin():
        yield

    db.begin = _begin
    return db


@pytest.fixture()
def mock_storage() -> AsyncMock:
    """Return a mock StorageClient with async no-op put methods."""
    storage = AsyncMock()
    storage.put_mei = AsyncMock()
    storage.put_mei_original = AsyncMock()
    return storage


def _mock_normalize_side_effect(src: str, dst: str) -> NormalizationReport:
    """Write src bytes to dst so that read_bytes() works; return clean report."""
    Path(dst).write_bytes(Path(src).read_bytes())
    return NormalizationReport(duration_bars=3, changes_applied=[], warnings=[])


# ---------------------------------------------------------------------------
# Module-level autouse fixture: suppress generate_incipit Celery dispatch
# ---------------------------------------------------------------------------
# All tests in this file call ingest_corpus() with mocked infrastructure.
# The new generate_incipit.delay() call added in Step 3 would try to connect
# to Redis (not available in unit tests) unless silenced here.
# TestTaskDispatch still verifies ingest_movement_analysis dispatch; a separate
# integration test covers generate_incipit dispatch.


@pytest.fixture(autouse=True)
def _mock_generate_incipit_delay():
    """Patch generate_incipit.delay for every unit test in this module."""
    with patch("services.ingestion.generate_incipit") as mock:
        mock.delay = MagicMock()
        yield mock


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestZipParsing:
    async def test_non_zip_bytes_raises_422(self, mock_db, mock_storage):
        from errors import IngestionError
        from models.errors import ErrorCode

        with pytest.raises(IngestionError) as exc_info:
            await ingest_corpus(
                "mozart", "piano-sonatas", b"not a zip", mock_db, mock_storage
            )
        assert exc_info.value.code == ErrorCode.INVALID_ZIP

    async def test_missing_metadata_yaml_raises_422(self, mock_db, mock_storage):
        from errors import IngestionError
        from models.errors import ErrorCode

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("readme.txt", "no metadata here")
        archive = buf.getvalue()

        with pytest.raises(IngestionError) as exc_info:
            await ingest_corpus(
                "mozart", "piano-sonatas", archive, mock_db, mock_storage
            )
        assert exc_info.value.code == ErrorCode.METADATA_PARSE_ERROR

    async def test_malformed_metadata_yaml_raises_422(self, mock_db, mock_storage):
        from errors import IngestionError
        from models.errors import ErrorCode

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("metadata.yaml", "slug: !!INVALID YAML [[[")
        archive = buf.getvalue()

        with pytest.raises(IngestionError) as exc_info:
            await ingest_corpus(
                "mozart", "piano-sonatas", archive, mock_db, mock_storage
            )
        assert exc_info.value.code == ErrorCode.METADATA_PARSE_ERROR

    async def test_invalid_metadata_schema_raises_422(
        self, valid_mei_bytes, mock_db, mock_storage, harmonies_bytes
    ):
        """metadata.yaml that parses as YAML but fails Pydantic."""
        from errors import IngestionError
        from models.errors import ErrorCode

        meta = _minimal_metadata()
        meta["corpus"]["licence"] = "NOT-A-REAL-SPDX"
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        with pytest.raises(IngestionError) as exc_info:
            await ingest_corpus(
                "mozart", "piano-sonatas", archive, mock_db, mock_storage
            )
        assert exc_info.value.code == ErrorCode.METADATA_PARSE_ERROR


class TestSlugCoherence:
    async def test_composer_slug_mismatch_raises_422(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        from errors import IngestionError
        from models.errors import ErrorCode

        meta = _minimal_metadata(composer_slug="mozart")
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        with pytest.raises(IngestionError) as exc_info:
            # URL slug is "beethoven" but metadata says "mozart"
            await ingest_corpus(
                "beethoven", "piano-sonatas", archive, mock_db, mock_storage
            )
        assert exc_info.value.code == ErrorCode.CORPUS_COHERENCE_ERROR

    async def test_corpus_slug_mismatch_raises_422(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        from errors import IngestionError
        from models.errors import ErrorCode

        meta = _minimal_metadata(corpus_slug="piano-sonatas")
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        with pytest.raises(IngestionError) as exc_info:
            await ingest_corpus(
                "mozart", "violin-sonatas", archive, mock_db, mock_storage
            )
        assert exc_info.value.code == ErrorCode.CORPUS_COHERENCE_ERROR

    async def test_abc_repository_raises_422(
        self, valid_mei_bytes, mock_db, mock_storage
    ):
        """ABC/Beethoven deny-list is enforced at Pydantic level → METADATA_PARSE_ERROR."""
        from errors import IngestionError
        from models.errors import ErrorCode

        meta = _minimal_metadata(
            composer_slug="beethoven",
            source_repository="DCMLab/abc/beethoven-quartets",
            analysis_source="DCML",
            licence="CC-BY-SA-4.0",
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("metadata.yaml", yaml.dump(meta))
        archive = buf.getvalue()

        with pytest.raises(IngestionError) as exc_info:
            await ingest_corpus(
                "beethoven", "piano-sonatas", archive, mock_db, mock_storage
            )
        # The ABC deny-list fires in Pydantic → caught as METADATA_PARSE_ERROR
        assert exc_info.value.code == ErrorCode.METADATA_PARSE_ERROR


class TestPerMovementValidation:
    async def test_invalid_mei_rejects_movement_continues(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        """A movement with invalid MEI is rejected; others are still processed."""
        meta = _minimal_metadata(
            works=[
                {
                    "slug": "k331",
                    "title": "Piano Sonata No. 11",
                    "movements": [
                        {
                            "slug": "movement-1",
                            "movement_number": 1,
                            "mei_filename": "mei/k331/movement-1.mei",
                            "harmonies_filename": "harmonies/k331/movement-1.tsv",
                        },
                        {
                            "slug": "movement-2",
                            "movement_number": 2,
                            "mei_filename": "mei/k331/movement-2.mei",
                            "harmonies_filename": "harmonies/k331/movement-2.tsv",
                        },
                    ],
                }
            ]
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("metadata.yaml", yaml.dump(meta))
            zf.writestr("mei/k331/movement-1.mei", valid_mei_bytes)  # good
            zf.writestr("mei/k331/movement-2.mei", b"not valid xml")  # bad
            zf.writestr("harmonies/k331/movement-1.tsv", harmonies_bytes)
            zf.writestr("harmonies/k331/movement-2.tsv", harmonies_bytes)
        archive = buf.getvalue()

        bad_report = ValidationReport(
            errors=[
                ValidationIssue(code="INVALID_XML", message="bad", severity="error")
            ]
        )
        call_count = 0

        def _validate(xml_bytes: bytes) -> ValidationReport:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return ValidationReport()  # movement-1 passes
            return bad_report  # movement-2 fails

        with patch("services.ingestion.validate_mei", side_effect=_validate):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with patch("services.ingestion.ingest_movement_analysis"):
                    report = await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )

        assert len(report.movements_accepted) == 1
        assert len(report.movements_rejected) == 1
        assert report.movements_accepted[0].movement_slug == "k331/movement-1"
        assert report.movements_rejected[0].movement_slug == "k331/movement-2"

    async def test_all_movements_rejected_raises_422(
        self, harmonies_bytes, mock_db, mock_storage
    ):
        from errors import IngestionError
        from models.errors import ErrorCode

        meta = _minimal_metadata()
        archive = _build_zip(meta, b"not valid xml", harmonies_bytes)

        bad_report = ValidationReport(
            errors=[
                ValidationIssue(code="INVALID_XML", message="bad", severity="error")
            ]
        )
        with patch("services.ingestion.validate_mei", return_value=bad_report):
            with pytest.raises(IngestionError) as exc_info:
                await ingest_corpus(
                    "mozart", "piano-sonatas", archive, mock_db, mock_storage
                )
        assert exc_info.value.code == ErrorCode.INVALID_MEI

    async def test_missing_mei_file_in_zip_rejects_movement(
        self, harmonies_bytes, mock_db, mock_storage
    ):
        """A movement whose mei_filename is absent in the ZIP is rejected."""
        meta = _minimal_metadata()
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("metadata.yaml", yaml.dump(meta))
            # intentionally omit the MEI file
            zf.writestr("harmonies/k331/movement-1.tsv", harmonies_bytes)
        archive = buf.getvalue()

        with patch("services.ingestion.validate_mei"):
            with patch("services.ingestion.ingest_movement_analysis"):
                with pytest.raises(Exception):
                    # All movements rejected → 422
                    await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )


class TestCorpusCoherence:
    async def test_duplicate_catalogue_number_raises_422(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        from errors import IngestionError
        from models.errors import ErrorCode

        meta = _minimal_metadata(
            works=[
                {
                    "slug": "k331",
                    "title": "K331",
                    "catalogue_number": "SHARED",
                    "movements": [
                        {
                            "slug": "movement-1",
                            "movement_number": 1,
                            "mei_filename": "mei/k331/movement-1.mei",
                            "harmonies_filename": "harmonies/k331/movement-1.tsv",
                        }
                    ],
                },
                {
                    "slug": "k332",
                    "title": "K332",
                    "catalogue_number": "SHARED",  # duplicate
                    "movements": [
                        {
                            "slug": "movement-1",
                            "movement_number": 1,
                            "mei_filename": "mei/k332/movement-1.mei",
                            "harmonies_filename": "harmonies/k332/movement-1.tsv",
                        }
                    ],
                },
            ]
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("metadata.yaml", yaml.dump(meta))
            zf.writestr("mei/k331/movement-1.mei", valid_mei_bytes)
            zf.writestr("mei/k332/movement-1.mei", valid_mei_bytes)
            zf.writestr("harmonies/k331/movement-1.tsv", harmonies_bytes)
            zf.writestr("harmonies/k332/movement-1.tsv", harmonies_bytes)
        archive = buf.getvalue()

        with patch("services.ingestion.validate_mei", return_value=ValidationReport()):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with pytest.raises(IngestionError) as exc_info:
                    await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )
        assert exc_info.value.code == ErrorCode.CORPUS_COHERENCE_ERROR
        assert "SHARED" in exc_info.value.message


class TestObjectKeys:
    async def test_put_mei_called_with_correct_key(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        meta = _minimal_metadata()
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        with patch("services.ingestion.validate_mei", return_value=ValidationReport()):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with patch("services.ingestion.ingest_movement_analysis"):
                    await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )

        mock_storage.put_mei.assert_called_once()
        key_arg = mock_storage.put_mei.call_args[0][0]
        assert key_arg == "mozart/piano-sonatas/k331/movement-1.mei"

    async def test_put_mei_original_called_with_correct_key(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        meta = _minimal_metadata()
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        with patch("services.ingestion.validate_mei", return_value=ValidationReport()):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with patch("services.ingestion.ingest_movement_analysis"):
                    await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )

        mock_storage.put_mei_original.assert_called_once()
        # put_mei_original receives the same key as put_mei (it adds originals/ internally)
        orig_key = mock_storage.put_mei_original.call_args[0][0]
        assert orig_key == "mozart/piano-sonatas/k331/movement-1.mei"


class TestStorageRollback:
    async def test_storage_failure_propagates(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        """When put_mei raises, the exception propagates out of the transaction."""
        meta = _minimal_metadata()
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)
        mock_storage.put_mei.side_effect = RuntimeError("S3 timeout")

        with patch("services.ingestion.validate_mei", return_value=ValidationReport()):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with pytest.raises(RuntimeError, match="S3 timeout"):
                    await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )


class TestTaskDispatch:
    async def test_task_dispatched_per_accepted_movement(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        meta = _minimal_metadata()
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        with patch("services.ingestion.validate_mei", return_value=ValidationReport()):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with patch("services.ingestion.ingest_movement_analysis") as mock_task:
                    mock_task.delay = MagicMock()
                    await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )

        mock_task.delay.assert_called_once()

    async def test_harmonies_content_passed_for_dcml_corpus(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        meta = _minimal_metadata(analysis_source="DCML")
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        with patch("services.ingestion.validate_mei", return_value=ValidationReport()):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with patch("services.ingestion.ingest_movement_analysis") as mock_task:
                    mock_task.delay = MagicMock()
                    await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )

        call_kwargs = mock_task.delay.call_args[1]
        assert call_kwargs["analysis_source"] == "DCML"
        assert call_kwargs["harmonies_tsv_content"] is not None
        assert "mc" in call_kwargs["harmonies_tsv_content"]  # TSV header column

    async def test_task_not_dispatched_for_rejected_movements(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        """Rejected movements must not trigger a Celery dispatch."""
        meta = _minimal_metadata()
        archive = _build_zip(meta, b"invalid xml", harmonies_bytes)
        bad_report = ValidationReport(
            errors=[
                ValidationIssue(code="INVALID_XML", message="bad", severity="error")
            ]
        )

        with patch("services.ingestion.validate_mei", return_value=bad_report):
            with patch("services.ingestion.ingest_movement_analysis") as mock_task:
                mock_task.delay = MagicMock()
                with pytest.raises(Exception):
                    await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )
        mock_task.delay.assert_not_called()


class TestReport:
    async def test_report_contains_accepted_slug(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        meta = _minimal_metadata()
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        with patch("services.ingestion.validate_mei", return_value=ValidationReport()):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with patch("services.ingestion.ingest_movement_analysis"):
                    report = await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )

        assert isinstance(report, IngestionReport)
        assert report.corpus == {
            "composer_slug": "mozart",
            "corpus_slug": "piano-sonatas",
        }
        assert len(report.movements_accepted) == 1
        assert report.movements_accepted[0].movement_slug == "k331/movement-1"
        assert report.movements_rejected == []

    async def test_source_commit_in_report(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        meta = _minimal_metadata(source_commit="deadbeef")
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        with patch("services.ingestion.validate_mei", return_value=ValidationReport()):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with patch("services.ingestion.ingest_movement_analysis"):
                    report = await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )

        assert report.source_commit == "deadbeef"

    async def test_normalization_warnings_in_accepted_entry(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        meta = _minimal_metadata()
        archive = _build_zip(meta, valid_mei_bytes, harmonies_bytes)

        def _normalize_with_warnings(src: str, dst: str) -> NormalizationReport:
            Path(dst).write_bytes(Path(src).read_bytes())
            return NormalizationReport(
                duration_bars=3,
                warnings=["Unpaired rptstart at measure 5"],
            )

        with patch("services.ingestion.validate_mei", return_value=ValidationReport()):
            with patch(
                "services.ingestion.normalize_mei", side_effect=_normalize_with_warnings
            ):
                with patch("services.ingestion.ingest_movement_analysis"):
                    report = await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )

        assert report.movements_accepted[0].warnings == [
            "Unpaired rptstart at measure 5"
        ]

    async def test_partial_accept_shows_rejected_entry(
        self, valid_mei_bytes, harmonies_bytes, mock_db, mock_storage
    ):
        """A ZIP with one valid and one invalid movement returns 201-compatible report."""
        meta = _minimal_metadata(
            works=[
                {
                    "slug": "k331",
                    "title": "K331",
                    "movements": [
                        {
                            "slug": "movement-1",
                            "movement_number": 1,
                            "mei_filename": "mei/k331/movement-1.mei",
                            "harmonies_filename": "harmonies/k331/movement-1.tsv",
                        },
                        {
                            "slug": "movement-2",
                            "movement_number": 2,
                            "mei_filename": "mei/k331/movement-2.mei",
                            "harmonies_filename": "harmonies/k331/movement-2.tsv",
                        },
                    ],
                }
            ]
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr("metadata.yaml", yaml.dump(meta))
            zf.writestr("mei/k331/movement-1.mei", valid_mei_bytes)
            zf.writestr("mei/k331/movement-2.mei", b"bad xml")
            zf.writestr("harmonies/k331/movement-1.tsv", harmonies_bytes)
            zf.writestr("harmonies/k331/movement-2.tsv", harmonies_bytes)
        archive = buf.getvalue()

        call_count = 0

        def _validate(xml_bytes: bytes) -> ValidationReport:
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return ValidationReport()
            return ValidationReport(
                errors=[
                    ValidationIssue(code="INVALID_XML", message="bad", severity="error")
                ]
            )

        with patch("services.ingestion.validate_mei", side_effect=_validate):
            with patch(
                "services.ingestion.normalize_mei",
                side_effect=_mock_normalize_side_effect,
            ):
                with patch("services.ingestion.ingest_movement_analysis"):
                    report = await ingest_corpus(
                        "mozart", "piano-sonatas", archive, mock_db, mock_storage
                    )

        assert len(report.movements_accepted) == 1
        assert len(report.movements_rejected) == 1
        assert report.movements_rejected[0].movement_slug == "k331/movement-2"
        assert report.movements_rejected[0].errors[0]["code"] == "INVALID_XML"
