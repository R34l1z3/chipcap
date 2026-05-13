/**
 * scripts/generateMetadata.js
 *
 * Generates ERC-721 metadata JSON for each token.
 * Follows OpenSea metadata standard:
 *   { name, description, image, attributes: [...] }
 *
 * Usage: node scripts/generateMetadata.js [baseImageURI]
 * Output: output/metadata/<tokenId>.json
 *
 * baseImageURI examples:
 *   ipfs://QmXxx.../          (after uploading images to IPFS)
 *   https://api.chiptap.gg/images/  (centralized fallback)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const META_DIR = path.join(__dirname, "..", "output", "metadata");

const baseImageURI = process.argv[2] || "ipfs://PLACEHOLDER_CID/";

const RARITIES = [
  { id: 0, name: "Common", maxSupply: "Unlimited", mintPrice: "2 POL" },
  { id: 1, name: "Uncommon", maxSupply: "10,000", mintPrice: "10 POL" },
  { id: 2, name: "Rare", maxSupply: "3,000", mintPrice: "40 POL" },
  { id: 3, name: "Epic", maxSupply: "500", mintPrice: "100 POL" },
  { id: 4, name: "Legendary", maxSupply: "50", mintPrice: "400 POL" },
];

const DESCRIPTIONS = [
  "A standard ChipTap battle chip. Common but reliable — every champion started here.",
  "An enhanced ChipTap chip with improved markings. Uncommon chips show you're getting serious.",
  "A prized ChipTap chip with distinctive blue patterns. Rare chips are worth fighting for.",
  "A powerful ChipTap chip radiating purple energy. Epic chips command respect in the arena.",
  "The ultimate ChipTap chip, bathed in golden light. Only 50 exist. Legends are made with these.",
];

function generateMetadata(tokenId, rarityId) {
  const rarity = RARITIES[rarityId];

  return {
    name: `ChipTap #${tokenId}`,
    description: DESCRIPTIONS[rarityId],
    image: `${baseImageURI}chip_${tokenId}.svg`,
    external_url: `https://chiptap.gg/chip/${tokenId}`,
    attributes: [
      {
        trait_type: "Rarity",
        value: rarity.name,
      },
      {
        trait_type: "Max Supply",
        value: rarity.maxSupply,
      },
      {
        display_type: "number",
        trait_type: "Rarity Tier",
        value: rarityId,
        max_value: 4,
      },
      {
        trait_type: "Collection",
        value: "Genesis",
      },
      {
        trait_type: "Game",
        value: "ChipTap PvP",
      },
    ],
  };
}

// ============================================================
// Generate metadata for sample tokens (matching image generator)
// ============================================================

if (!fs.existsSync(META_DIR)) fs.mkdirSync(META_DIR, { recursive: true });

let count = 0;
for (let rarity = 0; rarity < 5; rarity++) {
  for (let i = 1; i <= 5; i++) {
    const tokenId = rarity * 100 + i;
    const metadata = generateMetadata(tokenId, rarity);
    const filename = `${tokenId}.json`;
    fs.writeFileSync(path.join(META_DIR, filename), JSON.stringify(metadata, null, 2));
    count++;
  }
}

console.log(`Generated ${count} metadata files in ${META_DIR}`);
console.log(`Image base URI: ${baseImageURI}`);
console.log(`\nTo update for IPFS, re-run with: node scripts/generateMetadata.js ipfs://YOUR_CID/`);

export { generateMetadata };
