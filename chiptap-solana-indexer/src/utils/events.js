// ============================================================
// src/utils/events.js — extract Anchor events from a tx's logs
// ============================================================
//
// Anchor's `emit!(MyEvent { … })` lowers to `sol_log_data(&[bytes])`,
// which Solana's runtime renders as a *line that starts with* the
// literal:
//
//     Program data: <base64>
//
// SEC-12 — previously this code used `indexOf(PROGRAM_DATA_PREFIX)`,
// which would also match lines like
//
//     Program log: Program data: hello
//
// (a benign `msg!("Program data: …")` from any program in the tx).
// At best it wastes CPU on doomed `BorshEventCoder.decode()` calls; at
// worst a malicious / unlucky payload could coerce a false-positive
// event of the wrong shape and let the indexer write garbage rows.
// `startsWith` is the documented contract.

const PROGRAM_DATA_PREFIX = "Program data: ";

/**
 * Walk Solana log messages and yield decoded events.
 * @param {string[]} logs       transaction.meta.logMessages
 * @param {object}   coders     { name: BorshEventCoder }
 * @returns {Array<{program: string, event: string, data: any}>}
 */
export function decodeEventsFromLogs(logs, coders) {
  const out = [];
  if (!Array.isArray(logs)) return out;

  for (const line of logs) {
    if (typeof line !== "string") continue;
    if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
    const b64 = line.slice(PROGRAM_DATA_PREFIX.length).trim();
    if (!b64) continue;

    for (const [name, coder] of Object.entries(coders)) {
      try {
        const decoded = coder.decode(b64);
        if (decoded && decoded.name) {
          out.push({ program: name, event: decoded.name, data: decoded.data });
          break; // matched exactly one
        }
      } catch {
        // not this coder's event; keep trying
      }
    }
  }
  return out;
}
