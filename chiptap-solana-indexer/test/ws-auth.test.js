// ============================================================
// test/ws-auth.test.js — SEC-13 regression
//
// Verifies the WS server rejects connections without the right token
// when WS_TOKEN is configured.  Requires the indexer to be running
// with WS_TOKEN=secret123 on port 3003.
// ============================================================

import { strict as assert } from "node:assert";
import WebSocket from "ws";

// Resolves after we're confident the connection's terminal state is
// known.  Auth rejection looks like: open → close(4401) within ~50 ms,
// so we don't resolve on `open` alone — we wait ~500 ms past it.
function connect(url, settleMs = 500) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url);
    let didClose = false;
    let closeCode, closeReason;
    let openTimer = null;
    ws.on("open", () => {
      openTimer = setTimeout(() => {
        if (didClose) {
          resolve({ closed: true, code: closeCode, reason: closeReason });
        } else {
          resolve({ open: true, ws });
        }
      }, settleMs);
    });
    ws.on("close", (code, reason) => {
      didClose = true;
      closeCode = code;
      closeReason = reason.toString();
      if (openTimer) {
        clearTimeout(openTimer);
        resolve({ closed: true, code, reason: closeReason });
      } else {
        // close before open ever fired — handshake refused
        resolve({ closed: true, code, reason: closeReason });
      }
    });
    ws.on("error", () => { /* close fires after */ });
  });
}

const WS    = process.env.WS_URL   || "ws://localhost:3003";
const TOKEN = process.env.WS_TOKEN || "secret123";

// 1. No token → reject 4401
const noTok = await connect(WS);
assert.ok(noTok.closed, "connection without token must close");
assert.equal(noTok.code, 4401, `expected close code 4401, got ${noTok.code}`);
console.log(`✓ no token → close ${noTok.code} ${noTok.reason}`);

// 2. Wrong token → reject 4401
const badTok = await connect(`${WS}/?token=wrong`);
assert.ok(badTok.closed, "wrong-token connection must close");
assert.equal(badTok.code, 4401, `expected 4401, got ${badTok.code}`);
console.log(`✓ wrong token → close ${badTok.code} ${badTok.reason}`);

// 3. Right token → opens AND receives a `connected` event.  We capture
// the first message via an early listener (it arrives within ~10 ms
// of open, before our 500 ms settle window expires).
const okMsg = await new Promise((resolve, reject) => {
  const ws = new WebSocket(`${WS}/?token=${encodeURIComponent(TOKEN)}`);
  const t = setTimeout(() => { try { ws.terminate(); } catch {} reject(new Error("timeout")); }, 3000);
  ws.on("message", (m) => {
    clearTimeout(t);
    try { ws.close(); } catch {}
    resolve(JSON.parse(m.toString()));
  });
  ws.on("close", (code) => {
    if (code !== 1000 && code !== 1005) reject(new Error(`unexpected close ${code}`));
  });
  ws.on("error", () => { /* close fires after */ });
});
assert.equal(okMsg.type, "connected", "expected initial `connected` event");
console.log(`✓ correct token → connected event received`);

console.log("\nOK — WS auth gates work");
process.exit(0);
