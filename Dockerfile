# ─────────────────────────── Сборка ───────────────────────────
FROM node:22-bookworm-slim AS build

WORKDIR /app

# Манифесты отдельным слоем: пока зависимости не поменялись, npm ci не переигрывается.
COPY package.json package-lock.json ./
COPY server/package.json ./server/
COPY web/package.json ./web/
RUN npm ci

COPY . .
RUN npm run build \
    && npm prune --omit=dev \
    && mkdir -p server/node_modules web/node_modules

# ─────────────────────────── Рантайм ───────────────────────────
FROM node:22-bookworm-slim AS runtime

# Версию ядра фиксируем: конфиг генерируется под современный формат (≥ 1.11),
# а в 1.13 удалены устаревшие поля, на которые мы намеренно не опираемся.
ARG SINGBOX_VERSION=1.13.18

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl tini; \
    rm -rf /var/lib/apt/lists/*; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sb_arch=amd64 ;; \
      arm64) sb_arch=arm64 ;; \
      *) echo "неподдерживаемая архитектура: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/SagerNet/sing-box/releases/download/v${SINGBOX_VERSION}/sing-box-${SINGBOX_VERSION}-linux-${sb_arch}.tar.gz" -o /tmp/sing-box.tar.gz; \
    tar -xzf /tmp/sing-box.tar.gz -C /tmp; \
    install -m 0755 "/tmp/sing-box-${SINGBOX_VERSION}-linux-${sb_arch}/sing-box" /usr/local/bin/sing-box; \
    rm -rf /tmp/sing-box*; \
    sing-box version

WORKDIR /app

COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/node_modules ./server/node_modules
COPY --from=build /app/server/dist ./server/dist
COPY --from=build /app/server/public ./server/public

ENV NODE_ENV=production \
    DATA_DIR=/data \
    SINGBOX_BIN=/usr/local/bin/sing-box \
    HOST=0.0.0.0 \
    PORT=8080

VOLUME ["/data"]

# Рабочий каталог — server: оттуда резолвятся ./public и ./,../node_modules.
WORKDIR /app/server

# tini как PID 1: sing-box запускается дочерним процессом, и без него
# зомби-процессы копились бы при каждом перезапуске ядра.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/index.js"]
