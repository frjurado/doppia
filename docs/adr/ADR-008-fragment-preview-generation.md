# ADR-008 — Fragment Preview Generation

**Status:** Accepted  
**Date:** 2026-04-13

---

## Context

The fragment list view displays a browsable collection of tagged fragments, each with a small rendered preview of its bars. These previews allow annotators and users to identify fragments visually without opening each one individually.

Generating these previews requires Verovio to render a subset of bars from an MEI file. Two approaches are viable:

**Client-side rendering at browse time.** Each fragment card triggers a Verovio WASM render in the browser when the list is loaded. Simple to implement: the same rendering infrastructure used in the score viewer is reused with no additional backend work.

**Server-side static generation at submission time.** When a fragment record transitions to `submitted` status, a background task renders the fragment's bar range using the Verovio Python bindings, stores the resulting SVG in R2 object storage, and records the preview URL. The list endpoint returns the preview URL directly; no Verovio computation occurs at browse time.

The choice turns on the performance characteristics of each approach at realistic list sizes.

Verovio WASM initialisation is not negligible — loading the WASM binary and rendering a passage takes hundreds of milliseconds per fragment. A list view displaying 20 fragment previews simultaneously would trigger 20 concurrent renders, producing a slow, janky load even on capable hardware. Pagination helps but does not eliminate the problem: even a page of 10 fragments renders visibly slowly if all previews load at once.

Server-side generation shifts the rendering cost to submission time (a one-time background task per fragment) and reduces browse-time cost to serving a static image URL — equivalent to any other image on the page.

The Celery task queue is already required from Phase 1 for the music21 preprocessing pipeline (ADR-004). The Verovio Python bindings are already required for server-side validation and incipit generation (Component 2 of the Phase 1 roadmap). No new infrastructure is introduced.

---

## Decision

Generate fragment previews **server-side, statically, at submission time** via a Celery task using the Verovio Python bindings. Store the rendered output in R2 object storage. Return the preview URL from the list endpoint.

**Trigger:** a Celery task is enqueued when a fragment record transitions to `submitted` status. If the fragment is subsequently revised and resubmitted, the task runs again and overwrites the previous preview.

**Output format:** SVG. Verovio produces clean, scalable SVG output; storing SVG avoids resolution concerns and keeps file sizes small for typical fragment lengths (2–8 bars).

**Storage key pattern:** `{corpus_slug}/{work_id}/{movement_id}/previews/{fragment_id}.svg`, following the same key convention as MEI files (ADR-002).

**Fallback:** if the preview has not yet been generated when the list is requested (e.g. the Celery task is still queued), the API returns `preview_url: null`. The frontend renders a placeholder. This case is transient and only affects the annotator's own recently submitted fragments.

---

## Consequences

**Positive**

- Browse performance is independent of fragment count. Loading a list of 50 fragments costs 50 URL fetches, not 50 Verovio renders.
- No Celery or Verovio dependency is added: both are already present for ADR-004 and corpus ingestion respectively.
- Previews are stored in R2 alongside MEI files under a predictable key structure. They are cacheable by any CDN layer and do not require a live application process to serve.
- Server-side rendering is deterministic: previews are generated once and are stable until the fragment or its MEI source changes.

**Negative**

- Previews must be invalidated and regenerated when a fragment's `bar_start`/`bar_end` is revised, or when the underlying MEI file is corrected. The correction workflow (Component 1 of the Phase 1 roadmap) must enqueue a preview regeneration task as part of its process.
- A fragment in `submitted` status has a brief window (while the Celery task runs) where its preview is unavailable. The `preview_url: null` fallback handles this gracefully but requires frontend handling.
- Server-side Verovio rendering may not produce pixel-identical output to client-side WASM rendering if the two builds are at different versions. Pin Verovio versions for both client and server and update them together.

**Neutral**

- `draft` fragments do not get previews generated — only `submitted` and above. Annotators viewing their own drafts in the tagging tool see the full score rendering, not a preview thumbnail.
- Preview generation uses the same `select` option (measure range) that client-side rendering would use. Any MEI edge cases affecting measure selection (repeats, pickup bars) affect both approaches equally.

---

## Alternatives considered

**Client-side rendering at browse time.** Rejected on performance grounds. Verovio WASM initialisation and rendering is too slow to run concurrently for a list of fragments. The user experience degrades proportionally with list size, making pagination a workaround rather than a solution. The approach also couples browse performance to the client's hardware, which is inappropriate for a tool that needs to work reliably for annotators.

**Server-side rendering on demand (not cached).** Rejected. Rendering on every list request would make the list endpoint slow and CPU-intensive under any concurrent usage. Caching the result is equivalent to the static generation approach but without the clean trigger point (submission) and without R2 as the durable store.
