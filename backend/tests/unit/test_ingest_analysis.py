"""Unit tests for the DCML analysis ingestion helpers.

Tests cover all pure helper functions and the parser/merger logic.
No database or object storage is required; these run without Docker.

Fixtures are drawn from real DCML K331-1.tsv rows where applicable so
that the tests double as a regression guard against fixture drift.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from services.tasks.ingest_analysis import (
    MeasureEntry,
    _build_measure_map,
    _build_numeral,
    _compute_beat,
    _dcml_branch,
    _extract_first_globalkey,
    _is_nan,
    _map_figbass,
    _map_form,
    _merge_events,
    _parse_changes,
    _parse_dcml_harmonies,
    _parse_global_key,
    _parse_numeral,
    _resolve_key,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# TSV header shared across inline fixtures.
_HEADER = (
    "mc\tmn\tquarterbeats\tduration_qb\tkeysig\ttimesig\tact_dur\t"
    "mc_onset\tmn_onset\tevent\ttimesig_num\tvolta\tchord_tones\tadded_tones\t"
    "root_roman\tbass_note\tglobalkey\tlocalkey\tpedal\tchord\t"
    "numeral\tform\tfigbass\tchanges\trelativeroot\tpedalend\tphraseend\t"
    "chord_tones_num\tadded_tones_num"
)


def _make_tsv(*rows: str) -> str:
    """Return a TSV string with the standard DCML header plus the given rows."""
    return "\n".join([_HEADER] + list(rows))


def _row(
    *,
    mc: int = 1,
    mn: int = 1,
    timesig: str = "4/4",
    mn_onset: str = "0",
    event: str = "I",
    volta: str = "NaN",
    globalkey: str = "C",
    localkey: str = "I",
    numeral: str = "I",
    form: str = "M",
    figbass: str = "",
    changes: str = "NaN",
    relativeroot: str = "NaN",
    phraseend: str = "NaN",
) -> str:
    """Build a TSV row with sensible defaults for the columns we care about."""
    return (
        f"{mc}\t{mn}\t0\t4\t0\t{timesig}\t4/4\t0\t{mn_onset}\t"
        f"{event}\t4\t{volta}\t()\t()\tI\t0\t"
        f"{globalkey}\t{localkey}\tNaN\t{numeral}\t"
        f"{numeral}\t{form}\t{figbass}\t{changes}\t{relativeroot}\tNaN\t{phraseend}\t"
        f"3\t0"
    )


# Minimal MEI fixture with measures 1–6, no endings.
_MEI_SIMPLE = b"""<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
  <music>
    <body>
      <mdiv>
        <score>
          <section>
            <measure n="1" xml:id="m1"/>
            <measure n="2" xml:id="m2"/>
            <measure n="3" xml:id="m3"/>
            <measure n="4" xml:id="m4"/>
            <measure n="5" xml:id="m5"/>
            <measure n="6" xml:id="m6"/>
          </section>
        </score>
      </mdiv>
    </body>
  </music>
</mei>"""

# MEI with first and second endings on measures 3–4.
_MEI_WITH_ENDINGS = b"""<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
  <music>
    <body>
      <mdiv>
        <score>
          <section>
            <measure n="1" xml:id="m1"/>
            <measure n="2" xml:id="m2"/>
            <ending n="1">
              <measure n="3" xml:id="m3v1"/>
            </ending>
            <ending n="2">
              <measure n="3" xml:id="m3v2"/>
            </ending>
            <measure n="4" xml:id="m4"/>
          </section>
        </score>
      </mdiv>
    </body>
  </music>
