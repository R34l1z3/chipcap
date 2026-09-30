// ============================================================
// src/services/chipOwnerReconcile.js — SEC-29
// ============================================================
//
// `chips.owner` is derived from events (mint, market fill, battle
// forfeit).  That has two holes events alone can't close:
//
//   • Order.  Backfill runs program by program, so after downtime a
//     market fill or forfeit can be processed BEFORE the chip's own
//     ChipMinted — the UPDATE finds no row, then the late mint inserts
//     the minter as owner.  (Seen live: a chip sold on 2026-07-29 was
//     indexed on 08-06 still owned by the seller.)
//   • Transfers outside the game.  A player can send a chip wallet to
//     wallet with plain mpl-core; none of our programs is involved, so
//     no event ever reaches the indexer.
//
// So the chain is asked directly, periodically: read each asset's
// mpl-core owner and correct the row.  One RPC call per 100 chips.
//
// Escrow is the exception.  While a chip sits with a program — the
// arena's chip_authority (battle / royale / tournament) or the market's
// authority (listed) — the on-chain owner is that PDA, but the chip
// still BELONGS to the player who put it there.  For those, the event-
// derived owner stands and only `listed` is corrected.
// ============================================================

import { PublicKey } from "@solana/web3.js";
import config from "../config/index.js";
import db from "../db/pool.js";

const BATCH = 100;                 // getMultipleAccountsInfo limit
const MPL_ASSET_V1 = 1;            // mpl-core Key discriminant for AssetV1

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, programId) =>
  PublicKey.findProgramAddressSync(seeds, new PublicKey(programId))[0].toBase58();

let lastRun = null;
export function getReconcileState() { return lastRun; }

export async function reconcileChipOwners(connection) {
  const chipAuthority = pda([enc("arena"), enc("chip_authority")], config.programs.battleArena);
  const marketAuthority = config.programs.marketplace
    ? pda([enc("market"), enc("authority")], config.programs.marketplace)
    : null;

  const started = Date.now();
  let checked = 0, ownerFixed = 0, listedFixed = 0;
  try {
    const { rows } = await db.query("SELECT asset, owner, listed FROM chips");
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH);
      const infos = await connection.getMultipleAccountsInfo(
        batch.map((r) => new PublicKey(r.asset)),
      );
      for (let k = 0; k < batch.length; k++) {
        const row  = batch[k];
        const info = infos[k];
        // Burned, closed, or not an mpl-core asset — nothing to compare.
        if (!info || info.data.length < 33 || info.data[0] !== MPL_ASSET_V1) continue;
        checked++;

        const holder = new PublicKey(info.data.subarray(1, 33)).toBase58();
        const inMarket = holder === marketAuthority;

        if (holder === chipAuthority || inMarket) {
          if (Boolean(row.listed) !== inMarket) {
            await db.query("UPDATE chips SET listed = $1 WHERE asset = $2", [inMarket, row.asset]);
            listedFixed++;
          }
          continue;
        }

        if (holder !== row.owner || row.listed) {
          await db.query(
            "UPDATE chips SET owner = $1, listed = FALSE WHERE asset = $2",
            [holder, row.asset],
          );
          ownerFixed++;
        }
      }
    }
    lastRun = {
      at: new Date().toISOString(), ok: true, checked, ownerFixed, listedFixed,
      ms: Date.now() - started,
    };
    if (ownerFixed || listedFixed) {
      console.log(`[IDX] chip reconcile: ${ownerFixed} owner / ${listedFixed} listed fixed (of ${checked})`);
    }
  } catch (err) {
    lastRun = { at: new Date().toISOString(), ok: false, error: err.message, checked, ownerFixed, listedFixed };
    console.error("[IDX] chip reconcile failed:", err.message);
  }
  return lastRun;
}
