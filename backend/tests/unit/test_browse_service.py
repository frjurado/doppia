"""Unit tests for backend/services/browse.py.

All database I/O is replaced with AsyncMock so no running PostgreSQL is needed.
The storage client is mocked wherever signed URLs are expected.

Test structure:
    TestListComposers     — ordering, empty list
    TestListCorpora       — 404 on unknown composer, work_count aggregate
    TestListWorks         — 404 on unknown composer/corpus, movement_count aggregate
    TestListMovements     — 404 on unknown work, incipit_url resolution, null incipit
"""

from __future__ import annotations

import uuid
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from services.browse import list_composers, list_corpora, list_movements, list_works

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_composer(**kwargs: Any) -> MagicMock:
    """Return a mock Composer with sensible defaults."""
    c = MagicMock(
        spec_set=[
            "id",
            "slug",
            "name",
            "sort_name",
            "birth_year",
            "death_year",
            "composer_id",
        ]
    )
    c.id = kwargs.get("id", uuid.uuid4())
    c.slug = kwargs.get("slug", "mozart")
    c.name = kwargs.get("name", "Wolfgang Amadeus Mozart")
    c.sort_name = kwargs.get("sort_name", "Mozart, Wolfgang Amadeus")
    c.birth_year = kwargs.get("birth_year", 1756)
    c.death_year = kwargs.get("death_year", 1791)
    return c


def _make_corpus(**kwargs: Any) -> MagicMock:
    c = MagicMock(
        spec_set=["id", "slug", "title", "source_repository", "licence", "composer_id"]
    )
    c.id = kwargs.get("id", uuid.uuid4())
    c.slug = kwargs.get("slug", "piano-sonatas")
    c.title = kwargs.get("title", "Piano Sonatas")
    c.source_repository = kwargs.get("source_repository", "DCMLab/mozart_piano_sonatas")
    c.licence = kwargs.get("licence", "CC-BY-SA-4.0")
    c.composer_id = kwargs.get("composer_id", uuid.uuid4())
    return c


def _make_work(**kwargs: Any) -> MagicMock:
    w = MagicMock(
        spec_set=[
            "id",
            "slug",
            "title",
            "catalogue_number",
            "year_composed",
            "corpus_id",
        ]
    )
    w.id = kwargs.get("id", uuid.uuid4())
    w.slug = kwargs.get("slug", "k331")
    w.title = kwargs.get("title", "Piano Sonata No. 11 in A major")
    w.catalogue_number = kwargs.get("catalogue_number", "K. 331")
    w.year_composed = kwargs.get("year_composed", 1783)
    w.corpus_id = kwargs.get("corpus_id", uuid.uuid4())
    return w


def _make_movement(**kwargs: Any) -> MagicMock:
    m = MagicMock(
        spec_set=[
            "id",
            "slug",
            "movement_number",
            "title",
            "tempo_marking",
            "key_signature",
            "meter",
            "duration_bars",
            "incipit_object_key",
            "work_id",
        ]
    )
    m.id = kwargs.get("id", uuid.uuid4())
    m.slug = kwargs.get("slug", "movement-1")
    m.movement_number = kwargs.get("movement_number", 1)
    m.title = kwargs.get("title", "Tema con Variazioni")
    m.tempo_marking = kwargs.get("tempo_marking", "Andante grazioso")
    m.key_signature = kwargs.get("key_signature", "A major")
    m.meter = kwargs.get("meter", "6/8")
    m.duration_bars = kwargs.get("duration_bars", 96)
    m.incipit_object_key = kwargs.get("incipit_object_key", None)
    m.work_id = kwargs.get("work_id", uuid.uuid4())
    return m


def _mock_db_scalar(value: Any) -> AsyncMock:
    """Return a mock db.execute() result whose scalar_one_or_none() returns value."""
    result = MagicMock()
    result.scalar_one_or_none.return_value = value
    db = AsyncMock()
    db.execute.return_value = result
    return db


