"""Cypher queries and execution helpers for knowledge-graph validation.

All functions accept a synchronous ``neo4j.Session`` object and return a list
of offending node ids.  An empty list means the check passed.  The calling
script aggregates results and prints a structured pass/fail report.

The nine checks implement the spec in
``docs/roadmap/component-4-knowledge-graph.md`` § Step 8 (six checks from
``phase-1.md`` plus three additional structural checks).

All queries are read-only; this module never writes to the graph.

See ``scripts/validate_graph.py`` for top-level orchestration.
"""

from __future__ import annotations

from neo4j import Session as _Session

# ---------------------------------------------------------------------------
# Check 1 — Isolated concept nodes
# ---------------------------------------------------------------------------

_CONCEPTS_WITH_NO_OUTGOING_EDGES = """\
MATCH (c:Concept)
WHERE NOT (c)-[]->()
RETURN c.id AS id
ORDER BY c.id
"""

# ---------------------------------------------------------------------------
# Check 2 — Dangling IS_SUBTYPE_OF targets
# ---------------------------------------------------------------------------

_DANGLING_IS_SUBTYPE_OF = """\
MATCH (c:Concept)-[:IS_SUBTYPE_OF]->(t)
WHERE NOT t:Concept
RETURN DISTINCT c.id AS id
ORDER BY c.id
"""

# ---------------------------------------------------------------------------
# Check 3 — Dangling CONTAINS targets
# ---------------------------------------------------------------------------

_DANGLING_CONTAINS = """\
MATCH (c:Concept)-[:CONTAINS]->(t)
WHERE NOT t:Concept
RETURN DISTINCT c.id AS id
ORDER BY c.id
"""

# ---------------------------------------------------------------------------
# Check 4 — PropertyValue.references pointing to missing concepts
# ---------------------------------------------------------------------------

_DANGLING_VALUE_REFERENCES = """\
MATCH (pv:PropertyValue)
WHERE pv.references IS NOT NULL
  AND NOT EXISTS { MATCH (:Concept {id: pv.references}) }
RETURN pv.id AS id
ORDER BY pv.id
"""

# ---------------------------------------------------------------------------
# Check 5 — PropertySchemas with no HAS_VALUE edges
# ---------------------------------------------------------------------------

_SCHEMAS_WITHOUT_VALUES = """\
MATCH (ps:PropertySchema)
WHERE NOT (ps)-[:HAS_VALUE]->()
  AND ps.cardinality <> 'BOOL'
RETURN ps.id AS id
ORDER BY ps.id
"""

# ---------------------------------------------------------------------------
# Check 6 — Duplicate CONTAINS order on a single source concept
# ---------------------------------------------------------------------------

_DUPLICATE_CONTAINS_ORDER = """\
MATCH (c:Concept)-[r:CONTAINS]->()
WITH c, r.order AS ord, count(*) AS n
WHERE n > 1
RETURN DISTINCT c.id AS id
ORDER BY c.id
"""

# ---------------------------------------------------------------------------
# Check 7 — Non-stub concepts with empty definition
# ---------------------------------------------------------------------------

_CONCEPTS_MISSING_DEFINITION = """\
MATCH (c:Concept)
WHERE c.stub = false
  AND (c.definition IS NULL OR c.definition = '')
RETURN c.id AS id
ORDER BY c.id
"""

# ---------------------------------------------------------------------------
# Check 8 — Concept ids not matching PascalCase convention
# ---------------------------------------------------------------------------

_CONCEPTS_WITH_NON_PASCAL_IDS = """\
MATCH (c:Concept)
WHERE NOT c.id =~ '^[A-Z][A-Za-z0-9]*$'
RETURN c.id AS id
ORDER BY c.id
"""

# ---------------------------------------------------------------------------
# Check 9 — Duplicate concept ids across nodes
# ---------------------------------------------------------------------------

_DUPLICATE_CONCEPT_IDS = """\
MATCH (c:Concept)
WITH c.id AS id, count(*) AS n
WHERE n > 1
RETURN id
ORDER BY id
"""

# ---------------------------------------------------------------------------
# Check 10 — Directed cycles in PREREQUISITE_FOR edges  (ADR-020 §3)
# ---------------------------------------------------------------------------

_PREREQUISITE_FOR_CYCLES = """\
MATCH path = (c:Concept)-[:PREREQUISITE_FOR*1..]->(c)
RETURN DISTINCT c.id AS id
ORDER BY c.id
"""

# ---------------------------------------------------------------------------
# Informational — stub counts by domain
# ---------------------------------------------------------------------------

_STUB_COUNTS_BY_DOMAIN = """\
MATCH (c:Concept)
WHERE c.stub = true
WITH c.domain AS domain, count(*) AS stubs
RETURN domain, stubs
ORDER BY domain
"""

# ---------------------------------------------------------------------------
# Public execution helpers
# ---------------------------------------------------------------------------


