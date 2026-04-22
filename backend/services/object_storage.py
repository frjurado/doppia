"""Async S3-compatible object storage client for MEI files.

Thin wrapper around ``aioboto3`` that exposes the four operations used by
the MEI corpus ingestion pipeline and the Verovio rendering service.

The client is environment-agnostic: the same code runs against MinIO locally
and Cloudflare R2 in staging/production.  All configuration is supplied via
environment variables (ADR-002).  No application code branches on environment.

Key convention (ADR-002):

- Normalized MEI:  ``{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei``
- Original MEI:    ``originals/{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei``
- Preview SVG:     ``{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/preview.svg``
  (written by Component 2 / Component 7; not by this module)

Example usage::

    from services.object_storage import make_storage_client

    client = make_storage_client()
    await client.put_mei("mozart/piano-sonatas/k331/movement-1.mei", mei_bytes)
    url = await client.signed_url("mozart/piano-sonatas/k331/movement-1.mei")
"""

from __future__ import annotations

import os

import aioboto3


class StorageClient:
    """Async S3-compatible storage client for MEI files.

    Each public method opens a short-lived ``aioboto3`` client for the
    duration of the call.  This is correct for Phase 1 request volumes;
    a persistent connection pool can be added later if latency measurements
    warrant it.

    Args:
        endpoint_url: Full URL of the S3-compatible endpoint
            (e.g. ``http://localhost:9000`` for MinIO or
            ``https://<account>.r2.cloudflarestorage.com`` for Cloudflare R2).
        bucket_name: Name of the target S3 bucket.
        access_key_id: AWS-style access key ID.
        secret_access_key: AWS-style secret access key.
    """

    def __init__(
        self,
        endpoint_url: str,
        bucket_name: str,
        access_key_id: str,
        secret_access_key: str,
    ) -> None:
        self._endpoint_url = endpoint_url
        self._bucket_name = bucket_name
        self._access_key_id = access_key_id
        self._secret_access_key = secret_access_key
        self._session = aioboto3.Session()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _client_kwargs(self) -> dict[str, str]:
        """Return keyword arguments for opening an ``aioboto3`` S3 client.

        Returns:
            Keyword arguments dict for ``session.client("s3", **kwargs)``.
        """
        return {
            "endpoint_url": self._endpoint_url,
            "aws_access_key_id": self._access_key_id,
            "aws_secret_access_key": self._secret_access_key,
            "region_name": "us-east-1",
        }

    async def _put(self, key: str, content: bytes) -> None:
        """Upload *content* to *key* in the configured bucket.

        Args:
            key: S3 object key.
            content: Raw bytes to store.
        """
        async with self._session.client("s3", **self._client_kwargs()) as s3:
            await s3.put_object(Bucket=self._bucket_name, Key=key, Body=content)

    # ------------------------------------------------------------------
    # Public interface
    # ------------------------------------------------------------------

    async def put_mei(self, key: str, content: bytes) -> None:
        """Store a normalized MEI file.

        Args:
            key: S3 object key following the convention
                ``{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei``.
            content: Normalized MEI bytes.
        """
        await self._put(key, content)

    async def put_mei_original(self, key: str, content: bytes) -> None:
        """Store the pre-normalization (original) MEI file.

        The key is stored under the ``originals/`` prefix so original files
        never collide with normalized files in the same bucket.

        Args:
            key: Logical S3 object key — the same value passed to
                :meth:`put_mei`.  The ``originals/`` prefix is added
                automatically.
            content: Pre-normalization MEI bytes.
        """
        await self._put(f"originals/{key}", content)

    async def get_mei(self, key: str) -> bytes:
        """Fetch a MEI file by its object key.

        Args:
            key: S3 object key of the MEI file.

        Returns:
            Raw MEI bytes.

        Raises:
            botocore.exceptions.ClientError: When the key does not exist
                (``Error["Code"] == "NoSuchKey"``) or any other S3 error
                occurs.
        """
        async with self._session.client("s3", **self._client_kwargs()) as s3:
            response = await s3.get_object(Bucket=self._bucket_name, Key=key)
            return await response["Body"].read()

    async def signed_url(self, key: str, expires_in: int = 300) -> str:
        """Generate a pre-signed GET URL for a stored file.

        The URL is valid for *expires_in* seconds from the moment it is
        generated.  Nothing persistent should store the returned URL; store
        the object key and generate a fresh URL at request time (ADR-002).

        Args:
            key: S3 object key of the file to expose.
            expires_in: URL lifetime in seconds (default 300).

        Returns:
            A pre-signed URL string.
        """
        async with self._session.client("s3", **self._client_kwargs()) as s3:
            return await s3.generate_presigned_url(
                "get_object",
                Params={"Bucket": self._bucket_name, "Key": key},
                ExpiresIn=expires_in,
            )


def make_storage_client() -> StorageClient:
    """Create a :class:`StorageClient` from environment variables.

    Reads ``R2_ENDPOINT_URL``, ``R2_BUCKET_NAME``, ``R2_ACCESS_KEY_ID``, and
    ``R2_SECRET_ACCESS_KEY`` from the process environment.  All four variables
    are required; a missing variable raises :exc:`KeyError`.

    Returns:
        A configured :class:`StorageClient` instance.

    Raises:
        KeyError: When any required environment variable is absent.
    """
    return StorageClient(
        endpoint_url=os.environ["R2_ENDPOINT_URL"],
        bucket_name=os.environ["R2_BUCKET_NAME"],
        access_key_id=os.environ["R2_ACCESS_KEY_ID"],
        secret_access_key=os.environ["R2_SECRET_ACCESS_KEY"],
    )
