"""Pydantic v2 response models for the corpus browse API.

Read-only response models for the four browse endpoints:
    GET /api/v1/composers
    GET /api/v1/composers/{composer_slug}/corpora
    GET /api/v1/composers/{composer_slug}/corpora/{corpus_slug}/works
    GET /api/v1/works/{work_id}/movements

No input validation is required; all models are output-only.

See docs/roadmap/component-2-corpus-browsing.md §Step 5.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel


class ComposerResponse(BaseModel):
    """Response shape for a single composer list item."""

    id: uuid.UUID
    slug: str
    name: str
    sort_name: str
    birth_year: int | None
    death_year: int | None


class CorpusResponse(BaseModel):
    """Response shape for a single corpus list item."""

    id: uuid.UUID
    slug: str
    title: str
    source_repository: str | None
    licence: str
    work_count: int


class WorkResponse(BaseModel):
    """Response shape for a single work list item."""

    id: uuid.UUID
    slug: str
    title: str
    catalogue_number: str | None
    year_composed: int | None
    movement_count: int


class MovementResponse(BaseModel):
    """Response shape for a single movement list item.

    ``incipit_url`` is a pre-signed URL valid for 15 minutes, or ``None`` when
    the incipit has not yet been generated.  ``incipit_ready`` is ``False``
    when ``incipit_url`` is ``None`` and the frontend should render a
    placeholder.
    """

    id: uuid.UUID
    slug: str
    movement_number: int
    title: str | None
    tempo_marking: str | None
    key_signature: str | None
    meter: str | None
    duration_bars: int | None
    incipit_url: str | None
    incipit_ready: bool
