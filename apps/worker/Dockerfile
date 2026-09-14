# Multi-stage build for the BullMQ worker. Build context MUST be the monorepo root, e.g.:
#   docker build -f apps/worker/Dockerfile -t relay-worker .
FROM node:20-slim AS runtime-base
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM node:20-slim AS base
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

# --- install: only package manifests, so this layer is cached until a dependency actually changes ---
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/database/package.json packages/database/package.json
RUN pnpm install --frozen-lockfile

# --- build: real source, generate the Prisma client, compile to dist ---
FROM deps AS build
COPY packages/database packages/database
COPY apps/worker apps/worker
RUN pnpm --filter @ai-customer-agent/database exec prisma generate
RUN pnpm --filter @ai-customer-agent/worker build

# --- runtime: ship the whole node_modules tree as-is (preserves pnpm's symlinked/hoisted layout,
# including the generated Prisma client) rather than a hand-pruned copy — larger image, but correct
# and simple; revisit with `pnpm deploy` if image size becomes a real concern. ---
FROM runtime-base AS runtime
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/worker
CMD ["node", "dist/worker.js"]
