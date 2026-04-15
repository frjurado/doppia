# Knowledge Graph — Domain Map

## Purpose

This document records the planned scope of the knowledge graph: which musical domains are confirmed for inclusion, which are under consideration but not yet scoped, and which have been explicitly excluded and why. It is a design boundary document, not a modelling guide. For modelling conventions, see [`knowledge-graph-design-reference.md`](knowledge-graph-design-reference.md).

---

## Confirmed Domains

These domains are committed to the knowledge graph. They will be developed domain by domain, in rough priority order, with stub nodes at every boundary so that cross-domain edges are never left dangling.

### 1. Basic Harmony

The atomic vocabulary on which all other domains depend. Covers scales, chord quality and inversion, Roman numeral function, and the diatonic/chromatic distinction. Without this domain, every other domain requires undeclared stub nodes for its most basic inputs.

**Scope discipline:** only what other domains need as inputs is defined here. Voice-leading tendencies and resolution behaviour belong to the domains that consume those concepts (Cadence, Prolongation), not to this one. The risk is scope creep toward a complete harmonic grammar; the constraint is to model only universals that are stable across all instances of a chord type.

---

### 2. Cadence

The seed domain — the first to be fully modelled. Covers cadence types (PAC, IAC, HC, DC, EC), their structural stages (Initial Tonic, Pre-Dominant, Dominant, Final Tonic), and their elaboration techniques (cadential 6-4, applied dominant, Neapolitan approach, chromatic pre-dominants, etc.).

Cadence is also the domain that has driven the most graph modelling decisions to date — the three-layer architecture (concept nodes, PropertySchema, PropertyValue), `CONTAINS` edges with `order` and `required` properties, and the concept ID stability invariant all emerged from working through this domain in detail.

---

### 3. Sequence

Harmonic and melodic sequences, their interval patterns, and their chord quality configurations. Covers descending fifth sequences, descending third sequences, ascending second sequences, and their diatonic and chromatic variants.

It relates strongly to the domain of Schema, as many sequences are stereotypical in nature, and imply certain voice-leading patterns.

---

### 4. Prolongation

A deliberately thin, non-Schenkerian conception. Covers surface prolongation techniques: pedal point, neighbour motion (upper and lower), voice exchange, and arpeggiation. This domain does not model Schenkerian structural levels or background/middleground hierarchies — those are interpretive constructs that resist the controlled vocabulary constraint and would make annotation unreliable.

The domain's value is in giving the tagging system a vocabulary for passages where harmonic stasis is achieved by surface decoration rather than progression.

---

### 5. Modulation

Key change as a structural and rhetorical event. Covers modulation types (pivot chord, chromatic, enharmonic, phrase modulation), the distinction between tonicisation and modulation proper, and common modulation targets in tonal practice (relative major/minor, dominant region, etc.).

Closely related to all the other harmonic domains, as well as to certain formal functions associated with modulation (Transition, Development).

---

### 6. Rule of the Octave

The conventional harmonisation of a stepwise bass ascending and descending through a full octave. Sits at the intersection of Basic Harmony and Schema: it is a pedagogical/compositional framework that codifies the default voice-leading grid of tonal practice, and in Gjerdingen's framing it is effectively a background schema against which Galant schemata operate.

Its dual nature means it has edges pointing in both directions: toward Basic Harmony (instantiating scale degree and chord concepts) and toward Schema (underpinning schema recognition as a background norm).

---

### 7. Formal Function

Phrase- and section-level formal roles in the Caplinian sense: presentation, continuation, cadential, and their combination into theme types (sentence, period, hybrid). Also covers larger formal sections (exposition, development, recapitulation) at a higher level of abstraction.

Formal Function is likely the second domain to be fully modelled, after the cadence domain is stable, because it is deeply entangled with cadence: cadence types are the primary differentiators of formal closure strength, and formal function nodes will carry `CONTAINS` edges pointing at cadence concepts.

---

### 8. Schema

Galant voice-leading schemata in the sense of Gjerdingen's *Music in the Galant Style*: Romanesca, Prinner, Monte, Fonte, Ponte, Meyer, Do-Re-Mi, Converging, and related patterns. These are multi-voice contrapuntal patterns with characteristic bass and soprano scale-degree pairs, not simply chord progressions.

Schema nodes are more complex than cadence nodes: each schema has a defined sequence of stages with characteristic bass and soprano scale degrees at each stage, and the same schema can appear in multiple formal contexts and with multiple harmonisations.

The Rule of the Octave domain feeds into this one as a background norm.

---

### 9. Musical Topic

Extra-musical associative categories in the sense of Ratner, Agawu, and Monelle: march, hunt, pastoral, learned style, singing style, Sturm und Drang, etc. Topics are characterised by a cluster of surface features (texture, rhythm, register, mode) that evoke a conventional extra-musical association.

