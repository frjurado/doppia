"""Pydantic response models for concept API endpoints.

Used by ``backend/api/routes/concepts.py`` and ``backend/services/concepts.py``.
All models are read-only (response-side only in Component 5; write models
are deferred to later steps).
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class ConceptSearchItem(BaseModel):
    """A single concept hit returned by the search endpoint.

    Attributes:
        id: Immutable concept identifier (the graph join key).
        name: Human-readable concept name.
        aliases: Alternative names / abbreviations (e.g. ``["PAC"]``).
        hierarchy_path: Ancestor names from root to this concept, inclusive
            (e.g. ``["Cadence", "Authentic Cadence", "Perfect Authentic Cadence"]``).
        definition: Long-form definition text, or ``None`` if not set.
    """

    id: str
    name: str
    aliases: list[str] = Field(default_factory=list)
    hierarchy_path: list[str] = Field(default_factory=list)
    definition: str | None = None


class ConceptSearchResponse(BaseModel):
    """Paginated response for ``GET /api/v1/concepts/search``.

    Attributes:
        items: Ordered list of matching concepts (highest relevance first).
        next_cursor: Opaque cursor for the next page; ``None`` when no further
            results exist.
    """

    items: list[ConceptSearchItem]
    next_cursor: str | None = None
