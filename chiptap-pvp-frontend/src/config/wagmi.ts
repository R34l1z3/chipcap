// ============================================================
// src/config/wagmi.ts — Wagmi + RainbowKit config
// ============================================================

import { getDefaultConfig } from "@rainbow-me/rainbowkit";
import { hardhat, polygonAmoy, polygon } from "wagmi/chains";

export const config = getDefaultConfig({
  appName: "ChipTap PvP",
  projectId: "chiptap-pvp-demo", // Get real one at https://cloud.walletconnect.com
  chains: [hardhat, polygonAmoy, polygon],
  ssr: false,
});
