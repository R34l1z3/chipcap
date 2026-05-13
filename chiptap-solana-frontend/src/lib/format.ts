import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

export function shortAddr(a: string | undefined | null): string {
  if (!a) return "---";
  return a.slice(0, 4) + "…" + a.slice(-4);
}

export function lamportsToSol(v: number | bigint | BN | string | undefined | null): number {
  if (v == null) return 0;
  if (BN.isBN(v))           return v.toNumber() / LAMPORTS_PER_SOL;
  if (typeof v === "bigint") return Number(v) / LAMPORTS_PER_SOL;
  if (typeof v === "string") return Number(v) / LAMPORTS_PER_SOL;
  return v / LAMPORTS_PER_SOL;
}

export function fmtSol(n: number, decimals = 4): string {
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString("en-US", { maximumFractionDigits: decimals, useGrouping: false });
}

export function timeAgo(secOrIso: number | string | null | undefined): string {
  if (secOrIso == null) return "—";
  let ts: number;
  if (typeof secOrIso === "string") {
    ts = Math.floor(new Date(secOrIso).getTime() / 1000);
  } else {
    // assume seconds
    ts = secOrIso;
  }
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60)    return `${diff}s ago`;
  if (diff < 3600)  return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
