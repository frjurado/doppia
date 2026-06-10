# ADR-024 — Fragment Rendering Context Contract

**Status:** Accepted  
**Date:** 2026-06-09

---

## Context

The fragment detail view (Component 8) renders a single fragment in isolation, constrained by default to its `bar_start`/`bar_end` range — the whole containing measures and nothing more. Several future features will need to render a fragment *with surrounding context* rather than on its own:

- **Blog embeds** (Phase 2 scrollytelling) may want a fragment shown with a bar or two of lead-in so the passage reads in flow.
- **MCQ exercises** (Phase 3) may present a cadence with the bars leading up to it but withhold the resolution, or show a fragment with asymmetric framing.
- **Orientation** — showing the parent container fragment a sub-fragment belongs to (e.g. rendering the theme that a cadence closes), so a reader sees where the fragment sits.

The Phase 1 roadmap (`docs/roadmap/phase-1.md` § Component 8) anticipated this with a forward-compatibility note: the detail API should accept an optional `context_bars` integer (default `0`) "specifying how many additional bars to render on each side of the fragment's range," with Phase 1 leaving it at `0` and the implementation ignoring any non-zero value until a consuming feature is built. The instinct — publish the contract now so consumers add a value rather than forcing a breaking parameter change later — is correct. The *shape* is not.

A single symmetric integer cannot express the contexts that are actually wanted:

- **Asymmetry.** "Two bars before, none after" (lead-in without giving away the resolution) is a common MCQ and blog need. `context_bars` forces the same count on both sides.
- **Fragment-relative context.** "Render the enclosing container fragment" and "render from after the previous same-domain fragment up to this one" are not expressible as a bar count at all — they are defined relative to other fragments, not as a fixed number of measures.

Freezing the API at `context_bars: int` now would mean breaking a published contract later, exactly the outcome the forward-compatibility note set out to avoid.

The data the richer contexts need already exists or is cheap to derive, so no schema change is required to *design* the contract:

- The enclosing container fragment is `parent_fragment_id`, already on the `fragment` table (see `fragment-schema.md`).
- "Previous same-domain fragment" needs the concept's domain (derivable from the knowledge graph) plus the ordering of same-domain fragments on the movement by `mc_start` (already stored).

---

## Decision

Replace the bare `context_bars` integer with a **structured, discriminated `context` parameter** on the fragment detail read, carrying a `mode` discriminator. The contract is published in full in Phase 1; only the default mode is implemented.

```
GET /api/v1/fragments/{id}?context.mode=none                          (default)
                          ?context.mode=bars&before=N&after=M
                          ?context.mode=enclosing_fragment
                          ?context.mode=previous_same_domain
```

| `mode` | Meaning | Phase 1 behaviour |
|---|---|---|
| `none` (default) | Containing measures only — the fragment's `bar_start`/`bar_end` range and nothing more. | **Implemented.** Identical to the current default render. |
| `bars` | Render `before` additional bars before the range and `after` additional bars after it (each ≥ 0, independently). Symmetric context is `before == after`; the old `context_bars: N` is `before=N&after=N`. | Validated, then **ignored** (renders as `none`). |
| `enclosing_fragment` | Render the parent container fragment (`parent_fragment_id`) for orientation, with the target fragment highlighted within it. | Validated, then **ignored**. |
| `previous_same_domain` | Render from after the previous same-domain fragment on the movement (by `mc_start`) up to and including the target fragment. | Validated, then **ignored**. |

**Phase 1 implements only `mode=none`.** The other modes are accepted and validated by the API contract (an unknown mode or a malformed `bars` payload is a request error) but otherwise have no effect — the detail read returns the containing-measures-only render regardless. Each mode's implementation lands with its consuming feature (blog embeds, MCQ exercises, orientation views), adding behaviour behind an already-published mode value rather than changing the parameter shape.

**No schema change.** The contract is expressible against existing columns (`parent_fragment_id`, `mc_start`) and the existing graph (concept domain). Designing and publishing the contract touches only the API surface; only the eventual mode implementations touch the read path.

---

## Consequences

**Positive**

- Future context features add a `mode` value, not a breaking parameter change. The published contract is stable from Phase 1.
- Asymmetric framing (`bars` with independent `before`/`after`) and fragment-relative context (`enclosing_fragment`, `previous_same_domain`) are all expressible — the cases a symmetric integer could not represent.
- No data-model change is required now or when the modes are implemented; the contract maps onto columns and graph structure that already exist.
- The default (`mode=none`) is exactly the prior behaviour, so nothing about the Phase 1 detail view changes in practice.

**Negative**

- The contract is larger than a single integer, so the request-validation layer must reject unknown modes and malformed `bars` payloads from day one even though only `none` does anything. This is a small, one-time cost and is the price of publishing a stable contract early.
- A client could pass `mode=enclosing_fragment` in Phase 1 and receive a containing-measures-only render with no error. The "accepted but ignored until implemented" behaviour must be documented so this is understood as intended, not a bug. (This is the same trade-off the original `context_bars` note made — non-default values ignored — now applied per mode.)

**Neutral**

- The `bars` mode subsumes the original `context_bars` semantics: `context_bars=N` is `mode=bars&before=N&after=N`. No expressiveness is lost relative to the superseded note.
- Mode implementations inherit the Verovio `select` measure-range edge cases (repeats, first/second endings, mid-system starts) documented for the base render in `docs/architecture/mei-ingest-normalization.md`; extending the rendered range does not introduce a new class of edge case, only a wider range subject to the same ones.
- This ADR supersedes the `context_bars` integer described in `phase-1.md` § Component 8; that note is updated to reference this decision.

---

## Alternatives considered

**Keep `context_bars: int` (the superseded note).** Rejected. A single symmetric integer cannot express asymmetric framing or fragment-relative context, both of which are concrete near-term needs. Keeping it would guarantee a breaking contract change when those features arrive — the exact outcome the forward-compatibility note existed to prevent.

**Two integers (`context_before` / `context_after`) without a mode discriminator.** Rejected. This solves asymmetry but still cannot express `enclosing_fragment` or `previous_same_domain`, which are not bar counts. A discriminated `mode` accommodates both the bar-count case and the fragment-relative cases under one stable contract.

**Defer the contract entirely and add a parameter when the first consumer is built.** Rejected on the same forward-compatibility grounds as the original note: the detail API is a published shape consumed by the score-rendering frontend, and adding a context parameter later — versus publishing the (mostly inert) contract now — is the avoidable breaking change. Publishing now costs only request validation.

**Implement one or more non-default modes in Phase 1.** Rejected as out of scope. No Phase 1 feature consumes surrounding context; building mode implementations before a consumer exists is speculative work. The modes land with their consuming features.
