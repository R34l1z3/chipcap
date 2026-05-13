// ============================================================
// src/services/eventListener.js — Blockchain event listener
//
// 1. Connects via WebSocket RPC
// 2. Catches up from last indexed block (backfill)
// 3. Subscribes to live events
// 4. Writes cursor after each batch
// ============================================================

import { ethers } from "ethers";
import config from "../config/index.js";
import db from "../db/pool.js";
import { CHIP_NFT_ABI, BATTLE_ARENA_ABI } from "../utils/abis.js";
import {
  handleChipMinted,
  handleTransfer,
  handleBattleCreated,
  handleBattleJoined,
  handleBattleDecided,
  handleBattleSettledPaid,
  handleBattleSettledForfeited,
  handleBattleCancelled,
  handleBattleExpired,
  handleVRFTimedOut,
  handleWinningsWithdrawn,
} from "./eventHandler.js";

let provider = null;
let chipNFT = null;
let battleArena = null;
let isRunning = false;

// ============================================================
// Get / set cursor
// ============================================================
async function getCursor() {
  const { rows } = await db.query("SELECT last_block FROM indexer_cursor WHERE id = 1");
  return rows[0]?.last_block || config.indexer.startBlock;
}

async function setCursor(block) {
  await db.query(
    "UPDATE indexer_cursor SET last_block = $1, updated_at = NOW() WHERE id = 1",
    [block]
  );
}

// ============================================================
// Normalise event payload across ethers v6 shapes:
//   - queryFilter() returns EventLog directly
//   - contract.on() callback receives a ContractEventPayload whose `.log`
//     is the EventLog
// Returns an EventLog-like object with args/fragment/eventName/blockNumber/
// transactionHash/index/address.
// ============================================================
function normaliseLog(raw) {
  if (!raw) return raw;
  // ContractEventPayload has a `.log` (and convenience `.args`, `.fragment`).
  if (raw.log && raw.log.address) {
    const inner = raw.log;
    // Make sure args/fragment are reachable on the returned object even if
    // the inner EventLog already carries them.
    if (!inner.args && raw.args) inner.args = raw.args;
    if (!inner.fragment && raw.fragment) inner.fragment = raw.fragment;
    if (!inner.eventName && raw.eventName) inner.eventName = raw.eventName;
    return inner;
  }
  return raw;
}

// ============================================================
// Process a single log
// ============================================================
async function processLog(rawLog) {
  const log = normaliseLog(rawLog);
  try {
    const eventName = log.fragment?.name || log.eventName;

    switch (eventName) {
      case "ChipMinted":       return handleChipMinted(log);
      case "Transfer":         return handleTransfer(log);
      case "BattleCreated":    return handleBattleCreated(log);
      case "BattleJoined":     return handleBattleJoined(log);
      case "BattleDecided":    return handleBattleDecided(log);
      case "BattleSettledPaid": return handleBattleSettledPaid(log);
      case "BattleSettledForfeited": return handleBattleSettledForfeited(log);
      case "BattleCancelled":  return handleBattleCancelled(log);
      case "BattleExpired":    return handleBattleExpired(log);
      case "VRFTimedOut":      return handleVRFTimedOut(log);
      case "WinningsWithdrawn": return handleWinningsWithdrawn(log);
      default:
        console.log(`[IDX] Unknown event: ${eventName}`);
    }
  } catch (err) {
    console.error(`[IDX] Error processing ${log.transactionHash}:`, err.message);
  }
}

