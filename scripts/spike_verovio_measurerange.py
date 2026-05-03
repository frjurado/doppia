"""Verovio `measureRange` keyword syntax spike — incipit generation pre-work.

Answers four questions left open by `scripts/spike_verovio_incipit.py` before
`generate_incipit.py` is updated to use `select({measureRange: "start-4"})`:

  A. Does `"start-N"` syntax work?  Is `measureRange: "start-4"` equivalent to
     `"1-4"` on a movement with no pickup bar?
  B. Does `"start-N"` include a pickup bar at position 1 (`@n="0"`)?
  C. Does position-index addressing correctly isolate individual `<ending>` elements
     that share `@n="2"`?  (Validates that mc_start/mc_end can be used directly as
     measureRange operands for fragment rendering.)
  D. Does the `"end"` keyword work?  Does `"start-100"` on a 6-measure piece degrade
     gracefully?

Run from the repo root with the backend venv active:

    python scripts/spike_verovio_measurerange.py

Output SVGs are written to scripts/spike_output/ for visual inspection.
Findings summary is printed to stdout as JSON.

Document findings in docs/architecture/mei-ingest-normalization.md under a new
section "Verovio measureRange keyword syntax: observed behaviour".
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent.parent
FIXTURE_DIR = REPO_ROOT / "backend" / "tests" / "fixtures" / "mei"
OUTPUT_DIR = REPO_ROOT / "scripts" / "spike_output"
OUTPUT_DIR.mkdir(exist_ok=True)

try:
    import verovio
except ImportError:
    sys.exit(
        "verovio not found. Activate the backend venv:\n"
        "  cd backend && source .venv/bin/activate  (or .venv\\Scripts\\activate)\n"
        "  pip install -r requirements.txt"
    )

# ---------------------------------------------------------------------------
# MEI fixtures
# ---------------------------------------------------------------------------

K331_MEI_PATH = FIXTURE_DIR / "k331-movement-1.mei"
VOLTA_MEI_PATH = FIXTURE_DIR / "volta-movement.mei"

# Pickup-bar fixture: 4/4, pickup at @n="0" (position 1), full measures n=1–5
# (positions 2–6).  Copied from spike_verovio_incipit.py so this script is
# self-contained.
PICKUP_MEI = """\
<?xml version="1.0" encoding="UTF-8"?>
<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">
  <meiHead>
    <fileDesc>
      <titleStmt><title>Spike — pickup bar @n=0</title></titleStmt>
      <pubStmt/>
    </fileDesc>
  </meiHead>
  <music>
    <body>
      <mdiv>
        <score>
          <scoreDef meter.count="4" meter.unit="4">
            <staffGrp>
              <staffDef n="1" clef.shape="G" clef.line="2" lines="5"/>
            </staffGrp>
          </scoreDef>
          <section>
            <measure n="0" metcon="false">
              <staff n="1"><layer n="1">
                <note dur="4" oct="4" pname="e"/>
              </layer></staff>
            </measure>
            <measure n="1">
              <staff n="1"><layer n="1">
                <note dur="4" oct="4" pname="c"/>
                <note dur="4" oct="4" pname="d"/>
                <note dur="4" oct="4" pname="e"/>
                <note dur="4" oct="4" pname="f"/>
              </layer></staff>
            </measure>
            <measure n="2">
              <staff n="1"><layer n="1">
                <note dur="4" oct="4" pname="g"/>
                <note dur="4" oct="4" pname="a"/>
                <note dur="4" oct="4" pname="b"/>
                <note dur="4" oct="5" pname="c"/>
              </layer></staff>
            </measure>
            <measure n="3">
              <staff n="1"><layer n="1">
                <note dur="4" oct="5" pname="d"/>
                <note dur="4" oct="5" pname="e"/>
                <note dur="4" oct="5" pname="f"/>
                <note dur="4" oct="5" pname="g"/>
              </layer></staff>
            </measure>
            <measure n="4">
              <staff n="1"><layer n="1">
                <note dur="4" oct="5" pname="a"/>
                <note dur="4" oct="4" pname="b"/>
                <note dur="4" oct="4" pname="a"/>
                <note dur="4" oct="4" pname="g"/>
              </layer></staff>
            </measure>
            <measure n="5">
              <staff n="1"><layer n="1">
                <note dur="4" oct="4" pname="f"/>
                <note dur="4" oct="4" pname="e"/>
                <note dur="4" oct="4" pname="d"/>
                <note dur="4" oct="4" pname="c"/>
              </layer></staff>
            </measure>
          </section>
        </score>
      </mdiv>
    </body>
  </music>
