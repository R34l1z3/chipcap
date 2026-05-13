const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployFixture, mintAndApprove, createBattle, joinBattle, fulfillVRF, runBattleToDecided } = require("./helpers");

describe("BattleArena v2", function () {

  // ============================================================
  describe("Create + Join + Cancel", function () {
    it("should create battle and escrow chip", async function () {
      const f = await loadFixture(deployFixture);
      const chipId = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      const battleId = await createBattle(f.arena, f.playerA, chipId);
      expect(await f.chipNFT.ownerOf(chipId)).to.equal(await f.arena.getAddress());
      const b = await f.arena.getBattle(battleId);
      expect(b.status).to.equal(0);
    });

    it("should join and trigger VRF", async function () {
      const f = await loadFixture(deployFixture);
      const chipA = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      const chipB = await mintAndApprove(f.chipNFT, f.arena, f.playerB);
      const battleId = await createBattle(f.arena, f.playerA, chipA);
      const reqId = await joinBattle(f.arena, f.playerB, battleId, chipB);
      expect(reqId).to.be.greaterThan(0);
      expect((await f.arena.getBattle(battleId)).status).to.equal(1);
    });

    it("should reject self-join", async function () {
      const f = await loadFixture(deployFixture);
      const c1 = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      const c2 = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      const bid = await createBattle(f.arena, f.playerA, c1);
      await expect(f.arena.connect(f.playerA).joinBattle(bid, c2))
        .to.be.revertedWithCustomError(f.arena, "CannotJoinOwnBattle");
    });

    it("should cancel and return chip", async function () {
      const f = await loadFixture(deployFixture);
      const chipId = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      const bid = await createBattle(f.arena, f.playerA, chipId);
      await f.arena.connect(f.playerA).cancelBattle(bid);
      expect(await f.chipNFT.ownerOf(chipId)).to.equal(f.playerA.address);
      expect((await f.arena.getBattle(bid)).status).to.equal(4);
    });

    it("should reject cancel after join", async function () {
      const f = await loadFixture(deployFixture);
      const cA = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      const cB = await mintAndApprove(f.chipNFT, f.arena, f.playerB);
      const bid = await createBattle(f.arena, f.playerA, cA);
      await joinBattle(f.arena, f.playerB, bid, cB);
      await expect(f.arena.connect(f.playerA).cancelBattle(bid))
        .to.be.revertedWithCustomError(f.arena, "WrongStatus");
    });

    it("should reject when paused", async function () {
      const f = await loadFixture(deployFixture);
      const chipId = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      await f.arena.connect(f.owner).setPaused(true);
      await expect(f.arena.connect(f.playerA).createBattle(chipId, 2))
        .to.be.revertedWithCustomError(f.arena, "Paused");
    });
  });

  // ============================================================
  describe("VRF Resolution", function () {
    it("even seed = playerA wins", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      expect(r.winner).to.equal(f.playerA.address);
      expect(r.loser).to.equal(f.playerB.address);
      expect((await f.arena.getBattle(r.battleId)).status).to.equal(2);
    });

    it("odd seed = playerB wins", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 77);
      expect(r.winner).to.equal(f.playerB.address);
    });

    it("[v2] winner chip NOT auto-transferred in callback", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      // v2: winner chip stays in escrow until claimWinnerChip()
      const winnerChip = r.winner === f.playerA.address ? r.chipA : r.chipB;
      expect(await f.chipNFT.ownerOf(winnerChip)).to.equal(await f.arena.getAddress());
    });
  });

  // ============================================================
  describe("[v2] claimWinnerChip", function () {
    it("should let winner claim their chip", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      const winnerChip = r.winner === f.playerA.address ? r.chipA : r.chipB;

      await f.arena.connect(r.winnerSigner).claimWinnerChip(r.battleId);
      expect(await f.chipNFT.ownerOf(winnerChip)).to.equal(r.winner);
    });

    it("should reject claim by non-winner", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      await expect(f.arena.connect(r.loserSigner).claimWinnerChip(r.battleId))
        .to.be.reverted;
    });

    it("should be idempotent (double claim is safe)", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      await f.arena.connect(r.winnerSigner).claimWinnerChip(r.battleId);
      // Second call should not revert (ownerOf check)
      await f.arena.connect(r.winnerSigner).claimWinnerChip(r.battleId);
    });
  });

  // ============================================================
  describe("[v2] payRansom + pull-payment", function () {
    it("should credit winner via pendingWithdrawals (not push)", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      const ransom = await f.arena.getRansomAmount(r.battleId);

      await f.arena.connect(r.loserSigner).payRansom(r.battleId, { value: ransom });

      // Winner has pending balance, NOT direct ETH transfer
      const pending = await f.arena.pendingWithdrawals(r.winner);
      expect(pending).to.be.greaterThan(0);

      // Both chips returned
      expect(await f.chipNFT.ownerOf(r.chipA)).to.equal(f.playerA.address);
      expect(await f.chipNFT.ownerOf(r.chipB)).to.equal(f.playerB.address);
    });

    it("should let winner withdrawWinnings", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      const ransom = await f.arena.getRansomAmount(r.battleId);

      await f.arena.connect(r.loserSigner).payRansom(r.battleId, { value: ransom });

      const balBefore = await ethers.provider.getBalance(r.winner);
      const tx = await f.arena.connect(r.winnerSigner).withdrawWinnings();
      const receipt = await tx.wait();
      const balAfter = await ethers.provider.getBalance(r.winner);

      expect(balAfter).to.be.greaterThan(balBefore);
      expect(await f.arena.pendingWithdrawals(r.winner)).to.equal(0);
    });

    it("should reject withdrawWinnings with zero balance", async function () {
      const f = await loadFixture(deployFixture);
      await expect(f.arena.connect(f.playerA).withdrawWinnings())
        .to.be.revertedWithCustomError(f.arena, "NothingToWithdraw");
    });

    it("should reject payment from non-loser", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      const ransom = await f.arena.getRansomAmount(r.battleId);
      await expect(f.arena.connect(r.winnerSigner).payRansom(r.battleId, { value: ransom }))
        .to.be.revertedWithCustomError(f.arena, "NotLoser");
    });

    it("should reject insufficient ransom", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      await expect(f.arena.connect(r.loserSigner).payRansom(r.battleId, { value: 1 }))
        .to.be.revertedWithCustomError(f.arena, "InsufficientPayment");
    });

    it("should split 95/5 correctly", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42, 0); // $5 pool
      const ransom = await f.arena.getRansomAmount(r.battleId);
      // $5 at $0.50/MATIC = 10 MATIC
      expect(ransom).to.equal(ethers.parseEther("10"));

      const treasuryBal0 = await ethers.provider.getBalance(await f.treasuryContract.getAddress());
      await f.arena.connect(r.loserSigner).payRansom(r.battleId, { value: ransom });
      const treasuryBal1 = await ethers.provider.getBalance(await f.treasuryContract.getAddress());

      // Treasury gets 5% = 0.5 MATIC
      expect(treasuryBal1 - treasuryBal0).to.equal(ethers.parseEther("0.5"));
      // Winner gets 95% = 9.5 MATIC in pending
      expect(await f.arena.pendingWithdrawals(r.winner)).to.equal(ethers.parseEther("9.5"));
    });
  });

  // ============================================================
  describe("Forfeit", function () {
    it("should transfer loser chip to winner", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      await f.arena.connect(r.loserSigner).forfeitChip(r.battleId);
      const loserChip = r.loser === f.playerA.address ? r.chipA : r.chipB;
      expect(await f.chipNFT.ownerOf(loserChip)).to.equal(r.winner);
    });

    it("should reject forfeit by non-loser", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      await expect(f.arena.connect(r.winnerSigner).forfeitChip(r.battleId))
        .to.be.revertedWithCustomError(f.arena, "NotLoser");
    });
  });

  // ============================================================
  describe("Timeouts", function () {
    it("should auto-forfeit after 24h", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      await time.increase(25 * 3600);
      await f.arena.connect(f.playerC).expireDecision(r.battleId); // anyone can call
      expect((await f.arena.getBattle(r.battleId)).status).to.equal(3);
    });

    it("should reject early expire", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      await expect(f.arena.expireDecision(r.battleId))
        .to.be.revertedWithCustomError(f.arena, "DecisionPeriodActive");
    });

    it("should reject payment after deadline", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      await time.increase(25 * 3600);
      const ransom = await f.arena.getRansomAmount(r.battleId);
      await expect(f.arena.connect(r.loserSigner).payRansom(r.battleId, { value: ransom }))
        .to.be.revertedWithCustomError(f.arena, "DecisionPeriodExpired");
    });

    it("should expire unjoined battle after join timeout", async function () {
      const f = await loadFixture(deployFixture);
      const chipId = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      const bid = await createBattle(f.arena, f.playerA, chipId);
      await expect(f.arena.expireJoin(bid)).to.be.revertedWithCustomError(f.arena, "JoinPeriodNotExpired");
      await time.increase(31 * 60);
      await f.arena.expireJoin(bid);
      expect(await f.chipNFT.ownerOf(chipId)).to.equal(f.playerA.address);
    });
  });

  // ============================================================
  describe("[v2] forceResolve (VRF timeout)", function () {
    it("should refund both chips after VRF timeout", async function () {
      const f = await loadFixture(deployFixture);
      const chipA = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      const chipB = await mintAndApprove(f.chipNFT, f.arena, f.playerB);
      const bid = await createBattle(f.arena, f.playerA, chipA);
      await joinBattle(f.arena, f.playerB, bid, chipB);
      // DON'T fulfill VRF — simulate timeout

      await time.increase(61 * 60); // 61 minutes > vrfTimeout (1h)
      await f.arena.connect(f.playerA).forceResolve(bid);

      expect(await f.chipNFT.ownerOf(chipA)).to.equal(f.playerA.address);
      expect(await f.chipNFT.ownerOf(chipB)).to.equal(f.playerB.address);
      expect((await f.arena.getBattle(bid)).status).to.equal(4); // CANCELLED
    });

    it("should reject forceResolve before timeout", async function () {
      const f = await loadFixture(deployFixture);
      const chipA = await mintAndApprove(f.chipNFT, f.arena, f.playerA);
      const chipB = await mintAndApprove(f.chipNFT, f.arena, f.playerB);
      const bid = await createBattle(f.arena, f.playerA, chipA);
      await joinBattle(f.arena, f.playerB, bid, chipB);
      await expect(f.arena.forceResolve(bid))
        .to.be.revertedWithCustomError(f.arena, "VRFNotTimedOut");
    });

    it("should reject forceResolve on non-ROLLING battle", async function () {
      const f = await loadFixture(deployFixture);
      const r = await runBattleToDecided(f, 42);
      await expect(f.arena.forceResolve(r.battleId))
        .to.be.revertedWithCustomError(f.arena, "WrongStatus");
    });
  });

  // ============================================================
  describe("Price Feed", function () {
    it("should calculate MATIC for $25 pool at $0.50", async function () {
      const f = await loadFixture(deployFixture);
      expect(await f.arena.getPoolAmountInMatic(2)).to.equal(ethers.parseEther("50"));
    });

    it("should update on price change", async function () {
      const f = await loadFixture(deployFixture);
      await f.priceFeed.setPrice(100000000); // $1.00/MATIC
      expect(await f.arena.getPoolAmountInMatic(2)).to.equal(ethers.parseEther("25"));
    });

    it("should return all 6 pools", async function () {
      const f = await loadFixture(deployFixture);
      const amounts = await f.arena.getAllPoolAmounts();
      expect(amounts[0]).to.equal(ethers.parseEther("10"));    // $5
      expect(amounts[5]).to.equal(ethers.parseEther("1000"));  // $500
    });
  });
});

