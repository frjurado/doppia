/**
 * Fragment detail page — isolated Verovio render + MIDI + record display.
 *
 * Component 8 Steps 11–12:
 *   Step 11: isolated Verovio render constrained to the fragment's mc_start/mc_end
 *     via renderFragment(), MIDI playback via useMidiPlayback, and sub-part bracket
 *     overlays positioned from SVG measure geometry.
 *   Step 12: full record display (summary, properties, harmony events with
 *     bass/soprano pitch, prose annotation, sub-parts, data licence) using
 *     FragmentDetailPanel in standalone mode. Rendering-context contract
 *     published as ADR-024 on the backend (GET /fragments/{id}?context.mode=).
 *
 * Component 9 Step 15 (fragment viewer remediation):
 *   - Centered, wider layout; header restructured into distinct groups
 *     (concept identity / work / location / source+licence).
 *   - Measure/beat display rule via formatFragmentRange(): beats render only
 *     within their measure's context, never for complete-measure fragments.
 *   - Default staff size Medium (scale 45).
 *   - System breaks allowed (breaks:'smart' at measured container width)
 *     instead of one long system with horizontal scrolling; vertical space is
 *     reserved so brackets are never clipped.
 *   - The main fragment bracket always renders above the score: the rendered
 *     excerpt (whole measures) is not necessarily the significant fragment
 *     (which may be beat-precise, and which future ADR-024 context modes may
 *     embed in surrounding music).
 *
 * The notation surface itself — Verovio render, bracket/caret overlays, harmony
 * labels and MIDI transport — lives in FragmentNotation, extracted so the
 * glossary concept page can mount the same renderer for an inline example
 * (Component 11 Step 6). The overlay rule and bracket geometry are documented
 * there.
 */

import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import FragmentDetailPanel from '../components/score/FragmentDetailPanel';
import FragmentNotation from '../components/score/FragmentNotation';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { ApiError } from '../services/api';
import type { FragmentDetailResponse } from '../services/fragmentApi';
import { getPublicFragment } from '../services/publicApi';
import { useAuth } from '../components/auth/AuthContext';
import { EDITORIAL_ROLES } from '../services/roles';
import { getFragment } from '../services/fragmentApi';
import {
  formatFragmentRange,
  rangeLabels,
  makeRepeatContextFormatter,
  qualifyRange,
} from '../utils/fragmentRange';
import { stripEmbeddedCatalogue } from '../utils/workTitle';
import styles from './FragmentDetail.module.css';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Fragment detail page — `/fragments/:fragmentId`.
 *
 * Loading sequence: `loadFragment()` yields the fragment record (mei_url,
 * mc_start/mc_end from Step 9), which this view renders as a header, the
 * notation surface (FragmentNotation — it owns the MEI fetch, Verovio render,
 * overlays and MIDI transport from there), and the full record panel.
 *
 * Public mode (Component 10 Step 5): the same view serves the anonymous
 * one route since Step 14b. The component picks the public API client and
 * hides the (always-`approved`) status badge and
 * skips the editor-only concept-schema fetch in the embedded record panel.
 */
export interface FragmentDetailProps {
  /**
   * Fragment fetch function. Defaults to the client the caller's session
   * warrants; tests inject their own.
   */
  loadFragment?: (id: string) => Promise<FragmentDetailResponse>;
  /**
   * Hide editor affordances. Defaults to "the caller holds no editorial role",
   * which is also what decides the client above.
   */
  publicMode?: boolean;
}

