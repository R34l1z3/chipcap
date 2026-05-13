// ============================================================
// src/pages/BattlePage.tsx — Battle Arena UI (v2)
//
// Updates for BattleArena v2 security fixes:
// - WithdrawBanner: shows pendingWithdrawals balance, withdraw button
// - claimWinnerChip: winner claims chip separately from VRF callback
// - forceResolve: VRF timeout rescue for stuck ROLLING battles
// ============================================================

import React, { useState, useEffect } from "react";
import {
  useAccount,
  useChainId,
  useReadContract,
  useReadContracts,
  useWriteContract,
  useWaitForTransactionReceipt,
} from "wagmi";
import { formatEther } from "viem";
import { BATTLE_ARENA_ABI, CHIP_NFT_ABI } from "../abi/contracts";
import { getContracts, POOL_TIERS, BATTLE_STATUS } from "../config";
import { useIndexerBattles as useBattles } from "../hooks/useIndexerBattles";
import ChipCard from "../components/ChipCard";
import { notifyTxError } from "../services/notifications";

type View = "lobby" | "create" | "watch";
const ZERO = "0x0000000000000000000000000000000000000000";

// ============================================================
// WithdrawBanner — appears when player has pending winnings
// ============================================================
function WithdrawBanner() {
  const { address } = useAccount();
  const chainId = useChainId();
  const contracts = getContracts(chainId);

  const { data: pending, refetch } = useReadContract({
    address: contracts.battleArena,
    abi: BATTLE_ARENA_ABI,
    functionName: "pendingWithdrawals",
    args: address ? [address] : undefined,
    query: { enabled: !!address, refetchInterval: 10000 },
  });

  const { writeContract: withdraw, data: wdTx, isPending, error: withdrawError } = useWriteContract();
  const { isLoading: confirming, isSuccess, error: withdrawConfirmError } = useWaitForTransactionReceipt({ hash: wdTx });

  useEffect(() => { if (isSuccess) refetch(); }, [isSuccess, refetch]);
  useEffect(() => { if (withdrawError) notifyTxError("Withdraw", withdrawError); }, [withdrawError]);
  useEffect(() => { if (withdrawConfirmError) notifyTxError("Withdraw confirm", withdrawConfirmError); }, [withdrawConfirmError]);

  const amount = (pending as bigint | undefined) ?? 0n;
  if (amount === 0n) return null;

  return (
    <div className="retro-panel mb-4" style={{ borderColor: "#00FF88", background: "#002211" }}>
      <div className="flex items-center justify-between">
        <div>
          <div className="font-pixel text-retro-win" style={{ fontSize: 10 }}>
            *** WINNINGS AVAILABLE ***
          </div>
          <div className="text-retro-gold font-pixel mt-2" style={{ fontSize: 16 }}>
            {formatEther(amount)} POL
          </div>
          <div className="text-xs opacity-60 mt-1">
            Claim your battle earnings. Pull-payment — safer than direct transfer.
          </div>
        </div>
        <button
          onClick={() => withdraw({
            address: contracts.battleArena,
            abi: BATTLE_ARENA_ABI,
            functionName: "withdrawWinnings",
          })}
          disabled={isPending || confirming}
          className="retro-btn retro-btn-gold py-3 px-5"
          style={{ fontSize: 10 }}
        >
          {isPending ? "CONFIRM..." : confirming ? "WITHDRAWING..." : "WITHDRAW NOW"}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// LOBBY
// ============================================================
function Lobby({
  onCreateBattle,
  onWatchBattle,
}: {
  onCreateBattle: () => void;
  onWatchBattle: (id: number) => void;
}) {
  const { address } = useAccount();
  const { openBattles, rollingBattles, myActiveBattles, loading, refetch } = useBattles();
  const chainId = useChainId();
  const contracts = getContracts(chainId);

  const [joining, setJoining] = useState<number | null>(null);
  const [selectedChip, setSelectedChip] = useState<number | null>(null);

  const { data: tokenIds } = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "tokensOfOwner",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const { writeContract: joinBattle, data: joinTx, isPending: joinPending, error: joinError } = useWriteContract();
  const { isLoading: joinConfirming, isSuccess: joinSuccess, error: joinConfirmError } = useWaitForTransactionReceipt({ hash: joinTx });
  const { writeContract: cancelBattle, isPending: cancelPending, error: cancelError } = useWriteContract();

  useEffect(() => {
    if (joinSuccess) { setJoining(null); setSelectedChip(null); refetch(); }
  }, [joinSuccess, refetch]);
  useEffect(() => { if (joinError) notifyTxError("Join", joinError); }, [joinError]);
  useEffect(() => { if (joinConfirmError) notifyTxError("Join confirm", joinConfirmError); }, [joinConfirmError]);
  useEffect(() => { if (cancelError) notifyTxError("Cancel", cancelError); }, [cancelError]);

  const handleJoin = (battleId: number) => {
    if (selectedChip === null) return;
    joinBattle({
      address: contracts.battleArena,
      abi: BATTLE_ARENA_ABI,
      functionName: "joinBattle",
      args: [BigInt(battleId), BigInt(selectedChip)],
    });
  };

  const handleCancel = (battleId: number) => {
    cancelBattle({
      address: contracts.battleArena,
      abi: BATTLE_ARENA_ABI,
      functionName: "cancelBattle",
      args: [BigInt(battleId)],
    });
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
        <h2 className="font-pixel text-retro-cyan" style={{ fontSize: 12 }}>&gt; BATTLE LOBBY</h2>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => refetch()} className="retro-btn" style={{ fontSize: 8, padding: "4px 8px" }}>
            REFRESH
          </button>
          <button onClick={onCreateBattle} className="retro-btn retro-btn-gold" style={{ fontSize: 8, padding: "4px 8px" }}>
            <span className="hidden sm:inline">+ CREATE BATTLE</span>
            <span className="sm:hidden">+ CREATE</span>
          </button>
        </div>
      </div>

      {/* Withdraw banner — visible whenever player has pending funds */}
      <WithdrawBanner />

      {/* My active battles */}
      {myActiveBattles.length > 0 && (
        <div className="mb-4">
          <div className="font-pixel text-retro-gold mb-2" style={{ fontSize: 9 }}>YOUR ACTIVE BATTLES:</div>
          {myActiveBattles.map((b) => {
            const needsAction = b.status === 2 && b.loser?.toLowerCase() === address?.toLowerCase();
            const canClaim = b.status === 2 && b.winner?.toLowerCase() === address?.toLowerCase();
            return (
              <div
                key={b.id}
                className="retro-panel mb-2 cursor-pointer"
                style={{ borderColor: b.status === 2 ? "#FF3333" : b.status === 1 ? "#FF00FF" : "#FFD700" }}
                onClick={() => onWatchBattle(b.id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-pixel text-retro-gold" style={{ fontSize: 10 }}>BATTLE #{b.id}</span>
                    <span className="ml-2 text-sm opacity-60">{b.poolLabel} pool</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-pixel px-2 py-0.5" style={{
                      fontSize: 8,
                      color: b.status === 0 ? "#00FFFF" : b.status === 1 ? "#FF00FF" : b.status === 2 ? "#FF3333" : "#aaa",
                      border: "1px solid currentColor",
                    }}>
                      {BATTLE_STATUS[b.status as keyof typeof BATTLE_STATUS]}
                    </span>
                    {needsAction && (
                      <span className="font-pixel text-retro-red animate-blink" style={{ fontSize: 8 }}>PAY OR FORFEIT</span>
                    )}
                    {canClaim && (
                      <span className="font-pixel text-retro-win" style={{ fontSize: 8 }}>CLAIM CHIP</span>
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
        OPEN BATTLES ({openBattles.length}):
      </div>

      {loading && openBattles.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-retro-cyan animate-blink">SCANNING BLOCKCHAIN...</div>
        </div>
      ) : openBattles.length === 0 ? (
        <div className="retro-panel text-center py-6">
          <div className="text-sm opacity-60">No open battles. Be the first!</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {openBattles.map((b) => {
            const isOwn = b.playerA.toLowerCase() === address?.toLowerCase();
            const isJoining = joining === b.id;
            return (
              <div key={b.id} className="retro-panel">
                <div className="flex items-start sm:items-center justify-between gap-2 mb-2 flex-wrap">
                  <div className="flex items-center gap-2 sm:gap-3 flex-wrap min-w-0">
                    <span className="font-pixel text-retro-cyan" style={{ fontSize: 10 }}>#{b.id}</span>
                    <span className="text-retro-gold font-pixel" style={{ fontSize: 12 }}>{b.poolLabel}</span>
                    <span className="text-xs opacity-50 truncate">by {b.playerA.slice(0, 6)}...{b.playerA.slice(-4)}</span>
                  </div>
                  {isOwn ? (
                    <button onClick={() => handleCancel(b.id)} disabled={cancelPending}
                      className="retro-btn retro-btn-red" style={{ fontSize: 8, padding: "3px 8px" }}>
                      CANCEL
                    </button>
                  ) : isJoining ? (
                    <div className="flex items-center gap-2 flex-wrap">
                      <select
                        className="retro-input text-sm py-1"
                        style={{ fontSize: 14, maxWidth: 160 }}
                        value={selectedChip ?? ""}
                        onChange={(e) => setSelectedChip(e.target.value ? Number(e.target.value) : null)}
                      >
                        <option value="">Pick chip</option>
                        {(tokenIds as bigint[] || []).map((id) => (
                          <option key={Number(id)} value={Number(id)}>Chip #{Number(id)}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleJoin(b.id)}
                        disabled={selectedChip === null || joinPending || joinConfirming}
                        className="retro-btn retro-btn-gold"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >
                        {joinPending ? "CONFIRM..." : joinConfirming ? "JOINING..." : "FIGHT!"}
                      </button>
                      <button
                        onClick={() => { setJoining(null); setSelectedChip(null); }}
                        className="retro-btn"
                        style={{ fontSize: 8, padding: "3px 8px" }}
                      >X</button>
                    </div>
                  ) : (
                    <button onClick={() => setJoining(b.id)} className="retro-btn retro-btn-gold"
                      style={{ fontSize: 8, padding: "3px 8px" }}>
                      JOIN
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2 text-xs opacity-50">
                  <span>Chip #{b.chipA}</span><span>|</span>
                  <span>{Math.floor((Date.now() / 1000 - b.createdAt) / 60)}m ago</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Rolling battles (awaiting VRF) */}
      {rollingBattles.length > 0 && (
        <div className="mt-4">
          <div className="font-pixel text-retro-magenta mb-2" style={{ fontSize: 9 }}>
            ROLLING ({rollingBattles.length}):
          </div>
          {rollingBattles.map((b) => (
            <div
              key={b.id}
              className="retro-panel mb-2 cursor-pointer"
              style={{ borderColor: "#FF00FF" }}
              onClick={() => onWatchBattle(b.id)}
            >
              <div className="flex items-center justify-between">
                <span className="font-pixel" style={{ fontSize: 10, color: "#FF00FF" }}>#{b.id} — {b.poolLabel}</span>
                <span className="animate-blink text-retro-magenta" style={{ fontSize: 12 }}>WAITING FOR VRF...</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ============================================================
// CREATE BATTLE
// ============================================================
function CreateBattle({ onBack }: { onBack: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const contracts = getContracts(chainId);
  const [selectedChip, setSelectedChip] = useState<number | null>(null);
  const [selectedPool, setSelectedPool] = useState(2);

  const { data: tokenIds } = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "tokensOfOwner",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  const chipDataCalls = ((tokenIds as bigint[]) || []).map((id) => ({
    address: contracts.chipNFT as `0x${string}`,
    abi: CHIP_NFT_ABI,
    functionName: "chipData" as const,
    args: [id],
  }));

  const { data: chipDataResults } = useReadContracts({
    contracts: chipDataCalls,
    query: { enabled: chipDataCalls.length > 0 },
  });

  const chips = ((tokenIds as bigint[]) || []).map((id, i) => {
    const d = chipDataResults?.[i]?.result as [number, bigint, bigint, bigint] | undefined;
    return {
      tokenId: Number(id),
      rarity: d ? Number(d[0]) : 0,
      battleCount: d ? Number(d[2]) : 0,
      winCount: d ? Number(d[3]) : 0,
    };
  });

  const { writeContract: createBattle, data: createTx, isPending, error: createError } = useWriteContract();
  const { isLoading: confirming, isSuccess, error: createConfirmError } = useWaitForTransactionReceipt({ hash: createTx });

  useEffect(() => { if (isSuccess) onBack(); }, [isSuccess, onBack]);
  useEffect(() => { if (createError) notifyTxError("Create battle", createError); }, [createError]);
  useEffect(() => { if (createConfirmError) notifyTxError("Create confirm", createConfirmError); }, [createConfirmError]);

  return (
    <div>
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>
        &lt; BACK TO LOBBY
      </button>
      <div className="retro-panel mb-4">
        <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 11 }}>&gt; CREATE NEW BATTLE</div>

        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>1. SELECT POOL:</div>
          <div className="flex gap-2 flex-wrap">
            {POOL_TIERS.map((p) => (
              <button
                key={p.id}
                onClick={() => setSelectedPool(p.id)}
                className="retro-btn"
                style={{
                  fontSize: 10,
                  padding: "6px 14px",
                  borderColor: selectedPool === p.id ? "#FFD700" : "#4a4a8a",
                  color: selectedPool === p.id ? "#FFD700" : "#4a4a8a",
                  textShadow: selectedPool === p.id ? "0 0 10px #FFD700" : "none",
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
          <div className="text-xs opacity-50 mt-1">
            If you lose: pay {POOL_TIERS[selectedPool].label} to keep chip, or forfeit chip
          </div>
        </div>

        <div className="mb-4">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 9 }}>2. SELECT YOUR CHIP:</div>
          {chips.length === 0 ? (
            <div className="text-sm opacity-50">No chips. Go to MINT first!</div>
          ) : (
            <div className="grid grid-cols-4 sm:grid-cols-5 gap-2">
              {chips.map((c) => (
                <ChipCard
                  key={c.tokenId}
                  tokenId={c.tokenId}
                  rarity={c.rarity}
                  battleCount={c.battleCount}
                  winCount={c.winCount}
                  selected={selectedChip === c.tokenId}
                  onClick={() => setSelectedChip(selectedChip === c.tokenId ? null : c.tokenId)}
                  size="sm"
                />
              ))}
            </div>
          )}
        </div>

        <button
          onClick={() =>
            selectedChip !== null &&
            createBattle({
              address: contracts.battleArena,
              abi: BATTLE_ARENA_ABI,
              functionName: "createBattle",
              args: [BigInt(selectedChip), selectedPool],
            })
          }
          disabled={selectedChip === null || isPending || confirming}
          className="retro-btn retro-btn-gold w-full py-3 font-pixel"
          style={{ fontSize: 12 }}
        >
          {isPending ? ">> CONFIRM IN WALLET..." :
           confirming ? ">> CREATING BATTLE..." :
           `>> CREATE ${POOL_TIERS[selectedPool].label} BATTLE WITH CHIP #${selectedChip ?? "?"} <<`}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// WATCH BATTLE — live view with v2 actions
// ============================================================
function WatchBattle({ battleId, onBack }: { battleId: number; onBack: () => void }) {
  const { address } = useAccount();
  const chainId = useChainId();
  const contracts = getContracts(chainId);

  const { data: battleRaw, refetch } = useReadContract({
    address: contracts.battleArena,
    abi: BATTLE_ARENA_ABI,
    functionName: "getBattle",
    args: [BigInt(battleId)],
    query: { refetchInterval: 3000 },
  });

  const { data: ransomAmount } = useReadContract({
    address: contracts.battleArena,
    abi: BATTLE_ARENA_ABI,
    functionName: "getRansomAmount",
    args: [BigInt(battleId)],
    query: { enabled: !!battleRaw },
  });

  const { data: deadline } = useReadContract({
    address: contracts.battleArena,
    abi: BATTLE_ARENA_ABI,
    functionName: "getDecisionDeadline",
    args: [BigInt(battleId)],
  });

  const { data: vrfDeadline } = useReadContract({
    address: contracts.battleArena,
    abi: BATTLE_ARENA_ABI,
    functionName: "getVrfDeadline",
    args: [BigInt(battleId)],
  });

  // Fetch rarities for both chips (fixes hardcoded rarity=0 bug)
  const chipARarity = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "chipData",
    args: battleRaw ? [(battleRaw as any).chipA] : undefined,
    query: { enabled: !!battleRaw },
  });
  const chipBRarity = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "chipData",
    args: battleRaw && (battleRaw as any).chipB > 0n ? [(battleRaw as any).chipB] : undefined,
    query: { enabled: !!battleRaw && !!(battleRaw as any).playerB && (battleRaw as any).playerB !== ZERO },
  });

  // Actions
  const { writeContract: claimChip, data: claimTx, isPending: claimPending, error: claimError } = useWriteContract();
  const { isLoading: claimConfirming, isSuccess: claimSuccess, error: claimConfirmError } = useWaitForTransactionReceipt({ hash: claimTx });

  const { writeContract: payRansom, data: payTx, isPending: payPending, error: payError } = useWriteContract();
  const { isLoading: payConfirming, isSuccess: paySuccess, error: payConfirmError } = useWaitForTransactionReceipt({ hash: payTx });

  const { writeContract: forfeitChip, data: forfeitTx, isPending: forfeitPending, error: forfeitError } = useWriteContract();
  const { isLoading: forfeitConfirming, isSuccess: forfeitSuccess, error: forfeitConfirmError } = useWaitForTransactionReceipt({ hash: forfeitTx });

  const { writeContract: forceResolve, data: forceTx, isPending: forcePending, error: forceError } = useWriteContract();
  const { isLoading: forceConfirming, isSuccess: forceSuccess, error: forceConfirmError } = useWaitForTransactionReceipt({ hash: forceTx });

  useEffect(() => {
    if (paySuccess || forfeitSuccess || claimSuccess || forceSuccess) refetch();
  }, [paySuccess, forfeitSuccess, claimSuccess, forceSuccess, refetch]);

  useEffect(() => { if (claimError) notifyTxError("Claim", claimError); }, [claimError]);
  useEffect(() => { if (claimConfirmError) notifyTxError("Claim confirm", claimConfirmError); }, [claimConfirmError]);
  useEffect(() => { if (payError) notifyTxError("Pay ransom", payError); }, [payError]);
  useEffect(() => { if (payConfirmError) notifyTxError("Pay confirm", payConfirmError); }, [payConfirmError]);
  useEffect(() => { if (forfeitError) notifyTxError("Forfeit", forfeitError); }, [forfeitError]);
  useEffect(() => { if (forfeitConfirmError) notifyTxError("Forfeit confirm", forfeitConfirmError); }, [forfeitConfirmError]);
  useEffect(() => { if (forceError) notifyTxError("Force resolve", forceError); }, [forceError]);
  useEffect(() => { if (forceConfirmError) notifyTxError("Force confirm", forceConfirmError); }, [forceConfirmError]);

  // Countdown timers
  const [timeLeft, setTimeLeft] = useState("");
  const [vrfTimeLeft, setVrfTimeLeft] = useState("");

  useEffect(() => {
    if (!deadline || Number(deadline) === 0) return;
    const interval = setInterval(() => {
      const left = Number(deadline) - Math.floor(Date.now() / 1000);
      if (left <= 0) { setTimeLeft("EXPIRED"); clearInterval(interval); return; }
      setTimeLeft(`${Math.floor(left / 3600)}h ${Math.floor((left % 3600) / 60)}m ${left % 60}s`);
    }, 1000);
    return () => clearInterval(interval);
  }, [deadline]);

  useEffect(() => {
    if (!vrfDeadline || Number(vrfDeadline) === 0) return;
    const interval = setInterval(() => {
      const left = Number(vrfDeadline) - Math.floor(Date.now() / 1000);
      if (left <= 0) { setVrfTimeLeft("TIMED OUT"); clearInterval(interval); return; }
      setVrfTimeLeft(`${Math.floor(left / 60)}m ${left % 60}s`);
    }, 1000);
    return () => clearInterval(interval);
  }, [vrfDeadline]);

  if (!battleRaw) {
    return (
      <div>
        <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>
          &lt; BACK
        </button>
        <div className="retro-panel text-center py-8">
          <div className="animate-blink text-retro-cyan">LOADING BATTLE #{battleId}...</div>
        </div>
      </div>
    );
  }

  const b = battleRaw as any;
  const status = Number(b.status);
  const isPlayerA = address?.toLowerCase() === b.playerA.toLowerCase();
  const isPlayerB = address?.toLowerCase() === b.playerB?.toLowerCase();
  const isWinner = address?.toLowerCase() === b.winner?.toLowerCase();
  const isLoser = address?.toLowerCase() === b.loser?.toLowerCase();
  const poolLabel = POOL_TIERS[Number(b.poolTier)]?.label || "?";

  const chipARar = chipARarity.data ? Number((chipARarity.data as any)[0]) : 0;
  const chipBRar = chipBRarity.data ? Number((chipBRarity.data as any)[0]) : 0;

  return (
    <div>
      <button onClick={onBack} className="retro-btn mb-4" style={{ fontSize: 8, padding: "3px 8px" }}>
        &lt; BACK TO LOBBY
      </button>

      <div className="retro-panel" style={{
        borderColor: status === 2 ? "#FF3333" : status === 1 ? "#FF00FF" : "#4a4a8a",
      }}>
        {/* Header */}
        <div className="text-center mb-4">
          <div className="font-pixel text-retro-gold" style={{ fontSize: 14 }}>BATTLE #{battleId}</div>
          <div className="text-sm">{poolLabel} POOL</div>
          <div
            className="font-pixel mt-1 inline-block px-3 py-0.5"
            style={{
              fontSize: 9,
              color:
                status === 0 ? "#00FFFF" :
                status === 1 ? "#FF00FF" :
                status === 2 ? "#FF3333" :
                status === 3 ? "#00FF00" : "#666",
              border: "1px solid currentColor",
            }}
          >
            {BATTLE_STATUS[status as keyof typeof BATTLE_STATUS]}
          </div>
        </div>

        {/* VS Layout */}
        <div className="flex items-center justify-center gap-2 sm:gap-4 mb-4">
          <div className="text-center min-w-0">
            <div className="font-pixel mb-1 truncate" style={{ fontSize: 8, color: isPlayerA ? "#FFD700" : "#00FFFF" }}>
              {isPlayerA ? "YOU" : b.playerA.slice(0, 6) + "..."}
            </div>
            <ChipCard tokenId={Number(b.chipA)} rarity={chipARar} size="md" />
          </div>

          <div className="flex flex-col items-center flex-shrink-0">
            <div className="font-pixel animate-glow" style={{
              fontSize: 20,
              color: status === 1 ? "#FF00FF" : status === 2 ? "#FFD700" : "#4a4a8a",
            }}>VS</div>
            {status === 1 && (
              <div className="animate-blink text-retro-magenta mt-1 text-center" style={{ fontSize: 11 }}>ROLLING...</div>
            )}
          </div>

          <div className="text-center min-w-0">
            <div className="font-pixel mb-1 truncate" style={{ fontSize: 8, color: isPlayerB ? "#FFD700" : "#00FFFF" }}>
              {b.playerB === ZERO ? "???" : isPlayerB ? "YOU" : b.playerB.slice(0, 6) + "..."}
            </div>
            {b.playerB !== ZERO ? (
              <ChipCard tokenId={Number(b.chipB)} rarity={chipBRar} size="md" />
            ) : (
              <div className="w-32 h-36 flex items-center justify-center" style={{ border: "2px dashed #4a4a8a" }}>
                <span className="text-retro-cyan opacity-30 animate-blink" style={{ fontSize: 12 }}>?</span>
              </div>
            )}
          </div>
        </div>

        {/* ROLLING — VRF animation + timeout warning */}
        {status === 1 && (
          <div className="text-center py-4">
            <pre className="text-retro-magenta inline-block animate-pulse" style={{ fontSize: 14 }}>
{`  .-""-.
 /      \\
|  O  O  |  CHAINLINK VRF
|  .--.  |  GENERATING...
 \\      /
  '-..-'`}
            </pre>
            <div className="text-xs opacity-50 mt-2">Waiting for provably fair randomness...</div>
            {vrfTimeLeft && (
              <div className="mt-3 text-xs">
                VRF timeout: <span className={`font-pixel ${vrfTimeLeft === "TIMED OUT" ? "text-retro-red" : "text-retro-cyan"}`}
                  style={{ fontSize: 11 }}>{vrfTimeLeft}</span>
              </div>
            )}
            {vrfTimeLeft === "TIMED OUT" && (isPlayerA || isPlayerB) && (
              <button
                onClick={() => forceResolve({
                  address: contracts.battleArena,
                  abi: BATTLE_ARENA_ABI,
                  functionName: "forceResolve",
                  args: [BigInt(battleId)],
                })}
                disabled={forcePending || forceConfirming}
                className="retro-btn retro-btn-red mt-3 px-4 py-2"
                style={{ fontSize: 9 }}
              >
                {forcePending ? "CONFIRM..." :
                 forceConfirming ? "RESOLVING..." :
                 "FORCE RESOLVE — REFUND BOTH CHIPS"}
              </button>
            )}
          </div>
        )}

        {/* DECIDED — winner claim + loser choice */}
        {status === 2 && (
          <div>
            <div
              className="text-center py-3 mb-4 font-pixel"
              style={{
                fontSize: 14,
                background: isWinner ? "#003300" : isLoser ? "#330000" : "#1a1a4e",
                border: `2px solid ${isWinner ? "#00FF00" : isLoser ? "#FF0000" : "#4a4a8a"}`,
                color: isWinner ? "#00FF88" : isLoser ? "#FF4444" : "#FFD700",
                textShadow: `0 0 15px currentColor`,
              }}
            >
              {isWinner ? "*** YOU WON! ***" :
               isLoser ? "*** YOU LOST ***" :
               `WINNER: ${b.winner.slice(0, 8)}...`}
            </div>

            {timeLeft && (
              <div className="text-center mb-3 text-sm">
                Decision deadline: <span className="text-retro-gold font-pixel" style={{ fontSize: 12 }}>{timeLeft}</span>
              </div>
            )}

            {/* Winner: claim chip button */}
            {isWinner && (
              <div className="retro-panel mb-3" style={{ borderColor: "#00FF00", background: "#001a11" }}>
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-retro-win font-pixel" style={{ fontSize: 10 }}>CLAIM YOUR CHIP</div>
                    <div className="text-xs opacity-60 mt-1">Your chip is in escrow — claim it back anytime.</div>
                  </div>
                  <button
                    onClick={() => claimChip({
                      address: contracts.battleArena,
                      abi: BATTLE_ARENA_ABI,
                      functionName: "claimWinnerChip",
                      args: [BigInt(battleId)],
                    })}
                    disabled={claimPending || claimConfirming}
                    className="retro-btn retro-btn-gold px-4"
                    style={{ fontSize: 9 }}
                  >
                    {claimPending ? "CONFIRM..." :
                     claimConfirming ? "CLAIMING..." :
                     claimSuccess ? "CLAIMED!" :
                     "CLAIM CHIP"}
                  </button>
                </div>
                <div className="text-xs opacity-40 mt-2">
                  Waiting for loser to pay ransom or forfeit... ({timeLeft || "..."})
                </div>
              </div>
            )}

            {/* Loser's choice */}
            {isLoser && (
              <div className="retro-panel" style={{ borderColor: "#FF3333" }}>
                <div className="font-pixel text-retro-red text-center mb-3" style={{ fontSize: 10 }}>
                  CHOOSE YOUR FATE:
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    onClick={() => payRansom({
                      address: contracts.battleArena,
                      abi: BATTLE_ARENA_ABI,
                      functionName: "payRansom",
                      args: [BigInt(battleId)],
                      value: (ransomAmount as bigint | undefined) ?? 0n,
                    })}
                    disabled={payPending || payConfirming || !ransomAmount}
                    className="retro-btn retro-btn-gold py-4"
                    style={{ fontSize: 9 }}
                  >
                    <div>PAY TO KEEP CHIP</div>
                    <div className="mt-1 text-xs opacity-70">
                      {ransomAmount ? formatEther(ransomAmount as bigint) : "..."} POL
                    </div>
                    <div className="mt-1 text-xs opacity-50">({poolLabel} — 95% to winner)</div>
                    {payPending && <div className="mt-1 animate-blink">CONFIRM...</div>}
                    {payConfirming && <div className="mt-1 animate-blink">PAYING...</div>}
                  </button>

                  <button
                    onClick={() => forfeitChip({
                      address: contracts.battleArena,
                      abi: BATTLE_ARENA_ABI,
                      functionName: "forfeitChip",
                      args: [BigInt(battleId)],
                    })}
                    disabled={forfeitPending || forfeitConfirming}
                    className="retro-btn retro-btn-red py-4"
                    style={{ fontSize: 9 }}
                  >
                    <div>FORFEIT CHIP</div>
                    <div className="mt-1 text-xs opacity-70">Chip goes to winner</div>
                    <div className="mt-1 text-xs opacity-50">No payment needed</div>
                    {forfeitPending && <div className="mt-1 animate-blink">CONFIRM...</div>}
                    {forfeitConfirming && <div className="mt-1 animate-blink">FORFEITING...</div>}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* SETTLED */}
        {status === 3 && (
          <div className="text-center py-4">
            <div
              className="font-pixel mb-3"
              style={{
                fontSize: 16,
                color: isWinner ? "#00FF88" : isLoser ? "#FF4444" : "#FFD700",
                textShadow: `0 0 20px currentColor`,
              }}
            >
              {isWinner ? "VICTORY!" : isLoser ? "DEFEAT" : "BATTLE COMPLETE"}
            </div>
            <div className="retro-panel inline-block mx-auto text-left">
              <table className="text-sm">
                <tbody>
                  <tr>
                    <td className="pr-4 py-1 opacity-60">Winner:</td>
                    <td className="py-1 text-retro-win">
                      {b.winner.toLowerCase() === address?.toLowerCase() ? "You" : b.winner.slice(0, 8) + "..."}
                    </td>
                  </tr>
                  <tr>
                    <td className="pr-4 py-1 opacity-60">Resolution:</td>
                    <td className="py-1">
                      {Number(b.resolution) === 1 ? (
                        <span className="text-retro-gold">PAID {formatEther(b.paymentAmount)} POL</span>
                      ) : Number(b.resolution) === 2 ? (
                        <span className="text-retro-red">CHIP FORFEITED</span>
                      ) : (
                        <span className="opacity-60">EXPIRED</span>
                      )}
                    </td>
                  </tr>
                  {Number(b.resolution) === 1 && (
                    <tr>
                      <td className="pr-4 py-1 opacity-60">Fee:</td>
                      <td className="py-1 opacity-50">{formatEther(b.feeAmount)} POL</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* CANCELLED */}
        {status === 4 && (
          <div className="text-center py-4 opacity-50">
            <div className="font-pixel" style={{ fontSize: 12 }}>BATTLE CANCELLED</div>
            <div className="text-sm mt-1">Chips returned to owners.</div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================
// MAIN EXPORT
// ============================================================
export default function BattlePage() {
  const [view, setView] = useState<View>("lobby");
  const [watchBattleId, setWatchBattleId] = useState<number | null>(null);

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
      <div className="text-center mb-4">
        <h1 className="font-pixel text-retro-magenta animate-glow" style={{ fontSize: 18 }}>
          BATTLE ARENA
        </h1>
      </div>

      {view === "lobby" && (
        <Lobby
          onCreateBattle={() => setView("create")}
          onWatchBattle={(id) => { setWatchBattleId(id); setView("watch"); }}
        />
      )}
      {view === "create" && <CreateBattle onBack={() => setView("lobby")} />}
      {view === "watch" && watchBattleId !== null && (
        <WatchBattle battleId={watchBattleId} onBack={() => setView("lobby")} />
      )}
    </div>
  );
}
