"""Redis caches for knowledge-graph reads (concept browsing and the concept tree).

Two caches live here, and both cache **graph structure only** — never anything
derived from the fragment database:

1. ``subtree:{concept_id}:1`` — the result of ``get_subtype_ids_async`` (the
   downward IS_SUBTYPE_OF subtree expansion), so repeated concept-browse
   requests do not hit Neo4j. (``include_subtypes=False`` is a singleton set
   computed without Neo4j, so it is never cached.)
2. ``tree:v2:{root_id}:{language}`` — the flat node list behind
   ``GET /api/v1/concepts/tree``, **without** approved-fragment counts.

Both key shapes change only when the graph is re-seeded, which is exactly what
``invalidate_subtree_cache_sync`` handles. Anything that changes on a *fragment*
lifecycle transition (approve / reject / delete / re-tag) is deliberately kept
out of these payloads: per-concept approved-fragment counts are read live from
PostgreSQL on every request (Component 11 Step 8 / M11 — before the fix the
whole tree response including its counts was cached, so counts could sit up to
an hour stale on a public browse surface).

TTL: 1 hour as a safety net; seed-based invalidation via
``invalidate_subtree_cache_sync`` is the primary correctness mechanism.

See docs/roadmap/component-8-fragment-browsing.md § Step 2 and
docs/roadmap/component-11-concept-glossary.md § Step 8.
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


_TREE_KEY_PREFIX: str = "tree"
_TREE_CACHE_VERSION: str = "v2"


def _tree_cache_key(root_id: str, language: str) -> str:
    """Return the Redis key for a cached concept-tree *structure*.

    The cached payload is **count-free** (Component 11 Step 8 / M11): the graph
    shape changes only on a re-seed, but approved-fragment counts change on
    every fragment-lifecycle transition, so counts are read live from
    PostgreSQL on every request and never cached here.

    The ``v2`` segment retires the pre-M11 key shape, whose payload was a whole
    ``ConceptTreeResponse`` with ``fragment_count`` baked in — a v1 entry left
    over from a previous deployment can never be mistaken for a v2 structure.

    The language is part of the key so a localised response is never served
    from another locale's cache entry (ADR-006). The ``tree:*`` invalidation
    pattern in :func:`invalidate_subtree_cache_sync` covers every suffix.
    """
    return f"{_TREE_KEY_PREFIX}:{_TREE_CACHE_VERSION}:{root_id}:{language}"


async def get_tree_structure_cache(
    redis: Redis,
    root_id: str,
    language: str,
) -> list[dict] | None:
    """Return the cached count-free tree structure for root_id, or None on a miss.

    Failures are logged and swallowed so a cache miss never breaks a tree request.

    Args:
        redis: Async Redis client.
        root_id: The root concept id whose tree structure was cached.
        language: The response language the cached entry was built for.

    Returns:
        The cached flat node list (translated identity + hierarchy linkage, no
        ``fragment_count``), or ``None`` on a miss or Redis error.
    """
    try:
        raw = await redis.get(_tree_cache_key(root_id, language))
        if raw is None:
            return None
        return json.loads(raw)
    except Exception:
        logger.warning("Tree cache read failed for %r", root_id, exc_info=True)
        return None


async def set_tree_structure_cache(
    redis: Redis,
    root_id: str,
    language: str,
    nodes: list[dict],
) -> None:
    """Write a count-free tree structure to the cache with a 1-hour TTL.

    Args:
        redis: Async Redis client.
        root_id: The root concept id whose tree structure is being cached.
        language: The response language the entry was built for.
        nodes: The flat node list, **without** ``fragment_count`` — counts are
            attached per request from PostgreSQL (M11).
    """
    try:
        await redis.set(
            _tree_cache_key(root_id, language),
            json.dumps(nodes),
            ex=_TTL_SECONDS,
        )
    except Exception:
        logger.warning("Tree cache write failed for %r", root_id, exc_info=True)


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
        for pattern in (f"{_KEY_PREFIX}:*", f"{_TREE_KEY_PREFIX}:*"):
            cursor: int = 0
            while True:
                cursor, keys = client.scan(cursor, match=pattern, count=100)
                if keys:
                    client.delete(*keys)
                    deleted += len(keys)
                if cursor == 0:
                    break
    finally:
        client.close()
    return deleted
