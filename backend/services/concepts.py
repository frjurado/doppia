"""Concept service: full-text search, schema-tree assembly, and concept-tree navigation.

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
    get_concept_subtree,
    get_domain_roots,
    get_type_refinement_children,
    search_concepts,
)
from models.concepts import (
    ConceptRootItem,
    ConceptRootsResponse,
    ConceptSchemaTreeResponse,
    ConceptSearchItem,
    ConceptSearchResponse,
    ConceptTreeNode,
    ConceptTreeResponse,
    ContainsStageItem,
    PropertySchemaItem,
    PropertyValueItem,
    ReferencedConcept,
    TypeRefinement,
    TypeRefinementChild,
)
from models.fragment import Fragment, FragmentConceptTag
from neo4j import AsyncDriver
from redis.asyncio import Redis
from services.cache import get_tree_cache, set_tree_cache
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

# How many items to return per page.
_PAGE_SIZE: int = 20


class ConceptService:
    """Business logic for concept search, schema retrieval, and tree navigation.

    Args:
        driver: The application-scoped async Neo4j driver.
        db: Async SQLAlchemy session; required only for ``get_tree`` (fragment
            counts).  Pass ``None`` when only search/schema operations are needed.
        redis: Async Redis client; used by ``get_tree`` to cache the tree
            response.  Pass ``None`` to skip caching.
    """

    def __init__(
        self,
        driver: AsyncDriver,
        db: AsyncSession | None = None,
        redis: Redis | None = None,
    ) -> None:
        self._driver = driver
        self._db = db
        self._redis = redis

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

    async def get_roots(self) -> ConceptRootsResponse:
        """Return all domain root concepts (non-stub nodes with no IS_SUBTYPE_OF parent).

        Domain roots are the natural entry points for the concept-tree navigator.
        Results are ordered alphabetically by name.

        Returns:
            :class:`~models.concepts.ConceptRootsResponse` with a list of root items.
        """
        async with self._driver.session() as session:
            rows = await get_domain_roots(session)
        return ConceptRootsResponse(
            roots=[
                ConceptRootItem(id=r["id"], name=r["name"], aliases=r["aliases"] or [])
                for r in rows
            ]
        )

    async def get_tree(self, root_id: str) -> ConceptTreeResponse:
        """Return the concept subtree rooted at root_id for the tag browser.

        Performs three operations:

        1. Checks Redis for a cached ``ConceptTreeResponse`` (key
           ``tree:{root_id}``); returns it immediately on a hit.
        2. Queries Neo4j for all non-stub concepts in the IS_SUBTYPE_OF
           subtree, building a flat node list with parent_id linkage and
           hierarchy paths.
        3. Queries PostgreSQL for ``approved`` fragment counts per concept id
           (cross-reference tags, not only ``is_primary``) and attaches them
           to each node.

        The assembled response is written back to Redis with a 1-hour TTL
        (invalidated by ``scripts/seed.py`` after every re-seed).

        Raises :class:`~errors.ConceptNotFoundError` (→ HTTP 404) when
        ``root_id`` is unknown or refers to a stub concept.

        Args:
            root_id: Immutable concept identifier for the tree root.

        Returns:
            :class:`~models.concepts.ConceptTreeResponse` with a flat node
            list ordered alphabetically.

        Raises:
            ConceptNotFoundError: If no non-stub Concept with ``root_id`` exists.
        """
        if self._redis is not None:
            cached = await get_tree_cache(self._redis, root_id)
            if cached is not None:
                return ConceptTreeResponse.model_validate(cached)

        async with self._driver.session() as neo4j_session:
            rows = await get_concept_subtree(neo4j_session, root_id)

        if not rows:
            raise ConceptNotFoundError(
                f"Concept '{root_id}' not found or is a stub.",
                detail={"concept_id": root_id},
            )

        node_ids = [r["id"] for r in rows]
        counts = await self._fetch_fragment_counts(node_ids)

        nodes = [
            ConceptTreeNode(
                id=r["id"],
                name=r["name"],
                aliases=r["aliases"] or [],
                hierarchy_path=r["hierarchy_path"] or [],
                parent_id=r["parent_id"],
                fragment_count=counts.get(r["id"], 0),
            )
            for r in rows
        ]

        response = ConceptTreeResponse(root_id=root_id, nodes=nodes)

        if self._redis is not None:
            await set_tree_cache(self._redis, root_id, response.model_dump())

        return response

    async def _fetch_fragment_counts(self, concept_ids: list[str]) -> dict[str, int]:
        """Return approved fragment counts keyed by concept_id.

        Counts every fragment whose concept tags include a concept in the list,
        regardless of ``is_primary``.  Only ``approved`` fragments are counted
        (the "browse the finished corpus" baseline).

        Returns an empty dict when no database session is available.
        """
        if self._db is None or not concept_ids:
            return {}
        stmt = (
            select(
                FragmentConceptTag.concept_id,
                func.count(Fragment.id.distinct()).label("cnt"),
            )
            .join(Fragment, Fragment.id == FragmentConceptTag.fragment_id)
            .where(
                FragmentConceptTag.concept_id.in_(concept_ids),
                Fragment.status == "approved",
            )
            .group_by(FragmentConceptTag.concept_id)
        )
        result = await self._db.execute(stmt)
        return {row.concept_id: row.cnt for row in result}


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
