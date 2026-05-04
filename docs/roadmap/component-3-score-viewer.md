# Phase 1 — Component 3: Score Viewer & MIDI Playback — Implementation Plan

This document translates Component 3 of `docs/roadmap/phase-1.md` into a concrete, sequenced set of implementation tasks. It also absorbs the two carry-ins recorded at the end of `docs/roadmap/measure-number-redesign-plan.md`: the Vitest setup and the deferred issues from Reports 5 and 6.

Component 3 has three deliverables:

1. **Deferred Component 2 cleanup** — a set of bugs, design-system violations, accessibility gaps, and infrastructure holes identified in Reports 5 and 6 that were explicitly held back ("addressed during this component, not before") to avoid blocking Component 2's merge.
2. **Vitest setup** — the frontend test harness, a known gap since Report 7 Issue 1, also carried here from the measure-number redesign planning note.
3. **Score viewer** — the interactive Verovio rendering + MIDI playback feature that replaces the `ScoreViewerStub` and provides the rendering infrastructure all subsequent components (tagging tool, fragment browser) depend on.

The ordering matters: the cleanup and test harness land first, so the score viewer is built on a correct foundation with test coverage from the start.

---

## Prerequisites

Component 3 assumes the following hard gates from Component 2 have passed:

- The four browse API endpoints pass integration tests against the Mozart staging fixture.
- The corpus browser UI renders correctly in staging with real data: incipits load, URL selection state persists, mobile accordion works.
- The design system tokens file and primitive components (`Surface`, `Type`) are in place.
- The Verovio Python bindings spike is documented in `docs/architecture/mei-ingest-normalization.md` (including the `"start-N"` syntax findings and the volta position-index results needed by Step 13 below).
- The measure-number redesign (steps 1–9 of `docs/roadmap/measure-number-redesign-plan.md`) is complete: `mc_start`/`mc_end` columns exist on `fragment`, `_build_measure_map` returns `{position_index: MeasureEntry}`, and the incipit task uses `select({measureRange: "start-4"}) + redoLayout()`.

---

## Part 1 — Deferred Component 2 Fixes

The issues below were identified in Reports 5 and 6. They are grouped by risk: real bugs first, then infrastructure, then design-system compliance, then code quality. Each step references the original report and issue number for traceability.

---

### Step 1 — Fix broken lint (R5-I1)

**Impact: CI blocker.** `npm run lint` fails on a fresh clone.

`frontend/eslint.config.js` imports `globals` and `typescript-eslint` — the new flat-config meta-package — but `package.json` only has the legacy individual packages (`@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`). The meta-package is not installed, so the config errors before any linting runs.

Add to `frontend/package.json` devDependencies:

```json
"globals": "^15.13.0",
"typescript-eslint": "^8.0.0"
```

The legacy packages can remain — the meta-package re-exports them. Run `npm install` and verify `npm run lint` completes with zero errors on a fresh clone.

