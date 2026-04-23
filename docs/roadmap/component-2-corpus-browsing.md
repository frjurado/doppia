# Phase 1 — Component 2: Corpus Browsing — Implementation Plan

This document translates Component 2 of `docs/roadmap/phase-1.md` into a concrete, sequenced set of implementation tasks. It assumes Component 1 (`docs/roadmap/component-1-mei-corpus-ingestion.md`) has passed its hard gates: the Mozart piano sonatas ingest runs end-to-end in staging, `composer`/`corpus`/`work`/`movement` rows exist in PostgreSQL, and normalised MEI files are readable from object storage.

Component 2 has two deliverables of unequal visibility:

1. **Incipit generation pipeline** — a backend Celery task that runs server-side Verovio (Python bindings) to render the first four bars of each movement as a static SVG and stores it in object storage. This task is triggered by Component 1's ingestion pipeline the moment a movement is accepted; it is Component 2's job to implement the handler.

2. **Corpus browser UI** — the first real frontend work: a four-column Composer → Corpus → Work → Movement selector that displays incipit previews and opens a movement for viewing or tagging. This is also the natural moment to establish the design system foundation (CSS tokens, base styles, font loading, primitive components) so that Components 3, 5, and 8 inherit a coherent starting point.

---

## Addressing the Verovio roadmap loop

The roadmap specifies that incipits are "generated at upload time," but Component 1's implementation plan explicitly deferred incipit generation to Component 2, with the note that "the ingestion pipeline emits a Celery event on successful movement ingest that Component 2 subscribes to." This phrasing describes a straightforward extension to the ingestion service, not a circular dependency.

**The loop resolves as follows:**

- Component 1's `ingest_corpus` service already runs the validation, normalization, and database writes. At the end of a successful movement ingest it currently enqueues the `ingest_analysis` task (Step 8 of the Component 1 plan). Component 2 adds a second `.delay()` call at the same point: `generate_incipit.delay(movement_id=movement.id)`. No restructuring of Component 1 is required — it is a single-line addition to `backend/services/ingestion.py`.

- **Server-side Verovio (Python bindings) is not client-side Verovio (WASM).** The Python `verovio` package is pinned in `backend/requirements.txt` — it was required for the corpus-preparation script (`scripts/prepare_dcml_corpus.py`, Step 6 of Component 1). Component 2's Celery task uses those same bindings to render SVGs server-side. The browser receives a signed URL and renders a static `<img>`. No Verovio WASM is loaded in the browser for the corpus browser. **The pin must be `verovio==6.1.0`** (or the current release per ADR-013); the originally committed `4.3.1` pin must not be used — see the spike results in `docs/architecture/mei-ingest-normalization.md` for why.

- Client-side Verovio WASM is Component 3's responsibility. The incipit pipeline and the interactive score viewer are technically independent and have no shared code path.

- **One spike is required early in Component 2 implementation** (Step 1 below): verify that the Python bindings' measure-range selection option works correctly for bars 0–4 on the Mozart corpus. This spike will also produce the documented evidence that Component 3 needs before building the fragment rendering feature (see `phase-1.md` Component 3 §"Fragment Rendering"). Running the spike here, at the simplest possible selection case, is lower risk than waiting for Component 3, and benefits both components.

---

## Addressing the design system

Component 2 is the first page rendered in the browser. Rather than starting with ad-hoc styles that later need harmonising, this plan includes an explicit design system foundation step before any UI components are built.

The foundation establishes:

- CSS custom properties mapping every token defined in `docs/mockups/opus_urtext/DESIGN.md` to a named variable.
- Google Fonts loading (Newsreader, Public Sans) in `index.html`.
- A minimal global reset enforcing the non-negotiable rules: `border-radius: 0`, Urtext Cream background, no pure black, `box-sizing: border-box`.
- Three primitive components (`Surface`, `TypeDisplay`, `TypeLabel`) that encode the tonal-layering and typography rules so no downstream component needs to hard-code token values.

