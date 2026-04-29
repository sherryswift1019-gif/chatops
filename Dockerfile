# ChatOps 业务镜像 — 多阶段构建：前端编译 + 后端打包
# base 镜像已含后端 + 前端 node_modules，业务构建仅 COPY 源码 + build。

ARG BASE_IMAGE=harbor.paraview.cn/chatops/chatops-base:latest

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
# JDK/Maven 暂不打包，fix_bug 当前不跑测试（TODO #14 规划 DinD 多语言构建环境）
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates curl gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
 && chmod a+r /etc/apt/keyrings/docker.asc \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo \"$VERSION_CODENAME\") stable" \
    > /etc/apt/sources.list.d/docker.list \
 && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.email "chatops@paraview.cn" \
 && git config --system user.name "ChatOps Agent"

RUN chown -R chatops:chatops /app
USER chatops

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1})" || exit 1

CMD ["node", "--import", "tsx/esm", "src/server.ts"]
