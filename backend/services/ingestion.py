"""Corpus ingestion service.

Implements the seven-step upload workflow described in
``docs/roadmap/component-1-mei-corpus-ingestion.md`` §Step 7:

1. Unpack ZIP.
2. Parse and validate ``metadata.yaml`` against :class:`~models.ingestion.IngestMetadata`.
3. Slug coherence: URL path params must match metadata slugs.
4. Per-movement MEI validation (:func:`~services.mei_validator.validate_mei`) and
   normalisation (:func:`~services.mei_normalizer.normalize_mei`).
5. Intra-corpus coherence checks (catalogue uniqueness, year plausibility).
6. Single DB transaction with storage writes: upsert all entities, write MEI files.
7. Dispatch one Celery analysis-ingestion task per accepted movement.

The public surface is a single async function:

    report = await ingest_corpus(composer_slug, corpus_slug, archive_bytes, db, storage)
"""

from __future__ import annotations

import io
import logging
import tempfile
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml
from errors import IngestionError

logger = logging.getLogger(__name__)
from models.errors import ErrorCode
from models.ingestion import (
    ComposerMetadata,
    CorpusMetadata,
    IngestionReport,
    IngestMetadata,
    MovementAccepted,
    MovementMetadata,
    MovementRejected,
    WorkMetadata,
)
from models.music import Composer, Corpus, Movement, Work
from models.normalization import NormalizationReport
from pydantic import ValidationError
from services.mei_normalizer import normalize_mei
from services.mei_validator import validate_mei
from services.object_storage import StorageClient
from services.tasks.generate_incipit import generate_incipit
from services.tasks.ingest_analysis import ingest_movement_analysis
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

# ---------------------------------------------------------------------------
# Internal dataclasses (not part of the public API)
# ---------------------------------------------------------------------------


@dataclass
class _AcceptedMovement:
    """All data collected for a single movement that passed validation."""

    work_meta: WorkMetadata
    mov_meta: MovementMetadata
    original_bytes: bytes
    normalized_bytes: bytes
    norm_report: NormalizationReport
    harmonies_bytes: bytes | None


@dataclass
class _DispatchEntry:
    """Arguments for a single Celery task dispatch, collected inside the
    transaction so the tempdir can be cleaned up before dispatch."""

    movement_id: uuid.UUID
    analysis_source: str
    harmonies_bytes: bytes | None


# ---------------------------------------------------------------------------
# Public service function
# ---------------------------------------------------------------------------


