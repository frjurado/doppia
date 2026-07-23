/**
 * Inline example fragments for a concept page — Component 11 Step 6.
 *
 * The distinctive glossary feature (`extended-features.md` § Concept Glossary
 * *with Inline Examples*): a small draw of real, approved fragments tagged with
 * the concept, shown as cheap pre-rendered preview SVGs (ADR-008, signed URLs)
 * and expandable on demand to the full Verovio + MIDI surface.
 *
 * Draw and shuffle (Step 3): the examples come from
 * `GET /public/concepts/{id}/examples`, a server-random sample re-drawn on each
 * call. The shuffle control is just another call — no client-side reshuffling —
 * so a larger pool yields genuine variety. The draw is capped at three.
 *
 * Expand on demand: the draw returns `ConceptBrowseItem`s (enough for the
 * preview card), not the full record the renderer needs. Expanding a card
 * fetches the fragment through the anonymous public client and mounts
 * FragmentNotation — the same Verovio/MIDI machinery as the fragment detail
 * page, so the SVG-overlay invariant and `getElementsAtTime()` MIDI mapping are
 * honoured there, not re-implemented. Only one card is open at a time, so at
 * most one full renderer/instrument is ever live.
 *
 * Graceful states: an empty pool (a foundational concept may have few approved
 * fragments early on) shows a short muted note and no shuffle; a single example
 * renders its card with the shuffle control hidden (nothing to reshuffle).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import FragmentNotation from './FragmentNotation';
import Type from '../ui/Type';
import { ApiError } from '../../services/api';
import type { ConceptBrowseItem, FragmentDetailResponse } from '../../services/fragmentApi';
import { getPublicConceptExamples } from '../../services/glossaryApi';
import { getPublicFragment } from '../../services/publicApi';
import { stripEmbeddedCatalogue } from '../../utils/workTitle';
import styles from './ConceptExamples.module.css';

/** The glossary draws three inline examples (Step 3 default). */
const EXAMPLE_LIMIT = 3;

/** Smaller default staff size than the detail page — examples sit in a column. */
const EXAMPLE_SCALE = 35;

interface ExampleCardProps {
  item: ConceptBrowseItem;
  expanded: boolean;
  onToggle: (id: string) => void;
}

/**
 * One example: a preview-card header that toggles an inline full render.
 *
 * The header (preview SVG + metadata) is always cheap. The full fragment record
 * is fetched lazily on first expand and cached, so collapsing and re-expanding
 * does not refetch. The renderer is unmounted on collapse, releasing its
 * Verovio/MIDI resources.
 */
