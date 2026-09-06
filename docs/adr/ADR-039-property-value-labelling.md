# ADR-039 — Property Value Labelling (`short_name` / `description` on `PropertyValue`)

**Status:** Accepted
**Date:** 2026-09-05
**See also:** `docs/architecture/knowledge-graph-design-reference.md` (§ 6 Layer 3 — PropertyValue node fields), `docs/adr/ADR-023-property-and-value-ordering.md` (`order` / `group` — display *position*, where this ADR governs display *text*), `docs/adr/ADR-006-internationalisation-strategy.md` (translation overlays carry `name` only), `docs/reports/component-11-reports/component-11-triage.md` (items 8 and 14 — the grounded complaint), `backend/seed/domains/cadences.yaml` (first consumer)

---

## Context

A `PropertyValue` carried exactly one label: `name`. It is what the tagging
form prints, and it was therefore doing three incompatible jobs at once.

The cadences domain shows all three colliding. `Stage2Components` offered
"Pre-dominant on Scale Degree 4 (IV, ii, ii6, …)" — a string that is
simultaneously:

1. the **absolute name** of the value, readable on its own;
2. the **form label**, printed directly beneath the heading "Stage 2
   Components", where "Pre-dominant on …" is redundant with the heading; and
3. a **gloss** ("IV, ii, ii6, …"), which is help text wearing a label's
   clothes.

Job 3 landed in the name because there was nowhere else for it to go: the ⓘ
popover is per *schema*, not per value. Job 2 conflicts with job 1 directly —
shortening the name for the form deletes the form-independent reading that
exports and Component 15's exercise distractors need, and a short label cannot
be expanded back into a long one.

A neighbouring symptom had the same root. The per-value ⓘ, where one appeared,
rendered the value's *referenced concept* — but the concepts these values
reference (`AppliedDominant`, `SD4Predominant`, …) live in the unwritten
harmonic-functions domain and are stubs. The reader got a title repeating the
value they had just read, over the body "Stub: defined in the
harmonic-functions domain."

---

## Decision

### 1. Add `short_name` (string, optional) to `PropertyValue`

The same label with its schema heading's context elided — "On Scale Degree 4"
under "Stage 2 Components". Clients render `short_name ?? name`.

`name` remains the **absolute** form and stays canonical. Every surface that
uses `short_name` prints the schema heading beside the value, so the elided
context is always present on screen; every surface that cannot guarantee that
uses `name`.

### 2. Add `description` (string, optional) to `PropertyValue`

Per-value help text — the gloss evicted from `name`. Surfaced by the ⓘ beside
the value.

It lives on the value rather than on a referenced concept because **most values
have no `references:` at all** (`SD3`, `SD5`, `Basic`, `Converging`,
`Independent`, …). A referenced definition could never be the general home for
per-value help; it is available for only a minority of values, by coincidence
of which ones happen to name a concept.

### 3. Add `stub` to the `ReferencedConcept` read model

So a client can tell a real definition from placeholder boilerplate. The ⓘ
resolves in this order:

1. the value's `description`, if set;
2. the referenced concept's `definition`, if the concept is **not** a stub and
   has one;
3. nothing — the ⓘ does not render.

No ⓘ is better than an ⓘ that repeats the label and says the domain is
unwritten.

### 4. Both fields are untranslated for now

ADR-006's translation tables carry `name` only. A non-English locale falls back
to the English short form and gloss — the same fallback the rest of the payload
already uses. Extending the overlays is a separate change, deliberately not
made here.

> **Superseded 2026-09-06 (Component 12 Step 19b).** Both fields are now
> translatable: migration `0015` adds `short_name` and `description` to
> `property_value_translation`, and the overlay reads them.
>
> The fallback is **per field, not per row**. A translation row may localise
> the name and leave the other two null — most values have neither — and null
> means "use the English graph value" rather than "this value has no short
> form". Falling back per row would blank a short name the graph does have, the
> moment any non-English row existed.
>
> `source_hash` now covers all three fields, so editing a short form or a gloss
> marks existing translations stale, which is what that column is for.

---

## Consequences

**Positive.** The three jobs separate cleanly: `name` for context-free
consumers, `short_name` for surfaces that supply context, `description` for
help. The tagging form gets short labels without any consumer losing the long
ones. The ⓘ stops emitting noise.

**Negative.** Two more optional fields on every value, and a rendering rule
(`short_name ?? name`) that each new display surface must remember. The
non-obvious half is *when not to* use the short form — mitigated by stating the
condition as a rule: use `short_name` only where the schema heading is on
screen.

**Neutral.** Values already seeded need no migration: both fields are optional
and absent means "unchanged". Re-seeding is a `MERGE`, and concept ids are
untouched, so the PostgreSQL join surface is unaffected.

---

## Alternatives considered

**Shorten `name` outright (triage option (a)).** YAML only, zero code. Rejected:
it deletes the gloss everywhere and leaves no absolute form for exports or
Component 15 distractors.

**Reuse the existing `aliases` list as the short label (triage option (b)).** No
new seed field. Rejected: it overloads "alias" (a conventional abbreviation —
"PAC") to also mean "context-elided label", two different things that would then
be indistinguishable in the data. Concept `aliases` keep their existing meaning.

**Put the gloss on the referenced concept.** Rejected as structurally
impossible for the general case — most values reference nothing.
