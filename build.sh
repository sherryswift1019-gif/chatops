#!/usr/bin/env bash
# 构建业务镜像（linux/amd64）
# 前置：chatops-base 镜像已在 harbor 可用（首次或 lockfile 变化时跑 ./build-base.sh）
# 前端在 Dockerfile 多阶段内编译，本地无需预构建 web/dist。
#
# 环境变量：
#   IMAGE_NAME    默认 chatops
#   IMAGE_TAG     默认 latest
#   BASE_IMAGE    默认 harbor.paraview.cn/chatops/chatops-base:latest
#   PLATFORM      默认 linux/amd64
set -euo pipefail

cd "$(dirname "$0")"

IMAGE_NAME="${IMAGE_NAME:-chatops}"
IMAGE_TAG="${IMAGE_TAG:-latest}"
BASE_IMAGE="${BASE_IMAGE:-harbor.paraview.cn/chatops/chatops-base:latest}"
PLATFORM="${PLATFORM:-linux/amd64}"

echo "==> Building ${IMAGE_NAME}:${IMAGE_TAG} (${PLATFORM})"
echo "    base: ${BASE_IMAGE}"

if docker buildx version >/dev/null 2>&1; then
  docker buildx build \
    --platform "${PLATFORM}" \
    --build-arg BASE_IMAGE="${BASE_IMAGE}" \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    --load \
    .
else
  docker build \
    --build-arg BASE_IMAGE="${BASE_IMAGE}" \
    -t "${IMAGE_NAME}:${IMAGE_TAG}" \
    .
fi

echo "==> Build complete: ${IMAGE_NAME}:${IMAGE_TAG}"
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "Size: {{.Size}}"
