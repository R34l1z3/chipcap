// ============================================================
// src/pages/TournamentPage.tsx — SEC-23 — 8-player single-elim tournaments
// ============================================================
//
// Three views in one tab, mirrors BattleRoyalePage:
//   • Lobby  — list open / active / completed; my registered list;
//              REGISTER button with ticket-balance gate (auto-buy if 0).
//   • Create — entry-fee tier picker + creator chip; auto-registers
//              creator as seat 0.
//   • Watch  — bracket SVG/CSS rendering + podium + CLAIM PRIZE /
//              CLAIM CHIP buttons + Switchboard audit link.
//
// Trust model + ticket SPL:
//   • Tournament entries cost ENTRY_FEE SOL (deducted from internal
//     UserAccount.balance) PLUS burning 1 TICKET SPL token.
//   • Tickets are mintable for TICKET_PRICE_SOL by anyone via buy_ticket;
//     they're a separate SPL so they can be airdropped/traded/given as
//     rewards (e.g. tournament 2nd/3rd-place "free entry next time").
//   • Bracket VRF: each match runs its own Switchboard cycle.  Relayer
//     auto-fulfils on TournamentMatchRolling events (see SEC-23 Phase 2).
//
// Anchor camelCase gotcha — on-chain field `winner_1st_slot` becomes
// `winner1StSlot` (capital S because the underscore precedes a digit
// boundary).  Frontend reads via indexer use snake_case (PG column
// names), reads via Anchor account.fetch use the weird camelCase.
// ============================================================

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { BN } from "@coral-xyz/anchor";
import {
  LAMPORTS_PER_SOL, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { useArenaProgram } from "../hooks/useArenaProgram";
import { useTreasuryProgram } from "../hooks/useTreasuryProgram";
import { useArenaConfig } from "../hooks/useArenaConfig";
import { useUserAccount } from "../hooks/useUserAccount";
import { useChipsByOwner } from "../hooks/useChipsByOwner";
import { useTicketBalance } from "../hooks/useTicketBalance";
import {
  useIndexerTournaments, type TournamentData,
} from "../hooks/useIndexerTournaments";

import { notify, notifyTxError } from "../lib/notifications";
import * as pda from "../lib/pda";
import { MPL_CORE_PROGRAM } from "../lib/mpl";
import {
  T_BRACKET_SIZE,
  T_PRIZE_1ST_PCT, T_PRIZE_2ND_PCT, T_PRIZE_3RD_PCT, T_FEE_PCT,
  TICKET_PRICE_SOL, TICKET_PRICE_LAMPORTS,
  T_ENTRY_FEE_OPTIONS_SOL, CLUSTER,
} from "../config";

// Per-match audit: link the cell's seed snippet to the Switchboard
// randomness_account on solscan.  Same cluster-aware URL helpers as
// BattleAuditPanel; inlined here to keep the bracket component
// self-contained.
function solscanAccount(addr: string): string {
  const c = CLUSTER === "mainnet" ? "" : `?cluster=${CLUSTER}`;
  return `https://solscan.io/account/${addr}${c}`;
}
import { fmtSol, lamportsToSol, shortAddr } from "../lib/format";
import ChipCard from "../components/ChipCard";
import BattleAuditPanel from "../components/BattleAuditPanel";

type View = "lobby" | "create" | "watch";

// ============================================================
// TicketBalanceBanner — current ticket count + BUY button
// ============================================================

function TicketBalanceBanner({ onBought }: { onBought?: () => void }) {
  const { t } = useTranslation();
  const arena = useArenaProgram();
  const { publicKey } = useWallet();
  const { balance, refetch: refetchTickets } = useTicketBalance();
  const [busy, setBusy] = useState(false);

  if (!publicKey) return null;

  const buy = async () => {
    if (!arena || !publicKey) return;
    setBusy(true);
    try {
      const ata = getAssociatedTokenAddressSync(pda.ticketMint(), publicKey);
      const sig = await (arena.methods as any)
        .buyTicket(new BN(1))
        .accounts({
          config:                 pda.arenaConfig(),
          vault:                  pda.arenaVault(),
          ticketMint:             pda.ticketMint(),
          ticketAuthority:        pda.ticketAuthority(),
          buyerAta:               ata,
          buyer:                  publicKey,
          tokenProgram:           TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram:          SystemProgram.programId,
        }).rpc();
      notify("info", `Bought 1 ticket · ${sig.slice(0, 8)}…`);
      await refetchTickets();
      onBought?.();
    } catch (e) { notifyTxError("Buy ticket", e); }
    finally { setBusy(false); }
  };

  return (
    <div
      className="retro-panel mb-3 flex items-center justify-between gap-3 flex-wrap"
      style={{ borderColor: "#00FFFF", background: "#001a22" }}
    >
      <div className="text-xs">
        <span className="font-pixel text-retro-cyan" style={{ fontSize: 9 }}>
          {t("tournament.tickets.title")}
        </span>
        <div className="opacity-80 mt-1">
          {t(balance === 1 ? "tournament.tickets.lineOne" : "tournament.tickets.lineMany", { n: balance, price: TICKET_PRICE_SOL })}
        </div>
      </div>
      <button
        onClick={buy}
        disabled={busy}
        className="retro-btn retro-btn-gold"
        style={{ fontSize: 9, padding: "4px 12px" }}
      >
        {busy ? t("tournament.tickets.buying") : t("tournament.tickets.buy", { price: TICKET_PRICE_SOL })}
      </button>
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
  const { open, active, completed, myActive, loading, refetch } = useIndexerTournaments();
  const { chips } = useChipsByOwner(me);
  const { data: user, refetch: refetchUser } = useUserAccount();
  const { balance: ticketBalance, refetch: refetchTickets } = useTicketBalance();

  const [registering, setRegistering] = useState<number | null>(null);
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const handleRegister = async (t: TournamentData) => {
    if (!arena || !publicKey || !selectedChip) return;
    setBusy(t.id);
    try {
      const currentBalance = user?.balance?.toNumber?.() ?? 0;
      const stakeLamports = t.entryFee;
      // Top up shortfall + small rent buffer if internal balance is short.
      const shortfall = Math.max(0, stakeLamports + 1_000_000 - currentBalance);

      const ata = getAssociatedTokenAddressSync(pda.ticketMint(), publicKey);
      const preIxs: any[] = [];

      // 1. ensureUserAccount — first-time players have no PDA.  SEC-10 pattern.
      preIxs.push(
        await (arena.methods as any).ensureUserAccount()
          .accounts({
            user:          pda.userAccount(publicKey),
            authority:     publicKey,
            payer:         publicKey,
            systemProgram: SystemProgram.programId,
          }).instruction(),
      );

      // 2. deposit shortfall (only if internal balance < entry_fee).
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

      // 3. buy_ticket if balance is 0 (auto top-up SPL ticket).
      //    Skipped if user already has ≥1 ticket from a prior purchase
      //    or airdrop — that way reward-style ticket distribution works.
      if (ticketBalance < 1) {
        preIxs.push(
          await (arena.methods as any).buyTicket(new BN(1))
            .accounts({
              config:                 pda.arenaConfig(),
              vault:                  pda.arenaVault(),
              ticketMint:             pda.ticketMint(),
              ticketAuthority:        pda.ticketAuthority(),
              buyerAta:               ata,
              buyer:                  publicKey,
              tokenProgram:           TOKEN_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram:          SystemProgram.programId,
            }).instruction(),
        );
      }

      const sig = await (arena.methods as any)
        .registerForTournament()
        .accounts({
          config:        pda.arenaConfig(),
          tournament:    pda.tournament(t.id),
          chipAuthority: pda.chipAuthority(),
          chip:          new PublicKey(selectedChip),
          ticketMint:    pda.ticketMint(),
          playerAta:     ata,
          playerUser:    pda.userAccount(publicKey),
          authority:     publicKey,
          player:        publicKey,
          mplCore:       MPL_CORE_PROGRAM,
          tokenProgram:  TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(preIxs)
        .rpc();
      notify("joined", `Registered for tournament #${t.id}! ${sig.slice(0, 8)}…`);
      setRegistering(null);
      setSelectedChip(null);
      await Promise.all([refetch(), refetchUser(), refetchTickets()]);
    } catch (e) { notifyTxError("Register for tournament", e); }
    finally { setBusy(null); }
  };

  const alreadyIn = (t: TournamentData) =>
    t.players.some((p) => p.player === me);

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <h2 className="font-pixel text-retro-cyan" style={{ fontSize: 12 }}>
          {t("tournament.lobby.title")}
        </h2>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => refetch()} className="retro-btn" style={{ fontSize: 8, padding: "4px 8px" }}>
            {t("common.refresh")}
          </button>
          <button onClick={onCreate} className="retro-btn retro-btn-gold" style={{ fontSize: 8, padding: "4px 8px" }}>
            <span className="hidden sm:inline">{t("tournament.lobby.createLong")}</span>
            <span className="sm:hidden">{t("tournament.lobby.createShort")}</span>
          </button>
        </div>
      </div>

      <TicketBalanceBanner />

      {/* My active tournaments */}
      {myActive.length > 0 && (
        <div className="mb-4">
          <div className="font-pixel text-retro-gold mb-2" style={{ fontSize: 9 }}>
            {t("tournament.lobby.yourActive")}
          </div>
          {myActive.map((tr) => {
            const podium = tr.status === 2 && [
              tr.winner1stSlot, tr.winner2ndSlot, tr.winner3rdSlot,
            ].some((s) => s != null && tr.players[s]?.player === me);
            return (
              <div
                key={tr.id}
                className="retro-panel mb-2 cursor-pointer"
                style={{
                  borderColor:
                    tr.status === 2 ? (podium ? "#00FF88" : "#aaa") :
                    tr.status === 1 ? "#FF00FF" : "#FFD700",
                }}
                onClick={() => onWatch(tr.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>
                      {t("tournament.lobby.tournamentNum", { id: tr.id })}
                    </span>
                    <span className="ml-2 text-sm opacity-60">
                      {t("tournament.lobby.entryRegistered", { entry: fmtSol(tr.entryFee / 1e9) + " SOL", registered: tr.registered, size: tr.bracketSize })}
                    </span>
                  </div>
                  <span className="font-pixel px-2 py-0.5" style={{
                    fontSize: 8,
                    color:
                      tr.status === 0 ? "#00FFFF" :
                      tr.status === 1 ? "#FF00FF" :
                      tr.status === 2 ? (podium ? "#00FF88" : "#888") : "#aaa",
                    border: "1px solid currentColor",
                  }}>
                    {t(`tStatus.${tr.status}`)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Open tournaments */}
      <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>
        {t("tournament.lobby.open", { count: open.length })}
      </div>

      {loading && open.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-retro-cyan animate-blink">{t("common.loading")}</div>
        </div>
      ) : open.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-sm opacity-60">{t("tournament.lobby.noOpen")}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {open.map((tr) => {
            const isIn = alreadyIn(tr);
            const isRegistering = registering === tr.id;
            const entrySol = tr.entryFee / 1e9;
            const poolWhenFull = entrySol * tr.bracketSize;
            return (
              <div key={tr.id} className="retro-panel">
                <div className="flex items-start sm:items-center justify-between gap-2 mb-2 flex-wrap">
                  <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0">
                    <span className="font-pixel text-retro-cyan" style={{ fontSize: 10 }}>#{tr.id}</span>
                    <span className="text-retro-gold font-pixel" style={{ fontSize: 12 }}>
                      {fmtSol(entrySol)} SOL
                    </span>
                    <span className="font-pixel" style={{ fontSize: 10, color: "#FF00FF" }}>
                      {tr.registered}/{tr.bracketSize}
                    </span>
                    <span className="text-xs opacity-50 truncate hidden sm:inline">
                      {t("common.by")} {shortAddr(tr.creator)}
                    </span>
                  </div>
                  {isIn ? (
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 8 }}>
                      {t("tournament.lobby.registered")}
                    </span>
                  ) : isRegistering ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        className="retro-input text-sm py-1"
                        style={{ fontSize: 14, maxWidth: 180 }}
                        value={selectedChip ?? ""}
                        onChange={(e) => setSelectedChip(e.target.value || null)}
                      >
                        <option value="">{t("tournament.lobby.pickChip")}</option>
                        {chips.map((c) => (
                          <option key={c.asset} value={c.asset}>
                            #{c.token_id} · …{c.asset.slice(-4)}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleRegister(tr)}
                        disabled={!selectedChip || busy === tr.id}
                        className="retro-btn retro-btn-gold"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >
                        {busy === tr.id ? t("tournament.lobby.joining") : t("tournament.lobby.enter")}
                      </button>
                      <button
                        onClick={() => { setRegistering(null); setSelectedChip(null); }}
                        className="retro-btn"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >X</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRegistering(tr.id)}
                      className="retro-btn retro-btn-gold"
                      style={{ fontSize: 8, padding: "3px 8px" }}
                    >{t("tournament.lobby.register")}</button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs opacity-50 flex-wrap">
                  <span>{t("tournament.lobby.poolWhenFull", { amount: fmtSol(poolWhenFull) })}</span>
                  <span>|</span>
                  <span>{t("tournament.lobby.prizes", { p1: fmtSol(poolWhenFull * 0.6), p2: fmtSol(poolWhenFull * 0.25), p3: fmtSol(poolWhenFull * 0.1) })}</span>
                  <span>|</span>
                  <span>{t("tournament.lobby.minAgo", { n: Math.floor((Date.now() / 1000 - tr.createdAt) / 60) })}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Active (bracket rolling) */}
      {active.length > 0 && (
        <div className="mt-4">
          <div className="font-pixel text-retro-magenta mb-2" style={{ fontSize: 9 }}>
            {t("tournament.lobby.active", { count: active.length })}
          </div>
          {active.map((tr) => (
            <div
              key={tr.id}
              className="retro-panel mb-2 cursor-pointer"
              style={{ borderColor: "#FF00FF" }}
              onClick={() => onWatch(tr.id)}
            >
              <div className="flex items-center justify-between">
                <span className="font-pixel" style={{ fontSize: 10, color: "#FF00FF" }}>
                  #{tr.id} — {t("tournament.lobby.entry", { entry: fmtSol(tr.entryFee / 1e9) + " SOL" })}
                </span>
                <span className="text-xs">
                  {t(`tRound.${tr.currentRound}`, { defaultValue: "ROUND" })}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Recent completed */}
      {completed.length > 0 && (
        <div className="mt-4">
          <div className="font-pixel mb-2" style={{ fontSize: 9, color: "#888" }}>
            {t("tournament.lobby.recentCompleted", { count: completed.length })}
          </div>
          {completed.slice(0, 5).map((tr) => (
            <div
              key={tr.id}
              className="retro-panel mb-2 cursor-pointer"
              style={{ borderColor: "#444" }}
              onClick={() => onWatch(tr.id)}
            >
              <div className="flex items-center justify-between">
                <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>
                  #{tr.id}
                </span>
                <span className="text-xs opacity-60">
                  {t("tournament.lobby.winnerShort", { addr: tr.winner1stSlot != null
                    ? shortAddr(tr.players[tr.winner1stSlot]?.player ?? "")
                    : "—" })}
                </span>
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
  const { balance: ticketBalance, refetch: refetchTickets } = useTicketBalance();

  const [chip, setChip] = useState<string | null>(null);
  const [entrySol, setEntrySol] = useState<number>(T_ENTRY_FEE_OPTIONS_SOL[0]);
  const [busy, setBusy] = useState(false);

  const entryLamports = Math.floor(entrySol * LAMPORTS_PER_SOL);
  const poolWhenFull  = entrySol * T_BRACKET_SIZE;

  const handleCreate = async () => {
    if (!arena || !publicKey || !chip || !cfg) return;
    setBusy(true);
    try {
      const tournamentId = cfg.nextBattleId.toString();

      // STEP 1 — create_tournament (rent-only, no chip/stake yet).
      const createSig = await (arena.methods as any)
        .createTournament(new BN(entryLamports))
        .accounts({
          config:        pda.arenaConfig(),
          tournament:    pda.tournament(new BN(tournamentId)),
          creator:       publicKey,
          systemProgram: SystemProgram.programId,
        }).rpc();
      notify("created", `Tournament #${tournamentId} created · ${createSig.slice(0, 8)}…`);
      await refetchCfg();

      // STEP 2 — creator auto-registers.  Bundle ensureUserAccount +
      // deposit-if-short + buy_ticket-if-zero as preinstructions
      // (same pattern as BattleRoyalePage SEC-10 fix).
      const currentBalance = user?.balance?.toNumber?.() ?? 0;
      const shortfall = Math.max(0, entryLamports + 1_000_000 - currentBalance);
      const ata = getAssociatedTokenAddressSync(pda.ticketMint(), publicKey);
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

      if (ticketBalance < 1) {
        preIxs.push(
          await (arena.methods as any).buyTicket(new BN(1))
            .accounts({
              config:                 pda.arenaConfig(),
              vault:                  pda.arenaVault(),
              ticketMint:             pda.ticketMint(),
              ticketAuthority:        pda.ticketAuthority(),
              buyerAta:               ata,
              buyer:                  publicKey,
              tokenProgram:           TOKEN_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram:          SystemProgram.programId,
            }).instruction(),
        );
      }

      const joinSig = await (arena.methods as any)
        .registerForTournament()
        .accounts({
          config:        pda.arenaConfig(),
          tournament:    pda.tournament(new BN(tournamentId)),
          chipAuthority: pda.chipAuthority(),
          chip:          new PublicKey(chip),
          ticketMint:    pda.ticketMint(),
          playerAta:     ata,
          playerUser:    pda.userAccount(publicKey),
          authority:     publicKey,
          player:        publicKey,
          mplCore:       MPL_CORE_PROGRAM,
          tokenProgram:  TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(preIxs)
        .rpc();
      notify("joined", `Registered as seat 0 · ${joinSig.slice(0, 8)}…`);
      await Promise.all([refetchUser(), refetchTickets()]);
      onBack();
    } catch (e) { notifyTxError("Create tournament", e); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>
        {t("tournament.create.back")}
      </button>
      <div className="retro-panel mb-4">
        <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 11 }}>
          {t("tournament.create.title")}
        </div>

        <div className="text-xs opacity-60 mb-3" style={{ lineHeight: 1.4 }}>
          {t("tournament.create.hintPrefix")}<b>{fmtSol(entrySol)} SOL</b>{t("tournament.create.hintPrizes", { p1: T_PRIZE_1ST_PCT, p2: T_PRIZE_2ND_PCT, p3: T_PRIZE_3RD_PCT, fee: T_FEE_PCT })}
        </div>

        <TicketBalanceBanner />

        {/* 1. ENTRY FEE */}
        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>{t("tournament.create.step1")}</div>
          <div className="flex gap-2 flex-wrap">
            {T_ENTRY_FEE_OPTIONS_SOL.map((sol) => (
              <button
                key={sol}
                onClick={() => setEntrySol(sol)}
                className="retro-btn"
                style={{
                  fontSize: 10, padding: "6px 14px",
                  borderColor: entrySol === sol ? "#FFD700" : "#4a4a8a",
                  color: entrySol === sol ? "#FFD700" : "#4a4a8a",
                  textShadow: entrySol === sol ? "0 0 10px #FFD700" : "none",
                }}
              >{t("tournament.create.solSuffix", { n: sol })}</button>
            ))}
          </div>
          <div className="text-xs opacity-50 mt-1">
            {t("tournament.create.poolBreakdown", { full: fmtSol(poolWhenFull), p1: fmtSol(poolWhenFull * T_PRIZE_1ST_PCT / 100), p2: fmtSol(poolWhenFull * T_PRIZE_2ND_PCT / 100), p3: fmtSol(poolWhenFull * T_PRIZE_3RD_PCT / 100) })}
          </div>
        </div>

        {/* 2. CREATOR'S CHIP */}
        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>{t("tournament.create.step2")}</div>
          {chips.length === 0 ? (
            <div className="text-sm opacity-50">{t("tournament.create.noChips")}</div>
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

        <button
          onClick={handleCreate}
          disabled={!chip || busy}
          className="retro-btn retro-btn-gold w-full py-3 font-pixel"
          style={{ fontSize: 12 }}
        >
          {busy
            ? t("tournament.create.confirm")
            : t("tournament.create.cta", { entry: fmtSol(entrySol) })}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Bracket — visual layout for 8-player single-elim + 3rd-place
// ============================================================

interface MatchCellProps {
  match: TournamentData["matches"][number];
  players: TournamentData["players"];
  highlight?: "winner" | "loser" | null;
  me?: string | null;
  label?: string;
}

function MatchCell({ match, players, highlight, me, label }: MatchCellProps) {
  const { t } = useTranslation();
  const seat = (slot: number) => {
    if (slot === 255 || slot == null) return { player: null, label: t("tournament.bracket.empty") };
    const p = players[slot];
    if (!p) return { player: null, label: t("tournament.bracket.slotPlaceholder", { n: slot }) };
    return {
      player: p.player,
      label: p.player === me ? t("tournament.watch.you") : shortAddr(p.player),
    };
  };
  const a = seat(match.slot_a);
  const b = seat(match.slot_b);
  const winnerIsA = match.status === 2 && match.winner_slot === match.slot_a;
  const winnerIsB = match.status === 2 && match.winner_slot === match.slot_b;

  return (
    <div
      className="retro-panel"
      style={{
        padding: 5,
        borderColor:
          match.status === 1 ? "#FF00FF" :
          match.status === 2 ? "#FFD700" :
          highlight === "winner" ? "#00FF88" :
          highlight === "loser"  ? "#FF4444" :
          "#2a2a5a",
        minWidth: 110,
        background: match.status === 2 ? "#0a0a1e" : undefined,
      }}
    >
      {label && (
        <div className="text-xs font-pixel mb-1" style={{ fontSize: 7, color: "#666" }}>
          {label}
        </div>
      )}
      <div
        className="text-xs"
        style={{
          color: winnerIsA ? "#00FF88" : (match.status === 2 ? "#666" : "#aaa"),
          textDecoration: match.status === 2 && !winnerIsA ? "line-through" : "none",
          fontWeight: winnerIsA ? "bold" : "normal",
        }}
      >
        {a.label}
      </div>
      <div className="text-xs opacity-50">{t("tournament.bracket.vs")}</div>
      <div
        className="text-xs"
        style={{
          color: winnerIsB ? "#00FF88" : (match.status === 2 ? "#666" : "#aaa"),
          textDecoration: match.status === 2 && !winnerIsB ? "line-through" : "none",
          fontWeight: winnerIsB ? "bold" : "normal",
        }}
      >
        {b.label}
      </div>
      <div className="font-pixel mt-1" style={{ fontSize: 6, color:
        match.status === 1 ? "#FF00FF" :
        match.status === 2 ? "#FFD700" : "#444" }}>
        {match.status === 1 && <span className="animate-blink">{t("tournament.bracket.rolling")}</span>}
        {match.status === 2 && (
          match.randomness_account ? (
            // Switchboard-verified — link the seed snippet to the
            // signed randomness account on solscan for independent audit.
            // Full seed shown on hover via title attr.
            <a
              href={solscanAccount(match.randomness_account)}
              target="_blank" rel="noreferrer"
              title={t("tournament.bracket.seedAuditTitle", { seed: match.seed ?? "" })}
              style={{ color: "#FFD700", textDecoration: "none", cursor: "help" }}
            >
              {t("tournament.bracket.seedShort", { n: match.seed?.slice(0, 6) ?? "?" })} ↗
            </a>
          ) : (
            <span title={t("tournament.bracket.seedTitle", { seed: match.seed ?? "" })} style={{ cursor: "help" }}>
              {t("tournament.bracket.seedShort", { n: match.seed?.slice(0, 6) ?? "?" })}
            </span>
          )
        )}
        {match.status === 0 && t("tournament.bracket.pending")}
      </div>
    </div>
  );
}

function Bracket({
  tournament, tChain, me,
}: {
  tournament: TournamentData;
  // On-chain account (optional).  Each match's randomnessAccount lives
  // on chain only — TournamentMatchDecided event doesn't carry it.
  // When present, we merge it into each match cell so the seed snippet
  // becomes a clickable solscan link.
  tChain?: any | null;
  me?: string | null;
}) {
  const { t } = useTranslation();
  // matches[0..4] = R0 (4 quarters) / [4..6] = R1 semis / [6] = final / [7] = 3rd-place

  const cell = (i: number) => {
    const ix = tournament.matches[i] ?? defaultMatch();
    const oc = tChain?.matches?.[i];
    if (!oc) return ix;   // wallet disconnected / no on-chain read — indexer only

    // On-chain is authoritative for the bracket STRUCTURE (slot_a/slot_b
    // for R1/R2 are filled by t_advance_round on chain, but the indexer's
    // handleTournamentMatchDecided never back-fills next-round slots — so
    // without this merge R1/R2 cells render "— vs —" forever).
    //
    // STATUS is the one field we DON'T blindly trust on-chain: the program
    // only knows PENDING(0)/DECIDED(2) — the ROLLING(1) animation is an
    // indexer-only state set on the TournamentMatchRolling event.  So:
    // trust on-chain when it says DECIDED; otherwise show the indexer
    // status (which may be 1=ROLLING mid Switchboard cycle).
    const ocDecided = Number(oc.status) === 2;   // T_MATCH_DECIDED
    const rndAcc = oc.randomnessAccount?.toBase58?.();
    return {
      status:      ocDecided ? 2 : Number(ix.status),
      round:       Number(oc.round),
      slot_a:      Number(oc.slotA),
      slot_b:      Number(oc.slotB),
      winner_slot: Number(oc.winnerSlot),
      seed:        ocDecided && oc.seed ? oc.seed.toString() : ix.seed,
      // Filter Pubkey::default() (all-1s) so we don't link to the system program.
      randomness_account:
        ocDecided && rndAcc && rndAcc !== "11111111111111111111111111111111"
          ? rndAcc : (ix.randomness_account ?? null),
      decided_at: ix.decided_at,
    };
  };

  return (
    <div className="overflow-x-auto">
      <div className="flex gap-4 items-stretch" style={{ minWidth: 600, padding: 8 }}>
        {/* R0 */}
        <div className="flex flex-col gap-2 justify-around">
          <div className="font-pixel text-retro-cyan text-center" style={{ fontSize: 7 }}>{t("tournament.bracket.quarters")}</div>
          {[0, 1, 2, 3].map((i) => (
            <MatchCell key={i} match={cell(i)} players={tournament.players} me={me} />
          ))}
        </div>

        {/* R1 */}
        <div className="flex flex-col gap-2 justify-around">
          <div className="font-pixel text-retro-cyan text-center" style={{ fontSize: 7 }}>{t("tournament.bracket.semis")}</div>
          {[4, 5].map((i) => (
            <MatchCell key={i} match={cell(i)} players={tournament.players} me={me} />
          ))}
        </div>

        {/* R2 */}
        <div className="flex flex-col gap-2 justify-around">
          <div className="font-pixel text-retro-cyan text-center" style={{ fontSize: 7 }}>{t("tournament.bracket.final")}</div>
          <MatchCell match={cell(6)} players={tournament.players} me={me} label={t("tournament.bracket.gold")} />
          <MatchCell match={cell(7)} players={tournament.players} me={me} label={t("tournament.bracket.bronze")} />
        </div>
      </div>
    </div>
  );
}

function defaultMatch() {
  return {
    status: 0, round: 0, slot_a: 255, slot_b: 255, winner_slot: 255,
    seed: null, randomness_account: null, decided_at: null,
  };
}

// ============================================================
// Watch — bracket + podium + actions
// ============================================================

function Watch({ tournamentId, onBack }: { tournamentId: number; onBack: () => void }) {
  const { t } = useTranslation();
  const { publicKey } = useWallet();
  const arena    = useArenaProgram();
  const treasury = useTreasuryProgram();
  const me = publicKey?.toBase58();

  // Frontend reads from indexer (snake_case + bracket rendering) AND
  // on-chain (camelCase, for masks + claim-state truth).  We could rely
  // purely on the indexer once it catches up, but on-chain reads are
  // authoritative and used to gate claim buttons.
  const [tIndex, setTIndex] = useState<TournamentData | null>(null);
  const [tChain, setTChain] = useState<any>(null);

  const fetchIndex = useCallback(async () => {
    try {
      const { indexerApi } = await import("../services/indexerApi");
      const r = await indexerApi.getTournament(tournamentId);
      const { useIndexerTournaments } = await import("../hooks/useIndexerTournaments");
      // The map() in useIndexerTournaments is private; re-fetch via the
      // raw row is fine — just cast through the same shape.
      setTIndex({
        id:               r.tournament.id,
        creator:          r.tournament.creator,
        bracketSize:      r.tournament.bracket_size,
        registered:       r.tournament.registered,
        currentRound:     r.tournament.current_round,
        status:           r.tournament.status,
        entryFee:         Number(r.tournament.entry_fee) || 0,
        players:          Array.isArray(r.tournament.players) ? r.tournament.players : [],
        matches:          Array.isArray(r.tournament.matches) ? r.tournament.matches : [],
        winner1stSlot:    r.tournament.winner_1st_slot,
        winner2ndSlot:    r.tournament.winner_2nd_slot,
        winner3rdSlot:    r.tournament.winner_3rd_slot,
        poolAmount:       Number(r.tournament.pool_amount) || 0,
        feeAmount:        Number(r.tournament.fee_amount)  || 0,
        prize1st:         Number(r.tournament.prize_1st)   || 0,
        prize2nd:         Number(r.tournament.prize_2nd)   || 0,
        prize3rd:         Number(r.tournament.prize_3rd)   || 0,
        prizeClaimedMask: r.tournament.prize_claimed_mask  || 0,
        chipsClaimedMask: r.tournament.chips_claimed_mask  || 0,
        cancelReason:     r.tournament.cancel_reason,
        vrfMethod:        r.tournament.vrf_method,
        createdAt:        r.tournament.created_at ? Math.floor(new Date(r.tournament.created_at).getTime() / 1000) : 0,
        startedAt:        r.tournament.started_at ? Math.floor(new Date(r.tournament.started_at).getTime() / 1000) : 0,
        completedAt:      r.tournament.completed_at ? Math.floor(new Date(r.tournament.completed_at).getTime() / 1000) : 0,
      });
    } catch { setTIndex(null); }
  }, [tournamentId]);

  const fetchChain = useCallback(async () => {
    if (!arena) return;
    try {
      const acc = await (arena.account as any).tournament.fetchNullable(pda.tournament(tournamentId));
      setTChain(acc);
    } catch { setTChain(null); }
  }, [arena, tournamentId]);

  useEffect(() => {
    fetchIndex();
    fetchChain();
    const id = setInterval(() => { fetchIndex(); fetchChain(); }, 4000);
    return () => clearInterval(id);
  }, [fetchIndex, fetchChain]);

  const tournament = tIndex;

  // Per-seat chip-claim state from on-chain mask.
  const playerSeats = useMemo(() => {
    if (!tournament || !tChain) return [] as { slot: number; player: string; chip: string; claimed: boolean }[];
    const mask: number = Number(tChain.chipsClaimedMask ?? 0);
    return tournament.players.map((p) => ({
      slot: p.slot, player: p.player, chip: p.chip,
      claimed: (mask & (1 << p.slot)) !== 0,
    }));
  }, [tournament, tChain]);

  const mySeat = playerSeats.find((s) => s.player === me);

  // Anchor camelCase: winner_1st_slot → winner1StSlot (capital S after digit).
  const w1 = tChain?.winner1StSlot;
  const w2 = tChain?.winner2NdSlot;
  const w3 = tChain?.winner3RdSlot;
  const prizeClaimedMask = Number(tChain?.prizeClaimedMask ?? 0);

  const myRank = (): number | null => {
    if (!tournament || !me) return null;
    if (w1 != null && w1 !== 255 && tournament.players[w1]?.player === me) return 0;
    if (w2 != null && w2 !== 255 && tournament.players[w2]?.player === me) return 1;
    if (w3 != null && w3 !== 255 && tournament.players[w3]?.player === me) return 2;
    return null;
  };

  const claimPrize = async (rank: number) => {
    if (!arena || !treasury || !publicKey) return;
    try {
      const sig = await (arena.methods as any).claimTournamentPrize(rank)
        .accounts({
          config:          pda.arenaConfig(),
          tournament:      pda.tournament(tournamentId),
          vault:           pda.arenaVault(),
          winnerUser:      pda.userAccount(publicKey),
          winner:          publicKey,
          treasuryConfig:  pda.treasuryConfig(),
          treasuryVault:   pda.treasuryVault(),
          treasuryProgram: treasury.programId,
          caller:          publicKey,
          systemProgram:   SystemProgram.programId,
        }).rpc();
      notify("settled", `Claimed rank ${rank + 1} prize · ${sig.slice(0, 8)}…`);
      await Promise.all([fetchIndex(), fetchChain()]);
    } catch (e) { notifyTxError(`Claim prize rank ${rank + 1}` as any, e); }
  };

  const claimChip = async () => {
    if (!arena || !publicKey || !mySeat) return;
    try {
      const sig = await (arena.methods as any).claimTournamentChip()
        .accounts({
          config:        pda.arenaConfig(),
          tournament:    pda.tournament(tournamentId),
          chipAuthority: pda.chipAuthority(),
          chip:          new PublicKey(mySeat.chip),
          player:        publicKey,
          mplCore:       MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        }).rpc();
      notify("info", `Reclaimed chip · ${sig.slice(0, 8)}…`);
      await Promise.all([fetchIndex(), fetchChain()]);
    } catch (e) { notifyTxError("Claim chip", e); }
  };

  if (!tournament) {
    return (
      <div>
        <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>{t("tournament.watch.back")}</button>
        <div className="retro-panel text-center py-8">
          <div className="animate-blink text-retro-cyan">{t("tournament.watch.loading", { id: tournamentId })}</div>
        </div>
      </div>
    );
  }

  const r = myRank();
  const myPrizeBit = r != null ? 1 << r : 0;
  const myPrizeClaimed = r != null ? (prizeClaimedMask & myPrizeBit) !== 0 : true;
  const myPrizeAmount = r === 0 ? lamportsToSol(tChain?.prize1st)
                      : r === 1 ? lamportsToSol(tChain?.prize2nd)
                      : r === 2 ? lamportsToSol(tChain?.prize3rd)
                      : 0;

  return (
    <div>
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>{t("tournament.watch.back")}</button>

      <div
        className="retro-panel"
        style={{
          borderColor:
            tournament.status === 2 ? "#FFD700" :
            tournament.status === 1 ? "#FF00FF" : "#4a4a8a",
        }}
      >
        {/* Header */}
        <div className="text-center mb-4">
          <div className="font-pixel text-retro-gold" style={{ fontSize: 14 }}>{t("tournament.watch.tournamentNum", { id: tournamentId })}</div>
          <div className="text-sm">
            {t("tournament.watch.header", { entry: fmtSol(tournament.entryFee / 1e9) + " SOL", registered: tournament.registered, size: tournament.bracketSize })}
            {tournament.status === 1 && <> · <span className="text-retro-magenta">{t(`tRound.${tournament.currentRound}`, { defaultValue: "" })}</span></>}
          </div>
          <div className="font-pixel mt-1 inline-block px-3 py-0.5" style={{
            fontSize: 9,
            color:
              tournament.status === 0 ? "#00FFFF" :
              tournament.status === 1 ? "#FF00FF" :
              tournament.status === 2 ? "#FFD700" : "#aaa",
            border: "1px solid currentColor",
          }}>
            {t(`tStatus.${tournament.status}`)}
          </div>
        </div>

        {/* Bracket */}
        {tournament.status >= 1 && <Bracket tournament={tournament} tChain={tChain} me={me} />}

        {/* Seats (during REGISTERING) */}
        {tournament.status === 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
            {Array.from({ length: tournament.bracketSize }).map((_, i) => {
              const p = tournament.players.find((x) => x.slot === i);
              return (
                <div
                  key={i}
                  className="retro-panel"
                  style={{
                    padding: 6,
                    borderColor: p ? "#FFD700" : "#2a2a5a",
                    opacity: p ? 1 : 0.4,
                  }}
                >
                  <div className="text-xs font-pixel" style={{ fontSize: 8, color: "#00FFFF" }}>
                    {t("tournament.watch.seat", { n: i })}
                  </div>
                  <div className="text-xs opacity-70 truncate mt-1">
                    {p ? (p.player === me ? t("tournament.watch.you") : shortAddr(p.player)) : t("tournament.watch.empty")}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Podium (when COMPLETED) */}
        {tournament.status === 2 && tChain && (
          <div className="grid grid-cols-3 gap-2 mt-4">
            {[
              { rank: 0, slot: w1, label: t("tournament.watch.podiumRank1"), pct: T_PRIZE_1ST_PCT, color: "#FFD700" },
              { rank: 1, slot: w2, label: t("tournament.watch.podiumRank2"), pct: T_PRIZE_2ND_PCT, color: "#C0C0C0" },
              { rank: 2, slot: w3, label: t("tournament.watch.podiumRank3"), pct: T_PRIZE_3RD_PCT, color: "#CD7F32" },
            ].map(({ rank, slot, label, pct, color }) => {
              const player = (slot != null && slot !== 255) ? tournament.players[slot]?.player : null;
              const claimed = (prizeClaimedMask & (1 << rank)) !== 0;
              const isMe = player === me;
              const prize = rank === 0 ? lamportsToSol(tChain?.prize1st)
                          : rank === 1 ? lamportsToSol(tChain?.prize2nd)
                          : lamportsToSol(tChain?.prize3rd);
              return (
                <div
                  key={rank}
                  className="retro-panel text-center"
                  style={{
                    borderColor: color,
                    background: isMe ? "#0a1a00" : undefined,
                    padding: 8,
                  }}
                >
                  <div className="font-pixel" style={{ fontSize: 12, color }}>{label}</div>
                  <div className="text-xs opacity-70 mt-1 truncate">
                    {player ? (isMe ? t("tournament.watch.you") : shortAddr(player)) : t("tournament.watch.podiumEmpty")}
                  </div>
                  <div className="text-xs font-pixel mt-1" style={{ fontSize: 9, color }}>
                    {t("tournament.watch.podiumPrize", { amount: fmtSol(prize), pct })}
                  </div>
                  {claimed && (
                    <div className="text-xs font-pixel mt-1" style={{ fontSize: 7, color: "#666" }}>
                      {t("tournament.watch.podiumClaimed")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Cancelled */}
        {tournament.status === 3 && (
          <div className="text-center py-3 mt-3 opacity-50">
            <div className="font-pixel" style={{ fontSize: 12 }}>{t("tournament.watch.cancelled")}</div>
            <div className="text-xs mt-1">
              {t("tournament.watch.cancelReason", { reason: t(`tCancelReason.${tournament.cancelReason}`, { defaultValue: "?" }) })}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 mt-4">
          {r != null && tournament.status === 2 && !myPrizeClaimed && (
            <button
              onClick={() => claimPrize(r)}
              className="retro-btn retro-btn-gold py-2"
              style={{ fontSize: 11 }}
            >
              {t("tournament.watch.claimPrize", { amount: fmtSol(myPrizeAmount), rank: r + 1 })}
            </button>
          )}
          {mySeat && tournament.status >= 2 && !mySeat.claimed && (
            <button
              onClick={claimChip}
              className="retro-btn"
              style={{ fontSize: 10, padding: "6px 12px" }}
            >
              {t("tournament.watch.claimChip", { slot: mySeat.slot })}
            </button>
          )}
          {mySeat && tournament.status >= 2 && mySeat.claimed && (
            <div className="text-xs opacity-50 text-center">
              {t("tournament.watch.reclaimed")}
            </div>
          )}
        </div>
      </div>

      {/* Tournament-mode audit panel: lifecycle tx envelope
          (CREATE / START / COMPLETE / CANCEL) + the switchboard badge.
          We deliberately DON'T pass randomSeed/winner here: a tournament
          has 8 independent per-match seeds, and pairing "the first
          decided match's seed" with "the overall champion" implies that
          seed picked that winner — it didn't.  Per-match seed +
          randomness_account links live in the bracket cells above, which
          is the correct granularity for auditing a bracket. */}
      {tournament.status >= 1 && (
        <BattleAuditPanel
          mode="tournament"
          battleId={tournamentId}
        />
      )}
    </div>
  );
}

// ============================================================
// Main export
// ============================================================

export default function TournamentPage({
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
            {t("tournament.title")}
          </h1>
        </div>
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 14 }}>
            {t("tournament.connect")}
          </div>
          <div className="flex justify-center mt-4">
            <WalletMultiButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 sm:p-4 max-w-4xl mx-auto">
      <div className="text-center mb-4">
        <h1 className="font-pixel text-retro-magenta animate-glow" style={{ fontSize: 18 }}>
          {t("tournament.title")}
        </h1>
        <div className="text-xs opacity-50 mt-1">
          {t("tournament.subtitle", { p1: T_PRIZE_1ST_PCT, p2: T_PRIZE_2ND_PCT, p3: T_PRIZE_3RD_PCT })}
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
        <Watch tournamentId={watchId} onBack={() => setView("lobby")} />
      )}
    </div>
  );
}
