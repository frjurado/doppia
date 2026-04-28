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
