# ChatOps 业务镜像 — 多阶段构建：前端编译 + 后端打包
# base 镜像已含后端 + 前端 node_modules，业务构建仅 COPY 源码 + build。

ARG BASE_IMAGE=harbor.paraview.cn/chatops/chatops-base:latest
ARG DOCKER_IMAGE=harbor.paraview.cn/para-pam/docker:27

# docker CLI 二进制来自 Harbor（避免访问 download.docker.com）
FROM ${DOCKER_IMAGE} AS docker-cli

# ============================================================
# Stage 1: 前端构建（node_modules 已在 base 中，只需 COPY 源码 + build）
# ============================================================
FROM ${BASE_IMAGE} AS web-build

WORKDIR /app/web
COPY web/ .
RUN pnpm build

# ============================================================
# Stage 2: 最终业务镜像
# ============================================================
FROM ${BASE_IMAGE}

WORKDIR /app

COPY tsconfig.json ./
COPY src/ src/
COPY --from=web-build /app/web/dist web/dist

RUN npx tsc --noEmit

# 运行时依赖：git 用于 analyze_bug/fix_bug 的 clone + worktree
# docker CLI 直接从 docker-cli stage 复制，不走外网 apt 源
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gosu \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.email "chatops@paraview.cn" \
 && git config --system user.name "ChatOps Agent"

# 安装 Playwright Chromium 及系统依赖（用于 E2E baseline 检查）
RUN npx playwright install chromium --with-deps

COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker

RUN chown -R chatops:chatops /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1})" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx/esm", "src/server.ts"]
