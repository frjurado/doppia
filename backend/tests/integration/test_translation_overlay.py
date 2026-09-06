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

import pytest
from services.translation import TranslationOverlay
from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.integration


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

        rows = await db_session.execute(
            text(
                "SELECT concept_id FROM concept_translation WHERE language = 'en' "
                "EXCEPT SELECT concept_id FROM concept_translation WHERE language = 'es'"
            )
        )
        missing = [r[0] for r in rows]
        assert missing == [], f"concepts with no Spanish row: {missing}"
