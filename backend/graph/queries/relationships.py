"""Neo4j relationship type constants.

All Cypher queries that reference relationship types must use these constants,
not bare strings. This makes relationship renames safe (grep for the constant)
and keeps the full edge vocabulary visible in one place.

See docs/architecture/edge-vocabulary-reference.md for the authoritative vocabulary
and the usage rules for each type.

Usage in static Cypher strings (bare strings are acceptable there because they are
visually obvious)::

    MATCH (c:Concept)-[:IS_SUBTYPE_OF*0..]->(ancestor:Concept)

Usage when building Cypher programmatically::

    query = f"MATCH (a)-[:{CONTAINS}]->(b) RETURN b"
"""

from __future__ import annotations

# ── Taxonomic / hierarchical ─────────────────────────────────────────────────

IS_SUBTYPE_OF = "IS_SUBTYPE_OF"
"""Directed edge from a more specific concept to its parent type.
Traversed upward (zero-or-more hops) for schema inheritance queries."""

# ── Schema structure ──────────────────────────────────────────────────────────

HAS_PROPERTY_SCHEMA = "HAS_PROPERTY_SCHEMA"
"""Concept → PropertySchema: declares that a concept (and its subtypes) carry this schema."""

HAS_VALUE = "HAS_VALUE"
"""PropertySchema → PropertyValue: the set of allowed values for the schema."""

VALUE_REFERENCES = "VALUE_REFERENCES"
"""PropertyValue → Concept: a value that is itself a reference to another concept node.
Used when a property value selects a concept (e.g. SopranoPosition → ScaleDegree1 → Concept)."""

# ── Compositional / structural ────────────────────────────────────────────────

CONTAINS = "CONTAINS"
"""Concept → Concept: declares that a concept structurally contains a sub-concept.
Carries ``order`` (int) and ``required`` (bool) edge properties.
Used to drive the sub-part tagging UI (Component 5.4)."""

# ── Voice-leading / harmonic resolution ──────────────────────────────────────

RESOLVES_TO = "RESOLVES_TO"
"""Concept → Concept: directional resolution relationship between harmonic entities
(e.g. Dominant → Tonic). Used in prerequisite chain and exercise generation queries."""

# ── Pedagogical ordering ─────────────────────────────────────────────────────

PREREQUISITE_FOR = "PREREQUISITE_FOR"
"""Concept → Concept: concept A is a prerequisite for understanding concept B.
Traversed backward (one-or-more hops) to build prerequisite chains for sequencing."""
