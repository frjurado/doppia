"""The Spanish overlay against the live translation tables (Step 19b).

Every other test of `TranslationOverlay` supplies its own fake rows. These read
what `scripts/seed.py --all` actually wrote from
`backend/seed/translations/es.yaml`, so they cover the one seam no unit test
can: that the seed file, the table columns and the read path agree.

Requires a seeded database — `python scripts/seed.py --all` with the Spanish
overlay file present. The assertions name a handful of ids rather than counting
rows, so adding concepts or languages later does not break them.
"""

from __future__ import annotations

import os
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from neo4j import AsyncDriver, AsyncGraphDatabase
from services.translation import TranslationOverlay
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration


@pytest_asyncio.fixture
async def neo4j_async_driver() -> AsyncGenerator[AsyncDriver, None]:
    """A live async Neo4j driver.

    Every other integration test mocks the driver, so there is no shared
    fixture to reuse. The glossary tests below need the real graph: the point
    of them is that the Cypher, the overlay and the assembly agree, and a mock
    would be asserting the assembly against itself.
    """
    driver = AsyncGraphDatabase.driver(
        os.environ.get("NEO4J_URI", "bolt://localhost:7687"),
        auth=(
            os.environ.get("NEO4J_USER", "neo4j"),
            os.environ.get("NEO4J_PASSWORD", "localpassword"),
        ),
    )
    try:
        yield driver
    finally:
        await driver.close()


@pytest.mark.asyncio(loop_scope="session")
class TestSpanishOverlay:
    """`es` rows are present and shaped as the read path expects."""

    async def test_concept_name_alias_and_definition(
        self, db_session: AsyncSession
    ) -> None:
        overlay = TranslationOverlay(db_session)
        result = await overlay.concept_translations(["PerfectAuthenticCadence"], "es")

        pac = result.get("PerfectAuthenticCadence")
        assert pac is not None, "seed the Spanish overlay: scripts/seed.py --all"
        assert pac.name == "Cadencia Auténtica Perfecta"
        # The alias is translated too, not inherited: "PAC" is an English
        # initialism whose Spanish counterpart is "CAP".
        assert pac.aliases == ["CAP"]
        assert pac.definition and "grado 1" in pac.definition

    async def test_schema_name_and_description(self, db_session: AsyncSession) -> None:
        overlay = TranslationOverlay(db_session)
        result = await overlay.schema_translations(["CadenceFunction"], "es")

        schema = result.get("CadenceFunction")
        assert schema is not None
        assert schema.name == "Función Cadencial"
        assert schema.description and "peso funcional" in schema.description

    async def test_value_carries_all_three_label_fields(
        self, db_session: AsyncSession
    ) -> None:
        """Migration 0015's columns are populated, not just present."""
        overlay = TranslationOverlay(db_session)
        result = await overlay.value_translations(["Stage2SD4"], "es")

        value = result.get("Stage2SD4")
        assert value is not None
        assert value.name == "Predominante sobre el Grado 4"
        assert value.short_name == "Sobre el Grado 4"
        assert value.description == "IV, ii, ii6, …"

    async def test_value_without_a_short_form_leaves_it_null(
        self, db_session: AsyncSession
    ) -> None:
        """Null is "fall back to English", and most values are in this shape."""
        overlay = TranslationOverlay(db_session)
        result = await overlay.value_translations(["Independent"], "es")

        value = result.get("Independent")
        assert value is not None
        assert value.name == "Independiente"
        assert value.short_name is None
        assert value.description is None

    async def test_english_path_short_circuits_without_querying(
        self, db_session: AsyncSession
    ) -> None:
        """`en` returns empty maps: the graph rows already carry English."""
        overlay = TranslationOverlay(db_session)
        assert (
            await overlay.concept_translations(["PerfectAuthenticCadence"], "en") == {}
        )
        assert await overlay.schema_translations(["CadenceFunction"], "en") == {}
        assert await overlay.value_translations(["Stage2SD4"], "en") == {}

    async def test_every_seeded_concept_has_a_spanish_row(
        self, db_session: AsyncSession
    ) -> None:
        """Partial coverage is the failure this catches.

        A missing row does not error — it renders English with
        `translation_missing: true` — so a half-translated overlay is invisible
        without a check like this one.
        """
        from sqlalchemy import text

        # Assert there is something to compare first. An EXCEPT over two empty
        # sets is empty, so on an unseeded database this test would pass while
        # proving nothing — which is exactly what it did on CI before the
        # integration job started seeding.
        english = await db_session.scalar(
            text("SELECT count(*) FROM concept_translation WHERE language = 'en'")
        )
        assert english and english > 0, (
            "no English concept rows: run scripts/seed.py --all before the "
            "integration suite"
        )

        rows = await db_session.execute(
            text(
                "SELECT concept_id FROM concept_translation WHERE language = 'en' "
                "EXCEPT SELECT concept_id FROM concept_translation WHERE language = 'es'"
            )
        )
        missing = [r[0] for r in rows]
        assert missing == [], f"concepts with no Spanish row: {missing}"


