#!/usr/bin/env bash
# ============================================================
# ChatOps 目标服务器一次性初始化脚本
# ============================================================
# 从开发机执行，通过 SSH 初始化目标服务器
# 用法: ./scripts/setup-target.sh
# 环境变量:
#   DEPLOY_HOST       目标 IP（默认 10.10.1.166）
#   DEPLOY_DIR        部署目录（默认 /opt/chatops）
#   DEPLOY_PASSWORD   SSH 密码（必需）
#   HARBOR_REGISTRY   Harbor 地址（默认 harbor.paraview.cn）
# ============================================================
set -euo pipefail

DEPLOY_HOST="${DEPLOY_HOST:-10.10.1.166}"
DEPLOY_DIR="${DEPLOY_DIR:-/opt/chatops}"
HARBOR_REGISTRY="${HARBOR_REGISTRY:-harbor.paraview.cn}"

if [ -z "${DEPLOY_PASSWORD:-}" ]; then
  echo "Error: DEPLOY_PASSWORD 未设置"
  echo "用法: DEPLOY_PASSWORD=xxx ./scripts/setup-target.sh"
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

export SSHPASS="${DEPLOY_PASSWORD}"
SSH_OPTS="-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR"
SSH="sshpass -e ssh ${SSH_OPTS}"
SCP="sshpass -e scp ${SSH_OPTS}"

echo "==> 初始化 ${DEPLOY_HOST}:${DEPLOY_DIR}"

# ── 1. 远程初始化 ──
${SSH} root@${DEPLOY_HOST} "bash -s" <<SETUP_EOF
set -euo pipefail

echo "--- 创建部署目录 ---"
mkdir -p ${DEPLOY_DIR}/backups

echo "--- 检查 Docker ---"
if ! command -v docker &>/dev/null; then
  echo "ERROR: Docker 未安装，请先安装 Docker"
  exit 1
fi
docker --version

echo "--- 检查 Docker Compose V2 ---"
if ! docker compose version &>/dev/null; then
  echo "ERROR: Docker Compose V2 未安装"
  echo "请安装: apt-get install docker-compose-plugin"
  exit 1
fi
docker compose version

echo "--- 配置 insecure-registries ---"
DAEMON_JSON="/etc/docker/daemon.json"
if [ -f "\${DAEMON_JSON}" ]; then
  if grep -q "${HARBOR_REGISTRY}" "\${DAEMON_JSON}"; then
    echo "insecure-registries 已配置，跳过"
  else
    echo "WARNING: \${DAEMON_JSON} 已存在但未包含 ${HARBOR_REGISTRY}"
    echo "请手动将 \"${HARBOR_REGISTRY}\" 添加到 insecure-registries 数组"
    echo "然后执行: systemctl restart docker"
  fi
else
  cat > "\${DAEMON_JSON}" <<'DAEMON_INNER_EOF'
{
  "insecure-registries": ["${HARBOR_REGISTRY}"]
}
DAEMON_INNER_EOF
  echo "已创建 \${DAEMON_JSON}，重启 Docker daemon..."
  systemctl restart docker
  echo "Docker daemon 已重启"
fi

echo "--- 创建 .env 模板 ---"
if [ ! -f "${DEPLOY_DIR}/.env" ]; then
  cat > "${DEPLOY_DIR}/.env" <<'ENV_EOF'
PORT=3000
ENV_EOF
  chmod 600 "${DEPLOY_DIR}/.env"
  echo "已创建 .env 模板（权限 600）"
else
  echo ".env 已存在，跳过"
fi

echo "--- 初始化完成 ---"
SETUP_EOF

# ── 2. 传输文件 ──
echo "==> 传输 docker-compose.prod.yml..."
${SCP} "${SCRIPT_DIR}/docker-compose.prod.yml" root@${DEPLOY_HOST}:${DEPLOY_DIR}/docker-compose.prod.yml

echo "==> 传输 rollback.sh..."
${SCP} "${SCRIPT_DIR}/scripts/rollback.sh" root@${DEPLOY_HOST}:${DEPLOY_DIR}/rollback.sh
${SSH} root@${DEPLOY_HOST} "chmod +x ${DEPLOY_DIR}/rollback.sh"

echo ""
echo "============================================================"
echo "初始化完成！"
echo "============================================================"
echo ""
echo "后续步骤:"
echo "  1. SSH 到 ${DEPLOY_HOST}，编辑 ${DEPLOY_DIR}/.env 填入生产凭证"
echo "     （如 ANTHROPIC_API_KEY、DINGTALK_CLIENT_ID 等）"
echo "  2. 在 GitLab CI/CD Variables 中添加 DEPLOY_PASSWORD (Masked)"
echo "  3. 推送代码到 main，在 GitLab Pipeline 中手动触发 deploy-prod"
