"""Integration tests: PropertySchema inheritance via IS_SUBTYPE_OF.

Pins the expected behaviour of ``get_inherited_schema_ids`` — the query that
``GET /api/v1/concepts/{id}/schemas`` will execute in Component 5.  These
tests document the inheritance rules against the live cadence domain so a
future regression in the query or the graph structure is immediately visible.

Schema inheritance rule (from knowledge-graph-design-reference.md):
  A concept inherits every PropertySchema declared on any of its ancestors
  via IS_SUBTYPE_OF*0.. traversal.  Only the highest ancestor that owns a
  schema needs to declare it; subtypes automatically inherit.

Key cadence domain hierarchy used by these tests::

    Cadence (schemas: CadenceFunction, PhraseClosure, ThemeClosure,
                      ECP, Covered, Unison)
    └── AuthenticCadence (no schemas)
        └── AuthenticCadenceRealised (schemas: ReinterpretedAsHC)
            ├── PerfectAuthenticCadence (no schemas)  → inherits 7
            └── ImperfectAuthenticCadence (schemas: IACSopranoDegree)  → inherits 8
        └── DeceptiveCadence (no schemas)  → inherits 6 (not ReinterpretedAsHC)
    └── HalfCadence (no schemas)
        └── HalfCadenceRealised (schemas: HalfCadenceShape)  → inherits 7

All tests require a Neo4j instance with the cadence domain seeded
(``python scripts/seed.py --all``).

See ``docs/roadmap/component-4-knowledge-graph.md`` § Step 14.
"""

from __future__ import annotations

import pytest
from neo4j import Driver

from backend.graph.queries.concepts import get_inherited_schema_ids

pytestmark = pytest.mark.integration

# Schemas declared on Cadence — inherited by every cadence subtype.
_CADENCE_ROOT_SCHEMAS = frozenset(
    ["CadenceFunction", "PhraseClosure", "ThemeClosure", "ECP", "Covered", "Unison"]
)


def test_pac_inherits_all_cadence_root_schemas(neo4j_driver: Driver) -> None:
    """PerfectAuthenticCadence inherits the six schemas declared on Cadence."""
    with neo4j_driver.session() as session:
        schemas = set(get_inherited_schema_ids(session, "PerfectAuthenticCadence"))
    assert _CADENCE_ROOT_SCHEMAS <= schemas


def test_pac_inherits_reinterpreted_as_hc(neo4j_driver: Driver) -> None:
    """PerfectAuthenticCadence inherits ReinterpretedAsHC from AuthenticCadenceRealised."""
    with neo4j_driver.session() as session:
        schemas = set(get_inherited_schema_ids(session, "PerfectAuthenticCadence"))
    assert "ReinterpretedAsHC" in schemas


def test_pac_total_schema_count(neo4j_driver: Driver) -> None:
    """PerfectAuthenticCadence resolves to exactly 7 schemas.

    6 from Cadence + 1 from AuthenticCadenceRealised; PAC itself has none.
    """
    with neo4j_driver.session() as session:
        schemas = get_inherited_schema_ids(session, "PerfectAuthenticCadence")
    assert len(schemas) == 7


def test_iac_has_direct_plus_inherited_schemas(neo4j_driver: Driver) -> None:
    """ImperfectAuthenticCadence resolves to 8 schemas: 7 inherited + IACSopranoDegree."""
    with neo4j_driver.session() as session:
        schemas = set(get_inherited_schema_ids(session, "ImperfectAuthenticCadence"))
    assert "IACSopranoDegree" in schemas
    assert _CADENCE_ROOT_SCHEMAS <= schemas
    assert "ReinterpretedAsHC" in schemas
    assert len(schemas) == 8


def test_deceptive_cadence_does_not_inherit_reinterpreted_as_hc(
    neo4j_driver: Driver,
) -> None:
    """DeceptiveCadence does not inherit ReinterpretedAsHC.

    DeceptiveCadence is a child of AuthenticCadence (not AuthenticCadenceRealised),
    so the ReinterpretedAsHC schema — which is declared on AuthenticCadenceRealised —
    is not in its inheritance chain.
    """
    with neo4j_driver.session() as session:
        schemas = set(get_inherited_schema_ids(session, "DeceptiveCadence"))
    assert "ReinterpretedAsHC" not in schemas
    assert _CADENCE_ROOT_SCHEMAS <= schemas
    assert len(schemas) == 6


def test_half_cadence_realised_inherits_root_and_has_shape_schema(
    neo4j_driver: Driver,
) -> None:
    """HalfCadenceRealised resolves to 7 schemas: 6 root + HalfCadenceShape."""
    with neo4j_driver.session() as session:
        schemas = set(get_inherited_schema_ids(session, "HalfCadenceRealised"))
    assert "HalfCadenceShape" in schemas
    assert _CADENCE_ROOT_SCHEMAS <= schemas
    assert len(schemas) == 7


def test_stub_concept_has_no_schemas(neo4j_driver: Driver) -> None:
    """ContrapuntalCadence (stub, prolongation domain) has no PropertySchema edges.

    Stub nodes carry no schemas because they are not yet fully modelled;
    the concept picker excludes them, so the schema list being empty is correct.
    """
    with neo4j_driver.session() as session:
        schemas = get_inherited_schema_ids(session, "ContrapuntalCadence")
    assert schemas == []
