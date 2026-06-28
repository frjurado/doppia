"""Clef spot-check for the measure-start clef recovery (Component 9, A1-A3).

Runs the real corpus-prep clef path (``.mscx`` -> ``.mxl`` -> ``.mei`` ->
:func:`prepare_dcml_corpus.recover_measure_start_clefs`) on a single movement and
audits the resulting MEI's clef structure, flagging the three staging
read-through symptoms directly — no database ingest, no SVG rendering required:

* **A1 — double clef:** a single ``<layer>`` holding two clefs of the same
  shape/line (the rendered double-glyph).
* **A2 — per-voice scope:** a multi-voice staff where a measure-start clef
  reaches some voices but not all.
* **A3 — section/trio:** surfaced via the recovery diagnostics (section-count
  mismatch / skipped clefs) and the per-section clef tally.

By default the audit also runs the ingest-time normalizer (Pass 0-10) after
recovery, so the report reflects the clef state actually ingested — in
particular ``<clef sameas>`` per-voice restatements are resolved by Pass 10
(otherwise they appear with no shape/line).  Pass ``--no-normalize`` to inspect
the raw prep output instead.

Usage (from the repo root, with the backend venv)::

    backend/.venv/Scripts/python.exe scripts/clef_audit.py \\
        --mscx ~/src/mozart_piano_sonatas/MS3/K331-2.mscx

On Windows MuseScore 3 is auto-detected at its default install path; override
with ``--mscore-path`` when it lives elsewhere.

This is a developer-workstation spot-check tool, not a container dependency.
See ``docs/investigations/accidentals-k279-mvt1/clefs-findings.md`` for the
render spot-check list it supports.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

# Importing the prep module bootstraps backend/ onto sys.path (see its module
# docstring), so the normalizer import below resolves for direct runs too.
import prepare_dcml_corpus as pdc

if TYPE_CHECKING:
    import lxml.etree

_MEI_NS = pdc._MEI_NS
_XML_NS = pdc._XML_NS
_DEFAULT_MSCORE = r"C:/Program Files/MuseScore 3/bin/MuseScore3.exe"


def _clefs(element: lxml.etree._Element) -> list[lxml.etree._Element]:
    """Return every ``<clef>`` descendant of *element* (incl. inside beams)."""
    return list(element.iter(f"{{{_MEI_NS}}}clef"))


def _clef_key(clef: lxml.etree._Element) -> str:
    """Return a compact ``shape/line[/dis]`` key for a clef (``?`` when absent)."""
    parts = [clef.get("shape", "?"), clef.get("line", "?")]
    if clef.get("dis"):
        parts.append(f"{clef.get('dis')}{clef.get('dis.place', '')}")
    return "/".join(parts)


def _voiced(layer: lxml.etree._Element) -> bool:
    """Return whether the layer carries note/rest content (a real voice)."""
    return bool(
        list(layer.iter(f"{{{_MEI_NS}}}note")) or list(layer.iter(f"{{{_MEI_NS}}}rest"))
    )


def audit_clefs(
    mei_bytes: bytes,
    notes: list[str] | None = None,
    *,
    verbose: bool = True,
) -> list[str]:
    """Audit an MEI document's clef structure and return the warning lines.

    Args:
        mei_bytes: The MEI document to audit.
        notes: Recovery diagnostics (from
            :func:`prepare_dcml_corpus.recover_measure_start_clefs`); each is
            reported and counted as a finding.
        verbose: When ``True``, print the full per-measure report to stdout.

    Returns:
        The list of warning strings (A1/A2 findings plus any recovery
        diagnostics); empty means a clean audit.
    """
    import lxml.etree

    root = lxml.etree.fromstring(mei_bytes)
    notes = notes or []
    warnings: list[str] = list(notes)

    if verbose:
        sections = pdc._mei_top_sections(root)
        print(f"\nMEI top-level sections: {len(sections)}")
        for index, measures in enumerate(sections, 1):
            tally = sum(len(_clefs(m)) for m in measures)
            print(f"  section {index}: {len(measures)} measures, {tally} clef(s)")
        print("\nRecovery diagnostics:")
        for note in notes:
            print(f"  ! {note}")
        if not notes:
            print("  (none)")
        print("\nPer-measure clef audit (only measures carrying clefs shown):")

    for measure in root.findall(f".//{{{_MEI_NS}}}measure"):
        mn = measure.get("n", "?")
        for staff in measure.findall(f"{{{_MEI_NS}}}staff"):
            sn = staff.get("n", "?")
            layers = staff.findall(f"{{{_MEI_NS}}}layer")
            layer_clefs: dict[str, list[lxml.etree._Element]] = {}
            for position, layer in enumerate(layers, 1):
                layer_clefs[layer.get("n", str(position))] = _clefs(layer)
            if not any(layer_clefs.values()):
                continue

            if verbose:
                cells = [
                    f"layer{ln}=[{', '.join(_clef_key(c) for c in cl) or '-'}]"
                    for ln, cl in layer_clefs.items()
                ]
                print(f"  m{mn} staff{sn}: " + "  ".join(cells))

            # A1 — a layer holding two clefs of the same key renders a double.
            for ln, cl in layer_clefs.items():
                keys = [_clef_key(c) for c in cl]
                dupes = sorted({k for k in keys if keys.count(k) > 1})
                if dupes:
                    msg = (
                        f"A1: m{mn} staff{sn} layer{ln} has duplicate clef(s) "
                        f"{dupes} -> double-clef glyph"
                    )
                    warnings.append(msg)
                    if verbose:
                        print(f"      {msg}")

            # A2 — a measure-start clef on some voices but not all.
            voiced_layers = [
                layer.get("n", str(position))
                for position, layer in enumerate(layers, 1)
                if _voiced(layer)
            ]
            leading = [
                layer.get("n", str(position))
                for position, layer in enumerate(layers, 1)
                if _voiced(layer) and pdc._layer_leads_with_clef(layer)
            ]
            if 0 < len(leading) < len(voiced_layers):
                missing = [ln for ln in voiced_layers if ln not in leading]
                msg = (
                    f"A2: m{mn} staff{sn} measure-start clef on voices {leading} "
                    f"but not {missing}"
                )
                warnings.append(msg)
                if verbose:
                    print(f"      {msg}")

    if verbose:
        total = len(_clefs(root))
        injected = sum(
            1
            for c in _clefs(root)
            if c.get(f"{{{_XML_NS}}}id", "").startswith("clefrec")
        )
        print(f"\nTotals: {total} clefs in MEI; {injected} recovered (clefrec*).")
        result = "PASS (no warnings)" if not warnings else f"{len(warnings)} WARNING(S)"
        print(f"Result: {result}")

    return warnings


def run_clef_pipeline(
    mscx_path: Path,
    mscore_exe: str,
    *,
    normalize: bool,
) -> tuple[bytes, list[str]]:
    """Run the prep clef path on one ``.mscx`` and return ``(mei_bytes, notes)``.

    Args:
        mscx_path: The MuseScore source movement.
        mscore_exe: Path to the MuseScore executable.
        normalize: When ``True``, also run the ingest-time normalizer so the MEI
            reflects the ingested clef state (``<clef sameas>`` resolved).

    Returns:
        The recovered (and optionally normalized) MEI bytes and the recovery
        diagnostics.
    """
    with tempfile.TemporaryDirectory() as raw_tmp:
        tmp = Path(raw_tmp)
        mxl = pdc.convert_mscx_to_mxl(mscx_path, tmp, mscore_exe=mscore_exe)
        mei = pdc.convert_mxl_to_mei(mxl, tmp)
        notes: list[str] = []
        mei = pdc.recover_measure_start_clefs(mscx_path, mei, notes=notes)

        if normalize:
            from services.mei_normalizer import normalize_mei

            src = tmp / "recovered.mei"
            dst = tmp / "normalized.mei"
            src.write_bytes(mei)
            normalize_mei(str(src), str(dst))
            mei = dst.read_bytes()

    return mei, notes


def main() -> int:
    """Parse arguments, run the pipeline, and print the audit. Returns an exit code."""
    parser = argparse.ArgumentParser(
        description="Audit measure-start clef recovery on a single .mscx (A1-A3)."
    )
    parser.add_argument(
        "--mscx",
        required=True,
        type=Path,
        help="Path to a real .mscx (e.g. a cloned MS3/K331-2.mscx).",
    )
    parser.add_argument(
        "--mscore-path",
        default=_DEFAULT_MSCORE,
        help=f"MuseScore executable (default: {_DEFAULT_MSCORE}).",
    )
    parser.add_argument(
        "--no-normalize",
        action="store_false",
        dest="normalize",
        help="Audit the raw prep output without running the ingest normalizer.",
    )
    args = parser.parse_args()

    if not args.mscx.exists():
        print(f"error: {args.mscx} not found", file=sys.stderr)
        return 2

    print(
        f"Converting {args.mscx.name} via {args.mscore_path} "
        f"(normalize={'on' if args.normalize else 'off'}) ..."
    )
    mei, notes = run_clef_pipeline(
        args.mscx, args.mscore_path, normalize=args.normalize
    )
    warnings = audit_clefs(mei, notes)
    return 1 if warnings else 0


if __name__ == "__main__":
    raise SystemExit(main())
