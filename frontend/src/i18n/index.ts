/**
 * i18next bootstrap for the Doppia frontend.
 *
 * ADR-006 § 2 mandates i18next for UI strings. This module initialises a single
 * shared i18next instance with statically-bundled resource files (two small
 * locales — no async backend needed) and a localStorage-backed language
 * detector.
 *
 * Language negotiation mirrors the backend (`backend/services/i18n.py`):
 * explicit preference (localStorage) → browser `Accept-Language` (navigator) →
 * fallback `en`. Supported languages are `{en, es}`; anything else degrades to
 * English.
 *
 * Spanish resource files are English-copied placeholders in Step 25; Step 26
 * replaces them with real translations and adds the visible switcher. This
 * module already exposes `changeLanguage` so the switcher only needs to call it.
 */
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import enCommon from './locales/en/common.json';
import enNav from './locales/en/nav.json';
import enAuth from './locales/en/auth.json';
import enBrowse from './locales/en/browse.json';
import enFragments from './locales/en/fragments.json';
import enReview from './locales/en/review.json';
import enScore from './locales/en/score.json';
import enErrors from './locales/en/errors.json';
import enPublic from './locales/en/public.json';

import esCommon from './locales/es/common.json';
import esNav from './locales/es/nav.json';
import esAuth from './locales/es/auth.json';
import esBrowse from './locales/es/browse.json';
import esFragments from './locales/es/fragments.json';
import esReview from './locales/es/review.json';
import esScore from './locales/es/score.json';
import esErrors from './locales/es/errors.json';
import esPublic from './locales/es/public.json';

/** BCP 47 primary subtags the UI ships in. Mirrors backend SUPPORTED_LANGUAGES. */
export const SUPPORTED_LANGUAGES = ['en', 'es'] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

/** Canonical fallback. Mirrors backend DEFAULT_LANGUAGE. */
export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

/** localStorage key holding the user's explicit language preference. */
export const LANGUAGE_STORAGE_KEY = 'doppia_language';

/** Namespaces, one per feature area (see src/i18n/locales/<lng>/<ns>.json). */
export const NAMESPACES = [
  'common',
  'nav',
  'auth',
  'browse',
  'fragments',
  'review',
  'score',
  'errors',
  'public',
] as const;

const resources = {
  en: {
    common: enCommon,
    nav: enNav,
    auth: enAuth,
    browse: enBrowse,
    fragments: enFragments,
    review: enReview,
    score: enScore,
    errors: enErrors,
    public: enPublic,
  },
  es: {
    common: esCommon,
    nav: esNav,
    auth: esAuth,
    browse: esBrowse,
    fragments: esFragments,
    review: esReview,
    score: esScore,
    errors: esErrors,
    public: esPublic,
  },
} as const;

void i18next
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: [...SUPPORTED_LANGUAGES],
    fallbackLng: DEFAULT_LANGUAGE,
    ns: [...NAMESPACES],
    defaultNS: 'common',
    returnNull: false,
    interpolation: {
      // React already escapes interpolated values.
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: LANGUAGE_STORAGE_KEY,
      caches: ['localStorage'],
    },
  });

/**
 * The language i18next actually resolved to (after supportedLngs/fallback).
 * Used to populate the API client's `Accept-Language` header.
 */
export function getCurrentLanguage(): string {
  return i18next.resolvedLanguage ?? i18next.language ?? DEFAULT_LANGUAGE;
}

/**
 * Switch the active language and persist it (the detector writes localStorage).
 * The visible switcher control is added in Step 26; this is its mechanism.
 */
export function changeLanguage(lng: SupportedLanguage): Promise<unknown> {
  return i18next.changeLanguage(lng);
}

export default i18next;
