"""Remove what the E1 seed pass left behind (idempotent).

``scripts/seed.py`` only uses ``MERGE``, so dropping something from the YAML
leaves it in place. The E1 graph revision
(`docs/roadmap/track-e-e1-graph-revision.md`, Step 5) retires ``Unison`` and moves
``Covered`` from ``Cadence`` to ``AuthenticCadenceRealised``. Run this after
seeding, on each environment:

- Neo4j: the ``Cadence`` → ``Covered`` edge, and the ``Unison`` schema node;
- PostgreSQL: the ``Unison`` translation rows.

It refuses to run if any fragment still stores ``Unison``, and it prints what it
would do unless ``--apply`` is passed.

Usage:
    python scripts/e1_graph_cleanup.py            # dry run
    python scripts/e1_graph_cleanup.py --apply

Reads ``NEO4J_URI``, ``NEO4J_USER``, ``NEO4J_PASSWORD`` and ``DATABASE_URL`` from
the environment, as ``scripts/seed.py`` does.
"""

from __future__ import annotations

import argparse
import os
import sys

import psycopg2
from neo4j import GraphDatabase

_COUNT_STALE = """\
OPTIONAL MATCH (:Concept {id: 'Cadence'})-[stale:HAS_PROPERTY_SCHEMA]->
               (:PropertySchema {id: 'Covered'})
WITH count(stale) AS edges
OPTIONAL MATCH (unison:PropertySchema {id: 'Unison'})
RETURN edges, count(unison) AS nodes
"""

_DELETE_EDGE = """\
MATCH (:Concept {id: 'Cadence'})-[stale:HAS_PROPERTY_SCHEMA]->
      (:PropertySchema {id: 'Covered'})
DELETE stale
"""

_DELETE_UNISON = "MATCH (s:PropertySchema {id: 'Unison'}) DETACH DELETE s"

_COUNT_USES = "SELECT count(*) FROM fragment WHERE summary->'properties' ? 'Unison'"

_COUNT_ROWS = (
    "SELECT count(*) FROM property_schema_translation WHERE schema_id = 'Unison'"
)

_DELETE_ROWS = "DELETE FROM property_schema_translation WHERE schema_id = 'Unison'"


def main() -> int:
    """Report the stale items and, with ``--apply``, remove them.

    Returns:
        A process exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        print("DATABASE_URL is not set.")
        return 1
    dsn = database_url.replace("+asyncpg", "").replace("ssl=", "sslmode=")

    driver = GraphDatabase.driver(
        os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
        auth=(
            os.environ.get("NEO4J_USER", "neo4j"),
            os.environ.get("NEO4J_PASSWORD", "localpassword"),
        ),
    )
    conn = psycopg2.connect(dsn, connect_timeout=20)
    try:
        with conn.cursor() as cur:
            cur.execute(_COUNT_USES)
            uses = cur.fetchone()[0]
            cur.execute(_COUNT_ROWS)
            rows = cur.fetchone()[0]
        with driver.session() as session:
            stale = session.run(_COUNT_STALE).single()
        print(f"fragments storing Unison: {uses}")
        print(f"Cadence -> Covered edges: {stale['edges']}")
        print(f"Unison schema nodes: {stale['nodes']}")
        print(f"Unison translation rows: {rows}")

        if uses:
            print("Refusing: migrate those fragments first.")
            return 1
        if not args.apply:
            print("Dry run; pass --apply to remove these.")
            return 0

        with driver.session() as session:
            session.run(_DELETE_EDGE).consume()
            session.run(_DELETE_UNISON).consume()
        with conn.cursor() as cur:
            cur.execute(_DELETE_ROWS)
        conn.commit()
        print("Removed.")
    finally:
        conn.close()
        driver.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
