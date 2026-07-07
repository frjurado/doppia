import { useTranslation } from 'react-i18next';
import {
  SUPPORTED_LANGUAGES,
  changeLanguage,
  getCurrentLanguage,
  type SupportedLanguage,
} from '../../i18n';
import styles from './LanguageSwitcher.module.css';

/**
 * Compact segmented control for switching the UI language (Component 9 Step 26).
 *
 * Renders one button per supported language; the active language is emphasised
 * and marked `aria-pressed`. Selecting a language calls `changeLanguage`, which
 * persists the choice to localStorage (via the i18next detector) and re-renders
 * every `useTranslation` consumer; the API client then sends the new
 * `Accept-Language` on subsequent requests.
 *
 * Design system: tonal segmented control, 0px border-radius, Public Sans labels,
 * no 1px borders — depth comes from container/primary tonal layering only.
 */
export default function LanguageSwitcher() {
  const { t } = useTranslation('nav');
  const active = getCurrentLanguage();

  return (
    <div className={styles.group} role="group" aria-label={t('language')}>
      {SUPPORTED_LANGUAGES.map((lng: SupportedLanguage) => {
        const isActive = active === lng;
        return (
          <button
            key={lng}
            type="button"
            className={`${styles.option}${isActive ? ` ${styles.optionActive}` : ''}`}
            aria-pressed={isActive}
            title={t(`languageNames.${lng}`)}
            onClick={() => {
              if (!isActive) void changeLanguage(lng);
            }}
          >
            {lng.toUpperCase()}
          </button>
        );
      })}
    </div>
  );
}
