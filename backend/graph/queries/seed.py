"""Cypher queries and execution helpers for knowledge-graph seeding.

All functions accept a synchronous ``neo4j.Session`` object.  Seeding is a
CLI-driven bulk operation (not a request handler), so the sync driver is used
throughout.  The async driver is for the application layer.

Every write uses ``MERGE`` (never ``CREATE``) per the project invariant.
Cypher strings are module-level constants so they can be audited independently
of the calling code.

See ``scripts/seed.py`` for top-level orchestration and the exit-code policy.
See ``docs/roadmap/component-4-knowledge-graph.md`` § Step 7 for the full spec.
"""

from __future__ import annotations

import json

from neo4j import Session as _Session

from backend.seed.schemas import ConceptYAML, ContainsEntryYAML, PropertySchemaYAML

# ---------------------------------------------------------------------------
# Infrastructure DDL
# ---------------------------------------------------------------------------

CREATE_CONCEPT_FULLTEXT_INDEX = """\
CREATE FULLTEXT INDEX concept_search IF NOT EXISTS
FOR (c:Concept) ON EACH [c.name, c.aliases]
"""
"""Full-text index over Concept.name and Concept.aliases.

``IF NOT EXISTS`` makes this idempotent.  Used by the concept-picker query in
Component 5.  Created during every seed run so it is always present in CI.
"""

# ---------------------------------------------------------------------------
# Read queries
# ---------------------------------------------------------------------------

_GET_ALL_CONCEPT_IDS = """\
MATCH (c:Concept) RETURN collect(c.id) AS ids
"""

_GET_ALL_SCHEMA_IDS = """\
MATCH (ps:PropertySchema) RETURN collect(ps.id) AS ids
"""

# ---------------------------------------------------------------------------
# Domain node
# ---------------------------------------------------------------------------

_MERGE_DOMAIN = """\
MERGE (d:Domain {id: $id})
ON CREATE SET d.name = $name
ON MATCH SET  d.name = $name
"""

# ---------------------------------------------------------------------------
# PropertyValue
# ---------------------------------------------------------------------------

_MERGE_PROPERTY_VALUE = """\
MERGE (pv:PropertyValue {id: $id})
ON CREATE SET pv.name = $name, pv.aliases = $aliases, pv.references = $references
ON MATCH SET  pv.name = $name, pv.aliases = $aliases, pv.references = $references
"""

# ---------------------------------------------------------------------------
# PropertySchema + HAS_VALUE edge
# ---------------------------------------------------------------------------

_MERGE_PROPERTY_SCHEMA = """\
MERGE (ps:PropertySchema {id: $id})
ON CREATE SET ps.name        = $name,
              ps.description = $description,
              ps.cardinality = $cardinality,
              ps.required    = $required
ON MATCH SET  ps.name        = $name,
              ps.description = $description,
              ps.cardinality = $cardinality,
              ps.required    = $required
"""

_MERGE_HAS_VALUE_EDGE = """\
MATCH (ps:PropertySchema {id: $schema_id})
MATCH (pv:PropertyValue  {id: $value_id})
MERGE (ps)-[:HAS_VALUE]->(pv)
"""

# ---------------------------------------------------------------------------
# Concept node
# ---------------------------------------------------------------------------

_MERGE_CONCEPT = """\
MERGE (c:Concept {id: $id})
ON CREATE SET c.name               = $name,
              c.aliases            = $aliases,
              c.type               = $type,
              c.definition         = $definition,
              c.domain             = $domain,
              c.complexity         = $complexity,
              c.stub               = $stub,
              c.top_level_taggable = $top_level_taggable,
              c.capture_extensions = $capture_extensions
ON MATCH SET  c.name               = $name,
              c.aliases            = $aliases,
              c.type               = $type,
              c.definition         = $definition,
              c.domain             = $domain,
              c.complexity         = $complexity,
              c.stub               = $stub,
              c.top_level_taggable = $top_level_taggable,
              c.capture_extensions = $capture_extensions
"""

