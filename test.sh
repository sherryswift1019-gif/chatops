#!/usr/bin/env bash
# =============================================================================
# ChatOps 测试入口（合并环境准备 + vitest 运行 + 报告）
#
# 用法:
#   ./test.sh                     # 跑全套测试（落盘到 logs/test-*.log + 生成 markdown 报告）
#   ./test.sh --setup-env         # 初始化环境：缺啥装啥（docker/node/pnpm/psql）+ 预拉镜像 + pnpm install + bootstrap DB
#   ./test.sh --filter <pattern>  # 只跑匹配文件名/路径的测试（透传给 vitest run）
#   ./test.sh --list              # 仅列出测试文件不执行
#   ./test.sh --keep              # 跑完保留 testcontainer 容器（调试用）
#   ./test.sh --rounds 5          # 疲劳测试：跑 5 轮
#   ./test.sh --typecheck         # 仅跑 tsc --noEmit + web/tsc，不跑测试
#
# 设计原则（受用户反馈约束）:
#   - vitest 全套约 200s+，单次跑完 tee 落盘到 logs/，后续 grep / awk 都从文件抽
#     绝不"先 tail 再 grep"两遍跑（参见 memory/feedback_long_test_run_once.md）
# =============================================================================
set -uo pipefail

PROJ_ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$PROJ_ROOT/logs"
mkdir -p "$LOG_DIR"

# ─── 颜色化日志 ───────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
info()   { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()   { echo -e "${YELLOW}[WARN]${NC} $*"; }
fail()   { echo -e "${RED}[FAIL]${NC} $*"; }
header() { echo -e "\n${CYAN}═══ $* ═══${NC}\n"; }

# ─── 全局参数 ─────────────────────────────────────────────────────────────────
ACTION="run"        # run | setup-env | typecheck | list | discover | static-check | scenario
FILTER=""
KEEP=false
ROUNDS=1
SCENARIO_ID=""
EVIDENCE_DIR=""
FORMAT="text"

while [[ $# -gt 0 ]]; do
    case "$1" in
        --setup-env) ACTION="setup-env"; shift ;;
        --typecheck) ACTION="typecheck"; shift ;;
        --list)      ACTION="list"; shift ;;
        --filter)    FILTER="$2"; shift 2 ;;
        --keep)      KEEP=true; shift ;;
        --rounds)    ROUNDS="$2"; shift 2 ;;
        --discover)  ACTION="discover"; shift ;;
        --static-check) ACTION="static-check"; shift ;;
        --scenario)  ACTION="scenario"; SCENARIO_ID="$2"; shift 2 ;;
        --evidence-dir) EVIDENCE_DIR="$2"; shift 2 ;;
        --format)    FORMAT="$2"; shift 2 ;;
        -h|--help)
            sed -n '3,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) fail "Unknown: $1"; exit 1 ;;
    esac
done

if ! [[ "$ROUNDS" =~ ^[1-9][0-9]*$ ]]; then
    fail "--rounds 必须为正整数，当前: $ROUNDS"; exit 1
fi

# ─── OS 检测（macOS / Ubuntu）─────────────────────────────────────────────────
detect_os() {
    if [[ "$(uname)" == "Darwin" ]]; then echo "macos"
    elif [[ -f /etc/lsb-release ]] && grep -q Ubuntu /etc/lsb-release; then echo "ubuntu"
    elif [[ -f /etc/os-release ]]; then
        . /etc/os-release; echo "${ID:-linux}"
    else echo "unknown"; fi
}
OS="$(detect_os)"

