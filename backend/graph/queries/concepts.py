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
CALL {
  WITH node
  OPTIONAL MATCH (x:Concept)-[:PREREQUISITE_FOR*1..]->(node)
  RETURN count(DISTINCT x) AS prereq_depth
}
WITH node, score,
     CASE node.complexity
       WHEN 'foundational' THEN 0
       WHEN 'intermediate' THEN 1
       WHEN 'advanced'     THEN 2
       ELSE 99
     END AS complexity_rank,
     prereq_depth
ORDER BY complexity_rank ASC, prereq_depth ASC, score DESC, node.name ASC
SKIP $skip LIMIT $limit
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
ORDER BY complexity_rank ASC, prereq_depth ASC, score DESC, node.name ASC
"""
"""Full-text search against the ``concept_search`` index (G5.3 / ADR-020).

Filters to taggable non-stub concepts; sorts by pedagogical complexity band
then prerequisite depth before applying SKIP/LIMIT, so pagination is stable
with respect to the ordering the UI displays.

Sort key: (complexity_rank ASC, prereq_depth ASC, score DESC, name ASC).
  complexity_rank — foundational=0, intermediate=1, advanced=2, unset=99.
  prereq_depth    — count of distinct ancestor concepts that have a
                    PREREQUISITE_FOR path leading to this node; concepts with
                    fewer predecessors (i.e. they are the prerequisites) sort
                    first within their band.

The hierarchy_path subquery picks the longest IS_SUBTYPE_OF path to a root
(defensive — the graph is a tree in Phase 1, but safe for DAG structures).

Parameters:
    q      — Lucene query string (must be non-empty)
    domain — exact domain filter, or ``null`` to search all domains
    skip   — number of results to skip (cursor offset)
    limit  — max number of results to return; pass ``page_size + 1``
             to detect whether a following page exists
"""


# ---------------------------------------------------------------------------
# Schema tree  (async — used by GET /api/v1/concepts/{id}/schemas)
# ---------------------------------------------------------------------------

_CHECK_CONCEPT_EXISTS = """\
MATCH (c:Concept {id: $concept_id})
RETURN c.id AS id
"""

_GET_CONCEPT_PROPERTY_SCHEMAS = """\
MATCH (c:Concept {id: $concept_id})-[:IS_SUBTYPE_OF*0..]->(ancestor:Concept)
      -[r:HAS_PROPERTY_SCHEMA]->(ps:PropertySchema)
WITH DISTINCT ps, r.order AS schema_order, r.group AS schema_group
OPTIONAL MATCH (ps)-[rv:HAS_VALUE]->(pv:PropertyValue)
OPTIONAL MATCH (pv)-[:VALUE_REFERENCES]->(ref:Concept)
WITH ps, schema_order, schema_group, rv, pv, ref
ORDER BY coalesce(rv.order, 9999), pv.name
WITH ps, schema_order, schema_group, collect(
  CASE WHEN pv IS NOT NULL
    THEN {
      id: pv.id,
      name: pv.name,
      order: rv.order,
      referenced_concept_id: ref.id,
      referenced_concept_name: ref.name,
      referenced_concept_definition: ref.definition
    }
    ELSE null
  END
) AS raw_values
RETURN ps.id          AS schema_id,
       ps.name        AS schema_name,
       ps.description AS schema_description,
       ps.cardinality AS cardinality,
       ps.required    AS required,
       schema_order   AS order,
       schema_group   AS group,
       [v IN raw_values WHERE v IS NOT NULL] AS values
ORDER BY
  CASE WHEN schema_group IS NULL THEN 1 ELSE 0 END,
  coalesce(schema_order, 9999),
  ps.name
"""
"""All PropertySchemas applicable to a concept (inherited via IS_SUBTYPE_OF).

For each schema, the values list is hydrated with name and optional
VALUE_REFERENCES concept info (id, name, definition).  BOOL schemas have
an empty values list.

Schemas are sorted by (group, order, name) per ADR-023: schemas with a
non-null group come first, ordered by their declared order within the group;
ungrouped schemas follow, also ordered by their declared order.  Values within
each schema are sorted by their HAS_VALUE edge order (nulls last), then name.
"""

_GET_CONCEPT_CONTAINS_STAGES = """\
MATCH (c:Concept {id: $concept_id})-[:IS_SUBTYPE_OF*0..]->(ancestor:Concept)
      -[r:CONTAINS]->(stage:Concept)