</mei>"""


# ===========================================================================
# _is_nan
# ===========================================================================


class TestIsNan:
    def test_nan_string(self) -> None:
        assert _is_nan("NaN")

    def test_lowercase_nan(self) -> None:
        assert _is_nan("nan")

    def test_empty_string(self) -> None:
        assert _is_nan("")

    def test_non_nan(self) -> None:
        assert not _is_nan("I")
        assert not _is_nan("0")
        assert not _is_nan("A")


# ===========================================================================
# _compute_beat
# ===========================================================================


class TestComputeBeat:
    def test_4_4_downbeat(self) -> None:
        assert _compute_beat("0", "4/4") == 1.0

    def test_4_4_beat_2(self) -> None:
        assert _compute_beat("1", "4/4") == 2.0

    def test_4_4_beat_4(self) -> None:
        assert _compute_beat("3", "4/4") == 4.0

    def test_3_4_downbeat(self) -> None:
        assert _compute_beat("0", "3/4") == 1.0

    def test_3_4_beat_3(self) -> None:
        assert _compute_beat("2", "3/4") == 3.0

    def test_6_8_downbeat(self) -> None:
        assert _compute_beat("0", "6/8") == 1.0

    def test_6_8_beat_2(self) -> None:
        # Second dotted-quarter beat in 6/8 is at 3 eighth notes = 1.5 quarter notes.
        assert _compute_beat("3/2", "6/8") == 2.0

    def test_6_8_string_fraction(self) -> None:
        # DCML sometimes stores fractions as "3/2" strings.
        assert _compute_beat("3/2", "6/8") == 2.0

    def test_6_8_beat_3(self) -> None:
        # Would be beat 3 if 9/8 has three dotted-quarter beats; 6/8 only has 2.
        # mn_onset=3.0 (full bar) → beat 3.0
        assert _compute_beat("3", "6/8") == 3.0

    def test_2_2_downbeat(self) -> None:
        assert _compute_beat("0", "2/2") == 1.0

    def test_2_2_beat_2(self) -> None:
        assert _compute_beat("2", "2/2") == 2.0


# ===========================================================================
# _resolve_key
# ===========================================================================


class TestResolveKey:
    # Simple pitch-class letters
    def test_uppercase_major(self) -> None:
        assert _resolve_key("A", "A") == "A major"

    def test_lowercase_minor(self) -> None:
        assert _resolve_key("a", "A") == "A minor"

    def test_flat_major(self) -> None:
        assert _resolve_key("Bb", "Bb") == "Bb major"

    def test_sharp_minor(self) -> None:
        assert _resolve_key("g#", "A") == "G# minor"

    def test_d_major(self) -> None:
        assert _resolve_key("D", "A") == "D major"

    # Roman numeral keys relative to globalkey
    def test_roman_tonic(self) -> None:
        # I in A major = A major
        assert _resolve_key("I", "A") == "A major"

    def test_roman_iv(self) -> None:
        # IV in A major = D major (5 semitones above A = D)
        assert _resolve_key("IV", "A") == "D major"

    def test_roman_v(self) -> None:
        # V in A major = E major
        assert _resolve_key("V", "A") == "E major"

    def test_roman_vi_minor(self) -> None:
        # vi in A major = F# minor (9 semitones above A = F#)
        assert _resolve_key("vi", "A") == "F# minor"

    def test_roman_sharp_iii(self) -> None:
        # #III in A major: diatonic III = C# (+4 semitones), raised by 1 = D (enharmonic)
        # (C#+1 = D = pitch class 2)
        assert _resolve_key("#III", "A") == "D major"

    def test_roman_ii_minor(self) -> None:
        # ii in A major = B minor (2 semitones above A = B)
        assert _resolve_key("ii", "A") == "B minor"

    def test_flat_key_uses_flats(self) -> None:
        # IV in F major = Bb major (not A# major)
        assert _resolve_key("IV", "F") == "Bb major"

    def test_c_major_i(self) -> None:
        assert _resolve_key("I", "C") == "C major"

    def test_flat_key_bb_iv_uses_flats(self) -> None:
        # IV in Bb major = Eb major (not D# major)
        assert _resolve_key("IV", "Bb") == "Eb major"

    def test_flat_key_eb_iv_uses_flats(self) -> None:
        # IV in Eb major = Ab major (not G# major)
        assert _resolve_key("IV", "Eb") == "Ab major"


# ===========================================================================
# _parse_numeral
# ===========================================================================


class TestParseNumeral:
    def test_plain_i(self) -> None:
        stripped, acc, root = _parse_numeral("I")
        assert stripped == "I"
        assert acc is None
        assert root == 1

    def test_flat_vii(self) -> None:
        stripped, acc, root = _parse_numeral("bVII")
        assert stripped == "VII"
        assert acc == "flat"
        assert root == 7

    def test_sharp_iv(self) -> None:
        stripped, acc, root = _parse_numeral("#IV")
        assert stripped == "IV"
        assert acc == "sharp"
        assert root == 4

    def test_lowercase_ii(self) -> None:
        stripped, acc, root = _parse_numeral("ii")
        assert stripped == "ii"
        assert acc is None
        assert root == 2

    def test_v(self) -> None:
        _, _, root = _parse_numeral("V")
        assert root == 5

    def test_vi(self) -> None:
        _, _, root = _parse_numeral("vi")
        assert root == 6


# ===========================================================================
# _map_figbass
# ===========================================================================


class TestMapFigbass:
    def test_root_position_empty(self) -> None:
        assert _map_figbass("") == ("", 0)

    def test_root_position_nan(self) -> None:
        assert _map_figbass("NaN") == ("", 0)

    def test_first_inversion_triad(self) -> None:
        assert _map_figbass("6") == ("6", 1)

    def test_second_inversion_triad(self) -> None:
        assert _map_figbass("64") == ("64", 2)

    def test_seventh_root(self) -> None:
        assert _map_figbass("7") == ("7", 0)

    def test_seventh_first_inv(self) -> None:
        assert _map_figbass("65") == ("65", 1)

    def test_seventh_second_inv(self) -> None:
        assert _map_figbass("43") == ("43", 2)

    def test_seventh_third_inv(self) -> None:
        assert _map_figbass("2") == ("2", 3)


# ===========================================================================
# _build_numeral
# ===========================================================================


class TestBuildNumeral:
    def test_plain(self) -> None:
        assert _build_numeral("I", "") == "I"

    def test_seventh(self) -> None:
        assert _build_numeral("V", "7") == "V7"

    def test_first_inv_triad(self) -> None:
        assert _build_numeral("ii", "6") == "ii6"

    def test_lowercase_seventh(self) -> None:
        assert _build_numeral("vii", "7") == "vii7"


# ===========================================================================
# _map_form
# ===========================================================================


class TestMapForm:
    def test_major(self) -> None:
        assert _map_form("M") == "major"

    def test_minor(self) -> None:
        assert _map_form("m") == "minor"

    def test_diminished_d(self) -> None:
        assert _map_form("d") == "diminished"

    def test_diminished_o(self) -> None:
        assert _map_form("o") == "diminished"

    def test_augmented_a(self) -> None:
        assert _map_form("a") == "augmented"

    def test_augmented_plus(self) -> None:
        assert _map_form("+") == "augmented"

    def test_half_diminished(self) -> None:
        assert _map_form("%") == "half-diminished"

    def test_nan_defaults_to_major(self) -> None:
        assert _map_form("NaN") == "major"

    def test_unknown_raises(self) -> None:
        import pytest

        with pytest.raises(ValueError):
            _map_form("Z")


# ===========================================================================
# _parse_changes
# ===========================================================================


class TestParseChanges:
    def test_nan(self) -> None:
        assert _parse_changes("NaN") == []

    def test_empty(self) -> None:
        assert _parse_changes("") == []

    def test_single_extension(self) -> None:
        assert _parse_changes("(9)") == ["9"]

    def test_multiple_extensions(self) -> None:
        assert _parse_changes("(9,11)") == ["9", "11"]

    def test_flat_extension(self) -> None:
        assert _parse_changes("(b7)") == ["b7"]

    def test_sharp_extension(self) -> None:
        assert _parse_changes("(#11)") == ["#11"]


# ===========================================================================
# _parse_dcml_harmonies
# ===========================================================================


class TestParseDcmlHarmonies:
    def test_empty_tsv(self) -> None:
        events, phrases, warnings = _parse_dcml_harmonies(_HEADER + "\n", b"")
        assert events == []
        assert phrases == []
        assert warnings == []

    def test_header_only(self) -> None:
        events, phrases, warnings = _parse_dcml_harmonies(_HEADER, b"")
        assert events == []

    def test_happy_path_chord_i(self) -> None:
        """mc=1, mn=1, 6/8, localkey=I, globalkey=A → A major I."""
        tsv = _make_tsv(
            _row(
                mc=1,
                mn=1,
                timesig="6/8",
                mn_onset="0",
                event="I",
                globalkey="A",
                localkey="I",
                numeral="I",
                form="M",
                figbass="",
            )
        )
        events, _, _ = _parse_dcml_harmonies(tsv, _MEI_SIMPLE)
        assert len(events) == 1
        ev = events[0]
        assert ev["mc"] == 1
        assert ev["mn"] == 1
        assert ev["volta"] is None
        assert ev["beat"] == 1.0
        assert ev["local_key"] == "A major"
        assert ev["numeral"] == "I"
        assert ev["quality"] == "major"
        assert ev["inversion"] == 0
        assert ev["root"] == 1
        assert ev["root_accidental"] is None
        assert ev["applied_to"] is None
        assert ev["extensions"] == []
        assert ev["source"] == "DCML"
        assert ev["auto"] is False
        assert ev["reviewed"] is False
        assert ev["bass_pitch"] is None
        assert ev["soprano_pitch"] is None

    def test_v7_chord(self) -> None:
        """V with figbass=7 → numeral V7, inversion 0."""
        tsv = _make_tsv(
            _row(
                mc=2,
                mn=2,
                timesig="6/8",
                mn_onset="0",
                event="V7",
                globalkey="A",
                localkey="I",
                numeral="V",
                form="M",
                figbass="7",
            )
        )
        events, _, _ = _parse_dcml_harmonies(tsv, _MEI_SIMPLE)
        ev = events[0]
        assert ev["numeral"] == "V7"
        assert ev["inversion"] == 0
        assert ev["root"] == 5

    def test_phrase_marker_excluded_from_events(self) -> None:
        """Standalone phrase-open rows (event='{') are not in the events list."""
        tsv = _make_tsv(
            _row(mc=1, mn=1, event="{", numeral="I", form="M"),
            _row(mc=1, mn=1, event="I", numeral="I", form="M"),
        )
        events, phrases, _ = _parse_dcml_harmonies(tsv, b"")
        # Only the chord row should produce an event.
        assert len(events) == 1
        assert events[0]["mc"] == 1
        # Phrase boundary should be captured.
        assert any("open" in p for p in phrases)

    def test_phraseend_column_captured(self) -> None:
        """Phrase close in phraseend column is captured as a boundary."""
        tsv = _make_tsv(
            _row(
                mc=2,
                mn=2,
                event="V7",
                numeral="V",
                form="M",
                figbass="7",
                phraseend="}",
            ),
        )
        events, phrases, _ = _parse_dcml_harmonies(tsv, b"")
        assert len(events) == 1
        assert any("close" in p for p in phrases)

    def test_secondary_dominant(self) -> None:
        """numeral=V, relativeroot=/V → applied_to='V'."""
        tsv = _make_tsv(
            _row(
                mc=4,
                mn=4,
                event="V/V",
                globalkey="A",
                localkey="I",
                numeral="V",
                form="M",
                figbass="",
                relativeroot="/V",
            )
        )
        events, _, _ = _parse_dcml_harmonies(tsv, b"")
        assert events[0]["applied_to"] == "V"
        assert events[0]["numeral"] == "V"

    def test_flat_numeral(self) -> None:
        """bVII → numeral='VII', root_accidental='flat'."""
        tsv = _make_tsv(
            _row(
                mc=5,
                mn=5,
                event="bVII",
                globalkey="A",
                localkey="I",
                numeral="bVII",
                form="M",
            )
        )
        events, _, _ = _parse_dcml_harmonies(tsv, b"")
        ev = events[0]
        assert ev["numeral"] == "VII"
        assert ev["root_accidental"] == "flat"

    def test_extension_parsed(self) -> None:
        """figbass=7, changes=(9) → numeral='V7', extensions=['9']."""
        tsv = _make_tsv(
            _row(
                mc=6,
                mn=6,
                event="V7(9)",
                globalkey="A",
                localkey="I",
                numeral="V",
                form="M",
                figbass="7",
                changes="(9)",
            )
        )
        events, _, _ = _parse_dcml_harmonies(tsv, b"")
        ev = events[0]
        assert ev["numeral"] == "V7"
        assert ev["extensions"] == ["9"]

    def test_volta_int(self) -> None:
        """volta=1.0 in TSV → int 1 in event."""
        tsv = _make_tsv(_row(mc=3, mn=3, volta="1"))
        events, _, _ = _parse_dcml_harmonies(tsv, b"")
        assert events[0]["volta"] == 1

    def test_volta_nan(self) -> None:
        tsv = _make_tsv(_row(mc=3, mn=3, volta="NaN"))
        events, _, _ = _parse_dcml_harmonies(tsv, b"")
        assert events[0]["volta"] is None

    def test_alignment_warning_on_unknown_measure(self) -> None:
        """TSV row with mc=99 (not in MEI, which has 6 positions) → alignment warning."""
        tsv = _make_tsv(_row(mc=99, mn=99))
        _, _, warnings = _parse_dcml_harmonies(tsv, _MEI_SIMPLE)
        assert len(warnings) == 1
        assert "mc=99" in warnings[0]

    def test_no_alignment_warning_on_known_measure(self) -> None:
        tsv = _make_tsv(_row(mc=1, mn=1))
        _, _, warnings = _parse_dcml_harmonies(tsv, _MEI_SIMPLE)
        assert warnings == []

    def test_volta_alignment_with_endings(self) -> None:
        """TSV rows at mc=3 and mc=4 resolve to positions 3 and 4 in the fixture MEI.

        _MEI_WITH_ENDINGS has 5 positions: m1(1), m2(2), m3v1(3), m3v2(4), m4(5).
        mc=3 and mc=4 both exist → no alignment warnings.
        """
        tsv = _make_tsv(
            _row(mc=3, mn=3, volta="1"),
            _row(mc=4, mn=3, volta="2"),
        )
        _, _, warnings = _parse_dcml_harmonies(tsv, _MEI_WITH_ENDINGS)
        assert warnings == []

    def test_k331_fixture_rows(self) -> None:
        """Smoke test against real rows from K331-1.tsv fixture."""
        from pathlib import Path

        fixture = (
            Path(__file__).parent.parent
            / "fixtures/dcml-subset/harmonies/K331-1.harmonies.tsv"
        )
        if not fixture.exists():
            import pytest

            pytest.skip("K331-1.harmonies.tsv fixture not available")
        tsv_content = fixture.read_text(encoding="utf-8")
        events, phrases, _ = _parse_dcml_harmonies(tsv_content, b"")
        # 7 rows total: 1 phrase-open, 5 chords with event column + 1 V/V row
        # (actual count depends on fixture; just verify non-empty and correct structure)
        assert len(events) > 0
        # The first chord should be I in A major.
        assert events[0]["numeral"] == "I"
        assert events[0]["local_key"] == "A major"
        # The second chord (mc=2) should be V7.
        v7_events = [e for e in events if e.get("mc") == 2]
        assert v7_events, "Expected event at mc=2"
        assert v7_events[0]["numeral"] == "V7"
        # The V/V chord (mc=4) should have applied_to=V.
        vov_events = [e for e in events if e.get("mc") == 4]
        assert vov_events, "Expected event at mc=4"
        assert vov_events[0]["applied_to"] == "V"


# ===========================================================================
# _merge_events
# ===========================================================================


class TestMergeEvents:
    def _ev(self, mc: int, numeral: str = "I", **kwargs: object) -> dict:
        return {
            "mc": mc,
            "mn": mc,
            "volta": None,
            "beat": 1.0,
            "numeral": numeral,
            "source": "DCML",
            "auto": False,
            "reviewed": False,
            **kwargs,
        }

    def test_no_existing_returns_incoming(self) -> None:
        incoming = [self._ev(1), self._ev(2, "V")]
        result = _merge_events([], incoming)
        assert len(result) == 2
        assert result[0]["mc"] == 1
        assert result[1]["mc"] == 2

    def test_manual_event_preserved(self) -> None:
        existing = [self._ev(1, source="manual", numeral="IV")]
        incoming = [self._ev(1, numeral="I")]  # different numeral
        result = _merge_events(existing, incoming)
        assert len(result) == 1
        assert result[0]["numeral"] == "IV"  # manual wins

    def test_reviewed_event_preserved(self) -> None:
        existing = [self._ev(1, reviewed=True, numeral="IV")]
        incoming = [self._ev(1, numeral="I")]
        result = _merge_events(existing, incoming)
        assert result[0]["numeral"] == "IV"

    def test_unreviewed_event_replaced(self) -> None:
        existing = [self._ev(1, numeral="IV")]  # wrong chord, unreviewed
        incoming = [self._ev(1, numeral="I")]  # correct chord
        result = _merge_events(existing, incoming)
        assert result[0]["numeral"] == "I"

    def test_new_incoming_event_inserted(self) -> None:
        existing = [self._ev(1)]
        incoming = [self._ev(1), self._ev(2, "V")]  # mc=2 is new
        result = _merge_events(existing, incoming)
        assert len(result) == 2
        mcs = {e["mc"] for e in result}
        assert mcs == {1, 2}

    def test_reviewed_orphan_preserved_with_flag(self) -> None:
        """Reviewed event whose mc no longer appears in incoming gets orphaned=True."""
        existing = [self._ev(5, reviewed=True, numeral="V")]
        incoming = [self._ev(1), self._ev(2)]  # mc=5 gone
        result = _merge_events(existing, incoming)
        orphans = [e for e in result if e.get("orphaned")]
        assert len(orphans) == 1
        assert orphans[0]["mc"] == 5

    def test_mixed_scenario(self) -> None:
        """Manual preserved, unreviewed replaced, new inserted, orphan flagged."""
        existing = [
            self._ev(1, source="manual", numeral="IV"),  # preserved
            self._ev(2, numeral="bVII"),  # replaced
            self._ev(10, reviewed=True, numeral="V"),  # orphaned (not in incoming)
        ]
        incoming = [
            self._ev(1, numeral="I"),  # manual at mc=1 wins
            self._ev(2, numeral="ii"),  # replaces bVII
            self._ev(3, numeral="V"),  # new
        ]
        result = _merge_events(existing, incoming)
        by_mc = {e["mc"]: e for e in result}
        assert by_mc[1]["numeral"] == "IV"  # manual preserved
        assert by_mc[2]["numeral"] == "ii"  # replaced
        assert by_mc[3]["numeral"] == "V"  # new
        assert by_mc[10]["numeral"] == "V"  # orphaned
        assert by_mc[10].get("orphaned") is True

    def test_result_sorted_by_mc(self) -> None:
        incoming = [self._ev(3), self._ev(1), self._ev(2)]
        result = _merge_events([], incoming)
        assert [e["mc"] for e in result] == [1, 2, 3]

    def test_no_mc_event_kept(self) -> None:
        """Existing events without mc (manually inserted) are always kept."""
        manual_no_mc = {
            "mc": None,
            "mn": 5,
            "volta": None,
            "beat": 2.0,
            "source": "manual",
            "numeral": "V",
            "reviewed": False,
        }
        existing = [manual_no_mc]
        incoming = [self._ev(1)]
        result = _merge_events(existing, incoming)
        no_mc = [e for e in result if e.get("mc") is None]
        assert len(no_mc) == 1
        assert no_mc[0]["numeral"] == "V"


# ===========================================================================
# _build_measure_map
# ===========================================================================


class TestBuildMeasureMap:
    """Unit tests for _build_measure_map.

    The function now returns ``{position_index: MeasureEntry}`` keyed by
    1-based document order. Non-integer @n values are preserved in n_raw
    rather than silently dropped (ADR-015).
    """

    # ── Happy paths ──────────────────────────────────────────────────────────

    def test_simple_linear_score(self) -> None:
        """Measures 1–3, no endings → keyed by position index 1–3."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="1" xml:id="m1"/>
    <measure n="2" xml:id="m2"/>
    <measure n="3" xml:id="m3"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert result == {
            1: MeasureEntry(n_raw="1", volta=None, xml_id="m1"),
            2: MeasureEntry(n_raw="2", volta=None, xml_id="m2"),
            3: MeasureEntry(n_raw="3", volta=None, xml_id="m3"),
        }

    def test_volta_endings_produce_distinct_keys(self) -> None:
        """Measures inside endings get contiguous position indices; same @n, different volta."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="1" xml:id="m1"/>
    <ending n="1"><measure n="2" xml:id="m2v1"/></ending>
    <ending n="2"><measure n="2" xml:id="m2v2"/></ending>
    <measure n="3" xml:id="m3"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert result == {
            1: MeasureEntry(n_raw="1", volta=None, xml_id="m1"),
            2: MeasureEntry(n_raw="2", volta=1, xml_id="m2v1"),
            3: MeasureEntry(n_raw="2", volta=2, xml_id="m2v2"),
            4: MeasureEntry(n_raw="3", volta=None, xml_id="m3"),
        }

    def test_pickup_bar_n_zero(self) -> None:
        """@n='0' pickup bar gets position 1; subsequent measures get 2, 3."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="0" xml:id="pickup"/>
    <measure n="1" xml:id="m1"/>
    <measure n="2" xml:id="m2"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert result[1] == MeasureEntry(n_raw="0", volta=None, xml_id="pickup")
        assert result[2] == MeasureEntry(n_raw="1", volta=None, xml_id="m1")
        assert len(result) == 3

    def test_volta_movement_fixture(self) -> None:
        """Smoke test against the shared volta-movement.mei fixture file.

        The fixture has 4 positions:
          1 → n='1', volta=None
          2 → n='2', volta=1  (inside ending n=1)
          3 → n='2', volta=2  (inside ending n=2)
          4 → n='3', volta=None
        """
        from pathlib import Path

        fixture = Path(__file__).parent.parent / "fixtures/mei/volta-movement.mei"
        if not fixture.exists():
            pytest.skip("volta-movement.mei fixture not found")
        result = _build_measure_map(fixture.read_bytes())
        assert len(result) == 4
        assert result[1].n_raw == "1" and result[1].volta is None
        assert result[2].volta == 1
        assert result[3].volta == 2
        assert result[4].n_raw == "3" and result[4].volta is None

    # ── Edge case: missing @n → n_raw is empty string ─────────────────────────

    def test_missing_n_attr_n_raw_is_empty_string(self) -> None:
        """Measures with no @n get n_raw='' and are still included in the map."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure xml:id="no-n"/>
    <measure n="2" xml:id="m2"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert len(result) == 2
        assert result[1] == MeasureEntry(n_raw="", volta=None, xml_id="no-n")
        assert result[2] == MeasureEntry(n_raw="2", volta=None, xml_id="m2")

    # ── Edge case: non-integer @n preserved in n_raw ──────────────────────────

    def test_non_integer_n_preserved_in_n_raw(self) -> None:
        """@n that cannot be parsed as int is preserved as n_raw — no longer dropped."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="bad" xml:id="bad"/>
    <measure n="3" xml:id="m3"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert len(result) == 2
        assert result[1] == MeasureEntry(n_raw="bad", volta=None, xml_id="bad")
        assert result[2] == MeasureEntry(n_raw="3", volta=None, xml_id="m3")

    def test_real_world_x1_x2_labels_preserved(self) -> None:
        """@n='X1', @n='X2' (seen in K.279/K.283/K.331 staging ingest) are now preserved.

        Previously these were silently dropped, producing spurious alignment
        warnings for every DCML TSV row referencing those positions. Now all
        four measures appear at positions 1–4 with their raw @n strings.
        """
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="X1" xml:id="rehearsal1"/>
    <measure n="1" xml:id="m1"/>
    <measure n="X2" xml:id="rehearsal2"/>
    <measure n="2" xml:id="m2"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert len(result) == 4
        assert result[1] == MeasureEntry(n_raw="X1", volta=None, xml_id="rehearsal1")
        assert result[2] == MeasureEntry(n_raw="1", volta=None, xml_id="m1")
        assert result[3] == MeasureEntry(n_raw="X2", volta=None, xml_id="rehearsal2")
        assert result[4] == MeasureEntry(n_raw="2", volta=None, xml_id="m2")

    def test_x1_x2_position_indices_are_stable(self) -> None:
        """Position indices are document-order regardless of @n value.

        Given X1, 1, X2, 2 in document order, position 1 = X1, position 2 = 1,
        position 3 = X2, position 4 = 2. This directly documents the fix for
        the Mozart staging corpus alignment warnings (ADR-015).
        """
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="X1" xml:id="x1"/>
    <measure n="1"  xml:id="m1"/>
    <measure n="X2" xml:id="x2"/>
    <measure n="2"  xml:id="m2"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert result[1].n_raw == "X1"
        assert result[2].n_raw == "1"
        assert result[3].n_raw == "X2"
        assert result[4].n_raw == "2"

    def test_n_with_alpha_suffix_preserved(self) -> None:
        """@n='12a' is now preserved as n_raw — no longer silently dropped."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="12a" xml:id="m12a"/>
    <measure n="12" xml:id="m12"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert len(result) == 2
        assert result[1] == MeasureEntry(n_raw="12a", volta=None, xml_id="m12a")
        assert result[2] == MeasureEntry(n_raw="12", volta=None, xml_id="m12")

    # ── Edge case: missing xml:id ─────────────────────────────────────────────

    def test_no_xml_id_added_with_empty_string(self) -> None:
        """Measures without xml:id have xml_id='' in their MeasureEntry."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="1"/>
    <measure n="2" xml:id="m2"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert result[1].xml_id == ""
        assert result[2].xml_id == "m2"

    # ── Edge case: malformed XML ──────────────────────────────────────────────

    def test_malformed_xml_returns_empty_dict(self) -> None:
        """XMLSyntaxError is caught and {} returned — alignment degrades gracefully."""
        result = _build_measure_map(b"<not valid xml <<<")
        assert result == {}

    def test_empty_bytes_returns_empty_dict(self) -> None:
        """Empty bytes → XMLSyntaxError → {} returned."""
        result = _build_measure_map(b"")
        assert result == {}

    # ── Edge case: ending with no @n → volta=None ─────────────────────────────

    def test_ending_no_n_attr_gives_volta_none(self) -> None:
        """Ending without @n → the measure inside gets volta=None."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="1" xml:id="m1"/>
    <ending>
      <measure n="2" xml:id="m2-ending"/>
    </ending>
    <measure n="3" xml:id="m3"/>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert len(result) == 3
        assert result[2] == MeasureEntry(n_raw="2", volta=None, xml_id="m2-ending")

    def test_ending_empty_n_attr_gives_volta_none(self) -> None:
        """Ending with @n='' is falsy → volta=None for the measure inside it."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="1" xml:id="m1"/>
    <ending n="">
      <measure n="2" xml:id="m2-ending"/>
    </ending>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert result[2] == MeasureEntry(n_raw="2", volta=None, xml_id="m2-ending")

    def test_position_indices_unique_no_overwrite(self) -> None:
        """Each measure gets a unique position index — no key collisions even when @n repeats.

        In the old (mn, volta) design, a normal measure and an un-numbered ending
        sharing the same @n would silently overwrite each other. Position indices
        are unique by definition, so both measures appear in the map.
        """
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="2" xml:id="normal-m2"/>
    <ending n="">
      <measure n="2" xml:id="ending-m2"/>
    </ending>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert len(result) == 2
        assert result[1] == MeasureEntry(n_raw="2", volta=None, xml_id="normal-m2")
        assert result[2] == MeasureEntry(n_raw="2", volta=None, xml_id="ending-m2")

    def test_ending_with_non_integer_n_gives_volta_none(self) -> None:
        """Ending with @n='abc' → ValueError in int() → except branch → volta=None."""
        mei = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="1" xml:id="m1"/>
    <ending n="abc">
      <measure n="2" xml:id="m2-ending"/>
    </ending>
  </section></score></mdiv></body></music>
