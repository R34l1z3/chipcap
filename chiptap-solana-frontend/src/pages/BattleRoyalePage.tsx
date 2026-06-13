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
import { useTranslation } from "react-i18next";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";

import { useArenaProgram } from "../hooks/useArenaProgram";
import { useTreasuryProgram } from "../hooks/useTreasuryProgram";
import { useChipNftProgram } from "../hooks/useChipNftProgram";
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
  POOL_TIERS, BR_PLAYER_OPTIONS,
  BR_MIN_PLAYERS, BR_MAX_PLAYERS_CAP,
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
  const { t } = useTranslation();
  const { publicKey } = useWallet();
  const { data: user } = useUserAccount();
  if (!publicKey) return null;
  const have = user?.balance?.toNumber?.() ?? 0;
  if (have >= neededLamports) return null;
  const shortBy = neededLamports - have;
  return (
    <div
      className="retro-panel mb-3"
      style={{ borderColor: "#00FFFF", background: "#001a22" }}
    >
      <div className="text-xs">
        <span className="font-pixel text-retro-cyan" style={{ fontSize: 9 }}>
          {t("royale.balance.title")}
        </span>
        <div className="opacity-80 mt-1">
          {t("royale.balance.hint", { have: fmtSol(have / 1e9), shortBy: fmtSol(shortBy / 1e9) })}
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
  const { t } = useTranslation();
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const arena = useArenaProgram();
  const { open, rolling, decided, myActive, loading, refetch } =
    useIndexerBattleRoyales();
  const { chips } = useChipsByOwner(me);
  const { data: user, refetch: refetchUser } = useUserAccount();

  const [joining, setJoining] = useState<number | null>(null);
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const handleJoin = async (br: BattleRoyaleData) => {
    if (!arena || !publicKey || !selectedChip) return;
    setBusy(br.id);
    try {
      const stakeLamports = Math.floor(br.poolSol * LAMPORTS_PER_SOL);
      const currentBalance = user?.balance?.toNumber?.() ?? 0;
      // Top-up needed so post-join balance is non-negative.  joinBattleRoyale
      // also moves a tiny rent buffer (1M lamports = 0.001 SOL) inside the
      // PDA, so we add that to the shortfall.
      const shortfall = Math.max(0, stakeLamports + 1_000_000 - currentBalance);

      // Build the preinstruction chain.  Always include ensureUserAccount
      // (cheap no-op if PDA exists); add a deposit if internal balance is
      // short of the stake.  Result: brand-new wallets can JOIN in a single
      // popup without first visiting the BATTLE tab to top up.
      const preIxs: any[] = [];

      preIxs.push(
        await (arena.methods as any).ensureUserAccount()
          .accounts({
            user:          pda.userAccount(publicKey),
            authority:     publicKey,
            payer:         publicKey,
            systemProgram: SystemProgram.programId,
          }).instruction(),
      );

      if (shortfall > 0) {
        preIxs.push(
          await (arena.methods as any).deposit(new BN(shortfall))
            .accounts({
              config:        pda.arenaConfig(),
              vault:         pda.arenaVault(),
              user:          pda.userAccount(publicKey),
              payer:         publicKey,
              systemProgram: SystemProgram.programId,
            }).instruction(),
        );
      }

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
        .preInstructions(preIxs)
        .rpc();
      notify("joined", `Joined royale #${br.id}! ${sig.slice(0, 8)}…`);
      setJoining(null);
      setSelectedChip(null);
      await Promise.all([refetch(), refetchUser()]);
    } catch (e) { notifyTxError("Join battle royale", e); }
    finally { setBusy(null); }
  };

  const hasChipInBr = (br: BattleRoyaleData) =>
    br.players.some((p) => p.player === me);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <h2 className="font-pixel text-retro-cyan" style={{ fontSize: 12 }}>
          {t("royale.lobby.title")}
        </h2>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => refetch()} className="retro-btn" style={{ fontSize: 8, padding: "4px 8px" }}>
            {t("common.refresh")}
          </button>
          <button onClick={onCreate} className="retro-btn retro-btn-gold" style={{ fontSize: 8, padding: "4px 8px" }}>
            <span className="hidden sm:inline">{t("royale.lobby.createLong")}</span>
            <span className="sm:hidden">{t("royale.lobby.createShort")}</span>
          </button>
        </div>
      </div>

      {/* My active royales */}
      {myActive.length > 0 && (
        <div className="mb-4">
          <div className="font-pixel text-retro-gold mb-2" style={{ fontSize: 9 }}>
            {t("royale.lobby.yourActive")}
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
                      {t("royale.lobby.royaleNum", { id: br.id })}
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
                      {t(`status.${br.status}`)}
                    </span>
                    {isWinner && (
                      <span className="font-pixel text-retro-win" style={{ fontSize: 8 }}>
                        {t("royale.lobby.claim")}
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
        {t("royale.lobby.open", { count: open.length })}
      </div>

      {loading && open.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-retro-cyan animate-blink">{t("common.loading")}</div>
        </div>
      ) : open.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-sm opacity-60">{t("royale.lobby.noOpen")}</div>
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
                      {t("common.by")} {shortAddr(br.creator)}
                    </span>
                  </div>
                  {alreadyIn ? (
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 8 }}>
                      {t("royale.lobby.inLobby")}
                    </span>
                  ) : isJoining ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        className="retro-input text-sm py-1"
                        style={{ fontSize: 14, maxWidth: 180 }}
                        value={selectedChip ?? ""}
                        onChange={(e) => setSelectedChip(e.target.value || null)}
                      >
                        <option value="">{t("royale.lobby.pickChip")}</option>
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
                        {busy === br.id ? t("royale.lobby.joining") : t("royale.lobby.fight")}
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
                    >{t("royale.lobby.join")}</button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs opacity-50 flex-wrap">
                  <span>{t("royale.lobby.stake", { amount: fmtSol(stakeLamports / 1e9) })}</span>
                  <span>|</span>
                  <span>{t("royale.lobby.minAgo", { n: Math.floor((Date.now() / 1000 - br.createdAt) / 60) })}</span>
                  {br.players.length > 0 && (
                    <>
                      <span>|</span>
                      <span>{t("royale.lobby.seats", { list: br.players.map((p) => shortAddr(p.player)).join(", ") })}</span>
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
            {t("royale.lobby.rolling", { count: rolling.length })}
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
                  {t("royale.lobby.waitingForVrf")}
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
            {t("royale.lobby.justDecided", { count: decided.length })}
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
                <span className="text-xs opacity-60">{t("royale.lobby.winnerShort", { addr: shortAddr(br.winner) })}</span>
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
  const { t } = useTranslation();
  const { publicKey } = useWallet();
  const arena = useArenaProgram();
  const { chips } = useChipsByOwner(publicKey?.toBase58());
  const { data: cfg, refetch: refetchCfg } = useArenaConfig();
  const { data: user, refetch: refetchUser } = useUserAccount();

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
      //
      // Bundled preinstructions (one popup):
      //   • ensureUserAccount — first-time creators have no UserAccount
      //     PDA; the join ix dereferences it and would fail with
      //     AnchorError 3012 (AccountNotInitialized) without this.
      //     SEC-10 pattern reused from pay_ransom.
      //   • deposit(shortfall) — if internal balance < stake, top up
      //     from the wallet.  Result: brand-new wallets can create AND
      //     join their own BR with one signature.
      const currentBalance = user?.balance?.toNumber?.() ?? 0;
      const shortfall = Math.max(0, stakeLamports + 1_000_000 - currentBalance);

      const preIxs: any[] = [];

      preIxs.push(
        await (arena.methods as any).ensureUserAccount()
          .accounts({
            user:          pda.userAccount(publicKey),
            authority:     publicKey,
            payer:         publicKey,
            systemProgram: SystemProgram.programId,
          }).instruction(),
      );

      if (shortfall > 0) {
        preIxs.push(
          await (arena.methods as any).deposit(new BN(shortfall))
            .accounts({
              config:        pda.arenaConfig(),
              vault:         pda.arenaVault(),
              user:          pda.userAccount(publicKey),
              payer:         publicKey,
              systemProgram: SystemProgram.programId,
            }).instruction(),
        );
      }

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
        .preInstructions(preIxs)
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
        {t("royale.create.back")}
      </button>
      <div className="retro-panel mb-4">
        <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 11 }}>
          {t("royale.create.title")}
        </div>

        <div className="text-xs opacity-60 mb-3" style={{ lineHeight: 1.4 }}>
          {t("royale.create.hint", { pool: POOL_TIERS[tier].label })}
        </div>

        {/* 1. POOL */}
        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>{t("royale.create.step1")}</div>
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
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>{t("royale.create.step2")}</div>
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
              >{t("royale.create.players", { n })}</button>
            ))}
          </div>
          <div className="text-xs opacity-50 mt-1">
            {t("royale.create.poolWhenFull", { amount: fmtSol(POOL_TIERS[tier].sol * maxPlayers) })}
          </div>
        </div>

        {/* 3. CREATOR'S CHIP */}
        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>{t("royale.create.step3")}</div>
          {chips.length === 0 ? (
            <div className="text-sm opacity-50">{t("royale.create.noChips")}</div>
          ) : (
            <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
              {chips.map((c) => (
                <ChipCard
                  key={c.asset}
                  tokenId={c.token_id}
                  asset={c.asset}
                  tier={c.tier}
                  progressionWins={c.progression_wins}
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
            ? t("royale.create.confirm")
            : t("royale.create.cta", { n: maxPlayers, pool: POOL_TIERS[tier].label })}
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
  const { t } = useTranslation();
  const { publicKey } = useWallet();
  const arena    = useArenaProgram();
  const treasury = useTreasuryProgram();
  const chipNft  = useChipNftProgram();
  const { data: cfg } = useArenaConfig();
  const me = publicKey?.toBase58();

  const [br, setBr] = useState<any>(null);
  // Ticker so the timeout countdown / cancel-eligible gate re-evaluates
  // each second.  Only runs while WAITING (0) or ROLLING (1) — the only
  // states with a time-based button.  Avoids a forever 1Hz re-render on
  // a backgrounded SETTLED/CANCELLED tab.
  const [, forceTick] = useState(0);
  const brStatus = br ? Number(br.status) : null;
  useEffect(() => {
    if (brStatus !== 0 && brStatus !== 1) return;
    const id = setInterval(() => forceTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [brStatus]);

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
          // SEC-22 — stake refund target.  On a CANCELLED royale the
          // program credits this PDA's balance by the join stake in the
          // same tx as the chip return.  Always passed (PDA exists since
          // the player joined); only mutated when status==CANCELLED.
          playerUser:    pda.userAccount(publicKey),
          player:        publicKey,
          mplCore:       MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        }).rpc();
      // STATUS_CANCELLED = 4 — read br directly (the outer `status`
      // const is declared below this closure, after the !br guard).
      notify("info", Number(br?.status) === 4
        ? `Reclaimed chip + stake refund · ${sig.slice(0, 8)}…`
        : `Reclaimed chip · ${sig.slice(0, 8)}…`);
      await fetchBr();
    } catch (e) { notifyTxError("Claim chip", e); }
  };

  const claimWinnings = async () => {
    if (!arena || !treasury || !publicKey) return;
    try {
      // SEC-26 — a BR win counts toward the winner's chip tier.  Bundle
      // record_chip_win for the winner's seat chip into the prize claim
      // (only the winner reaches this button).  Permissionless +
      // idempotent; best-effort so an unwired chip-nft can't block the
      // payout.
      const preIxs: any[] = [];
      if (chipNft && mySeat?.chip) {
        try {
          preIxs.push(
            await (chipNft.methods as any).recordChipWin()
              .accounts({
                config:   pda.chipNftConfig(),
                chipData: pda.chipData(new PublicKey(mySeat.chip)),
                game:     pda.royale(royaleId),
                caller:   publicKey,
              }).instruction(),
          );
        } catch { /* leave empty — prize claim still works */ }
      }

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
        })
        .preInstructions(preIxs)
        .rpc();
      notify("settled", `Claimed winnings · ${sig.slice(0, 8)}…`);
      await fetchBr();
    } catch (e) { notifyTxError("Claim winnings", e); }
  };

  // SEC-22 / polish — open-callable cancel for a WAITING royale whose
  // join window expired without filling.  Anyone (incl. non-participants)
  // can poke; flips status→CANCELLED.  Each player then reclaims chip +
  // stake via claim_chip_br.  Mirrors `expire_join` for 1v1.
  const expireJoin = async () => {
    if (!arena || !publicKey) return;
    try {
      const sig = await (arena.methods as any).expireBattleRoyaleJoin()
        .accounts({
          config:        pda.arenaConfig(),
          royale:        pda.royale(royaleId),
          caller:        publicKey,
        }).rpc();
      notify("info", `Cancelled stuck royale #${royaleId} · ${sig.slice(0, 8)}…`);
      await fetchBr();
    } catch (e) { notifyTxError("Expire join", e); }
  };

  // SEC-22 / polish — open-callable cancel for a ROLLING royale whose
  // VRF never resolved (relayer died mid-cycle).  Same accounts struct
  // as expireJoin; the program branches on status + vrf_timeout.
  const forceResolve = async () => {
    if (!arena || !publicKey) return;
    try {
      const sig = await (arena.methods as any).forceResolveBattleRoyale()
        .accounts({
          config:        pda.arenaConfig(),
          royale:        pda.royale(royaleId),
          caller:        publicKey,
        }).rpc();
      notify("info", `Force-resolved stuck royale #${royaleId} · ${sig.slice(0, 8)}…`);
      await fetchBr();
    } catch (e) { notifyTxError("Force resolve", e); }
  };

  if (!br) {
    return (
      <div>
        <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>{t("royale.watch.back")}</button>
        <div className="retro-panel text-center py-8">
          <div className="animate-blink text-retro-cyan">{t("royale.watch.loading", { id: royaleId })}</div>
        </div>
      </div>
    );
  }

  const status = Number(br.status);
  const prizeClaimed = !!br.prizeClaimed;

  return (
    <div>
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>{t("royale.watch.back")}</button>

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
          <div className="font-pixel text-retro-gold" style={{ fontSize: 14 }}>{t("royale.watch.royaleNum", { id: royaleId })}</div>
          <div className="text-sm">
            {t("royale.watch.poolSeats", { pool: poolLabel, joined: Number(br.numJoined), max: Number(br.maxPlayers) })}
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
            {t(`status.${status}`)}
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
                  {t("royale.watch.seat", { n: s.slot })} {s.player === me && t("royale.watch.youParen")}
                </div>
                <div className="text-xs opacity-70 truncate mt-1">{shortAddr(s.player)}</div>
                <div className="text-xs opacity-50 mt-1">{t("royale.watch.chipTail", { tail: s.chip.slice(-4) })}</div>
                {s.claimed && (
                  <div className="text-xs font-pixel mt-1" style={{ fontSize: 7, color: "#666" }}>
                    {t("royale.watch.chipClaimed")}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Status-specific banners */}
        {status === 1 && (
          <div className="text-center py-3 animate-blink text-retro-magenta" style={{ fontSize: 12 }}>
            {t("royale.watch.rolling")}
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
              ? t("royale.watch.youWonRoyale")
              : t("royale.watch.winnerIs", { addr: shortAddr(br.winner?.toBase58?.()) })}
          </div>
        )}

        {status === 4 && (
          <div className="text-center py-3 opacity-50">
            <div className="font-pixel" style={{ fontSize: 12 }}>{t("royale.watch.cancelled")}</div>
            <div className="text-xs mt-1">
              {t("royale.watch.cancelReason", { reason: t(`brCancelReason.${br.cancelReason}`, { defaultValue: "?" }) })}
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
              {t("royale.watch.claimWinnings", { amount: fmtSol(lamportsToSol(br.poolAmount) - lamportsToSol(br.feeAmount)) })}
            </button>
          )}
          {/* Polish — open cancel paths for stuck royales.  Both are
              open-callable (anyone can poke).  After cancel, every
              player reclaims chip + stake via CLAIM CHIP + STAKE below.
              Countdown shows until the timeout, then the button.  The
              `remaining < 0` (strict) boundary mirrors the on-chain
              `now > created_at + timeout` so we never offer a button
              the program would reject with *PeriodNotExpired. */}
          {(() => {
            if (!cfg) return null;
            const now = Math.floor(Date.now() / 1000);
            // WAITING — expire_join after join_timeout.
            if (status === 0) {
              const eligibleAt = (Number(br.createdAt) || 0) + cfg.joinTimeout;
              const remaining = eligibleAt - now;
              if (remaining >= 0) {
                return (
                  <div className="text-xs opacity-50 text-center">
                    {t("royale.watch.joinClosesIn", { m: Math.floor(remaining / 60), s: remaining % 60 })}
                  </div>
                );
              }
              return (
                <button onClick={expireJoin} className="retro-btn retro-btn-red py-2" style={{ fontSize: 11 }}>
                  {t("royale.watch.cancelStuck")}
                </button>
              );
            }
            // ROLLING — force_resolve after vrf_timeout (relayer died).
            if (status === 1) {
              const eligibleAt = (Number(br.rollingAt) || 0) + cfg.vrfTimeout;
              const remaining = eligibleAt - now;
              if (remaining >= 0) {
                return (
                  <div className="text-xs opacity-50 text-center">
                    {t("royale.watch.vrfTimeoutIn", { m: Math.floor(remaining / 60), s: remaining % 60 })}
                  </div>
                );
              }
              return (
                <button onClick={forceResolve} className="retro-btn retro-btn-red py-2" style={{ fontSize: 11 }}>
                  {t("royale.watch.forceCancel")}
                </button>
              );
            }
            return null;
          })()}
          {mySeat && status >= 2 && !mySeat.claimed && (
            <button
              onClick={claimChip}
              className="retro-btn"
              style={{ fontSize: 10, padding: "6px 12px" }}
            >
              {status === 4
                ? t("royale.watch.claimChipStake", { slot: mySeat.slot })
                : t("royale.watch.claimChip", { slot: mySeat.slot })}
            </button>
          )}
          {mySeat && status >= 2 && mySeat.claimed && (
            <div className="text-xs opacity-50 text-center">
              {status === 4 ? t("royale.watch.reclaimedFull") : t("royale.watch.reclaimedShort")}
            </div>
          )}
        </div>
      </div>

      {/* Audit panel hits /api/battle-royales/:id and renders the BR
          lifecycle tx rows (CREATE / ROLLING / DECIDE / SETTLE / CANCEL).
          Only feed seed/winner once DECIDED — a CANCELLED royale never
          set them, so winner is Pubkey::default() (toBase58 → all-1s
          literal, which is truthy and would render a bogus solscan link
          to the system program).  Gate on status===2/3 (DECIDED/SETTLED). */}
      {status >= 1 && (
        <BattleAuditPanel
          mode="royale"
          battleId={royaleId}
          randomSeed={status === 2 || status === 3 ? br.randomSeed?.toString?.() : null}
          winner={status === 2 || status === 3 ? br.winner?.toBase58?.() : null}
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
  const { t } = useTranslation();
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
            {t("royale.title")}
          </h1>
        </div>
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 14 }}>
            {t("royale.connect")}
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
          {t("royale.title")}
        </h1>
        <div className="text-xs opacity-50 mt-1">
          {t("royale.subtitle")}
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
