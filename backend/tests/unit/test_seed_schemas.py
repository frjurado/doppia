"""Unit tests for backend/seed/schemas.py.

All tests are unit-level (no Docker, no network).  They verify:
- Round-trip fidelity of the Pydantic models against known-good YAML fixtures
- ``extra="forbid"`` enforcement
- Literal / enum validation (cardinality, concept type, edge type)
- Default value correctness per knowledge-graph-design-reference.md conventions
"""

from __future__ import annotations

import pytest
from pydantic import ValidationError

from backend.seed.schemas import (
    VALID_EDGE_TYPES,
    ConceptYAML,
    ContainsEntryYAML,
    DomainYAML,
    PropertySchemaYAML,
    PropertyValueYAML,
    RelationshipYAML,
)

# ---------------------------------------------------------------------------
# Fixtures — minimal valid data blobs
# ---------------------------------------------------------------------------

MINIMAL_CONCEPT: dict = {
    "id": "PerfectAuthenticCadence",
    "name": "Perfect Authentic Cadence",
    "definition": "A cadence ending on I in root position with scale degree 1 in the soprano.",
    "domain": "cadences",
    "type": "CadenceType",
}

MINIMAL_SCHEMA: dict = {
    "id": "SopranoPosition",
    "name": "Soprano Position",
    "description": "Scale degree in the soprano voice at the point of resolution.",
    "cardinality": "ONE_OF",
    "values": [
        {"id": "ScaleDegree1", "name": "Scale Degree 1"},
        {"id": "ScaleDegree3", "name": "Scale Degree 3"},
    ],
}

MINIMAL_DOMAIN: dict = {
    "domain": "cadences",
    "concepts": [MINIMAL_CONCEPT],
    "property_schemas": [MINIMAL_SCHEMA],
}


# ---------------------------------------------------------------------------
# 1. Round-trip: parse → serialise → re-parse
# ---------------------------------------------------------------------------


def test_domain_round_trip() -> None:
    """A known-good YAML dict parses, serialises, and re-parses identically."""
    domain = DomainYAML.model_validate(MINIMAL_DOMAIN)
    serialised = domain.model_dump(mode="json")
    domain2 = DomainYAML.model_validate(serialised)
    assert domain == domain2


def test_concept_round_trip() -> None:
    concept = ConceptYAML.model_validate(MINIMAL_CONCEPT)
    assert concept.id == "PerfectAuthenticCadence"
    assert concept == ConceptYAML.model_validate(concept.model_dump(mode="json"))


def test_property_schema_round_trip() -> None:
    schema = PropertySchemaYAML.model_validate(MINIMAL_SCHEMA)
    assert schema.id == "SopranoPosition"
    assert schema == PropertySchemaYAML.model_validate(schema.model_dump(mode="json"))


# ---------------------------------------------------------------------------
# 2. extra="forbid" — typo in YAML key raises ValidationError
# ---------------------------------------------------------------------------


def test_extra_fields_forbidden_on_concept() -> None:
    """A misspelled YAML key raises ValidationError and names the bad key."""
    bad = {**MINIMAL_CONCEPT, "defenition": "typo"}  # misspelled 'definition'
    with pytest.raises(ValidationError) as exc_info:
        ConceptYAML.model_validate(bad)
    assert "defenition" in str(exc_info.value)


def test_extra_fields_forbidden_on_property_schema() -> None:
    bad = {**MINIMAL_SCHEMA, "cardinallity": "ONE_OF"}  # misspelled key
    with pytest.raises(ValidationError) as exc_info:
        PropertySchemaYAML.model_validate(bad)
    assert "cardinallity" in str(exc_info.value)


def test_extra_fields_forbidden_on_domain() -> None:
    bad = {**MINIMAL_DOMAIN, "unknown_top_level": True}
    with pytest.raises(ValidationError) as exc_info:
        DomainYAML.model_validate(bad)
    assert "unknown_top_level" in str(exc_info.value)


def test_extra_fields_forbidden_on_contains_entry() -> None:
    bad = {"target": "Dominant", "order": 1, "required": True, "bogus_field": 99}
    with pytest.raises(ValidationError) as exc_info:
        ContainsEntryYAML.model_validate(bad)
    assert "bogus_field" in str(exc_info.value)


# ---------------------------------------------------------------------------
# 3. Cardinality literal validation
# ---------------------------------------------------------------------------


def test_invalid_cardinality_raises() -> None:
    bad = {**MINIMAL_SCHEMA, "cardinality": "FOO"}
    with pytest.raises(ValidationError) as exc_info:
        PropertySchemaYAML.model_validate(bad)
    error_str = str(exc_info.value)
    assert "cardinality" in error_str or "FOO" in error_str


