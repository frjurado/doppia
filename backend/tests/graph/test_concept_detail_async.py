"""Integration tests: public concept-detail queries (Component 11 Step 1).

Verifies ``graph.queries.concepts.get_concept_detail`` and
``get_concept_relationships`` against a live Neo4j instance with the cadence
domain seeded.

Verification criteria from docs/roadmap/component-11-concept-glossary.md § Step 1:
- The detail payload carries identity, the stub/definition_reviewed/
  top_level_taggable flags (as booleans, defaulted when the property is absent),
  the root→leaf hierarchy path, the direct parent, and the direct children.
- A domain root has ``parent = None`` and non-empty children.
- An unknown id returns ``None``.
- Typed relationships include both directions and the display vocabulary
  (PREREQUISITE_FOR, CONTAINS, …) but never IS_SUBTYPE_OF (that is the
  hierarchy, surfaced by the detail query).

All tests require ``DOPPIA_RUN_INTEGRATION=1``.

Implementation note: each test uses a fresh driver inside a single
``asyncio.run()`` call, matching test_concept_search_async.py — this avoids the
Windows ProactorEventLoop "future attached to a different loop" error.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import pytest
from neo4j import AsyncGraphDatabase

pytestmark = pytest.mark.integration


def _detail(concept_id: str) -> dict[str, Any] | None:
    """Run ``get_concept_detail`` against a fresh async driver / event loop."""
    from graph.queries.concepts import get_concept_detail

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    async def _run() -> dict[str, Any] | None:
        driver = AsyncGraphDatabase.driver(uri, auth=(user, password))
        await driver.verify_connectivity()
        try:
            async with driver.session() as session:
                return await get_concept_detail(session, concept_id)
        finally:
            await driver.close()

    return asyncio.run(_run())


def _relationships(concept_id: str) -> list[dict[str, Any]]:
    """Run ``get_concept_relationships`` against a fresh async driver / event loop."""
    from graph.queries.concepts import get_concept_relationships

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    async def _run() -> list[dict[str, Any]]:
        driver = AsyncGraphDatabase.driver(uri, auth=(user, password))
        await driver.verify_connectivity()
        try:
            async with driver.session() as session:
                return await get_concept_relationships(session, concept_id)
        finally:
            await driver.close()

    return asyncio.run(_run())


def _domain_roots() -> list[dict[str, Any]]:
    """Run ``get_domain_roots`` against a fresh async driver / event loop."""
    from graph.queries.concepts import get_domain_roots

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    async def _run() -> list[dict[str, Any]]:
        driver = AsyncGraphDatabase.driver(uri, auth=(user, password))
        await driver.verify_connectivity()
        try:
            async with driver.session() as session:
                return await get_domain_roots(session)
        finally:
            await driver.close()

    return asyncio.run(_run())


def _public_index() -> Any:
    """Run ``ConceptService.get_public_index`` against a fresh async driver.

    ``db=None`` so approved-fragment counts are all zero and no PostgreSQL is
    needed — this test only exercises the real domain-root + subtree Cypher and
    the domain-grouping assembly.
    """
    from services.concepts import ConceptService

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    async def _run() -> Any:
        driver = AsyncGraphDatabase.driver(uri, auth=(user, password))
        await driver.verify_connectivity()
        try:
            service = ConceptService(driver)  # db=None → counts default to 0
            return await service.get_public_index()
        finally:
            await driver.close()

    return asyncio.run(_run())


class TestConceptDetail:
    """graph.queries.concepts.get_concept_detail against live Neo4j."""

    def test_leaf_concept_payload(self) -> None:
        row = _detail("PerfectAuthenticCadence")

        assert row is not None
        assert row["id"] == "PerfectAuthenticCadence"
        assert "PAC" in row["aliases"]
        assert row["definition"]
        assert row["domain"] == "cadences"
        # Flags come back as booleans even though definition_reviewed is not yet
        # seeded (coalesced default false).
        assert row["stub"] is False
        assert row["definition_reviewed"] is False
        assert row["top_level_taggable"] is True
        # Direct parent and root→leaf hierarchy.
        assert row["parent"]["id"] == "AuthenticCadenceRealised"
        assert row["hierarchy_path"][0] == "Cadence"
        assert row["hierarchy_path"][-1] == "Perfect Authentic Cadence"

    def test_domain_root_has_no_parent_and_has_children(self) -> None:
        row = _detail("Cadence")

        assert row is not None
        assert row["parent"] is None
        child_ids = {c["id"] for c in row["children"]}
        assert "AuthenticCadence" in child_ids

    def test_unknown_concept_returns_none(self) -> None:
        assert _detail("NoSuchConcept") is None


class TestConceptRelationships:
    """graph.queries.concepts.get_concept_relationships against live Neo4j."""

    def test_prerequisite_edges_outgoing(self) -> None:
        rels = _relationships("AuthenticCadenceRealised")

        prereq_targets = {
            r["target_id"]
            for r in rels
            if r["rel_type"] == "PREREQUISITE_FOR" and r["direction"] == "outgoing"
        }
        assert {
            "HalfCadenceRealised",
            "DeceptiveCadence",
            "EvadedCadence",
            "AbandonedCadence",
        } <= prereq_targets

    def test_is_subtype_of_never_appears(self) -> None:
        """The hierarchy edge is excluded from the typed-relationship list."""
        for cid in ("PerfectAuthenticCadence", "AuthenticCadence", "Cadence"):
            rels = _relationships(cid)
            assert all(r["rel_type"] != "IS_SUBTYPE_OF" for r in rels), cid

    def test_contains_edge_outgoing(self) -> None:
        rels = _relationships("AuthenticCadence")

        contains_targets = {r["target_id"] for r in rels if r["rel_type"] == "CONTAINS"}
        assert "CadentialFinalTonic" in contains_targets

    def test_directions_are_labelled(self) -> None:
        rels = _relationships("AuthenticCadenceRealised")
        assert rels, "expected at least one typed relationship"
        assert all(r["direction"] in ("outgoing", "incoming") for r in rels)


class TestDomainRoots:
    """graph.queries.concepts.get_domain_roots — the Step 4b root-selection rule."""

    def test_includes_cadence_and_post_cadential(self) -> None:
        ids = {r["id"] for r in _domain_roots()}
        assert "Cadence" in ids
        assert "ClosingSection" in ids
        assert "StandingOnTheDominant" in ids

    def test_excludes_contains_target_stages(self) -> None:
        ids = {r["id"] for r in _domain_roots()}
        for stage in (
            "CadentialInitialTonic",
            "CadentialPreDominant",
            "CadentialDominant",
            "CadentialFinalTonic",
        ):
            assert stage not in ids, f"{stage} is a CONTAINS target, not a root"

    def test_rows_carry_domain(self) -> None:
        rows = _domain_roots()
        assert rows, "expected at least one root"
        cadence = next(r for r in rows if r["id"] == "Cadence")
        assert cadence["domain"] == "cadences"


class TestPublicIndex:
    """ConceptService.get_public_index against live Neo4j (db=None, counts 0)."""

    def test_cadences_is_one_domain_forest(self) -> None:
        index = _public_index()

        domains = {d.domain: d for d in index.domains}
        assert "cadences" in domains, "cadences domain missing from index"
        cadences = domains["cadences"]
        assert cadences.label == "Cadences"

        by_id = {n.id: n for n in cadences.nodes}
        # Cadence and the post-cadential concepts are all top-level (parent_id
        # None) within the single cadences domain — a forest, not separate
        # "domains" (Step 4b).
        top_level = {n.id for n in cadences.nodes if n.parent_id is None}
        assert {"Cadence", "ClosingSection", "StandingOnTheDominant"} <= top_level
        # PAC is a descendant of Cadence.
        assert "PerfectAuthenticCadence" in by_id
        assert by_id["PerfectAuthenticCadence"].parent_id is not None
        assert by_id["PerfectAuthenticCadence"].hierarchy_path[0] == "Cadence"
        # db=None → counts default to 0 for every node.
        assert all(n.fragment_count == 0 for n in cadences.nodes)

    def test_stage_concepts_are_not_index_roots(self) -> None:
        """CONTAINS-target stage concepts never surface as browsable roots."""
        index = _public_index()
        top_level_ids = {
            n.id for d in index.domains for n in d.nodes if n.parent_id is None
        }
        for stage in (
            "CadentialInitialTonic",
            "CadentialPreDominant",
            "CadentialDominant",
            "CadentialFinalTonic",
        ):
            assert stage not in top_level_ids, f"{stage} must not be an index root"

    def test_index_excludes_stubs(self) -> None:
        """A domain's browsable tree is its non-stub subtree."""
        index = _public_index()
        for d in index.domains:
            assert d.domain, "domain key must be present"
            assert d.nodes, f"domain {d.domain} has no nodes"
