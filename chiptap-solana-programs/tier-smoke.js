// ============================================================
// tier-smoke.js — SEC-26 — validates record_chip_win end-to-end on a
// LOCALNET validator (no Switchboard needed; 1v1 resolves via the
// Option-A fulfill_random_words mock VRF).
//
// PART 1 — 1v1 (real DECIDED battle): exercises the whole record_chip_win
//   machinery + the Battle byte-layout parse:
//     • happy path → progression_wins=1, tier=0, last_game_id=battleId
//     • replay        → WinAlreadyRecorded
//     • loser's chip  → NotWinnerChip
//     • ROLLING game  → GameNotDecided
//
// PART 2 — BattleRoyale (read-side offset cross-check): a BR can't reach
//   DECIDED on localnet (winner needs Switchboard), so instead we create
//   + join a real BR and assert that the SAME byte offsets record_chip_win
//   uses (disc, id@8, status@16, num_joined@19, players@52+32i,
//   chips@308+32i, winner@564) extract values identical to the Anchor
//   decode of the same account.  This is what would have caught a wrong
//   stride / offset.
//
//   B_ID env unused; run after deploy + init on a fresh localnet.
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, sendAndConfirmTransaction,
} = require("@solana/web3.js");

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const RPC = process.env.SOLANA_RPC || "http://127.0.0.1:8899";

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
const userPda     = (a) => pda([enc("user"), a.toBuffer()], arena.programId);
const battlePda   = (id) => pda([enc("battle"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);
const royalePda   = (id) => pda([enc("royale"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);
const chipDataPda = (a) => pda([enc("chip"), a.toBuffer()], chipNft.programId);

const log = (...a) => console.log("•", ...a);
const section = (s) => console.log(`\n===== ${s} =====`);
let failures = 0;
function ok(cond, msg) { if (cond) log("✓", msg); else { console.error("✗ FAIL:", msg); failures++; } }

async function fund(to, sol) {
  const tx = new Transaction().add(SystemProgram.transfer({
    fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.floor(sol * LAMPORTS_PER_SOL),
  }));
  return sendAndConfirmTransaction(connection, tx, [owner]);
}
async function mintFor(player) {
  const asset = Keypair.generate();
  await chipNft.methods.mintChip("ChipTap", "https://chiptap.gg/metadata/tier-0.json").accounts({
    config: chipNftConfig, vault: chipNftVault,
    asset: asset.publicKey, chipData: chipDataPda(asset.publicKey),
    payer: player.publicKey, mplCore: MPL_CORE,
    systemProgram: SystemProgram.programId,
  }).signers([player, asset]).rpc();
  return asset.publicKey;
}
function recordWin(chipAsset, gamePda, signer) {
  return chipNft.methods.recordChipWin().accounts({
    config: chipNftConfig,
    chipData: chipDataPda(chipAsset),
    game: gamePda,
    caller: signer.publicKey,
  }).signers([signer]).rpc();
}
async function expectErr(promise, codeName, label) {
  try { await promise; ok(false, `${label} — expected ${codeName}, but it SUCCEEDED`); }
  catch (e) {
    const s = JSON.stringify(e?.error ?? {}) + " " + (e?.message ?? "");
    ok(s.includes(codeName), `${label} — rejected with ${codeName}`);
  }
}

(async () => {
  // ---------- config sanity ----------
  section("config: battle_arena_program wired?");
  const cfg = await chipNft.account.chipNftConfig.fetch(chipNftConfig);
  ok(cfg.battleArenaProgram.equals(arena.programId),
    `chip_nft.battle_arena_program == arena (${cfg.battleArenaProgram.toBase58().slice(0,8)}…)`);

  // ================= PART 1 — 1v1 =================
  section("PART 1 — 1v1 record_chip_win");
  const A = Keypair.generate(), B = Keypair.generate();
  await fund(A.publicKey, 5); await fund(B.publicKey, 5);
  const chipA = await mintFor(A), chipB = await mintFor(B);
  log("chipA", chipA.toBase58().slice(0,8), "chipB", chipB.toBase58().slice(0,8));

  // battle #1 — will be DECIDED (A wins, seed 42 even → player_a)
  const aCfg = await arena.account.arenaConfig.fetch(arenaConfig);
  const id1 = aCfg.nextBattleId.toString();
  await arena.methods.createBattle(0).accounts({
    config: arenaConfig, battle: battlePda(id1), chipAuthority, chip: chipA,
    player: A.publicKey, mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([A]).rpc();
  await arena.methods.joinBattle().accounts({
    config: arenaConfig, battle: battlePda(id1), chipAuthority, chip: chipB,
    player: B.publicKey, mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([B]).rpc();

  // battle #2 — left at ROLLING for the GameNotDecided negative test
  const id2 = (Number(id1) + 1).toString();
  const A2 = Keypair.generate(), B2 = Keypair.generate();
  await fund(A2.publicKey, 5); await fund(B2.publicKey, 5);
  const chipA2 = await mintFor(A2), chipB2 = await mintFor(B2);
  await arena.methods.createBattle(0).accounts({
    config: arenaConfig, battle: battlePda(id2), chipAuthority, chip: chipA2,
    player: A2.publicKey, mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([A2]).rpc();
  await arena.methods.joinBattle().accounts({
    config: arenaConfig, battle: battlePda(id2), chipAuthority, chip: chipB2,
    player: B2.publicKey, mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([B2]).rpc();

  // negative: ROLLING game must be rejected
  await expectErr(recordWin(chipA2, battlePda(id2), A2), "GameNotDecided",
    "record_chip_win on ROLLING battle");

  // resolve battle #1 (mock VRF, owner = vrf_authority, seed 42 → player_a wins)
  await arena.methods.fulfillRandomWords(new anchor.BN(42)).accounts({
    config: arenaConfig, battle: battlePda(id1), vrfAuthority: owner.publicKey,
  }).signers([owner]).rpc();
  const b1 = await arena.account.battle.fetch(battlePda(id1));
  ok(b1.status === 2, `battle #${id1} DECIDED (status=${b1.status})`);
  ok(b1.winner.equals(A.publicKey), "winner == playerA");

  // negative: loser's chip must be rejected
  await expectErr(recordWin(chipB, battlePda(id1), B), "NotWinnerChip",
    "record_chip_win with loser's chip");

  // happy path: winner's chip
  await recordWin(chipA, battlePda(id1), A);
  let cd = await chipNft.account.chipData.fetch(chipDataPda(chipA));
  ok(Number(cd.progressionWins) === 1, `progression_wins == 1 (got ${cd.progressionWins})`);
  ok(Number(cd.tier) === 0, `tier still 0 (got ${cd.tier})`);
  ok(cd.lastGameId.toString() === id1, `last_game_id == ${id1} (got ${cd.lastGameId})`);

  // replay guard
  await expectErr(recordWin(chipA, battlePda(id1), A), "WinAlreadyRecorded",
    "replay record_chip_win on same battle");

  // ================= PART 2 — BR offset cross-check =================
  section("PART 2 — BattleRoyale byte-offset cross-check");
  const N = 2;  // BR_MIN_PLAYERS
  const brPlayers = Array.from({ length: N }, () => Keypair.generate());
  for (const p of brPlayers) await fund(p.publicKey, 0.5);
  const brChips = [];
  for (const p of brPlayers) brChips.push(await mintFor(p));
  for (const p of brPlayers) {
    await arena.methods.deposit(new anchor.BN(0.05 * LAMPORTS_PER_SOL + 2_000_000)).accounts({
      config: arenaConfig, vault: arenaVault, user: userPda(p.publicKey),
      payer: p.publicKey, systemProgram: SystemProgram.programId,
    }).signers([p]).rpc();
  }
  const brCfg = await arena.account.arenaConfig.fetch(arenaConfig);
  const brId  = brCfg.nextBattleId.toString();
  const rPda  = royalePda(brId);
  await arena.methods.createBattleRoyale(0, N).accounts({
    config: arenaConfig, royale: rPda, creator: brPlayers[0].publicKey,
    systemProgram: SystemProgram.programId,
  }).signers([brPlayers[0]]).rpc();
  for (let i = 0; i < N; i++) {
    await arena.methods.joinBattleRoyale().accounts({
      config: arenaConfig, royale: rPda, chipAuthority, chip: brChips[i],
      playerUser: userPda(brPlayers[i].publicKey),
      authority: brPlayers[i].publicKey, player: brPlayers[i].publicKey,
      mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([brPlayers[i]]).rpc();
  }
  log("BR", brId, "created +", N, "joined");

  // Anchor decode (ground truth)
  const br = await arena.account.battleRoyale.fetch(rPda);
  // Raw bytes — parse with the EXACT offsets record_chip_win uses.
  const raw = (await connection.getAccountInfo(rPda)).data;
  const ROYALE_DISC = [236, 95, 128, 245, 19, 52, 28, 163];
  ok(ROYALE_DISC.every((b, i) => raw[i] === b), "discriminator matches ROYALE_DISC");
  const rId        = Number(raw.readBigUInt64LE(8));
  const rStatus    = raw[16];
  const rNumJoined = raw[19];
  ok(rId === Number(brId), `id@8 == ${brId} (got ${rId})`);
  ok(rStatus === Number(br.status), `status@16 == anchor (${rStatus})`);
  ok(rNumJoined === Number(br.numJoined), `num_joined@19 == anchor (${rNumJoined})`);
  for (let i = 0; i < N; i++) {
    const pOff = 52 + i * 32, cOff = 308 + i * 32;
    const pRaw = new PublicKey(raw.subarray(pOff, pOff + 32)).toBase58();
    const cRaw = new PublicKey(raw.subarray(cOff, cOff + 32)).toBase58();
    ok(pRaw === br.players[i].toBase58(), `players[${i}]@${pOff} == anchor`);
    ok(cRaw === br.chips[i].toBase58(),   `chips[${i}]@${cOff} == anchor`);
  }
  const wRaw = new PublicKey(raw.subarray(564, 596)).toBase58();
  ok(wRaw === br.winner.toBase58(), "winner@564 == anchor (default until DECIDED)");

  // Simulate record_chip_win's winner-chip extraction for a hypothetical
  // winner = players[1]: walk players[], find slot, read chips[slot].
  const hypoWinner = br.players[1].toBase58();
  let foundChip = null;
  for (let i = 0; i < rNumJoined; i++) {
    const pOff = 52 + i * 32;
    if (new PublicKey(raw.subarray(pOff, pOff + 32)).toBase58() === hypoWinner) {
      foundChip = new PublicKey(raw.subarray(308 + i * 32, 340 + i * 32)).toBase58();
      break;
    }
  }
  ok(foundChip === br.chips[1].toBase58(),
    "winner-chip extraction picks chips[winner_slot] correctly");

  section(failures === 0 ? "🎉 TIER SMOKE OK" : `❌ ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error("tier-smoke crashed:", e); process.exit(1); });
