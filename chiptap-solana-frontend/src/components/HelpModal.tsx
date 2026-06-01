// ============================================================
// src/components/HelpModal.tsx — first-run + on-demand how-to-play
//
// One modal, two entry points:
//   • Auto-opens once on a visitor's first page load (localStorage gate
//     HELP_SEEN_KEY) so a brand-new player sees the flow before they
//     even connect a wallet (step 1 IS "connect a wallet").
//   • The "?" button in RetroHeader opens it any time.
//
// Content is devnet-aware (faucet link) and reads prices from config so
// it can't drift from the on-chain tiers.  Kept skimmable: numbered
// steps + a short blurb each, scrollable body for small screens.
// ============================================================

import React from "react";
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
  const faucetUrl = "https://faucet.solana.com/";
  const cheapestTier = POOL_TIERS[0]?.label ?? "0.05 SOL";
  const cheapestMint = DEFAULT_MINT_PRICE_SOL[0] ?? 0.02;

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
        style={{
          maxWidth: 560, borderColor: GOLD, background: "#0f0f24",
          marginTop: 8, marginBottom: 24,
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 mb-3">
          <span className="font-pixel animate-glow" style={{ fontSize: 13, color: MAGENTA }}>
            HOW TO PLAY
          </span>
          <button
            onClick={onClose}
            className="retro-btn"
            style={{ fontSize: 9, padding: "4px 10px" }}
          >
            CLOSE [X]
          </button>
        </div>

        <div
          className="text-sm mb-3 opacity-80"
          style={{ fontFamily: "'VT323', monospace", lineHeight: 1.4 }}
        >
          ChipTap is a provably-fair on-chain battle game. You own NFT
          chips and stake SOL; every winner is picked by a verifiable
          Switchboard VRF — not by us. {CLUSTER !== "mainnet" && (
            <span style={{ color: GOLD }}>
              {" "}You're on <b>{CLUSTER}</b> — play money, no real value.
            </span>
          )}
        </div>

        <Step n={1} title="CONNECT A WALLET" color={CYAN}>
          Top-right <b>SELECT WALLET</b> button. Phantom, Solflare, or
          Backpack all work. {CLUSTER !== "mainnet" && (
            <>Set your wallet's network to <b>{CLUSTER}</b>.</>
          )}
        </Step>

        {CLUSTER !== "mainnet" && (
          <Step n={2} title="GET FREE DEVNET SOL" color={GOLD}>
            You need a little SOL for fees + stakes. Grab some free from{" "}
            <a href={faucetUrl} target="_blank" rel="noreferrer" style={{ color: GOLD }}>
              faucet.solana.com ↗
            </a>{" "}
            — paste your wallet address, request ~1 SOL.
          </Step>
        )}

        <Step n={CLUSTER !== "mainnet" ? 3 : 2} title="MINT A CHIP" color={GREEN}>
          Go to the <b>[+] MINT</b> tab. A chip is your NFT fighter —
          cheapest is ~{cheapestMint} SOL. You need at least one to enter
          any game.
        </Step>

        <Step n={CLUSTER !== "mainnet" ? 4 : 3} title="FUND YOUR ARENA BALANCE" color={CYAN}>
          Stakes come from an <b>internal balance</b> inside the game (not
          your wallet directly). On the <b>[!] BATTLE</b> tab use the
          <i> INTERNAL BALANCE</i> banner to <b>DEPOSIT</b> some SOL. It's
          on-chain and yours — <b>WITHDRAW</b> any time. Joining a game
          auto-tops-up if you're short, so this step is optional.
        </Step>

        <Step n={CLUSTER !== "mainnet" ? 5 : 4} title="PICK A MODE & PLAY" color={MAGENTA}>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: CYAN }}>[!] BATTLE</span> — 1v1. Stake {cheapestTier}+.
            Loser either pays the pool (95% to winner) to keep their chip,
            or forfeits the chip.
          </div>
          <div style={{ marginBottom: 4 }}>
            <span style={{ color: MAGENTA }}>[%] ROYALE</span> — up to 8
            players, one VRF roll picks the winner who takes the whole
            pool. Chips are just your ticket in — they always come back.
          </div>
          <div>
            <span style={{ color: GOLD }}>[T] TOURNEY</span> — buy a ticket
            ({TICKET_PRICE_SOL} SOL), enter an 8-player bracket. Prizes:
            1st {T_PRIZE_1ST_PCT}% / 2nd {T_PRIZE_2ND_PCT}% / 3rd{" "}
            {T_PRIZE_3RD_PCT}% of the pool ({T_FEE_PCT}% fee).
          </div>
        </Step>

        <Step n={CLUSTER !== "mainnet" ? 6 : 5} title="CLAIM & CASH OUT" color={GREEN}>
          Won? Your winnings land in your internal balance — hit
          <b> CLAIM</b> on the result screen, then <b>WITHDRAW</b> on the
          BATTLE tab to move SOL back to your wallet. Always reclaim your
          chip too.
        </Step>

        {/* Fairness note */}
        <div
          className="mt-2"
          style={{ background: "#001a11", border: `2px solid ${GREEN}`, padding: "8px 10px" }}
        >
          <div className="font-pixel mb-1" style={{ fontSize: 8, color: GREEN }}>
            ✓ WHY IT'S FAIR
          </div>
          <div className="text-sm opacity-80" style={{ fontFamily: "'VT323', monospace", lineHeight: 1.35 }}>
            Every result opens an <b>ON-CHAIN AUDIT TRAIL</b> panel with the
            VRF seed and a Switchboard randomness account you can verify on
            solscan. The project can't pick winners — the oracle network
            signs the randomness and the program checks the proof before
            using it.
          </div>
        </div>

        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="retro-btn retro-btn-gold" style={{ fontSize: 10, padding: "6px 16px" }}>
            GOT IT — LET'S PLAY
          </button>
        </div>
      </div>
    </div>
  );
}
