// ============================================================
// kick-battle.js — Manually run the Switchboard cycle for a stuck
// 1v1 battle in ROLLING (used when the relayer was down at BattleJoined).
// Mirrors kick-tournament.js but for fulfill_random_words_switchboard.
//
//   B_ID=23 node kick-battle.js
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair,
  Transaction, sendAndConfirmTransaction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const sb = require("@switchboard-xyz/on-demand");
const { Randomness, AnchorUtils, ON_DEMAND_DEVNET_QUEUE } = sb;

const B_ID = parseInt(process.env.B_ID || "23", 10);
const RPC  = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

const arena = new anchor.Program(
  JSON.parse(fs.readFileSync(path.join(__dirname, "target", "idl", "battle_arena.json"))),
  provider,
);
const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, arena.programId)[0];
const arenaConfig = pda([enc("arena")]);
const bPda = pda([enc("battle"), new anchor.BN(B_ID).toArrayLike(Buffer, "le", 8)]);

(async () => {
  const before = await arena.account.battle.fetch(bPda);
  console.log(`battle #${B_ID} status=${before.status} (1=ROLLING expected)`);
  if (before.status !== 1) { console.log("not ROLLING — nothing to do."); return; }

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
  console.log("commit submitted; waiting reveal window…");
  await new Promise((r) => setTimeout(r, 8_000));

  let sig, lastErr;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const revealIx = await rnd.revealIx(owner.publicKey);
      const fulfillIx = await arena.methods.fulfillRandomWordsSwitchboard().accounts({
        config: arenaConfig, battle: bPda,
        randomnessAccount: kp.publicKey, caller: owner.publicKey,
      }).instruction();
      const tx2 = new Transaction().add(cuPrice, cuLimit, revealIx, fulfillIx);
      tx2.feePayer = owner.publicKey;
      sig = await sendAndConfirmTransaction(connection, tx2, [owner], {
        commitment: "confirmed", skipPreflight: true,
      });
      break;
    } catch (e) { lastErr = e; await new Promise((r) => setTimeout(r, 3_000)); }
  }
  if (!sig) throw lastErr ?? new Error("reveal+fulfill failed");
  console.log("fulfill sig:", sig.slice(0, 24) + "…");

  const after = await arena.account.battle.fetch(bPda);
  const winnerIsA = after.winner.equals(after.playerA);
  console.log(`status=${after.status} (2=DECIDED)`);
  console.log(`seed=${after.randomSeed.toString()}  → winner = player_${winnerIsA ? "A" : "B"} (${after.winner.toBase58()})`);
  console.log(`loser = ${after.loser.toBase58()}`);
})().catch(e => { console.error("FATAL:", e.message || e); if (e.logs) console.error(e.logs.slice(-5).join("\n")); process.exit(1); });
