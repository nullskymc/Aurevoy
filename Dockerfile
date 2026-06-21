# ── Builder ──────────────────────────────────────────
FROM node:22-slim AS builder
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/web-ui/package.json packages/web-ui/
COPY apps/agent/package.json apps/agent/
COPY apps/desktop/package.json apps/desktop/
RUN npm ci --ignore-scripts && npm rebuild better-sqlite3

COPY packages/shared/ packages/shared/
COPY apps/agent/ apps/agent/
RUN npm run build:shared && npm run build -w @aurevoy/agent && npm prune --production

# ── Runtime ──────────────────────────────────────────
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      git python3 curl ca-certificates \
    && curl -LsSf https://astral.sh/uv/install.sh | sh \
    && mv /root/.local/bin/uv /usr/local/bin/uv \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /root/.local

WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder /app/packages/shared/package.json ./packages/shared/
COPY --from=builder /app/apps/agent/dist ./apps/agent/dist
COPY --from=builder /app/apps/agent/package.json ./apps/agent/
COPY --from=builder /app/apps/agent/skills ./apps/agent/skills

ENV AUREVOY_HOST=0.0.0.0 \
    AUREVOY_PORT=8787 \
    AUREVOY_PYTHON_AUTO_SETUP=false \
    AUREVOY_PYTHON_HOME=/usr \
    AUREVOY_LOG_PRETTY=false \
    NODE_ENV=production

VOLUME ["/root/.aurevoy"]

EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s \
  CMD node -e "fetch('http://127.0.0.1:8787/api/health').then(r=>{process.exit(r.ok?0:1)})"

CMD ["node", "apps/agent/dist/index.js"]
