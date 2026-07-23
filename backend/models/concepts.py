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
        translation_missing: ``True`` when the requested non-English locale has
            no translation for this concept and English values are served as a
            fallback (ADR-006 §6). Always ``False`` for English.
    """

    id: str
    name: str
    definition: str | None = None
    translation_missing: bool = False


class PropertyValueItem(BaseModel):
    """A single permitted value for a PropertySchema.

    Attributes:
        id: Stable value identifier.
        name: Human-readable value label.
        order: Display position within the schema's value list (from the
            ``HAS_VALUE`` edge); ``None`` when not declared (sorts last).
        referenced_concept: If this value has a ``VALUE_REFERENCES`` edge,
            the target concept's id, name, and definition; ``None`` otherwise.
        translation_missing: ``True`` when the requested non-English locale has
            no translation for this value and the English label is served as a
            fallback (ADR-006 §6). Always ``False`` for English.
    """

    id: str
    name: str
    order: int | None = None
    referenced_concept: ReferencedConcept | None = None
    translation_missing: bool = False


class PropertySchemaItem(BaseModel):
    """A PropertySchema node with its hydrated value list.

    Attributes:
        id: Stable schema identifier (e.g. ``"CadenceFunction"``).
        name: Human-readable schema label.
        description: Prose explanation of the property dimension.
        cardinality: ``"ONE_OF"``, ``"MANY_OF"``, or ``"BOOL"``.
        required: Whether an instance must supply a value for this property.
        order: Display position in the concept's property form (from the
            ``HAS_PROPERTY_SCHEMA`` edge); ``None`` when not declared (sorts last).
        group: Optional cluster label grouping related schemas in the form
            (from the ``HAS_PROPERTY_SCHEMA`` edge); ``None`` for ungrouped schemas.
        values: Permitted values; empty list for BOOL schemas.
        translation_missing: ``True`` when the requested non-English locale has
            no translation for this schema and English values are served as a
            fallback (ADR-006 §6). Always ``False`` for English.
    """

    id: str
    name: str
    description: str | None = None
    cardinality: str
    required: bool
    order: int | None = None
    group: str | None = None
    values: list[PropertyValueItem] = Field(default_factory=list)
    translation_missing: bool = False


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
        translation_missing: ``True`` when the requested non-English locale has
            no translation for the stage concept (``target_name`` falls back to
            English) (ADR-006 §6). Always ``False`` for English.
    """

    target_id: str
    target_name: str
    order: int
    required: bool
    display_mode: str
    containment_mode: str
    default_weight: float
    translation_missing: bool = False


