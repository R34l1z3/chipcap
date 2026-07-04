// Quick devnet sanity: mint one chip from the freshly-deployed chip_nft
// and assert it comes out at tier 0 with the new ChipData layout.
const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");

const secret = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"));
const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(secret)));
const connection = new Connection("https://api.devnet.solana.com", "confirmed");
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
anchor.setProvider(provider);

const chipNftIdl = JSON.parse(fs.readFileSync(path.join(__dirname, "target", "idl", "chip_nft.json"), "utf8"));
const chipNft = new anchor.Program(chipNftIdl, provider);
const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const chipDataPda = (a) => pda([enc("chip"), a.toBuffer()], chipNft.programId);

(async () => {
  console.log("chip_nft:", chipNft.programId.toBase58());
  const asset = Keypair.generate();
  const sig = await chipNft.methods.mintChip("ChipTap", "https://chiptap.gg/metadata/tier-0.json")
    .accounts({ config: chipNftConfig, vault: chipNftVault, asset: asset.publicKey,
      chipData: chipDataPda(asset.publicKey), payer: wallet.publicKey, mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId })
    .signers([asset]).rpc();
  console.log("minted:", asset.publicKey.toBase58(), "sig", sig.slice(0, 12) + "…");
  const cd = await chipNft.account.chipData.fetch(chipDataPda(asset.publicKey));
  console.log("token_id:", cd.tokenId.toString(), "| tier:", cd.tier,
    "| progression_wins:", cd.progressionWins, "| last_game_id:", cd.lastGameId.toString());
  console.log(Number(cd.tier) === 0 && Number(cd.progressionWins) === 0
    ? "✅ DEVNET MINT OK — fresh T0 chip" : "❌ unexpected ChipData");
})().catch((e) => { console.error("mint-check failed:", e.message || e); process.exit(1); });
