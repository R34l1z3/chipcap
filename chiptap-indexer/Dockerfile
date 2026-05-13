# syntax=docker/dockerfile:1.7
# ============================================================
# ChipTap Indexer — production image
# ============================================================
# Two stages:
#   1. deps      — installs prod-only npm deps (no devDeps).
#   2. runtime   — minimal node:alpine + app source + tini.
#
# Notes:
#   • Runs as non-root user `node` (built into node:alpine).
#   • PID 1 is `tini` so SIGTERM properly propagates and the
#     pg-pool / WS server shut down cleanly on `docker stop`.
#   • Healthcheck hits /api/health every 30s.
#   • The same image runs both the long-lived indexer and the
#     one-shot migrator — overridable via CMD.
# ============================================================

# ---- stage 1: deps ----
FROM node:20-alpine AS deps

WORKDIR /app

# Install prod deps. Use lockfile if present (deterministic); fall back
# to a regular install otherwise so first-time users aren't blocked.
COPY package.json package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm \
    set -eux; \
    if [ -f package-lock.json ]; then \
      npm ci --omit=dev --no-audit --no-fund; \
    else \
      npm install --omit=dev --no-audit --no-fund; \
    fi


# ---- stage 2: runtime ----
FROM node:20-alpine AS runtime

ENV NODE_ENV=production \
    PORT=3002 \
    WS_PORT=3003 \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false

# tini for proper PID-1 signal handling; wget for HEALTHCHECK
# (curl is not in the base image — keep image tiny).
RUN apk add --no-cache tini wget

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Drop privileges. The `node` user (uid 1000) ships with node:alpine.
USER node

EXPOSE 3002 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -q -O - "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1 || exit 1

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "src/index.js"]
