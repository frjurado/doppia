"""Knowledge graph seeding script.

Loads a domain YAML file from ``backend/seed/domains/<domain>.yaml``,
validates it against Pydantic models, and writes the graph to Neo4j using
idempotent Cypher MERGE statements. Safe to re-run at any time.

Usage::

    python scripts/seed.py --domain cadences
    python scripts/seed.py --domain harmonic-functions

The ``--domain`` argument must match a filename in ``backend/seed/domains/``
(without the ``.yaml`` extension).

Validation errors abort the seed with a descriptive message before any Cypher
is executed. This ensures Neo4j is never left in a partially seeded state.

See docs/roadmap/phase-1.md § Component 4 for the full seed workflow and
YAML schema specification.
"""

from __future__ import annotations

import argparse
import sys


def main() -> None:
    """Entry point for the seeding script."""
    parser = argparse.ArgumentParser(description="Seed a knowledge graph domain into Neo4j.")
    parser.add_argument(
        "--domain",
        required=True,
        help="Domain name to seed (e.g. 'cadences'). Must match a file in backend/seed/domains/.",
    )
    args = parser.parse_args()

    print(f"[seed] Domain: {args.domain!r} — not yet implemented.")
    print("[seed] TODO: validate YAML → Pydantic → Cypher MERGE into Neo4j.")
    sys.exit(0)


if __name__ == "__main__":
    main()
