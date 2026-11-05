"""Report the fragment counts that gate the E1 graph revision (read-only).

Answers `docs/investigations/caplin-graph-review/proposals.md` § E, for
Step 1 of `docs/roadmap/track-e-e1-graph-revision.md`. Every query runs inside a
read-only transaction, so the server refuses any write.

The connection string comes from ``--url-file`` (default
``private/staging.env``, a git-ignored file holding one line,
``STAGING_DATABASE_URL=postgresql://...``) or from the ``STAGING_DATABASE_URL``
environment variable. It is never printed.

Usage:
    python scripts/e1_staging_facts.py
    python scripts/e1_staging_facts.py --url-file .env --url-key DATABASE_URL
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any, Sequence

import psycopg2
import psycopg2.extensions

_TOP_LEVEL = """
    FROM fragment f
    JOIN fragment_concept_tag t ON t.fragment_id = f.id AND t.is_primary
    JOIN movement m ON m.id = f.movement_id
    JOIN work w ON w.id = m.work_id
    WHERE f.parent_fragment_id IS NULL
"""

_PLACE = "w.slug || '/' || m.slug AS place, f.bar_start, f.bar_end, f.status"

_CHILDREN = """
    (SELECT coalesce(string_agg(ct.concept_id, ' > ' ORDER BY c.mc_end, c.beat_end), '(none)')
       FROM fragment c
       JOIN fragment_concept_tag ct ON ct.fragment_id = c.id AND ct.is_primary
      WHERE c.parent_fragment_id = f.id) AS stages
