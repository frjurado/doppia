"""PostgreSQL translation overlay for Neo4j knowledge content (ADR-006 §3).

The knowledge graph in Neo4j holds English values only. Localised
``name``/``aliases``/``definition`` (concepts), ``name``/``description``
(property schemas), and ``name`` (property values) live in PostgreSQL
translation tables keyed by ``(<id>, language)``. The service layer fetches
the canonical English node from Neo4j and overlays the requested locale here.

This module owns those lookups; route handlers never touch it directly
(invariant: the service layer owns cross-database joins). All reads are
batched — one query per table per request — and the canonical-English path
(``language == 'en'``) short-circuits to avoid a redundant round-trip, since
the English values are already carried on the Neo4j rows.
"""

from __future__ import annotations

from dataclasses import dataclass

from services.i18n import DEFAULT_LANGUAGE
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass(frozen=True)
class ConceptTranslation:
    """Localised concept fields from ``concept_translation``."""

    name: str
    aliases: list[str] | None
    definition: str | None


@dataclass(frozen=True)
class SchemaTranslation:
    """Localised property-schema fields from ``property_schema_translation``."""

    name: str
    description: str | None


@dataclass(frozen=True)
class ValueTranslation:
    """Localised property-value field from ``property_value_translation``."""

    name: str


_CONCEPT_SQL = text(
    "SELECT concept_id, name, aliases, definition "
    "FROM concept_translation "
    "WHERE concept_id = ANY(:ids) AND language = :language"
)

_SCHEMA_SQL = text(
    "SELECT schema_id, name, description "
    "FROM property_schema_translation "
    "WHERE schema_id = ANY(:ids) AND language = :language"
)

_VALUE_SQL = text(
    "SELECT value_id, name "
    "FROM property_value_translation "
    "WHERE value_id = ANY(:ids) AND language = :language"
)


def is_translation_missing(language: str, translated_ids: object, item_id: str) -> bool:
    """Return whether ``item_id`` lacks a translation for the requested locale.

    Canonical English is never "missing" (the graph value *is* the English
    record). For any other language, an id absent from the overlay result is
    flagged so the frontend can render an indicator (ADR-006 §6).

    Args:
        language: The requested response language.
        translated_ids: A membership-testable container of ids that *do* have a
            translation record (e.g. the keys of an overlay dict).
        item_id: The id being rendered.

    Returns:
        ``True`` when a non-English translation is absent for ``item_id``.
    """
    return language != DEFAULT_LANGUAGE and item_id not in translated_ids


class TranslationOverlay:
    """Batched read-side translation lookups for the requested locale.

    Args:
        db: Async SQLAlchemy session bound to PostgreSQL.
    """

    def __init__(self, db: AsyncSession) -> None:
        self._db = db

    async def concept_translations(
        self, ids: list[str], language: str
    ) -> dict[str, ConceptTranslation]:
        """Return concept translations keyed by concept id for ``language``.

        Returns an empty dict for the canonical English path (short-circuit)
        or when ``ids`` is empty.

        Args:
            ids: Concept ids to look up.
            language: Requested response language.

        Returns:
            Mapping of concept id → :class:`ConceptTranslation` for ids that
            have a record in the requested language.
        """
        if language == DEFAULT_LANGUAGE or not ids:
            return {}
        result = await self._db.execute(
            _CONCEPT_SQL, {"ids": ids, "language": language}
        )
        return {
            row.concept_id: ConceptTranslation(
                name=row.name, aliases=row.aliases, definition=row.definition
            )
            for row in result
        }

    async def schema_translations(
        self, ids: list[str], language: str
    ) -> dict[str, SchemaTranslation]:
        """Return property-schema translations keyed by schema id for ``language``."""
        if language == DEFAULT_LANGUAGE or not ids:
            return {}
        result = await self._db.execute(_SCHEMA_SQL, {"ids": ids, "language": language})
        return {
            row.schema_id: SchemaTranslation(name=row.name, description=row.description)
            for row in result
        }

    async def value_translations(
        self, ids: list[str], language: str
    ) -> dict[str, ValueTranslation]:
        """Return property-value translations keyed by value id for ``language``."""
        if language == DEFAULT_LANGUAGE or not ids:
            return {}
        result = await self._db.execute(_VALUE_SQL, {"ids": ids, "language": language})
        return {row.value_id: ValueTranslation(name=row.name) for row in result}
