"""Unit tests for the ALLOWED_ORIGINS CORS fallback (Component 10 Step 11).

``_resolve_origins`` unions the static per-environment allowlist with a
comma-separated ``ALLOWED_ORIGINS`` env var (for Fly PR-preview deploys), while
staying an explicit allowlist — no wildcard, no regex.
"""

from __future__ import annotations

import pytest
from main import _ALLOWED_ORIGINS, _resolve_origins


def test_unset_leaves_static_allowlist_unchanged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv("ALLOWED_ORIGINS", raising=False)
    assert _resolve_origins("staging") == _ALLOWED_ORIGINS["staging"]
    assert _resolve_origins("production") == _ALLOWED_ORIGINS["production"]


def test_env_origins_are_unioned_after_static(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "ALLOWED_ORIGINS", "https://doppia-pr-42.fly.dev,https://doppia-pr-43.fly.dev"
    )
    origins = _resolve_origins("staging")
    assert origins[0] == "https://doppia-staging.fly.dev"  # static first
    assert "https://doppia-pr-42.fly.dev" in origins
    assert "https://doppia-pr-43.fly.dev" in origins


def test_normalises_whitespace_trailing_slash_and_dedupes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv(
        "ALLOWED_ORIGINS",
        "  https://preview.fly.dev/ , https://doppia-staging.fly.dev , ",
    )
    origins = _resolve_origins("staging")
    assert origins.count("https://doppia-staging.fly.dev") == 1  # not duplicated
    assert "https://preview.fly.dev" in origins  # trailing slash + spaces stripped
    assert "" not in origins  # trailing empty entry skipped


def test_wildcard_is_dropped_from_the_credentialed_allowlist(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ALLOWED_ORIGINS", "*,https://ok.fly.dev")
    origins = _resolve_origins("staging")
    assert "*" not in origins
    assert "https://ok.fly.dev" in origins
