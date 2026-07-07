# Component 9 — Staging Read-Through: Interlock Plan

This plan sequences the issue clusters from `docs/reports/component-9-reports/staging-readthrough-issues.md` (the canonical issue list; family tracking tables live there) into the existing Component 9 Steps. It is kept **separate** from `component-9-corpus-population-and-hardening.md` deliberately: the main plan is the agreed scope of record, and this read-through is a mid-flight correction layer that mostly *reopens* already-"done" Steps and *gates* Step 10. Folding it in would blur which parts of C9 shipped clean and which were reopened.

Cross-references use the issue IDs (A1, B3, …) from the triage report and the Step numbers from the main C9 plan.

## The one structural fact

**Step 9 is not "done."** It re-ingested the 15 movements and so propagated the Step 6–8 fixes — but it also introduced the clef regressions (A1–A3) and shipped over the still-open accidental-realisation gap (B1–B2). So the corpus **cannot be frozen yet**, and the campaign's "corpus frozen" gate (main plan, Hard Gate 2) is not met.

Everything else follows from this: the normalizer must be finished and the 15 re-verified **before** Step 10 (full ingest of the remaining 39), because re-ingesting after fragments exist is the `mc`-drift risk the whole plan was built around (main plan, "Decisions taken into this plan" → "Corpus is final before the campaign").

## Three bands, by when they must happen

### Band 1 — Blocks Step 10 (reopened Part 2 + the errata mechanism)

These change the normalizer or the source data; they must land, and the 15 must be re-verified, before any new ingestion.

| Order | Work | Issues | Step |
|---|---|---|---|
| 1 | **ADR-027 — corrections overlay** ratified (the mechanism B3/C2 and all future errata depend on). Check redistribution against ADR-009. | B3, C2 | new ADR, then a normalizer correction pass |
| 2 | **Clef recovery fixes** — widen idempotency guard (A1), inject into every layer / hoist to staff scope (A2), section-aware index (A3). Extend the Step 6 render spot-check list with multi-voice + multi-section measures. | A1–A3 | reopen Step 6 |
| 3 | **Accidental realisation** — MIDI trace on the re-ingested files (B2), then the accidental-completion pass if confirmed needed (B1). | B1–B2 | new Step 7b |
| 4 | **Staff presentation** — labels / brace / `bar.thru` normalisation, bundled into the incipit-title regen pass so incipits regenerate once. | D1 | Step 8b |
| 5 | **First errata entries** authored against the overlay — trio start-repeat (C2), accidental errata (B3). | B3, C2 | overlay data |
| 6 | **Re-verify the 15** — re-run the normalizer, confirm A/B/D fixed on the render spot-check + a fresh MIDI dump, confirm **`mc` stability** (compare against `mc-stability-snapshot.json`); document any drift per the Step 9 runbook. | — | Step 9 (re-run) |

Only after band 1 closes does **Step 10** run — and the band-1 triage decisions (overlay, clef, staff-presentation) then apply automatically to the 39 new movements, where multi-voice and multi-section writing is *more* common than in K279.

Courtesy-clef placement (D3) is *designed* with A1–A3 here but its actual normalisation is a nicety that may defer to P2 if it doesn't fall out of the clef-scope fix for free.

### Band 2 — Parallel, independent of the corpus freeze (Stream C work)

No effect on `mc`/ingestion; can land any time, ideally before the campaign so reviewers aren't fighting the tool. **F1 should be pulled forward** — hanging notes will plague the review cycles.

| Work | Issues | Step |
|---|---|---|
| Global note-off on stop/pause | **F1 (pull forward)** | Step 18/20 |
| Caret: height from staff extents (E1), ornament filtering (E2), repeat-seam precedence + test (E3) | E1–E3 | reopen Step 19 |
| First-note-from-position race | F2 | Step 20 |
| `NaN` transport/display guard | C1 | Step 3 |
| Beat display: fractions + inclusive end | G1 | Step 15 (extend) |
| Harmony sidebar beat-clip | H1 | Step 21/23 |
| Login button when logged out | I1 | Step 12 |
| "Token has expired" translation | I2 | Step 25 |
| Composer-name + catalogue de-duplication | J1, J2 | Step 13 |
| Stage ordering (after surface check) | G2 | Part 1 / Step 15 |

### Band 3 — Investigate or defer to Phase 2

Genuine, but not worth blocking C9. Each needs a scoping/feasibility pass before it's a fix.

| Work | Issues | Note |
|---|---|---|
| Spacebar-to-play + collision guards | F3 | design the guard set first |
| Playback speed control | F4 | must resync the caret clock, not just `bpm` |
| Scroll-follow caret | F5 | needs user-scroll-detection to avoid "fighting" |
| Ornament MIDI timing | F6 | likely a Verovio limit — document it |
| Tuplet-bracket / dashed / long slur cosmetics | D2 | fix only a mis-resolved slur endpoint if cheap |
| Tactile/touch tagging | G3 | real feature, not a tweak |

## Gate checklist (what "ready for Step 10" means)

