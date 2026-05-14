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

(async () => {
  const cfgKey = pda([enc("arena")]);
  const cfg = await arena.account.arenaConfig.fetch(cfgKey);
  console.log("ArenaConfig.next_battle_id =", cfg.nextBattleId.toString());
  const auth = pda([enc("arena"), enc("chip_authority")]);
  console.log("chip_authority PDA =", auth.toBase58());

  const ids = [1, 2, 3];
  for (const id of ids) {
    const bPda = pda([enc("battle"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)]);
    const info = await connection.getAccountInfo(bPda);
    if (!info) { console.log(`battle #${id}: NOT ON CHAIN`); continue; }
    const b = await arena.account.battle.fetch(bPda);
    console.log(`battle #${id}: status=${b.status} chipA=${b.chipA.toBase58()} chipB=${b.chipB.toBase58()}`);
    for (const [label, key] of [["chipA", b.chipA], ["chipB", b.chipB]]) {
      const a = await connection.getAccountInfo(key);
      if (!a) { console.log(`   ${label}: NO ASSET ON CHAIN`); continue; }
      console.log(`   ${label} owner = ${new PublicKey(a.data.slice(1, 33)).toBase58()}`);
    }
  }
})();
