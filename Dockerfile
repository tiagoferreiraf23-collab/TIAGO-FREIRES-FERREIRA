# Production Dockerfile — built from the MONOREPO ROOT
# (not from apps/api, so the build context can see packages/shared).

# ─── Stage 1: install deps ──────────────────────────────────────────────────
FROM node:20-slim AS deps
WORKDIR /app

# Prisma needs openssl + libc6 at runtime
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

# Copy manifests first so docker layer cache only invalidates when deps change
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install ALL deps (need dev for tsc build); we prune at the end
RUN npm ci --no-audit --no-fund

# ─── Stage 2: build ─────────────────────────────────────────────────────────
FROM deps AS builder
WORKDIR /app

COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Build shared first — apps/api imports from @sdr-solar/shared/dist
RUN npm run build --workspace=packages/shared

# Generate Prisma client and compile TypeScript
WORKDIR /app/apps/api
RUN npx prisma generate
RUN npm run build

# ─── Stage 3: production runtime ────────────────────────────────────────────
FROM node:20-slim AS production
WORKDIR /app
ENV NODE_ENV=production

# Same runtime deps as builder (prisma needs them)
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates curl && rm -rf /var/lib/apt/lists/*

# Copy compiled output + node_modules from builder
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared ./packages/shared
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/prisma ./apps/api/prisma
COPY --from=builder /app/apps/api/package.json ./apps/api/package.json

WORKDIR /app/apps/api

# Railway sets PORT automatically — fall back to 3000 if not set
ENV PORT=3000
EXPOSE 3000

# Healthcheck for Railway / Docker — checks the /health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:${PORT:-3000}/health || exit 1

# On boot: apply pending migrations, then start the server.
# `prisma migrate deploy` is safe to run on every start (idempotent).
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
