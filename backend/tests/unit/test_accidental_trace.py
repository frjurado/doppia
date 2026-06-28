"""Unit tests for scripts/accidental_trace.py.

The audit core (:func:`accidental_trace.trace_accidentals`) is pure — it derives
the realised alteration from each note's own encoded ``accid``/``accid.ges`` (the
proven Verovio engine model) and the expected alteration from staff+octave-scoped
convention, so these tests need neither MuseScore nor Verovio.
"""

from __future__ import annotations

# accidental_trace is importable because pyproject.toml adds "scripts/" to
# pytest's pythonpath; importing it bootstraps backend/ onto sys.path in turn.
import accidental_trace

_MEI_NS = "http://www.music-encoding.org/ns/mei"


def _mei(staff_inner: str, key_sig: str = "0") -> bytes:
    return (
        f'<?xml version="1.0" encoding="UTF-8"?>'
        f'<mei xmlns="{_MEI_NS}"><music><body><mdiv><score>'
        f'<scoreDef meter.count="4" meter.unit="4" key.sig="{key_sig}">'
        f'<staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>'
        f'<staffDef n="2" lines="5" clef.shape="F" clef.line="4"/></staffGrp></scoreDef>'
        f'<section><measure n="1">{staff_inner}</measure></section>'
        f"</score></mdiv></body></music></mei>"
    ).encode("utf-8")


class TestAuditClean:
    """A correctly encoded document raises no mismatch."""

    def test_keysig_flat_with_ges_passes(self) -> None:
        # F major: a B with accid.ges='f' matches the key sig.
        mei = _mei(
            '<staff n="1"><layer n="1">'
            '<note xml:id="n1" dur.ppq="96" dur="1" oct="4" pname="b">'
            '<accid accid.ges="f"/></note></layer></staff>',
            key_sig="1f",
        )
        assert accidental_trace.audit_accidentals(mei, verbose=False) == []


class TestAuditSuppression:
    """A key-sig flat suppressed to natural is a mismatch."""

    def test_suppressed_flat_flagged(self) -> None:
        # F major: a B with no accid.ges sounds natural but should be flat.
        mei = _mei(
            '<staff n="1"><layer n="1">'
            '<note xml:id="b4" dur.ppq="96" dur="1" oct="4" pname="b"/>'
            "</layer></staff>",
            key_sig="1f",
        )
        mismatches = accidental_trace.audit_accidentals(mei, verbose=False)
        assert len(mismatches) == 1
        assert mismatches[0].xml_id == "b4"
        assert mismatches[0].expected == -1 and mismatches[0].realised == 0


class TestAuditCrossVoice:
    """An explicit accidental binds a same-pitch note in another voice."""

    def test_cross_voice_carry_flagged(self) -> None:
        # C major: voice 1 C#5, voice 2 bare C5 (same onset) — C5 should be sharp.
        mei = _mei(
            '<staff n="1">'
            '<layer n="1"><note xml:id="cs5" dur.ppq="48" dur="2" oct="5" pname="c">'
            '<accid accid="s" accid.ges="s"/></note></layer>'
            '<layer n="2"><note xml:id="c5" dur.ppq="48" dur="2" oct="5" pname="c"/>'
            "</layer></staff>"
        )
        mismatches = accidental_trace.audit_accidentals(mei, verbose=False)
        assert [m.xml_id for m in mismatches] == ["c5"]
        assert mismatches[0].expected == 1 and mismatches[0].realised == 0


class TestAuditBackwardBleed:
    """A sharp must not bind an earlier-onset note in another voice."""

    def test_backward_sharp_flagged(self) -> None:
        # Voice 1 rests then notates G#4; voice 2 g4 (earlier) wrongly sounds sharp.
        mei = _mei(
            '<staff n="1">'
            '<layer n="1"><rest dur.ppq="24" dur="4"/>'
            '<note xml:id="gs4" dur.ppq="24" dur="4" oct="4" pname="g">'
            '<accid accid="s" accid.ges="s"/></note></layer>'
            '<layer n="2"><note xml:id="g4e" dur.ppq="24" dur="4" oct="4" pname="g">'
            '<accid accid.ges="s"/></note><rest dur.ppq="24" dur="4"/></layer></staff>'
        )
        mismatches = accidental_trace.audit_accidentals(mei, verbose=False)
        assert [m.xml_id for m in mismatches] == ["g4e"]
        assert mismatches[0].expected == 0 and mismatches[0].realised == 1


class TestAuditTieInherits:
    """A tie continuation inherits its start's alteration and is not flagged."""

    def test_tied_flat_not_flagged(self) -> None:
        # C major: Bb (explicit) tied to a continuation carrying accid.ges='f'.
        mei = (
            f'<?xml version="1.0" encoding="UTF-8"?>'
            f'<mei xmlns="{_MEI_NS}"><music><body><mdiv><score>'
            f'<scoreDef meter.count="4" meter.unit="4" key.sig="0"><staffGrp>'
            f'<staffDef n="1" lines="5" clef.shape="G" clef.line="2"/></staffGrp></scoreDef>'
            f"<section>"
            f'<measure n="1"><staff n="1"><layer n="1">'
            f'<note xml:id="bf_start" dur.ppq="96" dur="1" oct="4" pname="b">'
            f'<accid accid="f" accid.ges="f"/></note></layer></staff>'
            f'<tie startid="#bf_start" endid="#bf_cont"/></measure>'
            f'<measure n="2"><staff n="1"><layer n="1">'
            f'<note xml:id="bf_cont" dur.ppq="96" dur="1" oct="4" pname="b">'
            f'<accid accid.ges="f"/></note></layer></staff></measure>'
            f"</section></score></mdiv></body></music></mei>"
        ).encode("utf-8")
        # bf_cont sounds flat (tie) though C-major default is natural — no mismatch.
        assert accidental_trace.audit_accidentals(mei, verbose=False) == []
