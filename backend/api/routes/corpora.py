"""Corpus management routes.

Currently exposes a single endpoint:

    POST /api/v1/composers/{composer_slug}/corpora/{corpus_slug}/upload

which accepts an admin-only multipart upload of the ZIP package produced by
``scripts/prepare_dcml_corpus.py`` and delegates all logic to
:func:`~services.ingestion.ingest_corpus`.

See docs/roadmap/component-1-mei-corpus-ingestion.md §Step 7.
"""

from __future__ import annotations

from api.dependencies import get_storage, require_role
from fastapi import APIRouter, Depends, File, UploadFile
from models.base import get_db
from models.ingestion import IngestionReport
from services.ingestion import ingest_corpus
from services.object_storage import StorageClient
from sqlalchemy.ext.asyncio import AsyncSession

router = APIRouter(prefix="/composers", tags=["Corpora"])


@router.post(
    "/{composer_slug}/corpora/{corpus_slug}/upload",
    status_code=201,
    response_model=IngestionReport,
    dependencies=[require_role("admin")],
    summary="Upload a corpus ZIP",
    response_description="Ingestion report listing accepted and rejected movements.",
)
async def upload_corpus(
    composer_slug: str,
    corpus_slug: str,
    archive: UploadFile = File(
        ..., description="ZIP produced by prepare_dcml_corpus.py"
    ),
    db: AsyncSession = Depends(get_db),
    storage: StorageClient = Depends(get_storage),
) -> IngestionReport:
    """Ingest a corpus upload ZIP.

    Validates, normalises, and persists all movements in the ZIP.  Movements
    that fail MEI validation are listed in ``movements_rejected`` but do not
    prevent successfully validated movements from being persisted.  The entire
    upload is rejected (422) only if ``metadata.yaml`` is invalid, slug
    coherence fails, or every movement is invalid.

    Args:
        composer_slug: Composer identifier from the URL path.
        corpus_slug: Corpus identifier from the URL path.
        archive: Multipart file field containing the corpus ZIP.
        db: Async database session (injected).
        storage: Object storage client (injected).

    Returns:
        :class:`~models.ingestion.IngestionReport` with per-movement outcomes.
    """
    return await ingest_corpus(
        composer_slug=composer_slug,
        corpus_slug=corpus_slug,
        archive_bytes=await archive.read(),
        db=db,
        storage=storage,
    )