class TypeRefinementChild(BaseModel):
    """One child concept in the Type Refinement radio group.

    Attributes:
        id: Concept id of the child.
        name: Concept name.
        definition: Definition text for the tooltip; ``None`` if absent.
        translation_missing: ``True`` when the requested non-English locale has
            no translation for this child concept (ADR-006 §6). Always ``False``
            for English.
    """

    id: str
    name: str
    definition: str | None = None
    translation_missing: bool = False


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
        schemas: All applicable PropertySchemas with hydrated values, sorted by
            (grouped-first, order, name) per ADR-023.
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
        translation_missing: ``True`` when the requested non-English locale has
            no translation for this concept and English values are served as a
            fallback (ADR-006 §6). Always ``False`` for English.
    """

    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    hierarchy_path: list[str] = Field(default_factory=list)
    definition: str | None = None
    translation_missing: bool = False


class ConceptSearchResponse(BaseModel):
    """Paginated response for ``GET /api/v1/concepts/search``.

    Attributes:
        items: Ordered list of matching concepts (highest relevance first).
        next_cursor: Opaque cursor for the next page; ``None`` when no further
            results exist.
    """

    items: list[ConceptSearchItem]
    next_cursor: str | None = None


# ---------------------------------------------------------------------------
# Concept tree response models  (GET /api/v1/concepts/tree)
# ---------------------------------------------------------------------------


class ConceptTreeNode(BaseModel):
    """One node in the concept IS_SUBTYPE_OF subtree.

    The tree is returned as a flat list; the caller assembles the hierarchy
    from ``parent_id``.  The root node's ``parent_id`` is ``None`` even if
    the root concept has ancestors above it in the full graph — those are
    outside the queried subtree and are not included.

    Attributes:
        id: Immutable concept identifier.
        name: Human-readable concept name.
        aliases: Alternative names / abbreviations (e.g. ``["PAC"]``).
        hierarchy_path: Ancestor names from domain root to this concept,
            inclusive (e.g. ``["Cadence", "Authentic Cadence",
            "Perfect Authentic Cadence"]``).
        parent_id: The id of this node's direct IS_SUBTYPE_OF parent
            *within the subtree*, or ``None`` for the root.
        fragment_count: Number of ``approved`` fragments whose concept tags
            include this concept (cross-reference tags count, not only
            ``is_primary``).
        translation_missing: ``True`` when the requested non-English locale has
            no translation for this concept and English values are served as a
            fallback (ADR-006 §6). Always ``False`` for English.
    """

    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    hierarchy_path: list[str] = Field(default_factory=list)
    parent_id: str | None = None
    fragment_count: int = 0
    translation_missing: bool = False


class ConceptTreeResponse(BaseModel):
    """Flat node list for the concept subtree rooted at ``root_id``.

    The tree is serialised as a flat list so the response has no recursive
    structure.  UI components build the nested display by keying on
    ``parent_id``.

    Attributes:
        root_id: The concept id that was used as the root of the query.
        nodes: All non-stub concepts in the subtree, sorted alphabetically
            by name.  Always contains at least one node (the root itself)
            when ``root_id`` is a valid non-stub concept.
    """

    root_id: str
    nodes: list[ConceptTreeNode]


# ---------------------------------------------------------------------------
# Domain roots response model  (GET /api/v1/concepts/roots)
# ---------------------------------------------------------------------------


class ConceptRootItem(BaseModel):
    """A domain root concept — a non-stub concept with no IS_SUBTYPE_OF parent.

    Attributes:
        id: Immutable concept identifier (e.g. ``"Cadence"``).
        name: Human-readable concept name.
        aliases: Alternative names / abbreviations; empty list if none.
        translation_missing: ``True`` when the requested non-English locale has
            no translation for this concept and English values are served as a
            fallback (ADR-006 §6). Always ``False`` for English.
    """

    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    translation_missing: bool = False


class ConceptRootsResponse(BaseModel):
    """All domain root concepts, sorted alphabetically.

    Attributes:
        roots: Ordered list of domain root items.
    """

    roots: list[ConceptRootItem]


# ---------------------------------------------------------------------------
# Public concept-detail response models  (GET /api/v1/public/concepts/{id})
# ---------------------------------------------------------------------------


class ConceptRef(BaseModel):
    """A lightweight reference to a concept (hierarchy neighbour or edge target).

    Attributes:
        id: Immutable concept identifier — the stable link target for the
            public concept page.
        name: Human-readable concept name.
        stub: ``True`` when the referenced concept belongs to a not-yet-modelled
            domain. The glossary renders stub targets as flagged non-links
            ("not yet covered") rather than hiding them, keeping inbound links
            stable (``phase-2.md`` Component 11 § Stubs).
    """

    id: str
    name: str
    stub: bool = False


class ConceptRelationship(BaseModel):
    """One typed relationship from the concept page's controlled vocabulary.

    Excludes ``IS_SUBTYPE_OF`` (surfaced separately as the hierarchy) and the
    schema structural edges. The vocabulary is defined by
    ``graph.queries.concepts.DISPLAY_RELATIONSHIP_TYPES``.

    Attributes:
        type: Relationship-type string (e.g. ``"RESOLVES_TO"``,
            ``"CONTRASTS_WITH"``) — a value from the edge vocabulary.
        direction: ``"outgoing"`` when this concept is the edge source,
            ``"incoming"`` when it is the target.
        target: The concept at the other end of the edge.
    """

    type: str
    direction: str
    target: ConceptRef


class ConceptDetailResponse(BaseModel):
    """Full public concept-page payload (GET /api/v1/public/concepts/{id}).

    Everything the glossary concept page renders in one call: the concept's
    identity and prose, its place in the ``IS_SUBTYPE_OF`` hierarchy (path,
    parent, children), and its typed relationships to other concepts. Example
    fragments are a separate, cheaply re-drawable call (Step 3).

    ``definition`` is the raw definition prose; the ``definition_reviewed`` flag
    tells the frontend whether that prose has passed editorial review or a
    placeholder should be shown in its place (Step 2). ``stub`` marks a concept
    whose domain is not yet modelled — its page states so honestly and omits the
    example section.

    Attributes:
        id: Immutable concept identifier (the join key and public URL key).
        name: Human-readable concept name.
        aliases: Alternative names / abbreviations (e.g. ``["PAC"]``).
        definition: Long-form definition prose, or ``None`` if unset.
        domain: The concept's domain (e.g. ``"cadences"``), or ``None``.
        complexity: Pedagogical band (``"foundational"`` / ``"intermediate"`` /
            ``"advanced"``), or ``None`` if unset.
        stub: ``True`` for a not-yet-modelled concept.
        definition_reviewed: ``True`` once the definition prose has passed the
            editorial review gate; ``False`` (the default) means the frontend
            should show the "under editorial review" placeholder (Step 2).
        top_level_taggable: Whether the concept is itself directly taggable
            (informational; sub-part-only concepts are ``False``).
        hierarchy_path: Ancestor names from the domain root to this concept,
            inclusive.
        parent: The direct ``IS_SUBTYPE_OF`` parent, or ``None`` for a domain
            root.
        children: Direct ``IS_SUBTYPE_OF`` children, ordered by name; stub
            children are included but flagged.
        relationships: Typed concept-to-concept relationships (both directions).
    """

    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    definition: str | None = None
    domain: str | None = None
    complexity: str | None = None
    stub: bool = False
    definition_reviewed: bool = False
    top_level_taggable: bool = False
    hierarchy_path: list[str] = Field(default_factory=list)
    parent: ConceptRef | None = None
    children: list[ConceptRef] = Field(default_factory=list)
    relationships: list[ConceptRelationship] = Field(default_factory=list)


# ---------------------------------------------------------------------------
# Public concept-index response models  (GET /api/v1/public/concepts)
# ---------------------------------------------------------------------------


class ConceptIndexNode(BaseModel):
    """One concept in the public browse-by-domain index.

    A flat node in a domain's ``IS_SUBTYPE_OF`` subtree; the frontend assembles
    the nested display by keying on ``parent_id`` (the same shape as the editor
    tree, minus the schema/CONTAINS detail a public reader does not need).

    Attributes:
        id: Immutable concept identifier (the link target for the concept page).
        name: Human-readable concept name.
        aliases: Alternative names / abbreviations (e.g. ``["PAC"]``).
        hierarchy_path: Ancestor names from the domain root to this concept,
            inclusive.
        parent_id: The id of this node's direct ``IS_SUBTYPE_OF`` parent within
            the domain subtree, or ``None`` for the domain root.
        fragment_count: Number of ``approved`` fragments whose concept tags
            include this concept (any tag, not only ``is_primary``) — the count
            the browse surface shows. Reads the same source as the editor tree,
            so the M11 count-cache fix (Step 8) de-stales both at once.
    """

    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    hierarchy_path: list[str] = Field(default_factory=list)
    parent_id: str | None = None
    fragment_count: int = 0


class ConceptIndexDomain(BaseModel):
    """One domain (a root concept and its non-stub subtree) in the index.

    Attributes:
        root_id: The domain root's concept id (a concept with no
            ``IS_SUBTYPE_OF`` parent, e.g. ``"Cadence"``).
        root_name: The domain root's human-readable name.
        nodes: All non-stub concepts in the root's ``IS_SUBTYPE_OF`` subtree,
            including the root itself (``parent_id = None``), ordered by name.
    """

    root_id: str
    root_name: str
    nodes: list[ConceptIndexNode] = Field(default_factory=list)


class ConceptIndexResponse(BaseModel):
    """The public concept glossary index — every domain, browsable anonymously.

    Returned by ``GET /api/v1/public/concepts``. Stub concepts are not listed
    here (a domain's browsable tree is its non-stub subtree); a stub concept
    remains reachable through the marked stub links on a concept page (Step 1),
    which keeps inbound links stable without cluttering the browse index.

    Attributes:
        domains: One entry per non-stub domain root, ordered by root name.
    """

    domains: list[ConceptIndexDomain] = Field(default_factory=list)
