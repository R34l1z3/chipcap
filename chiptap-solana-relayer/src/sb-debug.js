// Diagnostic: load Switchboard randomness accounts we created during
// the smoke and print their decoded state — focus on oracle + value.
import { Connection, PublicKey } from "@solana/web3.js";
import sb from "@switchboard-xyz/on-demand";
const { Randomness, AnchorUtils, Oracle, Queue } = sb;

const RPC = "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");

const ACCOUNTS = process.argv.slice(2);
if (ACCOUNTS.length === 0) {
  console.log("usage: node sb-debug.js <account1> [account2 ...]");
  process.exit(1);
}

const sbProgram = await AnchorUtils.loadProgramFromConnection(connection);
console.log("SB program:", sbProgram.programId.toBase58());
console.log();

for (const addr of ACCOUNTS) {
  console.log(`=== ${addr} ===`);
  try {
    const rnd = new Randomness(sbProgram, new PublicKey(addr));
    const d = await rnd.loadData();
    console.log("  ALL FIELDS:", Object.keys(d).join(", "));
    console.log("  authority:    ", d.authority.toBase58());
    console.log("  queue:        ", d.queue.toBase58());
    console.log("  oracle:       ", d.oracle.toBase58(), d.oracle.toBase58() === "11111111111111111111111111111111" ? "← UNASSIGNED" : "");
    console.log("  seed_slot:    ", d.seedSlot.toString());
    console.log("  value_slot:   ", d.valueSlot?.toString?.() ?? d.valueSlot);
    console.log("  seed_slothash bytes (head):", Buffer.from(d.seedSlothash).slice(0, 8).toString("hex"));
    console.log("  value bytes (head):        ", Buffer.from(d.value).slice(0, 8).toString("hex"));
    console.log("  value_slot > seed_slot:", Number(d.valueSlot.toString()) > Number(d.seedSlot.toString()) ? "YES (revealed)" : "no");

    // If an oracle is assigned, try fetching its data + gateway URL
    if (d.oracle.toBase58() !== "11111111111111111111111111111111") {
      const oracle = new Oracle(sbProgram, d.oracle);
      const od = await oracle.loadData();
      const url = String.fromCharCode(...od.gatewayUri).replace(/\0+$/, '');
      console.log("  oracle gateway URL:", url || "(empty)");
      if (url) {
        try {
          const r = await fetch(url, { method: "GET" }).then(r => `${r.status} ${r.statusText}`);
          console.log("  GET", url, "→", r);
        } catch (e) {
          console.log("  GET", url, "→ ERROR:", e.message);
        }
      }
    }
  } catch (e) {
    console.log("  load failed:", e.message);
  }
  console.log();
}
