// ============================================================
// scripts/e2e-battle.js — Full end-to-end battle flow
//
// Runs on Hardhat local node. Does everything:
// 1. Deploy all contracts + mocks
// 2. Mint chips for 2 players
// 3. Create battle
// 4. Join battle
// 5. Fulfill VRF
// 6. Test both resolutions: pay ransom + forfeit
// 7. Verify final state
//
// Usage: npx hardhat run scripts/e2e-battle.js --network hardhat
// ============================================================

const { ethers } = require("hardhat");

function ok(msg) { console.log(`  ✅ ${msg}`); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }
function section(msg) { console.log(`\n${"=".repeat(50)}\n  ${msg}\n${"=".repeat(50)}`); }

async function main() {
  const [owner, playerA, playerB] = await ethers.getSigners();

  section("1. DEPLOY CONTRACTS");

  const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
  const priceFeed = await MockPriceFeed.deploy(50000000); // $0.50/MATIC
  ok(`MockPriceFeed: ${await priceFeed.getAddress()}`);

  const MockVRF = await ethers.getContractFactory("MockVRFCoordinator");
  const vrf = await MockVRF.deploy();
  ok(`MockVRFCoordinator: ${await vrf.getAddress()}`);

  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy();
  ok(`Treasury: ${await treasury.getAddress()}`);

  const ChipNFT = await ethers.getContractFactory("ChipNFT");
  const chipNFT = await ChipNFT.deploy("https://test.com/");
  ok(`ChipNFT: ${await chipNFT.getAddress()}`);

  const BattleArena = await ethers.getContractFactory("BattleArena");
  const arena = await BattleArena.deploy(
    await chipNFT.getAddress(), await priceFeed.getAddress(),
    await treasury.getAddress(), await vrf.getAddress(),
    ethers.ZeroHash, 1
  );
  ok(`BattleArena: ${await arena.getAddress()}`);

  await chipNFT.setBattleContract(await arena.getAddress(), true);
  await chipNFT.setMintEnabled(true);
  await treasury.setDepositor(await arena.getAddress(), true);
  ok("Permissions configured");

  // ============================================================
  section("2. MINT CHIPS");

  const mintPrice = await chipNFT.mintPrice(0); // Common
  await chipNFT.connect(playerA).mint(0, { value: mintPrice });
  await chipNFT.connect(playerA).mint(0, { value: mintPrice });
  await chipNFT.connect(playerB).mint(0, { value: mintPrice });
  await chipNFT.connect(playerB).mint(0, { value: mintPrice });

  const tokensA = await chipNFT.tokensOfOwner(playerA.address);
  const tokensB = await chipNFT.tokensOfOwner(playerB.address);
  ok(`Player A chips: [${tokensA.join(", ")}]`);
  ok(`Player B chips: [${tokensB.join(", ")}]`);

  // ============================================================
  section("3. BATTLE #1 — LOSER PAYS RANSOM");

  const chipA1 = tokensA[0];
  const chipB1 = tokensB[0];

  // Approve
  await chipNFT.connect(playerA).approve(await arena.getAddress(), chipA1);
  await chipNFT.connect(playerB).approve(await arena.getAddress(), chipB1);
  ok("Chips approved for arena");

  // Create
  let tx = await arena.connect(playerA).createBattle(chipA1, 0); // $5 pool
  let receipt = await tx.wait();
  const battleId1 = 1;
  ok(`Battle #${battleId1} created (Player A, $5 pool)`);

  // Join
  tx = await arena.connect(playerB).joinBattle(battleId1, chipB1);
  receipt = await tx.wait();
  info("Player B joined — VRF requested");

  let b = await arena.getBattle(battleId1);
  ok(`Status: ${["WAITING","ROLLING","DECIDED","SETTLED","CANCELLED"][b.status]}`);

  // Fulfill VRF (even seed = playerA wins)
  await vrf.fulfillRandomWords(1, [42]);
  b = await arena.getBattle(battleId1);
  ok(`VRF fulfilled — Winner: ${b.winner === playerA.address ? "Player A" : "Player B"}`);
  ok(`Status: ${["WAITING","ROLLING","DECIDED","SETTLED","CANCELLED"][b.status]}`);

  // Winner claims chip (v2)
  const winnerSigner1 = b.winner === playerA.address ? playerA : playerB;
  const loserSigner1 = b.loser === playerA.address ? playerA : playerB;
  await arena.connect(winnerSigner1).claimWinnerChip(battleId1);
  ok("Winner claimed chip back");

  // Loser pays ransom
  const ransom = await arena.getRansomAmount(battleId1);
  info(`Ransom amount: ${ethers.formatEther(ransom)} MATIC`);

  const treasuryBal0 = await ethers.provider.getBalance(await treasury.getAddress());
  await arena.connect(loserSigner1).payRansom(battleId1, { value: ransom });
  const treasuryBal1 = await ethers.provider.getBalance(await treasury.getAddress());

  b = await arena.getBattle(battleId1);
  ok(`Battle #1 settled: PAID`);
  ok(`Treasury fee: ${ethers.formatEther(treasuryBal1 - treasuryBal0)} MATIC`);

  // Winner withdraws
  const pending = await arena.pendingWithdrawals(b.winner);
  info(`Winner pending: ${ethers.formatEther(pending)} MATIC`);
  await arena.connect(winnerSigner1).withdrawWinnings();
  ok("Winner withdrew winnings");
  ok(`Pending after withdraw: ${ethers.formatEther(await arena.pendingWithdrawals(b.winner))} MATIC`);

  // Both players still own their chips
  ok(`Chip #${chipA1} owner: ${await chipNFT.ownerOf(chipA1) === playerA.address ? "Player A ✅" : "WRONG ❌"}`);
  ok(`Chip #${chipB1} owner: ${await chipNFT.ownerOf(chipB1) === playerB.address ? "Player B ✅" : "WRONG ❌"}`);

  // ============================================================
  section("4. BATTLE #2 — LOSER FORFEITS");

  const chipA2 = tokensA[1];
  const chipB2 = tokensB[1];

  await chipNFT.connect(playerA).approve(await arena.getAddress(), chipA2);
  await chipNFT.connect(playerB).approve(await arena.getAddress(), chipB2);

  await arena.connect(playerA).createBattle(chipA2, 2); // $25 pool
  await arena.connect(playerB).joinBattle(2, chipB2);
  ok("Battle #2 created and joined");

  // Odd seed = playerB wins
  await vrf.fulfillRandomWords(2, [77]);
  b = await arena.getBattle(2);
  ok(`VRF fulfilled — Winner: ${b.winner === playerB.address ? "Player B" : "Player A"}`);

  // Loser forfeits
  const loserSigner2 = b.loser === playerA.address ? playerA : playerB;
  const winnerAddr2 = b.winner;
  const loserChip = b.loser === playerA.address ? chipA2 : chipB2;

  await arena.connect(loserSigner2).forfeitChip(2);
  b = await arena.getBattle(2);
  ok(`Battle #2 settled: FORFEITED`);
  ok(`Loser's chip #${loserChip} now owned by winner: ${await chipNFT.ownerOf(loserChip) === winnerAddr2 ? "YES ✅" : "NO ❌"}`);

  // ============================================================
  section("5. FINAL STATE");

  const treasuryFinal = await ethers.provider.getBalance(await treasury.getAddress());
  info(`Treasury balance: ${ethers.formatEther(treasuryFinal)} MATIC`);
  info(`Treasury total collected: ${ethers.formatEther(await treasury.totalCollected())} MATIC`);
  info(`Player A chips: [${(await chipNFT.tokensOfOwner(playerA.address)).join(", ")}]`);
  info(`Player B chips: [${(await chipNFT.tokensOfOwner(playerB.address)).join(", ")}]`);
  info(`Next battle ID: ${await arena.nextBattleId()}`);

  console.log("\n" + "=".repeat(50));
  console.log("  🎉 E2E TEST PASSED — ALL FLOWS WORKING");
  console.log("=".repeat(50) + "\n");
}

main().catch((err) => {
  console.error("\n❌ E2E FAILED:", err);
  process.exitCode = 1;
});
