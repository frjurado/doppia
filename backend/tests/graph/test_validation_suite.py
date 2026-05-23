"""Integration tests: validation suite against the seeded cadence domain.

All tests require a Neo4j instance with the full cadence domain seeded
(``python scripts/seed.py --all``).  Tests that deliberately break the graph
restore the original state in ``try/finally`` blocks so they do not affect
other tests.

Test naming convention:
- ``test_all_ten_checks_pass`` — clean-graph assertion; must run on an
  unmodified seeded graph.
- ``test_checkN_catches_*`` — deliberate-breakage tests that inject a
  violation, assert the corresponding check flags it, then clean up.

See ``docs/roadmap/component-4-knowledge-graph.md`` § Step 14 for the spec.
"""

from __future__ import annotations

import pytest
from neo4j import Driver

from backend.graph.queries.validation import (
    check_concept_id_format,
    check_concept_id_uniqueness,
    check_concepts_have_definitions,
    check_contains_order_uniqueness,
    check_contains_targets,
    check_is_subtype_of_targets,
    check_no_isolated_concepts,
    check_prerequisite_for_acyclicity,
    check_schemas_have_values,
    check_value_references_targets,
)

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# Clean-graph assertion
# ---------------------------------------------------------------------------


def test_all_ten_checks_pass(neo4j_driver: Driver) -> None:
    """All ten validation checks pass against the seeded cadence domain.

    This test fails if the seed output is structurally inconsistent or if a
    prior deliberate-breakage test failed to clean up after itself.
    """
    with neo4j_driver.session() as session:
        assert (
            check_no_isolated_concepts(session) == []
        ), "Check 1 failed: isolated concepts"
        assert (
            check_is_subtype_of_targets(session) == []
        ), "Check 2 failed: dangling IS_SUBTYPE_OF"
        assert (
            check_contains_targets(session) == []
        ), "Check 3 failed: dangling CONTAINS"
        assert (
            check_value_references_targets(session) == []
        ), "Check 4 failed: dangling VALUE_REFERENCES"
        assert (
            check_schemas_have_values(session) == []
        ), "Check 5 failed: schemas without values"
        assert (
            check_contains_order_uniqueness(session) == []
        ), "Check 6 failed: duplicate CONTAINS order"
        assert (
            check_concepts_have_definitions(session) == []
        ), "Check 7 failed: missing definitions"
        assert (
            check_concept_id_format(session) == []
        ), "Check 8 failed: non-PascalCase ids"
        assert (
            check_concept_id_uniqueness(session) == []
        ), "Check 9 failed: duplicate ids"
        assert (
            check_prerequisite_for_acyclicity(session) == []
        ), "Check 10 failed: PREREQUISITE_FOR cycle"


# ---------------------------------------------------------------------------
# Deliberate-breakage tests
# ---------------------------------------------------------------------------


def test_check5_catches_schema_without_value(neo4j_driver: Driver) -> None:
    """Check 5 flags a ONE_OF PropertySchema that has no HAS_VALUE edges.

    BOOL schemas are legitimately valueless (ADR-019); the check exempts them.
    This test uses a ONE_OF schema to confirm the non-exempt path.
    """
    with neo4j_driver.session() as session:
        session.run(
            "CREATE (ps:PropertySchema {"
            "  id: '_TVSchema', name: 'TV Schema',"
            "  description: 'test-only schema',"
            "  cardinality: 'ONE_OF', required: false"
            "})"
        )
    try:
        with neo4j_driver.session() as session:
            offenders = check_schemas_have_values(session)
        assert "_TVSchema" in offenders
    finally:
        with neo4j_driver.session() as session:
            session.run("MATCH (ps:PropertySchema {id: '_TVSchema'}) DETACH DELETE ps")


def test_check6_catches_duplicate_contains_order(neo4j_driver: Driver) -> None:
    """Check 6 flags a concept whose two CONTAINS children share the same order value."""
    with neo4j_driver.session() as session:
        session.run(
            "CREATE (p:Concept {id: '_TVParent', name: 'TV Parent',"
            "  domain: '_tv', stub: false, definition: 'test',"
            "  top_level_taggable: false, aliases: [], capture_extensions: '[]'}),"
            "       (c1:Concept {id: '_TVChild1', name: 'TV Child 1',"
            "  domain: '_tv', stub: false, definition: 'test',"
            "  top_level_taggable: false, aliases: [], capture_extensions: '[]'}),"
            "       (c2:Concept {id: '_TVChild2', name: 'TV Child 2',"
            "  domain: '_tv', stub: false, definition: 'test',"
            "  top_level_taggable: false, aliases: [], capture_extensions: '[]'})"
        )
        # Both CONTAINS edges carry order=1 — the duplicate that check 6 catches
        session.run(
            "MATCH (p:Concept {id: '_TVParent'}),"
            "      (c1:Concept {id: '_TVChild1'}),"
            "      (c2:Concept {id: '_TVChild2'}) "
            "CREATE (p)-[:CONTAINS {order: 1, required: false,"
            "  display_mode: 'stage', containment_mode: 'contiguous',"
            "  default_weight: 1.0}]->(c1),"
            "       (p)-[:CONTAINS {order: 1, required: false,"
            "  display_mode: 'stage', containment_mode: 'contiguous',"
            "  default_weight: 1.0}]->(c2)"
        )
    try:
        with neo4j_driver.session() as session:
            offenders = check_contains_order_uniqueness(session)
        assert "_TVParent" in offenders
    finally:
        with neo4j_driver.session() as session:
            session.run(
                "MATCH (n) WHERE n.id IN ['_TVParent', '_TVChild1', '_TVChild2'] "
                "DETACH DELETE n"
            )


def test_check2_catches_dangling_is_subtype_of(neo4j_driver: Driver) -> None:
    """Check 2 flags a concept whose IS_SUBTYPE_OF edge points to a non-Concept node."""
    with neo4j_driver.session() as session:
        session.run(
            "CREATE (c:Concept {id: '_TVDanglingSource', name: 'TV Dangling',"
            "  domain: '_tv', stub: false, definition: 'test',"
            "  top_level_taggable: false, aliases: [], capture_extensions: '[]'}),"
            "       (t:_TVDomain {id: '_TVNonConceptTarget', name: 'TV Non-Concept'})"
        )
        session.run(
            "MATCH (c:Concept {id: '_TVDanglingSource'}),"
            "      (t:_TVDomain {id: '_TVNonConceptTarget'}) "
            "CREATE (c)-[:IS_SUBTYPE_OF]->(t)"
        )
    try:
        with neo4j_driver.session() as session:
            offenders = check_is_subtype_of_targets(session)
        assert "_TVDanglingSource" in offenders
    finally:
        with neo4j_driver.session() as session:
            session.run(
                "MATCH (n) WHERE n.id IN ['_TVDanglingSource', '_TVNonConceptTarget'] "
                "DETACH DELETE n"
            )
