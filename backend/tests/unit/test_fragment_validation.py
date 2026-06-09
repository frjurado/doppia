"""Unit tests for the fragment write validation layer (Step 5 — Component 5).

Covers:
- FragmentSummary Pydantic write constraints (concepts min_length, optional
  music21_version, optional ActualKey.confidence)
- FragmentCreate / SubPartFragmentCreate Pydantic models (beat constraints,
  concept_tags min_length)
- validate_concept_existence — cross-database referential integrity (Neo4j mocked)
- validate_summary_properties — property value validation against schemas
- validate_containment — sub-part bar range containment check

All tests are pure unit tests — no Docker, no running database required.
Neo4j interactions are replaced by AsyncMock stubs.

Test structure
--------------
TestFragmentSummaryWriteConstraints — Pydantic: new v1 schema constraints
TestFragmentWriteModels             — FragmentCreate / SubPartFragmentCreate
TestConceptExistenceValidation      — validate_concept_existence
TestSummaryPropertyValidation       — validate_summary_properties
TestContainmentValidation           — validate_containment
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from pydantic import ValidationError

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _min_summary(**overrides: Any) -> dict[str, Any]:
    """Return a minimal valid version-1 summary dict."""
    base: dict[str, Any] = {
        "version": 1,
        "key": "A major",
        "meter": "4/4",
        "concepts": ["PerfectAuthenticCadence"],
    }
    base.update(overrides)
    return base


def _min_tag(**overrides: Any) -> dict[str, Any]:
    """Return a minimal valid concept tag dict."""
    base: dict[str, Any] = {"concept_id": "PerfectAuthenticCadence", "is_primary": True}
    base.update(overrides)
    return base


def _min_fragment(**overrides: Any) -> dict[str, Any]:
    """Return a minimal valid FragmentCreate payload dict."""
    base: dict[str, Any] = {
        "movement_id": str(uuid.uuid4()),
        "bar_start": 1,
        "bar_end": 4,
        "mc_start": 1,
        "mc_end": 4,
        "summary": _min_summary(),
        "concept_tags": [_min_tag()],
    }
    base.update(overrides)
    return base


def _schema_row(
    schema_id: str,
    cardinality: str = "ONE_OF",
    required: bool = False,
    values: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    """Build a schema row fixture matching get_concept_property_schemas output."""
    return {
        "schema_id": schema_id,
        "schema_name": schema_id,
        "schema_description": None,
        "cardinality": cardinality,
        "required": required,
        "values": values or [],
    }


# ---------------------------------------------------------------------------
# TestFragmentSummaryWriteConstraints
# ---------------------------------------------------------------------------


class TestFragmentSummaryWriteConstraints:
    """New constraints on FragmentSummary introduced in Step 5."""

    def test_concepts_empty_list_rejected(self) -> None:
        """concepts must contain at least one id (min_length=1)."""
        from models.fragment import FragmentSummary

        with pytest.raises(ValidationError) as exc_info:
            FragmentSummary.model_validate(_min_summary(concepts=[]))
        errors = exc_info.value.errors()
        assert any(e["loc"][0] == "concepts" for e in errors)

    def test_music21_version_is_optional(self) -> None:
        """music21_version may be omitted in the DCML-only path (option b)."""
        from models.fragment import FragmentSummary

        summary = FragmentSummary.model_validate(_min_summary())
        assert summary.music21_version is None

    def test_music21_version_sentinel_string_accepted(self) -> None:
        """music21_version='none' is accepted as a DCML-only sentinel."""
        from models.fragment import FragmentSummary

        summary = FragmentSummary.model_validate(_min_summary(music21_version="none"))
        assert summary.music21_version == "none"

    def test_actual_key_without_confidence_accepted(self) -> None:
        """ActualKey.confidence is optional: DCML-only path has no confidence score."""
        from models.fragment import ActualKey, FragmentSummary

        summary = FragmentSummary.model_validate(
            _min_summary(
                actual_key={
                    "value": "G major",
                    "auto": False,
                    "reviewed": True,
                    # confidence omitted — DCML-seeded key has no machine confidence
                }
            )
        )
        assert isinstance(summary.actual_key, ActualKey)
        assert summary.actual_key.confidence is None
        assert summary.actual_key.auto is False
        assert summary.actual_key.reviewed is True

    def test_actual_key_with_confidence_still_accepted(self) -> None:
        """ActualKey.confidence remains valid when present (music21 auto path)."""
        from models.fragment import ActualKey, FragmentSummary

        summary = FragmentSummary.model_validate(
            _min_summary(
                actual_key={
                    "value": "D major",
                    "confidence": 0.91,
                    "auto": True,
                    "reviewed": False,
                }
            )
        )
        assert isinstance(summary.actual_key, ActualKey)
        assert summary.actual_key.confidence == pytest.approx(0.91)


# ---------------------------------------------------------------------------
# TestFragmentWriteModels
# ---------------------------------------------------------------------------


class TestFragmentWriteModels:
    """Pydantic validation on FragmentCreate and SubPartFragmentCreate."""

    def test_valid_fragment_create_passes(self) -> None:
        """A complete, correct FragmentCreate payload validates without error."""
        from models.fragment import FragmentCreate

        frag = FragmentCreate.model_validate(_min_fragment())
        assert frag.bar_start == 1
        assert frag.bar_end == 4
        assert frag.mc_start == 1
        assert len(frag.concept_tags) == 1
        assert frag.sub_parts == []

    def test_concept_tags_must_be_non_empty(self) -> None:
        """concept_tags requires at least one entry (min_length=1)."""
        from models.fragment import FragmentCreate

        with pytest.raises(ValidationError) as exc_info:
            FragmentCreate.model_validate(_min_fragment(concept_tags=[]))
        errors = exc_info.value.errors()
        assert any(e["loc"][0] == "concept_tags" for e in errors)

    def test_concept_tag_id_must_be_non_empty(self) -> None:
        """concept_id must be a non-empty string (min_length=1)."""
        from models.fragment import FragmentCreate

        with pytest.raises(ValidationError):
            FragmentCreate.model_validate(
                _min_fragment(concept_tags=[{"concept_id": "", "is_primary": True}])
            )

    def test_beat_start_lt_beat_end_passes(self) -> None:
        """beat_start < beat_end with both set is valid (ADR-005)."""
        from models.fragment import FragmentCreate

        frag = FragmentCreate.model_validate(
            _min_fragment(beat_start=1.0, beat_end=2.5)
        )
        assert frag.beat_start == pytest.approx(1.0)
        assert frag.beat_end == pytest.approx(2.5)

    def test_beat_start_equal_to_beat_end_rejected(self) -> None:
        """beat_start == beat_end in a single bar is rejected: zero-width (ADR-005)."""
        from models.fragment import FragmentCreate

        with pytest.raises(ValidationError) as exc_info:
            FragmentCreate.model_validate(
                _min_fragment(
                    bar_start=2,
                    bar_end=2,
                    mc_start=2,
                    mc_end=2,
                    beat_start=2.0,
                    beat_end=2.0,
                )
            )
        assert any("beat_start" in str(e) for e in exc_info.value.errors())

    def test_beat_start_greater_than_beat_end_rejected(self) -> None:
        """beat_start > beat_end within a single bar is rejected (ADR-005)."""
        from models.fragment import FragmentCreate

        with pytest.raises(ValidationError) as exc_info:
            FragmentCreate.model_validate(
                _min_fragment(
                    bar_start=2,
                    bar_end=2,
                    mc_start=2,
                    mc_end=2,
                    beat_start=3.0,
                    beat_end=1.0,
                )
            )
        assert any("beat_start" in str(e) for e in exc_info.value.errors())

    def test_cross_bar_beat_inverted_numerically_passes(self) -> None:
        """Cross-bar: beat_start > beat_end numerically is valid (ADR-005).

        e.g. beat 3.5 of bar 2 → beat 2.0 of bar 3 is a legitimate fragment.
        """
        from models.fragment import FragmentCreate

        frag = FragmentCreate.model_validate(
            _min_fragment(
                bar_start=2,
                bar_end=3,
                mc_start=2,
                mc_end=3,
                beat_start=3.5,
                beat_end=2.0,
            )
        )
        assert frag.beat_start == pytest.approx(3.5)
        assert frag.beat_end == pytest.approx(2.0)

    def test_beat_start_set_beat_end_null_rejected(self) -> None:
        """beat_start set with beat_end null is rejected: both or neither (ADR-005)."""
        from models.fragment import FragmentCreate

        with pytest.raises(ValidationError) as exc_info:
            FragmentCreate.model_validate(_min_fragment(beat_start=1.0, beat_end=None))
        assert any(
            "beat_start" in str(e) or "beat_end" in str(e)
            for e in exc_info.value.errors()
        )

    def test_both_beats_null_passes(self) -> None:
        """Null beat_start and beat_end is valid: measure-level selection (ADR-005)."""
        from models.fragment import FragmentCreate

        frag = FragmentCreate.model_validate(
            _min_fragment(beat_start=None, beat_end=None)
        )
        assert frag.beat_start is None
        assert frag.beat_end is None

    def test_sub_part_inherits_beat_constraint(self) -> None:
        """beat_start >= beat_end within a single bar is also rejected on sub-parts."""
        from models.fragment import FragmentCreate

        sub_part = {
            "bar_start": 2,
            "bar_end": 2,
            "mc_start": 2,
            "mc_end": 2,
            "beat_start": 4.0,
            "beat_end": 1.0,  # reversed within same bar — invalid
            "summary": _min_summary(),
            "concept_tags": [_min_tag()],
        }
        with pytest.raises(ValidationError):
            FragmentCreate.model_validate(_min_fragment(sub_parts=[sub_part]))

    def test_valid_fragment_with_sub_parts_passes(self) -> None:
        """A FragmentCreate with valid sub-parts validates without error."""
        from models.fragment import FragmentCreate

        sub_part = {
            "bar_start": 2,
            "bar_end": 3,
            "mc_start": 2,
            "mc_end": 3,
            "summary": _min_summary(),
            "concept_tags": [_min_tag(concept_id="CadentialDominant")],
        }
        frag = FragmentCreate.model_validate(_min_fragment(sub_parts=[sub_part]))
        assert len(frag.sub_parts) == 1
        assert frag.sub_parts[0].bar_start == 2


# ---------------------------------------------------------------------------
# TestConceptExistenceValidation
# ---------------------------------------------------------------------------


class TestConceptExistenceValidation:
    """validate_concept_existence: cross-database referential integrity."""

    @pytest.mark.asyncio
    async def test_all_concepts_exist_passes(self) -> None:
        """No exception is raised when every concept_id is found in Neo4j."""
        from services.fragment_validation import validate_concept_existence

        mock_driver = MagicMock()
        mock_session = AsyncMock()
        mock_driver.session.return_value.__aenter__ = AsyncMock(
            return_value=mock_session
        )
        mock_driver.session.return_value.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "services.fragment_validation.check_concept_exists",
            new=AsyncMock(return_value=True),
        ):
            # Should not raise.
            await validate_concept_existence(
                ["PerfectAuthenticCadence", "CadentialDominant"], mock_driver
            )

    @pytest.mark.asyncio
    async def test_single_missing_concept_raises(self) -> None:
        """FragmentValidationError is raised when a concept_id is not in Neo4j."""
        from errors import FragmentValidationError
        from services.fragment_validation import validate_concept_existence

        mock_driver = MagicMock()
        mock_session = AsyncMock()
        mock_driver.session.return_value.__aenter__ = AsyncMock(
            return_value=mock_session
        )
        mock_driver.session.return_value.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "services.fragment_validation.check_concept_exists",
            new=AsyncMock(return_value=False),
        ):
            with pytest.raises(FragmentValidationError) as exc_info:
                await validate_concept_existence(["NoSuchConcept"], mock_driver)

        err = exc_info.value
        assert "NoSuchConcept" in str(err)
        assert "NoSuchConcept" in err.detail["missing_concept_ids"]

    @pytest.mark.asyncio
    async def test_multiple_missing_concepts_all_reported(self) -> None:
        """All missing concept ids are collected before raising."""
        from errors import FragmentValidationError
        from services.fragment_validation import validate_concept_existence

        mock_driver = MagicMock()
        mock_session = AsyncMock()
        mock_driver.session.return_value.__aenter__ = AsyncMock(
            return_value=mock_session
        )
        mock_driver.session.return_value.__aexit__ = AsyncMock(return_value=False)

        with patch(
            "services.fragment_validation.check_concept_exists",
            new=AsyncMock(return_value=False),
        ):
            with pytest.raises(FragmentValidationError) as exc_info:
                await validate_concept_existence(["MissingA", "MissingB"], mock_driver)

        missing = exc_info.value.detail["missing_concept_ids"]
        assert "MissingA" in missing
        assert "MissingB" in missing

    @pytest.mark.asyncio
    async def test_mix_of_existing_and_missing_raises(self) -> None:
        """Only the missing ids are reported when some concepts exist."""
        from errors import FragmentValidationError
        from services.fragment_validation import validate_concept_existence

        mock_driver = MagicMock()
        mock_session = AsyncMock()
        mock_driver.session.return_value.__aenter__ = AsyncMock(
            return_value=mock_session
        )
        mock_driver.session.return_value.__aexit__ = AsyncMock(return_value=False)

        exists_map = {"PerfectAuthenticCadence": True, "GhostConcept": False}

        async def _check(session: Any, concept_id: str) -> bool:
            return exists_map[concept_id]

        with patch("services.fragment_validation.check_concept_exists", new=_check):
            with pytest.raises(FragmentValidationError) as exc_info:
                await validate_concept_existence(
                    ["PerfectAuthenticCadence", "GhostConcept"], mock_driver
                )

        missing = exc_info.value.detail["missing_concept_ids"]
        assert missing == ["GhostConcept"]


# ---------------------------------------------------------------------------
# TestSummaryPropertyValidation
# ---------------------------------------------------------------------------


class TestSummaryPropertyValidation:
    """validate_summary_properties: schema-driven property validation."""

    def test_no_properties_no_schemas_passes(self) -> None:
        """Empty properties with no schemas is valid (stageless concept)."""
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        summary = FragmentSummary.model_validate(_min_summary())
        validate_summary_properties(summary, schemas=[])  # must not raise

    def test_required_property_present_passes(self) -> None:
        """A required schema with a valid value passes."""
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        schemas = [
            _schema_row(
                "CadenceFunction",
                cardinality="ONE_OF",
                required=True,
                values=[{"id": "Independent"}, {"id": "Dependent"}],
            )
        ]
        summary = FragmentSummary.model_validate(
            _min_summary(properties={"CadenceFunction": "Independent"})
        )
        validate_summary_properties(summary, schemas=schemas)  # must not raise

    def test_missing_required_property_raises(self) -> None:
        """A required schema with no value in properties raises FragmentValidationError."""
        from errors import FragmentValidationError
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        schemas = [
            _schema_row(
                "CadenceFunction",
                cardinality="ONE_OF",
                required=True,
                values=[{"id": "Independent"}],
            )
        ]
        summary = FragmentSummary.model_validate(_min_summary())  # no properties

        with pytest.raises(FragmentValidationError) as exc_info:
            validate_summary_properties(summary, schemas=schemas)

        assert "CadenceFunction" in str(exc_info.value)
        assert exc_info.value.detail["missing_schema_id"] == "CadenceFunction"

    def test_optional_property_missing_passes(self) -> None:
        """An optional (required=False) schema with no value is accepted."""
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        schemas = [_schema_row("ECP", cardinality="BOOL", required=False)]
        summary = FragmentSummary.model_validate(_min_summary())
        validate_summary_properties(summary, schemas=schemas)  # must not raise

    def test_one_of_invalid_value_raises(self) -> None:
        """A ONE_OF value not in the schema's value list raises."""
        from errors import FragmentValidationError
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        schemas = [
            _schema_row(
                "SopranoPosition",
                cardinality="ONE_OF",
                required=False,
                values=[{"id": "ScaleDegree1"}, {"id": "ScaleDegree3"}],
            )
        ]
        summary = FragmentSummary.model_validate(
            _min_summary(properties={"SopranoPosition": "ScaleDegree5"})  # not valid
        )
        with pytest.raises(FragmentValidationError) as exc_info:
            validate_summary_properties(summary, schemas=schemas)

        assert "ScaleDegree5" in str(exc_info.value)

    def test_one_of_non_string_value_raises(self) -> None:
        """A ONE_OF value that is a list (not a string) raises."""
        from errors import FragmentValidationError
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        schemas = [_schema_row("SopranoPosition", cardinality="ONE_OF", required=False)]
        # Sneak in a list value by bypassing Pydantic via model_construct
        summary = FragmentSummary.model_construct(
            version=1,
            key="A major",
            meter="4/4",
            concepts=["PerfectAuthenticCadence"],
            properties={"SopranoPosition": ["ScaleDegree1"]},  # list, not str
        )
        with pytest.raises(FragmentValidationError):
            validate_summary_properties(summary, schemas=schemas)

    def test_many_of_valid_list_passes(self) -> None:
        """A MANY_OF value list with all valid ids passes."""
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        schemas = [
            _schema_row(
                "CadentialElaboration",
                cardinality="MANY_OF",
                required=False,
                values=[{"id": "Cadential64"}, {"id": "AppliedDominant"}],
            )
        ]
        summary = FragmentSummary.model_validate(
            _min_summary(
                properties={"CadentialElaboration": ["Cadential64", "AppliedDominant"]}
            )
        )
        validate_summary_properties(summary, schemas=schemas)  # must not raise

    def test_many_of_invalid_value_raises(self) -> None:
        """A MANY_OF list containing an unknown id raises."""
        from errors import FragmentValidationError
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        schemas = [
            _schema_row(
                "CadentialElaboration",
                cardinality="MANY_OF",
                required=False,
                values=[{"id": "Cadential64"}],
            )
        ]
        summary = FragmentSummary.model_validate(
            _min_summary(
                properties={"CadentialElaboration": ["Cadential64", "UnknownId"]}
            )
        )
        with pytest.raises(FragmentValidationError) as exc_info:
            validate_summary_properties(summary, schemas=schemas)

        assert "UnknownId" in str(exc_info.value)

    def test_bool_schema_no_validation_of_value(self) -> None:
        """A BOOL schema with any string value in properties is accepted."""
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        schemas = [_schema_row("ECP", cardinality="BOOL", required=False, values=[])]
        summary = FragmentSummary.model_validate(
            _min_summary(properties={"ECP": "true"})
        )
        validate_summary_properties(summary, schemas=schemas)  # must not raise

    def test_unknown_schema_in_properties_is_silently_ignored(self) -> None:
        """A property key not in the schemas list is skipped without error."""
        from models.fragment import FragmentSummary
        from services.fragment_validation import validate_summary_properties

        schemas = [_schema_row("CadenceFunction", cardinality="ONE_OF", required=False)]
        summary = FragmentSummary.model_validate(
            _min_summary(properties={"UnknownSchemaFromFuture": "somevalue"})
        )
        validate_summary_properties(summary, schemas=schemas)  # must not raise


