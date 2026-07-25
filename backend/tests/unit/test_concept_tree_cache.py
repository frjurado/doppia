"""Unit tests for the concept-tree cache and its count freshness (M11, Step 8).

The pre-fix bug: ``ConceptService.get_tree`` cached the whole
``ConceptTreeResponse`` — ``fragment_count`` included — under a 1-hour TTL that
only ``scripts/seed.py`` invalidated, so per-concept approved counts sat stale
on the browse surface for up to an hour after an approve / reject / delete /
re-tag.

The fix splits the two freshness classes: the *structure* (which changes only
on a re-seed) is cached; the *counts* are read live from PostgreSQL on every
call. These tests lock that split in:

    - The cached payload carries no ``fragment_count`` key.
    - A cache **hit** still issues the count query and serves fresh counts.
    - Counts changing between two calls are reflected while the structure stays
      cached (the actual M11 regression).
    - A Redis error degrades to a Neo4j read, never an exception.
    - The key is versioned so a pre-fix (v1) payload can never be read back.

All Redis I/O is mocked; no running Redis, Neo4j, or PostgreSQL is required.

See docs/roadmap/component-11-concept-glossary.md § Step 8.
"""

from __future__ import annotations

import json
from typing import Any
from unittest.mock import AsyncMock

import pytest
from services.cache import get_tree_structure_cache, set_tree_structure_cache

# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------


class _FakeSession:
    """Async context manager standing in for ``driver.session()``."""

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None


class _FakeDriver:
    def session(self) -> _FakeSession:
        return _FakeSession()


def _fake_redis() -> AsyncMock:
    """Return an AsyncMock Redis whose get/set share an in-memory dict."""
    stored: dict[str, str] = {}

    async def _set(key: str, value: str, *, ex: int) -> None:
        stored[key] = value

    async def _get(key: str) -> str | None:
        return stored.get(key)

    redis = AsyncMock()
    redis.set = AsyncMock(side_effect=_set)
    redis.get = AsyncMock(side_effect=_get)
    redis.stored = stored  # type: ignore[attr-defined]
    return redis


_SUBTREE_ROWS: list[dict[str, Any]] = [
    {
        "id": "Cadence",
        "name": "Cadence",
        "aliases": [],
        "hierarchy_path": ["Cadence"],
        "parent_id": None,
    },
    {
        "id": "PerfectAuthenticCadence",
        "name": "Perfect Authentic Cadence",
        "aliases": ["PAC"],
        "hierarchy_path": ["Cadence", "Perfect Authentic Cadence"],
        "parent_id": "Cadence",
    },
]


# ---------------------------------------------------------------------------
# TestTreeStructureCache — the cache module contract
# ---------------------------------------------------------------------------


class TestTreeStructureCache:
    """get_tree_structure_cache / set_tree_structure_cache."""

    async def test_key_is_versioned_and_language_scoped(self) -> None:
        """The key carries the v2 segment and the language (ADR-006)."""
        redis = _fake_redis()

        await get_tree_structure_cache(redis, "Cadence", "en")

        assert redis.get.call_args.args[0] == "tree:v2:Cadence:en"

    async def test_pre_fix_v1_entry_is_never_read(self) -> None:
        """A leftover ``tree:{root}:{lang}`` payload is not a v2 cache hit.

        Guards the deploy seam: v1 entries embed stale counts, so reading one
        back would silently reintroduce the bug until its TTL expired.
        """
        redis = _fake_redis()
        redis.stored["tree:Cadence:en"] = json.dumps(
            {"root_id": "Cadence", "nodes": [{"id": "Cadence", "fragment_count": 99}]}
        )

        assert await get_tree_structure_cache(redis, "Cadence", "en") is None

    async def test_roundtrip_preserves_structure(self) -> None:
        """A written structure is returned intact."""
        redis = _fake_redis()
        nodes = [{"id": "Cadence", "name": "Cadence", "parent_id": None}]

        await set_tree_structure_cache(redis, "Cadence", "en", nodes)

        assert await get_tree_structure_cache(redis, "Cadence", "en") == nodes
        assert redis.set.call_args.kwargs["ex"] == 3600  # 1-hour safety net

    async def test_redis_errors_are_swallowed(self) -> None:
        """Read errors degrade to a miss; write errors do not raise."""
        redis = AsyncMock()
        redis.get = AsyncMock(side_effect=Exception("Connection refused"))
        redis.set = AsyncMock(side_effect=Exception("Connection refused"))

        assert await get_tree_structure_cache(redis, "Cadence", "en") is None
        await set_tree_structure_cache(redis, "Cadence", "en", [])  # must not raise


# ---------------------------------------------------------------------------
# TestGetTreeCountFreshness — the M11 fix
# ---------------------------------------------------------------------------


