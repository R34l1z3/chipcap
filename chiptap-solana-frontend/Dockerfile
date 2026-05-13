# syntax=docker/dockerfile:1.7
# ============================================================
# ChipTap Solana frontend — production image
# Multi-stage: vite build → nginx-unprivileged
# ============================================================

# ---- stage 1: build ----
FROM node:20-alpine AS build

WORKDIR /app

COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    set -eux; \
    if [ -f package-lock.json ]; then \
      npm ci --no-audit --no-fund; \
    else \
      npm install --no-audit --no-fund; \
    fi

COPY tsconfig.json tsconfig.node.json vite.config.ts \
     postcss.config.js tailwind.config.js index.html ./
COPY public ./public
COPY src    ./src

# Build args become env vars for `vite build` and are baked into JS.
ARG VITE_INDEXER_URL=/api
ARG VITE_WS_URL=/ws
ARG VITE_SOLANA_CLUSTER=mainnet
ARG VITE_SOLANA_RPC=
ARG VITE_CHIP_NFT_PROGRAM=ChipNFT11111111111111111111111111111111111
ARG VITE_BATTLE_ARENA_PROGRAM=BatLArena1111111111111111111111111111111111
ARG VITE_TREASURY_PROGRAM=Treasury11111111111111111111111111111111111

ENV VITE_INDEXER_URL=$VITE_INDEXER_URL \
    VITE_WS_URL=$VITE_WS_URL \
    VITE_SOLANA_CLUSTER=$VITE_SOLANA_CLUSTER \
    VITE_SOLANA_RPC=$VITE_SOLANA_RPC \
    VITE_CHIP_NFT_PROGRAM=$VITE_CHIP_NFT_PROGRAM \
    VITE_BATTLE_ARENA_PROGRAM=$VITE_BATTLE_ARENA_PROGRAM \
    VITE_TREASURY_PROGRAM=$VITE_TREASURY_PROGRAM

RUN npm run build && ls -la dist


# ---- stage 2: nginx ----
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --chown=101:101 --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1
