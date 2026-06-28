# ADR-027 — MEI Source-Corrections Overlay (Pass 0)

**Date:** 2026-06-28
**Status:** Accepted
**Related:** ADR-009 (DCML licensing constraint), ADR-014 (original MEI retention), ADR-015 (dual measure coordinate system), ADR-022 (accidental normalization, pass 9), ADR-025 (repeat barlines & volta selection), ADR-026 (tie completion, pass 8), ADR-030 (deterministic MEI `xml:id`s — the prerequisite that makes the `xml:id` locator below actually stable)

---

## Context

The Component 9 staging read-through (`docs/reports/component-9-reports/staging-readthrough-issues.md`) surfaced a class of defect that is **not** a normalizer or rendering bug: the *source data itself is wrong*. Two confirmed instances:

- **B3 — source accidental errata.** Notes whose alteration is wrong in the DCML/MuseScore source relative to a reference edition (e.g. K. 279/ii mm. 51–52, where the edition DCML cites has an explicit flat that MuseScore omits; K. 332/ii m. 24; K. 332/iii mm. 22/27/232/237 a B♭ played natural).
- **C2 — missing trio start-repeat.** K. 331/ii's trio has no `|:` start-repeat in the source (a DCML encoding error), so playback's repeat expansion jumps back to the minuet's `|:`.

Francisco raised the meta-question twice: *how should the project deal with mistakes in the source data?* Silent hand-edits are unacceptable — they violate ADR-014 (the original must stay byte-identical and re-processable), they are invisible to reviewers, and they cannot be reconciled against upstream when the DCML repository is updated.

The decision was taken with Francisco on 2026-06-24 (recorded in the triage report, "Source-errata policy"): adopt a **versioned corrections overlay** and ratify it as an ADR before the first correction lands. This ADR is that ratification. It defines the mechanism only; the first concrete entries (C2, then B3) are authored separately (Band 1, Item 5 of the interlock plan).

---

## Decision

### 1. A corrections overlay is *data*, applied by a dedicated normalizer pass

A **corrections overlay** is a YAML data file — one entry per known source error — loaded at ingest and applied by a new **Pass 0** of `services/mei_normalizer.py`, *before* the ten existing normalization passes. Pass 0 runs first because the correctness passes that follow depend on the data being right: repeat-barline pairing (pass 4) and split-measure completion (pass 7) depend on a corrected `|:`; accidental stripping (pass 9) and tie completion (pass 8) depend on corrected accidentals.

Because the overlay is data, growing the list of corrections never touches normalizer logic — the same reason the seed YAMLs are data, not code. Adding a brand-new *kind* of correction (a `field` the mechanism does not yet handle) is the only change that touches code; the supported `field` set is small and extensible (see §3).

The overlay files live in `backend/seed/corrections/`, one file per corpus (`{composer_slug}__{corpus_slug}.yaml`). `services/corrections_overlay.py` owns loading and per-movement filtering; the normalizer receives an already-filtered `list[Correction]` and never touches the filesystem itself (keeping it pure and unit-testable). A movement with no entries (the common case) gets an empty list, and Pass 0 is a no-op — idempotence and the existing fixture corpus are unaffected.

### 2. Each entry is a structured, attributed record

| Field | Purpose |
|---|---|
| `movement` | `{work_slug}/{movement_slug}` — the scope key the loader filters on. |
| `target.xml_id` | Stable locator: the MEI `xml:id` of the affected element (note or measure). |
| `target.fallback` | Human-readable `(mc, staff, layer, beat, pname, oct)` locator, advisory only — used by a reviewer when an `xml_id` drifts. |
| `field` | What is being corrected (`accid`, `accid.ges`, `repeat-start`, `repeat-end`, …). |
| `expected` | The **current wrong value** in the source (the pre-state). Load-bearing — see merge-back below. `null` means the attribute is currently absent. |
| `corrected` | The value to write. `null` means remove the attribute. |
| `rationale` | Why this is an error, **citing the reference edition** (e.g. "NMA/Henle prints an explicit flat; DCML/MuseScore omits it"). |
| `class` | `errata` (objective error vs. a reference edition) **or** `editorial` (a defensible variant we prefer). Only `errata` is PR-worthy upstream. |
| `upstream` | `none` / `submitted` (+ PR URL) / `merged` / `superseded`. |
| `source_sha` | The DCML source git SHA the entry was authored against (the prep script already records this via `get_git_sha`). |
| `added` | Date + author. |

`expected` and `corrected` must differ (a no-op correction is rejected at load by the Pydantic model).

### 3. The pre-state check makes the pass idempotent and merge-back-safe

For each correction, Pass 0 locates the target by `xml:id`, resolves `field` to a concrete `(child-element?, attribute)`, reads the current value, and acts on a **three-way** comparison — exactly the design Francisco's merge-back concern requires:

1. **Current value already equals `corrected`** (upstream fixed it our way, *or* this is a second normalizer pass over already-corrected output) → **no-op**, recorded as `info` `CORRECTION_SUPERSEDED`. No double-correction is possible because the pass never fires when the value is already right.
2. **Current value equals `expected`** → **apply** the correction (`changes_applied`, audited with field, target, `expected → corrected`, class, and rationale).
3. **Current value is neither** (upstream fixed it *differently*, or the location drifted, or the `xml_id` is gone) → **skip and warn** (`warning` `CORRECTION_PRESTATE_MISMATCH` / `CORRECTION_TARGET_MISSING`), so a human decides whether to retire or re-target the entry.

