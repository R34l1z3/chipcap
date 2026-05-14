// ============================================================
// src/randomness.js — pluggable randomness sources
//
// Each exported function returns a Uint8Array of 8 bytes interpretable
// as a u64 LE seed for fulfill_random_words.  All sources are
// deterministic given the inputs so we can replay if needed.
// ============================================================

import { createHash } from "node:crypto";

/**
 * Derive a u64 seed from a recent slothash + the battle id.
 * Validator-leader could in theory influence the slothash, but with
 * unpredictable battle-id timing this is hard to game on a busy chain.
 * Fine for low-stake battles.
 *
 * @param {import("@solana/web3.js").Connection} connection
 * @param {bigint|number|string} battleId
 * @returns {Promise<bigint>} u64 seed
 */
export async function fromSlotHash(connection, battleId) {
  // getRecentBlockhash is deprecated; getLatestBlockhash gives us a
  // recent confirmed blockhash which is functionally a slothash for
  // randomness purposes.
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  // Mix the blockhash with battle id so two concurrent battles in the
  // same slot don't produce the same seed.
  const idBuf = Buffer.alloc(8);
  idBuf.writeBigUInt64LE(BigInt(battleId));
  const digest = createHash("sha256")
    .update(blockhash)
    .update(idBuf)
    .digest();
  // First 8 bytes as u64 LE.
  return digest.readBigUInt64LE(0);
}

/**
 * Stub for Switchboard On-Demand integration (Option B precursor).
 * NOT IMPLEMENTED — falls back to throwing so we explicitly choose.
 *
 * To wire up:
 *   1. npm i @switchboard-xyz/on-demand
 *   2. Implement create / commit / reveal sequence per their docs
 *   3. Take first 8 bytes of revealed value as u64 LE seed
 */
export async function fromSwitchboard(_connection, _battleId) {
  throw new Error(
    "Switchboard randomness not yet implemented — set RANDOMNESS_SOURCE=slothash. " +
    "See chiptap-solana-programs/SWITCHBOARD.md for the integration plan.",
  );
}

export function pickSource(name) {
  switch (name) {
    case "slothash":    return fromSlotHash;
    case "switchboard": return fromSwitchboard;
    default:
      throw new Error(`Unknown RANDOMNESS_SOURCE=${name}; valid: slothash, switchboard`);
  }
}
