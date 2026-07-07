# Step 17 — Cross-Surface Design Coherence Review

**Date:** 2026-06-12 · **Branch:** `feature/selection-and-stages` (Steps 12–16 landed) · **Reference:** `docs/mockups/opus_urtext/DESIGN.md`

Surfaces audited: corpus browser (`/`), fragment browser (`/concepts`), review queue (`/review-queue`), fragment viewer (`FragmentDetail`), score viewer (`ScoreViewer`), fragment detail panel (panel + standalone modes), login. Audited against each other and against `DESIGN.md` for the three Step 17 axes: list-layout vocabulary, preview treatment, header treatment. All file:line references verified in source.

**Headline finding:** the most serious item is not stylistic drift but a live rendering bug — `tokens.css` never defines the `error` / `tertiary` / `secondary` color families nor `--color-on-primary-container`, and route-level CSS uses them **without fallbacks** (the score components consistently carry fallbacks; the routes do not). See F1.

Dispositions: **change right away** (F1–F7), **document & defer to Phase 2** (F8–F13), **leave as is — intentional, rationale recorded** (F14–F18).

---

## Bucket 1 — Change right away

### F1. Undefined color tokens — rendering bug (highest priority)

`frontend/src/styles/tokens.css` defines no `--color-error*`, `--color-tertiary*`, `--color-secondary*`, or `--color-on-primary-container`. A `var()` with no fallback that references an undefined custom property is *invalid at computed-value time*: the declaration wins the cascade but computes to the property's initial/inherited value. Concrete breakage today:

- `frontend/src/routes/FragmentBrowser.module.css:318–331` and `frontend/src/routes/FragmentDetail.module.css:33–46` — status badges: `submitted` and `rejected` get **no background** (transparent, not even the base `.statusBadge` background, which the invalid declaration overrides); `approved` gets `--color-on-primary-container` text → inherited dark `#1b1c17` on `#587891` (contrast failure).
- `frontend/src/routes/FragmentBrowser.module.css:41–42` (clear-selection chip), `:152–158` (selected tree row), `:194–197` (selected tree count) — all use undefined `--color-on-primary-container` → dark text on mid-blue.
- `frontend/src/routes/FragmentDetail.module.css:264, 268` — sub-part bracket colors for `submitted` (`--color-tertiary`) and `rejected` (`--color-error`) are undefined → those brackets render with no background (invisible).
- `frontend/src/routes/Login.module.css:77` — hardcoded `#b00020` error red, with a comment admitting the token is missing; everywhere else the de-facto error red is `#b3261e`.

By contrast, `frontend/src/components/score/*.module.css` (~30 sites: FragmentDetailPanel, FormPanel, HarmonyPanel, StageList, StageBrackets, ConceptPicker, PropertyForm, SubPartForm, SubmissionChecklist) consistently uses fallbacks: `var(--color-error, #b3261e)`, `var(--color-error-container, #f9dedc)`, `var(--color-tertiary, #7a5900)`, `var(--color-secondary-container, #dce2f9)`. The palette exists — it lives in fallback expressions instead of the token file.

**Fix:** add complete `error`, `tertiary`, `secondary` families (`--color-X`, `--color-X-container`, `--color-on-X`, `--color-on-X-container`) plus `--color-on-primary-container` to `tokens.css`, promoting the de-facto fallback values. Replace the Login hardcode with the token. Optionally (mechanical, same change): sweep the now-redundant fallback expressions out of `components/score/*.module.css`.

### F2. Status→color mapping disagrees across surfaces

"Submitted" maps to `tertiary-container` in the FragmentBrowser/FragmentDetail badges but to `secondary-container` (`#dce2f9`, blue-lavender; `frontend/src/components/score/FragmentDetailPanel.module.css:102`) in the detail panel. Once F1 lands, the same status would show two hues on two surfaces. **Fix with F1:** one status→color mapping everywhere; recommend adopting the panel's mapping (`submitted` → `secondary-container`), since the panel is the only surface currently rendering a visible badge.

### F3. Load-more button divergence

