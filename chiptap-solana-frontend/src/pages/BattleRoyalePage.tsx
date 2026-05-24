// ============================================================
// src/pages/BattleRoyalePage.tsx — SEC-22 — 8-player BR mode
// ============================================================
//
// Three views in one tab, same pattern as BattlePage:
//   • Lobby  — open BRs + my active + rolling/decided
//   • Create — pool tier + max_players (2..8) + creator chip
//   • Watch  — minimal "see status / claim chip / claim winnings"
//              with on-chain audit panel
//
// Trust + UX notes:
//   • Stake comes from the player's internal `UserAccount.balance`
//     (same as 1v1) — there is no fresh deposit at join time.  The
//     player MUST top up via the 1v1 BattlePage's
//     DepositWithdrawBanner first if their balance is < pool_tier
//     SOL.  We surface a yellow banner about this in Create + Lobby.
//   • Chips in BR are MEMBERSHIP TOKENS — they always come back.
//     Only the stake (pool_tier SOL) is at risk.
//   • Relayer auto-fulfills VRF via Switchboard On-Demand once the
//     lobby fills (BattleRoyaleRolling event).  See SWITCHBOARD.md.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";

import { useArenaProgram } from "../hooks/useArenaProgram";
import { useTreasuryProgram } from "../hooks/useTreasuryProgram";
import { useArenaConfig } from "../hooks/useArenaConfig";
import { useUserAccount } from "../hooks/useUserAccount";
import { useChipsByOwner } from "../hooks/useChipsByOwner";
import {
  useIndexerBattleRoyales, type BattleRoyaleData,
} from "../hooks/useIndexerBattleRoyales";

import { notify, notifyTxError } from "../lib/notifications";
import * as pda from "../lib/pda";
import { MPL_CORE_PROGRAM } from "../lib/mpl";
import {
  POOL_TIERS, BATTLE_STATUS, BR_PLAYER_OPTIONS,
  BR_MIN_PLAYERS, BR_MAX_PLAYERS_CAP, BR_CANCEL_REASON,
} from "../config";
import { fmtSol, lamportsToSol, shortAddr } from "../lib/format";
import ChipCard from "../components/ChipCard";
import BattleAuditPanel from "../components/BattleAuditPanel";

type View = "lobby" | "create" | "watch";

// ============================================================
// BalanceHint — single source of truth for "do you have enough
// SOL inside the arena to join?".  Shared by Lobby + Create.
// ============================================================

