# Doppia Code Review — Report 5: Frontend

## Summary

**Scope.** This report covers the frontend configuration (`package.json`, `vite.config.ts`, `tsconfig.app.json`, `eslint.config.js`, `.prettierrc`), the design-token and base-style layer (`src/styles/`), the entry points (`main.tsx`, `App.tsx`), and the API/auth services (`src/services/api.ts`, `src/services/auth.ts`). It does **not** cover the route components (`src/routes/CorpusBrowser.tsx`, `ScoreViewerStub.tsx`), the browse UI components (`src/components/browse/*`), or the UI primitives (`src/components/ui/Surface.tsx`, `Type.tsx`) in depth — those were left for a follow-up pass. Findings here therefore concern the foundation rather than feature code.

**General view.** The frontend is small, well-scoped, and consistent with ADR-010 (React 18 + Vite + TypeScript + RR v6 — confirmed in `package.json`). The design system is wired up exactly as `docs/mockups/opus_urtext/DESIGN.md` and CLAUDE.md prescribe: Henle Blue and Urtext Cream as CSS custom properties, Newsreader/Public Sans typography, 0px border-radius enforced globally via the `*` selector, no 1px solid dividers (the outline-variant token uses `rgba(...)` with 0.15 opacity). TypeScript is in strict mode with `noUnusedLocals`, `noUnusedParameters`, and `allowJs: false` — matching CONTRIBUTING.md's "no `.js` files in src". The `apiFetch` wrapper correctly parses the backend error envelope (`body.error.code`, `body.error.message`, `body.error.detail`), wraps network failures as `ApiError("NETWORK_ERROR", ...)`, and types responses via a generic.

The problems are concentrated in three places. **First, a real bug in CI / contributor experience**: `npm run lint` fails on a fresh clone because `eslint.config.js` imports packages that aren't in `package.json`. **Second, a doc-vs-code drift**: README claims the frontend dev server runs on `localhost:3000`, but Vite is configured for 5173 (and the backend's CORS allowlist also uses 5173). **Third, a security policy ambiguity**: `auth.ts` stores access tokens in `localStorage`, while `security-model.md` line 312 explicitly forbids `localStorage` for session-scoped data (admittedly in a passage about signed URLs, but the XSS exfiltration concern applies more strongly to JWTs). ADR-001 doesn't address token storage, so the choice is undocumented.

Smaller findings: Google Fonts loaded at runtime via `@import` will conflict with the Phase 2 CSP, no runtime validation at the API boundary (`apiFetch<T>` casts `unknown` to `T` blindly), and the design system is enforced by convention rather than by a stylelint rule.

---

## Issue 1: `npm run lint` fails on a fresh clone

**Issue.** `frontend/eslint.config.js` imports two packages that are not in `package.json`:

```js
import globals from 'globals';
import tseslint from 'typescript-eslint';
```

`package.json` has `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` (the legacy individual-package style), but the config uses the new flat-config meta-package `typescript-eslint`. These are different packages.

I verified this end-to-end on a fresh clone:

```
$ cd frontend && npm install
$ npm run lint
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'typescript-eslint'
imported from /home/claude/doppia/frontend/eslint.config.js
```

`globals` happens to resolve because npm hoisted it as a transitive dependency of eslint, but `typescript-eslint` is not hoisted and the whole config errors out before any linting runs.

CONTRIBUTING.md tells contributors to run `npm run lint`. CLAUDE.md does the same. The README at line 100 says CI runs lint. So this breaks the documented contributor flow and (if CI is configured per the docs) every PR.

**Solution.** Add the missing packages to `frontend/package.json` devDependencies:

```json
"globals": "^15.13.0",
"typescript-eslint": "^8.0.0"
```

The legacy `@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` can stay (the meta-package re-exports them) or be removed once the flat config is the only consumer.

**Verification.** After `npm install`:

```bash
$ npm run lint
# should complete with zero errors (and no `--max-warnings 0` violation)
```

Add a CI step that runs `npm run lint` on every PR.

---

