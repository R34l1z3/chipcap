// ============================================================
// src/i18n/index.ts — react-i18next init (6 languages)
//
// en is the base + fallback.  Language is detected from localStorage
// (key `chiptap_lang`) then the browser, and persisted on change.
//
// We mirror the active language onto <html lang="…"> so the per-script
// font CSS in index.css can swap in a pixel font that actually covers
// the script (Press Start 2P / VT323 are Latin-only):
//   ru → Pixelify Sans (pixel, Cyrillic)
//   zh → Zpix (pixel, CJK)  + Noto Sans SC fallback until the subset loads
//   hi → Noto Sans Devanagari (no pixel Devanagari font exists)
// ============================================================

import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import en from "./locales/en.json";
import zh from "./locales/zh.json";
import ru from "./locales/ru.json";
import hi from "./locales/hi.json";
import es from "./locales/es.json";
import pt from "./locales/pt.json";

// Native-name labels for the switcher (each shown in its own script).
export const LANGS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "ru", label: "Русский" },
  { code: "hi", label: "हिन्दी" },
  { code: "es", label: "Español" },
  { code: "pt", label: "Português" },
];

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      zh: { translation: zh },
      ru: { translation: ru },
      hi: { translation: hi },
      es: { translation: es },
      pt: { translation: pt },
    },
    fallbackLng: "en",
    supportedLngs: ["en", "zh", "ru", "hi", "es", "pt"],
    // Treat "en-US", "pt-BR", "zh-CN" etc. as their base language.
    load: "languageOnly",
    interpolation: { escapeValue: false }, // React already escapes
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "chiptap_lang",
      caches: ["localStorage"],
    },
  });

// Keep <html lang> in sync so the per-script font rules apply.
function syncHtmlLang(lng: string) {
  document.documentElement.lang = (lng || "en").split("-")[0];
}
i18n.on("languageChanged", syncHtmlLang);
syncHtmlLang(i18n.language);

export default i18n;
