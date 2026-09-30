// ============================================================
// join-battle.js — operator helper (not a test): be the opponent for a
// 1v1 created in the UI, so one person can watch a live reveal.
//
//   SOLANA_RPC=https://api.devnet.solana.com node join-battle.js          # join the NEXT new battle
//   SOLANA_RPC=https://api.devnet.solana.com B_ID=42 node join-battle.js  # join battle 42
//
// Funds a throwaway from the deploy wallet, mints it a chip, joins, then
// waits for the relayer to decide.  If the throwaway loses it forfeits
// straight away, so the UI player gets the chip without a 24 h wait.  If
// it wins, the UI player decides (pay or forfeit) as usual.
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction } = require("@solana/web3.js");

const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const WAIT_NEW_MS = 15 * 60 * 1000;   // how long to wait for the UI battle
const WAIT_DECIDE_MS = 10 * 60 * 1000;

const owner = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

const idlDir = path.join(__dirname, "target", "idl");
const chipNft = new anchor.Program(JSON.parse(fs.readFileSync(path.join(idlDir, "chip_nft.json"))), provider);
const arena   = new anchor.Program(JSON.parse(fs.readFileSync(path.join(idlDir, "battle_arena.json"))), provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];
const arenaConfig   = pda([enc("arena")], arena.programId);
const chipAuthority = pda([enc("arena"), enc("chip_authority")], arena.programId);
const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const chipDataPda = (a) => pda([enc("chip"), a.toBuffer()], chipNft.programId);
const battlePda   = (id) => pda([enc("battle"), new anchor.BN(id).toArrayLike(Buffer, "le", 8)], arena.programId);

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), "•", ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findBattle() {
  if (process.env.B_ID) return Number(process.env.B_ID);
  const start = Number((await arena.account.arenaConfig.fetch(arenaConfig)).nextBattleId);
  log(`waiting for a new battle (id >= ${start}) — create one in the UI now`);
  const deadline = Date.now() + WAIT_NEW_MS;
  while (Date.now() < deadline) {
    const next = Number((await arena.account.arenaConfig.fetch(arenaConfig)).nextBattleId);
    for (let id = start; id < next; id++) {
      const b = await arena.account.battle.fetchNullable(battlePda(id));
      if (b && b.status === 0) return id;   // a 1v1 still WAITING (ids are shared with BR/tournaments)
    }
    await sleep(3000);
  }
  throw new Error("no new WAITING battle appeared");
}

(async () => {
  const kp = Keypair.generate();
  await provider.sendAndConfirm(new Transaction().add(SystemProgram.transfer({
    fromPubkey: owner.publicKey, toPubkey: kp.publicKey, lamports: Math.round(0.06 * LAMPORTS_PER_SOL),
  })), []);
  const asset = Keypair.generate();
  await chipNft.methods.mintChip("ChipTap", "https://chiptap.gg/metadata/tier-0.json").accounts({
    config: chipNftConfig, vault: chipNftVault,
    asset: asset.publicKey, chipData: chipDataPda(asset.publicKey),
    payer: kp.publicKey, mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([kp, asset]).rpc();
  log("opponent", kp.publicKey.toBase58(), "chip", asset.publicKey.toBase58());

  const id = await findBattle();
  const pre = await arena.account.battle.fetch(battlePda(id));
  log(`joining battle #${id} (player_a ${pre.playerA.toBase58()})`);
  await arena.methods.joinBattle().accounts({
    config: arenaConfig, battle: battlePda(id), chipAuthority,
    chip: asset.publicKey, player: kp.publicKey,
    mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
  }).signers([kp]).rpc();
  log("joined — ROLLING, waiting for the relayer");

  const deadline = Date.now() + WAIT_DECIDE_MS;
  let b;
  while (Date.now() < deadline) {
    b = await arena.account.battle.fetch(battlePda(id));
    if (b.status >= 2) break;
    await sleep(3000);
  }
  if (!b || b.status < 2) throw new Error("not decided in time — is the relayer running?");

  const opponentWon = b.winner.equals(kp.publicKey);
  log(`DECIDED — seed ${b.randomSeed.toString()} → ${opponentWon ? "opponent (throwaway) won" : "UI player won"}`);
  if (!opponentWon) {
    await arena.methods.forfeitChip().accounts({
      config: arenaConfig, battle: battlePda(id), chipAuthority,
      chipLoser: asset.publicKey, loser: kp.publicKey, winner: b.winner,
      mplCore: MPL_CORE, systemProgram: SystemProgram.programId,
    }).signers([kp]).rpc();
    log("throwaway forfeited — the chip is the UI player's now");
  }
})().catch((e) => {
  console.error("FATAL:", e.message || e);
  if (e.logs) console.error(e.logs.slice(-8).join("\n"));
  process.exit(1);
});
