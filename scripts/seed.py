"""Knowledge graph seeding script.

Loads domain YAML files from ``backend/seed/domains/``, validates them against
Pydantic models, and writes the graph to Neo4j using idempotent Cypher MERGE
statements.  Safe to re-run at any time.

Usage::

    python scripts/seed.py --domain cadences
    python scripts/seed.py --all
    python scripts/seed.py --domain cadences --dry-run   # validate only, no Neo4j writes
    python scripts/seed.py --all --force                 # skip id-immutability prompt

Exit codes:
    0  Success (or dry-run completed cleanly).
    1  YAML validation error (Pydantic).
    2  Unresolved cross-reference in live-seed mode.
    3  User cancelled after id-immutability warning.

Seeding order (dependency-safe):
    1. Full-text index DDL (idempotent IF NOT EXISTS).
    2. Domain grouping nodes.
    3. PropertyValue nodes.
    4. PropertySchema nodes + HAS_VALUE edges.
    5. Concept nodes.
    6. BELONGS_TO edges (Concept → Domain).
    7. Typed relationship edges (IS_SUBTYPE_OF, RESOLVES_TO, etc.).
    8. CONTAINS edges (with order, required, display_mode, containment_mode,
       default_weight edge properties).
    9. HAS_PROPERTY_SCHEMA edges.
   10. VALUE_REFERENCES edges (PropertyValue → Concept).

See docs/roadmap/component-4-knowledge-graph.md § Step 7 for the full spec.
"""

from __future__ import annotations

import argparse
import os
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Bootstrap sys.path so backend packages are importable when running directly
# from the repo root.  When pytest imports this module (``backend`` is already
# on pythonpath via pyproject.toml), the insert is a harmless no-op.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import yaml  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from backend.graph.queries.seed import (  # noqa: E402
    create_fulltext_index,
    get_existing_concept_ids,
    get_existing_schema_ids,
    merge_belongs_to_edge,
    merge_concept,
    merge_contains_edge,
    merge_domain_node,
    merge_has_property_schema_edge,
    merge_property_schema,
    merge_relationship_edge,
    merge_value_references_edge,
)
from backend.seed.schemas import DomainYAML  # noqa: E402

# ---------------------------------------------------------------------------
# Repository layout
# ---------------------------------------------------------------------------

_REPO_ROOT = Path(__file__).parent.parent
_DOMAINS_DIR = _REPO_ROOT / "backend" / "seed" / "domains"

# ---------------------------------------------------------------------------
# Stats
# ---------------------------------------------------------------------------


@dataclass
class SeedStats:
    """Counters accumulated during a seed run.

    Attributes:
        property_values_seeded: Total PropertyValue nodes merged.
        property_schemas_seeded: Total PropertySchema nodes merged.
        concepts_seeded: Total Concept nodes merged.
        concepts_new: Concepts that did not exist in Neo4j before this run.
        relationship_edges_seeded: Non-CONTAINS typed edges merged.
        contains_edges_seeded: CONTAINS edges merged.
        has_property_schema_edges_seeded: HAS_PROPERTY_SCHEMA edges merged.
        stubs_by_domain: Stub concept count per domain key.
    """

    property_values_seeded: int = 0
    property_schemas_seeded: int = 0
    concepts_seeded: int = 0
    concepts_new: int = 0
    relationship_edges_seeded: int = 0
    contains_edges_seeded: int = 0
    has_property_schema_edges_seeded: int = 0
    stubs_by_domain: dict[str, int] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------


def _parse_args() -> argparse.Namespace:
    """Parse command-line arguments.

    Returns:
        Parsed argument namespace.
    """
    parser = argparse.ArgumentParser(
        description="Seed a knowledge-graph domain into Neo4j."
    )
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument(
        "--domain",
        metavar="NAME",
        help=(
            "Domain name to seed (e.g. 'cadences'). "
            "Must match a file in backend/seed/domains/."
        ),
    )
    target.add_argument(
        "--all",
        action="store_true",
        dest="all_domains",
        help="Seed every YAML file found in backend/seed/domains/.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help=(
            "Validate YAML and check internal references only. "
            "No Neo4j connection is opened and no writes are made."
        ),
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help=(
            "Skip the id-immutability confirmation prompt. "
            "Intended for CI; use with care — orphaned concept ids break "
            "fragment_concept_tag referential integrity."
        ),
    )
    return parser.parse_args()


# ---------------------------------------------------------------------------
# YAML loading and Pydantic validation
# ---------------------------------------------------------------------------


