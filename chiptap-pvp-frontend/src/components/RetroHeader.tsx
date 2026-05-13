// ============================================================
// src/components/RetroHeader.tsx
// ============================================================

import React from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";

type Tab = "mint" | "inventory" | "battle" | "history" | "leaderboard" | "profile";

export default function RetroHeader({
  tab,
  setTab,
}: {
  tab: Tab;
  setTab: (t: Tab) => void;
}) {
  // `short` is the icon-only label used on phones (<sm). `label` is full
  // text shown on tablet+ alongside the icon.
  const tabs: { id: Tab; label: string; icon: string; short: string }[] = [
    { id: "mint",        label: "MINT",     icon: "+", short: "MINT" },
    { id: "inventory",   label: "MY CHIPS", icon: "#", short: "CHIPS" },
    { id: "battle",      label: "BATTLE",   icon: "!", short: "PVP" },
    { id: "leaderboard", label: "TOP",      icon: "*", short: "TOP" },
    { id: "profile",     label: "ME",       icon: "@", short: "ME" },
    { id: "history",     label: "HISTORY",  icon: "?", short: "LOG" },
  ];

  return (
    <header>
      {/* Title bar — Windows 98 style */}
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
            v1.0
          </span>
        </div>
        <ConnectButton.Custom>
          {({ account, chain, openConnectModal, openAccountModal, mounted }) => {
            if (!mounted || !account || !chain) {
              return (
                <button
                  onClick={openConnectModal}
                  className="retro-btn retro-btn-gold flex-shrink-0"
                  style={{ fontSize: 9, padding: "4px 8px" }}
                >
                  <span className="hidden sm:inline">CONNECT WALLET</span>
                  <span className="sm:hidden">CONNECT</span>
                </button>
              );
            }
            return (
              <button
                onClick={openAccountModal}
                className="retro-btn flex-shrink-0"
                style={{ fontSize: 9, padding: "4px 8px" }}
              >
                <span className="hidden sm:inline">
                  {account.displayName} [{chain.name?.slice(0, 6)}]
                </span>
                <span className="sm:hidden">
                  {account.displayName}
                </span>
              </button>
            );
          }}
        </ConnectButton.Custom>
      </div>

      {/* Marquee ticker — hide on very narrow screens to save vertical space */}
      <div className="retro-ticker hidden xs:block sm:block">
        <div className="animate-marquee inline-block text-retro-gold font-pixel" style={{ fontSize: 9 }}>
          *** WELCOME TO CHIPTAP PvP *** MINT YOUR CHIPS *** BATTLE OTHER PLAYERS *** WIN NFTs *** 50/50 PROVABLY FAIR *** POWERED BY CHAINLINK VRF ***
        </div>
      </div>

      {/* Tab navigation — horizontal scroll fallback if it ever overflows */}
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
            {/* Phone (<sm): icon-only or short label */}
            <span className="sm:hidden">[{t.icon}] {t.short}</span>
            {/* Tablet+ (sm:): full label */}
            <span className="hidden sm:inline" style={{ fontSize: 10 }}>
              [{t.icon}] {t.label}
            </span>
          </button>
        ))}
      </nav>
    </header>
  );
}
