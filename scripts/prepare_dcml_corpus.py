"""DCML corpus-preparation pipeline.

Converts a cloned DCML repository into an upload ZIP ready for the
``POST /api/v1/composers/{slug}/corpora/{slug}/upload`` endpoint.

Pipeline (per movement):

1. Walk ``MS3/*.mscx`` files listed in the TOML config.
2. Convert each ``.mscx`` → ``.mxl`` via ``mscore`` CLI (MuseScore 3.6.2).
3. Convert ``.mxl`` → ``.mei`` via ``verovio`` CLI.
4. Run ``validate_mei()`` on the emitted MEI; abort on any hard error.
5. Locate the matching ``harmonies/*.tsv``.

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
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

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
        description=(
            "Convert a cloned DCML repository into an upload ZIP for Doppia."
        )
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


def convert_mscx_to_mxl(mscx_path: Path, tmpdir: Path, mscore_exe: str) -> Path:
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
    if not tk.loadFile(str(mxl_path)):
        raise RuntimeError(f"verovio failed to load {mxl_path}")
    mei_bytes = tk.getMEI().encode("utf-8")

    # Verovio adds encoding-metadata attributes that the CMN RelaxNG schema
    # does not permit.  Strip them before validation:
    #   - @meiversion on the root <mei> element
    #   - @version on <application> inside <appInfo>
    # Both are purely informational and have no effect on musical content.
    _MEI_NS = "http://www.music-encoding.org/ns/mei"
    root = lxml.etree.fromstring(mei_bytes)
    root.attrib.pop("meiversion", None)
    for app in root.iter(f"{{{_MEI_NS}}}application"):
        app.attrib.pop("version", None)
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
    if not mscore_exe or not (
        Path(mscore_exe).exists() or shutil.which(mscore_exe)
    ):
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

            try:
                mei_bytes = convert_mxl_to_mei(mxl_path, tmpdir)
            except RuntimeError as exc:
                _err(f"verovio failed for {label}: {exc}")
                sys.exit(1)

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
    _log(f"Skipped 0 movements.")
    _log(f"Output: {args.output}")
    sys.exit(0)


if __name__ == "__main__":
    main()
