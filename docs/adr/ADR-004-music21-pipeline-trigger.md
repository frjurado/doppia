# ADR-004 — Analysis Pipeline Trigger and Smart-Merge Policy

**Status:** Accepted (amended 2026-04-28)
**Date:** 2026-03-27

---

## Context

*Amendment note (2026-04-28): This ADR was originally written when music21 was the sole analysis engine. ADR-009 (2026-04-14) and the corpus-and-analysis-sources architecture document introduced DCML and WhenInRome as primary analysis sources, with music21 as a fallback for corpora that have neither. The trigger timing and smart-merge policy described here apply to whichever source the corpus declares; the framing has been updated accordingly. The original music21-specific title ("music21 Preprocessing Pipeline Trigger") is superseded.*

The analysis pipeline auto-extracts structured harmonic information from MEI files and populates `movement_analysis.events`. The analysis source depends on the corpus's declared `analysis_source` field:

- **`"DCML"`** — expert `harmonies.tsv` files are parsed and ingested directly into `movement_analysis`; events carry `source: "DCML"`.
- **`"WhenInRome"`** — WhenInRome annotation files are parsed analogously; events carry `source: "WhenInRome"`. (Deferred to a later component; branch exists but raises `NotImplementedError`.)
- **`"music21_auto"`** — music21 runs harmonic analysis over the MEI file; events carry `source: "music21_auto"`. (Deferred to Component 6.)
- **`"none"`** — no analysis is performed; `movement_analysis` is seeded empty.

For DCML corpora (the primary Phase 1 case), the pipeline parses TSV files rather than running music21. The computational profile is different but the trigger question is the same: the analysis must be available before the annotator creates fragments, so it must run before fragment creation, not after.

The pipeline is non-trivial to run synchronously in a request-response cycle (parsing a large TSV, inserting many rows into `movement_analysis`). It must run asynchronously.

The question is **when** it is triggered. Three options:

**On MEI upload (whole movement, async)** — when an MEI file is successfully ingested, a background task analyses the entire movement and stores the results in a movement-level analysis cache (a `movement_analysis` table). When an annotator subsequently creates a fragment, the preprocessing service slices the relevant bars from the cached analysis rather than re-running the analysis. The annotator sees pre-populated data immediately on fragment creation.

**On fragment submission (async)** — the pipeline runs only for bars that have actually been tagged, not for the entire movement. The annotator submits a fragment record without analysis data, a background task runs the analysis, and the record is updated when the task completes. The annotator sees a "pending" state and must return to the record later to review the auto-generated fields.

**On demand (annotator triggers manually)** — the annotator explicitly requests analysis from the tagging tool UI. Maximum control; requires a UI affordance, a loading state, and a completion notification. The annotator's workflow is interrupted by a waiting period.

The tagging tool's peer review workflow requires that all auto-generated fields with `"auto": true` in the `harmony` array are reviewed before a fragment can be approved. This means the auto-generated data must be available and inspectable before submission, not after. An approach that delivers the data after submission either breaks the review workflow or requires an additional "re-open for review" state.

---

## Decision

Trigger the analysis pipeline **on MEI upload**, asynchronously via a Celery task, processing the entire movement.

When an MEI file passes validation and is stored in R2, a Celery task is enqueued immediately. The task dispatches based on the corpus's `analysis_source`:

1. Fetches the MEI file (and, for DCML/WhenInRome, the companion annotation file) from R2 or the corpus source.
2. Runs the appropriate analysis: parses the TSV for DCML/WhenInRome corpora; runs music21 harmonic analysis for `music21_auto` corpora.
3. Stores the result as a movement-level analysis record in the `movement_analysis` table (keyed by `movement_id`).

When an annotator creates a fragment record in the tagging tool, the preprocessing service reads the relevant beat range from the `movement_analysis` record at render time and presents it for review within the tagging UI. `movement_analysis` is the **single source of truth** for harmonic analysis: the fragment's `summary` does not persist a `harmony` array, and corrections made during tagging write back into the `movement_analysis` event directly (setting the event's `source = "manual"`, `auto = false`, `reviewed = true`). See `docs/architecture/fragment-schema.md` § "Harmonic analysis: movement-level single source of truth" for the full model.

