"""Unit tests for the render_fragment_preview Celery task (Component 8 Step 5).

Tests target ``_render_fragment_preview_async`` — the inner async coroutine —
and exercise it directly rather than via the Celery broker.  Verovio rendering,
object storage, and SQLAlchemy are all replaced by mocks; no Docker services
are required.

Integration tests that exercise the full round-trip (real MEI → Verovio SVG →
MinIO write → DB update) follow the ``test_generate_incipit.py`` pattern and
are marked ``@pytest.mark.integration``.

Verification cases from the roadmap (Step 5 / Step 13):
    1. Fragment not found → Ignore raised; no Verovio call.
    2. Draft fragment → Ignore raised; no Verovio call.
    3. Rejected fragment → Ignore raised; no Verovio call.
    4. Submitted fragment → renders, stores SVG under the ADR-008 key, updates row.
    5. Approved fragment → same path as submitted.
    6. SVG key format matches ``fragment_preview_key(...)`` exactly.
    7. Second invocation uses the same stable key (overwrite-in-place guarantee).
    8. Verovio ``select`` is called with the fragment's mc_start-mc_end range.
"""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from celery.exceptions import Ignore

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_row(
    *,
    status: str = "submitted",
    mc_start: int = 1,
    mc_end: int = 4,
    composer_slug: str = "mozart",
    corpus_slug: str = "piano-sonatas",
    work_slug: str = "k331",
    movement_slug: str = "movement-1",
    mei_object_key: str = "mozart/piano-sonatas/k331/movement-1.mei",
) -> MagicMock:
    """Return a lightweight Row-like mock for a fragment + movement JOIN result."""
    row = MagicMock()
    row.status = status
    row.mc_start = mc_start
    row.mc_end = mc_end
    row.mei_object_key = mei_object_key
    row.movement_slug = movement_slug
    row.work_slug = work_slug
    row.corpus_slug = corpus_slug
    row.composer_slug = composer_slug
    return row


class _AsyncCM:
    """Minimal async context manager that yields a fixed value."""

    def __init__(self, value: object) -> None:
        self._value = value

    async def __aenter__(self) -> object:
        return self._value

    async def __aexit__(self, *_: object) -> None:
        pass


def _build_read_session(row: MagicMock | None) -> AsyncMock:
    """Build an AsyncSession mock whose execute().one_or_none() returns row."""
    result = MagicMock()
    result.one_or_none.return_value = row
    session = AsyncMock()
    session.execute = AsyncMock(return_value=result)
    return session


def _build_write_session() -> AsyncMock:
    """Build an AsyncSession mock for the UPDATE path (session.begin() context)."""
    session = AsyncMock()
    session.execute = AsyncMock()
    begin_cm = AsyncMock()
    begin_cm.__aenter__ = AsyncMock(return_value=None)
    begin_cm.__aexit__ = AsyncMock(return_value=False)
    session.begin = MagicMock(return_value=begin_cm)
    return session


@pytest.fixture(autouse=True)
def _db_url(monkeypatch: pytest.MonkeyPatch) -> None:
    """Ensure DATABASE_URL is set so create_async_engine doesn't KeyError."""
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+asyncpg://test:test@localhost/test",
    )


# ---------------------------------------------------------------------------
# TestRenderFragmentPreviewGuards
# ---------------------------------------------------------------------------


class TestRenderFragmentPreviewGuards:
    """Status and existence guards that Ignore non-processable fragments."""

    async def _run_with_row(self, row: MagicMock | None) -> None:
        """Patch all external calls and invoke the async task with a single-call session."""
        fragment_id = str(uuid.uuid4())

        read_session = _build_read_session(row)
        # Only one session is needed for guard cases (no render / write path).
        fake_session_cls = MagicMock(return_value=_AsyncCM(read_session))

        engine = MagicMock()
        engine.dispose = AsyncMock()

        with (
            patch(
                "services.tasks.render_fragment_preview.create_async_engine",
                return_value=engine,
            ),
            patch(
                "services.tasks.render_fragment_preview.AsyncSession",
                fake_session_cls,
            ),
        ):
            from services.tasks.render_fragment_preview import (
                _render_fragment_preview_async,
            )

            with pytest.raises(Ignore):
                await _render_fragment_preview_async(fragment_id)

    async def test_not_found_raises_ignore(self) -> None:
        """Ignore is raised when no fragment row matches the given id."""
        await self._run_with_row(None)

    async def test_draft_fragment_raises_ignore(self) -> None:
        """Ignore is raised for a fragment in 'draft' status."""
        await self._run_with_row(_make_row(status="draft"))

    async def test_rejected_fragment_raises_ignore(self) -> None:
        """Ignore is raised for a fragment in 'rejected' status."""
        await self._run_with_row(_make_row(status="rejected"))


# ---------------------------------------------------------------------------
# TestRenderFragmentPreviewHappyPath
# ---------------------------------------------------------------------------