> **Not green yet (2026-06-30).** Francisco's staging read-through of the re-ingested 15 found **A1, A3, D1-labels, and C2-playback still broken** — the prep-level audits that marked them "fixed" have blind spots (clef_audit can't see misplaced/missing clefs; staff_audit can't see group-level labels). See the "Staging re-verification (2026-06-30)" section in `staging-readthrough-issues.md`. A2, B1, B2, B3, and `mc`-stability **are** verified on staging. **Step 10 stays blocked** until A1/A3/D1-labels land and re-verify on a render (C2-playback may follow as a multi-section item).

- [x] ADR-027 (corrections overlay) ratified; ADR-009 redistribution question answered. (Mechanism landed: `mei_normalizer` Pass 0 + `services/corrections_overlay.py` loader + `backend/seed/corrections/`. First errata entries are Band 1 Item 5 / the B3/C2 checklist line below.)
- [~] A1–A3: **A2 ✔ verified on staging; A1 + A3 RE-OPENED (2026-06-30).** A1/A3 are one bug, and not the hypothesised one — on K331/ii `recover_measure_start_clefs` is a **no-op** (`_extract_measure_start_clefs` returns 0 of the 22 bass clefs, because MuseScore encodes them as *trailing* clefs after the notes, which the extractor rejects as mid-measure), and Verovio collapses minuet+trio into one MEI `<section>`, so the trio's clefs collide onto the minuet measures of the same number on import (spurious minuet m7/25/37/43 = the trio's clefs; trio left empty). Fix needs: extract trailing measure-start clefs + a collision-robust placement that overrides the converter. `clef_audit` is blind to misplaced/missing clefs — re-verify on a render. (Original idempotency-guard/per-voice/section-index work landed and fixed A2, but did not address this.)
- [x] B1–B2 **fixed** (2026-06-28, ADR-028): Pass 9 rewritten as `_resolve_gestural_accidentals` — staff+octave-scoped, section-aware, onset-ordered full resolution (sets/overrides/removes `accid.ges`). The Verovio-behaviour check is settled (each note realised from its own `accid`/`accid.ges` only). Verified: 81 normalizer unit tests + `scripts/accidental_trace.py` reporting 0 mismatches on all seven movements (27 on raw prep) with a MIDI cross-check. *Passing on staging is confirmed at Band 1 Item 6.*
- [~] D1 (2026-06-28, ADR-029): brace + `bar.thru` ✔ **verified on staging**, but **labels RE-OPENED (2026-06-30)**. Pass 11 strips labels only from `<staffDef>`/`<instrDef>`, but the converter emits instrument labels as `<label>`/`<labelAbbr>` **children of the leaf `<staffGrp>`** (K331 all three; K332/i, /iii), which survive and render as "Piano" / "Piano, Piano right" + "Pno." on later systems. The ADR-029 "no labels on the current converter" claim was wrong — it rested on `staff_audit`, which doesn't check group-level labels. Fix: Pass 11 also strips `<label>`/`<labelAbbr>` from the leaf `<staffGrp>`; audit checks them.
- [x] B3/C2 errata entered in the overlay with reference citations. (2026-06-29, ADR-027 first entries + ADR-030. `backend/seed/corrections/mozart__piano-sonatas.yaml`: C2 — K331/ii Trio *second-strain* start-repeat (mc65); B3 — K332/ii m24 beat-4 C→natural and K279/ii m51 LH B♭ cautionary flat. All cite the NMA. **Prerequisite landed:** ADR-030 enabled Verovio `xmlIdChecksum` in corpus-prep so the xml:id locator is deterministic and survives the Item 6 re-prep — the prep had to change before any xml:id-keyed errata could be authored. Pass 9 amended (ADR-028) to drop a gestural that contradicts a corrected printed `@accid`, keeping each accidental erratum a single entry. Verified on fresh prep: all fire with no warnings and correct Verovio MIDI; 104 unit tests pass. *Staging confirmation at Item 6.*)
- [x] The 15 re-verified; `mc` stability confirmed against the snapshot; drift (if any) documented. **Done (2026-06-29)** — `docs/reports/component-9-reports/band1-item6-offline-verification.md`. Offline: re-prep+normalize all 15 with the full Band-1 pipeline (ADR-030 deterministic ids + overlay) → **all 15 mc-STABLE**, A/B/D clean (clef/accid/staff 0), 3 errata fire. Live re-ingest against the local stack: 15 accepted/0 rejected, `verify` STABLE pre- and post-ingest, the 3 errata confirmed in the stored MEI, 15 incipits + 9 fragment previews regenerated, 0 task failures. Caught + fixed a real bug — the overlay was named `mozart__mozart-piano-sonatas.yaml` but the corpus slug is `piano-sonatas`, so Pass 0 silently found no overlay; renamed to `mozart__piano-sonatas.yaml` and re-pointed the guard test at the real slug. Fragments are `(bar/mc/beat)`-coordinate only, so ADR-030's id churn cannot expose them. **Caveat (2026-06-30):** the offline A/B/D audit in this item reported clean, but the human staging read-through then found A1/A3/D1-labels still broken — the audits have blind spots (see the gate banner above). `mc`-stability and the overlay landing are solid; the render-level fixes are not. So this item's re-ingest stands, but it does **not** by itself clear the A1/A3/D1 gate rows.

When this is green, the corpus can be ingested (Step 10), verified (Step 11), and **then** frozen — and the campaign's corpus gate is genuinely met.