# ═════════════════════════════════════════════════════════════════════════════
# --setup-env: 环境初始化
# ═════════════════════════════════════════════════════════════════════════════
setup_env() {
    header "ChatOps 测试环境准备 ($OS)"

    # ─── 1. 工具可用性检查 ────────────────────────────────────────────────────
    info "[1/6] 检查工具..."
    local tools_ok=true
    check() {
        local name="$1" required="${2:-true}"
        if command -v "$name" &>/dev/null; then
            local ver=""
            case "$name" in
                node) ver=" $(node -v)";;
                pnpm) ver=" $(pnpm -v 2>/dev/null)";;
                docker) ver=" $(docker -v 2>/dev/null | awk '{print $3}' | tr -d ',')";;
                psql) ver=" $(psql --version 2>/dev/null | awk '{print $3}')";;
            esac
            echo -e "  ${GREEN}✓${NC} $name${ver}"
        elif [ "$required" = "true" ]; then
            echo -e "  ${RED}✗${NC} $name (必需)"; tools_ok=false
        else
            echo -e "  ${YELLOW}~${NC} $name (可选)"
        fi
    }
    check node
    check pnpm
    check docker
    check psql false   # 集成测试用 testcontainer 自动起,本地 psql 仅用于 seed
    check git
    check jq false

    if [ "$tools_ok" = false ]; then
        echo ""
        warn "工具缺失，尝试自动安装（需 sudo）..."
        case "$OS" in
            macos)
                if ! command -v brew &>/dev/null; then
                    fail "需要先装 Homebrew: https://brew.sh"; exit 1
                fi
                brew install node pnpm postgresql jq || true
                if ! command -v docker &>/dev/null; then
                    warn "macOS Docker 请手动从 https://orbstack.dev 或 https://docker.com 安装"
                fi
                ;;
            ubuntu|debian)
                if [ "$(id -u)" -ne 0 ] && ! sudo -n true 2>/dev/null; then
                    warn "本步需要 sudo，过程中可能弹出密码提示"
                fi
                sudo apt-get update -qq
                # Node.js 20 LTS（NodeSource）—— 仅当 node 缺失或非 v20/v22 时安装
                if ! command -v node &>/dev/null \
                   || [[ "$(node -v 2>/dev/null)" != v20* && "$(node -v 2>/dev/null)" != v22* ]]; then
                    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
                    sudo apt-get install -y --no-install-recommends nodejs
                fi
                sudo apt-get install -y --no-install-recommends \
                    postgresql-client jq git ca-certificates curl gnupg
                if ! command -v pnpm &>/dev/null; then
                    sudo corepack enable 2>/dev/null || sudo npm install -g pnpm
                fi
                # docker-ce + docker-ce-cli
                if ! command -v docker &>/dev/null; then
                    sudo install -m 0755 -d /etc/apt/keyrings
                    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
                        sudo gpg --dearmor --yes -o /etc/apt/keyrings/docker.gpg
                    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
                        | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
                    sudo apt-get update -qq
                    sudo apt-get install -y --no-install-recommends \
                        docker-ce docker-ce-cli containerd.io
                    sudo systemctl enable --now docker
                fi
                # 当前用户加入 docker 组
                if ! id -nG "$USER" | grep -qw docker; then
                    sudo usermod -aG docker "$USER"
                    warn "已把 $USER 加入 docker 组，需重新登录或 'newgrp docker' 后才能免 sudo 跑 docker"
                fi
                ;;
            *)
                fail "暂不支持自动安装：$OS。请按发行版自行装 node / pnpm / docker / postgresql-client / jq"
                exit 1
                ;;
        esac
        info "重新检查工具可用性..."
        tools_ok=true
        check node
        check pnpm
        check docker
        check git
        if [ "$tools_ok" = false ]; then
            fail "自动安装后仍有工具缺失，请手动处理（可能需要重新登录让 docker 组生效）"; exit 1
        fi
    fi

    # ─── 2. Docker daemon 检查 ────────────────────────────────────────────────
    info "[2/6] 检查 Docker daemon..."
    if ! docker info &>/dev/null; then
        case "$OS" in
            macos)  warn "Docker Desktop / OrbStack 未跑，请先启动" ;;
            *)      warn "docker daemon 未跑：sudo systemctl start docker" ;;
        esac
        fail "testcontainer 需要 Docker，当前 daemon 不可达"; exit 1
    fi
    info "  Docker daemon OK"

    # ─── 3. 预拉测试用镜像 ────────────────────────────────────────────────────
    info "[3/6] 预拉 alpine:3.19（DooD 集成测基线镜像）..."
    if docker image inspect alpine:3.19 &>/dev/null; then
        info "  alpine:3.19 已在本地"
    else
        if docker pull alpine:3.19 2>&1 | tail -3; then
            info "  alpine:3.19 拉取完成"
        else
            warn "  alpine:3.19 拉取失败，集成测首跑会自动重试（或手动 docker pull alpine:3.19）"
        fi
    fi

    # ─── 4. pnpm install（后端 + 前端）──────────────────────────────────────
    info "[4/6] 后端 pnpm install..."
    (cd "$PROJ_ROOT" && pnpm install --frozen-lockfile 2>&1 | tail -5) \
        || { fail "后端 pnpm install 失败"; exit 1; }

    if [ -d "$PROJ_ROOT/web" ]; then
        info "  前端 pnpm install..."
        (cd "$PROJ_ROOT/web" && pnpm install --frozen-lockfile 2>&1 | tail -5) \
            || { fail "前端 pnpm install 失败"; exit 1; }
    fi

    # ─── 5. PostgreSQL 测试库 bootstrap ───────────────────────────────────────
    info "[5/6] PostgreSQL 测试库准备..."
    if docker ps --format '{{.Names}}' | grep -q '^chatops-postgres-1$'; then
        info "  chatops-postgres-1 容器已跑（开发用）"
        # 顺手 bootstrap chatops_test 数据库（resetTestDb 的 marker 会在首跑自动建）
        if docker exec chatops-postgres-1 psql -U chatops -lqt 2>/dev/null | cut -d\| -f1 | grep -qw chatops_test; then
            info "  chatops_test DB 已存在"
        else
            docker exec chatops-postgres-1 psql -U chatops -d postgres \
                -c "CREATE DATABASE chatops_test OWNER chatops;" 2>&1 | grep -v 'NOTICE' || true
            info "  chatops_test DB 已建（resetTestDb 首次跑会 bootstrap marker）"
        fi
    else
        info "  开发用 postgres 容器未跑，集成测试将走 testcontainer 自动起（每文件 ~5s）"
    fi

    # ─── 6. 完成 ──────────────────────────────────────────────────────────────
    info "[6/6] 完成"
    echo ""
    info "下一步："
    echo "  ./test.sh                   # 跑全套测试"
    echo "  ./test.sh --filter approval # 只跑 approval 相关"
    echo "  ./test.sh --typecheck       # 只跑 tsc"
}

