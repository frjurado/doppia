# Band 1 Item 6 — re-verification + re-ingest of the 15

**Date:** 2026-06-29
**Scope:** the 15 staging movements (K279, K280, K283, K331, K332 — 3 movements
each), per `scripts/dcml_corpora/mozart-browser-staging.toml`.
**Status:** offline verification **and** the live re-ingest are complete; all 15
mc-stable, all Band-1 fixes + the 3 errata in the stored artefacts.

Item 6 of `docs/roadmap/component-9-staging-readthrough-plan.md` is the Step 9
re-run: re-prepare + re-ingest the 15 with all Band-1 fixes, confirm A/B/D fixed
and **`mc` stability** against `mc-stability-snapshot.json`, then proceed to
Step 10. This report records the **offline** half — everything verifiable
without standing up Docker/MinIO/Postgres — which de-risks the live re-ingest by
proving, ahead of it, that the freshly-prepared artefacts are mc-stable and carry
every fix. The live re-ingest itself (which mutates stored artefacts + the DB)
remains to be run per the runbook; see "Remaining (live)" below.

## Method

For each of the 15, the exact ingest-time pipeline was run locally —
`convert_mscx_to_mxl` → `convert_mxl_to_mei` (now with deterministic
`xmlIdChecksum`, ADR-030) → `recover_measure_start_clefs` → `normalize_mei`
(Pass 0 corrections overlay + all structural passes) — and the result audited.
This is byte-for-byte the artefact the upload path would store, so an offline
PASS predicts the live `verify`. (DCML source pinned at
`5337257a5318711e6302cfe85c3f1a6ade3c6271`; MuseScore 3.)

## Results — all clean

**mc-stability (the gate):** every one of the 15 is **STABLE** — its
pitch/duration per-measure fingerprints (`measure_content_fingerprints`, the same
function the live `verify` uses) match `mc-stability-snapshot.json` exactly. No
measure is added, removed, or reordered, so all 32 existing fragments keep
pointing at the same music.

This holds even though the Band-1 re-prep changes a great deal *inside* measures —
recovered clefs, resolved `accid.ges`, a braced grand staff, a restored Trio
start-repeat, two corrected printed accidentals, and **every `xml:id`** (ADR-030).
The fingerprint hashes only pitch and duration, so it is invariant under all of
these and sensitive only to real measure movement.

**A/B/D fixes present on all 15** (audited on the normalized bytes):

| Audit | Tool | Result |
|---|---|---|
| A — clefs (double / per-voice) | `clef_audit.audit_clefs` | 0 findings |
| B — gestural accidentals | `accidental_trace.audit_accidentals` | 0 mismatches |
| D1 — staff presentation | `staff_audit.audit_staff_presentation` | 0 warnings |

**Overlay (ADR-027) fires:** the 3 errata authored in Band 1 Item 5 all apply
with no `CORRECTION_*` warnings — C2 (K331/ii Trio second-strain start-repeat),
B3 (K332/ii m24 C→natural), B3 (K279/ii m51 cautionary B♭). The other 12
movements have no entries (Pass 0 no-op).

## `mc`-stability and ADR-030 (note)

ADR-030 makes `xml:id`s deterministic but still *changes them once* on this
re-prep (random → checksum-derived). This is safe for fragment integrity:
fragments are stored purely as `(bar/mc/beat)_start/end` coordinates
(`backend/models/fragment.py`, migration 0004) — they hold **no** element
`xml:id` references — so only measure add/remove/reorder could expose them, and
the fingerprint check rules that out. (The original Step 9 re-prep already churned
ids under Verovio's random default; ADR-030 makes future re-preps reproducible
instead.)

## Live re-ingest (done — 2026-06-29)

Ran against the local stack (postgres + minio + redis healthy, host backend +
a `--pool=solo` Celery worker):

1. Re-prepared the 15 → zip (`mozart-browser-staging.toml`, `xmlIdChecksum` ids,
   git SHA `5337257`).
2. Uploaded via `POST /api/v1/composers/mozart/corpora/piano-sonatas/upload`
   (admin-token; upsert, movement IDs preserved). 15 accepted, 0 rejected.
3. `verify_reingest_mc_stability.py verify` → **all 15 STABLE** (pre-flight and
   post-ingest), matching the offline prediction.
4. Stored-artefact spot check confirms the 3 errata landed: K331/ii `e65xqli`
   `left="rptstart"`; K332/ii `c106gvd1` `accid="n"` (no `accid.ges`); K279/ii
   `g1mnbfyc` `accid="f"` (no `accid.ges`).
5. Worker regenerated 15 incipits, ran 15 analysis re-ingests, and
   `regenerate_fragment_previews.py` re-rendered the 9 eligible fragment
   previews — **0 task failures**.

### Bug caught by doing the live run: overlay filename mismatch

The first upload applied **no** overlay corrections. Root cause: the ingestion
service resolves the overlay by `metadata.corpus.slug`, which is `piano-sonatas`
(the slug in the object keys and API path), but the file had been named
`mozart__mozart-piano-sonatas.yaml` (following the README's misleading example),
so `load_corrections` found nothing and Pass 0 was a silent no-op. The offline
check had masked this by passing the corpus slug explicitly. Fixed: renamed to
`mozart__piano-sonatas.yaml`, set the in-file `corpus: piano-sonatas`, corrected
the README / `corrections_overlay.py` docstring examples, and re-pointed the
`test_seed_overlay_entries_validate` guard at the **real** slug so it now
exercises the same file the ingest resolves. Re-uploaded → all 3 errata applied.

## Visual spot-check (for review)

Open each in the score viewer / corpus browser:

- **K331/ii** — the Trio's *second* strain now repeats within the trio (no jump
  back to the Menuetto `|:`); the Trio's first measure still has no `|:`.
- **K332/ii m24** — the beat-4 C prints a natural and plays C♮ (so does the
  bar's last C); the beat-2 C♯ is unchanged.
- **K279/ii m51** — the LH B shows a cautionary ♭ and plays B♭.
- **K279/i** — recovered clef changes (mm. 5, 9) and the m. 13–14 tie.
- **Incipits** — title-free and braced (grand staff), via the regenerated SVGs.
