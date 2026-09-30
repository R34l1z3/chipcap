// ============================================================
// tournament-cancel-smoke.js — SEC-29 — proves the tournament cancel
// refund.
//
// The bug: expire_tournament_registration set CANCELLED and players got
// their chips back, but the entry fee (debited from the internal
// balance) and the burned ticket were simply lost.  Fix:
// claim_tournament_chip now, on CANCELLED, credits entry_fee back to
// player_user.balance AND re-mints the ticket — atomically with the chip
// return, guarded by the same per-slot bit.
//
// This test (localnet or devnet — SOLANA_RPC picks):
//   1. set_join_timeout → 300 s (min allowed) so we can expire quickly
//   2. create a tournament; 2 throwaways buy a ticket and register
//      (stays REGISTERING — a bracket needs 8)
//   3. wait > 300 s, expire_tournament_registration → CANCELLED
//   4. claim with ANOTHER player's ticket ATA → must fail
//   5. each player claims → chip back, balance +entry_fee, ticket +1
//   6. second claim → must fail (no double refund)
//   7. restore join_timeout → 1800 s
//
// Runtime ~6 min (the 300 s wait dominates).
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
} = require("@solana/spl-token");

const RPC = process.env.SOLANA_RPC || "http://127.0.0.1:8899";
const IS_DEVNET = /devnet/i.test(RPC);
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const ENTRY_FEE_LAMPORTS = 20_000_000;   // 0.02 SOL
const N_JOIN = 2;
const SHORT_TIMEOUT = 300;               // min allowed by set_join_timeout
const RESTORE_TIMEOUT = 1800;            // devnet default
const T_STATUS_REGISTERING = 0;
const T_STATUS_CANCELLED = 3;

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

const idlDir = path.join(__dirname, "target", "idl");
const chipNft = new anchor.Program(JSON.parse(fs.readFileSync(path.join(idlDir, "chip_nft.json"))), provider);
const arena   = new anchor.Program(JSON.parse(fs.readFileSync(path.join(idlDir, "battle_arena.json"))), provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const arenaConfig     = pda([enc("arena")], arena.programId);
const arenaVault      = pda([enc("arena"), enc("vault")], arena.programId);
const chipAuthority   = pda([enc("arena"), enc("chip_authority")], arena.programId);
const ticketMint      = pda([enc("ticket_mint")], arena.programId);
const ticketAuthority = pda([enc("ticket_authority")], arena.programId);
const chipNftConfig   = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault    = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const userPda     = (a) => pda([enc("user"), a.toBuffer()], arena.programId);
const chipDataPda = (a) => pda([enc("chip"), a.toBuffer()], chipNft.programId);
const tourneyPda  = (id) => pda([enc("tournament"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);
const ataOf       = (a) => getAssociatedTokenAddressSync(ticketMint, a);

let passed = 0, failed = 0;
const check = (ok, label) => {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else    { failed++; console.log(`  ✗ ${label}`); }
};
const log = (...a) => console.log("•", ...a);
const section = (s) => console.log(`\n===== ${s} =====`);

async function fund(to, sol) {
  const lamports = Math.round(sol * LAMPORTS_PER_SOL);
  if (!IS_DEVNET) {
    const sig = await connection.requestAirdrop(to, lamports);
    await connection.confirmTransaction(sig, "confirmed");
    return;
  }
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
    fromPubkey: owner.publicKey, toPubkey: to, lamports,
  })), []);
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
async function balance(auth) {
  const u = await arena.account.userAccount.fetchNullable(userPda(auth));
  return u ? BigInt(u.balance.toString()) : 0n;
}
async function tickets(auth) {
  try { return BigInt((await connection.getTokenAccountBalance(ataOf(auth))).value.amount); }
  catch { return 0n; }
}
// mpl-core AssetV1: byte 0 = key, bytes 1..33 = owner.
async function chipOwner(asset) {
  const info = await connection.getAccountInfo(asset);
  return new PublicKey(info.data.subarray(1, 33));
}
const claimAccounts = (tId, chip, player, playerAta) => ({
  config: arenaConfig, tournament: tourneyPda(tId), chipAuthority,
  chip, player, mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  playerUser: userPda(player), ticketMint, playerAta, ticketAuthority,
  tokenProgram: TOKEN_PROGRAM_ID,
});

async function restoreTimeout() {
  await arena.methods.setJoinTimeout(new anchor.BN(RESTORE_TIMEOUT)).accounts({
    config: arenaConfig, owner: owner.publicKey,
  }).rpc();
}

