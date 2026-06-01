// ============================================================
// src/components/RetroHeader.tsx — uses Solana wallet-adapter
// ============================================================

import React from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

type Tab = "mint" | "inventory" | "battle" | "royale" | "tournament" | "history" | "leaderboard" | "profile";

export default function RetroHeader({
  tab, setTab, onHelp,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
  onHelp?: () => void;
}) {
  const tabs: { id: Tab; label: string; icon: string; short: string }[] = [
    { id: "mint",        label: "MINT",     icon: "+", short: "MINT" },
    { id: "inventory",   label: "MY CHIPS", icon: "#", short: "CHIPS" },
    { id: "battle",      label: "BATTLE",   icon: "!", short: "PVP" },
    { id: "royale",      label: "ROYALE",   icon: "%", short: "BR" },
    { id: "tournament",  label: "TOURNEY",  icon: "T", short: "TRN" },
    { id: "leaderboard", label: "TOP",      icon: "*", short: "TOP" },
    { id: "profile",     label: "ME",       icon: "@", short: "ME" },
    { id: "history",     label: "HISTORY",  icon: "?", short: "LOG" },
  ];

  return (
    <header>
      {/* Title bar */}
      <div
        className="flex items-center justify-between gap-2 px-2 sm:px-3 py-1"
        style={{
          background: "linear-gradient(90deg, #000080 0%, #1084d0 100%)",
          borderBottom: "2px solid #4a4a8a",
        }}
      >
        {/* Brand never truncates — it's flex-shrink-0 so a narrow header
            shrinks the wallet button's whitespace instead of eating the
            name.  "PvP" is a dim accent, not part of the truncatable run. */}
        <div className="flex items-baseline gap-1.5 flex-shrink-0">
          <span className="font-pixel text-xs text-white">ChipTap</span>
          <span className="font-pixel text-retro-gold" style={{ fontSize: 9 }}>PvP</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* How-to-play — opens the same modal that auto-shows on first visit. */}
          {onHelp && (
            <button
              onClick={onHelp}
              title="How to play"
              aria-label="How to play"
              className="font-pixel"
              style={{
                fontSize: 12, color: "#FFD700",
                width: 28, height: 28, lineHeight: "24px",
                border: "2px outset #6a6aaa",
                background: "linear-gradient(180deg, #3a3a7a 0%, #2a2a5a 100%)",
                cursor: "pointer", flexShrink: 0,
                textShadow: "0 0 6px #FFD700",
                touchAction: "manipulation",
              }}
            >
              ?
            </button>
          )}
          {/* Wallet-adapter modal trigger.  Style overrides live in index.css. */}
          <WalletMultiButton />
        </div>
      </div>

      {/* Tabs */}
      <nav
        className="flex border-b-2 border-retro-border overflow-x-auto"
        style={{ scrollbarWidth: "none" }}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className="flex-1 min-w-[60px] py-2 text-center font-pixel transition-all"
            style={{
              fontSize: 9,
              background: tab === t.id ? "#1a1a4e" : "#0a0a2e",
              color: tab === t.id ? "#FFD700" : "#4a4a8a",
              borderRight: "1px solid #2a2a5a",
              borderTop: tab === t.id ? "2px solid #FFD700" : "2px solid transparent",
              textShadow: tab === t.id ? "0 0 10px #FFD700" : "none",
              touchAction: "manipulation",
            }}
          >
            <span className="sm:hidden">[{t.icon}] {t.short}</span>
            <span className="hidden sm:inline" style={{ fontSize: 10 }}>
              [{t.icon}] {t.label}
            </span>
          </button>
        ))}
      </nav>
    </header>
  );
}
