// ============================================================
// src/pages/BattlePage.tsx — full battle flow on Solana
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, PublicKey, SystemProgram } from "@solana/web3.js";

import { useArenaProgram } from "../hooks/useArenaProgram";
import { useChipNftProgram } from "../hooks/useChipNftProgram";
import { useTreasuryProgram } from "../hooks/useTreasuryProgram";
import { useUserAccount } from "../hooks/useUserAccount";
import { useArenaConfig } from "../hooks/useArenaConfig";
import { useIndexerBattles, type BattleData } from "../hooks/useIndexerBattles";
import { useChipsByOwner } from "../hooks/useChipsByOwner";

import { notify, notifyTxError } from "../lib/notifications";
import * as pda from "../lib/pda";
import { MPL_CORE_PROGRAM } from "../lib/mpl";
import { POOL_TIERS } from "../config";
import { fmtSol, lamportsToSol, shortAddr } from "../lib/format";
import ChipCard from "../components/ChipCard";
import BattleAuditPanel from "../components/BattleAuditPanel";

type View = "lobby" | "create" | "watch";

// ============================================================
// DepositWithdrawBanner — internal-balance ledger UI
// ============================================================

function DepositWithdrawBanner() {
  const { t } = useTranslation();
  const arena = useArenaProgram();
  const { publicKey } = useWallet();
  const { data: user, refetch: refetchUser } = useUserAccount();

  const [amountSol, setAmountSol] = useState("0.5");
  const [busy, setBusy] = useState<"deposit" | "withdraw" | null>(null);

  const balanceSol = lamportsToSol(user?.balance);
  const lockedSol  = lamportsToSol(user?.locked);

  const lamports = (() => {
    const f = parseFloat(amountSol);
    if (!Number.isFinite(f) || f <= 0) return 0;
    return Math.floor(f * LAMPORTS_PER_SOL);
  })();

  const deposit = async () => {
    if (!arena || !publicKey || lamports <= 0) return;
    setBusy("deposit");
    try {
      const sig = await (arena.methods as any)
        .deposit(new BN(lamports))
        .accounts({
          config: pda.arenaConfig(),
          vault:  pda.arenaVault(),
          user:   pda.userAccount(publicKey),
          payer:  publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      notify("info", `Deposited ${amountSol} SOL · ${sig.slice(0, 8)}…`);
      await refetchUser();
    } catch (e) { notifyTxError("Deposit", e); }
    finally { setBusy(null); }
  };

  const withdrawAll = async () => {
    if (!arena || !publicKey || !user) return;
    const amt = user.balance.toNumber();
    if (amt <= 0) return;
    setBusy("withdraw");
    try {
      const sig = await (arena.methods as any)
        .withdraw(new BN(amt))
        .accounts({
          config: pda.arenaConfig(),
          vault:  pda.arenaVault(),
          user:   pda.userAccount(publicKey),
          authority: publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      notify("info", `Withdrew ${fmtSol(amt / LAMPORTS_PER_SOL)} SOL · ${sig.slice(0, 8)}…`);
      await refetchUser();
    } catch (e) { notifyTxError("Withdraw", e); }
    finally { setBusy(null); }
  };

  if (!publicKey) return null;

  return (
    <div className="retro-panel mb-4" style={{ borderColor: "#FFD700", background: "#221a00" }}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div>
          <div className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>
            {t("battle.balance.title")}
          </div>
          <div className="text-xs opacity-60 mt-1">
            {t("battle.balance.free")} <span className="text-retro-gold">{fmtSol(balanceSol)} SOL</span>
            <span className="opacity-40 mx-2">·</span>
            {t("battle.balance.locked")} <span className="text-retro-magenta">{fmtSol(lockedSol)} SOL</span>
          </div>
        </div>
        <button
          onClick={withdrawAll}
          disabled={busy !== null || !user || user.balance.isZero()}
          className="retro-btn retro-btn-gold"
          style={{ fontSize: 9, padding: "4px 10px" }}
        >
          {busy === "withdraw" ? t("battle.balance.withdrawing") : t("battle.balance.withdrawAll")}
        </button>
      </div>
      <div className="flex gap-2 items-center flex-wrap">
        <input
          className="retro-input flex-1 min-w-[120px]"
          style={{ fontSize: 14, padding: "6px 8px" }}
          value={amountSol}
          onChange={(e) => setAmountSol(e.target.value)}
          type="text"
          inputMode="decimal"
          placeholder={t("battle.balance.amountPlaceholder")}
        />
        <button
          onClick={deposit}
          disabled={busy !== null || lamports <= 0}
          className="retro-btn"
          style={{ fontSize: 9, padding: "4px 10px" }}
        >
          {busy === "deposit" ? t("battle.balance.depositing") : t("battle.balance.deposit")}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Lobby
// ============================================================

function Lobby({
  onCreateBattle, onWatchBattle,
}: {
  onCreateBattle: () => void;
  onWatchBattle: (id: number) => void;
}) {
  const { t } = useTranslation();
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58();
  const arena = useArenaProgram();
  const { openBattles, rollingBattles, myActiveBattles, loading, refetch } = useIndexerBattles();
  const { chips } = useChipsByOwner(me);

  const [joining, setJoining] = useState<number | null>(null);
  const [selectedChip, setSelectedChip] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const handleJoin = async (b: BattleData) => {
    if (!arena || !publicKey || !selectedChip) return;
    setBusy(b.id);
    try {
      const sig = await (arena.methods as any)
        .joinBattle()
        .accounts({
          config: pda.arenaConfig(),
          battle: pda.battle(b.id),
          chipAuthority: pda.chipAuthority(),
          chip:    new PublicKey(selectedChip),
          player:  publicKey,
          mplCore: MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      notify("joined", `Joined battle #${b.id}! ${sig.slice(0, 8)}…`);
      setJoining(null);
      setSelectedChip(null);
      await refetch();
    } catch (e) { notifyTxError("Join battle", e); }
    finally { setBusy(null); }
  };

  const handleCancel = async (b: BattleData) => {
    if (!arena || !publicKey) return;
    setBusy(b.id);
    try {
      const sig = await (arena.methods as any)
        .cancelBattle()
        .accounts({
          config: pda.arenaConfig(),
          battle: pda.battle(b.id),
          chipAuthority: pda.chipAuthority(),
          chipA:  new PublicKey(b.chipA),
          player: publicKey,
          mplCore: MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      notify("info", `Cancelled battle #${b.id} · ${sig.slice(0, 8)}…`);
      await refetch();
    } catch (e) { notifyTxError("Cancel battle", e); }
    finally { setBusy(null); }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <h2 className="font-pixel text-retro-cyan" style={{ fontSize: 12 }}>{t("battle.lobby.title")}</h2>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => refetch()} className="retro-btn" style={{ fontSize: 8, padding: "4px 8px" }}>
            {t("common.refresh")}
          </button>
          <button onClick={onCreateBattle} className="retro-btn retro-btn-gold" style={{ fontSize: 8, padding: "4px 8px" }}>
            <span className="hidden sm:inline">{t("battle.lobby.createLong")}</span>
            <span className="sm:hidden">{t("battle.lobby.createShort")}</span>
          </button>
        </div>
      </div>

      <DepositWithdrawBanner />

      {/* My active battles */}
      {myActiveBattles.length > 0 && (
        <div className="mb-4">
          <div className="font-pixel text-retro-gold mb-2" style={{ fontSize: 9 }}>
            {t("battle.lobby.yourActive")}
          </div>
          {myActiveBattles.map((b) => {
            const needsAction = b.status === 2 && b.loser  === me;
            const canClaim    = b.status === 2 && b.winner === me;
            return (
              <div
                key={b.id}
                className="retro-panel mb-2 cursor-pointer"
                style={{
                  borderColor:
                    b.status === 2 ? "#FF3333" :
                    b.status === 1 ? "#FF00FF" : "#FFD700",
                }}
                onClick={() => onWatchBattle(b.id)}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>
                      {t("battle.lobby.battleNum", { id: b.id })}
                    </span>
                    <span className="ml-2 text-sm opacity-60">{b.poolLabel}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-pixel px-2 py-0.5" style={{
                      fontSize: 8,
                      color:
                        b.status === 0 ? "#00FFFF" :
                        b.status === 1 ? "#FF00FF" :
                        b.status === 2 ? "#FF3333" : "#aaa",
                      border: "1px solid currentColor",
                    }}>
                      {t(`status.${b.status}`)}
                    </span>
                    {needsAction && (
                      <span className="font-pixel text-retro-red animate-blink" style={{ fontSize: 8 }}>
                        {t("battle.lobby.payOrForfeit")}
                      </span>
                    )}
                    {canClaim && (
                      <span className="font-pixel text-retro-win" style={{ fontSize: 8 }}>
                        {t("battle.lobby.claim")}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Open battles */}
      <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>
        {t("battle.lobby.open", { count: openBattles.length })}
      </div>

      {loading && openBattles.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-retro-cyan animate-blink">{t("common.loading")}</div>
        </div>
      ) : openBattles.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-sm opacity-60">{t("battle.lobby.noOpen")}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {openBattles.map((b) => {
            const isOwn = b.playerA === me;
            const isJoining = joining === b.id;
            return (
              <div key={b.id} className="retro-panel">
                <div className="flex items-start sm:items-center justify-between gap-2 mb-2 flex-wrap">
                  <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0">
                    <span className="font-pixel text-retro-cyan" style={{ fontSize: 10 }}>#{b.id}</span>
                    <span className="text-retro-gold font-pixel" style={{ fontSize: 12 }}>{b.poolLabel}</span>
                    <span className="text-xs opacity-50 truncate">{t("common.by")} {shortAddr(b.playerA)}</span>
                  </div>
                  {isOwn ? (
                    <button onClick={() => handleCancel(b)} disabled={busy === b.id}
                      className="retro-btn retro-btn-red" style={{ fontSize: 8, padding: "3px 8px" }}>
                      {busy === b.id ? "..." : t("battle.lobby.cancel")}
                    </button>
                  ) : isJoining ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        className="retro-input text-sm py-1"
                        style={{ fontSize: 14, maxWidth: 180 }}
                        value={selectedChip ?? ""}
                        onChange={(e) => setSelectedChip(e.target.value || null)}
                      >
                        <option value="">{t("battle.lobby.pickChip")}</option>
                        {chips.map((c) => (
                          <option key={c.asset} value={c.asset}>
                            #{c.token_id} · …{c.asset.slice(-4)}
                          </option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleJoin(b)}
                        disabled={!selectedChip || busy === b.id}
                        className="retro-btn retro-btn-gold"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >
                        {busy === b.id ? t("battle.lobby.joining") : t("battle.lobby.fight")}
                      </button>
                      <button
                        onClick={() => { setJoining(null); setSelectedChip(null); }}
                        className="retro-btn"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >X</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setJoining(b.id)}
                      className="retro-btn retro-btn-gold"
                      style={{ fontSize: 8, padding: "3px 8px" }}
                    >{t("battle.lobby.join")}</button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs opacity-50">
                  <span>{t("battle.lobby.chipTail", { tail: b.chipA.slice(-4) })}</span>
                  <span>|</span>
                  <span>{t("battle.lobby.minAgo", { n: Math.floor((Date.now() / 1000 - b.createdAt) / 60) })}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Rolling */}
      {rollingBattles.length > 0 && (
        <div className="mt-4">
          <div className="font-pixel text-retro-magenta mb-2" style={{ fontSize: 9 }}>
            {t("battle.lobby.rolling", { count: rollingBattles.length })}
          </div>
          {rollingBattles.map((b) => (
            <div
              key={b.id}
              className="retro-panel mb-2 cursor-pointer"
              style={{ borderColor: "#FF00FF" }}
              onClick={() => onWatchBattle(b.id)}
            >
              <div className="flex items-center justify-between">
                <span className="font-pixel" style={{ fontSize: 10, color: "#FF00FF" }}>
                  #{b.id} — {b.poolLabel}
                </span>
                <span className="animate-blink text-retro-magenta" style={{ fontSize: 12 }}>
                  {t("battle.lobby.waitingForVrf")}
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
// CreateBattle
// ============================================================

function CreateBattle({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const { publicKey } = useWallet();
  const arena = useArenaProgram();
  const { chips } = useChipsByOwner(publicKey?.toBase58());
  const { data: cfg } = useArenaConfig();

  const [chip, setChip] = useState<string | null>(null);
  const [tier, setTier] = useState(2);
  const [busy, setBusy] = useState(false);

  const handleCreate = async () => {
    if (!arena || !publicKey || !chip || !cfg) return;
    setBusy(true);
    try {
      const battleId = cfg.nextBattleId.toString();
      const sig = await (arena.methods as any)
        .createBattle(tier)
        .accounts({
          config: pda.arenaConfig(),
          battle: pda.battle(new BN(battleId)),
          chipAuthority: pda.chipAuthority(),
          chip:   new PublicKey(chip),
          player: publicKey,
          mplCore: MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      notify("created", `Battle #${battleId} created · ${sig.slice(0, 8)}…`);
      onBack();
    } catch (e) { notifyTxError("Create battle", e); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>
        {t("battle.create.back")}
      </button>
      <div className="retro-panel mb-4">
        <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 11 }}>
          {t("battle.create.title")}
        </div>

        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>{t("battle.create.step1")}</div>
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
          <div className="text-xs opacity-50 mt-1">
            {t("battle.create.loseHint", { pool: POOL_TIERS[tier].label })}
          </div>
        </div>

        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>{t("battle.create.step2")}</div>
          {chips.length === 0 ? (
            <div className="text-sm opacity-50">{t("battle.create.noChips")}</div>
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

        <button
          onClick={handleCreate}
          disabled={!chip || busy}
          className="retro-btn retro-btn-gold w-full py-3 font-pixel"
          style={{ fontSize: 12 }}
        >
          {busy
            ? t("battle.create.confirm")
            : t("battle.create.cta", { pool: POOL_TIERS[tier].label })}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// WatchBattle
// ============================================================

function WatchBattle({ battleId, onBack }: { battleId: number; onBack: () => void }) {
  const { t } = useTranslation();
  const { publicKey } = useWallet();
  const arena    = useArenaProgram();
  const chipNft  = useChipNftProgram();
  const treasury = useTreasuryProgram();
  const { data: cfg } = useArenaConfig();
  const { data: user, refetch: refetchUser } = useUserAccount();
  const me = publicKey?.toBase58();

  const [battle, setBattle] = useState<any>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // The Battle account has no "winner chip claimed" flag — we read the
  // chip asset's mpl-core owner instead (bytes 1..33 of AssetV1).  Once
  // the owner equals battle.winner, the chip left escrow and the CLAIM
  // panel must disappear (clicking again would fail inside mpl-core
  // with a cryptic IncorrectOwner).
  const [winnerChipClaimed, setWinnerChipClaimed] = useState(false);

  const fetchBattle = useCallback(async () => {
    if (!arena) return;
    try {
      const acc = await (arena.account as any).battle.fetchNullable(pda.battle(battleId));
      setBattle(acc);
      if (acc && (acc.status === 2 || acc.status === 3) && acc.winner) {
        const wChip = acc.winner.equals?.(acc.playerA) ? acc.chipA : acc.chipB;
        const info = await (arena as any).provider.connection.getAccountInfo(wChip);
        if (info?.data && info.data.length >= 33) {
          const owner = new PublicKey(info.data.subarray(1, 33));
          setWinnerChipClaimed(owner.equals(acc.winner));
        }
      }
    } catch { setBattle(null); }
  }, [arena, battleId]);

  useEffect(() => {
    fetchBattle();
    const id = setInterval(fetchBattle, 3000);
    return () => clearInterval(id);
  }, [fetchBattle]);

  // 1 Hz ticker so the pay-window countdown stays live — only while
  // there is actually a deadline on screen (loser at DECIDED).
  const [, forceTick] = useState(0);
  const battleStatus = battle ? Number(battle.status) : null;
  const iAmLoser = !!(me && battle?.loser?.toBase58?.() === me);
  useEffect(() => {
    if (battleStatus !== 2 || !iAmLoser) return;
    const id = setInterval(() => forceTick((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [battleStatus, iAmLoser]);

  if (!battle) {
    return (
      <div>
        <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>{t("battle.watch.back")}</button>
        <div className="retro-panel text-center py-8">
          <div className="animate-blink text-retro-cyan">{t("battle.watch.loading", { id: battleId })}</div>
        </div>
      </div>
    );
  }

  const status   = battle.status;
  const isPlayerA = me && battle.playerA?.toBase58?.() === me;
  const isPlayerB = me && battle.playerB?.toBase58?.() === me;
  const isWinner  = me && battle.winner?.toBase58?.()  === me;
  const isLoser   = me && battle.loser?.toBase58?.()   === me;
  const poolLabel = POOL_TIERS[Number(battle.poolTier)]?.label ?? "?";

  const winnerChip = battle.winner?.equals?.(battle.playerA) ? battle.chipA : battle.chipB;
  const loserChip  = battle.loser?.equals?.(battle.playerA)  ? battle.chipA : battle.chipB;

  // ---- actions ----

  const claim = async () => {
    if (!arena || !publicKey) return;
    setBusy("claim");
    try {
      // SEC-26 — record the win toward this chip's tier progression in
      // the SAME tx as the claim.  record_chip_win is permissionless +
      // idempotent (monotonic last_game_id guard), so bundling it here
      // is the natural moment: the winner is already signing, the battle
      // is DECIDED, and the chip is theirs.  Best-effort: if the chip-nft
      // program isn't wired yet (older deploy) we still let the claim go.
      const preIxs: any[] = [];
      if (chipNft) {
        try {
          preIxs.push(
            await (chipNft.methods as any).recordChipWin()
              .accounts({
                config:    pda.chipNftConfig(),
                chipData:  pda.chipData(winnerChip),
                game:      pda.battle(battleId),
                caller:    publicKey,
              }).instruction(),
          );
        } catch { /* leave preIxs empty — claim still works */ }
      }

      await (arena.methods as any).claimWinnerChip()
        .accounts({
          config: pda.arenaConfig(),
          battle: pda.battle(battleId),
          chipAuthority: pda.chipAuthority(),
          chip: winnerChip,
          winner: publicKey,
          mplCore: MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(preIxs)
        .rpc();
      notify("info", `Claimed chip from battle #${battleId}!`);
      await fetchBattle();
    } catch (e) { notifyTxError("Claim", e); }
    finally { setBusy(null); }
  };

  // pay_ransom debits the POOL from the loser's internal balance — but
  // joining a 1v1 battle never moves SOL, so a loser who has not used
  // the DEPOSIT banner has balance 0 (or no UserAccount at all) and the
  // ix fails with InsufficientBalance / AccountNotInitialized.  Mirror
  // the BR-join fix: bundle a deposit for the shortfall (deposit is
  // init_if_needed, so it also creates the PDA on first use).
  const poolLamports = battle && cfg
    ? Number(cfg.poolAmounts[Number(battle.poolTier)]?.toString?.() ?? 0)
    : 0;
  const payShortfall = Math.max(0, poolLamports - (user?.balance?.toNumber?.() ?? 0));

  const pay = async () => {
    if (!arena || !chipNft || !treasury || !publicKey) return;
    setBusy("pay");
    try {
      const preIxs: any[] = [];

      if (payShortfall > 0) {
        preIxs.push(
          await (arena.methods as any).deposit(new BN(payShortfall))
            .accounts({
              config:        pda.arenaConfig(),
              vault:         pda.arenaVault(),
              user:          pda.userAccount(publicKey),
              payer:         publicKey,
              systemProgram: SystemProgram.programId,
            }).instruction(),
        );
      }

      // SEC-10: bundle `ensure_user_account` in the same transaction so
      // the loser pays the rent for the winner's UserAccount PDA if it
      // doesn't exist yet.  No popup from the winner — one signature
      // total.  (init_if_needed inside pay_ransom would blow the 4 KB
      // BPF stack frame; this is the cheap workaround.)
      preIxs.push(
        await (arena.methods as any).ensureUserAccount()
          .accounts({
            user:      pda.userAccount(battle.winner),
            authority: battle.winner,
            payer:     publicKey,
            systemProgram: SystemProgram.programId,
          }).instruction(),
      );

      await (arena.methods as any).payRansom()
        .accounts({
          config: pda.arenaConfig(),
          battle: pda.battle(battleId),
          chipAuthority: pda.chipAuthority(),
          vault: pda.arenaVault(),
          loserUser:  pda.userAccount(battle.loser),
          winnerUser: pda.userAccount(battle.winner),
          chipLoser:  loserChip,
          treasuryConfig: pda.treasuryConfig(),
          treasuryVault:  pda.treasuryVault(),
          treasuryProgram: treasury.programId,
          loser:  publicKey,
          winner: battle.winner,
          mplCore: MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions(preIxs)
        .rpc();
      notify("settled", `Paid ransom for battle #${battleId}!`);
      await Promise.all([fetchBattle(), refetchUser()]);
    } catch (e) { notifyTxError("Pay ransom", e); }
    finally { setBusy(null); }
  };

  const forfeit = async () => {
    if (!arena || !chipNft || !publicKey) return;
    setBusy("forfeit");
    try {
      await (arena.methods as any).forfeitChip()
        .accounts({
          config: pda.arenaConfig(),
          battle: pda.battle(battleId),
          chipAuthority: pda.chipAuthority(),
          chipLoser:  loserChip,
          chipWinner: winnerChip,
          chipNftConfig: pda.chipNftConfig(),
          chipDataA:  pda.chipData(battle.chipA),
          chipDataB:  pda.chipData(battle.chipB),
          chipNftProgram: chipNft.programId,
          loser:  publicKey,
          winner: battle.winner,
          mplCore: MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        }).rpc();
      notify("settled", `Forfeited battle #${battleId}.`);
      await fetchBattle();
    } catch (e) { notifyTxError("Forfeit", e); }
    finally { setBusy(null); }
  };

  const forceResolve = async () => {
    if (!arena || !publicKey) return;
    setBusy("force");
    try {
      await (arena.methods as any).forceResolve()
        .accounts({
          config: pda.arenaConfig(),
          battle: pda.battle(battleId),
          chipAuthority: pda.chipAuthority(),
          chipA: battle.chipA,
          chipB: battle.chipB,
          playerA: battle.playerA,
          playerB: battle.playerB,
          mplCore: MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        }).rpc();
      notify("info", `Force-resolved battle #${battleId} — chips refunded.`);
      await fetchBattle();
    } catch (e) { notifyTxError("Force resolve", e); }
    finally { setBusy(null); }
  };

  return (
    <div>
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>{t("battle.watch.back")}</button>

      <div className="retro-panel" style={{
        borderColor:
          status === 2 ? "#FF3333" :
          status === 1 ? "#FF00FF" : "#4a4a8a",
      }}>
        {/* Header */}
        <div className="text-center mb-4">
          <div className="font-pixel text-retro-gold" style={{ fontSize: 14 }}>{t("battle.watch.battleNum", { id: battleId })}</div>
          <div className="text-sm">{t("battle.watch.poolSuffix", { pool: poolLabel })}</div>
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

        {/* Players */}
        <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4">
          <div className="text-center min-w-0">
            <div className="font-pixel mb-1 truncate" style={{ fontSize: 8, color: isPlayerA ? "#FFD700" : "#00FFFF" }}>
              {isPlayerA ? t("common.you") : shortAddr(battle.playerA?.toBase58?.())}
            </div>
            <ChipCard asset={battle.chipA?.toBase58?.()} tier={0} size="md" />
          </div>

          <div className="flex flex-col items-center flex-shrink-0">
            <div className="font-pixel animate-glow" style={{
              fontSize: 20,
              color: status === 1 ? "#FF00FF" : status === 2 ? "#FFD700" : "#4a4a8a",
            }}>{t("battle.watch.vs")}</div>
            {status === 1 && (
              <div className="animate-blink text-retro-magenta mt-1 text-center" style={{ fontSize: 11 }}>
                {t("battle.watch.rolling")}
              </div>
            )}
          </div>

          <div className="text-center min-w-0">
            <div className="font-pixel mb-1 truncate" style={{ fontSize: 8, color: isPlayerB ? "#FFD700" : "#00FFFF" }}>
              {battle.playerB?.equals?.(new PublicKey("11111111111111111111111111111111"))
                ? t("battle.watch.unknown")
                : isPlayerB ? t("common.you") : shortAddr(battle.playerB?.toBase58?.())}
            </div>
            <ChipCard asset={battle.chipB?.toBase58?.()} tier={0} size="md" />
          </div>
        </div>

        {/* Status-specific actions */}
        {status === 1 && (
          <div className="text-center py-4">
            <div className="text-xs opacity-50 mb-2">{t("battle.watch.waitingForVrf")}</div>
            {(isPlayerA || isPlayerB) && (
              <button
                onClick={forceResolve}
                disabled={busy !== null}
                className="retro-btn retro-btn-red px-4 py-2"
                style={{ fontSize: 9 }}
              >
                {busy === "force" ? t("battle.watch.resolving") : t("battle.watch.forceResolve")}
              </button>
            )}
          </div>
        )}

        {status === 2 && (
          <div>
            <div className="text-center py-3 mb-4 font-pixel" style={{
              fontSize: 14,
              background: isWinner ? "#003300" : isLoser ? "#330000" : "#1a1a4e",
              border: `2px solid ${isWinner ? "#00FF00" : isLoser ? "#FF0000" : "#4a4a8a"}`,
              color: isWinner ? "#00FF88" : isLoser ? "#FF4444" : "#FFD700",
              textShadow: `0 0 15px currentColor`,
            }}>
              {isWinner ? t("battle.watch.youWon")
               : isLoser ? t("battle.watch.youLost")
               : t("battle.watch.winnerIs", { addr: shortAddr(battle.winner?.toBase58?.()) })}
            </div>

            {isWinner && !winnerChipClaimed && (
              <div className="retro-panel mb-3" style={{ borderColor: "#00FF00", background: "#001a11" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-retro-win font-pixel" style={{ fontSize: 10 }}>{t("battle.watch.claimYourChip")}</div>
                    <div className="text-xs opacity-60 mt-1">{t("battle.watch.chipInEscrow")}</div>
                  </div>
                  <button
                    onClick={claim} disabled={busy !== null}
                    className="retro-btn retro-btn-gold px-4"
                    style={{ fontSize: 9 }}
                  >
                    {busy === "claim" ? t("battle.watch.claiming") : t("battle.watch.claimChip")}
                  </button>
                </div>
              </div>
            )}
            {isWinner && winnerChipClaimed && (
              <div className="text-xs opacity-50 text-center mb-3">
                {t("battle.watch.chipClaimed")}
              </div>
            )}

            {isLoser && (() => {
              // pay_ransom is rejected after decided_at + decision_timeout
              // (DecisionPeriodExpired) — don't offer a button the program
              // will bounce.  forfeit_chip has no time gate.
              const now = Math.floor(Date.now() / 1000);
              const deadline = cfg
                ? (Number(battle.decidedAt) || 0) + cfg.decisionTimeout
                : null;
              const remaining = deadline != null ? deadline - now : null;
              const payOpen = remaining == null || remaining > 0;
              return (
                <div className="retro-panel" style={{ borderColor: "#FF3333" }}>
                  <div className="font-pixel text-retro-red text-center mb-3" style={{ fontSize: 10 }}>
                    {t("battle.watch.chooseFate")}
                  </div>
                  <div className={payOpen ? "grid grid-cols-2 gap-3" : "grid grid-cols-1 gap-3"}>
                    {payOpen && (
                      <button
                        onClick={pay} disabled={busy !== null}
                        className="retro-btn retro-btn-gold py-4"
                        style={{ fontSize: 9 }}
                      >
                        <div>{t("battle.watch.payToKeep")}</div>
                        <div className="mt-1 text-xs opacity-70">{t("battle.watch.payToKeepSub", { pool: poolLabel })}</div>
                        {busy === "pay" && <div className="mt-1 animate-blink">{t("battle.watch.paying")}</div>}
                      </button>
                    )}
                    <button
                      onClick={forfeit} disabled={busy !== null}
                      className="retro-btn retro-btn-red py-4"
                      style={{ fontSize: 9 }}
                    >
                      <div>{t("battle.watch.forfeitChip")}</div>
                      <div className="mt-1 text-xs opacity-70">{t("battle.watch.forfeitSub")}</div>
                      {busy === "forfeit" && <div className="mt-1 animate-blink">{t("battle.watch.forfeiting")}</div>}
                    </button>
                  </div>
                  {payOpen && remaining != null && (
                    <div className="text-xs opacity-50 text-center mt-2">
                      {t("battle.watch.payCloses", {
                        h: Math.floor(remaining / 3600),
                        m: Math.floor((remaining % 3600) / 60),
                      })}
                    </div>
                  )}
                  {payOpen && payShortfall > 0 && (
                    <div className="text-xs text-retro-cyan text-center mt-1 opacity-80">
                      {t("battle.watch.autoTopUp", { amount: fmtSol(payShortfall / LAMPORTS_PER_SOL) })}
                    </div>
                  )}
                  {!payOpen && (
                    <div className="text-xs text-retro-red text-center mt-2 opacity-80">
                      {t("battle.watch.payExpired")}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}

        {status === 3 && (
          <div className="text-center py-4">
            <div className="font-pixel mb-3" style={{
              fontSize: 16,
              color: isWinner ? "#00FF88" : isLoser ? "#FF4444" : "#FFD700",
              textShadow: `0 0 20px currentColor`,
            }}>
              {isWinner ? t("battle.watch.victory") : isLoser ? t("battle.watch.defeat") : t("battle.watch.complete")}
            </div>
            <div className="text-sm opacity-60">
              {t("battle.watch.resolutionLabel")} {battle.resolution === 1 ? t("resolution.1")
                : battle.resolution === 2 ? t("resolution.2")
                : battle.resolution === 3 ? t("resolution.3") : "—"}
            </div>
          </div>
        )}

        {status === 4 && (
          <div className="text-center py-4 opacity-50">
            <div className="font-pixel" style={{ fontSize: 12 }}>{t("battle.watch.cancelled")}</div>
          </div>
        )}
      </div>

      {/* On-chain audit trail — visible past WAITING.  Lets any
          spectator verify the VRF result was not picked by the relayer
          operator (Option A interim trust model).
          Only feed seed/winner/loser once DECIDED(2)/SETTLED(3): during
          ROLLING(1) battle.winner is Pubkey::default() → toBase58() is
          the truthy all-1s literal, which would render "winner: 1111…1111"
          and "seed: 0" in the panel (same class as the SEC-24 BR fix). */}
      {status >= 1 && (
        <BattleAuditPanel
          battleId={battleId}
          randomSeed={status === 2 || status === 3 ? battle.randomSeed?.toString?.() : null}
          winner={status === 2 || status === 3 ? battle.winner?.toBase58?.() : null}
          loser={status === 2 || status === 3 ? battle.loser?.toBase58?.() : null}
        />
      )}
    </div>
  );
}

// ============================================================
// Main export
// ============================================================

export default function BattlePage({ initialWatchId }: { initialWatchId?: number | null } = {}) {
  const { t } = useTranslation();
  const { connected } = useWallet();
  const [view, setView] = useState<View>(
    initialWatchId != null ? "watch" : "lobby"
  );
  const [watchId, setWatchId] = useState<number | null>(initialWatchId ?? null);

  // Open the requested battle when navigated via deep-link.
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
            {t("battle.title")}
          </h1>
        </div>
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 14 }}>
            {t("battle.connect")}
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
          {t("battle.title")}
        </h1>
      </div>

      {view === "lobby"  && (
        <Lobby
          onCreateBattle={() => setView("create")}
          onWatchBattle={(id) => { setWatchId(id); setView("watch"); }}
        />
      )}
      {view === "create" && <CreateBattle onBack={() => setView("lobby")} />}
      {view === "watch"  && watchId !== null && (
        <WatchBattle battleId={watchId} onBack={() => setView("lobby")} />
      )}
    </div>
  );
}
