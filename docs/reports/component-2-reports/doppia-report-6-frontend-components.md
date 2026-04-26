# Doppia Code Review — Report 6: Frontend Components and Routes

## Summary

**Scope.** This report completes the frontend pass started in Report 5. It covers the route components (`CorpusBrowser.tsx`, `ScoreViewerStub.tsx`), the four browse-UI components (`BrowseAccordion`, `BrowseColumn`, `BrowseItem`, `MovementCard`, `IncipitImage`), the two UI primitives (`Surface`, `Type`), the typed browse-API client (`services/browseApi.ts`), and the response types (`types/browse.ts`). It also re-checks the relevant CSS modules against the design-system invariants in CONTRIBUTING.md and `docs/mockups/opus_urtext/DESIGN.md`.

**General view.** The component layer is clean, small, and consistent with the design tokens and the four-level browse hierarchy from `roadmap/component-2-corpus-browsing.md`. Type definitions match the backend Pydantic models field-for-field; the API client wraps each backend route 1:1 with proper URL-component encoding; the desktop and mobile layouts share a sensible separation. Components use native semantic elements (`<button>` for selectable items, `<h*>` defaults via `Type`), and the design tokens are referenced via `var(...)` not hardcoded. The skeleton-loading pattern in `BrowseColumn` works without animation, consistent with the "no transitions" design constraint.

The problems concentrate in three categories. **First, the React data-flow has unhandled error paths**: none of the four `fetchX` calls in `CorpusBrowser` has a `.catch()`, so backend errors disappear and the UI shows misleading empty states. There's also a classic stale-fetch race when the user clicks quickly between selections. **Second, design-system invariants are violated by the very components that ought to enforce them**: `1px solid` borders appear in two CSS modules despite CONTRIBUTING.md saying "never", typography is set inline in `Type.tsx` rather than via classes, and the desktop CTA button hardcodes its own typography instead of using `<Type>`. **Third, accessibility is unaddressed end-to-end**: no `:focus-visible` styles on any interactive element, generic `alt` text on score incipits, and `Type`'s heading-level mapping is tied to font size rather than semantic position.

The third category is the one most worth flagging for design-time decisions: Phase 1 is the right time to establish a11y patterns before twenty more components are built on top.

---

## Issue 1: No error handling on any of the four fetch calls in `CorpusBrowser`

**Issue.** `routes/CorpusBrowser.tsx` lines 67–111: each of the four `useEffect` hooks calls `fetchComposers().then(setComposers).finally(...)` (or equivalent for corpora/works/movements). None has a `.catch()`. `apiFetch` was specifically designed to throw a structured `ApiError` with `code`/`message`/`status`/`detail` (see `services/api.ts`), and the route ignores all of that.

Three concrete failure modes today:

1. **Backend returns 404** (composer slug not found, work id not found, etc.). `apiFetch` throws `ApiError("COMPOSER_NOT_FOUND", "Composer 'x' not found.", 404)`. The `.then(setComposers)` is skipped, `.finally(setLoading(false))` runs, and the user sees the empty-state label "Nothing here" or "No corpora found" with no error message. The actual situation — the backend specifically said the composer doesn't exist — is invisible.

2. **Backend is unreachable.** `apiFetch` throws `ApiError("NETWORK_ERROR", ...)`. Same outcome: empty state, no signal that the user needs to check connection / retry.

3. **Auth token is missing or expired.** Backend returns 401, `apiFetch` throws `ApiError("AUTH_INVALID_TOKEN", ...)`. Empty state again — and worse, no redirect to a login affordance.

Beyond user-facing behaviour, an unhandled rejection from a React effect bubbles up as an unhandled promise rejection in the browser console (in dev) and is silent in production.

**Solution.** Add a per-column error state and a top-level error boundary. Per-column is enough for Phase 1:

```typescript
const [composersError, setComposersError] = useState<ApiError | null>(null);

useEffect(() => {
  let cancelled = false;
  setComposersLoading(true);
  setComposersError(null);

  fetchComposers()
    .then((data) => {
      if (!cancelled) setComposers(data);
    })
    .catch((err: unknown) => {
      if (!cancelled) {
        setComposersError(err instanceof ApiError ? err : new ApiError('UNKNOWN', String(err)));
      }
    })
    .finally(() => {
      if (!cancelled) setComposersLoading(false);
    });

  return () => { cancelled = true; };
}, []);
```

