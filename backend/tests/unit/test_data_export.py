"""Unit tests for the export registry (Component 12 Step 8).

The registry is the deliverable, not the three sections that happen to be in it
today: Component 13 must be able to add collections by registering a section
rather than by editing the exporter. These tests pin that contract, and the
document's envelope.

The sections' own SQL is exercised against a real database in
``tests/integration/test_data_rights.py``.
"""

from __future__ import annotations

import uuid
from collections.abc import AsyncGenerator
from typing import Any
from unittest.mock import AsyncMock

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession


@pytest_asyncio.fixture
async def isolated_registry() -> AsyncGenerator[Any, None]:
    """Run against a copy of the registry, restoring it afterwards.

    Yields:
        The ``services.data_export`` module.
    """
    import services.data_export as data_export

    original = dict(data_export._SECTIONS)
    yield data_export
    data_export._SECTIONS.clear()
    data_export._SECTIONS.update(original)


class TestRegistry:
    """A section is registered, not hard-coded."""

    async def test_component_12_registers_its_three_sections(
        self, isolated_registry: Any
    ) -> None:
        assert isolated_registry.registered_sections() == (
            "profile",
            "exercise_history",
            "reading_history",
        )

    async def test_a_new_section_appears_in_the_document(
        self, isolated_registry: Any
    ) -> None:
        """This is exactly what Component 13 will do for collections."""

        async def _collections(db: AsyncSession, user_id: uuid.UUID) -> list[dict]:
            return [{"id": "c1", "title": "Class prep"}]

        isolated_registry.register_section("collections", _collections)
        for name in ("profile", "exercise_history", "reading_history"):
            isolated_registry._SECTIONS[name] = AsyncMock(return_value=[])

        document = await isolated_registry.build_export(
            AsyncMock(spec=AsyncSession), str(uuid.uuid4())
        )

        assert document["collections"] == [{"id": "c1", "title": "Class prep"}]

    async def test_registering_a_name_twice_is_refused(
        self, isolated_registry: Any
    ) -> None:
        """A silent overwrite would drop someone's data from every export."""

        async def _loader(db: AsyncSession, user_id: uuid.UUID) -> list:
            return []

        with pytest.raises(ValueError, match="already registered"):
            isolated_registry.register_section("profile", _loader)


class TestDocumentEnvelope:
    """The document says what it is and who it is for."""

    async def test_carries_version_timestamp_and_user(
        self, isolated_registry: Any
    ) -> None:
        user_id = str(uuid.uuid4())
        for name in list(isolated_registry._SECTIONS):
            isolated_registry._SECTIONS[name] = AsyncMock(return_value=[])

        document = await isolated_registry.build_export(
            AsyncMock(spec=AsyncSession), user_id
        )

        assert document["export_version"] == isolated_registry.EXPORT_VERSION
        assert document["user_id"] == user_id
        assert document["generated_at"].endswith("+00:00")

    async def test_every_loader_receives_the_same_uuid(
        self, isolated_registry: Any
    ) -> None:
        """Loaders take a ``UUID``, not a string — one parse, at the top."""
        user_id = uuid.uuid4()
        loader = AsyncMock(return_value=[])
        for name in list(isolated_registry._SECTIONS):
            isolated_registry._SECTIONS[name] = loader

        await isolated_registry.build_export(AsyncMock(spec=AsyncSession), str(user_id))

        for call in loader.await_args_list:
            assert call.args[1] == user_id
