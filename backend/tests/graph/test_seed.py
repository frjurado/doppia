"""Integration tests for the knowledge-graph seeding layer.

Requires a running Neo4j instance (``docker compose up neo4j``).  All tests
are marked ``integration`` and are skipped unless
``DOPPIA_RUN_INTEGRATION=1`` is set.

Every test uses the unique id prefix ``_TestSeed`` to avoid colliding with
real domain data, and cleans up its nodes in a ``finally`` block so subsequent
runs start from a known state.

See ``docs/roadmap/component-4-knowledge-graph.md`` § Step 7 for the spec that
these tests verify.
"""

from __future__ import annotations

import pytest
from neo4j import Driver

from backend.graph.queries.seed import (
    create_fulltext_index,
    get_existing_concept_ids,
    merge_domain_node,
    merge_property_schema,
)
from backend.graph.queries.validation import (
    check_prerequisite_for_acyclicity,
    check_schemas_have_values,
)
from backend.seed.schemas import (
    CaptureExtensionYAML,
    ConceptYAML,
    ContainsEntryYAML,
    DomainYAML,
    PropertySchemaYAML,
    PropertyValueYAML,
    RelationshipYAML,
)

pytestmark = pytest.mark.integration

# ---------------------------------------------------------------------------
# Synthetic test fixtures
# ---------------------------------------------------------------------------
# All ids start with "_TestSeed" so they never clash with real domain data
# and are trivially cleaned up with a prefix match.

_DOMAIN_KEY = "_test_seed_domain"

_SCHEMA = PropertySchemaYAML(
    id="_TestSeedSchema",
    name="Test Schema",
    description="A schema used only in seed integration tests.",
    cardinality="ONE_OF",
    values=[
        PropertyValueYAML(id="_TestSeedValueA", name="Value A"),
        PropertyValueYAML(
            id="_TestSeedValueB",
            name="Value B",
            references="_TestSeedConceptChild",
        ),
    ],
)

_DOMAIN = DomainYAML(
    domain=_DOMAIN_KEY,
    concepts=[
        ConceptYAML(
            id="_TestSeedConceptParent",
            name="Test Seed Parent",
            definition="A parent concept used only in seed integration tests.",
            domain=_DOMAIN_KEY,
            type="CadenceType",
        ),
        ConceptYAML(
            id="_TestSeedConceptChild",
            name="Test Seed Child",
            definition="A child concept used only in seed integration tests.",
            domain=_DOMAIN_KEY,
            type="CadenceType",
            relationships=[
                RelationshipYAML(type="IS_SUBTYPE_OF", target="_TestSeedConceptParent"),
            ],
            contains=[
                ContainsEntryYAML(
                    target="_TestSeedConceptParent",
                    order=1,
                    required=True,
                    display_mode="stage",
                    containment_mode="contiguous",
                    default_weight=1.0,
                ),
            ],
            property_schemas=["_TestSeedSchema"],
        ),
    ],
    property_schemas=[_SCHEMA],
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _cleanup(driver: Driver) -> None:
    """Remove all test nodes inserted by these tests."""
    with driver.session() as session:
        session.run("MATCH (n) WHERE n.id STARTS WITH '_TestSeed' DETACH DELETE n")
        session.run(
            "MATCH (d:Domain {id: $id}) DETACH DELETE d",
            id=_DOMAIN_KEY,
        )


def _seed_full_domain(driver: Driver) -> None:
    """Seed the synthetic test domain using the execution helpers."""
    from scripts.seed import SeedStats, _seed_domain  # noqa: PLC0415

    with driver.session() as session:
        create_fulltext_index(session)
        merge_domain_node(session, _DOMAIN_KEY)
        for schema in _DOMAIN.property_schemas:
            merge_property_schema(session, schema)
        existing = get_existing_concept_ids(session)
        _seed_domain(session, _DOMAIN, existing, SeedStats())


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


def test_seed_creates_concept_nodes(neo4j_driver: Driver) -> None:
    """Seeding the test domain creates the expected Concept nodes."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            result = session.run(
                "MATCH (c:Concept) WHERE c.id STARTS WITH '_TestSeed' "
                "RETURN c.id AS id, c.stub AS stub ORDER BY c.id"
            )
            records = result.data()

        ids = [r["id"] for r in records]
        assert "_TestSeedConceptChild" in ids
        assert "_TestSeedConceptParent" in ids
        # All test concepts are non-stubs
        for r in records:
            assert r["stub"] is False
    finally:
        _cleanup(neo4j_driver)


def test_seed_creates_property_schema_and_values(neo4j_driver: Driver) -> None:
    """Seeding creates PropertySchema and PropertyValue nodes with HAS_VALUE edges."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            result = session.run(
                "MATCH (ps:PropertySchema {id: '_TestSeedSchema'})-[:HAS_VALUE]->(pv) "
                "RETURN pv.id AS value_id ORDER BY pv.id"
            )
            value_ids = [r["value_id"] for r in result.data()]

        assert "_TestSeedValueA" in value_ids
        assert "_TestSeedValueB" in value_ids
    finally:
        _cleanup(neo4j_driver)


