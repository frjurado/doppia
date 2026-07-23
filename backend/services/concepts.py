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
    get_concept_detail,
    get_concept_property_schemas,
    get_concept_relationships,
    get_concept_subtree,
    get_domain_roots,
    get_type_refinement_children,
    search_concepts,
)
from models.concepts import (
    ConceptDetailResponse,
    ConceptIndexDomain,
    ConceptIndexNode,
    ConceptIndexResponse,
    ConceptRef,
    ConceptRelationship,
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
from services.i18n import DEFAULT_LANGUAGE
from services.translation import TranslationOverlay, is_translation_missing
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

# How many items to return per page.
_PAGE_SIZE: int = 20


class ConceptService:
    """Business logic for concept search, schema retrieval, and tree navigation.

    Args:
        driver: The application-scoped async Neo4j driver.
        db: Async SQLAlchemy session; used for fragment counts (``get_tree``)
            and the translation overlay on non-English reads (ADR-006). May be
            ``None`` only when every read is English-only (the overlay
            short-circuits ``'en'`` without touching the session).
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

    def _overlay(self) -> TranslationOverlay:
        """Return a translation overlay bound to this service's DB session.

        The overlay short-circuits for English (``DEFAULT_LANGUAGE``) without
        touching the session, so a ``None`` ``db`` is tolerated on the
        English-only path; any non-English request requires a session.
        """
        return TranslationOverlay(self._db)  # type: ignore[arg-type]

    async def search(
        self,
        *,
        q: str,
        domain: str | None = None,
        cursor: str | None = None,
        language: str = DEFAULT_LANGUAGE,
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
            language: Requested response language; English values are overlaid
                with the requested locale where a translation exists (ADR-006).

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

        translations = await self._overlay().concept_translations(
            [row["id"] for row in page_rows], language
        )

        items: list[ConceptSearchItem] = []
        for row in page_rows:
            t = translations.get(row["id"])
            items.append(
                ConceptSearchItem(
                    id=row["id"],
                    name=t.name if t else row["name"],
                    aliases=(
                        t.aliases if t and t.aliases is not None else row["aliases"]
                    )
                    or [],
                    hierarchy_path=row["hierarchy_path"] or [],
                    definition=(t.definition if t else row.get("definition")),
                    translation_missing=is_translation_missing(
                        language, translations, row["id"]
                    ),
                )
            )

        return ConceptSearchResponse(
            items=items,
            next_cursor=_encode_cursor(skip + _PAGE_SIZE) if has_more else None,
        )

    async def get_schema_tree(
        self, concept_id: str, language: str = DEFAULT_LANGUAGE
    ) -> ConceptSchemaTreeResponse:
        """Fetch the full schema tree for a concept.

        Runs four Neo4j queries sequentially within one session:
        existence check, property schemas, CONTAINS stages, and type-refinement
        children.  Raises :class:`~errors.ConceptNotFoundError` (→ HTTP 404) if
        the concept id is unknown.

        Args:
            concept_id: Immutable concept identifier (e.g.
                ``"PerfectAuthenticCadence"``).
            language: Requested response language; schema/value/referenced-concept
                labels are overlaid with the requested locale where a
                translation exists (ADR-006).

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

        # Collect every translatable id across the three row sets, then resolve
        # the overlay in one batch per table.
        schema_ids = [row["schema_id"] for row in schemas_rows]
        value_ids: list[str] = []
        concept_ref_ids: set[str] = set()
        for row in schemas_rows:
            for v in row["values"]:
                value_ids.append(v["id"])
                if v.get("referenced_concept_id") is not None:
                    concept_ref_ids.add(v["referenced_concept_id"])
        concept_ref_ids.update(row["target_id"] for row in stages_rows)
        concept_ref_ids.update(row["child_id"] for row in children_rows)

        overlay = self._overlay()
        schema_t = await overlay.schema_translations(schema_ids, language)
        value_t = await overlay.value_translations(value_ids, language)
        concept_t = await overlay.concept_translations(list(concept_ref_ids), language)

        schemas = [
            _build_schema_item(row, language, schema_t, value_t, concept_t)
            for row in schemas_rows
        ]
        stages = [
            ContainsStageItem(
                target_id=row["target_id"],
                target_name=(
                    concept_t[row["target_id"]].name
                    if row["target_id"] in concept_t
                    else row["target_name"]
                ),
                order=row["order"],
                required=row["required"],
                display_mode=row["display_mode"],
                containment_mode=row["containment_mode"],
                default_weight=row["default_weight"],
                translation_missing=is_translation_missing(
                    language, concept_t, row["target_id"]
                ),
            )
            for row in stages_rows
        ]
        type_refinement = _compute_type_refinement(children_rows, language, concept_t)

        return ConceptSchemaTreeResponse(
            concept_id=concept_id,
            schemas=schemas,
            stages=stages,
            type_refinement=type_refinement,
        )

    async def get_roots(self, language: str = DEFAULT_LANGUAGE) -> ConceptRootsResponse:
        """Return all domain root concepts (non-stub nodes with no IS_SUBTYPE_OF parent).

        Domain roots are the natural entry points for the concept-tree navigator.
        Results are ordered alphabetically by name.

        Args:
            language: Requested response language; root names/aliases are
                overlaid with the requested locale where a translation exists.

        Returns:
            :class:`~models.concepts.ConceptRootsResponse` with a list of root items.
        """
        async with self._driver.session() as session:
            rows = await get_domain_roots(session)

        translations = await self._overlay().concept_translations(
            [r["id"] for r in rows], language
        )
        roots: list[ConceptRootItem] = []
        for r in rows:
            t = translations.get(r["id"])
            roots.append(
                ConceptRootItem(
                    id=r["id"],
                    name=t.name if t else r["name"],
                    aliases=(t.aliases if t and t.aliases is not None else r["aliases"])
                    or [],
                    translation_missing=is_translation_missing(
                        language, translations, r["id"]
                    ),
                )
            )
        return ConceptRootsResponse(roots=roots)

    async def get_tree(
        self, root_id: str, language: str = DEFAULT_LANGUAGE
    ) -> ConceptTreeResponse:
        """Return the concept subtree rooted at root_id for the tag browser.

        Performs three operations:

        1. Checks Redis for a cached ``ConceptTreeResponse`` (key
           ``tree:{root_id}:{language}``); returns it immediately on a hit.
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
            language: Requested response language; node names/aliases are
                overlaid with the requested locale where a translation exists.
                The cache entry is keyed per language.

        Returns:
            :class:`~models.concepts.ConceptTreeResponse` with a flat node
            list ordered alphabetically.

        Raises:
            ConceptNotFoundError: If no non-stub Concept with ``root_id`` exists.
        """
        if self._redis is not None:
            cached = await get_tree_cache(self._redis, root_id, language)
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
        translations = await self._overlay().concept_translations(node_ids, language)

        nodes = []
        for r in rows:
            t = translations.get(r["id"])
            nodes.append(
                ConceptTreeNode(
                    id=r["id"],
                    name=t.name if t else r["name"],
                    aliases=(t.aliases if t and t.aliases is not None else r["aliases"])
                    or [],
                    hierarchy_path=r["hierarchy_path"] or [],
                    parent_id=r["parent_id"],
                    fragment_count=counts.get(r["id"], 0),
                    translation_missing=is_translation_missing(
                        language, translations, r["id"]
                    ),
                )
            )

        response = ConceptTreeResponse(root_id=root_id, nodes=nodes)

        if self._redis is not None:
            await set_tree_cache(self._redis, root_id, language, response.model_dump())

        return response

    async def get_public_detail(self, concept_id: str) -> ConceptDetailResponse:
        """Assemble the public concept-page payload for one concept.

        Runs two Neo4j queries within one session — the detail row (identity,
        flags, hierarchy, parent, children) and the typed relationships — and
        assembles them into a :class:`~models.concepts.ConceptDetailResponse`.
        English-only: the public glossary carries no translation overlay in
        Phase 2 (i18n is deferred to Track M / Component 12).

        The raw ``definition`` prose is returned as-is together with the
        ``definition_reviewed`` flag; whether to show the prose or a placeholder
        is the frontend's call (Step 2). A stub concept returns a valid payload
        with ``stub=true`` so its page can state its domain is not yet modelled.

        Args:
            concept_id: The immutable concept id to resolve.

        Returns:
            :class:`~models.concepts.ConceptDetailResponse`.

        Raises:
            ConceptNotFoundError: If no Concept node with ``concept_id`` exists.
        """
        async with self._driver.session() as session:
            row = await get_concept_detail(session, concept_id)
            if row is None:
                raise ConceptNotFoundError(
                    f"Concept '{concept_id}' not found.",
                    detail={"concept_id": concept_id},
                )
            rel_rows = await get_concept_relationships(session, concept_id)

        # Sort relationships deterministically for a stable page: by edge type,
        # then outgoing before incoming, then target name.
        rel_rows.sort(
            key=lambda r: (
                r["rel_type"],
                r["direction"] != "outgoing",
                r["target_name"],
            )
        )
        relationships = [
            ConceptRelationship(
                type=r["rel_type"],
                direction=r["direction"],
                target=ConceptRef(
                    id=r["target_id"],
                    name=r["target_name"],
                    stub=r["target_stub"],
                ),
            )
            for r in rel_rows
        ]

        parent = (
            ConceptRef(
                id=row["parent"]["id"],
                name=row["parent"]["name"],
                stub=row["parent"]["stub"],
            )
            if row["parent"] is not None
            else None
        )
        children = [
            ConceptRef(id=c["id"], name=c["name"], stub=c["stub"])
            for c in row["children"]
        ]

        return ConceptDetailResponse(
            id=row["id"],
            name=row["name"],
            aliases=row["aliases"] or [],
            definition=row["definition"],
            domain=row["domain"],
            complexity=row["complexity"],
            stub=row["stub"],
            definition_reviewed=row["definition_reviewed"],
            top_level_taggable=row["top_level_taggable"],
            hierarchy_path=row["hierarchy_path"] or [],
            parent=parent,
            children=children,
            relationships=relationships,
        )

    async def get_public_index(self) -> ConceptIndexResponse:
        """Assemble the public browse-by-domain concept index.

        For every non-stub domain root, fetch its non-stub ``IS_SUBTYPE_OF``
        subtree, then attach approved-fragment counts in a single batch read.
        English-only (no translation overlay in the Phase-2 public glossary).

        Counts come from :meth:`_fetch_fragment_counts` — the same source the
        editor tree uses — so the M11 count-cache fix (Step 8) de-stales the
        public index and the editor tree together, and no second count source is
        introduced here.

        Returns:
            :class:`~models.concepts.ConceptIndexResponse` with one entry per
            domain root (ordered by root name), each carrying its flat subtree.
            Empty ``domains`` when the graph has no non-stub roots.
        """
        async with self._driver.session() as session:
            roots = await get_domain_roots(session)
            subtrees: dict[str, list[dict]] = {}
            for root in roots:
                subtrees[root["id"]] = await get_concept_subtree(session, root["id"])

        # Batch approved-fragment counts across every node in every domain.
        all_ids = [node["id"] for nodes in subtrees.values() for node in nodes]
        counts = await self._fetch_fragment_counts(all_ids)

        domains: list[ConceptIndexDomain] = []
        for root in roots:
            nodes = [
                ConceptIndexNode(
                    id=n["id"],
                    name=n["name"],
                    aliases=n["aliases"] or [],
                    hierarchy_path=n["hierarchy_path"] or [],
                    parent_id=n["parent_id"],
                    fragment_count=counts.get(n["id"], 0),
                )
                for n in subtrees[root["id"]]
            ]
            domains.append(
                ConceptIndexDomain(
                    root_id=root["id"],
                    root_name=root["name"],
                    nodes=nodes,
                )
            )
        return ConceptIndexResponse(domains=domains)

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


def _build_schema_item(
    row: dict,
    language: str,
    schema_t: dict,
    value_t: dict,
    concept_t: dict,
) -> PropertySchemaItem:
    """Assemble a :class:`~models.concepts.PropertySchemaItem` from a raw query row.

    Schema, value, and referenced-concept labels are overlaid from the supplied
    translation maps (empty for English); ``translation_missing`` is set per
    item when the requested non-English locale has no record.
    """
    values: list[PropertyValueItem] = []
    for v in row["values"]:
        ref: ReferencedConcept | None = None
        if v.get("referenced_concept_id") is not None:
            ref_id = v["referenced_concept_id"]
            ct = concept_t.get(ref_id)
            ref = ReferencedConcept(
                id=ref_id,
                name=ct.name if ct else v["referenced_concept_name"],
                definition=(
                    ct.definition if ct else v.get("referenced_concept_definition")
                ),
                translation_missing=is_translation_missing(language, concept_t, ref_id),
            )
        vt = value_t.get(v["id"])
        values.append(
            PropertyValueItem(
                id=v["id"],
                name=vt.name if vt else v["name"],
                order=v.get("order"),
                referenced_concept=ref,
                translation_missing=is_translation_missing(language, value_t, v["id"]),
            )
        )
    st = schema_t.get(row["schema_id"])
    return PropertySchemaItem(
        id=row["schema_id"],
        name=st.name if st else row["schema_name"],
        description=st.description if st else row.get("schema_description"),
        cardinality=row["cardinality"],
        required=row["required"],
        order=row.get("order"),
        group=row.get("group"),
        values=values,
        translation_missing=is_translation_missing(
            language, schema_t, row["schema_id"]
        ),
    )


def _compute_type_refinement(
    children_rows: list[dict],
    language: str,
    concept_t: dict,
) -> TypeRefinement:
    """Determine whether Type Refinement should be shown.

    Compares the CONTAINS fingerprints of all direct non-stub children.  If
    fewer than two children exist, or all fingerprints are identical, no
    refinement section is needed.

    Args:
        children_rows: Raw rows from :func:`~graph.queries.concepts.get_type_refinement_children`.
        language: Requested response language.
        concept_t: Concept translation map keyed by child concept id (empty for
            English).

    Returns:
        :class:`~models.concepts.TypeRefinement` with ``show=True`` and all
        children when structures differ, or ``show=False`` with an empty list.
    """
    if len(children_rows) <= 1:
        return TypeRefinement(show=False)

    fingerprints = [frozenset(row["fingerprint"]) for row in children_rows]
    if len(set(fingerprints)) == 1:
        return TypeRefinement(show=False)

    children: list[TypeRefinementChild] = []
    for row in children_rows:
        ct = concept_t.get(row["child_id"])
        children.append(
            TypeRefinementChild(
                id=row["child_id"],
                name=ct.name if ct else row["child_name"],
                definition=ct.definition if ct else row["child_definition"],
                translation_missing=is_translation_missing(
                    language, concept_t, row["child_id"]
                ),
            )
        )
    return TypeRefinement(show=True, children=children)


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
