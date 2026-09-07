"""Every route that serves concept-derived text must negotiate a language.

Component 12 Step 19c. Each i18n gap this component fixed had one shape: a
payload naming a concept, served by a route that never asked what language the
reader wanted. That shape is mechanically detectable, and its absence as a
check is how the set accumulated unnoticed — the inventory in Step 19 looked at
frontend strings and database tables and concluded "the gap is data, not code".

The test walks the live FastAPI route table rather than a hand-maintained list,
so a new route carrying concept text fails here on the day it is added.
"""

from __future__ import annotations

import inspect
from typing import Any

from fastapi.routing import APIRoute

# Response-model fields that carry text resolved from the concept graph. A
# route returning any of these is showing a reader words that have a Spanish
# form in `concept_translation`.
_CONCEPT_TEXT_FIELDS = frozenset(
    {
        "hierarchy_path",
        "primary_concept_name",
        "primary_concept_alias",
        "concept_tags",
    }
)

# Routes exempt, with the reason. Kept explicit so an exemption is a decision
# someone wrote down rather than an omission.
_EXEMPT: dict[str, str] = {}


def _model_fields(model: Any, seen: set[Any] | None = None) -> set[str]:
    """Collect field names from a Pydantic model, following nested models."""
    seen = seen if seen is not None else set()
    if model in seen or not hasattr(model, "model_fields"):
        return set()
    seen.add(model)

    names: set[str] = set()
    for name, field in model.model_fields.items():
        names.add(name)
        annotation = field.annotation
        for candidate in (annotation, *getattr(annotation, "__args__", ())):
            names |= _model_fields(candidate, seen)
    return names


def _iter_api_routes(routes: Any) -> list[APIRoute]:
    """Flatten the app's route tree.

    The versioned API is mounted as one included router, so ``app.routes`` holds
    a handful of entries and every real endpoint lives one level down. Walking
    only the top level silently matches nothing — which is what the guard test
    below exists to catch.
    """
    found: list[APIRoute] = []
    for route in routes:
        if isinstance(route, APIRoute):
            found.append(route)
            continue
        # Starlette wraps an included router in a route object that exposes the
        # real router as `original_router`, not as `routes`. Following only
        # `routes` finds nothing at all, which is why the guard test below
        # asserts the matcher saw something.
        original = getattr(route, "original_router", None)
        if original is not None:
            found.extend(_iter_api_routes(original.routes))
            continue
        nested = getattr(route, "routes", None)
        if nested:
            found.extend(_iter_api_routes(nested))
    return found


def _serves_concept_text(route: APIRoute) -> bool:
    model = route.response_model
    if model is None:
        return False
    return bool(_model_fields(model) & _CONCEPT_TEXT_FIELDS)


def _negotiates_language(route: APIRoute) -> bool:
    """True when the handler takes the ``get_language`` dependency."""
    for name, param in inspect.signature(route.endpoint).parameters.items():
        if name == "language":
            return True
        default = param.default
        dependency = getattr(default, "dependency", None)
        if dependency is not None and getattr(dependency, "__name__", "") == (
            "get_language"
        ):
            return True
    return False


def test_every_concept_text_route_negotiates_language() -> None:
    from main import app

    offenders: list[str] = []
    for route in _iter_api_routes(app.routes):
        if not _serves_concept_text(route):
            continue
        if route.path in _EXEMPT:
            continue
        if not _negotiates_language(route):
            offenders.append(f"{sorted(route.methods)} {route.path}")

    assert offenders == [], (
        "These routes return concept-derived text but never negotiate a "
        "language, so they serve English to every reader:\n  "
        + "\n  ".join(sorted(offenders))
    )


def test_the_check_can_actually_see_concept_text_routes() -> None:
    """Guard against the assertion above passing because it matched nothing.

    A field rename would empty `_CONCEPT_TEXT_FIELDS`'s intersection and the
    test would go green while checking nothing at all.
    """
    from main import app

    matched = [
        route.path
        for route in _iter_api_routes(app.routes)
        if _serves_concept_text(route)
    ]
    assert len(matched) >= 5, f"expected several concept-text routes, saw {matched}"
