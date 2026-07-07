"""Accidental spot-check for the gestural-accidental resolution (Component 9, B1-B3).

Audits an MEI document's encoded accidentals against staff- and octave-scoped
Classical convention and flags any note whose **realised** alteration (what
Verovio will play — its own ``accid.ges``, else its own ``@accid``, else
natural) differs from the **expected** alteration (the active key signature,
overridden by the most-recent explicit ``@accid`` on the same ``(pname, oct)``
earlier in onset order across all voices of the staff; tie continuations inherit
their start's alteration).  A clean audit means MIDI playback matches the
notation — i.e. the resolution pass (ADR-028) did its job.

The audit core is **pure** (MEI bytes only) and relies on the proven Verovio
engine model — *each note's MIDI pitch comes from its own encoded
``accid``/``accid.ges`` only* (see
``docs/investigations/accidentals-k279-mvt1/accidentals-playback-findings.md``).
``--verify-midi`` additionally renders MIDI and cross-checks that the realised
tokens actually match Verovio's output (confirming the engine model holds for
the file under test).

It reuses the normalizer's own key-signature index, tie map, and onset walk
(``backend/services/mei_normalizer.py``), so it stays in lock-step with the
resolver's notion of "expected".

Usage (from the repo root, with the backend venv)::

    backend/.venv/Scripts/python.exe scripts/accidental_trace.py \\
        --mscx ~/src/mozart_piano_sonatas/MS3/K279-2.mscx

Pass ``--no-normalize`` to audit the raw prep output (before the resolver) — the
B1-B3 defects show up as warnings.  This is a developer-workstation spot-check
tool, not a container dependency; it is the accidental sibling of
``scripts/clef_audit.py``.
"""

from __future__ import annotations

import argparse
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

# Importing the prep module bootstraps backend/ onto sys.path (see its module
# docstring), so the service imports below resolve for direct runs too.
import prepare_dcml_corpus as pdc
from services.mei_normalizer import (
    _MEI_NS,
    _XML_ID_KEY,
    _build_measure_key_sigs,
    _build_tie_targets,
    _read_elem_key_sig,
    _staff_ordered_notes,
)

_DEFAULT_MSCORE = r"C:/Program Files/MuseScore 3/bin/MuseScore3.exe"

# Alteration token -> semitone offset.
_ALTER: dict[str | None, int] = {
    None: 0,
    "": 0,
    "n": 0,
    "s": 1,
    "f": -1,
    "ss": 2,
    "x": 2,
    "ff": -2,
}


def _alt(token: str | None) -> int:
    """Return the semitone offset for an accidental token (0 when unknown)."""
    return _ALTER.get(token, 0)


@dataclass(frozen=True)
class NoteTrace:
    """One note's expected-vs-realised accidental verdict."""

    measure: str
    staff: str
    pname: str
    oct: str
    xml_id: str
    notated: str | None
    ges: str | None
    expected: int
    realised: int
    is_tie: bool

    @property
    def mismatch(self) -> bool:
        """True when the played alteration differs from convention (and not a tie)."""
        return not self.is_tie and self.expected != self.realised


def trace_accidentals(mei_bytes: bytes) -> list[NoteTrace]:
    """Return a per-note expected-vs-realised accidental trace for *mei_bytes*.

    Pure: derives "realised" from each note's own ``accid.ges``/``@accid`` per the
    Verovio engine model, and "expected" from staff+octave-scoped, section-aware,
    onset-ordered convention (reusing the normalizer's helpers).

    Args:
        mei_bytes: The MEI document to audit.

    Returns:
        One :class:`NoteTrace` per note, in measure/staff document order.
    """
    import lxml.etree

    root = lxml.etree.fromstring(mei_bytes)
    ks_index = _build_measure_key_sigs(root)
    ties = _build_tie_targets(root)
    tree = root.getroottree()
    out: list[NoteTrace] = []

    for measure in root.findall(f".//{{{_MEI_NS}}}measure"):
        m_n = measure.get("n", "?")
        raw = ks_index.get(tree.getpath(measure), {None: {}})
        ks_by_staff: dict[str | None, dict[str, str]] = {
            k: dict(v) for k, v in raw.items()
        }
        for staffdef in measure.findall(f"{{{_MEI_NS}}}staffDef"):
            n = staffdef.get("n")
            ks = _read_elem_key_sig(staffdef) if n is not None else None
            if ks is not None:
                ks_by_staff[n] = ks
        for scoredef in measure.findall(f"{{{_MEI_NS}}}scoreDef"):
            ks = _read_elem_key_sig(scoredef)
            if ks is not None:
                ks_by_staff[None] = ks

        for staff in measure.findall(f"{{{_MEI_NS}}}staff"):
            staff_n = staff.get("n", "?")
            active_ks = ks_by_staff.get(staff_n, ks_by_staff.get(None, {}))

            events = []
            for seq, (onset, note) in enumerate(_staff_ordered_notes(staff)):
                accid_el = note.find(f"{{{_MEI_NS}}}accid")
                has_accid = accid_el is not None and "accid" in accid_el.attrib
                events.append(
                    (onset, 0 if has_accid else 1, seq, note, accid_el, has_accid)
                )
            events.sort(key=lambda e: (e[0], e[1], e[2]))

            running: dict[tuple[str, str], str] = {}
            for _onset, _ef, _seq, note, accid_el, has_accid in events:
                pname = note.get("pname", "")
                oct_ = note.get("oct", "")
                key = (pname, oct_)
                note_id = note.get(_XML_ID_KEY, "?")
                notated = accid_el.get("accid") if accid_el is not None else None
                ges = accid_el.get("accid.ges") if accid_el is not None else None
                is_tie = note_id in ties

                if has_accid:
                    running[key] = notated or ""
                    expected = _alt(notated)
                    realised = _alt(notated)
                elif is_tie:
                    expected = _alt(ties.get(note_id))
                    realised = _alt(ges) if ges is not None else _alt(notated)
                else:
                    exp_token = running[key] if key in running else active_ks.get(pname)
                    expected = _alt(exp_token)
                    realised = _alt(ges) if ges is not None else _alt(notated)

                out.append(
                    NoteTrace(
                        m_n,
                        staff_n,
                        pname,
                        oct_,
                        note_id,
                        notated,
                        ges,
                        expected,
                        realised,
                        is_tie,
                    )
                )
    return out


