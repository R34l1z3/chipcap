// ============================================================
// src/components/BootDiagnostics.tsx
//
// Runs once on mount.  Probes:
//   1. Solana RPC reachable + correct cluster
//   2. All 3 programs are actually deployed at the configured PDAs
//   3. Whether a Solana wallet extension is injected in window
//
// Prints a single grouped table to DevTools Console.  Shows a slim
// top banner with the first failed check (so non-DevTools users still
// see something).  Stays out of the way once everything is green.
// ============================================================

import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  CHIP_NFT_PROGRAM,
  BATTLE_ARENA_PROGRAM,
  TREASURY_PROGRAM,
  CLUSTER,
  RPC_URL,
} from "../config";

type ProbeStatus = "pending" | "ok" | "fail";
type Probe       = { name: string; status: ProbeStatus; detail?: string };

declare global {
  interface Window {
    // Phantom / Solflare / Backpack each inject under different keys.
    solana?:    { isPhantom?: boolean };
    solflare?:  unknown;
    backpack?:  unknown;
  }
}

export default function BootDiagnostics() {
  const { t } = useTranslation();
  const { connection } = useConnection();
  const { wallets }    = useWallet();
  const [probes, setProbes] = useState<Probe[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const out: Probe[] = [];

      // 1. RPC reachable
      try {
        const v = await connection.getVersion();
        out.push({
          name: "Solana RPC",
          status: "ok",
          detail: `${RPC_URL} (${(v as any)["solana-core"] ?? "?"})`,
        });
      } catch (e: any) {
        out.push({
          name: "Solana RPC",
          status: "fail",
          detail: `${RPC_URL} unreachable: ${e?.message ?? e}`,
        });
      }

      // 2. Programs deployed
      const programs = [
        ["chip_nft",     CHIP_NFT_PROGRAM],
        ["battle_arena", BATTLE_ARENA_PROGRAM],
        ["treasury",     TREASURY_PROGRAM],
      ] as const;
      for (const [name, pk] of programs) {
        try {
          const acc = await connection.getAccountInfo(pk);
          if (acc && acc.executable) {
            out.push({ name: `Program ${name}`, status: "ok", detail: pk.toBase58() });
          } else {
            out.push({
              name: `Program ${name}`,
              status: "fail",
              detail: `${pk.toBase58()} — not deployed (run anchor deploy + run-init.sh)`,
            });
          }
        } catch (e: any) {
          out.push({ name: `Program ${name}`, status: "fail", detail: e?.message ?? String(e) });
        }
      }

      // 3. Wallet extension detected (best-effort).  Wallet-adapter
      // populates `wallets[]` based on installed extensions + Wallet
      // Standard discovery, so if it's empty no wallet is reachable.
      const detected: string[] = [];
      if (typeof window !== "undefined") {
        if ((window.solana as any)?.isPhantom) detected.push("Phantom (window.solana)");
        if (window.solflare) detected.push("Solflare (window.solflare)");
        if (window.backpack) detected.push("Backpack (window.backpack)");
      }
      const adapterNames = wallets.map((w) => `${w.adapter.name}:${w.readyState}`);
      const walletOk = detected.length > 0 || adapterNames.some((n) => n.includes("Installed"));
      out.push({
        name: "Wallet extension",
        status: walletOk ? "ok" : "fail",
        detail: walletOk
          ? `${detected.join(", ") || adapterNames.join(", ")}`
          : `No wallet detected. Install Phantom (https://phantom.app) or Solflare. Adapters seen: ${adapterNames.join(", ") || "none"}`,
      });

      if (cancelled) return;
      setProbes(out);

      // Pretty console group for copy/paste into bug reports.
      /* eslint-disable no-console */
      console.groupCollapsed(
        `%c[ChipTap] Boot diagnostics — cluster=${CLUSTER}`,
        "color:#FFD700;font-weight:bold;",
      );
      console.table(out.map((p) => ({ check: p.name, status: p.status, detail: p.detail })));
      console.groupEnd();
      /* eslint-enable no-console */
    })();
    return () => { cancelled = true; };
  }, [connection, wallets]);

  if (dismissed) return null;

  const firstFail = probes.find((p) => p.status === "fail");
  if (!firstFail) return null;

  return (
    <div
      style={{
        background: "#5a0a0a",
        color: "#FFD700",
        padding: "6px 12px",
        borderBottom: "2px solid #FF3333",
        fontFamily: "'VT323', monospace",
        fontSize: 14,
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontFamily: "'Press Start 2P', monospace", fontSize: 9, color: "#FF8888" }}>
        ! {t("boot.warning")}
      </span>
      <span style={{ flex: 1, minWidth: 200 }}>
        {/* The "no wallet" case is the one a normal user actually hits —
            translate it.  Deeper RPC/program failures stay English
            (they're for bug reports / devs). */}
        {firstFail.name === "Wallet extension"
          ? t("boot.noWallet")
          : `${firstFail.name} — ${firstFail.detail}`}
      </span>
      <button
        className="retro-btn"
        style={{ fontSize: 9, padding: "2px 6px", minHeight: 0 }}
        onClick={() => setDismissed(true)}
      >
        {t("boot.dismiss")}
      </button>
    </div>
  );
}
