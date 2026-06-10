"""Unit tests for the Redis subtree cache (Component 8 Step 2).

The subtree cache wraps ``get_subtype_ids_async`` results so repeated
browse requests do not hit Neo4j for every ``GET /api/v1/fragments?concept_id=...``
call.  Tests cover the read/write/miss paths and the graceful-degradation
contract (Redis errors → cache miss, never a raised exception to the caller).

All Redis I/O is mocked; no running Redis instance is required.

Verification cases from the roadmap (Step 13):
    - Cache miss returns None (Neo4j fallback path).
    - Cache hit returns the stored id set (parsed from JSON).
    - Set + get roundtrip preserves the set exactly.
    - Redis error on get → None (degraded gracefully).
    - Redis error on set → no exception raised.
    - Cache key follows the ``subtree:{concept_id}:1`` pattern.
    - Value is stored with a 1-hour TTL.

See docs/roadmap/component-8-fragment-browsing.md § Step 2.
"""

from __future__ import annotations

import json
from unittest.mock import AsyncMock

from services.cache import get_subtree_cache, set_subtree_cache

# ---------------------------------------------------------------------------
# TestGetSubtreeCache
# ---------------------------------------------------------------------------


class TestGetSubtreeCache:
    """get_subtree_cache — read path, miss, and error handling."""

    async def test_cache_miss_returns_none(self) -> None:
        """When Redis has no entry, get_subtree_cache returns None."""
        redis = AsyncMock()
        redis.get = AsyncMock(return_value=None)

        result = await get_subtree_cache(redis, "PerfectAuthenticCadence")

        assert result is None
        redis.get.assert_awaited_once_with("subtree:PerfectAuthenticCadence:1")

    async def test_cache_hit_returns_set(self) -> None:
        """A cached entry is deserialised back to a set of strings."""
        stored_ids = [
            "AuthenticCadence",
            "ImperfectAuthenticCadence",
            "PerfectAuthenticCadence",
        ]
        redis = AsyncMock()
        redis.get = AsyncMock(return_value=json.dumps(stored_ids).encode())

        result = await get_subtree_cache(redis, "AuthenticCadence")

        assert result == set(stored_ids)

    async def test_redis_error_returns_none(self) -> None:
        """A Redis failure on get is swallowed and returns None."""
        redis = AsyncMock()
        redis.get = AsyncMock(side_effect=Exception("Connection refused"))

        result = await get_subtree_cache(redis, "AuthenticCadence")

        assert result is None  # degraded gracefully

    async def test_key_pattern_is_correct(self) -> None:
        """The Redis key follows the subtree:{concept_id}:1 pattern."""
        redis = AsyncMock()
        redis.get = AsyncMock(return_value=None)

        await get_subtree_cache(redis, "HalfCadence")

        redis.get.assert_awaited_once_with("subtree:HalfCadence:1")

    async def test_different_concept_ids_use_different_keys(self) -> None:
        """Each concept_id maps to a distinct Redis key."""
        redis_a = AsyncMock()
        redis_a.get = AsyncMock(return_value=None)
        redis_b = AsyncMock()
        redis_b.get = AsyncMock(return_value=None)

        await get_subtree_cache(redis_a, "HalfCadence")
        await get_subtree_cache(redis_b, "AuthenticCadence")

        key_a = redis_a.get.call_args.args[0]
        key_b = redis_b.get.call_args.args[0]
        assert key_a != key_b
        assert "HalfCadence" in key_a
        assert "AuthenticCadence" in key_b


# ---------------------------------------------------------------------------
# TestSetSubtreeCache
# ---------------------------------------------------------------------------


class TestSetSubtreeCache:
    """set_subtree_cache — write path and error handling."""

    async def test_writes_sorted_json_with_ttl(self) -> None:
        """The id set is serialised as sorted JSON and stored with a 1-hour TTL."""
        redis = AsyncMock()
        redis.set = AsyncMock()

        await set_subtree_cache(redis, "AuthenticCadence", {"C", "B", "A"})

        redis.set.assert_awaited_once()
        call_args = redis.set.call_args
        key = call_args.args[0]
        value = call_args.args[1]
        assert key == "subtree:AuthenticCadence:1"
        decoded = json.loads(value)
        assert decoded == sorted(decoded), "Value must be sorted"
        assert set(decoded) == {"A", "B", "C"}
        assert call_args.kwargs["ex"] == 3600  # 1-hour TTL

    async def test_redis_error_does_not_raise(self) -> None:
        """A Redis failure on set is swallowed without raising."""
        redis = AsyncMock()
        redis.set = AsyncMock(side_effect=Exception("Connection refused"))

        # Must not raise.
        await set_subtree_cache(redis, "AuthenticCadence", {"PAC", "IAC"})

    async def test_empty_set_is_stored(self) -> None:
        """An empty id set is stored as an empty JSON array."""
        redis = AsyncMock()
        redis.set = AsyncMock()

        await set_subtree_cache(redis, "StubConcept", set())

        stored_value = redis.set.call_args.args[1]
        assert json.loads(stored_value) == []


# ---------------------------------------------------------------------------
# TestCacheRoundtrip
# ---------------------------------------------------------------------------


class TestCacheRoundtrip:
    """get_subtree_cache / set_subtree_cache — roundtrip correctness.

    Simulates the service layer's pattern: expand subtree from Neo4j once,
    cache it, then serve subsequent browse requests from the cache.
    """

    async def test_roundtrip_preserves_set(self) -> None:
        """A value written by set_subtree_cache is returned intact by get_subtree_cache."""
        stored: dict[str, bytes] = {}

        async def _mock_set(key: str, value: str, *, ex: int) -> None:
            stored[key] = value.encode() if isinstance(value, str) else value

        async def _mock_get(key: str) -> bytes | None:
            return stored.get(key)

        redis = AsyncMock()
        redis.set = AsyncMock(side_effect=_mock_set)
        redis.get = AsyncMock(side_effect=_mock_get)

        original_ids = {
            "PerfectAuthenticCadence",
            "ImperfectAuthenticCadence",
            "AuthenticCadence",
        }
        await set_subtree_cache(redis, "AuthenticCadence", original_ids)
        result = await get_subtree_cache(redis, "AuthenticCadence")

        assert result == original_ids

    async def test_different_concepts_do_not_share_cache_entries(self) -> None:
        """Separate concept_ids do not collide in the cache."""
        stored: dict[str, bytes] = {}

        async def _mock_set(key: str, value: str, *, ex: int) -> None:
            stored[key] = value.encode() if isinstance(value, str) else value

        async def _mock_get(key: str) -> bytes | None:
            return stored.get(key)

        redis = AsyncMock()
        redis.set = AsyncMock(side_effect=_mock_set)
        redis.get = AsyncMock(side_effect=_mock_get)

        await set_subtree_cache(redis, "AuthenticCadence", {"AuthenticCadence", "PAC"})
        await set_subtree_cache(redis, "HalfCadence", {"HalfCadence", "HC"})

        ac_result = await get_subtree_cache(redis, "AuthenticCadence")
        hc_result = await get_subtree_cache(redis, "HalfCadence")

        assert ac_result == {"AuthenticCadence", "PAC"}
        assert hc_result == {"HalfCadence", "HC"}
        # The two sets are disjoint — they didn't cross-contaminate.
        assert ac_result.isdisjoint(hc_result)
