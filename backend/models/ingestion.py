"""Pydantic v2 models for the MEI corpus upload import format.

These models validate the ``metadata.yaml`` sidecar that accompanies a corpus
upload ZIP.  They are the *import format*, not the persisted ORM form: every
database write must pass through these models first.

The four-level hierarchy mirrors the PostgreSQL schema::

    IngestMetadata
        composer: ComposerMetadata
        corpus:   CorpusMetadata
                      works: list[WorkMetadata]
                                 movements: list[MovementMetadata]

All models are validated with ``extra="forbid"`` so that typos in the YAML
sidecar raise immediately rather than silently losing data.

See docs/roadmap/component-1-mei-corpus-ingestion.md §Step 1.
"""

from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

# ---------------------------------------------------------------------------
# Module-level constants
# ---------------------------------------------------------------------------

_SLUG_PATTERN: re.Pattern[str] = re.compile(r"^[a-z0-9][a-z0-9-]*$")
"""Slugs must start with an alphanumeric character and contain only lowercase
alphanumerics and hyphens.  This is enforced at every level of the hierarchy."""

# Subset of SPDX identifiers accepted as corpus licences.  Add new identifiers
# here as new corpora are onboarded; never weaken the check to accept free-form
# strings.
_KNOWN_SPDX_LICENCES: frozenset[str] = frozenset(
    {
        "CC-BY-SA-4.0",
        "CC-BY-4.0",
        "CC0-1.0",
        "MIT",
        "GPL-3.0-only",
        "LGPL-2.1-only",
    }
)

# Source-repository substrings that must be refused at validation time.
# Enforces ADR-009: the ABC (Beethoven string quartets) corpus carries a
# licence that is incompatible with Doppia's redistribution requirements.
# Substring match (case-insensitive) so that both bare slugs and full GitHub
# URLs are caught.
_ABC_DENY_LIST: frozenset[str] = frozenset(
    {
        "abc/beethoven-quartets",
        "abc/beethoven_quartets",
    }
)


# ---------------------------------------------------------------------------
# Shared slug helper
# ---------------------------------------------------------------------------


def _validate_slug(value: str) -> str:
    """Validate that *value* matches the project slug pattern.

    Args:
        value: The candidate slug string.

    Returns:
        The unchanged value when valid.

    Raises:
        ValueError: When *value* does not match ``_SLUG_PATTERN``.
    """
    if not _SLUG_PATTERN.match(value):
        raise ValueError(
            f"Invalid slug {value!r}: must match ^[a-z0-9][a-z0-9-]*$"
        )
    return value


# ---------------------------------------------------------------------------
# MovementMetadata
# ---------------------------------------------------------------------------


class MovementMetadata(BaseModel):
    """Metadata for a single movement within a work.

    ``mei_filename`` is the path to the MEI file *within the upload ZIP*,
    relative to the ZIP root.  It is required because the uploader controls
    the ZIP layout; the Pydantic model is what resolves "which file is which
    movement."

    ``harmonies_filename`` is the path to the DCML harmonies TSV within the
    ZIP.  It is ``None`` for non-DCML corpora.  Presence is enforced at the
    ``CorpusMetadata`` level, where ``analysis_source`` is available.
    """

    model_config = ConfigDict(strict=False, extra="forbid")

    slug: str
    movement_number: int
    title: str | None = None
    tempo_marking: str | None = None
    key_signature: str | None = None
    meter: str | None = None
    mei_filename: str
    harmonies_filename: str | None = None

    @field_validator("slug")
    @classmethod
    def _slug_format(cls, v: str) -> str:
        """Enforce slug format on movement slugs.

        Args:
            v: The raw slug value.

        Returns:
            The validated slug.
        """
        return _validate_slug(v)


# ---------------------------------------------------------------------------
# WorkMetadata
# ---------------------------------------------------------------------------


