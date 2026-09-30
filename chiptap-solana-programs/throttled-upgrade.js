// ============================================================
// throttled-upgrade.js — upgrade a program through a rate-limited RPC.
//
// `solana program deploy --use-rpc` fires the ~850 buffer writes in
// parallel; on the public devnet RPC that trips the per-IP limit and the
// whole IP stays in the 429 penalty box (seen 2026-09-30 upgrading the
// 823 KB battle_arena).  This does the same job politely:
//
//   1. create + InitializeBuffer (buffer keypair saved → resumable)
//   2. Write chunks one at a time at RATE tx/s, backing off on 429
//   3. read the buffer back, re-send only chunks that differ, repeat
//   4. Upgrade (buffer → program), spill rent back to the wallet
//
//   node throttled-upgrade.js <program-id> <path/to/program.so>
//   env: SOLANA_RPC (default devnet), RATE (tx/s, default 3),
//        BUFFER_KEYPAIR (default /tmp/upgrade-buffer.json — reused if present)
// ============================================================

const fs = require("fs"); const path = require("path"); const os = require("os");
const {
  Connection, PublicKey, Keypair, SystemProgram, Transaction, TransactionInstruction,
  SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY,
} = require("@solana/web3.js");

const RPC = process.env.SOLANA_RPC || "https://api.devnet.solana.com";
const RATE = Number(process.env.RATE || 3);
const BUFFER_FILE = process.env.BUFFER_KEYPAIR || "/tmp/upgrade-buffer.json";
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const HEADER = 37;      // UpgradeableLoaderState::Buffer { authority: Option<Pubkey> }
const CHUNK = 950;      // keeps a 1-signer Write tx under the 1232-byte packet limit

