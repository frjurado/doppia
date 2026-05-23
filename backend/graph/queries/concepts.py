"""Cypher queries for concept graph traversal.

Used by the concept API layer (Component 5).  Placed here so they can be
tested independently of the HTTP layer.

All functions accept a synchronous ``neo4j.Session`` object.

See ``docs/roadmap/component-4-knowledge-graph.md`` § Step 14 for the test
spec that pins the expected behaviour of the schema-inheritance query.
"""

from __future__ import annotations

from neo4j import Session as _Session

# ---------------------------------------------------------------------------
# Schema inheritance
# ---------------------------------------------------------------------------

_GET_INHERITED_SCHEMAS = """\
MATCH (c:Concept {id: $concept_id})-[:IS_SUBTYPE_OF*0..]->(ancestor)
      -[:HAS_PROPERTY_SCHEMA]->(ps:PropertySchema)
RETURN DISTINCT ps.id AS schema_id
ORDER BY ps.id
"""
"""Resolve all PropertySchemas applicable to a concept.

Walks IS_SUBTYPE_OF edges upward zero or more hops, collecting every
HAS_PROPERTY_SCHEMA edge found along the way.  DISTINCT ensures each
schema id appears once even if multiple ancestors declare the same schema
(which should not happen, but is defensive).

The zero-hop case (``*0..``) means the concept itself is included as an
ancestor, so its own HAS_PROPERTY_SCHEMA edges are always returned.

This is the query ``GET /api/v1/concepts/{id}/schemas`` will execute in
Component 5.
"""


def get_inherited_schema_ids(session: _Session, concept_id: str) -> list[str]:
    """Return all PropertySchema ids applicable to a concept, including inherited.

    Schemas are inherited transitively via ``IS_SUBTYPE_OF``: if a concept's
    parent has a ``HAS_PROPERTY_SCHEMA`` edge, the concept inherits it without
    needing its own explicit edge in the YAML.

    Args:
        session: An open synchronous Neo4j session.
        concept_id: The concept id to resolve (e.g. ``"PerfectAuthenticCadence"``).

    Returns:
        Alphabetically sorted list of PropertySchema ids; empty if the concept
        has no schemas and no ancestors with schemas.
    """
    result = session.run(_GET_INHERITED_SCHEMAS, concept_id=concept_id)
    return [r["schema_id"] for r in result.data()]
