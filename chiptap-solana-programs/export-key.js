// Convert ~/.config/solana/id.json (uint8 array) to a base58 secret key
// that Phantom / Solflare accepts in "Import private key".
const fs = require("fs");
const os = require("os");
const path = require("path");
const bs58 = require("bs58");
const sk = Uint8Array.from(JSON.parse(
  fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8")
));
const enc = (bs58.default || bs58).encode;
console.log(enc(sk));
