# Extended Features — Design Ideas

> **Status: Phase 2+ brainstorm.** This document is not a specification and does not belong to the Phase 1 build. It collects design ideas for features that become possible once the Phase 1 and Phase 2 foundations are in place. Nothing here is committed, prioritised, or guaranteed to ship. It exists to think through what the data model and graph structure make possible, so that Phase 1 decisions are made with this horizon in mind.

These features extend the platform beyond the core blog, collections, and multiple-choice exercises. All of them are enabled directly by infrastructure already committed to in Phase 1 and Phase 2: the typed knowledge graph, structured fragment JSONB summaries, Verovio rendering, MIDI playback, and per-user exercise history. None require a Phase 3 reasoning layer to function.

---

## Concept Reference & Navigation

### Concept Glossary with Inline Examples

A browsable reference where every concept node in the knowledge graph becomes a page. Each page surfaces the concept's prose definition, its position in the type hierarchy, its typed relationships to other concepts (`RESOLVES_TO`, `CONTRASTS_WITH`, `IMPLIES`, and so on), and a curated set of corpus fragments tagged with that concept rendered inline via Verovio with MIDI playback. The glossary requires no bespoke content authoring: it is generated automatically from the graph and fragment database. The `APPEARS_IN` edges do the curation work; the fragment rendering infrastructure handles display.

### Prerequisite Map

A visual display of the `PREREQUISITE_FOR` chain leading to any given concept, showing what a student needs to understand before tackling a topic. Because this relationship is explicit graph structure, the map can be rendered as a navigable tree or dependency diagram via Cytoscape.js without any AI inference. It is useful for self-directed students who want to know where to begin, and for instructors designing a curriculum sequence. The view is a partial subgraph — only `PREREQUISITE_FOR` edges, traversed from a given concept toward its prerequisites.

### Concept Neighbourhood Explorer

A small interactive graph view centered on any concept, showing its immediate neighbourhood: siblings, subtypes, what it contrasts with, what it implies, what it resolves to. This is the embedded Cytoscape.js visualization already specified in the architecture — a FastAPI endpoint returns the relevant subgraph in Cytoscape JSON format, and the frontend renders it interactively. Like the prerequisite map, it is a partial graph view, scoped to the most pedagogically relevant edge types for the concept in question. A student can open it from any concept mention in a blog post or glossary entry and immediately see how that concept sits in the broader theoretical landscape.

---

## Analytical Practice

### Error Detection

A fragment is displayed with notation and playback, accompanied by a deliberately introduced analytical error — a wrong Roman numeral, a misidentified cadence type, an incorrect property value. The student must find and correct it. Distractors are drawn from sibling concept nodes connected by `CONTRASTS_WITH` or `IS_SUBTYPE_OF` edges, making errors genuinely plausible rather than obvious. This exercises a different cognitive skill than identification tasks: the student must hold the correct analysis in mind and compare it against what is presented, rather than simply categorising from scratch. The exercise type requires no AI; the graph structure provides both the distractor pool and the answer key.

### Comparative Analysis Tasks

Two fragments are presented side by side — both instances of the same concept, but differing along one specific property dimension (soprano position, elaboration type, or another `PropertySchema`). The student is asked to articulate what distinguishes them. The `CONTRASTS_WITH` edges in the knowledge graph naturally surface good pairings, and the structured property records on each fragment make it possible to select pairs that share a concept but diverge in exactly one analytically meaningful way. This is one of the more distinctive affordances of the structured data model: the comparison is principled and specific rather than impressionistic.

### Sequencing / Ordering Exercises

A set of fragments representing the stages of a formal unit — opening gesture, continuation, cadence, for example — is presented in scrambled order. The student reconstructs the correct sequence. The `CONTAINS` edges on concept nodes, which carry explicit `order` and `required` properties, provide the answer key. This exercise type is more cognitively demanding than identification tasks and engages students' understanding of formal syntax and phrase rhythm rather than just harmonic vocabulary. It is correspondingly more difficult to design well, since the fragments must be drawn from real passages whose stages are cleanly separable.

---

## Listening-Focused Practice

### Melodic Dictation Scaffolding

A fragment is played without displaying the notation, and the student answers a stepped sequence of questions about what they hear: scale degree, interval quality, melodic contour, and similar features. The stepped MCQ format scaffolds the task — each question narrows the range of what the student needs to identify at once, making the exercise approachable before full dictation is realistic. The structured JSON summary provides the ground truth for all steps without requiring AI to evaluate free-form transcription. This format is more tractable to implement than open-ended dictation, and more pedagogically explicit about what the student is listening for.

### Comparative Listening

Two fragments are played in sequence without notation. The student is asked which uses a specific harmonic or formal device — an applied dominant, a cadential 6-4, a deceptive resolution. The system selects one fragment tagged with the target concept and one drawn from structurally similar context without it, ensuring the comparison is musically coherent rather than arbitrary. This exercises aural discrimination grounded in conceptual knowledge: the student must know not just that something sounds different, but what the relevant theoretical difference is and how to hear it.

---

## Instructor Tools

### Presentation Mode for Collections

An instructor can walk through a collection fragment by fragment in class: full-screen notation display, playback controls, and concept annotations togglable on or off. This is essentially a slideshow mode over a collection, but with Verovio rendering and MIDI playback built into every slide. An instructor prepares a class session by curating a collection — choosing fragments, setting the order, writing optional annotations — and then presents directly from the platform without switching to a separate tool. The feature requires no new data model; it is a display mode layered on top of the existing collection infrastructure.

### Worksheet Export

A collection can be exported as a printable PDF: notation staves rendered from Verovio, blank space below each fragment for written analysis, and optional partial Roman numeral labels for fill-in exercises. This makes the fragment database directly useful for traditional homework assignments and exam preparation, bridging the platform's digital infrastructure with paper-based pedagogy. Verovio's server-side rendering pipeline makes the generation straightforward.

---

## Self-Paced Learning Structures

### Concept Mastery Tracker and Spaced Repetition Review Queue

These two features are two sides of the same coin: one surfaces where a student stands; the other drives them forward.

The **concept mastery tracker** is a per-user view showing which concept nodes the student has exercised, their accuracy rate on each, and which sibling or prerequisite concepts they have not yet encountered. It is a dashboard over the `exercise_result` table joined against the concept graph, and it gives students and instructors a structured picture of what is known, what is partially known, and what remains untouched.

The **spaced repetition review queue** uses the same accuracy data to schedule review. Concepts answered incorrectly or not seen recently are surfaced as review items; correctly-answered recent concepts recede. A straightforward scheduling algorithm — SM-2 or a Leitner-style bucket system — operates over the existing exercise history without any AI involvement. Because exercise history is recorded from the first day Phase 2 launches, both features can go live with real data the moment they are built, rather than starting from a blank slate.

Together they constitute the platform's primary mechanism for sustained, structured learning over time: the tracker shows the map; the review queue provides the daily route.
