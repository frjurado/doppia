"""Cypher queries for concept graph traversal.

Used by the concept API layer (Component 5).  Placed here so they can be
tested independently of the HTTP layer.

Synchronous functions accept a ``neo4j.Session`` (used by graph integration
tests and seed scripts).  Async functions accept a ``neo4j.AsyncSession``
(used by FastAPI route handlers via the lifespan ``AsyncDriver``).

See ``docs/roadmap/component-4-knowledge-graph.md`` § Step 14 for the test
spec that pins the expected behaviour of the schema-inheritance query.
"""

from __future__ import annotations

from typing import Any

from neo4j import AsyncSession as _AsyncSession
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


# ---------------------------------------------------------------------------
# Full-text concept search  (async — used by the API layer)
# ---------------------------------------------------------------------------

_SEARCH_CONCEPTS = """\
CALL db.index.fulltext.queryNodes("concept_search", $q)
YIELD node, score
WHERE node.stub = false AND node.top_level_taggable = true
  AND ($domain IS NULL OR node.domain = $domain)
WITH node, score ORDER BY score DESC SKIP $skip LIMIT $limit
CALL {
  WITH node
  MATCH p = (node)-[:IS_SUBTYPE_OF*0..]->(root:Concept)
  WHERE NOT (root)-[:IS_SUBTYPE_OF]->(:Concept)
  WITH p ORDER BY length(p) DESC LIMIT 1
  RETURN [n IN reverse(nodes(p)) | n.name] AS hierarchy_path
}
RETURN node.id                       AS id,
       node.name                     AS name,
       coalesce(node.aliases, [])    AS aliases,
       node.definition               AS definition,
       hierarchy_path,
       score
ORDER BY score DESC
"""
"""Full-text search against the ``concept_search`` index.

Filters to taggable non-stub concepts; computes the IS_SUBTYPE_OF hierarchy
path (root → concept) in a correlated subquery; paginates via SKIP/LIMIT.

The subquery picks the longest path when multiple paths to a root exist
(defensive — the graph is a tree in Phase 1, but safe for DAG structures).

Parameters:
    q      — Lucene query string (must be non-empty)
    domain — exact domain filter, or ``null`` to search all domains
    skip   — number of results to skip (offset)
    limit  — max number of results to return (should be page_size + 1 to
             detect whether a next page exists)
"""


async def search_concepts(
    session: _AsyncSession,
    *,
    q: str,
    domain: str | None,
    skip: int,
    limit: int,
) -> list[dict[str, Any]]:
    """Execute the full-text concept search and return raw result dicts.

    Each dict has keys: ``id``, ``name``, ``aliases``, ``definition``,
    ``hierarchy_path``, ``score``.

    Args:
        session: An open async Neo4j session.
        q: Lucene query string (non-empty).
        domain: Exact domain name to filter by, or ``None`` for all domains.
        skip: Number of leading results to skip (for cursor pagination).
        limit: Maximum number of results to return; pass ``page_size + 1``
            to detect whether a following page exists.

    Returns:
        List of result dicts (may be empty).
    """
    result = await session.run(
        _SEARCH_CONCEPTS,
        q=q,
        domain=domain,
        skip=skip,
        limit=limit,
    )
    return await result.data()