These primitives are not a component library — they are the minimum shared vocabulary that prevents style drift across the five remaining frontend components in Phase 1. They should be simple enough to read and understand in under five minutes.

---

## Relevant ADRs and architecture docs

- `ADR-002` — object-key convention; incipit key follows the same pattern.
- `ADR-008` — fragment preview generation; incipit generation uses the same server-side Verovio approach. The incipit key structure mirrors the fragment preview key structure but is per-movement, not per-fragment.
- `ADR-010` — React 18 + Vite + TypeScript; confirmed no SSR.
- `docs/mockups/opus_urtext/DESIGN.md` — authoritative design system; all component styles derive from this document.
- `docs/architecture/mei-ingest-normalization.md` — Verovio spike results go here.
- `phase-1.md` Component 3 §"Fragment Rendering" — the Verovio `select` spike initiated here unblocks that section.

---

## Schema change

Component 2 adds two nullable columns to the `movement` table via a new Alembic migration:

```sql
ALTER TABLE movement ADD COLUMN incipit_object_key TEXT;
ALTER TABLE movement ADD COLUMN incipit_generated_at TIMESTAMPTZ;
```

`incipit_object_key` follows the key convention: `{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/incipit.svg`.

`incipit_generated_at` allows the browse API to distinguish "never generated" (null) from "generated" without hitting object storage. It also supports a future admin endpoint that re-queues incipit generation for movements where incipit generation has never completed.

The ORM model (`backend/models/music.py`) gains matching optional columns on the `Movement` class.

---

## Step 1 — Verovio Python bindings spike

**Before any Celery task code is written**, run a manual spike using the Python bindings against a real Mozart movement MEI file from local MinIO.

The spike should answer:

1. Can Verovio's `select` rendering option (or equivalent) restrict output to a bar range (measures `@n 0`–`4`) reliably, without rendering the full score first?
2. Does the output SVG have reasonable dimensions for an incipit thumbnail at a `scale` of 30–40?
3. Are there any issues with pickup bars (measure `@n="0"`) in the rendering output?
4. Is the output byte-for-byte stable across repeated calls with identical inputs (required for cache coherence)?

The spike is a short Python script, not a committed service. Run it locally, document the answers, and write the findings into `docs/architecture/mei-ingest-normalization.md` under a new section "§ Verovio bar-range selection: observed behaviour." These findings directly inform both the incipit task (Step 3 below) and Component 3's fragment rendering implementation.

**Fallback if `select` is unreliable for the pickup-bar edge case:** render the full first system by setting `breaks: "none"` and a wide `pageWidth`, then trim the SVG output to a fixed viewBox covering the first N bars. This is safe for incipits because bars 0–4 are always at the beginning of the score; mid-score trimming (needed for fragment rendering) is a separate, harder problem that Component 3 must solve.

Document whichever approach is adopted and why.

---

## Step 2 — Object storage extension

Add one new method to `backend/services/object_storage.py`:

```python
async def put_svg(key: str, content: str) -> None:
    """Store an SVG string in object storage. Content-Type: image/svg+xml."""
```

This is a thin wrapper around the existing `aioboto3` client, identical in shape to `put_mei`. SVG is stored as UTF-8 text with `ContentType: image/svg+xml`.

Incipit key format:

```python
def incipit_key(
    composer_slug: str,
    corpus_slug: str,
    work_slug: str,
    movement_slug: str,
) -> str:
    return f"{composer_slug}/{corpus_slug}/{work_slug}/{movement_slug}/incipit.svg"
```

Add this as a module-level helper alongside the `movement_mei_key` helper already implied by Component 1's object storage client.

**Verification.** Extend the existing object storage integration test (Component 1, Step 2) with a round-trip for `put_svg` / `signed_url` against the MinIO fixture bucket.

---

