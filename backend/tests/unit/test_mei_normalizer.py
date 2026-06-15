"""Unit tests for the MEI normalization pipeline.

Each test covers one normalization rule and asserts both the expected
transformation (or flag) AND idempotence: running the normalizer a second
time on the output produces byte-identical output and ``is_clean=True``.

Fixtures live in ``backend/tests/fixtures/mei/normalizer/``.  They are
minimal hand-written MEI snippets; they are not required to pass the
RelaxNG schema check because the normalizer runs after validation and
its unit tests bypass the validator.
"""

from __future__ import annotations

from pathlib import Path

import lxml.etree
from services.mei_normalizer import normalize_mei

# ---------------------------------------------------------------------------
# Fixture helpers
# ---------------------------------------------------------------------------

_FIXTURE_DIR = Path(__file__).parent.parent / "fixtures" / "mei" / "normalizer"


def _fixture(name: str) -> Path:
    """Return the absolute path to a normalizer fixture file.

    Args:
        name: Filename within the normalizer fixture directory.

    Returns:
        Absolute :class:`~pathlib.Path` to the fixture.
    """
    p = _FIXTURE_DIR / name
    assert p.exists(), f"Missing fixture: {p}"
    return p


def _run(tmp_path: Path, fixture_name: str) -> tuple[str, bytes]:
    """Normalize *fixture_name* into *tmp_path* and return (report, raw_bytes).

    Args:
        tmp_path: pytest ``tmp_path`` fixture — a temporary directory.
        fixture_name: Filename of the MEI fixture to normalize.

    Returns:
        A tuple ``(report, output_bytes)`` where *report* is the
        :class:`~models.normalization.NormalizationReport` and
        *output_bytes* is the raw content of the output file.
    """
    src = _fixture(fixture_name)
    dst = tmp_path / fixture_name
    report = normalize_mei(str(src), str(dst))
    output_bytes = dst.read_bytes()
    return report, output_bytes


def _round_trip(tmp_path: Path, first_output: bytes, fixture_name: str) -> bytes:
    """Run the normalizer a second time on *first_output* and return the result.

    Asserts that the second pass applies *no* auto-corrections (``changes_applied``
    must be empty).  Persistent warnings are allowed — a file with a genuine
    structural problem (e.g. duplicate ``@n``) will keep warning on every pass;
    idempotence only requires that the *output bytes* are identical and no
    further *mutations* occur.

    Args:
        tmp_path: pytest ``tmp_path`` fixture.
        first_output: Raw bytes from the first normalization pass.
        fixture_name: Used only to name the intermediate file.

    Returns:
        Raw bytes produced by the second normalization pass.
    """
    src2 = tmp_path / f"second_{fixture_name}"
    src2.write_bytes(first_output)
    dst2 = tmp_path / f"second_out_{fixture_name}"
    report2 = normalize_mei(str(src2), str(dst2))
    assert (
        report2.changes_applied == []
    ), f"Second pass applied changes (idempotence failure): {report2.changes_applied}"
    return dst2.read_bytes()


# ---------------------------------------------------------------------------
# Pass 1 — Pickup bar
# ---------------------------------------------------------------------------


class TestPickupBar:
    """Pass 1: pickup bar encoding."""

    def test_n1_renumbered_to_n0(self, tmp_path: Path) -> None:
        """Pickup with @n='1' is renamed to @n='0'; subsequent measures decrease by 1."""
        report, out_bytes = _run(tmp_path, "pickup_bar_n1.mei")

        tree = lxml.etree.fromstring(out_bytes)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        measures = tree.xpath("//mei:measure[not(ancestor::mei:ending)]", namespaces=ns)

        assert measures[0].get("n") == "0"
        assert measures[0].get("metcon") == "false"
        assert measures[1].get("n") == "1"
        assert measures[2].get("n") == "2"
        assert any(
            "pickup" in c.lower() or "renumber" in c.lower()
            for c in report.changes_applied
        )

    def test_n1_pickup_idempotent(self, tmp_path: Path) -> None:
        """Renumbered pickup: second pass is byte-identical and clean."""
        _, first_out = _run(tmp_path, "pickup_bar_n1.mei")
        second_out = _round_trip(tmp_path, first_out, "pickup_bar_n1.mei")
        assert first_out == second_out

    def test_n0_missing_metcon_set(self, tmp_path: Path) -> None:
        """Pickup already @n='0' but missing @metcon gets @metcon='false' added."""
        report, out_bytes = _run(tmp_path, "pickup_bar_no_metcon.mei")

        tree = lxml.etree.fromstring(out_bytes)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        first_measure = tree.xpath("//mei:measure", namespaces=ns)[0]

        assert first_measure.get("n") == "0"
        assert first_measure.get("metcon") == "false"
        assert report.changes_applied  # some change was recorded

    def test_n0_missing_metcon_idempotent(self, tmp_path: Path) -> None:
        """After setting @metcon, second pass is byte-identical and clean."""
        _, first_out = _run(tmp_path, "pickup_bar_no_metcon.mei")
        second_out = _round_trip(tmp_path, first_out, "pickup_bar_no_metcon.mei")
        assert first_out == second_out