function BalanceHint({ neededLamports }: { neededLamports: number }) {
  const { publicKey } = useWallet();
  const { data: user } = useUserAccount();
  if (!publicKey) return null;
  const have = user?.balance?.toNumber?.() ?? 0;
  if (have >= neededLamports) return null;
  const shortBy = neededLamports - have;
  return (
    <div
      className="retro-panel mb-3"
      style={{ borderColor: "#FFD700", background: "#221a00" }}
    >
      <div className="text-xs">
        <span className="font-pixel text-retro-gold" style={{ fontSize: 9 }}>
          NEED MORE INTERNAL BALANCE
        </span>
        <div className="opacity-80 mt-1">
          You have <span className="text-retro-gold">{fmtSol(have / 1e9)} SOL</span> internal,
          {" "}need <span className="text-retro-gold">{fmtSol(neededLamports / 1e9)} SOL</span>
          {" "}(short by {fmtSol(shortBy / 1e9)} SOL).
          {" "}Top up via the <span className="text-retro-cyan">BATTLE</span> tab's
          {" "}<i>INTERNAL BALANCE</i> banner first.
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Lobby
// ============================================================

function Lobby({
  onCreate, onWatch,
}: {
  onCreate: () => void;
  onWatch: (id: number) => void;
}) {
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const arena = useArenaProgram();
  const { open, rolling, decided, myActive, loading, refetch } =
    useIndexerBattleRoyales();
  const { chips } = useChipsByOwner(me);

  const [joining, setJoining] = useState<number | null>(null);
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const handleJoin = async (br: BattleRoyaleData) => {
    if (!arena || !publicKey || !selectedChip) return;
    setBusy(br.id);
    try {
      const sig = await (arena.methods as any)
        .joinBattleRoyale()
        .accounts({
          config:        pda.arenaConfig(),
          royale:        pda.royale(br.id),
          chipAuthority: pda.chipAuthority(),
          chip:          new PublicKey(selectedChip),
          playerUser:    pda.userAccount(publicKey),
          authority:     publicKey,
          player:        publicKey,
          mplCore:       MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      notify("joined", `Joined royale #${br.id}! ${sig.slice(0, 8)}…`);
      setJoining(null);
      setSelectedChip(null);
      await refetch();
    } catch (e) { notifyTxError("Join battle royale", e); }
    finally { setBusy(null); }
  };

  const hasChipInBr = (br: BattleRoyaleData) =>
    br.players.some((p) => p.player === me);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <h2 className="font-pixel text-retro-cyan" style={{ fontSize: 12 }}>
          &gt; BATTLE ROYALE LOBBY
        </h2>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => refetch()} className="retro-btn" style={{ fontSize: 8, padding: "4px 8px" }}>
            REFRESH
          </button>
          <button onClick={onCreate} className="retro-btn retro-btn-gold" style={{ fontSize: 8, padding: "4px 8px" }}>
            <span className="hidden sm:inline">+ CREATE ROYALE</span>
            <span className="sm:hidden">+ CREATE</span>
          </button>
        </div>
      </div>

      {/* My active royales */}
      {myActive.length > 0 && (
        <div className="mb-4">
          <div className="font-pixel text-retro-gold mb-2" style={{ fontSize: 9 }}>
            YOUR ACTIVE ROYALES:
          </div>
          {myActive.map((br) => {
            const isWinner = br.status === 2 && br.winner === me;
            return (
              <div
                key={br.id}
                className="retro-panel mb-2 cursor-pointer"
                style={{
                  borderColor:
                    br.status === 2 ? (isWinner ? "#00FF88" : "#FF3333") :
                    br.status === 1 ? "#FF00FF" : "#FFD700",
                }}
                onClick={() => onWatch(br.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>
                      ROYALE #{br.id}
                    </span>
                    <span className="ml-2 text-sm opacity-60">
                      {br.poolLabel} · {br.numJoined}/{br.maxPlayers}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-pixel px-2 py-0.5" style={{
                      fontSize: 8,
                      color:
                        br.status === 0 ? "#00FFFF" :
                        br.status === 1 ? "#FF00FF" :
                        br.status === 2 ? (isWinner ? "#00FF88" : "#FF3333") : "#aaa",
                      border: "1px solid currentColor",
                    }}>
                      {BATTLE_STATUS[br.status as keyof typeof BATTLE_STATUS]}
                    </span>
                    {isWinner && (
                      <span className="font-pixel text-retro-win" style={{ fontSize: 8 }}>
                        CLAIM
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Open royales */}
      <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>
        OPEN ROYALES ({open.length}):
      </div>

      {loading && open.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-retro-cyan animate-blink">LOADING...</div>
        </div>
      ) : open.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-sm opacity-60">No open royales. Be the first!</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {open.map((br) => {
            const alreadyIn = hasChipInBr(br);
            const isJoining = joining === br.id;
            const stakeLamports = Math.floor(br.poolSol * LAMPORTS_PER_SOL);
            return (
              <div key={br.id} className="retro-panel">
                <div className="flex items-start sm:items-center justify-between gap-2 mb-2 flex-wrap">
                  <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0">
                    <span className="font-pixel text-retro-cyan" style={{ fontSize: 10 }}>#{br.id}</span>
                    <span className="text-retro-gold font-pixel" style={{ fontSize: 12 }}>{br.poolLabel}</span>
                    <span className="font-pixel" style={{ fontSize: 10, color: "#FF00FF" }}>
                      {br.numJoined}/{br.maxPlayers}
                    </span>
                    <span className="text-xs opacity-50 truncate hidden sm:inline">
                      by {shortAddr(br.creator)}
                    </span>
                  </div>
                  {alreadyIn ? (
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 8 }}>
                      IN LOBBY ✓
                    </span>
                  ) : isJoining ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        className="retro-input text-sm py-1"
                        style={{ fontSize: 14, maxWidth: 180 }}
                        value={selectedChip ?? ""}
                        onChange={(e) => setSelectedChip(e.target.value || null)}
                      >
                        <option value="">Pick chip</option>
                        {chips.map((c) => (
                          <option key={c.asset} value={c.asset}>
                            #{c.token_id} · …{c.asset.slice(-4)}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleJoin(br)}
                        disabled={!selectedChip || busy === br.id}
                        className="retro-btn retro-btn-gold"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >
                        {busy === br.id ? "JOINING..." : "FIGHT!"}
                      </button>
                      <button
                        onClick={() => { setJoining(null); setSelectedChip(null); }}
                        className="retro-btn"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >X</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setJoining(br.id)}
                      className="retro-btn retro-btn-gold"
                      style={{ fontSize: 8, padding: "3px 8px" }}
                    >JOIN</button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs opacity-50 flex-wrap">
                  <span>stake {fmtSol(stakeLamports / 1e9)} SOL</span>
                  <span>|</span>
                  <span>{Math.floor((Date.now() / 1000 - br.createdAt) / 60)}m ago</span>
                  {br.players.length > 0 && (
                    <>
                      <span>|</span>
                      <span>seats: {br.players.map((p) => shortAddr(p.player)).join(", ")}</span>
                    </>
                  )}
                </div>
                {isJoining && (
                  <BalanceHint neededLamports={stakeLamports + 1_000_000 /* rent buffer */} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Rolling */}
      {rolling.length > 0 && (
        <div className="mt-4">
          <div className="font-pixel text-retro-magenta mb-2" style={{ fontSize: 9 }}>
            ROLLING ({rolling.length}):
          </div>
          {rolling.map((br) => (
            <div
              key={br.id}
              className="retro-panel mb-2 cursor-pointer"
              style={{ borderColor: "#FF00FF" }}
              onClick={() => onWatch(br.id)}
            >
              <div className="flex items-center justify-between">
                <span className="font-pixel" style={{ fontSize: 10, color: "#FF00FF" }}>
                  #{br.id} — {br.poolLabel} — {br.numJoined}/{br.maxPlayers}
                </span>
                <span className="animate-blink text-retro-magenta" style={{ fontSize: 12 }}>
                  WAITING FOR VRF...
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Decided (not yet settled — winner can claim) */}
      {decided.length > 0 && (
        <div className="mt-4">
          <div className="font-pixel mb-2" style={{ fontSize: 9, color: "#FFD700" }}>
            JUST DECIDED ({decided.length}):
          </div>
          {decided.map((br) => (
            <div
              key={br.id}
              className="retro-panel mb-2 cursor-pointer"
              style={{ borderColor: "#FFD700" }}
              onClick={() => onWatch(br.id)}
            >
              <div className="flex items-center justify-between">
                <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>
                  #{br.id} — {br.poolLabel}
                </span>
                <span className="text-xs opacity-60">winner: {shortAddr(br.winner)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Create
// ============================================================

function Create({ onBack }: { onBack: () => void }) {
  const { publicKey } = useWallet();
  const arena = useArenaProgram();
  const { chips } = useChipsByOwner(publicKey?.toBase58());
  const { data: cfg, refetch: refetchCfg } = useArenaConfig();
  const { refetch: refetchUser } = useUserAccount();

  const [chip, setChip] = useState<string | null>(null);
  const [tier, setTier] = useState(0);          // default cheapest tier
  const [maxPlayers, setMaxPlayers] = useState<number>(8);
  const [busy, setBusy] = useState(false);

  const stakeLamports = Math.floor(POOL_TIERS[tier].sol * LAMPORTS_PER_SOL);

  const handleCreate = async () => {
    if (!arena || !publicKey || !chip || !cfg) return;
    if (maxPlayers < BR_MIN_PLAYERS || maxPlayers > BR_MAX_PLAYERS_CAP) return;
    setBusy(true);
    try {
      const royaleId = cfg.nextBattleId.toString();
      // STEP 1 — create the royale (creator pays only rent here, no
      // chip / stake commitment yet).  This is two popups separated
      // by a refetch instead of one bundled tx because the join ix
      // reads the royale account immediately after, and Anchor's
      // .preInstructions() doesn't preserve account ordering across
      // ixs the way our manual flow needs.
      const createSig = await (arena.methods as any)
        .createBattleRoyale(tier, maxPlayers)
        .accounts({
          config:  pda.arenaConfig(),
          royale:  pda.royale(new BN(royaleId)),
          creator: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      notify("created", `Royale #${royaleId} created · ${createSig.slice(0, 8)}…`);
      await refetchCfg();

      // STEP 2 — creator joins as the first player.  Their chip goes to
      // chip_authority escrow and `pool_tier` SOL is moved from internal
      // balance to locked.
      const joinSig = await (arena.methods as any)
        .joinBattleRoyale()
        .accounts({
          config:        pda.arenaConfig(),
          royale:        pda.royale(new BN(royaleId)),
          chipAuthority: pda.chipAuthority(),
          chip:          new PublicKey(chip),
          playerUser:    pda.userAccount(publicKey),
          authority:     publicKey,
          player:        publicKey,
          mplCore:       MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      notify("joined", `Joined royale #${royaleId} · ${joinSig.slice(0, 8)}…`);
      await refetchUser();
      onBack();
    } catch (e) { notifyTxError("Create royale", e); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>
        &lt; BACK
      </button>
      <div className="retro-panel mb-4">
        <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 11 }}>
          &gt; CREATE NEW ROYALE
        </div>

        <div className="text-xs opacity-60 mb-3" style={{ lineHeight: 1.4 }}>
          Every player stakes <b>{POOL_TIERS[tier].label}</b>. Winner takes
          the pool minus the project fee. Chips are <i>membership tokens</i>
          {" "}— they always come back to their owner after the royale ends.
        </div>

        {/* 1. POOL */}
        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>1. SELECT POOL:</div>
          <div className="flex gap-2 flex-wrap">
            {POOL_TIERS.map((p) => (
              <button
                key={p.id}
                onClick={() => setTier(p.id)}
                className="retro-btn"
                style={{
                  fontSize: 10, padding: "6px 14px",
                  borderColor: tier === p.id ? "#FFD700" : "#4a4a8a",
                  color: tier === p.id ? "#FFD700" : "#4a4a8a",
                  textShadow: tier === p.id ? "0 0 10px #FFD700" : "none",
                }}
              >{p.label}</button>
            ))}
          </div>
        </div>

        {/* 2. MAX PLAYERS */}
        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>2. MAX PLAYERS:</div>
          <div className="flex gap-2 flex-wrap">
            {BR_PLAYER_OPTIONS.map((n) => (
              <button
                key={n}
                onClick={() => setMaxPlayers(n)}
                className="retro-btn"
                style={{
                  fontSize: 10, padding: "6px 14px",
                  borderColor: maxPlayers === n ? "#FF00FF" : "#4a4a8a",
                  color: maxPlayers === n ? "#FF00FF" : "#4a4a8a",
                  textShadow: maxPlayers === n ? "0 0 10px #FF00FF" : "none",
                }}
              >{n}P</button>
            ))}
          </div>
          <div className="text-xs opacity-50 mt-1">
            Pool will be {fmtSol(POOL_TIERS[tier].sol * maxPlayers)} SOL when full.
          </div>
        </div>

        {/* 3. CREATOR'S CHIP */}
        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>3. YOUR CHIP (creator auto-joins):</div>
          {chips.length === 0 ? (
            <div className="text-sm opacity-50">No chips. Mint one first!</div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {chips.map((c) => (
                <ChipCard
                  key={c.asset}
                  tokenId={c.token_id}
                  asset={c.asset}
                  rarity={c.rarity}
                  battleCount={c.battle_count}
                  winCount={c.win_count}
                  selected={chip === c.asset}
                  onClick={() => setChip(chip === c.asset ? null : c.asset)}
                  size="sm"
                />
              ))}
            </div>
          )}
        </div>

        {/* Balance hint — show only if user has selected a chip and is short */}
        {chip && (
          <BalanceHint neededLamports={stakeLamports + 1_000_000} />
        )}

        <button
          onClick={handleCreate}
          disabled={!chip || busy}
          className="retro-btn retro-btn-gold w-full py-3 font-pixel"
          style={{ fontSize: 12 }}
        >
          {busy
            ? ">> CONFIRM IN WALLET..."
            : `>> CREATE ${maxPlayers}P · ${POOL_TIERS[tier].label} ROYALE <<`}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Watch — minimal: status, players, claim chip, claim winnings,
// audit panel.  Full "force_resolve / expire_join" admin paths
// are deferred (admin can use a CLI).
// ============================================================

function Watch({ royaleId, onBack }: { royaleId: number; onBack: () => void }) {
  const { publicKey } = useWallet();
  const arena    = useArenaProgram();
  const treasury = useTreasuryProgram();
  const me = publicKey?.toBase58();

  const [br, setBr] = useState<any>(null);

  const fetchBr = useCallback(async () => {
    if (!arena) return;
    try {
      const acc = await (arena.account as any).battleRoyale.fetchNullable(pda.royale(royaleId));
      setBr(acc);
    } catch { setBr(null); }
  }, [arena, royaleId]);

  useEffect(() => {
    fetchBr();
    const id = setInterval(fetchBr, 3000);
    return () => clearInterval(id);
  }, [fetchBr]);

  // Per-player chip-claim state from the bitmask
  const playerSeats = useMemo(() => {
    if (!br) return [] as { slot: number; player: string; chip: string; claimed: boolean }[];
    const players: PublicKey[] = br.players ?? [];
    const chips:   PublicKey[] = br.chips   ?? [];
    const mask: number = Number(br.chipsClaimedMask ?? 0);
    return players.slice(0, Number(br.numJoined ?? 0)).map((p, i) => ({
      slot: i,
      player: p?.toBase58?.() ?? "",
      chip:   chips[i]?.toBase58?.() ?? "",
      claimed: (mask & (1 << i)) !== 0,
    }));
  }, [br]);

  const mySeat = playerSeats.find((s) => s.player === me);
  const isWinner = me && br?.winner?.toBase58?.() === me;
  const poolLabel = br ? (POOL_TIERS[Number(br.poolTier)]?.label ?? "?") : "?";

  const claimChip = async () => {
    if (!arena || !publicKey || !mySeat) return;
    try {
      const sig = await (arena.methods as any).claimChipBr()
        .accounts({
          config:        pda.arenaConfig(),
          royale:        pda.royale(royaleId),
          chipAuthority: pda.chipAuthority(),
          chip:          new PublicKey(mySeat.chip),
          player:        publicKey,
          mplCore:       MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        }).rpc();
      notify("info", `Reclaimed chip · ${sig.slice(0, 8)}…`);
      await fetchBr();
    } catch (e) { notifyTxError("Claim chip", e); }
  };

  const claimWinnings = async () => {
    if (!arena || !treasury || !publicKey) return;
    try {
      const sig = await (arena.methods as any).claimWinningsBr()
        .accounts({
          config:          pda.arenaConfig(),
          royale:          pda.royale(royaleId),
          vault:           pda.arenaVault(),
          winnerUser:      pda.userAccount(publicKey),
          winner:          publicKey,
          treasuryConfig:  pda.treasuryConfig(),
          treasuryVault:   pda.treasuryVault(),
          treasuryProgram: treasury.programId,
          caller:          publicKey,
          systemProgram:   SystemProgram.programId,
        }).rpc();
      notify("settled", `Claimed winnings · ${sig.slice(0, 8)}…`);
      await fetchBr();
    } catch (e) { notifyTxError("Claim winnings", e); }
  };

  if (!br) {
    return (
      <div>
        <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>&lt; BACK</button>
        <div className="retro-panel text-center py-8">
          <div className="animate-blink text-retro-cyan">LOADING ROYALE #{royaleId}…</div>
        </div>
      </div>
    );
  }

  const status = Number(br.status);
  const prizeClaimed = !!br.prizeClaimed;

  return (
    <div>
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>&lt; BACK</button>

      <div
        className="retro-panel"
        style={{
          borderColor:
            status === 2 ? (isWinner ? "#00FF88" : "#FF3333") :
            status === 1 ? "#FF00FF" : "#4a4a8a",
        }}
      >
        {/* Header */}
        <div className="text-center mb-4">
          <div className="font-pixel text-retro-gold" style={{ fontSize: 14 }}>ROYALE #{royaleId}</div>
          <div className="text-sm">
            {poolLabel} · {Number(br.numJoined)}/{Number(br.maxPlayers)}
          </div>
          <div className="font-pixel mt-1 inline-block px-3 py-0.5" style={{
            fontSize: 9,
            color:
              status === 0 ? "#00FFFF" :
              status === 1 ? "#FF00FF" :
              status === 2 ? "#FF3333" :
              status === 3 ? "#00FF00" : "#666",
            border: "1px solid currentColor",
          }}>
            {BATTLE_STATUS[status as keyof typeof BATTLE_STATUS]}
          </div>
        </div>

        {/* Seats */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
          {playerSeats.map((s) => {
            const isWin = br.winner?.toBase58?.() === s.player;
            return (
              <div
                key={s.slot}
                className="retro-panel"
                style={{
                  padding: 6,
                  borderColor: isWin ? "#00FF88" : "#2a2a5a",
                  background: isWin ? "#001a11" : undefined,
                }}
              >
                <div className="text-xs font-pixel" style={{
                  fontSize: 8,
                  color: s.player === me ? "#FFD700" : (isWin ? "#00FF88" : "#00FFFF"),
                }}>
                  SEAT {s.slot} {s.player === me && "(YOU)"}
                </div>
                <div className="text-xs opacity-70 truncate mt-1">{shortAddr(s.player)}</div>
                <div className="text-xs opacity-50 mt-1">chip …{s.chip.slice(-4)}</div>
                {s.claimed && (
                  <div className="text-xs font-pixel mt-1" style={{ fontSize: 7, color: "#666" }}>
                    chip claimed ✓
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Status-specific banners */}
        {status === 1 && (
          <div className="text-center py-3 animate-blink text-retro-magenta" style={{ fontSize: 12 }}>
            ROLLING — relayer is fulfilling Switchboard VRF…
          </div>
        )}

        {status === 2 && (
          <div className="text-center py-3 mb-3 font-pixel" style={{
            fontSize: 14,
            background: isWinner ? "#003300" : "#1a1a4e",
            border: `2px solid ${isWinner ? "#00FF00" : "#4a4a8a"}`,
            color: isWinner ? "#00FF88" : "#FFD700",
            textShadow: "0 0 15px currentColor",
          }}>
            {isWinner
              ? "*** YOU WON THE ROYALE! ***"
              : `WINNER: ${shortAddr(br.winner?.toBase58?.())}`}
          </div>
        )}

        {status === 4 && (
          <div className="text-center py-3 opacity-50">
            <div className="font-pixel" style={{ fontSize: 12 }}>ROYALE CANCELLED</div>
            <div className="text-xs mt-1">
              reason: {BR_CANCEL_REASON[br.cancelReason as keyof typeof BR_CANCEL_REASON] ?? "?"}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2">
          {isWinner && status >= 2 && !prizeClaimed && (
            <button
              onClick={claimWinnings}
              className="retro-btn retro-btn-gold py-2"
              style={{ fontSize: 11 }}
            >
              CLAIM {fmtSol(lamportsToSol(br.poolAmount) - lamportsToSol(br.feeAmount))} SOL WINNINGS
            </button>
          )}
          {mySeat && status >= 2 && !mySeat.claimed && (
            <button
              onClick={claimChip}
              className="retro-btn"
              style={{ fontSize: 10, padding: "6px 12px" }}
            >
              CLAIM MY CHIP BACK (slot {mySeat.slot})
            </button>
          )}
          {mySeat && status >= 2 && mySeat.claimed && (
            <div className="text-xs opacity-50 text-center">
              You've reclaimed your chip ✓
            </div>
          )}
        </div>
      </div>

      {/* Audit panel — shares the same component as 1v1; it queries the
          indexer by id which works for both tables (the indexer's
          getBattle() endpoint targets battles, so we pass the BR's seed
          + winner directly and let the panel show "switchboard" badge
          once the SwitchboardVerified row lands).  Future: a BR-specific
          variant that fetches /battle-royales/:id. */}
      {status >= 1 && (
        <BattleAuditPanel
          battleId={royaleId}
          randomSeed={br.randomSeed?.toString?.()}
          winner={br.winner?.toBase58?.()}
        />
      )}
    </div>
  );
}

// ============================================================
// Main export
// ============================================================

export default function BattleRoyalePage({
  initialWatchId,
}: { initialWatchId?: number | null } = {}) {
  const { connected } = useWallet();
  const [view, setView] = useState<View>(initialWatchId != null ? "watch" : "lobby");
  const [watchId, setWatchId] = useState<number | null>(initialWatchId ?? null);

  useEffect(() => {
    if (initialWatchId != null) {
      setWatchId(initialWatchId);
      setView("watch");
    }
  }, [initialWatchId]);

  if (!connected) {
    return (
      <div className="p-2 sm:p-4 max-w-3xl mx-auto">
        <div className="text-center mb-4">
          <h1 className="font-pixel text-retro-magenta animate-glow" style={{ fontSize: 18 }}>
            BATTLE ROYALE
          </h1>
        </div>
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 14 }}>
            CONNECT WALLET TO PLAY
          </div>
          <div className="flex justify-center mt-4">
            <WalletMultiButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
      <div className="text-center mb-4">
        <h1 className="font-pixel text-retro-magenta animate-glow" style={{ fontSize: 18 }}>
          BATTLE ROYALE
        </h1>
        <div className="text-xs opacity-50 mt-1">
          8-player single-VRF · Switchboard On-Demand · chips returned, stake at risk
        </div>
      </div>

      {view === "lobby"  && (
        <Lobby
          onCreate={() => setView("create")}
          onWatch={(id) => { setWatchId(id); setView("watch"); }}
        />
      )}
      {view === "create" && <Create onBack={() => setView("lobby")} />}
      {view === "watch"  && watchId !== null && (
        <Watch royaleId={watchId} onBack={() => setView("lobby")} />
      )}
    </div>
  );
}
