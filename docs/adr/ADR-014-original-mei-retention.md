# ADR-014 — Original MEI Retention Policy

**Status:** Accepted
**Date:** 2026-04-28
**See also:** ADR-002 (file storage), `docs/architecture/mei-ingest-normalization.md`

---

## Context

The MEI ingestion pipeline normalises uploaded MEI files before storing them for use by the rest of the system (Verovio rendering, music21 analysis, DCML TSV ingest). Normalisation includes: encoding declaration canonicalisation, measure numbering repair, barline type normalisation, and other fixes documented in `docs/architecture/mei-ingest-normalization.md`.

The normaliser is applied once per upload and its output is what the system treats as the authoritative representation of each movement. However:

- Normalisers have bugs. A normalisation step may silently corrupt a feature of the MEI file that only becomes apparent months later when that feature is needed for a new analysis task.
- Source MEI files from DCML, OpenScore, and other corpora may be updated upstream. Knowing the exact version uploaded is required to reproduce any stored analysis result.
- Auditing stored analyses against the original source requires a byte-for-byte copy of what was uploaded, not the normalised output.

The question is whether to retain the pre-normalisation MEI file alongside the normalised version.

---

## Decision

Retain the original (pre-normalisation) MEI file in R2 under the `originals/` prefix, indefinitely.

The original MEI file is written to:

```
originals/{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei
```

The normalised MEI file is written to:

```
{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}.mei
```

The `originals/` copy is written at ingestion time by `services/ingestion.py` before normalisation runs. It is never overwritten or deleted by the application. Manual deletion by an administrator (e.g. to remove a mistakenly ingested file) is the only intended deletion path.

The `originals/` copy is not served to frontend clients and is not referenced by any API endpoint. It is a backend-only audit and recovery asset.

---

## Consequences

**Positive**

- If a normalisation bug is discovered, the original file can be re-processed through a corrected normaliser without needing to re-upload from the source corpus.
- The exact file that generated any stored `movement_analysis` record can be identified by comparing the upload timestamp with corpus version metadata.
- Storage overhead is modest: MEI files are text (XML), typically 50KB–2MB each. Doubling the MEI storage cost is negligible relative to R2's per-GB pricing at Phase 1 corpus scale.

**Negative**

- The `originals/` prefix is a convention enforced by application code and documentation, not by bucket-level access controls. A future developer writing a new ingestion path must know to write to both keys. `services/object_storage.py` documents the convention explicitly.
- Retention without a deletion policy means the `originals/` prefix grows monotonically. This is acceptable at corpus scale but should be reviewed if the corpus reaches tens of thousands of movements.

**Neutral**

- R2 does not charge egress for internal access from the backend. Reading the `originals/` copy for re-processing incurs no additional egress cost.
- The `originals/` key structure mirrors the normalised key structure. Given the same slugs, the original can always be located from the normalised key by prepending `originals/`.

---

## Alternatives considered

**Discard the original after normalisation.** Rejected. The normaliser is not trivially invertible and may have bugs discovered only after analysis data has accumulated. Discarding the original removes the recovery path. The storage cost of retention is negligible.

**Store originals in a separate bucket.** Considered but rejected. A separate bucket adds configuration overhead (credentials, lifecycle rules, access controls) with no benefit over the `originals/` prefix within the same bucket. Prefixes provide sufficient logical separation without operational complexity.

**Store originals in PostgreSQL (bytea or large object).** Rejected. PostgreSQL is the wrong tool for binary file storage at this volume; the same reasoning that led to ADR-002's rejection of in-database MEI storage applies equally to originals.
