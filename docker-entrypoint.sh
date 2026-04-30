#!/bin/sh
set -e

# Bind mount 把镜像里 chown 过的挂载点覆盖成宿主 inode（默认 root:root）。
# 容器以 root 启动 → 把挂载点 owner 修正回 chatops → gosu 降权 exec CMD。
# 容器内 chatops UID/GID 由 Dockerfile.base 的 useradd 默认值决定（实测 1001:1001）。
DATA_DIR="${TEST_DATA_DIR:-/data/chatops/test-runs}"
mkdir -p "$DATA_DIR"
chown chatops:chatops "$DATA_DIR"

# Docker-out-of-Docker：在 gosu 降权前授予 chatops 访问 Docker socket 的权限。
# gosu 通过 initgroups() 重建 supplementary groups，只读 /etc/group，
# 因此 docker-compose group_add 加的 GID 会被丢弃，必须在此处显式处理。
# OrbStack/macOS: socket 呈现为 root:root(GID 0)，用 chgrp 转给 chatops。
# 标准 Linux docker group(非 0 GID): usermod -aG 写入 /etc/group，gosu 能读到。
if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  if [ "$SOCK_GID" = "0" ]; then
    chgrp chatops /var/run/docker.sock
  else
    getent group "$SOCK_GID" >/dev/null 2>&1 || groupadd -g "$SOCK_GID" docker-host
    usermod -aG "$(getent group "$SOCK_GID" | cut -d: -f1)" chatops
  fi
fi

exec gosu chatops "$@"
