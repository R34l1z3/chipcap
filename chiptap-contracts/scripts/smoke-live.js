// ============================================================
// scripts/smoke-live.js — exercises the running localhost node
// (NOT the ephemeral hardhat in-process network) so the indexer
// picks up real events via WebSocket.
//
// Usage: npx hardhat run scripts/smoke-live.js --network localhost
// ============================================================

const { ethers } = require("hardhat");

async function main() {
  const [owner, playerA, playerB] = await ethers.getSigners();

  // Re-use deterministic addresses produced by deploy.js.
  const CHIP_NFT = "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9";
  const ARENA   = "0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9";
  const VRF     = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

  const chipNFT = await ethers.getContractAt("ChipNFT", CHIP_NFT);
  const arena   = await ethers.getContractAt("BattleArena", ARENA);
  const vrf     = await ethers.getContractAt("MockVRFCoordinator", VRF);

  // ---- mint ----
  const price = await chipNFT.mintPrice(0); // Common
  await (await chipNFT.connect(playerA).mint(0, { value: price })).wait();
  await (await chipNFT.connect(playerB).mint(0, { value: price })).wait();
  console.log("Minted 1 chip per player");

  // ---- create + join ----
  const tokensA = await chipNFT.tokensOfOwner(playerA.address);
  const tokensB = await chipNFT.tokensOfOwner(playerB.address);
  const chipA = tokensA[tokensA.length - 1];
  const chipB = tokensB[tokensB.length - 1];

  await (await chipNFT.connect(playerA).approve(ARENA, chipA)).wait();
  await (await chipNFT.connect(playerB).approve(ARENA, chipB)).wait();

  const createTx = await arena.connect(playerA).createBattle(chipA, 0); // $5
  const createRcpt = await createTx.wait();
  const battleId = Number(
    arena.interface.parseLog(
      createRcpt.logs.find((l) => { try { return arena.interface.parseLog(l)?.name === "BattleCreated"; } catch { return false; } })
    ).args.battleId
  );
  console.log("Created battle", battleId);

  const joinTx = await arena.connect(playerB).joinBattle(battleId, chipB);
  const joinRcpt = await joinTx.wait();
  const reqId = Number(
    arena.interface.parseLog(
      joinRcpt.logs.find((l) => { try { return arena.interface.parseLog(l)?.name === "BattleJoined"; } catch { return false; } })
    ).args.vrfRequestId
  );
  console.log("Joined; vrf request", reqId);

  // ---- fulfill VRF (even = playerA wins) ----
  await (await vrf.fulfillRandomWords(reqId, [42])).wait();
  const b = await arena.getBattle(battleId);
  console.log("Decided. winner:", b.winner === playerA.address ? "A" : "B");

  // ---- pay ransom ----
  const winnerSigner = b.winner === playerA.address ? playerA : playerB;
  const loserSigner  = b.winner === playerA.address ? playerB : playerA;

  const ransom = await arena.getRansomAmount(battleId);
  await (await arena.connect(loserSigner).payRansom(battleId, { value: ransom })).wait();
  await (await arena.connect(winnerSigner).withdrawWinnings()).wait();
  console.log("Paid ransom + withdrew winnings");

  console.log("DONE");
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
