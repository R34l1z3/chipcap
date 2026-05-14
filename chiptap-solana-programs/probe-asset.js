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
const chipAuth = pda([enc("arena"), enc("chip_authority")]);
console.log("chip_authority PDA =", chipAuth.toBase58());

(async () => {
  const assets = ["FXcwKf8sRJYtvXasqcUjBGRZP6WgjW4nTk4KKo3nXcxr",
                  "AEDHjY2vrwhXGZ8Ft8r6u62sKXms3hz677KwAHazy4pN"];
  for (const k of assets) {
    const acc = await connection.getAccountInfo(new PublicKey(k));
    if (!acc) { console.log(k, "MISSING ON CHAIN"); continue; }
    // mpl-core Asset layout: key(1) + owner(32) + ... — owner is bytes 1..33
    const owner = new PublicKey(acc.data.slice(1, 33)).toBase58();
    console.log(`asset ${k.slice(0,8)}: owner = ${owner}`);
  }
})();