# ---------------------------------------------------------------------------
# Edges attached to Concept nodes
# ---------------------------------------------------------------------------

# Relationship type is interpolated via Python .format() — safe because
# RelationshipYAML.type is validated against VALID_EDGE_TYPES at parse time.
_MERGE_RELATIONSHIP_EDGE_TEMPLATE = """\
MATCH (source:Concept {{id: $source_id}})
MATCH (target:Concept {{id: $target_id}})
MERGE (source)-[:{rel_type}]->(target)
"""

_MERGE_CONTAINS_EDGE = """\
MATCH (source:Concept {id: $source_id})
MATCH (target:Concept {id: $target_id})
MERGE (source)-[r:CONTAINS]->(target)
ON CREATE SET r.order            = $order,
              r.required         = $required,
              r.display_mode     = $display_mode,
              r.containment_mode = $containment_mode,
              r.default_weight   = $default_weight
ON MATCH SET  r.order            = $order,
              r.required         = $required,
              r.display_mode     = $display_mode,
              r.containment_mode = $containment_mode,
              r.default_weight   = $default_weight
"""

_MERGE_HAS_PROPERTY_SCHEMA_EDGE = """\
MATCH (c:Concept      {id: $concept_id})
MATCH (ps:PropertySchema {id: $schema_id})
MERGE (c)-[:HAS_PROPERTY_SCHEMA]->(ps)
"""

_MERGE_BELONGS_TO_EDGE = """\
MATCH (c:Concept {id: $concept_id})
MATCH (d:Domain  {id: $domain_id})
MERGE (c)-[:BELONGS_TO]->(d)
"""

_MERGE_VALUE_REFERENCES_EDGE = """\
MATCH (pv:PropertyValue {id: $value_id})
MATCH (c:Concept        {id: $concept_id})
MERGE (pv)-[:VALUE_REFERENCES]->(c)
"""

# ---------------------------------------------------------------------------
# Public execution helpers
# ---------------------------------------------------------------------------


def get_existing_concept_ids(session: _Session) -> frozenset[str]:
    """Return the set of all Concept ids currently in the graph.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        A frozenset of concept id strings (empty if the graph has none).
    """
    record = session.run(_GET_ALL_CONCEPT_IDS).single()
    return frozenset(record["ids"] if record else [])


def get_existing_schema_ids(session: _Session) -> frozenset[str]:
    """Return the set of all PropertySchema ids currently in the graph.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        A frozenset of property-schema id strings (empty if none exist).
    """
    record = session.run(_GET_ALL_SCHEMA_IDS).single()
    return frozenset(record["ids"] if record else [])


def create_fulltext_index(session: _Session) -> None:
    """Create (or no-op if already present) the concept full-text search index.

    Args:
        session: An open synchronous Neo4j session.
    """
    session.run(CREATE_CONCEPT_FULLTEXT_INDEX)


def merge_domain_node(session: _Session, domain_key: str) -> None:
    """Upsert a Domain grouping node.

    Args:
        session: An open synchronous Neo4j session.
        domain_key: The domain identifier string (e.g. ``"cadences"``).
    """
    session.run(_MERGE_DOMAIN, id=domain_key, name=domain_key)


def merge_property_value(
    session: _Session,
    pv_id: str,
    name: str,
    aliases: list[str],
    references: str | None,
) -> None:
    """Upsert a PropertyValue node.

    Args:
        session: An open synchronous Neo4j session.
        pv_id: The PropertyValue id.
        name: Human-readable label.
        aliases: Alternative labels (may be empty).
        references: Concept id this value points back to, or ``None``.
    """
    session.run(
        _MERGE_PROPERTY_VALUE,
        id=pv_id,
        name=name,
        aliases=aliases,
        references=references,
    )


