// ============================================================
// tests/smoke.ts — single happy-path run-through covering all
// programs.  Mirrors `chiptap-contracts/scripts/e2e-battle.js`.
// ============================================================

import * as anchor from "@coral-xyz/anchor";
import { BN } from "@coral-xyz/anchor";
import { LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";

import {
  setup, mintChip, deposit, getBattle, getUserAccount, pda,
  MPL_CORE_ID, type Fixture,
} from "./helpers";

describe("smoke — full battle (paid resolution)", function () {
  this.timeout(120_000);

  let fx: Fixture;

  before(async () => {
    fx = await setup();
  });

  it("runs: mint × 2, create, join, fulfill VRF, pay ransom, withdraw", async () => {
    const { arena, chipNft, treasury, owner, playerA, playerB } = fx;

    // ---- mint ----
    const chipA = await mintChip(fx, playerA, 0);
    const chipB = await mintChip(fx, playerB, 0);

    // ---- deposit (each player deposits 1 SOL) ----
    await deposit(fx, playerA, 1 * LAMPORTS_PER_SOL);
    await deposit(fx, playerB, 1 * LAMPORTS_PER_SOL);

    // ---- read pool tier 0 ($0.05 SOL) and battle id ----
    const cfg = await arena.account.arenaConfig.fetch(
      pda.arenaConfig(arena.programId),
    );
    const tier = 0;
    const battleId = cfg.nextBattleId.toString();
    const pool = cfg.poolAmounts[tier].toNumber();

    // ---- create battle ----
    await arena.methods
      .createBattle(tier)
      .accounts({
        config: pda.arenaConfig(arena.programId),
        battle: pda.battle(arena.programId, new BN(battleId)),
        chipAuthority: pda.chipAuthority(arena.programId),
        chip: chipA,
        player: playerA.publicKey,
        mplCore: MPL_CORE_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([playerA])
      .rpc();

    // ---- join battle ----
    await arena.methods
      .joinBattle()
      .accounts({
        config: pda.arenaConfig(arena.programId),
        battle: pda.battle(arena.programId, new BN(battleId)),
        chipAuthority: pda.chipAuthority(arena.programId),
        chip: chipB,
        player: playerB.publicKey,
        mplCore: MPL_CORE_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([playerB])
      .rpc();

    let b = await getBattle(fx, new BN(battleId));
    expect(b.status).to.equal(1); // ROLLING

    // ---- fulfill VRF (owner is default vrf_authority) ----
    // Even seed (42) → playerA wins.
    await arena.methods
      .fulfillRandomWords(new BN(42))
      .accounts({
        config: pda.arenaConfig(arena.programId),
        battle: pda.battle(arena.programId, new BN(battleId)),
        vrfAuthority: owner.publicKey,
      } as any)
      .signers([owner])
      .rpc();

    b = await getBattle(fx, new BN(battleId));
    expect(b.status).to.equal(2); // DECIDED
    expect(b.winner.toBase58()).to.equal(playerA.publicKey.toBase58());
    expect(b.loser.toBase58()).to.equal(playerB.publicKey.toBase58());

    // ---- claim winner chip (winner pulls A's chip back) ----
    await arena.methods
      .claimWinnerChip()
      .accounts({
        config: pda.arenaConfig(arena.programId),
        battle: pda.battle(arena.programId, new BN(battleId)),
        chipAuthority: pda.chipAuthority(arena.programId),
        chip: chipA,
        winner: playerA.publicKey,
        mplCore: MPL_CORE_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([playerA])
      .rpc();

    // ---- pay ransom (loser keeps chip B, sends pool→winner+treasury) ----
    await arena.methods
      .payRansom()
      .accounts({
        config: pda.arenaConfig(arena.programId),
        battle: pda.battle(arena.programId, new BN(battleId)),
        chipAuthority: pda.chipAuthority(arena.programId),
        vault: pda.arenaVault(arena.programId),
        loserUser:  pda.user(arena.programId, playerB.publicKey),
        winnerUser: pda.user(arena.programId, playerA.publicKey),
        chipLoser:  chipB,
        chipWinner: chipA,
        chipNftConfig: pda.chipNftConfig(chipNft.programId),
        chipDataA:    pda.chipData(chipNft.programId, chipA),
        chipDataB:    pda.chipData(chipNft.programId, chipB),
        chipNftProgram: chipNft.programId,
        treasuryConfig: pda.treasuryConfig(treasury.programId),
        treasuryVault:  pda.treasuryVault(treasury.programId),
        treasuryProgram: treasury.programId,
        loser:  playerB.publicKey,
        winner: playerA.publicKey,
        mplCore: MPL_CORE_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([playerB])
      .rpc();

    b = await getBattle(fx, new BN(battleId));
    expect(b.status).to.equal(3);     // SETTLED
    expect(b.resolution).to.equal(1); // PAID
    expect(b.paymentAmount.toNumber()).to.equal(pool);
    // 5% of pool
    expect(b.feeAmount.toNumber()).to.equal(Math.floor(pool * 500 / 10_000));

    // ---- internal balances ----
    const winnerAcct = await getUserAccount(fx, playerA.publicKey);
    const loserAcct  = await getUserAccount(fx, playerB.publicKey);

    // Winner's balance grew by pool - fee (payout).
    const fee = Math.floor(pool * 500 / 10_000);
    expect(winnerAcct.balance.toNumber()).to.equal(LAMPORTS_PER_SOL + (pool - fee));
    // Loser's balance shrank by full pool.
    expect(loserAcct.balance.toNumber()).to.equal(LAMPORTS_PER_SOL - pool);

    // ---- winner withdraws full balance ----
    await arena.methods
      .withdraw(new BN(winnerAcct.balance.toString()))
      .accounts({
        config: pda.arenaConfig(arena.programId),
        vault:  pda.arenaVault(arena.programId),
        user:   pda.user(arena.programId, playerA.publicKey),
        authority: playerA.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([playerA])
      .rpc();

    const winnerAfter = await getUserAccount(fx, playerA.publicKey);
    expect(winnerAfter.balance.toNumber()).to.equal(0);
  });
});
