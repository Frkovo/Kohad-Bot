# syntax=docker/dockerfile:1
# Build the TypeScript sources, then copy only the compiled output and production dependencies.
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# sharp and @resvg/resvg-js ship prebuilt binaries for linux-x64; no build tools are needed.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY keys.json ./
COPY scripts/healthcheck.mjs scripts/migrate-legacy.mjs ./scripts/
# The data directory holds caches and logs only; player data lives in MySQL.
RUN mkdir -p /app/.data && chown -R node:node /app/.data
USER node
EXPOSE 3729
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 CMD ["node", "scripts/healthcheck.mjs"]
CMD ["node", "dist/index.js"]
