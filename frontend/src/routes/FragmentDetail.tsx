import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { ApiError } from '../services/api';
import { FragmentDetailResponse, getFragment } from '../services/fragmentApi';
import styles from './FragmentDetail.module.css';

/**
 * Fragment detail page (Component 8 Steps 11–12).
 *
 * This stub fetches the fragment record and displays identity metadata.
 * The isolated Verovio render + MIDI (Step 11) and the full record display
 * (Step 12) land in subsequent steps.
 */
export default function FragmentDetail() {
  usePageTitle('Fragment — Doppia');
  const { fragmentId } = useParams<{ fragmentId: string }>();
  const navigate = useNavigate();

  const [fragment, setFragment] = useState<FragmentDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!fragmentId) return;
    setIsLoading(true);
    getFragment(fragmentId)
      .then(setFragment)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      })
      .finally(() => setIsLoading(false));
  }, [fragmentId]);

  const primaryTag = fragment?.concept_tags.find((t) => t.is_primary) ?? null;
  const conceptLabel = primaryTag?.alias ?? primaryTag?.name ?? '—';
  const secondaryTags = fragment?.concept_tags.filter((t) => !t.is_primary) ?? [];

  return (
    <Surface layer="base" className={styles.page}>
      {/* Nav strip */}
      <Surface layer="container-lowest" className={styles.pageNav}>
        <button
          type="button"
          className={styles.navBack}
          onClick={() => navigate(-1)}
        >
          <Type
            variant="label-sm"
            as="span"
            style={{ color: 'var(--color-on-surface-variant)' }}
          >
            ← Fragment Browser
          </Type>
        </button>
        {fragment && (
          <span className={styles.statusBadge} data-status={fragment.status}>
            <Type variant="label-sm" as="span">
              {fragment.status}
            </Type>
          </span>
        )}
      </Surface>

      {isLoading && (
        <div className={styles.centered}>
          <Type
            variant="label-sm"
            as="span"
            style={{ color: 'var(--color-on-surface-variant)' }}
          >
            Loading…
          </Type>
        </div>
      )}

      {error && (
        <div className={styles.centered}>
          <Type variant="label-sm" as="span" style={{ color: 'var(--color-error)' }}>
            {error.message}
          </Type>
        </div>
      )}

      {fragment && (
        <div className={styles.body}>
          {/* Concept identity */}
          <Surface layer="container-lowest" className={styles.section}>
            <Type variant="title" as="h1" className={styles.conceptTitle}>
              {conceptLabel}
            </Type>
            {primaryTag && primaryTag.hierarchy_path.length > 0 && (
              <Type
                variant="label-sm"
                as="p"
                style={{ color: 'var(--color-on-surface-variant)', margin: 0 }}
              >
                {primaryTag.hierarchy_path.join(' → ')}
              </Type>
            )}
            <Type
              variant="label-sm"
              as="p"
              style={{ color: 'var(--color-on-surface-variant)', margin: 0 }}
            >
              mm. {fragment.bar_start}–{fragment.bar_end}
              {fragment.beat_start != null
                ? ` · beat ${fragment.beat_start}–${fragment.beat_end}`
                : ''}
            </Type>
            {fragment.data_licence && (
              <Type
                variant="label-sm"
                as="p"
                style={{ color: 'var(--color-on-surface-variant)', opacity: 0.7, margin: 0 }}
              >
                {fragment.data_licence_url ? (
                  <a
                    href={fragment.data_licence_url}
                    target="_blank"
                    rel="noreferrer"
                    style={{ color: 'inherit', textDecoration: 'none' }}
                  >
                    {fragment.data_licence}
                  </a>
                ) : (
                  fragment.data_licence
                )}
              </Type>
            )}
          </Surface>

          {/* Notation render placeholder — Step 11 */}
          <Surface layer="container-low" className={styles.notationArea}>
            <Type
              variant="label-sm"
              as="span"
              style={{ color: 'var(--color-on-surface-variant)' }}
            >
              Notation · mm. {fragment.bar_start}–{fragment.bar_end}
            </Type>
            <Type
              variant="label-sm"
              as="span"
              style={{ color: 'var(--color-on-surface-variant)', opacity: 0.5 }}
            >
              Isolated Verovio render — Step 11
            </Type>
          </Surface>

          {/* Additional concept tags */}
          {secondaryTags.length > 0 && (
            <Surface layer="container-lowest" className={styles.section}>
              <Type
                variant="label-sm"
                as="h2"
                style={{ color: 'var(--color-on-surface-variant)', margin: 0 }}
              >
                Also tagged
              </Type>
              <div className={styles.tagList}>
                {secondaryTags.map((t) => (
                  <span key={t.concept_id} className={styles.tagChip}>
                    <Type variant="label-sm" as="span">
                      {t.alias ?? t.name}
                    </Type>
                  </span>
                ))}
              </div>
            </Surface>
          )}

          {/* Prose annotation */}
          {fragment.prose_annotation && (
            <Surface layer="container-lowest" className={styles.section}>
              <Type
                variant="label-sm"
                as="h2"
                style={{ color: 'var(--color-on-surface-variant)', margin: 0 }}
              >
                Note
              </Type>
              <Type variant="body-sm" as="p" style={{ margin: 0 }}>
                {fragment.prose_annotation}
              </Type>
            </Surface>
          )}
        </div>
      )}
    </Surface>
  );
}