RETURN DISTINCT
       stage.id                                    AS target_id,
       stage.name                                 AS target_name,
       r.order                                    AS order,
       r.required                                 AS required,
       coalesce(r.display_mode, 'stage')          AS display_mode,
       coalesce(r.containment_mode, 'contiguous') AS containment_mode,
       coalesce(r.default_weight, 1.0)            AS default_weight
ORDER BY r.order
"""
"""All CONTAINS stages for a concept, collected from all IS_SUBTYPE_OF ancestors.

Edge properties default to 'stage', 'contiguous', 1.0 when absent, matching
the CONTAINS edge property defaults in edge-vocabulary-reference.md.
"""

_GET_TYPE_REFINEMENT_CHILDREN = """\
MATCH (parent:Concept {id: $concept_id})<-[:IS_SUBTYPE_OF]-(child:Concept)
WHERE child.stub = false
CALL {
  WITH child
  OPTIONAL MATCH (child)-[:IS_SUBTYPE_OF*0..]->(anc:Concept)-[r:CONTAINS]->(s:Concept)
  WITH child, collect(DISTINCT (s.id + '|' + toString(r.order))) AS fingerprint
  RETURN fingerprint
}
RETURN child.id         AS child_id,
       child.name       AS child_name,
       child.definition AS child_definition,
       fingerprint
ORDER BY child.name
"""
"""Direct non-stub IS_SUBTYPE_OF children with their resolved CONTAINS fingerprints.

The fingerprint is a list of '<stage_id>|<order>' strings collected from all
IS_SUBTYPE_OF ancestors of the child.  The service layer compares fingerprints
across siblings to determine whether Type Refinement should be shown.
"""


async def check_concept_exists(
    session: _AsyncSession,
    concept_id: str,
) -> bool:
    """Return True if a Concept node with the given id exists in the graph.

    Args:
        session: An open async Neo4j session.
        concept_id: The concept id to look up.

    Returns:
        ``True`` if the concept exists, ``False`` otherwise.
    """
    result = await session.run(_CHECK_CONCEPT_EXISTS, concept_id=concept_id)
    row = await result.single()
    return row is not None


async def get_concept_property_schemas(
    session: _AsyncSession,
    concept_id: str,
) -> list[dict[str, Any]]:
    """Return all PropertySchemas applicable to a concept, with hydrated values.

    Each dict has keys: ``schema_id``, ``schema_name``, ``schema_description``,
    ``cardinality``, ``required``, ``order``, ``group``, ``values``
    (list of value dicts, empty for BOOL).

    Each value dict has: ``id``, ``name``, ``order``, ``referenced_concept_id``,
    ``referenced_concept_name``, ``referenced_concept_definition`` (last three
    may be ``None`` when the value carries no VALUE_REFERENCES edge).

    Args:
        session: An open async Neo4j session.
        concept_id: The concept id to resolve schemas for.

    Returns:
        List of schema dicts sorted by (grouped-first, order, name) per ADR-023.
    """
    result = await session.run(_GET_CONCEPT_PROPERTY_SCHEMAS, concept_id=concept_id)
    return await result.data()


async def get_concept_contains_stages(
    session: _AsyncSession,
    concept_id: str,
) -> list[dict[str, Any]]:
    """Return all CONTAINS stages for a concept, collected from all ancestors.

    Each dict has: ``target_id``, ``target_name``, ``order``, ``required``,
    ``display_mode``, ``containment_mode``, ``default_weight``.

    Args:
        session: An open async Neo4j session.
        concept_id: The concept id to resolve stages for.

    Returns:
        List of stage dicts ordered by ``order`` ascending.
    """
    result = await session.run(_GET_CONCEPT_CONTAINS_STAGES, concept_id=concept_id)
    return await result.data()


async def get_type_refinement_children(
    session: _AsyncSession,
    concept_id: str,
) -> list[dict[str, Any]]:
    """Return direct non-stub IS_SUBTYPE_OF children with CONTAINS fingerprints.

    Each dict has: ``child_id``, ``child_name``, ``child_definition``,
    ``fingerprint`` (list of ``'<stage_id>|<order>'`` strings).

    Args:
        session: An open async Neo4j session.
        concept_id: The parent concept id.

    Returns:
        List of child dicts ordered alphabetically by name.
    """
    result = await session.run(_GET_TYPE_REFINEMENT_CHILDREN, concept_id=concept_id)
    return await result.data()


# ---------------------------------------------------------------------------
# Harmony capture gate  (async — used by the approval gate in Step 8)
# ---------------------------------------------------------------------------

_CHECK_CONCEPTS_HAVE_HARMONY_GATE = """\
MATCH (c:Concept)-[:IS_SUBTYPE_OF*0..]->(ancestor:Concept)
WHERE c.id IN $concept_ids
  AND ancestor.capture_extensions IS NOT NULL
  AND ancestor.capture_extensions CONTAINS '"harmony_gate"'
