"""Unit tests for services.task_dispatch (ADR-034).

Covers the mode switch (inline default / celery / unknown-value fallback),
inline execution on the dispatch executor, the no-running-loop synchronous
fallback, and the fire-and-forget error containment (task failures and
``Ignore`` are logged, never raised to the caller).

The "task" doubles are MagicMocks shaped like Celery task objects (callable,
with ``.delay`` and ``.name``) — the dispatcher's contract is exactly that
surface, so no broker or real task registration is needed.
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock

import pytest
from celery.exceptions import Ignore
from services.task_dispatch import dispatch_task, task_execution_mode


def _mock_task(name: str = "mock_task", side_effect: object = None) -> MagicMock:
    """Return a MagicMock shaped like a Celery task object."""
    task = MagicMock(name=name, side_effect=side_effect)
    task.name = name
    task.delay = MagicMock()
    return task


class TestTaskExecutionMode:
    def test_defaults_to_inline(self, monkeypatch):
        monkeypatch.delenv("TASK_EXECUTION_MODE", raising=False)
        assert task_execution_mode() == "inline"

    def test_celery_mode(self, monkeypatch):
        monkeypatch.setenv("TASK_EXECUTION_MODE", "celery")
        assert task_execution_mode() == "celery"

    def test_unknown_value_falls_back_to_inline(self, monkeypatch, caplog):
        monkeypatch.setenv("TASK_EXECUTION_MODE", "rabbitmq")
        with caplog.at_level("WARNING"):
            assert task_execution_mode() == "inline"
        assert "rabbitmq" in caplog.text


class TestCeleryMode:
    async def test_dispatch_calls_delay_with_kwargs(self, monkeypatch):
        monkeypatch.setenv("TASK_EXECUTION_MODE", "celery")
        task = _mock_task()

        result = dispatch_task(task, fragment_id="abc")

        assert result is None
        task.delay.assert_called_once_with(fragment_id="abc")
        task.assert_not_called()  # the task body must not run in-process

    async def test_broker_errors_propagate(self, monkeypatch):
        """Celery mode preserves the pre-existing contract: callers on the
        ingest path guard broker failures themselves."""
        monkeypatch.setenv("TASK_EXECUTION_MODE", "celery")
        task = _mock_task()
        task.delay.side_effect = ConnectionError("broker down")

        with pytest.raises(ConnectionError):
            dispatch_task(task, fragment_id="abc")


class TestInlineMode:
    async def test_runs_task_callable_on_executor(self, monkeypatch):
        monkeypatch.setenv("TASK_EXECUTION_MODE", "inline")
        task = _mock_task()

        future = dispatch_task(task, fragment_id="abc")

        assert future is not None
        await future  # deterministic: wait for the executor thread
        task.assert_called_once_with(fragment_id="abc")
        task.delay.assert_not_called()

    async def test_task_exception_is_contained(self, monkeypatch, caplog):
        monkeypatch.setenv("TASK_EXECUTION_MODE", "inline")
        task = _mock_task(side_effect=RuntimeError("verovio exploded"))

        with caplog.at_level("ERROR"):
            future = dispatch_task(task, fragment_id="abc")
            assert future is not None
            await future  # must not raise

        assert "mock_task" in caplog.text
        assert "dropped" in caplog.text

    async def test_ignore_is_logged_quietly(self, monkeypatch, caplog):
        """A task discarding its input (row missing / wrong status) is
        expected behaviour, not an error."""
        monkeypatch.setenv("TASK_EXECUTION_MODE", "inline")
        task = _mock_task(side_effect=Ignore())

        with caplog.at_level("INFO"):
            future = dispatch_task(task, fragment_id="abc")
            assert future is not None
            await future

        assert "ignored" in caplog.text
        assert "ERROR" not in [r.levelname for r in caplog.records]

    def test_no_running_loop_runs_synchronously(self, monkeypatch):
        """Sync script context (no event loop): the task runs in place."""
        monkeypatch.setenv("TASK_EXECUTION_MODE", "inline")
        task = _mock_task()

        result = dispatch_task(task, movement_id="xyz")

        assert result is None
        task.assert_called_once_with(movement_id="xyz")

    def test_no_running_loop_contains_exceptions(self, monkeypatch, caplog):
        monkeypatch.setenv("TASK_EXECUTION_MODE", "inline")
        task = _mock_task(side_effect=RuntimeError("boom"))

        with caplog.at_level("ERROR"):
            dispatch_task(task, movement_id="xyz")  # must not raise

        assert any(r.levelname == "ERROR" for r in caplog.records)

    async def test_dispatch_order_preserved(self, monkeypatch):
        """The single-worker executor runs tasks in dispatch order."""
        monkeypatch.setenv("TASK_EXECUTION_MODE", "inline")
        calls: list[str] = []
        first = _mock_task("first", side_effect=lambda **kw: calls.append("first"))
        second = _mock_task("second", side_effect=lambda **kw: calls.append("second"))

        f1 = dispatch_task(first, fragment_id="1")
        f2 = dispatch_task(second, fragment_id="2")
        assert f1 is not None and f2 is not None
        await asyncio.gather(f1, f2)

        assert calls == ["first", "second"]
