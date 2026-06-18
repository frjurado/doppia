"""Unit tests for the ADR-006 translation-overlay backend (Step 24).

Covers the pure language-negotiation helpers, the ``get_language`` FastAPI
dependency, the ``TranslationOverlay`` read-side logic (including the English
short-circuit and the ``translation_missing`` fallback), and the seed-script
English-record param builders. No database or HTTP stack required.
"""

from __future__ import annotations

from typing import Any

import pytest

# ---------------------------------------------------------------------------
# normalize_language / parse_accept_language
# ---------------------------------------------------------------------------


class TestNormalizeLanguage:
    """services.i18n.normalize_language — supported, unsupported, missing."""

    def test_supported_returned_as_is(self) -> None:
        from services.i18n import normalize_language

        assert normalize_language("en") == "en"
        assert normalize_language("es") == "es"

    def test_case_and_region_normalised_to_primary_subtag(self) -> None:
        from services.i18n import normalize_language

        assert normalize_language("ES") == "es"
        assert normalize_language("es-ES") == "es"
        assert normalize_language("EN-us") == "en"

    def test_unsupported_falls_back_to_default(self) -> None:
        from services.i18n import normalize_language

        assert normalize_language("de") == "en"
        assert normalize_language("fr-FR") == "en"

    def test_none_and_empty_fall_back_to_default(self) -> None:
        from services.i18n import normalize_language

        assert normalize_language(None) == "en"
        assert normalize_language("") == "en"


class TestParseAcceptLanguage:
    """services.i18n.parse_accept_language — header parsing and q-values."""

    def test_none_returns_default(self) -> None:
        from services.i18n import parse_accept_language

        assert parse_accept_language(None) == "en"

    def test_single_supported_language(self) -> None:
        from services.i18n import parse_accept_language

        assert parse_accept_language("es") == "es"

    def test_unsupported_only_falls_back_to_default(self) -> None:
        from services.i18n import parse_accept_language

        assert parse_accept_language("de, fr;q=0.8") == "en"

    def test_highest_q_supported_language_wins(self) -> None:
        from services.i18n import parse_accept_language

        # es has a higher weight than en here, so es wins.
        assert parse_accept_language("en;q=0.5, es;q=0.9") == "es"
        # unsupported de has top weight but is ignored; es is the best supported.
        assert parse_accept_language("de, es;q=0.7, en;q=0.3") == "es"

    def test_region_subtags_match_primary(self) -> None:
        from services.i18n import parse_accept_language

        assert parse_accept_language("es-MX,es;q=0.9") == "es"

    def test_malformed_q_is_tolerated(self) -> None:
        from services.i18n import parse_accept_language

        # A malformed q on es drops its weight to 0, so en (default weight 1) wins.
        assert parse_accept_language("es;q=notanumber, en") == "en"


# ---------------------------------------------------------------------------
# get_language dependency
# ---------------------------------------------------------------------------


class _FakeRequest:
    """Minimal stand-in for a Starlette request exposing only ``headers``."""

    def __init__(self, headers: dict[str, str]) -> None:
        self.headers = headers


class TestGetLanguageDependency:
    """api.dependencies.get_language — param > header > default precedence."""

    def test_explicit_param_wins_over_header(self) -> None:
        from api.dependencies import get_language

        req = _FakeRequest({"accept-language": "en"})
        assert get_language(req, language="es") == "es"

    def test_unsupported_param_falls_back_to_default(self) -> None:
        from api.dependencies import get_language

        req = _FakeRequest({"accept-language": "es"})
        # Explicit (unsupported) param normalises to 'en'; header is not consulted.
        assert get_language(req, language="de") == "en"

    def test_header_used_when_no_param(self) -> None:
        from api.dependencies import get_language

        req = _FakeRequest({"accept-language": "es-ES,es;q=0.9"})
        assert get_language(req, language=None) == "es"

    def test_default_when_neither_present(self) -> None:
        from api.dependencies import get_language

        req = _FakeRequest({})
        assert get_language(req, language=None) == "en"


# ---------------------------------------------------------------------------
# is_translation_missing
# ---------------------------------------------------------------------------


class TestIsTranslationMissing:
    """services.translation.is_translation_missing — fallback flag logic."""

    def test_english_is_never_missing(self) -> None:
        from services.translation import is_translation_missing

        assert is_translation_missing("en", {}, "PerfectAuthenticCadence") is False

    def test_non_english_absent_is_missing(self) -> None:
        from services.translation import is_translation_missing

        assert is_translation_missing("es", {}, "PerfectAuthenticCadence") is True

    def test_non_english_present_is_not_missing(self) -> None:
        from services.translation import is_translation_missing

        present = {"PerfectAuthenticCadence": object()}
        assert is_translation_missing("es", present, "PerfectAuthenticCadence") is False


# ---------------------------------------------------------------------------
# TranslationOverlay
# ---------------------------------------------------------------------------


class _Row:
    """Attribute-style row, mimicking a SQLAlchemy result row."""

    def __init__(self, **kw: Any) -> None:
        self.__dict__.update(kw)


class _FakeResult:
    def __init__(self, rows: list[_Row]) -> None:
        self._rows = rows

    def __iter__(self) -> Any:
        return iter(self._rows)