ReviewQueue: `label-md` text, wrapper padding `spacing-3 spacing-4` (`frontend/src/routes/ReviewQueue.module.css`). FragmentBrowser: `label-sm` text, wrapper padding `spacing-2 0` (`frontend/src/routes/FragmentBrowser.module.css:334–337`). **Fix:** unify to `label-sm` (the quieter treatment befits a minor control) and one wrapper padding.

### F4. Preview-well background differs

Corpus incipits sit on `surface-container-low` (`IncipitImage.module.css`); fragment previews on `surface-container` (`frontend/src/routes/FragmentBrowser.module.css:272ff`). **Fix:** one token for the "score preview well" role — `surface-container-low` (score paper reads better on the lighter well).

### F5. Hardcoded `font-weight: 600` on `.fragmentConcept`

`frontend/src/routes/FragmentBrowser.module.css:300–302` overrides weight outside the `Type` system, violating the no-downstream-font-hard-coding rule (Newsreader 600 is loaded and sanctioned via `Type`). **Fix:** add a bold modifier (or `*-strong` variant) to `Type` / `Type.module.css` and use it.

### F6. Tree-row selected state — *decided 2026-06-12*

Selected concept-tree rows use `primary-container` (bold blue, `FragmentBrowser.module.css:152–158`) while selected BrowseItems (corpus browser, review queue) use `surface-container-high` (subtle tonal, `BrowseItem.module.css`). **Decision (Francisco):** converge both to the subtler corpus-browser treatment — selected tree rows become `surface-container-high`; the selected tree count badge (`:194–197`) loses its `primary` background accordingly. The clear-selection chip (`:38–46`) may keep `primary-container` as an *active filter* affordance (it is a control, not a selection state) — it gains a proper `on-primary-container` text color via F1 either way.

### F7. S/M/L scale toggle implemented twice with different treatments — *decided 2026-06-12*

`FragmentDetail .scaleBtn`: base `surface-container-high`, active `primary-container`. `ScoreViewer .sizeButton`: base transparent, active `primary` with `on-primary` text. **Decision (Francisco):** converge on the ScoreViewer treatment (the established one); FragmentDetail's `.scaleBtn` CSS values are aligned to it. Shared-component extraction stays deferred (F12).

---

## Bucket 2 — Document & defer (Phase-2 design debt register)