def test_valid_cardinalities() -> None:
    for cardinality in ("ONE_OF", "MANY_OF"):
        schema = PropertySchemaYAML.model_validate(
            {**MINIMAL_SCHEMA, "cardinality": cardinality}
        )
        assert schema.cardinality == cardinality


# ---------------------------------------------------------------------------
# 4. Edge-type validation on RelationshipYAML
# ---------------------------------------------------------------------------


def test_invalid_edge_type_raises() -> None:
    """An unknown edge type raises ValidationError with a descriptive message."""
    with pytest.raises(ValidationError) as exc_info:
        RelationshipYAML.model_validate(
            {"type": "NONSENSE_EDGE", "target": "SomeConcept"}
        )
    assert "NONSENSE_EDGE" in str(exc_info.value)


def test_valid_edge_types_accepted() -> None:
    """Every constant in relationships.py is accepted as a valid edge type."""
    for edge_type in VALID_EDGE_TYPES:
        rel = RelationshipYAML.model_validate(
            {"type": edge_type, "target": "SomeConcept"}
        )
        assert rel.type == edge_type


def test_valid_edge_types_set_is_non_empty() -> None:
    """Sanity check: the edge type vocabulary is populated from the module."""
    assert len(VALID_EDGE_TYPES) >= 6  # at minimum the types present at project start


# ---------------------------------------------------------------------------
# 5. Concept defaults: stub and top_level_taggable
# ---------------------------------------------------------------------------


def test_stub_defaults_to_false() -> None:
    """Per knowledge-graph-design-reference.md, stub defaults to False."""
    concept = ConceptYAML.model_validate(MINIMAL_CONCEPT)
    assert concept.stub is False


def test_top_level_taggable_defaults_to_true() -> None:
    """Per knowledge-graph-design-reference.md, top_level_taggable defaults to True."""
    concept = ConceptYAML.model_validate(MINIMAL_CONCEPT)
    assert concept.top_level_taggable is True


def test_stub_true_overrides_default() -> None:
    stub_concept = {**MINIMAL_CONCEPT, "stub": True, "top_level_taggable": False}
    concept = ConceptYAML.model_validate(stub_concept)
    assert concept.stub is True
    assert concept.top_level_taggable is False


# ---------------------------------------------------------------------------
# 6. ContainsEntryYAML defaults
# ---------------------------------------------------------------------------


def test_contains_entry_defaults() -> None:
    entry = ContainsEntryYAML.model_validate({"target": "Dominant", "order": 3})
    assert entry.required is True
    assert entry.display_mode == "stage"
    assert entry.containment_mode == "contiguous"
    assert entry.default_weight == 1.0


def test_contains_entry_segment_display_mode() -> None:
    entry = ContainsEntryYAML.model_validate(
        {"target": "SubstageA", "order": 1, "display_mode": "segment"}
    )
    assert entry.display_mode == "segment"


def test_invalid_display_mode_raises() -> None:
    with pytest.raises(ValidationError):
        ContainsEntryYAML.model_validate(
            {"target": "X", "order": 1, "display_mode": "row"}
        )


# ---------------------------------------------------------------------------
# 7. PropertyValueYAML: optional references field
# ---------------------------------------------------------------------------


def test_property_value_references_optional() -> None:
    value = PropertyValueYAML.model_validate(
        {"id": "ScaleDegree1", "name": "Scale Degree 1"}
    )
    assert value.references is None


def test_property_value_references_set() -> None:
    value = PropertyValueYAML.model_validate(
        {"id": "Cadential64", "name": "Cadential 6-4", "references": "CadentialSixFour"}
    )
    assert value.references == "CadentialSixFour"


# ---------------------------------------------------------------------------
# 8. Full domain with relationships and contains parses correctly
# ---------------------------------------------------------------------------


def test_full_domain_with_all_fields() -> None:
    """A concept using relationships, contains, and property_schemas parses cleanly."""
    full_domain = {
        "domain": "cadences",
        "concepts": [
            {
                "id": "AuthenticCadence",
                "name": "Authentic Cadence",
                "type": "CadenceType",
                "definition": "A cadence whose final harmony is I preceded by V.",
                "domain": "cadences",
                "complexity": "foundational",
                "top_level_taggable": False,
                "relationships": [
                    {"type": "IS_SUBTYPE_OF", "target": "Cadence"},
                ],
                "contains": [
                    {"target": "Dominant", "order": 3, "required": True},
                ],
                "property_schemas": ["SopranoPosition"],
            }
        ],
        "property_schemas": [],
    }
    domain = DomainYAML.model_validate(full_domain)
    concept = domain.concepts[0]
    assert concept.relationships[0].type == "IS_SUBTYPE_OF"
    assert concept.contains[0].order == 3
    assert concept.property_schemas == ["SopranoPosition"]
    assert concept.complexity == "foundational"