Then `BrowseColumn` accepts an optional `error?: ApiError | null` prop and renders an error state alongside loading/empty/items. The error state should display `error.message` (human-readable) and offer a Retry button. The same fix applies to all four columns.

A top-level `ErrorBoundary` component is worth adding for non-fetch errors (e.g. a render-time crash): React 18's standard pattern.

**Verification.** Manual: stop the backend, reload the page → each column shows an error state instead of an empty list. Authenticated test: clear `localStorage.doppia_access_token` and reload → 401 surfaces with a "please sign in" message rather than four empty columns.

---

## Issue 2: Stale-fetch race condition across rapid selection changes

**Issue.** Same `useEffect` hooks. If the user clicks composer A, then quickly clicks composer B before A's corpora finish loading:

1. Effect runs for A: `fetchCorpora('a')` starts.
2. User clicks B before A returns: effect re-runs, `fetchCorpora('b')` starts.
3. `fetchCorpora('b')` returns first → `setCorpora(b_corpora)`.
4. `fetchCorpora('a')` returns later → `setCorpora(a_corpora)`. **Stale.**

Result: the UI shows A's corpora paired with B's selection. Hovering "open work" jumps to A's tree while B is selected. This is the standard React effect-cleanup bug.

The codebase doesn't trigger it often because the fetches are fast in development and users don't click that quickly, but on a slow connection or a saturated backend, it surfaces consistently.

**Solution.** Standard cleanup pattern. The `let cancelled = false` flag in the snippet under Issue 1 also fixes this — a request that completes after its effect has been replaced is dropped silently. An alternative is `AbortController`:

```typescript
useEffect(() => {
  if (!composerSlug) {
    setCorpora([]);
    return;
  }
  const controller = new AbortController();
  setCorporaLoading(true);
  setCorpora([]);

  fetchCorpora(composerSlug, { signal: controller.signal })  // requires apiFetch support
    .then(setCorpora)
    .catch(...)
    .finally(...);

  return () => controller.abort();
}, [composerSlug]);
```

The `AbortController` approach actually cancels the in-flight HTTP request (better for slow backends), but requires plumbing `signal` through `apiFetch`. The `cancelled` flag is simpler and sufficient for Phase 1 — pick one.

**Verification.** Throttle the network to "Slow 3G" in DevTools, click composer A, immediately click composer B before A returns. After the fix: B's corpora appear and A's are dropped. Without the fix: A overwrites B (or vice versa, non-deterministic).

---

## Issue 3: `1px solid` divider violates the design-system rule (two CSS modules)

**Issue.** CONTRIBUTING.md and `DESIGN.md` are unambiguous:

> Key constraints: 0px border-radius everywhere, **no 1px solid dividers**, depth through tonal layering only.

But `routes/CorpusBrowser.module.css` line 21:

```css
.columnPanel {
  ...
  border-right: 1px solid var(--color-outline-variant);
}
```

And `components/browse/BrowseAccordion.module.css` line 8:

```css
.section {
  border-bottom: 1px solid var(--color-outline-variant);
}
```

The `--color-outline-variant` token is `rgba(114, 120, 125, 0.15)` — semi-transparent — so these are "ghost" lines, not full-strength dividers. That may have been the loophole used. But the rule says "no 1px solid dividers" without qualification, and the design-system intent (per the surrounding tonal scale) is for column separation to come from background-color shifts between layers, not from any kind of line.

Either:
1. **The rule has a low-opacity exception** that should be documented in CONTRIBUTING.md, or
2. **The dividers should be removed** and the columns separated by tonal contrast — e.g. odd columns at `container-low`, even columns at `container`.

Reading the design doc, option 2 is what the system actually wants. The current code looks like the developer was reaching for a familiar pattern (column separators) rather than committing to the tonal approach.

**Solution.** Remove both `1px solid` borders. For desktop columns: alternate the `Surface` layer between adjacent columns, e.g. column 1 = `container-lowest`, column 2 = `container-low`, column 3 = `container-lowest`, column 4 = `container-low`. The eye reads the boundary from the color shift. For accordion sections: the existing `Surface layer="container-low"` background already provides the visual grouping, so the border-bottom is redundant.

