"""Loading and per-movement filtering of MEI source-corrections overlays.

A corrections overlay is a YAML data file under ``backend/seed/corrections/``,
one per corpus (``{composer_slug}__{corpus_slug}.yaml``), listing known errors
in the source data (ADR-027).  This module reads the corpus file, validates each
entry into a :class:`~models.corrections.Correction`, and returns only the
entries scoped to a single movement.

The normalizer (``services.mei_normalizer``) receives the already-filtered list
and applies it as Pass 0; it never touches the filesystem itself, keeping it
pure and unit-testable.  A corpus with no overlay file — the common case — yields
an empty list, so Pass 0 is a no-op.

Overlay file shape::

    composer: mozart
    corpus: mozart-piano-sonatas
    corrections:
      - movement: k331/movement-2     # {work_slug}/{movement_slug}
        target:
          xml_id: m1a2b3c4
          fallback: "mc=49 staff=2 layer=1 (trio start)"
        field: repeat-start
        expected: null                # attribute currently absent
        corrected: rptstart
        rationale: "DCML source omits the trio's start-repeat; NMA prints |:."
        class: errata
        upstream: none
        source_sha: 0123abc...
        added: "2026-06-28 Francisco"
"""

from __future__ import annotations

from pathlib import Path

import yaml
from models.corrections import Correction

# Default overlay location: backend/seed/corrections/.
_DEFAULT_OVERLAY_DIR: Path = (
    Path(__file__).resolve().parent.parent / "seed" / "corrections"
)


def overlay_path(
    composer_slug: str,
    corpus_slug: str,
    overlay_dir: Path | None = None,
) -> Path:
    """Return the overlay-file path for a corpus.

    Args:
        composer_slug: The composer slug (e.g. ``"mozart"``).
        corpus_slug: The corpus slug (e.g. ``"mozart-piano-sonatas"``).
        overlay_dir: Directory holding overlay files; defaults to
            ``backend/seed/corrections/``.

    Returns:
        The path ``{overlay_dir}/{composer_slug}__{corpus_slug}.yaml`` (which
        may not exist).
    """
    base = overlay_dir if overlay_dir is not None else _DEFAULT_OVERLAY_DIR
    return base / f"{composer_slug}__{corpus_slug}.yaml"


def load_corrections(
    composer_slug: str,
    corpus_slug: str,
    work_slug: str,
    movement_slug: str,
    overlay_dir: Path | None = None,
) -> list[Correction]:
    """Load the corrections that apply to a single movement.

    Reads the corpus overlay file (if present), validates every entry, and
    returns those whose ``movement`` equals ``{work_slug}/{movement_slug}``,
    preserving file order.

    Args:
        composer_slug: The composer slug.
        corpus_slug: The corpus slug.
        work_slug: The work slug (e.g. ``"k331"``).
        movement_slug: The movement slug (e.g. ``"movement-2"``).
        overlay_dir: Directory holding overlay files; defaults to
            ``backend/seed/corrections/``.

    Returns:
        The matching :class:`~models.corrections.Correction` entries, or an
        empty list when the corpus has no overlay file or no entries for this
        movement.

    Raises:
        ValueError: If the overlay file is malformed (not a mapping, missing
            ``corrections``, or an entry fails validation) — surfaced so a
            broken overlay fails the ingest loudly rather than silently
            skipping corrections.
    """
    path = overlay_path(composer_slug, corpus_slug, overlay_dir)
    if not path.exists():
        return []

    raw = yaml.safe_load(path.read_text(encoding="utf-8"))
    if raw is None:
        return []
    if not isinstance(raw, dict):
        raise ValueError(f"Corrections overlay {path} is not a YAML mapping.")

    entries = raw.get("corrections", [])
    if not isinstance(entries, list):
        raise ValueError(
            f"Corrections overlay {path}: 'corrections' must be a list, "
            f"got {type(entries).__name__}."
        )

    scope = f"{work_slug}/{movement_slug}"
    result: list[Correction] = []
    for i, entry in enumerate(entries):
        try:
            correction = Correction.model_validate(entry)
        except Exception as exc:  # pydantic.ValidationError or non-mapping entry
            raise ValueError(
                f"Corrections overlay {path}: entry #{i} is invalid: {exc}"
            ) from exc
        if correction.movement == scope:
            result.append(correction)
    return result
