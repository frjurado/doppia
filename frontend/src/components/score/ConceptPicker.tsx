/**
 * Concept picker — tagging-tool-design.md §7.1.
 *
 * Provides three navigation paths for finding a concept:
 *  1. Search box — debounced full-text search against the concept_search index.
 *  2. Domain facets — pill buttons that narrow results to a single domain.
 *  3. Hierarchy path — each result card shows its ancestor chain so the
 *     annotator can orient within the graph without a separate browse endpoint.
 *
 * The server already filters to stub=false AND top_level_taggable=true;
 * the client never re-introduces excluded nodes (ADR-011 §5).
 *
 * The component is uncontrolled with respect to the query string but controlled
 * with respect to the selected concept (the parent owns selection state so that
 * FormPanel can wire session.setConceptSet and drive stage pre-population).
 *
 * References: tagging-tool-design.md §7.1, ADR-011 §5.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { searchConcepts } from '../../services/conceptApi';
import type { ConceptSearchHit } from '../../services/conceptApi';
import Type from '../ui/Type';
import styles from './ConceptPicker.module.css';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Debounce delay for the search box in milliseconds. */
const DEBOUNCE_MS = 300;

/**
 * Known domain filter labels for Phase 1. The cadences domain is the only one
 * seeded in Phase 1; the list can be extended as further domains are added.
 * Keys are the domain string sent to the API; values are the display label.
 */
const DOMAINS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'cadences', label: 'Cadences' },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConceptPickerProps {
  /** Currently selected concept id, or null. */
  selectedConceptId: string | null;
  /** Called when the user selects or deselects a concept. */
  onSelect: (concept: ConceptSearchHit | null) => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/**
 * Displays a concept's ancestor chain as breadcrumb-style text.
 * e.g. "Cadence › Authentic Cadence" for PerfectAuthenticCadence.
 */
function HierarchyPath({ path }: { path: string[] }) {
  const { t } = useTranslation('score');
  if (path.length === 0) return null;
  return (
    <span
      className={styles.hierarchyPath}
      aria-label={t('conceptPicker.underPath', { path: path.join(' › ') })}
    >
      {path.join(' › ')}
    </span>
  );
}

/** A single result card in the search results list. */
function ConceptCard({
  concept,
  isSelected,
  onSelect,
}: {
  concept: ConceptSearchHit;
  isSelected: boolean;
  onSelect: (c: ConceptSearchHit) => void;
}) {
  const { t } = useTranslation('score');
  const aliasSnippet =
    concept.aliases.length > 0
      ? concept.aliases.slice(0, 2).join(', ')
      : null;

  return (
    <button
      type="button"
      className={[styles.conceptCard, isSelected ? styles.conceptCardSelected : '']
        .filter(Boolean)
        .join(' ')}
      onClick={() => onSelect(concept)}
      aria-pressed={isSelected}
      data-testid={`concept-card-${concept.id}`}
    >
      <span className={styles.conceptCardHeader}>
        <Type variant="label-md" as="span" className={styles.conceptName}>
          {concept.name}
        </Type>
        {isSelected && (
          <span className={styles.selectedBadge} aria-label={t('conceptPicker.selected')}>✓</span>
        )}
      </span>
      {aliasSnippet && (
        <span className={styles.aliases}>{aliasSnippet}</span>
      )}
      <HierarchyPath path={concept.hierarchy_path} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// ConceptPicker
// ---------------------------------------------------------------------------

export default function ConceptPicker({ selectedConceptId, onSelect }: ConceptPickerProps) {
  const { t } = useTranslation('score');
  const [query, setQuery] = useState('');
  const [activeDomain, setActiveDomain] = useState<string | null>(null);
  const [results, setResults] = useState<ConceptSearchHit[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Search whenever query or domain changes, debounced.
  const triggerSearch = useCallback(
    (q: string, domain: string | null) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (!q.trim()) {
        setResults([]);
        setError(null);
        setIsLoading(false);
        return;
      }
      debounceRef.current = setTimeout(async () => {
        // Abort any in-flight request.
        abortRef.current?.abort();
        abortRef.current = new AbortController();

        setIsLoading(true);
        setError(null);
        try {
          const page = await searchConcepts(q.trim(), domain);
          setResults(page.items);
        } catch (err) {
          if ((err as Error).name !== 'AbortError') {
            setError(t('conceptPicker.searchFailed'));
            setResults([]);
          }
        } finally {
          setIsLoading(false);
        }
      }, DEBOUNCE_MS);
    },
    [t],
  );

  useEffect(() => {
    triggerSearch(query, activeDomain);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, activeDomain, triggerSearch]);

  const handleQueryChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setQuery(e.target.value);
  };

  const handleDomainToggle = (key: string) => {
    setActiveDomain(prev => (prev === key ? null : key));
  };

  const handleSelect = (concept: ConceptSearchHit) => {
    if (concept.id === selectedConceptId) {
      // Clicking the selected concept deselects it.
      onSelect(null);
    } else {
      onSelect(concept);
    }
  };

  const handleClear = () => {
    setQuery('');
    setResults([]);
    onSelect(null);
  };

  const hasQuery = query.trim().length > 0;

  return (
    <div className={styles.picker} data-testid="concept-picker">
      {/* Search box */}
      <div className={styles.searchRow}>
        <input
          type="search"
          className={styles.searchInput}
          placeholder={t('conceptPicker.searchPlaceholder')}
          value={query}
          onChange={handleQueryChange}
          aria-label={t('conceptPicker.searchAria')}
          autoComplete="off"
          data-testid="concept-search-input"
        />
        {(hasQuery || selectedConceptId) && (
          <button
            type="button"
            className={styles.clearButton}
            onClick={handleClear}
            aria-label={t('conceptPicker.clearSelection')}
          >
            ✕
          </button>
        )}
      </div>

      {/* Domain facets */}
      <div className={styles.facets} role="group" aria-label={t('conceptPicker.domainFilter')}>
        <button
          type="button"
          className={[styles.facetPill, activeDomain === null ? styles.facetPillActive : '']
            .filter(Boolean)
            .join(' ')}
          onClick={() => setActiveDomain(null)}
          aria-pressed={activeDomain === null}
        >
          <Type variant="label-sm" as="span">{t('conceptPicker.all')}</Type>
        </button>
        {DOMAINS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            className={[
              styles.facetPill,
              activeDomain === key ? styles.facetPillActive : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => handleDomainToggle(key)}
            aria-pressed={activeDomain === key}
            data-testid={`facet-${key}`}
          >
            <Type variant="label-sm" as="span">{label}</Type>
          </button>
        ))}
      </div>

      {/* Results area */}
      <div className={styles.results} role="list" aria-label={t('conceptPicker.resultsAria')}>
        {isLoading && (
          <Type variant="label-sm" as="p" className={styles.statusMsg}>
            {t('common:searching')}
          </Type>
        )}
        {!isLoading && error && (
          <Type variant="label-sm" as="p" className={styles.errorMsg} role="alert">
            {error}
          </Type>
        )}
        {!isLoading && !error && hasQuery && results.length === 0 && (
          <Type variant="label-sm" as="p" className={styles.statusMsg}>
            {t('conceptPicker.noConceptsFound')}
          </Type>
        )}
        {!isLoading && !error && !hasQuery && !selectedConceptId && (
          <Type variant="label-sm" as="p" className={styles.statusMsg}>
            {t('conceptPicker.typeToSearch')}
          </Type>
        )}
        {results.map(concept => (
          <div key={concept.id} role="listitem">
            <ConceptCard
              concept={concept}
              isSelected={concept.id === selectedConceptId}
              onSelect={handleSelect}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