def _mock_db_scalars(items: list[Any]) -> AsyncMock:
    """Return a mock db.execute() result whose scalars().all() returns items."""
    scalars = MagicMock()
    scalars.all.return_value = items
    result = MagicMock()
    result.scalars.return_value = scalars
    db = AsyncMock()
    db.execute.return_value = result
    return db


# ---------------------------------------------------------------------------
# TestListComposers
# ---------------------------------------------------------------------------


class TestListComposers:
    @pytest.mark.asyncio
    async def test_returns_all_composers_ordered(self) -> None:
        bach = _make_composer(slug="bach", sort_name="Bach, Johann Sebastian")
        mozart = _make_composer(slug="mozart", sort_name="Mozart, Wolfgang Amadeus")
        db = _mock_db_scalars([bach, mozart])

        result = await list_composers(db)

        assert len(result) == 2
        assert result[0].slug == "bach"
        assert result[1].slug == "mozart"

    @pytest.mark.asyncio
    async def test_empty_list(self) -> None:
        db = _mock_db_scalars([])
        result = await list_composers(db)
        assert result == []

    @pytest.mark.asyncio
    async def test_response_fields(self) -> None:
        composer = _make_composer()
        db = _mock_db_scalars([composer])

        result = await list_composers(db)

        item = result[0]
        assert item.id == composer.id
        assert item.slug == composer.slug
        assert item.name == composer.name
        assert item.sort_name == composer.sort_name
        assert item.birth_year == composer.birth_year
        assert item.death_year == composer.death_year


# ---------------------------------------------------------------------------
# TestListCorpora
# ---------------------------------------------------------------------------


class TestListCorpora:
    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_composer(self) -> None:
        # First execute call (composer lookup) returns None.
        result_mock = MagicMock()
        result_mock.scalar_one_or_none.return_value = None
        db = AsyncMock()
        db.execute.return_value = result_mock

        result = await list_corpora("unknown", db)

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_corpora_with_work_count(self) -> None:
        composer = _make_composer()
        corpus = _make_corpus(composer_id=composer.id)
        work_count = 18

        execute_results = [
            # First call: composer lookup
            MagicMock(**{"scalar_one_or_none.return_value": composer}),
            # Second call: corpora + work_count join
            MagicMock(**{"all.return_value": [(corpus, work_count)]}),
        ]
        db = AsyncMock()
        db.execute.side_effect = execute_results

        result = await list_corpora("mozart", db)

        assert result is not None
        assert len(result) == 1
        item = result[0]
        assert item.id == corpus.id
        assert item.slug == corpus.slug
        assert item.work_count == work_count
        assert item.source_repository == corpus.source_repository

    @pytest.mark.asyncio
    async def test_empty_corpora_list(self) -> None:
        composer = _make_composer()
        execute_results = [
            MagicMock(**{"scalar_one_or_none.return_value": composer}),
            MagicMock(**{"all.return_value": []}),
        ]
        db = AsyncMock()
        db.execute.side_effect = execute_results

        result = await list_corpora("mozart", db)

        assert result == []


# ---------------------------------------------------------------------------
# TestListWorks
# ---------------------------------------------------------------------------


