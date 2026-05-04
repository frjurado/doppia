"""Unit tests for the generate_incipit Celery task.

Tests exercise ``_generate_incipit_async`` directly with all external
dependencies (database, object storage, Verovio) mocked.  No Docker or
real Verovio rendering is required; these run in the same pass as other
unit tests.

The key behaviours verified here are the Verovio call sequence introduced
by the 2026-05-04 spike (Findings 6–9):
- ``select({"measureRange": "start-N"})`` with ``_INCIPIT_BARS`` as N
- ``"start-end"`` fallback for movements shorter than ``_INCIPIT_BARS``
- ``redoLayout()`` called after ``select()`` and before ``renderToSVG()``
- ``setOptions`` called with ``breaks="none"`` (not ``"smart"``)
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from celery.exceptions import Ignore
from services.tasks.generate_incipit import _generate_incipit_async

# ---------------------------------------------------------------------------
# Minimal SVG used as the Verovio render return value.
# ---------------------------------------------------------------------------

_SVG = "<svg xmlns='http://www.w3.org/2000/svg'><g/></svg>"

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


class TestGenerateIncipitAsync:
    """Unit tests for ``_generate_incipit_async``.

    Each test patches ``create_async_engine``, ``AsyncSession``,
    ``make_storage_client``, and ``verovio.toolkit`` so no external
    services are required.
    """

    @staticmethod
    def _async_cm(value=None):
        """Return an async context manager that yields *value*."""
        cm = AsyncMock()
        cm.__aenter__ = AsyncMock(return_value=value)
        cm.__aexit__ = AsyncMock(return_value=False)
        return cm

    def _build_mocks(
        self,
        duration_bars: int | None = 6,
        mei_bytes: bytes = b"<mei/>",
    ):
        """Return (engine, session_class, storage_factory, mock_tk).

        *duration_bars* controls what ``movement.duration_bars`` returns,
        allowing incipit fallback tests without touching anything else.
        """
        engine = AsyncMock()
        engine.dispose = AsyncMock()

        # Phase 1 session: SELECT movement row.
        movement_row = MagicMock()
        movement_row.mei_object_key = "mozart/piano-sonatas/k331/movement-1.mei"
        movement_row.duration_bars = duration_bars
        movement_row.movement_slug = "movement-1"
        movement_row.work_slug = "k331"
        movement_row.corpus_slug = "piano-sonatas"
        movement_row.composer_slug = "mozart"
        read_result = MagicMock()
        read_result.one_or_none.return_value = movement_row
        read_session = AsyncMock()
        read_session.execute = AsyncMock(return_value=read_result)

        # Phase 2 session: UPDATE movement row.
        write_session = AsyncMock()
        write_session.execute = AsyncMock()
        write_session.begin = MagicMock(return_value=self._async_cm())

        session_class = MagicMock(
            side_effect=[self._async_cm(read_session), self._async_cm(write_session)]
        )

        storage = AsyncMock()
        storage.get_mei = AsyncMock(return_value=mei_bytes)
        storage.put_svg = AsyncMock()
        storage_factory = MagicMock(return_value=storage)

        mock_tk = MagicMock()
        mock_tk.loadData.return_value = True
        mock_tk.renderToSVG.return_value = _SVG

        return engine, session_class, storage_factory, mock_tk

    # ------------------------------------------------------------------
    # measureRange selection
    # ------------------------------------------------------------------

    async def test_select_range_start_4_for_normal_movement(self, monkeypatch) -> None:
        """duration_bars=6 (>= _INCIPIT_BARS) → select called with 'start-4'."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")
        engine, session_class, storage_factory, mock_tk = self._build_mocks(
            duration_bars=6
        )

        with (
            patch(
                "services.tasks.generate_incipit.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.generate_incipit.AsyncSession", new=session_class),
            patch(
                "services.tasks.generate_incipit.make_storage_client", storage_factory
            ),
            patch(
                "services.tasks.generate_incipit.verovio.toolkit", return_value=mock_tk
            ),
        ):
            await _generate_incipit_async(str(uuid.uuid4()))

        mock_tk.select.assert_called_once_with({"measureRange": "start-4"})

    async def test_select_range_start_end_for_short_movement(self, monkeypatch) -> None:
        """duration_bars=3 (< _INCIPIT_BARS) → select called with 'start-end'."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")
        engine, session_class, storage_factory, mock_tk = self._build_mocks(
            duration_bars=3
        )

        with (
            patch(
                "services.tasks.generate_incipit.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.generate_incipit.AsyncSession", new=session_class),
            patch(
                "services.tasks.generate_incipit.make_storage_client", storage_factory
            ),
            patch(
                "services.tasks.generate_incipit.verovio.toolkit", return_value=mock_tk
            ),
        ):
            await _generate_incipit_async(str(uuid.uuid4()))

        mock_tk.select.assert_called_once_with({"measureRange": "start-end"})

    async def test_select_range_start_4_when_duration_bars_none(
        self, monkeypatch
    ) -> None:
        """duration_bars=None → select called with 'start-4' (no fallback)."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")
        engine, session_class, storage_factory, mock_tk = self._build_mocks(
            duration_bars=None
        )

        with (
            patch(
                "services.tasks.generate_incipit.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.generate_incipit.AsyncSession", new=session_class),
            patch(
                "services.tasks.generate_incipit.make_storage_client", storage_factory
            ),
            patch(
                "services.tasks.generate_incipit.verovio.toolkit", return_value=mock_tk
            ),
        ):
            await _generate_incipit_async(str(uuid.uuid4()))

        mock_tk.select.assert_called_once_with({"measureRange": "start-4"})

    # ------------------------------------------------------------------
    # Verovio options
    # ------------------------------------------------------------------

    async def test_set_options_breaks_none_and_page_width_2200(
        self, monkeypatch
    ) -> None:
        """setOptions is called with breaks='none' and pageWidth=2200."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")
        engine, session_class, storage_factory, mock_tk = self._build_mocks()

        with (
            patch(
                "services.tasks.generate_incipit.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.generate_incipit.AsyncSession", new=session_class),
            patch(
                "services.tasks.generate_incipit.make_storage_client", storage_factory
            ),
            patch(
                "services.tasks.generate_incipit.verovio.toolkit", return_value=mock_tk
            ),
        ):
            await _generate_incipit_async(str(uuid.uuid4()))

        options = mock_tk.setOptions.call_args[0][0]
        assert options["breaks"] == "none"
        assert options["pageWidth"] == 2200
        assert "pageHeight" not in options

    # ------------------------------------------------------------------
    # Call ordering
    # ------------------------------------------------------------------

    async def test_select_redolayout_called_before_rendertostg(
        self, monkeypatch
    ) -> None:
        """select → redoLayout → renderToSVG in that exact order."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")
        engine, session_class, storage_factory, mock_tk = self._build_mocks()

        call_order: list[str] = []

        def _record(name: str, return_value=None):
            def _inner(*args, **kwargs):
                call_order.append(name)
                return return_value

            return _inner

        mock_tk.select.side_effect = _record("select")
        mock_tk.redoLayout.side_effect = _record("redoLayout")
        mock_tk.renderToSVG.side_effect = _record("renderToSVG", _SVG)

        with (
            patch(
                "services.tasks.generate_incipit.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.generate_incipit.AsyncSession", new=session_class),
            patch(
                "services.tasks.generate_incipit.make_storage_client", storage_factory
            ),
            patch(
                "services.tasks.generate_incipit.verovio.toolkit", return_value=mock_tk
            ),
        ):
            await _generate_incipit_async(str(uuid.uuid4()))

        assert call_order == ["select", "redoLayout", "renderToSVG"]

    # ------------------------------------------------------------------
    # Error path
    # ------------------------------------------------------------------

    async def test_movement_not_found_raises_ignore_and_skips_verovio(
        self, monkeypatch
    ) -> None:
        """SELECT returns None → Ignore raised; Verovio toolkit is never called."""
        monkeypatch.setenv("DATABASE_URL", "postgresql+asyncpg://fake/db")

        engine = AsyncMock()
        engine.dispose = AsyncMock()
        not_found_result = MagicMock()
        not_found_result.one_or_none.return_value = None
        not_found_session = AsyncMock()
        not_found_session.execute = AsyncMock(return_value=not_found_result)
        session_class = MagicMock(return_value=self._async_cm(not_found_session))

        mock_tk = MagicMock()

        with (
            patch(
                "services.tasks.generate_incipit.create_async_engine",
                return_value=engine,
            ),
            patch("services.tasks.generate_incipit.AsyncSession", new=session_class),
            patch(
                "services.tasks.generate_incipit.verovio.toolkit", return_value=mock_tk
            ),
        ):
            with pytest.raises(Ignore):
                await _generate_incipit_async(str(uuid.uuid4()))

        mock_tk.select.assert_not_called()
        mock_tk.renderToSVG.assert_not_called()
