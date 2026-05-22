# ADR-020 — Pedagogical Sequencing (`PREREQUISITE_FOR`) in the Cadence Domain

**Status:** Accepted
**Date:** 2026-05-22
**See also:** `docs/architecture/edge-vocabulary-reference.md` (`PREREQUISITE_FOR` definition and the "no redundant inverses" / "earn your edge type" principles), `docs/seed-drafts/cadences-design.md` (cadence morphology design — first consumer), `docs/architecture/knowledge-graph-design-reference.md` ("What earns a concept node"; the prerequisite-chain query), `docs/architecture/project-architecture.md` (pedagogical awareness; prerequisite-map view and collection sequencing), `docs/adr/ADR-011-multi-level-tagging-design.md` (`top_level_taggable`), `backend/graph/queries/relationships.py` (`PREREQUISITE_FOR` constant)

---

## Context

`PREREQUISITE_FOR` is part of the authoritative edge vocabulary and is already a relationship constant in `backend/graph/queries/relationships.py`, but no domain has ever *applied* it. `cadences-design.md` is deliberately morphology-only — it models what notes/chords are present (concept hierarchy) and how instances vary (property schemas), and brackets pedagogy out, mentioning it once as a deferred "pedagogical hook." This ADR is therefore the **first concrete use of `PREREQUISITE_FOR` in any domain**, and the conventions it sets become the de facto precedent for every domain that follows.

A draft pedagogical-dependency sketch for the cadence concepts was reviewed over two passes. The review surfaced two questions that needed deciding before seeding:

1. **Which nodes to anchor on.** The initial sketch drew edges from the abstract category nodes (`AuthenticCadence`, `HalfCadence`). Because those are the taxonomic *parents* of the deviation subtypes, most of the proposed edges (`AC → DC`, `HC → DominantArrival`) merely retraced `IS_SUBTYPE_OF`, and the post-cadential edges (`AC → ClosingSection`, `HC → StandingOnTheDominant`) merely retraced the reverse of existing `FOLLOWS` edges. They duplicated structure the graph already had.

2. **Whether to materialise edges that duplicate structural edges** — the normalise/denormalise question. It has teeth because the canonical prerequisite-chain query reads *only* `PREREQUISITE_FOR`:

   ```cypher
   MATCH path = (c:Concept {id: $id})<-[:PREREQUISITE_FOR*1..]-(:Concept)
   RETURN nodes(path), relationships(path)
   ```

   "Derivable from `FOLLOWS`/`IS_SUBTYPE_OF`" does not mean "available to that query" — nothing currently folds structural edges into the prerequisite walk. So omitting a derivable edge and materialising it are genuinely different, not cosmetic.

The key move that resolved (1) and shrank (2) was to **anchor prerequisites on the *realised* cadence forms** rather than the abstract parents. A learner masters a working cadence before its deviations, so the prerequisite for a deceptive/evaded/abandoned cadence is `AuthenticCadenceRealised`, not the abstract `AuthenticCadence`. Re-anchoring is simultaneously the more accurate pedagogical claim *and* the mechanism that turns parent→child shadows into genuine sibling edges: `AuthenticCadenceRealised` is a *sibling* of `DeceptiveCadence` under `AuthenticCadence`, with no edge between them.

After re-anchoring, only the post-cadential / cross-fragment concepts (`ClosingSection`, `StandingOnTheDominant`, `ReopeningHalfCadence`) still had candidate prerequisites that shadowed existing structure — and those are precisely the concepts whose membership in a *cadence-learning* sequence is weakest (they are post-cadential phenomena, more naturally sequenced by the Formal Function domain once it exists).

---

## Decision

### 1. Seed six `PREREQUISITE_FOR` edges, anchored on realised forms

Each edge reads source → target = "source is a prerequisite for target." Every one carries information that is **not** derivable from any existing `IS_SUBTYPE_OF` or `FOLLOWS` edge.

