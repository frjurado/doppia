import { Link } from 'react-router-dom';
import Surface from '../components/ui/Surface';
import Type from '../components/ui/Type';
import { usePageTitle } from '../hooks/usePageTitle';
import { useAuth } from '../components/auth/AuthContext';
import { EDITORIAL_ROLES } from '../services/roles';
import { useTranslation } from 'react-i18next';
import styles from './Landing.module.css';

/**
 * The site root — one page for every audience (Step 14b).
 *
 * `/` was the corpus browser, an editorial surface, which made three things
 * wrong at once: an anonymous visitor to the site root was bounced to `/login`
 * and never saw the product, the post-login redirect sent every account to a
 * page most of them could not open, and `RequireRole` could not send a refused
 * caller to `/` without looping. All three fall out of putting a public page
 * here.
 *
 * It is deliberately a set of doors rather than a marketing page: Doppia's
 * value is the corpus and the graph behind it, and the honest way to show that
 * is to hand people the two surfaces that are actually built. Editorial roles
 * see a third door to the corpus. Nothing here invents content — no counts, no
 * testimonials, no features that do not exist yet.
 */
export default function Landing() {
  const { t } = useTranslation(['landing', 'common']);
  usePageTitle(t('landing:pageTitle'));
  const { user } = useAuth();
  const isEditorial = EDITORIAL_ROLES.some((role) => user?.roles.includes(role) ?? false);

  return (
    <Surface layer="base" className={styles.page}>
      <div className={styles.inner}>
        <header className={styles.hero}>
          <Type variant="display-lg" as="h1" className={styles.title}>
            {t('landing:title')}
          </Type>
          <Type variant="label-md" as="p" className={styles.tagline}>
            {t('landing:tagline')}
          </Type>
          <Type variant="body-lg" as="p" className={styles.lede}>
            {t('landing:lede')}
          </Type>
        </header>

        <nav className={styles.doors} aria-label={t('landing:doorsAria')}>
          <Link to="/glossary" className={styles.door}>
            <Type variant="title" as="h2" className={styles.doorTitle}>
              {t('landing:glossary.title')}
            </Type>
            <Type variant="body-sm" as="p" className={styles.doorBody}>
              {t('landing:glossary.body')}
            </Type>
          </Link>

          <Link to="/fragments" className={styles.door}>
            <Type variant="title" as="h2" className={styles.doorTitle}>
              {t('landing:fragments.title')}
            </Type>
            <Type variant="body-sm" as="p" className={styles.doorBody}>
              {t('landing:fragments.body')}
            </Type>
          </Link>

          {isEditorial && (
            <Link to="/corpus" className={styles.door}>
              <Type variant="title" as="h2" className={styles.doorTitle}>
                {t('landing:corpus.title')}
              </Type>
              <Type variant="body-sm" as="p" className={styles.doorBody}>
                {t('landing:corpus.body')}
              </Type>
            </Link>
          )}
        </nav>

        <Type variant="body-sm" as="p" className={styles.note}>
          {t('landing:note')}
        </Type>
      </div>
    </Surface>
  );
}
