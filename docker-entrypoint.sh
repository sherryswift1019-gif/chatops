#!/bin/sh
set -e

# Bind mount 把镜像里 chown 过的挂载点覆盖成宿主 inode（默认 root:root）。
# 容器以 root 启动 → 把挂载点 owner 修正回 chatops → gosu 降权 exec CMD。
# 容器内 chatops UID/GID 由 Dockerfile.base 的 useradd 默认值决定（实测 1001:1001）。
DATA_DIR="${TEST_DATA_DIR:-/data/chatops/test-runs}"
mkdir -p "$DATA_DIR"
chown chatops:chatops "$DATA_DIR"

exec gosu chatops "$@"