| Prerequisite (source) | Dependent (target) | Why it is non-derivable / pedagogical reading |
|---|---|---|
| `AuthenticCadenceRealised` | `HalfCadenceRealised` | Cross-branch cousins under `Cadence`; no existing edge connects the two branches. Learn the authentic close before the half close. |
| `PerfectAuthenticCadence` | `ImperfectAuthenticCadence` | Siblings under `AuthenticCadenceRealised`; sibling order is not implied by the taxonomy. The PAC is the prototype; the IAC is the weaker variant taught after it. |
| `AuthenticCadenceRealised` | `DeceptiveCadence` | `AuthenticCadenceRealised` and `DeceptiveCadence` are siblings under `AuthenticCadence`; no edge between them. Understand a realised close before a deviation from it. |
| `AuthenticCadenceRealised` | `EvadedCadence` | As above. |
| `AuthenticCadenceRealised` | `AbandonedCadence` | As above. |
| `HalfCadenceRealised` | `DominantArrival` | Siblings under `HalfCadence`; no edge between them. Understand the realised half cadence before the dominant-arrival deviation. |

### 2. Assert no prerequisites for the post-cadential / cross-fragment concepts

`ClosingSection`, `StandingOnTheDominant`, and `ReopeningHalfCadence` receive **no** `PREREQUISITE_FOR` edges in this domain. Their only candidate prerequisites duplicate existing structure: `AuthenticCadenceRealised → ClosingSection` and `HalfCadenceRealised → StandingOnTheDominant` are reverses of those concepts' `FOLLOWS` edges; the `AuthenticCadenceRealised → ReopeningHalfCadence` leg is the reverse of `ReopeningHalfCadence FOLLOWS AuthenticCadenceRealised`; and the `HalfCadenceRealised → ReopeningHalfCadence` leg is plain parent→child (`ReopeningHalfCadence IS_SUBTYPE_OF HalfCadenceRealised`). These are post-cadential phenomena whose pedagogical sequencing belongs to the Formal Function domain when it is built. `ReopeningHalfCadence` already inherits a sensible position via its `IS_SUBTYPE_OF HalfCadenceRealised` edge, so it is not orphaned.

### 3. `PREREQUISITE_FOR` is acyclic

The chain query traverses unbounded (`*1..`); a cycle would make it non-terminating / path-exploding. The six edges above form a DAG. Acyclicity is a standing constraint on the edge type, to be enforced by a graph-validation check (see Consequences).

### 4. Prerequisite edges may touch abstract (non-taggable) concepts

Of the anchors used here, only `AuthenticCadenceRealised` is `top_level_taggable: false` — it always resolves to PAC/IAC. `HalfCadenceRealised` is itself directly taggable. Touching a non-taggable concept is fine regardless: `PREREQUISITE_FOR` describes explanation and curriculum ordering, not fragment tagging, so a non-taggable concept is a legitimate endpoint. The chain query, when surfacing a learner-facing sequence, resolves a non-taggable endpoint down its `IS_SUBTYPE_OF` subtypes (e.g. `AuthenticCadenceRealised` expands to `PerfectAuthenticCadence` / `ImperfectAuthenticCadence`).

### 5. Defer the general normalise-vs-denormalise policy

Whether `PREREQUISITE_FOR` edges that *duplicate* a structural edge should be materialised (denormalise) or omitted and derived at query time (normalise) is **not** decided project-wide here. Within the cadence domain the question is sidestepped entirely: by Decisions 1–2 every retained edge is non-derivable, so there is nothing to normalise. Revisit the general policy when the first evidence beyond cadences appears — i.e. when a second domain's prerequisites genuinely overlap structural edges, or when the prerequisite-chain query must serve multiple domains under one traversal. Cadences is the most structurally entangled domain we expect; generalising a policy from it would risk over-fitting.

### 6. Correct the `ClosingSection` `FOLLOWS` target (morphology-design fix)

