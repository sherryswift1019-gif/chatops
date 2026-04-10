#!/usr/bin/env bash
set -euo pipefail

IMAGE_NAME="${IMAGE_NAME:-chatops}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

echo "==> Building ${IMAGE_NAME}:${IMAGE_TAG}"
docker build -t "${IMAGE_NAME}:${IMAGE_TAG}" .

echo "==> Build complete: ${IMAGE_NAME}:${IMAGE_TAG}"
docker images "${IMAGE_NAME}:${IMAGE_TAG}" --format "Size: {{.Size}}"
