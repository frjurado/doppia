import { useTranslation } from 'react-i18next';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import styles from './Progress.module.css';

/**
 * Progress placeholder (`/progress`) — Component 12 Step 13.
 *
 * The account menu carries a progress entry from this component on, but the
 * dashboard itself belongs to Component 15, with the exercise data that would
 * give it something to show. This page is what the entry opens meanwhile.
 *
 * It is a real page rather than a disabled menu item on purpose: `DESIGN.md`
 * § 7.4 rules that unshipped surfaces are absent, never shown-and-greyed. An
 * entry that opens an honest "not yet" is a different thing from a door that
 * does not open.
 */
export default function Progress() {
  const { t } = useTranslation('profile');
  usePageTitle(t('progress.pageTitle'));

  return (
    <Surface layer="container-low" className={styles.page}>
      <div className={styles.inner}>
        <Type variant="display-sm" as="h1">
          {t('progress.heading')}
        </Type>
        <Type variant="body-lg" as="p" className={styles.body}>
          {t('progress.body')}
        </Type>
      </div>
    </Surface>
  );
}
