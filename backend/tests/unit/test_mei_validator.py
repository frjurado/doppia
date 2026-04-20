"""Unit tests for the MEI validation pipeline.

Tests run against minimal hand-written MEI fixtures in
``tests/fixtures/mei/``.  No Docker required.
"""

from __future__ import annotations

from pathlib import Path

from services.mei_validator import validate_mei

FIXTURES = Path(__file__).parent.parent / "fixtures" / "mei"


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_valid_mei_passes() -> None:
    """A well-formed, schema-compliant MEI file with notes passes all checks."""
    report = validate_mei((FIXTURES / "valid.mei").read_bytes())
    assert report.is_valid
    assert report.errors == []
    assert report.warnings == []


# ---------------------------------------------------------------------------
# Hard errors — file rejected
# ---------------------------------------------------------------------------


def test_invalid_xml_rejected() -> None:
    """A file with an unclosed tag fails check 1 (INVALID_XML)."""
    report = validate_mei((FIXTURES / "invalid_xml.mei").read_bytes())
    assert not report.is_valid
    assert report.errors[0].code == "INVALID_XML"


def test_schema_violation_rejected() -> None:
    """A file with an unknown root element fails check 2 (SCHEMA_VIOLATION)."""
    report = validate_mei((FIXTURES / "schema_violation.mei").read_bytes())
    assert not report.is_valid
    assert report.errors[0].code == "SCHEMA_VIOLATION"


def test_no_notes_rejected() -> None:
    """A valid MEI with no <note> or <rest> elements fails check 5 (ENCODING_EMPTY)."""
    report = validate_mei((FIXTURES / "no_notes.mei").read_bytes())
    assert not report.is_valid
    assert report.errors[0].code == "ENCODING_EMPTY"


# ---------------------------------------------------------------------------
# Warnings — file accepted but flagged
# ---------------------------------------------------------------------------


def test_duplicate_measure_n_warns() -> None:
    """Two measures outside <ending> with the same @n produce a MEASURE_NUMBER_ERROR warning."""
    report = validate_mei((FIXTURES / "duplicate_measure_n.mei").read_bytes())
    assert report.is_valid
    codes = [i.code for i in report.warnings]
    assert "MEASURE_NUMBER_ERROR" in codes


def test_non_integer_measure_n_warns() -> None:
    """A measure with @n='12a' outside <ending> produces a MEASURE_NUMBER_ERROR warning."""
    report = validate_mei((FIXTURES / "non_integer_measure_n.mei").read_bytes())
    assert report.is_valid
    codes = [i.code for i in report.warnings]
    assert "MEASURE_NUMBER_ERROR" in codes


def test_large_gap_measure_n_warns() -> None:
    """A gap of 14 in the @n sequence (1→15) produces a MEASURE_NUMBER_ERROR warning."""
    report = validate_mei((FIXTURES / "large_gap_measure_n.mei").read_bytes())
    assert report.is_valid
    codes = [i.code for i in report.warnings]
    assert "MEASURE_NUMBER_ERROR" in codes


def test_staff_count_mismatch_warns() -> None:
    """A measure with fewer <staff> children than <scoreDef> declares produces STAFF_COUNT_MISMATCH."""
    report = validate_mei((FIXTURES / "staff_count_mismatch.mei").read_bytes())
    assert report.is_valid
    codes = [i.code for i in report.warnings]
    assert "STAFF_COUNT_MISMATCH" in codes
