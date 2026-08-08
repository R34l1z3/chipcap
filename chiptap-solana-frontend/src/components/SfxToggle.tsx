// Sound on/off, sitting next to the help button in the header.
// Muted by default (see lib/sfx.ts) — the click that turns it on is
// also the user gesture that unlocks the AudioContext, so the first
// sting after enabling actually plays.
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { isSfxOn, setSfxOn, subscribeSfx } from "../lib/sfx";

export default function SfxToggle() {
  const { t } = useTranslation();
  const [on, setOn] = useState(isSfxOn());

  useEffect(() => subscribeSfx(setOn), []);

  const label = on ? t("header.soundOff") : t("header.soundOn");

  return (
    <button
      onClick={() => setSfxOn(!on)}
      title={label}
      aria-label={label}
      aria-pressed={on}
      className="font-pixel"
      style={{
        fontSize: 11,
        lineHeight: 1,
        padding: "4px 7px",
        background: "transparent",
        border: `1px solid ${on ? "#FFD700" : "#4a4a8a"}`,
        color: on ? "#FFD700" : "#4a4a8a",
        cursor: "pointer",
      }}
    >
      {on ? "♪" : "×"}
    </button>
  );
}