// ============================================================
// Backfill — catch up from last cursor to current block
// ============================================================
async function backfill() {
  const fromBlock = (await getCursor()) + 1;
  const currentBlock = await provider.getBlockNumber();
  const safeBlock = currentBlock - config.indexer.confirmations;

  if (fromBlock > safeBlock) {
    console.log(`[IDX] Already caught up (cursor=${fromBlock - 1}, chain=${currentBlock})`);
    return;
  }

  console.log(`[IDX] Backfilling blocks ${fromBlock} → ${safeBlock} (${safeBlock - fromBlock + 1} blocks)...`);

  // Process in chunks of 2000 blocks
  const CHUNK = 2000;
  for (let start = fromBlock; start <= safeBlock; start += CHUNK) {
    const end = Math.min(start + CHUNK - 1, safeBlock);

    // Fetch ChipNFT events
    const chipLogs = await chipNFT.queryFilter("*", start, end);
    for (const log of chipLogs) await processLog(log);

    // Fetch BattleArena events
    const battleLogs = await battleArena.queryFilter("*", start, end);
    for (const log of battleLogs) await processLog(log);

    await setCursor(end);

    if (config.isDev && (end - fromBlock) % 10000 < CHUNK) {
      console.log(`[IDX] Progress: block ${end} / ${safeBlock}`);
    }
  }

  console.log(`[IDX] Backfill complete. Cursor at block ${safeBlock}`);
}

// ============================================================
// Live listener — subscribe to new events
// ============================================================
function subscribeLive() {
  console.log("[IDX] Subscribing to live events...");

  const handle = (raw) => {
    const log = normaliseLog(raw);
    return processLog(log).then(() => {
      if (typeof log.blockNumber === "number") setCursor(log.blockNumber);
    });
  };

  // ChipNFT events
  chipNFT.on("ChipMinted", (...args) => handle(args[args.length - 1]));
  chipNFT.on("Transfer",   (...args) => handle(args[args.length - 1]));

  // BattleArena events
  const battleEvents = [
    "BattleCreated", "BattleJoined", "BattleDecided",
    "BattleSettledPaid", "BattleSettledForfeited",
    "BattleCancelled", "BattleExpired",
    "VRFTimedOut", "WinningsWithdrawn",
  ];

  for (const eventName of battleEvents) {
    battleArena.on(eventName, (...args) => handle(args[args.length - 1]));
  }

  console.log("[IDX] Live event subscription active");
}

// ============================================================
// Reconnection logic
// ============================================================
function setupReconnect() {
  provider.on("error", (err) => {
    console.error("[IDX] Provider error:", err.message);
  });

  // ethers v6 WebSocket provider disconnect handling.
  if (provider.websocket) {
    // Without an explicit 'error' listener, an underlying ws error
    // (ECONNREFUSED, ENETUNREACH, etc.) kills the entire process
    // via Node's "Unhandled 'error' event". Swallow + log instead;
    // 'close' will fire next and trigger a backoff reconnect.
    provider.websocket.on("error", (err) => {
      console.warn("[IDX] WebSocket error:", err.message || err);
    });

    provider.websocket.on("close", () => {
      console.warn("[IDX] WebSocket disconnected. Reconnecting in 5s...");
      // Must reset isRunning before scheduling, otherwise start() returns early.
      isRunning = false;
      setTimeout(() => start(), 5000);
    });
  }
}

// ============================================================
// Start
// ============================================================
export async function start() {
  if (isRunning) return;
  isRunning = true;

  try {
    // Connect
    if (config.rpc.ws.startsWith("ws")) {
      provider = new ethers.WebSocketProvider(config.rpc.ws);
      // Attach early so an immediate ECONNREFUSED on the underlying socket
      // doesn't take down the whole process before setupReconnect() runs.
      if (provider.websocket && typeof provider.websocket.on === "function") {
        provider.websocket.on("error", (err) => {
          console.warn("[IDX] WebSocket error (early):", err.message || err);
        });
      }
    } else {
      provider = new ethers.JsonRpcProvider(config.rpc.http);
    }

    const network = await provider.getNetwork();
    console.log(`[IDX] Connected to chain ${network.chainId}`);

    // Init contracts
    chipNFT = new ethers.Contract(config.contracts.chipNFT, CHIP_NFT_ABI, provider);
    battleArena = new ethers.Contract(config.contracts.battleArena, BATTLE_ARENA_ABI, provider);

    // Backfill missed events
    await backfill();

    // Subscribe to live events
    subscribeLive();
    setupReconnect();

    console.log("[IDX] Indexer running");
  } catch (err) {
    console.error("[IDX] Start failed:", err.message);
    isRunning = false;
    console.log("[IDX] Retrying in 10s...");
    setTimeout(() => start(), 10000);
  }
}

export function getProvider() {
  return provider;
}
