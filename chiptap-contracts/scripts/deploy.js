const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying with:", deployer.address);
  console.log("Balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "MATIC");

  const network = await ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  console.log("Chain ID:", chainId);

  // ---- Config per network ----
  let vrfCoordinator, vrfKeyHash, vrfSubId, priceFeed;

  if (chainId === 137) {
    // Polygon mainnet
    vrfCoordinator = process.env.VRF_COORDINATOR;
    vrfKeyHash = process.env.VRF_KEY_HASH;
    vrfSubId = process.env.VRF_SUBSCRIPTION_ID;
    priceFeed = process.env.PRICE_FEED_MATIC_USD;
  } else if (chainId === 80002) {
    // Polygon Amoy testnet
    vrfCoordinator = process.env.VRF_COORDINATOR_AMOY;
    vrfKeyHash = process.env.VRF_KEY_HASH_AMOY;
    vrfSubId = process.env.VRF_SUBSCRIPTION_ID_AMOY;
    priceFeed = process.env.PRICE_FEED_MATIC_USD_AMOY;
  } else {
    // Local / Hardhat — deploy real mocks so the system is fully functional.
    console.log("Local network — deploying MockVRFCoordinator + MockPriceFeed...");

    const MockPriceFeed = await ethers.getContractFactory("MockPriceFeed");
    const mockFeed = await MockPriceFeed.deploy(50000000); // $0.50/MATIC, 8 decimals
    await mockFeed.waitForDeployment();
    priceFeed = await mockFeed.getAddress();
    console.log("   MockPriceFeed:", priceFeed);

    const MockVRF = await ethers.getContractFactory("MockVRFCoordinator");
    const mockVrf = await MockVRF.deploy();
    await mockVrf.waitForDeployment();
    vrfCoordinator = await mockVrf.getAddress();
    console.log("   MockVRFCoordinator:", vrfCoordinator);

    vrfKeyHash = "0x" + "0".repeat(64);
    vrfSubId = "1";
  }

  // ---- 1. Deploy Treasury ----
  console.log("\n1. Deploying Treasury...");
  const Treasury = await ethers.getContractFactory("Treasury");
  const treasury = await Treasury.deploy();
  await treasury.waitForDeployment();
  const treasuryAddr = await treasury.getAddress();
  console.log("   Treasury:", treasuryAddr);

  // ---- 2. Deploy ChipNFT ----
  console.log("\n2. Deploying ChipNFT...");
  const baseURI = "https://api.chiptap.gg/metadata/"; // Update after IPFS upload
  const ChipNFT = await ethers.getContractFactory("ChipNFT");
  const chipNFT = await ChipNFT.deploy(baseURI);
  await chipNFT.waitForDeployment();
  const chipNFTAddr = await chipNFT.getAddress();
  console.log("   ChipNFT:", chipNFTAddr);

  // ---- 3. Deploy BattleArena ----
  console.log("\n3. Deploying BattleArena...");
  const BattleArena = await ethers.getContractFactory("BattleArena");
  const arena = await BattleArena.deploy(
    chipNFTAddr,
    priceFeed,
    treasuryAddr,
    vrfCoordinator,
    vrfKeyHash,
    vrfSubId
  );
  await arena.waitForDeployment();
  const arenaAddr = await arena.getAddress();
  console.log("   BattleArena:", arenaAddr);

  // ---- 4. Configure permissions ----
  console.log("\n4. Configuring permissions...");

  // Allow BattleArena to update chip battle stats
  const tx1 = await chipNFT.setBattleContract(arenaAddr, true);
  await tx1.wait();
  console.log("   ChipNFT: BattleArena authorized");

  // Enable minting
  const tx2 = await chipNFT.setMintEnabled(true);
  await tx2.wait();
  console.log("   ChipNFT: Minting enabled");

  // Allow BattleArena to deposit to Treasury
  const tx3 = await treasury.setDepositor(arenaAddr, true);
  await tx3.wait();
  console.log("   Treasury: BattleArena authorized as depositor");

  // ---- Summary ----
  console.log("\n========================================");
  console.log("  DEPLOYMENT COMPLETE");
  console.log("========================================");
  console.log("  Treasury:    ", treasuryAddr);
  console.log("  ChipNFT:     ", chipNFTAddr);
  console.log("  BattleArena: ", arenaAddr);
  console.log("========================================");
  console.log("\nNext steps:");
  console.log("  1. Add BattleArena as VRF consumer in Chainlink subscription");
  console.log("  2. Fund VRF subscription with LINK");
  console.log("  3. Upload NFT metadata to IPFS");
  console.log("  4. Verify contracts on PolygonScan:");
  console.log(`     npx hardhat verify --network polygon ${treasuryAddr}`);
  console.log(`     npx hardhat verify --network polygon ${chipNFTAddr} "${baseURI}"`);
  console.log(`     npx hardhat verify --network polygon ${arenaAddr} ${chipNFTAddr} ${priceFeed} ${treasuryAddr} ${vrfCoordinator} ${vrfKeyHash} ${vrfSubId}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