// ============================================================
describe("Treasury", function () {
  it("should receive fees from battle", async function () {
    const f = await loadFixture(deployFixture);
    const r = await runBattleToDecided(f, 42, 0);
    const ransom = await f.arena.getRansomAmount(r.battleId);
    await f.arena.connect(r.loserSigner).payRansom(r.battleId, { value: ransom });

    const bal = await ethers.provider.getBalance(await f.treasuryContract.getAddress());
    expect(bal).to.equal(ethers.parseEther("0.5")); // 5% of 10 MATIC
    expect(await f.treasuryContract.totalCollected()).to.equal(ethers.parseEther("0.5"));
  });

  it("should allow owner to withdraw", async function () {
    const f = await loadFixture(deployFixture);
    const r = await runBattleToDecided(f, 42, 0);
    await f.arena.connect(r.loserSigner).payRansom(r.battleId, { value: await f.arena.getRansomAmount(r.battleId) });

    const ownerBal0 = await ethers.provider.getBalance(f.owner.address);
    await f.treasuryContract.connect(f.owner).withdrawAll();
    const ownerBal1 = await ethers.provider.getBalance(f.owner.address);
    expect(ownerBal1).to.be.greaterThan(ownerBal0);
  });

  it("should reject non-owner withdraw", async function () {
    const f = await loadFixture(deployFixture);
    await expect(f.treasuryContract.connect(f.playerA).withdrawAll())
      .to.be.revertedWithCustomError(f.treasuryContract, "OwnableUnauthorizedAccount");
  });

  it("should track totalCollected and totalWithdrawn", async function () {
    const f = await loadFixture(deployFixture);
    const r = await runBattleToDecided(f, 42, 0);
    await f.arena.connect(r.loserSigner).payRansom(r.battleId, { value: await f.arena.getRansomAmount(r.battleId) });

    expect(await f.treasuryContract.totalCollected()).to.equal(ethers.parseEther("0.5"));
    await f.treasuryContract.connect(f.owner).withdrawAll();
    expect(await f.treasuryContract.totalWithdrawn()).to.equal(ethers.parseEther("0.5"));
  });
});
