"""Pydantic validation models for knowledge-graph seed YAML files.

Every ``*.yaml`` file under ``backend/seed/domains/`` must parse successfully
against ``DomainYAML``.  ``extra="forbid"`` is enforced on all models so that
a typo in a YAML key produces a ``ValidationError`` rather than being silently
ignored.

Edge-type validation reads the authoritative vocabulary from
``backend/graph/queries/relationships``, ensuring that the list is never
hardcoded in two places.

Usage::

    from backend.seed.schemas import DomainYAML
    import yaml, pathlib

    raw = yaml.safe_load(pathlib.Path("backend/seed/domains/cadences.yaml").read_text())
    domain = DomainYAML.model_validate(raw)
"""

from __future__ import annotations

import inspect
from typing import Literal

from pydantic import BaseModel, ConfigDict, field_validator, model_validator

from backend.graph.queries import relationships as _rel_module

# ---------------------------------------------------------------------------
# Edge-type vocabulary (derived from the relationships constants module so the
# list never lives in two places).
# ---------------------------------------------------------------------------

VALID_EDGE_TYPES: frozenset[str] = frozenset(
    v
    for k, v in inspect.getmembers(_rel_module)
    if isinstance(v, str) and k == v  # constant name equals its string value
)

# ---------------------------------------------------------------------------
# Concept-node type enumeration.
# From knowledge-graph-design-reference.md § "Concept node types".
# Add new types here as new domains introduce them — never accept an unknown
# value at load time.
# ---------------------------------------------------------------------------

ConceptType = Literal["Chord", "CadenceType", "SequenceType", "FormalUnit"]

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


class PropertyValueYAML(BaseModel):
    """One permitted value for a PropertySchema."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    order: int | None = None
    """Display position within this property schema's value list; unset sorts last."""
    references: str | None = None
    """Concept id this value points back to via a VALUE_REFERENCES edge (optional)."""
    aliases: list[str] = []


class PropertySchemaYAML(BaseModel):
    """A dimension of instance variation attached to a concept via HAS_PROPERTY_SCHEMA."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    description: str
    cardinality: Literal["ONE_OF", "MANY_OF", "BOOL"]
    required: bool = False
    values: list[PropertyValueYAML] = []
    """Permitted values. Must be non-empty for ONE_OF/MANY_OF; must be empty for BOOL."""

    @model_validator(mode="after")
    def _validate_values_vs_cardinality(self) -> "PropertySchemaYAML":
        if self.cardinality == "BOOL" and self.values:
            raise ValueError(
                "BOOL schemas must have no values; found non-empty values list."
            )
        if self.cardinality in ("ONE_OF", "MANY_OF") and not self.values:
            raise ValueError(
                f"{self.cardinality} schemas must have at least one value."
            )
        return self


class RelationshipYAML(BaseModel):
    """A typed edge from the owning concept to a target concept id."""

    model_config = ConfigDict(extra="forbid")

    type: str
    """Must be one of the active edge types in backend/graph/queries/relationships.py."""
    target: str
    """Concept id of the relationship target."""

    @field_validator("type")
    @classmethod
    def type_must_be_valid_edge(cls, v: str) -> str:
        if v not in VALID_EDGE_TYPES:
            raise ValueError(
                f"Unknown edge type {v!r}. "
                f"Valid types: {sorted(VALID_EDGE_TYPES)}. "
                "To add a new edge type, edit backend/graph/queries/relationships.py "
                "and docs/architecture/edge-vocabulary-reference.md first."
            )
        return v


class ContainsEntryYAML(BaseModel):
    """One CONTAINS edge from the owning concept to a structural sub-component."""

    model_config = ConfigDict(extra="forbid")

    target: str
    """Concept id of the contained sub-component."""
    order: int
    """Position of this component in the sequence (1-based)."""
    required: bool = True
    display_mode: Literal["stage", "segment"] = "stage"
    """'stage' creates its own bracket row; 'segment' renders within the parent row."""
    containment_mode: Literal["contiguous", "free"] = "contiguous"
    default_weight: float = 1.0
    """Relative width in the default bracket layout; normalised across siblings."""


class CaptureExtensionYAML(BaseModel):
    """One structured field the tagging tool should collect for a concept instance.

    Fields are a flat, shared namespace across all concepts
    (see ``docs/architecture/capture_extensions.md`` § Key Principles):
    two concepts may declare the same ``field`` only if the ``type`` and
    ``required`` values are identical.
    """

    model_config = ConfigDict(extra="forbid")

    field: str
    """Flat-namespace field name shared across all concepts (must not conflict)."""
    type: Literal["harmony_object", "harmony_gate", "fragment_pointer"]
    required: bool
    description: str


class PropertySchemaRefYAML(BaseModel):
    """A concept's reference to a PropertySchema with display-ordering metadata.

    Object form of a ``property_schemas`` entry on a concept node (ADR-023).
    The bare-string form (schema id only) is still accepted for backward compatibility.
    """

    model_config = ConfigDict(extra="forbid")

    schema: str
    """Id of the PropertySchema node being referenced."""
    order: int | None = None
    """Display position in the property form; unset sorts after all numbered schemas."""
    group: str | None = None
    """Optional cluster label; schemas sharing the same group are rendered together."""


class ConceptYAML(BaseModel):
    """A single concept node definition in the seed YAML."""

    model_config = ConfigDict(extra="forbid")

    id: str
    """Immutable PascalCase identifier (join key between PostgreSQL and Neo4j)."""
    name: str
    aliases: list[str] = []
    type: ConceptType | None = None
    """Closed enumeration from knowledge-graph-design-reference.md § 'Concept node types'.
    None is valid for abstract grouping concepts that do not fit a specific structural type."""
    definition: str
    domain: str
    """Domain key this concept belongs to (e.g. 'cadences', 'harmonic-functions')."""
    complexity: Literal["foundational", "intermediate", "advanced"] | None = None
    stub: bool = False
    """When True the node exists as a placeholder; excluded from the tagging UI."""
    definition_reviewed: bool = False
    """When True the ``definition`` prose has passed an editorial review pass and
    may be shown on the public glossary concept page. When False (the default),
    the definition was written for annotators and the glossary substitutes an
    "under editorial review" placeholder (Component 11 Step 2). An informational
    flag like ``stub`` — it gates public display, not seeding or tagging."""
    top_level_taggable: bool = True
    """When False the concept does not appear in the concept picker as a direct tag."""
    relationships: list[RelationshipYAML] = []
    contains: list[ContainsEntryYAML] = []
    property_schemas: list[str | PropertySchemaRefYAML] = []
    """PropertySchema references applicable to this concept (and inherited by subtypes).
    Each entry is either a bare schema id string or a ``PropertySchemaRefYAML`` object
    carrying ``order`` and ``group`` metadata for the ``HAS_PROPERTY_SCHEMA`` edge."""
    capture_extensions: list[CaptureExtensionYAML] = []
    """Structured extra fields the tagging tool should collect for this concept.
    Stored as a JSON-encoded string on the Neo4j node (``c.capture_extensions``)."""


class DomainYAML(BaseModel):
    """Top-level structure of a seed YAML file for one domain."""

    model_config = ConfigDict(extra="forbid")

    domain: str
    """Machine-readable domain key (e.g. 'cadences')."""
    concepts: list[ConceptYAML] = []
    property_schemas: list[PropertySchemaYAML] = []
