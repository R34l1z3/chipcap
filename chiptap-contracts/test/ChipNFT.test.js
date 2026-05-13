const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployFixture } = require("./helpers");

describe("ChipNFT", function () {
  describe("Minting", function () {
    it("should mint a Common chip for correct price", async function () {
      const { chipNFT, playerA } = await loadFixture(deployFixture);
      const price = await chipNFT.mintPrice(0);
      await chipNFT.connect(playerA).mint(0, { value: price });
      expect(await chipNFT.balanceOf(playerA.address)).to.equal(1);
      const data = await chipNFT.chipData((await chipNFT.tokensOfOwner(playerA.address))[0]);
      expect(data.rarity).to.equal(0);
    });

    it("should reject insufficient payment", async function () {
      const { chipNFT, playerA } = await loadFixture(deployFixture);
      await expect(chipNFT.connect(playerA).mint(0, { value: 1 }))
        .to.be.revertedWithCustomError(chipNFT, "InsufficientPayment");
    });

    it("should refund excess", async function () {
      const { chipNFT, playerA } = await loadFixture(deployFixture);
      const price = await chipNFT.mintPrice(0);
      const bal0 = await ethers.provider.getBalance(playerA.address);
      const tx = await chipNFT.connect(playerA).mint(0, { value: price + ethers.parseEther("1") });
      const r = await tx.wait();
      const bal1 = await ethers.provider.getBalance(playerA.address);
      expect(bal0 - bal1).to.be.closeTo(price + r.gasUsed * r.gasPrice, ethers.parseEther("0.01"));
    });

    it("should reject when disabled", async function () {
      const { chipNFT, playerA, owner } = await loadFixture(deployFixture);
      await chipNFT.connect(owner).setMintEnabled(false);
      await expect(chipNFT.connect(playerA).mint(0, { value: await chipNFT.mintPrice(0) }))
        .to.be.revertedWithCustomError(chipNFT, "MintDisabled");
    });

    it("should mint all 5 rarities", async function () {
      const { chipNFT, playerA } = await loadFixture(deployFixture);
      for (let r = 0; r < 5; r++) await chipNFT.connect(playerA).mint(r, { value: await chipNFT.mintPrice(r) });
      expect(await chipNFT.balanceOf(playerA.address)).to.equal(5);
    });

    it("should batch mint", async function () {
      const { chipNFT, playerA } = await loadFixture(deployFixture);
      const p = await chipNFT.mintPrice(0);
      await chipNFT.connect(playerA).mintBatch(0, 5, { value: p * 5n });
      expect(await chipNFT.balanceOf(playerA.address)).to.equal(5);
    });

    it("should enforce max supply", async function () {
      const { chipNFT, playerA, owner } = await loadFixture(deployFixture);
      await chipNFT.connect(owner).setMaxSupply(4, 2); // Legendary max 2
      const p = await chipNFT.mintPrice(4);
      await chipNFT.connect(playerA).mint(4, { value: p });
      await chipNFT.connect(playerA).mint(4, { value: p });
      await expect(chipNFT.connect(playerA).mint(4, { value: p }))
        .to.be.revertedWithCustomError(chipNFT, "MaxSupplyReached");
    });
  });

  describe("Permissions", function () {
    it("should reject non-battle contract recording stats", async function () {
      const { chipNFT, playerA } = await loadFixture(deployFixture);
      await chipNFT.connect(playerA).mint(0, { value: await chipNFT.mintPrice(0) });
      await expect(chipNFT.connect(playerA).recordBattle(1, true))
        .to.be.revertedWithCustomError(chipNFT, "NotBattleContract");
    });

    it("should reject non-owner admin calls", async function () {
      const { chipNFT, playerA } = await loadFixture(deployFixture);
      await expect(chipNFT.connect(playerA).setMintEnabled(false))
        .to.be.revertedWithCustomError(chipNFT, "OwnableUnauthorizedAccount");
    });

    it("should allow owner to withdraw", async function () {
      const { chipNFT, owner, playerA } = await loadFixture(deployFixture);
      await chipNFT.connect(playerA).mint(0, { value: await chipNFT.mintPrice(0) });
      const bal0 = await ethers.provider.getBalance(owner.address);
      await chipNFT.connect(owner).withdraw();
      expect(await ethers.provider.getBalance(owner.address)).to.be.greaterThan(bal0);
    });
  });
});
