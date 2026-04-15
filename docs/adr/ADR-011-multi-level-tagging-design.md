# ADR-011 — Multi-Level Tagging Tool Design

**Status:** Accepted  
**Date:** 2026-04-15  
**See also:** `docs/architecture/tagging-tool-design.md` (full design specification), `docs/architecture/prototype-tagging-tool.md` (prototype analysis), `docs/adr/ADR-005-sub-measure-precision.md` (selection grid)

---

## Context

The tagging tool must support annotation of concepts that have internal stage structure — a `PerfectAuthenticCadence` contains stages (Initial Tonic, Pre-Dominant, Dominant, Final Tonic), each of which must be given its own spatial bounds within the main fragment. A first design draft explored the UX and data-handling implications of this requirement.

Several non-obvious design questions arose that required explicit decisions before implementation:

1. How deep should the stage bracket hierarchy go in the UI, given that the graph allows arbitrary nesting via `CONTAINS` edges?
2. Should the interaction enforce a specific step-by-step ordering, or allow the annotator to work in any order?
3. Should adjacent stage brackets be allowed to overlap or leave gaps between them?
4. Which concept nodes should appear in the concept picker as direct fragment tags, and which should be excluded?
5. How should the property form be generated from the knowledge graph, and how should structurally-divergent subtypes be handled?
6. How should pre-populated default stage bracket sizes be determined, and how should they relate to the selection grid?

---

## Decisions

### 1. Two-level visual display limit

The tagging UI renders at most two levels of bracket rows below the staff. A concept's stages appear in the stage bracket track (level 1). A stage concept whose sub-stages should be shown at all renders them as **segments within its own bracket** — a split handle inside the bracket — rather than as a third row (level 2 via `display_mode: 'segment'`). A third bracket row is not supported.

This limit is enforced in the graph: `CONTAINS` edges with `display_mode: 'stage'` on a node that is itself a `display_mode: 'stage'` child are rejected by the seeding script. Knowledge engineers must use `display_mode: 'segment'` for sub-stages of compound structural slots.

**Rationale:** three rows of brackets in the score view becomes unreadable and difficult to interact with. The musical hierarchy of interest — a cadence's stages plus one compound stage — fits within two levels. Deeper nesting is a graph modelling problem to be solved by choosing the right level of granularity, not a UI problem to be solved by adding more bracket rows.

### 2. Non-ordered (concurrent-flag) interaction model

The tagging session is not a wizard with enforced step ordering. Instead, four independent boolean flags (`fragmentSet`, `conceptSet`, `stagesComplete`, `propertiesComplete`) track completion state. The annotator can draw a main bracket, select a concept, drag stage brackets, and set property values in any order. Any previously-set value can be changed at any time.

**Rationale:** cadence annotation is complex enough in musical terms without the tool imposing a fixed sequence. The annotator may want to draw all brackets first and then classify, or classify first and then refine bounds. Forcing an order increases friction without improving data quality. The cost is implementation complexity (reactive state model rather than a simple phase enum); the benefit is a substantially better working experience.

### 3. `containment_mode: contiguous` as default for stage brackets

A new edge property `containment_mode` on `CONTAINS` edges governs whether adjacent stage brackets share a split handle (`contiguous`) or have independent endpoints (`free`). The default is `contiguous`.

In contiguous mode, adjacent brackets share a single boundary — dragging the split handle moves both the right edge of stage N and the left edge of stage N+1 simultaneously. Gaps and overlaps are structurally impossible.

**Rationale:** for cadence stages, every beat of the fragment belongs to exactly one stage. This is musically correct and eliminates a class of annotation error. The split-handle interaction is also simpler to use than trying to manually align two independent endpoints. `free` mode is defined for future domains where gaps between stages are musically meaningful (e.g. a formal function with an intervening passage that belongs to no stage), but is not implemented in Phase 1.

### 4. `display_mode` and `containment_mode` as CONTAINS edge properties

Rather than hard-coding tagging-UI behaviour in application logic, the graph itself encodes how each concept's stages should be displayed and constrained. Two new properties on `CONTAINS` edges:

- `display_mode: 'stage' | 'segment'` — whether the target concept creates a bracket row or a subdivision.
- `containment_mode: 'contiguous' | 'free'` — whether siblings share boundaries.

A third property `default_weight: float` governs default bracket size distribution (see Decision 6).

**Rationale:** encoding these in the graph keeps the UI generic. Adding a new domain concept with unusual display requirements does not require UI code changes — only graph data changes. The seeding script enforces the two-level constraint and validates that `containment_mode` is set to a known value.

### 5. `stub` and `top_level_taggable` as concept node properties

Two boolean fields on concept nodes control tagging tool inclusion:

- `stub: boolean` (default `false`) — excludes nodes that exist only as graph placeholders from all tagging UI.
- `top_level_taggable: boolean` (default `true`) — excludes nodes from the concept picker that should only appear as stage targets or are too abstract for direct fragment tagging (e.g. `Cadence`, `AuthenticCadence`).

