// ============================================================
// src/components/HelpModal.tsx — first-run + on-demand how-to-play
//
// One modal, two entry points:
//   • Auto-opens once on a visitor's first page load (HELP_SEEN_KEY).
//   • The "?" button in RetroHeader opens it any time.
//
// Fully i18n'd (SEC-25) — all copy comes from t("help.*"); prices/tiers
// are interpolated from config so they can't drift from the on-chain
// values, and the devnet faucet step auto-drops on mainnet.
// ============================================================

import React from "react";
import { useTranslation } from "react-i18next";
import {
  CLUSTER, POOL_TIERS, DEFAULT_MINT_PRICE_SOL, TICKET_PRICE_SOL,
  T_PRIZE_1ST_PCT, T_PRIZE_2ND_PCT, T_PRIZE_3RD_PCT, T_FEE_PCT,
} from "../config";

export const HELP_SEEN_KEY = "chiptap_help_seen_v1";

const GOLD = "#FFD700";
const CYAN = "#00FFFF";
const MAGENTA = "#FF00FF";
const GREEN = "#00FF88";

function Step({ n, title, color, children }: {
  n: number; title: string; color: string; children: React.ReactNode;
}) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="flex items-center gap-2 mb-1">
        <span
          className="font-pixel flex items-center justify-center flex-shrink-0"
          style={{
            fontSize: 10, width: 22, height: 22, color: "#000",
            background: color, border: "2px outset #fff",
          }}
        >
          {n}
        </span>
        <span className="font-pixel" style={{ fontSize: 10, color }}>{title}</span>
      </div>
      <div
        className="text-sm opacity-90"
        style={{ fontFamily: "'VT323', monospace", lineHeight: 1.35, paddingLeft: 30 }}
      >
        {children}
      </div>
    </div>
  );
}

export default function HelpModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const isDevnet = CLUSTER !== "mainnet";
  const faucetUrl = "https://faucet.solana.com/";
  const cheapestTier = POOL_TIERS[0]?.label ?? "0.05 SOL";
  const cheapestMint = DEFAULT_MINT_PRICE_SOL;

  // Step numbers shift down by one on mainnet (no faucet step).
  const sMint = isDevnet ? 3 : 2;
  const sFund = isDevnet ? 4 : 3;
  const sPlay = isDevnet ? 5 : 4;
  const sClaim = isDevnet ? 6 : 5;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0, zIndex: 9500,
        background: "rgba(0,0,0,0.75)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        padding: "16px 8px", overflowY: "auto",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="retro-panel w-full"
        style={{ maxWidth: 560, borderColor: GOLD, background: "#0f0f24", marginTop: 8, marginBottom: 24 }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 mb-3">
          <span className="font-pixel animate-glow" style={{ fontSize: 13, color: MAGENTA }}>
            {t("help.title")}
          </span>
          <button onClick={onClose} className="retro-btn" style={{ fontSize: 9, padding: "4px 10px" }}>
            {t("common.close")} [X]
          </button>
        </div>

        <div className="text-sm mb-3 opacity-80" style={{ fontFamily: "'VT323', monospace", lineHeight: 1.4 }}>
          {t("help.intro")}{" "}
          {isDevnet && (
            <span style={{ color: GOLD }}>{t("help.introDevnet", { cluster: CLUSTER })}</span>
          )}
        </div>

        <Step n={1} title={t("help.step1Title")} color={CYAN}>
          {t("help.step1Body")}{" "}
          {isDevnet && <>{t("help.step1Network", { cluster: CLUSTER })}</>}
        </Step>

        {isDevnet && (
          <Step n={2} title={t("help.step2Title")} color={GOLD}>
            {t("help.step2Body", { faucet: "faucet.solana.com" })}
            <div style={{ marginTop: 4 }}>
              <a href={faucetUrl} target="_blank" rel="noreferrer"
                 className="retro-btn retro-btn-gold inline-block"
                 style={{ fontSize: 8, padding: "3px 10px", textDecoration: "none" }}>
                {t("help.step2Title")} ↗
              </a>
            </div>
          </Step>
        )}

        <Step n={sMint} title={t("help.step3Title")} color={GREEN}>
          {t("help.step3Body", { price: cheapestMint })}
        </Step>

        <Step n={sFund} title={t("help.step4Title")} color={CYAN}>
          {t("help.step4Body")}
        </Step>

        <Step n={sPlay} title={t("help.step5Title")} color={MAGENTA}>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: CYAN }}>[!] BATTLE</span> — {t("help.step5Battle", { tier: cheapestTier })}
          </div>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: MAGENTA }}>[%] ROYALE</span> — {t("help.step5Royale")}
          </div>
          <div>
            <span style={{ color: GOLD }}>[T] TOURNEY</span> —{" "}
            {t("help.step5Tourney", {
              ticket: TICKET_PRICE_SOL,
              p1: T_PRIZE_1ST_PCT, p2: T_PRIZE_2ND_PCT, p3: T_PRIZE_3RD_PCT, fee: T_FEE_PCT,
            })}
          </div>
        </Step>

        <Step n={sClaim} title={t("help.step6Title")} color={GREEN}>
          {t("help.step6Body")}
        </Step>

        {/* Fairness note */}
        <div className="mt-2" style={{ background: "#001a11", border: `2px solid ${GREEN}`, padding: "8px 10px" }}>
          <div className="font-pixel mb-1" style={{ fontSize: 8, color: GREEN }}>
            ✓ {t("help.fairTitle")}
          </div>
          <div className="text-sm opacity-80" style={{ fontFamily: "'VT323', monospace", lineHeight: 1.35 }}>
            {t("help.fairBody")}
          </div>
        </div>

        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="retro-btn retro-btn-gold" style={{ fontSize: 10, padding: "6px 16px" }}>
            {t("help.gotIt")}
          </button>
        </div>
      </div>
    </div>
  );
}
