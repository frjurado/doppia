"""Canonical fixture builders shared across unit and integration test files.

Centralises the two main payload factories so that a schema change (new
required field, renamed key) only needs to be made in one place.

Usage::

    from tests.fixtures.builders import valid_ingest_dict, minimal_metadata
    from tests.fixtures.builders import HARMONIES_TSV_PATH, VOLTA_TSV_PATH
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Fixture file paths
# ---------------------------------------------------------------------------

_HERE = Path(__file__).parent

# Canonical K331 harmonies TSV — used by unit and integration tests that need
# a valid DCML harmonies file without caring about specific content.
HARMONIES_TSV_PATH: Path = _HERE / "dcml-subset" / "harmonies" / "K331-1.tsv"

# Synthetic volta TSV — four rows covering first- and second-time endings.
# Used by the volta-handling integration test in test_corpus_ingestion.py.
VOLTA_TSV_PATH: Path = _HERE / "dcml-subset" / "harmonies" / "volta-movement.tsv"


# ---------------------------------------------------------------------------
# Metadata builders
# ---------------------------------------------------------------------------


def valid_ingest_dict() -> dict[str, Any]:
    """Return a complete, valid ingest payload as a plain dict.

    Every test that exercises an invalid case should call this, deep-copy the
    result, and mutate only the field under test.  This keeps each test
    semantically isolated from unrelated validation rules.

    Returns:
        A fresh dict matching the full IngestMetadata schema.
    """
    return {
        "composer": {
            "slug": "mozart",
            "name": "Wolfgang Amadeus Mozart",
            "sort_name": "Mozart, Wolfgang Amadeus",
            "birth_year": 1756,
            "death_year": 1791,
            "nationality": "Austrian",
            "wikidata_id": "Q254",
        },
        "corpus": {
            "slug": "piano-sonatas",
            "title": "Piano Sonatas",
            "source_repository": "dcml/mozart-piano-sonatas",
            "source_url": "https://github.com/DCMLab/mozart_piano_sonatas",
            "source_commit": "abc1234",
            "analysis_source": "DCML",
            "licence": "CC-BY-SA-4.0",
            "licence_notice": "© 2023 DCML",
            "notes": None,
            "works": [
                {
                    "slug": "k331",
                    "title": "Piano Sonata No. 11 in A major",
                    "catalogue_number": "K. 331",
                    "year_composed": 1783,
                    "year_notes": "ca. 1783",
                    "key_signature": "A major",
                    "instrumentation": "Piano",
                    "notes": None,
                    "movements": [
                        {
                            "slug": "movement-1",
                            "movement_number": 1,
                            "title": "Andante grazioso",
                            "tempo_marking": "Andante grazioso",
                            "key_signature": "A major",
                            "meter": "6/8",
                            "mei_filename": "mei/k331/movement-1.mei",
                            "harmonies_filename": "harmonies/k331/movement-1.tsv",
                        },
                        {
                            "slug": "movement-2",
                            "movement_number": 2,
                            "title": "Menuetto",
                            "tempo_marking": "Menuetto",
                            "key_signature": "A major",
                            "meter": "3/4",
                            "mei_filename": "mei/k331/movement-2.mei",
                            "harmonies_filename": "harmonies/k331/movement-2.tsv",
                        },
                    ],
                },
            ],
        },
    }


def minimal_metadata(
    *,
    composer_slug: str = "mozart",
    corpus_slug: str = "piano-sonatas",
    analysis_source: str = "DCML",
    licence: str = "CC-BY-SA-4.0",
    source_repository: str = "DCMLab/mozart_piano_sonatas",
    source_commit: str = "abc1234",
    works: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return a minimal IngestMetadata-compatible dict.

    Used by service-level and ingestion integration tests.  Covers the minimum
    required fields; callers can override any keyword argument or mutate the
    returned dict to exercise specific validation paths.

    Args:
        composer_slug: Composer slug for the payload.
        corpus_slug: Corpus slug for the payload.
        analysis_source: DCML, WhenInRome, music21_auto, or none.
        licence: SPDX licence identifier.
        source_repository: Repository path or URL.
        source_commit: Git commit hash.
        works: Override the default single-work list.

    Returns:
        A fresh dict matching the minimal IngestMetadata schema.
    """
    if works is None:
        works = [
            {
                "slug": "k331",
                "title": "Piano Sonata No. 11 in A major, K. 331",
                "catalogue_number": "K. 331",
                "year_composed": 1783,
                "movements": [
                    {
                        "slug": "movement-1",
                        "movement_number": 1,
                        "title": "Andante grazioso",
                        "meter": "6/8",
                        "mei_filename": "mei/k331/movement-1.mei",
                        "harmonies_filename": "harmonies/k331/movement-1.tsv",
                    }
                ],
            }
        ]
    return {
        "composer": {
            "slug": composer_slug,
            "name": "Wolfgang Amadeus Mozart",
            "sort_name": "Mozart, Wolfgang Amadeus",
            "birth_year": 1756,
            "death_year": 1791,
            "nationality": "Austrian",
            "wikidata_id": "Q254",
        },
        "corpus": {
            "slug": corpus_slug,
            "title": "Piano Sonatas",
            "source_repository": source_repository,
            "source_commit": source_commit,
            "analysis_source": analysis_source,
            "licence": licence,
            "works": works,
        },
    }