# ---------------------------------------------------------------------------
# Pass 2 — Meter change propagation
# ---------------------------------------------------------------------------


class TestMeterChangePropagation:
    """Pass 2: meterSig insertion for staffDef meter changes."""

    def test_metersig_inserted(self, tmp_path: Path) -> None:
        """A <meterSig> is inserted as first child of the measure with <staffDef>."""
        report, out_bytes = _run(tmp_path, "meter_change_staffdef.mei")

        tree = lxml.etree.fromstring(out_bytes)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        # Measure 2 contains the staffDef with meter change
        measures = tree.xpath("//mei:measure", namespaces=ns)
        measure2 = measures[1]
        meter_sigs = measure2.xpath("mei:meterSig", namespaces=ns)

        assert len(meter_sigs) == 1
        assert meter_sigs[0].get("count") == "3"
        assert meter_sigs[0].get("unit") == "4"
        # It should be the first child
        assert measure2[0].tag.endswith("}meterSig")
        assert any("meterSig" in c for c in report.changes_applied)

    def test_metersig_not_doubled(self, tmp_path: Path) -> None:
        """Running normalizer twice does not insert a second <meterSig>."""
        _, first_out = _run(tmp_path, "meter_change_staffdef.mei")

        tree = lxml.etree.fromstring(first_out)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        measures = tree.xpath("//mei:measure", namespaces=ns)
        meter_sigs_after_1st = measures[1].xpath("mei:meterSig", namespaces=ns)
        assert len(meter_sigs_after_1st) == 1

    def test_metersig_idempotent(self, tmp_path: Path) -> None:
        """Second pass is byte-identical."""
        _, first_out = _run(tmp_path, "meter_change_staffdef.mei")
        second_out = _round_trip(tmp_path, first_out, "meter_change_staffdef.mei")
        assert first_out == second_out


# ---------------------------------------------------------------------------
# Pass 3 — <ending> @n assignment
# ---------------------------------------------------------------------------


class TestEndingNs:
    """Pass 3: ending @n auto-assignment and structural checks."""

    def test_sequential_n_assigned(self, tmp_path: Path) -> None:
        """Endings without @n are assigned 1, 2 in document order."""
        report, out_bytes = _run(tmp_path, "ending_no_n.mei")

        tree = lxml.etree.fromstring(out_bytes)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        endings = tree.xpath("//mei:ending", namespaces=ns)

        assert endings[0].get("n") == "1"
        assert endings[1].get("n") == "2"
        assert any("Assigned" in c for c in report.changes_applied)

    def test_sequential_assignment_idempotent(self, tmp_path: Path) -> None:
        """After assignment, second pass leaves @n values unchanged."""
        _, first_out = _run(tmp_path, "ending_no_n.mei")
        second_out = _round_trip(tmp_path, first_out, "ending_no_n.mei")
        assert first_out == second_out

    def test_non_sequential_endings_warned(self, tmp_path: Path) -> None:
        """Endings with @n=[1,3] (missing 2) produce a warning."""
        report, _ = _run(tmp_path, "ending_non_sequential.mei")
        assert any("sequential" in w.lower() for w in report.warnings)

    def test_non_sequential_idempotent(self, tmp_path: Path) -> None:
        """Non-sequential endings: second pass is byte-identical."""
        _, first_out = _run(tmp_path, "ending_non_sequential.mei")
        second_out = _round_trip(tmp_path, first_out, "ending_non_sequential.mei")
        assert first_out == second_out


# ---------------------------------------------------------------------------
# Pass 4 — Repeat-barline pairing
# ---------------------------------------------------------------------------


