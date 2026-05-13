import "dotenv/config";

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

const config = {
  port:    parseInt(process.env.PORT    || "3002", 10),
  wsPort:  parseInt(process.env.WS_PORT || "3003", 10),
  nodeEnv: process.env.NODE_ENV || "development",
  isDev:   process.env.NODE_ENV !== "production",

  db: { url: process.env.DATABASE_URL },

  rpc: {
    http: process.env.SOLANA_RPC || "http://127.0.0.1:8899",
    ws:   process.env.SOLANA_WS  || "ws://127.0.0.1:8900",
  },

  programs: {
    chipNft:     required("CHIP_NFT_PROGRAM"),
    battleArena: required("BATTLE_ARENA_PROGRAM"),
    treasury:    required("TREASURY_PROGRAM"),
  },

  indexer: {
    startSlot:        parseInt(process.env.START_SLOT || "0", 10),
    pollIntervalMs:   parseInt(process.env.POLL_INTERVAL_MS || "5000", 10),
    backfillBatch:    parseInt(process.env.BACKFILL_BATCH_SIZE || "200", 10),
  },

  ws: {
    // SEC-13 — when set, /api/health and the WS server require a shared
    // token (?token=… for the WS handshake, X-Indexer-Token header for HTTP).
    // Empty/missing in dev = no auth (preserves localnet ergonomics);
    // set in production to keep wallet-address broadcasts off the public
    // internet.
    token:           process.env.WS_TOKEN || "",
    // Hard cap on concurrently connected clients.  Above this, new
    // connections are closed at handshake — protects the indexer from
    // a basic resource exhaustion.
    maxClients:      parseInt(process.env.WS_MAX_CLIENTS || "200", 10),
    // Bytes — if a client's outgoing buffer exceeds this, drop the
    // socket rather than letting it accumulate.
    maxBufferedBytes: parseInt(process.env.WS_MAX_BUFFERED_BYTES || "1048576", 10),
    // Ping interval (ms).  Dead TCP connections that haven't been
    // detected by the kernel get evicted on the next pong-miss.
    pingMs:          parseInt(process.env.WS_PING_MS || "30000", 10),
  },
};

export default config;
