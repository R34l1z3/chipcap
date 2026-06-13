// ============================================================
// init-chip-nft-devnet.js — SEC-26 minimal wipe.
// Inits ONLY the freshly-deployed chip_nft program; leaves the live
// battle_arena + treasury untouched.  Idempotent.
//   SOLANA_RPC=https://api.devnet.solana.com node init-chip-nft-devnet.js
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, SystemProgram } = require("@solana/web3.js");

const secret = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"));
const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(secret)));
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed", preflightCommitment: "confirmed" });
anchor.setProvider(provider);

const idlDir = path.join(__dirname, "target", "idl");
const chipNftIdl     = JSON.parse(fs.readFileSync(path.join(idlDir, "chip_nft.json"), "utf8"));
const battleArenaIdl = JSON.parse(fs.readFileSync(path.join(idlDir, "battle_arena.json"), "utf8"));
const chipNft = new anchor.Program(chipNftIdl, provider);
const arena   = new anchor.Program(battleArenaIdl, provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const chipAuthority = pda([enc("arena"), enc("chip_authority")], arena.programId);

const log = (...a) => console.log("[init-chip]", ...a);

(async () => {
  log("RPC:", RPC);
  log("wallet:", wallet.publicKey.toBase58());
  log("balance:", (await connection.getBalance(wallet.publicKey)) / 1e9, "SOL");
  log("chip_nft     :", chipNft.programId.toBase58());
  log("battle_arena :", arena.programId.toBase58(), "(existing, untouched)");
  log("chip_nft_config:", chipNftConfig.toBase58());
  log("chip_authority :", chipAuthority.toBase58());

  // 1) initialize (skip if already done)
  try {
    const sig = await chipNft.methods.initialize()
      .accounts({ owner: wallet.publicKey, config: chipNftConfig, vault: chipNftVault, systemProgram: SystemProgram.programId })
      .rpc();
    log("initialize: OK", sig);
  } catch (e) {
    const m = (e?.message || "").toLowerCase();
    if (m.includes("already in use") || m.includes("0x0")) log("initialize: already done");
    else throw e;
  }

  // 2) wire battle_authority ← arena.chip_authority (audit field)
  await chipNft.methods.setBattleAuthority(chipAuthority)
    .accounts({ config: chipNftConfig, owner: wallet.publicKey }).rpc();
  log("set_battle_authority: OK");

  // 3) wire battle_arena_program ← existing arena program id (used by record_chip_win)
  await chipNft.methods.setBattleArenaProgram(arena.programId)
    .accounts({ config: chipNftConfig, owner: wallet.publicKey }).rpc();
  log("set_battle_arena_program: OK ->", arena.programId.toBase58());

  // 4) enable mint
  await chipNft.methods.setMintEnabled(true)
    .accounts({ config: chipNftConfig, owner: wallet.publicKey }).rpc();
  log("set_mint_enabled(true): OK");

  // verify
  const cfg = await chipNft.account.chipNftConfig.fetch(chipNftConfig);
  log("--- config ---");
  log("mint_enabled:", cfg.mintEnabled, "| mint_price:", Number(cfg.mintPrice)/1e9, "SOL | next_token_id:", cfg.nextTokenId.toString());
  log("battle_arena_program:", cfg.battleArenaProgram.toBase58());
  log("battle_authority:", cfg.battleAuthority.toBase58());
  log(cfg.mintEnabled && cfg.battleArenaProgram.equals(arena.programId) ? "✅ chip_nft READY" : "❌ wiring mismatch");
})().catch((e) => { console.error("init failed:", e); process.exit(1); });
