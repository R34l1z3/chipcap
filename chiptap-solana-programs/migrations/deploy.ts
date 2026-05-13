// ============================================================
// migrations/deploy.ts
//
// Run after `anchor deploy` to:
//   1. initialize all 3 programs (idempotent)
//   2. wire chip-nft.battle_authority   ← arena.chip_authority PDA
//   3. wire treasury.battle_arena       ← arena.vault PDA
//   4. enable minting
//
// Usage:
//   anchor run deploy --provider.cluster localnet
//   anchor run deploy --provider.cluster devnet
//
// Reads programs from `anchor.workspace`, signers from
// ANCHOR_WALLET / ANCHOR_PROVIDER_URL.
// ============================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SystemProgram } from "@solana/web3.js";
import { pda } from "../tests/helpers";

import type { Treasury }    from "../target/types/treasury";
import type { ChipNft }     from "../target/types/chip_nft";
import type { BattleArena } from "../target/types/battle_arena";

module.exports = async function (provider: anchor.AnchorProvider) {
  anchor.setProvider(provider);

  const treasury = anchor.workspace.Treasury    as Program<Treasury>;
  const chipNft  = anchor.workspace.ChipNft     as Program<ChipNft>;
  const arena    = anchor.workspace.BattleArena as Program<BattleArena>;

  const owner = (provider.wallet as anchor.Wallet).publicKey;
  const log   = (...a: any[]) => console.log("[deploy]", ...a);

  log("owner   :", owner.toBase58());
  log("treasury:", treasury.programId.toBase58());
  log("chip-nft:", chipNft.programId.toBase58());
  log("arena   :", arena.programId.toBase58());

  // ---- 1. init ----
  await maybeInit(
    "treasury",
    () => treasury.methods.initialize().accounts({
      owner,
      config: pda.treasuryConfig(treasury.programId),
      vault:  pda.treasuryVault(treasury.programId),
      systemProgram: SystemProgram.programId,
    } as any).rpc(),
  );

  await maybeInit(
    "chip-nft",
    () => chipNft.methods.initialize().accounts({
      owner,
      config: pda.chipNftConfig(chipNft.programId),
      vault:  pda.chipNftVault(chipNft.programId),
      systemProgram: SystemProgram.programId,
    } as any).rpc(),
  );

  await maybeInit(
    "arena",
    () => arena.methods.initialize().accounts({
      owner,
      config:        pda.arenaConfig(arena.programId),
      vault:         pda.arenaVault(arena.programId),
      chipAuthority: pda.chipAuthority(arena.programId),
      chipNftProgram: chipNft.programId,
      treasuryProgram: treasury.programId,
      systemProgram: SystemProgram.programId,
    } as any).rpc(),
  );

  // ---- 2. wire ----
  log("wire chip-nft.battle_authority …");
  await chipNft.methods
    .setBattleAuthority(pda.chipAuthority(arena.programId))
    .accounts({ config: pda.chipNftConfig(chipNft.programId), owner } as any)
    .rpc();

  log("wire treasury.battle_arena …");
  await treasury.methods
    .setBattleArena(pda.arenaVault(arena.programId))
    .accounts({ config: pda.treasuryConfig(treasury.programId), owner } as any)
    .rpc();

  log("enable mint …");
  await chipNft.methods.setMintEnabled(true)
    .accounts({ config: pda.chipNftConfig(chipNft.programId), owner } as any)
    .rpc().catch(() => {});

  log("");
  log("==== DEPLOYMENT COMPLETE ====");
  log("treasury config :", pda.treasuryConfig(treasury.programId).toBase58());
  log("chip-nft config :", pda.chipNftConfig(chipNft.programId).toBase58());
  log("arena config    :", pda.arenaConfig(arena.programId).toBase58());
  log("arena vault     :", pda.arenaVault(arena.programId).toBase58());
  log("chip authority  :", pda.chipAuthority(arena.programId).toBase58());
};

async function maybeInit(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const sig = await fn();
    console.log(`[deploy] ${name} init: ${sig}`);
  } catch (e: any) {
    const msg = (e?.message || "").toLowerCase();
    if (msg.includes("already in use") || msg.includes("0x0")) {
      console.log(`[deploy] ${name}: already initialised`);
      return;
    }
    throw e;
  }
}
