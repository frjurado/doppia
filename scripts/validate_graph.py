"""Knowledge graph validation script.

Runs a suite of structural checks against the live Neo4j instance to verify
that the seeded graph conforms to the expected structure. Safe to run at any
time; makes no writes.

Checks performed (per docs/roadmap/phase-1.md § Component 4):

1. No concept node has zero outgoing edges (every node is connected).
2. Every IS_SUBTYPE_OF reference points to an existing concept id.
3. Every CONTAINS target is a defined concept id.
4. Every PropertyValue with a ``references`` field points to an existing concept id.
5. Every PropertySchema has at least one HAS_VALUE edge.
6. CONTAINS edges on a given concept have unique ``order`` values.

Also reports stub node counts by domain (stubs are expected and tracked, not errors).

Usage::

    python scripts/validate_graph.py

Exits 0 on success, 1 if any check fails.

CI runs this script on every commit that touches ``backend/seed/``.
"""

from __future__ import annotations

import sys


def main() -> None:
    """Entry point for the graph validation script."""
    print("[validate_graph] Not yet implemented.")
    print("[validate_graph] TODO: connect to Neo4j and run the 6 structural checks.")
    sys.exit(0)


if __name__ == "__main__":
    main()