async def ingest_corpus(
    composer_slug: str,
    corpus_slug: str,
    archive_bytes: bytes,
    db: AsyncSession,
    storage: StorageClient,
) -> IngestionReport:
    """Validate, normalise, persist, and enqueue a corpus upload ZIP.

    Args:
        composer_slug: Composer slug from the URL path parameter.
        corpus_slug: Corpus slug from the URL path parameter.
        archive_bytes: Raw bytes of the multipart-uploaded ZIP file.
        db: Async SQLAlchemy session injected by FastAPI's ``get_db`` dependency.
        storage: Instantiated object storage client (passed in for testability).

    Returns:
        :class:`~models.ingestion.IngestionReport` describing which movements
        were accepted and which were rejected.

    Raises:
        IngestionError: On ZIP parse failure, metadata validation failure,
            slug mismatch, all-movements-rejected, or corpus coherence failure.
            Maps to 422 Unprocessable Entity via the DoppiaError exception handler.
    """
    # ------------------------------------------------------------------
    # 1. Unpack ZIP
    # ------------------------------------------------------------------
    try:
        zf = zipfile.ZipFile(io.BytesIO(archive_bytes))
    except zipfile.BadZipFile as exc:
        raise IngestionError(
            ErrorCode.INVALID_ZIP, f"Archive is not a valid ZIP file: {exc}"
        ) from exc

    with tempfile.TemporaryDirectory() as _tmpdir:
        tmp = Path(_tmpdir)

        # ------------------------------------------------------------------
        # 2. Parse metadata.yaml
        # ------------------------------------------------------------------
        try:
            raw_yaml = zf.read("metadata.yaml")
        except KeyError:
            raise IngestionError(
                ErrorCode.METADATA_PARSE_ERROR,
                "metadata.yaml not found in archive.",
            )

        try:
            raw_dict = yaml.safe_load(raw_yaml)
            metadata = IngestMetadata.model_validate(raw_dict)
        except (yaml.YAMLError, ValidationError) as exc:
            raise IngestionError(
                ErrorCode.METADATA_PARSE_ERROR,
                f"metadata.yaml failed validation: {exc}",
            ) from exc

        # ------------------------------------------------------------------
        # 3. Slug coherence
        # ------------------------------------------------------------------
        if metadata.composer.slug != composer_slug:
            raise IngestionError(
                ErrorCode.CORPUS_COHERENCE_ERROR,
                f"metadata.composer.slug {metadata.composer.slug!r} does not match "
                f"URL slug {composer_slug!r}.",
            )
        if metadata.corpus.slug != corpus_slug:
            raise IngestionError(
                ErrorCode.CORPUS_COHERENCE_ERROR,
                f"metadata.corpus.slug {metadata.corpus.slug!r} does not match "
                f"URL slug {corpus_slug!r}.",
            )

        # ------------------------------------------------------------------
        # 4. Per-movement validate + normalise
        # ------------------------------------------------------------------
        accepted: list[_AcceptedMovement] = []
        rejected: list[MovementRejected] = []

        for work_meta, mov_meta in metadata.flat_movements():
            compound_slug = f"{work_meta.slug}/{mov_meta.slug}"

            # Read MEI bytes from ZIP
            try:
                mei_bytes = zf.read(mov_meta.mei_filename)
            except KeyError:
                rejected.append(
                    MovementRejected(
                        movement_slug=compound_slug,
                        errors=[
                            {
                                "code": "FILE_NOT_FOUND",
                                "message": f"{mov_meta.mei_filename!r} not found in archive.",
                                "severity": "error",
                            }
                        ],
                    )
                )
                continue

            # Validate MEI
            val_report = validate_mei(mei_bytes)
            if not val_report.is_valid:
                rejected.append(
                    MovementRejected(
                        movement_slug=compound_slug,
                        errors=[e.model_dump() for e in val_report.errors],
                    )
                )
                continue

            # Normalise MEI (writes to tmp files; normalize_mei takes paths)
            src = tmp / f"src_{work_meta.slug}_{mov_meta.slug}.mei"
            dst = tmp / f"norm_{work_meta.slug}_{mov_meta.slug}.mei"
            src.write_bytes(mei_bytes)
            norm_report = normalize_mei(str(src), str(dst))
            normalized_bytes = dst.read_bytes()

            # Read harmonies TSV if present
            harmonies_bytes: bytes | None = None
            if mov_meta.harmonies_filename:
                try:
                    harmonies_bytes = zf.read(mov_meta.harmonies_filename)
                except KeyError:
                    pass  # missing harmonies file is a soft failure; noted but not fatal

            accepted.append(
                _AcceptedMovement(
                    work_meta=work_meta,
                    mov_meta=mov_meta,
                    original_bytes=mei_bytes,
                    normalized_bytes=normalized_bytes,
                    norm_report=norm_report,
                    harmonies_bytes=harmonies_bytes,
                )
            )

        # ------------------------------------------------------------------
        # 5. Intra-corpus coherence checks
        # ------------------------------------------------------------------
        coherence_warnings: list[str] = []
        catalogue_seen: dict[str, str] = {}  # catalogue_number → work_slug

        for work_meta in metadata.corpus.works:
            cat = work_meta.catalogue_number
            if cat is not None:
                if cat in catalogue_seen:
                    raise IngestionError(
                        ErrorCode.CORPUS_COHERENCE_ERROR,
                        f"Duplicate catalogue_number {cat!r}: "
                        f"works {catalogue_seen[cat]!r} and {work_meta.slug!r}.",
                    )
                catalogue_seen[cat] = work_meta.slug

            # Year plausibility
            birth = metadata.composer.birth_year
            death = metadata.composer.death_year
            year = work_meta.year_composed
            if year is not None:
                if birth is not None and year < birth:
                    coherence_warnings.append(
                        f"Work {work_meta.slug!r}: year_composed {year} precedes "
                        f"composer birth_year {birth}."
                    )
                if death is not None and year > death + 50:
                    coherence_warnings.append(
                        f"Work {work_meta.slug!r}: year_composed {year} is "
                        f"suspiciously late (composer death_year {death})."
                    )

        # ------------------------------------------------------------------
        # 6. Abort if every movement was rejected
        # ------------------------------------------------------------------
        if not accepted and rejected:
            raise IngestionError(
                ErrorCode.INVALID_MEI,
                f"All {len(rejected)} movement(s) failed MEI validation.",
                detail={"rejected": [r.model_dump() for r in rejected]},
            )

        # ------------------------------------------------------------------
        # 7. DB transaction + storage writes
        # ------------------------------------------------------------------
        dispatch_entries: list[_DispatchEntry] = []

        async with db.begin():
            # Upsert composer
            composer_id = await _upsert_composer(db, metadata.composer)

            # Upsert corpus
            corpus_id = await _upsert_corpus(db, metadata.corpus, composer_id)

            # Upsert works + movements; write MEI to storage inside the transaction
            # so that any storage failure rolls back the DB writes.
            work_id_cache: dict[str, uuid.UUID] = {}

            for acc in accepted:
                work_slug = acc.work_meta.slug
                if work_slug not in work_id_cache:
                    work_id_cache[work_slug] = await _upsert_work(
                        db, acc.work_meta, corpus_id
                    )
                work_id = work_id_cache[work_slug]

                mei_key = (
                    f"{composer_slug}/{corpus_slug}/"
                    f"{acc.work_meta.slug}/{acc.mov_meta.slug}.mei"
                )
                movement_id = await _upsert_movement(
                    db, acc.mov_meta, work_id, mei_key, acc.norm_report
                )

                # Storage writes — exceptions here roll back the DB transaction.
                await storage.put_mei_original(mei_key, acc.original_bytes)
                await storage.put_mei(mei_key, acc.normalized_bytes)

                dispatch_entries.append(
                    _DispatchEntry(
                        movement_id=movement_id,
                        analysis_source=metadata.corpus.analysis_source,
                        harmonies_bytes=acc.harmonies_bytes,
                    )
                )

    # ------------------------------------------------------------------
    # 8. Dispatch Celery tasks (outside transaction, after commit)
    # ------------------------------------------------------------------
    for entry in dispatch_entries:
        try:
            ingest_movement_analysis.delay(
                movement_id=str(entry.movement_id),
                analysis_source=entry.analysis_source,
                harmonies_tsv_content=(
                    entry.harmonies_bytes.decode() if entry.harmonies_bytes else None
                ),
            )
            generate_incipit.delay(movement_id=str(entry.movement_id))
        except Exception as exc:
            # Broker unavailable (e.g. misconfigured Redis in staging). The
            # upload itself has already succeeded — DB records committed and
            # MEI files stored. Log and continue; tasks can be re-enqueued
            # manually once the broker is reachable.
            logger.warning(
                "Could not enqueue background tasks for movement %s: %s",
                entry.movement_id,
                exc,
            )

    # ------------------------------------------------------------------
    # 9. Return report
    # ------------------------------------------------------------------
    return IngestionReport(
        corpus={"composer_slug": composer_slug, "corpus_slug": corpus_slug},
        movements_accepted=[
            MovementAccepted(
                movement_slug=f"{acc.work_meta.slug}/{acc.mov_meta.slug}",
                warnings=acc.norm_report.warnings,
            )
            for acc in accepted
        ],
        movements_rejected=rejected,
        coherence_warnings=coherence_warnings,
        source_commit=metadata.corpus.source_commit,
    )