def _load_domain_files(args: argparse.Namespace) -> list[DomainYAML]:
    """Load and validate all requested domain YAML files.

    Args:
        args: Parsed command-line arguments.

    Returns:
        List of validated DomainYAML models, one per file.

    Raises:
        SystemExit(1): On missing file or Pydantic validation error.
    """
    if args.all_domains:
        paths = sorted(_DOMAINS_DIR.glob("*.yaml"))
        if not paths:
            print(
                f"[seed] ERROR: no *.yaml files found in {_DOMAINS_DIR}",
                file=sys.stderr,
            )
            sys.exit(1)
    else:
        path = _DOMAINS_DIR / f"{args.domain}.yaml"
        if not path.exists():
            print(
                f"[seed] ERROR: domain file not found: {path}",
                file=sys.stderr,
            )
            sys.exit(1)
        paths = [path]

    domains: list[DomainYAML] = []
    errors_found = False

    for path in paths:
        raw = yaml.safe_load(path.read_text(encoding="utf-8"))
        try:
            domain = DomainYAML.model_validate(raw)
        except ValidationError as exc:
            print(
                f"[seed] VALIDATION ERROR in {path.name}:\n{exc}",
                file=sys.stderr,
            )
            errors_found = True
            continue
        domains.append(domain)
        print(f"[seed] Validated {path.name} ({len(domain.concepts)} concepts)")

    if errors_found:
        sys.exit(1)

    return domains


# ---------------------------------------------------------------------------
# Reference resolution
# ---------------------------------------------------------------------------


def _build_known_ids(
    domains: list[DomainYAML],
) -> tuple[frozenset[str], frozenset[str]]:
    """Collect all concept and property-schema ids from the loaded YAML files.

    Args:
        domains: Validated domain models.

    Returns:
        A ``(concept_ids, schema_ids)`` pair of frozensets.
    """
    concept_ids: set[str] = set()
    schema_ids: set[str] = set()
    for domain in domains:
        for concept in domain.concepts:
            concept_ids.add(concept.id)
        for schema in domain.property_schemas:
            schema_ids.add(schema.id)
    return frozenset(concept_ids), frozenset(schema_ids)


def _check_references(
    domains: list[DomainYAML],
    concept_ids: frozenset[str],
    schema_ids: frozenset[str],
    dry_run: bool,
) -> bool:
    """Verify that all cross-references within loaded files resolve.

    Unresolved references that point to concepts/schemas outside the loaded
    YAML set are reported as warnings in ``--dry-run`` mode (the referenced
    nodes may already exist in Neo4j from a prior seed) and as hard errors in
    live mode.

    Args:
        domains: Validated domain models.
        concept_ids: Known concept ids from the loaded YAML files.
        schema_ids: Known property-schema ids from the loaded YAML files.
        dry_run: If ``True``, unresolved refs produce warnings, not errors.

    Returns:
        ``True`` if all references resolve (or dry-run warnings were issued),
        ``False`` if hard errors were found in live mode.
    """
    unresolved: list[str] = []

    for domain in domains:
        for concept in domain.concepts:
            for rel in concept.relationships:
                if rel.target not in concept_ids:
                    unresolved.append(
                        f"  concept {concept.id!r}: relationship target {rel.target!r} "
                        f"not in loaded files (domain={domain.domain!r})"
                    )
            for entry in concept.contains:
                if entry.target not in concept_ids:
                    unresolved.append(
                        f"  concept {concept.id!r}: contains target {entry.target!r} "
                        f"not in loaded files (domain={domain.domain!r})"
                    )
            for schema_ref in concept.property_schemas:
                schema_id = (
                    schema_ref if isinstance(schema_ref, str) else schema_ref.schema
                )
                if schema_id not in schema_ids:
                    unresolved.append(
                        f"  concept {concept.id!r}: property_schema {schema_id!r} "
                        f"not in loaded files (domain={domain.domain!r})"
                    )

    if not unresolved:
        return True

    label = "WARNING" if dry_run else "ERROR"
    print(
        f"\n[seed] {label}: {len(unresolved)} unresolved cross-reference(s):",
        file=sys.stderr,
    )
    for msg in unresolved:
        print(msg, file=sys.stderr)

    if dry_run:
        print(
            "[seed] (dry-run) References may exist in Neo4j from a prior seed; "
            "run without --dry-run to validate against the live graph.\n",
            file=sys.stderr,
        )
        return True  # warn only — dry-run succeeds so the iteration loop keeps moving

    return False  # hard failure in live mode


# ---------------------------------------------------------------------------
# Capture-extension field consistency
# ---------------------------------------------------------------------------


