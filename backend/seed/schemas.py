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

from pydantic import BaseModel, ConfigDict, field_validator

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
    references: str | None = None
    """Concept id this value points back to via a VALUE_REFERENCES edge (optional)."""
    aliases: list[str] = []


class PropertySchemaYAML(BaseModel):
    """A dimension of instance variation attached to a concept via HAS_PROPERTY_SCHEMA."""

    model_config = ConfigDict(extra="forbid")

    id: str
    name: str
    description: str
    cardinality: Literal["ONE_OF", "MANY_OF"]
    required: bool = False
    values: list[PropertyValueYAML]


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
    top_level_taggable: bool = True
    """When False the concept does not appear in the concept picker as a direct tag."""
    relationships: list[RelationshipYAML] = []
    contains: list[ContainsEntryYAML] = []
    property_schemas: list[str] = []
    """Ids of PropertySchema nodes applicable to this concept (and inherited by subtypes)."""


class DomainYAML(BaseModel):
    """Top-level structure of a seed YAML file for one domain."""

    model_config = ConfigDict(extra="forbid")

    domain: str
    """Machine-readable domain key (e.g. 'cadences')."""
    concepts: list[ConceptYAML] = []
    property_schemas: list[PropertySchemaYAML] = []