def check_no_isolated_concepts(session: _Session) -> list[str]:
    """Return concept ids with no outgoing edges.

    Every seeded concept must be connected to the graph — at minimum via a
    ``BELONGS_TO`` Domain edge or an ``IS_SUBTYPE_OF`` edge.  An isolated
    node is either a leftover test artefact or a seed script error.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of offending concept ids; empty on pass.
    """
    result = session.run(_CONCEPTS_WITH_NO_OUTGOING_EDGES)
    return [r["id"] for r in result.data()]


def check_is_subtype_of_targets(session: _Session) -> list[str]:
    """Return concept ids whose ``IS_SUBTYPE_OF`` edge points to a non-Concept node.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of offending source concept ids; empty on pass.
    """
    result = session.run(_DANGLING_IS_SUBTYPE_OF)
    return [r["id"] for r in result.data()]


def check_contains_targets(session: _Session) -> list[str]:
    """Return concept ids whose ``CONTAINS`` edge points to a non-Concept node.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of offending source concept ids; empty on pass.
    """
    result = session.run(_DANGLING_CONTAINS)
    return [r["id"] for r in result.data()]


def check_value_references_targets(session: _Session) -> list[str]:
    """Return PropertyValue ids whose ``references`` field names a missing concept.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of offending PropertyValue ids; empty on pass.
    """
    result = session.run(_DANGLING_VALUE_REFERENCES)
    return [r["id"] for r in result.data()]


def check_schemas_have_values(session: _Session) -> list[str]:
    """Return PropertySchema ids with no outgoing ``HAS_VALUE`` edges.

    Every PropertySchema must have at least one allowed value; a schema with
    no values cannot be applied to any concept at tagging time.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of offending PropertySchema ids; empty on pass.
    """
    result = session.run(_SCHEMAS_WITHOUT_VALUES)
    return [r["id"] for r in result.data()]


def check_contains_order_uniqueness(session: _Session) -> list[str]:
    """Return concept ids where two or more ``CONTAINS`` children share an ``order``.

    ``order`` must be unique per source concept because the sub-part tagging
    UI renders children in ``order`` sequence with no tie-breaking rule.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of offending source concept ids; empty on pass.
    """
    result = session.run(_DUPLICATE_CONTAINS_ORDER)
    return [r["id"] for r in result.data()]


def check_concepts_have_definitions(session: _Session) -> list[str]:
    """Return non-stub concept ids with a missing or empty ``definition``.

    Stub nodes (``stub == true``) are exempt because they carry only a
    placeholder definition until the owning domain is seeded.  All fully
    defined concepts must supply prose.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of offending concept ids; empty on pass.
    """
    result = session.run(_CONCEPTS_MISSING_DEFINITION)
    return [r["id"] for r in result.data()]


def check_concept_id_format(session: _Session) -> list[str]:
    """Return concept ids that do not match the PascalCase convention.

    The required pattern is ``^[A-Z][A-Za-z0-9]*$``: starts with an uppercase
    letter, contains only letters and digits (no underscores, hyphens, or
    spaces).  This invariant is enforced here to catch ids that slipped past
    YAML validation (e.g. ids imported from an external source).

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of non-conforming concept ids; empty on pass.
    """
    result = session.run(_CONCEPTS_WITH_NON_PASCAL_IDS)
    return [r["id"] for r in result.data()]


def check_concept_id_uniqueness(session: _Session) -> list[str]:
    """Return concept ids that appear on more than one node.

    ``MERGE`` semantics in the seed script should make duplicates impossible,
    but this check catches any ``CREATE``-instead-of-``MERGE`` regression or
    manual graph edit.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of duplicate ids; empty on pass.
    """
    result = session.run(_DUPLICATE_CONCEPT_IDS)
    return [r["id"] for r in result.data()]


def check_prerequisite_for_acyclicity(session: _Session) -> list[str]:
    """Return concept ids that participate in a directed PREREQUISITE_FOR cycle.

    ADR-020 §3 asserts the PREREQUISITE_FOR relationship is acyclic; a cycle
    would cause prerequisite-chain traversal queries to loop indefinitely.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        List of concept ids involved in a cycle; empty list on pass.
    """
    result = session.run(_PREREQUISITE_FOR_CYCLES)
    return [r["id"] for r in result.data()]


def get_stub_counts_by_domain(session: _Session) -> dict[str, int]:
    """Return a mapping of domain key → stub concept count.

    Stub counts are informational (not errors) and are printed separately by
    the validation script so operators can track adjacent-domain coverage.

    Args:
        session: An open synchronous Neo4j session.

    Returns:
        Dict mapping domain key strings to stub counts.  Empty if no stubs.
    """
    result = session.run(_STUB_COUNTS_BY_DOMAIN)
    return {r["domain"]: r["stubs"] for r in result.data()}