def _check_capture_extension_consistency(domains: list[DomainYAML]) -> bool:
    """Verify that the same capture-extension field name is not declared with
    conflicting ``type`` or ``required`` across concepts.

    The ``capture_extensions`` namespace is flat and shared across all concepts
    (see ``docs/architecture/capture_extensions.md`` § Key Principles): two
    concepts may declare the same ``field`` only if their ``type`` and
    ``required`` values are identical.

    Args:
        domains: Validated domain models.

    Returns:
        ``True`` if no conflicts are found, ``False`` otherwise (errors printed
        to stderr).
    """
    from collections import defaultdict

    # seen[field_name] = [(concept_id, type, required), ...]
    seen: dict[str, list[tuple[str, str, bool]]] = defaultdict(list)

    for domain in domains:
        for concept in domain.concepts:
            for ext in concept.capture_extensions:
                seen[ext.field].append((concept.id, ext.type, ext.required))

    conflicts: list[str] = []
    for field_name, declarations in seen.items():
        types = {d[1] for d in declarations}
        requireds = {d[2] for d in declarations}
        if len(types) > 1 or len(requireds) > 1:
            detail = ", ".join(
                f"{cid!r}(type={t!r}, required={r})" for cid, t, r in declarations
            )
            conflicts.append(
                f"  field {field_name!r}: conflicting declarations — {detail}"
            )

    if conflicts:
        print(
            f"\n[seed] ERROR: {len(conflicts)} capture_extension field conflict(s):",
            file=sys.stderr,
        )
        for msg in conflicts:
            print(msg, file=sys.stderr)
        return False
    return True


# ---------------------------------------------------------------------------
# Id-immutability guardrail
# ---------------------------------------------------------------------------


def _check_id_immutability(
    existing_concept_ids: frozenset[str],
    yaml_concept_ids: frozenset[str],
    force: bool,
) -> bool:
    """Warn when existing Neo4j concept ids are absent from the YAML.

    A missing id means a concept was renamed or deleted in YAML, which would
    orphan any ``fragment_concept_tag`` rows that reference it.

    Args:
        existing_concept_ids: Concept ids currently in Neo4j.
        yaml_concept_ids: Concept ids present across all loaded YAML files.
        force: If ``True``, skip the interactive prompt (CI mode).

    Returns:
        ``True`` to proceed, ``False`` if the user cancelled.
    """
    orphaned = existing_concept_ids - yaml_concept_ids
    if not orphaned:
        return True

    print(
        "\n[seed] WARNING: the following concept id(s) exist in Neo4j but are "
        "absent from the loaded YAML files:",
        file=sys.stderr,
    )
    for cid in sorted(orphaned):
        print(f"  {cid}", file=sys.stderr)
    print(
        "\nRemoving a concept id from YAML while fragment_concept_tag rows still "
        "reference it is a breaking change — those tags will become dangling.\n"
        "This is NOT automatically repaired by this script.\n",
        file=sys.stderr,
    )

    if force:
        print(
            "[seed] --force passed; continuing despite orphaned ids.", file=sys.stderr
        )
        return True

    answer = input("[seed] Proceed anyway? [y/N] ").strip().lower()
    if answer not in ("y", "yes"):
        print("[seed] Aborted.", file=sys.stderr)
        return False

    return True


# ---------------------------------------------------------------------------
# Seeding logic
# ---------------------------------------------------------------------------


def _seed_domain(
    session: object,
    domain: DomainYAML,
    existing_concept_ids: frozenset[str],
    stats: SeedStats,
) -> None:
    """Seed a single domain into Neo4j.

    Writes nodes and edges in the order required to satisfy Neo4j MATCH
    constraints (nodes must exist before edges that reference them).

    Args:
        session: An open synchronous Neo4j session.
        domain: The validated DomainYAML model.
        existing_concept_ids: Concept ids that existed before this run (used
            to compute the ``concepts_new`` counter).
        stats: Accumulated statistics object (mutated in place).
    """
    # Step 1: PropertyValues + PropertySchemas + HAS_VALUE edges
    for schema in domain.property_schemas:
        merge_property_schema(session, schema)
        stats.property_schemas_seeded += 1
        stats.property_values_seeded += len(schema.values)

    # Step 2: Domain grouping node
    merge_domain_node(session, domain.domain)

    # Step 3: Concept nodes
    for concept in domain.concepts:
        merge_concept(session, concept)
        stats.concepts_seeded += 1
        if concept.id not in existing_concept_ids:
            stats.concepts_new += 1
        if concept.stub:
            stats.stubs_by_domain[concept.domain] = (
                stats.stubs_by_domain.get(concept.domain, 0) + 1
            )

    # Step 4: BELONGS_TO edges (Concept → Domain)
    for concept in domain.concepts:
        merge_belongs_to_edge(session, concept.id, domain.domain)

    # Step 5: Typed relationship edges (IS_SUBTYPE_OF, RESOLVES_TO, etc.)
    for concept in domain.concepts:
        for rel in concept.relationships:
            merge_relationship_edge(session, concept.id, rel.type, rel.target)
            stats.relationship_edges_seeded += 1

    # Step 6: CONTAINS edges (carry edge properties)
    for concept in domain.concepts:
        for entry in concept.contains:
            merge_contains_edge(session, concept.id, entry)
            stats.contains_edges_seeded += 1

    # Step 7: HAS_PROPERTY_SCHEMA edges (carry order/group per ADR-023)
    for concept in domain.concepts:
        for ref in concept.property_schemas:
            merge_has_property_schema_edge(session, concept.id, ref)
            stats.has_property_schema_edges_seeded += 1

    # Step 8: VALUE_REFERENCES edges (PropertyValue → Concept)
    for schema in domain.property_schemas:
        for pv in schema.values:
            if pv.references:
                merge_value_references_edge(session, pv.id, pv.references)


