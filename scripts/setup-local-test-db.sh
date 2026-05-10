#!/usr/bin/env bash
# =============================================================================
# scripts/setup-local-test-db.sh
#
# 当本机没有 docker 时，用本机 PostgreSQL 直接搭测试库（绕开 testcontainer）。
# 适用于 macOS Homebrew postgresql@17 / postgresql@16 之类原生安装。
#
# 用法:
#   ./scripts/setup-local-test-db.sh                       # 默认 chatops_test 库
#   DB_NAME=foo ./scripts/setup-local-test-db.sh           # 自定义库名
#   PSQL=/usr/local/bin/psql ./scripts/setup-local-test-db.sh
#
# 跑完会打印 export 行（脚本本身在 subshell 里跑，不能 export 到 caller）。
# 拷过去贴到 shell 即可：
#
#   eval "$(./scripts/setup-local-test-db.sh)"
#   npx vitest run --root . src/__tests__/integration/quick-impl-schema-v60.test.ts
#
# 为什么：testcontainer 需要 docker socket；本机没装时（Day 0 验证之前部分开发
# 机的状态），这是最快上手的临时方案。生产 / CI 仍然走 testcontainer 或
# GitLab service。
# =============================================================================
set -euo pipefail

PROJ_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="${DB_NAME:-chatops_test}"
DB_USER="${DB_USER:-$(whoami)}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"

# 自动找 psql：优先 PATH，其次 Homebrew 路径
if [[ -z "${PSQL:-}" ]]; then
  if command -v psql > /dev/null 2>&1; then
    PSQL="$(command -v psql)"
  elif [[ -x /opt/homebrew/opt/postgresql@17/bin/psql ]]; then
    PSQL=/opt/homebrew/opt/postgresql@17/bin/psql
  elif [[ -x /opt/homebrew/opt/postgresql@16/bin/psql ]]; then
    PSQL=/opt/homebrew/opt/postgresql@16/bin/psql
  else
    echo "ERROR: psql not found. Set PSQL=/path/to/psql or install postgresql." >&2
    exit 1
  fi
fi

DATABASE_URL="postgresql://${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME}"

# stderr 是日志（用户看），stdout 是 export 行（eval 用）
log() { echo "[setup-local-test-db] $*" >&2; }

log "psql:    $PSQL"
log "target:  $DB_NAME @ $DB_HOST:$DB_PORT (user $DB_USER)"

# 1. drop + create
log "drop database $DB_NAME (if exists)"
"$PSQL" -d postgres -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
  -c "DROP DATABASE IF EXISTS $DB_NAME" >&2

log "create database $DB_NAME"
"$PSQL" -d postgres -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
  -c "CREATE DATABASE $DB_NAME" >&2

# 2. apply schemas in numeric order: schema.sql 优先，然后 schema-v<N>.sql 按 N 升序
SCHEMA_DIR="$PROJ_ROOT/src/db"
log "applying schema files from $SCHEMA_DIR"

# 用 ls + awk 排序（schema.sql 给 0，其他取数字）
FILES=()
while IFS= read -r line; do
  FILES+=("$line")
done < <(
  cd "$SCHEMA_DIR"
  ls schema*.sql 2>/dev/null | awk '{
    if ($1 == "schema.sql") {
      print "0\t"$1
    } else {
      v = substr($1, index($1,"-v") + 2)
      sub(/\.sql$/, "", v)
      print v"\t"$1
    }
  }' | sort -n | cut -f2
)

if [[ ${#FILES[@]} -eq 0 ]]; then
  log "ERROR: no schema files in $SCHEMA_DIR"
  exit 1
fi

count=0
for f in "${FILES[@]}"; do
  log "  apply $f"
  "$PSQL" -v ON_ERROR_STOP=1 -d "$DB_NAME" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
    -f "$SCHEMA_DIR/$f" > /dev/null 2>&1 || {
      log "ERROR: schema $f apply failed; rerun manually for details:"
      log "  $PSQL -d $DB_NAME -f $SCHEMA_DIR/$f"
      exit 1
    }
  count=$((count + 1))
done
log "applied $count schema files"

# 3. marker 表（resetTestDb 通过此表确认是测试库）
log "creating chatops_test_db_marker"
"$PSQL" -d "$DB_NAME" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
  -c "CREATE TABLE IF NOT EXISTS chatops_test_db_marker ()" > /dev/null 2>&1

# 4. 健康检查：v60 表必须在
log "verifying v60 tables..."
TABLES=$(
  "$PSQL" -d "$DB_NAME" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -At \
    -c "SELECT to_regclass(t)::TEXT FROM (VALUES
          ('public.requirements'),
          ('public.requirement_approval_waiters'),
          ('public.test_pipelines'),
          ('public.pipeline_node_types')
        ) AS s(t)"
)
for line in $TABLES; do
  if [[ "$line" == "" ]]; then
    log "ERROR: required table missing after migration"
    exit 1
  fi
done
log "v60 tables OK: requirements, requirement_approval_waiters, test_pipelines, pipeline_node_types"

NODE_TYPE_COUNT=$(
  "$PSQL" -d "$DB_NAME" -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -At \
    -c "SELECT COUNT(*) FROM pipeline_node_types WHERE category='quick_impl'"
)
if [[ "$NODE_TYPE_COUNT" != "4" ]]; then
  log "ERROR: expected 4 quick_impl node types, got $NODE_TYPE_COUNT"
  exit 1
fi
log "quick_impl node types OK: 4 (skill_node, skill_with_approval, skill_with_review, mr_create)"

log ""
log "✅ test db ready"
log ""
log "to use:  eval \"\$(./scripts/setup-local-test-db.sh)\""
log "   then: npx vitest run --root . <test-file>"
log ""

# stdout 是给 eval 用的 export 行
echo "export CI=true"
echo "export DATABASE_URL='$DATABASE_URL'"
