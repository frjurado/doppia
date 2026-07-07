/**
 * stripEmbeddedCatalogue tests — Component 9 J2 (catalogue shown twice).
 */

import { describe, expect, it } from 'vitest';
import { stripEmbeddedCatalogue } from '../workTitle';

describe('stripEmbeddedCatalogue', () => {
  it('strips a comma-separated trailing catalogue number', () => {
    expect(stripEmbeddedCatalogue('Piano Sonata No. 11 in A major, K. 331', 'K. 331')).toBe(
      'Piano Sonata No. 11 in A major'
    );
  });

  it('strips a space-separated trailing catalogue number', () => {
    expect(stripEmbeddedCatalogue('Symphony No. 40 K. 550', 'K. 550')).toBe('Symphony No. 40');
  });

  it('returns the title unchanged when catalogue_number is null', () => {
    expect(stripEmbeddedCatalogue('Piano Sonata', null)).toBe('Piano Sonata');
  });

  it('returns the title unchanged when it does not end with the catalogue number', () => {
    expect(stripEmbeddedCatalogue('Piano Sonata', 'K. 331')).toBe('Piano Sonata');
  });
});