# ═════════════════════════════════════════════════════════════════════════════
# --list: 列出测试文件
# ═════════════════════════════════════════════════════════════════════════════
list_tests() {
    header "测试文件清单"
    local cnt_unit cnt_int cnt_mock
    cnt_unit=$(find "$PROJ_ROOT/src/__tests__/unit" -name '*.test.ts' 2>/dev/null | wc -l | tr -d ' ')
    cnt_int=$(find "$PROJ_ROOT/src/__tests__/integration" -name '*.test.ts' 2>/dev/null | wc -l | tr -d ' ')
    cnt_mock=$(find "$PROJ_ROOT/src/__tests__/mock-e2e" -name '*.test.ts' 2>/dev/null | wc -l | tr -d ' ')

    echo "Unit (${cnt_unit}):"
    find "$PROJ_ROOT/src/__tests__/unit" -name '*.test.ts' 2>/dev/null | sed "s|$PROJ_ROOT/||" | sort
    echo ""
    echo "Integration (${cnt_int}):"
    find "$PROJ_ROOT/src/__tests__/integration" -name '*.test.ts' 2>/dev/null | sed "s|$PROJ_ROOT/||" | sort
    echo ""
    echo "Mock-e2e (${cnt_mock}):"
    find "$PROJ_ROOT/src/__tests__/mock-e2e" -name '*.test.ts' 2>/dev/null | sed "s|$PROJ_ROOT/||" | sort
    echo ""
    info "总计: $((cnt_unit + cnt_int + cnt_mock)) 个测试文件"
}

# ═════════════════════════════════════════════════════════════════════════════
# --typecheck: 仅类型检查
# ═════════════════════════════════════════════════════════════════════════════
run_typecheck() {
    header "TypeScript 类型检查"
    local log="$LOG_DIR/typecheck-$(date +%Y%m%d_%H%M%S).log"

    info "后端 tsc --noEmit..."
    (cd "$PROJ_ROOT" && pnpm typecheck 2>&1) | tee "$log"
    local be_rc=${PIPESTATUS[0]}

    if [ -d "$PROJ_ROOT/web" ]; then
        info "前端 tsc --noEmit..."
        (cd "$PROJ_ROOT/web" && pnpm exec tsc --noEmit 2>&1) | tee -a "$log"
        local fe_rc=${PIPESTATUS[0]}
    else
        local fe_rc=0
    fi

    info "日志: $log"
    [ "$be_rc" -ne 0 ] && { fail "后端 tsc 失败"; return 1; }
    [ "$fe_rc" -ne 0 ] && { fail "前端 tsc 失败"; return 1; }
    info "类型检查通过 ✓"
}