export default function FragmentDetail({ loadFragment, publicMode }: FragmentDetailProps = {}) {
  // One route serves everyone since Step 14b, so the component picks its own
  // client rather than the route injecting one. The two are not independent:
  // the public endpoint pins `approved` and excludes NonCommercial corpora
  // (ADR-009 § 2) for anonymous callers, and `publicMode` additionally skips
  // the concept-schemas fetch, which is editor-only and would 401. Deciding
  // both from the same fact keeps them from drifting apart.
  const { user, status } = useAuth();
  const isEditorial = EDITORIAL_ROLES.some((role) => user?.roles.includes(role) ?? false);
  const isPublic = publicMode ?? !isEditorial;
  const fetchFragment = loadFragment ?? (isEditorial ? getFragment : getPublicFragment);
  const { t } = useTranslation(['fragments', 'common']);
  usePageTitle(t('fragments:detail.pageTitle'));
  const { fragmentId } = useParams<{ fragmentId: string }>();
  const navigate = useNavigate();

  // ── Fragment fetch ──────────────────────────────────────────────────────
  const [fragment, setFragment] = useState<FragmentDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<ApiError | null>(null);

  useEffect(() => {
    if (!fragmentId) return;
    // Wait for the session before fetching. Roles arrive asynchronously — the
    // access token is restored from the refresh cookie after a reload — so
    // firing on the first render would send an editor to the public endpoint
    // and then never retry: they would silently lose the status badge, the
    // resolved property names, and any NonCommercial fragment entirely.
    // A caller who injected `loadFragment` (tests) does not wait.
    if (loadFragment === undefined && status === 'loading') return;
    setIsLoading(true);
    fetchFragment(fragmentId)
      .then(setFragment)
      .catch((err) => {
        if (err instanceof ApiError) setError(err);
      })
      .finally(() => setIsLoading(false));
    // fetchFragment is derived from `isEditorial`, which is the dependency that
    // matters beyond the id; the function identity itself is not stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fragmentId, isEditorial, status]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const primaryTag = fragment?.concept_tags.find((tag) => tag.is_primary) ?? null;
  const conceptLabel = primaryTag?.alias ?? primaryTag?.name ?? '—';
  const secondaryTags = fragment?.concept_tags.filter((tag) => !tag.is_primary) ?? [];

  // Header groups (Step 15): work/composer and movement as separate lines.
  const workLine = fragment
    ? [
        fragment.composer_name,
        [
          // work_title already embeds the catalogue number (DCML corpus-prep
          // convention); strip it before re-appending in parens so it renders
          // once, not twice (Component 9 J2).
          stripEmbeddedCatalogue(fragment.work_title, fragment.work_catalogue_number),
          fragment.work_catalogue_number ? `(${fragment.work_catalogue_number})` : null,
        ]
          .filter(Boolean)
          .join(' '),
      ]
        .filter(Boolean)
        .join(' — ') || null
    : null;

  const movementLine = fragment
    ? [
        fragment.movement_number != null
          ? t('fragments:movementShort', { number: fragment.movement_number })
          : null,
        fragment.movement_title,
      ]
        .filter(Boolean)
        .join(' — ') || null
    : null;

  // ── JSX ─────────────────────────────────────────────────────────────────
  return (
    <Surface layer="base" className={styles.page}>
      {/* Nav strip */}
      <Surface layer="container-lowest" className={styles.pageNav}>
        <button type="button" className={styles.navBack} onClick={() => navigate(-1)}>
          <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
            {t('fragments:detail.backToBrowser')}
          </Type>
        </button>
        {fragment && !isPublic && (
          <span className={styles.statusBadge} data-status={fragment.status}>
            <Type variant="label-sm" as="span">
              {t(`common:status.${fragment.status}`)}
            </Type>
          </span>
        )}
      </Surface>

      {isLoading && (
        <div className={styles.centered}>
          <Type variant="label-sm" as="span" style={{ color: 'var(--color-on-surface-variant)' }}>
            {t('common:loading')}
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
          <div className={styles.bodyInner}>
            {/* ── Header: concept identity / work / location / source+licence ─ */}
            <Surface layer="container-lowest" className={styles.headerSection}>
              <div className={styles.headerIdentity}>
                {primaryTag && primaryTag.hierarchy_path.length > 0 && (
                  <Type variant="label-sm" as="p" className={styles.headerKicker}>
                    {primaryTag.hierarchy_path.join(' → ')}
                  </Type>
                )}
                <Type variant="display-sm" as="h1" className={styles.conceptTitle}>
                  {conceptLabel}
                </Type>
                {workLine && (
                  <Type variant="body-lg" as="p" className={styles.workLine}>
                    {workLine}
                  </Type>
                )}
                {movementLine && (
                  <Type variant="body-sm" as="p" className={styles.movementLine}>
                    {movementLine}
                  </Type>
                )}
              </div>
              <div className={styles.headerMeta}>
                <Type variant="label-md" as="p" className={styles.locationLine}>
                  {qualifyRange(
                    formatFragmentRange(
                      fragment.bar_start,
                      fragment.bar_end,
                      fragment.beat_start,
                      fragment.beat_end,
                      rangeLabels(t)
                    ),
                    {
                      sectionLabel: fragment.section_label,
                      repeatContext: fragment.repeat_context,
                      formatRepeatContext: makeRepeatContextFormatter(t),
                    }
                  )}
                </Type>
                {(fragment.data_licence || fragment.harmony_sources.length > 0) && (
                  <div className={styles.sourceGroup}>
                    {fragment.data_licence && (
                      <Type variant="label-sm" as="p" className={styles.sourceLine}>
                        {fragment.data_licence_url ? (
                          <a
                            href={fragment.data_licence_url}
                            target="_blank"
                            rel="noreferrer"
                            className={styles.sourceLink}
                          >
                            {fragment.data_licence}
                          </a>
                        ) : (
                          fragment.data_licence
                        )}
                      </Type>
                    )}
                    {fragment.harmony_sources.length > 0 && (
                      <Type variant="label-sm" as="p" className={styles.sourceLine}>
                        {t('fragments:detail.sources', {
                          list: fragment.harmony_sources.join(', '),
                        })}
                      </Type>
                    )}
                  </div>
                )}
              </div>
            </Surface>

            {/* ── Notation area ───────────────────────────────────────────── */}
            {/* Verovio render + bracket/caret overlays + harmony labels +
                MIDI transport, shared with the glossary example expand
                (Component 11 Step 6). */}
            <Surface layer="container-low" className={styles.notationSection}>
              <FragmentNotation fragment={fragment} />
            </Surface>

            {/* ── Additional concept tags ──────────────────────────────────── */}
            {secondaryTags.length > 0 && (
              <Surface layer="container-lowest" className={styles.section}>
                <Type
                  variant="label-sm"
                  as="h2"
                  style={{ color: 'var(--color-on-surface-variant)', margin: 0 }}
                >
                  {t('fragments:detail.alsoTagged')}
                </Type>
                <div className={styles.tagList}>
                  {secondaryTags.map((tag) => (
                    <span key={tag.concept_id} className={styles.tagChip}>
                      <Type variant="label-sm" as="span">
                        {tag.alias ?? tag.name}
                      </Type>
                    </span>
                  ))}
                </div>
              </Surface>
            )}

            {/* ── Full fragment record (Component 8 Step 12) ───────────────── */}
            {/* Summary, properties, harmony events (with bass/soprano pitch),
                prose annotation (Commentary), sub-parts, and data licence.
                Reuses FragmentDetailPanel in standalone mode — no panel chrome
                or action buttons, skips the internal getFragment fetch. */}
            <FragmentDetailPanel
              fragmentId={fragment.id}
              initialFragment={fragment}
              tagMode="view"
              standalone
              disableSchemaFetch={isPublic}
            />
          </div>
        </div>
      )}
    </Surface>
  );
}
