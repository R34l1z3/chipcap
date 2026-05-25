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
  T_BRACKET_SIZE, T_STATUS, T_MATCH_STATUS, T_ROUND_LABEL,
  T_PRIZE_1ST_PCT, T_PRIZE_2ND_PCT, T_PRIZE_3RD_PCT, T_FEE_PCT,
  TICKET_PRICE_SOL, TICKET_PRICE_LAMPORTS,
  T_ENTRY_FEE_OPTIONS_SOL, T_CANCEL_REASON,
} from "../config";
import { fmtSol, lamportsToSol, shortAddr } from "../lib/format";
import ChipCard from "../components/ChipCard";
import BattleAuditPanel from "../components/BattleAuditPanel";

type View = "lobby" | "create" | "watch";

// ============================================================
// TicketBalanceBanner — current ticket count + BUY button
// ============================================================

function TicketBalanceBanner({ onBought }: { onBought?: () => void }) {
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
          YOUR TICKETS
        </span>
        <div className="opacity-80 mt-1">
          <span className="text-retro-gold">{balance}</span> TICKET{balance === 1 ? "" : "S"}
          {" "}· price <span className="text-retro-gold">{TICKET_PRICE_SOL} SOL</span> each
        </div>
      </div>
      <button
        onClick={buy}
        disabled={busy}
        className="retro-btn retro-btn-gold"
        style={{ fontSize: 9, padding: "4px 12px" }}
      >
        {busy ? "BUYING…" : `+ BUY 1 TICKET (${TICKET_PRICE_SOL} SOL)`}
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
          &gt; TOURNAMENT LOBBY
        </h2>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => refetch()} className="retro-btn" style={{ fontSize: 8, padding: "4px 8px" }}>
            REFRESH
          </button>
          <button onClick={onCreate} className="retro-btn retro-btn-gold" style={{ fontSize: 8, padding: "4px 8px" }}>
            <span className="hidden sm:inline">+ CREATE TOURNAMENT</span>
            <span className="sm:hidden">+ CREATE</span>
          </button>
        </div>
      </div>

      <TicketBalanceBanner />

      {/* My active tournaments */}
      {myActive.length > 0 && (
        <div className="mb-4">
          <div className="font-pixel text-retro-gold mb-2" style={{ fontSize: 9 }}>
            YOUR ACTIVE TOURNAMENTS:
          </div>
          {myActive.map((t) => {
            const podium = t.status === 2 && [
              t.winner1stSlot, t.winner2ndSlot, t.winner3rdSlot,
            ].some((s) => s != null && t.players[s]?.player === me);
            return (
              <div
                key={t.id}
                className="retro-panel mb-2 cursor-pointer"
                style={{
                  borderColor:
                    t.status === 2 ? (podium ? "#00FF88" : "#aaa") :
                    t.status === 1 ? "#FF00FF" : "#FFD700",
                }}
                onClick={() => onWatch(t.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>
                      TOURNAMENT #{t.id}
                    </span>
                    <span className="ml-2 text-sm opacity-60">
                      {fmtSol(t.entryFee / 1e9)} entry · {t.registered}/{t.bracketSize}
                    </span>
                  </div>
                  <span className="font-pixel px-2 py-0.5" style={{
                    fontSize: 8,
                    color:
                      t.status === 0 ? "#00FFFF" :
                      t.status === 1 ? "#FF00FF" :
                      t.status === 2 ? (podium ? "#00FF88" : "#888") : "#aaa",
                    border: "1px solid currentColor",
                  }}>
                    {T_STATUS[t.status as keyof typeof T_STATUS]}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Open tournaments */}
      <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>
        OPEN TOURNAMENTS ({open.length}):
      </div>

      {loading && open.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-retro-cyan animate-blink">LOADING...</div>
        </div>
      ) : open.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-sm opacity-60">No open tournaments. Be the first!</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {open.map((t) => {
            const isIn = alreadyIn(t);
            const isRegistering = registering === t.id;
            const entrySol = t.entryFee / 1e9;
            const poolWhenFull = entrySol * t.bracketSize;
            return (
              <div key={t.id} className="retro-panel">
                <div className="flex items-start sm:items-center justify-between gap-2 mb-2 flex-wrap">
                  <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0">
                    <span className="font-pixel text-retro-cyan" style={{ fontSize: 10 }}>#{t.id}</span>
                    <span className="text-retro-gold font-pixel" style={{ fontSize: 12 }}>
                      {fmtSol(entrySol)} SOL
                    </span>
                    <span className="font-pixel" style={{ fontSize: 10, color: "#FF00FF" }}>
                      {t.registered}/{t.bracketSize}
                    </span>
                    <span className="text-xs opacity-50 truncate hidden sm:inline">
                      by {shortAddr(t.creator)}
                    </span>
                  </div>
                  {isIn ? (
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 8 }}>
                      REGISTERED ✓
                    </span>
                  ) : isRegistering ? (
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
                        onClick={() => handleRegister(t)}
                        disabled={!selectedChip || busy === t.id}
                        className="retro-btn retro-btn-gold"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >
                        {busy === t.id ? "JOINING..." : "ENTER!"}
                      </button>
                      <button
                        onClick={() => { setRegistering(null); setSelectedChip(null); }}
                        className="retro-btn"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >X</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setRegistering(t.id)}
                      className="retro-btn retro-btn-gold"
                      style={{ fontSize: 8, padding: "3px 8px" }}
                    >REGISTER</button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs opacity-50 flex-wrap">
                  <span>pool when full: {fmtSol(poolWhenFull)} SOL</span>
                  <span>|</span>
                  <span>1st: {fmtSol(poolWhenFull * 0.6)} · 2nd: {fmtSol(poolWhenFull * 0.25)} · 3rd: {fmtSol(poolWhenFull * 0.1)}</span>
                  <span>|</span>
                  <span>{Math.floor((Date.now() / 1000 - t.createdAt) / 60)}m ago</span>
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
            ACTIVE ({active.length}):
          </div>
          {active.map((t) => (
            <div
              key={t.id}
              className="retro-panel mb-2 cursor-pointer"
              style={{ borderColor: "#FF00FF" }}
              onClick={() => onWatch(t.id)}
            >
              <div className="flex items-center justify-between">
                <span className="font-pixel" style={{ fontSize: 10, color: "#FF00FF" }}>
                  #{t.id} — {fmtSol(t.entryFee / 1e9)} entry
                </span>
                <span className="text-xs">
                  {T_ROUND_LABEL[t.currentRound as keyof typeof T_ROUND_LABEL] ?? "ROUND"}
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
            RECENT COMPLETED ({completed.length}):
          </div>
          {completed.slice(0, 5).map((t) => (
            <div
              key={t.id}
              className="retro-panel mb-2 cursor-pointer"
              style={{ borderColor: "#444" }}
              onClick={() => onWatch(t.id)}
            >
              <div className="flex items-center justify-between">
                <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>
                  #{t.id}
                </span>
                <span className="text-xs opacity-60">
                  winner: {t.winner1stSlot != null
                    ? shortAddr(t.players[t.winner1stSlot]?.player ?? "")
                    : "—"}
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
        &lt; BACK
      </button>
      <div className="retro-panel mb-4">
        <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 11 }}>
          &gt; CREATE NEW TOURNAMENT
        </div>

        <div className="text-xs opacity-60 mb-3" style={{ lineHeight: 1.4 }}>
          8-player single-elimination + 3rd-place playoff.  Every entry
          burns 1 ticket + stakes <b>{fmtSol(entrySol)} SOL</b>.  Prizes:
          {" "}<span className="text-retro-gold">1st {T_PRIZE_1ST_PCT}%</span>,
          {" "}<span className="text-retro-gold">2nd {T_PRIZE_2ND_PCT}%</span>,
          {" "}<span className="text-retro-gold">3rd {T_PRIZE_3RD_PCT}%</span>;
          {" "}{T_FEE_PCT}% fee.  Chips returned to all 8 players.
        </div>

        <TicketBalanceBanner />

        {/* 1. ENTRY FEE */}
        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>1. ENTRY FEE:</div>
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
              >{sol} SOL</button>
            ))}
          </div>
          <div className="text-xs opacity-50 mt-1">
            Pool when full = {fmtSol(poolWhenFull)} SOL → 1st {fmtSol(poolWhenFull * T_PRIZE_1ST_PCT / 100)} · 2nd {fmtSol(poolWhenFull * T_PRIZE_2ND_PCT / 100)} · 3rd {fmtSol(poolWhenFull * T_PRIZE_3RD_PCT / 100)}
          </div>
        </div>

        {/* 2. CREATOR'S CHIP */}
        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>2. YOUR CHIP (creator auto-registers):</div>
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

        <button
          onClick={handleCreate}
          disabled={!chip || busy}
          className="retro-btn retro-btn-gold w-full py-3 font-pixel"
          style={{ fontSize: 12 }}
        >
          {busy
            ? ">> CONFIRM IN WALLET..."
            : `>> CREATE ${fmtSol(entrySol)} SOL TOURNAMENT <<`}
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
  const seat = (slot: number) => {
    if (slot === 255 || slot == null) return { player: null, label: "—" };
    const p = players[slot];
    if (!p) return { player: null, label: `slot ${slot}` };
    return {
      player: p.player,
      label: p.player === me ? "YOU" : shortAddr(p.player),
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
      <div className="text-xs opacity-50">vs</div>
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
        {match.status === 1 && <span className="animate-blink">ROLLING…</span>}
        {match.status === 2 && `seed ${match.seed?.slice(0, 6) ?? "?"}…`}
        {match.status === 0 && "PENDING"}
      </div>
    </div>
  );
}

function Bracket({ t, me }: { t: TournamentData; me?: string | null }) {
  // matches[0..4] = R0 (4 quarters)
  // matches[4..6] = R1 (2 semis)
  // matches[6]    = R2 final
  // matches[7]    = R2 3rd-place
  return (
    <div className="overflow-x-auto">
      <div className="flex gap-4 items-stretch" style={{ minWidth: 600, padding: 8 }}>
        {/* R0 */}
        <div className="flex flex-col gap-2 justify-around">
          <div className="font-pixel text-retro-cyan text-center" style={{ fontSize: 7 }}>QUARTERS</div>
          {[0, 1, 2, 3].map((i) => (
            <MatchCell key={i} match={t.matches[i] ?? defaultMatch()} players={t.players} me={me} />
          ))}
        </div>

        {/* R1 */}
        <div className="flex flex-col gap-2 justify-around">
          <div className="font-pixel text-retro-cyan text-center" style={{ fontSize: 7 }}>SEMIS</div>
          {[4, 5].map((i) => (
            <MatchCell key={i} match={t.matches[i] ?? defaultMatch()} players={t.players} me={me} />
          ))}
        </div>

        {/* R2 */}
        <div className="flex flex-col gap-2 justify-around">
          <div className="font-pixel text-retro-cyan text-center" style={{ fontSize: 7 }}>FINAL</div>
          <MatchCell match={t.matches[6] ?? defaultMatch()} players={t.players} me={me} label="GOLD" />
          <MatchCell match={t.matches[7] ?? defaultMatch()} players={t.players} me={me} label="BRONZE" />
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

  const t = tIndex;

  // Per-seat chip-claim state from on-chain mask.
  const playerSeats = useMemo(() => {
    if (!t || !tChain) return [] as { slot: number; player: string; chip: string; claimed: boolean }[];
    const mask: number = Number(tChain.chipsClaimedMask ?? 0);
    return t.players.map((p) => ({
      slot: p.slot, player: p.player, chip: p.chip,
      claimed: (mask & (1 << p.slot)) !== 0,
    }));
  }, [t, tChain]);

  const mySeat = playerSeats.find((s) => s.player === me);

  // Anchor camelCase: winner_1st_slot → winner1StSlot (capital S after digit).
  const w1 = tChain?.winner1StSlot;
  const w2 = tChain?.winner2NdSlot;
  const w3 = tChain?.winner3RdSlot;
  const prizeClaimedMask = Number(tChain?.prizeClaimedMask ?? 0);

  const myRank = (): number | null => {
    if (!t || !me) return null;
    if (w1 != null && w1 !== 255 && t.players[w1]?.player === me) return 0;
    if (w2 != null && w2 !== 255 && t.players[w2]?.player === me) return 1;
    if (w3 != null && w3 !== 255 && t.players[w3]?.player === me) return 2;
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
    } catch (e) { notifyTxError(`Claim prize rank ${rank + 1}`, e); }
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

  if (!t) {
    return (
      <div>
        <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>&lt; BACK</button>
        <div className="retro-panel text-center py-8">
          <div className="animate-blink text-retro-cyan">LOADING TOURNAMENT #{tournamentId}…</div>
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
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>&lt; BACK</button>

      <div
        className="retro-panel"
        style={{
          borderColor:
            t.status === 2 ? "#FFD700" :
            t.status === 1 ? "#FF00FF" : "#4a4a8a",
        }}
      >
        {/* Header */}
        <div className="text-center mb-4">
          <div className="font-pixel text-retro-gold" style={{ fontSize: 14 }}>TOURNAMENT #{tournamentId}</div>
          <div className="text-sm">
            {fmtSol(t.entryFee / 1e9)} entry · {t.registered}/{t.bracketSize}
            {t.status === 1 && <> · <span className="text-retro-magenta">{T_ROUND_LABEL[t.currentRound as keyof typeof T_ROUND_LABEL] ?? ""}</span></>}
          </div>
          <div className="font-pixel mt-1 inline-block px-3 py-0.5" style={{
            fontSize: 9,
            color:
              t.status === 0 ? "#00FFFF" :
              t.status === 1 ? "#FF00FF" :
              t.status === 2 ? "#FFD700" : "#aaa",
            border: "1px solid currentColor",
          }}>
            {T_STATUS[t.status as keyof typeof T_STATUS]}
          </div>
        </div>

        {/* Bracket */}
        {t.status >= 1 && <Bracket t={t} me={me} />}

        {/* Seats (during REGISTERING) */}
        {t.status === 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
            {Array.from({ length: t.bracketSize }).map((_, i) => {
              const p = t.players.find((x) => x.slot === i);
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
                    SEAT {i}
                  </div>
                  <div className="text-xs opacity-70 truncate mt-1">
                    {p ? (p.player === me ? "YOU" : shortAddr(p.player)) : "empty"}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Podium (when COMPLETED) */}
        {t.status === 2 && tChain && (
          <div className="grid grid-cols-3 gap-2 mt-4">
            {[
              { rank: 0, slot: w1, label: "1st", pct: T_PRIZE_1ST_PCT, color: "#FFD700" },
              { rank: 1, slot: w2, label: "2nd", pct: T_PRIZE_2ND_PCT, color: "#C0C0C0" },
              { rank: 2, slot: w3, label: "3rd", pct: T_PRIZE_3RD_PCT, color: "#CD7F32" },
            ].map(({ rank, slot, label, pct, color }) => {
              const player = (slot != null && slot !== 255) ? t.players[slot]?.player : null;
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
                    {player ? (isMe ? "YOU" : shortAddr(player)) : "—"}
                  </div>
                  <div className="text-xs font-pixel mt-1" style={{ fontSize: 9, color }}>
                    {fmtSol(prize)} SOL ({pct}%)
                  </div>
                  {claimed && (
                    <div className="text-xs font-pixel mt-1" style={{ fontSize: 7, color: "#666" }}>
                      claimed ✓
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Cancelled */}
        {t.status === 3 && (
          <div className="text-center py-3 mt-3 opacity-50">
            <div className="font-pixel" style={{ fontSize: 12 }}>TOURNAMENT CANCELLED</div>
            <div className="text-xs mt-1">
              reason: {T_CANCEL_REASON[t.cancelReason as keyof typeof T_CANCEL_REASON] ?? "?"}
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2 mt-4">
          {r != null && t.status === 2 && !myPrizeClaimed && (
            <button
              onClick={() => claimPrize(r)}
              className="retro-btn retro-btn-gold py-2"
              style={{ fontSize: 11 }}
            >
              CLAIM {fmtSol(myPrizeAmount)} SOL — RANK {r + 1}
            </button>
          )}
          {mySeat && t.status >= 2 && !mySeat.claimed && (
            <button
              onClick={claimChip}
              className="retro-btn"
              style={{ fontSize: 10, padding: "6px 12px" }}
            >
              CLAIM MY CHIP BACK (slot {mySeat.slot})
            </button>
          )}
          {mySeat && t.status >= 2 && mySeat.claimed && (
            <div className="text-xs opacity-50 text-center">
              You've reclaimed your chip ✓
            </div>
          )}
        </div>
      </div>

      {/* Reuse the BR/1v1 audit panel — for tournaments it carries the
          vrf_method badge (switchboard) but the underlying per-match
          seeds are visible directly in the bracket cells above.  Audit
          panel adds a top-level link to ANY of the per-match randomness
          accounts for solscan deep-dive; for now we punt and just show
          the tournament-level badge. */}
      {t.status >= 1 && (
        <BattleAuditPanel
          battleId={tournamentId}
          randomSeed={t.matches.find((m) => m.status === 2)?.seed ?? null}
          winner={w1 != null && w1 !== 255 ? t.players[w1]?.player : null}
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
            TOURNAMENTS
          </h1>
        </div>
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 14 }}>
            CONNECT WALLET TO COMPETE
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
          TOURNAMENTS
        </h1>
        <div className="text-xs opacity-50 mt-1">
          8-player single-elim · {T_PRIZE_1ST_PCT}/{T_PRIZE_2ND_PCT}/{T_PRIZE_3RD_PCT}% prize split · Switchboard VRF per match
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
