// ============================================================
// src/pages/MarketPage.tsx — SEC-27 P2P chip marketplace
//
// Two views:
//   BROWSE — other people's active listings; one click buys.
//   SELL   — pick one of your chips, name a price, list it; cancel
//            your own listings from the same screen.
//
// Payment is direct wallet -> wallet SOL (the marketplace never
// custodies funds), so a purchase is exactly one wallet popup.
// A listed chip is escrowed in `market_authority`, which is also why a
// listed chip can't be sent into a battle: mpl-core refuses a transfer
// whose authority isn't the current owner.
// ============================================================

import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";

import { useMarketplaceProgram } from "../hooks/useMarketplaceProgram";
import { useIndexerListings, type ListingData } from "../hooks/useIndexerListings";
import { useChipsByOwner } from "../hooks/useChipsByOwner";
import { notify, notifyTxError } from "../lib/notifications";
import * as pda from "../lib/pda";
import { MPL_CORE_PROGRAM } from "../lib/mpl";
import { MARKET_ENABLED } from "../config";
import { fmtSol } from "../lib/format";
import ChipCard from "../components/ChipCard";

const LAMPORTS = 1_000_000_000;

type View = "browse" | "sell";

export default function MarketPage() {
  const { t } = useTranslation();
  const { connected, publicKey } = useWallet();
  const program = useMarketplaceProgram();
  const owner = publicKey?.toBase58();

  const { buyable, myActive, loading, refetch } = useIndexerListings();
  const { chips, refetch: refetchChips } = useChipsByOwner(owner);

  const [view, setView]       = useState<View>("browse");
  const [pending, setPending] = useState<string | null>(null);
  const [pick, setPick]       = useState<string | null>(null);
  const [price, setPrice]     = useState("");
  const [feeBps, setFeeBps]   = useState<number | null>(null);

  // Current marketplace fee, straight from MarketConfig.  Listings
  // snapshot it at creation, so this is only the rate a NEW listing
  // would get — existing rows show their own stored fee_bps.
  useEffect(() => {
    if (!program) return;
    (async () => {
      try {
        const acc = await (program.account as any).marketConfig.fetchNullable(pda.marketConfig());
        if (acc) setFeeBps(Number(acc.feeBps));
      } catch { /* not initialised on this cluster — leave null */ }
    })();
  }, [program]);

  const after = useCallback(async () => {
    await Promise.all([refetch(), refetchChips()]);
  }, [refetch, refetchChips]);

  // ---- actions ----

  const handleList = useCallback(async () => {
    if (!program || !publicKey || !pick) return;
    const sol = Number(price);
    if (!Number.isFinite(sol) || sol <= 0) {
      notify("error", t("market.errBadPrice"));
      return;
    }
    setPending("list");
    try {
      const asset = new PublicKey(pick);
      await (program.methods as any)
        .makeListing(new BN(Math.round(sol * LAMPORTS)))
        .accounts({
          config:          pda.marketConfig(),
          listing:         pda.listing(asset),
          marketAuthority: pda.marketAuthority(),
          chip:            asset,
          seller:          publicKey,
          mplCore:         MPL_CORE_PROGRAM,
          systemProgram:   SystemProgram.programId,
        })
        .rpc();
      notify("created", t("market.toastListed", { price: fmtSol(sol) }));
      setPick(null);
      setPrice("");
      await after();
    } catch (e) {
      notifyTxError(t("market.errList"), e);
    } finally {
      setPending(null);
    }
  }, [program, publicKey, pick, price, t, after]);

  const handleCancel = useCallback(async (l: ListingData) => {
    if (!program || !publicKey) return;
    setPending(`cancel:${l.id}`);
    try {
      const asset = new PublicKey(l.asset);
      await (program.methods as any)
        .cancelListing()
        .accounts({
          config:          pda.marketConfig(),
          listing:         pda.listing(asset),
          marketAuthority: pda.marketAuthority(),
          chip:            asset,
          seller:          publicKey,
          mplCore:         MPL_CORE_PROGRAM,
          systemProgram:   SystemProgram.programId,
        })
        .rpc();
      notify("info", t("market.toastCancelled"));
      await after();
    } catch (e) {
      notifyTxError(t("market.errCancel"), e);
    } finally {
      setPending(null);
    }
  }, [program, publicKey, t, after]);

  const handleBuy = useCallback(async (l: ListingData) => {
    if (!program || !publicKey) return;
    setPending(`buy:${l.id}`);
    try {
      const asset = new PublicKey(l.asset);
      // Slippage guard — pass exactly the price the buyer was shown.
      // The Listing PDA is seeded by the asset, so a seller could
      // cancel+relist higher between signing and execution; without
      // this the buyer's own signature would pay the new price.
      const maxPrice = new BN(Math.round(l.price * LAMPORTS));
      await (program.methods as any)
        .fillListing(maxPrice)
        .accounts({
          config:          pda.marketConfig(),
          listing:         pda.listing(asset),
          vault:           pda.marketVault(),
          marketAuthority: pda.marketAuthority(),
          seller:          new PublicKey(l.seller),
          chip:            asset,
          buyer:           publicKey,
          mplCore:         MPL_CORE_PROGRAM,
          systemProgram:   SystemProgram.programId,
        })
        .rpc();
      notify("win", t("market.toastBought", { price: fmtSol(l.price) }));
      await after();
    } catch (e) {
      notifyTxError(t("market.errBuy"), e);
    } finally {
      setPending(null);
    }
  }, [program, publicKey, t, after]);

  // ---- gates ----

  if (!MARKET_ENABLED) {
    return (
      <div className="retro-panel text-center py-8">
        <div className="font-pixel text-xs mb-2" style={{ color: "#FFD700" }}>
          {t("market.title")}
        </div>
        <p className="text-sm opacity-70">{t("market.notConfigured")}</p>
      </div>
    );
  }

  if (!connected) {
    return (
      <div className="retro-panel text-center py-8">
        <div className="font-pixel text-xs mb-3" style={{ color: "#FFD700" }}>
          {t("market.title")}
        </div>
        <p className="text-sm opacity-70 mb-4">{t("market.connect")}</p>
        <div className="flex justify-center"><WalletMultiButton /></div>
      </div>
    );
  }

  // Chips that are free to list: owned, and not already escrowed.
  const sellable = chips.filter((c) => !c.listed);

  return (
    <div className="space-y-4">
      {/* view switch + fee note */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex gap-2">
          {(["browse", "sell"] as View[]).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`retro-btn ${view === v ? "retro-btn-gold" : ""}`}
              style={{ fontSize: 9 }}
            >
              {t(`market.tab_${v}`)}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {feeBps != null && (
            <span className="opacity-60" style={{ fontSize: 10 }}>
              {t("market.feeNote", { pct: (feeBps / 100).toFixed(2) })}
            </span>
          )}
          <button onClick={refetch} className="retro-btn" style={{ fontSize: 9 }}>
            {t("common.refresh")}
          </button>
        </div>
      </div>

      {view === "browse" && (
        <div className="retro-panel">
          <div className="font-pixel text-xs mb-3" style={{ color: "#00FFFF" }}>
            {t("market.browseTitle")}
          </div>
          {loading && buyable.length === 0 && (
            <p className="text-sm opacity-60">{t("common.loading")}</p>
          )}
          {!loading && buyable.length === 0 && (
            <p className="text-sm opacity-60">{t("market.empty")}</p>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
            {buyable.map((l) => (
              <div key={l.id} className="flex flex-col items-center gap-2">
                <ChipCard
                  tokenId={l.tokenId ?? undefined}
                  asset={l.asset}
                  tier={l.tier}
                  progressionWins={l.wins}
                  size="sm"
                />
                <div className="font-pixel" style={{ fontSize: 10, color: "#FFD700" }}>
                  {fmtSol(l.price)} SOL
                </div>
                <button
                  onClick={() => handleBuy(l)}
                  disabled={pending !== null}
                  className="retro-btn retro-btn-gold w-full"
                  style={{ fontSize: 8 }}
                >
                  {pending === `buy:${l.id}` ? t("market.buying") : t("market.buy")}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {view === "sell" && (
        <>
          <div className="retro-panel">
            <div className="font-pixel text-xs mb-3" style={{ color: "#00FF00" }}>
              {t("market.listTitle")}
            </div>

            {sellable.length === 0 ? (
              <p className="text-sm opacity-60">{t("market.noChips")}</p>
            ) : (
              <>
                <p className="text-sm opacity-70 mb-2">{t("market.selectChip")}</p>
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {sellable.map((c) => (
                    <ChipCard
                      key={c.asset}
                      tokenId={c.token_id}
                      asset={c.asset}
                      tier={c.tier}
                      progressionWins={c.progression_wins}
                      selected={pick === c.asset}
                      onClick={() => setPick(c.asset)}
                      size="sm"
                    />
                  ))}
                </div>

                <div className="flex flex-col sm:flex-row gap-2 mt-3">
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    placeholder={t("market.pricePlaceholder")}
                    className="retro-input flex-1"
                    style={{ fontSize: 12 }}
                  />
                  <button
                    onClick={handleList}
                    disabled={!pick || !price || pending !== null}
                    className="retro-btn retro-btn-gold"
                    style={{ fontSize: 9 }}
                  >
                    {pending === "list" ? t("market.listingPending") : t("market.list")}
                  </button>
                </div>

                {/* What the seller actually walks away with. */}
                {feeBps != null && Number(price) > 0 && (
                  <p className="opacity-70 mt-2" style={{ fontSize: 10 }}>
                    {t("market.youReceive", {
                      amount: fmtSol(Number(price) * (1 - feeBps / 10_000)),
                    })}
                  </p>
                )}
              </>
            )}
          </div>

          <div className="retro-panel">
            <div className="font-pixel text-xs mb-3" style={{ color: "#FF00FF" }}>
              {t("market.myListings")}
            </div>
            {myActive.length === 0 ? (
              <p className="text-sm opacity-60">{t("market.emptyMine")}</p>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {myActive.map((l) => (
                  <div key={l.id} className="flex flex-col items-center gap-2">
                    <ChipCard
                      tokenId={l.tokenId ?? undefined}
                      asset={l.asset}
                      tier={l.tier}
                      progressionWins={l.wins}
                      size="sm"
                    />
                    <div className="font-pixel" style={{ fontSize: 10, color: "#FFD700" }}>
                      {fmtSol(l.price)} SOL
                    </div>
                    <button
                      onClick={() => handleCancel(l)}
                      disabled={pending !== null}
                      className="retro-btn w-full"
                      style={{ fontSize: 8 }}
                    >
                      {pending === `cancel:${l.id}` ? t("market.cancelling") : t("market.cancel")}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
