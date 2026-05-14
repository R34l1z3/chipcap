// ============================================================
// src/smoke.js — relayer health-check
//
// Pings the configured RPC, loads the IDL, and prints the wallet
// address + balance.  Doesn't watch anything.  Use to verify
// configuration before running the full service.
// ============================================================

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const rpc  = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const keypairPath = process.env.VRF_AUTHORITY_KEYPAIR || `${process.env.HOME}/.config/solana/id.json`;
const programId = new PublicKey(process.env.BATTLE_ARENA_PROGRAM || "Ae65nkzg2DD4dFUttxUXPpVfZT7kMPX1L9Uk9GDxkBU8");

console.log("RPC:               ", rpc);
console.log("Keypair file:      ", keypairPath);
console.log("Program ID:        ", programId.toBase58());
console.log("Randomness source: ", process.env.RANDOMNESS_SOURCE || "slothash");

const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
console.log("vrf_authority pubkey:", kp.publicKey.toBase58());

const c = new Connection(rpc, "confirmed");
const bal = await c.getBalance(kp.publicKey);
console.log("vrf_authority balance:", (bal / 1e9).toFixed(6), "SOL");

// Sanity: is the IDL parseable?
const idl = JSON.parse(fs.readFileSync(path.join(here, "..", "idl", "battle_arena.json"), "utf8"));
const ev  = idl.events?.find((e) => e.name === "BattleJoined");
console.log("IDL ok:", !!ev, "  has BattleJoined event:", !!ev);

// Sanity: is the program executable on the configured network?
const acc = await c.getAccountInfo(programId);
if (!acc || !acc.executable) {
  console.error("❌ program is NOT executable on this RPC — wrong network?");
  process.exit(1);
}
console.log("✅ program is executable on this RPC");