class TestRepeatBarlinePairing:
    """Pass 4: repeat barline pairing checks."""

    def test_first_rptend_unpaired_no_warning(self, tmp_path: Path) -> None:
        """The first rptend without a preceding rptstart is allowed — no warning."""
        report, _ = _run(tmp_path, "rptend_unpaired_first.mei")
        paired_warnings = [
            w
            for w in report.warnings
            if "unpaired" in w.lower() or "unmatched" in w.lower()
        ]
        assert paired_warnings == []

    def test_first_rptend_idempotent(self, tmp_path: Path) -> None:
        """First unpaired rptend: second pass byte-identical."""
        _, first_out = _run(tmp_path, "rptend_unpaired_first.mei")
        second_out = _round_trip(tmp_path, first_out, "rptend_unpaired_first.mei")
        assert first_out == second_out

    def test_second_rptend_unpaired_warns(self, tmp_path: Path) -> None:
        """Second rptend without a preceding rptstart produces a warning."""
        report, _ = _run(tmp_path, "rptend_unpaired_second.mei")
        assert any("unpaired" in w.lower() for w in report.warnings)

    def test_second_rptend_idempotent(self, tmp_path: Path) -> None:
        """Second unpaired rptend: second pass byte-identical."""
        _, first_out = _run(tmp_path, "rptend_unpaired_second.mei")
        second_out = _round_trip(tmp_path, first_out, "rptend_unpaired_second.mei")
        assert first_out == second_out

    def test_rptstart_no_close_warns(self, tmp_path: Path) -> None:
        """An rptstart with no matching rptend produces a warning."""
        report, _ = _run(tmp_path, "rptstart_no_close.mei")
        assert any(
            "unclosed" in w.lower() or "rptstart" in w.lower() for w in report.warnings
        )

    def test_rptstart_no_close_idempotent(self, tmp_path: Path) -> None:
        """Unclosed rptstart: second pass byte-identical."""
        _, first_out = _run(tmp_path, "rptstart_no_close.mei")
        second_out = _round_trip(tmp_path, first_out, "rptstart_no_close.mei")
        assert first_out == second_out

    def test_rptboth_no_warning(self, tmp_path: Path) -> None:
        """rptboth is a valid close+open event; no pairing errors expected."""
        report, _ = _run(tmp_path, "rptboth.mei")
        paired_warnings = [
            w
            for w in report.warnings
            if "unpaired" in w.lower() or "unclosed" in w.lower()
        ]
        assert paired_warnings == []

    def test_rptboth_idempotent(self, tmp_path: Path) -> None:
        """rptboth file: second pass byte-identical."""
        _, first_out = _run(tmp_path, "rptboth.mei")
        second_out = _round_trip(tmp_path, first_out, "rptboth.mei")
        assert first_out == second_out


# ---------------------------------------------------------------------------
# Pass 5 — @n uniqueness outside <ending>
# ---------------------------------------------------------------------------


class TestMeasureNOutsideEndings:
    """Pass 5: @n uniqueness, non-integer values, and gap checks."""

    def test_duplicate_n_warns(self, tmp_path: Path) -> None:
        """Duplicate @n=2 outside endings produces a warning."""
        report, _ = _run(tmp_path, "duplicate_n_outside_ending.mei")
        assert any("duplicate" in w.lower() for w in report.warnings)

    def test_duplicate_n_idempotent(self, tmp_path: Path) -> None:
        """Duplicate @n: second pass byte-identical (no mutations in pass 5)."""
        _, first_out = _run(tmp_path, "duplicate_n_outside_ending.mei")
        second_out = _round_trip(tmp_path, first_out, "duplicate_n_outside_ending.mei")
        assert first_out == second_out

    def test_non_integer_n_outside_ending_warns(self, tmp_path: Path) -> None:
        """Non-integer @n='12a' outside ending produces a warning (not corrected)."""
        report, out_bytes = _run(tmp_path, "non_integer_n_outside_ending.mei")

        # The @n should NOT be corrected (pass 5 is flag-only)
        tree = lxml.etree.fromstring(out_bytes)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        bare_measures = tree.xpath(
            "//mei:measure[not(ancestor::mei:ending)]", namespaces=ns
        )
        n_values = [m.get("n") for m in bare_measures]
        assert (
            "12a" in n_values
        ), "Pass 5 should NOT strip suffix from @n outside endings"
        assert any("non-integer" in w.lower() or "12a" in w for w in report.warnings)

    def test_non_integer_n_idempotent(self, tmp_path: Path) -> None:
        """Non-integer @n outside ending: second pass byte-identical."""
        _, first_out = _run(tmp_path, "non_integer_n_outside_ending.mei")
        second_out = _round_trip(
            tmp_path, first_out, "non_integer_n_outside_ending.mei"
        )
        assert first_out == second_out

    def test_large_gap_warns(self, tmp_path: Path) -> None:
        """Gap of 14 (from @n=1 to @n=15) produces a warning."""
        report, _ = _run(tmp_path, "large_gap_n.mei")
        assert any("gap" in w.lower() for w in report.warnings)

    def test_large_gap_idempotent(self, tmp_path: Path) -> None:
        """Large gap: second pass byte-identical."""
        _, first_out = _run(tmp_path, "large_gap_n.mei")
        second_out = _round_trip(tmp_path, first_out, "large_gap_n.mei")
        assert first_out == second_out


# ---------------------------------------------------------------------------
# Pass 6 — @n inside <ending> elements
# ---------------------------------------------------------------------------