</mei>
"""

# ---------------------------------------------------------------------------
# Helpers  (same API as spike_verovio_incipit.py)
# ---------------------------------------------------------------------------

BASE_OPTIONS: dict = {
    "pageWidth": 2200,
    "pageHeight": 800,
    "adjustPageHeight": True,
    "breaks": "none",
    "scale": 35,
}


def _svg_dimensions(svg: str) -> tuple[str, str]:
    """Return (width, height) attribute values from the root <svg> element."""
    w = re.search(r'<svg[^>]+\bwidth="([^"]+)"', svg)
    h = re.search(r'<svg[^>]+\bheight="([^"]+)"', svg)
    return (w.group(1) if w else "?"), (h.group(1) if h else "?")


def _measure_count_in_svg(svg: str) -> int:
    """Count <g class="measure"> elements as a proxy for rendered measures."""
    return len(re.findall(r'class="[^"]*\bmeasure\b[^"]*"', svg))


def _strip_xml_comments(mei_str: str) -> str:
    return re.sub(r"<!--.*?-->", "", mei_str, flags=re.DOTALL)


def _render_with_select_method(mei_str: str, options: dict, select_arg: dict) -> str:
    """Render using tk.select() called after loadData + redoLayout."""
    tk = verovio.toolkit()
    tk.setOptions(options)
    ok = tk.loadData(_strip_xml_comments(mei_str))
    if not ok:
        raise RuntimeError(f"Verovio failed to load MEI. Log: {tk.getLog()}")
    tk.select(select_arg)
    tk.redoLayout()
    return tk.renderToSVG(1)


def _render_full(mei_str: str, options: dict) -> str:
    """Render without any selection (baseline)."""
    tk = verovio.toolkit()
    tk.setOptions(options)
    ok = tk.loadData(_strip_xml_comments(mei_str))
    if not ok:
        raise RuntimeError(f"Verovio failed to load MEI. Log: {tk.getLog()}")
    return tk.renderToSVG(1)


def _render_with_select_log(
    mei_str: str, options: dict, select_arg: dict
) -> tuple[str, str]:
    """Like _render_with_select_method but also returns the Verovio log."""
    tk = verovio.toolkit()
    tk.setOptions(options)
    ok = tk.loadData(_strip_xml_comments(mei_str))
    if not ok:
        raise RuntimeError(f"Verovio failed to load MEI. Log: {tk.getLog()}")
    tk.select(select_arg)
    tk.redoLayout()
    svg = tk.renderToSVG(1)
    return svg, tk.getLog()


def _save(svg: str, name: str) -> Path:
    path = OUTPUT_DIR / f"{name}.svg"
    path.write_text(svg, encoding="utf-8")
    return path


def _header(title: str) -> None:
    print()
    print("=" * 70)
    print(f"  {title}")
    print("=" * 70)


# ---------------------------------------------------------------------------
# Section A — "start-N" syntax on a plain movement (no pickup, no endings)
# ---------------------------------------------------------------------------


def section_a(k331_mei: str) -> dict:
    _header('A — "start-N" syntax (k331, 6 measures, no endings)')

    results: dict = {}

    # A1: explicit "1-4" — confirmed working baseline from previous spike
    svg_1_4 = _render_with_select_method(
        k331_mei, BASE_OPTIONS, {"measureRange": "1-4"}
    )
    _save(svg_1_4, "A1_explicit_1_4")
    a1_count = _measure_count_in_svg(svg_1_4)
    a1_dims = _svg_dimensions(svg_1_4)
    print(
        f"  A1 measureRange '1-4':     {a1_count} measures, {a1_dims[0]}×{a1_dims[1]}"
    )
    results["A1_explicit_1_4"] = {"count": a1_count, "dims": a1_dims}

    # A2: "start-4" — does the keyword work?
    svg_s4 = _render_with_select_method(
        k331_mei, BASE_OPTIONS, {"measureRange": "start-4"}
    )
    _save(svg_s4, "A2_start_4")
    a2_count = _measure_count_in_svg(svg_s4)
    a2_dims = _svg_dimensions(svg_s4)
    print(
        f"  A2 measureRange 'start-4': {a2_count} measures, {a2_dims[0]}×{a2_dims[1]}"
    )
    results["A2_start_4"] = {"count": a2_count, "dims": a2_dims}

    # A3: "start-6" — does "start-N" with N == total measures render all?
    svg_s6 = _render_with_select_method(
        k331_mei, BASE_OPTIONS, {"measureRange": "start-6"}
    )
    _save(svg_s6, "A3_start_6")
    a3_count = _measure_count_in_svg(svg_s6)
    a3_dims = _svg_dimensions(svg_s6)
    print(
        f"  A3 measureRange 'start-6': {a3_count} measures, {a3_dims[0]}×{a3_dims[1]}"
    )
    results["A3_start_6"] = {"count": a3_count, "dims": a3_dims}

    # Interpretation
    results["start_N_works"] = a2_count == a1_count
    results["start_N_same_dims_as_explicit"] = a2_dims == a1_dims
    if results["start_N_works"]:
        print(
            '  RESULT: "start-N" produces the same output as explicit "1-N". Safe to adopt.'
        )
    else:
        print(
            f'  WARNING: "start-4" gave {a2_count} measures vs "1-4" gave {a1_count}.'
            " Do NOT use start-N syntax — fall back to explicit range."
        )

    return results


# ---------------------------------------------------------------------------
# Section B — "start-N" with a pickup bar at @n="0" (position 1)
# ---------------------------------------------------------------------------


def section_b() -> dict:
    _header('B — "start-N" with pickup bar (@n="0" at position 1)')

    results: dict = {}

    # B1: full render (baseline — 6 positions: pickup + n=1..5)
    svg_full = _render_full(PICKUP_MEI, BASE_OPTIONS)
    _save(svg_full, "B1_pickup_full")
    b1_count = _measure_count_in_svg(svg_full)
    print(f"  B1 full render:            {b1_count} measures (expected 6)")
    results["B1_full"] = {"count": b1_count}

    # B2: "start-4" — should give positions 1–4 (pickup + n=1,2,3)
    svg_s4 = _render_with_select_method(
        PICKUP_MEI, BASE_OPTIONS, {"measureRange": "start-4"}
    )
    _save(svg_s4, "B2_pickup_start_4")
    b2_count = _measure_count_in_svg(svg_s4)
    b2_dims = _svg_dimensions(svg_s4)
    print(
        f"  B2 measureRange 'start-4': {b2_count} measures, {b2_dims[0]}×{b2_dims[1]}"
    )
    results["B2_start_4"] = {"count": b2_count, "dims": b2_dims}

    # B3: "1-4" (explicit) — should give the same 4 positions
    svg_1_4 = _render_with_select_method(
        PICKUP_MEI, BASE_OPTIONS, {"measureRange": "1-4"}
    )
    _save(svg_1_4, "B3_pickup_1_4")
    b3_count = _measure_count_in_svg(svg_1_4)
    b3_dims = _svg_dimensions(svg_1_4)
    print(
        f"  B3 measureRange '1-4':     {b3_count} measures, {b3_dims[0]}×{b3_dims[1]}"
    )
    results["B3_explicit_1_4"] = {"count": b3_count, "dims": b3_dims}

    # Interpretation
    results["start_N_includes_pickup"] = b2_count == 4
    results["start_N_equiv_explicit_with_pickup"] = b2_count == b3_count
    if b2_count == b3_count == 4:
        print(
            '  RESULT: "start-4" and "1-4" both include the pickup bar (4 measures each).'
            " Use start-N for incipits — pickup bar is automatically included."
        )
    elif b2_count != b3_count:
        print(
            f'  NOTE: "start-4" gave {b2_count} measures, "1-4" gave {b3_count}.'
            " Behaviour differs — check SVGs for visual confirmation."
        )
    else:
        print(f"  UNEXPECTED: b2={b2_count}, b3={b3_count}. Inspect SVGs manually.")

    return results


# ---------------------------------------------------------------------------
# Section C — Position-index correctness under volta endings
# ---------------------------------------------------------------------------


def section_c(volta_mei: str) -> dict:
    _header("C — Position index under volta endings (volta fixture, 4 positions)")
    print("  Fixture structure: pos1=n1, pos2=ending1/n2, pos3=ending2/n2, pos4=n3")

    results: dict = {}

    # C1: full render (baseline — should give 4 measure elements)
    svg_full = _render_full(volta_mei, BASE_OPTIONS)
    _save(svg_full, "C1_volta_full")
    c1_count = _measure_count_in_svg(svg_full)
    print(f"  C1 full render:    {c1_count} measures (expected 4)")
    results["C1_full"] = {"count": c1_count}

    # C2: "1-2" — positions 1 (n=1) and 2 (ending1/n=2)
    svg_1_2 = _render_with_select_method(
        volta_mei, BASE_OPTIONS, {"measureRange": "1-2"}
    )
    _save(svg_1_2, "C2_volta_1_2")
    c2_count = _measure_count_in_svg(svg_1_2)
    c2_dims = _svg_dimensions(svg_1_2)
    print(
        f"  C2 range '1-2':    {c2_count} measures (expected 2), {c2_dims[0]}×{c2_dims[1]}"
    )
    results["C2_range_1_2"] = {"count": c2_count, "dims": c2_dims}

    # C3: "3-4" — positions 3 (ending2/n=2) and 4 (n=3)
    svg_3_4 = _render_with_select_method(
        volta_mei, BASE_OPTIONS, {"measureRange": "3-4"}
    )
    _save(svg_3_4, "C3_volta_3_4")
    c3_count = _measure_count_in_svg(svg_3_4)
    c3_dims = _svg_dimensions(svg_3_4)
    print(
        f"  C3 range '3-4':    {c3_count} measures (expected 2), {c3_dims[0]}×{c3_dims[1]}"
    )
    results["C3_range_3_4"] = {"count": c3_count, "dims": c3_dims}

    # C4: "2-3" — positions 2 (ending1/n=2) and 3 (ending2/n=2) — two measures, same @n
    svg_2_3 = _render_with_select_method(
        volta_mei, BASE_OPTIONS, {"measureRange": "2-3"}
    )
    _save(svg_2_3, "C4_volta_2_3")
    c4_count = _measure_count_in_svg(svg_2_3)
    c4_dims = _svg_dimensions(svg_2_3)
    print(
        f"  C4 range '2-3':    {c4_count} measures (expected 2, both @n=2), "
        f"{c4_dims[0]}×{c4_dims[1]}"
    )
    results["C4_range_2_3"] = {"count": c4_count, "dims": c4_dims}

    # Interpretation
    position_index_correct = c2_count == 2 and c3_count == 2 and c4_count == 2
    results["position_index_correct_under_volta"] = position_index_correct
    if position_index_correct:
        print(
            "  RESULT: Position-index addressing is correct under volta endings."
            " mc_start/mc_end can be used directly as measureRange operands."
        )
    else:
        print(
            "  WARNING: Position-index addressing behaved unexpectedly."
            " Inspect SVGs before adopting mc_start/mc_end as measureRange operands."
        )

    return results


# ---------------------------------------------------------------------------
# Section D — "end" keyword and overflow behaviour
# ---------------------------------------------------------------------------


def section_d(k331_mei: str) -> dict:
    _header('D — "end" keyword and overflow (k331, 6 measures)')

    results: dict = {}

    # D1: full render (baseline — 6 measures)
    svg_full = _render_full(k331_mei, BASE_OPTIONS)
    d1_count = _measure_count_in_svg(svg_full)
    d1_dims = _svg_dimensions(svg_full)
    print(f"  D1 full render:         {d1_count} measures, {d1_dims[0]}×{d1_dims[1]}")
    results["D1_full"] = {"count": d1_count, "dims": d1_dims}

    # D2: "3-end" — should give positions 3–6 (4 measures)
    svg_3_end = _render_with_select_method(
        k331_mei, BASE_OPTIONS, {"measureRange": "3-end"}
    )
    _save(svg_3_end, "D2_3_end")
    d2_count = _measure_count_in_svg(svg_3_end)
    d2_dims = _svg_dimensions(svg_3_end)
    print(
        f"  D2 range '3-end':       {d2_count} measures (expected 4), {d2_dims[0]}×{d2_dims[1]}"
    )
    results["D2_3_end"] = {"count": d2_count, "dims": d2_dims}

    # D3: "start-end" — should give all 6 measures (same as full render)
    svg_start_end = _render_with_select_method(
        k331_mei, BASE_OPTIONS, {"measureRange": "start-end"}
    )
    _save(svg_start_end, "D3_start_end")
    d3_count = _measure_count_in_svg(svg_start_end)
    d3_dims = _svg_dimensions(svg_start_end)
    print(
        f"  D3 range 'start-end':   {d3_count} measures (expected {d1_count}), "
        f"{d3_dims[0]}×{d3_dims[1]}"
    )
    results["D3_start_end"] = {"count": d3_count, "dims": d3_dims}

    # D4: "start-100" — exceeds movement length; should clamp gracefully
    svg_s100, log_s100 = _render_with_select_log(
        k331_mei, BASE_OPTIONS, {"measureRange": "start-100"}
    )
    _save(svg_s100, "D4_start_100")
    d4_count = _measure_count_in_svg(svg_s100)
    d4_dims = _svg_dimensions(svg_s100)
    has_warning = bool(log_s100.strip())
    print(
        f"  D4 range 'start-100':   {d4_count} measures (expected {d1_count}), "
        f"{d4_dims[0]}×{d4_dims[1]}, log non-empty={has_warning}"
    )
    if has_warning:
        print(f"     Verovio log: {log_s100[:200]!r}")
    results["D4_start_100"] = {
        "count": d4_count,
        "dims": d4_dims,
        "verovio_log_non_empty": has_warning,
        "verovio_log_excerpt": log_s100[:200] if has_warning else "",
    }

    # Interpretation
    end_keyword_works = d2_count == 4 and d3_count == d1_count
    overflow_graceful = d4_count == d1_count
    results["end_keyword_works"] = end_keyword_works
    results["overflow_clamps_gracefully"] = overflow_graceful
    if end_keyword_works:
        print('  RESULT: "end" keyword works correctly.')
    else:
        print('  WARNING: "end" keyword did not produce expected measure counts.')
    if overflow_graceful:
        print(
            '  RESULT: "start-100" clamps gracefully to all measures — safe to use as fallback.'
        )
    else:
        print(
            '  WARNING: "start-100" did not produce full render — do not use as fallback.'
        )

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    vrv_version = verovio.toolkit().getVersion()
    print("Verovio measureRange keyword syntax spike")
    print(f"verovio version: {vrv_version}")
    print(f"Output dir:      {OUTPUT_DIR}")

    k331_mei = K331_MEI_PATH.read_text(encoding="utf-8")
    volta_mei = VOLTA_MEI_PATH.read_text(encoding="utf-8")

    results_a = section_a(k331_mei)
    results_b = section_b()
    results_c = section_c(volta_mei)
    results_d = section_d(k331_mei)

    _header("SUMMARY — copy findings into mei-ingest-normalization.md")
    print(
        json.dumps(
            {
                "verovio_version": vrv_version,
                "section_a_start_N_syntax": results_a,
                "section_b_start_N_with_pickup": results_b,
                "section_c_volta_position_index": results_c,
                "section_d_end_keyword_overflow": results_d,
            },
            indent=2,
            default=str,
        )
    )

    print()
    print("SVGs written to:", OUTPUT_DIR)
    print("Open them in a browser to verify visual output.")
    print()
    print("Next step: append findings to")
    print("  docs/architecture/mei-ingest-normalization.md")
    print('  under § "Verovio measureRange keyword syntax: observed behaviour"')


if __name__ == "__main__":
    main()