This domain is somewhat structurally different from others. Every other domain has functional, structural, or taxonomic edges. Topic relationships are associative: a topic *evokes* a social context or affect rather than *resolving to* or *containing* anything in the graph's functional sense. 

---

### 10. Rhetorical Figure

Musical figures in the Classical and early Romantic rhetorical tradition: lamento, sigh, exclamatio, and related gestures. These are brief, conventionally recognised surface patterns that carry rhetorical weight within a formal context.

**Scope note:** the scope here might be Classical-period rhetorical thinking (Koch, Forkel, and contemporary reception) to begin with, rather than the Baroque *musica poetica* tradition (Burmeister), which has a more codified taxonomy but is less immediately relevant to the primary corpus (Classical-period keyboard music). This decision should be revisited depending on the corpus extension when the domain is modelled.

---

### 11. Texture

Surface textural categories: monophony, homophony, melody-with-accompaniment, polyphony, and characteristic accompaniment patterns (Alberti bass, um-pah, chorale style). Texture is a relatively thin domain in terms of node count, but it has high connectivity: many schema-level and topic-level distinctions depend on it implicitly, and it affects how nearly every other concept manifests in a fragment.

---

## Areas Under Exploration

These domains are identified as potentially valuable but are not yet scoped. They are not stub nodes; they are not on the active roadmap. They are named here so that design decisions in confirmed domains do not inadvertently close off the options they would require.

### Counterpoint

Likely to fracture into at least three distinct sub-domains with almost no shared node types:

- **Species counterpoint** — intervallic rules, motion types (contrary, oblique, similar, parallel), forbidden parallels. Connects to Basic Harmony and Texture.
- **Invertible counterpoint** — double, triple, and quadruple counterpoint; the rules governing interval inversion at the octave, tenth, and twelfth. Highly technical, small node count.
- **Imitative counterpoint** — canon, fugue, stretto, subject and answer. Connects strongly to Formal Function and Schema.

The decision of which sub-domain to address first, and how to model the boundaries between them, is deferred until there is a clearer sense of which is most needed for corpus annotation and AI tutoring.

### Phrase Rhythm and Hypermeter

Metric phenomena at the phrase level: hypermetric regularity and irregularity, hemiola, metrical reinterpretation, phrase expansion and compression, overlap. Distinct enough from Formal Function to deserve its own treatment — Caplin addresses phrase rhythm separately, and the phenomena connect to Cadence, Sequence, and Formal Function via edges that do not otherwise exist.

The primary design question is how to model hypermeter without importing a full metrical hierarchy (which would have the same tractability problems as Schenkerian prolongation). A thin, surface-oriented conception — similar to the approach taken for Prolongation — is likely the right starting point.

---

## Explicitly Excluded: Thematic and Motivic Relationships

The possibility of a Theme/Motif domain — covering the relationships between fragments that share motivic material (repetition, variation, development, augmentation, inversion, fragmentation) — has been considered and explicitly excluded from the project scope.

### Why it is excluded

**It changes the epistemic stance of the system.** The entire knowledge graph is built on a single premise: a fragment is an *example of a universal concept*. A PAC is an example of the concept `PerfectAuthenticCadence`, which applies across any work in any corpus. Thematic identity inverts this: the fragment *is* the meaningful unit, and meaning emerges from its relationship to other specific fragments in the same work. "Fragment 47 is the development of the fugue subject from Fragment 12" is a fact about a specific corpus object, not a classification of a universal.

**It requires architectural changes.** Inter-fragment identity relationships — repetition, variation, development — are edges between specific corpus objects, not between concept nodes. Accommodating them properly would require either a `fragment_relationship` table in PostgreSQL (manageable) or promoting fragments to first-class graph nodes in Neo4j (a significant architectural shift). Either way, the data model, the tagging interface, the annotation workflow, and the AI reasoning layer would all need to be extended to handle a fundamentally different kind of knowledge.

**Annotation burden and interpretive contestation are significantly higher.** Whether a passage is a *variation* of a theme or a *new idea derived from motivic material* is one of the questions musicologists disagree most about. The peer-review workflow and controlled vocabulary that make cadence annotation tractable do not transfer cleanly to thematic analysis.

**The scope becomes unmanageable.** Admitting thematic relationships means admitting work-specific analysis alongside concept-level analysis. The system would need to distinguish between "what is a fugue subject?" (concept-level, answerable from the graph) and "how does Bach develop this particular subject?" (work-specific, requiring inter-fragment traversal). These are different systems serving different purposes, and conflating them undermines the clarity of both.

### What is retained

The concept nodes `Subject`, `Answer`, `Countersubject`, `HeadMotif`, `ContrastingMiddle`, and similar thematic type names are genuine universal concepts with definitions, relationships, and pedagogical roles. These belong in the knowledge graph — in the Formal Function domain or a future Imitative Counterpoint domain. The exclusion applies to *thematic identity relationships between specific corpus fragments*, not to the abstract concept types themselves.
