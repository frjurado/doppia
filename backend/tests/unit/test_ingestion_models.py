"""Unit tests for backend/models/ingestion.py.

Tests cover:
- Valid paths: full round-trip, optional fields omitted, multi-work, etc.
- Slug format validation at every model level.
- Slug uniqueness within parent (movements in work, works in corpus).
- DCML/licence cross-field consistency.
- DCML/harmonies_filename cross-field consistency.
- ABC deny-list on source_repository.
- SPDX licence allowlist.
- extra="forbid" enforcement.

All tests are synchronous — no DB or HTTP client needed.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest
from pydantic import ValidationError

from models.ingestion import (
    ComposerMetadata,
    CorpusMetadata,
    IngestMetadata,
    MovementMetadata,
    WorkMetadata,
)


# ---------------------------------------------------------------------------
# Base fixture factory
# ---------------------------------------------------------------------------


def _valid_ingest_dict() -> dict[str, Any]:
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


def _errors_by_loc(exc: ValidationError) -> dict[str, list[str]]:
    """Return a mapping of field path string → list of error messages.

    Useful for writing precise assertions without coupling to Pydantic's
    internal error structure.

    Args:
        exc: A ``ValidationError`` caught in a ``pytest.raises`` block.

    Returns:
        Dict where keys are dot-joined loc tuples and values are message lists.
    """
    result: dict[str, list[str]] = {}
    for e in exc.errors():
        key = ".".join(str(p) for p in e["loc"])
        result.setdefault(key, []).append(e["msg"])
    return result


# ===========================================================================
# Valid paths
# ===========================================================================


def test_valid_ingest_parses_without_error() -> None:
    """A complete, correct payload deserialises into IngestMetadata."""
    meta = IngestMetadata.model_validate(_valid_ingest_dict())
    assert isinstance(meta, IngestMetadata)
    assert meta.composer.slug == "mozart"
    assert meta.corpus.slug == "piano-sonatas"
    assert len(meta.corpus.works) == 1
    assert len(meta.corpus.works[0].movements) == 2


def test_optional_fields_omitted() -> None:
    """All None-default fields can be absent from the payload."""
    d = _valid_ingest_dict()
    # Remove every optional field
    del d["composer"]["birth_year"]
    del d["composer"]["death_year"]
    del d["composer"]["nationality"]
    del d["composer"]["wikidata_id"]
    del d["corpus"]["source_repository"]
    del d["corpus"]["source_url"]
    del d["corpus"]["source_commit"]
    del d["corpus"]["licence_notice"]
    del d["corpus"]["notes"]
    work = d["corpus"]["works"][0]
    del work["catalogue_number"]
    del work["year_composed"]
    del work["year_notes"]
    del work["key_signature"]
    del work["instrumentation"]
    del work["notes"]
    for m in work["movements"]:
        del m["title"]
        del m["tempo_marking"]
        del m["key_signature"]
        del m["meter"]

    meta = IngestMetadata.model_validate(d)
    assert meta.composer.birth_year is None
    assert meta.corpus.works[0].catalogue_number is None


def test_multiple_works_and_movements_valid() -> None:
    """Two works with two movements each parses without error."""
    d = _valid_ingest_dict()
    d["corpus"]["works"].append(
        {
            "slug": "k332",
            "title": "Piano Sonata No. 12 in F major",
            "catalogue_number": "K. 332",
            "movements": [
                {
                    "slug": "movement-1",
                    "movement_number": 1,
                    "mei_filename": "mei/k332/movement-1.mei",
                    "harmonies_filename": "harmonies/k332/movement-1.tsv",
                },
                {
                    "slug": "movement-2",
                    "movement_number": 2,
                    "mei_filename": "mei/k332/movement-2.mei",
                    "harmonies_filename": "harmonies/k332/movement-2.tsv",
                },
            ],
        }
    )
    meta = IngestMetadata.model_validate(d)
    assert len(meta.corpus.works) == 2


def test_catalogue_number_arbitrary_string() -> None:
    """catalogue_number accepts special characters — it is free-form."""
    d = _valid_ingest_dict()
    d["corpus"]["works"][0]["catalogue_number"] = "K. 525 / Op. 17b (arr.)"
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.works[0].catalogue_number == "K. 525 / Op. 17b (arr.)"


def test_analysis_source_when_in_rome_no_harmonies_required() -> None:
    """WhenInRome corpus with harmonies_filename absent on movements is valid."""
    d = _valid_ingest_dict()
    d["corpus"]["analysis_source"] = "WhenInRome"
    d["corpus"]["licence"] = "CC-BY-4.0"
    for work in d["corpus"]["works"]:
        for m in work["movements"]:
            m["harmonies_filename"] = None
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.analysis_source == "WhenInRome"


def test_analysis_source_none_no_harmonies_required() -> None:
    """analysis_source='none' corpus is valid without harmonies files."""
    d = _valid_ingest_dict()
    d["corpus"]["analysis_source"] = "none"
    d["corpus"]["licence"] = "CC0-1.0"
    for work in d["corpus"]["works"]:
        for m in work["movements"]:
            del m["harmonies_filename"]
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.analysis_source == "none"


def test_wikidata_id_none() -> None:
    """wikidata_id=None is valid."""
    d = _valid_ingest_dict()
    d["composer"]["wikidata_id"] = None
    meta = IngestMetadata.model_validate(d)
    assert meta.composer.wikidata_id is None


def test_slug_starting_with_digit_is_valid() -> None:
    """Slugs that start with a digit are permitted by the pattern."""
    d = _valid_ingest_dict()
    d["corpus"]["works"][0]["slug"] = "3-sonatas"
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.works[0].slug == "3-sonatas"


def test_flat_movements_helper() -> None:
    """flat_movements returns one tuple per movement across all works."""
    d = _valid_ingest_dict()
    d["corpus"]["works"].append(
        {
            "slug": "k333",
            "title": "Piano Sonata No. 13",
            "movements": [
                {
                    "slug": "movement-1",
                    "movement_number": 1,
                    "mei_filename": "mei/k333/movement-1.mei",
                    "harmonies_filename": "harmonies/k333/movement-1.tsv",
                },
            ],
        }
    )
    meta = IngestMetadata.model_validate(d)
    pairs = meta.flat_movements()
    # k331 has 2 movements, k333 has 1 → 3 total
    assert len(pairs) == 3
    assert all(isinstance(w, WorkMetadata) for w, _ in pairs)
    assert all(isinstance(m, MovementMetadata) for _, m in pairs)


# ===========================================================================
# Slug format — one test per model level
# ===========================================================================


def test_movement_slug_uppercase_rejected() -> None:
    """Movement slug with uppercase letters raises ValidationError."""
    with pytest.raises(ValidationError) as exc_info:
        MovementMetadata(slug="I-Allegro", movement_number=1, mei_filename="x.mei")
    locs = _errors_by_loc(exc_info.value)
    assert "slug" in locs


def test_work_slug_leading_hyphen_rejected() -> None:
    """Work slug starting with a hyphen raises ValidationError."""
    with pytest.raises(ValidationError) as exc_info:
        WorkMetadata(
            slug="-op18",
            title="Test",
            movements=[
                MovementMetadata(
                    slug="i", movement_number=1, mei_filename="x.mei"
                )
            ],
        )
    locs = _errors_by_loc(exc_info.value)
    assert "slug" in locs


def test_corpus_slug_space_rejected() -> None:
    """Corpus slug containing a space raises ValidationError."""
    d = _valid_ingest_dict()
    d["corpus"]["slug"] = "piano sonatas"
    with pytest.raises(ValidationError) as exc_info:
        IngestMetadata.model_validate(d)
    locs = _errors_by_loc(exc_info.value)
    assert any("slug" in k for k in locs)


def test_composer_slug_empty_rejected() -> None:
    """Empty string is rejected as a composer slug."""
    with pytest.raises(ValidationError) as exc_info:
        ComposerMetadata(slug="", name="X", sort_name="X")
    locs = _errors_by_loc(exc_info.value)
    assert "slug" in locs


def test_movement_slug_with_underscore_rejected() -> None:
    """Underscores are not permitted in slugs."""
    with pytest.raises(ValidationError) as exc_info:
        MovementMetadata(
            slug="movement_1", movement_number=1, mei_filename="x.mei"
        )
    locs = _errors_by_loc(exc_info.value)
    assert "slug" in locs


# ===========================================================================
# Slug uniqueness
# ===========================================================================


def test_duplicate_movement_slugs_in_work_rejected() -> None:
    """Two movements with the same slug in one work raises ValidationError."""
    d = _valid_ingest_dict()
    # Give both movements the same slug
    d["corpus"]["works"][0]["movements"][1]["slug"] = "movement-1"
    with pytest.raises(ValidationError) as exc_info:
        IngestMetadata.model_validate(d)
    # The error should mention the duplicate slug
    messages = " ".join(
        msg for msgs in _errors_by_loc(exc_info.value).values() for msg in msgs
    )
    assert "movement-1" in messages


def test_duplicate_work_slugs_in_corpus_rejected() -> None:
    """Two works with the same slug in one corpus raises ValidationError."""
    d = _valid_ingest_dict()
    second_work = copy.deepcopy(d["corpus"]["works"][0])
    # Same slug as k331
    d["corpus"]["works"].append(second_work)
    with pytest.raises(ValidationError) as exc_info:
        IngestMetadata.model_validate(d)
    messages = " ".join(
        msg for msgs in _errors_by_loc(exc_info.value).values() for msg in msgs
    )
    assert "k331" in messages


def test_same_movement_slug_in_different_works_is_valid() -> None:
    """The same movement slug in two different works is permitted."""
    d = _valid_ingest_dict()
    d["corpus"]["works"].append(
        {
            "slug": "k332",
            "title": "Sonata K. 332",
            "movements": [
                {
                    # Same slug as in k331 — different parent, so valid
                    "slug": "movement-1",
                    "movement_number": 1,
                    "mei_filename": "mei/k332/movement-1.mei",
                    "harmonies_filename": "harmonies/k332/movement-1.tsv",
                }
            ],
        }
    )
    meta = IngestMetadata.model_validate(d)
    slugs = [w.movements[0].slug for w in meta.corpus.works]
    assert slugs == ["movement-1", "movement-1"]


# ===========================================================================
# DCML / licence cross-field
# ===========================================================================


def test_dcml_with_cc_by_sa_is_valid() -> None:
    """DCML corpus with CC-BY-SA-4.0 passes validation."""
    d = _valid_ingest_dict()
    d["corpus"]["analysis_source"] = "DCML"
    d["corpus"]["licence"] = "CC-BY-SA-4.0"
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.licence == "CC-BY-SA-4.0"


def test_dcml_with_wrong_licence_rejected() -> None:
    """DCML corpus with a non-CC-BY-SA-4.0 licence raises ValidationError."""
    d = _valid_ingest_dict()
    d["corpus"]["analysis_source"] = "DCML"
    d["corpus"]["licence"] = "CC-BY-4.0"
    with pytest.raises(ValidationError) as exc_info:
        IngestMetadata.model_validate(d)
    messages = " ".join(
        msg for msgs in _errors_by_loc(exc_info.value).values() for msg in msgs
    )
    assert "CC-BY-SA-4.0" in messages


def test_non_dcml_with_cc_by_sa_is_valid() -> None:
    """A WhenInRome corpus may carry CC-BY-SA-4.0 (not forbidden for others)."""
    d = _valid_ingest_dict()
    d["corpus"]["analysis_source"] = "WhenInRome"
    d["corpus"]["licence"] = "CC-BY-SA-4.0"
    for work in d["corpus"]["works"]:
        for m in work["movements"]:
            m["harmonies_filename"] = None
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.analysis_source == "WhenInRome"


def test_non_dcml_with_other_licence_is_valid() -> None:
    """A music21_auto corpus with CC0-1.0 is valid."""
    d = _valid_ingest_dict()
    d["corpus"]["analysis_source"] = "music21_auto"
    d["corpus"]["licence"] = "CC0-1.0"
    for work in d["corpus"]["works"]:
        for m in work["movements"]:
            m["harmonies_filename"] = None
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.licence == "CC0-1.0"


# ===========================================================================
# DCML / harmonies_filename cross-field
# ===========================================================================


def test_dcml_all_movements_have_harmonies_is_valid() -> None:
    """DCML corpus where all movements carry harmonies_filename is valid."""
    meta = IngestMetadata.model_validate(_valid_ingest_dict())
    for work in meta.corpus.works:
        for m in work.movements:
            assert m.harmonies_filename is not None


def test_dcml_missing_harmonies_on_one_movement_rejected() -> None:
    """DCML corpus with one movement missing harmonies_filename is rejected."""
    d = _valid_ingest_dict()
    d["corpus"]["works"][0]["movements"][1]["harmonies_filename"] = None
    with pytest.raises(ValidationError) as exc_info:
        IngestMetadata.model_validate(d)
    messages = " ".join(
        msg for msgs in _errors_by_loc(exc_info.value).values() for msg in msgs
    )
    assert "movement-2" in messages


def test_dcml_missing_harmonies_on_all_movements_rejected() -> None:
    """DCML corpus with no harmonies_filename on any movement is rejected."""
    d = _valid_ingest_dict()
    for work in d["corpus"]["works"]:
        for m in work["movements"]:
            m["harmonies_filename"] = None
    with pytest.raises(ValidationError):
        IngestMetadata.model_validate(d)


def test_non_dcml_missing_harmonies_is_valid() -> None:
    """music21_auto corpus with harmonies_filename absent is valid."""
    d = _valid_ingest_dict()
    d["corpus"]["analysis_source"] = "music21_auto"
    d["corpus"]["licence"] = "CC0-1.0"
    for work in d["corpus"]["works"]:
        for m in work["movements"]:
            del m["harmonies_filename"]
    meta = IngestMetadata.model_validate(d)
    for work in meta.corpus.works:
        for m in work.movements:
            assert m.harmonies_filename is None


# ===========================================================================
# ABC deny-list
# ===========================================================================


def test_abc_beethoven_slug_rejected() -> None:
    """source_repository matching the ABC slug raises ValidationError."""
    d = _valid_ingest_dict()
    d["corpus"]["source_repository"] = "abc/beethoven-quartets"
    d["corpus"]["analysis_source"] = "DCML"
    with pytest.raises(ValidationError) as exc_info:
        IngestMetadata.model_validate(d)
    messages = " ".join(
        msg for msgs in _errors_by_loc(exc_info.value).values() for msg in msgs
    )
    assert "abc/beethoven-quartets" in messages.lower()


def test_abc_beethoven_full_url_rejected() -> None:
    """Full GitHub URL containing the ABC slug also triggers the deny-list."""
    d = _valid_ingest_dict()
    d["corpus"]["source_repository"] = (
        "https://github.com/DCMLab/abc/beethoven-quartets"
    )
    d["corpus"]["analysis_source"] = "DCML"
    with pytest.raises(ValidationError):
        IngestMetadata.model_validate(d)


def test_non_deny_listed_repository_is_valid() -> None:
    """A non-blocked source_repository does not trigger the deny-list."""
    d = _valid_ingest_dict()
    d["corpus"]["source_repository"] = "dcml/mozart-piano-sonatas"
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.source_repository == "dcml/mozart-piano-sonatas"


def test_source_repository_none_is_valid() -> None:
    """source_repository=None is valid (field is optional)."""
    d = _valid_ingest_dict()
    d["corpus"]["source_repository"] = None
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.source_repository is None


# ===========================================================================
# SPDX licence allowlist
# ===========================================================================


def test_unknown_spdx_licence_rejected() -> None:
    """A licence string not in the allowlist raises ValidationError."""
    d = _valid_ingest_dict()
    d["corpus"]["licence"] = "Proprietary"
    with pytest.raises(ValidationError) as exc_info:
        IngestMetadata.model_validate(d)
    locs = _errors_by_loc(exc_info.value)
    assert any("licence" in k for k in locs)


def test_cc0_licence_is_valid() -> None:
    """CC0-1.0 is in the allowlist and is accepted."""
    d = _valid_ingest_dict()
    d["corpus"]["analysis_source"] = "none"
    d["corpus"]["licence"] = "CC0-1.0"
    for work in d["corpus"]["works"]:
        for m in work["movements"]:
            m["harmonies_filename"] = None
    meta = IngestMetadata.model_validate(d)
    assert meta.corpus.licence == "CC0-1.0"


# ===========================================================================
# extra="forbid"
# ===========================================================================


def test_extra_field_on_movement_rejected() -> None:
    """Unknown keys on a movement raise ValidationError."""
    d = _valid_ingest_dict()
    d["corpus"]["works"][0]["movements"][0]["mystery_key"] = "surprise"
    with pytest.raises(ValidationError) as exc_info:
        IngestMetadata.model_validate(d)
    messages = " ".join(
        msg for msgs in _errors_by_loc(exc_info.value).values() for msg in msgs
    )
    assert "mystery_key" in messages or "extra" in messages.lower()


def test_extra_field_on_corpus_rejected() -> None:
    """Unknown keys on the corpus block raise ValidationError."""
    d = _valid_ingest_dict()
    d["corpus"]["legacy_id"] = 42
    with pytest.raises(ValidationError) as exc_info:
        IngestMetadata.model_validate(d)
    messages = " ".join(
        msg for msgs in _errors_by_loc(exc_info.value).values() for msg in msgs
    )
    assert "legacy_id" in messages or "extra" in messages.lower()
