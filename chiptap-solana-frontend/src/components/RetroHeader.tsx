// ============================================================
// src/components/RetroHeader.tsx — uses Solana wallet-adapter
// ============================================================

import React from "react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";

type Tab = "mint" | "inventory" | "battle" | "royale" | "history" | "leaderboard" | "profile";

export default function RetroHeader({
  tab, setTab,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  const tabs: { id: Tab; label: string; icon: string; short: string }[] = [
    { id: "mint",        label: "MINT",     icon: "+", short: "MINT" },
    { id: "inventory",   label: "MY CHIPS", icon: "#", short: "CHIPS" },
    { id: "battle",      label: "BATTLE",   icon: "!", short: "PVP" },
    { id: "royale",      label: "ROYALE",   icon: "%", short: "BR" },
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
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-pixel text-xs text-white truncate">
            ChipTap PvP
          </span>
          <span className="hidden sm:inline text-yellow-300 font-pixel text-xs animate-blink flex-shrink-0">
            v0.1 / Solana
          </span>
        </div>
        {/* Wallet-adapter modal trigger.  Style overrides live in index.css. */}
        <WalletMultiButton />
      </div>

      {/* Marquee */}
      <div className="retro-ticker">
        <div className="animate-marquee inline-block text-retro-gold font-pixel" style={{ fontSize: 9 }}>
          *** CHIPTAP ON SOLANA *** PHANTOM / SOLFLARE / BACKPACK *** PROVABLY FAIR *** METAPLEX CORE NFTs ***
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