const [programIdStr, soPath] = process.argv.slice(2);
if (!programIdStr || !soPath) { console.error("usage: node throttled-upgrade.js <program-id> <program.so>"); process.exit(1); }
const programId = new PublicKey(programIdStr);
const so = fs.readFileSync(soPath);
const wallet = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))));
const connection = new Connection(RPC, "confirmed");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry any RPC call on 429 / network errors with exponential backoff. */
async function rpc(fn, label) {
  for (let i = 0, wait = 2000; ; i++, wait = Math.min(wait * 2, 60_000)) {
    try { return await fn(); }
    catch (e) {
      const msg = String(e.message || e);
      if (i >= 30) throw new Error(`${label}: ${msg}`);
      if (!/429|Too many|fetch failed|ECONNRESET|timed out|503|502/i.test(msg)) throw e;
      log(`  ${label}: ${msg.slice(0, 60)} — backing off ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

function writeIx(buffer, offset, bytes) {
  return new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: buffer, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ],
    data: Buffer.concat([u32(1), u32(offset), u64(bytes.length), bytes]),
  });
}

async function ensureBuffer() {
  // Resume a buffer someone else created (e.g. an interrupted
  // `solana program deploy`).  Write only needs the buffer AUTHORITY's
  // signature, not the buffer keypair, so the address is enough.
  if (process.env.BUFFER_ADDRESS) {
    const pk = new PublicKey(process.env.BUFFER_ADDRESS);
    const info = await rpc(() => connection.getAccountInfo(pk), "getAccountInfo(buffer)");
    if (!info || !info.owner.equals(LOADER)) throw new Error("BUFFER_ADDRESS is not a loader buffer");
    if (info.data.length !== HEADER + so.length) throw new Error(`buffer is ${info.data.length} bytes, need ${HEADER + so.length}`);
    if (!new PublicKey(info.data.subarray(5, 37)).equals(wallet.publicKey)) throw new Error("buffer authority is not this wallet");
    log("resuming existing buffer", pk.toBase58());
    return { publicKey: pk, external: true };
  }
  let kp;
  if (fs.existsSync(BUFFER_FILE)) {
    kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(BUFFER_FILE, "utf8"))));
    const info = await rpc(() => connection.getAccountInfo(kp.publicKey), "getAccountInfo(buffer)");
    if (info && info.data.length === HEADER + so.length) { log("resuming buffer", kp.publicKey.toBase58()); return kp; }
    if (info) throw new Error(`buffer ${kp.publicKey.toBase58()} exists with the wrong size — close it first`);
  } else {
    kp = Keypair.generate();
    fs.writeFileSync(BUFFER_FILE, JSON.stringify(Array.from(kp.secretKey)));
  }
  const space = HEADER + so.length;
  const lamports = await rpc(() => connection.getMinimumBalanceForRentExemption(space), "rent");
  log(`creating buffer ${kp.publicKey.toBase58()} (${space} bytes, ${(lamports / 1e9).toFixed(4)} SOL)`);
  const tx = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey, newAccountPubkey: kp.publicKey,
      lamports, space, programId: LOADER,
    }),
    new TransactionInstruction({           // InitializeBuffer
      programId: LOADER,
      keys: [
        { pubkey: kp.publicKey, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: false, isWritable: false },
      ],
      data: u32(0),
    }),
  );
  await rpc(async () => {
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;
    const sig = await connection.sendTransaction(tx, [wallet, kp]);
    await connection.confirmTransaction(sig, "confirmed");
  }, "create buffer");
  return kp;
}

async function sendChunks(buffer, offsets) {
  let bh = null, bhAt = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (!bh || Date.now() - bhAt > 45_000) {
      bh = (await rpc(() => connection.getLatestBlockhash(), "blockhash")).blockhash;
      bhAt = Date.now();
    }
    const off = offsets[i];
    const tx = new Transaction({ feePayer: wallet.publicKey, recentBlockhash: bh })
      .add(writeIx(buffer, off, so.subarray(off, off + CHUNK)));
    tx.sign(wallet);
    await rpc(() => connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 }), `write@${off}`);
    if (i % 50 === 0) log(`  sent ${i + 1}/${offsets.length}`);
    await sleep(1000 / RATE);
  }
}

async function diffOffsets(buffer) {
  const info = await rpc(() => connection.getAccountInfo(buffer), "read buffer");
  const data = info.data.subarray(HEADER);
  const bad = [];
  for (let off = 0; off < so.length; off += CHUNK) {
    const end = Math.min(off + CHUNK, so.length);
    if (!data.subarray(off, end).equals(so.subarray(off, end))) bad.push(off);
  }
  return bad;
}

(async () => {
  log(`upgrade ${programId.toBase58()} ← ${soPath} (${so.length} bytes) via ${RPC} at ${RATE} tx/s`);
  const buf = await ensureBuffer();

  let todo = await diffOffsets(buf.publicKey);
  for (let pass = 1; todo.length; pass++) {
    if (pass > 8) throw new Error(`${todo.length} chunks still differ after 8 passes`);
    log(`pass ${pass}: ${todo.length} chunks to write`);
    await sendChunks(buf.publicKey, todo);
    await sleep(8000);   // let the last writes land before reading back
    todo = await diffOffsets(buf.publicKey);
  }
  log("buffer verified — identical to the .so");

  const [programData] = PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER);
  const upgrade = new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: programData, isSigner: false, isWritable: true },
      { pubkey: programId, isSigner: false, isWritable: true },
      { pubkey: buf.publicKey, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: false, isWritable: true },   // spill: buffer rent comes back
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: false },
    ],
    data: u32(3),
  });
  const sig = await rpc(async () => {
    const tx = new Transaction().add(upgrade);
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.feePayer = wallet.publicKey;
    const s = await connection.sendTransaction(tx, [wallet]);
    await connection.confirmTransaction(s, "confirmed");
    return s;
  }, "upgrade");
  if (!buf.external) fs.unlinkSync(BUFFER_FILE);
  log("UPGRADED — sig", sig);
})().catch((e) => { console.error("FATAL:", e.message || e); if (e.logs) console.error(e.logs.join("\n")); process.exit(1); });
