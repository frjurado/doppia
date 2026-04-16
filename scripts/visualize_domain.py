"""Domain visualisation script (pyvis).

Exports a pyvis interactive HTML file for a given knowledge graph domain.
Run this after every seed to spot structural problems without opening Neo4j Bloom.

Usage::

    python scripts/visualize_domain.py --domain cadences

Writes ``<domain>.html`` to the current working directory and prints the path.

See docs/roadmap/phase-1.md § Component 4 — Visualization Setup.
"""

from __future__ import annotations

import argparse
import sys


def main() -> None:
    """Entry point for the domain visualisation script."""
    parser = argparse.ArgumentParser(
        description="Export a pyvis HTML visualisation for a knowledge graph domain."
    )
    parser.add_argument(
        "--domain",
        required=True,
        help="Domain name to visualise (e.g. 'cadences').",
    )
    args = parser.parse_args()

    print(f"[visualize_domain] Domain: {args.domain!r} — not yet implemented.")
    print("[visualize_domain] TODO: query Neo4j subgraph → NetworkX → pyvis HTML.")
    sys.exit(0)


if __name__ == "__main__":
    main()
