"""Unit tests for the corrections-overlay model and loader (ADR-027).

Covers the :class:`~models.corrections.Correction` model (alias handling,
no-op rejection) and ``services.corrections_overlay.load_corrections``
(per-movement filtering, missing file, malformed file).
"""

from __future__ import annotations

from pathlib import Path

import pytest
from models.corrections import Correction
from services.corrections_overlay import load_corrections, overlay_path

_FIXTURE_DIR = Path(__file__).parent.parent / "fixtures" / "corrections"


# ---------------------------------------------------------------------------
# Correction model
# ---------------------------------------------------------------------------


def test_correction_accepts_class_alias() -> None:
    """The reserved ``class`` key maps to ``correction_class``."""
    c = Correction.model_validate(
        {
            "movement": "k331/movement-2",
            "target": {"xml_id": "n1"},
            "field": "accid",
            "expected": "n",
            "corrected": "f",
            "rationale": "edition has a flat",
            "class": "errata",
            "source_sha": "abc",
            "added": "2026-06-28 test",
        }
    )
    assert c.correction_class == "errata"
    assert c.target.xml_id == "n1"
    assert c.upstream == "none"  # default


def test_correction_rejects_noop() -> None:
    """A correction whose ``expected`` equals ``corrected`` is rejected."""
    with pytest.raises(ValueError, match="no-op"):
        Correction.model_validate(
            {
                "movement": "k331/movement-2",
                "target": {"xml_id": "n1"},
                "field": "accid",
                "expected": "f",
                "corrected": "f",
                "rationale": "x",
                "class": "errata",
                "source_sha": "abc",
                "added": "2026-06-28 test",
            }
        )


def test_correction_rejects_unknown_key() -> None:
    """``extra='forbid'`` catches typo'd keys before they silently drop."""
    with pytest.raises(ValueError):
        Correction.model_validate(
            {
                "movement": "k331/movement-2",
                "target": {"xml_id": "n1"},
                "field": "accid",
                "corrected": "f",
                "rationale": "x",
                "class": "errata",
                "source_sha": "abc",
                "added": "2026-06-28 test",
                "typo_field": "oops",
            }
        )


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------


def test_load_corrections_filters_by_movement() -> None:
    """Only the requested movement's entries are returned, in file order."""
    result = load_corrections(
        "mozart",
        "mozart-piano-sonatas",
        "k331",
        "movement-2",
        overlay_dir=_FIXTURE_DIR,
    )
    assert len(result) == 2
    assert [c.field for c in result] == ["repeat-start", "accid"]
    assert all(c.movement == "k331/movement-2" for c in result)


def test_load_corrections_other_movement() -> None:
    """A different movement gets only its own entry."""
    result = load_corrections(
        "mozart",
        "mozart-piano-sonatas",
        "k279",
        "movement-1",
        overlay_dir=_FIXTURE_DIR,
    )
    assert len(result) == 1
    assert result[0].field == "accid.ges"
    assert result[0].correction_class == "editorial"


def test_load_corrections_missing_file_returns_empty() -> None:
    """A corpus with no overlay file yields no corrections (the common case)."""
    result = load_corrections(
        "nobody",
        "no-such-corpus",
        "w1",
        "m1",
        overlay_dir=_FIXTURE_DIR,
    )
    assert result == []


def test_load_corrections_movement_with_no_entries() -> None:
    """A movement absent from a present overlay file yields an empty list."""
    result = load_corrections(
        "mozart",
        "mozart-piano-sonatas",
        "k331",
        "movement-1",
        overlay_dir=_FIXTURE_DIR,
    )
    assert result == []


def test_load_corrections_malformed_file_raises(tmp_path: Path) -> None:
    """A malformed entry fails the ingest loudly rather than silently skipping."""
    bad = tmp_path / "x__y.yaml"
    bad.write_text(
        "corrections:\n  - movement: w/m\n    field: accid\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="invalid"):
        load_corrections("x", "y", "w", "m", overlay_dir=tmp_path)


def test_overlay_path_naming() -> None:
    """The overlay filename follows ``{composer}__{corpus}.yaml``."""
    p = overlay_path("mozart", "mozart-piano-sonatas", overlay_dir=_FIXTURE_DIR)
    assert p.name == "mozart__mozart-piano-sonatas.yaml"


# ---------------------------------------------------------------------------
# The real shipped overlay (backend/seed/corrections/) — must stay well-formed
# ---------------------------------------------------------------------------

_SEED_DIR = Path(__file__).parent.parent.parent / "seed" / "corrections"


def test_seed_overlay_entries_validate() -> None:
    """Every entry in the shipped Mozart overlay parses into a valid Correction.

    Guards the production overlay so a malformed real entry (bad ``class``,
    no-op correction, typo'd key, missing ``source_sha``) is caught here rather
    than failing the ingest. Loading each authored movement exercises the
    Pydantic validation in :func:`load_corrections`.
    """
    movements = [
        ("k331", "movement-2"),
        ("k332", "movement-2"),
        ("k279", "movement-2"),
    ]
    total = 0
    for work, mov in movements:
        entries = load_corrections(
            "mozart", "mozart-piano-sonatas", work, mov, overlay_dir=_SEED_DIR
        )
        total += len(entries)
        for c in entries:
            assert c.target.xml_id  # non-empty locator
            assert c.expected != c.corrected  # not a no-op
            assert c.correction_class in ("errata", "editorial")
            assert c.source_sha  # pinned to a DCML commit
    assert total >= 3, "expected the first C2 + B3 errata to be present"