# ---------------------------------------------------------------------------
# Private upsert helpers
# ---------------------------------------------------------------------------


async def _upsert_composer(db: AsyncSession, meta: ComposerMetadata) -> uuid.UUID:
    """Upsert the ``composer`` row, returning its UUID.

    Args:
        db: Open async session (within an active transaction).
        meta: Validated composer metadata.

    Returns:
        The ``composer.id`` UUID (existing or newly inserted).
    """
    ins = pg_insert(Composer).values(
        slug=meta.slug,
        name=meta.name,
        sort_name=meta.sort_name,
        birth_year=meta.birth_year,
        death_year=meta.death_year,
        nationality=meta.nationality,
        wikidata_id=meta.wikidata_id,
    )
    stmt = ins.on_conflict_do_update(
        index_elements=["slug"],
        set_={
            "name": ins.excluded.name,
            "sort_name": ins.excluded.sort_name,
            "birth_year": ins.excluded.birth_year,
            "death_year": ins.excluded.death_year,
            "nationality": ins.excluded.nationality,
            "wikidata_id": ins.excluded.wikidata_id,
            "updated_at": func.now(),
        },
    ).returning(Composer.id)
    result = await db.execute(stmt)
    return result.scalar_one()


async def _upsert_corpus(
    db: AsyncSession, meta: CorpusMetadata, composer_id: uuid.UUID
) -> uuid.UUID:
    """Upsert the ``corpus`` row, returning its UUID.

    Args:
        db: Open async session (within an active transaction).
        meta: Validated corpus metadata.
        composer_id: UUID of the parent composer row.

    Returns:
        The ``corpus.id`` UUID (existing or newly inserted).
    """
    ins = pg_insert(Corpus).values(
        composer_id=composer_id,
        slug=meta.slug,
        title=meta.title,
        source_repository=meta.source_repository,
        source_url=meta.source_url,
        source_commit=meta.source_commit,
        analysis_source=meta.analysis_source,
        licence=meta.licence,
        licence_notice=meta.licence_notice,
        notes=meta.notes,
    )
    stmt = ins.on_conflict_do_update(
        index_elements=["composer_id", "slug"],
        set_={
            "title": ins.excluded.title,
            "source_repository": ins.excluded.source_repository,
            "source_url": ins.excluded.source_url,
            "source_commit": ins.excluded.source_commit,
            "analysis_source": ins.excluded.analysis_source,
            "licence": ins.excluded.licence,
            "licence_notice": ins.excluded.licence_notice,
            "notes": ins.excluded.notes,
            "updated_at": func.now(),
        },
    ).returning(Corpus.id)
    result = await db.execute(stmt)
    return result.scalar_one()


