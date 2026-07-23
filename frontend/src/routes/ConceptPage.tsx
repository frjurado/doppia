/**
 * Public concept page — Component 11 Step 5.
 *
 * The glossary's unit surface: one anonymous, deep-linkable page per Concept
 * node, keyed on the immutable concept `id` (§ Decisions 1) at
 * `/glossary/:conceptId`. It renders the Step 1 payload in four movements:
 *
 *  1. Identity — name, aliases, domain/complexity, and the IS_SUBTYPE_OF
 *     breadcrumb from the domain root down to (but not including) this concept.
 *  2. Definition — the reviewed prose, or the "under editorial review"
 *     placeholder when `definition_reviewed` is false (Step 2). The raw
 *     annotator prose is never shown to a public reader; the page still
 *     exists and its links stay stable, only the prose is withheld.
 *  3. Structure — the direct IS_SUBTYPE_OF children ("more specific types")
 *     and the typed relationships grouped by edge type and direction.
 *  4. A link into the anonymous fragment browse for this concept
 *     (`/public/concepts?concept=<id>`).
 *
 * Two states diverge from that shape:
 *  - **Stub concept** — leads with the honest "domain not yet modelled" banner,
 *    withholds the definition block, and omits the browse link (a stub carries
 *    no approved fragments). The inline example section (Step 6) is likewise
 *    omitted for stubs.
 *  - **Unknown id** — the backend 404 (`CONCEPT_NOT_FOUND`) renders as a plain
 *    not-found message rather than a raw API error.
 *
 * Stub *targets* — a stub parent, child, or relationship target — render as
 * flagged non-links ("not yet covered") rather than being hidden, so a link
 * into a not-yet-covered corner of the graph is honest rather than absent.
 *
 * Design system (DESIGN.md): tonal layering only (no dividers, no borders),
 * 0px radius, Newsreader for prose and headings, Public Sans for the label
 * micro-copy, spacing as the section separator.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { ApiError } from '../services/api';
import { getPublicConcept } from '../services/glossaryApi';
import type { ConceptDetail, ConceptRef } from '../services/glossaryApi';
import { groupRelationships, relationshipLabel } from '../utils/conceptRelationships';
import styles from './ConceptPage.module.css';

// ---------------------------------------------------------------------------
// Concept links
// ---------------------------------------------------------------------------

/**
 * A concept reference: a link to its own glossary page, or — when the target is
 * a stub — flagged inert text. Stubs have a page (§ Step 1 returns a valid
 * payload for them), but linking into one from a list of neighbours would
 * promise coverage that does not exist yet, so the list marks them instead.
 */
