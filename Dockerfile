# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src

RUN npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
# Use the official Playwright image which already has Chromium + system deps
FROM mcr.microsoft.com/playwright:v1.44.0-jammy AS runner

WORKDIR /app

# Only install production deps in the final image
COPY package*.json ./
RUN npm ci --omit=dev

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Playwright needs a writable HOME for browser cache
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV NODE_ENV=production

# The app writes backup files here; mount a volume in Railway if you want persistence
RUN mkdir -p /app/backups

EXPOSE 4000

CMD ["node", "dist/server.js"]