async def _upsert_work(
    db: AsyncSession, meta: WorkMetadata, corpus_id: uuid.UUID
) -> uuid.UUID:
    """Upsert the ``work`` row, returning its UUID.

    Args:
        db: Open async session (within an active transaction).
        meta: Validated work metadata.
        corpus_id: UUID of the parent corpus row.

    Returns:
        The ``work.id`` UUID (existing or newly inserted).
    """
    ins = pg_insert(Work).values(
        corpus_id=corpus_id,
        slug=meta.slug,
        title=meta.title,
        catalogue_number=meta.catalogue_number,
        year_composed=meta.year_composed,
        year_notes=meta.year_notes,
        key_signature=meta.key_signature,
        instrumentation=meta.instrumentation,
        notes=meta.notes,
    )
    stmt = ins.on_conflict_do_update(
        index_elements=["corpus_id", "slug"],
        set_={
            "title": ins.excluded.title,
            "catalogue_number": ins.excluded.catalogue_number,
            "year_composed": ins.excluded.year_composed,
            "year_notes": ins.excluded.year_notes,
            "key_signature": ins.excluded.key_signature,
            "instrumentation": ins.excluded.instrumentation,
            "notes": ins.excluded.notes,
            "updated_at": func.now(),
        },
    ).returning(Work.id)
    result = await db.execute(stmt)
    return result.scalar_one()


async def _upsert_movement(
    db: AsyncSession,
    meta: MovementMetadata,
    work_id: uuid.UUID,
    mei_object_key: str,
    norm_report: NormalizationReport,
) -> uuid.UUID:
    """Upsert the ``movement`` row, returning its UUID.

    On re-ingest, ``ingested_at`` is bumped to reflect the new upload time.
    ``created_at`` is left at its original value.

    Args:
        db: Open async session (within an active transaction).
        meta: Validated movement metadata.
        work_id: UUID of the parent work row.
        mei_object_key: Normalized MEI object key (without ``originals/`` prefix).
        norm_report: Normalization report from which ``duration_bars`` and
            ``normalization_warnings`` are taken.

    Returns:
        The ``movement.id`` UUID (existing or newly inserted).
    """
    normalization_warnings: dict[str, Any] | None = (
        {"warnings": norm_report.warnings} if norm_report.warnings else None
    )
    ins = pg_insert(Movement).values(
        work_id=work_id,
        slug=meta.slug,
        movement_number=meta.movement_number,
        title=meta.title,
        tempo_marking=meta.tempo_marking,
        key_signature=meta.key_signature,
        meter=meta.meter,
        mei_object_key=mei_object_key,
        mei_original_object_key=f"originals/{mei_object_key}",
        duration_bars=norm_report.duration_bars if norm_report.duration_bars else None,
        normalization_warnings=normalization_warnings,
    )
    stmt = ins.on_conflict_do_update(
        index_elements=["work_id", "slug"],
        set_={
            "movement_number": ins.excluded.movement_number,
            "title": ins.excluded.title,
            "tempo_marking": ins.excluded.tempo_marking,
            "key_signature": ins.excluded.key_signature,
            "meter": ins.excluded.meter,
            "mei_object_key": ins.excluded.mei_object_key,
            "mei_original_object_key": ins.excluded.mei_original_object_key,
            "duration_bars": ins.excluded.duration_bars,
            "normalization_warnings": ins.excluded.normalization_warnings,
            "ingested_at": func.now(),
            "updated_at": func.now(),
        },
    ).returning(Movement.id)
    result = await db.execute(stmt)
    return result.scalar_one()


