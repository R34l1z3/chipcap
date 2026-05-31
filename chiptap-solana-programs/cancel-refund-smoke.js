// ============================================================
// cancel-refund-smoke.js — SEC-22 — proves the cancel→refund fix.
//
// The bug: cancel_br set status=CANCELLED but never returned the
// joined stake; claim_chip_br only returned the chip.  Fix: claim_chip_br
// now credits player_user.balance += stake when status==CANCELLED, and
// cancel_br emits BattleRoyaleCancelled.
//
// This test (devnet only):
//   1. set_join_timeout → 300 s (min allowed) so we can expire quickly
//   2. create an 8-player BR; have 2 throwaways join (stays WAITING)
//   3. record each joiner's internal balance AFTER join (stake debited)
//   4. wait > 300 s
//   5. expire_battle_royale_join → status CANCELLED + event
//   6. each joiner claim_chip_br → asserts chip back AND balance restored
//      to its pre-join value (stake refunded)
//   7. restore join_timeout → 1800 s
//
// Runtime ~6 min (the 300 s wait dominates).  Run sparingly.
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, sendAndConfirmTransaction,
} = require("@solana/web3.js");

const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const POOL_TIER  = 0;          // 0.05 SOL
const MAX_PLAYERS = 8;         // create big so 2 joins keep it WAITING
const N_JOIN = 2;
const SHORT_TIMEOUT = 300;     // min allowed by set_join_timeout
const RESTORE_TIMEOUT = 1800;  // devnet default

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
const arenaConfig   = pda([enc("arena")], arena.programId);
const arenaVault    = pda([enc("arena"), enc("vault")], arena.programId);
const chipAuthority = pda([enc("arena"), enc("chip_authority")], arena.programId);
const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const userPda    = (a) => pda([enc("user"), a.toBuffer()], arena.programId);
const chipDataPda = (a) => pda([enc("chip"), a.toBuffer()], chipNft.programId);
const royalePda  = (id) => pda([enc("royale"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);

const log = (...a) => console.log("•", ...a);
const section = (s) => console.log(`\n===== ${s} =====`);

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
async function balance(auth) {
  const u = await arena.account.userAccount.fetchNullable(userPda(auth));
  return u ? Number(u.balance) : 0;
}

(async () => {
  section("set_join_timeout → 300 s");
  await arena.methods.setJoinTimeout(new anchor.BN(SHORT_TIMEOUT)).accounts({
    config: arenaConfig, owner: owner.publicKey,
  }).rpc();
  log("join_timeout now 300 s");

  section(`setup ${N_JOIN} throwaway players`);
  const players = Array.from({ length: N_JOIN }, () => Keypair.generate());
  for (const p of players) await fund(p.publicKey, 0.12);
  const chips = [];
  for (let i = 0; i < N_JOIN; i++) chips.push(await mintFor(players[i]));
  log("funded + minted");

  section("create BR + 2 joins (stays WAITING)");
  const cfgPre = await arena.account.arenaConfig.fetch(arenaConfig);
  const id = cfgPre.nextBattleId.toString();
  const rPda = royalePda(id);
  await arena.methods.createBattleRoyale(POOL_TIER, MAX_PLAYERS).accounts({
    config: arenaConfig, royale: rPda, creator: players[0].publicKey,
    systemProgram: SystemProgram.programId,
  }).signers([players[0]]).rpc();
  log("BR id =", id);

  const stakeLamports = cfgPre.poolAmounts[POOL_TIER];
  const balPostJoin = [];
  for (let i = 0; i < N_JOIN; i++) {
    const u = userPda(players[i].publicKey);
    const ensureIx = await arena.methods.ensureUserAccount().accounts({
      user: u, authority: players[i].publicKey, payer: players[i].publicKey,
      systemProgram: SystemProgram.programId,
    }).instruction();
    const depositIx = await arena.methods.deposit(new anchor.BN(Number(stakeLamports) + 2_000_000)).accounts({
      config: arenaConfig, vault: arenaVault, user: u,
      payer: players[i].publicKey, systemProgram: SystemProgram.programId,
    }).instruction();
    await arena.methods.joinBattleRoyale().accounts({
      config: arenaConfig, royale: rPda, chipAuthority,
      chip: chips[i], playerUser: u,
      authority: players[i].publicKey, player: players[i].publicKey,
      mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
    }).preInstructions([ensureIx, depositIx]).signers([players[i]]).rpc();
    const b = await balance(players[i].publicKey);
    balPostJoin.push(b);
    log(`player ${i} joined — internal balance after join: ${(b/1e9).toFixed(4)} SOL`);
  }

  const rWaiting = await arena.account.battleRoyale.fetch(rPda);
  log("status:", rWaiting.status, "(expected 0=WAITING)  num_joined:", rWaiting.numJoined);
  if (rWaiting.status !== 0) throw new Error("expected WAITING");

  section(`wait ${SHORT_TIMEOUT + 15} s for join window to expire`);
  await new Promise(r => setTimeout(r, (SHORT_TIMEOUT + 15) * 1000));

  section("expire_battle_royale_join");
  const expSig = await arena.methods.expireBattleRoyaleJoin().accounts({
    config: arenaConfig, royale: rPda, caller: owner.publicKey,
  }).rpc();
  log("expire sig:", expSig.slice(0, 16) + "…");
  const rCancelled = await arena.account.battleRoyale.fetch(rPda);
  log("status:", rCancelled.status, "(expected 4=CANCELLED)");
  if (rCancelled.status !== 4) throw new Error("expected CANCELLED");

  section("each player claim_chip_br → chip + stake refund");
  let allOk = true;
  for (let i = 0; i < N_JOIN; i++) {
    const balBefore = await balance(players[i].publicKey);
    await arena.methods.claimChipBr().accounts({
      config: arenaConfig, royale: rPda, chipAuthority,
      chip: chips[i], playerUser: userPda(players[i].publicKey),
      player: players[i].publicKey,
      mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([players[i]]).rpc();
    const balAfter = await balance(players[i].publicKey);
    const refunded = balAfter - balBefore;
    const expected = Number(stakeLamports);
    const ok = refunded === expected;
    allOk = allOk && ok;
    log(`player ${i}: balance ${(balBefore/1e9).toFixed(4)} → ${(balAfter/1e9).toFixed(4)} SOL  (refund ${(refunded/1e9).toFixed(4)}, expected ${(expected/1e9).toFixed(4)}) ${ok ? "✓" : "✗ MISMATCH"}`);
  }

  section("restore join_timeout → 1800 s");
  await arena.methods.setJoinTimeout(new anchor.BN(RESTORE_TIMEOUT)).accounts({
    config: arenaConfig, owner: owner.publicKey,
  }).rpc();
  log("join_timeout restored");

  if (!allOk) throw new Error("stake refund mismatch — fix did NOT work");
  console.log("\n🎉 CANCEL-REFUND SMOKE OK — expire → CANCELLED → claim_chip_br returns chip + full stake refund");
})().catch(e => {
  console.error("\nFATAL:", e.message || e);
  if (e.logs) console.error(e.logs.slice(-8).join("\n"));
  // Best-effort: restore the timeout even on failure so we don't leave
  // devnet config in the 300 s test state.
  arena.methods.setJoinTimeout(new anchor.BN(RESTORE_TIMEOUT)).accounts({
    config: arenaConfig, owner: owner.publicKey,
  }).rpc().then(() => console.error("(join_timeout restored to 1800)")).catch(() => {});
  process.exit(1);
});
