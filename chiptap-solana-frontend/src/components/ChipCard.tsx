// Chip card — identified by Asset Pubkey on Solana, badge kept for flavour.
// SEC-26 — shows the chip's TIER (T0..T4) and, when progression data is
// available, a thin progress bar toward the next tier.
import React from "react";
import { useTranslation } from "react-i18next";
import { TIERS, tierProgress } from "../config";

interface ChipCardProps {
  tokenId?: number;
  asset?:   string;
  tier:     number;
  progressionWins?: number;   // SEC-26 — drives the next-tier progress bar
  battleCount?: number;
  winCount?:    number;
  selected?:    boolean;
  onClick?:     () => void;
  size?: "sm" | "md" | "lg";
}

export default function ChipCard({
  tokenId, asset, tier,
  progressionWins,
  battleCount = 0, winCount = 0,
  selected = false, onClick, size = "md",
}: ChipCardProps) {
  const { t } = useTranslation();
  const ti = TIERS[tier] || TIERS[0];
  const dims = size === "sm" ? "w-24 h-28" : size === "lg" ? "w-40 h-48" : "w-32 h-36";

  // Display badge: prefer numeric token_id; fall back to last 4 of asset.
  const badge =
    tokenId != null ? `#${tokenId}` :
    asset ? `…${asset.slice(-4)}` : "—";

  const prog = progressionWins != null ? tierProgress(progressionWins, tier) : null;

  return (
    <div
      onClick={onClick}
      className={`chip-card ${dims} flex flex-col items-center justify-center cursor-pointer transition-all ${ti.bgClass}`}
      style={{
        borderColor: selected ? "#FFD700" : ti.color,
        borderWidth: selected ? 3 : 2,
        boxShadow: selected
          ? `0 0 20px ${ti.color}66, inset 0 0 15px ${ti.color}22`
          : `0 0 5px ${ti.color}22`,
      }}
    >
      <svg
        viewBox="0 0 64 64"
        className={size === "sm" ? "w-12 h-12" : size === "lg" ? "w-20 h-20" : "w-16 h-16"}
        style={{ imageRendering: "pixelated" }}
      >
        <circle cx="32" cy="32" r="28" fill="none" stroke={ti.color} strokeWidth="2" opacity="0.5" />
        <circle cx="32" cy="32" r="22" fill={ti.color + "33"} stroke={ti.color} strokeWidth="2" />
        <circle cx="32" cy="32" r="14" fill="none" stroke={ti.color} strokeWidth="1" opacity="0.6" />
        {[0, 90, 180, 270].map((a) => {
          const rad = (a * Math.PI) / 180;
          return (
            <line key={a}
              x1={32 + 22 * Math.cos(rad)} y1={32 + 22 * Math.sin(rad)}
              x2={32 + 28 * Math.cos(rad)} y2={32 + 28 * Math.sin(rad)}
              stroke={ti.color} strokeWidth="3" />
          );
        })}
        <text x="32" y="34" textAnchor="middle" dominantBaseline="central"
          fill={ti.color} fontSize="9" fontFamily="monospace" fontWeight="bold">
          {badge}
        </text>
      </svg>
      <div className="font-pixel mt-1 uppercase" style={{ fontSize: 7, color: ti.color, letterSpacing: 1 }}>
        {t(`tier.${tier}`)}
      </div>
      {/* Progress toward next tier (hidden at sm + at max tier). */}
      {prog && prog.next != null && size !== "sm" && (
        <div className="mt-1 w-full px-2">
          <div style={{ height: 3, background: "#2a2a5a", borderRadius: 1 }}>
            <div style={{
              height: 3, width: `${Math.round(prog.pct * 100)}%`,
              background: ti.color, borderRadius: 1,
            }} />
          </div>
          <div className="text-center opacity-60" style={{ fontSize: 7 }}>
            {progressionWins}/{prog.next}
          </div>
        </div>
      )}
      {battleCount > 0 && size !== "sm" && (
        <div className="text-xs mt-1 opacity-70" style={{ fontSize: 12 }}>
          {winCount}W/{battleCount - winCount}L
        </div>
      )}
    </div>
  );
}
