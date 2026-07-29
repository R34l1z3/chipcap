// ============================================================
// market-smoke.js — SEC-27 P2P chip marketplace, end-to-end.
//
// Runs against a LOCAL validator (no Switchboard / no VRF needed —
// the marketplace has no randomness).  Sequence:
//
//   mint -> list -> (buyer cancel must FAIL) -> cancel -> re-list
//        -> (self-buy must FAIL) -> fill -> withdraw_fees
//        -> (non-owner withdraw must FAIL)
//
// Asserts at every step: mpl-core asset ownership, exact lamport
// split (price - fee to seller, fee to market_vault), Listing account
// lifecycle (created / closed / seed reusable), and config counters.
//
// Usage (from WSL, root — the toolchain lives under /root):
//   node market-smoke.js
// ============================================================

const fs   = require("fs");
const path = require("path");
const os   = require("os");
const anchor = require("@coral-xyz/anchor");
const {
  Connection, PublicKey, Keypair, SystemProgram, LAMPORTS_PER_SOL, Transaction,
} = require("@solana/web3.js");

const MPL_CORE = new PublicKey("CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d");
const RPC = process.env.SOLANA_RPC || "http://127.0.0.1:8899";
const FEE_BPS = 250; // 2.5 %

// On devnet the faucet is rate-limited into uselessness and SOL is
// scarce, so throwaways are funded by TRANSFER from the deploy wallet
// and swept back at the end, and the trade sizes shrink accordingly.
const IS_DEVNET = /devnet/i.test(RPC);
const PRICE_LIST = IS_DEVNET ? 0.03 : 0.5;   // first (cancelled) listing
const PRICE_SELL = IS_DEVNET ? 0.05 : 1;     // second (filled) listing
const FUND_SELLER = IS_DEVNET ? 0.06 : 5;
const FUND_BUYER  = IS_DEVNET ? 0.10 : 5;

const walletPath = path.join(os.homedir(), ".config/solana/id.json");
const owner = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(fs.readFileSync(walletPath, "utf8"))),
);
const connection = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(owner), {
  commitment: "confirmed", preflightCommitment: "confirmed",
});
anchor.setProvider(provider);

const idlDir = path.join(__dirname, "target", "idl");
const chipNftIdl = JSON.parse(fs.readFileSync(path.join(idlDir, "chip_nft.json")));
const marketIdl  = JSON.parse(fs.readFileSync(path.join(idlDir, "marketplace.json")));
const chipNft = new anchor.Program(chipNftIdl, provider);
const market  = new anchor.Program(marketIdl,  provider);

const enc = (s) => new TextEncoder().encode(s);
const pda = (seeds, pid) => PublicKey.findProgramAddressSync(seeds, pid)[0];

const chipNftConfig = pda([enc("chip_nft")], chipNft.programId);
const chipNftVault  = pda([enc("chip_nft"), enc("vault")], chipNft.programId);
const chipDataPda   = (a) => pda([enc("chip"), a.toBuffer()], chipNft.programId);

const marketConfig    = pda([enc("market")], market.programId);
const marketVault     = pda([enc("market"), enc("vault")], market.programId);
const marketAuthority = pda([enc("market"), enc("authority")], market.programId);
const listingPda      = (a) => pda([enc("listing"), a.toBuffer()], market.programId);

const log     = (...a) => console.log("•", ...a);
const section = (s)    => console.log(`\n===== ${s} =====`);
const sol     = (l)    => (Number(l) / LAMPORTS_PER_SOL).toFixed(6);

let failures = 0;
function check(label, cond, detail = "") {
  if (cond) { console.log(`  ✅ ${label}`); }
  else { console.log(`  ❌ ${label} ${detail}`); failures++; }
}

/// Fund a throwaway: airdrop on localnet, transfer from the deploy
/// wallet on devnet (the faucet there is rate-limited into uselessness).
async function fund(to, amount) {
  const lamports = Math.round(amount * LAMPORTS_PER_SOL);
  if (!IS_DEVNET) {
    const sig = await connection.requestAirdrop(to, lamports);
    await connection.confirmTransaction(sig, "confirmed");
    return;
  }
  const tx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: owner.publicKey, toPubkey: to, lamports }),
  );
  await provider.sendAndConfirm(tx, []);
}

