"""Integration tests: full-text concept search index.

All tests require a Neo4j instance with the cadence domain seeded and the
full-text index created (both happen via ``python scripts/seed.py --all``).

The index is defined as::

    CREATE FULLTEXT INDEX concept_search IF NOT EXISTS
    FOR (c:Concept) ON EACH [c.name, c.aliases]

See ``docs/roadmap/component-4-knowledge-graph.md`` § Steps 12 and 14.
"""

from __future__ import annotations

import pytest
from neo4j import Driver

pytestmark = pytest.mark.integration

_FULLTEXT_QUERY = """\
CALL db.index.fulltext.queryNodes("concept_search", $query)
YIELD node
RETURN node.id AS id
"""


def _search(driver: Driver, query: str) -> list[str]:
    """Run a full-text search and return the matching concept ids."""
    with driver.session() as session:
        result = session.run(_FULLTEXT_QUERY, {"query": query})
        return [r["id"] for r in result.data()]


def test_search_by_name_returns_pac(neo4j_driver: Driver) -> None:
    """Searching 'perfect authentic' returns PerfectAuthenticCadence."""
    ids = _search(neo4j_driver, "perfect authentic")
    assert "PerfectAuthenticCadence" in ids


def test_search_by_partial_name_returns_half_cadence(neo4j_driver: Driver) -> None:
    """Searching 'half cadence' returns both HalfCadence and HalfCadenceRealised."""
    ids = _search(neo4j_driver, "half cadence")
    assert "HalfCadence" in ids
    assert "HalfCadenceRealised" in ids


def test_search_by_alias_returns_pac(neo4j_driver: Driver) -> None:
    """Searching the alias 'PAC' returns PerfectAuthenticCadence.

    Verifies that the full-text index correctly indexes list-property elements
    (Neo4j 5 indexes each element of a string-list property individually).
    """
    ids = _search(neo4j_driver, "PAC")
    assert "PerfectAuthenticCadence" in ids


def test_search_by_alias_returns_hc(neo4j_driver: Driver) -> None:
    """Searching the alias 'HC' returns HalfCadenceRealised."""
    ids = _search(neo4j_driver, "HC")
    assert "HalfCadenceRealised" in ids


def test_search_nonsense_returns_empty(neo4j_driver: Driver) -> None:
    """Searching a term absent from the graph returns no results."""
    ids = _search(neo4j_driver, "xyzzyfoobarbaz")
    assert ids == []
