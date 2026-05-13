// ============================================================
// src/utils/idl.js
//
// Loads Anchor IDLs (must be present at indexer startup).
// Indexer is decoupled from Rust — it reads JSON only.  Replace
// the placeholder files in `idl/` with real outputs from
//   `anchor build` → `chiptap-solana-programs/target/idl/*.json`
// after the first build.
// ============================================================

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { BorshEventCoder } from "@coral-xyz/anchor";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IDL_DIR  = join(__dirname, "..", "..", "idl");

function load(name) {
  const path = join(IDL_DIR, `${name}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `IDL not found at ${path}\n` +
      `Copy from chiptap-solana-programs/target/idl/${name}.json after \`anchor build\``
    );
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadIdls() {
  const battleArena = load("battle_arena");
  const chipNft     = load("chip_nft");
  const treasury    = load("treasury");
  return {
    battleArena,
    chipNft,
    treasury,
    coders: {
      battleArena: new BorshEventCoder(battleArena),
      chipNft:     new BorshEventCoder(chipNft),
      treasury:    new BorshEventCoder(treasury),
    },
  };
}
