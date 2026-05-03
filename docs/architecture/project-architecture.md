# Doppia — Open Music Analysis Repository: Architecture Overview

## Project Aim

To build an open repository of curated musical scores and annotated fragments, grounded in a semantically rich knowledge base. The system centres on a Verovio-based score viewer and expert tagging tool that links musical fragments to a structured concept graph — infrastructure that delivers standalone value for editorial work, publication, and music theory pedagogy.

The system is designed in layers, each of which delivers standalone value while preparing the ground for the next. The notation infrastructure enables the editorial tools; the editorial tools populate the knowledge base; the knowledge base powers user-facing features (blog, collections, exercises) that are immediately useful and that happen to lay the ideal groundwork for an optional AI reasoning layer in a later phase.

---

## Core Components

### 1. The Score Corpus (MEI + Verovio)

The raw material of the system. Complete musical scores are sourced from open repositories (e.g. OpenScore) and stored in **MEI format**, which serves as the authoritative, archival representation of each score.

A **Verovio-based interface** allows human experts to visualize scores and manually tag fragments — marking a cadence here, a period there, a specific harmonic gesture elsewhere. These tags are the bridge between the raw notation and the knowledge system.

---

### 2. The Fragment Database

Each tagged excerpt from the corpus is stored as a **fragment record** with three derived representations:

- **Renderable artifact**: a pointer to the relevant bars within the MEI file, used by the front-end to display engraved notation (via Verovio) and generate audio.
- **Structured analytical summary**: a JSON object encoding the musically meaningful features of the fragment — key, meter, harmonic reduction, cadence type, formal role, notable features, etc.
- **Prose annotation**: a short expert-written paragraph describing what is theoretically significant about the fragment.

Fragments carry **hierarchical tags** that encode both local features and structural context — a cadence tag that also knows it belongs to a consequent phrase within a parallel period, for example. Tags are not free text; every tag value is a reference to a node in the knowledge graph, ensuring consistency across the corpus.

Preprocessing pipelines (e.g. using **music21**) can assist in auto-generating structural summaries from MEI, with human review and enrichment.

---

### 3. The Knowledge Graph

The semantic core of the system. Rather than a flat dictionary of definitions or a simple hierarchy, the knowledge base is a **graph** where nodes are musical concepts and edges are typed relationships capturing how concepts relate to one another. The graph is organised into domains — Basic Harmony, Cadence, Sequence, Prolongation, Modulation, Rule of the Octave, Formal Function, Schema, Musical Topic, Rhetorical Figure, and Texture — developed one at a time with stub nodes at every boundary so cross-domain edges are never left dangling. The confirmed domain list, areas under exploration, and explicitly excluded scope are documented in [`knowledge-graph-domain-map.md`](knowledge-graph-domain-map.md).

#### Node structure

Each concept node contains:
- A canonical name and known aliases
- A prose definition
- Domain and complexity metadata
- A set of typed relationships to other nodes and to corpus fragments

#### Relationship vocabulary (edge types)

The full, authoritative edge type reference — including active types, retired types with rationale, and conventions — is maintained in:

**[`edge-vocabulary-reference.md`](edge-vocabulary-reference.md)**

The typed edge vocabulary is what makes the graph useful for reasoning rather than mere retrieval. `CONTRASTS_WITH` edges power exercise distractor selection; `PREREQUISITE_FOR` edges inform the ordering of collections; `IS_SUBTYPE_OF` edges allow property schema inheritance to propagate down the taxonomy. Concept tags on fragments are resolved at the application layer via PostgreSQL, not as Neo4j edges.

---

### 4. The Vector Store (Prose Layer)

All natural-language content — concept prose annotations, fragment annotations, blog post body text, explanatory text about expressive qualities, style, historical context — is stored in a **vector database** and retrieved via RAG (Retrieval-Augmented Generation). This is the layer that carries the *why*: the things that resist tabular or relational encoding, such as why certain voice leading choices feel characteristically Classical, or what makes a specific harmonic moment emotionally charged.

Blog posts that reference fragments using the controlled vocabulary of the knowledge graph are candidates for inclusion here, progressively enriching the prose layer as the publication archive grows.