RETURN count(*) > 0 AS has_harmony_gate
"""
"""Check whether any concept in the list (or any ancestor) declares a harmony gate.

A concept declares a harmony gate by including an entry with
``type: "harmony_gate"`` in its ``capture_extensions`` JSON string property.
The IS_SUBTYPE_OF*0.. walk ensures that inherited gate declarations are found.

Returns exactly one row: ``{has_harmony_gate: true/false}``.
"""


# ---------------------------------------------------------------------------
# Bulk concept hydration  (async — used by fragment read endpoints, Step 7)
# ---------------------------------------------------------------------------

_GET_CONCEPTS_BY_IDS = """\
UNWIND $concept_ids AS concept_id
MATCH (c:Concept {id: concept_id})
CALL {
  WITH c
  MATCH p = (c)-[:IS_SUBTYPE_OF*0..]->(root:Concept)
  WHERE NOT (root)-[:IS_SUBTYPE_OF]->(:Concept)
  WITH p ORDER BY length(p) DESC LIMIT 1
  RETURN [n IN reverse(nodes(p)) | n.name] AS hierarchy_path
}
RETURN c.id                        AS id,
       c.name                      AS name,
       coalesce(c.aliases, [])     AS aliases,
       hierarchy_path
"""
"""Return name, aliases, and hierarchy path for each concept id in one round-trip.

Uses UNWIND so a single session fetches all requested concepts.  Concepts
not found in the graph are silently omitted from the result set.  The
hierarchy_path subquery picks the longest IS_SUBTYPE_OF path to a root,
matching the pattern used by _SEARCH_CONCEPTS.

Parameters:
    concept_ids — list of concept id strings
"""


async def get_concepts_by_ids(
    session: _AsyncSession,
    concept_ids: list[str],
) -> list[dict[str, Any]]:
    """Return name, aliases, and hierarchy path for each concept id.

    Each dict has keys: ``id``, ``name``, ``aliases`` (list), ``hierarchy_path`` (list).
    Concepts not found in the graph are silently omitted.

    Args:
        session: An open async Neo4j session.
        concept_ids: Concept ids to hydrate; empty list returns ``[]``.

    Returns:
        List of concept dicts, one per found concept.
    """
    if not concept_ids:
        return []
    result = await session.run(_GET_CONCEPTS_BY_IDS, concept_ids=concept_ids)
    return await result.data()


async def check_concepts_have_harmony_gate(
    session: _AsyncSession,
    concept_ids: list[str],
) -> bool:
    """Return True if any concept (or ancestor) in ``concept_ids`` declares a harmony gate.

    A harmony gate declaration means the approval of fragments tagged with that
    concept depends on all ``movement_analysis`` events in the fragment's range
    having ``reviewed: true``.  See ``docs/architecture/capture_extensions.md``.

    Args:
        session: An open async Neo4j session.
        concept_ids: Concept ids to check; may be empty (returns False).

    Returns:
        ``True`` if any concept or its ancestor carries a ``harmony_gate``
        entry in ``capture_extensions``; ``False`` otherwise.
    """
    if not concept_ids:
        return False
    result = await session.run(
        _CHECK_CONCEPTS_HAVE_HARMONY_GATE, concept_ids=concept_ids
    )
    row = await result.single()
    if row is None:
        return False
    return bool(row["has_harmony_gate"])


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

    Results are ordered by ``(complexity_rank, prereq_depth, score DESC,
    name ASC)`` so foundational concepts appear before intermediate and
    advanced ones, and prerequisites appear before their dependents within
    the same band (ADR-020, G5.3).

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