class TestRenderFragmentPreviewHappyPath:
    """Happy-path rendering for submitted and approved fragments."""

    def _build_mock_stack(
        self,
        fragment_id: str,
        row: MagicMock,
    ) -> dict:
        """Return a dict of all patched objects for a successful render."""
        # Two sessions: read (SELECT) and write (UPDATE).
        read_session = _build_read_session(row)
        write_session = _build_write_session()
        sessions = [_AsyncCM(read_session), _AsyncCM(write_session)]
        fake_session_cls = MagicMock(side_effect=sessions)

        engine = MagicMock()
        engine.dispose = AsyncMock()

        # Storage mock: get_mei returns minimal MEI; put_svg is a no-op.
        storage = AsyncMock()
        storage.get_mei = AsyncMock(return_value=b"<mei/>")
        storage.put_svg = AsyncMock()

        # Verovio toolkit mock: loadData succeeds; renderToSVG returns minimal SVG.
        tk = MagicMock()
        tk.setResourcePath = MagicMock()
        tk.setOptions = MagicMock()
        tk.loadData = MagicMock(return_value=True)
        tk.select = MagicMock()
        tk.redoLayout = MagicMock()
        tk.renderToSVG = MagicMock(return_value="<svg/>")

        return {
            "engine": engine,
            "fake_session_cls": fake_session_cls,
            "storage": storage,
            "mock_make_storage": MagicMock(return_value=storage),
            "tk": tk,
            "mock_toolkit_cls": MagicMock(return_value=tk),
        }

    async def _run_happy(self, fragment_id: str, row: MagicMock) -> dict:
        """Execute the task with mocked dependencies and return the mock stack."""
        mocks = self._build_mock_stack(fragment_id, row)

        with (
            patch(
                "services.tasks.render_fragment_preview.create_async_engine",
                return_value=mocks["engine"],
            ),
            patch(
                "services.tasks.render_fragment_preview.AsyncSession",
                mocks["fake_session_cls"],
            ),
            patch(
                "services.tasks.render_fragment_preview.make_storage_client",
                mocks["mock_make_storage"],
            ),
            patch("verovio.toolkit", mocks["mock_toolkit_cls"]),
        ):
            from services.tasks.render_fragment_preview import (
                _render_fragment_preview_async,
            )

            await _render_fragment_preview_async(fragment_id)

        return mocks

    async def test_submitted_fragment_calls_put_svg(self) -> None:
        """A submitted fragment is rendered and its SVG stored in object storage."""
        fragment_id = str(uuid.uuid4())
        mocks = await self._run_happy(fragment_id, _make_row(status="submitted"))

        mocks["storage"].put_svg.assert_awaited_once()

    async def test_approved_fragment_calls_put_svg(self) -> None:
        """An approved fragment follows the same render path as submitted."""
        fragment_id = str(uuid.uuid4())
        mocks = await self._run_happy(fragment_id, _make_row(status="approved"))

        mocks["storage"].put_svg.assert_awaited_once()

    async def test_key_matches_adr008_pattern(self) -> None:
        """The storage key follows the ADR-008 per-fragment pattern."""
        fragment_id = str(uuid.uuid4())
        mocks = await self._run_happy(fragment_id, _make_row(status="submitted"))

        called_key = mocks["storage"].put_svg.call_args.args[0]
        expected_key = (
            "mozart/piano-sonatas/k331/movement-1" f"/fragments/{fragment_id}.svg"
        )
        assert called_key == expected_key

    async def test_header_suppressed_in_options(self) -> None:
        """Step 8b: setOptions disables the movement-title page header."""
        fragment_id = str(uuid.uuid4())
        mocks = await self._run_happy(fragment_id, _make_row(status="submitted"))

        options = mocks["tk"].setOptions.call_args.args[0]
        assert options["header"] == "none"

    async def test_measure_range_select_uses_mc_bounds(self) -> None:
        """Verovio select is called with the fragment's mc_start–mc_end range."""
        fragment_id = str(uuid.uuid4())
        mocks = await self._run_happy(
            fragment_id, _make_row(status="submitted", mc_start=3, mc_end=6)
        )

        mocks["tk"].select.assert_called_once_with({"measureRange": "3-6"})

    async def test_stable_key_on_two_consecutive_runs(self) -> None:
        """A re-run produces the same storage key, overwriting the prior SVG."""
        fragment_id = str(uuid.uuid4())
        row = _make_row(status="submitted")
        keys_used: list[str] = []

        async def _capture_put(key: str, svg: str) -> None:
            keys_used.append(key)

        for _ in range(2):
            mocks = self._build_mock_stack(fragment_id, row)
            mocks["storage"].put_svg = AsyncMock(side_effect=_capture_put)

            with (
                patch(
                    "services.tasks.render_fragment_preview.create_async_engine",
                    return_value=mocks["engine"],
                ),
                patch(
                    "services.tasks.render_fragment_preview.AsyncSession",
                    mocks["fake_session_cls"],
                ),
                patch(
                    "services.tasks.render_fragment_preview.make_storage_client",
                    mocks["mock_make_storage"],
                ),
                patch("verovio.toolkit", mocks["mock_toolkit_cls"]),
            ):
                from services.tasks.render_fragment_preview import (
                    _render_fragment_preview_async,
                )

                await _render_fragment_preview_async(fragment_id)

        assert len(keys_used) == 2, "put_svg must be called once per run"
        assert keys_used[0] == keys_used[1], "Key must be stable across runs"

    async def test_engine_disposed_after_task(self) -> None:
        """engine.dispose() is called exactly once regardless of success."""
        fragment_id = str(uuid.uuid4())
        mocks = await self._run_happy(fragment_id, _make_row(status="submitted"))

        mocks["engine"].dispose.assert_awaited_once()
