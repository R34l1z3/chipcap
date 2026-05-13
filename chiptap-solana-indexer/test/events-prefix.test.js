// ============================================================
// test/events-prefix.test.js — regression for SEC-12
//
// Confirms decodeEventsFromLogs() only fires when a line *starts*
// with "Program data: ".  Substring matches (e.g. a `msg!()` log
// quoting that phrase) must NOT be parsed as events.
// ============================================================

import { strict as assert } from "node:assert";
import * as anchor from "@coral-xyz/anchor";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeEventsFromLogs } from "../src/utils/events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const arenaIdl = JSON.parse(
  fs.readFileSync(path.join(here, "..", "idl", "battle_arena.json"), "utf8"),
);
const coders = { arena: new anchor.BorshEventCoder(arenaIdl) };

// Build a real event payload so we can compare against the false-positive case.
function encodeEvent(name, data) {
  // Discriminator is sha256("event:<Name>")[..8]; BorshEventCoder doesn't
  // expose encode for events directly, so we replay one we know works:
  // grab the discriminator from the IDL, append a borsh-encoded payload.
  // For this test we only need the *prefix* — pad with zeros to avoid
  // accidentally encoding a valid event when we don't want one.
  const ev = arenaIdl.events.find((e) => e.name === name);
  if (!ev) throw new Error(`event ${name} not in IDL`);
  return Buffer.concat([Buffer.from(ev.discriminator), data]).toString("base64");
}

// 1. Real Program-data line at the start of the string → decoded.
const realPayload = encodeEvent("BattleCancelled", Buffer.concat([
  Buffer.alloc(8, 0x01),               // battle_id = 1 (LE)
  Buffer.alloc(32, 0),                 // player_a pubkey (32 bytes)
]));
const positive = decodeEventsFromLogs([`Program data: ${realPayload}`], coders);
assert.equal(positive.length, 1,                "real Program data line decodes");
assert.equal(positive[0].event, "BattleCancelled", "real line yields BattleCancelled");

// 2. A `msg!()` containing the literal substring must NOT be parsed.
const negative = decodeEventsFromLogs(
  [`Program log: Program data: ${realPayload}`],
  coders,
);
assert.equal(negative.length, 0, "msg!() with 'Program data: ' substring is ignored");

// 3. The `Program log: …` prefix alone is irrelevant noise.
const noise = decodeEventsFromLogs([
  "Program 11111111111111111111111111111111 invoke [1]",
  "Program log: Instruction: PayRansom",
  "Program log: Hello, Program data: world",     // <- decoy
  "Program 11111111111111111111111111111111 success",
], coders);
assert.equal(noise.length, 0, "no decoy log line is decoded as an event");

console.log("OK — startsWith gate keeps msg!() substrings out");
process.exit(0);
