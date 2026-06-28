"""Unit tests for scripts/clef_audit.py.

The audit core (:func:`clef_audit.audit_clefs`) is pure — it works on MEI bytes,
so these tests need neither MuseScore nor Verovio.  They verify the A1/A2
detectors and the recovery-diagnostic pass-through.
"""

from __future__ import annotations

# clef_audit is importable because pyproject.toml adds "scripts/" to pytest's
# pythonpath; importing it bootstraps backend/ onto sys.path in turn.
import clef_audit

_MEI_NS = "http://www.music-encoding.org/ns/mei"
_XML_NS = "http://www.w3.org/XML/1998/namespace"


def _mei(measures: str) -> bytes:
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<mei xmlns="{_MEI_NS}"><music><body><mdiv><score>'
        f"<section>{measures}</section>"
        f"</score></mdiv></body></music></mei>"
    ).encode("utf-8")


def _measure(n: int, staff2_inner: str) -> str:
    return (
        f'<measure n="{n}">'
        f'<staff n="1"><layer n="1"><note dur="4" oct="4" pname="c"/></layer></staff>'
        f'<staff n="2">{staff2_inner}</staff>'
        f"</measure>"
    )


class TestAuditClean:
    """A well-formed single clef per layer raises no warnings."""

    def test_single_clef_passes(self) -> None:
        mei = _mei(
            _measure(
                1,
                '<layer n="1"><clef shape="G" line="2"/>'
                '<note dur="4" oct="3" pname="c"/></layer>',
            )
        )
        assert clef_audit.audit_clefs(mei, verbose=False) == []


class TestAuditA1DoubleClef:
    """A1 — a layer with two same-key clefs is a rendered double."""

    def test_duplicate_clef_warns(self) -> None:
        mei = _mei(
            _measure(
                1,
                '<layer n="1"><clef shape="F" line="4"/>'
                '<clef shape="F" line="4"/>'
                '<note dur="4" oct="3" pname="c"/></layer>',
            )
        )
        warnings = clef_audit.audit_clefs(mei, verbose=False)
        assert len(warnings) == 1
        assert warnings[0].startswith("A1:")
        assert "F/4" in warnings[0]

    def test_distinct_clefs_do_not_warn(self) -> None:
        # A genuine mid-measure change (G then F) is not a double.
        mei = _mei(
            _measure(
                1,
                '<layer n="1"><clef shape="G" line="2"/>'
                '<note dur="4" oct="3" pname="c"/>'
                '<clef shape="F" line="4"/>'
                '<note dur="4" oct="2" pname="c"/></layer>',
            )
        )
        assert clef_audit.audit_clefs(mei, verbose=False) == []


class TestAuditA2PerVoice:
    """A2 — a measure-start clef on some voices but not all."""

    def test_one_voice_missing_clef_warns(self) -> None:
        mei = _mei(
            _measure(
                1,
                '<layer n="1"><clef shape="G" line="2"/>'
                '<note dur="4" oct="3" pname="c"/></layer>'
                '<layer n="2"><note dur="4" oct="2" pname="c"/></layer>',
            )
        )
        warnings = clef_audit.audit_clefs(mei, verbose=False)
        assert len(warnings) == 1
        assert warnings[0].startswith("A2:")
        assert "layer" not in warnings[0] or "2" in warnings[0]

    def test_both_voices_clefed_passes(self) -> None:
        mei = _mei(
            _measure(
                1,
                '<layer n="1"><clef shape="G" line="2"/>'
                '<note dur="4" oct="3" pname="c"/></layer>'
                '<layer n="2"><clef shape="G" line="2"/>'
                '<note dur="4" oct="2" pname="c"/></layer>',
            )
        )
        assert clef_audit.audit_clefs(mei, verbose=False) == []


class TestAuditDiagnostics:
    """Recovery diagnostics are surfaced as findings."""

    def test_notes_passed_through(self) -> None:
        mei = _mei(
            _measure(
                1,
                '<layer n="1"><clef shape="G" line="2"/>'
                '<note dur="4" oct="3" pname="c"/></layer>',
            )
        )
        notes = ["clef recovery: ... falling back to global measure indexing"]
        warnings = clef_audit.audit_clefs(mei, notes, verbose=False)
        assert warnings == notes