/// Return whatever is left in a throwaway to the deploy wallet, so a
/// devnet run costs only the fees + the value that genuinely moved.
async function sweep(kp) {
  const bal = await connection.getBalance(kp.publicKey);
  if (bal === 0) return 0;
  // The throwaway pays its own fee here (it is the feePayer), so leave
  // nothing behind — a system account may legitimately reach zero.
  const fee = 5000;
  if (bal <= fee) return 0;
  const amount = bal - fee;
  try {
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey:   owner.publicKey,
        lamports:   amount,
      }),
    );
    tx.feePayer = kp.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.sign(kp);
    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return amount;
  } catch (e) {
    // Never swallow this silently — an unswept throwaway is real SOL
    // that nobody can ever recover (the keypair is in-memory only).
    console.log(`  ⚠️  sweep of ${kp.publicKey.toBase58().slice(0, 8)}… FAILED: ${(e.message || "").slice(0, 120)}`);
    return 0;
  }
}

/// mpl-core Asset layout: byte 0 = key, bytes 1..33 = owner pubkey.
async function assetOwner(asset) {
  const info = await connection.getAccountInfo(asset);
  if (!info?.data || info.data.length < 33) throw new Error("asset account too small");
  return new PublicKey(info.data.subarray(1, 33));
}

const lamportsOf = async (k) => (await connection.getAccountInfo(k))?.lamports ?? 0;

/// Expect an instruction to fail with a specific Anchor error name.
async function expectFail(label, promiseFn, expectedName) {
  try {
    await promiseFn();
    console.log(`  ❌ ${label} — expected ${expectedName}, but it SUCCEEDED`);
    failures++;
  } catch (e) {
    const msg = (e?.message || "") + JSON.stringify(e?.logs || []);
    if (msg.includes(expectedName)) {
      console.log(`  ✅ ${label} — rejected with ${expectedName}`);
    } else {
      console.log(`  ❌ ${label} — wrong error: ${(e.message || "").slice(0, 160)}`);
      failures++;
    }
  }
}