@pytest.mark.asyncio(loop_scope="session")
class TestPublicGlossaryLanguage:
    """The public glossary honours language — Component 12 Step 19c.

    Until 19c these two service methods were documented English-only, so the
    largest reader-facing surface was the one place Spanish never reached.
    These read the live seeded overlay rather than a stub, which is what makes
    them evidence that the seed, the queries and the assembly agree.
    """

    async def _service(self, db_session, neo4j_async_driver):  # type: ignore[no-untyped-def]
        from services.concepts import ConceptService

        return ConceptService(driver=neo4j_async_driver, db=db_session)

    async def test_detail_is_english_by_default(
        self, db_session, neo4j_async_driver
    ) -> None:  # type: ignore[no-untyped-def]
        svc = await self._service(db_session, neo4j_async_driver)
        r = await svc.get_public_detail("PerfectAuthenticCadence")
        assert r.name == "Perfect Authentic Cadence"
        assert r.translation_missing is False

    async def test_detail_translates_every_name_on_the_page(
        self, db_session, neo4j_async_driver
    ) -> None:  # type: ignore[no-untyped-def]
        """Name, aliases, hierarchy and parent — a page cannot be half-Spanish."""
        svc = await self._service(db_session, neo4j_async_driver)
        r = await svc.get_public_detail("PerfectAuthenticCadence", "es")

        assert r.name == "Cadencia Auténtica Perfecta"
        assert r.aliases == ["CAP"]
        assert r.hierarchy_path[0] == "Cadencia"
        assert r.hierarchy_path[-1] == "Cadencia Auténtica Perfecta"
        assert r.parent is not None
        assert r.parent.name == "Cadencia Auténtica (Realizada)"
        assert r.translation_missing is False

    async def test_index_translates_names_and_hierarchy(
        self, db_session, neo4j_async_driver
    ) -> None:  # type: ignore[no-untyped-def]
        """This endpoint also backs the fragment browser's concept tree."""
        svc = await self._service(db_session, neo4j_async_driver)
        idx = await svc.get_public_index("es")

        cadences = next(d for d in idx.domains if d.domain == "cadences")
        names = [n.name for n in cadences.nodes]
        assert "Cadencia Auténtica Perfecta" in names
        assert not any(n.startswith("Perfect ") for n in names)

        pac = next(n for n in cadences.nodes if n.id == "PerfectAuthenticCadence")
        assert pac.hierarchy_path[0] == "Cadencia"

    async def test_index_is_ordered_by_the_translated_name(
        self, db_session, neo4j_async_driver
    ) -> None:  # type: ignore[no-untyped-def]
        """The Cypher orders by the English name; overlaying breaks that order.

        Without a re-sort the Spanish forest came back Abandonada, Auténtica,
        (Realizada), Cadencia, Rota — alphabetical in a language the reader is
        not seeing.
        """
        from services.concepts import _sort_key

        svc = await self._service(db_session, neo4j_async_driver)
        for language in ("en", "es"):
            idx = await svc.get_public_index(language)
            for domain in idx.domains:
                keys = [_sort_key(n.name) for n in domain.nodes]
                assert keys == sorted(keys), f"{domain.domain} unordered in {language}"

    async def test_the_service_the_route_builds_can_read_the_overlay(
        self, db_session, neo4j_async_driver
    ) -> None:  # type: ignore[no-untyped-def]
        """Exercise the DI function, not a hand-built service.

        Every unit test of this route overrides the service wholesale, so a
        missing dependency in the DI function is invisible to them — which is
        how the Spanish concept page shipped returning 500. The service was
        constructed Neo4j-only (correct while the page was English-only), and
        English short-circuits the overlay, so nothing touched the absent
        session until a non-English request arrived.
        """
        from api.routes.public_concepts import get_public_concept_service

        service = get_public_concept_service(driver=neo4j_async_driver, db=db_session)
        result = await service.get_public_detail("PerfectAuthenticCadence", "es")
        assert result.name == "Cadencia Auténtica Perfecta"
