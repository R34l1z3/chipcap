// ============================================================
// src/switchboard.js — SEC-21 / SEC-22 Option B: Switchboard On-Demand VRF
//
// Manual driver — sdk's `commitAndReveal` has a bug where it
// builds a v0 tx without specifying the payer; we replicate the
// logic ourselves with proper signers.
//
// Flow per VRF request (1v1 battle OR Battle Royale):
//   1. createAndCommitIxs → tx with [createIx, commitIx], signed by
//      payer + the freshly-generated randomnessKp
//   2. wait queue's reveal-delay (~10s)
//   3. revealIx() — SDK fetches the oracle's signed reveal payload
//      and returns an ix that consumes it
//   4. tx2 = [revealIx, ourFulfillIx] signed by payer, atomic
//
// `runSwitchboardCycle` is now ix-agnostic — the caller passes a
// `buildFulfillIx(randomnessAccountPubkey) => Promise<TxIx>` callback,
// so the same driver serves 1v1 (`fulfill_random_words_switchboard`,
// SEC-21) AND Battle Royale (`fulfill_random_words_br_switchboard`,
// SEC-22).  No code duplication.
// ============================================================

import sb from "@switchboard-xyz/on-demand";
const {
  Randomness, AnchorUtils,
  ON_DEMAND_DEVNET_PID, ON_DEMAND_DEVNET_QUEUE,
  ON_DEMAND_MAINNET_PID, ON_DEMAND_MAINNET_QUEUE,
} = sb;

export function switchboardEndpoints(cluster) {
  if (cluster === "mainnet" || cluster === "mainnet-beta") {
    return { programId: ON_DEMAND_MAINNET_PID, queue: ON_DEMAND_MAINNET_QUEUE };
  }
  return { programId: ON_DEMAND_DEVNET_PID, queue: ON_DEMAND_DEVNET_QUEUE };
}

/**
 * Run the full Switchboard On-Demand commit→reveal→fulfill cycle.
 *
 * @param {object} args
 * @param {Connection} args.connection
 * @param {Keypair}    args.payer       — pays SOL + signs all txs
 * @param {PublicKey}  args.queuePubkey — Switchboard queue (devnet vs mainnet)
 * @param {(randomnessAccount: PublicKey) => Promise<TransactionInstruction>}
 *                      args.buildFulfillIx — our program's "consume the
 *                      revealed seed" ix.  Receives the randomness account
 *                      pubkey so it can wire it as an account.
 * @returns {Promise<{ randomnessAccount: PublicKey, fulfillSig: string }>}
 */
export async function runSwitchboardCycle({
  connection, payer, queuePubkey, buildFulfillIx,
}) {
  // Use a provider that knows our payer wallet (otherwise SDK helpers
  // can't sign / resolve the authority).
  const { AnchorProvider, Wallet } = await import("@coral-xyz/anchor");
  const { ComputeBudgetProgram, Transaction, sendAndConfirmTransaction } =
    await import("@solana/web3.js");

  const sbProvider = new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed", preflightCommitment: "confirmed",
  });
  const sbProgram = await AnchorUtils.loadProgramFromProvider(sbProvider);

  // STEP 1 — create + commit.
  const [randomness, accountKeypair, createIxs] =
    await Randomness.createAndCommitIxs(sbProgram, queuePubkey, payer.publicKey);

  const cuPrice = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 });
  const cuLimit = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  const tx1 = new Transaction().add(cuPrice, cuLimit, ...createIxs);
  tx1.feePayer = payer.publicKey;
  await sendAndConfirmTransaction(connection, tx1, [payer, accountKeypair], {
    commitment: "confirmed",
  });

  // STEP 2 — wait for queue's reveal-delay window.  Switchboard oracles
  // observe the commit and prepare signed responses during these slots.
  await new Promise((r) => setTimeout(r, 8_000));

  // STEP 3 — retry-loop the manual reveal+fulfill build, since
  // `revealIx()` throws if the oracle gateway hasn't responded yet.
  let fulfillSig;
  let lastErr;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      // revealIx() internally polls the oracle gateway over HTTP for
      // its signed response; this can throw repeatedly until the
      // gateway is ready (~5-30 s on a healthy queue).
      const revealIx = await randomness.revealIx(payer.publicKey);

      // Our program-specific ix that consumes the seed.  The caller
      // decides whether this is 1v1 or BR; we don't care here.
      const fulfillIx = await buildFulfillIx(accountKeypair.publicKey);

      const tx2 = new Transaction().add(cuPrice, cuLimit, revealIx, fulfillIx);
      tx2.feePayer = payer.publicKey;
      fulfillSig = await sendAndConfirmTransaction(connection, tx2, [payer], {
        commitment: "confirmed", skipPreflight: true,
      });
      break;
    } catch (e) {
      lastErr = e;
      // Backoff a bit between attempts — Switchboard nodes can take
      // up to ~30 s to publish gateway-reachable signatures.
      await new Promise((r) => setTimeout(r, 3_000));
    }
  }
  if (!fulfillSig) {
    throw lastErr ?? new Error("Switchboard reveal+fulfill failed after 20 attempts");
  }

  return { randomnessAccount: accountKeypair.publicKey, fulfillSig };
}
