# ADR-010 — Frontend Framework

**Status:** Accepted
**Date:** 2026-04-14

---

## Context

The tech stack document listed Verovio, Cytoscape.js, and a block editor as frontend tools, but never named a frontend framework. CONTRIBUTING.md described "functional components" and "hooks" — React vocabulary — without stating React explicitly. This implicit decision needed to be made explicit before Phase 1 frontend work began in earnest.

The application has several distinct surfaces with different characteristics:

- **Tagging tool** (Phase 1, internal) — Verovio score viewer with SVG overlay, ghost interaction layer, concept search backed by the knowledge graph. Heavily client-side; no public users; no SEO value.
- **Blog** (Phase 2) — Scrollytelling layout with inline Verovio-rendered notation, MIDI playback, and a block editor (TipTap or Lexical) for authoring. The one surface with a plausible SEO argument.
- **Collections and exercises** (Phase 2) — Authenticated user features. No SEO value.
- **AI tutoring interface** (Phase 3) — Conversational UI with inline notation and audio. Fully client-side by nature.

The backend is FastAPI serving a JSON API. There is no Node.js server in the architecture and no BFF pattern — the frontend is a static client deployed independently of the API.

The Verovio constraint is significant. Verovio is a WASM module with an imperative, side-effectful API: `tk.renderToSVG()` returns an SVG string, `tk.getTimesForElement()` maps MIDI ticks to SVG element IDs for playback sync, and `tk.getElementsAtTime()` handles the reverse. The ghost overlay architecture in the tagging tool (see `docs/architecture/prototype-tagging-tool.md`) is built on these APIs and requires geometry queries at interaction time. None of this is compatible with server rendering — WASM does not run in a server environment, and the geometry queries require a live browser DOM.

The scrollytelling blog layout has the same character: scroll synchronisation between notation and prose is a client-side runtime concern, not a rendering concern that benefits from SSR.

The three realistic options were:

**React + Vite (SPA).** A plain React application with a Vite dev server and build pipeline, with React Router for client-side navigation. No server rendering. Consistent with the functional-components-and-hooks conventions already documented. Maximum compatibility with the Verovio WASM constraint. Simplest deployment shape: a static build served from a CDN or the same host as the FastAPI backend.

**Next.js.** React with an integrated server-rendering layer (SSR/SSG). Adds file-based routing and optional server components. The argument in its favour is SSG for public blog content, which would make posts indexable without JavaScript execution. The argument against is substantial: every Verovio-adjacent component requires `dynamic(() => import(...), { ssr: false })` to disable SSR; React Server Components are designed for data-fetching components that render on the server, which describes almost nothing in this application; and the added complexity of the App Router model would be paid across the entire codebase for a benefit that applies to one surface (the blog) among many. Given that Doppia targets an academic/pedagogical audience rather than general web search traffic, the SEO argument for Next.js is weak.

**SvelteKit.** Technically capable but inconsistent with existing documentation. "Functional components" and "hooks" are React vocabulary; adopting Svelte now would require rewriting the conventions section and finding Svelte-compatible equivalents for TipTap and Cytoscape.js React integrations. No property of this application is handled distinctly better by Svelte. Not a live contender.

---

## Decision

Use **React 18 + Vite** as the frontend framework and build tool, with **TypeScript** throughout and **React Router v6** for client-side navigation.

This makes explicit the decision already implied by CONTRIBUTING.md's component and hooks conventions. React + Vite is the most coherent choice given the Verovio WASM constraint, the FastAPI-only backend, and the predominantly client-side nature of all application surfaces.

TypeScript is the language for all frontend code. Props are typed with TypeScript interfaces as described in CONTRIBUTING.md; no `any` without a comment justifying it.

React Router v6 handles client-side navigation between the tagging tool, blog, collections, exercises, and (in Phase 3) the AI tutoring interface. Each major surface is a top-level route; nested routes handle sub-views within a surface.

---

## Consequences

**Positive**

- No SSR friction with Verovio. The WASM module loads once per session in the browser; there is no server rendering step to suppress or work around. Ghost construction, geometry queries, and playback synchronisation all run in the environment they were designed for.
- Consistent with existing conventions. CONTRIBUTING.md's component, hooks, TypeScript, and overlay architecture guidance already describes React. Making the framework explicit removes ambiguity without changing any established pattern.
- Simple deployment topology. The Vite build produces a static bundle (HTML, JS, CSS) that can be served from a CDN, from the same Fly.io/Railway container as the FastAPI backend, or from Supabase Storage. No Node.js runtime is required in production.
- Full ecosystem compatibility. TipTap (the preferred block editor) is React-native. Cytoscape.js has maintained React bindings. Verovio WASM integration examples in the community are predominantly React-based.
- Clean separation from the backend. The frontend build is an independent artefact. FastAPI serves `/api/v1/...`; the frontend build is deployed separately and talks to it over HTTPS. No coupling between the Python and JS build steps.

**Negative**

- No built-in SSR/SSG. Public blog posts will not be server-rendered at build time. If SEO on blog content becomes a priority, a lightweight prerendering step (e.g. `vite-plugin-ssr` or a build-time prerender hook) can be added without migrating to Next.js. This is explicitly deferred, not foreclosed.
- No file-based routing conventions. React Router requires explicit route definitions. This is a minor discipline cost compared to Next.js's file-system router, but one that is paid once (in the route configuration file) rather than continuously.

**Neutral**

- The Vite dev server proxies API requests to FastAPI during local development (`/api` → `localhost:8000`). This is standard Vite configuration and does not affect production deployment.
- Component library and styling decisions (CSS modules, Tailwind, a component kit) are not decided here. They are independent of the framework choice and can be addressed as a separate ADR or in CONTRIBUTING.md when the Phase 1 tagging tool UI is being built.

---

## Alternatives considered

**Next.js.** Rejected. The App Router's React Server Components model is a poor fit for a predominantly WASM-and-scroll application. Every Verovio component would require an `ssr: false` dynamic import; the scrollytelling blog layout is client-side scroll logic regardless of the rendering strategy; and the FastAPI backend architecture means Next.js's server layer provides no benefit (no database access from the server layer, no BFF). The SEO argument for the blog is acknowledged but does not outweigh the pervasive friction. Revisit if search discoverability of blog content becomes a measurable priority in Phase 2.

**SvelteKit.** Rejected. Svelte is a different component model from the one already documented in CONTRIBUTING.md. Adopting it would require revising existing conventions and accepting a smaller ecosystem for this application's specific library dependencies. No technical advantage specific to this project's requirements justifies the switch.
