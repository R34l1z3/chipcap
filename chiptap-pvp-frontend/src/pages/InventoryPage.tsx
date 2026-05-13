// ============================================================
// src/pages/InventoryPage.tsx — User's chip collection
// ============================================================

import React, { useEffect, useState } from "react";
import { useAccount, useChainId, useReadContract, useReadContracts, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { CHIP_NFT_ABI } from "../abi/contracts";
import { getContracts, RARITIES } from "../config";
import ChipCard from "../components/ChipCard";
import { notifyTxError } from "../services/notifications";

export default function InventoryPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const contracts = getContracts(chainId);
  const [selectedChip, setSelectedChip] = useState<number | null>(null);

  // Get token IDs owned
  const { data: tokenIds, isLoading, refetch } = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "tokensOfOwner",
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  });

  // Get chip data for all owned tokens
  const chipDataCalls = (tokenIds || []).map((id: bigint) => ({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "chipData" as const,
    args: [id],
  }));

  const { data: chipDataResults } = useReadContracts({
    contracts: chipDataCalls,
    query: { enabled: chipDataCalls.length > 0 },
  });

  // Check if approved for BattleArena
  const { data: isApprovedForAll } = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "isApprovedForAll",
    args: address ? [address, contracts.battleArena] : undefined,
    query: { enabled: !!address },
  });

  // Approve all for BattleArena
  const { writeContract: approveAll, data: approveTx, isPending: approving, error: approveError } = useWriteContract();
  const { isLoading: confirmingApprove, isSuccess: approveSuccess, error: approveConfirmError } = useWaitForTransactionReceipt({ hash: approveTx });

  useEffect(() => { if (approveError) notifyTxError("Approve", approveError); }, [approveError]);
  useEffect(() => { if (approveConfirmError) notifyTxError("Approve confirm", approveConfirmError); }, [approveConfirmError]);

  const handleApproveAll = () => {
    approveAll({
      address: contracts.chipNFT,
      abi: CHIP_NFT_ABI,
      functionName: "setApprovalForAll",
      args: [contracts.battleArena, true],
    });
  };

  // Parse chip data
  const chips = (tokenIds || []).map((id: bigint, i: number) => {
    const data = chipDataResults?.[i]?.result as [number, bigint, bigint, bigint] | undefined;
    return {
      tokenId: Number(id),
      rarity: data ? Number(data[0]) : 0,
      mintedAt: data ? Number(data[1]) : 0,
      battleCount: data ? Number(data[2]) : 0,
      winCount: data ? Number(data[3]) : 0,
    };
  });

  const selected = selectedChip !== null ? chips.find((c) => c.tokenId === selectedChip) : null;

  if (!isConnected) {
    return (
      <div className="flex items-center justify-center h-full p-8">
        <div className="retro-panel text-center">
          <div className="font-pixel text-retro-gold" style={{ fontSize: 14 }}>
            CONNECT WALLET TO VIEW INVENTORY
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
      {/* Title */}
      <div className="flex items-center justify-between mb-4">
        <h1 className="font-pixel text-retro-cyan" style={{ fontSize: 14 }}>
          MY CHIPS [{chips.length}]
        </h1>
        <button onClick={() => refetch()} className="retro-btn" style={{ fontSize: 9, padding: "4px 10px" }}>
          REFRESH
        </button>
      </div>

      {/* Approval banner */}
      {!isApprovedForAll && chips.length > 0 && (
        <div className="retro-panel mb-4" style={{ borderColor: "#FF8800" }}>
          <div className="flex items-center justify-between gap-4">
            <div>
              <div className="font-pixel text-retro-orange" style={{ fontSize: 10 }}>
                APPROVAL NEEDED
              </div>
              <div className="text-sm text-retro-cyan opacity-70 mt-1">
                Approve BattleArena to use your chips in battles.
                This is a one-time action.
              </div>
            </div>
            <button
              onClick={handleApproveAll}
              disabled={approving || confirmingApprove}
              className="retro-btn retro-btn-gold flex-shrink-0"
              style={{ fontSize: 9 }}
            >
              {approving ? "CONFIRM..." : confirmingApprove ? "APPROVING..." : "APPROVE ALL"}
            </button>
          </div>
          {approveSuccess && (
            <div className="text-retro-lime font-pixel mt-2" style={{ fontSize: 9 }}>
              APPROVED! You can now use chips in battles.
            </div>
          )}
        </div>
      )}

      {isLoading ? (
        <div className="retro-panel text-center py-8">
          <div className="text-retro-cyan animate-blink">LOADING INVENTORY...</div>
        </div>
      ) : chips.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 12 }}>
            NO CHIPS FOUND
          </div>
          <div className="text-sm opacity-60">
            Go to [+] MINT to create your first chip!
          </div>
        </div>
      ) : (
        <div className="flex flex-col sm:flex-row gap-4">
          {/* Chip grid */}
          <div className="flex-1 min-w-0">
            <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
              {chips.map((chip) => (
                <ChipCard
                  key={chip.tokenId}
                  tokenId={chip.tokenId}
                  rarity={chip.rarity}
                  battleCount={chip.battleCount}
                  winCount={chip.winCount}
                  selected={selectedChip === chip.tokenId}
                  onClick={() => setSelectedChip(selectedChip === chip.tokenId ? null : chip.tokenId)}
                  size="sm"
                />
              ))}
            </div>
          </div>

          {/* Detail panel — full width on mobile, sidebar on sm+ */}
          {selected && (
            <div className="retro-panel w-full sm:w-56 flex-shrink-0" style={{ borderColor: RARITIES[selected.rarity]?.color }}>
              <div className="font-pixel text-xs mb-3" style={{ fontSize: 10, color: RARITIES[selected.rarity]?.color }}>
                &gt; CHIP #{selected.tokenId}
              </div>

              <div className="flex justify-center mb-3">
                <ChipCard tokenId={selected.tokenId} rarity={selected.rarity} size="md" />
              </div>

              <table className="w-full text-sm">
                <tbody>
                  <tr>
                    <td className="py-1 opacity-60">Rarity:</td>
                    <td className="py-1 text-right" style={{ color: RARITIES[selected.rarity]?.color }}>
                      {RARITIES[selected.rarity]?.name}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1 opacity-60">Battles:</td>
                    <td className="py-1 text-right">{selected.battleCount}</td>
                  </tr>
                  <tr>
                    <td className="py-1 opacity-60">Wins:</td>
                    <td className="py-1 text-right text-retro-win">{selected.winCount}</td>
                  </tr>
                  <tr>
                    <td className="py-1 opacity-60">Losses:</td>
                    <td className="py-1 text-right text-retro-lose">{selected.battleCount - selected.winCount}</td>
                  </tr>
                  <tr>
                    <td className="py-1 opacity-60">Win %:</td>
                    <td className="py-1 text-right text-retro-gold">
                      {selected.battleCount > 0
                        ? Math.round((selected.winCount / selected.battleCount) * 100) + "%"
                        : "N/A"}
                    </td>
                  </tr>
                  <tr>
                    <td className="py-1 opacity-60">Minted:</td>
                    <td className="py-1 text-right text-xs opacity-50">
                      {selected.mintedAt > 0
                        ? new Date(selected.mintedAt * 1000).toLocaleDateString()
                        : "..."}
                    </td>
                  </tr>
                </tbody>
              </table>

              {isApprovedForAll && (
                <div className="mt-3 text-center">
                  <div className="text-xs text-retro-lime opacity-60 mb-1">Ready for battle</div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Stats footer */}
      {chips.length > 0 && (
        <div className="retro-panel mt-4">
          <div className="flex justify-around text-center">
            <div>
              <div className="text-retro-gold font-pixel" style={{ fontSize: 16 }}>{chips.length}</div>
              <div className="text-xs opacity-50">TOTAL</div>
            </div>
            {RARITIES.map((rar) => {
              const count = chips.filter((c) => c.rarity === rar.id).length;
              if (count === 0) return null;
              return (
                <div key={rar.id}>
                  <div className="font-pixel" style={{ fontSize: 16, color: rar.color }}>{count}</div>
                  <div className="text-xs opacity-50">{rar.name.toUpperCase()}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