class WorkMetadata(BaseModel):
    """Metadata for a single musical work, including its movements.

    ``catalogue_number`` is free-form (Köchel, BWV, opus, etc.) per the
    project specification; no structural constraint is applied beyond treating
    it as an opaque string.
    """

    model_config = ConfigDict(strict=False, extra="forbid")

    slug: str
    title: str
    catalogue_number: str | None = None
    year_composed: int | None = None
    year_notes: str | None = None
    key_signature: str | None = None
    instrumentation: str | None = None
    notes: str | None = None
    movements: list[MovementMetadata]

    @field_validator("slug")
    @classmethod
    def _slug_format(cls, v: str) -> str:
        """Enforce slug format on work slugs.

        Args:
            v: The raw slug value.

        Returns:
            The validated slug.
        """
        return _validate_slug(v)

    @model_validator(mode="after")
    def _unique_movement_slugs(self) -> WorkMetadata:
        """Reject duplicate movement slugs within this work.

        Returns:
            Self when all movement slugs are unique.

        Raises:
            ValueError: When two or more movements share a slug.
        """
        seen: set[str] = set()
        duplicates: list[str] = []
        for m in self.movements:
            if m.slug in seen:
                duplicates.append(m.slug)
            seen.add(m.slug)
        if duplicates:
            raise ValueError(
                f"Duplicate movement slug(s) within work {self.slug!r}: "
                + ", ".join(repr(s) for s in duplicates)
            )
        return self


# ---------------------------------------------------------------------------
# CorpusMetadata
# ---------------------------------------------------------------------------


class CorpusMetadata(BaseModel):
    """Metadata for a corpus, including its works.

    ``analysis_source`` drives the analysis-ingestion task dispatcher
    (``backend/services/tasks/ingest_analysis.py``).  Its value must be
    consistent with ``licence`` (DCML → CC-BY-SA-4.0) and with the presence
    of ``harmonies_filename`` on every movement (DCML → required).

    ``source_repository`` is checked against ``_ABC_DENY_LIST``; corpora
    from the ABC Beethoven string quartets repository are refused at
    validation time per ADR-009.
    """

    model_config = ConfigDict(strict=False, extra="forbid")

    slug: str
    title: str
    source_repository: str | None = None
    source_url: str | None = None
    source_commit: str | None = None
    analysis_source: Literal["DCML", "WhenInRome", "music21_auto", "none"]
    licence: str
    licence_notice: str | None = None
    notes: str | None = None
    works: list[WorkMetadata]

    @field_validator("slug")
    @classmethod
    def _slug_format(cls, v: str) -> str:
        """Enforce slug format on corpus slugs.

        Args:
            v: The raw slug value.

        Returns:
            The validated slug.
        """
        return _validate_slug(v)

    @field_validator("source_repository")
    @classmethod
    def _deny_abc_repository(cls, v: str | None) -> str | None:
        """Refuse corpora from the ABC/Beethoven deny-list.

        Performs a substring match (case-insensitive) so that both bare slugs
        such as ``"abc/beethoven-quartets"`` and full GitHub URLs are caught.

        Args:
            v: The raw ``source_repository`` value, or ``None``.

        Returns:
            The unchanged value when not on the deny-list.

        Raises:
            ValueError: When ``v`` matches an entry in ``_ABC_DENY_LIST``.
        """
        if v is None:
            return v
        lowered = v.lower()
        for blocked in _ABC_DENY_LIST:
            if blocked in lowered:
                raise ValueError(
                    f"source_repository {v!r} matches the deny-list entry "
                    f"{blocked!r} (ADR-009: ABC/Beethoven string quartets "
                    f"corpus is not permitted for ingestion)."
                )
        return v

    @field_validator("licence")
    @classmethod
    def _spdx_allowlist(cls, v: str) -> str:
        """Validate that *v* is an allowed SPDX licence identifier.

        The allowlist is maintained in ``_KNOWN_SPDX_LICENCES``.  Add new
        identifiers there when onboarding corpora with different licences.

        Args:
            v: The raw licence string.

        Returns:
            The unchanged value when in the allowlist.

        Raises:
            ValueError: When *v* is not in ``_KNOWN_SPDX_LICENCES``.
        """
        if v not in _KNOWN_SPDX_LICENCES:
            raise ValueError(
                f"Licence {v!r} is not in the known SPDX allowlist: "
                + ", ".join(sorted(_KNOWN_SPDX_LICENCES))
            )
        return v

    @model_validator(mode="after")
    def _validate_corpus_invariants(self) -> CorpusMetadata:
        """Enforce corpus-level cross-field invariants.

        Checks (in order, early-exit on first failure):

        1. DCML corpora must carry ``CC-BY-SA-4.0``.
        2. DCML corpora must have ``harmonies_filename`` on every movement.
        3. Work slugs must be unique within this corpus.

        Returns:
            Self when all invariants pass.

        Raises:
            ValueError: On the first invariant violation found.
        """
        # 1. DCML → licence must be CC-BY-SA-4.0
        if self.analysis_source == "DCML" and self.licence != "CC-BY-SA-4.0":
            raise ValueError(
                f"DCML corpora must carry licence 'CC-BY-SA-4.0'; "
                f"got {self.licence!r}."
            )

        # 2. DCML → harmonies_filename required on every movement
        if self.analysis_source == "DCML":
            missing: list[str] = [
                m.slug
                for w in self.works
                for m in w.movements
                if m.harmonies_filename is None
            ]
            if missing:
                raise ValueError(
                    "DCML corpus requires harmonies_filename on every movement; "
                    "missing on: " + ", ".join(repr(s) for s in missing)
                )

        # 3. Work slugs must be unique within this corpus
        seen: set[str] = set()
        duplicates: list[str] = []
        for w in self.works:
            if w.slug in seen:
                duplicates.append(w.slug)
            seen.add(w.slug)
        if duplicates:
            raise ValueError(
                "Duplicate work slug(s) within corpus "
                f"{self.slug!r}: "
                + ", ".join(repr(s) for s in duplicates)
            )

        return self


