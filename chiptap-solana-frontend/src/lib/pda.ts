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