function ExampleCard({ item, expanded, onToggle }: ExampleCardProps) {
  const { t } = useTranslation(['public', 'fragments', 'common']);

  const [fragment, setFragment] = useState<FragmentDetailResponse | null>(null);
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'error'>('idle');
  // The full record is fetched exactly once, on the first expand. This ref (not
  // `loadState`) gates the effect so a `setLoadState` re-render can't re-run it
  // and cancel its own in-flight request; collapse/re-expand then reuses the
  // cached `fragment`, and a failed load is not silently retried.
  const fetchStartedRef = useRef(false);

  useEffect(() => {
    if (!expanded || fetchStartedRef.current) return;
    fetchStartedRef.current = true;
    let cancelled = false;
    setLoadState('loading');
    getPublicFragment(item.id)
      .then((res) => {
        if (cancelled) return;
        setFragment(res);
        setLoadState('idle');
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadState('error');
        if (!(err instanceof ApiError)) throw err;
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, item.id]);

  const conceptLabel = item.primary_concept_alias ?? item.primary_concept_name ?? '—';
  const barRange = t('common:barRangeMm', { start: item.bar_start, end: item.bar_end });
  // work_title already embeds the catalogue number (DCML corpus-prep
  // convention); strip it before re-appending so it renders once (Component 9 J2).
  const workTitle = stripEmbeddedCatalogue(item.work_title, item.work_catalogue_number);
  const workLabel = `${workTitle}${item.work_catalogue_number ? ` ${item.work_catalogue_number}` : ''}`;
  const movementLabel = `${t('fragments:movementShort', { number: item.movement_number })}${
    item.movement_title ? ` · ${item.movement_title}` : ''
  }`;

  return (
    <li className={styles.card}>
      <button
        type="button"
        className={styles.cardHeader}
        aria-expanded={expanded}
        onClick={() => onToggle(item.id)}
      >
        <div className={styles.previewArea}>
          {item.preview_url ? (
            <img src={item.preview_url} alt="" className={styles.previewImage} loading="lazy" />
          ) : (
            <div className={styles.previewPlaceholder}>
              <Type
                variant="label-sm"
                as="span"
                style={{ color: 'var(--color-on-surface-variant)' }}
              >
                {t('fragments:browser.previewGenerating')}
              </Type>
            </div>
          )}
        </div>
        <div className={styles.cardMeta}>
          <Type variant="body-sm" as="span" bold>
            {conceptLabel}
          </Type>
          <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
            {item.composer_name} · {workLabel}
          </Type>
          <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
            {movementLabel} · {barRange}
          </Type>
        </div>
        <Type variant="label-sm" as="span" className={styles.expandHint} aria-hidden="true">
          {expanded ? t('public:glossary.examples.collapse') : t('public:glossary.examples.expand')}
        </Type>
      </button>

      {expanded && (
        <div className={styles.cardBody}>
          {loadState === 'loading' && (
            <Type variant="label-sm" as="p" style={{ color: 'var(--color-on-surface-variant)' }}>
              {t('public:glossary.examples.expandLoading')}
            </Type>
          )}
          {loadState === 'error' && (
            <Type variant="label-sm" as="p" style={{ color: 'var(--color-error)' }}>
              {t('public:glossary.examples.expandError')}
            </Type>
          )}
          {fragment && <FragmentNotation fragment={fragment} initialScale={EXAMPLE_SCALE} />}
        </div>
      )}
    </li>
  );
}

interface ConceptExamplesProps {
  /** Concept whose approved fragments to draw as inline examples. */
  conceptId: string;
}

/**
 * The example-fragments section of a concept page.
 *
 * Mounted only for non-stub concepts (a stub carries no approved fragments).
 * Renders its own heading and, when the pool has more than one fragment, a
 * shuffle control that re-draws the sample.
 */
export default function ConceptExamples({ conceptId }: ConceptExamplesProps) {
  const { t } = useTranslation('public');

  const [examples, setExamples] = useState<ConceptBrowseItem[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const draw = useCallback(
    (signal: { cancelled: boolean }) => {
      setStatus('loading');
      setExpandedId(null);
      getPublicConceptExamples(conceptId, { limit: EXAMPLE_LIMIT })
        .then((res) => {
          if (signal.cancelled) return;
          setExamples(res.examples);
          setStatus('ready');
        })
        .catch((err) => {
          if (signal.cancelled) return;
          setStatus('error');
          if (!(err instanceof ApiError)) throw err;
        });
    },
    [conceptId]
  );

  useEffect(() => {
    const signal = { cancelled: false };
    draw(signal);
    return () => {
      signal.cancelled = true;
    };
  }, [draw]);

  const shuffle = useCallback(() => {
    draw({ cancelled: false });
  }, [draw]);

  const toggle = useCallback((id: string) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  // A concept with no approved fragments yet: the section stays, honestly empty.
  if (status === 'ready' && examples.length === 0) {
    return (
      <section className={styles.section} aria-labelledby="concept-examples-heading">
        <Type variant="label-sm" as="h2" id="concept-examples-heading" className={styles.heading}>
          {t('glossary.examples.heading')}
        </Type>
        <Type variant="body-lg" as="p" className={styles.emptyNote}>
          {t('glossary.examples.empty')}
        </Type>
      </section>
    );
  }

  return (
    <section className={styles.section} aria-labelledby="concept-examples-heading">
      <div className={styles.headingRow}>
        <Type variant="label-sm" as="h2" id="concept-examples-heading" className={styles.heading}>
          {t('glossary.examples.heading')}
        </Type>
        {status === 'ready' && examples.length > 1 && (
          <button type="button" className={styles.shuffleButton} onClick={shuffle}>
            <Type variant="label-sm" as="span">
              {t('glossary.examples.shuffle')}
            </Type>
          </button>
        )}
      </div>

      {status === 'loading' && (
        <Type variant="label-sm" as="p" style={{ color: 'var(--color-on-surface-variant)' }}>
          {t('glossary.examples.loading')}
        </Type>
      )}

      {status === 'error' && (
        <Type variant="label-sm" as="p" style={{ color: 'var(--color-error)' }}>
          {t('glossary.examples.loadError')}
        </Type>
      )}

      {status === 'ready' && examples.length > 0 && (
        <ul className={styles.list}>
          {examples.map((item) => (
            <ExampleCard
              key={item.id}
              item={item}
              expanded={expandedId === item.id}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
