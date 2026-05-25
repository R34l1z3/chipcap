// ============================================================
// init-ticket-mint.js — SEC-23 one-shot bootstrap.
//
// Creates the global SPL tournament-ticket mint (PDA `[b"ticket_mint"]`)
// with `ticket_authority` PDA as both mint+freeze authority, then
// stores its pubkey in ArenaConfig.ticket_mint.
//
// Idempotent: rejects on chain with TicketMintAlreadyInitialized after
// the first run — safe to invoke from CI.
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } = require("@solana/web3.js");

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "target", "idl", "battle_arena.json")));
const arena = new anchor.Program(idl, provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds) => PublicKey.findProgramAddressSync(seeds, arena.programId)[0];

const arenaConfig     = pda([enc("arena")]);
const ticketMint      = pda([enc("ticket_mint")]);
const ticketAuthority = pda([enc("ticket_authority")]);

(async () => {
  console.log("config:           ", arenaConfig.toBase58());
  console.log("ticket_mint PDA:  ", ticketMint.toBase58());
  console.log("ticket_authority: ", ticketAuthority.toBase58());

  // Pre-check — if already initialised, bail cleanly.
  const cfg = await arena.account.arenaConfig.fetch(arenaConfig);
  if (!cfg.ticketMint.equals(PublicKey.default)) {
    console.log(`\nAlready initialised — config.ticket_mint = ${cfg.ticketMint.toBase58()}`);
    process.exit(0);
  }

  const sig = await arena.methods.initTicketMint().accounts({
    config:           arenaConfig,
    ticketMint:       ticketMint,
    ticketAuthority:  ticketAuthority,
    owner:            owner.publicKey,
    tokenProgram:     TOKEN_PROGRAM_ID,
    systemProgram:    SystemProgram.programId,
    rent:             SYSVAR_RENT_PUBKEY,
  }).rpc();
  console.log(`\nOK · sig=${sig}`);

  const after = await arena.account.arenaConfig.fetch(arenaConfig);
  console.log(`config.ticket_mint = ${after.ticketMint.toBase58()}`);
  console.log("✓ ticket mint live on devnet");
})().catch(e => { console.error("FATAL:", e); if (e.logs) console.error(e.logs.slice(-10).join("\n")); process.exit(1); });
