# ChatOps 业务镜像 — 多阶段构建：前端编译 + 后端打包
# base 镜像已含：node_modules（前后端）+ 系统依赖（git/curl/gosu）+ Playwright Chromium
# 业务构建仅 COPY 源码 + build。

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

# 不依赖源码的二进制层：先做，让源码改动不会让其失效
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# 源码层：变化频繁，放最后
COPY tsconfig.json ./
COPY src/ src/
# pipeline-a LLM generator 需要 readFileSync(spec.specPath, 'utf8') 读 docs/test-specs/*.md
# 作为 prompt 上下文。chatops 主进程跑 pipeline A 时 cwd=/app，所以 docs 必须 COPY 进 image。
COPY docs/ docs/
COPY --from=web-build /app/web/dist web/dist

RUN npx tsc --noEmit \
 && chown -R chatops:chatops /app

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>{if(!r.ok)throw 1})" || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--import", "tsx/esm", "src/server.ts"]