## Issue 2: README claims frontend dev server is on `localhost:3000`; actual port is 5173

**Issue.** README.md line 45:

> **Frontend dev server** on `localhost:3000`

`vite.config.ts` line 8 explicitly sets `port: 5173`. `backend/main.py`'s `_ALLOWED_ORIGINS["local"]` also lists `http://localhost:5173` and `http://localhost:4173` (Vite preview), not 3000. So the README is the only thing claiming 3000.

A new contributor following the README will run `docker compose up`, see frontend logs reporting port 5173, hit `localhost:3000` in their browser, get nothing, and start debugging. Worse, if they "fix" it by changing the Vite port to 3000, every API call from the frontend will now fail CORS (3000 isn't in the allowlist).

**Solution.** Update README.md line 45 to say `localhost:5173`. Update line 161 (the operational links table) the same way. The Vite preview port (4173) might be worth mentioning too, since it's in the CORS allowlist — but only if anyone actually uses `vite preview` locally.

**Verification.** `grep -rn "localhost:3000\|localhost:5173" README.md backend/main.py frontend/vite.config.ts` — every reference to a frontend dev port should be `5173` (or `4173` for preview).

---

## Issue 3: Access tokens in `localStorage` is undocumented and weakly defended

**Issue.** `frontend/src/services/auth.ts` stores the access token in `localStorage` under the key `doppia_access_token`. Three observations:

1. **`security-model.md` line 312 explicitly forbids `localStorage`** for session-scoped data: *"they should be treated as session-scoped and not persisted to localStorage or similar."* That paragraph is technically about signed URLs, but the exfiltration concern (any XSS-capable script reads `localStorage.*`) applies more strongly to JWTs than to short-lived signed URLs.
2. **ADR-001 doesn't address token storage**, so this is an undocumented decision.
3. **The frontend already loads CSS from Google Fonts via runtime `@import`** (`base.css` line 1), which means any compromise of `fonts.googleapis.com` could inject script (via a CSS-injection-to-XSS chain — narrow but real). The XSS surface is not zero.

For Phase 1 (internal-only tagging tool, small annotator team) the risk is small. But the doc says one thing, the code does another, and there's no recorded choice.

**Solution.** Three options, in increasing investment:

1. **Document the current choice in ADR-014.** Title: "JWT storage in the browser." Decision: localStorage is acceptable for Phase 1 because (a) the tagging tool is internal-only with no anonymous traffic, (b) the team is small and trusted, (c) the alternatives (`HttpOnly` cookie + CSRF token, in-memory only with refresh dance) add Phase 1 complexity without a Phase 1 threat model. State explicitly that this must be revisited before Phase 2 public launch.
2. **Move to in-memory token storage now.** `auth.ts` keeps the token in a module variable; `getSession()` reads from there. The token is lost on page refresh, requiring re-login. Not viable without a refresh-token flow.
3. **Use `HttpOnly` cookies for the JWT** and get tokens via a `/auth/session` endpoint. Best long-term, requires backend cooperation (set the cookie, validate it from the cookie not the header), and doesn't block on Supabase-Auth specifics.

Recommendation for now: **option 1**. Write the ADR, schedule a Phase 2 task to revisit. Until then, also reconcile `security-model.md` line 312: either add a sentence noting that the JWT-in-localStorage choice is the documented exception (per ADR-014), or rewrite the sentence to be specifically about signed URLs.

**Verification.** ADR-014 exists and is linked from `security-model.md`. A grep for `localStorage` across the frontend returns only the JWT use case, not new ones.

---

## Issue 4: No runtime validation at the API boundary

**Issue.** `apiFetch<T>` (services/api.ts line 38) does:

```typescript
return response.json() as Promise<T>;
```

The cast is unchecked. If the backend response shape drifts from the TypeScript type — a new field, a renamed field, a wrong nullability — the frontend silently produces objects that don't match `T`, and the type error surfaces somewhere downstream as `undefined.something` or an unexpected `null`. There is no runtime safety net.

This is normal in many React apps — TypeScript-only validation is the default. But `summary` JSONB on `fragment` is described in `fragment-schema.md` as "a published API from the moment the first fragment record is written," and ADR-007 ties the embedding pipeline to it. Both situations are exactly when runtime drift gets expensive.

**Solution.** Add a runtime validator at the boundary. Two reasonable choices:

1. **Zod** (most popular, larger). Define schemas alongside the TS types in `src/types/`:

   ```typescript
   // types/browse.ts
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

   Then make `apiFetch` accept an optional schema:

   ```typescript
   export async function apiFetch<T>(
     path: string,
     options?: RequestInit,
     schema?: ZodSchema<T>,
   ): Promise<T> {
     // ... existing fetch logic ...
     const json = await response.json();
     return schema ? schema.parse(json) : (json as T);
   }
   ```

2. **Valibot** (smaller, similar API, better tree-shaking). Same shape.

The cost is modest (~12KB gzipped for Zod), the bug-prevention is real, and you get the schemas as the single source of truth for the API contract — auto-derived TypeScript types and runtime validators from the same definition.

**Verification.** A test that posts a malformed response to `apiFetch` (via a mock) and asserts on the `ZodError`. Drift between backend and frontend surfaces as a clear validation error rather than a downstream `undefined` access.

---

## Issue 5: Design-system invariants enforced by convention only

**Issue.** CONTRIBUTING.md and CLAUDE.md treat the design system as load-bearing:

> Key constraints: 0px border-radius everywhere, no 1px solid dividers, depth through tonal layering only. Deviating without a documented reason is treated as a style violation.

The actual enforcement:
- `base.css` has a `*` selector applying `border-radius: var(--border-radius)` (which is `0px`). ✓
- The forbidden colors (pure black, pure white) are documented as a comment in `base.css` lines 24–26: *"Forbid pure black and pure white as direct values in component CSS. Use token variables only. This comment is the enforcement rule; ESLint cannot lint CSS, so it lives here as documentation."*

So the policy lives in a comment. A contributor opening a CSS module and writing `border: 1px solid #000` will pass lint, build, and tests with zero friction. The `*` rule for border-radius can be overridden by any specific selector. The "no pure black/white" rule has no enforcement at all.

**Solution.** Add **stylelint** with rules that match the policy. A reasonable starting config:

```js
// frontend/.stylelintrc.json
{
  "extends": ["stylelint-config-standard"],
  "rules": {
    // Forbid pure black/white literals; use tokens.
    "color-no-hex": [true, { "ignore": ["named"] }],
    "declaration-property-value-disallowed-list": {
      "color": ["/^#000(000)?$/", "/^#fff(fff)?$/", "black", "white"],
      "background-color": ["/^#000(000)?$/", "/^#fff(fff)?$/", "black", "white"]
    },
    // 0px border-radius everywhere; allow only var(--border-radius).
    "declaration-property-value-allowed-list": {
      "border-radius": ["/^var\\(--border-radius\\)$/", "0", "0px"]
    },
    // No 1px solid dividers.
    "declaration-property-value-disallowed-list": {
      "border": ["/^1px solid /"],
      "border-top": ["/^1px solid /"],
      "border-bottom": ["/^1px solid /"],
      "border-left": ["/^1px solid /"],
      "border-right": ["/^1px solid /"]
    }
  }
}
```

Add `"lint:css": "stylelint 'src/**/*.css'"` to package.json scripts. Wire into CI.

**Verification.** Adding a `border-radius: 4px` or `border: 1px solid black` anywhere in `src/components/` causes `npm run lint:css` to fail.

---

## Issue 6: Google Fonts loaded at runtime via `@import` will collide with the Phase 2 CSP

**Issue.** `src/styles/base.css` line 1:

```css
@import url('https://fonts.googleapis.com/css2?family=Newsreader:...&family=Public+Sans:...');
```

Three concerns:

1. **CSP.** `security-model.md` Phase 2 additions list a starting CSP (line 447–456):
   ```
   default-src 'self';
   style-src 'self' 'unsafe-inline';
   ```
   `style-src 'self'` blocks `fonts.googleapis.com`. The CSP would need `style-src 'self' 'unsafe-inline' https://fonts.googleapis.com` and `font-src 'self' https://fonts.gstatic.com` to allow fonts. That's three external origins added to the CSP — all controlled by Google.

2. **Privacy.** Every page load makes a request to Google. For an open music analysis tool with academic/EU users, this may matter (GDPR — Google Fonts has been ruled an issue in some EU jurisdictions when not pre-installed locally).

3. **Performance.** A render-blocking external CSS import on every page load. Self-hosted fonts ship with the bundle and cache predictably.

**Solution.** Use `@fontsource/newsreader` and `@fontsource/public-sans` to bundle the fonts with the build. Both are open-source, MIT-licensed packages that mirror the Google Fonts catalog.

```bash
npm install @fontsource/newsreader @fontsource/public-sans
```

```css
/* base.css */
@import '@fontsource/newsreader/400.css';
@import '@fontsource/newsreader/600.css';
@import '@fontsource/newsreader/400-italic.css';
@import '@fontsource/public-sans/400.css';
@import '@fontsource/public-sans/500.css';
@import '@fontsource/public-sans/600.css';
@import './tokens.css';
```

The `@import url(...)` to `googleapis.com` goes away; fonts ship with the Vite build; the CSP starting policy from `security-model.md` works as written; no Google round-trip on first paint.

**Verification.** Build the production bundle and inspect: the CSS should reference local font URLs (`/assets/newsreader-...woff2`), not `fonts.googleapis.com`. Network tab on a fresh load shows zero requests to Google domains.

---

## Issue 7: `apiFetch` `Content-Type` header is set on every request, including `GET`

**Issue.** `services/api.ts` line 41:

```typescript
const headers: Record<string, string> = {
  'Content-Type': 'application/json',
  ...(options?.headers as Record<string, string> | undefined),
};
```

`Content-Type` describes the **request body**. On a `GET` request with no body, the header is meaningless and can occasionally cause middleware on the backend to misinterpret the request. It's also one extra byte (well, a few) on every request.

More importantly, the header set unconditionally will conflict with `multipart/form-data` uploads — relevant for the corpus-upload endpoint at `routes/corpora.py`. If the frontend ever needs to call that endpoint via `apiFetch`, it will break: setting `Content-Type: application/json` on a multipart upload is wrong, and overriding it via `options.headers` works only because of the spread order. But the upload endpoint also requires the browser to set the `boundary` parameter on `Content-Type`, which means the right approach is to **omit** `Content-Type` entirely and let `fetch` set it from the `body`.

**Solution.** Set `Content-Type: application/json` only when a body is present and the caller hasn't overridden it:

```typescript
const headers: Record<string, string> = {
  ...(options?.headers as Record<string, string> | undefined),
};
const hasBody = options?.body !== undefined && options.body !== null;
const callerSetContentType = headers['Content-Type'] !== undefined;
if (hasBody && !callerSetContentType && !(options?.body instanceof FormData)) {
  headers['Content-Type'] = 'application/json';
}
```

Or more simply: leave it to the caller. `apiFetch` could just not set `Content-Type` and let each call site declare what it sends.

**Verification.** A test that calls `apiFetch('/upload', { method: 'POST', body: formData })` does not produce a request with `Content-Type: application/json` overriding the FormData boundary.

---

## Issue 8: README's `frontend/` project layout is out of date

**Issue.** Continuing the finding from Report 1 Issue 6: README.md project layout (line 130) describes:

```
├── frontend/
│   ├── components/     Verovio renderer, MIDI player, tagging UI, browsing UI
│   └── services/       API client, graph query client
```

Actual layout:

```
frontend/src/
├── App.tsx
├── main.tsx
├── components/
│   ├── browse/         BrowseAccordion, BrowseColumn, BrowseItem, IncipitImage, MovementCard
│   └── ui/             Surface, Type
├── routes/             CorpusBrowser, ScoreViewerStub
├── services/           api.ts, auth.ts, browseApi.ts
├── styles/             base.css, tokens.css
├── types/              browse.ts
└── vite-env.d.ts
```

The README's layout omits `src/`, `routes/`, `styles/`, `types/`, and the `ui/` subdirectory. It also lists "Verovio renderer, MIDI player, tagging UI" — none of which exist yet (Component 3+ work).

**Solution.** Replace the frontend block in the README with the actual structure, marking unbuilt directories explicitly:

```
frontend/src/
├── App.tsx, main.tsx       Entry points + router setup
├── components/
│   ├── browse/             Composer/corpus/work/movement browse UI (Component 2)
│   └── ui/                 Shared primitives (Surface, Type)
├── routes/                 Top-level routes
│   ├── CorpusBrowser       (Component 2; live)
│   └── ScoreViewerStub     (Component 3 stub)
├── services/               api.ts (fetch wrapper), auth.ts, browseApi.ts
├── styles/                 base.css, tokens.css (design system)
└── types/                  TypeScript-only response shapes
```

**Verification.** `tree -L 3 frontend/src` output matches the README's frontend block.

---

## Issue 9: Token typing in `auth.ts` doesn't match the Supabase claim

**Issue.** `services/auth.ts` line 8–10 states:

> This module is intentionally interface-compatible with the Supabase session shape so that swapping the implementation for a proper Supabase client in Phase 2 requires no changes in apiFetch or any consumer.

The current `Session` interface (line 15–17):

```typescript
export interface Session {
  access_token: string;
}
```

The actual Supabase `Session` shape has many more fields: `refresh_token`, `expires_in`, `expires_at`, `token_type`, `user` (with id, email, app_metadata, etc.). The current shape is a strict subset, which is fine — but the comment says "interface-compatible," and a Phase 2 swap to Supabase will work only if every consumer uses **only** `session.access_token`.

In Phase 1 there's only one consumer (`apiFetch`), and it does only use `access_token`. So today the claim holds. But the comment lacks the constraint: "consumers must access only `access_token` until the full Supabase shape is adopted." A future contributor reading this will assume they can add `session.user.email` and find out at swap time that the field doesn't exist yet.

**Solution.** Either:

1. **Promote the interface to the full Supabase shape now**, even if the local-dev mock only populates `access_token`. The other fields are nullable / typed as `string | null`. Phase 2 swap becomes a no-op for types; only the implementation changes.

2. **Tighten the comment**: "Phase 1 consumers must access only `access_token`. Adding other Supabase fields requires expanding this interface to match Supabase's full Session shape." Then accept the constraint until Phase 2.

Recommendation: option 2 is the smaller change and the constraint is real — there's no token expiry handling in Phase 1, so claiming the full Supabase interface would require stub implementations.

**Verification.** Doc / comment review.

---

## Issue 10: `tsconfig.app.json` and `tsconfig.node.json` exist; `tsconfig.json` is empty?

**Issue.** Three tsconfig files in `frontend/`:
- `tsconfig.json` — 512 bytes
- `tsconfig.app.json` — 1.0K (the substantive one)
- `tsconfig.node.json` — 1.0K

The `tsconfig.json` at the root is the one most editor tooling looks at first. Vite's standard scaffold uses it as a "references" wrapper that pulls in `tsconfig.app.json` and `tsconfig.node.json`. I didn't view it but its 512-byte size is consistent with that. Worth a sanity check that it actually references both, and that editors / IDEs pick up the strict-mode rules from `tsconfig.app.json`.

**Solution.** No specific fix expected; flag for verification only. If `tsconfig.json` is just `{ "files": [] }` or similarly empty, editor TypeScript support won't pick up the strict-mode rules, and developers may write code that builds (because `tsc -b` reads `tsconfig.app.json`) but shows no errors in the editor.

**Verification.** Open `frontend/tsconfig.json` and confirm it has `"references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.node.json" }]`. If it's missing, add it.

---

## Code-quality patterns worth keeping

- **`ApiError` carries `code`, `message`, `status`, and `detail`** — it preserves the full backend error envelope, including the structured `detail` object. Consumers can switch on `error.code` rather than parsing the message string. This is exactly the right shape for a typed-error consumer.
- **Network failure is wrapped as `ApiError("NETWORK_ERROR", ...)`** so callers handle a uniform exception type rather than splitting between `fetch`'s `TypeError` and HTTP errors. Removes a category of bug.
- **Body-parse failure on error responses falls back to defaults** (line 72–74) instead of throwing within the error handler. So a non-JSON 500 from a misbehaving server still produces a meaningful `ApiError` rather than a confusing parse failure.
- **`StrictMode` is on** in `main.tsx`. React 18 strict-mode double-invocation catches a class of effect bugs early. Worth keeping when more components land.
- **`base.css` enforces 0px border-radius via `*`** — globally, not as a per-component rule. The right scope.
- **`tsconfig.app.json` has `noUnusedLocals` and `noUnusedParameters`** as compile errors, not warnings. Combined with the `noUnusedLocals` finding from Report 2 Issue 3 (where `MovementAnalysis` is unused in Python and Ruff doesn't catch it), this puts the frontend ahead of the backend on dead-code hygiene.
- **The auth module is small and stable.** Three exported functions (`getSession`, `setToken`, `clearToken`), a single interface, no transitive imports. Easy to swap for a real Supabase client in Phase 2.

---

## What this report does not cover

The component layer was not analyzed in depth. Specifically:

- `src/routes/CorpusBrowser.tsx` (the only live route)
- `src/routes/ScoreViewerStub.tsx`
- `src/components/browse/*` — `BrowseAccordion`, `BrowseColumn`, `BrowseItem`, `IncipitImage`, `MovementCard`
- `src/components/ui/Surface.tsx`, `Type.tsx`
- `src/services/browseApi.ts` (the typed wrapper around `apiFetch` for the four browse endpoints)
- `src/types/browse.ts`

A follow-up pass on those would focus on:

- **Component composition discipline.** CONTRIBUTING.md says "one component per file, file name matches component name (PascalCase), props as TypeScript interfaces in the same file or in a co-located `types.ts`." Worth verifying.
- **Verovio overlay rule readiness.** None of these components renders Verovio yet, but the SVG overlay pattern is foundational. The shared primitives (`Surface`, `Type`) should be checked against `docs/architecture/prototype-tagging-tool.md` for forward compatibility with the overlay layer.
- **Browse-API client typing.** `services/browseApi.ts` should map cleanly onto the four backend endpoints in `routes/browse.py`. Worth checking the response types match `models/browse.py` field-for-field.
- **Loading / error / empty states.** A common React-app shortcoming is treating these as afterthoughts. The browse hierarchy has four levels of nested fetches; each one needs its own state model.
- **Accessibility.** The design system has no documented a11y position (focus management, color contrast on the cream palette, keyboard navigation). Worth a Phase 1 pass before more UI lands.

---

## Summary of action items

**Real bug (fix immediately):**
- Issue 1: Add `globals` and `typescript-eslint` to `package.json`. `npm run lint` is broken on every fresh clone.

**Doc-vs-code drift:**
- Issue 2: README port `3000` → `5173`.
- Issue 8: Update README's frontend project-layout block.
- Issue 9: Tighten the "Supabase-interface-compatible" comment in `auth.ts`.

**Security and policy decisions to write down:**
- Issue 3: Document the JWT-in-localStorage choice as ADR-014, or change it.
- Issue 6: Self-host the Newsreader and Public Sans fonts to align with the planned CSP.

**Hardening:**
- Issue 4: Add Zod (or Valibot) validation at the API boundary.
- Issue 5: Add stylelint with rules that enforce the design-system invariants.
- Issue 7: Stop setting `Content-Type: application/json` on every `apiFetch` request.

**Verification only:**
- Issue 10: Confirm `tsconfig.json` references `tsconfig.app.json` and `tsconfig.node.json`.