Applying the realised-anchor principle exposed a latent inconsistency in `cadences-design.md`: the natural pedagogical prerequisite for a closing section is the *realised* AC, yet `ClosingSection FOLLOWS AuthenticCadence` pointed at the abstract parent. That divergence was the tell. A closing section prolongs the tonic *after a successful close*, which only a realised authentic cadence delivers — deceptive, evaded, and abandoned cadences never reach the tonic. The `FOLLOWS` edge is therefore retargeted: **`ClosingSection FOLLOWS AuthenticCadenceRealised`**. `StandingOnTheDominant FOLLOWS HalfCadence` is left unchanged: a standing-on-the-dominant can legitimately follow a realised half cadence *or* a `DominantArrival`, so the abstract parent is the correct, broader target.

---

## Consequences

### Positive

- Every cadence `PREREQUISITE_FOR` edge carries information the graph did not already hold, honoring the vocabulary's "no redundant inverses" and "earn your edge type" principles. No special exception to those principles is needed.
- The canonical single-relationship prerequisite-chain query stays valid and meaningful — no rewrite to union `FOLLOWS`/`IS_SUBTYPE_OF`, and no per-domain query logic.
- No dual source of truth between `FOLLOWS` and `PREREQUISITE_FOR`, so no drift risk and no new "reverse-FOLLOWS must match its prereq" coherence check for this domain.
- Re-anchoring on realised forms is both the more accurate pedagogical claim and the structural mechanism that earns each edge.
- The work surfaced and fixed a real bug in the morphology design (the `ClosingSection` `FOLLOWS` target).

### Negative

- Because one anchor is non-taggable (`AuthenticCadenceRealised` is `top_level_taggable: false`; `HalfCadenceRealised` is taggable), a learner-facing chain walk is not purely over `PREREQUISITE_FOR`; it must expand non-taggable endpoints down `IS_SUBTYPE_OF`. Acceptable, but it means the "single edge type" walk is an idealisation even here.
- The post-cadential concepts have no pedagogical sequencing for now; the prerequisite-map view and collection-sequencing suggestions will not position `ClosingSection`, `StandingOnTheDominant`, or `ReopeningHalfCadence` until the Formal Function domain supplies it.
- The general normalise/denormalise policy remains open; a future domain may force the decision and could prompt a revisit of the reasoning here.
- Acyclicity now needs a graph-validation check (`scripts/validate_graph.py`): assert no directed cycle over `PREREQUISITE_FOR`. This is a code task for the YAML/seed pass, not part of this doc.

### Neutral

- First consumer of `PREREQUISITE_FOR`. Establishes the realised-anchor precedent for later domains.
- Six edges to seed — trivial YAML once the cadence concepts exist.

---

## Alternatives Considered

**Anchor prerequisites on the abstract parents (the original sketch: `AC → DC`, `HC → DominantArrival`, etc.).** Rejected. It produces parent→child edges that merely duplicate `IS_SUBTYPE_OF`, and it is the less accurate pedagogical claim — a student learns a *realised* cadence, not the abstract category, before a deviation from it.

**Chain the deviations `DC → EC → Abandoned`.** Rejected as over-interpretation. A linear chain asserts each deviation strictly builds on the previous, but Caplin contrasts the evaded and abandoned cadences by *where* the cadential process fails (parallel deviations, not nested ones). The only real prerequisite is the realised AC; the deviations fan out from it. A teaching-difficulty ordering (deceptive first, abandoned last) is a defensible *collection-sequencing* choice, but it is a UI/curriculum-authoring concern, not a structural fact to commit to the graph.

**Materialise the post-cadential / reopening prerequisites (denormalise within cadences).** Rejected for this domain. Those edges are pure inverses of `FOLLOWS` or plain parent→child taxonomy; materialising them would create a dual source of truth and require a coherence check, all for the concepts whose pedagogical-sequence membership is weakest. Deferred to the Formal Function domain rather than denied outright.

**Establish a project-wide normalise-vs-denormalise policy now.** Rejected as premature. With only the cadence domain as evidence — and it the most structurally entangled domain in sight — a general rule would be over-fitted. Decide when a second domain provides a real overlap to reason about.