def test_seed_creates_is_subtype_of_edge(neo4j_driver: Driver) -> None:
    """A RelationshipYAML entry creates the correct typed edge in Neo4j."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            result = session.run(
                "MATCH (child:Concept {id: '_TestSeedConceptChild'})"
                "-[:IS_SUBTYPE_OF]->"
                "(parent:Concept {id: '_TestSeedConceptParent'}) "
                "RETURN count(*) AS n"
            )
            count = result.single()["n"]

        assert count == 1
    finally:
        _cleanup(neo4j_driver)


def test_seed_creates_contains_edge_with_properties(neo4j_driver: Driver) -> None:
    """A ContainsEntryYAML creates a CONTAINS edge with all five edge properties."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            result = session.run(
                "MATCH (child:Concept {id: '_TestSeedConceptChild'})"
                "-[r:CONTAINS]->"
                "(parent:Concept {id: '_TestSeedConceptParent'}) "
                "RETURN r.order AS order, r.required AS required, "
                "r.display_mode AS display_mode, "
                "r.containment_mode AS containment_mode, "
                "r.default_weight AS default_weight"
            )
            record = result.single()

        assert record is not None
        assert record["order"] == 1
        assert record["required"] is True
        assert record["display_mode"] == "stage"
        assert record["containment_mode"] == "contiguous"
        assert record["default_weight"] == pytest.approx(1.0)
    finally:
        _cleanup(neo4j_driver)


def test_seed_creates_has_property_schema_edge(neo4j_driver: Driver) -> None:
    """A concept with property_schemas gets HAS_PROPERTY_SCHEMA edges."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            result = session.run(
                "MATCH (c:Concept {id: '_TestSeedConceptChild'})"
                "-[:HAS_PROPERTY_SCHEMA]->"
                "(ps:PropertySchema {id: '_TestSeedSchema'}) "
                "RETURN count(*) AS n"
            )
            count = result.single()["n"]

        assert count == 1
    finally:
        _cleanup(neo4j_driver)


def test_seed_creates_value_references_edge(neo4j_driver: Driver) -> None:
    """A PropertyValue with a references field gets a VALUE_REFERENCES edge."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            result = session.run(
                "MATCH (pv:PropertyValue {id: '_TestSeedValueB'})"
                "-[:VALUE_REFERENCES]->"
                "(c:Concept {id: '_TestSeedConceptChild'}) "
                "RETURN count(*) AS n"
            )
            count = result.single()["n"]

        assert count == 1
    finally:
        _cleanup(neo4j_driver)


def test_seed_is_idempotent(neo4j_driver: Driver) -> None:
    """Seeding the same domain twice leaves identical node and edge counts."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            r1 = session.run(
                "MATCH (n) WHERE n.id STARTS WITH '_TestSeed' RETURN count(n) AS n"
            ).single()["n"]
            e1 = session.run(
                "MATCH (n)-[r]->(m) "
                "WHERE n.id STARTS WITH '_TestSeed' OR m.id STARTS WITH '_TestSeed' "
                "RETURN count(r) AS n"
            ).single()["n"]

        # Second seed — must not create duplicates
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            r2 = session.run(
                "MATCH (n) WHERE n.id STARTS WITH '_TestSeed' RETURN count(n) AS n"
            ).single()["n"]
            e2 = session.run(
                "MATCH (n)-[r]->(m) "
                "WHERE n.id STARTS WITH '_TestSeed' OR m.id STARTS WITH '_TestSeed' "
                "RETURN count(r) AS n"
            ).single()["n"]

        assert r1 == r2, f"Node count changed after re-seed: {r1} → {r2}"
        assert e1 == e2, f"Edge count changed after re-seed: {e1} → {e2}"
    finally:
        _cleanup(neo4j_driver)


def test_get_existing_concept_ids_returns_seeded_ids(neo4j_driver: Driver) -> None:
    """get_existing_concept_ids includes newly seeded concepts."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            ids = get_existing_concept_ids(session)

        assert "_TestSeedConceptParent" in ids
        assert "_TestSeedConceptChild" in ids
    finally:
        _cleanup(neo4j_driver)


