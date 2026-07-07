"""Admin-only management endpoints.

Currently exposes:

    POST /api/v1/admin/dispatch-pending-analysis

which re-enqueues ingest_movement_analysis for every movement row whose
``pending_analysis`` flag is still ``TRUE`` — i.e. movements whose Celery
task was never dispatched or crashed before the DB write.

See docs/adr/ADR-018-partial-failure-recovery-for-ingestion.md.
"""

from __future__ import annotations

import logging
import uuid

from api.dependencies import require_role
from fastapi import APIRouter, Depends
from models.base import get_db
from pydantic import BaseModel
from services.task_dispatch import dispatch_task
from services.tasks.ingest_analysis import ingest_movement_analysis
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin", tags=["Admin"])


class DispatchPendingAnalysisReport(BaseModel):
    """Response body for POST /admin/dispatch-pending-analysis.

    Attributes:
        dispatched: Number of tasks successfully enqueued.
        failed_to_dispatch: Movement UUIDs whose task could not be enqueued
            (broker unreachable or unexpected error).  Empty list on full
            success.
    """

    dispatched: int
    failed_to_dispatch: list[str]


@router.post(
    "/dispatch-pending-analysis",
    status_code=200,
    response_model=DispatchPendingAnalysisReport,
    dependencies=[require_role("admin")],
    summary="Re-dispatch analysis tasks for all pending movements",
    response_description="Count of dispatched tasks and list of any dispatch failures.",
)
async def dispatch_pending_analysis(
    db: AsyncSession = Depends(get_db),
) -> DispatchPendingAnalysisReport:
    """Enqueue ingest_movement_analysis for every movement with pending_analysis=TRUE.

    Each movement is eligible for dispatch if its ``pending_analysis`` flag is
    ``TRUE``, which happens when the original task dispatch failed (broker
    unreachable) or the task itself crashed before the analysis was written.

    The endpoint does **not** flip the flag — ``pending_analysis`` stays
    ``TRUE`` until a successful analysis write clears it inside the task.
    Re-running the endpoint is therefore safe: movements that have already
    been analysed since the last call will have ``pending_analysis=FALSE`` and
    will not be re-dispatched.

    Note: for DCML corpora, ``harmonies_tsv_content`` is not stored in R2 and
    is not available at re-dispatch time.  Those tasks will fail at execution
    with ``ValueError: harmonies_tsv_content is required``; ``pending_analysis``
    will remain ``TRUE``.  The proper recovery path for DCML movements is to
    re-upload the corpus ZIP, which passes the harmonies file through the normal
    ingestion pipeline.

    Args:
        db: Async database session (injected).

    Returns:
        :class:`DispatchPendingAnalysisReport` with dispatch counts.
    """
    rows = (
        await db.execute(
            text(
                "SELECT m.id, c.analysis_source "
                "FROM movement m "
                "JOIN work w ON w.id = m.work_id "
                "JOIN corpus c ON c.id = w.corpus_id "
                "WHERE m.pending_analysis = TRUE"
            )
        )
    ).fetchall()

    dispatched = 0
    failed: list[str] = []

    for row in rows:
        movement_id: uuid.UUID = row.id
        analysis_source: str = row.analysis_source or "none"
        try:
            dispatch_task(
                ingest_movement_analysis,
                movement_id=str(movement_id),
                analysis_source=analysis_source,
                harmonies_tsv_content=None,
            )
            dispatched += 1
        except Exception as exc:
            logger.warning(
                "dispatch-pending-analysis: could not enqueue movement %s: %s",
                movement_id,
                exc,
            )
            failed.append(str(movement_id))

    return DispatchPendingAnalysisReport(
        dispatched=dispatched,
        failed_to_dispatch=failed,
    )
