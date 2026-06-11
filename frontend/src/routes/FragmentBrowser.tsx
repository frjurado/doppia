import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { ApiError } from '../services/api';
import { ConceptTreeNode, getConceptTree } from '../services/conceptApi';
import { ConceptBrowseItem, listByConcept } from '../services/fragmentApi';
import styles from './FragmentBrowser.module.css';

// ---------------------------------------------------------------------------
// Tree building helpers
// ---------------------------------------------------------------------------

/** Assemble the flat node list into a children map keyed by parent_id. */
function buildChildrenMap(nodes: ConceptTreeNode[]): Map<string | null, ConceptTreeNode[]> {
  const map = new Map<string | null, ConceptTreeNode[]>();
  for (const node of nodes) {
    const key = node.parent_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(node);
  }
  return map;
}

// ---------------------------------------------------------------------------
// TreeNode component
// ---------------------------------------------------------------------------

interface TreeNodeProps {
  node: ConceptTreeNode;
  childrenMap: Map<string | null, ConceptTreeNode[]>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  depth: number;
}

function TreeNode({ node, childrenMap, selectedId, onSelect, depth }: TreeNodeProps) {
  const children = childrenMap.get(node.id) ?? [];
  const hasChildren = children.length > 0;
  const isSelected = node.id === selectedId;
  // Expand by default if the selected node is a descendant.
  const [expanded, setExpanded] = useState(true);

  const label = node.aliases.length > 0 ? node.aliases[0] : node.name;
  const showAlias = node.aliases.length > 0 && node.aliases[0] !== node.name;

  return (
    <div className={styles.treeNode}>
      <button
        type="button"
        className={styles.treeRow}
        data-selected={isSelected}
        style={{ paddingLeft: `calc(var(--spacing-4) + ${depth * 16}px)` }}
        onClick={() => onSelect(node.id)}
        aria-current={isSelected ? 'true' : undefined}
      >
        {hasChildren && (
          <span
            className={styles.treeToggle}
            role="button"
            aria-label={expanded ? 'Collapse' : 'Expand'}
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? '▾' : '▸'}
          </span>
        )}
        {!hasChildren && <span className={styles.treeTogglePlaceholder} />}
        <span className={styles.treeLabel}>
          {showAlias && (
            <Type variant="label-sm" as="span" className={styles.treeAlias}>
              {label}
            </Type>
          )}
          <Type variant="body-sm" as="span">
            {node.name}
          </Type>
        </span>
        {node.fragment_count > 0 && (
          <Type
            variant="label-sm"
            as="span"
            className={styles.treeCount}
            style={{ color: 'var(--color-on-surface-variant)' }}
          >
            {node.fragment_count}
          </Type>
        )}
      </button>

      {hasChildren && expanded && (
        <div className={styles.treeChildren}>
          {children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              childrenMap={childrenMap}
              selectedId={selectedId}
              onSelect={onSelect}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Fragment preview card
// ---------------------------------------------------------------------------

interface FragmentCardProps {
  item: ConceptBrowseItem;
  onOpen: (id: string) => void;
}

function FragmentCard({ item, onOpen }: FragmentCardProps) {
  const conceptLabel = item.primary_concept_alias ?? item.primary_concept_name ?? '—';
  const barRange = `mm. ${item.bar_start}–${item.bar_end}`;
  const workLabel = `${item.work_title}${item.work_catalogue_number ? ` ${item.work_catalogue_number}` : ''}`;
  const movementLabel = `mvt. ${item.movement_number}${item.movement_title ? ` · ${item.movement_title}` : ''}`;

  return (
    <button
      type="button"
      className={styles.fragmentCard}
      onClick={() => onOpen(item.id)}
      aria-label={`Open fragment ${conceptLabel} ${barRange}`}
    >
      <div className={styles.previewArea}>
        {item.preview_url ? (
          <img
            src={item.preview_url}
            alt=""
            className={styles.previewImage}
            loading="lazy"
          />
        ) : (
          <div className={styles.previewPlaceholder}>
            <Type
              variant="label-sm"
              as="span"
              style={{ color: 'var(--color-on-surface-variant)' }}
            >
              Preview generating…
            </Type>
          </div>
        )}
      </div>
      <div className={styles.fragmentMeta}>
        <Type variant="body-sm" as="span" className={styles.fragmentConcept}>
          {conceptLabel}
        </Type>
        <Type
          variant="label-sm"
          as="span"
          style={{ color: 'var(--color-on-surface-variant)' }}
        >
          {item.composer_name} · {workLabel}
        </Type>
        <Type
          variant="label-sm"
          as="span"
          style={{ color: 'var(--color-on-surface-variant)' }}
        >
          {movementLabel} · {barRange}
        </Type>
        <div className={styles.fragmentBadges}>
          <span className={styles.statusBadge} data-status={item.status}>
            <Type variant="label-sm" as="span">
              {item.status}
            </Type>
          </span>
          {item.data_licence && (
            <Type
              variant="label-sm"
              as="span"
              style={{ color: 'var(--color-on-surface-variant)', opacity: 0.7 }}
            >
              {item.data_licence}
            </Type>
          )}
        </div>
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

/**
 * Fragment browser: concept-tree navigator (left) + fragment list (right).
 *
 * URL params:
 *   root    — concept id used as the tree root (e.g. "Cadence")
 *   concept — currently selected concept id (drives the right panel)
 *
 * Component 8 Step 7.
 */
export default function FragmentBrowser() {
  usePageTitle('Fragment Browser — Doppia');
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const rootId = searchParams.get('root');
  const conceptId = searchParams.get('concept');

  // ---- tree state ----
  const [treeNodes, setTreeNodes] = useState<ConceptTreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<ApiError | null>(null);

  // ---- root search state ----
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<{ id: string; name: string }[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- fragment list state ----
  const [fragments, setFragments] = useState<ConceptBrowseItem[]>([]);
  const [fragmentsNextCursor, setFragmentsNextCursor] = useState<string | null>(null);
  const [fragmentsLoading, setFragmentsLoading] = useState(false);
  const [fragmentsError, setFragmentsError] = useState<ApiError | null>(null);
  const [includeSubtypes, setIncludeSubtypes] = useState(true);
  const [statusFilter] = useState<'approved' | 'submitted' | 'draft' | 'rejected'>('approved');

  // ---- load tree when root changes ----
  useEffect(() => {
    if (!rootId) {
      setTreeNodes([]);
      return;
    }
    setTreeLoading(true);
    setTreeError(null);
    getConceptTree(rootId)
      .then((res) => setTreeNodes(res.nodes))
      .catch((err) => {
        if (err instanceof ApiError) setTreeError(err);
      })
      .finally(() => setTreeLoading(false));
  }, [rootId]);

  // ---- debounced root search ----
  const handleSearchChange = useCallback((value: string) => {
    setSearchQuery(value);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    if (!value.trim()) {
      setSearchResults([]);
      return;
    }
    searchTimerRef.current = setTimeout(async () => {
      setSearchLoading(true);
      try {
        const { searchConcepts } = await import('../services/conceptApi');
        const page = await searchConcepts(value.trim());
        setSearchResults(page.items.map((h) => ({ id: h.id, name: h.name })));
      } catch {
        setSearchResults([]);
      } finally {
        setSearchLoading(false);
      }
    }, 300);
  }, []);

  const pickRoot = useCallback(
    (id: string) => {
      setSearchQuery('');
      setSearchResults([]);
      setSearchParams((p) => {
        const next = new URLSearchParams(p);
        next.set('root', id);
        next.delete('concept');
        return next;
      });
    },
    [setSearchParams],
  );

  // ---- load fragments when selected concept changes ----
  const loadFragments = useCallback(
    async (cursor?: string) => {
      if (!conceptId) return;
      const isFirstPage = cursor === undefined;
      if (isFirstPage) setFragmentsLoading(true);
      setFragmentsError(null);
      try {
        const res = await listByConcept(conceptId, {
          includeSubtypes,
          status: statusFilter,
          cursor,
        });
        setFragments((prev) => (isFirstPage ? res.items : [...prev, ...res.items]));
        setFragmentsNextCursor(res.next_cursor);
      } catch (err) {
        if (err instanceof ApiError) setFragmentsError(err);
      } finally {
        if (isFirstPage) setFragmentsLoading(false);
      }
    },
    [conceptId, includeSubtypes, statusFilter],
  );

  useEffect(() => {
    setFragments([]);
    setFragmentsNextCursor(null);
    if (conceptId) loadFragments();
  }, [conceptId, includeSubtypes, statusFilter]); // eslint-disable-line react-hooks/exhaustive-deps

  const childrenMap = useMemo(() => buildChildrenMap(treeNodes), [treeNodes]);
  const roots = childrenMap.get(null) ?? [];

  const selectConcept = useCallback(
    (id: string) => {
      setSearchParams((p) => {
        const next = new URLSearchParams(p);
        next.set('concept', id);
        return next;
      });
    },
    [setSearchParams],
  );

  const selectedNode = treeNodes.find((n) => n.id === conceptId) ?? null;

  const openFragment = useCallback(
    (id: string) => {
      navigate(`/fragments/${id}`);
    },
    [navigate],
  );

  return (
    <Surface layer="base" className={styles.page}>
      <div className={styles.body}>
        {/* Left: concept tree panel */}
        <Surface layer="container-lowest" className={styles.treePanel}>
          <div className={styles.treePanelHeader}>
            <Type variant="label-md" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
              Concepts
            </Type>
          </div>

          {/* Root search */}
          <div className={styles.searchBox}>
            <input
              type="search"
              className={styles.searchInput}
              placeholder="Search for a concept root…"
              value={searchQuery}
              onChange={(e) => handleSearchChange(e.target.value)}
              aria-label="Search concept roots"
            />
            {(searchResults.length > 0 || searchLoading) && (
              <Surface layer="container-highest" floating className={styles.searchDropdown}>
                {searchLoading && (
                  <div className={styles.searchItem}>
                    <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
                      Searching…
                    </Type>
                  </div>
                )}
                {searchResults.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={styles.searchItem}
                    onClick={() => pickRoot(r.id)}
                  >
                    <Type variant="body-sm" as="span">{r.name}</Type>
                    <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
                      {r.id}
                    </Type>
                  </button>
                ))}
              </Surface>
            )}
          </div>

          {/* Tree */}
          <div className={styles.treeScroll}>
            {treeLoading && (
              <div className={styles.treeEmpty}>
                <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
                  Loading…
                </Type>
              </div>
            )}
            {treeError && (
              <div className={styles.treeEmpty}>
                <Type variant="label-sm" as="span" style={{ color: 'var(--color-error)' }}>
                  {treeError.message}
                </Type>
              </div>
            )}
            {!treeLoading && !treeError && !rootId && (
              <div className={styles.treeEmpty}>
                <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
                  Search for a concept to browse
                </Type>
              </div>
            )}
            {!treeLoading && roots.map((root) => (
              <TreeNode
                key={root.id}
                node={root}
                childrenMap={childrenMap}
                selectedId={conceptId}
                onSelect={selectConcept}
                depth={0}
              />
            ))}
          </div>
        </Surface>

        {/* Right: fragment list panel */}
        <div className={styles.listPanel}>
          {conceptId ? (
            <>
              <div className={styles.listHeader}>
                <div className={styles.listHeaderLeft}>
                  {selectedNode && (
                    <Type variant="title" as="span">
                      {selectedNode.name}
                    </Type>
                  )}
                  {selectedNode?.aliases.length ? (
                    <Type
                      variant="label-sm"
                      as="span"
                      style={{ color: 'var(--color-on-surface-variant)' }}
                    >
                      {selectedNode.aliases.join(' · ')}
                    </Type>
                  ) : null}
                </div>
                <label className={styles.subtypesToggle}>
                  <input
                    type="checkbox"
                    checked={includeSubtypes}
                    onChange={(e) => setIncludeSubtypes(e.target.checked)}
                  />
                  <Type variant="label-sm" as="span">
                    Include subtypes
                  </Type>
                </label>
              </div>

              <div className={styles.listScroll}>
                {fragmentsLoading && (
                  <div className={styles.listEmpty}>
                    <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
                      Loading fragments…
                    </Type>
                  </div>
                )}
                {fragmentsError && (
                  <div className={styles.listEmpty}>
                    <Type variant="label-sm" as="span" style={{ color: 'var(--color-error)' }}>
                      {fragmentsError.message}
                    </Type>
                  </div>
                )}
                {!fragmentsLoading && !fragmentsError && fragments.length === 0 && (
                  <div className={styles.listEmpty}>
                    <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
                      No approved fragments found
                    </Type>
                  </div>
                )}
                {fragments.map((item) => (
                  <FragmentCard key={item.id} item={item} onOpen={openFragment} />
                ))}
                {fragmentsNextCursor && !fragmentsLoading && (
                  <div className={styles.loadMore}>
                    <button
                      type="button"
                      className={styles.loadMoreButton}
                      onClick={() => loadFragments(fragmentsNextCursor)}
                    >
                      <Type variant="label-sm" as="span">Load more</Type>
                    </button>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className={styles.listEmpty}>
              <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
                {rootId ? 'Select a concept from the tree' : 'Search for a concept to get started'}
              </Type>
            </div>
          )}
        </div>
      </div>
    </Surface>
  );
}
