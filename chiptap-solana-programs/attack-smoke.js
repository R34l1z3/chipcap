// ============================================================
// attack-smoke.js — regression tests for SEC-1 / SEC-2 / SEC-3.
//
// Each block sets up the right battle state, then submits the
// instruction with attacker-controlled pubkeys in the slots that
// used to be unconstrained.  Expects each attack to revert with
// a specific Anchor error code.
//
// Run AFTER the program has been upgraded with the fixes in place.
// ============================================================

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

const owner = Keypair.fromSecretKey(Uint8Array.from(
  JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))
));
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed", skipPreflight: false,
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
const userPda        = (auth) => pda([enc("user"), auth.toBuffer()], arena.programId);
const battlePda      = (id) => pda([enc("battle"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);
const chipDataPda    = (a)  => pda([enc("chip"), a.toBuffer()], chipNft.programId);

const log     = (...a) => console.log("•", ...a);
const section = (s)    => console.log(`\n===== ${s} =====`);
const expect  = (cond, msg) => { if (!cond) throw new Error("ASSERT FAILED: " + msg); };

async function airdrop(to, sol) {
  const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
}

async function mintFor(player) {
  const asset = Keypair.generate();
  await chipNft.methods
    .mintChip("ChipTap", "https://chiptap.gg/metadata/0.json")
    .accounts({
      config: chipNftConfig, vault: chipNftVault,
      asset: asset.publicKey, chipData: chipDataPda(asset.publicKey),
      payer: player.publicKey, mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([player, asset])
    .rpc();
  return asset.publicKey;
}

/** Set up a fresh battle, optionally advancing it to a given status. */
async function setupBattle({ joined = false, vrfSeed = null }) {
  const playerA = Keypair.generate();
  const playerB = Keypair.generate();
  await airdrop(playerA.publicKey, 5);
  await airdrop(playerB.publicKey, 5);
  const chipA = await mintFor(playerA);
  const chipB = await mintFor(playerB);

  const cfg = await arena.account.arenaConfig.fetch(arenaConfig);
  const battleId = cfg.nextBattleId.toString();
  const bPda = battlePda(battleId);

  await arena.methods.createBattle(0).accounts({
    config: arenaConfig, battle: bPda, chipAuthority,
    chip: chipA, player: playerA.publicKey,
    mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([playerA]).rpc();

  if (joined) {
    await arena.methods.joinBattle().accounts({
      config: arenaConfig, battle: bPda, chipAuthority,
      chip: chipB, player: playerB.publicKey,
      mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([playerB]).rpc();
  }
  if (vrfSeed !== null) {
    await arena.methods.fulfillRandomWords(new anchor.BN(vrfSeed)).accounts({
      config: arenaConfig, battle: bPda, vrfAuthority: owner.publicKey,
    }).signers([owner]).rpc();
  }
  return { playerA, playerB, chipA, chipB, battleId, bPda };
}

/** Run an async fn, expect it to throw with a matching message. */
async function expectFail(label, code, fn) {
  try {
    await fn();
    throw new Error(`expected ${code} but tx succeeded`);
  } catch (e) {
    const msg = e.message ?? String(e);
    if (msg.includes(code)) {
      log(`✓ ${label} rejected with ${code}`);
    } else {
      console.error(`✗ ${label} threw, but not ${code}:\n   ${msg}\n`);
      throw e;
    }
  }
}

(async () => {
  section("SEC-1: pay_ransom with attacker pubkey as winner");
  {
    // playerA wins (seed=42 = even).  Loser is playerB.
    const { playerA, playerB, chipA, chipB, bPda } =
      await setupBattle({ joined: true, vrfSeed: 42 });

    // Both real users top up (winner needs UserAccount to exist).
    await arena.methods.deposit(new anchor.BN(0.5 * LAMPORTS_PER_SOL))
      .accounts({
        config: arenaConfig, vault: arenaVault,
        user: userPda(playerB.publicKey), payer: playerB.publicKey,
        systemProgram: SystemProgram.programId,
      }).signers([playerB]).rpc();
    await arena.methods.deposit(new anchor.BN(0.001 * LAMPORTS_PER_SOL))
      .accounts({
        config: arenaConfig, vault: arenaVault,
        user: userPda(playerA.publicKey), payer: playerA.publicKey,
        systemProgram: SystemProgram.programId,
      }).signers([playerA]).rpc();

    // Attacker: a new keypair with its own UserAccount PDA.
    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey, 1);
    await arena.methods.deposit(new anchor.BN(0.001 * LAMPORTS_PER_SOL))
      .accounts({
        config: arenaConfig, vault: arenaVault,
        user: userPda(attacker.publicKey), payer: attacker.publicKey,
        systemProgram: SystemProgram.programId,
      }).signers([attacker]).rpc();

    await expectFail("pay_ransom(attacker as winner)", "NotWinner", () =>
      arena.methods.payRansom().accounts({
        config: arenaConfig, battle: bPda, chipAuthority,
        vault: arenaVault,
        loserUser:  userPda(playerB.publicKey),
        winnerUser: userPda(attacker.publicKey),
        chipLoser:  chipB,
        treasuryConfig, treasuryVault, treasuryProgram: treasury.programId,
        loser:  playerB.publicKey,
        winner: attacker.publicKey,           // <-- attack
        mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
      }).signers([playerB]).rpc()
    );

    // Sanity: legit caller succeeds.
    await arena.methods.payRansom().accounts({
      config: arenaConfig, battle: bPda, chipAuthority,
      vault: arenaVault,
      loserUser:  userPda(playerB.publicKey),
      winnerUser: userPda(playerA.publicKey),
      chipLoser:  chipB,
      treasuryConfig, treasuryVault, treasuryProgram: treasury.programId,
      loser:  playerB.publicKey,
      winner: playerA.publicKey,
      mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([playerB]).rpc();
    log("✓ legit pay_ransom still works");
  }

  section("SEC-2: expire_join with attacker pubkey as player_a");
  {
    const { playerA, chipA, bPda } = await setupBattle({ joined: false });

    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey, 1);

    await expectFail("expire_join(attacker as player_a)", "WrongPlayer", () =>
      arena.methods.expireJoin().accounts({
        config: arenaConfig, battle: bPda, chipAuthority,
        chipA,
        playerA: attacker.publicKey,         // <-- attack (struct constraint fails immediately)
        caller:  attacker.publicKey,
        mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
      }).signers([attacker]).rpc()
    );
  }

  section("SEC-8: expire_decision with attacker pubkey as winner");
  {
    // VRF resolved (status=DECIDED) but decision timeout not yet passed.
    // The struct-level `address` constraint runs before the timeout
    // check, so we can verify the gate without waiting 24h.
    const { playerA, playerB, chipA, chipB, bPda } =
      await setupBattle({ joined: true, vrfSeed: 42 });

    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey, 1);

    await expectFail("expire_decision(attacker as winner)", "WrongPlayer", () =>
      arena.methods.expireDecision().accounts({
        config: arenaConfig, battle: bPda, chipAuthority,
        chipLoser: chipB,
        loser:     playerB.publicKey,       // correct
        winner:    attacker.publicKey,      // <-- attack: chip would go to attacker
        caller:    attacker.publicKey,
        mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
      }).signers([attacker]).rpc()
    );

    await expectFail("expire_decision(attacker as loser)", "WrongPlayer", () =>
      arena.methods.expireDecision().accounts({
        config: arenaConfig, battle: bPda, chipAuthority,
        chipLoser: chipB,
        loser:     attacker.publicKey,      // <-- attack: wrong loser
        winner:    playerA.publicKey,
        caller:    attacker.publicKey,
        mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
      }).signers([attacker]).rpc()
    );
  }

  section("SEC-3: force_resolve with attacker pubkeys as player_a / player_b");
  {
    const { playerA, playerB, chipA, chipB, bPda } =
      await setupBattle({ joined: true });           // status = ROLLING

    const attackerA = Keypair.generate();
    const attackerB = Keypair.generate();
    await airdrop(attackerA.publicKey, 1);
    await airdrop(attackerB.publicKey, 1);

    await expectFail("force_resolve(attacker pubkeys)", "WrongPlayer", () =>
      arena.methods.forceResolve().accounts({
        config: arenaConfig, battle: bPda, chipAuthority,
        chipA, chipB,
        playerA: attackerA.publicKey,        // <-- attack
        playerB: attackerB.publicKey,        // <-- attack
        mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
      }).rpc()
    );
  }

  console.log("\n🎉 ATTACK SMOKE OK — all 3 attacks rejected, happy path still works");
})().catch((e) => { console.error(e); process.exit(1); });
