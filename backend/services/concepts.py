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
    get_concepts_for_search_by_ids,
    get_domain_roots,
    get_type_refinement_children,
    search_concept_ids,
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
from services.cache import get_tree_structure_cache, set_tree_structure_cache
from services.i18n import DEFAULT_LANGUAGE, fold
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
        """Concept search with cursor-based pagination, in the requested locale.

        English takes the Neo4j full-text path unchanged. A non-English locale
        takes the merged path of ADR-040: the same full-text query *and* a match
        against ``concept_translation``, unioned, so that a Spanish tagger finds
        a concept by its Spanish name and still finds one that has not been
        translated yet. The two differ in ordering as well as in recall — see
        :meth:`_search_merged`.

        Args:
            q: Search query; must be non-empty (validated upstream). Treated as
                a Lucene query string by the graph half.
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

        if language == DEFAULT_LANGUAGE:
            page_rows, has_more = await self._search_english(
                q=q, domain=domain, skip=skip
            )
            translations: dict[str, object] = {}
        else:
            page_rows, has_more, translations = await self._search_merged(
                q=q, domain=domain, skip=skip, language=language
            )

        items = [self._search_item(row, translations, language) for row in page_rows]
        return ConceptSearchResponse(
            items=items,
            next_cursor=_encode_cursor(skip + _PAGE_SIZE) if has_more else None,
        )

    async def _search_english(
        self, *, q: str, domain: str | None, skip: int
    ) -> tuple[list[dict], bool]:
        """The canonical-English search path — unchanged by ADR-040.

        Requests ``_PAGE_SIZE + 1`` rows from Neo4j and uses the extra row to
        determine whether a next page exists, so callers never see the sentinel
        row in ``items``. Ordering, relevance score and cursor semantics are
        exactly what they were before the merged path existed; nothing new runs
        here, which is what keeps the common path free of regression risk.

        Args:
            q: Lucene query string.
            domain: Exact domain filter, or ``None``.
            skip: Cursor offset.

        Returns:
            The page's rows and whether a following page exists.
        """
        fetch = _PAGE_SIZE + 1  # request one extra to detect a next page
        async with self._driver.session() as session:
            rows = await search_concepts(
                session, q=q, domain=domain, skip=skip, limit=fetch
            )
        return rows[:_PAGE_SIZE], len(rows) == fetch

    async def _search_merged(
        self, *, q: str, domain: str | None, skip: int, language: str
    ) -> tuple[list[dict], bool, dict[str, object]]:
        """The merged cross-language search path (ADR-040 § 2, § 3, § 6).

        Matches in both stores, unions the ids, hydrates them from the graph and
        orders the union by the key the picker already uses — complexity band,
        then prerequisite depth — with the *translated* name, accent-folded, as
        the final tie-break.

        Two things about that ordering are deliberate. The relevance score is
        dropped rather than blended: two scorers over two languages are not on a
        common scale, and the score only ever ordered within a
        ``(complexity_rank, prereq_depth)`` bucket, so an alphabetical
        tie-break in the reader's own alphabet replaces an unexplainable order
        with an explainable one. And it fixes an omission — ``search`` was the
        one surface Step 19c overlaid without re-sorting, so Spanish results
        were until now tie-broken on the English name.

        Paging slices in the service because a ``SKIP`` pushed into either store
        names nothing in the merged order. ADR-040 § 6 records the size at which
        that stops being acceptable and what replaces it.

        Args:
            q: The user's query.
            domain: Exact domain filter, or ``None``.
            skip: Cursor offset into the merged order.
            language: A non-English locale.

        Returns:
            The page's rows, whether a following page exists, and the
            translations already fetched for them — the caller reuses these
            rather than reading the overlay twice.
        """
        overlay = self._overlay()
        async with self._driver.session() as session:
            graph_ids = await search_concept_ids(session, q=q, domain=domain)
            overlay_ids = await overlay.search_concept_ids(q, language)
            rows = await get_concepts_for_search_by_ids(
                session, ids=sorted(graph_ids | overlay_ids), domain=domain
            )

        # Ancestors too, not just the rows themselves: a result's hierarchy path
        # names concepts that are not among the matches, and fetching only the
        # matched ids left every ancestor English while the leaf was translated.
        wanted: set[str] = {row["id"] for row in rows}
        for row in rows:
            wanted.update(row.get("hierarchy_path_ids") or [])
        translations = await overlay.concept_translations(sorted(wanted), language)

        def order(row: dict) -> tuple[int, int, str]:
            t = translations.get(row["id"])
            return (
                row["complexity_rank"],
                row["prereq_depth"],
                _sort_key(t.name if t else row["name"]),
            )

        rows.sort(key=order)
        page = rows[skip : skip + _PAGE_SIZE]
        return page, len(rows) > skip + _PAGE_SIZE, translations

    def _search_item(
        self, row: dict, translations: dict, language: str
    ) -> ConceptSearchItem:
        """Build one search hit, overlaid into the requested locale.

        Shared by both search paths so a field cannot be localised on one and
        not the other. ``translations`` is empty on the English path, where the
        graph values are already the English record.

        Args:
            row: A raw search row from either path.
            translations: Concept translations keyed by id, ancestors included.
            language: The requested response language.

        Returns:
            The assembled :class:`~models.concepts.ConceptSearchItem`.
        """
        t = translations.get(row["id"])
        return ConceptSearchItem(
            id=row["id"],
            name=t.name if t else row["name"],
            aliases=(t.aliases if t and t.aliases is not None else row["aliases"])
            or [],
            hierarchy_path=localise_hierarchy_path(
                row["hierarchy_path"],
                row.get("hierarchy_path_ids"),
                translations,
            ),
            definition=(t.definition if t else row.get("definition")),
            translation_missing=is_translation_missing(
                language, translations, row["id"]
            ),
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

        Two reads, with different freshness requirements deliberately kept
        apart (Component 11 Step 8 / M11):

        1. The **structure** — the flat, translated node list with parent_id
           linkage and hierarchy paths — comes from
           :meth:`_get_tree_structure`, which is Redis-cached because the graph
           shape changes only on a re-seed.
        2. The **counts** — ``approved`` fragments per concept id
           (cross-reference tags, not only ``is_primary``) — are read live from
           PostgreSQL on every call and attached to the cached structure, so an
           approve / reject / delete / re-tag is reflected immediately. Counts
           are never written to the cache.

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
        structure = await self._get_tree_structure(root_id, language)
        counts = await self._fetch_fragment_counts([n["id"] for n in structure])

        nodes = [
            ConceptTreeNode(
                id=n["id"],
                name=n["name"],
                aliases=n["aliases"],
                hierarchy_path=n["hierarchy_path"],
                parent_id=n["parent_id"],
                fragment_count=counts.get(n["id"], 0),
                translation_missing=n["translation_missing"],
            )
            for n in structure
        ]
        return ConceptTreeResponse(root_id=root_id, nodes=nodes)

    async def _get_tree_structure(self, root_id: str, language: str) -> list[dict]:
        """Return the cached, count-free node structure for a concept subtree.

        Checks Redis (key ``tree:v2:{root_id}:{language}``) and returns the
        cached flat node list on a hit. On a miss, queries Neo4j for every
        non-stub concept in the IS_SUBTYPE_OF subtree, applies the translation
        overlay, and writes the result back with a 1-hour TTL (invalidated by
        ``scripts/seed.py`` after every re-seed — the only event that can change
        the shape).

        The payload deliberately carries **no** ``fragment_count``: see
        :meth:`get_tree`.

        Args:
            root_id: Immutable concept identifier for the tree root.
            language: Requested response language (part of the cache key).

        Returns:
            A flat list of node dicts with keys ``id``, ``name``, ``aliases``,
            ``hierarchy_path``, ``parent_id``, and ``translation_missing``.

        Raises:
            ConceptNotFoundError: If no non-stub Concept with ``root_id`` exists.
        """
        if self._redis is not None:
            cached = await get_tree_structure_cache(self._redis, root_id, language)
            if cached is not None:
                return cached

        async with self._driver.session() as neo4j_session:
            rows = await get_concept_subtree(neo4j_session, root_id)

        if not rows:
            raise ConceptNotFoundError(
                f"Concept '{root_id}' not found or is a stub.",
                detail={"concept_id": root_id},
            )

        # Ancestors included for the same reason as in `search`: a node's path
        # can reach above the subtree root.
        node_ids: set[str] = {r["id"] for r in rows}
        for r in rows:
            node_ids.update(r.get("hierarchy_path_ids") or [])
        translations = await self._overlay().concept_translations(
            sorted(node_ids), language
        )

        structure: list[dict] = []
        for r in rows:
            t = translations.get(r["id"])
            structure.append(
                {
                    "id": r["id"],
                    "name": t.name if t else r["name"],
                    "aliases": (
                        t.aliases if t and t.aliases is not None else r["aliases"]
                    )
                    or [],
                    "hierarchy_path": localise_hierarchy_path(
                        r["hierarchy_path"],
                        r.get("hierarchy_path_ids"),
                        translations,
                    ),
                    "parent_id": r["parent_id"],
                    "translation_missing": is_translation_missing(
                        language, translations, r["id"]
                    ),
                }
            )

        structure.sort(key=lambda node: _sort_key(node["name"]))

        if self._redis is not None:
            await set_tree_structure_cache(self._redis, root_id, language, structure)

        return structure

    async def get_public_detail(
        self, concept_id: str, language: str = DEFAULT_LANGUAGE
    ) -> ConceptDetailResponse:
        """Assemble the public concept-page payload for one concept.

        Runs two Neo4j queries within one session — the detail row (identity,
        flags, hierarchy, parent, children) and the typed relationships — and
        assembles them into a :class:`~models.concepts.ConceptDetailResponse`.

        Localised through the translation overlay (Component 12 Step 19c). This
        was English-only until then, which made the glossary — the largest
        reader-facing surface — the one place Spanish content never reached.
        Every concept name on the page goes through the overlay: the concept
        itself, its hierarchy path, its parent, its children, and the target of
        every relationship, so a page cannot be half-translated.

        The raw ``definition`` prose is returned as-is together with the
        ``definition_reviewed`` flag; whether to show the prose or a placeholder
        is the frontend's call (Step 2). A stub concept returns a valid payload
        with ``stub=true`` so its page can state its domain is not yet modelled.

        Args:
            concept_id: The immutable concept id to resolve.
            language: Requested response language.

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

        # One overlay read for every concept the page names — itself, its
        # ancestors, its parent, its children, and every relationship target —
        # so the page is translated as a whole rather than in patches.
        overlay_ids = {concept_id}
        overlay_ids.update(row.get("hierarchy_path_ids") or [])
        overlay_ids.update(c["id"] for c in row["children"])
        overlay_ids.update(r["target_id"] for r in rel_rows)
        if row["parent"] is not None:
            overlay_ids.add(row["parent"]["id"])
        translations = await self._overlay().concept_translations(
            sorted(overlay_ids), language
        )

        def _name(concept: str, english: str) -> str:
            """Translated name for a referenced concept, else its English name."""
            t = translations.get(concept)
            return t.name if t else english

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
                    name=_name(r["target_id"], r["target_name"]),
                    stub=r["target_stub"],
                ),
            )
            for r in rel_rows
        ]

        parent = (
            ConceptRef(
                id=row["parent"]["id"],
                name=_name(row["parent"]["id"], row["parent"]["name"]),
                stub=row["parent"]["stub"],
            )
            if row["parent"] is not None
            else None
        )
        children = [
            ConceptRef(id=c["id"], name=_name(c["id"], c["name"]), stub=c["stub"])
            for c in row["children"]
        ]

        own = translations.get(concept_id)
        return ConceptDetailResponse(
            id=row["id"],
            name=own.name if own else row["name"],
            aliases=(own.aliases if own and own.aliases is not None else row["aliases"])
            or [],
            definition=(own.definition if own else row["definition"]),
            domain=row["domain"],
            complexity=row["complexity"],
            stub=row["stub"],
            definition_reviewed=row["definition_reviewed"],
            top_level_taggable=row["top_level_taggable"],
            hierarchy_path=localise_hierarchy_path(
                row["hierarchy_path"], row.get("hierarchy_path_ids"), translations
            ),
            parent=parent,
            children=children,
            relationships=relationships,
            translation_missing=is_translation_missing(
                language, translations, concept_id
            ),
        )

    async def get_public_index(
        self, language: str = DEFAULT_LANGUAGE
    ) -> ConceptIndexResponse:
        """Assemble the public browse-by-domain concept index.

        Fetch every browsable root (Component 11 Step 4b: no ``IS_SUBTYPE_OF``
        parent and not a ``CONTAINS`` target), fetch each root's non-stub
        subtree, **group the roots by their ``domain`` field**, and emit one
        forest per domain — so a domain with several roots (e.g. cadences:
        ``Cadence`` + ``ClosingSection`` + ``StandingOnTheDominant``) renders as
        a single heading with several top-level entries, not as several
        "domains". Approved-fragment counts are attached in one batch read.

        Localised through the translation overlay (Component 12 Step 19c). This
        endpoint also backs the fragment browser's concept tree, which takes
        the public index whenever no ``?root`` narrowing is in play — so it was
        untranslated there too, not only in the glossary.

        Counts come from :meth:`_fetch_fragment_counts` — the same source the
        editor tree uses, read live per request and never cached (Step 8 / M11)
        — so the public index and the editor tree can never disagree, and no
        second count source is introduced here.

        Args:
            language: Requested response language.

        Returns:
            :class:`~models.concepts.ConceptIndexResponse` with one entry per
            domain (ordered by domain key), each carrying the forest of its
            browsable roots' subtrees. Empty ``domains`` when the graph has no
            browsable roots.
        """
        async with self._driver.session() as session:
            roots = await get_domain_roots(session)
            subtrees: dict[str, list[dict]] = {}
            for root in roots:
                subtrees[root["id"]] = await get_concept_subtree(session, root["id"])

        # Batch approved-fragment counts across every node in every domain.
        all_ids = [node["id"] for nodes in subtrees.values() for node in nodes]
        counts = await self._fetch_fragment_counts(all_ids)

        # One overlay read for the whole forest, ancestors included: a node's
        # hierarchy path can name a concept that is not itself in the forest.
        overlay_ids = set(all_ids)
        for nodes in subtrees.values():
            for node in nodes:
                overlay_ids.update(node.get("hierarchy_path_ids") or [])
        translations = await self._overlay().concept_translations(
            sorted(overlay_ids), language
        )

        # Group roots by domain, preserving the name-ordered root sequence; a
        # root with no domain (defensive — every seeded concept has one) is
        # bucketed under an empty-string key so it is never silently dropped.
        roots_by_domain: dict[str, list[dict]] = {}
        for root in roots:
            roots_by_domain.setdefault(root.get("domain") or "", []).append(root)

        domains: list[ConceptIndexDomain] = []
        for domain_key in sorted(roots_by_domain):
            nodes = [
                ConceptIndexNode(
                    id=n["id"],
                    name=(
                        translations[n["id"]].name
                        if n["id"] in translations
                        else n["name"]
                    ),
                    aliases=(
                        translations[n["id"]].aliases
                        if n["id"] in translations
                        and translations[n["id"]].aliases is not None
                        else n["aliases"]
                    )
                    or [],
                    hierarchy_path=localise_hierarchy_path(
                        n["hierarchy_path"],
                        n.get("hierarchy_path_ids"),
                        translations,
                    ),
                    parent_id=n["parent_id"],
                    fragment_count=counts.get(n["id"], 0),
                )
                for root in roots_by_domain[domain_key]
                for n in subtrees[root["id"]]
            ]
            nodes.sort(key=lambda node: _sort_key(node.name))
            domains.append(
                ConceptIndexDomain(
                    domain=domain_key,
                    label=_domain_label(domain_key),
                    nodes=nodes,
                )
            )
        return ConceptIndexResponse(domains=domains)

    async def _fetch_fragment_counts(self, concept_ids: list[str]) -> dict[str, int]:
        """Return approved fragment counts keyed by concept_id.

        Counts every fragment whose concept tags include a concept in the list,
        regardless of ``is_primary``.  Only ``approved`` fragments are counted
        (the "browse the finished corpus" baseline).

        This is the **single** count source for every browse surface (editor
        concept tree and public glossary index alike) and is intentionally
        uncached: the result changes on every fragment approve / reject / delete
        / re-tag, so caching it is what made counts go stale before Component 11
        Step 8 (M11). It is one grouped PostgreSQL query over an ``IN`` list.

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
# Public-index helpers (module-private)
# ---------------------------------------------------------------------------


def _domain_label(domain_key: str) -> str:
    """Derive a display heading from a machine-readable domain key.

    ``"cadences"`` → ``"Cadences"``, ``"formal-function"`` → ``"Formal
    Function"``. Deliberately simple (Component 11 Step 4b): a ``Domain`` node
    ``label`` property can supply a curated string later without changing the
    response shape. An empty key (a concept with no ``domain``) yields an empty
    label; the frontend can render such a group under a neutral fallback.
    """
    return domain_key.replace("-", " ").title()


# ---------------------------------------------------------------------------
# Schema-tree helpers (module-private)
# ---------------------------------------------------------------------------


def _sort_key(name: str) -> str:
    """Case- and accent-insensitive sort key for a display name.

    The Cypher orders by the *English* name, so once a payload is overlaid the
    list is no longer in the alphabetical order its contract promises: the
    Spanish cadence forest came back Abandonada, Auténtica, (Realizada),
    Cadencia, Rota. Re-sorting on the translated name restores it.

    Delegates to :func:`services.i18n.fold`, which is also what the merged
    search matches on (ADR-040 § 2) — sorting and matching must fold alike or a
    result lands somewhere the reader cannot predict.
    """
    return fold(name)


def localise_hierarchy_path(
    names: list[str] | None,
    ids: list[str] | None,
    translations: dict,
) -> list[str]:
    """Overlay a hierarchy path's element names, falling back per element.

    The Cypher returns the path twice — as names and as ids — because the path
    is a list of *display strings* with no key to translate by on its own. The
    ids are that key (Component 12 Step 19c).

    Falls back per element rather than per path: a path whose middle ancestor
    has no translation row still localises the rest, which matters because the
    cadence hierarchy mixes translated concepts with stubs.

    Args:
        names: English names from the graph, root → leaf.
        ids: Concept ids in the same order, or ``None`` on a payload predating
            the id projection.
        translations: Concept-id → translation map for the requested locale.

    Returns:
        The path with every element that has a translation replaced, same
        order and length as ``names``.
    """
    names = names or []
    if not ids or len(ids) != len(names):
        # No usable key: return the English path rather than a partial one.
        return list(names)
    return [
        (translations[cid].name if cid in translations else name)
        for name, cid in zip(names, ids)
    ]


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
                stub=bool(v.get("referenced_concept_stub")),
                translation_missing=is_translation_missing(language, concept_t, ref_id),
            )
        vt = value_t.get(v["id"])
        values.append(
            PropertyValueItem(
                id=v["id"],
                name=vt.name if vt else v["name"],
                # Per field, not per row (migration 0015). A translation row
                # localises the name but may leave the short form or the gloss
                # null — most values have neither — and null there means "use
                # the English graph value", not "this value has none". Falling
                # back per row instead would blank a short name the graph does
                # have, the moment any Spanish row existed.
                short_name=(
                    vt.short_name if vt and vt.short_name else v.get("short_name")
                ),
                description=(
                    vt.description if vt and vt.description else v.get("description")
                ),
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
