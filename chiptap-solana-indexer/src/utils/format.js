// ============================================================
// src/utils/format.js — anchor BN / Pubkey helpers
// ============================================================

import { LAMPORTS_PER_SOL } from "@solana/web3.js";

/** Stringify potentially-BN/bigint/number. */
export function asNum(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v.toNumber === "function") {
    try { return v.toNumber(); } catch { return Number(v.toString()); }
  }
  return Number(v.toString?.() ?? v);
}

export function asBigInt(v) {
  if (v == null) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v.toString === "function") return BigInt(v.toString());
  return BigInt(v);
}

/** Render a Pubkey-like value to base58 string. */
export function asPubkey(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v.toBase58 === "function") return v.toBase58();
  return String(v);
}

export function lamportsToSol(lamports) {
  return Number(asBigInt(lamports)) / LAMPORTS_PER_SOL;
}
