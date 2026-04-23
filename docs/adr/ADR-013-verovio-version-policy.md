# ADR-013 — Verovio Version Policy

**Status:** Accepted  
**Date:** 2026-04-23

---

## Context

`backend/requirements.txt` pins `verovio==4.3.1`. A spike run on 2026-04-23 (documented in `docs/architecture/mei-ingest-normalization.md` §"Verovio bar-range selection: observed behaviour") found that the `select` option — which ADR-008 and Component 3's fragment rendering both depend on — is non-functional in that version: `setOptions` rejects it as an unsupported option, and the `tk.select()` method does not restrict rendered measures.

The current Verovio release is **6.1.0** (March 2026). `select` with `measureRange` has been documented as functional since 3.10 (May 2022) and is supported in 6.1.0. The re-spike against 6.1.0 initially concluded `select` was still non-functional, but a subsequent code review found a bug in the spike script: `tk.select()` was called without the required `tk.redoLayout()` call, causing `renderToSVG()` to render the pre-selection full-score layout. The correct sequence — `loadData()` → `select()` → `redoLayout()` → `renderToSVG()` — is confirmed available in the 6.1.0 Python bindings. No ADR originally documented the 4.3.1 pin; it appears to have been the current release at the time `requirements.txt` was first committed.

### Verovio's versioning scheme (since 2025)

Starting with version 5.0 (February 2025), Verovio adopted a calendar-based major version scheme: the major version increments once per year (5.x in 2025, 6.x in 2026). Minor releases occur roughly every 2–3 months and bring rendering improvements, feature additions, and occasional breaking changes in SVG structure or toolkit API output formats. Patch releases address regressions only.

### Breaking-area changes between 4.3.1 and 6.1.0

Three categories of change require verification before deploying the upgrade:

**SVG structure (5.3, May 2025).** The way SMuFL font glyphs are embedded in the SVG output was refactored to improve compatibility with third-party SVG renderers. All snapshot baselines in `tests/snapshots/` are invalidated and must be regenerated. All incipit SVGs already stored in object storage were rendered under 4.3.1 and must be backfilled.

**Time map key names (5.4, July 2025).** JSON key names in the time map output changed. Any code calling `getTimesForElement()` and parsing its response must be audited against the new names before the upgrade is deployed.

**MIDI repetition expansion default (6.0, January 2026).** Repetitions (first/second endings, dal segno) are now expanded by default in MIDI and time map output. Code relying on the previous non-expansion behaviour must add `"expandRepeats": False` to its options.

---

## Decision

1. **Upgrade immediately to `verovio==6.1.0`** in `backend/requirements.txt` and all Docker images. The upgrade brings `select`-based bar-range rendering into a well-supported release; the correct sequence (`loadData()` → `select()` → `redoLayout()` → `renderToSVG()`) is required for Component 3 fragment rendering and the ADR-008 fragment preview task.

2. **Adopt an annual update cadence.** At the start of each calendar year, upgrade to the latest stable release of the new major version (e.g. upgrade to 7.0.x when available in early 2027). Each upgrade must pass the snapshot test suite and include the breaking-area checks described in `docs/architecture/mei-ingest-normalization.md` §"Verovio version: root cause and upgrade decision".

3. **Always pin to a specific patch version.** Never use a floating `verovio>=x.y` constraint. Verovio updates occasionally include SVG structure changes and time map API changes that can silently corrupt stored previews or break MIDI synchronisation if introduced without a tested upgrade path.

4. **Keep server-side Python bindings and client-side WASM at the same major.minor version.** ADR-008's negative consequences section notes that differing versions between the two runtimes can produce non-identical preview and live-viewer output. Upgrading the Python package and the frontend WASM must happen in the same commit.

---

## Consequences

**Positive**

- Brings the codebase to the current Verovio stable release (6.1.0) with its improved SVG structure. `select()` + `redoLayout()` is the correct and supported API for bar-range rendering in the Python bindings; the re-spike initially concluded otherwise due to a bug in the spike script (missing `redoLayout()`), which has since been identified and corrected.
- The 5.3 SVG structure change makes stored SVGs more compatible with downstream renderers and CDN-level transformations.
- From 5.6, Verovio ships pre-built Python wheels for Ubuntu arm64, eliminating the build step on arm64 CI runners.
- Annual updates keep Doppia aligned with the DCML and MEI ecosystem tooling, reducing integration friction when new corpus sources are added.

**Negative**

- The 5.3 SVG structure change requires regenerating all snapshot baselines and backfilling all stored incipit SVGs.
- The 5.4 time map API change requires an audit of `getTimesForElement()` callers before staging deployment.
- The 6.0 MIDI repetition default may require explicit `"expandRepeats": False` to restore previous test behaviour.

**Neutral**

- MEI 5.x vs. MEI 4 is a non-issue for the DCML corpus: Verovio 6.1 reads both. No corpus re-encoding or normalizer changes are needed.
- MuseScore 4 as a corpus input path is not affected by this decision and remains deferred to Phase 2.

---

## Alternatives considered

**Stay on 4.3.1 and implement SVG viewBox clipping for fragment rendering.** Feasible for Component 3: render the full score with `breaks: "none"`, parse the resulting SVG to locate measure barline x-coordinates, then clip the `viewBox` to the target range. The incipit workaround (smart-break page 1) is already adequate for Component 2. This option became moot once the `select()` + `redoLayout()` sequence was identified as functional — SVG clipping is significantly more complex and remains a fallback only.

**Upgrade to 5.x rather than 6.x.** The same breaking-area changes apply to any 5.x upgrade, and 6.1.0 is the current stable release actively receiving fixes. There is no advantage to stopping at 5.x. Rejected.