</mei>"""
        result = _build_measure_map(mei)
        assert result[2] == MeasureEntry(n_raw="2", volta=None, xml_id="m2-ending")


# ===========================================================================
# _parse_global_key
# ===========================================================================


class TestParseGlobalKey:
    """Unit tests for _parse_global_key.

    The function extracts (tonic_pitch_class, use_flats) from a DCML globalkey
    string.  Tests document both correct behavior and a known limitation in the
    source code: _FLAT_KEY_TONICS contains multi-char entries (e.g. 'Bb') that
    can never match the single-char ``letter`` variable — so only 'F' reliably
    sets use_flats=True via set membership.
    """

    def test_a_major(self) -> None:
        """'A' → tonic_pc=9, use_flats=False."""
        pc, flats = _parse_global_key("A")
        assert pc == 9
        assert flats is False

    def test_a_minor_lowercase(self) -> None:
        """'a' (lowercase) normalises to 'A'; same tonic_pc."""
        pc, flats = _parse_global_key("a")
        assert pc == 9
        assert flats is False

    def test_c_major(self) -> None:
        """'C' → tonic_pc=0, use_flats=False."""
        pc, flats = _parse_global_key("C")
        assert pc == 0
        assert flats is False

    def test_g_major(self) -> None:
        """'G' → tonic_pc=7, use_flats=False."""
        pc, flats = _parse_global_key("G")
        assert pc == 7
        assert flats is False

    def test_f_major_uses_flats(self) -> None:
        """'F' is the only single-char tonic in _FLAT_KEY_TONICS → use_flats=True."""
        pc, flats = _parse_global_key("F")
        assert pc == 5
        assert flats is True

    def test_f_sharp_use_flats_false(self) -> None:
        """'F#' → note='F#'; 'F#' is not in _FLAT_KEY_TONICS → use_flats=False."""
        pc, flats = _parse_global_key("F#")
        assert pc == 6
        assert flats is False

    def test_bb_major_use_flats(self) -> None:
        """'Bb' → note='Bb'; 'Bb' is in _FLAT_KEY_TONICS → use_flats=True."""
        pc, flats = _parse_global_key("Bb")
        assert pc == 10
        assert flats is True

    def test_eb_major_use_flats(self) -> None:
        """'Eb' → note='Eb'; 'Eb' is in _FLAT_KEY_TONICS → use_flats=True."""
        pc, flats = _parse_global_key("Eb")
        assert pc == 3
        assert flats is True

    def test_ab_major_use_flats(self) -> None:
        """'Ab' → note='Ab'; 'Ab' is in _FLAT_KEY_TONICS → use_flats=True."""
        pc, flats = _parse_global_key("Ab")
        assert pc == 8
        assert flats is True

    def test_db_major_use_flats(self) -> None:
        """'Db' → note='Db'; 'Db' is in _FLAT_KEY_TONICS → use_flats=True."""
        pc, flats = _parse_global_key("Db")
        assert pc == 1
        assert flats is True

    def test_gb_major_use_flats(self) -> None:
        """'Gb' → note='Gb'; 'Gb' is in _FLAT_KEY_TONICS → use_flats=True."""
        pc, flats = _parse_global_key("Gb")
        assert pc == 6
        assert flats is True

    def test_cb_major_use_flats(self) -> None:
        """'Cb' → note='Cb'; 'Cb' is in _FLAT_KEY_TONICS → use_flats=True."""
        pc, flats = _parse_global_key("Cb")
        assert pc == 11
        assert flats is True

    def test_d_major(self) -> None:
        """'D' → tonic_pc=2, use_flats=False."""
        pc, flats = _parse_global_key("D")
        assert pc == 2
        assert flats is False

    def test_b_major(self) -> None:
        """'B' → tonic_pc=11, use_flats=False."""
        pc, flats = _parse_global_key("B")
        assert pc == 11
        assert flats is False

    def test_leading_trailing_whitespace_stripped(self) -> None:
        """Whitespace around the key string is stripped before parsing."""
        pc, _ = _parse_global_key("  A  ")
        assert pc == 9

    def test_invalid_string_raises_value_error(self) -> None:
        """Non-pitch-class strings raise ValueError."""
        with pytest.raises(ValueError, match="Cannot parse globalkey"):
            _parse_global_key("unknown")

    def test_empty_string_raises_value_error(self) -> None:
        """Empty string raises ValueError."""
        with pytest.raises(ValueError, match="Cannot parse globalkey"):
            _parse_global_key("")

    def test_numeric_string_raises_value_error(self) -> None:
        """Numeric string raises ValueError (not a pitch-class letter)."""
        with pytest.raises(ValueError, match="Cannot parse globalkey"):
            _parse_global_key("123")


# ===========================================================================
# _extract_first_globalkey
# ===========================================================================


class TestExtractFirstGlobalkey:
    """Unit tests for _extract_first_globalkey."""

    def test_returns_first_non_nan_globalkey(self) -> None:
        tsv = _make_tsv(_row(mc=1, mn=1, globalkey="A"))
        assert _extract_first_globalkey(tsv) == "A"

    def test_skips_nan_globalkey_rows(self) -> None:
        """Rows with NaN globalkey are skipped; returns the first non-NaN one."""
        tsv = _make_tsv(
            _row(mc=1, mn=1, globalkey="NaN"),
            _row(mc=2, mn=2, globalkey="A"),
        )
        assert _extract_first_globalkey(tsv) == "A"

    def test_skips_phrase_marker_rows(self) -> None:
        """Phrase-open '{' rows are skipped by the event-column filter."""
        tsv = _make_tsv(
            _row(mc=1, mn=1, event="{", globalkey="A"),
            _row(mc=1, mn=1, event="I", globalkey="A"),
        )
        assert _extract_first_globalkey(tsv) == "A"

    def test_returns_none_for_header_only(self) -> None:
        assert _extract_first_globalkey(_HEADER) is None

    def test_returns_none_when_all_nan(self) -> None:
        tsv = _make_tsv(
            _row(mc=1, mn=1, globalkey="NaN"),
            _row(mc=2, mn=2, globalkey="NaN"),
        )
        assert _extract_first_globalkey(tsv) is None


# ===========================================================================
# _dcml_branch
# ===========================================================================


class TestDcmlBranch:
    """Unit tests for _dcml_branch with mocked DB and object storage.

    Each test patches create_async_engine, AsyncSession, and make_storage_client
    so no database or MinIO connection is needed.

    Session call order:
      1st AsyncSession call → Phase 1 read (SELECT movement).
      2nd AsyncSession call → Phase 3 writes (UPDATE / INSERT / UPDATE warnings).
    """

    _SIMPLE_MEI = b"""<?xml version="1.0"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score><section>
    <measure n="1" xml:id="m1"/>
    <measure n="2" xml:id="m2"/>
  </section></score></mdiv></body></music>
