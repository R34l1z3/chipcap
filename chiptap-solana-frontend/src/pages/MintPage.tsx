// ============================================================
// src/pages/MintPage.tsx — real mint flow
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { useChipNftProgram } from "../hooks/useChipNftProgram";
import { useChipsByOwner } from "../hooks/useChipsByOwner";
import { notify, notifyTxError } from "../lib/notifications";
import * as pda from "../lib/pda";
import { MPL_CORE_PROGRAM } from "../lib/mpl";
import { RARITIES, DEFAULT_MINT_PRICE_SOL } from "../config";
import { fmtSol } from "../lib/format";
import ChipCard from "../components/ChipCard";

interface ChipNftConfigView {
  mintEnabled: boolean;
  nextTokenId: bigint;
  mintPrice:   number[];   // SOL
  maxSupply:   number[];
  mintedCount: number[];
}

function METADATA_URI(rarity: number) {
  // Placeholder.  Replace with `ipfs://CID/<token>.json` once the
  // chiptap-nft-metadata project's outputs are pinned to IPFS.
  return `https://chiptap.gg/metadata/rarity-${rarity}.json`;
}

export default function MintPage() {
  const { connected, publicKey } = useWallet();
  const program = useChipNftProgram();
  const owner   = publicKey?.toBase58();
  const { refetch: refetchChips } = useChipsByOwner(owner);

  const [selectedRarity, setSelectedRarity] = useState(0);
  const [pending, setPending] = useState(false);
  const [cfg,     setCfg]     = useState<ChipNftConfigView | null>(null);
  const [cfgErr,  setCfgErr]  = useState<string | null>(null);

  const fetchCfg = useCallback(async () => {
    if (!program) return;
    setCfgErr(null);
    try {
      const acc = await (program.account as any).chipNftConfig.fetchNullable(pda.chipNftConfig());
      if (!acc) {
        setCfgErr("chip-nft program not initialised on this cluster yet");
        return;
      }
      setCfg({
        mintEnabled: acc.mintEnabled,
        nextTokenId: BigInt(acc.nextTokenId.toString()),
        mintPrice:   (acc.mintPrice as any[]).map((p) => Number(p) / 1_000_000_000),
        maxSupply:   (acc.maxSupply as any[]).map((m) => Number(m)),
        mintedCount: (acc.mintedCount as any[]).map((m) => Number(m)),
      });
    } catch (e) {
      setCfgErr((e as Error).message);
    }
  }, [program]);

  useEffect(() => { fetchCfg(); }, [fetchCfg]);

  const r = RARITIES[selectedRarity];
  const priceSol = cfg?.mintPrice[selectedRarity] ?? DEFAULT_MINT_PRICE_SOL[selectedRarity];
  const minted   = cfg?.mintedCount[selectedRarity] ?? 0;
  const cap      = cfg?.maxSupply[selectedRarity]   ?? 0;
  const capLabel = cap > 0 ? `${minted} / ${cap}` : `${minted} / ∞`;

  const handleMint = useCallback(async () => {
    if (!program || !publicKey) return;
    setPending(true);
    try {
      const asset = Keypair.generate();
      const name  = "ChipTap";
      const uri   = METADATA_URI(selectedRarity);

      const sig = await (program.methods as any)
        .mintChip(selectedRarity, name, uri)
        .accounts({
          config:    pda.chipNftConfig(),
          vault:     pda.chipNftVault(),
          asset:     asset.publicKey,
          chipData:  pda.chipData(asset.publicKey),
          payer:     publicKey,
          mplCore:   MPL_CORE_PROGRAM,
          systemProgram: SystemProgram.programId,
        })
        .signers([asset])
        .rpc();

      notify("info", `Minted ${r.name}! ${sig.slice(0, 8)}…`);
      await Promise.all([fetchCfg(), refetchChips()]);
    } catch (e) {
      notifyTxError("Mint", e);
    } finally {
      setPending(false);
    }
  }, [program, publicKey, selectedRarity, r.name, fetchCfg, refetchChips]);

  if (!connected) {
    return (
      <div className="p-2 sm:p-4 max-w-2xl mx-auto">
        <div className="text-center mb-6">
          <h1 className="font-pixel text-retro-gold animate-glow" style={{ fontSize: 18 }}>
            CHIP MINT STATION
          </h1>
        </div>
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 14 }}>
            CONNECT WALLET TO MINT
          </div>
          <div className="text-sm opacity-60 mb-4">Phantom · Solflare · Backpack</div>
          <div className="flex justify-center">
            <WalletMultiButton />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 sm:p-4 max-w-2xl mx-auto">
      <div className="text-center mb-6">
        <h1 className="font-pixel text-retro-gold animate-glow" style={{ fontSize: 18 }}>
          CHIP MINT STATION
        </h1>
        <div className="text-sm opacity-60 mt-1">Select rarity</div>
      </div>

      {cfgErr && (
        <div className="retro-panel mb-4" style={{ borderColor: "#FF8800" }}>
          <div className="font-pixel text-retro-orange" style={{ fontSize: 10 }}>NETWORK NOT READY</div>
          <div className="text-xs opacity-70 mt-1">{cfgErr}</div>
        </div>
      )}

      <div className="retro-panel mb-4">
        <div className="font-pixel text-xs text-retro-cyan mb-3" style={{ fontSize: 10 }}>
          &gt; SELECT RARITY:
        </div>
        <div className="flex gap-2 flex-wrap justify-center">
          {RARITIES.map((rar) => (
            <button
              key={rar.id}
              onClick={() => setSelectedRarity(rar.id)}
              className="retro-btn px-3 py-2"
              style={{
                fontSize: 9,
                borderColor: selectedRarity === rar.id ? rar.color : "#4a4a8a",
                color: selectedRarity === rar.id ? rar.color : "#4a4a8a",
                textShadow: selectedRarity === rar.id ? `0 0 10px ${rar.color}` : "none",
              }}
            >
              {rar.name}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-4">
        <div className="retro-panel flex-shrink-0 flex items-center justify-center mx-auto sm:mx-0" style={{ width: 160 }}>
          <ChipCard tokenId={Number(cfg?.nextTokenId ?? 0)} rarity={selectedRarity} size="lg" />
        </div>

        <div className="retro-panel flex-1 w-full">
          <div className="font-pixel text-xs mb-3" style={{ fontSize: 10, color: r.color }}>
            &gt; {r.name.toUpperCase()} CHIP INFO:
          </div>
          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td className="py-1 text-retro-cyan opacity-70">Price:</td>
                <td className="py-1 text-right" style={{ color: r.color }}>
                  {fmtSol(priceSol)} SOL
                </td>
              </tr>
              <tr>
                <td className="py-1 text-retro-cyan opacity-70">Minted:</td>
                <td className="py-1 text-right">{capLabel}</td>
              </tr>
              <tr style={{ borderTop: "1px solid #2a2a5a" }}>
                <td className="py-2 text-retro-gold font-pixel" style={{ fontSize: 11 }}>TOTAL:</td>
                <td className="py-2 text-right text-retro-gold font-pixel" style={{ fontSize: 14 }}>
                  {fmtSol(priceSol)} SOL
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <button
        onClick={handleMint}
        disabled={pending || !cfg?.mintEnabled}
        className="retro-btn retro-btn-gold w-full py-4 font-pixel"
        style={{ fontSize: 14 }}
      >
        {pending
          ? ">> SIGN IN WALLET..."
          : !cfg?.mintEnabled
          ? ">> MINT DISABLED"
          : `>> MINT ${r.name.toUpperCase()} CHIP <<`}
      </button>

      <div className="text-xs opacity-40 mt-3 text-center">
        Each mint creates a fresh Metaplex Core Asset + ChipData PDA.
      </div>
    </div>
  );
}
