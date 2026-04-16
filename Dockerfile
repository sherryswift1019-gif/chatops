# ChatOps 业务镜像 — 多阶段构建：前端编译 + 后端打包
# 依赖已在 base 镜像烘焙，前端在 web-build stage 编译
#
# Build（linux/amd64）：
#   ./build.sh
#
# base 由 BASE_IMAGE build arg 指定，默认 harbor.paraview.cn/chatops/chatops-base:latest
# 需要重建 base 时使用 ./build-base.sh。

ARG BASE_IMAGE=harbor.paraview.cn/chatops/chatops-base:latest

# ============================================================
# Stage 1: 前端构建（base 已有 node + pnpm + npmmirror 配置）
# ============================================================
FROM ${BASE_IMAGE} AS web-build

WORKDIR /app/web

# 先拷贝锁文件，安装前端依赖（利用 Docker layer cache）
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# 拷贝前端源码并构建
COPY web/ .
RUN pnpm build

# ============================================================
# Stage 2: 最终业务镜像
# ============================================================
FROM ${BASE_IMAGE}

WORKDIR /app

# 源码与编译配置；node_modules 已在 base 中
COPY tsconfig.json ./
COPY src/ src/

# 前端构建产物（来自 web-build stage）
COPY --from=web-build /app/web/dist web/dist

# 验证 TypeScript 编译
RUN npx tsc --noEmit

# chatops 用户 / /data/chatops/test-runs 已在 base 中创建
RUN chown -R chatops:chatops /app
USER chatops

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1})" || exit 1

CMD ["node", "--import", "tsx/esm", "src/server.ts"]