- **F8. Shared list-panel scaffold.** FragmentBrowser's list panel and ReviewQueue each hand-roll the 640px centered panel + header row + load-more (`FragmentBrowser.module.css`, `ReviewQueue.module.css:20`). A shared `ListPanel` component would enforce the vocabulary structurally; not cheap enough for in-component convergence.
- **F9. Hover-scroll preview duplication.** `frontend/src/components/browse/IncipitImage.tsx` and the inline fragment-preview logic in `FragmentBrowser.tsx` implement identical translateX pan logic (same 60 px/s constant, same 0.5s ease-out return). Extract a shared `HoverScrollPreview` component.
- **F10. Layout width scale.** 640px (list panels), 1200px (`ScoreViewer.module.css:281`), 1280px (`FragmentDetail.module.css:67`), 400px (Login) are scattered magic numbers. Tokenize (`--layout-list-width`, `--layout-detail-width`) and decide then whether 1200 vs 1280 should unify (the score viewer's width interacts with Verovio break behaviour — a visual decision, not a find-replace).
- **F11. Shared work-attribution component.** Composer/work/movement lines exist in three layouts with different type variants per role (FragmentDetail work line: `body-lg`; ScoreViewer work line: `headline`). The header *genres* are intentional (F15), but the per-role typography could be governed by one role-based component.
- **F12. Shared button/control library.** Segmented controls (`.scaleBtn` vs `.sizeButton`), transport buttons (implemented in both detail views with differing padding/hover), primary/destructive buttons (panel's `.approveButton` / `.rejectOpenButton` patterns) are re-implemented per view. F7 fixes the visible drift cheaply; the abstraction is Phase 2.
- **F13. Review queue has no score previews.** Both other browse surfaces lead with previews; the queue is text-only rows. Adding previews (server-side preview images exist for submitted fragments) is a candidate Phase-2 improvement, not cheap convergence.

---

## Bucket 3 — Leave as is (intentional divergences, rationale recorded)

- **F14. Corpus browser is full-width Miller columns; fragment browser / review queue are 640px centered lists.** Different layout genus: drill-down navigation vs result list. Chosen deliberately in Step 13.
- **F15. Two detail-header genres.** ScoreViewer's centered composer/work/movement stack reads as an Urtext edition title page; FragmentDetail's grouped left/right header (Step 15) reads as a catalogue record; the panel's inline badge+name header is a compact inspector. Each fits its surface; forcing one treatment would flatten meaningful distinctions.
- **F16. Preview dimensions differ by surface** — 175×112 (corpus MovementCard) vs 140×90 (fragment cards) — but share the ~1.56:1 ratio. Density-appropriate per surface.
- **F17. Fragment-list header uses the `title` variant** while other list headers use `label-md`. Semantically different: it names the selected *concept* (content), not the column (chrome).
- **F18. Row vs card item vocabularies.** BrowseItem rows (corpus, review queue) are transparent with tonal hover (`surface-container`); fragment cards are white per DESIGN.md "soft lift" with tonal hover (`surface-container-low`). Two legitimate item genres. Rule of thumb for future surfaces: *rows* for navigable chrome within a column, *cards* for self-contained result objects.

---

## Worklist for the follow-up fix task

Ordered; F1+F2 are one change. No code has been changed in this review.

1. **F1 + F2** — define token families in `tokens.css` (values from existing fallbacks; `submitted` → `secondary-container` everywhere); fix the no-fallback route CSS and the Login hardcode; optionally sweep redundant fallbacks in `components/score/`.
2. **F3** — unify load-more (variant `label-sm`, one padding).
3. **F4** — preview wells → `surface-container-low`.
4. **F5** — `Type` bold modifier replaces the `.fragmentConcept` override.
5. **F6** — tree-row selection → `surface-container-high` (decided).
6. **F7** — `.scaleBtn` → ScoreViewer toggle treatment (decided).

Verification after the fix task: visually confirm submitted/rejected badges, sub-part brackets, and selected tree rows in the running frontend; `npm test` passes; `DESIGN.md` needs no amendment (the token additions implement its existing palette intent; record the F18 rows-vs-cards rule there if desired).

---

## Implementation note (2026-06-12)

F1–F7 implemented. Value decisions taken where "promote the de-facto fallbacks" was underdetermined:

- **`--color-on-primary-container` is `#ffffff`, not the de-facto fallback `#003040`.** The fallback assumed a light M3-style container; this project's `--color-primary-container` is mid-blue `#587891`, on which `#003040` is exactly the dark-on-mid-blue contrast failure F1 flagged (≈3:1). White passes AA (≈4.7:1). Side effect: the panel's approved badge text goes from dark teal to white.
- **Families completed with M3-consistent companions where no de-facto value existed:** `--color-secondary: #575e71` / `--color-on-secondary: #ffffff` (the M3 blue-scheme secondary matching the de-facto `#dce2f9` container), `--color-tertiary-container: #ffdf9e` / `--color-on-tertiary-container: #261a00` (M3 gold companions to `#7a5900`; currently unused after F2 remapped submitted → secondary).
- **`--color-on-surface: #1b1c17` added** (alias of `on-background`): route CSS referenced it without a fallback — same class of bug as F1, harmless for `color` since the invalid value inherits, but now defined.
- **F2 scope:** the submitted *status* uses the secondary family everywhere (badges and sub-part brackets); `tertiary` remains the warning/unreviewed accent (`StageList .warnText`, `HarmonyPanel .badgeUnreviewed`) — those are not status mappings.
- **F7:** colour treatment (transparent base, `on-surface-variant` text, primary text on hover, solid primary when active) mirrored exactly; `.scaleBtn` keeps its compact geometry (`2px` vertical padding, `min-width: 28px`) since it sits in the detail view's tighter control strip.
- **Fallback sweep** limited to the families tokenized here (error/tertiary/secondary/on-primary-container); pre-existing redundant fallbacks for primary/surface tokens in `components/score/` were left alone.
