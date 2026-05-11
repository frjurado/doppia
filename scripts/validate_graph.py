"""Knowledge graph validation script.

Runs a suite of nine structural checks against the live Neo4j instance to
verify that the seeded graph conforms to the expected structure.  Safe to
run at any time — makes no writes.

Checks performed (per ``docs/roadmap/component-4-knowledge-graph.md`` § Step 8):

1. No concept node has zero outgoing edges.
2. Every IS_SUBTYPE_OF reference points to an existing concept.
3. Every CONTAINS target is an existing concept.
4. Every PropertyValue with a ``references`` field points to an existing concept.
5. Every PropertySchema has at least one HAS_VALUE edge.
6. CONTAINS edges on a given concept have unique ``order`` values.
7. Every non-stub concept has a non-empty ``definition``.
8. Every concept id matches ``^[A-Z][A-Za-z0-9]*$`` (PascalCase).
9. No two concept nodes share the same ``id``.

Stub node counts by domain are reported as informational data (not errors).

Usage::

    python scripts/validate_graph.py

Environment variables (defaults match ``.env.example``)::

    NEO4J_URI       bolt://localhost:7687
    NEO4J_USER      neo4j
    NEO4J_PASSWORD  localpassword

Exits 0 on success, 1 if any check fails or if Neo4j is unreachable.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from neo4j import GraphDatabase  # noqa: E402

from backend.graph.queries.validation import (  # noqa: E402
    check_concept_id_format,
    check_concept_id_uniqueness,
    check_concepts_have_definitions,
    check_contains_order_uniqueness,
    check_contains_targets,
    check_is_subtype_of_targets,
    check_no_isolated_concepts,
    check_schemas_have_values,
    check_value_references_targets,
    get_stub_counts_by_domain,
)

# ---------------------------------------------------------------------------
# Check registry
# ---------------------------------------------------------------------------

_CHECKS = [
    (1, "No isolated concept nodes", check_no_isolated_concepts),
    (2, "IS_SUBTYPE_OF targets exist", check_is_subtype_of_targets),
    (3, "CONTAINS targets exist", check_contains_targets),
    (4, "PropertyValue.references targets exist", check_value_references_targets),
    (5, "PropertySchemas have at least one value", check_schemas_have_values),
    (6, "CONTAINS order is unique per concept", check_contains_order_uniqueness),
    (7, "Non-stub concepts have definitions", check_concepts_have_definitions),
    (8, "Concept ids match PascalCase", check_concept_id_format),
    (9, "Concept ids are unique", check_concept_id_uniqueness),
]

_COL_NUM = 4
_COL_LABEL = 48
_COL_RESULT = 30
_SEPARATOR = "-" * (_COL_NUM + _COL_LABEL + _COL_RESULT + 2)


def _print_header() -> None:
    print(f"{'#':<{_COL_NUM}} {'Check':<{_COL_LABEL}} {'Result'}")
    print(_SEPARATOR)


def _print_row(num: int, label: str, offenders: list[str]) -> None:
    if offenders:
        n = len(offenders)
        status = f"FAIL  ({n} offender{'s' if n != 1 else ''})"
    else:
        status = "pass"
    print(f"{num:<{_COL_NUM}} {label:<{_COL_LABEL}} {status}")
    for oid in offenders[:10]:
        print(f"       → {oid}")
    if len(offenders) > 10:
        print(f"       … and {len(offenders) - 10} more")


def main() -> None:
    """Entry point for the graph validation script."""
    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    print(f"Connecting to {uri} …")
    driver = GraphDatabase.driver(uri, auth=(user, password))

    try:
        driver.verify_connectivity()
    except Exception as exc:  # noqa: BLE001
        print(f"[ERROR] Cannot connect to Neo4j: {exc}", file=sys.stderr)
        sys.exit(1)

    any_failed = False

    try:
        with driver.session() as session:
            print()
            _print_header()

            for num, label, fn in _CHECKS:
                offenders = fn(session)
                _print_row(num, label, offenders)
                if offenders:
                    any_failed = True

            print()

            # Stub counts — informational, not errors
            stub_counts = get_stub_counts_by_domain(session)
            if stub_counts:
                print("Stub nodes by domain (informational):")
                for domain, count in sorted(stub_counts.items()):
                    print(f"  {domain}: {count}")
            else:
                print("No stub nodes in graph.")
            print()
    finally:
        driver.close()

    if any_failed:
        print("[FAIL] One or more validation checks did not pass — see above.")
        sys.exit(1)

    print("[PASS] All 9 checks passed.")
    sys.exit(0)


if __name__ == "__main__":
    main()
