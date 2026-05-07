# Stage 1: build
FROM node:20-bookworm-slim AS builder

# Install pnpm via corepack
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

# Install dependencies first (layer cache)
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# Copy source and build
COPY . .
RUN pnpm build

# Stage 2: runtime
# Use the official Playwright image so Chromium and its system deps are present
# for thumbnail capture at runtime.
FROM mcr.microsoft.com/playwright:v1.59.1-jammy AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=15123
ENV HOSTNAME=0.0.0.0

# Copy the Next.js standalone bundle
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

# The data directory is expected to be a bind-mount at runtime.
# Create it here so the container starts cleanly even without a mount.
RUN mkdir -p /app/data && chown -R node:node /app

USER node

EXPOSE 15123

CMD ["node", "server.js"]
