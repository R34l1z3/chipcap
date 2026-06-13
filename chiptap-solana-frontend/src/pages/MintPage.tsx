// ============================================================
// src/pages/MintPage.tsx — real mint flow
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Keypair, SystemProgram } from "@solana/web3.js";
import { useChipNftProgram } from "../hooks/useChipNftProgram";
import { useChipsByOwner } from "../hooks/useChipsByOwner";
import { notify, notifyTxError } from "../lib/notifications";
import * as pda from "../lib/pda";
import { MPL_CORE_PROGRAM } from "../lib/mpl";
import { TIERS, DEFAULT_MINT_PRICE_SOL } from "../config";
import { fmtSol } from "../lib/format";
import ChipCard from "../components/ChipCard";

interface ChipNftConfigView {
  mintEnabled: boolean;
  nextTokenId: bigint;
  mintPrice:   number;   // SOL — SEC-26: single flat tier-0 price
  maxSupply:   number;   // 0 = unlimited
  mintedCount: number;
}

function METADATA_URI() {
  // Placeholder.  Replace with `ipfs://CID/<token>.json` once the
  // chiptap-nft-metadata project's outputs are pinned to IPFS.  All
  // chips mint at tier 0 (SEC-26); higher-tier art is swapped client-side.
  return `https://chiptap.gg/metadata/tier-0.json`;
}

export default function MintPage() {
  const { t } = useTranslation();
  const { connected, publicKey } = useWallet();
  const program = useChipNftProgram();
  const owner   = publicKey?.toBase58();
  const { refetch: refetchChips } = useChipsByOwner(owner);

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
        mintPrice:   Number(acc.mintPrice) / 1_000_000_000,
        maxSupply:   Number(acc.maxSupply),
        mintedCount: Number(acc.mintedCount),
      });
    } catch (e) {
      setCfgErr((e as Error).message);
    }
  }, [program]);

  useEffect(() => { fetchCfg(); }, [fetchCfg]);

  const t0 = TIERS[0];
  const tierName = t("tier.0");
  const priceSol = cfg?.mintPrice ?? DEFAULT_MINT_PRICE_SOL;
  const minted   = cfg?.mintedCount ?? 0;
  const cap      = cfg?.maxSupply   ?? 0;
  const capLabel = cap > 0 ? `${minted} / ${cap}` : `${minted} / ∞`;

  const handleMint = useCallback(async () => {
    if (!program || !publicKey) return;
    setPending(true);
    try {
      const asset = Keypair.generate();
      const name  = "ChipTap";
      const uri   = METADATA_URI();

      const sig = await (program.methods as any)
        .mintChip(name, uri)
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

      notify("info", `${t("mint.toast")} ${sig.slice(0, 8)}…`);
      await Promise.all([fetchCfg(), refetchChips()]);
    } catch (e) {
      notifyTxError("Mint", e);
    } finally {
      setPending(false);
    }
  }, [program, publicKey, t, fetchCfg, refetchChips]);

  if (!connected) {
    return (
      <div className="p-2 sm:p-4 max-w-2xl mx-auto">
        <div className="text-center mb-6">
          <h1 className="font-pixel text-retro-gold animate-glow" style={{ fontSize: 18 }}>
            {t("mint.title")}
          </h1>
        </div>
        <div className="retro-panel text-center py-8">
          <div className="font-pixel text-retro-gold mb-3" style={{ fontSize: 14 }}>
            {t("mint.connect")}
          </div>
          <div className="text-sm opacity-60 mb-4">{t("mint.wallets")}</div>
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
          {t("mint.title")}
        </h1>
        <div className="text-sm opacity-60 mt-1">{t("mint.tierSub")}</div>
      </div>

      {cfgErr && (
        <div className="retro-panel mb-4" style={{ borderColor: "#FF8800" }}>
          <div className="font-pixel text-retro-orange" style={{ fontSize: 10 }}>{t("mint.networkNotReady")}</div>
          <div className="text-xs opacity-70 mt-1">{cfgErr}</div>
        </div>
      )}

      <div className="retro-panel mb-4" style={{ borderColor: t0.color }}>
        <div className="font-pixel text-xs mb-1" style={{ fontSize: 10, color: t0.color }}>
          &gt; {t("mint.tierIntro")}
        </div>
        <div className="text-xs opacity-70" style={{ lineHeight: 1.4 }}>
          {t("mint.tierBody")}
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-4 mb-4">
        <div className="retro-panel flex-shrink-0 flex items-center justify-center mx-auto sm:mx-0" style={{ width: 160 }}>
          <ChipCard tokenId={Number(cfg?.nextTokenId ?? 0)} tier={0} size="lg" />
        </div>

        <div className="retro-panel flex-1 w-full">
          <div className="font-pixel text-xs mb-3" style={{ fontSize: 10, color: t0.color }}>
            &gt; {t("mint.chipInfo", { rarity: tierName.toUpperCase() })}
          </div>
          <table className="w-full text-sm">
            <tbody>
              <tr>
                <td className="py-1 text-retro-cyan opacity-70">{t("mint.price")}</td>
                <td className="py-1 text-right" style={{ color: t0.color }}>
                  {fmtSol(priceSol)} SOL
                </td>
              </tr>
              <tr>
                <td className="py-1 text-retro-cyan opacity-70">{t("mint.minted")}</td>
                <td className="py-1 text-right">{capLabel}</td>
              </tr>
              <tr style={{ borderTop: "1px solid #2a2a5a" }}>
                <td className="py-2 text-retro-gold font-pixel" style={{ fontSize: 11 }}>{t("mint.total")}</td>
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
          ? `>> ${t("mint.signing")}`
          : !cfg?.mintEnabled
          ? `>> ${t("mint.disabled")}`
          : `>> ${t("mint.cta")} <<`}
      </button>

      <div className="text-xs opacity-40 mt-3 text-center">
        {t("mint.footnote")}
      </div>
    </div>
  );
}
