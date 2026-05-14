// Probe claim_winner_chip directly so we can see the exact program error.
const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const battleId = process.argv[2] || "1";

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner),
  { commitment: "confirmed", preflightCommitment: "confirmed" });
anchor.setProvider(provider);

const arenaIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "target/idl/battle_arena.json")));
const arena = new anchor.Program(arenaIdl, provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, arena.programId)[0];
const arenaConfig   = pda([enc("arena")]);
const chipAuthority = pda([enc("arena"), enc("chip_authority")]);
const battlePda     = pda([enc("battle"), new anchor.BN(battleId).toArrayLike(Buffer, "le", 8)]);

(async () => {
  const b = await arena.account.battle.fetch(battlePda);
  console.log("battle:", { status: b.status, winner: b.winner.toBase58(), playerA: b.playerA.toBase58(), chipA: b.chipA.toBase58(), chipB: b.chipB.toBase58() });
  const winnerChip = b.winner.equals(b.playerA) ? b.chipA : b.chipB;
  console.log("winnerChip =", winnerChip.toBase58());

  try {
    const sig = await arena.methods.claimWinnerChip().accounts({
      config: arenaConfig, battle: battlePda, chipAuthority,
      chip: winnerChip, winner: owner.publicKey,
      mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([owner]).rpc();
    console.log("claim OK sig:", sig);
  } catch (e) {
    console.error("claim FAILED:");
    console.error(e.message);
    if (e.logs) console.error("LOGS:\n" + e.logs.join("\n"));
  }
})();