class _FakeSession:
    """Records executed statements and returns a fixed row set."""

    def __init__(self, rows: list[_Row]) -> None:
        self._rows = rows
        self.calls: list[tuple[Any, dict]] = []

    async def execute(self, sql: Any, params: dict) -> _FakeResult:
        self.calls.append((sql, params))
        return _FakeResult(self._rows)


class TestTranslationOverlay:
    """services.translation.TranslationOverlay — short-circuit and overlay."""

    @pytest.mark.asyncio
    async def test_english_short_circuits_without_query(self) -> None:
        from services.translation import TranslationOverlay

        session = _FakeSession([])
        overlay = TranslationOverlay(session)  # type: ignore[arg-type]

        result = await overlay.concept_translations(["PAC"], "en")

        assert result == {}
        assert session.calls == []  # no DB round-trip on the English path

    @pytest.mark.asyncio
    async def test_empty_ids_short_circuits(self) -> None:
        from services.translation import TranslationOverlay

        session = _FakeSession([])
        overlay = TranslationOverlay(session)  # type: ignore[arg-type]

        assert await overlay.concept_translations([], "es") == {}
        assert session.calls == []

    @pytest.mark.asyncio
    async def test_concept_overlay_returns_keyed_rows(self) -> None:
        from services.translation import TranslationOverlay

        session = _FakeSession(
            [
                _Row(
                    concept_id="PAC",
                    name="Cadencia auténtica perfecta",
                    aliases=["CAP"],
                    definition="Una cadencia…",
                )
            ]
        )
        overlay = TranslationOverlay(session)  # type: ignore[arg-type]

        result = await overlay.concept_translations(["PAC", "IAC"], "es")

        assert len(session.calls) == 1
        assert session.calls[0][1] == {"ids": ["PAC", "IAC"], "language": "es"}
        assert result["PAC"].name == "Cadencia auténtica perfecta"
        assert result["PAC"].aliases == ["CAP"]
        assert "IAC" not in result  # no row → caller flags translation_missing

    @pytest.mark.asyncio
    async def test_schema_and_value_overlays(self) -> None:
        from services.translation import TranslationOverlay

        schema_session = _FakeSession(
            [_Row(schema_id="CadenceFunction", name="Función", description="…")]
        )
        value_session = _FakeSession(
            [_Row(value_id="Independent", name="Independiente")]
        )

        schema_overlay = TranslationOverlay(schema_session)  # type: ignore[arg-type]
        value_overlay = TranslationOverlay(value_session)  # type: ignore[arg-type]

        schemas = await schema_overlay.schema_translations(["CadenceFunction"], "es")
        values = await value_overlay.value_translations(["Independent"], "es")

        assert schemas["CadenceFunction"].name == "Función"
        assert schemas["CadenceFunction"].description == "…"
        assert values["Independent"].name == "Independiente"


# ---------------------------------------------------------------------------
# Seed-script English-record param builders
# ---------------------------------------------------------------------------


class TestSeedTranslationParams:
    """backend.graph.queries.seed — English record params and SQL shape."""

    def test_english_source_hash_is_stable_and_field_aware(self) -> None:
        from backend.graph.queries.seed import english_source_hash

        # Deterministic.
        assert english_source_hash("a", "b") == english_source_hash("a", "b")
        # None is treated as empty string.
        assert english_source_hash("a", None) == english_source_hash("a", "")
        # Field boundaries matter: ("a","b") != ("ab",).
        assert english_source_hash("a", "b") != english_source_hash("ab")

    def test_concept_params_use_english_authoritative(self) -> None:
        from backend.graph.queries.seed import concept_translation_params

        class _Concept:
            id = "PerfectAuthenticCadence"
            name = "Perfect Authentic Cadence"
            aliases = ["PAC"]
            definition = "A cadence ending on root-position tonic."

        params = concept_translation_params(_Concept())  # type: ignore[arg-type]
        assert params["concept_id"] == "PerfectAuthenticCadence"
        assert params["language"] == "en"
        assert params["status"] == "authoritative"
        assert params["aliases"] == ["PAC"]
        assert params["source_hash"]  # non-empty digest

    def test_value_params_minimal_shape(self) -> None:
        from backend.graph.queries.seed import value_translation_params

        params = value_translation_params("Independent", "Independent")
        assert params == {
            "value_id": "Independent",
            "language": "en",
            "name": "Independent",
            "status": "authoritative",
            "source_hash": params["source_hash"],
        }

    def test_upsert_sql_is_idempotent(self) -> None:
        from backend.graph.queries.seed import (
            _UPSERT_CONCEPT_TRANSLATION,
            _UPSERT_PROPERTY_SCHEMA_TRANSLATION,
            _UPSERT_PROPERTY_VALUE_TRANSLATION,
        )

        for sql in (
            _UPSERT_CONCEPT_TRANSLATION,
            _UPSERT_PROPERTY_SCHEMA_TRANSLATION,
            _UPSERT_PROPERTY_VALUE_TRANSLATION,
        ):
            assert "ON CONFLICT" in sql
            assert "DO UPDATE" in sql
