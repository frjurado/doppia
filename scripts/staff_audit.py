"""Staff-presentation spot-check for the grand-staff normalization (Component 9, D1).

Runs the real corpus-prep path (``.mscx`` -> ``.mxl`` -> ``.mei`` ->
:func:`prepare_dcml_corpus.recover_measure_start_clefs`) on a movement and audits
the header ``<staffGrp>`` of a single-instrument piano grand staff, flagging the
three Cluster-D1 staging symptoms directly — no database ingest, no SVG render:

* **brace missing:** the leaf ``<staffGrp>`` (the one directly holding the two
  ``<staffDef>`` staves) declares no brace in either MEI form (``@symbol="brace"``
  or a ``<grpSym symbol="brace">`` child);
* **barlines not connected:** that group lacks ``bar.thru="true"``;
* **redundant label:** any ``@label`` / ``<label>`` survives on a ``<staffDef>``
  or ``<instrDef>``.

By default the audit runs the ingest-time normalizer (Pass 0-11) after recovery,
so the report reflects the staff presentation actually ingested — Pass 11
(ADR-029) should leave **no** warnings.  Pass ``--no-normalize`` to inspect the
raw prep output instead (the 5 affected movements — K332/i, K332/ii, K576/i-iii
— show the brace/bar.thru defects there).

Usage (from the repo root, with the backend venv)::

    backend/.venv/Scripts/python.exe scripts/staff_audit.py \\
        --mscx ~/src/mozart_piano_sonatas/MS3/K332-2.mscx

    # corpus-wide regression sweep over a directory of .mscx files:
    backend/.venv/Scripts/python.exe scripts/staff_audit.py --all \\
        --mscx-dir ~/src/mozart_piano_sonatas/MS3

This is a developer-workstation spot-check tool, not a container dependency; it
is the staff-presentation sibling of ``scripts/clef_audit.py`` and
``scripts/accidental_trace.py``.  See ADR-029.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from pathlib import Path

# Importing the prep module bootstraps backend/ onto sys.path (see its module
# docstring), so the normalizer import below resolves for direct runs too.
import prepare_dcml_corpus as pdc

_MEI_NS = pdc._MEI_NS
_DEFAULT_MSCORE = r"C:/Program Files/MuseScore 3/bin/MuseScore3.exe"


def _q(tag: str) -> str:
    return f"{{{_MEI_NS}}}{tag}"


def audit_staff_presentation(mei_bytes: bytes, *, verbose: bool = True) -> list[str]:
    """Audit a movement's grand-staff presentation and return warning lines.

    Args:
        mei_bytes: The MEI document to inspect.
        verbose: When ``True``, print each finding and a result line.

    Returns:
        A list of warning strings (empty when the staff presentation is clean).
    """
    import lxml.etree

    root = lxml.etree.fromstring(mei_bytes)
    warnings: list[str] = []

    header = root.find(f".//{_q('scoreDef')}/{_q('staffGrp')}")
    if header is None:
        warnings.append("no header staffGrp found")
        if verbose:
            print(f"  {warnings[-1]}")
        return warnings

    # Leaf groups: a <staffGrp> whose direct children include a <staffDef>.
    leaf_groups = [
        grp
        for grp in root.iter(_q("staffGrp"))
        if any(child.tag == _q("staffDef") for child in grp)
    ]
    if len(leaf_groups) != 1:
        # Multi-instrument (or no) grand staff — out of D1 scope; not a defect.
        if verbose:
            print(
                f"  (skipped: {len(leaf_groups)} leaf staff groups, not a solo grand staff)"
            )
        return warnings

    group = leaf_groups[0]
    staves = [c for c in group if c.tag == _q("staffDef")]

    braced = group.get("symbol") == "brace" or any(
        c.tag == _q("grpSym") and c.get("symbol") == "brace" for c in group
    )
    if len(staves) >= 2 and not braced:
        warnings.append(f"brace missing on the {len(staves)}-staff grand-staff group")
    if len(staves) >= 2 and group.get("bar.thru") != "true":
        warnings.append(
            "bar.thru!='true' — barlines do not connect across the staff gap"
        )

    for sd in header.iter(_q("staffDef")):
        if "label" in sd.attrib:
            warnings.append(f"residual @label={sd.get('label')!r} on a staffDef")
        if sd.find(_q("label")) is not None:
            warnings.append("residual <label> on a staffDef")
    for instr in header.iter(_q("instrDef")):
        if "label" in instr.attrib or instr.find(_q("label")) is not None:
            warnings.append("residual label on an instrDef")

    if verbose:
        for w in warnings:
            print(f"  {w}")
        result = "PASS (clean)" if not warnings else f"{len(warnings)} WARNING(S)"
        print(f"  Result: {result}")

    return warnings


def run_pipeline(mscx: Path, mscore_exe: str, *, normalize: bool) -> bytes:
    """Prep (and optionally normalize) a movement, returning the MEI bytes."""
    with tempfile.TemporaryDirectory() as raw:
        tmp = Path(raw)
        mxl = pdc.convert_mscx_to_mxl(mscx, tmp, mscore_exe=mscore_exe)
        mei = pdc.convert_mxl_to_mei(mxl, tmp)
        mei = pdc.recover_measure_start_clefs(mscx, mei)
        if normalize:
            from services.mei_normalizer import normalize_mei

            src, dst = tmp / "r.mei", tmp / "n.mei"
            src.write_bytes(mei)
            normalize_mei(str(src), str(dst))
            mei = dst.read_bytes()
    return mei


def main() -> int:
    """Parse arguments, run the pipeline, and print the audit. Returns an exit code."""
    parser = argparse.ArgumentParser(
        description="Audit grand-staff presentation on a .mscx or a directory (D1)."
    )
    parser.add_argument("--mscx", type=Path, help="Path to a single .mscx.")
    parser.add_argument(
        "--all",
        action="store_true",
        help="Audit every .mscx under --mscx-dir (corpus regression sweep).",
    )
    parser.add_argument(
        "--mscx-dir", type=Path, help="Directory of .mscx files for --all."
    )
    parser.add_argument(
        "--mscore-path",
        default=_DEFAULT_MSCORE,
        help=f"MuseScore exe (default: {_DEFAULT_MSCORE}).",
    )
    parser.add_argument(
        "--no-normalize",
        action="store_false",
        dest="normalize",
        help="Audit the raw prep output (before Pass 11) to surface the defects.",
    )
    args = parser.parse_args()

    if args.all:
        directory = args.mscx_dir or (args.mscx.parent if args.mscx else None)
        if directory is None or not directory.is_dir():
            print("error: --all requires --mscx-dir to be a directory", file=sys.stderr)
            return 2
        total_warn = 0
        for mscx in sorted(directory.glob("*.mscx")):
            mei = run_pipeline(mscx, args.mscore_path, normalize=args.normalize)
            warnings = audit_staff_presentation(mei, verbose=False)
            flag = (
                "OK" if not warnings else f"{len(warnings)} WARN: {'; '.join(warnings)}"
            )
            print(f"{mscx.stem}: {flag}")
            total_warn += len(warnings)
        print(f"\nTotal warnings across corpus: {total_warn}")
        return 1 if total_warn else 0

    if not args.mscx or not args.mscx.exists():
        print("error: --mscx must point to an existing .mscx", file=sys.stderr)
        return 2

    print(
        f"Converting {args.mscx.name} via {args.mscore_path} "
        f"(normalize={'on' if args.normalize else 'off'}) ..."
    )
    mei = run_pipeline(args.mscx, args.mscore_path, normalize=args.normalize)
    warnings = audit_staff_presentation(mei)
    return 1 if warnings else 0


if __name__ == "__main__":
    raise SystemExit(main())