---

### 5. User Infrastructure

A shared identity and state layer underpins all user-facing features. It is designed holistically rather than grafted onto individual features, because collections, exercises, and any future reasoning tools all draw on the same user model.

#### Core user model
- **Authentication**: standard account creation and login (email/password, OAuth).
- **Profile**: display name, institutional affiliation (optional), self-reported experience level.
- **Roles**: anonymous visitors (read-only blog access), registered users (collections, exercises, progress), editors (fragment tagging), administrators.

#### User state
- **Collection ownership**: which collections a user has created, and which shared collections they have imported.
- **Exercise history**: per-exercise-type accuracy records, stored from day one to support future adaptive difficulty, even before that layer is built.
- **Reading history**: which blog posts and fragment pages a user has visited (opt-in).
- **Implicit profile**: the aggregate of collections, exercise history, and reading activity constitutes a rich signal about what a user knows and has been working on — data that is valuable in itself and that would allow a future AI reasoning layer to situate its responses in a real learning history.

Designing this layer early — even before any AI is built — ensures the data exists when it is needed.

---

### 6. Core User Features

These three features deliver immediate, standalone value from a populated fragment database. None of them require a Phase 3 AI layer to function — they are the product in Phases 2 and beyond.

#### Blog

A publication layer where authors can intersperse prose with musical fragments rendered inline via Verovio. Key characteristics:

- **Scrollytelling layout**: the horizontal nature of a musical staff maps naturally onto a scroll axis, allowing extended passages to unfold without line breaks. As the reader scrolls, notation advances in sync.
- **Integrated playback**: MIDI audio playback with auto-scroll synchronization is available for any embedded fragment.
- **Knowledge graph linkage**: authors reference fragments using the controlled tag vocabulary, meaning blog posts are implicitly connected to the concept graph. A post about the Neapolitan sixth becomes discoverable from that concept node, and its prose is a candidate for ingestion into a vector store if a Phase 3 reasoning layer is ever built.
- **Authoring UX**: a block-level editor with a fragment picker backed by the fragment DB allows authors to embed notation without writing code.

#### Collections

Registered users can create named, ordered collections of fragments, with optional personal annotations on each entry. Collections serve multiple use cases: class preparation, personal practice repertoire, research notes, thematic browsing.

- **Sharing**: collections can be published as read-only shareable links, or made importable so students can copy a collection into their own workspace.
- **Purpose metadata**: collections carry an optional intent field (e.g. *class preparation*, *practice*, *research*) and free-text description. This is lightweight now but creates a useful signal for instructors and users — and would allow a future reasoning layer to situate its explanations in the user's recent focus.
- **Ordering**: fragment order within a collection is explicit and user-controlled. In instructional collections, this order encodes pedagogical intent; `PREREQUISITE_FOR` edges from the knowledge graph can optionally surface suggestions for sequencing.

#### Exercises

Dynamically generated exercises driven by knowledge graph structure and the fragment database.

- **Exercise definition**: an exercise type is a declarative query against the knowledge graph — a target concept, a discrimination task (e.g. identify cadence type), and a distractor selection rule (e.g. draw distractors from sibling nodes connected by `CONTRASTS_WITH` or `IS_SUBTYPE_OF`). This allows content authors to define new exercise types without writing graph queries by hand.
- **Multiple-choice identification**: given a displayed fragment, identify the tagged concept. Distractors are structurally related concepts drawn from real corpus examples, making them genuinely plausible rather than arbitrary.
- **Listening exercises**: the fragment is played via MIDI without displaying the notation. This exploits the existing audio infrastructure and addresses a skill — aural recognition — that visual exercises cannot train.
- **Progress tracking**: per-user, per-exercise-type accuracy is recorded from launch. Streaks, completion rates, and accuracy trends are surfaced in a simple progress dashboard.
- **Adaptive difficulty (future)**: accuracy data accumulated over time can feed an Elo-style or IRT-based rating system, ordering exercises within each category by empirical difficulty. This feature is planned but gated on having sufficient user data.

---

### 7. The AI Reasoning Layer

The LLM sits on top of all the above and does not operate in isolation. For any given student query, it may:

