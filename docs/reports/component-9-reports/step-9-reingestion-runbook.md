# Step 9 — Re-ingestion of the existing 15 movements (runbook)

Component 9, Step 9 (`docs/roadmap/component-9-corpus-population-and-hardening.md`).
Steps 6–8 changed the ingestion pipeline, so the 15 already-ingested movements
must be re-processed identically before the tagging campaign begins.

## Why re-ingestion is required

Three of the Step 6–8 changes alter the stored artefacts and therefore must be
re-applied to the existing corpus:

| Step | Change | Layer | Effect on stored artefact |
|---|---|---|---|
| 6 | Measure-start clef recovery | `prepare_dcml_corpus.py` (`.mscx` → MEI) | Adds `<clef>` to the **uploaded** MEI; only re-running prepare brings it in. |
| 7 | Cross-barline tie completion | `mei_normalizer.py` | Adds `<tie>`/`@tie` during normalization at ingest. |
| 8 | Warning severity channel + volta-aware checks | `mei_normalizer.py`, `ingestion.py` | Re-classifies warnings; updates `movement.normalization_warnings`. |
| 8b | Strip movement title from incipit/preview | render tasks | Render-time only — fixed by regenerating incipits/previews. |

Because clef recovery lives in `prepare_dcml_corpus.py` (not the normalizer),
`backfill_mei_normalization.py` alone is **insufficient** — it re-normalizes the
already-stored originals, which were prepared with the old script and lack the
recovered clefs. The correct path is a full **re-prepare → re-upload**.

## mc-stability guarantee (verified)

Fragment `mc_start`/`mc_end` are document-order measure indices (ADR-015). None
of the Step 6–8 changes add, remove, or reorder `<measure>` elements — they only
insert child elements (`<clef>`, `<tie>`, `<accid>`, `<meterSig>`) inside
existing measures. So mc is structurally stable and the 32 existing fragments
(6 approved, 26 draft) keep pointing at the same music.

This is **verified empirically**, not just asserted, by
`scripts/verify_reingest_mc_stability.py` (snapshot before, verify after). The
pre-re-ingestion snapshot is committed at `mc-stability-snapshot.json`.

## Local re-ingestion procedure

Prerequisites: `docker compose up` (postgres, minio, redis), the backend API
running, a Celery worker running, MuseScore 3.6.2, and a clone of
`DCMLab/mozart_piano_sonatas`.

1. **Snapshot mc fingerprints (already done; re-run if storage changed):**
   ```bash
   python scripts/verify_reingest_mc_stability.py snapshot
   ```
   Writes `docs/reports/component-9-reports/mc-stability-snapshot.json`.

2. **Re-prepare the existing 5 sonatas** with the updated pipeline (clef
   recovery included):
   ```bash
   python scripts/prepare_dcml_corpus.py \
     --repo-path ~/src/mozart_piano_sonatas \
     --config scripts/dcml_corpora/mozart-browser-staging.toml \
     --output /tmp/mozart-browser-staging.zip \
     --mscore-path "C:/Program Files/MuseScore 3/bin/MuseScore3.exe"
   ```

3. **Re-upload** (upsert; movement IDs are preserved, so fragment foreign keys
   stay valid). Admin auth required — locally, run the backend with
   `ENVIRONMENT=local AUTH_MODE=local` and use the literal `admin-token`
   (ensure the dev users exist: `python backend/scripts/seed_dev_users.py`).
   The multipart field is named `archive`:
   ```bash
   curl -X POST \
     "http://localhost:8000/api/v1/composers/mozart/corpora/piano-sonatas/upload" \
     -H "Authorization: Bearer admin-token" \
     -F "archive=@/tmp/mozart-browser-staging.zip"
   ```
   The upload re-normalizes, rewrites original + normalized MEI, and re-dispatches
   `ingest_movement_analysis` (ADR-004) and `generate_incipit` per movement.

4. **Verify mc stability:**
   ```bash
   python scripts/verify_reingest_mc_stability.py verify
   ```
   Expect every movement `STABLE`. If anything reports `DRIFTED`, **stop** — list
   the exposed fragments (SQL printed by the script) and migrate/flag them per
   Step 9 before continuing; document the incident in this directory.

5. **Regenerate fragment previews** (the upload path does not — ADR-008's
   MEI-correction trigger fires per-fragment, not on bulk ingest; see
   `preview-regeneration-gap.md` for the pending automation). Run after
   `verify` is clean:
   ```bash
   python scripts/regenerate_fragment_previews.py   # all submitted/approved fragments
   ```
   On staging, run it on the app machine (`fly ssh console -C ...`) while the
   worker is on. **Note (2026-07-05):** the default snapshot path does not
   exist inside the Docker image — run the `snapshot`/`verify` steps with an
   explicit `--output`/`--snapshot` path (e.g. `/tmp/mc-after.json`), or diff
   the machine's fingerprints against the committed snapshot locally.

6. **Spot-check renders** for the Part 2 regression cases: K279/i clef changes
   (mm. 5, 9) and the tie at mm. 13–14, plus incipits now title-free (Step 8b).

## Staging / production

Same sequence, with `R2_*` and `DATABASE_URL` env vars pointed at the deployed
backends (see `backfill_mei_normalization.py` header for the variable list). The
verify step is mandatory there too: production is where real tagged fragments
would be exposed by an unexpected drift.
