"""Verovio render regression guards (Component 10 Step 13).

Pins the current Verovio (6.1.0) SVG output for a representative set of
movements and fragment selects, so the eventual deliberate Verovio 6.2.0 upgrade
(ADR-013; M14, deferred to Component 14) is a **reviewed** event: a version bump
whose rendering changes will fail these snapshots, making the geometric deltas
visible in the diff rather than shipping silently.

These are **informational** guards, not a block on the upgrade: when the bump is
intentional, regenerate the snapshots and review the diff.

    # inspect what a Verovio change did, then accept it:
    UPDATE_VEROVIO_SNAPSHOTS=1 pytest backend/tests/snapshots

Determinism (byte-stable across runs *and* across Windows/Linux — verified) comes
from ``verovio_render.render_snapshot`` (fixed ``xmlIdSeed`` + version-string
strip). The snapshots live in ``__snapshots__/`` next to this file.

Coverage is a representative set, extendable by adding a ``_CASES`` row:
    * whole small movement (``k331-movement-1``, ``k331-movement-2``);
    * a mid-movement fragment ``select`` (bars 3–5 — not starting at bar 1);
    * a first/second-ending (volta) movement (``volta-movement``).
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from .verovio_render import render_snapshot

_MEI_DIR = Path(__file__).parents[1] / "fixtures" / "mei"
_SNAP_DIR = Path(__file__).parent / "__snapshots__"
_UPDATE = os.environ.get("UPDATE_VEROVIO_SNAPSHOTS") == "1"

# (label, fixture filename, measureRange | None)
_CASES: list[tuple[str, str, str | None]] = [
    ("k331_mvt1_full", "k331-movement-1.mei", None),
    ("k331_mvt1_bars_3_5", "k331-movement-1.mei", "3-5"),  # mid-movement select
    ("k331_mvt2_full", "k331-movement-2.mei", None),
    ("volta_movement_full", "volta-movement.mei", None),  # first/second ending
]


@pytest.mark.parametrize(
    ("label", "fixture", "measure_range"),
    _CASES,
    ids=[c[0] for c in _CASES],
)
def test_verovio_render_snapshot(
    label: str, fixture: str, measure_range: str | None
) -> None:
    """Render the case and assert it matches its stored snapshot."""
    svg = render_snapshot(str(_MEI_DIR / fixture), measure_range)
    snapshot = _SNAP_DIR / f"{label}.svg"

    if _UPDATE:
        _SNAP_DIR.mkdir(exist_ok=True)
        snapshot.write_text(svg, encoding="utf-8", newline="\n")
        return

    if not snapshot.exists():
        pytest.fail(
            f"Missing snapshot {snapshot.name}. Generate it with "
            f"UPDATE_VEROVIO_SNAPSHOTS=1 pytest backend/tests/snapshots and commit it."
        )

    # Normalise line endings: the stored .svg is LF, but git autocrlf may hand
    # it back as CRLF on Windows checkout, while the fresh render is always LF.
    expected = snapshot.read_text(encoding="utf-8").replace("\r\n", "\n")
    svg = svg.replace("\r\n", "\n")
    assert svg == expected, (
        f"Verovio render changed for {label!r}. If this is an intentional Verovio "
        f"version or option change (ADR-013 / M14), regenerate with "
        f"UPDATE_VEROVIO_SNAPSHOTS=1 pytest backend/tests/snapshots and review the "
        f"diff before committing; otherwise a dependency or code change altered "
        f"rendering unexpectedly."
    )
