/**
 * scripts/batchGenerate.js
 *
 * Batch generate chip images + metadata for a range of tokens.
 * Used before IPFS upload — generates all files for the entire collection.
 *
 * Usage:
 *   node scripts/batchGenerate.js                  # default: tokens 1-100 per rarity
 *   node scripts/batchGenerate.js 1 1000           # tokens 1-1000 (all Common)
 *   node scripts/batchGenerate.js 1 50 4           # tokens 1-50, Legendary only
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { generateChipSVG, RARITIES } from "./generateImages.js";
import { generateMetadata } from "./generateMetadata.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = path.join(__dirname, "..", "output");
const IMG_DIR = path.join(BASE_DIR, "images");
const META_DIR = path.join(BASE_DIR, "metadata");

const startId = parseInt(process.argv[2] || "1", 10);
const endId = parseInt(process.argv[3] || "100", 10);
const forcedRarity = process.argv[4] !== undefined ? parseInt(process.argv[4], 10) : null;

// Determine rarity based on tokenId ranges (mirrors contract logic)
function getRarityForToken(tokenId) {
  if (forcedRarity !== null) return forcedRarity;
  // In production, rarity is stored on-chain in chipData.
  // For pre-generation, we distribute evenly or use a mapping.
  // This is a placeholder — replace with actual on-chain data in production.
  return tokenId % 5;
}

[IMG_DIR, META_DIR].forEach((dir) => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

console.log(`Generating tokens ${startId} to ${endId}...`);
let count = 0;

for (let tokenId = startId; tokenId <= endId; tokenId++) {
  const rarity = getRarityForToken(tokenId);

  // Generate SVG
  const svg = generateChipSVG(tokenId, rarity);
  fs.writeFileSync(path.join(IMG_DIR, `chip_${tokenId}.svg`), svg);

  // Generate metadata
  const meta = generateMetadata(tokenId, rarity);
  fs.writeFileSync(path.join(META_DIR, `${tokenId}.json`), JSON.stringify(meta, null, 2));

  count++;
  if (count % 100 === 0) console.log(`  ...${count} tokens generated`);
}

console.log(`\nDone! Generated ${count} tokens (images + metadata)`);
console.log(`  Images:   ${IMG_DIR}`);
console.log(`  Metadata: ${META_DIR}`);
console.log(`\nNext steps:`);
console.log(`  1. Upload output/images/ to IPFS/Arweave`);
console.log(`  2. Get the CID (e.g. ipfs://QmABC123...)`);
console.log(`  3. Re-run metadata gen: node scripts/generateMetadata.js ipfs://QmABC123.../`);
console.log(`  4. Upload output/metadata/ to IPFS/Arweave`);
console.log(`  5. Get metadata CID`);
console.log(`  6. Update ChipNFT.setBaseURI("ipfs://METADATA_CID/")`);
