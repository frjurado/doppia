"""Unit tests for the ingest_movement_analysis Celery task wrapper.

Verifies routing logic, argument validation, and that the task signature
matches what services/ingestion.py passes via .delay().  The inner async
function (_dcml_branch) is mocked so no database or object storage is needed.

Test structure:
    TestIngestMovementAnalysisRouting   — DCML, WhenInRome, music21_auto,
                                          none, unknown source
    TestIngestMovementAnalysisSignature — kwarg names match ingestion.py .delay() calls
"""

from __future__ import annotations

import uuid
from unittest.mock import patch

import pytest
from services.tasks.ingest_analysis import ingest_movement_analysis

# ---------------------------------------------------------------------------
# TestIngestMovementAnalysisRouting
# ---------------------------------------------------------------------------


class TestIngestMovementAnalysisRouting:
    """ingest_movement_analysis routes to the right branch for each analysis_source."""

    def test_dcml_calls_asyncio_run_with_dcml_branch(self) -> None:
        """DCML source calls asyncio.run(_dcml_branch(movement_id, tsv))."""
        movement_id = str(uuid.uuid4())
        tsv = "mc\tmn\n1\t1\n"

        with (
            patch("services.tasks.ingest_analysis.asyncio.run") as mock_run,
            patch("services.tasks.ingest_analysis._dcml_branch") as mock_branch,
        ):
            # asyncio.run is synchronous in the task; we just need to confirm it
            # is called with the coroutine returned by _dcml_branch.
            ingest_movement_analysis(
                movement_id=movement_id,
                analysis_source="DCML",
                harmonies_tsv_content=tsv,
            )

        mock_run.assert_called_once()
        mock_branch.assert_called_once_with(movement_id, tsv)

    def test_dcml_missing_tsv_raises_value_error(self) -> None:
        """DCML source with harmonies_tsv_content=None raises ValueError."""
        with pytest.raises(ValueError, match="harmonies_tsv_content is required"):
            ingest_movement_analysis(
                movement_id=str(uuid.uuid4()),
                analysis_source="DCML",
                harmonies_tsv_content=None,
            )

    def test_when_in_rome_raises_not_implemented(self) -> None:
        """WhenInRome raises NotImplementedError (deferred branch)."""
        with pytest.raises(NotImplementedError):
            ingest_movement_analysis(
                movement_id=str(uuid.uuid4()),
                analysis_source="WhenInRome",
            )

    def test_music21_auto_raises_not_implemented(self) -> None:
        """music21_auto raises NotImplementedError (deferred branch)."""
        with pytest.raises(NotImplementedError):
            ingest_movement_analysis(
                movement_id=str(uuid.uuid4()),
                analysis_source="music21_auto",
            )

    def test_none_source_returns_without_error(self) -> None:
        """analysis_source='none' is a no-op and returns None."""
        result = ingest_movement_analysis(
            movement_id=str(uuid.uuid4()),
            analysis_source="none",
        )
        assert result is None

    def test_unknown_source_raises_value_error(self) -> None:
        """An unrecognised analysis_source raises ValueError."""
        with pytest.raises(ValueError, match="Unknown analysis_source"):
            ingest_movement_analysis(
                movement_id=str(uuid.uuid4()),
                analysis_source="bogus",  # type: ignore[arg-type]
            )


# ---------------------------------------------------------------------------
# TestIngestMovementAnalysisSignature
# ---------------------------------------------------------------------------


class TestIngestMovementAnalysisSignature:
    """Task signature matches what services/ingestion.py passes via .delay().

    services/ingestion.py calls:
        ingest_movement_analysis.delay(
            movement_id=str(entry.movement_id),
            analysis_source=entry.analysis_source,
            harmonies_tsv_content=...,
        )

    If these kwarg names drift from the task signature, Celery silently routes
    the task but the inner function receives unexpected arguments.  This test
    pins the contract so a rename fails fast.
    """

    def test_accepts_movement_id_kwarg(self) -> None:
        """Task accepts movement_id as a keyword argument."""
        with (
            patch("services.tasks.ingest_analysis.asyncio.run"),
            patch("services.tasks.ingest_analysis._dcml_branch"),
        ):
            # Should not raise TypeError.
            ingest_movement_analysis(
                movement_id=str(uuid.uuid4()),
                analysis_source="none",
            )

    def test_accepts_analysis_source_kwarg(self) -> None:
        """Task accepts analysis_source as a keyword argument."""
        with (
            patch("services.tasks.ingest_analysis.asyncio.run"),
            patch("services.tasks.ingest_analysis._dcml_branch"),
        ):
            ingest_movement_analysis(
                movement_id=str(uuid.uuid4()),
                analysis_source="none",
            )

    def test_accepts_harmonies_tsv_content_kwarg(self) -> None:
        """Task accepts harmonies_tsv_content as a keyword argument (optional)."""
        with (
            patch("services.tasks.ingest_analysis.asyncio.run"),
            patch("services.tasks.ingest_analysis._dcml_branch"),
        ):
            ingest_movement_analysis(
                movement_id=str(uuid.uuid4()),
                analysis_source="none",
                harmonies_tsv_content=None,
            )

    def test_harmonies_tsv_content_defaults_to_none(self) -> None:
        """harmonies_tsv_content has a default of None (matches ingestion.py)."""
        import inspect

        sig = inspect.signature(ingest_movement_analysis)
        param = sig.parameters.get("harmonies_tsv_content")
        assert param is not None, "harmonies_tsv_content parameter must exist"
        assert param.default is None, (
            "harmonies_tsv_content must default to None so non-DCML callers "
            "can omit it"
        )