class TestEndingMeasureNs:
    """Pass 6: suffix stripping and duplicate detection within endings."""

    def test_suffix_stripped(self, tmp_path: Path) -> None:
        """@n='2a' and @n='2b' inside endings are stripped to '2'."""
        report, out_bytes = _run(tmp_path, "ending_suffix_n.mei")

        tree = lxml.etree.fromstring(out_bytes)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        ending_measures = tree.xpath("//mei:ending/mei:measure", namespaces=ns)
        n_values = [m.get("n") for m in ending_measures]

        assert "2" in n_values
        assert "2a" not in n_values
        assert "2b" not in n_values
        assert any(
            "suffix" in c.lower() or "stripped" in c.lower()
            for c in report.changes_applied
        )

    def test_suffix_stripped_idempotent(self, tmp_path: Path) -> None:
        """After suffix stripping, second pass is byte-identical."""
        _, first_out = _run(tmp_path, "ending_suffix_n.mei")
        second_out = _round_trip(tmp_path, first_out, "ending_suffix_n.mei")
        assert first_out == second_out

    def test_duplicate_within_ending_warns(self, tmp_path: Path) -> None:
        """Two measures with @n=2 inside the same ending produce a warning."""
        report, _ = _run(tmp_path, "ending_duplicate_n_within.mei")
        assert any("duplicate" in w.lower() for w in report.warnings)

    def test_duplicate_across_endings_no_warn(self, tmp_path: Path) -> None:
        """@n=2 appearing in ending n='1' and ending n='2' is expected — no warning."""
        report, _ = _run(tmp_path, "ending_suffix_n.mei")
        # After stripping, both endings have @n=2 — this is the shared-slot convention.
        cross_ending_warnings = [w for w in report.warnings if "duplicate" in w.lower()]
        assert cross_ending_warnings == []


# ---------------------------------------------------------------------------
# Pass 7 — Incomplete measures at repeat boundaries
# ---------------------------------------------------------------------------


class TestSplitMeasures:
    """Pass 7: complement @metcon propagation and @join validation.

    Fixture layout:

    ``split_measure_no_metcon.mei``
      m1(n=1) — m2(n=2, rptstart) — m3(n=3, complement) — m4(n=4, rptend, metcon=false)
      The rptend at m4 is paired with rptstart at m2.  The complement is m3
      (first measure after m2).  m3 lacks ``@metcon='false'`` → normalizer sets it.

    ``split_measure_no_complement.mei``
      m1(n=1, rptend, metcon=false) — m2(n=2)
      The rptend at m1 is the first close *and* is at document index 0.
      No complement can be identified → warning.
    """

    def test_complement_metcon_set(self, tmp_path: Path) -> None:
        """Complement (m3) gets @metcon='false'; close (m4) already has it."""
        report, out_bytes = _run(tmp_path, "split_measure_no_metcon.mei")

        tree = lxml.etree.fromstring(out_bytes)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        measures = tree.xpath("//mei:measure", namespaces=ns)

        # m3 (index 2, first after rptstart at m2) should now carry @metcon='false'
        assert (
            measures[2].get("metcon") == "false"
        ), "Complement measure (m3) should have @metcon='false' after normalization"
        assert any("metcon" in c.lower() for c in report.changes_applied)

    def test_complement_metcon_set_idempotent(self, tmp_path: Path) -> None:
        """After metcon correction, second pass is byte-identical."""
        _, first_out = _run(tmp_path, "split_measure_no_metcon.mei")
        second_out = _round_trip(tmp_path, first_out, "split_measure_no_metcon.mei")
        assert first_out == second_out

    def test_no_complement_warns(self, tmp_path: Path) -> None:
        """When the close rptend is the very first measure, no complement exists → warn."""
        report, _ = _run(tmp_path, "split_measure_no_complement.mei")
        assert any("complement" in w.lower() for w in report.warnings)

    def test_no_complement_idempotent(self, tmp_path: Path) -> None:
        """No-complement warning case: second pass byte-identical."""
        _, first_out = _run(tmp_path, "split_measure_no_complement.mei")
        second_out = _round_trip(tmp_path, first_out, "split_measure_no_complement.mei")
        assert first_out == second_out


# ---------------------------------------------------------------------------
# Already-clean document
# ---------------------------------------------------------------------------


class TestAlreadyClean:
    """A fully normalized document should produce no changes and no warnings."""

    def test_clean_no_changes(self, tmp_path: Path) -> None:
        """Already-normalized file: no changes_applied and no warnings."""
        report, _ = _run(tmp_path, "already_clean.mei")
        assert report.changes_applied == []
        assert report.warnings == []
        assert report.is_clean is True

    def test_clean_idempotent(self, tmp_path: Path) -> None:
        """Already-normalized file: second pass produces byte-identical output."""
        _, first_out = _run(tmp_path, "already_clean.mei")
        second_out = _round_trip(tmp_path, first_out, "already_clean.mei")
        assert first_out == second_out


# ---------------------------------------------------------------------------
# Duration metadata
# ---------------------------------------------------------------------------