1. **Retrieve** relevant prose chunks from the vector store (RAG)
2. **Look up** precise definitions and concept relationships by traversing the knowledge graph
3. **Fetch** structured analytical summaries of relevant corpus fragments
4. **Display** MEI-rendered notation and audio to the student via the front-end
5. **Consult** the student's implicit profile — their collection history, exercise accuracy, and reading history — to calibrate explanations to their demonstrated level and recent focus

The model synthesizes across all these sources to produce responses that are grounded in both abstract theory and concrete musical examples. It can reason comparatively ("what's the difference between X and Y?"), sequentially ("what do I need to understand before this?"), and contextually ("what role does this gesture play within the larger form?").

Because the user infrastructure and exercise tracking are built before the AI layer, the tutor inherits a real history of each student from day one of its launch — rather than starting blind.

---

## How the Components Relate

```
MEI Corpus (OpenScore / DCML / other open sources)
        │
        ▼
  Tagging Interface (Verovio)
        │
        ├──► Fragment DB ──────────────────────────────────────────┐
        │     ├── MEI pointers (render/audio)                      │
        │     ├── Structured JSON summaries (analysis)             │
        │     └── Hierarchical tags (→ Knowledge Graph nodes)      │
        │                                                          │
        ├──► Analysis ingestion pipeline (per corpus.analysis_source) │
        │     ├── DCML TSV parsing (primary; Phase 1)              │
        │     ├── When in Rome RomanText (deferred)                │
        │     └── music21 auto-analysis (deferred; Component 6)    │
        │     → movement_analysis.events                           │
        │                                                          ▼
        └──► Expert Annotations ──► Vector Store (RAG prose layer)
                                    ▲         │
                               Blog posts     ▼
                            (concept-tagged) Knowledge Graph ◄──── APPEARS_IN ──── Fragments
                                             (concepts + typed
                                              relationships)
                                                    │
                                    ┌───────────────┼───────────────┐
                                    ▼               ▼               ▼
                                  Blog          Collections      Exercises
                             (scrollytelling,  (user-curated,   (graph-driven,
                              playback)         shareable)       MIDI listening)
                                    │               │               │
                                    └───────────────┼───────────────┘
                                                    ▼
                                           User Infrastructure
                                      (identity, history, progress)
                                                    │
                                                    ▼
                                                LLM Tutor
                                          (student-aware reasoning)
                                                    │
                                              ┌─────┴──────┐
                                              ▼            ▼
                                         Student UI    Reasoning
                                      (notation/audio) (explanation)
```

---

## Key Design Principles

**Separation of rendering and reasoning.** MEI is the source of truth for notation; the AI never reads it directly. Derived JSON representations carry the reasoning load.

**Controlled vocabulary.** Tags and relationship types are not free text — every value references a node in the knowledge graph, ensuring consistency across the entire corpus and making cross-corpus queries reliable. This same vocabulary drives non-AI features: exercise distractor logic, collection sequencing suggestions, and blog concept linkage all depend on it.

**Definitions as relational nodes, not just text.** A concept's meaning is encoded as much in its graph relationships as in its prose definition. Understanding the Neapolitan sixth means knowing it is a predominant, that it intensifies a cadence, that it resolves to V (often via a cadential 6-4), and that it contrasts with the diatonic subdominant — not just reading its definition.

**Pedagogical awareness.** `PREREQUISITE_FOR` edges allow the system to reason about conceptual distance and support appropriately sequenced learning — in exercise ordering, collection construction, and the prerequisite map view, as well as any future AI reasoning layer.

**Layered value delivery.** Each phase of the project delivers usable features without requiring the next phase to be complete. The notation infrastructure is useful to editors before any user features exist. The core user features are a complete product regardless of whether a Phase 3 reasoning layer is ever added.

**Human expertise at every layer.** The quality of the knowledge base is bounded by the richness of the knowledge encoded by human experts — in the tagging, the graph structure, the prose annotations, and the relationship vocabulary. The system amplifies and organises expert knowledge; it does not substitute for it.

**Forward-compatible data design.** User state (exercise accuracy, collection history, reading history) is recorded from the moment those features launch. This data has immediate value for progress tracking and is also the foundation on which a Phase 3 reasoning layer could be built — without requiring a separate data migration at that point.