This makes Pass 0 idempotent (re-running on its own output hits case 1) and makes "upstream merged it" a self-retiring no-op rather than a conflict. Pinning `source_sha` per entry means an upstream version bump automatically re-validates the whole overlay through these pre-state checks — no separate audit needed.

The supported `field` set at ratification — sufficient for the first errata (C2, B3) — is `repeat-start`/`repeat-end` (the measure's `@left`/`@right` barline) and `accid`/`accid.ges` (the note's `<accid>` child). An unrecognised `field` is skipped with a `warning` (`CORRECTION_UNKNOWN_FIELD`) rather than silently ignored.

### 4. Errata are the upstream-PR backlog

The overlay is, by construction, the dataset we would file upstream: every `class: errata` entry is a precise, located, reference-cited error report against the DCML repository. Filtering on `class: errata` produces the PR backlog; the `rationale` + citation is most of the PR body already written. `class: editorial` entries stay local — they are our preference, not an objective fix, and must not be pushed onto the source. The retirement workflow: when an entry logs `CORRECTION_SUPERSEDED` on a re-ingest, confirm against the source, set `upstream: merged`, bump `source_sha`, and move the entry to a `corrections-changelog`.

### 5. Licensing / redistribution (the ADR-009 question)

Band 1 required this be checked against ADR-009. Two distinct artefacts, two distinct answers:

- **The corrected MEI** is a derivative of the CC BY-SA 4.0 DCML score, so it carries CC BY-SA 4.0 — exactly as the *un*corrected DCML-derived MEI already does. ADR-009 already governs this: any MEI or annotation data exposed via the public API derived from DCML material is surfaced with `data_licence: "CC BY-SA 4.0"`. The correction changes the bytes but not the licence class, so **it introduces no new redistribution exposure** and needs no new mechanism. ADR-014 is preserved: the original and the DCML source are never mutated; the correction is applied to the working copy at ingest, transparently and reversibly.
- **The overlay data file itself** — locations, rationales, citations, and the `expected`/`corrected` values — is the project's own authorship (a derived, attributed dataset of error reports, not a copy of the source). It carries no ShareAlike obligation and is unproblematic to keep, to version, and to share upstream as PRs.

The NonCommercial ABC corpus (ADR-009 §2) remains excluded from the public API; the overlay does not change that boundary.

---

## Consequences

**Positive**

- Source errors are corrected transparently, auditably, and reversibly, satisfying ADR-014 instead of fighting it. The ingestion report lists every applied correction with its rationale, so a reviewer sees exactly what differs from the source and why.
- The mechanism doubles as a ready-made upstream-contribution queue, converting private workarounds into shareable, cited corrections.
- The pre-state check neutralises the merge-back risk: re-ingesting after upstream merges a fix is a logged no-op, not a double-correction.
- Both the clef cluster (A) and the accidental cluster (B) needed a place to put genuine source errata; this is it, and it is in scope before Step 10 so the 39 new movements can carry corrections from first ingest.

**Negative**

- The overlay is a convention enforced by code and review, not by the schema. A correction whose `xml_id` drifts after an upstream re-encode degrades to a `CORRECTION_TARGET_MISSING` warning rather than silently mis-applying — acceptable, but it means the overlay must be re-validated on every `source_sha` bump (the pre-state check automates the detection).
- `normalize_mei` gains an optional `corrections` parameter and the ingest path gains an overlay-load step. Both default to "no corrections," so existing callers and the existing corpus are unaffected.

**Neutral**

- Pass 0 is numbered 0 deliberately: it is conceptually *pre*-normalization (it fixes the source before the structural passes run), so it sits ahead of pass 1 without renumbering passes 1–10.
- Corrections target by `xml:id`, which is stable per movement and unaffected by pass 1's measure renumbering or by ADR-015 `mc` coordinates, so Pass 0's ordering relative to the other passes is safe for every supported `field`. **This stability is not free:** Verovio seeds `xml:id`s randomly by default, so the prep had to be made deterministic before any `xml:id`-keyed correction could survive a re-prep. That fix — seeding the ids from a checksum of each movement's input — is **ADR-030**, ratified alongside the first errata entries (Band 1 Item 5). Without ADR-030 the locator silently disarms on the next re-prep.

---

## Alternatives considered

**Silent hand-edits to the stored MEI.** Rejected. Violates ADR-014 (no byte-identical original to re-process from), is invisible to review, and cannot be reconciled with upstream. The whole point of the overlay is to make corrections data, not a one-time manual mutation.

**Edit the DCML `.mscx` source in our fork and re-run the corpus-prep pipeline.** Rejected for the local fix path. It mutates the source (against ADR-014's spirit), requires re-running `mscore`/`verovio` for every correction, and still does not give a structured, filterable errata record. Filing the corrections *upstream* as PRs is the right long-term home for `class: errata`, but the overlay is what makes those PRs cheap; the two are complementary, not alternatives.

**Apply corrections in `scripts/prepare_dcml_corpus.py` (corpus-prep) rather than the normalizer.** Rejected. Corpus-prep needs the `.mscx` and the `mscore` toolchain; the normalizer operates on MEI alone and re-runs from the retained original (ADR-014) without any external tool. Putting Pass 0 in the normalizer means a correction can be added and re-applied by re-ingesting from `originals/`, with no MuseScore round-trip — the same property that makes passes 8–10 live there.

**A free-text correction note per movement.** Rejected. Unstructured notes cannot be applied mechanically, cannot be pre-state-checked for merge-back safety, and cannot be filtered into a PR backlog. The structured record is what makes the mechanism idempotent and upstream-ready.
