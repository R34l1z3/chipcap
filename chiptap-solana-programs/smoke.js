// ============================================================
// smoke.js — full happy-path battle on a running validator.
// Mirrors EVM e2e-battle.js for Solana.  Prints program-emitted
// events for each tx so you can see the indexer-shaped data.
// ============================================================

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

const walletPath = path.join(os.homedir(), ".config/solana/id.json");
const ownerSecret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
const owner = Keypair.fromSecretKey(Uint8Array.from(ownerSecret));
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
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

const treasuryConfig = pda([enc("treasury")], treasury.programId);
const treasuryVault  = pda([enc("treasury"), enc("vault")], treasury.programId);

const chipNftConfig  = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault   = pda([enc("chip_nft"), enc("vault")], chipNft.programId);

const arenaConfig    = pda([enc("arena")], arena.programId);
const arenaVault     = pda([enc("arena"), enc("vault")], arena.programId);
const chipAuthority  = pda([enc("arena"), enc("chip_authority")], arena.programId);

const userPda = (auth)  => pda([enc("user"), auth.toBuffer()], arena.programId);
const battlePda = (id)  => pda([enc("battle"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);
const chipDataPda = (a) => pda([enc("chip"), a.toBuffer()], chipNft.programId);

const log     = (...a) => console.log("•", ...a);
const section = (s)    => console.log(`\n===== ${s} =====`);

async function airdrop(to, sol) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function dumpEvents(sig, label) {
  const tx = await connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  if (!tx?.meta?.logMessages) return;
  const PROGRAM_DATA = "Program data: ";
  const coders = {
    treasury: new anchor.BorshEventCoder(treasuryIdl),
    chip_nft: new anchor.BorshEventCoder(chipNftIdl),
    arena:    new anchor.BorshEventCoder(arenaIdl),
  };
  for (const line of tx.meta.logMessages) {
    if (!line.startsWith("Program data: ")) continue;
    const b64 = line.slice(PROGRAM_DATA.length);
    for (const [k, c] of Object.entries(coders)) {
      try {
        const ev = c.decode(b64);
        if (ev) { console.log(`  📡 [${label}] ${k}.${ev.name}`, JSON.stringify(ev.data, (_,v) => v?.toBase58?.() ?? (typeof v === "bigint" ? v.toString() : v))); break; }
      } catch {}
    }
  }
}

(async () => {
  section("setup");
  const playerA = Keypair.generate();
  const playerB = Keypair.generate();
  log("playerA:", playerA.publicKey.toBase58());
  log("playerB:", playerB.publicKey.toBase58());

  await airdrop(playerA.publicKey, 5);
  await airdrop(playerB.publicKey, 5);

  // ---- mint chips ----
  section("mint × 2 (Common)");
  async function mintFor(player) {
    const asset = Keypair.generate();
    const sig = await chipNft.methods
      .mintChip("ChipTap", "https://chiptap.gg/metadata/0.json")
      .accounts({
        config:   chipNftConfig,
        vault:    chipNftVault,
        asset:    asset.publicKey,
        chipData: chipDataPda(asset.publicKey),
        payer:    player.publicKey,
        mplCore:  MPL_CORE,
        systemProgram: SystemProgram.programId,
      })
      .signers([player, asset])
      .rpc();
    log("minted", asset.publicKey.toBase58(), "for", player.publicKey.toBase58().slice(0,8));
    await dumpEvents(sig, "mint");
    return asset.publicKey;
  }
  const chipA = await mintFor(playerA);
  const chipB = await mintFor(playerB);

  // ---- create battle ----
  section("create battle (tier 0 = 0.05 SOL)");
  const cfg = await arena.account.arenaConfig.fetch(arenaConfig);
  const battleId = cfg.nextBattleId.toString();
  log("nextBattleId =", battleId);
  let sig = await arena.methods
    .createBattle(0)
    .accounts({
      config: arenaConfig,
      battle: battlePda(battleId),
      chipAuthority,
      chip:   chipA,
      player: playerA.publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([playerA])
    .rpc();
  log("create signature:", sig);
  await dumpEvents(sig, "create");

  // ---- join battle ----
  section("join");
  sig = await arena.methods
    .joinBattle()
    .accounts({
      config: arenaConfig,
      battle: battlePda(battleId),
      chipAuthority,
      chip:   chipB,
      player: playerB.publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([playerB])
    .rpc();
  log("join signature:", sig);
  await dumpEvents(sig, "join");

  let battle = await arena.account.battle.fetch(battlePda(battleId));
  log("status =", battle.status, "(1=ROLLING)");

  // ---- fulfill VRF (mock: owner is vrf_authority) ----
  section("fulfill VRF — seed=42 (even → playerA wins)");
  sig = await arena.methods
    .fulfillRandomWords(new anchor.BN(42))
    .accounts({
      config: arenaConfig,
      battle: battlePda(battleId),
      vrfAuthority: owner.publicKey,
    })
    .signers([owner])
    .rpc();
  log("vrf signature:", sig);
  await dumpEvents(sig, "vrf");

  battle = await arena.account.battle.fetch(battlePda(battleId));
  log("winner:", battle.winner.toBase58().slice(0,8), "loser:", battle.loser.toBase58().slice(0,8));

  // ---- deposit for loser (so they can pay ransom) ----
  section("loser deposits 0.5 SOL into UserAccount");
  sig = await arena.methods
    .deposit(new anchor.BN(0.5 * LAMPORTS_PER_SOL))
    .accounts({
      config: arenaConfig,
      vault:  arenaVault,
      user:   userPda(playerB.publicKey),
      payer:  playerB.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([playerB])
    .rpc();
  log("deposit sig:", sig);
  await dumpEvents(sig, "deposit");

  // SEC-10 — winner's UserAccount PDA via `ensure_user_account`,
  // signed by the LOSER (anyone can be the payer, and the loser is
  // already going to sign pay_ransom — same wallet popup in the UI).
  // No interaction from the winner needed.
  section("loser pre-creates winner's UserAccount (SEC-10)");
  await arena.methods
    .ensureUserAccount()
    .accounts({
      user:      userPda(playerA.publicKey),
      authority: playerA.publicKey,
      payer:     playerB.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .signers([playerB])
    .rpc();
  log("winner UserAccount ensured by loser");

  // ---- claim winner chip ----
  section("winner claims chip");
  sig = await arena.methods
    .claimWinnerChip()
    .accounts({
      config: arenaConfig,
      battle: battlePda(battleId),
      chipAuthority,
      chip:   chipA,
      winner: playerA.publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([playerA])
    .rpc();
  log("claim sig:", sig);

  // ---- pay ransom ----
  section("loser pays ransom");
  sig = await arena.methods
    .payRansom()
    .accounts({
      config: arenaConfig,
      battle: battlePda(battleId),
      chipAuthority,
      vault:  arenaVault,
      loserUser:  userPda(playerB.publicKey),
      winnerUser: userPda(playerA.publicKey),
      chipLoser:  chipB,
      treasuryConfig,
      treasuryVault,
      treasuryProgram: treasury.programId,
      loser:  playerB.publicKey,
      winner: playerA.publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([playerB])
    .rpc();
  log("pay-ransom sig:", sig);
  await dumpEvents(sig, "settle");

  // ---- final balances ----
  section("final state");
  const ua = await arena.account.userAccount.fetch(userPda(playerA.publicKey));
  const ub = await arena.account.userAccount.fetch(userPda(playerB.publicKey));
  log("playerA balance =", Number(ua.balance) / LAMPORTS_PER_SOL, "SOL  (winner payout — 0.0475)");
  log("playerB balance =", Number(ub.balance) / LAMPORTS_PER_SOL, "SOL  (deposit minus pool — 0.45)");

  battle = await arena.account.battle.fetch(battlePda(battleId));
  log("battle status =", battle.status, "(3=SETTLED)");
  log("resolution    =", battle.resolution, "(1=PAID)");

  console.log("\n🎉 SMOKE OK\n");
})().catch((e) => { console.error("smoke failed:", e); process.exit(1); });