</mei>"""

    # One chord at mc=1, mn=1, globalkey="A" — matches _SIMPLE_MEI measure 1.
    _TSV_A_MAJOR = _make_tsv(_row(mc=1, mn=1, globalkey="A", localkey="I"))

    # One chord at mn=99 — not present in _SIMPLE_MEI → triggers alignment warning.
    _TSV_UNKNOWN_MEASURE = _make_tsv(_row(mc=99, mn=99, globalkey="A", localkey="I"))

    @staticmethod
    def _async_cm(value=None):
        cm = AsyncMock()
        cm.__aenter__ = AsyncMock(return_value=value)
        cm.__aexit__ = AsyncMock(return_value=False)
        return cm

    def _build_mocks(self, key_signature=None, mei_bytes=None):
        """Return (engine, AsyncSession_class, storage_factory, write_session)."""
        if mei_bytes is None:
            mei_bytes = self._SIMPLE_MEI

        engine = AsyncMock()
        engine.dispose = AsyncMock()

        # Phase 1 session: SELECT movement row.
        movement_row = MagicMock()
        movement_row.mei_object_key = "k331/m1.mei"
        movement_row.key_signature = key_signature
        read_result = MagicMock()
        read_result.one_or_none.return_value = movement_row
        read_session = AsyncMock()
        read_session.execute = AsyncMock(return_value=read_result)

        # Phase 3 session: writes.
        write_result = MagicMock()
        write_result.one_or_none.return_value = None  # no existing movement_analysis
        write_session = AsyncMock()
        write_session.execute = AsyncMock(return_value=write_result)
        write_session.begin = MagicMock(return_value=self._async_cm(None))

        session_class = MagicMock(
            side_effect=[self._async_cm(read_session), self._async_cm(write_session)]
        )

        storage = AsyncMock()
        storage.get_mei = AsyncMock(return_value=mei_bytes)
        storage_factory = MagicMock(return_value=storage)

        return engine, session_class, storage_factory, write_session

    async def test_movement_not_found_raises_and_disposes_engine(
        self, monkeypatch
    ) -> None:
        """SELECT movement returns None → ValueError; engine.dispose() still called."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")

        engine = AsyncMock()
        engine.dispose = AsyncMock()
        not_found_result = MagicMock()
        not_found_result.one_or_none.return_value = None
        not_found_session = AsyncMock()
        not_found_session.execute = AsyncMock(return_value=not_found_result)
        session_class = MagicMock(return_value=self._async_cm(not_found_session))

        with (
            patch(
                "services.tasks.ingest_analysis.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.ingest_analysis.AsyncSession", new=session_class),
        ):
            with pytest.raises(ValueError, match="no movement found"):
                await _dcml_branch(str(uuid.uuid4()), _make_tsv(_row()))

        engine.dispose.assert_awaited_once()

    async def test_backfills_key_signature_when_absent(self, monkeypatch) -> None:
        """key_signature=None + globalkey='A' in TSV → UPDATE movement SET key_signature='A major'."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")
        engine, session_class, storage_factory, write_session = self._build_mocks(
            key_signature=None
        )

        with (
            patch(
                "services.tasks.ingest_analysis.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.ingest_analysis.AsyncSession", new=session_class),
            patch(
                "services.tasks.ingest_analysis.make_storage_client", storage_factory
            ),
        ):
            await _dcml_branch(str(uuid.uuid4()), self._TSV_A_MAJOR)

        all_calls = write_session.execute.call_args_list
        ks_calls = [c for c in all_calls if len(c.args) > 1 and "ks" in c.args[1]]
        assert len(ks_calls) == 1, "Expected exactly one UPDATE key_signature call"
        assert ks_calls[0].args[1]["ks"] == "A major"

    async def test_no_key_signature_update_when_already_set(self, monkeypatch) -> None:
        """key_signature already set → no UPDATE key_signature issued."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")
        engine, session_class, storage_factory, write_session = self._build_mocks(
            key_signature="A major"
        )

        with (
            patch(
                "services.tasks.ingest_analysis.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.ingest_analysis.AsyncSession", new=session_class),
            patch(
                "services.tasks.ingest_analysis.make_storage_client", storage_factory
            ),
        ):
            await _dcml_branch(str(uuid.uuid4()), self._TSV_A_MAJOR)

        all_calls = write_session.execute.call_args_list
        ks_calls = [c for c in all_calls if len(c.args) > 1 and "ks" in c.args[1]]
        assert len(ks_calls) == 0, "Should not UPDATE key_signature when already set"

    async def test_alignment_warnings_stored_for_unknown_measure(
        self, monkeypatch
    ) -> None:
        """TSV row at mn=99 not present in MEI → alignment warning written to DB."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")
        engine, session_class, storage_factory, write_session = self._build_mocks()

        with (
            patch(
                "services.tasks.ingest_analysis.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.ingest_analysis.AsyncSession", new=session_class),
            patch(
                "services.tasks.ingest_analysis.make_storage_client", storage_factory
            ),
        ):
            await _dcml_branch(str(uuid.uuid4()), self._TSV_UNKNOWN_MEASURE)

        import json

        all_calls = write_session.execute.call_args_list
        warn_calls = [
            c for c in all_calls if len(c.args) > 1 and "warnings" in c.args[1]
        ]
        assert len(warn_calls) == 1, "Expected one UPDATE normalization_warnings call"
        warnings = json.loads(warn_calls[0].args[1]["warnings"])
        assert len(warnings) == 1
        assert "mc=99" in warnings[0]

    async def test_no_alignment_warnings_for_matching_tsv(self, monkeypatch) -> None:
        """TSV row at mn=1 matches MEI measure → no normalization_warnings update."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")
        engine, session_class, storage_factory, write_session = self._build_mocks()

        with (
            patch(
                "services.tasks.ingest_analysis.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.ingest_analysis.AsyncSession", new=session_class),
            patch(
                "services.tasks.ingest_analysis.make_storage_client", storage_factory
            ),
        ):
            await _dcml_branch(str(uuid.uuid4()), self._TSV_A_MAJOR)

        all_calls = write_session.execute.call_args_list
        warn_calls = [
            c for c in all_calls if len(c.args) > 1 and "warnings" in c.args[1]
        ]
        assert (
            warn_calls == []
        ), "Should not issue normalization_warnings when TSV aligns with MEI"
