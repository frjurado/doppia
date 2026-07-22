"""Deterministic Verovio render helper for the snapshot regression guards.

Renders an MEI fixture to a **normalised** SVG that is stable across repeated
runs, so the stored snapshots only change when Verovio's actual output changes
(a version bump, an option change) — which is exactly what the M14 Verovio
6.2.0 upgrade (ADR-013) needs surfaced for review.

Determinism is achieved with ``xmlIdSeed`` (a fixed seed makes Verovio's
otherwise-random element/glyph id tokens reproducible) plus stripping the
``Engraved by Verovio <version>`` string (which always changes on a bump and
would otherwise be trivial diff noise masking the geometric deltas).

The render options mirror the server-side fragment-preview path
(``services/tasks/render_fragment_preview.py``) so the guard reflects a real
render configuration.
"""

from __future__ import annotations

import os
import re

import verovio

# Mirror the server-side preview render options + a fixed id seed for
# determinism. See render_fragment_preview.py for the production options.
SNAPSHOT_OPTIONS: dict[str, object] = {
    "pageWidth": 2200,
    "adjustPageHeight": True,
    "breaks": "none",
    "scale": 35,
    "header": "none",
    "xmlIdSeed": 1,
}

_VERSION_RE = re.compile(r"Engraved by Verovio[^<\"]*")
_COMMENT_RE = re.compile(r"<!--.*?-->", re.DOTALL)


def _resource_path() -> str | None:
    """Return the bundled Verovio ``data/`` directory, or ``None``."""
    candidate = os.path.join(os.path.dirname(os.path.abspath(verovio.__file__)), "data")
    return candidate if os.path.isdir(candidate) else None


def render_snapshot(mei_path: str, measure_range: str | None = None) -> str:
    """Render an MEI file to a normalised, reproducible SVG string.

    Args:
        mei_path: Absolute path to the MEI fixture.
        measure_range: Optional ``"start-end"`` 1-based document-order measure
            range to ``select`` (the fragment-preview edge case). ``None``
            renders the whole file.

    Returns:
        The SVG with the Verovio version string normalised out; byte-stable
        across runs for a given Verovio version.
    """
    with open(mei_path, encoding="utf-8") as fh:
        mei_text = _COMMENT_RE.sub("", fh.read())

    tk = verovio.toolkit()
    res = _resource_path()
    if res:
        tk.setResourcePath(res)
    tk.setOptions(SNAPSHOT_OPTIONS)
    if not tk.loadData(mei_text):
        raise RuntimeError(f"Verovio failed to load {mei_path}: {tk.getLog()}")
    if measure_range is not None:
        tk.select({"measureRange": measure_range})
        tk.redoLayout()
    svg = tk.renderToSVG(1)
    return _VERSION_RE.sub("Engraved by Verovio", svg)
