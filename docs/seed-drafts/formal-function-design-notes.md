# Formal Function Domain — Design Notes (pre-modelling)

**Status:** Design notes for a future domain. **Not yet seeded.** These notes capture the intended scope of the Formal Function domain so the work is not lost; the domain gets its own full design pass (like the cadence domain received) when it is modelled. Per `docs/architecture/knowledge-graph-domain-map.md`, Formal Function is "likely the second domain to be fully modelled, after the cadence domain is stable."

**Date:** 2026-05-21

**See also:** `docs/seed-drafts/cadences-design.md` (the cadence domain references a stable subset of these as stubs — see "What is seeded now" below), `docs/architecture/knowledge-graph-domain-map.md` § 7 (Formal Function), `docs/architecture/knowledge-graph-design-reference.md`.

**Theoretical reference:** Caplin, *Classical Form* (1998) and *Analyzing Classical Form* (2013).

---

## What is seeded now (and why only this)

The cadence domain's `PhraseClosure` and `ThemeClosure` property schemas reference formal-function concepts. Because cadence tagging of the present corpus begins before this domain is modelled, a small, deliberately *stable* subset of these concepts is seeded now as stubs (`stub: true`, `top_level_taggable: false`) so the most common closure facts can be captured at tag time. The rationale and constraints are documented in `cadences-design.md` § "Seeding strategy for formal-function closure"; the short version is: seed only bedrock terms that will not be renamed or restructured, keep the closure schemas optional, and rely on the required `CadenceFunction` as the always-present floor.

**Seeded now (stubs referenced by the cadence domain):**

- Phrase / theme level: `Sentence`, `Period`, `HybridTheme` (abstract only), `Antecedent`, `Consequent`, `Continuation`.
- Interthematic level: `MainTheme`, `Transition`, `SubordinateTheme`, `Coda`.

Everything else below is **deferred** to the full domain pass. When that pass happens, the stubs above are promoted in place (the seed script's `MERGE` semantics handle this — no id changes, no moved files), and the deferred concepts are added. Adding new closure values is non-breaking; a one-time enrichment pass over cadences tagged in the interim fills blanks and adds finer values.

---

## Full intended skeleton

The taxonomy below is the working sketch. Indentation implies subtyping unless noted. Items marked **[seeded]** are the stubs above; all others are deferred.

### Theme types

- **Simple Theme**
  - **Sentence** **[seeded]**
  - **Period** **[seeded]**
- **Hybrid Theme** **[seeded — abstract node only]**
  - **Hybrid 1** — antecedent + continuation
  - **Hybrid 2** — antecedent + cadential *(see theory note 1: this is "antecedent + cadential", not "antecedent + ECP")*
  - **Hybrid 3** — compound basic idea + continuation
  - **Hybrid 4** — compound basic idea + consequent
- **Compound Theme**
  - **Compound Sentence**
  - **Compound Period**

The four hybrid subtypes are the unsettled area that motivated seeding only the abstract `HybridTheme` for now.

### Small ternary & binary

- **Small Ternary**
  - **Exposition (A)**
  - **Contrasting Middle (B)**
  - **Recapitulation (A')**
- **Small Binary**
  - **First part**
  - **Second part**

### Phrase types (intrathematic functions)

- **Presentation**
- **Continuation** **[seeded]**
  - **Cadential** *(see theory note 2: the "Continuation ⇒ ECP / ECP" entries in the source sketch are the cadential phrase function; a "Continuation ⇒ Cadence" fused middle ground is real but deferred to a later discussion)*
- **Antecedent** **[seeded]**
- **Consequent** **[seeded]**
- **Compound Basic Idea**
- **Compound Presentation**
- **Compound Antecedent** *(deferred — may end up a property variation on `Antecedent` rather than a distinct node)*
- **Compound Consequent** *(deferred — likewise, relative to `Consequent`)*

### Sub-phrase functions

Basic Idea, Contrasting Idea, Codetta, etc. **Deferred** — not yet a clear picture, and not directly connected to cadences.

### Framing functions

- **Introduction**
- **Closing Section** — **already modelled in the cadence domain** as the post-cadential `ClosingSection` (FOLLOWS `AuthenticCadence`). Do **not** create a duplicate node here; when this domain is built, reconcile ownership (the cadence-domain node is the canonical one for now).
- **Standing on the Dominant** — likewise already modelled as the cadence-domain `StandingOnTheDominant` (FOLLOWS `HalfCadence`). Do not duplicate.

See the framing-function overlap note below.

### Interthematic functions

- **Main Theme** **[seeded]**
- **Subordinate Theme** **[seeded]**
- **Transition** **[seeded]**
- **Closing Section** *(interthematic — the closing-theme group at the end of an exposition; distinct from the framing-function "Closing Section" above. Dropped for now: the source sketch's author set it aside until the concept is clearer; the cadence domain accordingly does not reference an interthematic closing-theme value.)*
- **Pre-Core**
- **Core**
- **Pseudo-Core**
- **Retransition**

### Full-movement functions

- **Exposition**
- **Development**
- **Recapitulation**
- **Slow Introduction**
- **Coda** **[seeded]**

### Full-movement forms

Sonata form, sonata-rondo, etc. **Deferred** — these may get their own nodes when the domain is modelled.

---

## Theory notes folded in from the review

1. **Hybrid 2 is "antecedent + cadential," not "antecedent + ECP."** The second member is the *cadential* phrase function, not the Expanded Cadential Progression (which is a harmonic structure). Keep this distinct from the `ECP` BOOL property defined on cadences in `cadences-design.md` — same word, different layer.

2. **The "cadential" phrase function deserves its own node.** The source sketch's uncertain "Continuation ⇒ ECP / ECP" entries are the cadential intrathematic function trying to surface — the phrase whose sole job is to articulate the cadence. Model it as `Cadential` rather than folding it into `Continuation` or naming it after a harmonic structure. The "Continuation ⇒ Cadence" fused middle ground (a continuation that becomes cadential) is a real Caplinian phenomenon but is left for the domain's own design pass.

---

## The framing-function overlap (decision needed when this domain is modelled)

`ClosingSection` and `StandingOnTheDominant` are Caplinian *framing functions* (form-domain concepts), but the cadence domain needs them now as taggable post-cadential entities, so they are defined there for Phase 1 (with `FOLLOWS` edges to `AuthenticCadence` / `HalfCadence`). When the Formal Function domain is built:

- Decide whether these two nodes move to this domain, are cross-referenced from it, or stay in the cadence domain with this domain pointing at them. Do not create duplicates in the meantime.
- Add `Introduction` as the third framing function.
- Keep the interthematic "closing-theme group" concept (if reintroduced) under a distinct id from the framing-function `ClosingSection`.

---

## Open questions for the domain's own design pass

- Whether `CompoundAntecedent` / `CompoundConsequent` and similar compound phrase functions are distinct nodes or property variations on their simple counterparts.
- How deep to model the hybrid subtypes, and whether they are subtypes of `HybridTheme` or characterised by the phrase functions they combine.
- Whether full-movement forms (sonata, rondo, …) earn nodes, and how they relate to the full-movement *functions* (exposition, development, …).
- Sub-phrase functions (basic idea, contrasting idea, codetta) — scope and whether any connect to cadences strongly enough to warrant earlier modelling.
- Reconciliation of the framing functions with the cadence-domain post-cadential concepts (above).