(async () => {
  log(`RPC ${RPC} (${IS_DEVNET ? "devnet" : "localnet"})`);

  section("set_join_timeout → 300 s");
  await arena.methods.setJoinTimeout(new anchor.BN(SHORT_TIMEOUT)).accounts({
    config: arenaConfig, owner: owner.publicKey,
  }).rpc();

  section(`setup ${N_JOIN} throwaway players`);
  const players = Array.from({ length: N_JOIN }, () => Keypair.generate());
  for (const p of players) await fund(p.publicKey, IS_DEVNET ? 0.12 : 2);
  const chips = [];
  for (const p of players) chips.push(await mintFor(p));
  log("funded + minted");

  section("create tournament + register (stays REGISTERING)");
  const cfgPre = await arena.account.arenaConfig.fetch(arenaConfig);
  const id = cfgPre.nextBattleId.toString();
  await arena.methods.createTournament(new anchor.BN(ENTRY_FEE_LAMPORTS)).accounts({
    config: arenaConfig, tournament: tourneyPda(id),
    creator: owner.publicKey, systemProgram: SystemProgram.programId,
  }).rpc();
  log("tournament id =", id);

  const balAfterReg = [], ticketsAfterReg = [];
  for (let i = 0; i < N_JOIN; i++) {
    const p = players[i];
    await arena.methods.buyTicket(new anchor.BN(1)).accounts({
      config: arenaConfig, vault: arenaVault, ticketMint, ticketAuthority,
      buyerAta: ataOf(p.publicKey), buyer: p.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).signers([p]).rpc();
    const u = userPda(p.publicKey);
    const ensureIx = await arena.methods.ensureUserAccount().accounts({
      user: u, authority: p.publicKey, payer: p.publicKey,
      systemProgram: SystemProgram.programId,
    }).instruction();
    const depositIx = await arena.methods.deposit(new anchor.BN(ENTRY_FEE_LAMPORTS + 1_000_000)).accounts({
      config: arenaConfig, vault: arenaVault, user: u,
      payer: p.publicKey, systemProgram: SystemProgram.programId,
    }).instruction();
    await arena.methods.registerForTournament().accounts({
      config: arenaConfig, tournament: tourneyPda(id), chipAuthority,
      chip: chips[i], ticketMint, playerAta: ataOf(p.publicKey),
      playerUser: u, authority: p.publicKey, player: p.publicKey,
      mplCore: MPL_CORE, tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    }).preInstructions([ensureIx, depositIx]).signers([p]).rpc();
    balAfterReg.push(await balance(p.publicKey));
    ticketsAfterReg.push(await tickets(p.publicKey));
  }
  const tReg = await arena.account.tournament.fetch(tourneyPda(id));
  check(tReg.status === T_STATUS_REGISTERING && tReg.registered === N_JOIN,
    `REGISTERING with ${tReg.registered}/${N_JOIN} registered`);
  check(ticketsAfterReg.every((t) => t === 0n), "tickets burned at registration");
  check((await chipOwner(chips[0])).equals(chipAuthority), "chip escrowed");

  section(`wait ${SHORT_TIMEOUT + 15} s for the registration window to expire`);
  await new Promise((r) => setTimeout(r, (SHORT_TIMEOUT + 15) * 1000));

  section("expire_tournament_registration");
  await arena.methods.expireTournamentRegistration().accounts({
    config: arenaConfig, tournament: tourneyPda(id), caller: owner.publicKey,
  }).rpc();
  const tCan = await arena.account.tournament.fetch(tourneyPda(id));
  check(tCan.status === T_STATUS_CANCELLED, `status ${tCan.status} = CANCELLED`);

  section("claim with someone else's ticket ATA → must fail");
  try {
    await arena.methods.claimTournamentChip()
      .accounts(claimAccounts(id, chips[1], players[1].publicKey, ataOf(players[0].publicKey)))
      .signers([players[1]]).rpc();
    check(false, "foreign ATA rejected");
  } catch (e) {
    check(/ConstraintTokenOwner|ConstraintAssociated|2015|2009|0x7df|0x7d9/i.test(String(e.message ?? e)),
      `foreign ATA rejected (${String(e.message ?? e).split("\n")[0].slice(0, 90)})`);
  }

  section("each player claims → chip + entry fee + ticket back");
  for (let i = 0; i < N_JOIN; i++) {
    const p = players[i];
    const balBefore = await balance(p.publicKey);
    const tixBefore = await tickets(p.publicKey);
    await arena.methods.claimTournamentChip()
      .accounts(claimAccounts(id, chips[i], p.publicKey, ataOf(p.publicKey)))
      .signers([p]).rpc();
    const refunded = (await balance(p.publicKey)) - balBefore;
    const tixGained = (await tickets(p.publicKey)) - tixBefore;
    check(refunded === BigInt(ENTRY_FEE_LAMPORTS), `player ${i}: entry fee refunded (${refunded} lamports)`);
    check(tixGained === 1n, `player ${i}: ticket re-minted (+${tixGained})`);
    check((await chipOwner(chips[i])).equals(p.publicKey), `player ${i}: chip returned`);
    check(balBefore === balAfterReg[i], `player ${i}: no balance drift between register and claim`);
  }

  section("second claim → must fail (no double refund)");
  const balBeforeDup = await balance(players[0].publicKey);
  try {
    await arena.methods.claimTournamentChip()
      .accounts(claimAccounts(id, chips[0], players[0].publicKey, ataOf(players[0].publicKey)))
      .signers([players[0]]).rpc();
    check(false, "double claim rejected");
  } catch (e) {
    check(/ChipAlreadyClaimed|ownership|Incorrect|0x/i.test(String(e.message ?? e)),
      `double claim rejected (${String(e.message ?? e).split("\n")[0].slice(0, 90)})`);
  }
  check((await balance(players[0].publicKey)) === balBeforeDup, "balance unchanged after rejected double claim");

  const tFinal = await arena.account.tournament.fetch(tourneyPda(id));
  check(tFinal.chipsClaimedMask === 0b11, `chips_claimed_mask = ${tFinal.chipsClaimedMask.toString(2)}`);

  section("restore join_timeout → 1800 s");
  await restoreTimeout();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  console.log("🎉 TOURNAMENT-CANCEL SMOKE OK — expire → CANCELLED → claim returns chip + entry fee + ticket");
})().catch(async (e) => {
  console.error("\nFATAL:", e.message || e);
  if (e.logs) console.error(e.logs.slice(-10).join("\n"));
  // Never leave the cluster in the 300 s test state.
  await restoreTimeout().then(() => console.error("(join_timeout restored to 1800)")).catch(() => {});
  process.exit(1);
});