If a divider really is needed (e.g. for hard separation in dense lists), use a dedicated `<Divider>` primitive that draws a 1px ghost line — and document the exception in the design doc, not in two scattered CSS modules.

**Verification.** `grep -rn "border.*1px solid" frontend/src/` returns zero matches (or only matches inside a documented `Divider` primitive). Visual review confirms columns and sections are still distinguishable by tonal shifts.

---

## Issue 4: Footer `backdrop-filter: blur` is wasted on an opaque background

**Issue.** `routes/CorpusBrowser.module.css` lines 34–44:

```css
.footer {
  ...
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  background: rgba(251, 249, 240, 0.80);
  background-color: var(--color-surface-container-highest);
}
```

CSS cascade rules: `background-color` wins because it comes after `background` (which is shorthand including background-color). The footer is therefore **fully opaque**, and `backdrop-filter: blur` operates on a background that has nothing transparent for it to blur through. The blur is a no-op.

The intent was clearly to have the footer translucent over the column content — that's the standard "frosted glass overlay" pattern. The rgba color is `var(--color-surface)` (Urtext Cream) at 80% opacity. The fix is to remove the `background-color: var(--color-surface-container-highest)` line.

Secondary issue: the rgba literal `rgba(251, 249, 240, 0.80)` should be a token (e.g. `--color-surface-translucent`) per the design system's "use tokens only" rule.

**Solution.** Remove line 43 (`background-color: var(--color-surface-container-highest)`); add `--color-surface-translucent: rgba(251, 249, 240, 0.80)` (or similar) to `tokens.css`; replace the rgba literal in the footer with `var(--color-surface-translucent)`.

**Verification.** Visual: the footer should show a blurred preview of the column content behind it. Token review: the rgba literal is gone from the CSS module.

---

## Issue 5: Footer `position: fixed` covers the bottom of the column lists with no compensating padding

**Issue.** Same component. `.footer` is `position: fixed; bottom: 0` (line 35–36). The `.grid` columns are `overflow: hidden` (line 14) and `flex: 1` height. The footer overlays the bottom 60–80px of the columns, and the columns have no `padding-bottom` to keep their last items above the footer.

User-facing effect: on a movement column with many items, the last 1–2 movements are hidden under the footer and can't be scrolled into view. The internal scroll of `.column` (in `BrowseColumn.module.css`) bottoms out at the column's actual bottom edge, which is below the visible viewport.

**Solution.** Add `padding-bottom` to `.columnPanel` (or the inner scroll container `.column` in `BrowseColumn.module.css`) equal to the footer height when a movement is selected. Easiest: a CSS variable set inline on `.page` from React based on selection state.

```css
/* CorpusBrowser.module.css */
.page {
  --footer-height: 0px;
}
.page[data-has-footer="true"] {
  --footer-height: 80px;
}
.columnPanel {
  padding-bottom: var(--footer-height);
}
```

```typescript
<Surface layer="base" className={styles.page} {...{ 'data-has-footer': selectedMovement ? 'true' : 'false' }}>
```

Or simpler: always reserve the space (the empty state below an open row is acceptable; the truncation is not).

**Verification.** Select a work with >10 movements; scroll to the bottom of the movement column. The last movement should be fully visible above the footer, not partially hidden.

---

## Issue 6: No `:focus-visible` styles on any interactive element

**Issue.** Three interactive elements have no focus indicator:

- `BrowseItem.module.css`: `.item` has `border: none` and no `:focus-visible` rule. Browsers' default outline for `<button>` may or may not appear depending on the UA stylesheet — Chrome typically shows it; some other browsers' defaults are weaker against the cream background.
- `BrowseAccordion.module.css`: `.header` has `border: none` and no `:focus-visible` rule.
- `CorpusBrowser.module.css`: `.ctaButton` has `border: none` and no `:focus-visible` rule.

Keyboard users navigating with Tab cannot reliably tell which item is focused. The design system's tonal "selected" state (`container-high`) is *only* applied to the URL-driven selection, not to the focused button. So focus and selection are decoupled, and the user has no signal which row their next Enter press will trigger.

This is a Phase 1 a11y baseline, not a future enhancement. WCAG 2.1 AA failure.

**Solution.** Add a single shared focus style. Token-based to keep with the design system:

```css
/* base.css or a shared ui/focus.css */
button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}
```

