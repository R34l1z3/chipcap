/**
 * scripts/generateImages.js
 *
 * Generates SVG chip images for each rarity tier.
 * Each chip has: outer ring, inner ring, edge notches, center emblem,
 * background pattern, and rarity-specific effects.
 *
 * Usage: node scripts/generateImages.js
 * Output: output/images/chip_<tokenId>.svg
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "..", "output", "images");

const RARITIES = [
  {
    id: 0, name: "Common", symbol: "C",
    bg: "#1a1a2e", ring: "#888888", inner: "#666666",
    accent: "#aaaaaa", glow: false, pattern: "dots",
  },
  {
    id: 1, name: "Uncommon", symbol: "U",
    bg: "#0a2e0a", ring: "#00CC00", inner: "#008800",
    accent: "#00FF00", glow: false, pattern: "grid",
  },
  {
    id: 2, name: "Rare", symbol: "R",
    bg: "#0a1a3e", ring: "#2266CC", inner: "#1144AA",
    accent: "#3399FF", glow: true, pattern: "diamonds",
  },
  {
    id: 3, name: "Epic", symbol: "E",
    bg: "#1a0a3e", ring: "#7722CC", inner: "#5511AA",
    accent: "#AA44FF", glow: true, pattern: "stars",
  },
  {
    id: 4, name: "Legendary", symbol: "L",
    bg: "#2e2200", ring: "#CC9900", inner: "#AA7700",
    accent: "#FFD700", glow: true, pattern: "rays",
  },
];

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    return (s >>> 0) / 0xffffffff;
  };
}

function generatePattern(rarity, rand) {
  let svg = "";
  switch (rarity.pattern) {
    case "dots":
      for (let i = 0; i < 12; i++) {
        const x = 100 + rand() * 300;
        const y = 100 + rand() * 300;
        const r = 2 + rand() * 3;
        svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="${rarity.accent}" opacity="0.08"/>`;
      }
      break;
    case "grid":
      for (let x = 80; x < 420; x += 40) {
        svg += `<line x1="${x}" y1="80" x2="${x}" y2="420" stroke="${rarity.accent}" stroke-width="0.5" opacity="0.06"/>`;
        svg += `<line x1="80" y1="${x}" x2="420" y2="${x}" stroke="${rarity.accent}" stroke-width="0.5" opacity="0.06"/>`;
      }
      break;
    case "diamonds":
      for (let i = 0; i < 8; i++) {
        const cx = 150 + rand() * 200;
        const cy = 150 + rand() * 200;
        const s = 8 + rand() * 12;
        svg += `<rect x="${(cx - s / 2).toFixed(1)}" y="${(cy - s / 2).toFixed(1)}" width="${s.toFixed(1)}" height="${s.toFixed(1)}" fill="none" stroke="${rarity.accent}" stroke-width="0.5" opacity="0.1" transform="rotate(45 ${cx.toFixed(1)} ${cy.toFixed(1)})"/>`;
      }
      break;
    case "stars":
      for (let i = 0; i < 6; i++) {
        const cx = 120 + rand() * 260;
        const cy = 120 + rand() * 260;
        svg += `<text x="${cx.toFixed(1)}" y="${cy.toFixed(1)}" fill="${rarity.accent}" opacity="0.08" font-size="16" text-anchor="middle" dominant-baseline="central">✦</text>`;
      }
      break;
    case "rays":
      for (let a = 0; a < 360; a += 30) {
        const rad = (a * Math.PI) / 180;
        svg += `<line x1="250" y1="250" x2="${(250 + 200 * Math.cos(rad)).toFixed(1)}" y2="${(250 + 200 * Math.sin(rad)).toFixed(1)}" stroke="${rarity.accent}" stroke-width="1" opacity="0.05"/>`;
      }
      break;
  }
  return svg;
}

function generateChipSVG(tokenId, rarityId) {
  const rarity = RARITIES[rarityId];
  const rand = seededRandom(tokenId * 7919 + rarityId * 104729);

  // Notch positions — 8 notches with slight variation
  const notchCount = 8 + rarityId * 2; // more notches for higher rarity
  const notches = [];
  for (let i = 0; i < notchCount; i++) {
    const angle = (i / notchCount) * 360 + (rand() - 0.5) * 5;
    notches.push(angle);
  }

  // Inner decoration — varies by rarity
  const innerDecoAngle = rand() * 360;

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 500" width="500" height="500">`;

  // Background
  svg += `<rect width="500" height="500" fill="${rarity.bg}" rx="20"/>`;

  // Background pattern
  svg += generatePattern(rarity, rand);

  // Glow effect for rare+
  if (rarity.glow) {
    svg += `<circle cx="250" cy="250" r="180" fill="${rarity.accent}" opacity="0.04"/>`;
    svg += `<circle cx="250" cy="250" r="140" fill="${rarity.accent}" opacity="0.03"/>`;
  }

  // Outer ring
  svg += `<circle cx="250" cy="250" r="190" fill="none" stroke="${rarity.ring}" stroke-width="4" opacity="0.4"/>`;
  svg += `<circle cx="250" cy="250" r="180" fill="none" stroke="${rarity.ring}" stroke-width="2.5"/>`;

  // Notches
  for (const angle of notches) {
    const rad = (angle * Math.PI) / 180;
    const x1 = 250 + 180 * Math.cos(rad);
    const y1 = 250 + 180 * Math.sin(rad);
    const x2 = 250 + 195 * Math.cos(rad);
    const y2 = 250 + 195 * Math.sin(rad);
    svg += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${rarity.accent}" stroke-width="4" stroke-linecap="round"/>`;
  }

  // Chip body
  svg += `<circle cx="250" cy="250" r="160" fill="${rarity.bg}" stroke="${rarity.ring}" stroke-width="2"/>`;

  // Inner rings
  svg += `<circle cx="250" cy="250" r="120" fill="none" stroke="${rarity.inner}" stroke-width="1" opacity="0.5"/>`;
  svg += `<circle cx="250" cy="250" r="80" fill="none" stroke="${rarity.inner}" stroke-width="1" opacity="0.3"/>`;

  // Inner decoration — 4 lines from center
  for (let i = 0; i < 4; i++) {
    const a = innerDecoAngle + i * 90;
    const rad = (a * Math.PI) / 180;
    svg += `<line x1="${(250 + 80 * Math.cos(rad)).toFixed(1)}" y1="${(250 + 80 * Math.sin(rad)).toFixed(1)}" x2="${(250 + 120 * Math.cos(rad)).toFixed(1)}" y2="${(250 + 120 * Math.sin(rad)).toFixed(1)}" stroke="${rarity.accent}" stroke-width="1.5" opacity="0.3"/>`;
  }

  // Center emblem
  svg += `<circle cx="250" cy="250" r="50" fill="${rarity.bg}" stroke="${rarity.accent}" stroke-width="2"/>`;

  // Token ID
  svg += `<text x="250" y="242" text-anchor="middle" dominant-baseline="central" fill="${rarity.accent}" font-family="'Courier New', monospace" font-weight="bold" font-size="20">#${tokenId}</text>`;

  // Rarity letter
  svg += `<text x="250" y="268" text-anchor="middle" dominant-baseline="central" fill="${rarity.ring}" font-family="'Courier New', monospace" font-size="12" opacity="0.7">${rarity.name.toUpperCase()}</text>`;

  // Bottom label
  svg += `<text x="250" y="460" text-anchor="middle" fill="${rarity.accent}" font-family="'Courier New', monospace" font-size="14" opacity="0.4">CHIPTAP</text>`;

  svg += `</svg>`;
  return svg;
}

// ============================================================
// Generate sample images (5 per rarity = 25 total)
// ============================================================

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

let count = 0;
for (let rarity = 0; rarity < 5; rarity++) {
  for (let i = 1; i <= 5; i++) {
    const tokenId = rarity * 100 + i; // 1-5, 101-105, 201-205, etc.
    const svg = generateChipSVG(tokenId, rarity);
    const filename = `chip_${tokenId}.svg`;
    fs.writeFileSync(path.join(OUT_DIR, filename), svg);
    count++;
  }
}

console.log(`Generated ${count} chip images in ${OUT_DIR}`);

// Export for use in metadata generator
export { generateChipSVG, RARITIES };