---

## Development Roadmap

### Phase 1 — Notation Infrastructure

The foundation. All later features depend on a populated, well-tagged fragment database.

- Set up MEI corpus ingestion pipeline from OpenScore and similar sources.
- Build the Verovio-based tagging interface for expert annotators.
- Define the knowledge graph schema and relationship vocabulary; implement the graph database. Seed the Cadence domain first — the seed domain whose modelling decisions established the three-layer architecture. The full planned domain scope is in [`knowledge-graph-domain-map.md`](knowledge-graph-domain-map.md).
- Build the analysis ingestion pipeline. The primary Phase 1 source is DCML TSV (pre-computed harmonic analyses for DCML corpora), dispatched via `ingest_analysis.py`. When in Rome RomanText support is deferred to the first non-DCML corpus; music21 auto-analysis is deferred to Component 6. See [`corpus-and-analysis-sources.md`](corpus-and-analysis-sources.md) for the provenance taxonomy and [`fragment-schema.md`](fragment-schema.md) §"Harmonic analysis: movement-level single source of truth" for the storage pattern.
- Implement the fragment database with MEI pointer storage, JSON summary fields, and hierarchical tag references.
- Build the Verovio rendering component and MIDI playback for the front-end.
- Begin populating the corpus with tagged fragments and concept nodes.

*Deliverable: a working tagging environment and a growing, queryable fragment database. No public-facing product yet, but the core knowledge asset is being built.*

---

### Phase 2 — Non-AI User Features

With a populated fragment database and knowledge graph, non-AI features can launch. User infrastructure is built once and shared across all three.

**User infrastructure**
- Implement authentication (email/OAuth) and user profiles.
- Define role model: anonymous visitor, registered user, editor, administrator.
- Design and implement the user state schema: collection ownership, exercise history, reading history.

**Blog**
- Build the publication CMS with block-level editor and fragment picker.
- Implement scrollytelling layout with Verovio-rendered inline notation.
- Integrate MIDI playback with auto-scroll synchronization.
- Connect blog posts to the knowledge graph via concept tagging; pipeline for ingesting blog prose into the vector store.

**Collections**
- Implement collection creation, ordering, and personal annotation.
- Build sharing: read-only links and importable collections.
- Add optional purpose metadata and description fields.

**Exercises**
- Define the exercise-type schema: declarative graph query + discrimination task + distractor rule.
- Implement multiple-choice identification exercises with graph-driven distractor selection.
- Implement listening exercises (MIDI playback only, notation hidden).
- Build per-user progress tracking and the progress dashboard.
- Populate initial exercise categories authored by domain experts.

*Deliverable: a publicly usable platform. Authors can publish annotated blog posts; registered users can build collections and work through exercises; progress is tracked. This is a complete, useful product in its own right — and one that also happens to lay the groundwork for a Phase 3 reasoning layer if that is pursued.*

---

### Phase 3 — AI Tutoring Layer

With a rich knowledge base, a growing prose corpus, and accumulated user data, the AI layer can be built on solid ground.

- Set up the vector store and RAG pipeline over fragment annotations, concept prose, and blog content.
- Implement knowledge graph traversal tools for the LLM (concept lookup, prerequisite chains, comparative queries).
- Build the LLM reasoning layer with tool-calling over the graph, vector store, and fragment DB.
- Integrate the student profile: the tutor reads exercise history and collection activity to calibrate responses.
- Build the conversational front-end: AI responses rendered alongside notation and audio where relevant.
- Implement adaptive exercise difficulty using accumulated accuracy data (Elo or IRT model).
- Iterative evaluation and refinement of AI response quality with domain expert review.

*Deliverable: a full AI tutoring experience that is grounded in a curated knowledge base, aware of each student's history, and capable of reasoning comparatively and sequentially over music theory concepts and real corpus examples.*

---

## Technology Stack

For tool choices, database topology, SQL schemas, Cypher query patterns, Docker Compose configuration, and production service mapping, see:

**[`tech-stack-and-database-reference.md`](tech-stack-and-database-reference.md)**
