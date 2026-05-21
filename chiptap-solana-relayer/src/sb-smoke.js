// Standalone Switchboard-cycle smoke.  Creates a battle, joins it,
// runs ONE Switchboard cycle, asserts status reached DECIDED via the
// Switchboard ix.  Use this to validate SDK API + program upgrade in
// isolation before flipping the live relayer to switchboard mode.
//
// Usage:
//   cd chiptap-solana-relayer
//   node src/sb-smoke.js
//
// Requires: VRF_AUTHORITY_KEYPAIR (or VRF_AUTHORITY_KEYPAIR_JSON)
// with enough devnet SOL (~0.5 SOL for Switchboard fees + create).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  Connection, Keypair, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import anchorPkg from "@coral-xyz/anchor";
const { AnchorProvider, BN, Program, Wallet, setProvider } = anchorPkg;
import { runSwitchboardCycle, switchboardEndpoints } from "./switchboard.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

// Wallet — same as relayer.
const secret = process.env.VRF_AUTHORITY_KEYPAIR_JSON
  ? JSON.parse(process.env.VRF_AUTHORITY_KEYPAIR_JSON)
  : JSON.parse(fs.readFileSync(process.env.VRF_AUTHORITY_KEYPAIR || `${os.homedir()}/.config/solana/id.json`, "utf8"));
const owner = Keypair.fromSecretKey(Uint8Array.from(secret));
console.log("owner:", owner.publicKey.toBase58());

const connection = new Connection(RPC, "confirmed");
const provider = new AnchorProvider(connection, new Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
setProvider(provider);

// Load IDLs from chiptap-solana-programs/target/idl
const idlDir = path.join(here, "..", "..", "chiptap-solana-programs", "target", "idl");
const arenaIdl   = JSON.parse(fs.readFileSync(path.join(idlDir, "battle_arena.json")));
const chipNftIdl = JSON.parse(fs.readFileSync(path.join(idlDir, "chip_nft.json")));
const arena   = new Program(arenaIdl, provider);
const chipNft = new Program(chipNftIdl, provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const arenaConfig   = pda([enc("arena")], arena.programId);
const chipAuthority = pda([enc("arena"), enc("chip_authority")], arena.programId);
const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const battlePda     = (id) => pda([enc("battle"), new BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);
const chipDataPda   = (a)  => pda([enc("chip"), a.toBuffer()], chipNft.programId);

async function fund(to, sol) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: owner.publicKey, toPubkey: to,
    lamports: Math.floor(sol * LAMPORTS_PER_SOL),
  }));
  return sendAndConfirmTransaction(connection, tx, [owner]);
}
async function mintFor(player) {
  const asset = Keypair.generate();
  await chipNft.methods.mintChip(0, "ChipTap", "https://chiptap.gg/metadata/0.json")
    .accounts({
      config: chipNftConfig, vault: chipNftVault,
      asset: asset.publicKey, chipData: chipDataPda(asset.publicKey),
      payer: player.publicKey, mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    }).signers([player, asset]).rpc();
  return asset.publicKey;
}

(async () => {
  console.log("=== setup two throwaway players ===");
  const a = Keypair.generate(); const b = Keypair.generate();
  await fund(a.publicKey, 0.05); await fund(b.publicKey, 0.05);
  console.log("playerA:", a.publicKey.toBase58().slice(0,8), "playerB:", b.publicKey.toBase58().slice(0,8));

  console.log("=== mint chips ===");
  const chipA = await mintFor(a);
  const chipB = await mintFor(b);

  console.log("=== create + join ===");
  const cfg = await arena.account.arenaConfig.fetch(arenaConfig);
  const id = cfg.nextBattleId.toString();
  const bPda = battlePda(id);
  console.log("battleId =", id);

  await arena.methods.createBattle(0).accounts({
    config: arenaConfig, battle: bPda, chipAuthority,
    chip: chipA, player: a.publicKey,
    mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([a]).rpc();

  await arena.methods.joinBattle().accounts({
    config: arenaConfig, battle: bPda, chipAuthority,
    chip: chipB, player: b.publicKey,
    mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([b]).rpc();
  console.log("joined — status should be ROLLING");

  console.log("=== Switchboard cycle ===");
  const cluster = RPC.includes("mainnet") ? "mainnet" : "devnet";
  const { queue } = switchboardEndpoints(cluster);
  console.log("queue =", queue.toBase58());

  const t0 = Date.now();
  const { randomnessAccount, fulfillSig } = await runSwitchboardCycle({
    connection, payer: owner, arenaProgram: arena,
    battlePda: bPda, arenaConfigPda: arenaConfig, queuePubkey: queue,
  });
  console.log(`Switchboard cycle done in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log("  randomness account:", randomnessAccount.toBase58());
  console.log("  fulfill sig:       ", fulfillSig);

  console.log("=== verify on-chain ===");
  const battle = await arena.account.battle.fetch(bPda);
  console.log("status:", battle.status, "(should be 2=DECIDED)");
  console.log("winner:", battle.winner.toBase58());
  console.log("seed:  ", battle.randomSeed.toString());

  if (battle.status !== 2) { console.error("❌ status not DECIDED"); process.exit(1); }
  console.log("\n🎉 SWITCHBOARD SMOKE OK — Option B working end-to-end");
})().catch((e) => { console.error("FATAL:", e); if (e.logs) console.error(e.logs.slice(-10).join("\n")); process.exit(1); });
