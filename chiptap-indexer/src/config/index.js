import "dotenv/config";

const config = {
  port: parseInt(process.env.PORT || "3002", 10),
  wsPort: parseInt(process.env.WS_PORT || "3003", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  isDev: process.env.NODE_ENV !== "production",

  db: { url: process.env.DATABASE_URL },

  rpc: {
    ws: process.env.RPC_WS || "ws://127.0.0.1:8545",
    http: process.env.RPC_HTTP || "http://127.0.0.1:8545",
  },

  contracts: {
    chipNFT: process.env.CHIP_NFT_ADDRESS,
    battleArena: process.env.BATTLE_ARENA_ADDRESS,
  },

  indexer: {
    startBlock: parseInt(process.env.START_BLOCK || "0", 10),
    confirmations: parseInt(process.env.CONFIRMATIONS || "3", 10),
    pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
  },
};

export default config;
