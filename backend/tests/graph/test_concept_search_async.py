"""Integration tests: async concept search query (Step 3, Component 5).

Verifies ``graph.queries.concepts.search_concepts`` against a live Neo4j
instance with the cadence domain seeded and the ``concept_search`` full-text
index in place.

Verification criteria from docs/roadmap/component-5-tagging-tool.md § Step 3:
- ``perfect authentic`` returns PAC ranked first.
- A stub or ``top_level_taggable=false`` concept never appears.
- ``domain=cadences`` narrows correctly (cross-domain query returns more hits).

All tests require ``DOPPIA_RUN_INTEGRATION=1``.

Implementation note: each test calls ``asyncio.run()`` with a fresh driver
rather than sharing a session-scoped async driver fixture.  This avoids the
Windows ProactorEventLoop "future attached to a different loop" error that
arises when an ``AsyncDriver``'s internal socket futures are created in one
event-loop context and consumed in another.
"""

from __future__ import annotations

import asyncio
import os

import pytest
from neo4j import AsyncGraphDatabase

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Helper: run one async search against a fresh driver / event loop
# ---------------------------------------------------------------------------


def _search(
    q: str,
    *,
    domain: str | None = None,
    skip: int = 0,
    limit: int = 25,
) -> list[dict]:
    """Synchronous wrapper that spins up a fresh async driver, runs the query,
    and tears it down — all within a single ``asyncio.run()`` call."""
    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    from graph.queries.concepts import search_concepts

    async def _run() -> list[dict]:
        driver = AsyncGraphDatabase.driver(uri, auth=(user, password))
        await driver.verify_connectivity()
        try:
            async with driver.session() as session:
                return await search_concepts(
                    session, q=q, domain=domain, skip=skip, limit=limit
                )
        finally:
            await driver.close()

    return asyncio.run(_run())


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestSearchConceptsAsync:
    """Direct tests of the async Cypher query function against live Neo4j."""

    def test_pac_ranked_first_for_perfect_authentic(self) -> None:
        """Searching 'perfect authentic' returns PAC as the first result."""
        results = _search("perfect authentic")

        assert results, "Expected at least one result"
        assert results[0]["id"] == "PerfectAuthenticCadence"

    def test_pac_found_by_alias(self) -> None:
        """Searching the alias 'PAC' returns PerfectAuthenticCadence."""
        results = _search("PAC")

        ids = [r["id"] for r in results]
        assert "PerfectAuthenticCadence" in ids

    def test_no_non_taggable_concepts_returned(self) -> None:
        """Abstract roots with ``top_level_taggable=false`` are excluded."""
        results = _search("cadence", limit=50)

        assert results, "Expected hits for 'cadence'"
        ids = [r["id"] for r in results]
        assert (
            "Cadence" not in ids
        ), "Abstract root 'Cadence' has top_level_taggable=false and must be excluded"
        assert (
            "AuthenticCadence" not in ids
        ), "'AuthenticCadence' has top_level_taggable=false and must be excluded"

    def test_domain_filter_narrows_results(self) -> None:
        """``domain=cadences`` returns only cadence-domain concepts."""
        results_cadences = _search("cadence", domain="cadences", limit=50)

        assert results_cadences, "Expected hits when filtering to cadences domain"
        for r in results_cadences:
            assert r["hierarchy_path"], f"Missing hierarchy_path for {r['id']}"
            assert r["hierarchy_path"][0] == "Cadence", (
                f"{r['id']} hierarchy root is {r['hierarchy_path'][0]!r}, "
                "expected 'Cadence'"
            )

    def test_hierarchy_path_root_to_leaf(self) -> None:
        """PAC's hierarchy_path runs from root to concept (inclusive)."""
        results = _search("perfect authentic cadence")

        pac = next((r for r in results if r["id"] == "PerfectAuthenticCadence"), None)
        assert pac is not None, "PerfectAuthenticCadence not found"

        path = pac["hierarchy_path"]
        assert path[-1] == "Perfect Authentic Cadence"
        assert "Cadence" in path
        assert path.index("Cadence") < path.index("Perfect Authentic Cadence")

    def test_aliases_included(self) -> None:
        """PAC's aliases list includes 'PAC'."""
        results = _search("perfect authentic")

        pac = next((r for r in results if r["id"] == "PerfectAuthenticCadence"), None)
        assert pac is not None
        assert "PAC" in pac["aliases"]

    def test_nonsense_query_returns_empty(self) -> None:
        """A query matching nothing returns an empty list, not an error."""
        results = _search("xyzzyfoobarbaz")

        assert results == []

    def test_pagination_skip_advances_page(self) -> None:
        """SKIP advances the result window: page 2 does not overlap page 1."""
        page1 = _search("cadence", skip=0, limit=3)
        page2 = _search("cadence", skip=3, limit=3)

        if not page1 or not page2:
            pytest.skip("Not enough results to test pagination")

        ids_page1 = {r["id"] for r in page1}
        ids_page2 = {r["id"] for r in page2}
        assert ids_page1.isdisjoint(
            ids_page2
        ), f"Pages must not overlap: page1={ids_page1}, page2={ids_page2}"