# ═════════════════════════════════════════════════════════════════════════════
# 单轮 vitest 跑测 + 落盘
# ═════════════════════════════════════════════════════════════════════════════
run_one_round() {
    local round_num="$1"
    local round_suffix=""
    [ "$round_num" -gt 0 ] && round_suffix="_round${round_num}"
    local log="$LOG_DIR/test$(date +%Y%m%d_%H%M%S)${round_suffix}.log"

    [ "$round_num" -gt 0 ] && header "第 ${round_num}/${ROUNDS} 轮"

    local cmd=(npx vitest run --reporter=default)
    [ -n "$FILTER" ] && cmd+=("$FILTER")

    info "运行: ${cmd[*]}"
    info "日志: $log"

    local start_ts=$(date +%s)
    # 关键：tee 落盘 + 屏幕看尾，跑完后所有过滤都从文件抽
    (cd "$PROJ_ROOT" && "${cmd[@]}" 2>&1) | tee "$log" | tail -40
    local rc=${PIPESTATUS[0]}
    local end_ts=$(date +%s)
    local elapsed=$((end_ts - start_ts))

    # 解析结果（vitest 输出格式：Test Files  N failed | M passed (...)；Tests N failed | M passed）
    # vitest 在 tee 管道里仍输出 ANSI 颜色码，行首是 \x1b[2m 不是空白，
    # 必须先剥色再 grep，否则 ^[[:space:]]* 匹配不到、计数全退化成 0
    local stripped files_line tests_line
    stripped=$(sed -E $'s/\x1b\\[[0-9;]*m//g' "$log")
    files_line=$(echo "$stripped" | grep -E '^[[:space:]]*Test Files' | tail -1 || true)
    tests_line=$(echo "$stripped" | grep -E '^[[:space:]]*Tests '   | tail -1 || true)

    local passed=0 failed=0 skipped=0
    if [ -n "$tests_line" ]; then
        passed=$(echo "$tests_line" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+' || echo 0)
        failed=$(echo "$tests_line" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || echo 0)
        skipped=$(echo "$tests_line" | grep -oE '[0-9]+ skipped' | head -1 | grep -oE '[0-9]+' || echo 0)
    fi

    # 落盘"失败 only"摘要供后续抓取
    local fail_summary="${log%.log}-fails.log"
    if [ "$failed" -gt 0 ]; then
        awk '/❯|FAIL|⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯/' "$log" > "$fail_summary"
    fi

    # 写入轮次记录
    ROUND_PASSED+=("$passed")
    ROUND_FAILED+=("$failed")
    ROUND_SKIPPED+=("$skipped")
    ROUND_DURATION+=("$elapsed")
    ROUND_LOG+=("$log")
    ROUND_RC+=("$rc")

    # 打印简报（不要再跑测试看清单！要看从 $log 或 $fail_summary 抽）
    info "本轮: 通过=$passed 失败=$failed 跳过=$skipped 耗时=${elapsed}s rc=$rc"
    [ "$failed" -gt 0 ] && info "失败摘要: $fail_summary（grep 'FAIL' '$log' 看完整）"
    return "$rc"
}

# ═════════════════════════════════════════════════════════════════════════════
# 报告生成
# ═════════════════════════════════════════════════════════════════════════════
generate_report() {
    local report="$LOG_DIR/report_$(date +%Y%m%d_%H%M%S).md"
    local git_ver
    git_ver=$(cd "$PROJ_ROOT" && git describe --tags --always 2>/dev/null || echo "unknown")
    local branch
    branch=$(cd "$PROJ_ROOT" && git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "?")

    local total_passed=0 total_failed=0 total_skipped=0 total_duration=0
    for i in "${!ROUND_PASSED[@]}"; do
        total_passed=$((total_passed + ROUND_PASSED[i]))
        total_failed=$((total_failed + ROUND_FAILED[i]))
        total_skipped=$((total_skipped + ROUND_SKIPPED[i]))
        total_duration=$((total_duration + ROUND_DURATION[i]))
    done
    local total=$((total_passed + total_failed + total_skipped))
    local pass_rate=0
    [ "$total" -gt 0 ] && pass_rate=$(echo "scale=1; $total_passed * 100 / $total" | bc 2>/dev/null || echo 0)

    cat > "$report" <<EOF
# ChatOps 测试报告

**日期**: $(date '+%Y-%m-%d %H:%M:%S')
**分支**: ${branch} @ ${git_ver}
**轮数**: ${ROUNDS}
**过滤**: ${FILTER:-（全套）}

## 总览

| 指标 | 数值 |
|------|------|
| 通过 | ${total_passed} |
| 失败 | ${total_failed} |
| 跳过 | ${total_skipped} |
| 总计 | ${total} |
| 通过率 | ${pass_rate}% |
| 总耗时 | ${total_duration}s |

EOF

    if [ "$ROUNDS" -gt 1 ]; then
        echo "## 各轮次" >> "$report"
        echo "" >> "$report"
        echo "| 轮次 | 通过 | 失败 | 跳过 | 耗时 | rc | 日志 |" >> "$report"
        echo "|------|------|------|------|------|----|----|" >> "$report"
        for i in "${!ROUND_PASSED[@]}"; do
            local rn=$((i + 1))
            local icon="✅"; [ "${ROUND_FAILED[$i]}" -gt 0 ] && icon="❌"
            echo "| ${icon} 第${rn}轮 | ${ROUND_PASSED[$i]} | ${ROUND_FAILED[$i]} | ${ROUND_SKIPPED[$i]} | ${ROUND_DURATION[$i]}s | ${ROUND_RC[$i]} | \`$(basename "${ROUND_LOG[$i]}")\` |" >> "$report"
        done
        echo "" >> "$report"
    fi

    if [ "$total_failed" -gt 0 ]; then
        echo "## 失败摘要" >> "$report"
        echo "" >> "$report"
        echo "完整失败堆栈见各轮次 log 同名 \`-fails.log\`，或：" >> "$report"
        echo "" >> "$report"
        echo '```bash' >> "$report"
        echo "grep -E 'FAIL|❯' ${ROUND_LOG[-1]}" >> "$report"
        echo '```' >> "$report"
        echo "" >> "$report"
    fi

    cat >> "$report" <<EOF
## 日志文件

$(for log in "${ROUND_LOG[@]}"; do echo "- \`$log\`"; done)

---
*Generated by ./test.sh*
EOF
    echo "$report"
}

# ═════════════════════════════════════════════════════════════════════════════
# --keep / 清理
# ═════════════════════════════════════════════════════════════════════════════
cleanup() {
    if [ "$KEEP" = true ]; then
        info "保留容器 / 临时文件 (--keep)"
        return
    fi
    # vitest 用 testcontainer，会自己清。这里只是兜底
    docker ps --filter 'label=org.testcontainers=true' --format '{{.ID}}' 2>/dev/null \
        | xargs -r docker rm -f >/dev/null 2>&1 || true
}
trap cleanup EXIT

# ═════════════════════════════════════════════════════════════════════════════
# 主流程
# ═════════════════════════════════════════════════════════════════════════════
main() {
    case "$ACTION" in
        setup-env) setup_env; exit 0 ;;
        list)      list_tests; exit 0 ;;
        typecheck) run_typecheck; exit $? ;;
    esac

    # === e2e 新增 action ===
    if [[ "$ACTION" == "discover" ]]; then
      SCENARIOS=()
      while IFS= read -r line; do
        id=$(echo "$line" | sed "s/.*test[[:space:]]*('[[:space:]]*//" | sed "s/'[[:space:]]*,.*//" | tr -d ' ')
        [[ -n "$id" ]] && SCENARIOS+=("{\"id\":\"$id\",\"name\":\"$id\",\"tags\":[]}")
      done < <(grep -rh "^test(" tests/e2e/ 2>/dev/null || true)
      if [[ ${#SCENARIOS[@]} -eq 0 ]]; then
        echo '{"scenarios":[]}'
      else
        JSON_SCENARIOS=$(IFS=,; echo "[${SCENARIOS[*]}]")
        echo "{\"scenarios\":${JSON_SCENARIOS}}"
      fi
      exit 0
    fi

    if [[ "$ACTION" == "static-check" ]]; then
      echo "==> Running static check (tsc --noEmit)..."
      (cd web && npx tsc --noEmit)
      npx tsc --noEmit
      echo "==> Static check passed."
      exit 0
    fi

    if [[ "$ACTION" == "scenario" ]]; then
      if [[ -z "$SCENARIO_ID" ]]; then
        echo "--scenario requires a scenario ID" >&2; exit 1
      fi
      if [[ ! "$SCENARIO_ID" =~ ^[a-zA-Z0-9_-]+$ ]]; then
        echo "--scenario: SCENARIO_ID must match [a-zA-Z0-9_-]+" >&2; exit 1
      fi
      EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/e2e-evidence}"
      mkdir -p "${EVIDENCE_DIR}/${SCENARIO_ID}/artifacts"
      echo "==> Running scenario: $SCENARIO_ID (evidence → ${EVIDENCE_DIR}/${SCENARIO_ID})"
      START_MS=$(($(date +%s%N) / 1000000))

      set +e
      # DooD 容器中 /app/node_modules/.bin/playwright 已就绪，避免 npx 去下载
      PW_BIN="/app/node_modules/.bin/playwright"
      [ -f "$PW_BIN" ] || PW_BIN="npx playwright"
      E2E_BASE_URL="${SANDBOX_URL:-${E2E_BASE_URL:-http://localhost:3000}}" $PW_BIN test \
        --config playwright.e2e.config.ts \
        --grep "$SCENARIO_ID" \
        --reporter=json 2>&1 | tee "${EVIDENCE_DIR}/${SCENARIO_ID}/playwright-output.txt"
      PW_EXIT=$?
      set -e

      END_MS=$(($(date +%s%N) / 1000000))
      DURATION=$((END_MS - START_MS))
      RESULT="pass"
      [[ $PW_EXIT -ne 0 ]] && RESULT="fail"

      cat > "${EVIDENCE_DIR}/${SCENARIO_ID}/manifest.json" <<EOF
{
  "summary": "Playwright scenario: ${SCENARIO_ID}, result: ${RESULT}",
  "contextHint": "Playwright E2E，查看 playwright-output.txt 和截图",
  "artifacts": [
    {"kind":"log","mimeType":"text/plain","path":"artifacts/playwright-output.txt","description":"Playwright 输出"}
  ]
}
EOF
      cp "${EVIDENCE_DIR}/${SCENARIO_ID}/playwright-output.txt" "${EVIDENCE_DIR}/${SCENARIO_ID}/artifacts/" 2>/dev/null || true

      echo "{\"result\":\"${RESULT}\",\"summary\":\"scenario ${SCENARIO_ID}: ${RESULT}\",\"duration_ms\":${DURATION}}"
      exit $PW_EXIT
    fi

    header "ChatOps 测试 (vitest)"
    [ -n "$FILTER" ] && info "过滤: $FILTER"
    [ "$ROUNDS" -gt 1 ] && info "疲劳测试: $ROUNDS 轮"

    # 前置：确保 pnpm 装过
    if [ ! -d "$PROJ_ROOT/node_modules" ]; then
        warn "node_modules 缺失，先跑 ./test.sh --setup-env"; exit 1
    fi

    declare -a ROUND_PASSED=() ROUND_FAILED=() ROUND_SKIPPED=() ROUND_DURATION=() ROUND_LOG=() ROUND_RC=()
    local any_failed=false

    for round in $(seq 1 "$ROUNDS"); do
        local label=0; [ "$ROUNDS" -gt 1 ] && label="$round"
        run_one_round "$label" || any_failed=true
        [ "$round" -lt "$ROUNDS" ] && sleep 1
    done

    header "测试完成"
    local report
    report=$(generate_report)
    info "报告: $report"

    [ "$any_failed" = true ] && exit 1
    exit 0
}

main