def test_bool_schema_not_flagged_by_check_schemas_have_values(
    neo4j_driver: Driver,
) -> None:
    """A BOOL PropertySchema with no HAS_VALUE edges must not trigger check 5.

    ADR-019: BOOL schemas legitimately carry no values; the validation query
    now excludes ``cardinality = 'BOOL'`` from the check.
    """
    bool_schema = PropertySchemaYAML(
        id="_TestSeedBoolSchema",
        name="Test Bool Schema",
        description="A BOOL schema used only in seed integration tests.",
        cardinality="BOOL",
    )
    bool_domain = DomainYAML(
        domain=_DOMAIN_KEY,
        concepts=[
            ConceptYAML(
                id="_TestSeedBoolConcept",
                name="Test Bool Concept",
                definition="Concept using a BOOL schema.",
                domain=_DOMAIN_KEY,
                type="CadenceType",
                property_schemas=["_TestSeedBoolSchema"],
            )
        ],
        property_schemas=[bool_schema],
    )

    from scripts.seed import SeedStats, _seed_domain  # noqa: PLC0415

    with neo4j_driver.session() as session:
        session.run(
            "MATCH (n) WHERE n.id = '_TestSeedBoolSchema' OR n.id = '_TestSeedBoolConcept' "
            "DETACH DELETE n"
        )
    try:
        with neo4j_driver.session() as session:
            create_fulltext_index(session)
            merge_domain_node(session, _DOMAIN_KEY)
            from backend.graph.queries.seed import (  # noqa: PLC0415
                merge_property_schema,
            )

            merge_property_schema(session, bool_schema)
            existing = get_existing_concept_ids(session)
            _seed_domain(session, bool_domain, existing, SeedStats())

        with neo4j_driver.session() as session:
            offenders = check_schemas_have_values(session)

        assert (
            "_TestSeedBoolSchema" not in offenders
        ), "BOOL schema was incorrectly flagged by check 5"
    finally:
        with neo4j_driver.session() as session:
            session.run(
                "MATCH (n) WHERE n.id = '_TestSeedBoolSchema' OR n.id = '_TestSeedBoolConcept' "
                "DETACH DELETE n"
            )


def test_capture_extensions_persisted_as_json(neo4j_driver: Driver) -> None:
    """capture_extensions on a concept round-trips through the seed layer as a JSON string."""
    import json  # noqa: PLC0415

    ext = CaptureExtensionYAML(
        field="cadential_harmony",
        type="harmony_object",
        required=False,
        description="The harmonic object at the cadence point.",
    )
    concept_with_ext = ConceptYAML(
        id="_TestSeedExtConcept",
        name="Test Extension Concept",
        definition="Concept with capture_extensions.",
        domain=_DOMAIN_KEY,
        type="CadenceType",
        capture_extensions=[ext],
    )
    ext_domain = DomainYAML(
        domain=_DOMAIN_KEY,
        concepts=[concept_with_ext],
        property_schemas=[],
    )

    from scripts.seed import SeedStats, _seed_domain  # noqa: PLC0415

    with neo4j_driver.session() as session:
        session.run("MATCH (n) WHERE n.id = '_TestSeedExtConcept' DETACH DELETE n")
    try:
        with neo4j_driver.session() as session:
            create_fulltext_index(session)
            merge_domain_node(session, _DOMAIN_KEY)
            existing = get_existing_concept_ids(session)
            _seed_domain(session, ext_domain, existing, SeedStats())

        with neo4j_driver.session() as session:
            result = session.run(
                "MATCH (c:Concept {id: '_TestSeedExtConcept'}) "
                "RETURN c.capture_extensions AS ce"
            ).single()

        assert result is not None
        stored = json.loads(result["ce"])
        assert isinstance(stored, list)
        assert len(stored) == 1
        assert stored[0]["field"] == "cadential_harmony"
        assert stored[0]["type"] == "harmony_object"
        assert stored[0]["required"] is False
    finally:
        with neo4j_driver.session() as session:
            session.run("MATCH (n) WHERE n.id = '_TestSeedExtConcept' DETACH DELETE n")


def test_prerequisite_for_acyclicity_no_cycle(neo4j_driver: Driver) -> None:
    """check_prerequisite_for_acyclicity returns empty list when no cycle exists."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        with neo4j_driver.session() as session:
            offenders = check_prerequisite_for_acyclicity(session)

        assert offenders == [], f"Unexpected PREREQUISITE_FOR cycle: {offenders}"
    finally:
        _cleanup(neo4j_driver)


def test_prerequisite_for_acyclicity_detects_cycle(neo4j_driver: Driver) -> None:
    """check_prerequisite_for_acyclicity returns involved ids when a cycle exists."""
    _cleanup(neo4j_driver)
    try:
        _seed_full_domain(neo4j_driver)

        # Manually create a cycle: Parent → Child → Parent via PREREQUISITE_FOR
        with neo4j_driver.session() as session:
            session.run(
                "MATCH (a:Concept {id: '_TestSeedConceptParent'}), "
                "      (b:Concept {id: '_TestSeedConceptChild'}) "
                "MERGE (a)-[:PREREQUISITE_FOR]->(b) "
                "MERGE (b)-[:PREREQUISITE_FOR]->(a)"
            )
            offenders = check_prerequisite_for_acyclicity(session)

        assert "_TestSeedConceptParent" in offenders
        assert "_TestSeedConceptChild" in offenders
    finally:
        _cleanup(neo4j_driver)
