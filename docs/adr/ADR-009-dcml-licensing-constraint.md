# ADR-009 — DCML Corpus Licensing Constraint for the Public API

**Status:** Accepted  
**Date:** 2026-04-14

---

## Context

The project uses DCML corpora as a secondary score and annotation source for repertoire not covered by OpenScore (see `docs/architecture/corpus-and-analysis-sources.md`). DCML corpora provide two distinct assets:

- **Scores** — uncompressed MuseScore 3 (`.mscx`) files, converted to MEI for storage.
- **Harmonic annotations** — expert `harmonies.tsv` files consumed directly into the fragment `summary` JSONB as `harmony_source: "DCML"`.

The licensing situation across DCML corpora is not uniform:

| Corpus type | Licence | Restriction |
|---|---|---|
| Most DCML corpora (Mozart, Beethoven piano sonatas, Chopin, Schubert, etc.) | CC BY-SA 4.0 | ShareAlike |
| ABC corpus (Beethoven string quartets) | CC BY-NC-SA 4.0 | ShareAlike + NonCommercial |

**CC BY-SA 4.0 — ShareAlike obligation.** Any database, API response, or other derivative work that incorporates CC BY-SA 4.0 material must be distributed under CC BY-SA 4.0 or a licence the Creative Commons organisation has designated as compatible. This obligation attaches to the licensed material itself, not to the project as a whole. Concretely: API responses that include DCML-derived annotation fields (`harmony`, `harmony_source`, and fields normalised directly from DCML TSVs) are derivative works and must be offered under CC BY-SA 4.0 terms.

**CC BY-NC-SA 4.0 — NonCommercial restriction.** The ABC corpus adds a NonCommercial clause on top of ShareAlike. Distributing ABC-derived material via a public API would restrict any downstream user from incorporating it in commercial products or services. This is a materially different legal exposure to the rest of the DCML collection and must be handled separately.

**What is not affected.** The ShareAlike obligation runs with the derived material, not with every field in a response that happens to be returned alongside it. The following project assets are not derivative works of DCML material and carry no ShareAlike obligation:

- The knowledge graph structure and any edges authored by the project.
- Prose annotations entered via the tagging tool.
- Fragment boundary selections made by annotators.
- Concept tags and their property values.
- The fragment schema, API design, and application code.
- Scores sourced from OpenScore (CC0) and their MEI representations.

---

## Decision

**1. Apply CC BY-SA 4.0 to API responses that include DCML-derived annotation data.**

The public read-only API must indicate CC BY-SA 4.0 as the applicable licence for any response that includes DCML-derived harmonic annotation fields. This is implemented by adding a `data_licence` field to fragment API responses:

```json
{
  "fragment_id": "...",
  "harmony_source": "DCML",
  "data_licence": "CC BY-SA 4.0",
  "data_licence_url": "https://creativecommons.org/licenses/by-sa/4.0/",
  ...
}
```

When `harmony_source` is `"music21_auto"`, `"manual"`, or `"WhenInRome"` (for analyses that do not originate from DCML), the `data_licence` field reflects the appropriate licence for that content. A mapping table from `harmony_source` values to applicable licences is maintained in the API response serialiser. For Phase 1, the only values are `"DCML"` (CC BY-SA 4.0) and `"music21_auto"` (no third-party restriction).

**2. Exclude the ABC corpus (Beethoven string quartets) from the public API.**

The CC BY-NC-SA 4.0 NonCommercial restriction on the ABC corpus is incompatible with a public API that places no restrictions on downstream use. The ABC corpus is excluded from public API responses for Phase 2 launch. It may be ingested internally and used in the tagging tool for authenticated annotators, but its derived data must not appear in unauthenticated or public endpoints.

If Beethoven string quartet coverage is needed in the public API, the path is to source equivalent scores and annotations from a CC0 or CC BY licence holder, not to include ABC-derived data under a NonCommercial flag.

**3. Surface attribution in the API documentation and terms of use.**

The public API landing page and documentation must include:

- Attribution to DCMLab and the relevant corpus repositories.
- A statement that harmonic annotation data is available under CC BY-SA 4.0.
- A link to the Creative Commons CC BY-SA 4.0 licence text.

This satisfies the BY (attribution) and SA (ShareAlike notice) requirements of the licence.

---

## Consequences

**Positive**

- The project can legally include DCML expert annotations in the public API. These are the highest-quality harmonic annotations available for the target repertoire; excluding them would significantly degrade the API's analytical value.
- The per-fragment `data_licence` field gives downstream consumers machine-readable licence information. They can filter by licence if they have their own compliance constraints.
- The decision is conservative: it applies the ShareAlike obligation to annotation data specifically rather than treating the entire API response as CC BY-SA 4.0. This preserves the project's freedom to licence its own authored assets (graph edges, prose annotations, concept taxonomy) separately.

**Negative**

- Beethoven string quartet coverage is absent from the public API unless an alternative source is found. The ABC corpus is the primary structured source for this repertoire.
- Downstream users who build commercial products using the API must ensure they handle the CC BY-SA 4.0 annotation fields correctly. The `data_licence` field makes this tractable but does not eliminate the obligation.
- Adding `data_licence` to the fragment response schema is a non-trivial serialiser change that must be implemented before the public read-only endpoint is activated. This is a launch blocker.

**Neutral**

- This decision does not affect the internal tagging tool. Authenticated annotators may work with any ingested corpus regardless of licence, since internal tool use does not constitute public distribution under CC BY-SA 4.0's terms.
- Score files (MEI) sourced from DCML `.mscx` conversions carry the same CC BY-SA 4.0 licence as the annotations. If MEI files are exposed directly via the API or downloadable links, the same `data_licence` treatment applies to those assets.
- The `harmony_source` field already exists in the fragment schema and is populated at ingestion time. No schema migration is required to support the per-fragment licence derivation logic.

---

## Alternatives considered

**Exclude all DCML-derived annotation data from the public API, serving only `music21_auto` annotations.** Rejected. music21 auto-analysis is reliable for key and meter but only medium-reliability for Roman numerals. Expert DCML annotations are the primary analytical asset for works in the DCML corpus; removing them would make the public API substantially less useful for exactly the repertoire (Mozart, Beethoven, Schubert) that is most central to the project.

**Include the ABC corpus under a NonCommercial flag and expose it in a separate, clearly marked API endpoint.** Considered but deferred. A separate endpoint or a `commercial_use_permitted: false` flag would give downstream users the information they need to comply. However, this approach complicates the API surface and increases the risk that the NonCommercial restriction is misunderstood or overlooked. The simpler and safer path is exclusion until there is a concrete use case that justifies the added complexity.

**Treat the entire API response as CC BY-SA 4.0 regardless of the annotation source.** Rejected. Applying ShareAlike to CC0 (OpenScore) or project-authored fields is unnecessary and would impose licensing restrictions on content that carries no such obligation from its upstream source. The per-field `harmony_source` → `data_licence` mapping is more precise and less restrictive.
