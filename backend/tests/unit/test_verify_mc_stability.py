"""Unit tests for scripts/verify_reingest_mc_stability.py.

Pins the contract the Step 9 mc-stability check depends on: the per-measure
fingerprint must be *invariant* under exactly the normalizer changes Steps 6–8
introduce (measure-start clef recovery, cross-barline tie completion, accidental
normalization) and *sensitive* to a measure being added, removed, or reordered.

``verify_reingest_mc_stability`` is importable because pyproject.toml adds
``scripts/`` to pytest's pythonpath.
"""

from __future__ import annotations

import verify_reingest_mc_stability as v

_MEI_TEMPLATE = """<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei">
  <music><body><mdiv><score>
    <section>{measures}</section>
  </score></mdiv></body></music>
</mei>"""


def _measure(n: int, body: str) -> str:
    return f'<measure n="{n}"><staff n="1"><layer>{body}</layer></staff></measure>'


def _doc(*measures: str) -> bytes:
    return _MEI_TEMPLATE.format(measures="".join(measures)).encode("utf-8")


_C4 = '<note pname="c" oct="4" dur="4"/>'
_D4 = '<note pname="d" oct="4" dur="4"/>'
_E4 = '<note pname="e" oct="4" dur="4"/>'


def test_fingerprint_one_per_measure_in_order() -> None:
    doc = _doc(_measure(1, _C4), _measure(2, _D4), _measure(3, _E4))
    fps = v.measure_content_fingerprints(doc)
    assert len(fps) == 3
    assert len(set(fps)) == 3  # distinct content -> distinct hashes


def test_invariant_under_inserted_clef() -> None:
    """Step 6: a recovered measure-start clef must not move mc."""
    base = _doc(_measure(1, _C4), _measure(2, _D4))
    with_clef = _doc(
        _measure(1, _C4),
        _measure(2, '<clef shape="F" line="4"/>' + _D4),
    )
    assert v.measure_content_fingerprints(base) == v.measure_content_fingerprints(
        with_clef
    )


def test_invariant_under_tie_and_accidental() -> None:
    """Step 7 tie completion and ADR-021/022 accidental edits must not move mc."""
    base = _doc(_measure(1, _C4), _measure(2, _D4))
    with_tie_accid = _doc(
        _measure(1, '<note pname="c" oct="4" dur="4" accid.ges="f"/><tie/>'),
        _measure(2, _D4),
    )
    assert v.measure_content_fingerprints(base) == v.measure_content_fingerprints(
        with_tie_accid
    )


def test_sensitive_to_added_measure() -> None:
    base = _doc(_measure(1, _C4), _measure(2, _D4))
    inserted = _doc(_measure(1, _C4), _measure(99, _E4), _measure(2, _D4))
    fp_base = v.measure_content_fingerprints(base)
    fp_ins = v.measure_content_fingerprints(inserted)
    assert len(fp_ins) == len(fp_base) + 1
    assert fp_ins[0] == fp_base[0]  # mc 1 unchanged
    assert fp_ins[1] != fp_base[1]  # mc 2 now holds the inserted measure


def test_sensitive_to_reordered_measures() -> None:
    base = _doc(_measure(1, _C4), _measure(2, _D4))
    swapped = _doc(_measure(1, _D4), _measure(2, _C4))
    assert v.measure_content_fingerprints(base) != v.measure_content_fingerprints(
        swapped
    )
