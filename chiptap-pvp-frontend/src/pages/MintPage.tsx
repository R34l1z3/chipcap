// ============================================================
// src/pages/MintPage.tsx — Mint chips with retro UI
// ============================================================

import React, { useEffect, useState } from "react";
import { useAccount, useChainId, useReadContract, useWriteContract, useWaitForTransactionReceipt } from "wagmi";
import { formatEther } from "viem";
import { CHIP_NFT_ABI } from "../abi/contracts";
import { getContracts, RARITIES } from "../config";
import ChipCard from "../components/ChipCard";
import { notifyTxError } from "../services/notifications";

export default function MintPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const contracts = getContracts(chainId);

  const [selectedRarity, setSelectedRarity] = useState(0);
  const [amount, setAmount] = useState(1);

  // Read mint price for selected rarity
  const { data: mintPrice } = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "mintPrice",
    args: [selectedRarity],
  });

  // Read minted count
  const { data: mintedCount } = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "mintedCount",
    args: [selectedRarity],
  });

  // Read max supply
  const { data: maxSupply } = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "maxSupply",
    args: [selectedRarity],
  });

  // Read mint enabled
  const { data: mintEnabled } = useReadContract({
    address: contracts.chipNFT,
    abi: CHIP_NFT_ABI,
    functionName: "mintEnabled",
  });

  // Mint transaction
  const { writeContract: mint, data: txHash, isPending, error: mintError } = useWriteContract();
  const { isLoading: isConfirming, isSuccess, error: confirmError } = useWaitForTransactionReceipt({ hash: txHash });

  useEffect(() => { if (mintError) notifyTxError("Mint", mintError); }, [mintError]);
  useEffect(() => { if (confirmError) notifyTxError("Mint confirm", confirmError); }, [confirmError]);

  const totalPrice = mintPrice ? BigInt(mintPrice) * BigInt(amount) : BigInt(0);

  const handleMint = () => {
    if (!mintPrice) return;
    if (amount === 1) {
      mint({
        address: contracts.chipNFT,
        abi: CHIP_NFT_ABI,
        functionName: "mint",
        args: [selectedRarity],
        value: BigInt(mintPrice),
      });
    } else {
      mint({
        address: contracts.chipNFT,
        abi: CHIP_NFT_ABI,
        functionName: "mintBatch",
        args: [selectedRarity, BigInt(amount)],
        value: totalPrice,
      });
    }
  };

  const r = RARITIES[selectedRarity];

  if (!isConnected) {
    return (
      <div className="flex flex-col items-center justify-center h-full p-8">
        <div className="retro-panel text-center max-w-md mx-auto">
          <div className="font-pixel text-retro-gold text-lg mb-4" style={{ fontSize: 14 }}>
            CONNECT WALLET TO MINT
          </div>
          <div className="text-retro-cyan">
            Use the [CONNECT WALLET] button in the header to get started.
          </div>
          <div className="mt-4 text-sm opacity-60">
            Supported: MetaMask, WalletConnect, Coinbase Wallet
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2 sm:p-4 max-w-2xl mx-auto">
      {/* Title */}
      <div className="text-center mb-6">
        <h1 className="font-pixel text-retro-gold animate-glow" style={{ fontSize: 18 }}>
          CHIP MINT STATION
        </h1>
        <div className="text-sm opacity-60 mt-1">Select rarity and amount</div>
      </div>

      {/* Rarity selector */}
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

      {/* Preview + Info */}
      <div className="flex flex-col sm:flex-row gap-4 mb-4">
        {/* Chip preview */}
        <div
          className="retro-panel flex-shrink-0 flex items-center justify-center mx-auto sm:mx-0"
          style={{ width: 160 }}
        >
          <ChipCard tokenId={0} rarity={selectedRarity} size="lg" />
        </div>

        {/* Info panel */}
        <div className="retro-panel flex-1 w-full">
          <div className="font-pixel text-xs mb-3" style={{ fontSize: 10, color: r.color }}>
            &gt; {r.name.toUpperCase()} CHIP INFO:
          </div>

          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td className="py-1 text-retro-cyan opacity-70">Price:</td>
                <td className="py-1 text-right" style={{ color: r.color }}>
                  {mintPrice ? formatEther(BigInt(mintPrice)) : "..."} POL
                </td>
              </tr>
              <tr>
                <td className="py-1 text-retro-cyan opacity-70">Minted:</td>
                <td className="py-1 text-right">
                  {mintedCount?.toString() || "0"} / {maxSupply && BigInt(maxSupply) > 0n ? maxSupply?.toString() : "∞"}
                </td>
              </tr>
              <tr>
                <td className="py-1 text-retro-cyan opacity-70">Amount:</td>
                <td className="py-1 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <button
                      onClick={() => setAmount(Math.max(1, amount - 1))}
                      className="retro-btn px-2 py-0"
                      style={{ fontSize: 10 }}
                    >
                      -
                    </button>
                    <span className="text-retro-gold font-pixel" style={{ fontSize: 14, minWidth: 20, textAlign: "center" }}>
                      {amount}
                    </span>
                    <button
                      onClick={() => setAmount(Math.min(10, amount + 1))}
                      className="retro-btn px-2 py-0"
                      style={{ fontSize: 10 }}
                    >
                      +
                    </button>
                  </div>
                </td>
              </tr>
              <tr style={{ borderTop: "1px solid #2a2a5a" }}>
                <td className="py-2 text-retro-gold font-pixel" style={{ fontSize: 11 }}>TOTAL:</td>
                <td className="py-2 text-right text-retro-gold font-pixel" style={{ fontSize: 14 }}>
                  {totalPrice > 0n ? formatEther(totalPrice) : "..."} POL
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* Mint button */}
      <button
        onClick={handleMint}
        disabled={isPending || isConfirming || !mintEnabled || !mintPrice}
        className="retro-btn retro-btn-gold w-full py-4 font-pixel"
        style={{ fontSize: 14 }}
      >
        {isPending
          ? ">> CONFIRM IN WALLET..."
          : isConfirming
          ? ">> MINTING..."
          : !mintEnabled
          ? ">> MINT DISABLED"
          : `>> MINT ${amount} ${r.name.toUpperCase()} CHIP${amount > 1 ? "S" : ""} <<`}
      </button>

      {/* Success message */}
      {isSuccess && (
        <div
          className="retro-panel mt-4 text-center"
          style={{ borderColor: "#00FF00" }}
        >
          <div className="font-pixel text-retro-lime" style={{ fontSize: 12 }}>
            MINT SUCCESSFUL!
          </div>
          <div className="text-sm text-retro-cyan mt-1">
            Your {r.name} chip{amount > 1 ? "s have" : " has"} been minted. Check your inventory!
          </div>
          {txHash && (
            <div className="text-xs mt-2 opacity-50 break-all">
              TX: {txHash.slice(0, 20)}...
            </div>
          )}
        </div>
      )}

      {/* ASCII art footer (hidden on phones — too narrow) */}
      <pre
        className="hidden sm:block text-center mt-6 text-retro-cyan opacity-20"
        style={{ fontSize: 10, lineHeight: 1.2 }}
      >
{`
  _____ _     _    _____          
 / ____| |   (_)  |_   _|         
| |    | |__  _ _ __| | __ _ _ __ 
| |    | '_ \\| | '_ | |/ _\` | '_ \\
| |____| | | | | |_)| | (_| | |_) |
 \\_____|_| |_|_| .__\\___|\\__,_| .__/ 
               | |             | |    
               |_|             |_|    
`}
      </pre>
    </div>
  );
}
