"""Unit tests for services/object_storage.py.

All aioboto3 I/O is replaced with mocks so no running MinIO is needed.
Integration tests (tests/integration/test_object_storage.py) cover the real
round-trip behaviour and remain unchanged.

Test structure:
    TestMakeStorageClient   — env-var reading, KeyError on missing var
    TestPutMei              — correct bucket, key, and body forwarded
    TestPutMeiOriginal      — originals/ prefix prepended automatically
    TestPutSvg              — ContentType header set correctly
    TestSignedUrl           — default TTL (CLIENT_FACING_URL_TTL), custom TTL
    TestGetMei              — success path and ClientError propagation
    TestIncipitKey          — pure function, no mocking required
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import pytest
from botocore.exceptions import ClientError
from services.object_storage import (
    BACKEND_PROCESSING_TTL,
    CLIENT_FACING_URL_TTL,
    StorageClient,
    incipit_key,
    make_storage_client,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mock_s3(**method_overrides: object) -> MagicMock:
    """Return an async mock that stands in for an aioboto3 S3 client.

    The mock is returned as the context manager's ``__aenter__`` value so that
    code written as ``async with session.client("s3", ...) as s3:`` receives it.
    """
    s3 = AsyncMock()
    for name, value in method_overrides.items():
        setattr(s3, name, value)
    return s3


def _make_storage_client(s3_mock: MagicMock) -> StorageClient:
    """Return a StorageClient whose aioboto3 session is replaced by *s3_mock*."""
    client = StorageClient(
        endpoint_url="http://localhost:9000",
        bucket_name="test-bucket",
        access_key_id="key",
        secret_access_key="secret",
    )
    # Patch the session so that .client(...) returns an async CM yielding s3_mock.
    cm = MagicMock()
    cm.__aenter__ = AsyncMock(return_value=s3_mock)
    cm.__aexit__ = AsyncMock(return_value=False)
    client._session = MagicMock()
    client._session.client.return_value = cm
    return client


# ---------------------------------------------------------------------------
# TestMakeStorageClient
# ---------------------------------------------------------------------------


class TestMakeStorageClient:
    def test_reads_env_vars(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """make_storage_client() reads the four required env vars."""
        monkeypatch.setenv("R2_ENDPOINT_URL", "http://r2.example.com")
        monkeypatch.setenv("R2_BUCKET_NAME", "my-bucket")
        monkeypatch.setenv("R2_ACCESS_KEY_ID", "AKID")
        monkeypatch.setenv("R2_SECRET_ACCESS_KEY", "SECRET")

        sc = make_storage_client()

        assert sc._endpoint_url == "http://r2.example.com"
        assert sc._bucket_name == "my-bucket"
        assert sc._access_key_id == "AKID"
        assert sc._secret_access_key == "SECRET"

    def test_raises_on_missing_var(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """make_storage_client() raises KeyError when any env var is absent."""
        for key in (
            "R2_ENDPOINT_URL",
            "R2_BUCKET_NAME",
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
        ):
            monkeypatch.delenv(key, raising=False)

        with pytest.raises(KeyError):
            make_storage_client()


# ---------------------------------------------------------------------------
# TestPutMei
# ---------------------------------------------------------------------------


class TestPutMei:
    async def test_puts_to_correct_bucket_and_key(self) -> None:
        """put_mei forwards the exact key and bytes to S3 put_object."""
        s3 = _make_mock_s3()
        sc = _make_storage_client(s3)
        key = "mozart/piano-sonatas/k331/movement-1.mei"
        content = b"<mei><music/></mei>"

        await sc.put_mei(key, content)

        s3.put_object.assert_awaited_once_with(
            Bucket="test-bucket", Key=key, Body=content
        )

    async def test_no_originals_prefix(self) -> None:
        """put_mei does not add any prefix to the key."""
        s3 = _make_mock_s3()
        sc = _make_storage_client(s3)

        await sc.put_mei("composer/corpus/work/mov.mei", b"bytes")

        called_key = s3.put_object.call_args.kwargs["Key"]
        assert not called_key.startswith("originals/")


# ---------------------------------------------------------------------------
# TestPutMeiOriginal
# ---------------------------------------------------------------------------


class TestPutMeiOriginal:
    async def test_prepends_originals_prefix(self) -> None:
        """put_mei_original stores under originals/{key}."""
        s3 = _make_mock_s3()
        sc = _make_storage_client(s3)
        key = "mozart/piano-sonatas/k331/movement-1.mei"
        content = b"<original/>"

        await sc.put_mei_original(key, content)

        s3.put_object.assert_awaited_once_with(
            Bucket="test-bucket",
            Key=f"originals/{key}",
            Body=content,
        )

    async def test_original_key_differs_from_normalized(self) -> None:
        """The key used for original storage is distinct from the normalized key."""
        s3 = _make_mock_s3()
        sc = _make_storage_client(s3)
        key = "composer/corpus/work/mov.mei"

        await sc.put_mei_original(key, b"x")

        called_key = s3.put_object.call_args.kwargs["Key"]
        assert called_key == f"originals/{key}"
        assert called_key != key


# ---------------------------------------------------------------------------
# TestPutSvg
# ---------------------------------------------------------------------------


class TestPutSvg:
    async def test_sets_svg_content_type(self) -> None:
        """put_svg passes ContentType=image/svg+xml to put_object."""
        s3 = _make_mock_s3()
        sc = _make_storage_client(s3)
        svg = '<svg xmlns="http://www.w3.org/2000/svg"/>'

        await sc.put_svg("some/key/incipit.svg", svg)

        s3.put_object.assert_awaited_once_with(
            Bucket="test-bucket",
            Key="some/key/incipit.svg",
            Body=svg.encode("utf-8"),
            ContentType="image/svg+xml",
        )

    async def test_encodes_svg_as_utf8(self) -> None:
        """put_svg converts the SVG string to UTF-8 bytes before uploading."""
        s3 = _make_mock_s3()
        sc = _make_storage_client(s3)
        svg = "<svg>é</svg>"

        await sc.put_svg("key.svg", svg)

        body = s3.put_object.call_args.kwargs["Body"]
        assert body == svg.encode("utf-8")


# ---------------------------------------------------------------------------
# TestSignedUrl
# ---------------------------------------------------------------------------


class TestSignedUrl:
    async def test_default_ttl_is_client_facing(self) -> None:
        """signed_url defaults to CLIENT_FACING_URL_TTL (1 hour)."""
        expected_url = "https://example.com/signed?Expires=3600"
        s3 = _make_mock_s3(generate_presigned_url=AsyncMock(return_value=expected_url))
        sc = _make_storage_client(s3)

        url = await sc.signed_url("some/key.mei")

        assert url == expected_url
        s3.generate_presigned_url.assert_awaited_once_with(
            "get_object",
            Params={"Bucket": "test-bucket", "Key": "some/key.mei"},
            ExpiresIn=CLIENT_FACING_URL_TTL,
        )

    async def test_custom_ttl_forwarded(self) -> None:
        """signed_url passes a custom expires_in value to the S3 call."""
        s3 = _make_mock_s3(
            generate_presigned_url=AsyncMock(return_value="https://example.com/x")
        )
        sc = _make_storage_client(s3)

        await sc.signed_url("some/key.mei", expires_in=BACKEND_PROCESSING_TTL)

        s3.generate_presigned_url.assert_awaited_once_with(
            "get_object",
            Params={"Bucket": "test-bucket", "Key": "some/key.mei"},
            ExpiresIn=BACKEND_PROCESSING_TTL,
        )

    def test_client_facing_ttl_is_one_hour(self) -> None:
        """CLIENT_FACING_URL_TTL is 3600 seconds (1 hour)."""
        assert CLIENT_FACING_URL_TTL == 3600

    def test_backend_processing_ttl_is_fifteen_minutes(self) -> None:
        """BACKEND_PROCESSING_TTL is 900 seconds (15 minutes)."""
        assert BACKEND_PROCESSING_TTL == 900


# ---------------------------------------------------------------------------
# TestGetMei
# ---------------------------------------------------------------------------


class TestGetMei:
    async def test_returns_raw_bytes(self) -> None:
        """get_mei returns the bytes from the response body."""
        expected = b"<mei><music/></mei>"
        body_mock = AsyncMock()
        body_mock.read = AsyncMock(return_value=expected)
        s3 = _make_mock_s3(get_object=AsyncMock(return_value={"Body": body_mock}))
        sc = _make_storage_client(s3)

        result = await sc.get_mei("mozart/piano-sonatas/k331/movement-1.mei")

        assert result == expected

    async def test_client_error_propagates(self) -> None:
        """get_mei raises ClientError when the S3 client does."""
        error_response = {"Error": {"Code": "NoSuchKey", "Message": "Not found"}}
        s3 = _make_mock_s3(
            get_object=AsyncMock(side_effect=ClientError(error_response, "GetObject"))
        )
        sc = _make_storage_client(s3)

        with pytest.raises(ClientError) as exc_info:
            await sc.get_mei("does-not-exist.mei")

        assert exc_info.value.response["Error"]["Code"] == "NoSuchKey"


# ---------------------------------------------------------------------------
# TestIncipitKey
# ---------------------------------------------------------------------------


class TestIncipitKey:
    def test_expected_path_structure(self) -> None:
        """incipit_key returns the correct slash-joined path."""
        key = incipit_key("bach", "wtc", "bwv846", "prelude")
        assert key == "bach/wtc/bwv846/prelude/incipit.svg"

    def test_uses_all_four_segments(self) -> None:
        """All four slug segments appear in the key."""
        key = incipit_key("mozart", "piano-sonatas", "k331", "movement-1")
        assert "mozart" in key
        assert "piano-sonatas" in key
        assert "k331" in key
        assert "movement-1" in key
        assert key.endswith("/incipit.svg")
