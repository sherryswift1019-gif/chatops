#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Check .env exists
if [ ! -f .env ]; then
  echo "Error: .env file not found. Copy from .env.example and fill in values:"
  echo "  cp .env.example .env"
  exit 1
fi

# Source .env for variable expansion in docker-compose
set -a; source .env; set +a

# 禁用 BuildKit：BuildKit 会重新向 Harbor 做 OAuth 验证，
# 而内网 Harbor TLS 证书不符合标准会导致构建失败；旧版 builder 使用本地缓存镜像。
export DOCKER_BUILDKIT=0
# 本地构建优先使用本地 base 镜像，避免重新拉取
export BASE_IMAGE="${BASE_IMAGE:-chatops-base:local}"

ACTION="${1:-up}"

case "$ACTION" in
  up)
    echo "==> Starting ChatOps platform..."
    docker compose up -d --build
    echo "==> Waiting for health check..."
    sleep 5
    if curl -sf http://localhost:${PORT:-3000}/health > /dev/null 2>&1; then
      echo "==> ChatOps is running at http://localhost:${PORT:-3000}"
      echo ""
      echo "Webhook endpoints:"
      echo "  DingTalk: http://<host>:${PORT:-3000}/webhook/dingtalk"
      echo "  Feishu:   http://<host>:${PORT:-3000}/webhook/feishu"
      echo "  GitLab:   http://<host>:${PORT:-3000}/webhook/gitlab"
    else
      echo "==> Health check failed. Checking logs..."
      docker compose logs chatops --tail 20
      exit 1
    fi
    ;;

  down)
    echo "==> Stopping ChatOps platform..."
    docker compose down
    echo "==> Stopped."
    ;;

  restart)
    echo "==> Restarting ChatOps..."
    docker compose restart chatops
    ;;

  logs)
    docker compose logs -f chatops
    ;;

  migrate)
    echo "==> Running database migration..."
    docker compose run --rm migrate
    echo "==> Migration complete."
    ;;

  status)
    docker compose ps
    ;;

  *)
    echo "Usage: $0 {up|down|restart|logs|migrate|status}"
    exit 1
    ;;
esac
