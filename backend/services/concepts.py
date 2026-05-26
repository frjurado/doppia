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

from graph.queries.concepts import search_concepts
from models.concepts import ConceptSearchItem, ConceptSearchResponse
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
