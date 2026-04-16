#!/usr/bin/env bash
# ============================================================
# ChatOps 回滚脚本（部署在目标服务器 /opt/chatops/）
# ============================================================
# 用法:
#   ./rollback.sh                         回滚到上一个版本（纯镜像切换）
#   ./rollback.sh main-abc12345           回滚到指定 tag
#   ./rollback.sh --restore-db            回滚镜像 + 恢复数据库
#   ./rollback.sh --restore-db v1.2.3     恢复数据库 + 指定 tag
# ============================================================
set -euo pipefail

DEPLOY_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="${DEPLOY_DIR}/docker-compose.prod.yml"

RESTORE_DB=false
TARGET_TAG=""

for arg in "$@"; do
  case "$arg" in
    --restore-db) RESTORE_DB=true ;;
    -h|--help)
      echo "用法: $0 [--restore-db] [IMAGE_TAG]"
      echo ""
      echo "  无参数          回滚到上一个版本（纯镜像切换）"
      echo "  IMAGE_TAG       回滚到指定镜像（完整镜像名或 tag）"
      echo "  --restore-db    同时恢复最近一次数据库备份"
      exit 0
      ;;
    *) TARGET_TAG="$arg" ;;
  esac
done

# ── 确定回滚目标 ──
if [ -z "${TARGET_TAG}" ]; then
  if [ ! -f "${DEPLOY_DIR}/.deploy-history" ]; then
    echo "Error: 无部署历史记录（.deploy-history 不存在）"
    echo "请手动指定镜像: $0 harbor.paraview.cn/chatops/chatops:<tag>"
    exit 1
  fi
  HISTORY_LINES=$(wc -l < "${DEPLOY_DIR}/.deploy-history")
  if [ "$HISTORY_LINES" -lt 2 ]; then
    echo "Error: 部署历史不足两条，无法自动确定上一版本"
    echo "请手动指定镜像: $0 harbor.paraview.cn/chatops/chatops:<tag>"
    exit 1
  fi
  TARGET_TAG=$(tail -2 "${DEPLOY_DIR}/.deploy-history" | head -1 | awk '{print $3}')
fi

# 如果传入的是短 tag（不含 /），补全为完整镜像名
if [[ "${TARGET_TAG}" != *"/"* ]]; then
  TARGET_TAG="harbor.paraview.cn/chatops/chatops:${TARGET_TAG}"
fi

echo "==> 回滚目标: ${TARGET_TAG}"

# ── 数据库恢复（可选）──
if [ "${RESTORE_DB}" = "true" ]; then
  LATEST_BACKUP=$(ls -t "${DEPLOY_DIR}/backups/chatops_"*.sql.gz 2>/dev/null | head -1 || true)
  if [ -z "${LATEST_BACKUP}" ]; then
    echo "Error: 无备份文件（${DEPLOY_DIR}/backups/ 为空）"
    exit 1
  fi

  echo "==> 验证备份文件: ${LATEST_BACKUP}"
  gzip -t "${LATEST_BACKUP}" || { echo "Error: 备份文件损坏"; exit 1; }
  echo "==> 备份文件完整，大小: $(du -h "${LATEST_BACKUP}" | cut -f1)"

  echo "==> 停止应用服务..."
  docker compose -f "${COMPOSE_FILE}" stop chatops migrate 2>/dev/null || true

  echo "==> 恢复数据库（--single-transaction 保护，失败自动回滚）..."
  gunzip -c "${LATEST_BACKUP}" \
    | docker compose -f "${COMPOSE_FILE}" exec -T postgres psql -U chatops --single-transaction chatops

  echo "==> 数据库恢复完成"
fi

# ── 镜像回滚 ──
echo "==> 更新 .env 中的 CHATOPS_IMAGE..."
if grep -q '^CHATOPS_IMAGE=' "${DEPLOY_DIR}/.env" 2>/dev/null; then
  sed -i "s|^CHATOPS_IMAGE=.*|CHATOPS_IMAGE=${TARGET_TAG}|" "${DEPLOY_DIR}/.env"
else
  echo "CHATOPS_IMAGE=${TARGET_TAG}" >> "${DEPLOY_DIR}/.env"
fi

echo "==> 重启服务..."
docker compose -f "${COMPOSE_FILE}" rm -f migrate 2>/dev/null || true
docker compose -f "${COMPOSE_FILE}" up -d

# ── 记录回滚操作 ──
echo "$(date +%Y%m%d_%H%M%S) ROLLBACK ${TARGET_TAG}" >> "${DEPLOY_DIR}/.deploy-history"

# ── 健康检查 ──
echo "==> 等待健康检查（max 120s）..."
for i in $(seq 1 24); do
  if curl -sf http://localhost:3000/health 2>/dev/null | grep -q '"ok"'; then
    echo "==> 回滚成功！当前版本: ${TARGET_TAG}"
    exit 0
  fi
  sleep 5
done

echo "==> 健康检查超时，请检查日志:"
echo "    docker compose -f ${COMPOSE_FILE} logs --tail 30 chatops migrate"
exit 1
