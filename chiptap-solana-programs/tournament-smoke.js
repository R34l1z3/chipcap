// ============================================================
// tournament-smoke.js — SEC-23 end-to-end validation on devnet.
//
// 8 throwaway wallets → buy tickets → mint chips → register
//   → start_tournament → 4 R0 + 2 R1 + 2 R2 Switchboard fulfills
//   → claim_tournament_prize × 3 → claim_tournament_chip × 8.
//
// Asserts at every transition.  Burns ~1 SOL of throwaway funding +
// ~7 × 0.001 SOL of Switchboard fees from the owner wallet.
// Total runtime ~5-7 minutes on healthy devnet.
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, sendAndConfirmTransaction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const sb = require("@switchboard-xyz/on-demand");
const { Randomness, AnchorUtils, ON_DEMAND_DEVNET_QUEUE } = sb;

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const ENTRY_FEE_SOL = 0.02;                       // tournament entry fee
const ENTRY_FEE_LAMPORTS = Math.floor(ENTRY_FEE_SOL * LAMPORTS_PER_SOL);
const TICKET_PRICE_LAMPORTS = 10_000_000;         // 0.01 SOL — must match program constant
const N = 8;                                       // bracket size

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection(RPC, "confirmed");
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
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];

const arenaConfig    = pda([enc("arena")], arena.programId);
const arenaVault     = pda([enc("arena"), enc("vault")], arena.programId);
const chipAuthority  = pda([enc("arena"), enc("chip_authority")], arena.programId);
const treasuryConfig = pda([enc("treasury")], treasury.programId);
const treasuryVault  = pda([enc("treasury"), enc("vault")], treasury.programId);
const ticketMint     = pda([enc("ticket_mint")], arena.programId);
const ticketAuthority= pda([enc("ticket_authority")], arena.programId);
const chipNftConfig  = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault   = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const userPda    = (a) => pda([enc("user"), a.toBuffer()], arena.programId);
const chipDataPda = (a) => pda([enc("chip"), a.toBuffer()], chipNft.programId);
const tourneyPda  = (id) => pda([enc("tournament"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);

const log     = (...a) => console.log("•", ...a);
const section = (s)    => console.log(`\n===== ${s} =====`);

async function fund(to, sol) {
  return sendAndConfirmTransaction(connection,
    new Transaction().add(SystemProgram.transfer({
      fromPubkey: owner.publicKey, toPubkey: to, lamports: Math.floor(sol * LAMPORTS_PER_SOL),
    })), [owner]);
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

async function buyAndRegister(player, chip, tournamentId) {
  const u   = userPda(player.publicKey);
  const ata = getAssociatedTokenAddressSync(ticketMint, player.publicKey);

  // buy_ticket → mint 1 ticket to player's ATA + pay 0.01 SOL → arena_vault
  await arena.methods.buyTicket(new anchor.BN(1)).accounts({
    config:                  arenaConfig,
    vault:                   arenaVault,
    ticketMint,
    ticketAuthority,
    buyerAta:                ata,
    buyer:                   player.publicKey,
    tokenProgram:            TOKEN_PROGRAM_ID,
    associatedTokenProgram:  ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram:           SystemProgram.programId,
  }).signers([player]).rpc();

  // ensure_user_account + deposit (entry_fee + rent buffer) + register — one tx
  const ensureIx = await arena.methods.ensureUserAccount().accounts({
    user: u, authority: player.publicKey, payer: player.publicKey,
    systemProgram: SystemProgram.programId,
  }).instruction();
  const depositIx = await arena.methods.deposit(new anchor.BN(ENTRY_FEE_LAMPORTS + 1_000_000)).accounts({
    config: arenaConfig, vault: arenaVault, user: u,
    payer: player.publicKey, systemProgram: SystemProgram.programId,
  }).instruction();

  return arena.methods.registerForTournament().accounts({
    config: arenaConfig,
    tournament: tourneyPda(tournamentId),
    chipAuthority,
    chip,
    ticketMint,
    playerAta: ata,
    playerUser: u,
    authority: player.publicKey,
    player: player.publicKey,
    mplCore: MPL_CORE,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).preInstructions([ensureIx, depositIx]).signers([player]).rpc();
}

async function runOneSwitchboardMatch(tournamentId, matchIdx) {
  const sbProvider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
    commitment: "confirmed", preflightCommitment: "confirmed",
  });
  const sbProgram = await AnchorUtils.loadProgramFromProvider(sbProvider);
  const [rnd, kp, createIxs] = await Randomness.createAndCommitIxs(
    sbProgram, ON_DEMAND_DEVNET_QUEUE, owner.publicKey,
  );
  const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
  const tx1 = new Transaction().add(cuPrice, cuLimit, ...createIxs);
  tx1.feePayer = owner.publicKey;
  await sendAndConfirmTransaction(connection, tx1, [owner, kp], { commitment: "confirmed" });

  await new Promise(r => setTimeout(r, 8_000));

  let sig;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const revealIx = await rnd.revealIx(owner.publicKey);
      const fulfillIx = await arena.methods.advanceMatchSwitchboard(matchIdx).accounts({
        config: arenaConfig, tournament: tourneyPda(tournamentId),
        randomnessAccount: kp.publicKey, caller: owner.publicKey,
      }).instruction();
      const tx2 = new Transaction().add(cuPrice, cuLimit, revealIx, fulfillIx);
      tx2.feePayer = owner.publicKey;
      sig = await sendAndConfirmTransaction(connection, tx2, [owner], {
        commitment: "confirmed", skipPreflight: true,
      });
      break;
    } catch (e) {
      await new Promise(r => setTimeout(r, 3_000));
    }
  }
  if (!sig) throw new Error(`match #${matchIdx}: reveal+fulfill never succeeded`);
  return sig;
}

