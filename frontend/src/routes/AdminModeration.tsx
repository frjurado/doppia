import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dismissReport, listReports, type ModerationReport } from '../services/adminApi';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import styles from './Admin.module.css';

const FILTERS = ['open', 'dismissed', 'actioned'] as const;
type Filter = (typeof FILTERS)[number];

/**
 * Moderation queue (`/admin/moderation`) — Component 12 Step 11.
 *
 * The queue ships before anything is reportable. That is deliberate: the
 * moderation tool has to be live before sharing is (`phase-2.md` § Component
 * 13), so Component 12 delivers the schema, the service and this page, and
 * Component 13 wires the report button on shared collections.
 *
 * So the expected state of this page today is empty, and the empty copy says
 * so rather than implying something has gone wrong.
 *
 * Dismissal is the only resolution offered. The other outcome — unpublish
 * share — needs a shared collection to unpublish, and arrives with 13 as a
 * second action; the backend's `resolve_report` already takes the outcome.
 */
export default function AdminModeration() {
  const { t } = useTranslation(['admin', 'errors']);
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('open');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(
    async (status: Filter) => {
      setLoadError(null);
      try {
        const page = await listReports({ status });
        setReports(page.items);
        setNextCursor(page.next_cursor);
      } catch {
        setLoadError(t('errors:unexpected'));
      }
    },
    [t]
  );

  useEffect(() => {
    void load(filter);
  }, [load, filter]);

  async function handleLoadMore() {
    if (!nextCursor) return;
    try {
      const page = await listReports({ status: filter, cursor: nextCursor });
      setReports((current) => [...current, ...page.items]);
      setNextCursor(page.next_cursor);
    } catch {
      setLoadError(t('errors:unexpected'));
    }
  }

  async function handleDismiss(report: ModerationReport) {
    setActionError(null);
    setBusy(report.id);
    try {
      const resolved = await dismissReport(report.id);
      // Closing a report takes it out of the open queue; leave it in place on
      // any other filter so the admin can see what they just did.
      setReports((current) =>
        filter === 'open'
          ? current.filter((r) => r.id !== resolved.id)
          : current.map((r) => (r.id === resolved.id ? resolved : r))
      );
    } catch {
      setActionError(t('errors:unexpected'));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Surface layer="base" className={styles.page}>
      <Type variant="display-sm" as="h1" className={styles.title}>
        {t('admin:moderationTitle')}
      </Type>
      <Type variant="body-md" as="p" className={styles.lede}>
        {t('admin:moderationLede')}
      </Type>

      <Surface layer="container-low" className={styles.panel}>
        <div className={styles.filters} role="group" aria-label={t('admin:filterLabel')}>
          {FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              className={`${styles.roleChip}${filter === value ? ` ${styles.filterActive}` : ` ${styles.roleChipOff}`}`}
              onClick={() => setFilter(value)}
            >
              {t(`admin:status_${value}`)}
            </button>
          ))}
        </div>

        {actionError && (
          <p className={styles.error} role="alert">
            <Type variant="body-sm" as="span">
              {actionError}
            </Type>
          </p>
        )}
        {loadError && (
          <p className={styles.error} role="alert">
            <Type variant="body-sm" as="span">
              {loadError}
            </Type>
          </p>
        )}

        {reports.length === 0 && !loadError ? (
          <p className={styles.empty}>
            <Type variant="body-md" as="span">
              {filter === 'open' ? t('admin:noOpenReports') : t('admin:noReports')}
            </Type>
          </p>
        ) : (
          <ul className={styles.rows}>
            {reports.map((report) => (
              <li key={report.id} className={styles.row}>
                <span className={styles.rowMain}>
                  <Type variant="body-md" as="span">
                    {t(`admin:reason_${report.reason}`, { defaultValue: report.reason })} ·{' '}
                    {report.resource_ref}
                  </Type>
                  <Type variant="body-sm" as="span" className={styles.rowMeta}>
                    {t('admin:reportedBy', { email: report.reporter_email })} ·{' '}
                    {new Date(report.created_at).toLocaleDateString()}
                  </Type>
                  {report.detail && (
                    <Type variant="body-sm" as="span">
                      {report.detail}
                    </Type>
                  )}
                </span>
                <span className={styles.rowActions}>
                  {report.status === 'open' ? (
                    <button
                      type="button"
                      className={styles.secondaryButton}
                      disabled={busy === report.id}
                      onClick={() => handleDismiss(report)}
                    >
                      <Type variant="label-md" as="span">
                        {t('admin:dismiss')}
                      </Type>
                    </button>
                  ) : (
                    <Type variant="body-sm" as="span" className={styles.rowMeta}>
                      {t(`admin:status_${report.status}`)}
                    </Type>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}

        {nextCursor && (
          <button type="button" className={styles.secondaryButton} onClick={handleLoadMore}>
            <Type variant="label-md" as="span">
              {t('admin:loadMore')}
            </Type>
          </button>
        )}
      </Surface>
    </Surface>
  );
}