"""

_REALISED_AC = "('PerfectAuthenticCadence', 'ImperfectAuthenticCadence')"

_QUERIES: list[tuple[str, str]] = [
    (
        "Fragments by status (top-level)",
        "SELECT status, count(*) FROM fragment "
        "WHERE parent_fragment_id IS NULL GROUP BY 1 ORDER BY 1",
    ),
    (
        "Stage child fragments",
        "SELECT count(*) FROM fragment WHERE parent_fragment_id IS NOT NULL",
    ),
    (
        "Top-level fragments by concept and status",
        f"SELECT t.concept_id, f.status, count(*) {_TOP_LEVEL} GROUP BY 1, 2 ORDER BY 1, 2",
    ),
    (
        "Unison or Covered present (gates: retire Unison, move Covered)",
        "SELECT t.concept_id, k.key, f.summary->'properties'->>k.key AS value, count(*) "
        f"{_TOP_LEVEL.replace('WHERE', ', LATERAL (VALUES (%s), (%s)) AS k(key) WHERE')} "
        "AND f.summary->'properties' ? k.key GROUP BY 1, 2, 3 ORDER BY 1, 2, 3",
    ),
    (
        "Covered = true on a cadence that is not a PAC or IAC (blocks the move)",
        f"SELECT t.concept_id, {_PLACE} {_TOP_LEVEL} "
        "AND f.summary->'properties'->>'Covered' = 'true' "
        f"AND t.concept_id NOT IN {_REALISED_AC} ORDER BY 2, 3",
    ),
    (
        "IACs by IACSopranoDegree",
        "SELECT coalesce(f.summary->'properties'->>'IACSopranoDegree', '(unset)'), "
        f"count(*) {_TOP_LEVEL} AND t.concept_id = 'ImperfectAuthenticCadence' "
        "GROUP BY 1 ORDER BY 1",
    ),
    (
        "IACs on scale degree 5",
        f"SELECT {_PLACE} {_TOP_LEVEL} "
        "AND f.summary->'properties'->>'IACSopranoDegree' = 'SD5' ORDER BY 1, 2",
    ),
    (
        "Evaded cadences and their stages (last stage should be the Dominant)",
        f"SELECT {_PLACE}, {_CHILDREN} {_TOP_LEVEL} "
        "AND t.concept_id = 'EvadedCadence' ORDER BY 1, 2",
    ),
    (
        "Abandoned cadences and Dominant Arrivals with a Dominant stage "
        "(check each against the stage rule, P10)",
        f"SELECT t.concept_id, {_PLACE}, {_CHILDREN} {_TOP_LEVEL} "
        "AND t.concept_id IN ('AbandonedCadence', 'DominantArrival') "
        "AND EXISTS (SELECT 1 FROM fragment c "
        "JOIN fragment_concept_tag ct ON ct.fragment_id = c.id AND ct.is_primary "
        "WHERE c.parent_fragment_id = f.id "
        "AND ct.concept_id = 'CadentialDominant') ORDER BY 1, 2, 3",
    ),
    (
        "Abandoned cadences and Dominant Arrivals, total",
        f"SELECT t.concept_id, count(*) {_TOP_LEVEL} "
        "AND t.concept_id IN ('AbandonedCadence', 'DominantArrival') "
        "GROUP BY 1 ORDER BY 1",
    ),
    (
        "Half cadences by CadenceFunction",
        "SELECT t.concept_id, f.summary->'properties'->>'CadenceFunction', count(*) "
        f"{_TOP_LEVEL} AND t.concept_id IN "
        "('HalfCadenceRealised', 'ReopeningHalfCadence', 'DominantArrival') "
        "GROUP BY 1, 2 ORDER BY 1, 2",
    ),
    (
        "Half cadences tagged WayStation, not reopened (they break the Q3 ruling)",
        f"SELECT {_PLACE} {_TOP_LEVEL} AND t.concept_id = 'HalfCadenceRealised' "
        "AND f.summary->'properties'->>'CadenceFunction' = 'WayStation' ORDER BY 1, 2",
    ),
    (
        "Soprano test set for E4 (PAC, IAC with a degree)",
        f"SELECT t.concept_id, count(*) {_TOP_LEVEL} AND ("
        "t.concept_id = 'PerfectAuthenticCadence' OR "
        "f.summary->'properties' ? 'IACSopranoDegree') GROUP BY 1 ORDER BY 1",
    ),
    (
        "Top-level fragments with and without prose",
        "SELECT status, count(*) AS total, "
        "count(*) FILTER (WHERE length(coalesce(prose_annotation, '')) > 0) AS with_prose "
        "FROM fragment WHERE parent_fragment_id IS NULL GROUP BY 1 ORDER BY 1",
    ),
]

_PARAMS: dict[int, tuple[str, ...]] = {3: ("Unison", "Covered")}


def _read_url(path: Path, key: str) -> str | None:
    """Return the value of ``key`` from an env-style file, if present.

    Args:
        path: The file to read.
        key: The variable name to look for.

    Returns:
        The value, or ``None`` when the file or the key is missing.
    """
    if not path.is_file():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        name, sep, value = line.strip().partition("=")
        if sep and name.strip() == key:
            return value.strip().strip("\"'")
    return None


def _print_table(title: str, rows: Sequence[tuple[Any, ...]]) -> None:
    """Print one result set under a heading.

    Args:
        title: The heading.
        rows: The rows to print.
    """
    print(f"\n== {title}")
    if not rows:
        print("(none)")
    for row in rows:
        print(" | ".join("" if cell is None else str(cell) for cell in row))


def main() -> int:
    """Run the queries in a read-only transaction and print the results.

    Returns:
        A process exit code.
    """
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url-file", default="private/staging.env")
    parser.add_argument("--url-key", default="STAGING_DATABASE_URL")
    args = parser.parse_args()

    url = os.environ.get(args.url_key) or _read_url(Path(args.url_file), args.url_key)
    if not url:
        print(f"No {args.url_key} found in the environment or {args.url_file}.")
        return 1
    # The app stores the asyncpg form; psycopg2 wants neither its scheme nor its
    # ``ssl`` query parameter.
    url = url.replace("+asyncpg", "").replace("ssl=", "sslmode=")

    try:
        conn: psycopg2.extensions.connection = psycopg2.connect(url, connect_timeout=20)
    except psycopg2.Error as exc:
        # libpq errors can echo connection details, so report only the type.
        print(f"Could not connect ({type(exc).__name__}). Check host, port, password.")
        return 1

    try:
        conn.set_session(readonly=True, autocommit=False)
        with conn.cursor() as cur:
            cur.execute("SHOW transaction_read_only")
            print(f"transaction_read_only = {cur.fetchone()[0]}")
            for index, (title, sql) in enumerate(_QUERIES):
                cur.execute(sql, _PARAMS.get(index))
                _print_table(title, cur.fetchall())
    finally:
        conn.rollback()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
