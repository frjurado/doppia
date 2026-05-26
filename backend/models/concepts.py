"""Pydantic response models for concept API endpoints.

Used by ``backend/api/routes/concepts.py`` and ``backend/services/concepts.py``.
All models are read-only (response-side only in Component 5; write models
are deferred to later steps).
"""

from __future__ import annotations

from pydantic import BaseModel, Field

# ---------------------------------------------------------------------------
# Schema-tree response models  (GET /api/v1/concepts/{id}/schemas)
# ---------------------------------------------------------------------------


class ReferencedConcept(BaseModel):
    """A concept referenced by a PropertyValue via a VALUE_REFERENCES edge.

    Included inline so the form can render the ⓘ info-link without a second
    round-trip.

    Attributes:
        id: Immutable concept identifier.
        name: Human-readable concept name.
        definition: Long-form definition text, or ``None`` if not set.
    """

    id: str
    name: str
    definition: str | None = None


class PropertyValueItem(BaseModel):
    """A single permitted value for a PropertySchema.

    Attributes:
        id: Stable value identifier.
        name: Human-readable value label.
        referenced_concept: If this value has a ``VALUE_REFERENCES`` edge,
            the target concept's id, name, and definition; ``None`` otherwise.
    """

    id: str
    name: str
    referenced_concept: ReferencedConcept | None = None


class PropertySchemaItem(BaseModel):
    """A PropertySchema node with its hydrated value list.

    Attributes:
        id: Stable schema identifier (e.g. ``"CadenceFunction"``).
        name: Human-readable schema label.
        description: Prose explanation of the property dimension.
        cardinality: ``"ONE_OF"``, ``"MANY_OF"``, or ``"BOOL"``.
        required: Whether an instance must supply a value for this property.
        values: Permitted values; empty list for BOOL schemas.
    """

    id: str
    name: str
    description: str | None = None
    cardinality: str
    required: bool
    values: list[PropertyValueItem] = Field(default_factory=list)


class ContainsStageItem(BaseModel):
    """A CONTAINS edge target (stage) with its edge-level metadata.

    Attributes:
        target_id: Concept id of the stage.
        target_name: Concept name of the stage.
        order: Position in the stage sequence (1-based).
        required: Whether instances must include this stage.
        display_mode: ``"stage"`` (own bracket row) or ``"segment"``
            (subdivision within parent bracket).
        containment_mode: ``"contiguous"`` (shared split handle) or
            ``"free"`` (independent endpoints; not implemented in Phase 1).
        default_weight: Relative width in the pre-populated bracket layout.
    """

    target_id: str
    target_name: str
    order: int
    required: bool
    display_mode: str
    containment_mode: str
    default_weight: float


class TypeRefinementChild(BaseModel):
    """One child concept in the Type Refinement radio group.

    Attributes:
        id: Concept id of the child.
        name: Concept name.
        definition: Definition text for the tooltip; ``None`` if absent.
    """

    id: str
    name: str
    definition: str | None = None


class TypeRefinement(BaseModel):
    """Type Refinement section data for the form panel.

    ``show`` is ``True`` when the concept has IS_SUBTYPE_OF children whose
    resolved CONTAINS structures differ from one another.  Selecting a child
    reshapes the stage bracket track; the chosen subtype id is recorded in the
    submission payload.

    Attributes:
        show: Whether to render the refinement section.
        children: The direct non-stub IS_SUBTYPE_OF children; empty when
            ``show`` is ``False``.
    """

    show: bool
    children: list[TypeRefinementChild] = Field(default_factory=list)


class ConceptSchemaTreeResponse(BaseModel):
    """Full schema tree for a taggable concept.

    Everything the form panel needs to render in one call: property schemas
    (inherited via IS_SUBTYPE_OF), stage structure (inherited CONTAINS edges),
    and Type Refinement metadata.

    Attributes:
        concept_id: The queried concept id.
        schemas: All applicable PropertySchemas with hydrated values, ordered
            alphabetically by schema id.
        stages: All inherited CONTAINS stages ordered by ``order`` ascending.
        type_refinement: Refinement section visibility and child list.
    """

    concept_id: str
    schemas: list[PropertySchemaItem] = Field(default_factory=list)
    stages: list[ContainsStageItem] = Field(default_factory=list)
    type_refinement: TypeRefinement


# ---------------------------------------------------------------------------
# Search response models  (GET /api/v1/concepts/search)
# ---------------------------------------------------------------------------


class ConceptSearchItem(BaseModel):
    """A single concept hit returned by the search endpoint.

    Attributes:
        id: Immutable concept identifier (the graph join key).
        name: Human-readable concept name.
        aliases: Alternative names / abbreviations (e.g. ``["PAC"]``).
        hierarchy_path: Ancestor names from root to this concept, inclusive
            (e.g. ``["Cadence", "Authentic Cadence", "Perfect Authentic Cadence"]``).
        definition: Long-form definition text, or ``None`` if not set.
    """

    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    hierarchy_path: list[str] = Field(default_factory=list)
    definition: str | None = None


class ConceptSearchResponse(BaseModel):
    """Paginated response for ``GET /api/v1/concepts/search``.

    Attributes:
        items: Ordered list of matching concepts (highest relevance first).
        next_cursor: Opaque cursor for the next page; ``None`` when no further
            results exist.
    """

    items: list[ConceptSearchItem]
    next_cursor: str | None = None