The concept picker filters to `stub: false AND top_level_taggable: true`.

**Rationale:** not every concept node is meaningful as a direct fragment tag. Without explicit filtering, the picker would include hundreds of nodes that confuse rather than assist — structural sub-components, unmodelled placeholders, and abstract categories. The two separate flags keep the concerns distinct: `stub` is a modelling completeness signal; `top_level_taggable` is a UI accessibility signal.

Stage concepts (e.g. `InitialTonic`, `PreDominant`) are **not** globally excluded — they remain `top_level_taggable: true` by default, because tagging a fragment as a prolonged dominant region without a full cadence context is a legitimate annotation. The knowledge engineer can set `top_level_taggable: false` on specific stage nodes if they determine that no independent tagging use case exists.

### 6. Weighted proportional defaults, snapped to the selection grid

When a concept with `CONTAINS` edges is selected, stage brackets are pre-populated immediately across the main fragment's spatial extent. Default widths are proportional to `default_weight` values on the `CONTAINS` edges (equal distribution if no weights are set). Computed positions are snapped to the currently active selection grid (measure, beat, or sub-beat — see ADR-005).

**Rationale:** forcing the annotator to draw every stage bracket from scratch imposes unnecessary work and discards the structural knowledge already encoded in the graph. Pre-population with sensible defaults (weighted by the typical proportion each stage occupies) gives the annotator real handles to adjust rather than an empty state. Snapping to the selection grid ensures that default boundaries align to the same musical grid the annotator would naturally choose, eliminating the first drag for most cases.

Knowledge engineers set `default_weight` values as they accumulate empirical intuition from actual tagging sessions. The UI requires no code change when weights are updated — it reads them from the graph at session start.

### 7. Type Refinement as a separate form section

When the selected concept has `IS_SUBTYPE_OF` children that differ in `CONTAINS` structure, a Type Refinement section appears at the top of the form panel — above properties — and must be resolved before submission. This section changes which stage brackets appear in the score overlay.

Type Refinement is distinct from property values: it changes the structure of the annotation, not just its descriptive content. Keeping it visually and semantically separate prevents conflation with property choices and makes the consequential nature of the choice explicit.

**Invariant:** a structural choice (one that changes the `CONTAINS` structure visible in the UI) is always modelled as a subtype split (`IS_SUBTYPE_OF`), never as a property value. A property value choice that would need to change the stage layout is a signal that the graph model should be refactored to introduce a subtype split.

---

## Consequences

### Positive

- The tagging tool is generic with respect to concept structure: adding new concepts with complex stage arrangements requires only graph data changes, not UI code changes.
- The non-ordered interaction model avoids forcing annotators into artificial sequences, reducing friction for complex annotations.
- Contiguous containment mode eliminates a class of annotation error (gaps and overlaps between stages) for the default cadence use case.
- Pre-populated defaults with grid snapping make multi-stage tagging significantly faster in practice.

### Negative

- The concurrent-flag state model is more complex to implement than a phase enum. Reactive coupling between the form panel and the score overlay requires careful state management.
- The two-level display limit is a constraint the graph model must respect. Violations are caught at seeding time, not at modelling time — the knowledge engineer must know the constraint when designing concept hierarchies.
- `default_weight` values must be set and maintained by knowledge engineers; initially they will be guesses that improve only with tagging experience.

### Neutral

- `multi-level-tagging-draft.md` is superseded by `tagging-tool-design.md`. The draft is retained in the repository as a historical artefact but should not be consulted as a current design reference.
- The prototype's ghost layer architecture and beat boundary inference algorithm carry forward unchanged. The decisions in this ADR concern the layers built on top of that foundation.

---

## Alternatives Considered

**Enforce a fixed annotation sequence (select concept → draw main bracket → draw stage brackets → set properties).** Rejected because the annotation task is complex enough musically that forcing a rigid sequence adds friction without improving data quality. The non-ordered model is harder to implement but substantially better to use.

**Render all levels of CONTAINS nesting as bracket rows.** Rejected because three or more rows of brackets in the score view is unreadable and practically unusable. The two-level limit with `display_mode: 'segment'` for deeper nesting is a deliberate design constraint that keeps the UI tractable.

**Allow overlapping and gapped stages by default.** Rejected for the cadence use case, where every beat of the fragment belongs to exactly one stage. Contiguous mode eliminates annotation errors that would be difficult to detect and correct after the fact. `containment_mode: 'free'` is available as an opt-in for domains where gaps are meaningful.

**Derive tagging-UI inclusion from graph structure automatically** (e.g. automatically exclude all `CONTAINS` targets from the top-level picker). Rejected because stage concepts like `InitialTonic` are legitimately taggable as independent fragments in some contexts. The explicit `top_level_taggable` flag gives knowledge engineers full control without requiring automated inference that would inevitably produce wrong results in edge cases.
