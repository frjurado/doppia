# Frontend Testing

## Current status

No frontend test framework is configured for Phase 1. This is a deliberate choice, not an oversight.

**Why deferred.** The Phase 1 frontend is a thin read-only browser layer on top of four browse endpoints (`/composers`, `/corpora`, `/works`, `/movements`). The backend integration tests cover the API contract; the frontend renders the responses with minimal transformation logic. The risk of silent regressions at this stage does not justify the setup cost.

**What is in place.** Static checking runs today:

```bash
npm run lint     # ESLint (zero warnings enforced)
npm run format   # Prettier
```

TypeScript's compiler also catches structural errors at build time (`npm run build`).

## Phase 2 plan

When the tagging UI ships (Phase 2), the frontend will contain non-trivial interaction logic — fragment selection, concept search, MEI overlay rendering — where regressions are harder to catch by eye. At that point the plan is:

1. **Add Vitest + `@testing-library/react`** to `devDependencies`.
2. **Add a `test` script** to `package.json`: `"test": "vitest run"`.
3. **Write one smoke test per route** asserting the page renders without throwing given a mocked service-layer response.
4. **Add component tests** for any piece of state logic that is not trivially derivable from props.

The Verovio SVG overlay layer (fragment selection brackets, playback indicators) will be tested via snapshot tests of the overlay HTML, not of the Verovio SVG itself (which is considered a third-party render surface).

## What not to test

- Verovio's SVG output directly. Verovio is a third-party library; its rendering is covered by its own test suite. Our responsibility is the overlay layer.
- Pixel-level visual regression. The design system (`docs/mockups/opus_urtext/DESIGN.md`) uses tonal depth and typography, not pixel-precise layout, so pixel diffs are noisy and not the right tool.