# ---------------------------------------------------------------------------
# TestContainmentValidation
# ---------------------------------------------------------------------------


class TestContainmentValidation:
    """validate_containment: sub-part bar ranges must be within the parent."""

    def _make_parent(self, bar_start: int = 1, bar_end: int = 8) -> Any:
        """Return a FragmentCreate with given parent bar range."""
        from models.fragment import FragmentCreate

        return FragmentCreate.model_validate(
            _min_fragment(bar_start=bar_start, bar_end=bar_end)
        )

    def _make_child(self, bar_start: int, bar_end: int) -> Any:
        """Return a SubPartFragmentCreate with given bar range."""
        from models.fragment import SubPartFragmentCreate

        return SubPartFragmentCreate.model_validate(
            {
                "bar_start": bar_start,
                "bar_end": bar_end,
                "mc_start": bar_start,
                "mc_end": bar_end,
                "summary": _min_summary(),
                "concept_tags": [_min_tag()],
            }
        )

    def test_child_within_parent_passes(self) -> None:
        """A sub-part fully inside the parent range is accepted."""
        from services.fragment_validation import validate_containment

        parent = self._make_parent(bar_start=1, bar_end=8)
        child = self._make_child(bar_start=3, bar_end=5)
        validate_containment(parent, [child])  # must not raise

    def test_child_equal_to_parent_range_passes(self) -> None:
        """A sub-part spanning the full parent range is accepted."""
        from services.fragment_validation import validate_containment

        parent = self._make_parent(bar_start=2, bar_end=6)
        child = self._make_child(bar_start=2, bar_end=6)
        validate_containment(parent, [child])  # must not raise

    def test_no_children_passes(self) -> None:
        """An empty sub-parts list raises no error."""
        from services.fragment_validation import validate_containment

        parent = self._make_parent()
        validate_containment(parent, [])  # must not raise

    def test_child_starts_before_parent_raises(self) -> None:
        """A sub-part starting before bar_start is out of range."""
        from errors import FragmentValidationError
        from services.fragment_validation import validate_containment

        parent = self._make_parent(bar_start=3, bar_end=8)
        child = self._make_child(bar_start=1, bar_end=5)  # starts before parent

        with pytest.raises(FragmentValidationError) as exc_info:
            validate_containment(parent, [child])

        detail = exc_info.value.detail
        assert detail["sub_part_index"] == 0
        assert detail["parent_bar_start"] == 3

    def test_child_ends_after_parent_raises(self) -> None:
        """A sub-part ending after bar_end is out of range."""
        from errors import FragmentValidationError
        from services.fragment_validation import validate_containment

        parent = self._make_parent(bar_start=1, bar_end=4)
        child = self._make_child(bar_start=2, bar_end=6)  # ends after parent

        with pytest.raises(FragmentValidationError) as exc_info:
            validate_containment(parent, [child])

        detail = exc_info.value.detail
        assert detail["child_bar_end"] == 6
        assert detail["parent_bar_end"] == 4

    def test_second_child_out_of_range_raises(self) -> None:
        """The index in the error detail identifies which sub-part failed."""
        from errors import FragmentValidationError
        from services.fragment_validation import validate_containment

        parent = self._make_parent(bar_start=1, bar_end=8)
        child_ok = self._make_child(bar_start=2, bar_end=4)
        child_bad = self._make_child(bar_start=6, bar_end=10)  # exceeds parent

        with pytest.raises(FragmentValidationError) as exc_info:
            validate_containment(parent, [child_ok, child_bad])

        assert exc_info.value.detail["sub_part_index"] == 1