# ---------------------------------------------------------------------------
# Summary output
# ---------------------------------------------------------------------------


def _print_summary(stats: SeedStats) -> None:
    """Print a structured summary of what was seeded.

    Args:
        stats: Accumulated statistics from the seed run.
    """
    print("\n[seed] ── Summary ────────────────────────────────────────────")
    print(
        f"[seed]   Concepts seeded     : {stats.concepts_seeded}"
        f" ({stats.concepts_new} new)"
    )
    print(f"[seed]   Property schemas   : {stats.property_schemas_seeded}")
    print(f"[seed]   Property values    : {stats.property_values_seeded}")
    print(f"[seed]   Relationship edges : {stats.relationship_edges_seeded}")
    print(f"[seed]   CONTAINS edges     : {stats.contains_edges_seeded}")
    print(f"[seed]   HAS_PROPERTY_SCHEMA: {stats.has_property_schema_edges_seeded}")
    if stats.stubs_by_domain:
        print("[seed]   Stub counts by domain:")
        for dom, count in sorted(stats.stubs_by_domain.items()):
            print(f"[seed]     {dom}: {count}")
    print("[seed] ────────────────────────────────────────────────────────")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main() -> None:
    """Parse arguments, validate YAML, seed Neo4j, and print a summary.

    Exit codes:
        0  Success (or dry-run completed cleanly).
        1  YAML validation error.
        2  Unresolved cross-reference in live-seed mode.
        3  User cancelled id-immutability prompt.
    """
    args = _parse_args()

    # ── Load and validate YAML ───────────────────────────────────────────────
    domains = _load_domain_files(args)

    # ── Reference resolution ─────────────────────────────────────────────────
    concept_ids, schema_ids = _build_known_ids(domains)
    refs_ok = _check_references(domains, concept_ids, schema_ids, args.dry_run)
    if not refs_ok:
        sys.exit(2)

    if not _check_capture_extension_consistency(domains):
        sys.exit(2)

    if args.dry_run:
        print(
            f"\n[seed] Dry-run complete. "
            f"{sum(len(d.concepts) for d in domains)} concept(s) across "
            f"{len(domains)} domain file(s) validated successfully."
        )
        sys.exit(0)

    # ── Connect to Neo4j ──────────────────────────────────────────────────────
    from neo4j import GraphDatabase  # noqa: PLC0415

    uri = os.environ.get("NEO4J_URI", "bolt://localhost:7687")
    user = os.environ.get("NEO4J_USER", "neo4j")
    password = os.environ.get("NEO4J_PASSWORD", "localpassword")

    driver = GraphDatabase.driver(uri, auth=(user, password))

    try:
        with driver.session() as session:
            # ── Id-immutability check ─────────────────────────────────────────
            existing_concept_ids = get_existing_concept_ids(session)
            existing_schema_ids = get_existing_schema_ids(session)

            # Extend known ids with what already exists in Neo4j, then re-check
            # references: a target may be absent from loaded files but already
            # seeded from a prior domain run.
            extended_concept_ids = concept_ids | existing_concept_ids
            extended_schema_ids = schema_ids | existing_schema_ids
            refs_ok_extended = _check_references(
                domains,
                extended_concept_ids,
                extended_schema_ids,
                dry_run=False,
            )
            if not refs_ok_extended:
                sys.exit(2)

            if not _check_id_immutability(
                existing_concept_ids, concept_ids, args.force
            ):
                sys.exit(3)

            # ── Seed ──────────────────────────────────────────────────────────
            create_fulltext_index(session)

            stats = SeedStats()
            for domain in domains:
                print(f"\n[seed] Seeding domain: {domain.domain!r} …")
                _seed_domain(session, domain, existing_concept_ids, stats)

            _print_summary(stats)

    finally:
        driver.close()

    sys.exit(0)


if __name__ == "__main__":
    main()
