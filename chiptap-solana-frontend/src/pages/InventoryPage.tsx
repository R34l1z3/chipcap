// Stub — implementation in next chunk.
import React from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useChipsByOwner } from "../hooks/useChipsByOwner";
import ChipCard from "../components/ChipCard";

export default function InventoryPage() {
  const { publicKey } = useWallet();
  const owner = publicKey?.toBase58();
  const { chips, loading } = useChipsByOwner(owner);

  if (!publicKey) {
    return (
      <div className="p-2 sm:p-4 max-w-3xl mx-auto">
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold" style={{ fontSize: 14 }}>
            CONNECT WALLET TO VIEW INVENTORY
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 sm:p-4 max-w-3xl mx-auto">
      <h1 className="font-pixel text-retro-cyan mb-4" style={{ fontSize: 14 }}>
        MY CHIPS [{chips.length}]
      </h1>

      {loading && chips.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="text-retro-cyan animate-blink">LOADING…</div>
        </div>
      ) : chips.length === 0 ? (
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-cyan mb-2" style={{ fontSize: 12 }}>
            NO CHIPS FOUND
          </div>
          <div className="text-sm opacity-60">Mint your first chip from MINT.</div>
        </div>
      ) : (
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-3">
          {chips.map((c) => (
            <ChipCard
              key={c.asset}
              tokenId={c.token_id}
              asset={c.asset}
              tier={c.tier}
                  progressionWins={c.progression_wins}
              battleCount={c.battle_count}
              winCount={c.win_count}
              size="sm"
            />
          ))}
        </div>
      )}

      <div className="text-xs opacity-40 mt-4 text-center">
        (approve / battle-arena escrow flows land in the next iteration)
      </div>
    </div>
  );
}