def merge_property_schema(session: _Session, schema: PropertySchemaYAML) -> None:
    """Upsert a PropertySchema node and all its HAS_VALUE edges.

    Also upserts each PropertyValue in ``schema.values`` via
    :func:`merge_property_value`.

    Args:
        session: An open synchronous Neo4j session.
        schema: The validated PropertySchemaYAML model.
    """
    session.run(
        _MERGE_PROPERTY_SCHEMA,
        id=schema.id,
        name=schema.name,
        description=schema.description,
        cardinality=schema.cardinality,
        required=schema.required,
    )
    for pv in schema.values:
        merge_property_value(session, pv.id, pv.name, pv.aliases, pv.references)
        session.run(_MERGE_HAS_VALUE_EDGE, schema_id=schema.id, value_id=pv.id)


def merge_concept(session: _Session, concept: ConceptYAML) -> None:
    """Upsert a Concept node.

    Does not write any edges; callers issue edge MERGEs separately so the
    ordering invariant (nodes before edges) is preserved.

    Args:
        session: An open synchronous Neo4j session.
        concept: The validated ConceptYAML model.
    """
    session.run(
        _MERGE_CONCEPT,
        id=concept.id,
        name=concept.name,
        aliases=concept.aliases,
        type=concept.type,
        definition=concept.definition,
        domain=concept.domain,
        complexity=concept.complexity,
        stub=concept.stub,
        top_level_taggable=concept.top_level_taggable,
        capture_extensions=json.dumps(
            [ext.model_dump() for ext in concept.capture_extensions]
        ),
    )


def merge_relationship_edge(
    session: _Session,
    source_id: str,
    rel_type: str,
    target_id: str,
) -> None:
    """Upsert a typed relationship edge between two Concept nodes.

    ``rel_type`` is interpolated directly into the Cypher string.  It **must**
    be a value from ``VALID_EDGE_TYPES`` (enforced by ``RelationshipYAML``'s
    field validator at parse time).

    Args:
        session: An open synchronous Neo4j session.
        source_id: Concept id of the source node.
        rel_type: Edge type constant (e.g. ``"IS_SUBTYPE_OF"``).
        target_id: Concept id of the target node.
    """
    cypher = _MERGE_RELATIONSHIP_EDGE_TEMPLATE.format(rel_type=rel_type)
    session.run(cypher, source_id=source_id, target_id=target_id)


def merge_contains_edge(
    session: _Session,
    source_id: str,
    entry: ContainsEntryYAML,
) -> None:
    """Upsert a CONTAINS edge with all five structural properties.

    Args:
        session: An open synchronous Neo4j session.
        source_id: Concept id of the containing concept.
        entry: The validated ContainsEntryYAML model.
    """
    session.run(
        _MERGE_CONTAINS_EDGE,
        source_id=source_id,
        target_id=entry.target,
        order=entry.order,
        required=entry.required,
        display_mode=entry.display_mode,
        containment_mode=entry.containment_mode,
        default_weight=entry.default_weight,
    )


def merge_has_property_schema_edge(
    session: _Session,
    concept_id: str,
    schema_id: str,
) -> None:
    """Upsert a HAS_PROPERTY_SCHEMA edge from a Concept to a PropertySchema.

    Args:
        session: An open synchronous Neo4j session.
        concept_id: The Concept id.
        schema_id: The PropertySchema id.
    """
    session.run(
        _MERGE_HAS_PROPERTY_SCHEMA_EDGE,
        concept_id=concept_id,
        schema_id=schema_id,
    )


def merge_belongs_to_edge(session: _Session, concept_id: str, domain_id: str) -> None:
    """Upsert a BELONGS_TO edge from a Concept to a Domain node.

    Args:
        session: An open synchronous Neo4j session.
        concept_id: The Concept id.
        domain_id: The Domain id (domain key string).
    """
    session.run(_MERGE_BELONGS_TO_EDGE, concept_id=concept_id, domain_id=domain_id)


def merge_value_references_edge(
    session: _Session,
    value_id: str,
    concept_id: str,
) -> None:
    """Upsert a VALUE_REFERENCES edge from a PropertyValue to a Concept.

    Args:
        session: An open synchronous Neo4j session.
        value_id: The PropertyValue id.
        concept_id: The referenced Concept id.
    """
    session.run(_MERGE_VALUE_REFERENCES_EDGE, value_id=value_id, concept_id=concept_id)
