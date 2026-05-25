// ============================================================
// src/lib/pda.ts — PDA derivers (must match programs' seeds)
// ============================================================

import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { BATTLE_ARENA_PROGRAM, CHIP_NFT_PROGRAM, TREASURY_PROGRAM } from "../config";

const enc = (s: string) => new TextEncoder().encode(s);

export const treasuryConfig = () =>
  PublicKey.findProgramAddressSync([enc("treasury")], TREASURY_PROGRAM)[0];

export const treasuryVault = () =>
  PublicKey.findProgramAddressSync([enc("treasury"), enc("vault")], TREASURY_PROGRAM)[0];

export const chipNftConfig = () =>
  PublicKey.findProgramAddressSync([enc("chip_nft")], CHIP_NFT_PROGRAM)[0];

export const chipNftVault = () =>
  PublicKey.findProgramAddressSync([enc("chip_nft"), enc("vault")], CHIP_NFT_PROGRAM)[0];

export const chipData = (asset: PublicKey) =>
  PublicKey.findProgramAddressSync([enc("chip"), asset.toBuffer()], CHIP_NFT_PROGRAM)[0];

export const arenaConfig = () =>
  PublicKey.findProgramAddressSync([enc("arena")], BATTLE_ARENA_PROGRAM)[0];

export const arenaVault = () =>
  PublicKey.findProgramAddressSync([enc("arena"), enc("vault")], BATTLE_ARENA_PROGRAM)[0];

export const chipAuthority = () =>
  PublicKey.findProgramAddressSync([enc("arena"), enc("chip_authority")], BATTLE_ARENA_PROGRAM)[0];

export const userAccount = (authority: PublicKey) =>
  PublicKey.findProgramAddressSync([enc("user"), authority.toBuffer()], BATTLE_ARENA_PROGRAM)[0];

export const battle = (id: number | bigint | BN) => {
  const idBn = BN.isBN(id) ? id : new BN(id.toString());
  return PublicKey.findProgramAddressSync(
    [enc("battle"), idBn.toArrayLike(Buffer, "le", 8)],
    BATTLE_ARENA_PROGRAM,
  )[0];
};

// SEC-22 — Battle Royale account PDA.  Shares the `arena.next_battle_id`
// counter with 1v1 battles, so the same numeric id maps to EITHER
// `battle(id)` OR `royale(id)` but never both.
export const royale = (id: number | bigint | BN) => {
  const idBn = BN.isBN(id) ? id : new BN(id.toString());
  return PublicKey.findProgramAddressSync(
    [enc("royale"), idBn.toArrayLike(Buffer, "le", 8)],
    BATTLE_ARENA_PROGRAM,
  )[0];
};

// SEC-23 — Tournament account + ticket SPL plumbing.  Tournament shares
// the next_battle_id counter, same convention as `royale` above.
export const tournament = (id: number | bigint | BN) => {
  const idBn = BN.isBN(id) ? id : new BN(id.toString());
  return PublicKey.findProgramAddressSync(
    [enc("tournament"), idBn.toArrayLike(Buffer, "le", 8)],
    BATTLE_ARENA_PROGRAM,
  )[0];
};

// Ticket SPL mint — deterministic PDA so the UI can derive it without
// fetching ArenaConfig (which still validates the binding on-chain via
// config.ticket_mint constraint).
export const ticketMint = () =>
  PublicKey.findProgramAddressSync([enc("ticket_mint")], BATTLE_ARENA_PROGRAM)[0];

// Mint+freeze authority for the ticket SPL.  PDA-only; never holds data.
export const ticketAuthority = () =>
  PublicKey.findProgramAddressSync([enc("ticket_authority")], BATTLE_ARENA_PROGRAM)[0];
