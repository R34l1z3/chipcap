const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair } = require("@solana/web3.js");
const MPL_CORE = "CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d";
const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection("http://127.0.0.1:8899", "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {});
anchor.setProvider(provider);
const chipNftIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "target/idl/chip_nft.json")));
const chipNft = new anchor.Program(chipNftIdl, provider);
const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, chipNft.programId)[0];

(async () => {
  const cfg = await chipNft.account.chipNftConfig.fetch(pda([enc("chip_nft")]));
  console.log("nextTokenId:", cfg.nextTokenId.toString(), "  mintedCount:", cfg.mintedCount);

  // Find all chip assets by their ChipData PDAs (seeds = ["chip", asset_pubkey])
  // We can't enumerate without an indexer scan, so use getProgramAccounts on mpl_core.
  const mplAssets = await connection.getProgramAccounts(new PublicKey(MPL_CORE), { encoding: "base64" });
  console.log(`mpl-core total assets on chain: ${mplAssets.length}`);
  for (const { pubkey, account } of mplAssets) {
    const owner = new PublicKey(account.data.slice(1, 33)).toBase58();
    console.log(`  ${pubkey.toBase58()} → owner ${owner}`);
  }
})();