class TestDurationBars:
    """duration_bars is the maximum integer @n across all measures."""

    def test_duration_bars_plain(self, tmp_path: Path) -> None:
        """Simple file: duration_bars equals the highest measure @n."""
        report, _ = _run(tmp_path, "rptend_unpaired_first.mei")
        assert report.duration_bars == 3

    def test_duration_bars_includes_endings(self, tmp_path: Path) -> None:
        """Measures inside endings count toward duration_bars."""
        report, _ = _run(tmp_path, "already_clean.mei")
        # already_clean.mei has measures @n=0,1,2 outside endings
        # and measures @n=3 inside ending n=1 and ending n=2
        assert report.duration_bars == 3

    def test_duration_bars_after_renumbering(self, tmp_path: Path) -> None:
        """After pickup renumbering, duration_bars reflects new @n values."""
        report, _ = _run(tmp_path, "pickup_bar_n1.mei")
        # Original: @n=1(pickup),2,3 -> normalized: @n=0,1,2
        assert report.duration_bars == 2

    def test_duration_bars_excludes_pickup(self, tmp_path: Path) -> None:
        """Pickup bar @n=0 is the minimum, not the maximum; duration_bars > 0."""
        report, _ = _run(tmp_path, "already_clean.mei")
        assert report.duration_bars > 0


# ---------------------------------------------------------------------------
# Pass 8 — Cross-barline tie completion
# ---------------------------------------------------------------------------


class TestCrossBarlineTieCompletion:
    """Pass 8: complete endpoint-less cross-barline ties (ADR-026)."""

    _NS = {"mei": "http://www.music-encoding.org/ns/mei"}
    _XML = {"xml": "http://www.w3.org/XML/1998/namespace"}

    def _by_id(self, tree: lxml.etree._Element, xml_id: str) -> lxml.etree._Element:
        """Return the single element with the given ``xml:id`` (asserts existence)."""
        els = tree.xpath(f"//*[@xml:id='{xml_id}']", namespaces=self._XML)
        assert len(els) == 1, f"Expected exactly one element xml:id={xml_id!r}"
        return els[0]

    def test_endid_resolved_to_next_measure_note(self, tmp_path: Path) -> None:
        """An endid-less tie points at the first same-pitch note in the next bar."""
        _, out_bytes = _run(tmp_path, "tie_incomplete_crossbar.mei")
        tree = lxml.etree.fromstring(out_bytes)
        tie = self._by_id(tree, "t_bb_m1")
        assert tie.get("endid") == "#n_bb_m2"

    def test_decoy_pitch_not_chosen(self, tmp_path: Path) -> None:
        """The continuation, not a later explicit B-natural in the bar, is chosen."""
        _, out_bytes = _run(tmp_path, "tie_incomplete_crossbar.mei")
        tree = lxml.etree.fromstring(out_bytes)
        assert self._by_id(tree, "t_bb_m1").get("endid") == "#n_bb_m2"
        assert self._by_id(tree, "t_bb_m1").get("endid") != "#n_decoy_b"

    def test_second_tie_resolved(self, tmp_path: Path) -> None:
        """A chained second endid-less tie resolves into the following measure."""
        _, out_bytes = _run(tmp_path, "tie_incomplete_crossbar.mei")
        tree = lxml.etree.fromstring(out_bytes)
        assert self._by_id(tree, "t_bb_m2").get("endid") == "#n_bb_m3"

    def test_accid_ges_propagated_to_continuation(self, tmp_path: Path) -> None:
        """Each continuation note gains accid.ges matching the tie origin's flat."""
        _, out_bytes = _run(tmp_path, "tie_incomplete_crossbar.mei")
        tree = lxml.etree.fromstring(out_bytes)
        assert self._by_id(tree, "a_bb_m2").get("accid.ges") == "f"
        assert self._by_id(tree, "a_bb_m3").get("accid.ges") == "f"
        # No notated accidental is added — the original engraving showed none.
        assert "accid" not in self._by_id(tree, "a_bb_m2").attrib
        assert "accid" not in self._by_id(tree, "a_bb_m3").attrib

    def test_propagated_accid_ges_survives_pass9(self, tmp_path: Path) -> None:
        """Pass 9 must not strip the tie continuation's accid.ges (C major, no key sig)."""
        report, out_bytes = _run(tmp_path, "tie_incomplete_crossbar.mei")
        assert not any(
            "spurious" in c.lower() for c in report.changes_applied
        ), f"Pass 9 wrongly stripped a tied continuation: {report.changes_applied}"
        tree = lxml.etree.fromstring(out_bytes)
        assert self._by_id(tree, "a_bb_m2").get("accid.ges") == "f"

    def test_complete_tie_untouched(self, tmp_path: Path) -> None:
        """A tie that already has both endpoints is left exactly as-is."""
        _, out_bytes = _run(tmp_path, "tie_incomplete_crossbar.mei")
        tree = lxml.etree.fromstring(out_bytes)
        e5_tie = self._by_id(tree, "t_e5_m1")
        assert e5_tie.get("endid") == "#n_e5_m2"
        # The natural E continuation gains no gestural accidental.
        assert "accid.ges" not in self._by_id(tree, "a_e5_m2").attrib

    def test_completion_recorded(self, tmp_path: Path) -> None:
        """Both completions are reported in changes_applied; no warnings."""
        report, _ = _run(tmp_path, "tie_incomplete_crossbar.mei")
        completed = [
            c for c in report.changes_applied if "cross-barline tie" in c.lower()
        ]
        assert len(completed) == 2
        assert not report.warnings

    def test_idempotent(self, tmp_path: Path) -> None:
        """A second pass on completed ties applies no further changes."""
        _, first_out = _run(tmp_path, "tie_incomplete_crossbar.mei")
        second_out = _round_trip(tmp_path, first_out, "tie_incomplete_crossbar.mei")
        assert first_out == second_out

    def test_unresolvable_tie_warns_and_is_left_alone(self, tmp_path: Path) -> None:
        """No continuation in the next bar: warn, leave the tie endid-less."""
        report, out_bytes = _run(tmp_path, "tie_incomplete_no_target.mei")
        tree = lxml.etree.fromstring(out_bytes)
        tie = self._by_id(tree, "t_bb_solo")
        assert "endid" not in tie.attrib
        assert not report.changes_applied
        assert any("unresolved" in w.lower() for w in report.warnings)


