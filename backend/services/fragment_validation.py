"""Fragment write validation — cross-database integrity and schema checks.

These functions are called by the fragment service before any database write.
They enforce the invariants that Pydantic cannot check alone (concept existence
in Neo4j, property values against graph schemas, sub-part containment).

The three public functions correspond to the five validation points in
docs/roadmap/component-5-tagging-tool.md § Step 5:

    validate_concept_existence   — point 2: concept_id referential integrity
    validate_summary_properties  — point 1 (property values) + required schema check
    validate_containment         — point 4: sub-part range containment

Data-licence derivation (point 5) is handled by the fragment service at write
time, not here, because it requires a PostgreSQL query against movement_analysis.
"""

from __future__ import annotations

from typing import Any

from errors import FragmentValidationError
from graph.queries.concepts import check_concept_exists
from models.fragment import FragmentCreate, FragmentSummary, SubPartFragmentCreate
from neo4j import AsyncDriver


async def validate_concept_existence(
    concept_ids: list[str],
    driver: AsyncDriver,
) -> None:
    """Assert every concept_id in the list exists in the Neo4j graph.

    Checks each id in a single session.  Collects all missing ids before
    raising so the caller receives the full list in one error.

    Args:
        concept_ids: Concept ids to verify (from ``concept_tags`` across the
            parent and all sub-parts).
        driver: Application-scoped async Neo4j driver.

    Raises:
        FragmentValidationError: With ``detail.missing_concept_ids`` listing
            every id not found in the graph.
    """
    missing: list[str] = []
    async with driver.session() as session:
        for cid in concept_ids:
            if not await check_concept_exists(session, cid):
                missing.append(cid)
    if missing:
        raise FragmentValidationError(
            f"Unknown concept id(s): {', '.join(missing)}. "
            "Every concept_id must exist in the knowledge graph before a "
            "fragment referencing it can be written.",
            detail={"missing_concept_ids": missing},
        )


def validate_summary_properties(
    summary: FragmentSummary,
    schemas: list[dict[str, Any]],
) -> None:
    """Assert summary.properties are valid against the applicable PropertySchemas.

    Enforces three rules from fragment-schema.md § "The summary JSONB schema":

    1. Every schema with ``required: true`` must have a value in
       ``summary.properties``.
    2. ``ONE_OF`` values must be a string and a valid ``PropertyValue.id``.
    3. ``MANY_OF`` values must be a list of strings, each a valid
       ``PropertyValue.id``.

    ``BOOL`` schemas have no value list; their presence as a key in
    ``summary.properties`` with any string value is accepted.

    Args:
        summary: The fragment summary to validate.
        schemas: Raw schema rows from
            ``graph.queries.concepts.get_concept_property_schemas()``.
            Each row has: ``schema_id``, ``cardinality``, ``required``,
            ``values`` (list of dicts with ``id`` key).

    Raises:
        FragmentValidationError: On the first validation failure, with
            structured ``detail`` identifying the offending schema and value.
    """
    schema_map: dict[str, dict[str, Any]] = {row["schema_id"]: row for row in schemas}
    valid_ids_by_schema: dict[str, frozenset[str]] = {
        row["schema_id"]: frozenset(v["id"] for v in row["values"]) for row in schemas
    }

    # 1. Required schemas must have a value.
    for schema_id, schema_row in schema_map.items():
        if schema_row.get("required") and schema_id not in summary.properties:
            raise FragmentValidationError(
                f"Required property '{schema_id}' is missing from "
                "summary.properties. Submission is blocked until all required "
                "properties are supplied.",
                detail={"missing_schema_id": schema_id},
            )

    # 2 & 3. Validate supplied property values against their schema cardinality.
    for schema_id, value in summary.properties.items():
        if schema_id not in schema_map:
            # Schema unknown to the current graph state — skip silently.
            # This can happen if a schema was added after the concept was cached.
            continue

        schema_row = schema_map[schema_id]
        cardinality: str = schema_row["cardinality"]
        valid_ids = valid_ids_by_schema.get(schema_id, frozenset())

        if cardinality == "ONE_OF":
            if not isinstance(value, str):
                raise FragmentValidationError(
                    f"Property '{schema_id}' has cardinality ONE_OF and must "
                    f"be a string, got {type(value).__name__}.",
                    detail={
                        "schema_id": schema_id,
                        "received_type": type(value).__name__,
                    },
                )
            if valid_ids and value not in valid_ids:
                raise FragmentValidationError(
                    f"'{value}' is not a valid value for property '{schema_id}'. "
                    f"Valid ids: {sorted(valid_ids)}.",
                    detail={
                        "schema_id": schema_id,
                        "invalid_value": value,
                        "valid_ids": sorted(valid_ids),
                    },
                )

        elif cardinality == "MANY_OF":
            if not isinstance(value, list):
                raise FragmentValidationError(
                    f"Property '{schema_id}' has cardinality MANY_OF and must "
                    f"be a list, got {type(value).__name__}.",
                    detail={
                        "schema_id": schema_id,
                        "received_type": type(value).__name__,
                    },
                )
            if valid_ids:
                invalid = [v for v in value if v not in valid_ids]
                if invalid:
                    raise FragmentValidationError(
                        f"Invalid value(s) for property '{schema_id}': "
                        f"{', '.join(invalid)}. "
                        f"Valid ids: {sorted(valid_ids)}.",
                        detail={
                            "schema_id": schema_id,
                            "invalid_values": invalid,
                            "valid_ids": sorted(valid_ids),
                        },
                    )

        # BOOL: no value list; any string value (or absence) is accepted.


def validate_containment(
    parent: FragmentCreate,
    children: list[SubPartFragmentCreate],
) -> None:
    """Assert each sub-part's bar range falls within the parent fragment's range.

    Service-layer containment check per tagging-tool-design.md § 9.  The
    database has no constraint enforcing this; the service layer is the only
    guard.

    Beat-level containment is not checked here because beat values are
    measure-local (1-indexed within their respective measure) and their
    comparison across different measures is not meaningful without knowing the
    meter at each position.  The tagging UI enforces beat containment at the
    ghost-overlay layer.

    Args:
        parent: The top-level fragment write payload.
        children: Sub-part payloads from ``parent.sub_parts``.

    Raises:
        FragmentValidationError: For the first sub-part whose bar range
            exceeds the parent's, with the index and ranges in ``detail``.
    """
    for idx, child in enumerate(children):
        if child.bar_start < parent.bar_start or child.bar_end > parent.bar_end:
            raise FragmentValidationError(
                f"Sub-part {idx} bar range [{child.bar_start}, {child.bar_end}] "
                f"falls outside the parent fragment's range "
                f"[{parent.bar_start}, {parent.bar_end}]. "
                "Every sub-part must be contained within its parent.",
                detail={
                    "sub_part_index": idx,
                    "child_bar_start": child.bar_start,
                    "child_bar_end": child.bar_end,
                    "parent_bar_start": parent.bar_start,
                    "parent_bar_end": parent.bar_end,
                },
            )