class TestListWorks:
    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_composer(self) -> None:
        result_mock = MagicMock()
        result_mock.scalar_one_or_none.return_value = None
        db = AsyncMock()
        db.execute.return_value = result_mock

        result = await list_works("unknown", "piano-sonatas", db)

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_corpus(self) -> None:
        composer = _make_composer()
        execute_results = [
            MagicMock(**{"scalar_one_or_none.return_value": composer}),
            MagicMock(**{"scalar_one_or_none.return_value": None}),
        ]
        db = AsyncMock()
        db.execute.side_effect = execute_results

        result = await list_works("mozart", "nonexistent", db)

        assert result is None

    @pytest.mark.asyncio
    async def test_returns_works_with_movement_count(self) -> None:
        composer = _make_composer()
        corpus = _make_corpus(composer_id=composer.id)
        work = _make_work(corpus_id=corpus.id)
        movement_count = 3

        execute_results = [
            MagicMock(**{"scalar_one_or_none.return_value": composer}),
            MagicMock(**{"scalar_one_or_none.return_value": corpus}),
            MagicMock(**{"all.return_value": [(work, movement_count)]}),
        ]
        db = AsyncMock()
        db.execute.side_effect = execute_results

        result = await list_works("mozart", "piano-sonatas", db)

        assert result is not None
        assert len(result) == 1
        item = result[0]
        assert item.id == work.id
        assert item.slug == work.slug
        assert item.catalogue_number == work.catalogue_number
        assert item.movement_count == movement_count


# ---------------------------------------------------------------------------
# TestListMovements
# ---------------------------------------------------------------------------


class TestListMovements:
    @pytest.mark.asyncio
    async def test_returns_none_for_unknown_work(self) -> None:
        result_mock = MagicMock()
        result_mock.scalar_one_or_none.return_value = None
        db = AsyncMock()
        db.execute.return_value = result_mock

        storage = AsyncMock()
        result = await list_movements(uuid.uuid4(), db, storage)

        assert result is None

    @pytest.mark.asyncio
    async def test_incipit_url_is_none_when_not_generated(self) -> None:
        work = _make_work()
        movement = _make_movement(work_id=work.id, incipit_object_key=None)

        execute_results = [
            MagicMock(**{"scalar_one_or_none.return_value": work}),
            MagicMock(
                **{
                    "scalars.return_value": MagicMock(
                        **{"all.return_value": [movement]}
                    )
                }
            ),
        ]
        db = AsyncMock()
        db.execute.side_effect = execute_results

        storage = AsyncMock()
        result = await list_movements(work.id, db, storage)

        assert result is not None
        assert result[0].incipit_url is None
        assert result[0].incipit_ready is False
        storage.signed_url.assert_not_called()

    @pytest.mark.asyncio
    async def test_incipit_url_resolved_when_key_present(self) -> None:
        work = _make_work()
        key = "mozart/piano-sonatas/k331/movement-1/incipit.svg"
        movement = _make_movement(work_id=work.id, incipit_object_key=key)
        signed = "https://example.com/signed-url"

        execute_results = [
            MagicMock(**{"scalar_one_or_none.return_value": work}),
            MagicMock(
                **{
                    "scalars.return_value": MagicMock(
                        **{"all.return_value": [movement]}
                    )
                }
            ),
        ]
        db = AsyncMock()
        db.execute.side_effect = execute_results

        storage = AsyncMock()
        storage.signed_url = AsyncMock(return_value=signed)

        result = await list_movements(work.id, db, storage)

        assert result is not None
        assert result[0].incipit_url == signed
        assert result[0].incipit_ready is True
        storage.signed_url.assert_awaited_once_with(key, expires_in=900)

    @pytest.mark.asyncio
    async def test_movement_fields(self) -> None:
        work = _make_work()
        movement = _make_movement(work_id=work.id)

        execute_results = [
            MagicMock(**{"scalar_one_or_none.return_value": work}),
            MagicMock(
                **{
                    "scalars.return_value": MagicMock(
                        **{"all.return_value": [movement]}
                    )
                }
            ),
        ]
        db = AsyncMock()
        db.execute.side_effect = execute_results

        result = await list_movements(work.id, db, AsyncMock())

        assert result is not None
        item = result[0]
        assert item.id == movement.id
        assert item.slug == movement.slug
        assert item.movement_number == movement.movement_number
        assert item.title == movement.title
        assert item.tempo_marking == movement.tempo_marking
        assert item.key_signature == movement.key_signature
        assert item.meter == movement.meter
        assert item.duration_bars == movement.duration_bars
