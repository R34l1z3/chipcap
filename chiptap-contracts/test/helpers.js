const { ethers } = require("hardhat");

async function deployFixture() {
  const [owner, playerA, playerB, playerC] = await ethers.getSigners();

  const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
  const priceFeed = await MockPriceFeed.deploy(50000000); // $0.50/MATIC

  const MockVRF = await ethers.getContractFactory("MockVRFCoordinator");
  const vrfCoordinator = await MockVRF.deploy();

  const Treasury = await ethers.getContractFactory("Treasury");
  const treasuryContract = await Treasury.deploy();

  const ChipNFT = await ethers.getContractFactory("ChipNFT");
  const chipNFT = await ChipNFT.deploy("https://test.com/metadata/");

  const BattleArena = await ethers.getContractFactory("BattleArena");
  const arena = await BattleArena.deploy(
    await chipNFT.getAddress(), await priceFeed.getAddress(),
    await treasuryContract.getAddress(), await vrfCoordinator.getAddress(),
    ethers.ZeroHash, 1
  );

  await chipNFT.setBattleContract(await arena.getAddress(), true);
  await chipNFT.setMintEnabled(true);
  await treasuryContract.setDepositor(await arena.getAddress(), true);

  return { owner, playerA, playerB, playerC, chipNFT, arena, treasuryContract, priceFeed, vrfCoordinator };
}

async function mintAndApprove(chipNFT, arena, player, rarity = 0) {
  const price = await chipNFT.mintPrice(rarity);
  await chipNFT.connect(player).mint(rarity, { value: price });
  const tokens = await chipNFT.tokensOfOwner(player.address);
  const tokenId = tokens[tokens.length - 1];
  await chipNFT.connect(player).approve(await arena.getAddress(), tokenId);
  return tokenId;
}

async function createBattle(arena, player, chipTokenId, poolTier = 2) {
  const tx = await arena.connect(player).createBattle(chipTokenId, poolTier);
  const receipt = await tx.wait();
  const ev = receipt.logs.find((l) => { try { return arena.interface.parseLog(l)?.name === "BattleCreated"; } catch { return false; } });
  return Number(arena.interface.parseLog(ev).args.battleId);
}

async function joinBattle(arena, player, battleId, chipTokenId) {
  const tx = await arena.connect(player).joinBattle(battleId, chipTokenId);
  const receipt = await tx.wait();
  const ev = receipt.logs.find((l) => { try { return arena.interface.parseLog(l)?.name === "BattleJoined"; } catch { return false; } });
  return Number(arena.interface.parseLog(ev).args.vrfRequestId);
}

async function fulfillVRF(vrfCoordinator, requestId, seed) {
  await vrfCoordinator.fulfillRandomWords(requestId, [seed]);
}

async function runBattleToDecided(fixture, seed = 42, poolTier = 2) {
  const { chipNFT, arena, playerA, playerB, vrfCoordinator } = fixture;
  const chipA = await mintAndApprove(chipNFT, arena, playerA);
  const chipB = await mintAndApprove(chipNFT, arena, playerB);
  const battleId = await createBattle(arena, playerA, chipA, poolTier);
  const requestId = await joinBattle(arena, playerB, battleId, chipB);
  await fulfillVRF(vrfCoordinator, requestId, seed);
  const battle = await arena.getBattle(battleId);
  return {
    battleId, requestId, chipA, chipB,
    winner: battle.winner, loser: battle.loser,
    winnerSigner: battle.winner === playerA.address ? playerA : playerB,
    loserSigner: battle.loser === playerA.address ? playerA : playerB,
  };
}

module.exports = { deployFixture, mintAndApprove, createBattle, joinBattle, fulfillVRF, runBattleToDecided };
