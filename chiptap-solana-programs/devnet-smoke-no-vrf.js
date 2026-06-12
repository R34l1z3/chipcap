// Same as devnet-smoke but does NOT trigger VRF — relayer should
// auto-fulfill via the configured RANDOMNESS_SOURCE (slothash or
// switchboard).  Used to validate the running relayer end-to-end.
const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, sendAndConfirmTransaction,
} = require("@solana/web3.js");

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

const idlDir = path.join(__dirname, "target", "idl");
const chipNftIdl = JSON.parse(fs.readFileSync(path.join(idlDir, "chip_nft.json")));
const arenaIdl   = JSON.parse(fs.readFileSync(path.join(idlDir, "battle_arena.json")));
const chipNft = new anchor.Program(chipNftIdl, provider);
const arena   = new anchor.Program(arenaIdl, provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const arenaConfig   = pda([enc("arena")], arena.programId);
const chipAuthority = pda([enc("arena"), enc("chip_authority")], arena.programId);
const battlePda     = (id) => pda([enc("battle"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);
const chipDataPda   = (a)  => pda([enc("chip"), a.toBuffer()], chipNft.programId);

async function fund(to, sol) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.floor(sol * LAMPORTS_PER_SOL),
  }));
  return sendAndConfirmTransaction(connection, tx, [owner]);
}
async function mintFor(player) {
  const asset = Keypair.generate();
  await chipNft.methods.mintChip("ChipTap", "https://chiptap.gg/metadata/0.json").accounts({
    config: chipNftConfig, vault: chipNftVault,
    asset: asset.publicKey, chipData: chipDataPda(asset.publicKey),
    payer: player.publicKey, mplCore: MPL_CORE,
    systemProgram: SystemProgram.programId,
  }).signers([player, asset]).rpc();
  return asset.publicKey;
}

(async () => {
  const a = Keypair.generate(); const b = Keypair.generate();
  await fund(a.publicKey, 0.05); await fund(b.publicKey, 0.05);
  console.log("playerA:", a.publicKey.toBase58().slice(0,8), "playerB:", b.publicKey.toBase58().slice(0,8));

  const chipA = await mintFor(a);
  const chipB = await mintFor(b);

  const cfg = await arena.account.arenaConfig.fetch(arenaConfig);
  const id = cfg.nextBattleId.toString();
  const bPda = battlePda(id);
  console.log("battleId =", id);

  await arena.methods.createBattle(0).accounts({
    config: arenaConfig, battle: bPda, chipAuthority,
    chip: chipA, player: a.publicKey,
    mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([a]).rpc();

  await arena.methods.joinBattle().accounts({
    config: arenaConfig, battle: bPda, chipAuthority,
    chip: chipB, player: b.publicKey,
    mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([b]).rpc();
  console.log("joined — status=ROLLING, waiting for relayer...");

  const t0 = Date.now();
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2_000));
    const battle = await arena.account.battle.fetch(bPda);
    process.stdout.write(`\rstatus=${battle.status} elapsed=${((Date.now()-t0)/1000).toFixed(1)}s `);
    if (battle.status === 2) {
      console.log(`\n\n🎉 RELAYER AUTO-FULFILLED battle #${id} via ${process.env.EXPECT_MODE || "configured source"}`);
      console.log("  winner:", battle.winner.toBase58());
      console.log("  seed:  ", battle.randomSeed.toString());
      process.exit(0);
    }
  }
  console.error("\n❌ relayer didn't fulfill in 60s");
  process.exit(1);
})().catch(e => { console.error(e); process.exit(1); });
