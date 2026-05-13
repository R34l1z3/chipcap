/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_INDEXER_URL?:        string;
  readonly VITE_WS_URL?:             string;
  readonly VITE_SOLANA_CLUSTER?:     "localnet" | "devnet" | "mainnet";
  readonly VITE_SOLANA_RPC?:         string;
  readonly VITE_CHIP_NFT_PROGRAM?:   string;
  readonly VITE_BATTLE_ARENA_PROGRAM?: string;
  readonly VITE_TREASURY_PROGRAM?:   string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
