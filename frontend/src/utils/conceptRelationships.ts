/**
 * Typed-relationship display helpers for the concept glossary — Component 11
 * Step 5.
 *
 * The public concept payload returns one entry per edge, each carrying its type
 * and the direction it was traversed in. The concept page renders those as
 * labelled blocks, which needs three decisions this module owns: which edge
 * types are undirected (so both directions collapse into one block), what order
 * the blocks appear in, and what an edge type is called in prose.
 *
 * Kept out of the route file so the ordering and the symmetric merge can be
 * unit-tested directly, and so the Step 7 index can reuse them if it needs to.
 *
 * Reference: docs/architecture/edge-vocabulary-reference.md
 */

import type { ConceptRef, ConceptRelationship } from '../services/glossaryApi';

/**
 * Edge types that are undirected by convention (edge-vocabulary-reference.md
 * § Conventions § Undirected edges). The stored direction is an artefact of
 * which way the edge was seeded and carries no meaning, so both directions
 * collapse into a single display block.
 */
const SYMMETRIC_TYPES = new Set(['CONTRASTS_WITH', 'IS_EQUIVALENT_TO']);

/**
 * Display order for relationship blocks: structural first, then syntactic,
 * then harmonic, comparative, and pedagogical. A type outside this list (a new
 * edge type seeded before this module learns about it) sorts last,
 * alphabetically, rather than disappearing.
 */
const TYPE_ORDER = [
  'CONTAINS',
  'PRECEDES',
  'FOLLOWS',
  'RESOLVES_TO',
  'CONTRASTS_WITH',
  'IS_EQUIVALENT_TO',
  'PREREQUISITE_FOR',
];

export type RelationshipDirection = 'outgoing' | 'incoming' | 'symmetric';

/** One rendered relationship block: a heading and the concepts under it. */
export interface RelationshipGroup {
  /** Stable React key — `${type}:${direction}`. */
  key: string;
  type: string;
  direction: RelationshipDirection;
  targets: ConceptRef[];
}

/** Minimal shape of the i18next `t` used here — a key plus a default value. */
export type Translate = (key: string, options?: Record<string, unknown>) => string;

/**
 * Group typed relationships for display: one block per (type, direction), with
 * the two directions of a symmetric type merged and duplicate targets removed.
 *
 * @param relationships The payload's `relationships` array, in any order.
 * @returns Display blocks in {@link TYPE_ORDER}, outgoing before incoming.
 */
export function groupRelationships(relationships: ConceptRelationship[]): RelationshipGroup[] {
  const groups = new Map<string, RelationshipGroup>();

  for (const rel of relationships) {
    const direction: RelationshipDirection = SYMMETRIC_TYPES.has(rel.type)
      ? 'symmetric'
      : rel.direction;
    const key = `${rel.type}:${direction}`;
    let group = groups.get(key);
    if (!group) {
      group = { key, type: rel.type, direction, targets: [] };
      groups.set(key, group);
    }
    // A symmetric edge can surface from both ends; show each concept once.
    if (!group.targets.some((target) => target.id === rel.target.id)) {
      group.targets.push(rel.target);
    }
  }

  const orderOf = (type: string) => {
    const index = TYPE_ORDER.indexOf(type);
    return index === -1 ? TYPE_ORDER.length : index;
  };

  return [...groups.values()].sort((a, b) => {
    const byType = orderOf(a.type) - orderOf(b.type) || a.type.localeCompare(b.type);
    if (byType !== 0) return byType;
    // Outgoing before incoming; a symmetric group never collides with either.
    return a.direction === 'outgoing' ? -1 : 1;
  });
}

/**
 * Human-readable fallback for an edge type with no translated label —
 * "PREREQUISITE_FOR" → "Prerequisite for". Keeps a not-yet-translated edge
 * type readable instead of shouting SCREAMING_SNAKE at a public reader.
 */
export function humaniseType(type: string): string {
  const words = type.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Resolve a block's heading from the `public` namespace, falling back to the
 * humanised edge type.
 *
 * @param t     The i18next `t` bound to a namespace list including `public`.
 * @param group The block to label.
 */
export function relationshipLabel(t: Translate, group: RelationshipGroup): string {
  return t(`public:glossary.relationships.${group.type}.${group.direction}`, {
    defaultValue: humaniseType(group.type),
  });
}
