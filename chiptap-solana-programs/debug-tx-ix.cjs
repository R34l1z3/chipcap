// Decode which instruction each battle tx invoked (from program logs).
const { Connection } = require(
  "../chiptap-solana-frontend/node_modules/@solana/web3.js");
const RPC = "https://api.devnet.solana.com";
const sigs = process.argv.slice(2);
(async () => {
  const conn = new Connection(RPC, "confirmed");
  for (const sig of sigs) {
    const tx = await conn.getTransaction(sig, { maxSupportedTransactionVersion: 0 });
    const logs = tx?.meta?.logMessages || [];
    const ixs = logs.filter((l) => l.includes("Instruction:"));
    const t = new Date((tx?.blockTime || 0) * 1000).toISOString().slice(5, 16);
    console.log(t, sig.slice(0, 12), "→", ixs.map((l) => l.split("Instruction: ")[1]).join(", "),
      tx?.meta?.err ? "ERR " + JSON.stringify(tx.meta.err) : "");
  }
})();
