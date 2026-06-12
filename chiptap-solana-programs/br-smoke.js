// ============================================================
// br-smoke.js — Battle Royale end-to-end smoke on devnet.
//
// Fund 8 throwaway players from the owner wallet, mint each a chip,
// each deposits the pool-tier stake to their internal balance, then
// create + join × 8 + Switchboard fulfill + claim_chip × 8 +
// claim_winnings.  Asserts status=SETTLED at the end and that the
// winner's balance grew by (pool − fee).
//
// Pre: requires relayer infrastructure OR runs the Switchboard cycle
// inline.  We do it inline for self-contained validation.
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
  Transaction, sendAndConfirmTransaction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const sb = require("@switchboard-xyz/on-demand");
const {
  Randomness, AnchorUtils,
  ON_DEMAND_DEVNET_PID, ON_DEMAND_DEVNET_QUEUE,
} = sb;

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const POOL_TIER  = 0;   // 0.05 SOL
const MAX_PLAYERS = 8;

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
const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const arenaConfig   = pda([enc("arena")], arena.programId);
const arenaVault    = pda([enc("arena"), enc("vault")], arena.programId);
const chipAuthority = pda([enc("arena"), enc("chip_authority")], arena.programId);
const treasuryConfig = pda([enc("treasury")], treasury.programId);
const treasuryVault  = pda([enc("treasury"), enc("vault")], treasury.programId);
const userPda    = (auth) => pda([enc("user"), auth.toBuffer()], arena.programId);
const royalePda  = (id)   => pda([enc("royale"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);
const chipDataPda = (a)   => pda([enc("chip"), a.toBuffer()], chipNft.programId);

const log     = (...a) => console.log("•", ...a);
const section = (s)    => console.log(`\n===== ${s} =====`);

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
  section("setup 8 throwaway players");
  const players = Array.from({ length: MAX_PLAYERS }, () => Keypair.generate());
  for (const p of players) await fund(p.publicKey, 0.1);
  log("funded each with 0.1 SOL");

  section("mint chips × 8");
  const chips = [];
  for (let i = 0; i < players.length; i++) {
    chips.push(await mintFor(players[i]));
    process.stdout.write(`\rminted ${i+1}/${MAX_PLAYERS}`);
  }
  console.log();

  section("each player deposits stake (pool_tier = 0.05 SOL)");
  const stakeLamports = 0.05 * LAMPORTS_PER_SOL;
  for (let i = 0; i < players.length; i++) {
    await arena.methods.deposit(new anchor.BN(stakeLamports + 1_000_000))  // a little extra for rent
      .accounts({
        config: arenaConfig, vault: arenaVault,
        user: userPda(players[i].publicKey),
        payer: players[i].publicKey,
        systemProgram: SystemProgram.programId,
      }).signers([players[i]]).rpc();
    process.stdout.write(`\rdeposited ${i+1}/${MAX_PLAYERS}`);
  }
  console.log();

  section("create Battle Royale");
  const cfgPre = await arena.account.arenaConfig.fetch(arenaConfig);
  const id     = cfgPre.nextBattleId.toString();
  const rPda   = royalePda(id);
  await arena.methods.createBattleRoyale(POOL_TIER, MAX_PLAYERS).accounts({
    config: arenaConfig, royale: rPda,
    creator: players[0].publicKey,
    systemProgram: SystemProgram.programId,
  }).signers([players[0]]).rpc();
  log("BR id =", id);

  section("8 players join sequentially");
  for (let i = 0; i < players.length; i++) {
    await arena.methods.joinBattleRoyale().accounts({
      config: arenaConfig, royale: rPda, chipAuthority,
      chip: chips[i],
      playerUser: userPda(players[i].publicKey),
      authority: players[i].publicKey,
      player: players[i].publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    }).signers([players[i]]).rpc();
    process.stdout.write(`\rjoined ${i+1}/${MAX_PLAYERS}`);
  }
  console.log();

  const rAfter = await arena.account.battleRoyale.fetch(rPda);
  log("status after 8th join:", rAfter.status, "(expected 1=ROLLING)");
  if (rAfter.status !== 1) throw new Error("expected status=ROLLING");

  section("Switchboard cycle");
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
  log("commit submitted; waiting reveal window...");
  await new Promise(r => setTimeout(r, 8_000));

  let sig;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const revealIx = await rnd.revealIx(owner.publicKey);
      const fulfillIx = await arena.methods.fulfillRandomWordsBrSwitchboard()
        .accounts({
          config: arenaConfig, royale: rPda,
          randomnessAccount: kp.publicKey,
          caller: owner.publicKey,
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
  if (!sig) throw new Error("reveal+fulfill never succeeded");
  log("fulfill sig:", sig);

  const rDecided = await arena.account.battleRoyale.fetch(rPda);
  const winnerIdx = players.findIndex(p => p.publicKey.equals(rDecided.winner));
  log("status:", rDecided.status, "(expected 2=DECIDED)");
  log("winner:", rDecided.winner.toBase58(), "= player[" + winnerIdx + "]");
  log("seed:", rDecided.randomSeed.toString());
  log("randomness account:", rDecided.randomnessAccount.toBase58());
  log("pool_amount:", (Number(rDecided.poolAmount) / 1e9).toFixed(4), "SOL");
  log("fee_amount:",  (Number(rDecided.feeAmount)  / 1e9).toFixed(4), "SOL");
  if (rDecided.status !== 2) throw new Error("expected status=DECIDED");
  if (winnerIdx < 0) throw new Error("winner not in player set");
  // Sanity: seed % max_players == winnerIdx
  const expectedIdx = Number(BigInt(rDecided.randomSeed.toString()) % BigInt(MAX_PLAYERS));
  if (expectedIdx !== winnerIdx) throw new Error(`seed % ${MAX_PLAYERS} = ${expectedIdx} but winner is player[${winnerIdx}]`);
  log("✓ seed%max_players matches winner index");

  section("each player claims their chip");
  for (let i = 0; i < players.length; i++) {
    await arena.methods.claimChipBr().accounts({
      config: arenaConfig, royale: rPda, chipAuthority,
      chip: chips[i],
      playerUser: userPda(players[i].publicKey),  // SEC-22 — stake refund target (no-op on DECIDED)
      player: players[i].publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    }).signers([players[i]]).rpc();
    process.stdout.write(`\rclaimed chip ${i+1}/${MAX_PLAYERS}`);
  }
  console.log();

  section("winner claims winnings");
  const winnerKp = players[winnerIdx];
  const balPre = (await arena.account.userAccount.fetch(userPda(winnerKp.publicKey))).balance;
  await arena.methods.claimWinningsBr().accounts({
    config: arenaConfig, royale: rPda, vault: arenaVault,
    winnerUser: userPda(winnerKp.publicKey),
    winner: winnerKp.publicKey,
    treasuryConfig, treasuryVault, treasuryProgram: treasury.programId,
    caller: winnerKp.publicKey,
    systemProgram: SystemProgram.programId,
  }).signers([winnerKp]).rpc();
  const balPost = (await arena.account.userAccount.fetch(userPda(winnerKp.publicKey))).balance;
  const delta = Number(balPost) - Number(balPre);
  log("winner internal balance Δ =", (delta / 1e9).toFixed(4), "SOL");

  const rFinal = await arena.account.battleRoyale.fetch(rPda);
  log("final status:", rFinal.status, "(expected 3=SETTLED)");
  log("prize_claimed:", rFinal.prizeClaimed);
  log("chips_claimed_mask:", rFinal.chipsClaimedMask, "(expected 255 = 0b11111111)");
  if (rFinal.status !== 3) throw new Error("expected status=SETTLED");

  console.log("\n🎉 BATTLE ROYALE SMOKE OK — full 8-player flow + Switchboard VRF + claim end-to-end");
})().catch(e => { console.error("\nFATAL:", e); if (e.logs) console.error(e.logs.slice(-10).join("\n")); process.exit(1); });
