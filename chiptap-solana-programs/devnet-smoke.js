// ============================================================
// devnet-smoke.js — create+join a battle on devnet, then watch the
// relayer auto-fulfill VRF.  Funds two throwaway players from the
// owner wallet (SOL transfer, no airdrop — devnet airdrop is
// rate-limited).
//
// Pre: relayer must be running with vrf_authority = owner pubkey.
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, sendAndConfirmTransaction,
} = require("@solana/web3.js");

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection(
  process.env.SOLANA_RPC || "https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

const idlDir = path.join(__dirname, "target", "idl");
const treasuryIdl = JSON.parse(fs.readFileSync(path.join(idlDir, "treasury.json")));
const chipNftIdl  = JSON.parse(fs.readFileSync(path.join(idlDir, "chip_nft.json")));
const arenaIdl    = JSON.parse(fs.readFileSync(path.join(idlDir, "battle_arena.json")));
const treasury = new anchor.Program(treasuryIdl, provider);
const chipNft  = new anchor.Program(chipNftIdl,  provider);
const arena    = new anchor.Program(arenaIdl,    provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];
const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const arenaConfig   = pda([enc("arena")], arena.programId);
const chipAuthority = pda([enc("arena"), enc("chip_authority")], arena.programId);
const chipDataPda   = (a)  => pda([enc("chip"), a.toBuffer()], chipNft.programId);
const battlePda     = (id) => pda([enc("battle"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);

const log     = (...a) => console.log("•", ...a);
const section = (s)    => console.log(`\n===== ${s} =====`);

async function fund(to, sol) {
  const ix = SystemProgram.transfer({
    fromPubkey: owner.publicKey,
    toPubkey:   to,
    lamports:   Math.floor(sol * LAMPORTS_PER_SOL),
  });
  const tx = new Transaction().add(ix);
  await sendAndConfirmTransaction(connection, tx, [owner]);
}

async function mintFor(player) {
  const asset = Keypair.generate();
  await chipNft.methods.mintChip("ChipTap", "https://chiptap.gg/metadata/0.json")
    .accounts({
      config: chipNftConfig, vault: chipNftVault,
      asset: asset.publicKey, chipData: chipDataPda(asset.publicKey),
      payer: player.publicKey, mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([player, asset]).rpc();
  return asset.publicKey;
}

(async () => {
  section("setup");
  const playerA = Keypair.generate();
  const playerB = Keypair.generate();
  log("playerA:", playerA.publicKey.toBase58().slice(0,8), "…");
  log("playerB:", playerB.publicKey.toBase58().slice(0,8), "…");

  await fund(playerA.publicKey, 0.05);
  await fund(playerB.publicKey, 0.05);
  log("funded each with 0.05 SOL");

  section("mint chips");
  const chipA = await mintFor(playerA);
  const chipB = await mintFor(playerB);
  log("chipA:", chipA.toBase58().slice(0,8), "  chipB:", chipB.toBase58().slice(0,8));

  section("create battle (tier 0 = 0.05 SOL)");
  const cfg = await arena.account.arenaConfig.fetch(arenaConfig);
  const battleId = cfg.nextBattleId.toString();
  const bPda = battlePda(battleId);
  log("battleId =", battleId);

  await arena.methods.createBattle(0).accounts({
    config: arenaConfig, battle: bPda, chipAuthority,
    chip: chipA, player: playerA.publicKey,
    mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([playerA]).rpc();
  log("create OK");

  section("join");
  await arena.methods.joinBattle().accounts({
    config: arenaConfig, battle: bPda, chipAuthority,
    chip: chipB, player: playerB.publicKey,
    mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([playerB]).rpc();
  log("join OK — status should now be ROLLING (1)");

  section("waiting for relayer to fulfill...");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const b = await arena.account.battle.fetch(bPda);
    log(`status=${b.status}`, b.status === 2 ? "(DECIDED — relayer worked!)" : "(still ROLLING)");
    if (b.status === 2) {
      log("winner:", b.winner.toBase58().slice(0,8));
      console.log("\n🎉 RELAYER OK — battle auto-fulfilled by Switchboard Option A relayer");
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.error("\n❌ TIMEOUT — relayer did not fulfill within 60s");
  console.error("   Check relayer logs.  Is it running?  Is the vrf_authority right?");
  process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