function ConceptLink({ concept }: { concept: ConceptRef }) {
  const { t } = useTranslation('public');

  if (concept.stub) {
    return (
      <span className={styles.conceptStub}>
        <Type variant="body-lg" as="span">
          {concept.name}
        </Type>
        <Type variant="label-sm" as="span" className={styles.stubTag}>
          {t('glossary.stubTag')}
        </Type>
      </span>
    );
  }

  return (
    <Link to={`/glossary/${encodeURIComponent(concept.id)}`} className={styles.conceptLink}>
      <Type variant="body-lg" as="span">
        {concept.name}
      </Type>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Route component
// ---------------------------------------------------------------------------

export default function ConceptPage() {
  const { t } = useTranslation(['public', 'common']);
  const { conceptId } = useParams<{ conceptId: string }>();

  const [concept, setConcept] = useState<ConceptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  usePageTitle(
    concept
      ? t('public:glossary.pageTitle', { concept: concept.name })
      : t('public:glossary.pageTitleFallback')
  );

  useEffect(() => {
    if (!conceptId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setConcept(null);

    getPublicConcept(conceptId)
      .then((res) => {
        if (!cancelled) setConcept(res);
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
  }, [conceptId]);

  const groups = useMemo(
    () => (concept ? groupRelationships(concept.relationships) : []),
    [concept]
  );

  /**
   * The breadcrumb shows the ancestors only — the concept's own name is the
   * page heading directly below it. `hierarchy_path` is root → concept
   * inclusive, so the trailing entry is dropped when it is this concept.
   */
  const ancestors = useMemo(() => {
    if (!concept) return [];
    const path = concept.hierarchy_path;
    return path.length > 0 && path[path.length - 1] === concept.name ? path.slice(0, -1) : path;
  }, [concept]);

  if (loading) {
    return (
      <Surface layer="base" className={styles.page}>
        <div className={styles.inner}>
          <Type variant="label-sm" as="span" className={styles.notice}>
            {t('public:glossary.loading')}
          </Type>
        </div>
      </Surface>
    );
  }

  if (error || !concept) {
    const notFound = error?.status === 404;
    return (
      <Surface layer="base" className={styles.page}>
        <div className={styles.inner}>
          <Type variant="body-lg" as="p" className={styles.notice}>
            {notFound
              ? t('public:glossary.notFound')
              : (error?.message ?? t('public:glossary.loadError'))}
          </Type>
        </div>
      </Surface>
    );
  }

  const meta = [
    concept.domain
      ? t(`public:glossary.domains.${concept.domain}`, { defaultValue: concept.domain })
      : null,
    concept.complexity
      ? t(`public:glossary.complexities.${concept.complexity}`, {
          defaultValue: concept.complexity,
        })
      : null,
  ].filter((entry): entry is string => entry !== null);

  return (
    <Surface layer="base" className={styles.page}>
      <article className={styles.inner}>
        <header className={styles.header}>
          {ancestors.length > 0 && (
            <nav aria-label={t('public:glossary.breadcrumbLabel')} className={styles.breadcrumb}>
              {ancestors.map((ancestorName, index) => {
                const isParent = index === ancestors.length - 1;
                const linkable = isParent && concept.parent !== null && !concept.parent.stub;
                return (
                  <span key={`${ancestorName}-${index}`} className={styles.crumb}>
                    {index > 0 && <span aria-hidden="true">{'›'}</span>}
                    {linkable && concept.parent ? (
                      <Link
                        to={`/glossary/${encodeURIComponent(concept.parent.id)}`}
                        className={styles.crumbLink}
                      >
                        {ancestorName}
                      </Link>
                    ) : (
                      <span>{ancestorName}</span>
                    )}
                  </span>
                );
              })}
            </nav>
          )}

          <Type variant="display-sm" as="h1" className={styles.title}>
            {concept.name}
          </Type>

          {concept.aliases.length > 0 && (
            <Type variant="label-md" as="p" className={styles.aliases}>
              {t('public:glossary.aliases', { aliases: concept.aliases.join(', ') })}
            </Type>
          )}

          {meta.length > 0 && (
            <Type variant="label-sm" as="p" className={styles.meta}>
              {meta.join(' · ')}
            </Type>
          )}
        </header>

        {concept.stub ? (
          <Surface layer="container-high" className={styles.stubBanner}>
            <Type variant="body-lg" as="p">
              {t('public:glossary.stubBanner')}
            </Type>
          </Surface>
        ) : (
          <section className={styles.section} aria-labelledby="concept-definition-heading">
            <Type
              variant="label-sm"
              as="h2"
              id="concept-definition-heading"
              className={styles.sectionHeading}
            >
              {t('public:glossary.definitionHeading')}
            </Type>
            {concept.definition_reviewed && concept.definition ? (
              <Type variant="body-lg" as="p" className={styles.definition}>
                {concept.definition}
              </Type>
            ) : (
              <Type variant="body-lg" as="p" className={styles.definitionPlaceholder}>
                {concept.definition
                  ? t('public:glossary.definitionUnderReview')
                  : t('public:glossary.definitionMissing')}
              </Type>
            )}
          </section>
        )}

        {concept.children.length > 0 && (
          <section className={styles.section} aria-labelledby="concept-children-heading">
            <Type
              variant="label-sm"
              as="h2"
              id="concept-children-heading"
              className={styles.sectionHeading}
            >
              {t('public:glossary.childrenHeading')}
            </Type>
            <ul className={styles.conceptList}>
              {concept.children.map((child) => (
                <li key={child.id}>
                  <ConceptLink concept={child} />
                </li>
              ))}
            </ul>
          </section>
        )}

        {groups.length > 0 && (
          <section className={styles.section} aria-labelledby="concept-relationships-heading">
            <Type
              variant="label-sm"
              as="h2"
              id="concept-relationships-heading"
              className={styles.sectionHeading}
            >
              {t('public:glossary.relationshipsHeading')}
            </Type>
            <dl className={styles.relationships}>
              {groups.map((group) => (
                <div key={group.key} className={styles.relationshipGroup}>
                  <Type variant="label-sm" as="dt" className={styles.relationshipLabel}>
                    {relationshipLabel(t, group)}
                  </Type>
                  <dd className={styles.relationshipTargets}>
                    <ul className={styles.conceptList}>
                      {group.targets.map((target) => (
                        <li key={target.id}>
                          <ConceptLink concept={target} />
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        )}

        {/* Example fragments (Step 6) mount here for non-stub concepts. */}

        {!concept.stub && (
          <div className={styles.browse}>
            <Link
              to={`/public/concepts?concept=${encodeURIComponent(concept.id)}`}
              className={styles.browseLink}
            >
              <Type variant="body-lg" as="span">
                {t('public:glossary.browseFragments', { concept: concept.name })}
              </Type>
            </Link>
          </div>
        )}
      </article>
    </Surface>
  );
}
