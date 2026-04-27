"""Integration tests for the object storage client.

Requires ``docker compose up`` (MinIO service) to be running.

Each test run creates a randomly named temporary bucket and tears it down on
completion — tests are fully isolated from the ``doppia-local`` development
bucket and from each other.
"""

from __future__ import annotations

import os
import uuid
from collections.abc import AsyncGenerator

import aioboto3
import pytest
import pytest_asyncio
from botocore.exceptions import ClientError

from services.object_storage import StorageClient, incipit_key

pytestmark = pytest.mark.integration

# ---------------------------------------------------------------------------
# MinIO connection defaults (match .env.example)
# ---------------------------------------------------------------------------

_ENDPOINT_URL = os.environ.get("R2_ENDPOINT_URL", "http://localhost:9000")
_ACCESS_KEY = os.environ.get("R2_ACCESS_KEY_ID", "minioadmin")
_SECRET_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "minioadmin")

_CLIENT_KWARGS: dict[str, str] = {
    "endpoint_url": _ENDPOINT_URL,
    "aws_access_key_id": _ACCESS_KEY,
    "aws_secret_access_key": _SECRET_KEY,
    "region_name": "us-east-1",
}

# ---------------------------------------------------------------------------
# Fixture — isolated temporary bucket
# ---------------------------------------------------------------------------


@pytest_asyncio.fixture
async def storage_client() -> AsyncGenerator[StorageClient, None]:
    """StorageClient backed by a fresh temporary MinIO bucket.

    Creates a randomly named bucket before each test and deletes all objects
    and the bucket itself on teardown, regardless of test outcome.

    Yields:
        A :class:`~services.object_storage.StorageClient` configured against
        the temporary bucket.
    """
    bucket_name = f"test-{uuid.uuid4().hex[:8]}"
    session = aioboto3.Session()

    async with session.client("s3", **_CLIENT_KWARGS) as s3:
        await s3.create_bucket(Bucket=bucket_name)

    yield StorageClient(
        endpoint_url=_ENDPOINT_URL,
        bucket_name=bucket_name,
        access_key_id=_ACCESS_KEY,
        secret_access_key=_SECRET_KEY,
    )

    # Teardown: empty and delete the temporary bucket.
    async with session.client("s3", **_CLIENT_KWARGS) as s3:
        paginator = s3.get_paginator("list_objects_v2")
        async for page in paginator.paginate(Bucket=bucket_name):
            objects = [{"Key": obj["Key"]} for obj in page.get("Contents", [])]
            if objects:
                await s3.delete_objects(
                    Bucket=bucket_name, Delete={"Objects": objects}
                )
        await s3.delete_bucket(Bucket=bucket_name)


# ---------------------------------------------------------------------------
# Test data
# ---------------------------------------------------------------------------

_MEI_KEY = "mozart/piano-sonatas/k331/movement-1.mei"
_MEI_CONTENT = b"<mei><music/></mei>"

_SVG_KEY = incipit_key("mozart", "piano-sonatas", "k331", "movement-1")
_SVG_CONTENT = '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="120"><rect width="800" height="120"/></svg>'

# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


async def test_put_and_get_mei(storage_client: StorageClient) -> None:
    """put_mei followed by get_mei returns the exact original bytes."""
    await storage_client.put_mei(_MEI_KEY, _MEI_CONTENT)
    result = await storage_client.get_mei(_MEI_KEY)
    assert result == _MEI_CONTENT


async def test_put_mei_original_stored_under_originals_prefix(
    storage_client: StorageClient,
) -> None:
    """put_mei_original stores under originals/{key}; the bare key is absent."""
    await storage_client.put_mei_original(_MEI_KEY, _MEI_CONTENT)

    # The prefixed key must be readable.
    result = await storage_client.get_mei(f"originals/{_MEI_KEY}")
    assert result == _MEI_CONTENT

    # The bare key must not exist.
    with pytest.raises(ClientError) as exc_info:
        await storage_client.get_mei(_MEI_KEY)
    assert exc_info.value.response["Error"]["Code"] == "NoSuchKey"


async def test_get_mei_nonexistent_key_raises(storage_client: StorageClient) -> None:
    """get_mei raises ClientError(NoSuchKey) for a key that was never written."""
    with pytest.raises(ClientError) as exc_info:
        await storage_client.get_mei("does-not-exist.mei")
    assert exc_info.value.response["Error"]["Code"] == "NoSuchKey"


async def test_signed_url_returns_string(storage_client: StorageClient) -> None:
    """signed_url returns a non-empty URL string rooted at the endpoint."""
    await storage_client.put_mei(_MEI_KEY, _MEI_CONTENT)
    url = await storage_client.signed_url(_MEI_KEY)
    assert isinstance(url, str)
    assert url.startswith(_ENDPOINT_URL)


async def test_put_svg_and_signed_url_round_trip(storage_client: StorageClient) -> None:
    """put_svg stores the SVG; signed_url returns a readable URL for it."""
    await storage_client.put_svg(_SVG_KEY, _SVG_CONTENT)
    url = await storage_client.signed_url(_SVG_KEY)
    assert isinstance(url, str)
    assert url.startswith(_ENDPOINT_URL)
    # Key path must appear in the presigned URL.
    assert "incipit.svg" in url


def test_put_svg_key_follows_incipit_key_convention() -> None:
    """incipit_key produces the expected path structure."""
    key = incipit_key("bach", "wtc", "bwv846", "prelude")
    assert key == "bach/wtc/bwv846/prelude/incipit.svg"


async def test_signed_url_custom_expiry(storage_client: StorageClient) -> None:
    """signed_url with a custom expires_in returns a valid URL string.

    MinIO (SigV2) encodes expiry as an absolute Unix timestamp in ``Expires=``;
    Cloudflare R2 / AWS (SigV4) uses ``X-Amz-Expires=``.  We verify the URL is
    returned without error and carries some expiry parameter — the encoding is
    an implementation detail of the signature scheme in use.
    """
    import time

    await storage_client.put_mei(_MEI_KEY, _MEI_CONTENT)
    url = await storage_client.signed_url(_MEI_KEY, expires_in=60)
    assert isinstance(url, str) and url.startswith(_ENDPOINT_URL)
    # SigV4: X-Amz-Expires=60  |  SigV2: Expires=<unix timestamp ≈ now+60>
    has_sigv4_expiry = "X-Amz-Expires=60" in url
    has_sigv2_expiry = "Expires=" in url and int(url.split("Expires=")[1].split("&")[0]) > int(time.time())
    assert has_sigv4_expiry or has_sigv2_expiry
