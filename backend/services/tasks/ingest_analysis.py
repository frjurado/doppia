"""Celery task: populate ``movement_analysis.events`` for a single movement.

The task is dispatched by the upload endpoint immediately after the DB
transaction commits.  It receives the raw ``harmonies.tsv`` content as an
argument (so the upload tempdir can be cleaned up immediately), plus the
``movement_id`` UUID and the ``analysis_source`` discriminator.

Dispatch is structured so that the DCML branch is the only one that must be
production-quality in Phase 1.  All other branches raise ``NotImplementedError``
deliberately; they are filled in as the matching corpus is first ingested:

- ``"DCML"`` — implemented in Step 8 (next session).
- ``"WhenInRome"`` — deferred until first When-in-Rome corpus.
- ``"music21_auto"`` — deferred to Component 6.
- ``"none"`` — no-op; no expert annotation and no music21 fallback yet.

See docs/roadmap/component-1-mei-corpus-ingestion.md §Step 8 and ADR-004.
"""

from __future__ import annotations

from typing import Literal

from services.celery_app import celery_app


@celery_app.task(name="ingest_analysis")
def ingest_movement_analysis(
    movement_id: str,
    analysis_source: Literal["DCML", "WhenInRome", "music21_auto", "none"],
    harmonies_tsv_content: str | None = None,
) -> None:
    """Populate ``movement_analysis.events`` for *movement_id*.

    Args:
        movement_id: UUID of the ``movement`` row (as a string).
        analysis_source: Provenance discriminator from ``corpus.analysis_source``.
        harmonies_tsv_content: Raw TSV text for DCML corpora; ``None`` otherwise.

    Raises:
        NotImplementedError: For branches not yet implemented (DCML, WhenInRome,
            music21_auto).  These are intentional placeholders.
        ValueError: When *analysis_source* is not a recognised value.
    """
    if analysis_source == "DCML":
        # Step 8: parse harmonies_tsv_content, upsert movement_analysis.events.
        raise NotImplementedError(
            "DCML analysis ingestion is implemented in Step 8."
        )
    elif analysis_source == "WhenInRome":
        raise NotImplementedError(
            "When in Rome ingestion is deferred until the first non-DCML corpus."
        )
    elif analysis_source == "music21_auto":
        raise NotImplementedError(
            "music21 auto-analysis is deferred to Component 6."
        )
    elif analysis_source == "none":
        # No expert annotation and no music21 fallback yet.
        return
    else:
        raise ValueError(
            f"Unknown analysis_source {analysis_source!r}. "
            "Expected one of: 'DCML', 'WhenInRome', 'music21_auto', 'none'."
        )
