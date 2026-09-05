"""Shared helper functions for integration tests.

These are plain async functions (not pytest fixtures) that can be imported
and called by any integration test module.
"""

from __future__ import annotations

import os

import aioboto3
from botocore.config import Config as BotocoreConfig
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


async def delete_test_composer(session: AsyncSession, slug: str) -> None:
    """Delete a test composer and all descendant rows (RESTRICT FKs → manual order).

    Args:
        session: Open async session.  The caller is responsible for committing
            or rolling back after this function returns.
        slug: Composer slug to delete.
    """
    await session.execute(
        text(
            """
            DELETE FROM movement_analysis
            WHERE movement_id IN (
                SELECT m.id FROM movement m
                JOIN work w ON m.work_id = w.id
                JOIN corpus c ON w.corpus_id = c.id
                JOIN composer co ON c.composer_id = co.id
                WHERE co.slug = :slug
            )
            """
        ),
        {"slug": slug},
    )
    await session.execute(
        text(
            """
            DELETE FROM movement
            WHERE work_id IN (
                SELECT w.id FROM work w
                JOIN corpus c ON w.corpus_id = c.id
                JOIN composer co ON c.composer_id = co.id
                WHERE co.slug = :slug
            )
            """
        ),
        {"slug": slug},
    )
    await session.execute(
        text(
            """
            DELETE FROM work
            WHERE corpus_id IN (
                SELECT c.id FROM corpus c
                JOIN composer co ON c.composer_id = co.id
                WHERE co.slug = :slug
            )
            """
        ),
        {"slug": slug},
    )
    await session.execute(
        text(
            """
            DELETE FROM corpus
            WHERE composer_id IN (
                SELECT id FROM composer WHERE slug = :slug
            )
            """
        ),
        {"slug": slug},
    )
    await session.execute(
        text("DELETE FROM composer WHERE slug = :slug"),
        {"slug": slug},
    )


async def delete_test_storage_objects(slug: str) -> None:
    """Delete every stored object belonging to a test composer.

    ``delete_test_composer`` removes database rows only. Uploaded MEI files
    outlive them, and because each run generates a fresh composer slug the
    residue accumulates permanently — this is what left months of
    ``browse-test-mozart-*`` objects in the local bucket.

    Both prefixes are cleared: the normalized key ``{slug}/…`` and the
    pre-normalization copy under ``originals/{slug}/…``.

    Failures are swallowed. Cleanup runs in a fixture teardown that must not
    convert a storage hiccup into a test error, and an object left behind is
    a housekeeping problem, not a correctness one.

    Args:
        slug: Composer slug whose objects should be removed.
    """
    try:
        bucket = os.environ["R2_BUCKET_NAME"]
        client_kwargs = {
            "endpoint_url": os.environ["R2_ENDPOINT_URL"],
            "aws_access_key_id": os.environ["R2_ACCESS_KEY_ID"],
            "aws_secret_access_key": os.environ["R2_SECRET_ACCESS_KEY"],
            "region_name": "auto",
            "config": BotocoreConfig(signature_version="s3v4"),
        }
    except KeyError:
        return

    session = aioboto3.Session()
    try:
        async with session.client("s3", **client_kwargs) as s3:
            for prefix in (f"{slug}/", f"originals/{slug}/"):
                paginator = s3.get_paginator("list_objects_v2")
                async for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
                    keys = [{"Key": o["Key"]} for o in page.get("Contents", [])]
                    if keys:
                        await s3.delete_objects(Bucket=bucket, Delete={"Objects": keys})
    except Exception:  # noqa: BLE001 - see docstring
        return