# ---------------------------------------------------------------------------
# ComposerMetadata
# ---------------------------------------------------------------------------


class ComposerMetadata(BaseModel):
    """Metadata for a composer.

    ``slug`` uniqueness across all composers in the database is enforced at
    the service layer (upsert on conflict), not here: the Pydantic model
    cannot perform a round-trip DB check.
    """

    model_config = ConfigDict(strict=False, extra="forbid")

    slug: str
    name: str
    sort_name: str
    birth_year: int | None = None
    death_year: int | None = None
    nationality: str | None = None
    wikidata_id: str | None = None

    @field_validator("slug")
    @classmethod
    def _slug_format(cls, v: str) -> str:
        """Enforce slug format on composer slugs.

        Args:
            v: The raw slug value.

        Returns:
            The validated slug.
        """
        return _validate_slug(v)


# ---------------------------------------------------------------------------
# IngestMetadata — root model
# ---------------------------------------------------------------------------


class IngestMetadata(BaseModel):
    """Root model for a corpus upload's ``metadata.yaml`` sidecar.

    The upload service calls ``IngestMetadata.model_validate(yaml_dict)`` on
    the parsed YAML content.  All validation — slug format, uniqueness,
    DCML/licence consistency, ABC deny-list — fires during construction.

    Example::

        import yaml
        from models.ingestion import IngestMetadata

        with open("metadata.yaml") as fh:
            raw = yaml.safe_load(fh)
        meta = IngestMetadata.model_validate(raw)
    """

    model_config = ConfigDict(strict=False, extra="forbid")

    composer: ComposerMetadata
    corpus: CorpusMetadata

    def flat_movements(self) -> list[tuple[WorkMetadata, MovementMetadata]]:
        """Return a flat list of (work, movement) pairs across all works.

        Convenience method for the ingestion service, which needs to iterate
        all movements alongside their parent work.

        Returns:
            Ordered list of (work, movement) 2-tuples.
        """
        return [
            (work, movement)
            for work in self.corpus.works
            for movement in work.movements
        ]
