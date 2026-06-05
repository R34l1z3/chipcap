// ============================================================
// src/components/LanguageSwitcher.tsx — compact language dropdown
//
// A native <select> (accessible, zero-dep) styled to fit the retro
// header.  Each option shows its language's native name.  Choice is
// persisted by i18next's LanguageDetector (localStorage chiptap_lang),
// and <html lang> is synced in src/i18n/index.ts so the per-script
// fonts kick in.
// ============================================================

import React from "react";
import { useTranslation } from "react-i18next";
import { LANGS } from "../i18n";

export default function LanguageSwitcher() {
  const { i18n } = useTranslation();
  const current = (i18n.language || "en").split("-")[0];

  return (
    <select
      aria-label="Language"
      value={current}
      onChange={(e) => i18n.changeLanguage(e.target.value)}
      className="font-pixel"
      style={{
        fontSize: 9,
        color: "#FFD700",
        background: "linear-gradient(180deg, #3a3a7a 0%, #2a2a5a 100%)",
        border: "2px outset #6a6aaa",
        height: 28,
        padding: "0 4px",
        cursor: "pointer",
        flexShrink: 0,
        outline: "none",
        touchAction: "manipulation",
      }}
    >
      {LANGS.map((l) => (
        <option key={l.code} value={l.code} style={{ background: "#0a0a2e", color: "#FFD700" }}>
          {l.label}
        </option>
      ))}
    </select>
  );
}