## Step 3 — Incipit generation Celery task

Create `backend/services/tasks/generate_incipit.py`:

```python
@celery_app.task(name="generate_incipit", bind=True, max_retries=3)
def generate_incipit(self, movement_id: str) -> None:
    """
    Render the first four bars of a movement as an SVG incipit and store
    it in object storage. Updates movement.incipit_object_key on success.

    Triggered immediately after a successful movement ingest.
    """
```

Implementation outline:

1. Query `movement` by `movement_id` to obtain `mei_object_key`, `composer_slug`, `corpus_slug`, `work_slug`, `movement_slug`. Raise `Ignore` (Celery's "discard silently") if the movement does not exist — this should not happen, but guards against race conditions in test teardown.
2. Fetch the normalised MEI bytes from object storage via `get_mei(movement.mei_object_key)`.
3. Instantiate the Verovio toolkit and apply the options established by the Step 1 spike (Finding 5 in `docs/architecture/mei-ingest-normalization.md`). Use the smart-break, narrow-page approach — it is simpler than `select`-based clipping for incipits, produces correct results including pickup bars, and does not depend on `measureRange` addressing:
   ```python
   tk = verovio.toolkit()
   tk.setOptions({
       "pageWidth": 800,
       "pageHeight": 800,
       "adjustPageHeight": True,
       "breaks": "smart",
       "scale": 35,
   })
   tk.loadData(mei_bytes.decode("utf-8"))
   svg = tk.renderToSVG(1)   # page 1 = first system = incipit
   ```
   Note: `select` with `measureRange` is now functional in Verovio 6.1.0 (see ADR-013) and is the recommended approach for **Component 3** fragment rendering. For incipits, the smart-break page-1 strategy remains preferable because it includes pickup bars naturally and requires no `@n` addressing logic.
4. Compute the incipit key and store via `put_svg`.
5. Update `movement.incipit_object_key` and `movement.incipit_generated_at` in a database write.
6. On `verovio` rendering failure: log the error and re-raise so Celery retries (up to `max_retries`). On final failure, leave `incipit_object_key` null — the browse API handles this gracefully.

**Re-ingest behaviour.** If `generate_incipit` is re-queued because the movement's MEI file was corrected (re-upload via the Component 1 upload endpoint), it overwrites the existing SVG at the same key and updates `incipit_generated_at`. This is the correct behaviour — incipits are derived from the normalised MEI and must stay in sync.

**Verification.** Integration test in `backend/tests/integration/test_generate_incipit.py`: given a movement row and its MEI in MinIO (reuse the Component 1 fixture), run the task, assert `movement.incipit_object_key` is set, assert the stored object is valid UTF-8 XML starting with `<svg`.

---

## Step 4 — Wire the incipit task into the ingestion pipeline

In `backend/services/ingestion.py`, after the database transaction commits and the `ingest_analysis` task is dispatched for each accepted movement, add:

```python
from backend.services.tasks.generate_incipit import generate_incipit

# Inside the per-movement loop, after the DB commit:
generate_incipit.delay(movement_id=str(movement.id))
```

This is the only change to Component 1 code. The task is fire-and-forget; its success or failure does not affect the ingestion report returned to the caller.

**Backfill.** For movements already ingested before this step exists (e.g., the Mozart piano sonatas ingested during Component 1 staging tests), run a one-off backfill:

```bash
python scripts/backfill_incipits.py
```

Create this script alongside the existing seed scripts. It queries all movements where `incipit_object_key IS NULL` and enqueues `generate_incipit` for each. This is a one-time operation and not part of the normal pipeline.

**Staging data top-up.** Once the incipit task is verified working, use the corpus-preparation script to ingest 5–6 complete works (roughly 12–15 movements) from the Mozart piano sonatas into staging. This serves two purposes: it confirms the incipit pipeline holds up across a range of key signatures, meters, and movement lengths, and it gives the corpus browser enough data to evaluate meaningfully — a single work in the works column is indistinguishable from a broken state. The full corpus population is Component 9's responsibility; this subset is the minimum needed to make the browser feel real during development. The existing fixture movements (K. 331/1–2, K. 283/2) count toward the total.

---

## Step 5 — Browse API endpoints

Create `backend/api/routes/browse.py` with four endpoints covering the Composer → Corpus → Work → Movement hierarchy. Register the router in `backend/api/router.py` under the existing `/api/v1` prefix.

All four endpoints require `require_role("editor")` in Phase 1. In Phase 2, the role requirement will be relaxed to allow public access once the public reader role is introduced. Implement role enforcement as a dependency (the existing pattern), not as inline logic, so the change is a one-line edit when the time comes.

### 5.1 — List composers

```
GET /api/v1/composers
```

Returns all composers in the database, ordered alphabetically by `sort_name`. Phase 1 will have very few (one or two), so no cursor pagination is strictly necessary, but apply the project's cursor convention anyway to establish the pattern.

Response shape per item:

```json
{
  "id": "uuid",
  "slug": "mozart",
  "name": "Wolfgang Amadeus Mozart",
  "sort_name": "Mozart, Wolfgang Amadeus",
  "birth_year": 1756,
  "death_year": 1791
}
```

### 5.2 — List corpora for a composer

```
GET /api/v1/composers/{composer_slug}/corpora
```

Returns all corpora for the given composer. 404 if the composer slug is not found.

Response shape per item:

```json
{
  "id": "uuid",
  "slug": "piano-sonatas",
  "title": "Piano Sonatas",
  "source_repository": "DCML",
  "licence": "CC-BY-SA-4.0",
  "work_count": 18
}
```

`work_count` is a scalar aggregate (`COUNT(work.id)`) computed in the same query via a subquery or SQLAlchemy `func.count()` — not a separate query.

### 5.3 — List works for a corpus

```
GET /api/v1/composers/{composer_slug}/corpora/{corpus_slug}/works
```

Returns all works in the corpus, ordered by `catalogue_number` (lexicographic, since catalogue numbers are free-form strings). 404 if either slug is not found.

Response shape per item:

```json
{
  "id": "uuid",
  "slug": "k331",
  "title": "Piano Sonata No. 11 in A major",
  "catalogue_number": "K. 331",
  "year_composed": "1783",
  "movement_count": 3
}
```

### 5.4 — List movements for a work

```
GET /api/v1/works/{work_id}/movements
```

Returns all movements for a work, ordered by `movement_number`. Includes the resolved incipit URL.

Response shape per item:

```json
{
  "id": "uuid",
  "slug": "movement-1",
  "movement_number": 1,
  "title": "Tema con Variazioni",
  "tempo_marking": "Andante grazioso",
  "key_signature": "A major",
  "meter": "6/8",
  "duration_bars": 96,
  "incipit_url": "https://...signed-url.../incipit.svg",
  "incipit_ready": true
}
```

`incipit_url` is a signed URL generated at request time from `movement.incipit_object_key` using the existing `signed_url()` helper. If `incipit_object_key` is null (not yet generated), `incipit_url` is `null` and `incipit_ready` is `false`. The frontend renders a placeholder in this case. Signed URLs expire after 15 minutes — consistent with the MEI signed URL policy in ADR-002.

**Service layer.** All four endpoints delegate to `backend/services/browse.py`. No database query logic lives in the route handler. The service functions are `async def` and return typed Pydantic response models.

**Pydantic models.** Create `backend/models/browse.py` with `ComposerResponse`, `CorpusResponse`, `WorkResponse`, `MovementResponse`, and their list-envelope counterparts. These are read-only response models only; no input validation is needed.

**Verification.** Unit tests in `backend/tests/unit/test_browse_service.py` mocking the database session. Integration tests in `backend/tests/integration/test_browse_api.py` against the Component 1 staging fixture data (Mozart piano sonatas), asserting correct hierarchy, item counts, and a non-null `incipit_url` after Step 4 has run.

---

## Step 6 — Design system foundation

This step has no component deliverable visible to a user, but it gates every subsequent frontend step. Establish it completely before writing any browsing UI.

### 6.1 — CSS custom properties

Create `frontend/src/styles/tokens.css`. Every named value comes directly from `docs/mockups/opus_urtext/DESIGN.md`. Do not invent new token names; if DESIGN.md uses an adjective ("Primary"), the variable is `--color-primary`.

```css
:root {
  /* Brand colours */
  --color-primary:                   #3f5f77;
  --color-primary-container:         #587891;

  /* Surface hierarchy (tonal layers, no borders) */
  --color-surface:                   #fbf9f0; /* Urtext Cream — base canvas */
  --color-surface-container-lowest:  #ffffff;
  --color-surface-container-low:     #f6f4eb;
  --color-surface-container:         #eeecde;
  --color-surface-container-high:    #eae8df;
  --color-surface-container-highest: #e4e3da;

  /* Text */
  --color-on-background:             #1b1c17; /* never pure black */
  --color-on-surface-variant:        #44483d;
  --color-on-primary:                #ffffff;

  /* Borders and outlines (ghost-only; never 100% opaque) */
  --color-outline:                   #72787d;
  --color-outline-variant:           rgba(114, 120, 125, 0.15);

  /* Typography */
  --font-serif:   'Newsreader', Georgia, 'Times New Roman', serif;
  --font-sans:    'Public Sans', system-ui, -apple-system, sans-serif;

  /* Spacing scale (multiples of 0.25rem) */
  --spacing-1:  0.25rem;
  --spacing-2:  0.5rem;
  --spacing-3:  0.75rem;
  --spacing-4:  1rem;
  --spacing-5:  1.25rem;
  --spacing-6:  1.5rem;
  --spacing-8:  2rem;
  --spacing-10: 2.5rem;
  --spacing-12: 3rem;

  /* Shape — 0px everywhere, non-negotiable */
  --border-radius: 0px;
}
```

### 6.2 — Global base styles

Create `frontend/src/styles/base.css`. Import after tokens.css in `main.tsx`.

```css
@import url('https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;1,6..72,400&family=Public+Sans:wght@400;500;600&display=swap');
@import './tokens.css';

*, *::before, *::after {
  box-sizing: border-box;
  border-radius: var(--border-radius); /* enforce 0px everywhere */
}

html, body, #root {
  height: 100%;
  margin: 0;
  padding: 0;
}

body {
  background-color: var(--color-surface);
  color: var(--color-on-background);
  font-family: var(--font-serif);
  font-size: 1rem;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
}

/* Forbid pure black and pure white as direct values in component CSS.
   Use token variables only. This comment is the enforcement rule;
   ESLint cannot lint CSS, so it lives here as documentation. */
```

### 6.3 — Primitive components

Create three primitive components. These are not styled building blocks for every conceivable UI pattern — they are the minimum required to encode the two most critical rules of the design system so that no downstream component needs to know token names directly.

**`frontend/src/components/ui/Surface.tsx`**

A `<div>` that accepts a `layer` prop mapping to the surface hierarchy. No borders. No shadows except the ambient-shadow case (provided via a `floating` boolean prop for modals only).

```tsx
type SurfaceLayer =
  | 'base'
  | 'container-low'
  | 'container'
  | 'container-high'
  | 'container-highest'
  | 'floating';

interface SurfaceProps {
  layer?: SurfaceLayer;
  floating?: boolean;
  className?: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}
```

The component maps `layer` to the corresponding `--color-surface-*` CSS variable via an inline style. No CSS class is generated per variant — the token system handles it.

**`frontend/src/components/ui/Type.tsx`**

A single component with `variant` and `as` props. Handles all typographic roles from DESIGN.md without a proliferation of separate heading components.

```tsx
type TypeVariant =
  | 'display-lg'   /* 3.5rem Newsreader, used for major section headers */
  | 'display-sm'   /* 2rem Newsreader */
  | 'headline'     /* 1.5rem Newsreader */
  | 'title'        /* 1.25rem Newsreader */
  | 'body-lg'      /* 1rem Newsreader, generous line-height */
  | 'body-sm'      /* 0.875rem Newsreader, for marginalia */
  | 'label-md'     /* 0.875rem Public Sans, uppercase */
  | 'label-sm';    /* 0.75rem Public Sans, uppercase */
```

`label-md` and `label-sm` use `var(--font-sans)`; all others use `var(--font-serif)`. No inline font declarations.

These two primitives are enough to build the entire corpus browser. Additional primitives (e.g. a `Button` component) are added in the components that first need them, not speculatively.

---

## Step 7 — API service layer (frontend)

Create `frontend/src/services/browseApi.ts`.

All API calls go through a thin wrapper that sets the auth header (Supabase JWT from `localStorage` in Phase 1's simple auth setup) and handles error responses consistently.

```ts
// frontend/src/services/api.ts  (shared base — create this file)
export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> { ... }

// frontend/src/services/browseApi.ts
export async function fetchComposers(): Promise<ComposerResponse[]> { ... }
export async function fetchCorpora(composerSlug: string): Promise<CorpusResponse[]> { ... }
export async function fetchWorks(composerSlug: string, corpusSlug: string): Promise<WorkResponse[]> { ... }
export async function fetchMovements(workId: string): Promise<MovementResponse[]> { ... }
```

TypeScript types in `frontend/src/types/browse.ts`, mirroring the Pydantic response models from Step 5.

**Error handling.** `apiFetch` throws a typed `ApiError` class on non-2xx responses. Components catch this and display a tonal-layered error surface, not a browser alert. Network errors (fetch fails entirely) are re-thrown as `ApiError` with `code: "NETWORK_ERROR"`.

**Auth.** In Phase 1, the Supabase client is initialised once in `frontend/src/services/auth.ts` and the JWT is read from the Supabase session object. `apiFetch` calls `getSession()` before each request. This is not ideal for performance on slow connections but is correct for an internal tool with a small user count.

---

## Step 8 — CorpusBrowser page

The browser is a single page at route `/` (as declared in `App.tsx`). It is a four-column layout on desktop that collapses to a stacked accordion on mobile.

### File layout

```
frontend/src/routes/
  CorpusBrowser.tsx          (page component, manages selection state and URL sync)

frontend/src/components/browse/
  BrowseColumn.tsx           (a single scrollable list column)
  BrowseItem.tsx             (a single list item, handles selected/hover states)
  MovementCard.tsx           (a movement list item — includes incipit image)
  IncipitImage.tsx           (incipit <img> with loading and null-state handling)
  BrowseAccordion.tsx        (mobile accordion wrapper)
```

### 8.1 — Selection state and URL sync

`CorpusBrowser` owns four pieces of state: selected composer slug, selected corpus slug, selected work ID, selected movement ID. These are synchronised to URL search params so that refreshing the page or sharing a link restores the selection:

```
/?composer=mozart&corpus=piano-sonatas&work=k331&movement=<uuid>
```

`useSearchParams` from React Router v6 is the mechanism. The state initialises from URL params on mount, and every selection update writes back to the URL via `setSearchParams`. No navigation occurs — the URL is updated in-place using the replace strategy.

### 8.2 — Column layout

The four columns are rendered side-by-side at all viewport widths above 768px. Each column is a fixed-width panel (not flex-grow equal) because the rightmost column (movements with incipits) needs more horizontal space than the others.

Suggested widths (adjust based on visual testing):
- Composers column: `220px`
- Corpora column: `220px`
- Works column: `280px`
- Movements column: `1fr` (fills remaining space)

The columns are rendered inside a CSS grid container: `grid-template-columns: 220px 220px 280px 1fr`.

**No divider lines.** Columns are separated by a shift in background `layer` prop. The column panels use `layer="container-low"` against the page's `layer="base"` background. The selected item within a column uses `layer="container-high"`.

**Each column** renders a `BrowseColumn` that:
- Accepts `items`, `selectedId`, `onSelect`, `isLoading`, and `isEmpty` props.
- Shows a loading skeleton (three placeholder `BrowseItem` components at 40% opacity) while the fetch is in flight.
- Shows an empty-state label ("No works found") in `label-md` style when the list is empty.
- Scrolls independently (overflow-y: auto) so a long list of works does not push the movements column off-screen.

**`BrowseItem`** is a plain `<button>` with `display: block; width: 100%`. No border. Selected state: background shifts to `var(--color-surface-container-high)`. Hover state: background shifts to `var(--color-surface-container)`. Both transitions are instant (no animation — the design system avoids transitions except where explicitly specified). Text is `body-lg` for primary label and `label-sm` (uppercase, `on-surface-variant`) for secondary metadata (e.g. catalogue number, year).

### 8.3 — MovementCard and incipit

`MovementCard` is a `BrowseItem` variant that also renders the incipit image below the text labels.

```tsx
<BrowseItem ...>
  <div className={styles.movementMeta}>
    <Type variant="body-lg">{title ?? `Movement ${movement_number}`}</Type>
    <Type variant="label-sm">{key_signature} · {meter}</Type>
  </div>
  <IncipitImage url={incipit_url} ready={incipit_ready} />
</BrowseItem>
```

`IncipitImage` renders:
- An `<img>` with `src={url}` when `incipit_ready` is true and `url` is non-null.
- A placeholder Surface (`layer="container"`) with a subtle `label-sm` text "Rendering…" when `incipit_ready` is false. This case is transient and only visible if the Celery task has not yet completed for a recently uploaded movement.
- The image is given a fixed height (`120px`) and `width: 100%`. It uses `object-fit: contain` and a `var(--color-surface-container-low)` background so SVG incipits with transparent backgrounds render on a consistent tone.

Clicking a `MovementCard` (or any `BrowseItem`) both updates the selection state and — for movements — enables a "Open score" action. In Phase 1, "Open score" navigates to `/tag/:movementId`. This route is not yet built (Component 3), so the navigation exists but the destination is a stub page that displays the movement's title and a "Score viewer coming soon" message.

### 8.4 — Open score CTA

When a movement is selected, a fixed-position footer appears at the bottom of the browser with:

- A primary button: "Open for tagging" → navigates to `/tag/:movementId`
- Movement title and catalogue context in `label-md`

The footer uses a `layer="container-highest"` Surface with the glassmorphism rule from DESIGN.md (`backdrop-filter: blur(12px)`; `background: rgba(251, 249, 240, 0.80)`). This is the only instance of glassmorphism in the corpus browser.

---

## Step 9 — Mobile accordion layout

At viewport widths below 768px, the four-column layout is replaced by a stacked accordion. Each level is a collapsible section. Selecting an item in one level auto-expands the next level.

`BrowseAccordion` wraps a set of `AccordionSection` components. It is not a generic accordion library — it is a small (~80 lines), purpose-built component that understands the four-level hierarchy:

```tsx
<BrowseAccordion>
  <AccordionSection title="Composer" value={selectedComposer?.name ?? 'Select a composer'} isOpen={...}>
    {/* composer list */}
  </AccordionSection>
  <AccordionSection title="Corpus" value={...} isOpen={...} disabled={!selectedComposer}>
    {/* corpus list */}
  </AccordionSection>
  ...
</BrowseAccordion>
```

A section opens when its parent level has a selection. Tapping the section header collapses it (allowing the user to change a higher-level selection). Each section's content is the same `BrowseColumn` children used in the desktop layout — the accordion is a layout wrapper, not a data source.

The mobile breakpoint is applied with a CSS media query in the page component: below 768px, the grid is replaced with the accordion via a conditional render. No JavaScript breakpoint detection — CSS handles layout, React handles which component is mounted via `window.innerWidth` on mount plus a `resize` listener. (React's `useMediaQuery` pattern, trivially implementable without a library.)

---

## Step 10 — Stub route for score viewer

Create `frontend/src/routes/ScoreViewerStub.tsx`. This is a placeholder page at `/tag/:movementId` that renders the movement title (fetched from the browse API using the movement ID from the URL param) and a message indicating the score viewer is not yet available. This prevents a broken navigation experience when a movement is opened from the corpus browser before Component 3 is built.

The stub shares the design system foundation established in Step 6. It is replaced entirely by Component 3's score viewer; no code from the stub carries forward.

---

## Step 11 — Verification

**Backend:**

- Unit tests: browse service functions with mocked DB sessions; all four endpoints return correct shapes; 404 on unknown slugs; `incipit_url` is null when `incipit_object_key` is null.
- Integration tests: browser endpoints against the Mozart staging fixture; `incipit_url` resolves to a readable object in MinIO after `generate_incipit` runs.
- Task test: `generate_incipit` task integration test (Step 3).
- Re-ingest test: re-uploading a movement (idempotent re-ingest from Component 1) re-queues `generate_incipit` and overwrites the existing incipit SVG.

**Frontend:**

- Manual visual review on Chrome and Firefox: design tokens render correctly, fonts load, 0px border-radius is enforced everywhere.
- Column layout: selecting a composer fetches and displays corpora; selecting a corpus fetches and displays works; selecting a work fetches and displays movements with incipits.
- URL sync: refreshing the page with `?composer=mozart&corpus=piano-sonatas&work=k331` restores the three-level selection.
- Mobile: at 375px viewport, accordion renders and functions correctly.
- Null incipit: a movement with `incipit_ready: false` displays the placeholder without a layout shift when the incipit later becomes available (the image slot has a fixed height).

No end-to-end browser tests in Phase 1 (deferred to Phase 2 per `phase-1.md` §"Testing strategy").

---

## Sequencing

```
Day 1: Verovio spike (Step 1) — document findings before writing any task code
Day 2: Schema migration + ORM update (Step 2 of schema section above) + object storage extension (Step 2)
Day 3: Incipit Celery task (Step 3) + wire into ingestion pipeline (Step 4) + backfill script
Day 4: Browse API endpoints + Pydantic models (Step 5)
Day 5: Design system foundation — tokens, base styles, primitive components (Step 6)
Day 6: API service layer (Step 7) + types
Day 7: CorpusBrowser page — desktop layout, column components, MovementCard, incipit display (Step 8)
Day 8: Mobile accordion (Step 9) + ScoreViewerStub (Step 10)
Day 9: Verification pass — backend tests, manual frontend review, staging smoke test (Step 11)
```

Steps 1–4 (backend pipeline) are fully independent of Steps 5–10 (frontend). If two developers are available, the split is clean: one takes the backend pipeline, one takes the frontend design system and browse UI. Both converge on Day 9.

---

## Hard gates before Component 3 begins

1. The Verovio Python bindings spike (Step 1) is documented in `docs/architecture/mei-ingest-normalization.md`. This document is a prerequisite for Component 3's fragment rendering implementation.
2. The four browse API endpoints pass integration tests against the Mozart staging fixture.
3. The corpus browser UI renders correctly in staging with real data: incipit images load, selection state persists in the URL, mobile accordion works.
4. The design system tokens file and primitive components are in place so Component 3's score viewer can inherit the type and surface system without redefining it.