# ---------------------------------------------------------------------------
# Pass 9 — Spurious gestural accidentals
# ---------------------------------------------------------------------------


class TestSpuriousGesturalAccidentals:
    """Pass 9: strip spurious accid.ges+glyph.auth from MEI conversion artefacts."""

    _NS = {"mei": "http://www.music-encoding.org/ns/mei"}

    def test_spurious_bass_accidental_stripped(self, tmp_path: Path) -> None:
        """Bass C4 with only accid.ges (no accid, no prior in same staff) is stripped."""
        report, out_bytes = _run(tmp_path, "spurious_gestural_accidentals.mei")

        tree = lxml.etree.fromstring(out_bytes)
        # Bass C4: xml:id="a_bass_c4" — should have accid.ges and glyph.auth removed.
        accid_el = tree.xpath(
            "//*[@xml:id='a_bass_c4']",
            namespaces={"xml": "http://www.w3.org/XML/1998/namespace"},
        )
        assert len(accid_el) == 1, "Expected to find <accid xml:id='a_bass_c4'>"
        el = accid_el[0]
        assert (
            "accid.ges" not in el.attrib
        ), "spurious accid.ges should have been stripped"
        assert (
            "glyph.auth" not in el.attrib
        ), "orphaned glyph.auth should have been stripped"

    def test_legitimate_carry_preserved(self, tmp_path: Path) -> None:
        """Treble second C#5 (within-staff carry) keeps its accid.ges."""
        _, out_bytes = _run(tmp_path, "spurious_gestural_accidentals.mei")

        tree = lxml.etree.fromstring(out_bytes)
        accid_el = tree.xpath(
            "//*[@xml:id='a_treble_cs5_second']",
            namespaces={"xml": "http://www.w3.org/XML/1998/namespace"},
        )
        assert len(accid_el) == 1
        el = accid_el[0]
        assert (
            el.get("accid.ges") == "s"
        ), "legitimate carry accid.ges must be preserved"

    def test_first_explicit_accidental_unchanged(self, tmp_path: Path) -> None:
        """Treble first C#5 with accid+accid.ges is not modified."""
        _, out_bytes = _run(tmp_path, "spurious_gestural_accidentals.mei")

        tree = lxml.etree.fromstring(out_bytes)
        accid_el = tree.xpath(
            "//*[@xml:id='a_treble_cs5_first']",
            namespaces={"xml": "http://www.w3.org/XML/1998/namespace"},
        )
        assert len(accid_el) == 1
        el = accid_el[0]
        assert el.get("accid") == "s"
        assert el.get("accid.ges") == "s"

    def test_change_recorded(self, tmp_path: Path) -> None:
        """Exactly one spurious accidental is reported in changes_applied."""
        report, _ = _run(tmp_path, "spurious_gestural_accidentals.mei")
        stripped = [c for c in report.changes_applied if "spurious" in c.lower()]
        assert len(stripped) == 1
        assert "c4" in stripped[0]

    def test_idempotent(self, tmp_path: Path) -> None:
        """Second pass on already-stripped output applies no further changes."""
        _, first_out = _run(tmp_path, "spurious_gestural_accidentals.mei")
        second_out = _round_trip(
            tmp_path, first_out, "spurious_gestural_accidentals.mei"
        )
        assert first_out == second_out

    # ------------------------------------------------------------------
    # New cases: key-signature awareness (ADR-022)
    # ------------------------------------------------------------------

    def test_keysig_sharp_carry_preserved(self, tmp_path: Path) -> None:
        """G major: F#5 notes with accid.ges='s' (key-sig carry) are preserved."""
        report, out_bytes = _run(tmp_path, "keysig_sharp_carry.mei")
        assert (
            not report.changes_applied
        ), f"Unexpected changes in G-major fixture: {report.changes_applied}"
        tree = lxml.etree.fromstring(out_bytes)
        ns = {"xml": "http://www.w3.org/XML/1998/namespace"}
        for xml_id in ("a_f5_first", "a_f5_second"):
            els = tree.xpath(f"//*[@xml:id='{xml_id}']", namespaces=ns)
            assert len(els) == 1, f"Expected element with xml:id={xml_id!r}"
            assert (
                els[0].get("accid.ges") == "s"
            ), f"{xml_id}: key-sig accid.ges must be preserved"

    def test_keysig_flat_carry_preserved(self, tmp_path: Path) -> None:
        """F major: Bb5 notes with accid.ges='f' (key-sig carry) are preserved."""
        report, out_bytes = _run(tmp_path, "keysig_flat_carry.mei")
        assert (
            not report.changes_applied
        ), f"Unexpected changes in F-major fixture: {report.changes_applied}"
        tree = lxml.etree.fromstring(out_bytes)
        ns = {"xml": "http://www.w3.org/XML/1998/namespace"}
        for xml_id in ("a_b5_first", "a_b5_second"):
            els = tree.xpath(f"//*[@xml:id='{xml_id}']", namespaces=ns)
            assert len(els) == 1
            assert (
                els[0].get("accid.ges") == "f"
            ), f"{xml_id}: key-sig accid.ges must be preserved"

    def test_keysig_midpiece_change(self, tmp_path: Path) -> None:
        """Mid-movement key change: C-major F stripped; G-major F# preserved."""
        report, out_bytes = _run(tmp_path, "keysig_midpiece_change.mei")
        tree = lxml.etree.fromstring(out_bytes)
        ns = {"xml": "http://www.w3.org/XML/1998/namespace"}
        # Measure 1 (C major): F5 accid.ges must be stripped.
        m1_els = tree.xpath("//*[@xml:id='a_m1_f5']", namespaces=ns)
        assert len(m1_els) == 1
        assert (
            "accid.ges" not in m1_els[0].attrib
        ), "C-major F5 accid.ges should have been stripped"
        # Measure 2 (G major): F#5 accid.ges must be preserved.
        m2_els = tree.xpath("//*[@xml:id='a_m2_f5']", namespaces=ns)
        assert len(m2_els) == 1
        assert (
            m2_els[0].get("accid.ges") == "s"
        ), "G-major F#5 accid.ges must be preserved"
        stripped = [c for c in report.changes_applied if "spurious" in c.lower()]
        assert len(stripped) == 1

    def test_keysig_carry_coexist(self, tmp_path: Path) -> None:
        """G major: explicit natural in measure; within-staff carry of natural kept."""
        report, out_bytes = _run(tmp_path, "keysig_carry_coexist.mei")
        assert (
            not report.changes_applied
        ), f"Unexpected changes: {report.changes_applied}"
        tree = lxml.etree.fromstring(out_bytes)
        ns = {"xml": "http://www.w3.org/XML/1998/namespace"}
        # Natural carry accid must be preserved (key sig would imply 's').
        carry_els = tree.xpath("//*[@xml:id='a_f5_carry']", namespaces=ns)
        assert len(carry_els) == 1
        assert (
            carry_els[0].get("accid.ges") == "n"
        ), "Within-staff natural carry must be preserved even in G major"

    def test_keysig_cross_staff_before_trigger(self, tmp_path: Path) -> None:
        """Spurious accid.ges on a note that precedes the explicit trigger in doc order."""
        report, out_bytes = _run(tmp_path, "keysig_cross_staff_before_trigger.mei")
        tree = lxml.etree.fromstring(out_bytes)
        ns = {"xml": "http://www.w3.org/XML/1998/namespace"}
        # Bass C4 (listed first in document order): spurious — must be stripped.
        bass_els = tree.xpath("//*[@xml:id='a_bass_c4_early']", namespaces=ns)
        assert len(bass_els) == 1
        assert (
            "accid.ges" not in bass_els[0].attrib
        ), "Spurious bass accid.ges (before trigger in doc order) must be stripped"
        assert "glyph.auth" not in bass_els[0].attrib
        # Treble C#5 (listed second): explicit — must be unchanged.
        treble_els = tree.xpath("//*[@xml:id='a_treble_c5']", namespaces=ns)
        assert len(treble_els) == 1
        assert treble_els[0].get("accid") == "s"
        assert treble_els[0].get("accid.ges") == "s"

    def test_keysig_idempotent_keybearing(self, tmp_path: Path) -> None:
        """Second pass on a key-bearing file (G major) produces byte-identical output."""
        _, first_out = _run(tmp_path, "keysig_sharp_carry.mei")
        second_out = _round_trip(tmp_path, first_out, "keysig_sharp_carry.mei")
        assert first_out == second_out

    def test_keysig_element_sig_attr(self, tmp_path: Path) -> None:
        """<keySig sig="1s"/> encoding (Verovio/MusicXML form) preserves key-sig-implied accid.ges."""
        report, out_bytes = _run(tmp_path, "keysig_element_sig_attr.mei")
        assert report.changes_applied == [], report.changes_applied
        tree = lxml.etree.fromstring(out_bytes)
        ns = {"xml": "http://www.w3.org/XML/1998/namespace"}
        for xml_id in ("a_f5_sharp", "a_f3_sharp"):
            els = tree.xpath(f"//*[@xml:id='{xml_id}']", namespaces=ns)
            assert len(els) == 1, f"{xml_id} missing"
            assert els[0].get("accid.ges") == "s", f"{xml_id} accid.ges stripped"

    def test_keysig_section_boundary_change(self, tmp_path: Path) -> None:
        """Section-boundary key change with initial per-staff keySig children (K.331 mvt 3 encoding).

        The initial <scoreDef> has <staffDef><keySig sig="0"/></staffDef> children
        that set per-staff key-sig state.  A mid-piece <scoreDef><keySig sig="3s"/>
        </scoreDef> between <section> siblings declares a global key change with no
        per-staff overrides.  Without the fix those per-staff entries shadow the new
        global and every accid.ges in the A-major section is incorrectly stripped.
        """
        report, out_bytes = _run(tmp_path, "keysig_section_boundary_change.mei")
        tree = lxml.etree.fromstring(out_bytes)
        ns = {"xml": "http://www.w3.org/XML/1998/namespace"}

        # Measure 1 (A minor): spurious F#5 must be stripped.
        m1_el = tree.xpath("//*[@xml:id='a_m1_f5']", namespaces=ns)
        assert len(m1_el) == 1
        assert (
            "accid.ges" not in m1_el[0].attrib
        ), "A-minor F5 accid.ges should have been stripped"

        # Measure 2 (A major): F#, C#, G# must all be preserved.
        for xml_id in ("a_m2_f5", "a_m2_c5", "a_m2_g5"):
            els = tree.xpath(f"//*[@xml:id='{xml_id}']", namespaces=ns)
            assert len(els) == 1, f"Expected element {xml_id!r}"
            assert els[0].get("accid.ges") == "s", (
                f"{xml_id}: A-major key-sig accid.ges must be preserved "
                f"(per-staff shadowing bug)"
            )

        stripped = [c for c in report.changes_applied if "spurious" in c.lower()]
        assert len(stripped) == 1, f"Expected exactly 1 spurious strip, got: {stripped}"

    def test_keysig_section_boundary_change_idempotent(self, tmp_path: Path) -> None:
        """Second pass on section-boundary key-change fixture is byte-identical."""
        _, first_out = _run(tmp_path, "keysig_section_boundary_change.mei")
        second_out = _round_trip(
            tmp_path, first_out, "keysig_section_boundary_change.mei"
        )
        assert first_out == second_out