class TestGetTreeCountFreshness:
    """ConceptService.get_tree — counts are live, structure is cached."""

    @staticmethod
    def _service(monkeypatch: pytest.MonkeyPatch, redis: AsyncMock) -> Any:
        """Build a ConceptService with the subtree query and overlay stubbed."""
        from services import concepts as svc
        from services.concepts import ConceptService

        calls: list[str] = []

        async def _fake_subtree(session: object, root_id: str) -> list[dict[str, Any]]:
            calls.append(root_id)
            return _SUBTREE_ROWS

        monkeypatch.setattr(svc, "get_concept_subtree", _fake_subtree)

        service = ConceptService(_FakeDriver(), redis=redis)  # type: ignore[arg-type]
        service._neo4j_calls = calls  # type: ignore[attr-defined]
        return service

    @pytest.mark.asyncio
    async def test_cached_payload_has_no_counts(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """What lands in Redis is structure only — no fragment_count anywhere."""
        redis = _fake_redis()
        service = self._service(monkeypatch, redis)
        service._fetch_fragment_counts = AsyncMock(  # type: ignore[method-assign]
            return_value={"PerfectAuthenticCadence": 5}
        )

        await service.get_tree("Cadence")

        cached = json.loads(redis.stored["tree:v2:Cadence:en"])
        assert cached, "structure should have been cached"
        assert all("fragment_count" not in node for node in cached)

    @pytest.mark.asyncio
    async def test_cache_hit_still_reads_counts_live(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The second call serves the cached structure but re-queries counts.

        This is the M11 regression: before the fix the whole response (counts
        included) came back from Redis and the count query never ran.
        """
        redis = _fake_redis()
        service = self._service(monkeypatch, redis)
        counts = AsyncMock(return_value={"PerfectAuthenticCadence": 5})
        service._fetch_fragment_counts = counts  # type: ignore[method-assign]

        first = await service.get_tree("Cadence")
        second = await service.get_tree("Cadence")

        assert service._neo4j_calls == ["Cadence"]  # structure cached, Neo4j hit once
        assert counts.await_count == 2  # counts read on both calls
        assert [n.fragment_count for n in first.nodes] == [
            n.fragment_count for n in second.nodes
        ]

    @pytest.mark.asyncio
    async def test_count_change_is_reflected_on_a_cache_hit(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Approving a fragment shows up on the next load, cached structure or not."""
        redis = _fake_redis()
        service = self._service(monkeypatch, redis)
        service._fetch_fragment_counts = AsyncMock(  # type: ignore[method-assign]
            side_effect=[
                {"PerfectAuthenticCadence": 5},
                {"PerfectAuthenticCadence": 6, "Cadence": 1},
            ]
        )

        before = await service.get_tree("Cadence")
        after = await service.get_tree("Cadence")

        assert {n.id: n.fragment_count for n in before.nodes} == {
            "Cadence": 0,
            "PerfectAuthenticCadence": 5,
        }
        assert {n.id: n.fragment_count for n in after.nodes} == {
            "Cadence": 1,
            "PerfectAuthenticCadence": 6,
        }

    @pytest.mark.asyncio
    async def test_counts_requested_for_every_node(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Every node in the subtree is included in the single count query."""
        redis = _fake_redis()
        service = self._service(monkeypatch, redis)
        counts = AsyncMock(return_value={})
        service._fetch_fragment_counts = counts  # type: ignore[method-assign]

        await service.get_tree("Cadence")

        counts.assert_awaited_once_with(["Cadence", "PerfectAuthenticCadence"])

    @pytest.mark.asyncio
    async def test_unknown_root_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """An unknown or stub root is still a 404, with or without Redis."""
        from errors import ConceptNotFoundError
        from services import concepts as svc
        from services.concepts import ConceptService

        async def _empty(session: object, root_id: str) -> list[dict[str, Any]]:
            return []

        monkeypatch.setattr(svc, "get_concept_subtree", _empty)

        service = ConceptService(_FakeDriver(), redis=_fake_redis())  # type: ignore[arg-type]
        service._fetch_fragment_counts = AsyncMock(return_value={})  # type: ignore[method-assign]

        with pytest.raises(ConceptNotFoundError):
            await service.get_tree("Nope")

    @pytest.mark.asyncio
    async def test_works_without_redis(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """With no Redis wired, every call reads structure and counts fresh."""
        from services import concepts as svc
        from services.concepts import ConceptService

        calls: list[str] = []

        async def _fake_subtree(session: object, root_id: str) -> list[dict[str, Any]]:
            calls.append(root_id)
            return _SUBTREE_ROWS

        monkeypatch.setattr(svc, "get_concept_subtree", _fake_subtree)

        service = ConceptService(_FakeDriver())  # type: ignore[arg-type]
        service._fetch_fragment_counts = AsyncMock(  # type: ignore[method-assign]
            return_value={"Cadence": 2}
        )

        result = await service.get_tree("Cadence")
        await service.get_tree("Cadence")

        assert calls == ["Cadence", "Cadence"]
        assert {n.id: n.fragment_count for n in result.nodes}["Cadence"] == 2