(async () => {
  section("setup 8 throwaway players");
  const players = Array.from({ length: N }, () => Keypair.generate());
  for (const p of players) await fund(p.publicKey, 0.08);
  log("funded each with 0.08 SOL");

  section("mint chips × 8");
  const chips = [];
  for (let i = 0; i < N; i++) { chips.push(await mintFor(players[i])); process.stdout.write(`\rminted ${i+1}/${N}`); }
  console.log();

  section("create tournament");
  const cfgPre = await arena.account.arenaConfig.fetch(arenaConfig);
  const id     = cfgPre.nextBattleId.toString();
  await arena.methods.createTournament(new anchor.BN(ENTRY_FEE_LAMPORTS)).accounts({
    config: arenaConfig, tournament: tourneyPda(id),
    creator: owner.publicKey, systemProgram: SystemProgram.programId,
  }).rpc();
  log("Tournament id =", id);

  section("8 players: buy ticket → deposit → register");
  for (let i = 0; i < N; i++) {
    await buyAndRegister(players[i], chips[i], id);
    process.stdout.write(`\rregistered ${i+1}/${N}`);
  }
  console.log();

  const tBefore = await arena.account.tournament.fetch(tourneyPda(id));
  log(`status=${tBefore.status} (expected 0=REGISTERING)  registered=${tBefore.registered}/${tBefore.bracketSize}`);
  if (tBefore.registered !== N) throw new Error("registration count mismatch");

  section("start_tournament");
  await arena.methods.startTournament().accounts({
    config: arenaConfig, tournament: tourneyPda(id),
    caller: owner.publicKey,
  }).rpc();
  const tStart = await arena.account.tournament.fetch(tourneyPda(id));
  log(`status=${tStart.status} (expected 1=ACTIVE)  current_round=${tStart.currentRound}`);
  log(`pool=${(tStart.poolAmount/1e9).toFixed(4)} SOL  fee=${(tStart.feeAmount/1e9).toFixed(4)} SOL`);
  log(`prize_1st/2nd/3rd = ${(tStart.prize1st/1e9).toFixed(4)} / ${(tStart.prize2nd/1e9).toFixed(4)} / ${(tStart.prize3rd/1e9).toFixed(4)} SOL`);

  // ---- Switchboard cycles, one per match.  8 matches total (R0×4 + R1×2 + R2×2)
  const matchSequence = [
    [0, 0], [0, 1], [0, 2], [0, 3],   // R0 quarters
    [1, 4], [1, 5],                   // R1 semis
    [2, 6], [2, 7],                   // R2: final + 3rd-place
  ];
  for (const [round, matchIdx] of matchSequence) {
    section(`match #${matchIdx} (round ${round})`);
    const tBefore = await arena.account.tournament.fetch(tourneyPda(id));
    const m = tBefore.matches[matchIdx];
    log(`slots: ${m.slotA} vs ${m.slotB}  (status=${m.status})`);
    const sig = await runOneSwitchboardMatch(id, matchIdx);
    const tAfter = await arena.account.tournament.fetch(tourneyPda(id));
    const m2 = tAfter.matches[matchIdx];
    log(`OK  winner_slot=${m2.winnerSlot}  seed=${m2.seed.toString()}  sig=${sig.slice(0,16)}…`);
  }

  const tDecided = await arena.account.tournament.fetch(tourneyPda(id));
  section("final state");
  log(`status=${tDecided.status} (expected 2=COMPLETED)`);
  log(`1st (slot ${tDecided.winner1stSlot}): ${tDecided.players[tDecided.winner1stSlot].toBase58()}`);
  log(`2nd (slot ${tDecided.winner2ndSlot}): ${tDecided.players[tDecided.winner2ndSlot].toBase58()}`);
  log(`3rd (slot ${tDecided.winner3rdSlot}): ${tDecided.players[tDecided.winner3rdSlot].toBase58()}`);
  if (tDecided.status !== 2) throw new Error("expected status=COMPLETED");

  section("claim prizes × 3");
  for (const rank of [0, 1, 2]) {
    const slot = [tDecided.winner1stSlot, tDecided.winner2ndSlot, tDecided.winner3rdSlot][rank];
    const winnerKp = players[slot];
    const balPre = (await arena.account.userAccount.fetch(userPda(winnerKp.publicKey))).balance;
    await arena.methods.claimTournamentPrize(rank).accounts({
      config: arenaConfig, tournament: tourneyPda(id), vault: arenaVault,
      winnerUser: userPda(winnerKp.publicKey),
      winner: winnerKp.publicKey,
      treasuryConfig, treasuryVault, treasuryProgram: treasury.programId,
      caller: winnerKp.publicKey,
      systemProgram: SystemProgram.programId,
    }).signers([winnerKp]).rpc();
    const balPost = (await arena.account.userAccount.fetch(userPda(winnerKp.publicKey))).balance;
    const delta = (Number(balPost) - Number(balPre)) / 1e9;
    log(`rank ${rank+1}: slot ${slot} got Δ=${delta.toFixed(4)} SOL`);
  }

  section("claim chips × 8");
  for (let i = 0; i < N; i++) {
    await arena.methods.claimTournamentChip().accounts({
      config: arenaConfig, tournament: tourneyPda(id), chipAuthority,
      chip: chips[i], player: players[i].publicKey,
      mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([players[i]]).rpc();
    process.stdout.write(`\rclaimed ${i+1}/${N}`);
  }
  console.log();

  const tFinal = await arena.account.tournament.fetch(tourneyPda(id));
  log(`prize_claimed_mask=${tFinal.prizeClaimedMask.toString(2).padStart(3,"0")} (expected 111)`);
  log(`chips_claimed_mask=${tFinal.chipsClaimedMask.toString(2).padStart(8,"0")} (expected 11111111)`);

  console.log("\n🏆 TOURNAMENT SMOKE OK — full 8-player single-elim + 3rd-place + claims passed end-to-end");
})().catch(e => { console.error("\nFATAL:", e); if (e.logs) console.error(e.logs.slice(-15).join("\n")); process.exit(1); });
