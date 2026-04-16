#!/usr/bin/env bash
# 构建并推送 chatops base 镜像（linux/amd64）
#
# 何时跑：pnpm-lock.yaml / package.json 变化、Node 或 pnpm 版本升级
# 何时不需要：日常改源码（使用 ./build.sh 即可）
#
# 策略：用 buildx (docker-container driver + QEMU) 跨架构 build → --load 到 host docker
# → docker push（复用 host 的 harbor 凭证和 TLS 信任，避免把凭证往 builder 容器里倒腾）
#
# 环境变量：
#   REGISTRY      默认 harbor.paraview.cn/chatops
#   IMAGE_NAME    默认 chatops-base
#   PUSH          默认 1（设为 0 只 build 到本地 docker，不 push）
#   PLATFORM      默认 linux/amd64
#   BUILDER       默认 chatops-multiarch（若不存在则创建）
set -euo pipefail

cd "$(dirname "$0")"

REGISTRY="${REGISTRY:-harbor.paraview.cn/chatops}"
IMAGE_NAME="${IMAGE_NAME:-chatops-base}"
PUSH="${PUSH:-1}"
PLATFORM="${PLATFORM:-linux/amd64}"
BUILDER="${BUILDER:-chatops-multiarch}"

# lockfile hash 作为可追溯归档 tag
LOCK_HASH="$(sha256sum pnpm-lock.yaml | head -c 8)"
DEPS_TAG="deps-${LOCK_HASH}"

LATEST_REF="${REGISTRY}/${IMAGE_NAME}:latest"
DEPS_REF="${REGISTRY}/${IMAGE_NAME}:${DEPS_TAG}"

echo "==> Building ${IMAGE_NAME} (${PLATFORM})"
echo "    latest: ${LATEST_REF}"
echo "    deps:   ${DEPS_REF}"

if ! docker buildx version >/dev/null 2>&1; then
  echo "Error: docker buildx 未安装，请启用 buildx 或升级 Docker。" >&2
  exit 1
fi

# 确保存在支持目标平台的 builder（docker-container driver + QEMU）
if ! docker buildx inspect "${BUILDER}" >/dev/null 2>&1; then
  echo "==> Creating buildx builder '${BUILDER}'"
  docker buildx create --name "${BUILDER}" --driver docker-container --bootstrap >/dev/null
fi

# 1. 跨架构 build 到本地 docker（--load）
docker buildx build \
  --builder "${BUILDER}" \
  --platform "${PLATFORM}" \
  -f Dockerfile.base \
  -t "${LATEST_REF}" \
  -t "${DEPS_REF}" \
  --load \
  .

# 2. 用 host docker 推到 harbor（沿用 host 的自签 CA 信任与凭证）
if [ "${PUSH}" = "1" ]; then
  echo "==> Pushing to ${REGISTRY}"
  docker push "${LATEST_REF}"
  docker push "${DEPS_REF}"
else
  echo "==> Local build only (PUSH=0)"
fi

echo "==> Base image ready:"
echo "    ${LATEST_REF}"
echo "    ${DEPS_REF}"
