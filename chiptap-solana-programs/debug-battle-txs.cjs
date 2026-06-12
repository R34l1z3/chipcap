// One-shot: list recent transactions touching battle PDAs #25/#28/#29
// and print errors + logs for the failed ones.
const { Connection, PublicKey } = require(
  "../chiptap-solana-frontend/node_modules/@solana/web3.js");

const ARENA = new PublicKey("Ae65nkzg2DD4dFUttxUXPpVfZT7kMPX1L9Uk9GDxkBU8");
const RPC = "https://api.devnet.solana.com";

function battlePda(id) {
  const le = Buffer.alloc(8);
  le.writeBigUInt64LE(BigInt(id));
  return PublicKey.findProgramAddressSync(
    [Buffer.from("battle"), le], ARENA)[0];
}

(async () => {
  const conn = new Connection(RPC, "confirmed");
  for (const id of [25, 28, 29]) {
    const pda = battlePda(id);
    console.log(`\n=== battle #${id} → ${pda.toBase58()} ===`);
    const sigs = await conn.getSignaturesForAddress(pda, { limit: 15 });
    for (const s of sigs) {
      const t = new Date((s.blockTime || 0) * 1000).toISOString().slice(5, 16);
      console.log(`${t} ${s.err ? "FAIL" : " ok "} ${s.signature.slice(0, 16)}… ${s.memo || ""}`);
      if (s.err) {
        const tx = await conn.getTransaction(s.signature, {
          maxSupportedTransactionVersion: 0 });
        const logs = tx?.meta?.logMessages || [];
        // print the interesting tail: program error lines
        for (const l of logs.slice(-12)) console.log("      " + l);
      }
    }
  }
})();
