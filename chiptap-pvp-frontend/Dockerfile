# syntax=docker/dockerfile:1.7
# ============================================================
# ChipTap PvP frontend — production image
# ============================================================
# Stage 1: build the static bundle with Vite.
# Stage 2: serve it with nginx-unprivileged (non-root, listens on 8080).
#
# Build-time configuration:
#   VITE_INDEXER_URL  — REST base. Default `/api` (proxied by nginx).
#   VITE_WS_URL       — WebSocket URL. Default `/ws`  (proxied by nginx).
#   VITE_WALLETCONNECT_PROJECT_ID — optional WalletConnect Cloud id.
#
# Override per-environment with `--build-arg`:
#   docker build --build-arg VITE_INDEXER_URL=https://api.example.com/api ...
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
COPY src ./src

# Build args become env vars for `vite build` — embedded into the bundle.
ARG VITE_INDEXER_URL=/api
ARG VITE_WS_URL=/ws
ARG VITE_WALLETCONNECT_PROJECT_ID=chiptap-pvp
ENV VITE_INDEXER_URL=$VITE_INDEXER_URL \
    VITE_WS_URL=$VITE_WS_URL \
    VITE_WALLETCONNECT_PROJECT_ID=$VITE_WALLETCONNECT_PROJECT_ID

RUN npm run build && ls -la dist


# ---- stage 2: nginx ----
# Use the unprivileged image: non-root, default port 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime

# Replace default conf with our SPA + proxy config.
COPY nginx.conf /etc/nginx/conf.d/default.conf

# Static bundle. nginx-unprivileged user is uid 101.
COPY --chown=101:101 --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null 2>&1 || exit 1

# nginx:alpine images already define USER 101 + ENTRYPOINT/CMD; no override needed.
