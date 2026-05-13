import React from "react";
import { RARITIES } from "../config";

interface ChipCardProps {
  tokenId: number;
  rarity: number;
  battleCount?: number;
  winCount?: number;
  selected?: boolean;
  onClick?: () => void;
  size?: "sm" | "md" | "lg";
}

export default function ChipCard({ tokenId, rarity, battleCount = 0, winCount = 0, selected = false, onClick, size = "md" }: ChipCardProps) {
  const r = RARITIES[rarity] || RARITIES[0];
  const dims = size === "sm" ? "w-24 h-28" : size === "lg" ? "w-40 h-48" : "w-32 h-36";

  return (
    <div
      onClick={onClick}
      className={`chip-card ${dims} flex flex-col items-center justify-center cursor-pointer transition-all ${r.bgClass}`}
      style={{
        borderColor: selected ? "#FFD700" : r.color,
        borderWidth: selected ? 3 : 2,
        boxShadow: selected ? `0 0 20px ${r.color}66, inset 0 0 15px ${r.color}22` : `0 0 5px ${r.color}22`,
      }}
    >
      <svg viewBox="0 0 64 64" className={size === "sm" ? "w-12 h-12" : size === "lg" ? "w-20 h-20" : "w-16 h-16"} style={{ imageRendering: "pixelated" }}>
        <circle cx="32" cy="32" r="28" fill="none" stroke={r.color} strokeWidth="2" opacity="0.5" />
        <circle cx="32" cy="32" r="22" fill={r.color + "33"} stroke={r.color} strokeWidth="2" />
        <circle cx="32" cy="32" r="14" fill="none" stroke={r.color} strokeWidth="1" opacity="0.6" />
        {[0, 90, 180, 270].map((a) => {
          const rad = (a * Math.PI) / 180;
          return <line key={a} x1={32 + 22 * Math.cos(rad)} y1={32 + 22 * Math.sin(rad)} x2={32 + 28 * Math.cos(rad)} y2={32 + 28 * Math.sin(rad)} stroke={r.color} strokeWidth="3" />;
        })}
        <text x="32" y="34" textAnchor="middle" dominantBaseline="central" fill={r.color} fontSize="10" fontFamily="monospace" fontWeight="bold">#{tokenId}</text>
      </svg>
      <div className="font-pixel mt-1 uppercase" style={{ fontSize: 7, color: r.color, letterSpacing: 1 }}>{r.name}</div>
      {battleCount > 0 && size !== "sm" && <div className="text-xs mt-1 opacity-70" style={{ fontSize: 12 }}>{winCount}W/{battleCount - winCount}L</div>}
    </div>
  );
}
