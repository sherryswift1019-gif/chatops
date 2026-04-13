FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

# Stage 1: Build frontend
FROM base AS web-build
WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY web/ .
RUN pnpm build

# Stage 2: Backend + serve frontend
FROM base AS final
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

COPY tsconfig.json ./
COPY src/ src/

# Copy frontend build output
COPY --from=web-build /app/web/dist web/dist

# Verify TypeScript compiles
RUN npx tsc --noEmit

# Create data directory for test reports
RUN mkdir -p /data/chatops/test-runs

# Create non-root user (Claude CLI refuses --dangerously-skip-permissions as root)
RUN useradd -m -s /bin/bash chatops && chown -R chatops:chatops /app /data/chatops
USER chatops

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1})" || exit 1

CMD ["node", "--import", "tsx/esm", "src/server.ts"]
