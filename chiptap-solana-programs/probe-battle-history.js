const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {});
anchor.setProvider(provider);
const arenaIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "target/idl/battle_arena.json")));
const arena = new anchor.Program(arenaIdl, provider);
const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, arena.programId)[0];
const battle1 = pda([enc("battle"), new anchor.BN(1).toArrayLike(Buffer, "le", 8)]);

(async () => {
  console.log("battle #1 PDA:", battle1.toBase58());
  const sigs = await connection.getSignaturesForAddress(battle1, { limit: 50 });
  console.log("touched by", sigs.length, "tx:");
  for (const s of sigs.reverse()) {
    const tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const ixName = (tx.meta?.logMessages || []).find(l => l.startsWith("Program log: Instruction:")) || "?";
    console.log(`  ${s.signature.slice(0,16)}  ${s.err ? "FAILED" : "OK"}  ${ixName}`);
  }
  // Same for chip A asset
  const chipA = new PublicKey("FXcwKf8sRJYtvXasqcUjBGRZP6WgjW4nTk4KKo3nXcxr");
  console.log("\nchip A (FXcwKf8s) tx history:");
  const sigs2 = await connection.getSignaturesForAddress(chipA, { limit: 50 });
  for (const s of sigs2.reverse()) {
    const tx = await connection.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
    if (!tx) continue;
    const ix = (tx.meta?.logMessages || []).find(l => l.startsWith("Program log: Instruction:")) || "?";
    console.log(`  ${s.signature.slice(0,16)}  ${s.err ? "FAILED" : "OK"}  ${ix}`);
  }
})();
