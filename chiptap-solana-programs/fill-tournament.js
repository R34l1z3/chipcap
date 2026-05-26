// ============================================================
// fill-tournament.js — One-off helper: fill N seats of an existing
// Tournament with throwaway players.  Mirrors fill-br.js.
//
//   T_ID=19 SLOTS_TO_FILL=2 node fill-tournament.js
//
// Each throwaway:
//   1. funded with 0.06 SOL from owner (covers entry + ticket + chip mint + rent + fees)
//   2. mints a Common chip via chip_nft
//   3. ensureUserAccount + deposit(entry + buf) + buy_ticket + register — one tx
//
// When this fills the last seat the on-chain code does NOT auto-start
// — `start_tournament` is a separate ix.  The script invokes it once
// the lobby reaches bracket_size.
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, sendAndConfirmTransaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");

const T_ID          = parseInt(process.env.T_ID || "19", 10);
const SLOTS_TO_FILL = parseInt(process.env.SLOTS_TO_FILL || "2", 10);
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
const arenaConfig    = pda([enc("arena")], arena.programId);
const arenaVault     = pda([enc("arena"), enc("vault")], arena.programId);
const chipAuthority  = pda([enc("arena"), enc("chip_authority")], arena.programId);
const ticketMint     = pda([enc("ticket_mint")], arena.programId);
const ticketAuthority= pda([enc("ticket_authority")], arena.programId);
const chipNftConfig  = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault   = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const userPda    = (a) => pda([enc("user"), a.toBuffer()], arena.programId);
const chipDataPda = (a) => pda([enc("chip"), a.toBuffer()], chipNft.programId);
const tourneyPda  = (id) => pda([enc("tournament"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);

const log = (...a) => console.log("•", ...a);

async function fund(to, sol) {
  return sendAndConfirmTransaction(connection,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.floor(sol * LAMPORTS_PER_SOL),
    })), [owner]);
}

async function mintFor(player) {
  const asset = Keypair.generate();
  await chipNft.methods.mintChip(0, "ChipTap", "https://chiptap.gg/metadata/0.json").accounts({
    config: chipNftConfig, vault: chipNftVault,
    asset: asset.publicKey, chipData: chipDataPda(asset.publicKey),
    payer: player.publicKey, mplCore: MPL_CORE,
    systemProgram: SystemProgram.programId,
  }).signers([player, asset]).rpc();
  return asset.publicKey;
}

async function buyAndRegister(player, chip, tId, entryLamports) {
  const u   = userPda(player.publicKey);
  const ata = getAssociatedTokenAddressSync(ticketMint, player.publicKey);

  const ensureIx = await arena.methods.ensureUserAccount().accounts({
    user: u, authority: player.publicKey, payer: player.publicKey,
    systemProgram: SystemProgram.programId,
  }).instruction();
  const depositIx = await arena.methods.deposit(new anchor.BN(entryLamports + 1_000_000)).accounts({
    config: arenaConfig, vault: arenaVault, user: u,
    payer: player.publicKey, systemProgram: SystemProgram.programId,
  }).instruction();
  const buyIx = await arena.methods.buyTicket(new anchor.BN(1)).accounts({
    config: arenaConfig, vault: arenaVault,
    ticketMint, ticketAuthority, buyerAta: ata,
    buyer: player.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).instruction();

  return arena.methods.registerForTournament().accounts({
    config: arenaConfig, tournament: tourneyPda(tId), chipAuthority,
    chip, ticketMint, playerAta: ata, playerUser: u,
    authority: player.publicKey, player: player.publicKey,
    mplCore: MPL_CORE, tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).preInstructions([ensureIx, depositIx, buyIx]).signers([player]).rpc();
}

(async () => {
  console.log(`\n=== fill-tournament: #${T_ID}, filling ${SLOTS_TO_FILL} seats ===\n`);

  const tBefore = await arena.account.tournament.fetch(tourneyPda(T_ID));
  console.log(`before: status=${tBefore.status} registered=${tBefore.registered}/${tBefore.bracketSize}`);
  const entryLamports = Number(tBefore.entryFee);
  console.log(`entry_fee=${(entryLamports/1e9).toFixed(3)} SOL per seat`);

  const players = Array.from({ length: SLOTS_TO_FILL }, () => Keypair.generate());

  console.log(`\nfunding ${players.length} throwaways (0.06 SOL each)…`);
  for (let i = 0; i < players.length; i++) {
    await fund(players[i].publicKey, 0.06);
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

  console.log(`\nregistering for tournament #${T_ID}…`);
  for (let i = 0; i < players.length; i++) {
    try {
      const sig = await buyAndRegister(players[i], chips[i], T_ID, entryLamports);
      console.log(`  seat ${i}: ${players[i].publicKey.toBase58().slice(0,8)}… registered · sig=${sig.slice(0,12)}…`);
    } catch (e) {
      console.log(`  FAILED on player ${i}:`, e.message);
      if (e.logs) console.log(e.logs.slice(-5).join("\n"));
      break;
    }
  }

  const tAfter = await arena.account.tournament.fetch(tourneyPda(T_ID));
  console.log(`\nafter:  status=${tAfter.status} registered=${tAfter.registered}/${tAfter.bracketSize}`);

  if (tAfter.registered === tAfter.bracketSize && tAfter.status === 0) {
    console.log(`\nlobby is FULL — calling start_tournament…`);
    const sig = await arena.methods.startTournament().accounts({
      config: arenaConfig, tournament: tourneyPda(T_ID),
      caller: owner.publicKey,
    }).rpc();
    console.log(`  start sig=${sig.slice(0,16)}…`);
    const tStart = await arena.account.tournament.fetch(tourneyPda(T_ID));
    console.log(`  → status=${tStart.status} (1=ACTIVE)  current_round=${tStart.currentRound}`);
    console.log(`  → pool=${(Number(tStart.poolAmount)/1e9).toFixed(4)} SOL`);
    console.log(`\n✓ Tournament is rolling. Relayer should now fulfil 4× R0 Switchboard cycles.`);
    console.log(`  watch via:   wsl -d Ubuntu -u root -- tail -f /tmp/relayer.log`);
  }
})().catch(e => { console.error("\nFATAL:", e); process.exit(1); });
