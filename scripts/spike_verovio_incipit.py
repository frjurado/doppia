"""Verovio Python bindings spike — Component 2, Step 1.

Answers four questions before the generate_incipit Celery task is written:

  A. API pattern: does select() restrict output to the named measures, and does
     setOptions({"select": ...}) vs tk.select() differ in behaviour?
  B. Pickup bar: is @n="0" addressable via measureRange? Does "0-4" include the
     anacrusis or must the range start at "1"?
  C. Dimensions: what SVG height results from scale=30/35/40 with pageWidth=2200
     and adjustPageHeight=True?
  D. Idempotency: do two identical render calls produce byte-for-byte equal SVG?

Run from the repo root with the backend venv active:

    python scripts/spike_verovio_incipit.py

Output SVGs are written to scripts/spike_output/ for visual inspection.
Findings summary is printed to stdout.

This script is NOT a committed service — it is a manual spike.
Document findings in docs/architecture/mei-ingest-normalization.md under
§ "Verovio bar-range selection: observed behaviour".
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Ensure the backend package is importable (not strictly needed here since we
# only use verovio directly, but keeps the environment consistent).
# ---------------------------------------------------------------------------
REPO_ROOT = Path(__file__).parent.parent
FIXTURE_DIR = REPO_ROOT / "backend" / "tests" / "fixtures" / "mei"
OUTPUT_DIR = REPO_ROOT / "scripts" / "spike_output"
OUTPUT_DIR.mkdir(exist_ok=True)

_VRV_VERSION: str = "unknown"

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

# Pickup-bar MEI built inline so we control @n exactly.
# 4/4, one-beat pickup at @n="0", then full measures n=1 through n=5.
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
# Helpers
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
    """Remove XML comments from MEI string.

    Verovio 4.3.1 fails to parse MEI when an XML comment appears before the
    root <mei> element (parser bug).  Normalized MEI produced by the lxml
    normalizer does not contain comments, so this is only needed for fixture
    files.  Strip defensively here; document the bug in the spike findings.
    """
    return re.sub(r"<!--.*?-->", "", mei_str, flags=re.DOTALL)


def _render(mei_str: str, options: dict) -> str:
    """Create a fresh toolkit, set options, load MEI, return page-1 SVG."""
    tk = verovio.toolkit()
    tk.setOptions(options)
    ok = tk.loadData(_strip_xml_comments(mei_str))
    if not ok:
        raise RuntimeError(f"Verovio failed to load MEI data. Log: {tk.getLog()}")
    return tk.renderToSVG(1)


def _render_with_select_method(mei_str: str, options: dict, select_arg: dict) -> str:
    """Render using tk.select() called after loadData."""
    tk = verovio.toolkit()
    tk.setOptions(options)
    ok = tk.loadData(_strip_xml_comments(mei_str))
    if not ok:
        raise RuntimeError(f"Verovio failed to load MEI data. Log: {tk.getLog()}")
    tk.select(select_arg)
    tk.redoLayout()
    return tk.renderToSVG(1)


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
# Section A — API comparison: setOptions select vs tk.select()
# ---------------------------------------------------------------------------

def section_a(k331_mei: str) -> dict:
    _header("A — API comparison: setOptions vs tk.select()")

    results: dict = {}

    # A1: full render (baseline — no selection)
    svg_full = _render(k331_mei, BASE_OPTIONS)
    _save(svg_full, "A1_full_no_selection")
    measures_full = _measure_count_in_svg(svg_full)
    w, h = _svg_dimensions(svg_full)
    print(f"  A1 full render: {measures_full} measure elements, {w}×{h}")
    results["full_measure_count"] = measures_full
    results["full_dims"] = (w, h)

    # A2: setOptions with "select" key
    opts_with_select = {**BASE_OPTIONS, "select": [{"measureRange": "1-4"}]}
    svg_opts = _render(k331_mei, opts_with_select)
    _save(svg_opts, "A2_setOptions_select_1_4")
    measures_opts = _measure_count_in_svg(svg_opts)
    w2, h2 = _svg_dimensions(svg_opts)
    print(f"  A2 setOptions select 1-4: {measures_opts} measure elements, {w2}×{h2}")
    results["setOptions_measure_count"] = measures_opts
    results["setOptions_dims"] = (w2, h2)
    results["setOptions_restricts"] = measures_opts < measures_full

    # A3: tk.select() called after loadData
    svg_method = _render_with_select_method(
        k331_mei, BASE_OPTIONS, {"measureRange": "1-4"}
    )
    _save(svg_method, "A3_select_method_1_4")
    measures_method = _measure_count_in_svg(svg_method)
    w3, h3 = _svg_dimensions(svg_method)
    print(f"  A3 tk.select() 1-4: {measures_method} measure elements, {w3}×{h3}")
    results["select_method_measure_count"] = measures_method
    results["select_method_dims"] = (w3, h3)
    results["select_method_restricts"] = measures_method < measures_full

    # Are both approaches equivalent?
    results["approaches_identical"] = svg_opts == svg_method
    print(f"  A4 setOptions == tk.select(): {results['approaches_identical']}")

    if not results["setOptions_restricts"] and not results["select_method_restricts"]:
        print("  WARNING: Neither approach restricted the rendered measures.")
        print("           Falling back to full-score render for incipit may be needed.")

    return results


# ---------------------------------------------------------------------------
# Section B — Pickup bar (@n="0") addressability
# ---------------------------------------------------------------------------

def section_b() -> dict:
    _header("B — Pickup bar: is @n=0 addressable via measureRange?")

    results: dict = {}

    # B1: full render of pickup MEI (baseline)
    svg_full = _render(PICKUP_MEI, BASE_OPTIONS)
    _save(svg_full, "B1_pickup_full")
    measures_full = _measure_count_in_svg(svg_full)
    print(f"  B1 full render: {measures_full} measure elements")
    results["full_measure_count"] = measures_full

    # B2: measureRange "0-4" (should include pickup + measures 1-4)
    # Use tk.select() called after loadData — the correct API in Verovio >= 3.13
    svg_0_4 = _render_with_select_method(PICKUP_MEI, BASE_OPTIONS, {"measureRange": "0-4"})
    _save(svg_0_4, "B2_select_0_4")
    measures_0_4 = _measure_count_in_svg(svg_0_4)
    print(f"  B2 measureRange 0-4: {measures_0_4} measure elements")
    results["range_0_4_count"] = measures_0_4

    # B3: measureRange "1-4" (excludes pickup — compare with B2)
    svg_1_4 = _render_with_select_method(PICKUP_MEI, BASE_OPTIONS, {"measureRange": "1-4"})
    _save(svg_1_4, "B3_select_1_4")
    measures_1_4 = _measure_count_in_svg(svg_1_4)
    print(f"  B3 measureRange 1-4: {measures_1_4} measure elements")
    results["range_1_4_count"] = measures_1_4

    # Interpretation
    if measures_0_4 > measures_1_4:
        results["pickup_addressable"] = True
        print("  RESULT: @n=0 IS addressable — range 0-4 includes the pickup bar.")
        print("          Recommended range for incipit task: '0-4' when pickup exists.")
    elif measures_0_4 == measures_1_4:
        results["pickup_addressable"] = False
        print("  RESULT: @n=0 NOT addressable — 0-4 and 1-4 produce the same output.")
        print("          Verovio likely uses 1-based internal indexing.")
        print("          Recommended strategy: always use '1-4'; pickup included implicitly")
        print("          (Verovio renders the full first system which contains the pickup).")
    else:
        results["pickup_addressable"] = "unexpected"
        print(f"  UNEXPECTED: 0-4 gave fewer measures ({measures_0_4}) than 1-4 ({measures_1_4}).")

    return results


# ---------------------------------------------------------------------------
# Section C — Dimensions at different scale values
# ---------------------------------------------------------------------------

def section_c(k331_mei: str) -> dict:
    _header("C — SVG dimensions at scale 30/35/40")

    results: dict = {}
    for scale in (30, 35, 40):
        opts = {**BASE_OPTIONS, "scale": scale}
        # Use tk.select() called after loadData — correct API in Verovio >= 3.13
        svg = _render_with_select_method(k331_mei, opts, {"measureRange": "1-4"})
        _save(svg, f"C_scale_{scale}")
        w, h = _svg_dimensions(svg)
        print(f"  scale={scale}: {w}×{h}")
        results[f"scale_{scale}"] = {"width": w, "height": h}

    return results


# ---------------------------------------------------------------------------
# Section D — Idempotency
# ---------------------------------------------------------------------------

def section_d(k331_mei: str) -> dict:
    _header("D — Idempotency")

    results: dict = {}
    clean_mei = _strip_xml_comments(k331_mei)

    # D1: without seeding
    def _render_direct(mei_str: str, options: dict) -> str:
        tk = verovio.toolkit()
        tk.setOptions(options)
        ok = tk.loadData(mei_str)
        if not ok:
            raise RuntimeError(tk.getLog())
        return tk.renderToSVG(1)

    svg1 = _render_direct(clean_mei, BASE_OPTIONS)
    svg2 = _render_direct(clean_mei, BASE_OPTIONS)
    identical_unseeded = svg1 == svg2
    results["unseeded_identical"] = identical_unseeded
    print(f"  D1 without seed: identical={identical_unseeded}")

    if not identical_unseeded:
        lines1, lines2 = svg1.splitlines(), svg2.splitlines()
        for i, (l1, l2) in enumerate(zip(lines1, lines2)):
            if l1 != l2:
                print(f"     first diff line {i + 1}: {l1[:100]!r}")
                break

    # D2: with resetXmlIdSeed(0) before each render
    def _render_seeded(mei_str: str, options: dict, seed: int = 0) -> str:
        tk = verovio.toolkit()
        tk.resetXmlIdSeed(seed)
        tk.setOptions(options)
        ok = tk.loadData(mei_str)
        if not ok:
            raise RuntimeError(tk.getLog())
        return tk.renderToSVG(1)

    svg3 = _render_seeded(clean_mei, BASE_OPTIONS, seed=0)
    svg4 = _render_seeded(clean_mei, BASE_OPTIONS, seed=0)
    identical_seeded = svg3 == svg4
    results["seeded_identical"] = identical_seeded
    print(f"  D2 with resetXmlIdSeed(0): identical={identical_seeded}")

    if identical_seeded:
        print("  RESULT: resetXmlIdSeed(0) makes output deterministic. Use in task.")
    elif not identical_unseeded and not identical_seeded:
        print("  WARNING: Neither approach is deterministic.")
        print("           Cache strategy must use movement_id as cache key,")
        print("           not SVG content hash.")

    _save(svg3, "D_seeded_render")

    return results


# ---------------------------------------------------------------------------
# Section E — Narrow pageWidth approach (alternative to select)
# ---------------------------------------------------------------------------

def section_e(k331_mei: str) -> dict:
    _header("E — Narrow pageWidth: natural first-system break as incipit")

    results: dict = {}
    clean_mei = _strip_xml_comments(k331_mei)

    # Try different pageWidths at scale=35 to see how many measures fit on page 1.
    # k331 fixture: 6/8, 6 measures. Real movements have many more.
    for pw in (400, 600, 800, 1200):
        opts = {
            "pageWidth": pw,
            "pageHeight": 800,
            "adjustPageHeight": True,
            "breaks": "smart",  # allow natural breaks
            "scale": 35,
        }
        tk = verovio.toolkit()
        tk.resetXmlIdSeed(0)
        tk.setOptions(opts)
        ok = tk.loadData(clean_mei)
        if not ok:
            raise RuntimeError(tk.getLog())
        pages = tk.getPageCount()
        svg_p1 = tk.renderToSVG(1)
        m_p1 = _measure_count_in_svg(svg_p1)
        w, h = _svg_dimensions(svg_p1)
        print(f"  pageWidth={pw}: {pages} pages, page-1 has {m_p1} measures, {w}×{h}")
        results[f"pw_{pw}"] = {"pages": pages, "p1_measures": m_p1, "dims": (w, h)}
        _save(svg_p1, f"E_pw{pw}_page1")

    print()
    print("  NOTE: k331 fixture only has 6 measures; real movements may break differently.")
    print("  Recommended approach: use pageWidth ~600, take page 1 (naturally ~3-4 bars)")
    print("  at scale=35 for most 4/4 and 6/8 movements. Verify against real Mozart data.")

    return results


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    global _VRV_VERSION
    _VRV_VERSION = verovio.toolkit().getVersion()
    print("Verovio Python bindings spike")
    print(f"verovio version: {_VRV_VERSION}")
    print(f"Output dir: {OUTPUT_DIR}")

    k331_mei = K331_MEI_PATH.read_text(encoding="utf-8")

    results_a = section_a(k331_mei)
    results_b = section_b()
    results_c = section_c(k331_mei)
    results_d = section_d(k331_mei)
    results_e = section_e(k331_mei)

    # Summary
    _header("SUMMARY — copy this into mei-ingest-normalization.md")
    print(json.dumps(
        {
            "verovio_version": _VRV_VERSION,
            "section_a_select_api": results_a,
            "section_b_pickup_bar": results_b,
            "section_c_dimensions": results_c,
            "section_d_idempotency": results_d,
            "section_e_narrow_pagewidth": results_e,
        },
        indent=2,
        default=str,
    ))

    print()
    print("SVGs written to:", OUTPUT_DIR)
    print("Open them in a browser to verify visual output.")
    print()
    print("Next step: append findings to")
    print("  docs/architecture/mei-ingest-normalization.md")
    print("  under § 'Verovio bar-range selection: observed behaviour'")


if __name__ == "__main__":
    main()
