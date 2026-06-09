"""Redis-based subtree expansion cache for concept-scoped fragment browsing.

Caches the result of ``get_subtype_ids_async`` (the downward IS_SUBTYPE_OF
subtree expansion) so repeated concept-browse requests do not hit Neo4j.

Cache key pattern:  ``subtree:{concept_id}:1`` (include_subtypes=True only;
``include_subtypes=False`` is a singleton set computed without Neo4j, so it
is never cached).

TTL: 1 hour as a safety net; seed-based invalidation via
``invalidate_subtree_cache`` is the primary correctness mechanism.

See docs/roadmap/component-8-fragment-browsing.md § Step 2.
"""

from __future__ import annotations

import json
import logging

from redis.asyncio import Redis

logger = logging.getLogger(__name__)

_TTL_SECONDS: int = 3600
_KEY_PREFIX: str = "subtree"


def _cache_key(concept_id: str) -> str:
    """Return the Redis key for a concept's full subtree (include_subtypes=True)."""
    return f"{_KEY_PREFIX}:{concept_id}:1"


async def get_subtree_cache(
    redis: Redis,
    concept_id: str,
) -> set[str] | None:
    """Return the cached subtree id set for a concept, or None on a miss.

    Failures are logged and swallowed so a cache miss never breaks a browse
    request.

    Args:
        redis: Async Redis client.
        concept_id: The root concept whose subtree was cached.

    Returns:
        The cached id set, or ``None`` on a miss or Redis error.
    """
    try:
        raw = await redis.get(_cache_key(concept_id))
        if raw is None:
            return None
        return set(json.loads(raw))
    except Exception:
        logger.warning("Subtree cache read failed for %r", concept_id, exc_info=True)
        return None


async def set_subtree_cache(
    redis: Redis,
    concept_id: str,
    ids: set[str],
) -> None:
    """Write a subtree id set to the cache with a 1-hour TTL.

    Args:
        redis: Async Redis client.
        concept_id: The root concept whose subtree is being cached.
        ids: The full subtree id set (including the root).
    """
    try:
        await redis.set(
            _cache_key(concept_id),
            json.dumps(sorted(ids)),
            ex=_TTL_SECONDS,
        )
    except Exception:
        logger.warning("Subtree cache write failed for %r", concept_id, exc_info=True)


def invalidate_subtree_cache_sync(redis_url: str) -> int:
    """Delete all subtree cache keys synchronously (called from the seed script).

    Uses a synchronous Redis client so it can be called from non-async
    contexts (the seed script runs outside an event loop).

    Args:
        redis_url: Redis connection URL (e.g. ``redis://localhost:6379/0``).

    Returns:
        Number of keys deleted.
    """
    import redis as _redis_sync  # noqa: PLC0415

    client = _redis_sync.Redis.from_url(redis_url, decode_responses=True)
    deleted = 0
    try:
        cursor: int = 0
        while True:
            cursor, keys = client.scan(cursor, match=f"{_KEY_PREFIX}:*", count=100)
            if keys:
                client.delete(*keys)
                deleted += len(keys)
            if cursor == 0:
                break
    finally:
        client.close()
    return deleted