def audit_accidentals(
    mei_bytes: bytes,
    *,
    measures: set[int] | None = None,
    verbose: bool = True,
) -> list[NoteTrace]:
    """Audit accidentals and return the mismatches (empty == clean).

    Args:
        mei_bytes: The MEI document to audit.
        measures: When given, restrict the printed report to these measure
            numbers (mismatches are still gathered from the whole document).
        verbose: When ``True``, print a per-mismatch report to stdout.

    Returns:
        The list of mismatching :class:`NoteTrace` notes.
    """
    traces = trace_accidentals(mei_bytes)
    mismatches = [t for t in traces if t.mismatch]

    if verbose:
        shown = mismatches
        if measures is not None:
            shown = [t for t in mismatches if _as_int(t.measure) in measures]
        print(f"\n{len(traces)} notes audited; {len(mismatches)} mismatch(es).")
        for t in shown:
            print(
                f"  m{t.measure} staff{t.staff} {t.pname}{t.oct} "
                f"id={t.xml_id} accid={t.notated} ges={t.ges} "
                f"realised {t.realised:+d} != expected {t.expected:+d}"
            )
        print(
            "Result: "
            + (
                "PASS (no mismatches)"
                if not mismatches
                else f"{len(mismatches)} MISMATCH(ES)"
            )
        )

    return mismatches


def verify_midi(mei_bytes: bytes) -> list[str]:
    """Cross-check the engine model: realised tokens vs Verovio's MIDI pitches.

    Renders MIDI and confirms each note's realised alteration (from its encoded
    ``accid.ges``/``@accid``) equals what Verovio actually plays.  Returns a list
    of discrepancy strings (empty when the engine model holds for this file).

    Args:
        mei_bytes: The MEI document to render.

    Returns:
        Human-readable discrepancy lines.
    """
    import lxml.etree
    import verovio

    _nat = {"c": 0, "d": 2, "e": 4, "f": 5, "g": 7, "a": 9, "b": 11}
    tk = verovio.toolkit()
    tk.loadData(mei_bytes.decode("utf-8"))
    tk.renderToMIDI()
    root = lxml.etree.fromstring(mei_bytes)
    discrepancies: list[str] = []
    for note in root.findall(f".//{{{_MEI_NS}}}note"):
        nid = note.get(_XML_ID_KEY)
        if not nid:
            continue
        pitch = tk.getMIDIValuesForElement(nid).get("pitch")
        if pitch is None:
            continue
        pname, oct_ = note.get("pname", ""), note.get("oct")
        if pname not in _nat or oct_ is None:
            continue
        accid_el = note.find(f"{{{_MEI_NS}}}accid")
        ges = accid_el.get("accid.ges") if accid_el is not None else None
        notated = accid_el.get("accid") if accid_el is not None else None
        realised = _alt(ges) if ges is not None else _alt(notated)
        base = (int(oct_) + 1) * 12 + _nat[pname]
        if pitch - base != realised:
            discrepancies.append(
                f"{pname}{oct_} id={nid}: MIDI {pitch} (alter {pitch - base:+d}) "
                f"but encoding implies {realised:+d}"
            )
    return discrepancies


def _as_int(value: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return -1


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
        description="Audit gestural-accidental resolution on a single .mscx (B1-B3)."
    )
    parser.add_argument(
        "--mscx", required=True, type=Path, help="Path to a real .mscx."
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
        help="Audit the raw prep output (before the resolver) to surface the defects.",
    )
    parser.add_argument(
        "--measures",
        help="Comma-separated measure numbers to restrict the printed report to.",
    )
    parser.add_argument(
        "--verify-midi",
        action="store_true",
        help="Also render MIDI and confirm the Verovio engine model holds.",
    )
    args = parser.parse_args()

    if not args.mscx.exists():
        print(f"error: {args.mscx} not found", file=sys.stderr)
        return 2

    measures = (
        {int(x) for x in args.measures.split(",") if x.strip()}
        if args.measures
        else None
    )
    print(
        f"Auditing {args.mscx.name} via {args.mscore_path} "
        f"(normalize={'on' if args.normalize else 'off'}) ..."
    )
    mei = run_pipeline(args.mscx, args.mscore_path, normalize=args.normalize)
    mismatches = audit_accidentals(mei, measures=measures)

    rc = 1 if mismatches else 0
    if args.verify_midi:
        disc = verify_midi(mei)
        print(f"\nEngine-model cross-check: {len(disc)} discrepancy(ies).")
        for d in disc:
            print(f"  {d}")
        if disc:
            rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
