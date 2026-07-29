// ============================================================
// src/lib/programs.ts
//
// Builds Anchor `Program` instances bound to the connected wallet.
// Anchor 0.30+ takes (idl, provider) — program ID lives inside the
// IDL's `address` field, no need to pass it separately.
// ============================================================

import * as anchor from "@coral-xyz/anchor";
import { AnchorWallet } from "@solana/wallet-adapter-react";
import { Connection } from "@solana/web3.js";

import battleArenaIdl from "../idl/battle_arena.json";
import chipNftIdl     from "../idl/chip_nft.json";
import treasuryIdl    from "../idl/treasury.json";
import marketplaceIdl from "../idl/marketplace.json";

export function buildProvider(
  connection: Connection,
  wallet: AnchorWallet | undefined,
): anchor.AnchorProvider | null {
  if (!wallet) return null;
  return new anchor.AnchorProvider(
    connection,
    wallet,
    { commitment: "confirmed", preflightCommitment: "confirmed" },
  );
}

// Anchor's TS bindings widened the `Idl` type a lot in 0.30.  Until we
// generate proper `target/types/*.ts`, we cast through `unknown as Idl`
// so the JSONs are accepted and `.methods.<x>()` is `any`-typed.
const idl = (j: unknown) => j as unknown as anchor.Idl;

export function getBattleArenaProgram(provider: anchor.AnchorProvider) {
  return new anchor.Program(idl(battleArenaIdl), provider);
}

export function getChipNftProgram(provider: anchor.AnchorProvider) {
  return new anchor.Program(idl(chipNftIdl), provider);
}

export function getTreasuryProgram(provider: anchor.AnchorProvider) {
  return new anchor.Program(idl(treasuryIdl), provider);
}

// SEC-27.  The program ID comes from the IDL's `address` field, so this
// works regardless of VITE_MARKETPLACE_PROGRAM — but callers should gate
// on MARKET_ENABLED anyway so a half-configured deploy doesn't send txs
// to a program the operator never meant to enable.
export function getMarketplaceProgram(provider: anchor.AnchorProvider) {
  return new anchor.Program(idl(marketplaceIdl), provider);
}
