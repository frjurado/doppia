"""Concept service: full-text search and schema-tree assembly.

All database access is encapsulated here; route handlers never call
graph queries directly.

Cursor encoding: an opaque base64(JSON) string that wraps a ``skip``
offset.  Callers treat it as an opaque token — the internal encoding
is not part of the public API contract.
"""

from __future__ import annotations

import base64
import json

from errors import ConceptNotFoundError
from graph.queries.concepts import (
    check_concept_exists,
    get_concept_contains_stages,
    get_concept_property_schemas,
    get_type_refinement_children,
    search_concepts,
)
from models.concepts import (
    ConceptSchemaTreeResponse,
    ConceptSearchItem,
    ConceptSearchResponse,
    ContainsStageItem,
    PropertySchemaItem,
    PropertyValueItem,
    ReferencedConcept,
    TypeRefinement,
    TypeRefinementChild,
)
from neo4j import AsyncDriver

# How many items to return per page.
_PAGE_SIZE: int = 20


class ConceptService:
    """Business logic for concept search and schema retrieval.

    Args:
        driver: The application-scoped async Neo4j driver, obtained via the
            ``get_neo4j`` FastAPI dependency.
    """

    def __init__(self, driver: AsyncDriver) -> None:
        self._driver = driver

    async def search(
        self,
        *,
        q: str,
        domain: str | None = None,
        cursor: str | None = None,
    ) -> ConceptSearchResponse:
        """Full-text concept search with cursor-based pagination.

        Requests ``_PAGE_SIZE + 1`` rows from Neo4j and uses the extra row to
        determine whether a next page exists, so callers never see the sentinel
        row in ``items``.

        Args:
            q: Lucene query string; must be non-empty (validated upstream).
            domain: Exact domain name to restrict results to, or ``None`` for
                all domains.
            cursor: Opaque cursor from a previous response's ``next_cursor``
                field; ``None`` for the first page.

        Returns:
            :class:`~models.concepts.ConceptSearchResponse` with ordered hits
            and an optional ``next_cursor``.
        """
        skip = _decode_cursor(cursor)
        fetch = _PAGE_SIZE + 1  # request one extra to detect a next page

        async with self._driver.session() as session:
            rows = await search_concepts(
                session,
                q=q,
                domain=domain,
                skip=skip,
                limit=fetch,
            )

        has_more = len(rows) == fetch
        page_rows = rows[:_PAGE_SIZE]

        items = [
            ConceptSearchItem(
                id=row["id"],
                name=row["name"],
                aliases=row["aliases"] or [],
                hierarchy_path=row["hierarchy_path"] or [],
                definition=row.get("definition"),
            )
            for row in page_rows
        ]

        return ConceptSearchResponse(
            items=items,
            next_cursor=_encode_cursor(skip + _PAGE_SIZE) if has_more else None,
        )

    async def get_schema_tree(self, concept_id: str) -> ConceptSchemaTreeResponse:
        """Fetch the full schema tree for a concept.

        Runs four Neo4j queries sequentially within one session:
        existence check, property schemas, CONTAINS stages, and type-refinement
        children.  Raises :class:`~errors.ConceptNotFoundError` (→ HTTP 404) if
        the concept id is unknown.

        Args:
            concept_id: Immutable concept identifier (e.g.
                ``"PerfectAuthenticCadence"``).

        Returns:
            :class:`~models.concepts.ConceptSchemaTreeResponse` with schemas,
            stages, and type-refinement metadata.

        Raises:
            ConceptNotFoundError: If no Concept node with ``concept_id`` exists.
        """
        async with self._driver.session() as session:
            if not await check_concept_exists(session, concept_id):
                raise ConceptNotFoundError(
                    f"Concept '{concept_id}' not found.",
                    detail={"concept_id": concept_id},
                )
            schemas_rows = await get_concept_property_schemas(session, concept_id)
            stages_rows = await get_concept_contains_stages(session, concept_id)
            children_rows = await get_type_refinement_children(session, concept_id)

        schemas = [_build_schema_item(row) for row in schemas_rows]
        stages = [
            ContainsStageItem(
                target_id=row["target_id"],
                target_name=row["target_name"],
                order=row["order"],
                required=row["required"],
                display_mode=row["display_mode"],
                containment_mode=row["containment_mode"],
                default_weight=row["default_weight"],
            )
            for row in stages_rows
        ]
        type_refinement = _compute_type_refinement(children_rows)

        return ConceptSchemaTreeResponse(
            concept_id=concept_id,
            schemas=schemas,
            stages=stages,
            type_refinement=type_refinement,
        )


# ---------------------------------------------------------------------------
# Schema-tree helpers (module-private)
# ---------------------------------------------------------------------------


def _build_schema_item(row: dict) -> PropertySchemaItem:
    """Assemble a :class:`~models.concepts.PropertySchemaItem` from a raw query row."""
    values: list[PropertyValueItem] = []
    for v in row["values"]:
        ref: ReferencedConcept | None = None
        if v.get("referenced_concept_id") is not None:
            ref = ReferencedConcept(
                id=v["referenced_concept_id"],
                name=v["referenced_concept_name"],
                definition=v.get("referenced_concept_definition"),
            )
        values.append(
            PropertyValueItem(
                id=v["id"],
                name=v["name"],
                order=v.get("order"),
                referenced_concept=ref,
            )
        )
    return PropertySchemaItem(
        id=row["schema_id"],
        name=row["schema_name"],
        description=row.get("schema_description"),
        cardinality=row["cardinality"],
        required=row["required"],
        order=row.get("order"),
        group=row.get("group"),
        values=values,
    )


def _compute_type_refinement(children_rows: list[dict]) -> TypeRefinement:
    """Determine whether Type Refinement should be shown.

    Compares the CONTAINS fingerprints of all direct non-stub children.  If
    fewer than two children exist, or all fingerprints are identical, no
    refinement section is needed.

    Args:
        children_rows: Raw rows from :func:`~graph.queries.concepts.get_type_refinement_children`.

    Returns:
        :class:`~models.concepts.TypeRefinement` with ``show=True`` and all
        children when structures differ, or ``show=False`` with an empty list.
    """
    if len(children_rows) <= 1:
        return TypeRefinement(show=False)

    fingerprints = [frozenset(row["fingerprint"]) for row in children_rows]
    if len(set(fingerprints)) == 1:
        return TypeRefinement(show=False)

    return TypeRefinement(
        show=True,
        children=[
            TypeRefinementChild(
                id=row["child_id"],
                name=row["child_name"],
                definition=row["child_definition"],
            )
            for row in children_rows
        ],
    )


# ---------------------------------------------------------------------------
# Cursor helpers (module-private)
# ---------------------------------------------------------------------------


def _encode_cursor(skip: int) -> str:
    """Encode an offset as an opaque base64 cursor token."""
    return base64.urlsafe_b64encode(json.dumps({"skip": skip}).encode()).decode()


def _decode_cursor(cursor: str | None) -> int:
    """Decode a cursor token back to its skip offset.

    Returns ``0`` for ``None`` or any malformed token so that bad cursors
    silently restart from the first page rather than raising.
    """
    if cursor is None:
        return 0
    try:
        payload = json.loads(base64.urlsafe_b64decode(cursor.encode()))
        skip = int(payload["skip"])
        return max(skip, 0)
    except Exception:
        return 0