Per-component overrides only when the offset needs to differ. The `outline-offset: -2px` puts the ring inside the element's box, which works well at the 0-px-border-radius design.

Worth adding `--color-focus: var(--color-primary)` to `tokens.css` so the focus color can be themed independently if needed.

**Verification.** Tab through the browse hierarchy with a keyboard. Every interactive element should show a visible 2px ring when focused. Accessibility audit (Lighthouse, axe) confirms no missing focus indicators.

---

## Issue 7: `Type.tsx` defines typography via inline styles instead of CSS classes

**Issue.** `components/ui/Type.tsx` lines 23–76 define the typographic scale as a `Record<TypeVariant, React.CSSProperties>`. Every `<Type variant="body-lg">` rendered allocates a fresh inline-style object on every render and emits 4–7 inline CSS properties on the rendered tag. Three downstream effects:

1. **Cannot be overridden by CSS specificity.** Inline styles have higher specificity than any class-based rule. Themed overrides — dark mode, print stylesheets, high-contrast mode — cannot adjust the scale via CSS. They'd have to ship a parallel React component.
2. **Allocations per render.** Every `<Type>` instance computes `{ ...variantStyles[variant], ...style }` on every render, producing a new object that breaks `React.memo` shallow-equality if any consumer wraps the component.
3. **No CSS file footprint.** The design system's source of truth for typography lives only in TypeScript, invisible to designers using browser DevTools and to any future styleguide scrape.

The standard pattern is a CSS module:

```css
/* Type.module.css */
.display-lg { font-family: var(--font-serif); font-size: 3.5rem; font-weight: 400; line-height: 1.1; }
.display-sm { ... }
.headline   { ... }
.title      { ... }
.body-lg    { ... }
.body-sm    { ... }
.label-md   { font-family: var(--font-sans); font-size: 0.875rem; ...; text-transform: uppercase; letter-spacing: 0.05em; }
.label-sm   { ... }
```

```typescript
<Tag className={`${styles[variant]} ${className ?? ''}`} style={style}>{children}</Tag>
```

**Solution.** Migrate the variant scale to a `Type.module.css` file, drop the `variantStyles` `Record`. Keep `defaultTags` (it controls the rendered HTML element, not styling). Inline-style injection from the optional `style` prop continues to work for one-off overrides.

