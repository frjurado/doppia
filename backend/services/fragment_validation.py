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

from collections.abc import Sequence
from typing import Any, Protocol

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


class _Bounded(Protocol):
    """The position fields every fragment write payload carries (ADR-005/015)."""

    bar_start: int
    bar_end: int
    mc_start: int
    mc_end: int
    beat_start: float | None
    beat_end: float | None


def _start_position(b: _Bounded) -> tuple[int, float]:
    """Sortable start position: document-order measure, then beat onset.

    A null ``beat_start`` means the bound sits at its measure's start, which is
    below every beat in that measure — so ``-inf`` orders it correctly without
    needing to know the meter.
    """
    return (b.mc_start, b.beat_start if b.beat_start is not None else float("-inf"))


def _end_position(b: _Bounded) -> tuple[int, float]:
    """Sortable end position; a null ``beat_end`` means the measure's end."""
    return (b.mc_end, b.beat_end if b.beat_end is not None else float("inf"))


def _assert_contained(parent: _Bounded, children: Sequence[_Bounded]) -> None:
    """Assert every sub-part's extent falls within the parent fragment's.

    Compared on ``(mc, beat)`` pairs. ``mc`` is the ADR-015 document-order index,
    the only unambiguous measure coordinate — bar numbers repeat across sections
    and endings, so ``bar_start`` alone cannot order two positions in K331/ii.
    Within one measure the beats then order the pair, and a null beat is that
    measure's own edge, so no meter is needed to compare them: the objection that
    kept beats out of this check ("beat values are measure-local") only applies to
    comparing beats *stripped of* their measure.

    Beat-level containment matters: the M7 defect (Component 11 Step 11) wrote
    whole-measure stage bounds under a fragment starting at beat 3, and a
    bar-only check saw nothing wrong with it.

    Args:
        parent: The top-level fragment write payload.
        children: Sub-part payloads.

    Raises:
        FragmentValidationError: For the first sub-part whose extent exceeds the
            parent's, with the index and both coordinate systems in ``detail``.
    """
    p_start, p_end = _start_position(parent), _end_position(parent)

    for idx, child in enumerate(children):
        if _start_position(child) >= p_start and _end_position(child) <= p_end:
            continue
        raise FragmentValidationError(
            f"Sub-part {idx} range [mc {child.mc_start}, mc {child.mc_end}] "
            f"(beats {child.beat_start}–{child.beat_end}) falls outside the "
            f"parent fragment's range [mc {parent.mc_start}, mc {parent.mc_end}] "
            f"(beats {parent.beat_start}–{parent.beat_end}). "
            "Every sub-part must be contained within its parent.",
            detail={
                "sub_part_index": idx,
                "child_bar_start": child.bar_start,
                "child_bar_end": child.bar_end,
                "parent_bar_start": parent.bar_start,
                "parent_bar_end": parent.bar_end,
                "child_mc_start": child.mc_start,
                "child_mc_end": child.mc_end,
                "parent_mc_start": parent.mc_start,
                "parent_mc_end": parent.mc_end,
                "child_beat_start": child.beat_start,
                "child_beat_end": child.beat_end,
                "parent_beat_start": parent.beat_start,
                "parent_beat_end": parent.beat_end,
            },
        )


def validate_containment(
    parent: FragmentCreate,
    children: list[SubPartFragmentCreate],
) -> None:
    """Assert each sub-part's extent falls within the parent fragment's.

    Service-layer containment check per tagging-tool-design.md § 9.  The
    database has no constraint enforcing this; the service layer is the only
    guard.  See :func:`_assert_contained` for the comparison rule.

    Args:
        parent: The top-level fragment write payload.
        children: Sub-part payloads from ``parent.sub_parts``.

    Raises:
        FragmentValidationError: For the first sub-part outside the parent.
    """
    _assert_contained(parent, children)
