#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

ACTION="${1:-up}"

# E2E sandbox subcommands do not require .env
case "$ACTION" in
  provision|teardown|healthcheck|deploy|redeploy) ;;
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
    API_PORT=$(node -e "const net=require('net');const s=net.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})")

    # 沙盒 DB：自动建一个名为 e2e-${RUN_ID} 的库（满足 sandbox-sentinel 的 e2e- 前缀），
    # 跑 chatops migration 把 schema 装进去。host 上没 psql，借 chatops-postgres-1
    # 容器跑 psql。host migration：
    #   - host caller: PG_HOST 未设 → fallback 'localhost'，连 chatops-postgres-1 publish 的端口
    #   - chatops 容器内 caller (setup-sandbox 调时): PG_HOST=postgres → chatops_default 网络上
    #     postgres 别名直连
    PG_CONTAINER="${PG_CONTAINER:-chatops-postgres-1}"
    PG_USER="${PG_USER:-chatops}"
    PG_PASSWORD="${PG_PASSWORD:-chatops}"
    PG_HOST_PORT="${PG_HOST_PORT:-5432}"
    MIGRATE_PG_HOST="${PG_HOST:-localhost}"
    SANDBOX_DB_NAME="${E2E_SANDBOX_DB_NAME:-e2e-${RUN_ID}}"
    SANDBOX_DB_AUTO_CREATED=false
    if [ -z "${E2E_SANDBOX_DB_URL:-}" ]; then
      echo "==> Creating sandbox DB ${SANDBOX_DB_NAME} via ${PG_CONTAINER}..."
      docker exec -e PGPASSWORD="${PG_PASSWORD}" "${PG_CONTAINER}" \
        psql -U "${PG_USER}" -d postgres -v ON_ERROR_STOP=1 \
        -c "CREATE DATABASE \"${SANDBOX_DB_NAME}\""
      SANDBOX_DB_AUTO_CREATED=true
      echo "==> Running chatops migration into sandbox DB..."
      # 用 chatops:latest 镜像跑一次性 migrate 容器：自带源码 + node_modules + tsx，
      # 不依赖 caller 环境（host 或 chatops 容器内）。容器接到 chatops_default 网络
      # 用 'postgres' DNS 别名连 PG。
      docker run --rm \
        --network chatops_default \
        -e DATABASE_URL="postgres://${PG_USER}:${PG_PASSWORD}@postgres:${PG_HOST_PORT}/${SANDBOX_DB_NAME}" \
        --entrypoint="" \
        chatops:latest \
        node --import tsx/esm src/db/migrate.ts >&2

      # 把 chatops 主 DB 的 system_config 拷到 sandbox DB —— sandbox 启动后需要 gitlab/claude
      # 等配置才能跑 pipeline A/B（GitLab clone/MR、Claude API 调用）。
      # fresh sandbox DB schema 已 migrate 完，只拷 data；用 --on-conflict-do-nothing 防已有
      # 同 key（理论上 fresh DB 没冲突，加 ON CONFLICT 是防御）。
      echo "==> Copying system_config from chatops main DB to sandbox DB..."
      docker exec -e PGPASSWORD="${PG_PASSWORD}" "${PG_CONTAINER}" \
        sh -c "pg_dump -U ${PG_USER} -d chatops -t system_config --data-only --column-inserts | \
               sed 's/^INSERT INTO public.system_config/INSERT INTO public.system_config/g; s/);$/) ON CONFLICT (key) DO NOTHING;/g' | \
               psql -U ${PG_USER} -d \"${SANDBOX_DB_NAME}\"" >&2 || \
        echo "==> WARN: system_config copy failed, sandbox may lack gitlab/claude config" >&2
    else
      echo "==> E2E_SANDBOX_DB_URL set, caller is responsible for sandbox DB lifecycle"
    fi

    # 容器视角的 DSN：host=postgres (docker DNS 别名), db=${SANDBOX_DB_NAME}。
    APP_DB_DSN="postgres://${PG_USER}:${PG_PASSWORD}@postgres:${PG_HOST_PORT}/${SANDBOX_DB_NAME}"

    echo "==> Provisioning sandbox network: ${SANDBOX_NET}, port: ${API_PORT}"
    # 给网络打 chatops.e2e.role/runId label —— defense-in-depth：
    # 即使代码兜底 teardown 漏了这条 sandbox，外部按 label 扫描也能识别清理。
    docker network create \
        --label "chatops.e2e.role=sandbox-net" \
        --label "chatops.e2e.runId=${RUN_ID}" \
        "${SANDBOX_NET}" 2>/dev/null || true
    # endpoints 用容器视角（chatops 容器跑 e2e Claude 子进程，通过 chatops_default 网络
    # + sandbox 容器名访问，端口是 sandbox 内部 listen 的 3000）。host 视角的 localhost:${API_PORT}
    # 也保留为 host_web_base_url 供本机直连。
    SANDBOX_CONTAINER="chatops-e2e-${API_PORT}"
    cat > "${OUT_HANDLE}" <<EOF
{
  "envId": "test-iter-${RUN_ID}",
  "kind": "docker-compose-local",
  "endpoints": {
    "web_base_url": "http://${SANDBOX_CONTAINER}:3000",
    "api_base_url": "http://${SANDBOX_CONTAINER}:3000",
    "host_web_base_url": "http://localhost:${API_PORT}",
    "api": "http://${SANDBOX_CONTAINER}:3000",
    "app_db_dsn": "${APP_DB_DSN}"
  },
  "modules": [],
  "internalRefs": {
    "network": "${SANDBOX_NET}",
    "apiPort": ${API_PORT},
    "containerName": "${SANDBOX_CONTAINER}",
    "runId": "${RUN_ID}",
    "branch": "${BRANCH}",
    "sandboxDbName": "${SANDBOX_DB_NAME}",
    "sandboxDbAutoCreated": ${SANDBOX_DB_AUTO_CREATED},
    "pgContainer": "${PG_CONTAINER}",
    "pgUser": "${PG_USER}"
  }
}
EOF
    echo "==> Sandbox provisioned. Handle: ${OUT_HANDLE}"
    ;;

  teardown)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "teardown: --handle file not found: $HANDLE" >&2; exit 1
    fi
    SANDBOX_NET=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs.network)" "$HANDLE")
    SANDBOX_DB_NAME=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs;process.stdout.write(r.sandboxDbName||'')" "$HANDLE")
    SANDBOX_DB_AUTO_CREATED=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs;process.stdout.write(String(!!r.sandboxDbAutoCreated))" "$HANDLE")
    PG_CONTAINER=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs;process.stdout.write(r.pgContainer||'chatops-postgres-1')" "$HANDLE")
    PG_USER=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs;process.stdout.write(r.pgUser||'chatops')" "$HANDLE")

    echo "==> Tearing down sandbox network: ${SANDBOX_NET}"
    docker ps -a --filter "network=${SANDBOX_NET}" --format "{{.ID}}" | xargs -r docker rm -f
    docker network rm "${SANDBOX_NET}" 2>/dev/null || true

    if [ "$SANDBOX_DB_AUTO_CREATED" = "true" ] && [ -n "$SANDBOX_DB_NAME" ]; then
      PG_PASSWORD="${PG_PASSWORD:-chatops}"
      echo "==> Dropping sandbox DB ${SANDBOX_DB_NAME}..."
      # 强断掉残留连接（容器已 rm 但 PG 端可能慢半拍释放）再 drop
      docker exec -e PGPASSWORD="${PG_PASSWORD}" "${PG_CONTAINER}" \
        psql -U "${PG_USER}" -d postgres \
        -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${SANDBOX_DB_NAME}'" >/dev/null 2>&1 || true
      docker exec -e PGPASSWORD="${PG_PASSWORD}" "${PG_CONTAINER}" \
        psql -U "${PG_USER}" -d postgres \
        -c "DROP DATABASE IF EXISTS \"${SANDBOX_DB_NAME}\"" || \
        echo "==> WARN: dropdb 失败，留下孤儿库 ${SANDBOX_DB_NAME}"
    fi
    echo "==> Teardown complete."
    ;;

  healthcheck)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "healthcheck: --handle file not found" >&2; exit 1
    fi
    API_PORT=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs.apiPort))" "$HANDLE")
    CONTAINER_NAME="chatops-e2e-${API_PORT}"
    echo "==> Healthcheck on container ${CONTAINER_NAME}..."
    for i in $(seq 1 30); do
      STATUS=$(docker inspect --format='{{.State.Health.Status}}' "${CONTAINER_NAME}" 2>/dev/null || echo "not_found")
      if [ "$STATUS" = "healthy" ]; then
        echo "==> Healthy."; exit 0
      fi
      sleep 2
    done
    echo "==> Healthcheck failed after 60s (status: ${STATUS})" >&2; exit 1
    ;;

  deploy)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "deploy: --handle file not found" >&2; exit 1
    fi
    API_PORT=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs.apiPort))" "$HANDLE")
    SANDBOX_NET=$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs.network)" "$HANDLE")
    HANDLE_DB_DSN=$(node -e "const e=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).endpoints||{};process.stdout.write(e.app_db_dsn||'')" "$HANDLE")
    HANDLE_RUN_ID=$(node -e "const r=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs;process.stdout.write(String(r.runId||''))" "$HANDLE")
    CONTAINER_NAME="chatops-e2e-${API_PORT}"

    # 优先用 handle.endpoints.app_db_dsn（provision 已建好的 sandbox DB，容器视角）。
    # 否则 fallback 到 E2E_SANDBOX_DB_URL 或 host DATABASE_URL，并把 host=localhost/127.0.0.1
    # 替换成 chatops_default 网络上的 docker DNS 别名 'postgres'（兼容老 caller）。
    if [ -n "$HANDLE_DB_DSN" ]; then
      SANDBOX_DB_URL="$HANDLE_DB_DSN"
    else
      SANDBOX_DB_URL="${E2E_SANDBOX_DB_URL:-$DATABASE_URL}"
      SANDBOX_DB_URL=$(echo "$SANDBOX_DB_URL" | sed -E 's#@(localhost|127\.0\.0\.1)([:/])#@postgres\2#g')
    fi

    echo "==> Deploying into sandbox (port ${API_PORT}, net ${SANDBOX_NET})..."
    docker rm -f "${CONTAINER_NAME}" 2>/dev/null || true
    # 给容器打 chatops.e2e.role/runId label —— defense-in-depth：
    # 即使代码兜底 teardown 漏了这条 sandbox，外部按 label 扫描也能识别清理。
    docker run -d \
      --name "${CONTAINER_NAME}" \
      --label "chatops.e2e.role=sandbox" \
      --label "chatops.e2e.runId=${HANDLE_RUN_ID:-unknown}" \
      --network "${SANDBOX_NET}" \
      -p "${API_PORT}:3000" \
      -e E2E_SANDBOX_MODE=true \
      -e PORT=3000 \
      -e DATABASE_URL="${SANDBOX_DB_URL}" \
      -v /var/run/docker.sock:/var/run/docker.sock \
      -v /srv/chatops/test-runs:/data/chatops/test-runs \
      chatops:latest
    docker network connect chatops_default "${CONTAINER_NAME}" 2>/dev/null || true
    echo "{\"deployedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"modules\":[\"chatops\"]}"
    ;;

  redeploy)
    HANDLE="${2#--handle=}"
    if [ -z "$HANDLE" ] || [ ! -f "$HANDLE" ]; then
      echo "redeploy: --handle file not found" >&2; exit 1
    fi
    API_PORT=$(node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).internalRefs.apiPort))" "$HANDLE")
    CONTAINER_NAME="chatops-e2e-${API_PORT}"
    echo "==> Redeploying sandbox (port ${API_PORT})..."
    docker restart "${CONTAINER_NAME}"
    echo "{\"redeployedAt\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}"
    ;;

  *)
    echo "Usage: $0 {up|down|restart|logs|migrate|status|provision|teardown|healthcheck|deploy|redeploy}"
    exit 1
    ;;
esac
