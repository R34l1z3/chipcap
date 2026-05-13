// ============================================================
// tests/helpers.ts — shared fixture for the three programs.
//
// One `setup()` call spins up:
//   • Anchor provider on the configured cluster
//   • Initialised treasury, chip-nft, battle-arena programs
//   • Cross-program wiring (chip-nft battle_authority, treasury
//     battle_arena vault registration)
//   • Helpers for: airdrop, mintChip, deposit, getBattle, etc.
// ============================================================

import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

import type { Treasury }    from "../target/types/treasury";
import type { ChipNft }     from "../target/types/chip_nft";
import type { BattleArena } from "../target/types/battle_arena";

// Metaplex Core program ID (mainnet/devnet/localnet, same address).
export const MPL_CORE_ID = new PublicKey(
  "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d"
);

// ============================================================
// PDA derivers — keep seeds in one place to avoid drift.
// ============================================================

export const pda = {
  treasuryConfig: (program: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("treasury")], program)[0],
  treasuryVault: (program: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("treasury"), Buffer.from("vault")],
      program,
    )[0],

  chipNftConfig: (program: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("chip_nft")], program)[0],
  chipNftVault: (program: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("chip_nft"), Buffer.from("vault")],
      program,
    )[0],
  chipData: (program: PublicKey, asset: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("chip"), asset.toBuffer()],
      program,
    )[0],

  arenaConfig: (program: PublicKey) =>
    PublicKey.findProgramAddressSync([Buffer.from("arena")], program)[0],
  arenaVault: (program: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("arena"), Buffer.from("vault")],
      program,
    )[0],
  chipAuthority: (program: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("arena"), Buffer.from("chip_authority")],
      program,
    )[0],
  user: (program: PublicKey, authority: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("user"), authority.toBuffer()],
      program,
    )[0],
  battle: (program: PublicKey, id: number | bigint | BN) => {
    const idBn = BN.isBN(id) ? id : new BN(id.toString());
    return PublicKey.findProgramAddressSync(
      [Buffer.from("battle"), idBn.toArrayLike(Buffer, "le", 8)],
      program,
    )[0];
  },
};

// ============================================================
// Fixture
// ============================================================

export interface Fixture {
  provider: anchor.AnchorProvider;
  treasury: Program<Treasury>;
  chipNft:  Program<ChipNft>;
  arena:    Program<BattleArena>;
  owner: Keypair;
  playerA: Keypair;
  playerB: Keypair;
  playerC: Keypair;
}

export async function setup(): Promise<Fixture> {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const treasury = anchor.workspace.Treasury    as Program<Treasury>;
  const chipNft  = anchor.workspace.ChipNft     as Program<ChipNft>;
  const arena    = anchor.workspace.BattleArena as Program<BattleArena>;

  const owner   = (provider.wallet as anchor.Wallet).payer;
  const playerA = Keypair.generate();
  const playerB = Keypair.generate();
  const playerC = Keypair.generate();

  // Airdrop test players.
  for (const k of [playerA, playerB, playerC]) {
    await airdrop(provider, k.publicKey, 100 * LAMPORTS_PER_SOL);
  }

  // ---- 1. init treasury ----
  await treasury.methods
    .initialize()
    .accounts({
      owner: owner.publicKey,
      config: pda.treasuryConfig(treasury.programId),
      vault:  pda.treasuryVault(treasury.programId),
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([owner])
    .rpc()
    .catch(swallowAlreadyInitialized);

  // ---- 2. init chip-nft ----
  await chipNft.methods
    .initialize()
    .accounts({
      owner: owner.publicKey,
      config: pda.chipNftConfig(chipNft.programId),
      vault:  pda.chipNftVault(chipNft.programId),
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([owner])
    .rpc()
    .catch(swallowAlreadyInitialized);

  await chipNft.methods.setMintEnabled(true)
    .accounts({
      config: pda.chipNftConfig(chipNft.programId),
      owner:  owner.publicKey,
    } as any)
    .signers([owner])
    .rpc();

  // ---- 3. init arena ----
  await arena.methods
    .initialize()
    .accounts({
      owner: owner.publicKey,
      config:         pda.arenaConfig(arena.programId),
      vault:          pda.arenaVault(arena.programId),
      chipAuthority:  pda.chipAuthority(arena.programId),
      chipNftProgram: chipNft.programId,
      treasuryProgram: treasury.programId,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([owner])
    .rpc()
    .catch(swallowAlreadyInitialized);

  // ---- 4. cross-wire: register chip authority + battle arena ----
  await chipNft.methods
    .setBattleAuthority(pda.chipAuthority(arena.programId))
    .accounts({
      config: pda.chipNftConfig(chipNft.programId),
      owner: owner.publicKey,
    } as any)
    .signers([owner])
    .rpc();

  await treasury.methods
    .setBattleArena(pda.arenaVault(arena.programId))
    .accounts({
      config: pda.treasuryConfig(treasury.programId),
      owner: owner.publicKey,
    } as any)
    .signers([owner])
    .rpc();

  return { provider, treasury, chipNft, arena, owner, playerA, playerB, playerC };
}

// ============================================================
// Utilities
// ============================================================

export async function airdrop(
  provider: anchor.AnchorProvider,
  to: PublicKey,
  lamports: number,
): Promise<void> {
  const sig = await provider.connection.requestAirdrop(to, lamports);
  const latestBh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction({ signature: sig, ...latestBh });
}

/** Mint a single chip via chip-nft program for `payer`. Returns asset Pubkey. */
export async function mintChip(
  fx: Fixture,
  payer: Keypair,
  rarity: number,
  name = "ChipTap test",
  uri  = "ipfs://test/1.json",
): Promise<PublicKey> {
  const asset = Keypair.generate();
  await fx.chipNft.methods
    .mintChip(rarity, name, uri)
    .accounts({
      config:    pda.chipNftConfig(fx.chipNft.programId),
      vault:     pda.chipNftVault(fx.chipNft.programId),
      asset:     asset.publicKey,
      chipData:  pda.chipData(fx.chipNft.programId, asset.publicKey),
      payer:     payer.publicKey,
      mplCore:   MPL_CORE_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([payer, asset])
    .rpc();
  return asset.publicKey;
}

/** Deposit lamports into the arena ledger for `payer`. */
export async function deposit(
  fx: Fixture, payer: Keypair, lamports: number,
): Promise<void> {
  await fx.arena.methods
    .deposit(new BN(lamports))
    .accounts({
      config: pda.arenaConfig(fx.arena.programId),
      vault:  pda.arenaVault(fx.arena.programId),
      user:   pda.user(fx.arena.programId, payer.publicKey),
      payer:  payer.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .signers([payer])
    .rpc();
}

export async function getBattle(fx: Fixture, id: number | BN) {
  return fx.arena.account.battle.fetch(pda.battle(fx.arena.programId, id));
}

export async function getUserAccount(fx: Fixture, who: PublicKey) {
  return fx.arena.account.userAccount.fetch(pda.user(fx.arena.programId, who));
}

// ============================================================
// Helpers
// ============================================================

function swallowAlreadyInitialized(e: any): void {
  // Re-running the fixture against an unchanged validator will hit
  // "already in use".  Tests should call setup() in `before()` once,
  // but be defensive.
  const msg = (e?.message || "").toLowerCase();
  if (msg.includes("already in use") || msg.includes("custom program error: 0x0")) return;
  throw e;
}
