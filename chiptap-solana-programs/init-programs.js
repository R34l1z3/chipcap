// ============================================================
// init-programs.js — calls initialize() on each deployed program
// and wires them up.  Idempotent.
//
// Usage: node init-programs.js
// ============================================================

const fs = require("fs");
const path = require("path");
const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");

// ---- load wallet ----
const walletPath = path.join(os.homedir(), ".config/solana/id.json");
const secret = JSON.parse(fs.readFileSync(walletPath, "utf8"));
const keypair = Keypair.fromSecretKey(Uint8Array.from(secret));
const wallet = new anchor.Wallet(keypair);
// SOLANA_RPC env var lets the same script target localnet / devnet /
// mainnet without code changes:
//   SOLANA_RPC=https://api.devnet.solana.com node init-programs.js
const RPC = process.env.SOLANA_RPC || "http://127.0.0.1:8899";
console.log("[init] RPC:", RPC);
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, wallet, {
  commitment: "confirmed",
  preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

// ---- load IDLs ----
const idlDir = path.join(__dirname, "target", "idl");
const treasuryIdl    = JSON.parse(fs.readFileSync(path.join(idlDir, "treasury.json"), "utf8"));
const chipNftIdl     = JSON.parse(fs.readFileSync(path.join(idlDir, "chip_nft.json"), "utf8"));
const battleArenaIdl = JSON.parse(fs.readFileSync(path.join(idlDir, "battle_arena.json"), "utf8"));

const treasury = new anchor.Program(treasuryIdl, provider);
const chipNft  = new anchor.Program(chipNftIdl, provider);
const arena    = new anchor.Program(battleArenaIdl, provider);

// ---- PDAs ----
const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, programId) => PublicKey.findProgramAddressSync(seeds, programId)[0];

const treasuryConfig = pda([enc("treasury")], treasury.programId);
const treasuryVault  = pda([enc("treasury"), enc("vault")], treasury.programId);

const chipNftConfig  = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault   = pda([enc("chip_nft"), enc("vault")], chipNft.programId);

const arenaConfig    = pda([enc("arena")], arena.programId);
const arenaVault     = pda([enc("arena"), enc("vault")], arena.programId);
const chipAuthority  = pda([enc("arena"), enc("chip_authority")], arena.programId);

const log = (...a) => console.log("[init]", ...a);

async function maybeInit(name, fn) {
  try {
    const sig = await fn();
    log(`${name}: initialised, sig=${sig}`);
  } catch (e) {
    const msg = (e?.message || "").toLowerCase();
    if (msg.includes("already in use") || msg.includes("0x0") || msg.includes("custom program error: 0x0")) {
      log(`${name}: already initialised`);
      return;
    }
    throw e;
  }
}

(async () => {
  log("wallet :", wallet.publicKey.toBase58());
  log("balance:", (await connection.getBalance(wallet.publicKey)) / 1e9, "SOL");
  log("");
  log("treasury     :", treasury.programId.toBase58());
  log("chip_nft     :", chipNft.programId.toBase58());
  log("battle_arena :", arena.programId.toBase58());
  log("");
  log("PDAs:");
  log("  treasury_config :", treasuryConfig.toBase58());
  log("  treasury_vault  :", treasuryVault.toBase58());
  log("  chip_nft_config :", chipNftConfig.toBase58());
  log("  chip_nft_vault  :", chipNftVault.toBase58());
  log("  arena_config    :", arenaConfig.toBase58());
  log("  arena_vault     :", arenaVault.toBase58());
  log("  chip_authority  :", chipAuthority.toBase58());
  log("");

  // ------------------------------------------------------------
  await maybeInit("treasury", () =>
    treasury.methods
      .initialize()
      .accounts({
        owner: wallet.publicKey,
        config: treasuryConfig,
        vault: treasuryVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );

  await maybeInit("chip_nft", () =>
    chipNft.methods
      .initialize()
      .accounts({
        owner: wallet.publicKey,
        config: chipNftConfig,
        vault: chipNftVault,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );

  await maybeInit("battle_arena", () =>
    arena.methods
      .initialize()
      .accounts({
        owner: wallet.publicKey,
        config: arenaConfig,
        vault: arenaVault,
        chipAuthority: chipAuthority,
        chipNftProgram: chipNft.programId,
        treasuryProgram: treasury.programId,
        systemProgram: SystemProgram.programId,
      })
      .rpc()
  );

  // ------------------------------------------------------------
  log("");
  log("wiring chip_nft.battle_authority ← arena.chip_authority …");
  await chipNft.methods
    .setBattleAuthority(chipAuthority)
    .accounts({ config: chipNftConfig, owner: wallet.publicKey })
    .rpc();

  log("wiring treasury.battle_arena ← arena.vault …");
  await treasury.methods
    .setBattleArena(arenaVault)
    .accounts({ config: treasuryConfig, owner: wallet.publicKey })
    .rpc();

  log("enabling mint …");
  await chipNft.methods
    .setMintEnabled(true)
    .accounts({ config: chipNftConfig, owner: wallet.publicKey })
    .rpc();

  log("");
  log("✅ ALL PROGRAMS READY");
})().catch((e) => {
  console.error("[init] failed:", e);
  process.exit(1);
});
