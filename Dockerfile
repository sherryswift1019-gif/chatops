FROM node:20-slim AS base

RUN corepack enable && corepack prepare pnpm@10 --activate
WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# Copy source
COPY tsconfig.json ./
COPY src/ src/

# Verify TypeScript compiles
RUN npx tsc --noEmit

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1})" || exit 1

CMD ["node", "--loader", "tsx/esm", "src/server.ts"]
