/**
 * conceptRelationships tests — Component 11 Step 5.
 *
 * The parts of the concept page's relationship display worth pinning
 * independently of the DOM: the symmetric-edge merge, the block ordering, and
 * the label fallback for an edge type with no translation.
 */

import { describe, expect, it } from 'vitest';
import type { ConceptRelationship } from '../../services/glossaryApi';
import { groupRelationships, humaniseType, relationshipLabel } from '../conceptRelationships';

function rel(
  type: string,
  direction: 'outgoing' | 'incoming',
  target: { id: string; name: string; stub?: boolean }
): ConceptRelationship {
  return { type, direction, target: { stub: false, ...target } };
}

describe('groupRelationships', () => {
  it('merges the two stored directions of a symmetric edge type', () => {
    const groups = groupRelationships([
      rel('CONTRASTS_WITH', 'outgoing', { id: 'HalfCadence', name: 'Half Cadence' }),
      rel('CONTRASTS_WITH', 'incoming', { id: 'DeceptiveCadence', name: 'Deceptive Cadence' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].direction).toBe('symmetric');
    expect(groups[0].targets.map((target) => target.id)).toEqual([
      'HalfCadence',
      'DeceptiveCadence',
    ]);
  });

  it('shows a target once when a symmetric edge surfaces from both ends', () => {
    const groups = groupRelationships([
      rel('IS_EQUIVALENT_TO', 'outgoing', { id: 'Monte', name: 'Monte' }),
      rel('IS_EQUIVALENT_TO', 'incoming', { id: 'Monte', name: 'Monte' }),
    ]);

    expect(groups[0].targets).toHaveLength(1);
  });

  it('keeps directional types in separate groups, outgoing first', () => {
    const groups = groupRelationships([
      rel('PRECEDES', 'incoming', { id: 'A', name: 'A' }),
      rel('PRECEDES', 'outgoing', { id: 'B', name: 'B' }),
    ]);

    expect(groups.map((group) => group.direction)).toEqual(['outgoing', 'incoming']);
  });

  it('orders groups structurally, with unknown edge types last', () => {
    const groups = groupRelationships([
      rel('SOME_NEW_EDGE', 'outgoing', { id: 'X', name: 'X' }),
      rel('PREREQUISITE_FOR', 'outgoing', { id: 'Y', name: 'Y' }),
      rel('CONTAINS', 'outgoing', { id: 'Z', name: 'Z' }),
    ]);

    expect(groups.map((group) => group.type)).toEqual([
      'CONTAINS',
      'PREREQUISITE_FOR',
      'SOME_NEW_EDGE',
    ]);
  });

  it('preserves stub flags on targets so the page can mark them', () => {
    const groups = groupRelationships([
      rel('RESOLVES_TO', 'outgoing', { id: 'Sequence', name: 'Sequence', stub: true }),
    ]);

    expect(groups[0].targets[0].stub).toBe(true);
  });
});

describe('humaniseType', () => {
  it('turns a SCREAMING_SNAKE edge type into prose', () => {
    expect(humaniseType('PREREQUISITE_FOR')).toBe('Prerequisite for');
    expect(humaniseType('CONTAINS')).toBe('Contains');
  });
});

describe('relationshipLabel', () => {
  it('looks the label up under the direction-specific key', () => {
    const seen: string[] = [];
    const t = (key: string) => {
      seen.push(key);
      return 'Resolves to';
    };
    const [group] = groupRelationships([
      rel('RESOLVES_TO', 'outgoing', { id: 'Tonic', name: 'Tonic' }),
    ]);

    expect(relationshipLabel(t, group)).toBe('Resolves to');
    expect(seen).toEqual(['public:glossary.relationships.RESOLVES_TO.outgoing']);
  });

  it('falls back to the humanised type when the key is untranslated', () => {
    // Stand-in for i18next's defaultValue behaviour on a missing key.
    const t = (_key: string, options?: Record<string, unknown>) =>
      String(options?.defaultValue ?? '');
    const [group] = groupRelationships([rel('SOME_NEW_EDGE', 'outgoing', { id: 'X', name: 'X' })]);

    expect(relationshipLabel(t, group)).toBe('Some new edge');
  });
});
