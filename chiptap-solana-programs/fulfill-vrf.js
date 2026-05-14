// One-shot helper: call fulfill_random_words for a given battle id.
// Usage: node fulfill-vrf.js <battleId> [seed]
const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");

const battleId = process.argv[2];
const seed = BigInt(process.argv[3] || "42");
if (!battleId) { console.error("usage: node fulfill-vrf.js <battleId> [seed]"); process.exit(1); }

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner),
  { commitment: "confirmed", preflightCommitment: "confirmed" });
anchor.setProvider(provider);

const arenaIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "target/idl/battle_arena.json")));
const arena = new anchor.Program(arenaIdl, provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, arena.programId)[0];
const arenaConfig = pda([enc("arena")]);
const battlePda = pda([enc("battle"), new anchor.BN(battleId).toArrayLike(Buffer, "le", 8)]);

(async () => {
  const sig = await arena.methods.fulfillRandomWords(new anchor.BN(seed))
    .accounts({ config: arenaConfig, battle: battlePda, vrfAuthority: owner.publicKey })
    .signers([owner]).rpc();
  console.log("fulfill sig:", sig);
  const b = await arena.account.battle.fetch(battlePda);
  console.log("status:", b.status, "  winner:", b.winner.toBase58(), "  loser:", b.loser.toBase58());
})().catch(e => { console.error(e); process.exit(1); });