The movement-level cache means the analysis runs once per movement, not once per fragment. A movement that yields 20 tagged fragments incurs one analysis run, not 20.

---

## Consequences

**Positive**

- The annotator's workflow is uninterrupted. Pre-populated data is available immediately when a fragment is created; there is no "pending analysis" state in the tagging tool.
- The analysis runs once per movement regardless of how many fragments are tagged from it. This is the most efficient trigger point.
- The peer review workflow is not complicated. Auto-generated harmony events are present and reviewable from the moment a draft fragment exists; the per-event `reviewed` flag on `movement_analysis` and the approval gate work as designed. Because review state lives at the movement level, a reviewer's work on fragment A satisfies the review gate for any later fragment B that covers overlapping events.
- The movement-level cache is a general asset. Any future feature that needs beat-level harmonic data for a movement (e.g. whole-movement playback annotation, score-level search) can read from `movement_analysis` without re-running music21.

**Negative**

- Movements are processed whether or not they ever yield any tagged fragments. If a corpus of 50 movements is ingested and only 10 are ultimately tagged, the analysis work for 40 movements was unnecessary.
  At Phase 1 corpus scale (tens of movements), this overhead is negligible. If the corpus grows to hundreds of movements and tagging density remains low, the trigger strategy can be revisited — the `movement_analysis` table makes it straightforward to identify which movements have been analysed and which fragments have consumed their analysis.
- The Celery task queue and a Redis broker are required from day one. Redis is already in the Docker Compose stack (wired in for Phase 2 caching); Celery adds a worker process. Both are present in the local development environment; neither adds a new managed service in production.
- If an MEI file is corrected after upload (measure number renumbering, score error fixes), the corresponding `movement_analysis` record is stale. The correction workflow must enqueue a re-analysis task as part of the correction process, and any fragment whose bar range overlaps a changed event must be flagged for re-review. The re-analysis task **must not clobber manually-reviewed events**; it applies the following smart-merge policy:
  - Events with `source = "manual"` or `reviewed = true` are preserved unchanged.
  - Events with `source in ("music21_auto", "DCML", "WhenInRome")` and `reviewed = false` are replaced by the new analysis.
  - New events from the re-analysis that did not exist at their `(bar, beat)` position are inserted.
  - Events that existed before but are not produced by the re-analysis are dropped unless `reviewed = true`, in which case they are preserved and flagged for human reconciliation.

  This policy is documented in full in `docs/architecture/fragment-schema.md` under the `movement_analysis` section; the correction tool and any re-analysis Celery task must implement it faithfully.

**Neutral**

- The `movement_analysis` table records the analysis source and (where applicable) the tool version used for each analysis run (the same practice as the `music21_version` field in `summary` JSONB). When a tool is upgraded and analysis output changes, movements can be selectively re-processed by querying for analyses generated by older versions.
- Fragment creation remains a fast synchronous operation. The preprocessing service reads from `movement_analysis` and slices the relevant bars; it does not call music21 at fragment creation time.

---

## Alternatives considered

**On fragment submission (async).** Rejected because it delivers the auto-generated data after the annotator has submitted the fragment, which conflicts with the peer review workflow: the review of auto-generated fields must happen before approval, and approval cannot be blocked on a background task that has not yet completed. The additional "pending" UI state and the re-open mechanism it would require add complexity with no benefit over the upload-time trigger.

**On demand (annotator triggers manually).** Rejected because it interrupts the tagging workflow with a waiting period and adds a UI affordance (trigger button, loading indicator, completion notification) that has no value if the analysis can be made available automatically. Manual triggering is appropriate when the trigger timing is genuinely ambiguous or when the user needs to control parameters; neither applies here.

**Analysis only for corpora with `analysis_source: "music21_auto"`** (ignoring DCML/WhenInRome on upload). Rejected because the trigger policy — run once per movement on upload, cache in `movement_analysis` — is the same regardless of analysis source. Differentiating the trigger by source would add complexity without benefit; the dispatch logic belongs in the task, not in the trigger decision.
