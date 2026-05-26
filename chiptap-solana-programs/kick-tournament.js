// ============================================================
// kick-tournament.js — Manually run Switchboard cycles for any
// PENDING matches in the current round of a tournament.
//
// Use when the relayer missed the TournamentMatchRolling events
// (e.g. it crashed and restarted after start_tournament).  Idempotent:
// matches already DECIDED are skipped on-chain.
//
//   T_ID=20 node kick-tournament.js
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair,
  Transaction, sendAndConfirmTransaction, ComputeBudgetProgram,
} = require("@solana/web3.js");
const sb = require("@switchboard-xyz/on-demand");
const { Randomness, AnchorUtils, ON_DEMAND_DEVNET_QUEUE } = sb;

const T_ID = parseInt(process.env.T_ID || "20", 10);
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
const tPda = pda([enc("tournament"), new anchor.BN(T_ID).toArrayLike(Buffer, "le", 8)]);

async function fulfillMatch(matchIdx) {
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

  await new Promise((r) => setTimeout(r, 8_000));

  let sig, lastErr;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      const revealIx = await rnd.revealIx(owner.publicKey);
      const fulfillIx = await arena.methods.advanceMatchSwitchboard(matchIdx).accounts({
        config: arenaConfig, tournament: tPda,
        randomnessAccount: kp.publicKey, caller: owner.publicKey,
      }).instruction();
      const tx2 = new Transaction().add(cuPrice, cuLimit, revealIx, fulfillIx);
      tx2.feePayer = owner.publicKey;
      sig = await sendAndConfirmTransaction(connection, tx2, [owner], {
        commitment: "confirmed", skipPreflight: true,
      });
      break;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  if (!sig) throw lastErr ?? new Error(`m${matchIdx}: reveal+fulfill failed`);
  return sig;
}

(async () => {
  console.log(`\n=== kick-tournament #${T_ID} ===\n`);
  while (true) {
    const t = await arena.account.tournament.fetch(tPda);
    console.log(`status=${t.status} round=${t.currentRound}`);
    if (t.status !== 1) {
      console.log("status != ACTIVE — nothing to fulfil, exiting.");
      break;
    }
    const pending = t.matches
      .map((m, i) => ({ m, i }))
      .filter(({ m }) => m.round === t.currentRound && m.status === 0);
    if (pending.length === 0) {
      console.log("no PENDING matches in current round — exiting.");
      break;
    }
    console.log(`fulfilling ${pending.length} match(es): ${pending.map(p => "m"+p.i).join(", ")}`);
    for (const { i } of pending) {
      console.log(`  → m${i}…`);
      try {
        const sig = await fulfillMatch(i);
        console.log(`  ✓ m${i} sig=${sig.slice(0, 16)}…`);
      } catch (e) {
        console.log(`  ✗ m${i} FAILED: ${e.message}`);
        if (e.logs) console.log(e.logs.slice(-3).join("\n"));
        process.exit(1);
      }
    }
    // Re-read; the LAST advance_match in the round bumps current_round
    // and seeds the next round's slot_a/b.  Loop to fulfil next round.
    await new Promise((r) => setTimeout(r, 2_000));
  }

  const final = await arena.account.tournament.fetch(tPda);
  console.log(`\nfinal: status=${final.status} round=${final.currentRound}`);
  if (final.status === 2) {
    console.log(`🏆 PODIUM:`);
    console.log(`  1st (slot ${final.winner1StSlot}): ${final.players[final.winner1StSlot]?.toBase58()}`);
    console.log(`  2nd (slot ${final.winner2NdSlot}): ${final.players[final.winner2NdSlot]?.toBase58()}`);
    console.log(`  3rd (slot ${final.winner3RdSlot}): ${final.players[final.winner3RdSlot]?.toBase58()}`);
  }
})().catch(e => { console.error("FATAL:", e); process.exit(1); });
