"""DCML corpus-preparation pipeline.

Converts a cloned DCML repository into an upload ZIP ready for the
``POST /api/v1/composers/{slug}/corpora/{slug}/upload`` endpoint.

Pipeline (per movement):

1. Walk ``MS3/*.mscx`` files listed in the TOML config.
2. Convert each ``.mscx`` → ``.mxl`` via ``mscore`` CLI (MuseScore 3.6.2).
3. Renumber the ``.mxl`` measures uniquely for the import when the movement
   restarts its numbering at a section break, restoring the true ``@n`` after
   import so Verovio's number-keyed importer does not mis-route clefs (ADR-032).
4. Supply strain-opening repeats the source omits so Verovio's playback
   ``<expansion>`` pairs each ``:|`` with its own ``|:`` (ADR-033) — applies to
   every movement whose structure matches, not just section-restart ones.
5. Convert ``.mxl`` → ``.mei`` via ``verovio`` CLI.
6. Re-insert measure-start clef changes MuseScore drops from its export (ADR-031).
7. Run ``validate_mei()`` on the emitted MEI; abort on any hard error.
8. Locate the matching ``harmonies/*.tsv``.

Outputs a ZIP with the following structure::

    {corpus_slug}.zip
      metadata.yaml
      mei/{work_slug}/{movement_slug}.mei
      harmonies/{work_slug}/{movement_slug}.tsv

Usage::

    python scripts/prepare_dcml_corpus.py \\
      --repo-path ~/src/mozart_piano_sonatas \\
      --config scripts/dcml_corpora/mozart-piano-sonatas.toml \\
      --output /tmp/mozart-piano-sonatas.zip

Requirements:

- ``mscore`` (MuseScore 3.6.2) must be on ``PATH``, or pass ``--mscore-path``
  with the full executable path (e.g. on Windows: ``--mscore-path
  "C:/Program Files/MuseScore 3/bin/MuseScore3.exe"``).
- Python packages: ``pyyaml``, ``lxml``, ``pydantic``, ``verovio`` (installed via backend deps).

This is a developer-workstation script, not a container dependency.
See ``docs/roadmap/component-1-mei-corpus-ingestion.md`` §Step 6.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import tomllib
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

import yaml

if TYPE_CHECKING:
    import lxml.etree

# Bootstrap sys.path so backend packages are importable when running the
# script directly from the repo root (``python scripts/prepare_dcml_corpus.py``).
# When pytest imports this module (scripts/ is on pythonpath), the backend/
# directory is already on sys.path from pyproject.toml, so this insert is a
# harmless no-op.
sys.path.insert(0, str(Path(__file__).parent.parent / "backend"))

from models.ingestion import (  # noqa: E402
    ComposerMetadata,
    CorpusMetadata,
    IngestMetadata,
    MovementMetadata,
    WorkMetadata,
)
from services.mei_validator import validate_mei  # noqa: E402

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_SCRIPT = "prepare_dcml_corpus"

# Source-repository substrings that trigger an early ABC deny-list refusal
# before any file processing begins.  Mirrors the Pydantic-level check in
# ``backend/models/ingestion.py`` but fires even earlier so no temporary
# files are created.  Case-insensitive substring match.
_DENY_LIST: frozenset[str] = frozenset(
    {
        "DCMLab/ABC",
        "abc/beethoven-quartets",
        "abc/beethoven_quartets",
    }
)


# ---------------------------------------------------------------------------
# Data containers
# ---------------------------------------------------------------------------


@dataclass
class MovementEntry:
    """A single movement discovered from the TOML config and the DCML repo."""

    work_slug: str
    movement_slug: str
    mscx_path: Path
    work_toml: dict[str, Any]
    movement_toml: dict[str, Any]


@dataclass
class AcceptedMovement:
    """A movement that passed conversion and MEI validation."""

    entry: MovementEntry
    mei_bytes: bytes
    harmonies_path: Path | None


# ---------------------------------------------------------------------------
# Logging helpers
# ---------------------------------------------------------------------------


def _log(msg: str) -> None:
    """Print an info-level message with the script prefix."""
    print(f"[{_SCRIPT}] {msg}")


def _err(msg: str) -> None:
    """Print an error-level message to stderr with the script prefix."""
    print(f"[{_SCRIPT}] ERROR: {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns:
        Parsed namespace with ``repo_path``, ``config``, and ``output``.
    """
    parser = argparse.ArgumentParser(
        description=("Convert a cloned DCML repository into an upload ZIP for Doppia.")
    )
    parser.add_argument(
        "--repo-path",
        required=True,
        type=Path,
        help="Absolute or relative path to the cloned DCML repository.",
    )
    parser.add_argument(
        "--config",
        required=True,
        type=Path,
        help="TOML config file (e.g. scripts/dcml_corpora/mozart-piano-sonatas.toml).",
    )
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Destination path for the output ZIP file.",
    )
    parser.add_argument(
        "--mscore-path",
        type=str,
        default=None,
        help=(
            "Full path to the mscore/MuseScore executable. "
            "Defaults to resolving 'mscore' from PATH. "
            "On Windows use e.g. "
            "'C:/Program Files/MuseScore 3/bin/MuseScore3.exe'."
        ),
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# Config loading
# ---------------------------------------------------------------------------


def load_toml_config(config_path: Path) -> dict[str, Any]:
    """Load and parse a TOML config file.

    Args:
        config_path: Path to the ``.toml`` config.

    Returns:
        Parsed config as a plain dict.

    Raises:
        SystemExit: If the file cannot be opened or parsed.
    """
    try:
        with open(config_path, "rb") as fh:
            return tomllib.load(fh)
    except (OSError, tomllib.TOMLDecodeError) as exc:
        _err(f"Cannot load config {config_path}: {exc}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# ABC deny-list
# ---------------------------------------------------------------------------


def check_abc_deny_list(config: dict[str, Any]) -> None:
    """Refuse corpora on the ABC deny-list before any file processing.

    Performs a case-insensitive substring match against ``_DENY_LIST``.

    Args:
        config: Parsed TOML config dict.

    Raises:
        SystemExit: If ``corpus.source_repository`` matches a deny-list entry.
    """
    source_repo: str = (config.get("corpus") or {}).get("source_repository") or ""
    lowered = source_repo.lower()
    for denied in _DENY_LIST:
        if denied.lower() in lowered:
            _err(
                f"source_repository {source_repo!r} matches deny-list entry "
                f"{denied!r} (ADR-009: this corpus is not permitted for ingestion)."
            )
            sys.exit(1)


# ---------------------------------------------------------------------------
# Git SHA
# ---------------------------------------------------------------------------


def get_git_sha(repo_path: Path) -> str:
    """Return the HEAD commit SHA of the given repository.

    Args:
        repo_path: Path to the git repository root.

    Returns:
        40-character hex SHA, or ``"unknown"`` if git is unavailable or the
        directory is not a git repository.
    """
    result = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=repo_path,
        capture_output=True,
        text=True,
    )
    if result.returncode == 0:
        return result.stdout.strip()
    return "unknown"


# ---------------------------------------------------------------------------
# Movement discovery
# ---------------------------------------------------------------------------


def discover_movements(
    repo_path: Path,
    config: dict[str, Any],
) -> list[MovementEntry]:
    """Build an ordered list of movements from the TOML config.

    Verifies that each ``.mscx`` file referenced in the config exists at
    ``repo_path / "MS3" / mscx_filename``.

    Args:
        repo_path: Path to the cloned DCML repository.
        config: Parsed TOML config dict.

    Returns:
        Ordered list of :class:`MovementEntry` objects.

    Raises:
        SystemExit: If any referenced ``.mscx`` file is missing.
    """
    entries: list[MovementEntry] = []
    for work_toml in config.get("works", []):
        work_slug: str = work_toml["slug"]
        for movement_toml in work_toml.get("movements", []):
            movement_slug: str = movement_toml["slug"]
            mscx_filename: str = movement_toml["mscx_filename"]
            mscx_path = repo_path / "MS3" / mscx_filename
            if not mscx_path.exists():
                _err(
                    f"Missing .mscx file for {work_slug}/{movement_slug}: "
                    f"{mscx_path}"
                )
                sys.exit(1)
            entries.append(
                MovementEntry(
                    work_slug=work_slug,
                    movement_slug=movement_slug,
                    mscx_path=mscx_path,
                    work_toml=work_toml,
                    movement_toml=movement_toml,
                )
            )
    return entries


# ---------------------------------------------------------------------------
# Conversion
# ---------------------------------------------------------------------------


def convert_mscx_to_mxl(
    mscx_path: Path, tmpdir: Path, mscore_exe: str = "mscore"
) -> Path:
    """Convert a MuseScore ``.mscx`` file to compressed MusicXML (``.mxl``).

    Calls the MuseScore CLI (3.6.2).  Pass the resolved executable path via
    ``mscore_exe`` — do not rely on bare ``"mscore"`` on Windows where the
    system PATH may differ from the shell PATH.

    Args:
        mscx_path: Source ``.mscx`` file.
        tmpdir: Temporary directory for the output file.
        mscore_exe: Full path (or bare name if on system PATH) of the mscore
            executable.

    Returns:
        Path to the generated ``.mxl`` file.

    Raises:
        subprocess.CalledProcessError: If ``mscore`` exits with a non-zero code.
    """
    out_mxl = tmpdir / (mscx_path.stem + ".mxl")
    subprocess.run(
        [mscore_exe, "--export-to", str(out_mxl), str(mscx_path)],
        check=True,
        capture_output=True,
        shell=mscore_exe.lower().endswith(".bat"),
    )
    return out_mxl


def convert_mxl_to_mei(mxl_path: Path, tmpdir: Path) -> bytes:
    """Convert a MusicXML ``.mxl`` file to MEI using the ``verovio`` Python bindings.

    Args:
        mxl_path: Source ``.mxl`` file.
        tmpdir: Unused; kept for signature compatibility.

    Returns:
        Raw MEI bytes, schema-clean for the MEI CMN RelaxNG profile.

    Raises:
        RuntimeError: If verovio fails to load the file.
    """
    import lxml.etree
    import verovio

    tk = verovio.toolkit()
    # Derive each element's xml:id from a checksum of the input data instead of
    # Verovio's default random seed.  This makes the ids *deterministic per
    # movement* — depending only on that movement's source bytes — so they are
    # reproducible across re-preps and stable as long as the source .mscx is
    # unchanged (pinned by each correction's ``source_sha``).  The corrections
    # overlay (ADR-027) locates targets by xml:id, which is only a viable locator
    # if the ids survive a re-prep; without this, every prep run renumbers every
    # element and the overlay would resolve to nothing on the next ingest.  See
    # ADR-030.
    tk.setOptions({"xmlIdChecksum": True})
    if not tk.loadFile(str(mxl_path)):
        raise RuntimeError(f"verovio failed to load {mxl_path}")
    mei_bytes = tk.getMEI().encode("utf-8")

    # Verovio adds encoding-metadata attributes that the CMN RelaxNG schema
    # does not permit.  Strip them before validation:
    #   - @meiversion on the root <mei> element
    #   - @version on <application> inside <appInfo>
    # Both are purely informational and have no effect on musical content.
    root = lxml.etree.fromstring(mei_bytes)
    root.attrib.pop("meiversion", None)
    for app in root.iter(f"{{{_MEI_NS}}}application"):
        app.attrib.pop("version", None)
    return lxml.etree.tostring(root, xml_declaration=True, encoding="UTF-8")


# ---------------------------------------------------------------------------
# Multi-section measure renumbering for the Verovio import (ADR-032)
# ---------------------------------------------------------------------------

_MEI_NS = "http://www.music-encoding.org/ns/mei"
_XML_NS = "http://www.w3.org/XML/1998/namespace"


def _renumber_musicxml(xml_bytes: bytes) -> tuple[bytes, list[str]] | None:
    """Renumber ``score-partwise`` measures to unique document-order numbers.

    Verovio's MusicXML importer keys clef (and repeat/ending) placement on the
    ``<measure number>`` attribute.  When a movement restarts its measure
    numbering at a section break (a minuet→trio, so the trio reuses the minuet's
    numbers), the importer routes the trio's clef changes onto the minuet bars of
    the same number and drops the mid-measure ones (ADR-032).  Rewriting every
    ``<measure>`` to a unique 1..N document-order number removes the collision.

    Args:
        xml_bytes: The uncompressed MusicXML score bytes (the ``.mxl`` rootfile).

    Returns:
        ``(new_xml_bytes, original_numbers)`` when the score carries duplicate
        measure numbers — ``original_numbers[i]`` is the original ``@number`` of
        the *i*-th measure in document order (read from the first part; all parts
        share the sequence), used to restore the true ``@n`` after import — or
        ``None`` when the numbers are already unique (renumbering is a no-op).
    """
    import io

    import lxml.etree

    parser = lxml.etree.XMLParser(resolve_entities=False, no_network=True)
    tree = lxml.etree.parse(io.BytesIO(xml_bytes), parser)
    root = tree.getroot()
    if root.tag != "score-partwise":
        return None  # score-timewise / unexpected root — leave untouched
    parts = root.findall("part")
    if not parts:
        return None

    # All parts carry the same measure sequence; the first part is canonical.
    original_numbers = [m.get("number", "") for m in parts[0].findall("measure")]
    if len(set(original_numbers)) == len(original_numbers):
        return None  # already unique — nothing to do

    for part in parts:
        for index, measure in enumerate(part.findall("measure"), start=1):
            measure.set("number", str(index))

    doctype = tree.docinfo.doctype or None
    new_bytes = lxml.etree.tostring(
        tree, xml_declaration=True, encoding="UTF-8", doctype=doctype
    )
    return new_bytes, original_numbers


def renumber_mxl_for_import(
    mxl_path: Path, tmpdir: Path
) -> tuple[Path, list[str] | None]:
    """Rewrite an ``.mxl`` so its measures are uniquely numbered for the import.

    Unzips the ``.mxl`` container, renumbers the score's measures via
    :func:`_renumber_musicxml`, and repacks — copying every other entry verbatim
    (preserving each entry's compression, so a ``STORED`` ``mimetype`` stays
    stored) and replacing only the score rootfile.  When the source already has
    unique measure numbers (a single-section movement) it is a no-op: the input
    path is returned with ``None`` and no restore is needed.

    Pair with :func:`restore_measure_numbers`, which puts the true (restarting)
    ``@n`` back on the MEI after :func:`convert_mxl_to_mei`.

    Args:
        mxl_path: The ``.mxl`` produced by :func:`convert_mscx_to_mxl`.
        tmpdir: Temporary directory for the rewritten ``.mxl``.

    Returns:
        ``(mxl_to_import, original_numbers)``: a rewritten ``.mxl`` path and the
        original document-order ``@number`` list when the source had duplicate
        numbers, otherwise ``(mxl_path, None)``.
    """
    import lxml.etree

    with zipfile.ZipFile(mxl_path) as zin:
        container = lxml.etree.fromstring(zin.read("META-INF/container.xml"))
        rootfile = container.find(".//{*}rootfile")
        score_name = rootfile.get("full-path") if rootfile is not None else None
        if not score_name:
            return mxl_path, None

        result = _renumber_musicxml(zin.read(score_name))
        if result is None:
            return mxl_path, None
        new_score, original_numbers = result

        out_path = tmpdir / (mxl_path.stem + ".renum.mxl")
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = new_score if item.filename == score_name else zin.read(item)
                # Passing the original ZipInfo preserves per-entry compression
                # (and order), so a STORED mimetype entry stays stored.
                zout.writestr(item, data)

    return out_path, original_numbers


def _left_forward_repeat(measure: lxml.etree._Element) -> lxml.etree._Element | None:
    """Return *measure*'s left forward-repeat ``<barline>`` (an opening ``|:``), or None."""
    for barline in measure.findall("barline"):
        if barline.get("location") == "left" and any(
            rep.get("direction") == "forward" for rep in barline.findall("repeat")
        ):
            return barline
    return None


def _has_backward_repeat(measure: lxml.etree._Element) -> bool:
    """Return whether *measure* carries a backward-repeat (a closing ``:|``)."""
    return any(
        rep.get("direction") == "backward"
        for barline in measure.findall("barline")
        for rep in barline.findall("repeat")
    )


def _strain_opening_repeats_needed(measures: list[lxml.etree._Element]) -> list[int]:
    """Return the 1-based indices of strain openings missing their forward-repeat.

    A *strain* is a run of measures that closes with a backward-repeat (``:|``).
    A strain that closes with ``:|`` but carries no forward-repeat (``|:``)
    anywhere within it is missing its opening repeat — the case a section-restart
    minuet/trio produces, where the DCML/MuseScore source omits the trio strains'
    opening ``|:`` (K331/ii mc49, mc65).  The very first strain is exempt: it
    opens at the movement start, whose opening repeat is implicit (the ``:|``
    repeats back to bar 1), so no glyph belongs there — exactly why the Menuetto's
    first strain must *not* get one while the trio's strains must.

    Args:
        measures: A part's ``<measure>`` elements in document order.

    Returns:
        The 1-based document-order indices at which to inject an opening ``|:``.
    """
    needed: list[int] = []
    strain_start = 1  # 1-based document-order index of the current strain's first bar
    for index, measure in enumerate(measures, start=1):
        if _has_backward_repeat(measure):
            scope = measures[strain_start - 1 : index]
            if strain_start != 1 and not any(
                _left_forward_repeat(m) is not None for m in scope
            ):
                needed.append(strain_start)
            strain_start = index + 1
    return needed


def repair_section_opening_repeats(
    mxl_path: Path, tmpdir: Path
) -> tuple[Path, list[int]]:
    """Inject the strain-opening repeats a section-restart source omits (ADR-033).

    Verovio builds the MIDI playback ``<expansion>`` at MusicXML-import time by
    pairing each backward-repeat (``:|``) with the most recent forward-repeat
    (``|:``).  When a trio strain closes with ``:|`` but its opening ``|:`` is
    absent (the DCML/MuseScore convention for a section that restarts), Verovio
    pairs the close with the *previous section's* ``|:`` — so the trio's repeat
    replays the end of the minuet instead (K331/ii: both trio repeats jump back to
    the Menuetto's bar 19).  This supplies the missing opening ``|:`` **before the
    import**, so the generated expansion is correct.  It must run pre-import: a
    post-import MEI edit (the earlier C2 overlay erratum) cannot help because the
    expansion is already frozen (ADR-033 supersedes that erratum).

    The injected barline is cloned from an existing forward-repeat in the score so
    its bar-style matches.  The rendered ``|:`` is an accepted minor engraving
    deviation (the NMA leaves the trio's first opening repeat implicit; Francisco
    chose the explicit glyph on 2026-07-01 as the simplest, most replicable fix).
    Injecting a barline changes neither measure count nor document order, so ``mc``
    is unaffected (ADR-015).

    Args:
        mxl_path: The ``.mxl`` (typically already renumbered for import).
        tmpdir: Temporary directory for the rewritten ``.mxl``.

    Returns:
        ``(mxl_to_import, injected_indices)``: a rewritten ``.mxl`` and the 1-based
        document-order measure indices that received an opening ``|:``, or
        ``(mxl_path, [])`` when nothing needed repair.
    """
    import copy
    import io

    import lxml.etree

    with zipfile.ZipFile(mxl_path) as zin:
        container = lxml.etree.fromstring(zin.read("META-INF/container.xml"))
        rootfile = container.find(".//{*}rootfile")
        score_name = rootfile.get("full-path") if rootfile is not None else None
        if not score_name:
            return mxl_path, []

        parser = lxml.etree.XMLParser(resolve_entities=False, no_network=True)
        tree = lxml.etree.parse(io.BytesIO(zin.read(score_name)), parser)
        root = tree.getroot()
        parts = root.findall("part")
        if not parts:
            return mxl_path, []

        indices = _strain_opening_repeats_needed(parts[0].findall("measure"))
        if not indices:
            return mxl_path, []

        # Clone an existing forward-repeat barline so bar-style/attributes match;
        # fall back to a minimal heavy-light opening repeat if the score has none.
        template = next(
            (
                bl
                for m in parts[0].findall("measure")
                if (bl := _left_forward_repeat(m)) is not None
            ),
            None,
        )
        for part in parts:
            measures = part.findall("measure")
            for index in indices:
                measure = measures[index - 1]
                if _left_forward_repeat(measure) is not None:
                    continue  # idempotent: already carries an opening repeat
                if template is not None:
                    barline = copy.deepcopy(template)
                else:
                    barline = lxml.etree.SubElement(measure, "barline")
                    barline.set("location", "left")
                    lxml.etree.SubElement(barline, "bar-style").text = "heavy-light"
                    lxml.etree.SubElement(barline, "repeat").set("direction", "forward")
                    measure.remove(barline)
                measure.insert(0, barline)

        doctype = tree.docinfo.doctype or None
        new_score = lxml.etree.tostring(
            tree, xml_declaration=True, encoding="UTF-8", doctype=doctype
        )
        out_path = tmpdir / (mxl_path.stem + ".repeats.mxl")
        with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zout:
            for item in zin.infolist():
                data = new_score if item.filename == score_name else zin.read(item)
                zout.writestr(item, data)

    return out_path, indices


def restore_measure_numbers(mei_bytes: bytes, original_numbers: list[str]) -> bytes:
    """Restore the true (restarting) ``@n`` on MEI measures after a renumbered import.

    The renumbered import (:func:`renumber_mxl_for_import`) makes Verovio emit
    MEI measures numbered 1..N; this maps each MEI ``<measure>`` — in document
    order, which is the ``mc`` join key and is never changed by the renumber
    (ADR-015) — back to its original source ``@number``.  The mapping is a clean
    1:1 by position because the renumber neither adds, removes, nor reorders
    measures.

    Args:
        mei_bytes: The MEI produced by :func:`convert_mxl_to_mei` on the
            renumbered ``.mxl``.
        original_numbers: The document-order ``@number`` list returned by
            :func:`renumber_mxl_for_import`.

    Returns:
        MEI bytes with each measure's display ``@n`` restored.

    Raises:
        ValueError: When the MEI measure count differs from *original_numbers*,
            so a corrupt ``@n`` remap fails loudly rather than silently
            mislabelling the display numbering.
    """
    import lxml.etree

    root = lxml.etree.fromstring(mei_bytes)
    measures = root.findall(f".//{{{_MEI_NS}}}measure")
    if len(measures) != len(original_numbers):
        raise ValueError(
            f"MEI has {len(measures)} measures but the renumbered .mxl had "
            f"{len(original_numbers)}; refusing to remap @n"
        )
    for measure, number in zip(measures, original_numbers):
        measure.set("n", number)
    return lxml.etree.tostring(root, xml_declaration=True, encoding="UTF-8")


# ---------------------------------------------------------------------------
# Measure-start clef recovery (works around a MuseScore MusicXML export defect)
# ---------------------------------------------------------------------------

# MuseScore base clef letters → (MEI @shape, default @line).
_CLEF_BASE_LINES: dict[str, str] = {"G": "2", "F": "4", "C": "3"}

# MuseScore octave-displacement suffixes → (MEI @dis, @dis.place).
_CLEF_DISPLACEMENTS: dict[str, tuple[str, str]] = {
    "8va": ("8", "above"),
    "8vb": ("8", "below"),
    "15ma": ("15", "above"),
    "15mb": ("15", "below"),
}


def _musescore_clef_to_mei(clef_type: str) -> dict[str, str] | None:
    """Map a MuseScore ``concertClefType`` token to MEI ``<clef>`` attributes.

    MuseScore clef tokens are a base letter (``G``/``F``/``C``) optionally
    followed by an octave-displacement suffix (``8va``/``8vb``/``15ma``/
    ``15mb``), or a numbered C-clef (``C1``..``C5``).

    Args:
        clef_type: The raw ``<concertClefType>`` text, e.g. ``"G"``, ``"F8vb"``.

    Returns:
        A dict of MEI ``<clef>`` attributes (``shape``, ``line`` and optionally
        ``dis``/``dis.place``), or ``None`` if the token is unrecognised.
    """
    token = (clef_type or "").strip()
    if not token:
        return None
    # Numbered C-clef, e.g. "C1".."C5".
    if len(token) == 2 and token[0] == "C" and token[1].isdigit():
        return {"shape": "C", "line": token[1]}
    base = token[0]
    if base not in _CLEF_BASE_LINES:
        return None
    attrs = {"shape": base, "line": _CLEF_BASE_LINES[base]}
    suffix = token[1:]
    if suffix:
        if suffix not in _CLEF_DISPLACEMENTS:
            return None
        attrs["dis"], attrs["dis.place"] = _CLEF_DISPLACEMENTS[suffix]
    return attrs


def _extract_measure_start_clefs(
    mscx_path: Path,
) -> list[tuple[int, str, dict[str, str]]]:
    """Extract genuine measure-start clef changes from a MuseScore ``.mscx``.

    Walks each staff's measures in document order, tracking the running clef per
    staff (seeded from the staff's ``<defaultClef>`` — ``G`` when absent).  A
    ``<Clef>`` that appears before any ``<Chord>``/``<Rest>`` in the measure's
    first ``<voice>`` and that differs from the running clef is a genuine
    measure-start change — the kind MuseScore drops from its MusicXML export.
    Mid-measure changes (which survive the export) and system-break courtesy-clef
    repeats (which equal the running clef) are both filtered out.

    Args:
        mscx_path: Path to the ``.mscx`` source file.

    Returns:
        A list of ``(measure_index, staff_id, mei_clef_attrs)`` tuples, where
        ``measure_index`` is the 1-based document-order measure position.
    """
    import lxml.etree

    score = lxml.etree.parse(str(mscx_path)).getroot().find("Score")
    if score is None:
        return []

    # Per-staff initial clef from the Part/Staff <defaultClef> (G when absent).
    initial: dict[str, str] = {}
    for part in score.findall("Part"):
        for staff_def in part.findall("Staff"):
            sid = staff_def.get("id")
            if sid is not None:
                initial[sid] = staff_def.findtext("defaultClef", "G")

    changes: list[tuple[int, str, dict[str, str]]] = []
    for staff in score.findall("Staff"):
        sid = staff.get("id")
        measures = staff.findall("Measure")
        if sid is None or not measures:
            continue
        running = initial.get(sid, "G")
        for idx, measure in enumerate(measures, start=1):
            voice = measure.find("voice")
            if voice is None:
                continue
            seen_note = False
            for child in voice:
                if not isinstance(child.tag, str):
                    continue
                if child.tag in ("Chord", "Rest"):
                    seen_note = True
                elif child.tag == "Clef":
                    ctype = child.findtext("concertClefType") or child.findtext(
                        "clefType"
                    )
                    if not ctype:
                        continue
                    if ctype != running and not seen_note:
                        attrs = _musescore_clef_to_mei(ctype)
                        if attrs is not None:
                            changes.append((idx, sid, attrs))
                    running = ctype
    return changes


def _extract_section_boundaries(mscx_path: Path) -> list[int]:
    """Return the 1-based measure indices that *end* a section in a ``.mscx``.

    A MuseScore section break (``<LayoutBreak><subtype>section</subtype>``) marks
    the last measure of a section; the minuet→trio break that restarts measure
    numbering is the canonical case.  Breaks are stored per-staff, so the union
    across all staves is taken — a boundary present on any staff is a boundary
    for the movement.

    Args:
        mscx_path: Path to the ``.mscx`` source file.

    Returns:
        Sorted 1-based document-order measure indices on which a section break
        occurs (empty when the movement is a single section).
    """
    import lxml.etree

    score = lxml.etree.parse(str(mscx_path)).getroot().find("Score")
    if score is None:
        return []
    boundaries: set[int] = set()
    for staff in score.findall("Staff"):
        for idx, measure in enumerate(staff.findall("Measure"), start=1):
            for layout_break in measure.iter("LayoutBreak"):
                if (layout_break.findtext("subtype") or "").strip() == "section":
                    boundaries.add(idx)
                    break
    return sorted(boundaries)


def _mei_top_sections(
    root: lxml.etree._Element,
) -> list[list[lxml.etree._Element]]:
    """Group the MEI measures by their top-level ``<section>``, in document order.

    Nested ``<section>`` elements (e.g. a trio encoded inside the minuet section)
    are folded into their top-level ancestor via the descendant axis, so each
    returned bucket is one *top-level* section's measures.  This is the MEI side
    of the section-aware ``.mscx``↔MEI alignment.

    Args:
        root: The MEI document root element.

    Returns:
        One list of ``<measure>`` elements per top-level section that contains
        measures, in document order.
    """
    result: list[list[lxml.etree._Element]] = []
    for section in root.iter(f"{{{_MEI_NS}}}section"):
        parent = section.getparent()
        if parent is not None and parent.tag == f"{{{_MEI_NS}}}section":
            continue  # nested — its measures are counted under the top section
        measures = section.findall(f".//{{{_MEI_NS}}}measure")
        if measures:
            result.append(measures)
    return result


def _top_section(
    measure: lxml.etree._Element,
) -> lxml.etree._Element | None:
    """Return the outermost ``<section>`` ancestor of *measure* (``None`` if none).

    Two measures share a top-level section iff this returns the same element for
    both — the test the D3 courtesy placement uses to avoid hosting a section's
    opening clef in the previous section.

    Args:
        measure: An MEI ``<measure>`` element.

    Returns:
        The outermost ancestor ``<section>``, or ``None`` when the measure has no
        section ancestor.
    """
    top: lxml.etree._Element | None = None
    el = measure.getparent()
    while el is not None:
        if el.tag == f"{{{_MEI_NS}}}section":
            top = el
        el = el.getparent()
    return top


def _resolve_mei_measure(
    measure_index: int,
    flat_measures: list[lxml.etree._Element],
    mei_sections: list[list[lxml.etree._Element]],
    boundaries: list[int],
    notes: list[str],
) -> lxml.etree._Element | None:
    """Map a 1-based ``.mscx`` measure index to its MEI ``<measure>`` element.

    When the ``.mscx`` section count (``len(boundaries) + 1``) matches the MEI
    top-level section count and there is more than one section, the index is
    resolved *within* its section — so a count divergence confined to an earlier
    section (the K331/ii trio failure, A3) does not shift every later clef out of
    place.  Otherwise it falls back to flat document-order indexing.

    Args:
        measure_index: 1-based ``.mscx`` document-order measure index.
        flat_measures: All MEI measures in document order (fallback path).
        mei_sections: MEI measures grouped by top-level section.
        boundaries: ``.mscx`` section-break indices from
            :func:`_extract_section_boundaries`.
        notes: Accumulator for human-readable diagnostics on skipped clefs.

    Returns:
        The matching MEI ``<measure>`` element, or ``None`` when it cannot be
        placed confidently (a diagnostic is appended to *notes*).
    """
    if len(boundaries) + 1 == len(mei_sections) and len(mei_sections) > 1:
        ordinal = sum(1 for b in boundaries if b < measure_index)
        start = max((b for b in boundaries if b < measure_index), default=0) + 1
        within = measure_index - start + 1
        section = mei_sections[ordinal]
        if 1 <= within <= len(section):
            return section[within - 1]
        notes.append(
            f"clef recovery: measure {measure_index} (section {ordinal + 1}, "
            f"position {within}) is outside the MEI section's "
            f"{len(section)} measures; clef skipped"
        )
        return None

    if measure_index <= len(flat_measures):
        return flat_measures[measure_index - 1]
    notes.append(
        f"clef recovery: measure index {measure_index} exceeds the MEI "
        f"measure count {len(flat_measures)}; clef skipped"
    )
    return None


def _layer_leads_with_clef(layer: lxml.etree._Element) -> bool:
    """Return whether the layer's first musical event is a ``<clef>``.

    Transparent grouping containers (``<beam>``, ``<tuplet>``, etc.) are
    descended into: MuseScore's MusicXML export sometimes places a genuine
    measure-start clef as the first child of a beam rather than a direct
    child of the layer (K533/iii m118), and it still functions as a leading
    clef there — checking direct children only produced a false "clef
    missing on this voice" read.
    """
    transparent = {"beam", "tuplet", "ftrem", "btrem", "graceGrp", "beamSpan"}

    def first_event(
        container: lxml.etree._Element,
    ) -> lxml.etree._Element | None:
        for child in container:
            if not isinstance(child.tag, str):
                continue
            local = child.tag.rsplit("}", 1)[-1]
            if local in transparent:
                found = first_event(child)
                if found is not None:
                    return found
                continue
            return child
        return None

    first = first_event(layer)
    return first is not None and first.tag == f"{{{_MEI_NS}}}clef"


def _layer_has_equivalent_clef(
    layer: lxml.etree._Element, attrs: dict[str, str]
) -> bool:
    """Return whether the layer already holds a clef equal to *attrs*.

    The descendant axis is used so a clef nested inside a ``<beam>``/``<tuplet>``
    counts: the converter sometimes emits a genuine measure-start change a little
    way into the layer (K279/i m. 86), and injecting an identical clef at
    position 0 is exactly what produces the rendered double-clef (A1).

    Args:
        layer: The MEI ``<layer>`` element.
        attrs: The recovered clef attributes (``shape``/``line`` and optionally
            ``dis``/``dis.place``).

    Returns:
        ``True`` when a clef matching every attribute in *attrs* already exists.
    """
    for clef in layer.iter(f"{{{_MEI_NS}}}clef"):
        if all(clef.get(key) == value for key, value in attrs.items()):
            return True
    return False


def _layer_end_tick(layer: lxml.etree._Element) -> int:
    """Total tick length of a layer's content (beams flattened, graces 0).

    Used to pick the voice whose content reaches the notated bar end when a
    single trailing courtesy clef is injected: a shorter voice's tail sits
    mid-measure, and a clef appended there draws mid-measure too (the K570/ii
    and K570/iii double-glyph generator).
    """
    total = 0

    def walk(container: lxml.etree._Element) -> None:
        nonlocal total
        for child in container:
            if not isinstance(child.tag, str):
                continue
            local = child.tag.rsplit("}", 1)[-1]
            if local in ("beam", "tuplet", "ftrem", "btrem", "graceGrp", "beamSpan"):
                walk(child)
            elif local in ("note", "chord", "rest", "space", "mRest", "mSpace"):
                dur = child.get("dur.ppq")
                if dur and dur.lstrip("-").isdigit():
                    total += int(dur)

    walk(layer)
    return total


def recover_measure_start_clefs(
    mscx_path: Path,
    mei_bytes: bytes,
    notes: list[str] | None = None,
) -> bytes:
    """Re-insert measure-initial clef changes dropped by MuseScore's MusicXML export.

    MuseScore (3.6.2 and 4) omits clef changes positioned at the very start of a
    measure when exporting MusicXML, so Verovio never sees them and the produced
    MEI lacks them.  Because MEI ``pname``/``oct`` are absolute pitch, the affected
    notes still render at the correct pitch but on the previous clef (heavily
    ledger-lined, no clef glyph), which reads as a missing clef change.  This pass
    reads the genuine measure-start clef changes back out of the ``.mscx`` source —
    the only artefact that retains them — and injects a ``<clef>`` at the start of
    the corresponding MEI measure/staff layer(s).  Mid-measure clef changes are
    exported correctly and are left untouched.

    Five properties make this safe on multi-voice and multi-section writing
    (Component 9 read-through A1–A3, D3; revised 2026-07-05 with the
    double-clef investigation):

    * **Courtesy placement (D3):** the recovered clef is appended as the last
      child of **one** layer of the **previous** measure's staff — the voice
      whose content reaches the notated bar end — so Verovio draws it as a
      courtesy *before* the barline (the position MuseScore uses).
      Cross-measure clef state is staff-scoped (probed on Verovio 6.1.0,
      2026-07-05), so a single copy re-clefs every voice of this measure;
      per-voice copies at unequal layer-end ticks were exactly the K570/ii
      and K570/iii double-glyph generator.  When there is no previous measure,
      or it lacks the staff, the clef falls back to the start of this measure.
    * **Repeat boundary:** when the previous measure closes with a repeat
      (``@right`` ``rptend``/``rptboth``) or this one opens with ``rptstart``,
      the change belongs to the music *after* the repeat only — NMA prints no
      courtesy before the barline there (K570/ii m.12→13) — so the clef is
      placed leading in this measure instead.
    * **Per-voice scope (A2) — leading placement only:** a leading clef is
      injected into every ``<layer>`` of this measure, because *within* a
      measure an MEI layer clef is layer-scoped — a single-layer leading
      injection would leave the second voice on the previous clef.  The guard
      is evaluated per layer (K533/iii m118: the converter can encode the
      change in one voice only, and the missing voices are completed in place
      at the same onset).  Normalizer Pass 10 silences the coincident copies
      to a single drawn glyph (ADR-031).
    * **Idempotency guard (A1):** injection is skipped when an equivalent clef
      already exists — anywhere in the host staff for the trailing courtesy
      (one copy suffices), per layer (leading clef or equivalent anywhere,
      including nested in a beam) for the leading placement — so re-runs and
      converter-emitted measure-start clefs do not stack into a double.
    * **Section-aware index (A3):** when the ``.mscx`` and MEI agree on section
      count, the measure index is resolved within its section, so a count
      divergence confined to an earlier section does not displace the trio's
      clefs.  Unresolvable placements are recorded in *notes* rather than
      silently dropped.

    Injecting clefs changes neither measure count nor document order, so fragment
    machine coordinates (``mc_start``/``mc_end``) are unaffected (ADR-015).

    Args:
        mscx_path: The MuseScore ``.mscx`` source for this movement.
        mei_bytes: The MEI produced by :func:`convert_mxl_to_mei`.
        notes: Optional accumulator for human-readable diagnostics about clefs
            that could not be placed (section mismatch, missing staff). Appended
            to in place when provided.

    Returns:
        MEI bytes with measure-start clefs re-inserted (the input bytes unchanged
        when no clefs were dropped).
    """
    import lxml.etree

    changes = _extract_measure_start_clefs(mscx_path)
    if not changes:
        return mei_bytes

    boundaries = _extract_section_boundaries(mscx_path)
    root = lxml.etree.fromstring(mei_bytes)
    flat_measures = root.findall(f".//{{{_MEI_NS}}}measure")
    mei_sections = _mei_top_sections(root)
    local_notes = notes if notes is not None else []

    if boundaries and len(boundaries) + 1 != len(mei_sections):
        local_notes.append(
            f"clef recovery: .mscx has {len(boundaries) + 1} sections but MEI "
            f"has {len(mei_sections)}; falling back to global measure indexing"
        )

    for measure_index, staff_id, attrs in changes:
        measure = _resolve_mei_measure(
            measure_index, flat_measures, mei_sections, boundaries, local_notes
        )
        if measure is None:
            continue
        staff_q = f"{{{_MEI_NS}}}staff[@n='{staff_id}']"
        n_staff = measure.find(staff_q)

        # D3: host the courtesy clef in the PREVIOUS measure of the SAME section
        # (rendered before the barline); fall back to the start of this measure
        # at a section boundary, the first measure, or a missing previous staff.
        host, trailing = measure, False
        idx = flat_measures.index(measure)
        if idx > 0:
            prev = flat_measures[idx - 1]
            if prev.find(staff_q) is not None and _top_section(prev) is _top_section(
                measure
            ):
                host, trailing = prev, True

        # Repeat boundary: the change applies only to the music after the
        # repeat, so NMA prints no courtesy before the barline (K570/ii
        # m.12→13) — place the clef leading in this measure instead.
        if trailing and (
            host.get("right") in ("rptend", "rptboth")
            or measure.get("left") == "rptstart"
        ):
            host, trailing = measure, False

        # Native partial encoding: when the converter already kept the change
        # in at least one of this measure's voices (K533/iii m118), complete
        # the missing voices in place at the same onset — a cross-barline
        # courtesy would draw a second glyph on the other side of the barline
        # from the native one.
        if (
            trailing
            and n_staff is not None
            and any(
                _layer_has_equivalent_clef(ly, attrs)
                for ly in n_staff.findall(f"{{{_MEI_NS}}}layer")
            )
        ):
            host, trailing = measure, False

        staff = host.find(staff_q)
        if staff is None:
            local_notes.append(
                f"clef recovery: staff {staff_id} absent in the measure mapped "
                f"from .mscx index {measure_index}; clef skipped"
            )
            continue
        layers = staff.findall(f"{{{_MEI_NS}}}layer")
        if not layers:
            continue

        if trailing:
            # One copy suffices: cross-measure clef state is staff-scoped.
            # Host it in the voice whose content reaches the bar end so the
            # glyph draws just before the barline, not mid-measure.
            if any(_layer_has_equivalent_clef(ly, attrs) for ly in layers):
                continue
            layer = max(layers, key=_layer_end_tick)
            layer_n = layer.get("n") or str(layers.index(layer) + 1)
            clef = lxml.etree.SubElement(layer, f"{{{_MEI_NS}}}clef")
            clef.set(f"{{{_XML_NS}}}id", f"clefrec{measure_index}s{staff_id}l{layer_n}")
            for key, value in attrs.items():
                clef.set(key, value)
            continue

        # Leading placement: within a measure a layer clef is layer-scoped,
        # so every voice needs its own copy at onset 0 (per-layer guards keep
        # re-runs and natively-encoded voices from stacking a double; the
        # normalizer silences the coincident copies to one drawn glyph).
        for position, layer in enumerate(layers, start=1):
            layer_n = layer.get("n") or str(position)
            if _layer_has_equivalent_clef(layer, attrs) or _layer_leads_with_clef(
                layer
            ):
                continue
            clef = lxml.etree.SubElement(layer, f"{{{_MEI_NS}}}clef")
            clef.set(f"{{{_XML_NS}}}id", f"clefrec{measure_index}s{staff_id}l{layer_n}")
            for key, value in attrs.items():
                clef.set(key, value)
            layer.remove(clef)
            layer.insert(0, clef)

    return lxml.etree.tostring(root, xml_declaration=True, encoding="UTF-8")


# ---------------------------------------------------------------------------
# Harmonies TSV
# ---------------------------------------------------------------------------


def find_harmonies_tsv(repo_path: Path, mscx_path: Path) -> Path | None:
    """Locate the DCML harmonies TSV matching an ``.mscx`` file.

    The DCML naming convention maps ``MS3/{stem}.mscx`` 1:1 to
    ``harmonies/{stem}.tsv``.

    Args:
        repo_path: Path to the cloned DCML repository.
        mscx_path: The ``.mscx`` source file whose harmonies TSV to find.

    Returns:
        Path to the TSV file, or ``None`` if it does not exist.
    """
    tsv_path = repo_path / "harmonies" / (mscx_path.stem + ".harmonies.tsv")
    return tsv_path if tsv_path.exists() else None


# ---------------------------------------------------------------------------
# Metadata construction
# ---------------------------------------------------------------------------


def build_ingest_metadata(
    config: dict[str, Any],
    git_sha: str,
    accepted: list[AcceptedMovement],
) -> IngestMetadata:
    """Build and validate an :class:`IngestMetadata` from the config and accepted movements.

    Args:
        config: Parsed TOML config dict.
        git_sha: HEAD commit SHA of the source repository.
        accepted: List of movements that passed conversion and validation.

    Returns:
        Validated :class:`IngestMetadata` instance.

    Raises:
        SystemExit: If the assembled metadata fails Pydantic validation.
    """
    # Group movements by work slug, preserving TOML order.
    work_movements: dict[str, list[MovementMetadata]] = {}
    work_toml_map: dict[str, dict[str, Any]] = {}
    for am in accepted:
        ws = am.entry.work_slug
        if ws not in work_movements:
            work_movements[ws] = []
            work_toml_map[ws] = am.entry.work_toml
        work_movements[ws].append(
            MovementMetadata(
                slug=am.entry.movement_slug,
                movement_number=am.entry.movement_toml["movement_number"],
                title=am.entry.movement_toml.get("title"),
                tempo_marking=am.entry.movement_toml.get("tempo_marking"),
                key_signature=am.entry.movement_toml.get("key_signature"),
                meter=am.entry.movement_toml.get("meter"),
                mei_filename=f"mei/{am.entry.work_slug}/{am.entry.movement_slug}.mei",
                harmonies_filename=(
                    f"harmonies/{am.entry.work_slug}/{am.entry.movement_slug}.tsv"
                    if am.harmonies_path is not None
                    else None
                ),
            )
        )

    works: list[WorkMetadata] = [
        WorkMetadata(
            slug=slug,
            title=work_toml_map[slug]["title"],
            catalogue_number=work_toml_map[slug].get("catalogue_number"),
            year_composed=work_toml_map[slug].get("year_composed"),
            year_notes=work_toml_map[slug].get("year_notes"),
            key_signature=work_toml_map[slug].get("key_signature"),
            instrumentation=work_toml_map[slug].get("instrumentation"),
            notes=work_toml_map[slug].get("notes"),
            movements=movements,
        )
        for slug, movements in work_movements.items()
    ]

    corpus_toml = config["corpus"]
    composer_toml = config["composer"]

    try:
        return IngestMetadata(
            composer=ComposerMetadata(
                slug=composer_toml["slug"],
                name=composer_toml["name"],
                sort_name=composer_toml["sort_name"],
                birth_year=composer_toml.get("birth_year"),
                death_year=composer_toml.get("death_year"),
                nationality=composer_toml.get("nationality"),
                wikidata_id=composer_toml.get("wikidata_id"),
            ),
            corpus=CorpusMetadata(
                slug=corpus_toml["slug"],
                title=corpus_toml["title"],
                source_repository=corpus_toml.get("source_repository"),
                source_url=corpus_toml.get("source_url"),
                source_commit=git_sha,
                analysis_source=corpus_toml["analysis_source"],
                licence=corpus_toml["licence"],
                licence_notice=corpus_toml.get("licence_notice"),
                notes=corpus_toml.get("notes"),
                works=works,
            ),
        )
    except Exception as exc:  # pydantic.ValidationError or similar
        _err(f"Metadata validation failed: {exc}")
        sys.exit(1)


# ---------------------------------------------------------------------------
# ZIP assembly
# ---------------------------------------------------------------------------


def assemble_zip(
    accepted: list[AcceptedMovement],
    metadata: IngestMetadata,
    output_path: Path,
) -> None:
    """Write the upload ZIP to *output_path*.

    ZIP layout::

        metadata.yaml
        mei/{work_slug}/{movement_slug}.mei
        harmonies/{work_slug}/{movement_slug}.tsv  (omitted when not available)

    Args:
        accepted: Movements to include.
        metadata: Validated :class:`IngestMetadata` for the ``metadata.yaml`` sidecar.
        output_path: Destination path for the ZIP file.
    """
    yaml_content: str = yaml.dump(
        metadata.model_dump(mode="json"),
        sort_keys=False,
        allow_unicode=True,
    )
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("metadata.yaml", yaml_content)
        for am in accepted:
            ws = am.entry.work_slug
            ms = am.entry.movement_slug
            zf.writestr(f"mei/{ws}/{ms}.mei", am.mei_bytes)
            if am.harmonies_path is not None:
                zf.write(am.harmonies_path, f"harmonies/{ws}/{ms}.tsv")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """CLI entry point for the DCML corpus-preparation pipeline."""
    args = parse_args()

    config = load_toml_config(args.config)
    check_abc_deny_list(config)
    git_sha = get_git_sha(args.repo_path)

    # Resolve the mscore executable once up front so a missing binary fails
    # immediately rather than mid-conversion.
    mscore_exe: str = args.mscore_path or shutil.which("mscore") or ""
    if not mscore_exe or not (Path(mscore_exe).exists() or shutil.which(mscore_exe)):
        _err(
            f"Cannot find mscore executable: {mscore_exe!r}. "
            "Pass --mscore-path with the full path, e.g. "
            "'C:/Program Files/MuseScore 3/bin/mscore.bat'."
        )
        sys.exit(1)

    entries = discover_movements(args.repo_path, config)
    accepted: list[AcceptedMovement] = []

    with tempfile.TemporaryDirectory() as _tmpdir:
        tmpdir = Path(_tmpdir)
        for entry in entries:
            label = f"{entry.work_slug}/{entry.movement_slug}"
            _log(f"Converting {label} ...")

            try:
                mxl_path = convert_mscx_to_mxl(entry.mscx_path, tmpdir, mscore_exe)
            except subprocess.CalledProcessError as exc:
                _err(f"mscore failed for {label}: {exc}")
                sys.exit(1)

            # Renumber measures uniquely before import so Verovio's number-keyed
            # importer does not mis-route the clefs of a section that restarts its
            # numbering (K331/ii minuet+trio); the true @n is restored below
            # (ADR-032).  A single-section movement is a no-op.
            mxl_path, original_numbers = renumber_mxl_for_import(mxl_path, tmpdir)
            if original_numbers is not None:
                _log(
                    f"  {label}: renumbered {len(original_numbers)} measures for import"
                )

            # Supply strain-opening repeats the source omits so Verovio's
            # playback expansion pairs each :| with its own |: (ADR-033).
            # Applies to every movement (not just section-restart ones) — a
            # 2026-07-04 render review of all 7 single-section cases the rule
            # also matched (K282/ii, K284/iii's 10 variation strains, K330/i,
            # K333/i, K545/ii, K570/i, K570/iii) confirmed each "before" was an
            # unambiguous bug (a strain replaying the previous one instead of
            # itself) and each "after" the correct form; the gate was only ever
            # a conservative holding pattern pending that review.
            mxl_path, repeat_fixes = repair_section_opening_repeats(mxl_path, tmpdir)
            if repeat_fixes:
                _log(
                    f"  {label}: injected opening repeat(s) at measure(s) "
                    f"{repeat_fixes} for correct playback expansion"
                )

            try:
                mei_bytes = convert_mxl_to_mei(mxl_path, tmpdir)
            except RuntimeError as exc:
                _err(f"verovio failed for {label}: {exc}")
                sys.exit(1)

            if original_numbers is not None:
                try:
                    mei_bytes = restore_measure_numbers(mei_bytes, original_numbers)
                except ValueError as exc:
                    _err(f"measure-number restore failed for {label}: {exc}")
                    sys.exit(1)

            # Recover measure-start clef changes that MuseScore drops from its
            # MusicXML export (see recover_measure_start_clefs docstring).
            clef_notes: list[str] = []
            mei_bytes = recover_measure_start_clefs(
                entry.mscx_path, mei_bytes, notes=clef_notes
            )
            for note in clef_notes:
                _log(f"  {label}: {note}")

            report = validate_mei(mei_bytes)
            if not report.is_valid:
                for e in report.errors:
                    _err(f"MEI validation failed for {label}: [{e.code}] {e.message}")
                sys.exit(1)

            harmonies_path = find_harmonies_tsv(args.repo_path, entry.mscx_path)
            accepted.append(
                AcceptedMovement(
                    entry=entry,
                    mei_bytes=mei_bytes,
                    harmonies_path=harmonies_path,
                )
            )

        metadata = build_ingest_metadata(config, git_sha, accepted)
        assemble_zip(accepted, metadata, args.output)

    _log(f"git SHA: {git_sha}")
    _log(f"Converted {len(accepted)} movements.")
    _log("Skipped 0 movements.")
    _log(f"Output: {args.output}")
    sys.exit(0)


if __name__ == "__main__":
    main()