**Verification.** A built page using `<Type variant="body-lg">` renders an element with `class="_body-lg_xxxxx"` (CSS Modules' hashed class) instead of `style="font-family: ..."`. DevTools' Elements panel shows the typography in the Styles pane, not the inline style attribute.

---

## Issue 8: `Type` heading-level defaults bind semantic level to font size

**Issue.** `Type.tsx` line 78–87:

```typescript
const defaultTags: Record<TypeVariant, AsProp> = {
  'display-lg': 'h1',
  'display-sm': 'h2',
  'headline':   'h3',
  'title':      'h4',
  'body-lg':    'p',
  'body-sm':    'p',
  'label-md':   'span',
  'label-sm':   'span',
};
```

This couples **typographic size** (visual) to **heading level** (semantic structure). A page that wants three section headers all visually styled `headline` should still produce `h2` semantically. The current defaults force the developer to think "I want size 1.5rem" which auto-gives them `<h3>` — but if the page has no `<h1>` or `<h2>`, screen-reader users land on a fragmented outline.

CONTRIBUTING.md doesn't address this; the current `ScoreViewerStub` at line 20 uses `<Type variant="headline">` which auto-renders `<h3>`. That page has no `<h1>` or `<h2>` at all — accessibility violation on the very first non-stub page.

**Solution.** Decouple. Two reasonable patterns:

1. **Default `as` to `span` for everything.** Force every consumer to specify the semantic element via `as`. Verbose but unambiguous: `<Type variant="headline" as="h1">Score Viewer</Type>`.
2. **Keep the defaults but add a CI lint rule** (or an a11y test) that fails if a page has no `<h1>` or has skipped heading levels. Many projects use `eslint-plugin-jsx-a11y` for this; React Testing Library has helpers for outline assertions.

Recommendation: option 1 for the primitive (decoupling is the right design), plus option 2's lint as a safety net.

**Verification.** `ScoreViewerStub` updated to render `<h1>Score Viewer</h1>` (via `<Type variant="headline" as="h1">` or directly). Lighthouse a11y score includes "Heading elements appear in a sequentially-descending order" passing.

---

## Issue 9: `IncipitImage` `alt` text is identical for every movement

**Issue.** `components/browse/IncipitImage.tsx` line 22:

```typescript
<img src={url} alt="Score incipit" className={styles.img} />
```

Screen reader users browsing a list of 10 movements hear "Score incipit, Score incipit, Score incipit..." with no way to distinguish them. The title and movement number are right there in the parent `MovementCard` but not passed into `IncipitImage`.

Worse: the incipit is a visual cue that's already replicated by the text label above it (the movement title). For screen readers, the incipit `<img>` is **redundant decoration** — its primary purpose is visual recognition of the score's opening, not name disambiguation. Best a11y practice: `alt=""` for purely decorative images, so screen readers skip them entirely.

**Solution.** Either:

1. **Treat as decorative**: `alt=""`. Movement title in the parent label is the screen-reader-accessible name. This is probably right.
2. **Make alt informative**: pass the movement title and number as a prop, render `alt={`Incipit for ${movementTitle ?? `movement ${movementNumber}`}`}`. Slightly redundant with the text label.

Recommendation: option 1, with a code comment noting that the incipit is a visual aid only and the text label is the canonical name.

**Verification.** Screen reader test (VoiceOver / NVDA): navigating the movements column reads only "Adagio. Andante. Allegro." (titles) without "Score incipit. Score incipit. Score incipit." between them.

---

## Issue 10: `IncipitImage` has no error handling for expired signed URLs

**Issue.** `services/browse.py` line 30 sets `_INCIPIT_URL_TTL_SECONDS = 900` (15 minutes). After 15 minutes, the URL returns 403 from the object store. `IncipitImage` has no `onError` handler:

```typescript
<img src={url} alt="Score incipit" className={styles.img} />
```

A user who keeps the page open for 15+ minutes (entirely realistic for a tagging session) sees broken-image icons across all rendered incipits with no recovery path. They have to manually refresh.

**Solution.** Add a minimal `onError` that swaps to the placeholder state:

```typescript
const [errored, setErrored] = useState(false);

if (ready && url && !errored) {
  return (
    <img
      src={url}
      alt=""  // see Issue 9
      onError={() => setErrored(true)}
      className={styles.img}
    />
  );
}

return (
  <Surface layer="container" className={styles.placeholder}>
    <Type variant="label-sm" style={{ color: 'var(--color-on-surface-variant)' }}>
      {errored ? 'Reload to refresh' : 'Rendering…'}
    </Type>
  </Surface>
);
```

A more elegant solution is to refetch the movements list when the page regains focus or after 14 minutes — but the simple fallback above is enough for Phase 1 and surfaces the right user instruction.

**Verification.** Open the browse page, select a work with movements, wait 16 minutes (or shorten the TTL to 30 seconds for testing), and observe that incipits change to "Reload to refresh" rather than broken-image icons.

---

## Issue 11: `BrowseAccordion` uses three effects to compute one derived state

**Issue.** `components/browse/BrowseAccordion.tsx` lines 108–118:

```typescript
useEffect(() => { if (selectedComposerSlug) setOpenSection('corpus'); }, [selectedComposerSlug]);
useEffect(() => { if (selectedCorpusSlug) setOpenSection('work'); }, [selectedCorpusSlug]);
useEffect(() => { if (selectedWorkId) setOpenSection('movement'); }, [selectedWorkId]);
```

Three effects, three commits on initial hydration when the URL has all three params set. Acceptable in React 18 (effects batch within a tick), but the *intent* — "open the deepest section that has a parent selected" — is clearer in one effect:

```typescript
useEffect(() => {
  if (selectedWorkId) setOpenSection('movement');
  else if (selectedCorpusSlug) setOpenSection('work');
  else if (selectedComposerSlug) setOpenSection('corpus');
}, [selectedComposerSlug, selectedCorpusSlug, selectedWorkId]);
```

Or, even better, derive `openSection` directly without state if the user-toggle case (manual collapse/expand) didn't exist. Since `toggle()` does mutate `openSection` from a click, state is justified — but consolidate the effects.

**Solution.** Replace the three effects with one, as above.

**Verification.** Behavior should be identical to the user. Code review: one effect instead of three.

---

## Issue 12: `BrowseAccordion` has 17 props (extreme prop drilling)

**Issue.** `BrowseAccordionProps` (lines 17–37) has 17 fields — every piece of state from the parent, four times over (composers/corpora/works/movements × items, selectedId, onSelect, isLoading). The desktop branch in `CorpusBrowser` repeats the same data binding inline. The mobile and desktop layouts are essentially two views of the same state machine, but the state machine is implemented twice.

Not a bug — the code works — but a maintenance smell. Adding a feature like "filter movements by tempo" requires editing both layouts, threading new props through `BrowseAccordionProps`, and keeping the desktop inline rendering consistent. As the four-tier structure grows (Components 4–8), this multiplies.

**Solution.** Extract a `useBrowseSelection()` hook that owns all four data sources, the URL-param state machine, and the loading/error flags. Both `BrowseAccordion` and the desktop layout consume the hook directly:

```typescript
function CorpusBrowser() {
  const browseState = useBrowseSelection();
  const isMobile = useMediaQuery('(max-width: 767px)');
  return (
    <Surface layer="base" className={styles.page}>
      {isMobile ? <BrowseAccordion {...browseState} /> : <BrowseDesktop {...browseState} />}
      {browseState.selectedMovement && <SelectionFooter movement={browseState.selectedMovement} />}
    </Surface>
  );
}
```

Even with the `{...browseState}` spread, the prop count drops from 17 to "everything in browseState" — and the spread is now a single source of truth.

A `useReducer` with action types (`SELECT_COMPOSER`, `SELECT_CORPUS`, etc.) would make the URL-param transitions in `select()` (lines 113–129) more declarative — currently the cascading deletes (`if (key === 'composer') { next.delete('corpus'); ... }`) are easy to break.

**Solution alternative.** A small Zustand store. Phase 1 doesn't have many state surfaces; a store is justified once Component 3 (score viewer) and Component 4 (fragment list) start sharing state with the browser.

**Verification.** Refactor lands; no regression in browse behaviour; `BrowseAccordion`'s prop interface drops to a single typed object.

---

## Issue 13: `Surface`'s `floating` boolean and `layer="floating"` overlap confusingly

**Issue.** `components/ui/Surface.tsx` exports a `SurfaceLayer` union that includes `'floating'`, and a separate `floating?: boolean` prop. They control different things:

- `layer="floating"` sets `backgroundColor: var(--color-surface-container-highest)` (line 27).
- `floating={true}` adds the `boxShadow` (line 47).

A consumer who writes `<Surface layer="floating">Bla</Surface>` gets the right background but no shadow — not what they probably expected. A consumer who writes `<Surface floating>Bla</Surface>` gets a shadow but the default `base` background — also probably not what they expected.

The name collision suggests these were meant to combine, but the implementation keeps them orthogonal.

**Solution.** Remove `layer="floating"` (it's just an alias for `container-highest`). Keep `floating={true}` as the shadow toggle. Document the pattern: *"Floating overlays use `<Surface layer="container-highest" floating>`."*

Or, if you want one prop: combine into `<Surface variant="floating">` that sets both background and shadow, drop `floating` and the `'floating'` literal in `SurfaceLayer`.

**Verification.** Pick one canonical pattern, update existing usages, document in the component's docstring.

---

## Issue 14: `Surface` hardcodes the floating shadow value instead of tokenizing

**Issue.** `Surface.tsx` line 47:

```typescript
{ boxShadow: '0 0 40px 0 rgba(27, 28, 23, 0.06)' }
```

The design tokens in `tokens.css` cover colors, typography, spacing, and border-radius. They do not cover shadows. The single shadow used by `Surface` lives as a string literal in TypeScript — outside the token system that the rest of the codebase uses.

**Solution.** Add a token:

```css
/* tokens.css */
--shadow-floating: 0 0 40px 0 rgba(27, 28, 23, 0.06);
```

Use in `Surface.tsx`:

```typescript
{ boxShadow: 'var(--shadow-floating)' }
```

If more shadow elevations are added later (popover vs. dialog vs. dropdown), they all live in `tokens.css` together.

**Verification.** `grep -rn "boxShadow.*rgba\|box-shadow.*rgba" frontend/src/` returns zero matches. All shadows reference `var(--shadow-*)`.

---

## Issue 15: CTA button hardcodes typography instead of using `<Type>` or tokens

**Issue.** `routes/CorpusBrowser.module.css` lines 60–72:

```css
.ctaButton {
  ...
  font-family: var(--font-sans);
  font-size: 0.875rem;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
```

Compare to `Type.tsx` `label-md`:

```typescript
'label-md': {
  fontFamily: 'var(--font-sans)',
  fontSize: '0.875rem',
  fontWeight: 500,
  lineHeight: 1.4,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',  // 0.05em vs 0.04em in the CSS
},
```

The CTA's `letter-spacing: 0.04em` doesn't match `label-md`'s `0.05em` — close but not quite. Either:

1. **The CTA was meant to use `label-md`** but was hand-written and the values drifted by 0.01em.
2. **The CTA uses a different scale** that should be a separate variant in `Type.tsx` (e.g. `'button-md'`).

Either way, two sources of truth for similar typography is a maintenance trap. CONTRIBUTING.md says "no downstream component should hard-code font or size values" — this CSS module violates that.

**Solution.** Two options:

1. **Use `<Type>` in the button**: replace the inner text with `<Type variant="label-md" as="span">Open for tagging</Type>`. The button itself just provides the colored background and click target. Drop the `font-*` properties from `.ctaButton`.
2. **Add a `button-md` variant to `Type.tsx`** if buttons genuinely need a different scale (different letter-spacing, different line-height for vertical centering).

Recommendation: option 1. The drift suggests there isn't actually a separate intentional scale.

**Verification.** `grep -rn "font-family\|font-size\|letter-spacing\|text-transform" frontend/src/components frontend/src/routes` returns matches only inside `Type.tsx` (the source of truth) and `base.css` (the body default). Other files reference typography only via `<Type>`.

---

## Issue 16: `Type.tsx` uses pre-React-18 `JSX.IntrinsicElements` namespace

**Issue.** `Type.tsx` line 13:

```typescript
type AsProp = keyof JSX.IntrinsicElements;
```

`JSX.IntrinsicElements` (the global) was the React 17– pattern. With React 18 + `react-jsx` transform (which `tsconfig.app.json` line 16 uses), the canonical namespace is `React.JSX.IntrinsicElements`. The global form still works because `@types/react` augments it for backward compatibility — but the augmentation is being phased out in newer `@types/react` versions.

Today this compiles. In a future `@types/react` upgrade (≥ 19, or stricter intermediate versions), it may produce a `Cannot find namespace 'JSX'` error.

**Solution.** `type AsProp = keyof React.JSX.IntrinsicElements;`

**Verification.** TypeScript still compiles. `npm run build` passes.

---

## Issue 17: Doubled `key` props in `BrowseAccordion`

**Issue.** `components/browse/BrowseAccordion.tsx` lines 144, 165, 187, 222 — every `renderItem` callback sets `key={...}` on its rendered `BrowseItem`/`MovementCard`. But `BrowseColumn` already wraps each `renderItem` output in `<React.Fragment key={key}>` (lines 76–79 of `BrowseColumn.tsx`). The inner `key` props are ignored by React because the Fragment is the actual list child.

Cosmetic — they don't break anything — but they're noise that suggests confusion about which level "owns" the list iteration. If `BrowseColumn` later changes its iteration shape, the inner keys will silently start mattering and cause subtle reorder bugs.

**Solution.** Drop the `key` props on the inner `BrowseItem`/`MovementCard` instances inside `renderItem`. The Fragment in `BrowseColumn` is the canonical list-key location.

**Verification.** `grep -n "key={" frontend/src/components/browse/BrowseAccordion.tsx frontend/src/routes/CorpusBrowser.tsx` shows keys only on direct array iterations (e.g. skeleton lines), not inside `renderItem` bodies.

---

## Issue 18: `ScoreViewerStub` displays the raw movement UUID and has no `<title>`

**Issue.** `routes/ScoreViewerStub.tsx` line 22:

```typescript
Movement ID: {movementId}
```

Renders the UUID directly. Acceptable for a Phase 1 stub explicitly documented as "replaced entirely by Component 3". Worth a `// dev-only` comment so the stub-ness is explicit.

Secondary: the page has no `<title>` setting. The browser tab shows whatever's in `index.html` regardless of which route the user is on. With two routes today and many more coming, this is worth fixing once. `react-helmet-async` is the standard option; for a small app a manual `useEffect(() => { document.title = '...' }, [])` is fine.

**Solution.** Add a `// dev-only` comment to the UUID display. Add a small `usePageTitle()` hook (one-liner with `useEffect`) and call it in both `CorpusBrowser` and `ScoreViewerStub`.

**Verification.** Browser tab title changes when navigating between routes.

---

## What the components get right

For balance:

- **Type definitions match the backend models exactly.** I diffed `frontend/src/types/browse.ts` against `backend/models/browse.py` field-for-field. Every field has the same name, the same nullability, and a TypeScript type that round-trips through JSON correctly (UUID → string, int → number, str | None → string | null). This is the load-bearing axis between frontend and backend, and it's clean.
- **`browseApi.ts` wraps each backend route 1:1** with proper `encodeURIComponent` on every dynamic path segment. No URL-injection vector even for adversarial slugs.
- **`BrowseItem` uses a native `<button>`** with `type="button"`, not a `<div onClick>`. Keyboard / screen-reader accessible by default (modulo the focus-style gap from Issue 6).
- **`BrowseColumn` separates loading/empty/items** explicitly. Adding a fourth state (error) is a small extension.
- **The skeleton-loading pattern doesn't animate.** Consistent with the design system's "no transitions" rule. Many design systems use shimmer animations; this one's restraint is intentional.
- **`IncipitImage` reserves a fixed 120px slot** (Issue 10 notwithstanding) so the layout doesn't jump when an incipit becomes ready. This is the right way to handle async-loaded media.
- **URL-driven selection state.** Refreshing or sharing a URL like `/?composer=bach&corpus=wtc&work=bwv1` restores the exact selection, no client-side state to serialize. Should be the default for any browse-style UI.
- **`MovementCard` uses null-coalescing for the movement title** (`m.title ?? `Movement ${m.movement_number}``), so untitled movements degrade gracefully.

---

## Summary of action items

**Real bugs (functional):**
- Issue 1: Add error handling to all four fetch calls in `CorpusBrowser`.
- Issue 2: Fix the stale-fetch race condition.
- Issue 4: Fix the footer's broken `backdrop-filter`.
- Issue 5: Add `padding-bottom` so the footer doesn't cover column items.
- Issue 10: Handle expired-incipit-URL `onError` in `IncipitImage`.

**Design-system invariants (the system enforces nothing today):**
- Issue 3: Remove the two `1px solid` dividers.
- Issue 7: Migrate `Type.tsx` typography from inline styles to a CSS module.
- Issue 14: Tokenize the `boxShadow` value.
- Issue 15: Replace the CTA button's hand-rolled typography with `<Type>` or tokens.

**Accessibility (Phase 1 baseline):**
- Issue 6: Add `:focus-visible` styles on all interactive elements.
- Issue 8: Decouple `Type` heading levels from font-size variants.
- Issue 9: Set `alt=""` on incipits (treat as decorative).

**Code quality (low priority):**
- Issue 11: Consolidate the three `BrowseAccordion` auto-advance effects.
- Issue 12: Extract `useBrowseSelection()` to reduce 17-prop drilling.
- Issue 13: Reconcile `Surface`'s `floating` prop and `layer="floating"`.
- Issue 16: `JSX.IntrinsicElements` → `React.JSX.IntrinsicElements`.
- Issue 17: Drop duplicate `key` props inside `renderItem`.
- Issue 18: Mark the stub UUID display dev-only and add `usePageTitle()`.

**Pattern across both frontend reports.** Combining Reports 5 and 6, the frontend has:
- One real CI bug (`npm run lint` fails: Report 5 Issue 1).
- Three doc-vs-code drifts (port 3000, README layout, Supabase-interface comment).
- A security policy ambiguity around JWT storage that needs an ADR or a code change.
- A pattern of design-system enforcement living in comments and conventions rather than in stylelint / CSS classes / tokens.
- A pattern of accessibility being unaddressed end-to-end — focus styles, alt text, heading-level semantics — at the moment when it's cheapest to fix.

The component code itself is clean and small. The gaps are infrastructural: lint/CI, the design-system enforcement layer, and a11y baseline. Phase 1 is the right time to land these.