# ---------------------------------------------------------------------------
# Pass 10 — Clef sameas resolution
# ---------------------------------------------------------------------------


class TestClefSameas:
    """Pass 10: resolve <clef sameas="#id"> to explicit shape/line."""

    def test_sameas_resolved_to_explicit(self, tmp_path: Path) -> None:
        """A clef referencing another via @sameas gains explicit shape/line."""
        report, out_bytes = _run(tmp_path, "clef_sameas.mei")

        tree = lxml.etree.fromstring(out_bytes)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        ref = tree.xpath("//mei:clef[@xml:id='clef-ref']", namespaces=ns)[0]

        assert ref.get("shape") == "G"
        assert ref.get("line") == "2"
        assert "sameas" not in ref.attrib
        assert any("sameas" in c.lower() for c in report.changes_applied)

    def test_real_clef_untouched(self, tmp_path: Path) -> None:
        """The referenced (already-explicit) clef is left unchanged."""
        _, out_bytes = _run(tmp_path, "clef_sameas.mei")
        tree = lxml.etree.fromstring(out_bytes)
        ns = {"mei": "http://www.music-encoding.org/ns/mei"}
        real = tree.xpath("//mei:clef[@xml:id='clef-real']", namespaces=ns)[0]
        assert real.get("shape") == "G"
        assert real.get("line") == "2"
        assert "sameas" not in real.attrib

    def test_sameas_idempotent(self, tmp_path: Path) -> None:
        """After resolution the clef carries no @sameas, so a second pass is clean."""
        _, first_out = _run(tmp_path, "clef_sameas.mei")
        second_out = _round_trip(tmp_path, first_out, "clef_sameas.mei")
        assert first_out == second_out
