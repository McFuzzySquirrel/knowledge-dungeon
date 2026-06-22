/**
 * i18n / internationalization configuration.
 *
 * Uses i18next with browser language detection to support multiple locales.
 * Currently supported: English (en), Spanish (es).
 *
 * Phase 5: Quality & Scale - Localization support.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import es from './locales/es.json';

export const SUPPORTED_LOCALES = ['en', 'es'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const LOCALE_LABELS: Record<SupportedLocale, string> = {
  en: 'English',
  es: 'Español',
};

export const DEFAULT_LOCALE: SupportedLocale = 'en';

const resources = {
  en: { translation: en },
  es: { translation: es },
} as const;

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: SUPPORTED_LOCALES as unknown as string[],
    interpolation: {
      escapeValue: false, // React already escapes
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
      lookupLocalStorage: 'knowledge-dungeon:locale',
    },
  });

export default i18n;
