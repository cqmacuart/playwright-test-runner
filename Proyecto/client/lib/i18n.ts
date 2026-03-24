import en from "../locales/en.json";
import es from "../locales/es.json";

export type Language = "en" | "es";
export type TranslationKey = keyof typeof en;

const translations = { en, es };

/**
 * A simple hook for translations.
 * In a larger app, this would be backed by a Context Provider.
 */
export function useTranslation(lang: Language) {
  const t = translations[lang];

  return {
    t: (key: TranslationKey): string => {
      return t[key] || en[key] || key;
    },
    translations: t,
  };
}
