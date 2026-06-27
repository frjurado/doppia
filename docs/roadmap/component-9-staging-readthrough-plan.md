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

- [ ] ADR-027 (corrections overlay) ratified; ADR-009 redistribution question answered.
- [ ] A1–A3 fixed; multi-voice + multi-section measures on the Step 6 spot-check list and passing.
- [ ] B1–B2 traced; B1 pass implemented or explicitly dropped after the Verovio-behaviour check.
- [ ] D1 normalised; incipits regenerated once (with Step 8b title strip).
- [ ] B3/C2 errata entered in the overlay with reference citations.
- [ ] The 15 re-verified; `mc` stability confirmed against the snapshot; drift (if any) documented.

When this is green, the corpus can be ingested (Step 10), verified (Step 11), and **then** frozen — and the campaign's corpus gate is genuinely met.
