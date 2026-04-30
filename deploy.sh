#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

ACTION="${1:-up}"

# E2E sandbox subcommands do not require .env
case "$ACTION" in
  provision|teardown|healthcheck) ;;
  *)
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
    ;;
esac

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

  provision)
    BRANCH="${2#--branch=}"
    OUT_HANDLE="${3#--out-handle=}"
    if [ -z "$BRANCH" ] || [ -z "$OUT_HANDLE" ]; then
      echo "Usage: $0 provision --branch=<branch> --out-handle=<file>" >&2; exit 1
    fi
    RUN_ID="${E2E_RUN_ID:-$(date +%s)}"
    SANDBOX_NET="chatops-e2e-sandbox-${RUN_ID}"
    API_PORT=$(python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()")
    echo "==> Provisioning sandbox network: ${SANDBOX_NET}, port: ${API_PORT}"
    docker network create "${SANDBOX_NET}" 2>/dev/null || true
    cat > "${OUT_HANDLE}" <<EOF
{
  "envId": "test-iter-${RUN_ID}",
  "kind": "docker-compose-local",
  "endpoints": { "api": "http://localhost:${API_PORT}" },
  "modules": [],
  "internalRefs": { "network": "${SANDBOX_NET}", "apiPort": ${API_PORT}, "runId": "${RUN_ID}", "branch": "${BRANCH}" }
}
EOF
    echo "==> Sandbox provisioned. Handle: ${OUT_HANDLE}"
    ;;

  teardown)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "teardown: --handle file not found: $HANDLE" >&2; exit 1
    fi
    SANDBOX_NET=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['internalRefs']['network'])" "$HANDLE")
    echo "==> Tearing down sandbox network: ${SANDBOX_NET}"
    docker ps -a --filter "network=${SANDBOX_NET}" --format "{{.ID}}" | xargs -r docker rm -f
    docker network rm "${SANDBOX_NET}" 2>/dev/null || true
    echo "==> Teardown complete."
    ;;

  healthcheck)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "healthcheck: --handle file not found" >&2; exit 1
    fi
    API_PORT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['internalRefs']['apiPort'])" "$HANDLE")
    echo "==> Healthcheck on port ${API_PORT}..."
    for i in $(seq 1 30); do
      if curl -sf "http://localhost:${API_PORT}/health" > /dev/null 2>&1; then
        echo "==> Healthy."; exit 0
      fi
      sleep 2
    done
    echo "==> Healthcheck failed after 60s" >&2; exit 1
    ;;

  deploy)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "deploy: --handle file not found" >&2; exit 1
    fi
    API_PORT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['internalRefs']['apiPort'])" "$HANDLE")
    SANDBOX_NET=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['internalRefs']['network'])" "$HANDLE")
    echo "==> Deploying into sandbox (port ${API_PORT}, net ${SANDBOX_NET})..."
    E2E_SANDBOX_MODE=true \
    PORT="${API_PORT}" \
    DOCKER_NETWORK="${SANDBOX_NET}" \
    DATABASE_URL="${E2E_SANDBOX_DB_URL:-$DATABASE_URL}" \
    docker compose -p "e2e-${API_PORT}" up -d --build chatops
    echo "{\"deployedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"modules\":[\"chatops\"]}"
    ;;

  redeploy)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "redeploy: --handle file not found" >&2; exit 1
    fi
    API_PORT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d['internalRefs']['apiPort'])" "$HANDLE")
    echo "==> Redeploying sandbox (port ${API_PORT})..."
    E2E_SANDBOX_MODE=true PORT="${API_PORT}" docker compose -p "e2e-${API_PORT}" restart chatops
    echo "{\"redeployedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    ;;

  *)
    echo "Usage: $0 {up|down|restart|logs|migrate|status|provision|teardown|healthcheck|deploy|redeploy}"
    exit 1
    ;;
esac
