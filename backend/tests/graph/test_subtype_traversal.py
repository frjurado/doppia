"""Integration tests: downward IS_SUBTYPE_OF subtree traversal (Component 8 Step 1).

Pins the expected behaviour of ``get_subtype_ids`` — the query that the
concept-scoped fragment browse uses to expand a parent concept into all its
non-stub subtypes.

Cadence domain hierarchy used by these tests (non-stub, relevant branches)::

    Cadence
    └── AuthenticCadence
        ├── AuthenticCadenceRealised
        │   ├── PerfectAuthenticCadence         (leaf)
        │   └── ImperfectAuthenticCadence       (leaf)
        ├── DeceptiveCadence                    (leaf)
        ├── EvadedCadence                       (leaf)
        └── AbandonedCadence                    (leaf)
    └── HalfCadence
        └── HalfCadenceRealised
            └── ReopeningHalfCadence            (leaf)
        └── DominantArrival                     (leaf)

Stub concepts (e.g. ContrapuntalCadence in the prolongation domain) must be
absent from all subtree results.

All tests require a Neo4j instance with all domains seeded
(``python scripts/seed.py --all``).

See ``docs/roadmap/component-8-fragment-browsing.md`` § Step 1.
"""

from __future__ import annotations

import pytest
from neo4j import Driver

from backend.graph.queries.concepts import get_subtype_ids

pytestmark = pytest.mark.integration

# Non-stub subtypes of AuthenticCadence (excluding the root itself)
_AUTHENTIC_CADENCE_SUBTYPES = frozenset(
    [
        "AuthenticCadenceRealised",
        "PerfectAuthenticCadence",
        "ImperfectAuthenticCadence",
        "DeceptiveCadence",
        "EvadedCadence",
        "AbandonedCadence",
    ]
)


def test_root_is_always_included(neo4j_driver: Driver) -> None:
    """The root concept id is always present in its own subtree (*0.. zero hop)."""
    with neo4j_driver.session() as session:
        ids = get_subtype_ids(session, "AuthenticCadence")
    assert "AuthenticCadence" in ids


def test_authentic_cadence_subtree_includes_all_subtypes(neo4j_driver: Driver) -> None:
    """AuthenticCadence subtree contains every non-stub subtype."""
    with neo4j_driver.session() as session:
        ids = get_subtype_ids(session, "AuthenticCadence")
    assert _AUTHENTIC_CADENCE_SUBTYPES <= ids


def test_pac_is_a_leaf_returns_singleton(neo4j_driver: Driver) -> None:
    """PerfectAuthenticCadence has no subtypes — subtree is just itself."""
    with neo4j_driver.session() as session:
        ids = get_subtype_ids(session, "PerfectAuthenticCadence")
    assert ids == {"PerfectAuthenticCadence"}


def test_iac_is_a_leaf_returns_singleton(neo4j_driver: Driver) -> None:
    """ImperfectAuthenticCadence has no subtypes — subtree is just itself."""
    with neo4j_driver.session() as session:
        ids = get_subtype_ids(session, "ImperfectAuthenticCadence")
    assert ids == {"ImperfectAuthenticCadence"}


def test_half_cadence_subtree_does_not_include_authentic_branch(
    neo4j_driver: Driver,
) -> None:
    """HalfCadence subtree does not bleed into the AuthenticCadence branch."""
    with neo4j_driver.session() as session:
        ids = get_subtype_ids(session, "HalfCadence")
    assert "HalfCadence" in ids
    assert "HalfCadenceRealised" in ids
    assert "PerfectAuthenticCadence" not in ids
    assert "AuthenticCadence" not in ids


def test_cadence_root_includes_both_branches(neo4j_driver: Driver) -> None:
    """Cadence (root of the whole domain) includes concepts from both branches."""
    with neo4j_driver.session() as session:
        ids = get_subtype_ids(session, "Cadence")
    assert "AuthenticCadence" in ids
    assert "PerfectAuthenticCadence" in ids
    assert "HalfCadence" in ids
    assert "HalfCadenceRealised" in ids


def test_stub_concept_excluded_from_results(neo4j_driver: Driver) -> None:
    """ContrapuntalCadence (stub, prolongation domain) is never in the result.

    ContrapuntalCadence is seeded with ``stub: true``; even if it were a
    structural subtype of something in the cadence domain it must not appear
    in browse results.
    """
    with neo4j_driver.session() as session:
        cadence_ids = get_subtype_ids(session, "Cadence")
    assert "ContrapuntalCadence" not in cadence_ids


def test_stub_root_returns_empty_set(neo4j_driver: Driver) -> None:
    """A stub root concept itself is excluded, yielding an empty set.

    ContrapuntalCadence is a stub and has no non-stub subtypes.
    """
    with neo4j_driver.session() as session:
        ids = get_subtype_ids(session, "ContrapuntalCadence")
    assert ids == set()