(async () => {
  section("setup");
  log("rpc     :", RPC);
  log("owner   :", owner.publicKey.toBase58());

  const seller = Keypair.generate();
  const buyer  = Keypair.generate();
  log("seller  :", seller.publicKey.toBase58());
  log("buyer   :", buyer.publicKey.toBase58());
  await fund(seller.publicKey, FUND_SELLER);
  await fund(buyer.publicKey,  FUND_BUYER);
  log(`funded seller=${FUND_SELLER} buyer=${FUND_BUYER} SOL (${IS_DEVNET ? "transfer from deploy wallet" : "airdrop"})`);

  // ---- marketplace init (idempotent) ----
  section("marketplace initialize");
  let cfg = await market.account.marketConfig.fetchNullable(marketConfig);
  if (!cfg) {
    const sig = await market.methods
      .initialize(FEE_BPS)
      .accounts({
        config: marketConfig,
        vault: marketVault,
        marketAuthority,
        owner: owner.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    log("initialized, sig =", sig);
    cfg = await market.account.marketConfig.fetchNullable(marketConfig);
  } else {
    log("already initialized — reusing");
  }
  check("owner recorded", cfg.owner.equals(owner.publicKey));
  check(`fee_bps == ${FEE_BPS}`, cfg.feeBps === FEE_BPS, `got ${cfg.feeBps}`);
  check("not paused", cfg.paused === false);
  log("market_authority:", marketAuthority.toBase58());
  log("market_vault    :", marketVault.toBase58());

  // ---- mint a chip for the seller ----
  section("mint chip for seller");
  const asset = Keypair.generate();
  await chipNft.methods
    .mintChip("ChipTap", "https://chiptap.gg/metadata/tier-0.json")
    .accounts({
      config: chipNftConfig,
      vault: chipNftVault,
      asset: asset.publicKey,
      chipData: chipDataPda(asset.publicKey),
      payer: seller.publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([seller, asset])
    .rpc();
  log("asset:", asset.publicKey.toBase58());
  check("chip owned by seller", (await assetOwner(asset.publicKey)).equals(seller.publicKey));

  const LISTING = listingPda(asset.publicKey);
  const PRICE_1 = Math.round(PRICE_LIST * LAMPORTS_PER_SOL);

  // ---- list ----
  section(`make_listing ${PRICE_LIST} SOL`);
  await market.methods
    .makeListing(new anchor.BN(PRICE_1))
    .accounts({
      config: marketConfig,
      listing: LISTING,
      marketAuthority,
      chip: asset.publicKey,
      seller: seller.publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([seller])
    .rpc();
  let listing = await market.account.listing.fetchNullable(LISTING);
  check("listing created", listing !== null);
  check("listing.seller", listing.seller.equals(seller.publicKey));
  check("listing.asset", listing.asset.equals(asset.publicKey));
  check("listing.price", listing.price.toString() === String(PRICE_1), `got ${listing.price}`);
  check("listing.fee_bps snapshotted", listing.feeBps === FEE_BPS, `got ${listing.feeBps}`);
  check("chip moved into escrow", (await assetOwner(asset.publicKey)).equals(marketAuthority));

  // ---- negative: a non-seller cannot cancel ----
  section("negative: buyer tries to cancel seller's listing");
  await expectFail("buyer cancel_listing", () =>
    market.methods.cancelListing()
      .accounts({
        config: marketConfig,
        listing: LISTING,
        marketAuthority,
        chip: asset.publicKey,
        seller: buyer.publicKey,
        mplCore: MPL_CORE,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer]).rpc(), "NotSeller");

  // ---- cancel ----
  section("cancel_listing (seller)");
  await market.methods.cancelListing()
    .accounts({
      config: marketConfig,
      listing: LISTING,
      marketAuthority,
      chip: asset.publicKey,
      seller: seller.publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([seller]).rpc();
  check("chip returned to seller", (await assetOwner(asset.publicKey)).equals(seller.publicKey));
  check("listing closed", (await market.account.listing.fetchNullable(LISTING)) === null);

  // ---- re-list (proves the PDA seed is reusable after close) ----
  section(`re-list at ${PRICE_SELL} SOL (seed reuse)`);
  const PRICE_2 = Math.round(PRICE_SELL * LAMPORTS_PER_SOL);
  await market.methods
    .makeListing(new anchor.BN(PRICE_2))
    .accounts({
      config: marketConfig,
      listing: LISTING,
      marketAuthority,
      chip: asset.publicKey,
      seller: seller.publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([seller]).rpc();
  listing = await market.account.listing.fetchNullable(LISTING);
  check("re-listed", listing !== null);
  check("new listing id incremented", listing.id.toString() !== "0", `id=${listing.id}`);
  check("chip back in escrow", (await assetOwner(asset.publicKey)).equals(marketAuthority));

  // ---- negative: seller cannot buy own listing ----
  section("negative: seller fills own listing");
  await expectFail("seller fill_listing", () =>
    market.methods.fillListing(new anchor.BN(PRICE_2))
      .accounts({
        config: marketConfig,
        listing: LISTING,
        vault: marketVault,
        marketAuthority,
        seller: seller.publicKey,
        chip: asset.publicKey,
        buyer: seller.publicKey,
        mplCore: MPL_CORE,
        systemProgram: SystemProgram.programId,
      })
      .signers([seller]).rpc(), "CannotBuyOwnListing");

  // ---- fill (the money path) ----
  section("fill_listing (buyer) — exact lamport split");
  const expFee      = Math.floor((PRICE_2 * FEE_BPS) / 10_000);
  const expToSeller = PRICE_2 - expFee;
  const listingRent = await lamportsOf(LISTING); // refunded to seller on close
  const sellerBefore = await lamportsOf(seller.publicKey);
  const vaultBefore  = await lamportsOf(marketVault);
  // total_volume / total_fees are LIFETIME accumulators on MarketConfig.
  // Snapshot them so this smoke stays re-runnable against an already
  // initialised marketplace instead of only passing on a fresh validator.
  const volBefore  = BigInt((await market.account.marketConfig.fetch(marketConfig)).totalVolume.toString());
  const feesBefore = BigInt((await market.account.marketConfig.fetch(marketConfig)).totalFees.toString());
  log(`price=${sol(PRICE_2)}  fee=${sol(expFee)}  toSeller=${sol(expToSeller)}  listingRent=${sol(listingRent)}`);

  // Slippage guard must REJECT a ceiling below the listed price.  This
  // is the front-running defence: the Listing PDA is seeded by the
  // ASSET, so its address survives a cancel+relist, and without the
  // bound a seller could raise the price between the buyer signing and
  // the tx landing — the buyer's own signature would pay the new price.
  await expectFail("fill with max_price below listed price", () =>
    market.methods.fillListing(new anchor.BN(PRICE_2 - 1))
      .accounts({
        config: marketConfig,
        listing: LISTING,
        vault: marketVault,
        marketAuthority,
        seller: seller.publicKey,
        chip: asset.publicKey,
        buyer: buyer.publicKey,
        mplCore: MPL_CORE,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer]).rpc(), "PriceExceedsMax");

  await market.methods.fillListing(new anchor.BN(PRICE_2))
    .accounts({
      config: marketConfig,
      listing: LISTING,
      vault: marketVault,
      marketAuthority,
      seller: seller.publicKey,
      chip: asset.publicKey,
      buyer: buyer.publicKey,
      mplCore: MPL_CORE,
      systemProgram: SystemProgram.programId,
    })
    .signers([buyer]).rpc();

  const sellerAfter = await lamportsOf(seller.publicKey);
  const vaultAfter  = await lamportsOf(marketVault);
  const sellerDelta = sellerAfter - sellerBefore;
  const vaultDelta  = vaultAfter - vaultBefore;

  // Seller signs nothing here, so they pay no tx fee: the delta is
  // exactly (price - fee) plus the refunded Listing rent.
  check("chip delivered to buyer", (await assetOwner(asset.publicKey)).equals(buyer.publicKey));
  check("listing closed after fill", (await market.account.listing.fetchNullable(LISTING)) === null);
  check(
    "seller received price-fee + rent",
    sellerDelta === expToSeller + listingRent,
    `got ${sellerDelta}, expected ${expToSeller + listingRent}`,
  );
  check("vault received exactly the fee", vaultDelta === expFee, `got ${vaultDelta}, expected ${expFee}`);

  cfg = await market.account.marketConfig.fetchNullable(marketConfig);
  const volDelta  = BigInt(cfg.totalVolume.toString()) - volBefore;
  const feesDelta = BigInt(cfg.totalFees.toString()) - feesBefore;
  check("config.total_volume += price", volDelta === BigInt(PRICE_2), `delta=${volDelta}`);
  check("config.total_fees += fee", feesDelta === BigInt(expFee), `delta=${feesDelta}`);

  // ---- negative: non-owner cannot withdraw fees ----
  section("negative: non-owner withdraw_fees");
  await expectFail("buyer withdraw_fees", () =>
    market.methods.withdrawFees(new anchor.BN(1))
      .accounts({
        config: marketConfig,
        vault: marketVault,
        owner: buyer.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([buyer]).rpc(), "NotOwner");

  // ---- withdraw fees ----
  section("withdraw_fees (owner)");
  const ownerBefore = await lamportsOf(owner.publicKey);
  await market.methods.withdrawFees(new anchor.BN(expFee))
    .accounts({
      config: marketConfig,
      vault: marketVault,
      owner: owner.publicKey,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  const vaultEnd = await lamportsOf(marketVault);
  const ownerEnd = await lamportsOf(owner.publicKey);
  check("vault drained back to rent-exempt floor", vaultEnd === vaultBefore, `got ${vaultEnd}, expected ${vaultBefore}`);
  check("owner net gain positive (fee minus tx cost)", ownerEnd > ownerBefore, `delta=${ownerEnd - ownerBefore}`);

  // ---- sweep throwaways back (keeps a devnet run cheap) ----
  if (IS_DEVNET) {
    section("sweep throwaways back to deploy wallet");
    const a = await sweep(seller);
    const b = await sweep(buyer);
    log(`recovered ${sol(a + b)} SOL`);
    log(`deploy wallet now: ${sol(await lamportsOf(owner.publicKey))} SOL`);
  }

  // ---- summary ----
  section("result");
  if (failures === 0) {
    console.log("🎉 ALL MARKETPLACE CHECKS PASSED");
    process.exit(0);
  } else {
    console.log(`💥 ${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
})().catch((e) => {
  console.error("\n💥 SMOKE CRASHED:", e.message);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
