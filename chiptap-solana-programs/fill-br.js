// ============================================================
// fill-br.js — One-off helper: fill N slots of an existing BR with
// throwaway players. Used to test BR end-to-end without coordinating
// multiple human wallets.
//
//   BR_ID=16 SLOTS_TO_FILL=3 node fill-br.js
//
// Each throwaway:
//   1. funded with 0.1 SOL from owner (covers stake + mint + rent + fees)
//   2. mints a Common chip via chip_nft
//   3. joinBattleRoyale (preix: ensure_user_account + deposit(stake + buf))
//
// After this completes, the BR has N more players.  If N == max_players,
// status flips to ROLLING and the relayer auto-fulfills via Switchboard.
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, sendAndConfirmTransaction,
} = require("@solana/web3.js");

const BR_ID         = parseInt(process.env.BR_ID || "16", 10);
const SLOTS_TO_FILL = parseInt(process.env.SLOTS_TO_FILL || "3", 10);
const RPC           = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

const idlDir = path.join(__dirname, "target", "idl");
const chipNftIdl = JSON.parse(fs.readFileSync(path.join(idlDir, "chip_nft.json")));
const arenaIdl   = JSON.parse(fs.readFileSync(path.join(idlDir, "battle_arena.json")));
const chipNft = new anchor.Program(chipNftIdl, provider);
const arena   = new anchor.Program(arenaIdl,   provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const arenaConfig   = pda([enc("arena")], arena.programId);
const arenaVault    = pda([enc("arena"), enc("vault")], arena.programId);
const chipAuthority = pda([enc("arena"), enc("chip_authority")], arena.programId);
const userPda    = (auth) => pda([enc("user"), auth.toBuffer()], arena.programId);
const royalePda  = (id)   => pda([enc("royale"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);
const chipDataPda = (a)   => pda([enc("chip"), a.toBuffer()], chipNft.programId);

const log = (...a) => console.log("•", ...a);

async function fund(to, sol) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: owner.publicKey, toPubkey: to,
    lamports: Math.floor(sol * LAMPORTS_PER_SOL),
  }));
  return sendAndConfirmTransaction(connection, tx, [owner]);
}

async function mintFor(player) {
  const asset = Keypair.generate();
  await chipNft.methods.mintChip(0, "ChipTap", "https://chiptap.gg/metadata/0.json")
    .accounts({
      config: chipNftConfig, vault: chipNftVault,
      asset: asset.publicKey, chipData: chipDataPda(asset.publicKey),
      payer: player.publicKey, mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    }).signers([player, asset]).rpc();
  return asset.publicKey;
}

async function joinBr(player, chip, brId, stakeLamports) {
  const rPda = royalePda(brId);
  const u = userPda(player.publicKey);

  const ensureIx = await arena.methods.ensureUserAccount()
    .accounts({ user: u, authority: player.publicKey, payer: player.publicKey, systemProgram: SystemProgram.programId })
    .instruction();
  const depositIx = await arena.methods.deposit(new anchor.BN(stakeLamports + 1_000_000))
    .accounts({ config: arenaConfig, vault: arenaVault, user: u, payer: player.publicKey, systemProgram: SystemProgram.programId })
    .instruction();

  return arena.methods.joinBattleRoyale()
    .accounts({
      config: arenaConfig, royale: rPda, chipAuthority,
      chip, playerUser: u,
      authority: player.publicKey, player: player.publicKey,
      mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
    })
    .preInstructions([ensureIx, depositIx])
    .signers([player])
    .rpc();
}

(async () => {
  console.log(`\n=== fill-br: BR #${BR_ID}, filling ${SLOTS_TO_FILL} slots ===\n`);

  const rBefore = await arena.account.battleRoyale.fetch(royalePda(BR_ID));
  console.log(`before: status=${rBefore.status} num_joined=${rBefore.numJoined}/${rBefore.maxPlayers}`);
  const tierLamports = rBefore.poolTier === 0 ? 50_000_000 :
                       rBefore.poolTier === 1 ? 100_000_000 :
                       rBefore.poolTier === 2 ? 250_000_000 :
                       rBefore.poolTier === 3 ? 500_000_000 :
                       rBefore.poolTier === 4 ? 1_000_000_000 : 5_000_000_000;
  console.log(`pool_tier=${rBefore.poolTier} → stake ${(tierLamports/1e9).toFixed(3)} SOL per player`);

  const players = Array.from({ length: SLOTS_TO_FILL }, () => Keypair.generate());

  console.log(`\nfunding ${players.length} throwaways (0.1 SOL each)…`);
  for (let i = 0; i < players.length; i++) {
    await fund(players[i].publicKey, 0.1);
    process.stdout.write(`\rfunded ${i+1}/${players.length}`);
  }
  console.log();

  console.log(`\nminting chips × ${players.length}…`);
  const chips = [];
  for (let i = 0; i < players.length; i++) {
    chips.push(await mintFor(players[i]));
    process.stdout.write(`\rminted ${i+1}/${players.length}`);
  }
  console.log();

  console.log(`\njoining BR #${BR_ID}…`);
  for (let i = 0; i < players.length; i++) {
    try {
      const sig = await joinBr(players[i], chips[i], BR_ID, tierLamports);
      console.log(`  seat: ${players[i].publicKey.toBase58().slice(0, 8)}… joined · sig=${sig.slice(0, 12)}…`);
    } catch (e) {
      console.log(`  FAILED on player ${i}:`, e.message);
      if (e.logs) console.log(e.logs.slice(-5).join("\n"));
      break;
    }
  }

  const rAfter = await arena.account.battleRoyale.fetch(royalePda(BR_ID));
  console.log(`\nafter:  status=${rAfter.status} num_joined=${rAfter.numJoined}/${rAfter.maxPlayers}`);
  if (rAfter.status === 1) {
    console.log("✓ STATUS=ROLLING — relayer should auto-fulfill via Switchboard now");
  } else if (rAfter.numJoined < rAfter.maxPlayers) {
    console.log(`waiting for ${rAfter.maxPlayers - rAfter.numJoined} more player(s) to join…`);
  }
})().catch(e => { console.error("\nFATAL:", e); process.exit(1); });