Also wire `npm run lint` into CI (see Step 3's CI configuration) so this class of regression is caught automatically going forward.

---

### Step 2 — Fix real bugs in the Component 2 UI (R6-I1, I2, I4, I5, I10)

These five issues are functional bugs visible to any user of the corpus browser.

**R6-I1 and R6-I2: Unhandled fetch errors and stale-fetch race in `CorpusBrowser`.**

All four `useEffect` fetch calls in `routes/CorpusBrowser.tsx` have no `.catch()`, so backend errors (404, 401, network failure) silently produce empty columns. They also lack cleanup, so rapid selection changes can produce stale results (fetch A finishes after fetch B is started, overwriting B's result).

Apply the cleanup pattern to every fetch effect. The simplest form uses a `cancelled` flag; `AbortController` is preferred for slow backends because it cancels the in-flight request, but requires `signal` to be plumbed through `apiFetch`. Either approach is acceptable — pick one and apply it consistently across all four effects.

Add a `error?: ApiError | null` prop to `BrowseColumn`. When an error is present, the column renders an error state (the `error.message` string from the structured `ApiError`, plus a Retry button) rather than the empty-state label. A top-level `ErrorBoundary` wrapping the `CorpusBrowser` route catches render-time crashes.

**R6-I4: Footer `backdrop-filter` is a no-op.**

`routes/CorpusBrowser.module.css` has both `background: rgba(...)` (80% opacity) and `background-color: var(--color-surface-container-highest)` (fully opaque) on `.footer`. CSS cascade gives `background-color` higher priority, so the footer is fully opaque and `backdrop-filter: blur(12px)` blurs nothing.

Remove the `background-color: var(--color-surface-container-highest)` line. Also add `--color-surface-translucent: rgba(251, 249, 240, 0.80)` to `tokens.css` and replace the rgba literal with `var(--color-surface-translucent)`.

**R6-I5: Footer `position: fixed` covers the bottom of the column lists.**

The fixed footer overlays the bottom ~80px of each column, and the columns have no compensating `padding-bottom`. Users with a long movement list cannot scroll the last items into view.

Use a CSS custom property on the page root that transitions from `0px` to the footer height when a movement is selected:

```css
.page { --footer-height: 0px; }
.page[data-has-footer="true"] { --footer-height: 80px; }
.columnPanel { padding-bottom: var(--footer-height); }
```

Set the `data-has-footer` attribute from React based on whether a movement is selected. This approach avoids a separate `padding-bottom` animation and keeps the layout in CSS.

**R6-I10: `IncipitImage` shows broken-image icons when the signed URL expires.**

Signed incipit URLs expire after 15 minutes (`_INCIPIT_URL_TTL_SECONDS = 900`). `IncipitImage` has no `onError` handler, so a user in a long tagging session sees broken-image icons with no recovery path.

Add an `errored` boolean state, set by `onError`. When `errored` is true, render the placeholder surface with the label "Reload to refresh" instead of the `<img>`. This surfaces the right action without requiring an automatic refetch.

---

### Step 3 — Documentation and tsconfig fixes (R5-I2, R5-I8, R5-I9, R5-I10, R6-I18)

These are non-behavioural corrections that take less time together than separately.

**R5-I2: README port `3000` → `5173`.** Update README.md lines referencing `localhost:3000` (the dev server) to `localhost:5173`. Vite is configured for 5173, and the backend's CORS allowlist confirms it. While here, add `localhost:4173` (Vite preview) as a footnote since it is in the CORS allowlist.

**R5-I8: README frontend project-layout block.** Replace the outdated layout (which lists `components/` and `services/` at the root, omits `src/`, and mentions "Verovio renderer, MIDI player, tagging UI" that don't exist yet) with the actual structure. Mark the unbuilt directories explicitly:

```
frontend/src/
├── App.tsx, main.tsx       Entry points + router setup
├── components/
│   ├── browse/             Corpus browser UI (Component 2)
│   └── ui/                 Surface, Type primitives
├── routes/
│   ├── CorpusBrowser       (Component 2; live)
│   └── ScoreViewer         (Component 3; replaces ScoreViewerStub)
├── services/               api.ts, auth.ts, browseApi.ts
├── styles/                 base.css, tokens.css
└── types/                  TypeScript response shapes
```

**R5-I9: Tighten the "Supabase-compatible" comment in `auth.ts`.** The comment claims the `Session` interface is compatible with Supabase's shape, but the current definition is a strict subset. Add: "Phase 1 consumers must access only `access_token`. Accessing other Supabase session fields requires expanding this interface to the full Supabase `Session` shape — do that in Phase 2 when the real Supabase client is wired in."

**R5-I10: Verify `tsconfig.json` references.** Confirm that `frontend/tsconfig.json` contains `"references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }]`. If it is a bare `{ "files": [] }` wrapper without references, add them. Without references, editor TypeScript support does not pick up the strict-mode rules from `tsconfig.app.json`.

**R6-I18: `ScoreViewerStub` — add `// dev-only` marker.** The UUID display (`Movement ID: {movementId}`) is acceptable for a stub; add a comment so it's clear: `{/* dev-only: replaced by Component 3 */}`. Also add a `usePageTitle()` hook (one-liner: `useEffect(() => { document.title = title; }, [title])`) and call it in both `CorpusBrowser` and `ScoreViewerStub`. This sets the browser tab title per route; when Component 3 replaces the stub, the hook carries forward without change.

---

### Step 4 — JWT storage decision: ADR-016 (R5-I3)

`frontend/src/services/auth.ts` stores the Supabase access token in `localStorage` under `doppia_access_token`. `security-model.md` forbids `localStorage` for session-scoped data in a paragraph about signed URLs; ADR-001 doesn't address token storage at all. The policy and the code are inconsistent, with no recorded rationale.

Write `docs/adr/ADR-016-jwt-browser-storage.md`. The decision is to retain `localStorage` for Phase 1 on the grounds that: the tagging tool is internal-only with no anonymous traffic, the annotator team is small and trusted, and the alternatives (`HttpOnly` cookie, in-memory token with refresh dance) add Phase 1 complexity without a Phase 1 threat model. State explicitly that this must be revisited before Phase 2 public launch, when the app gains anonymous users and the XSS surface expands.

Update `security-model.md` to add a sentence in the relevant paragraph noting that the JWT-in-`localStorage` choice is the documented exception per ADR-016, and that it is scoped to Phase 1's internal-only deployment.

---

### Step 5 — Self-host fonts and add stylelint (R5-I5, R5-I6)

These two items address the same root gap: design-system invariants that are currently enforced only by convention.

**R5-I6: Self-host Newsreader and Public Sans.**

`base.css` loads both fonts via a runtime `@import url('https://fonts.googleapis.com/...')`. This conflicts with the planned Phase 2 CSP (`style-src 'self'` blocks `fonts.googleapis.com`), makes a render-blocking third-party request on every page load, and raises GDPR concerns for EU academic users (Google Fonts has been ruled a data-transfer issue in some jurisdictions when not locally cached).

```bash
npm install @fontsource/newsreader @fontsource/public-sans
```

Replace the runtime import with:

```css
@import '@fontsource/newsreader/400.css';
@import '@fontsource/newsreader/600.css';
@import '@fontsource/newsreader/400-italic.css';
@import '@fontsource/public-sans/400.css';
@import '@fontsource/public-sans/500.css';
@import '@fontsource/public-sans/600.css';
@import './tokens.css';
```

Fonts now ship with the Vite build as local `/assets/*.woff2` references. The `@import url(...)` to `googleapis.com` is removed entirely. Verify: build the production bundle and confirm no requests to `fonts.googleapis.com` or `fonts.gstatic.com` appear in the network tab on first load.

**R5-I5: Add stylelint.**

The design system has three non-negotiable rules that are currently enforced only by a comment in `base.css`:
- No pure black or pure white literals (use token variables)
- 0px border-radius everywhere (only `var(--border-radius)` is permitted)
- No `1px solid` dividers

Add `stylelint` and `stylelint-config-standard` to devDependencies. Create `frontend/.stylelintrc.json`:

```json
{
  "extends": ["stylelint-config-standard"],
  "rules": {
    "declaration-property-value-disallowed-list": {
      "color": ["/^#000(000)?$/", "/^#fff(fff)?$/", "black", "white"],
      "background-color": ["/^#000(000)?$/", "/^#fff(fff)?$/", "black", "white"],
      "border": ["/^1px solid /"],
      "border-top": ["/^1px solid /"],
      "border-bottom": ["/^1px solid /"],
      "border-left": ["/^1px solid /"],
      "border-right": ["/^1px solid /"]
    },
    "declaration-property-value-allowed-list": {
      "border-radius": ["/^var\\(--border-radius\\)$/", "0", "0px"]
    }
  }
}
```

Add to `package.json` scripts: `"lint:css": "stylelint 'src/**/*.css'"`. Wire into CI alongside `npm run lint`. Verify: adding `border-radius: 4px` anywhere in `src/` causes `npm run lint:css` to fail.

---

### Step 6 — API hardening: Zod validation and Content-Type fix (R5-I4, R5-I7)

**R5-I4: Add runtime validation at the API boundary.**

`apiFetch<T>` currently casts `response.json()` to `T` without any runtime check. If the backend response shape drifts from the TypeScript type, the mismatch surfaces as an obscure `undefined.something` crash deep in a component rather than a clear validation error at the boundary. This is particularly risky for the `summary` JSONB (described in `fragment-schema.md` as a published API from the moment the first fragment is written) and for the browse types (which the tagging tool will depend on heavily from Component 5).

Add `zod` to `frontend/dependencies`. Convert `src/types/browse.ts` from plain TypeScript interfaces to Zod schemas with `z.infer<>` for the TypeScript types:

```typescript
import { z } from 'zod';
export const ComposerSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  sort_name: z.string(),
  birth_year: z.number().nullable(),
  death_year: z.number().nullable(),
});
export type Composer = z.infer<typeof ComposerSchema>;
```

Update `apiFetch` to accept an optional schema parameter:

```typescript
export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
  schema?: z.ZodSchema<T>,
): Promise<T> {
  // ... existing fetch logic ...
  const json = await response.json();
  return schema ? schema.parse(json) : (json as T);
}
```

The schema parameter is optional to allow gradual adoption — call sites that don't yet have a Zod schema continue to work with the bare cast. The browse API client (`browseApi.ts`) is the first call site to adopt schemas. Add a unit test that posts a malformed response to `apiFetch` with a schema and asserts that a `ZodError` is thrown.

**R5-I7: Fix `Content-Type: application/json` set on every request.**

`services/api.ts` currently sets `Content-Type: application/json` unconditionally. On `GET` requests this is meaningless; on `multipart/form-data` uploads (the corpus upload endpoint) it actively breaks the request by overwriting the `boundary` parameter that `fetch` would set automatically.

Set `Content-Type: application/json` only when a non-null body is present and the caller has not already set their own `Content-Type` and the body is not a `FormData`:

```typescript
const headers: Record<string, string> = {
  ...(options?.headers as Record<string, string> | undefined),
};
const hasBody = options?.body != null;
const callerSetContentType = 'Content-Type' in headers;
if (hasBody && !callerSetContentType && !(options?.body instanceof FormData)) {
  headers['Content-Type'] = 'application/json';
}
```

---

### Step 7 — Design system compliance: remove violations (R6-I3, R6-I7, R6-I13, R6-I14, R6-I15)

With stylelint now wired (Step 5), the existing violations it would catch must be fixed before it can run clean. These changes align the codebase with the rules it claims to enforce.

**R6-I3: Remove `1px solid` dividers.**

`routes/CorpusBrowser.module.css` has `border-right: 1px solid var(--color-outline-variant)` on `.columnPanel`. `components/browse/BrowseAccordion.module.css` has `border-bottom: 1px solid var(--color-outline-variant)`. Both violate "no 1px solid dividers."

Remove both borders. For desktop columns: alternate the `Surface` layer between adjacent columns — e.g., columns 1 and 3 at `container-lowest`, columns 2 and 4 at `container-low`. The eye reads the boundary from the color shift, as the design system intends. For the accordion: the `container-low` background already provides visual grouping; the border is redundant and can go.

**R6-I7: Migrate `Type.tsx` typography from inline styles to a CSS module.**

`Type.tsx` currently defines the typographic scale as `Record<TypeVariant, React.CSSProperties>`, applying it as inline styles on each render. Inline styles cannot be overridden by CSS specificity (blocking dark mode, print stylesheets, high-contrast mode), allocate new objects every render (breaking shallow `React.memo` equality), and are invisible to DevTools' style panel.

Create `frontend/src/components/ui/Type.module.css` with one class per variant:

```css
.display-lg { font-family: var(--font-serif); font-size: 3.5rem; font-weight: 400; line-height: 1.1; }
.headline   { font-family: var(--font-serif); font-size: 1.5rem; font-weight: 400; line-height: 1.25; }
.label-md   { font-family: var(--font-sans); font-size: 0.875rem; font-weight: 500; text-transform: uppercase; letter-spacing: 0.05em; }
/* ... all variants ... */
```

In `Type.tsx`, replace the `variantStyles` record with `styles[variant]` via CSS Modules. Keep `defaultTags` (it controls the HTML element, not styling). Keep the optional `style` prop for one-off overrides. Drop the `variantStyles` object entirely.

**R6-I13: Reconcile `Surface`'s `floating` prop and `layer="floating"` overlap.**

`layer="floating"` sets `backgroundColor: var(--color-surface-container-highest)`. `floating={true}` adds the box shadow. They control different things, causing confusion: `<Surface layer="floating">` gets background but no shadow; `<Surface floating>` gets shadow but default background.

Remove `'floating'` from the `SurfaceLayer` union — it is simply `container-highest` by another name. Keep the `floating` boolean prop for the shadow. Document the canonical pattern in the component's JSDoc: *"Floating overlays use `<Surface layer="container-highest" floating>`."* Update any existing usages.

**R6-I14: Tokenize the `Surface` box-shadow value.**

`Surface.tsx` hardcodes `boxShadow: '0 0 40px 0 rgba(27, 28, 23, 0.06)'` as an inline string literal. Add to `tokens.css`:

```css
--shadow-floating: 0 0 40px 0 rgba(27, 28, 23, 0.06);
```

Use in `Surface.tsx`: `{ boxShadow: 'var(--shadow-floating)' }`. Future shadow elevations (popover, dialog, dropdown) join the token file alongside it.

**R6-I15: Replace the CTA button's hand-rolled typography with `<Type>`.**

`.ctaButton` in `CorpusBrowser.module.css` manually declares `font-family`, `font-size`, `font-weight`, `letter-spacing`, and `text-transform` — drifting by 0.01em in `letter-spacing` from the `label-md` scale in `Type.tsx`. This creates two sources of truth for similar typography.

Replace the button's inner text with `<Type variant="label-md" as="span">Open for tagging</Type>` and drop the `font-*` properties from `.ctaButton`. The button provides the colored background and click target; `Type` provides the typography.

---

### Step 8 — Accessibility baseline (R6-I6, R6-I8, R6-I9)

These three issues are WCAG 2.1 AA concerns that are cheapest to fix before more interactive components land.

**R6-I6: Add `:focus-visible` styles to all interactive elements.**

No interactive element in the corpus browser has a visible focus indicator. `BrowseItem`, `BrowseAccordion`'s section header, and the CTA button all have `border: none` and no `:focus-visible` rule, so keyboard users cannot tell which element their Tab focus is on.

Add to `base.css` (or a co-located `ui/focus.css` imported from `base.css`):

```css
button:focus-visible,
a:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: -2px;
}
```

Also add `--color-focus: var(--color-primary)` to `tokens.css` so focus color can be independently themed. The `outline-offset: -2px` places the ring inside the element's box, which works correctly at 0px border-radius.

Verify: Tab through the browse hierarchy; every interactive element shows a 2px primary-color ring when focused. Lighthouse / axe accessibility audit should pass "Interactive elements have accessible focus indicators."

**R6-I8: Decouple `Type` heading-level defaults from font size.**

`Type.tsx`'s `defaultTags` map binds `'display-lg'` to `<h1>`, `'headline'` to `<h3>`, etc. This couples typographic size (visual) to heading level (semantic). A page that needs three section headers all styled `headline` gets `<h3>` from the first — but if the page has no `<h2>`, screen readers encounter a broken heading outline.

`ScoreViewerStub` already violates this: it renders `<Type variant="headline">` which auto-produces `<h3>` on a page with no `<h1>`.

Change all defaults to `span` (or `p` for body variants). Force every consumer to specify the semantic element via `as`. This is more verbose but unambiguous: `<Type variant="headline" as="h1">Score Viewer</Type>`. Update all existing call sites in the codebase at the same time.

Additionally, add `eslint-plugin-jsx-a11y` to devDependencies and enable the `heading-has-content` and `no-heading-increment` rules. Wire into `eslint.config.js`.

**R6-I9: Set `alt=""` on incipit images.**

`IncipitImage` currently renders `alt="Score incipit"` on every movement, so screen-reader users hear "Score incipit, Score incipit, Score incipit…" The incipit is purely visual — the movement title in the parent `MovementCard` is the canonical accessible name. Decorative images should carry `alt=""` so screen readers skip them.

Change to `alt=""` and add a code comment: `{/* Decorative: the movement title in MovementCard is the accessible name. */}`

---

### Step 9 — Code-quality cleanup (R6-I11, R6-I12, R6-I16, R6-I17)

These are maintenance improvements with no user-visible effect. Do them in a single commit before the score viewer work begins, so the Component 2 component layer is clean.

**R6-I11: Consolidate `BrowseAccordion`'s three auto-advance effects.**

Three separate `useEffect` hooks each set `openSection` based on whether a selection exists. Replace with one:

```typescript
useEffect(() => {
  if (selectedWorkId) setOpenSection('movement');
  else if (selectedCorpusSlug) setOpenSection('work');
  else if (selectedComposerSlug) setOpenSection('corpus');
}, [selectedComposerSlug, selectedCorpusSlug, selectedWorkId]);
```

**R6-I12: Extract `useBrowseSelection()` to reduce 17-prop drilling.**

`BrowseAccordionProps` has 17 fields — every piece of state from `CorpusBrowser`, four times over. Extract a `useBrowseSelection()` hook that owns all four data sources, the URL-param state machine, and the loading/error flags. Both the accordion and the desktop layout consume the hook directly. This reduces both the prop interface and the risk of divergence between the two layouts as the browse feature grows.

**R6-I16: `JSX.IntrinsicElements` → `React.JSX.IntrinsicElements` in `Type.tsx`.**

`type AsProp = keyof JSX.IntrinsicElements` uses the React 17 global namespace that is being phased out in newer `@types/react` versions. Replace with `keyof React.JSX.IntrinsicElements`.

**R6-I17: Drop duplicate `key` props inside `BrowseAccordion`'s `renderItem` callbacks.**

`BrowseColumn` wraps each `renderItem` output in `<React.Fragment key={key}>`. The inner `key` props on `BrowseItem`/`MovementCard` inside the callbacks are ignored by React (the Fragment is the list child) and should be removed to avoid silent bugs if the iteration shape changes.

---

## Part 2 — Vitest Setup

### Step 10 — Frontend test harness

**This step was flagged as a known gap in Report 7 Issue 1 and explicitly carried into Component 3 by the measure-number redesign plan.**

Add Vitest and React Testing Library to `frontend/package.json` devDependencies:

```bash
npm install -D vitest @testing-library/react @testing-library/user-event @testing-library/jest-dom jsdom
```

Configure in `vite.config.ts`:

```typescript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
  },
});
```

Create `frontend/src/test/setup.ts`:

```typescript
import '@testing-library/jest-dom';
```

Add to `package.json` scripts:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:coverage": "vitest run --coverage"
```

**Initial test suite.** Write smoke tests for each existing route — enough to confirm the page renders without throwing given a mocked service layer. Create `src/routes/__tests__/CorpusBrowser.test.tsx`:

```typescript
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { vi } from 'vitest';
import * as browseApi from '../../services/browseApi';
import CorpusBrowser from '../CorpusBrowser';

vi.mock('../../services/browseApi');

describe('CorpusBrowser', () => {
  it('renders the composer column heading', async () => {
    vi.mocked(browseApi.fetchComposers).mockResolvedValue([]);
    render(<MemoryRouter><CorpusBrowser /></MemoryRouter>);
    expect(screen.getByText(/composer/i)).toBeInTheDocument();
  });

  it('shows an error state when the fetch fails', async () => {
    vi.mocked(browseApi.fetchComposers).mockRejectedValue(
      new Error('NETWORK_ERROR'),
    );
    render(<MemoryRouter><CorpusBrowser /></MemoryRouter>);
    await screen.findByText(/something went wrong/i);
  });
});
```

**Coverage target:** every new file added in Component 3 should have at least one test. The goal is to normalise testing as part of feature development rather than retroactively, not to reach a specific coverage threshold immediately. A reasonable starting threshold for `npm run test:coverage` is 50% — enough to catch obvious gaps without being onerous on thin UI files.

**Wire into CI:** add `npm test` to the GitHub Actions workflow alongside `npm run lint` and `npm run lint:css`.

---

## Part 3 — Score Viewer Implementation

With the cleanup and test harness in place, Component 3's primary deliverable can be built on a clean foundation.

---

### Step 11 — Verovio WASM integration

Create `frontend/src/services/verovio.ts` as the single point of interaction with the Verovio WASM build. Isolating Verovio behind a service module means components never import from `verovio` directly, and the WASM loading lifecycle is managed in one place.

**Loading strategy.** The Verovio WASM bundle is large (~7–10 MB). Load it lazily, on first navigation to the score viewer route, not at app startup. Use a singleton promise so concurrent callers receive the same instance:

```typescript
let _verovioPromise: Promise<verovio.toolkit> | null = null;

export function getVerovioToolkit(): Promise<verovio.toolkit> {
  if (!_verovioPromise) {
    _verovioPromise = import('verovio/wasm').then(({ VerovioToolkit }) => {
      const tk = new VerovioToolkit();
      return tk;
    });
  }
  return _verovioPromise;
}
```

The route-level loading boundary shows a "Loading score renderer…" placeholder (a `Surface layer="container"` with a `label-md` label) while the singleton resolves. Once resolved, the toolkit instance is reused for all subsequent renders without reloading WASM.

**Pinning.** Per ADR-013 (Verovio version policy), the npm package must be pinned to a specific version in `package.json` (use the same version confirmed functional in the Python bindings spike, currently 4.2.1 in `requirements.txt` though the spike confirmed 6.1.0 behaviour — reconcile with the backend pin and document in ADR-013 as an addendum if the versions differ).

**Rendering pipeline.** Expose the following functions from `verovio.ts`:

```typescript
// Render one page (segment) of a loaded score.
export async function renderPage(
  tk: verovio.toolkit,
  meiText: string,
  options: RenderOptions,
  pageNum: number,
): Promise<string>   // returns SVG string

// Render a fragment range (uses mc coordinates from the fragment row).
export async function renderFragment(
  tk: verovio.toolkit,
  meiText: string,
  mcStart: number,
  mcEnd: number,
  options: RenderOptions,
): Promise<string>   // returns SVG string

// Generate MIDI from a loaded score.
export async function renderMidi(
  tk: verovio.toolkit,
): Promise<string>   // returns base64-encoded MIDI
```

`RenderOptions` covers `scale` (staff size), `transpose`, and `pageWidth`. Changing any option requires re-rendering; callers are responsible for debouncing control interactions (see Step 12).

**Progressive rendering.** For full-movement display, render pages one at a time rather than waiting for all pages to complete before displaying anything. The rendering loop:

1. Set options and load MEI: `tk.setOptions(opts); tk.loadData(meiText)`.
2. Get total page count: `tk.getPageCount()`.
3. Render page 1 synchronously (no yield), append its SVG to the DOM.
4. Render remaining pages in batches via `setTimeout(0)` between pages so the browser can paint and respond to input.
5. A loading indicator beneath the last rendered page advances until all pages are appended.

This guarantees the first system is visible within ~300ms of MEI load, regardless of score length.

---

### Step 12 — Score viewer route and controls

Create `frontend/src/routes/ScoreViewer.tsx`, replacing `ScoreViewerStub.tsx` entirely (delete the stub once the viewer passes its smoke test).

**Route.** The viewer is at `/scores/:movementId`. `CorpusBrowser`'s "Open for tagging" button already navigates here; update its `to` prop from `/tag/:movementId` to `/scores/:movementId`.

**MEI fetch.** On mount, call a new backend endpoint `GET /api/v1/movements/{movementId}/mei-url` that returns a fresh signed URL for the MEI file. Fetch the MEI text via the signed URL. The URL is not stored — it expires, and the MEI text is what the viewer needs. Once the text is fetched, pass it to the Verovio service.

Add `GET /api/v1/movements/{movementId}/mei-url` to `backend/api/routes/browse.py`. It resolves `movement.mei_object_key` via `signed_url()` and returns `{ "url": "https://..." }`. This is a thin route; the service logic is one line. Require `editor` role.

**Layout.** Three zones:

1. **Toolbar** — a `Surface layer="container-high"` strip at the top of the viewer (not fixed; scrolls with the page). Contains the score controls (Steps 12.1 and 12.2 below) and a back-to-browser link.
2. **Score panel** — the scrollable main content. SVG pages stack vertically. A thin loading indicator (a `--color-primary`-tinted horizontal bar) advances as pages are progressively rendered.
3. **Playback bar** — a `Surface layer="container-highest"` strip fixed at the bottom of the viewport, containing transport controls (Step 14).

**12.1 — Staff size control.**

Expose Verovio's `scale` option as three preset buttons: Small (25), Medium (35, default), Large (45). Changing the scale re-renders the entire score: set new options, call `tk.loadData(meiText)` (Verovio requires a reload when options change), re-render all pages. Debounce scale changes with a 200ms delay so rapid clicks coalesce into one render.

While re-rendering, keep the previous SVG visible (do not clear the DOM first) and overlay a semi-transparent surface with a `label-md` "Re-rendering…" label. This avoids a blank-screen flash.

**12.2 — Transposition control.**

Expose Verovio's `transpose` option as a `<select>` element listing common transposition intervals: No transposition, Up a semitone, Up a tone, Up a major third, Down a semitone, Down a tone, Down a major third, plus any octave. The values map to Verovio's transposition strings (e.g. `"d2"`, `"M2"`, `"-d2"`, etc.).

Transposition is display-only — the MEI file is never modified. MIDI playback follows the display transposition: the MIDI generated by `verovio.renderToMIDI()` is called after setting the transposition option, so the MIDI notes reflect the transposed pitches.

Debounce the same way as scale changes (200ms).

**12.3 — Score viewer Vitest tests.**

Write tests in `src/routes/__tests__/ScoreViewer.test.tsx`. Mock `verovio.ts` and the MEI fetch. Cover: loading state while WASM loads, SVG rendered once loading completes, error state when MEI fetch fails.

---

### Step 13 — Fragment rendering

Fragment rendering uses the `mc_start`/`mc_end` coordinates established by the measure-number redesign. No coordinate conversion is needed at render time: pass `mc_start` and `mc_end` directly to `tk.select()` as the `measureRange` operand.

**Fragment render function:**

```typescript
// In verovio.ts
export async function renderFragment(
  tk: verovio.toolkit,
  meiText: string,
  mcStart: number,
  mcEnd: number,
  options: RenderOptions,
): Promise<string> {
  tk.setOptions({ ...options, breaks: 'none', adjustPageHeight: true });
  tk.loadData(meiText);
  tk.select({ measureRange: `${mcStart}-${mcEnd}` });
  tk.redoLayout();
  return tk.renderToSVG(1);
}
```

This directly applies the spike findings from the Component 2 Verovio Python bindings spike (confirmed working in Verovio 6.1.0 with 1-based position indices as `measureRange` operands). Note that `breaks: 'none'` with a wide `pageWidth` is the approach for fragment renders — all selected measures on a single page, no pagination.

**Spike for edge cases (to run at Step 11 setup time, before this step):**

Although the Python bindings spike confirmed the core behaviour, the WASM client-side build should be verified for two fragment-specific edge cases before this step is written:

1. A fragment that begins at `mc=1` (first measure) — does `measureRange: "1-4"` behave identically to `measureRange: "start-4"`?
2. A fragment containing a volta ending — does rendering `mc_start=2, mc_end=2` on a movement where position 2 is inside `<ending n="1">` render only that ending's measure, not the parallel ending?

Document findings in `docs/architecture/mei-ingest-normalization.md` under an addendum to the existing spike section. Any workarounds required go into the `renderFragment` function as comments.

**Fragment overlay architecture forward-compatibility.** Fragment rendering in Component 3 covers the full-score overlay (Component 7) and the standalone fragment detail view (Component 8). Neither is fully built yet, but the overlay architecture is established now so Components 7 and 8 inherit a correct starting point.

Overlays (selection brackets, fragment labels) are absolutely-positioned HTML elements layered above the SVG container with `pointer-events: none`. They are never added inside Verovio's SVG — Verovio re-renders can discard SVG modifications at any time. This is the rule from `docs/architecture/prototype-tagging-tool.md` and CLAUDE.md; applying it here means it cannot be violated by a future component that copies the pattern.

---

### Step 14 — MIDI playback

**Decision:** `@tonejs/midi` + Tone.js (ADR-012). The architecture mirrors the spec in `phase-1.md` Component 3 § "MIDI Playback."

**14.1 — Install and configure.**

```bash
npm install tone @tonejs/midi
```

Tone.js requires user gesture before `AudioContext` starts (browser autoplay policy). Wire `Tone.start()` to the play button's click handler. Do not call it on mount.

**14.2 — SoundFont.**

Load a piano SoundFont into `Tone.Sampler`. Host the SoundFont from Cloudflare R2 (or the same MinIO bucket in local dev) — do not bundle it with the frontend. Use a compact piano SoundFont in the 1–2 MB range (e.g. Salamander Grand Piano reduced samples). The SoundFont bucket key convention: `soundfonts/piano/{note}.mp3`. Add this key prefix to `docs/architecture/tech-stack-and-database-reference.md`.

The sampler loads lazily when the play button is clicked for the first time, not on score load. Show a "Loading instrument…" state in the playback bar while the sampler resolves.

**14.3 — MIDI generation and scheduling.**

1. On score load (after all pages are rendered), call `renderMidi(tk)` to obtain the base64 MIDI string.
2. Decode via `@tonejs/midi`'s `Midi` constructor to get a note schedule.
3. On play: schedule all notes onto the `Tone.Transport` using `Tone.Sampler.triggerAttackRelease`.
4. At each note onset, fire the position callback:

```typescript
onPositionUpdate({ bar: noteBar, beat: noteBeat });
```

**14.4 — `onPositionUpdate` callback and highlight.**

The `onPositionUpdate(bar, beat)` callback is the **sole interface between the playback layer and the score viewer**. The MIDI player calls it; a future real-audio player would call the same callback. The score viewer subscribes to it; the tagging tool overlay will also subscribe.

In the callback handler, call `tk.getElementsAtTime(bar, beat)` to identify the sounding SVG element. Add a CSS class (`is-playing`) to the corresponding SVG group. Apply the class via a direct DOM mutation on the SVG (not via React state — the callback fires at note-level frequency and React state updates would be too slow). When the element changes, remove `is-playing` from the previous element.

Style `is-playing` in `ScoreViewer.module.css`: a translucent background tint using `var(--color-primary)` at 15% opacity, applied via SVG `fill` on the group. This is simpler to implement than a caret and sufficient for Phase 1.

**14.5 — Transport controls.**

The playback bar (`Surface layer="container-highest"`, `position: fixed; bottom: 0`) contains:
- **Play/Pause** — `Tone.Transport.start()` / `Tone.Transport.pause()`. Icon: standard play/pause symbols.
- **Stop** — `Tone.Transport.stop()` plus `Tone.Transport.position = 0`. Clears the highlight.
- **Position display** — a `label-md` display of the current bar and beat (updated from `onPositionUpdate`).

Scrubbing (clicking to a position in the score) is deferred to Phase 2 per the spec in `phase-1.md`.

**14.6 — Transposition follow-through.**

When the transposition control changes (Step 12.2), regenerate the MIDI by calling `renderMidi(tk)` after the re-render is complete (since the toolkit now has the transposed score loaded). Re-schedule all notes. If playback is in progress, stop it first.

**14.7 — Playback tests.**

Mock `Tone` and `@tonejs/midi` in Vitest. Test: play button triggers `Tone.start()` and `Tone.Transport.start()`; stop button resets position; `onPositionUpdate` fires with correct bar/beat values from the mocked note schedule.

---

### Step 15 — Verification

**Backend:**

- `GET /api/v1/movements/{movementId}/mei-url` returns a signed URL and requires `editor` role; 404 on unknown movement.
- Unit test: service function resolves `mei_object_key` via `signed_url()` and returns the correct shape.

**Frontend — functional:**

- Loading a movement navigates to `/scores/:movementId`, shows the loading skeleton, then renders the first system SVG within 300ms of MEI load completing.
- Staff size: switching Small → Large re-renders the score; previous pages stay visible during re-render.
- Transposition: selecting "Up a tone" re-renders with transposed notation; MIDI follows the transposition.
- Playback: clicking Play loads the instrument (first click only), then starts playback; the highlight tracks the playing note; Stop clears the highlight and resets position.
- Fragment rendering: passing `mcStart=1, mcEnd=4` to `renderFragment` produces an SVG of the first four measures; a volta fixture confirms `mcStart=2, mcEnd=2` renders only the intended measure.

**Frontend — tests (`npm test` passes):**

- `CorpusBrowser.test.tsx`: smoke tests from Step 10 pass.
- `ScoreViewer.test.tsx`: loading, rendered, error states.
- Playback tests: transport controls mock correctly.

**Design system (`npm run lint:css` passes):**

- No `1px solid` borders.
- No `border-radius` values other than `var(--border-radius)`, `0`, or `0px`.
- No pure black or white literals.

**Lint (`npm run lint` passes):**

- No ESLint errors.
- `eslint-plugin-jsx-a11y` rules pass.

**Accessibility:**

- Tab navigation through the corpus browser shows focus rings on all interactive elements.
- Screen reader navigation of the movements column does not announce "Score incipit" between titles.
- `ScoreViewer` renders a proper `<h1>` (via `<Type variant="headline" as="h1">`).

---

## Sequencing

The deferred fixes (Steps 1–9) are mostly independent of each other and of the score viewer. Two developers can split them cleanly: one takes the functional bugs and infrastructure (Steps 1–5), the other takes the design-system and accessibility pass (Steps 6–9). Steps 10–15 depend on Steps 1–9 being complete (the test harness is needed from Step 10 onward) but are otherwise sequential.

```
Day 1:   Step 1 (lint fix) + Step 3 (doc/tsconfig fixes)
Day 2:   Step 2 (functional bugs: fetch error handling, race, footer, incipit)
Day 3:   Step 4 (ADR-016, security-model.md) + Step 5 (self-host fonts, stylelint)
Day 4:   Step 6 (Zod, Content-Type) + Step 9 (code quality cleanup)
Day 5:   Step 7 (design system: borders, Type.tsx, Surface) + Step 8 (a11y: focus, alt, heading levels)
Day 6:   Step 10 (Vitest setup + initial smoke tests)
Day 7:   Step 11 (Verovio WASM integration: loading, progressive render)
Day 8:   Step 12 (ScoreViewer route: layout, staff size, transposition)
Day 9:   Step 13 (Fragment rendering: mc coordinates, spike verification)
Day 10:  Step 14 (MIDI playback: SoundFont, scheduling, transport controls, highlight)
Day 11:  Step 15 (Verification pass: all tests, lint, a11y audit, staging smoke)
```

---

## Hard gates before Component 4 begins

1. `npm run lint`, `npm run lint:css`, and `npm test` all pass in CI.
2. The score viewer renders the Mozart corpus movements correctly in staging: SVGs load progressively, staff size and transposition controls function, MIDI playback starts and the highlight tracks notes.
3. Fragment rendering is verified for both linear and volta fixtures using `mc_start`/`mc_end` coordinates; findings are in `docs/architecture/mei-ingest-normalization.md`.
4. ADR-016 (JWT storage) is written and linked from `security-model.md`.
5. The `onPositionUpdate(bar, beat)` callback abstraction is in place and documented as the sole interface between playback and the score viewer, so Component 7's fragment overlay and any future real-audio path can subscribe without touching the MIDI player.
