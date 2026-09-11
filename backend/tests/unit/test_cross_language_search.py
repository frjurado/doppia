"""Unit tests for cross-language concept search — ADR-040, Component 12 Step 21.

The defect: typing "cadencia" into the concept picker returned nothing, because
the Neo4j full-text index covers ``Concept.name``/``Concept.aliases``, which are
English by ADR-006 § 1. The fix searches both stores and unions the result for a
non-English locale.

What is worth testing here is not "does a query return rows" — the live probes
in the Step 21 notes cover that — but the four properties the ADR argues for and
that a refactor could quietly break:

* English takes an untouched path (§ 1);
* a concept with **no** translation is still findable in Spanish (§ Context —
  the failure that ruled out searching PostgreSQL alone);
* the union is ordered by complexity, prerequisite depth, then the *translated*
  name (§ 3); and
* the picker never offers a concept the English path would have filtered out.

Structure
---------
TestFoldAndTokenize      — the shared matching/sorting primitive
TestOverlaySearch        — the PostgreSQL half of the union
TestMergedSearch         — the service: union, order, page
TestEnglishPathUntouched — § 1, asserted rather than assumed
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import pytest
from services.concepts import ConceptService
from services.i18n import fold, tokenize
from services.translation import TranslationOverlay

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


@dataclass
class _Row:
    """A ``concept_translation`` row as SQLAlchemy hands it back."""

    concept_id: str
    name: str
    aliases: list[str] | None


class _FakeResult:
    """Iterable stand-in for a SQLAlchemy result."""

    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows

    def __iter__(self) -> Any:
        return iter(self._rows)


class _FakeDb:
    """Async session that returns fixed rows and records what it was asked."""

    def __init__(self, rows: list[Any]) -> None:
        self._rows = rows
        self.calls: list[dict[str, Any]] = []

    async def execute(self, _stmt: Any, params: dict[str, Any] | None = None) -> Any:
        self.calls.append(params or {})
        return _FakeResult(self._rows)


class _FakeSession:
    """Async context manager standing in for a Neo4j session."""

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        return None


class _FakeDriver:
    """Neo4j driver whose ``session()`` yields :class:`_FakeSession`."""

    def session(self) -> _FakeSession:
        return _FakeSession()


def _graph_row(
    concept_id: str,
    name: str,
    *,
    complexity_rank: int = 0,
    prereq_depth: int = 0,
    aliases: list[str] | None = None,
) -> dict[str, Any]:
    """A hydrated search row as ``_CONCEPTS_FOR_SEARCH_BY_IDS`` returns it."""
    return {
        "id": concept_id,
        "name": name,
        "aliases": aliases or [],
        "definition": None,
        "hierarchy_path": [name],
        "hierarchy_path_ids": [concept_id],
        "complexity_rank": complexity_rank,
        "prereq_depth": prereq_depth,
    }


# ---------------------------------------------------------------------------
# The shared primitive
# ---------------------------------------------------------------------------


class TestFoldAndTokenize:
    """One folding rule for matching and for sorting (ADR-040 § 3)."""

    def test_fold_strips_accents_and_case(self) -> None:
        assert fold("Auténtica") == fold("AUTENTICA") == "autentica"

    def test_fold_keeps_accented_names_in_alphabetical_place(self) -> None:
        # Python's default ordering files every accented character after "z",
        # which would put "Época" after "Zarzuela".
        assert sorted(["Zarzuela", "Época"], key=fold) == ["Época", "Zarzuela"]

    def test_tokenize_splits_on_punctuation(self) -> None:
        assert tokenize("Semicadencia (Realizada)") == {"semicadencia", "realizada"}

    def test_tokenize_folds_accents(self) -> None:
        assert "autentica" in tokenize("Cadencia Auténtica Perfecta")

    def test_tokenize_matches_whole_tokens_only(self) -> None:
        # Mirrors the Neo4j index, measured against it: "cadence" finds Perfect
        # Authentic Cadence, "caden" finds nothing. A substring match here would
        # make Spanish quietly more permissive than English.
        assert "caden" not in tokenize("Cadencia Auténtica Perfecta")

    def test_tokenize_ignores_empty_and_punctuation_only(self) -> None:
        assert tokenize("   ") == set()
        assert tokenize("(—)") == set()


# ---------------------------------------------------------------------------
# The PostgreSQL half
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestOverlaySearch:
    """``TranslationOverlay.search_concept_ids`` — ADR-040 § 2."""

    ROWS = [
        _Row("PerfectAuthenticCadence", "Cadencia Auténtica Perfecta", ["CAP"]),
        _Row("HalfCadence", "Semicadencia (Realizada)", None),
        _Row("DeceptiveCadence", "Cadencia Rota", []),
    ]

    async def test_matches_on_name(self) -> None:
        db = _FakeDb(self.ROWS)
        got = await TranslationOverlay(db).search_concept_ids("cadencia", "es")
        assert got == {"PerfectAuthenticCadence", "DeceptiveCadence"}

    async def test_matches_on_alias(self) -> None:
        db = _FakeDb(self.ROWS)
        got = await TranslationOverlay(db).search_concept_ids("CAP", "es")
        assert got == {"PerfectAuthenticCadence"}

    async def test_matching_is_accent_insensitive(self) -> None:
        # The one deliberate asymmetry with the Neo4j analyser: requiring a
        # Spanish tagger to type accents to find their own vocabulary would be
        # a worse rule than the one it enforces.
        db = _FakeDb(self.ROWS)
        assert await TranslationOverlay(db).search_concept_ids("autentica", "es") == {
            "PerfectAuthenticCadence"
        }

    async def test_terms_are_ored(self) -> None:
        # Matching the Neo4j default operator, measured: "perfect deceptive"
        # returns both.
        db = _FakeDb(self.ROWS)
        got = await TranslationOverlay(db).search_concept_ids("perfecta rota", "es")
        assert got == {"PerfectAuthenticCadence", "DeceptiveCadence"}

    async def test_english_short_circuits_without_touching_the_database(self) -> None:
        # The English text is already on the Neo4j rows; reading it again here
        # would be a redundant round-trip on the common path.
        db = _FakeDb(self.ROWS)
        assert await TranslationOverlay(db).search_concept_ids("cadence", "en") == set()
        assert db.calls == []

    async def test_a_query_with_no_tokens_matches_nothing(self) -> None:
        db = _FakeDb(self.ROWS)
        assert await TranslationOverlay(db).search_concept_ids("  (—) ", "es") == set()
        assert db.calls == []

    async def test_it_asks_for_the_requested_locale(self) -> None:
        db = _FakeDb(self.ROWS)
        await TranslationOverlay(db).search_concept_ids("cadencia", "es")
        assert db.calls == [{"language": "es"}]


# ---------------------------------------------------------------------------
# The service
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestMergedSearch:
    """The union, its ordering and its paging — ADR-040 § 2, § 3, § 6."""

    @staticmethod
    def _service(
        monkeypatch: pytest.MonkeyPatch,
        *,
        graph_ids: set[str],
        overlay_ids: set[str],
        rows: list[dict[str, Any]],
        translations: dict[str, Any],
        seen: dict[str, Any] | None = None,
    ) -> ConceptService:
        """Build a ConceptService with both halves of the union stubbed."""

        async def fake_search_concept_ids(_session: Any, **_kw: Any) -> set[str]:
            return graph_ids

        async def fake_hydrate(
            _session: Any, *, ids: list[str], domain: str | None
        ) -> list[dict[str, Any]]:
            if seen is not None:
                seen["ids"] = ids
                seen["domain"] = domain
            wanted = set(ids)
            return [r for r in rows if r["id"] in wanted]

        async def fake_overlay_search(_self: Any, _q: str, _lang: str) -> set[str]:
            return overlay_ids

        async def fake_concept_translations(
            _self: Any, ids: list[str], _lang: str
        ) -> dict[str, Any]:
            return {k: v for k, v in translations.items() if k in set(ids)}

        monkeypatch.setattr(
            "services.concepts.search_concept_ids", fake_search_concept_ids
        )
        monkeypatch.setattr(
            "services.concepts.get_concepts_for_search_by_ids", fake_hydrate
        )
        monkeypatch.setattr(
            TranslationOverlay, "search_concept_ids", fake_overlay_search
        )
        monkeypatch.setattr(
            TranslationOverlay, "concept_translations", fake_concept_translations
        )
        return ConceptService(_FakeDriver(), db=object(), redis=None)

    async def test_a_concept_found_only_in_spanish_is_returned(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        svc = self._service(
            monkeypatch,
            graph_ids=set(),
            overlay_ids={"DeceptiveCadence"},
            rows=[_graph_row("DeceptiveCadence", "Deceptive Cadence")],
            translations={"DeceptiveCadence": _Tr("Cadencia Rota")},
        )
        resp = await svc.search(q="cadencia", language="es")
        assert [i.name for i in resp.items] == ["Cadencia Rota"]

    async def test_an_untranslated_concept_is_still_findable_in_spanish(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # The argument that ruled out searching PostgreSQL alone. Concepts are
        # seeded English-first, so every new one has a window in which it has no
        # Spanish row; a locale-only search would make it invisible for the whole
        # of that window rather than merely untranslated.
        svc = self._service(
            monkeypatch,
            graph_ids={"NewlySeeded"},
            overlay_ids=set(),
            rows=[_graph_row("NewlySeeded", "Newly Seeded Concept")],
            translations={},
        )
        resp = await svc.search(q="newly", language="es")
        assert [i.name for i in resp.items] == ["Newly Seeded Concept"]
        assert resp.items[0].translation_missing is True

    async def test_a_concept_found_in_both_appears_once(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        svc = self._service(
            monkeypatch,
            graph_ids={"PerfectAuthenticCadence"},
            overlay_ids={"PerfectAuthenticCadence"},
            rows=[_graph_row("PerfectAuthenticCadence", "Perfect Authentic Cadence")],
            translations={
                "PerfectAuthenticCadence": _Tr("Cadencia Auténtica Perfecta")
            },
        )
        resp = await svc.search(q="cadence", language="es")
        assert [i.id for i in resp.items] == ["PerfectAuthenticCadence"]

    async def test_the_hydrator_filters_what_the_english_path_would_exclude(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # concept_translation carries a row for every concept in the graph,
        # stubs and non-taggable nodes included, so the union is filtered by the
        # graph query. An id it drops must not reach the picker.
        seen: dict[str, Any] = {}
        svc = self._service(
            monkeypatch,
            graph_ids=set(),
            overlay_ids={"AStubConcept", "DeceptiveCadence"},
            rows=[_graph_row("DeceptiveCadence", "Deceptive Cadence")],
            translations={"DeceptiveCadence": _Tr("Cadencia Rota")},
            seen=seen,
        )
        resp = await svc.search(q="cadencia", domain="cadences", language="es")
        assert seen["ids"] == ["AStubConcept", "DeceptiveCadence"]
        assert seen["domain"] == "cadences"
        assert [i.id for i in resp.items] == ["DeceptiveCadence"]

    async def test_ordering_is_complexity_then_prereq_then_translated_name(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        rows = [
            _graph_row("Z", "Z Concept", complexity_rank=0, prereq_depth=1),
            _graph_row("A", "A Concept", complexity_rank=0, prereq_depth=1),
            _graph_row("E", "E Concept", complexity_rank=0, prereq_depth=0),
            _graph_row("Y", "Y Concept", complexity_rank=1, prereq_depth=0),
        ]
        # The Spanish names invert the English alphabetical order, so a result
        # sorted on the English name would be visibly wrong.
        translations = {
            "Z": _Tr("Alfa"),
            "A": _Tr("Zulú"),
            "E": _Tr("Eco"),
            "Y": _Tr("Bravo"),
        }
        svc = self._service(
            monkeypatch,
            graph_ids={r["id"] for r in rows},
            overlay_ids=set(),
            rows=rows,
            translations=translations,
        )
        resp = await svc.search(q="concept", language="es")
        assert [i.name for i in resp.items] == ["Eco", "Alfa", "Zulú", "Bravo"]

    async def test_accented_names_sort_in_their_alphabetical_place(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        rows = [
            _graph_row("Z", "Zarzuela"),
            _graph_row("E", "Epoch"),
        ]
        svc = self._service(
            monkeypatch,
            graph_ids={"Z", "E"},
            overlay_ids=set(),
            rows=rows,
            translations={"Z": _Tr("Zarzuela"), "E": _Tr("Época")},
        )
        resp = await svc.search(q="x", language="es")
        assert [i.name for i in resp.items] == ["Época", "Zarzuela"]

    async def test_paging_slices_the_merged_order(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        rows = [_graph_row(f"C{n:02d}", f"Concept {n:02d}") for n in range(45)]
        svc = self._service(
            monkeypatch,
            graph_ids={r["id"] for r in rows},
            overlay_ids=set(),
            rows=rows,
            translations={},
        )
        first = await svc.search(q="concept", language="es")
        assert len(first.items) == 20
        assert first.items[0].id == "C00"
        assert first.next_cursor is not None

        second = await svc.search(q="concept", cursor=first.next_cursor, language="es")
        assert [i.id for i in second.items][:1] == ["C20"]
        assert second.next_cursor is not None

        third = await svc.search(q="concept", cursor=second.next_cursor, language="es")
        assert len(third.items) == 5
        assert third.next_cursor is None, "the last page must not offer another"


@pytest.mark.asyncio
class TestEnglishPathUntouched:
    """§ 1 — English runs the old path, asserted rather than assumed."""

    async def test_english_never_consults_the_overlay(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        calls: list[str] = []

        async def fake_search_concepts(
            _session: Any, *, q: str, domain: str | None, skip: int, limit: int
        ) -> list[dict[str, Any]]:
            calls.append("graph")
            return [_graph_row("PerfectAuthenticCadence", "Perfect Authentic Cadence")]

        async def fail_merged(*_a: Any, **_kw: Any) -> set[str]:
            raise AssertionError("the merged path must not run for English")

        monkeypatch.setattr("services.concepts.search_concepts", fake_search_concepts)
        monkeypatch.setattr("services.concepts.search_concept_ids", fail_merged)
        monkeypatch.setattr(TranslationOverlay, "search_concept_ids", fail_merged)

        svc = ConceptService(_FakeDriver(), db=None, redis=None)
        resp = await svc.search(q="cadence", language="en")

        assert calls == ["graph"]
        assert [i.name for i in resp.items] == ["Perfect Authentic Cadence"]
        assert resp.items[0].translation_missing is False


@dataclass
class _Tr:
    """A concept translation, with the two optional fields defaulted."""

    name: str
    aliases: list[str] | None = None
    definition: str | None = None
