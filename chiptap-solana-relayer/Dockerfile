# Minimal Node image — relayer is a small long-running daemon.
# ~50 MB final image; fits comfortably in Fly.io free tier (256 MB RAM).
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# tini reaps zombies (Solana web3.js spawns workers under the hood) and
# forwards SIGTERM cleanly so Fly.io can graceful-restart in <1s.
RUN apk add --no-cache tini
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY idl ./idl
# Drop privileges.
USER node
ENTRYPOINT ["/sbin/tini","--"]
CMD ["node","src/index.js"]
