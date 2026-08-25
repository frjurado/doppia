/**
 * Public glossary index — Component 11 Step 7.
 *
 * The anonymous entry surface into the glossary: a browse-by-domain hierarchy of
 * concept links at `/glossary`. This is the navigation Component 10 deliberately
 * left out of `PublicFragmentBrowser` (its concept-tree endpoints are editor-
 * only); wiring it here completes the public read journey — index → concept page
 * → example expand → fragment browse → fragment detail.
 *
 * Consumes the § Step 4b shape: each domain is a **forest**, not a single tree.
 * The backend returns a flat `nodes` list per domain keyed on `parent_id`, and
 * several entries carry `parent_id: null` (the `Cadence` tree plus the post-
 * cadential roots that are subtypes of nothing). We assemble the nesting by
 * grouping on `parent_id` — the same flat-list pattern the editor tree uses —
 * and the heading comes from the domain `label`, not a root concept's name.
 * Stub concepts are not in the index (§ Step 4); they are reached only as marked
 * links from a concept page.
 *
 * Design system (DESIGN.md): tonal layering only (no dividers, no borders), 0px
 * radius, Newsreader for headings, Public Sans for labels, spacing as separator.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { ApiError } from '../services/api';
import { getPublicConceptIndex } from '../services/glossaryApi';
import type { ConceptIndexDomain, ConceptIndexNode } from '../services/glossaryApi';
import styles from './GlossaryIndex.module.css';

// ---------------------------------------------------------------------------
// Forest assembly
// ---------------------------------------------------------------------------

/** Group a domain's flat node list into a children map keyed by parent_id. */
function buildChildrenMap(nodes: ConceptIndexNode[]): Map<string | null, ConceptIndexNode[]> {
  const map = new Map<string | null, ConceptIndexNode[]>();
  for (const node of nodes) {
    const key = node.parent_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(node);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Tree node
// ---------------------------------------------------------------------------

interface IndexNodeProps {
  node: ConceptIndexNode;
  childrenMap: Map<string | null, ConceptIndexNode[]>;
  depth: number;
}

/**
 * One concept in the index forest: a link to its glossary page, with its
 * approved-fragment count, then its IS_SUBTYPE_OF children indented below. This
 * is navigation, not selection — every node is always a link and the whole
 * forest is shown expanded (a public reader scans, it does not drill).
 */
function IndexNode({ node, childrenMap, depth }: IndexNodeProps) {
  const children = childrenMap.get(node.id) ?? [];
  const alias = node.aliases.length > 0 && node.aliases[0] !== node.name ? node.aliases[0] : null;

  return (
    <li className={styles.node}>
      <Link
        to={`/glossary/${encodeURIComponent(node.id)}`}
        className={styles.nodeLink}
        style={{ paddingLeft: `calc(${depth} * var(--spacing-5))` }}
      >
        <span className={styles.nodeLabel}>
          <Type variant="body-lg" as="span">
            {node.name}
          </Type>
          {alias && (
            <Type variant="label-sm" as="span" className={styles.nodeAlias}>
              {alias}
            </Type>
          )}
        </span>
        {node.fragment_count > 0 && (
          <Type variant="label-sm" as="span" className={styles.nodeCount}>
            {node.fragment_count}
          </Type>
        )}
      </Link>

      {children.length > 0 && (
        <ul className={styles.nodeChildren}>
          {children.map((child) => (
            <IndexNode key={child.id} node={child} childrenMap={childrenMap} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// Domain section
// ---------------------------------------------------------------------------

function DomainSection({ domain }: { domain: ConceptIndexDomain }) {
  const { t } = useTranslation('public');
  const childrenMap = useMemo(() => buildChildrenMap(domain.nodes), [domain.nodes]);
  const roots = childrenMap.get(null) ?? [];

  return (
    <section className={styles.domain} aria-labelledby={`domain-${domain.domain}`}>
      <Type
        variant="label-sm"
        as="h2"
        id={`domain-${domain.domain}`}
        className={styles.domainHeading}
      >
        {t(`glossary.domains.${domain.domain}`, { defaultValue: domain.label })}
      </Type>
      <ul className={styles.forest}>
        {roots.map((root) => (
          <IndexNode key={root.id} node={root} childrenMap={childrenMap} depth={0} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Route component
// ---------------------------------------------------------------------------

export default function GlossaryIndex() {
  const { t } = useTranslation('public');
  usePageTitle(t('glossary.index.pageTitle'));

  const [domains, setDomains] = useState<ConceptIndexDomain[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    getPublicConceptIndex()
      .then((res) => {
        if (!cancelled) setDomains(res.domains);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError) setError(err);
        else setError(new ApiError('UNKNOWN_ERROR', String(err)));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Surface layer="base" className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.header}>
          <Type variant="display-sm" as="h1" className={styles.title}>
            {t('glossary.index.heading')}
          </Type>
          <Type variant="body-lg" as="p" className={styles.intro}>
            {t('glossary.index.intro')}
          </Type>
        </header>

        {loading && (
          <Type variant="label-sm" as="p" className={styles.notice}>
            {t('glossary.index.loading')}
          </Type>
        )}

        {!loading && error && (
          <Type variant="body-lg" as="p" className={styles.notice}>
            {error.message || t('glossary.index.loadError')}
          </Type>
        )}

        {!loading && !error && domains !== null && domains.length === 0 && (
          <Type variant="body-lg" as="p" className={styles.notice}>
            {t('glossary.index.empty')}
          </Type>
        )}

        {!loading && !error && domains !== null && domains.length > 0 && (
          <div className={styles.domains}>
            {domains.map((domain) => (
              <DomainSection key={domain.domain} domain={domain} />
            ))}
          </div>
        )}
      </div>
    </Surface>
  );
}
