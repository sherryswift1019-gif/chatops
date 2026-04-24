#!/usr/bin/env bash
#
# scripts/e2e-prd-submit.sh — PRD MR 主动提交 pipeline 的端到端冒烟
#
# 用法:
#   ./scripts/e2e-prd-submit.sh              # 跑全部 case
#   ./scripts/e2e-prd-submit.sh C D E        # 只跑指定 case（大小写无关）
#   ./scripts/e2e-prd-submit.sh all-fast     # 跑 C/D/E/I（无 GitLab 调用）
#   ./scripts/e2e-prd-submit.sh all-gitlab   # 跑 F/A/B/G（需要真 GitLab）
#
# Case 索引:
#   C · 路径错兜底（regex trip）
#   D · 跨 repo 兜底
#   E · email 缺失兜底
#   I · admin prompt migrate 持久化（B1 验证）
#   F · source 分支不存在 → GitLab 错误抽取（N2 验证）
#   A · 正向 pass + un-draft
#   B · 正向 blocked 保持 Draft（B3 排序验证）
#   G · 重复提交 force-draft 重置（核心闸门不变量）
#
# 前置条件（见 docs/prds/prd-active-submit-smoke.md §0）:
#   - 本地 server 跑起来（PORT 默认 3100），E2E_MODE=1 + CLAUDE_MOCK=1
#   - DB: dingtalk_users.u-trigger 有 email
#   - GitLab: $REPO 有 $SRC 和 $TGT 分支，$SRC 上有 $MR_FILE

set -uo pipefail

# ─── 默认 env（可被 shell 覆盖）─────────────────────────────
PORT="${PORT:-3100}"
REPO="${REPO:-PAM/devops/chatops}"
SRC="${SRC:-feat/prd-smoke}"
TGT="${TGT:-feat/docreview}"
MR_FILE="${MR_FILE:-docs/prds/test.md}"
GITLAB_HOST="${GITLAB_HOST:-http://code.paraview.cn}"

BASE="http://localhost:${PORT}"
WORK_URL="${GITLAB_HOST}/${REPO}/-/tree/${SRC}"
MR_URL="${GITLAB_HOST}/${REPO}/-/tree/${TGT}"
TEST_USER_ID="u-trigger"     # /admin/_e2e/trigger-capability 硬编码的 initiatorId
TEST_EMAIL="smoke-pm@example.com"

# ─── 颜色/日志 ─────────────────────────────────────────────
RED='\033[0;31m'; GRN='\033[0;32m'; YLW='\033[1;33m'; DIM='\033[2m'; NC='\033[0m'
info()  { printf "${DIM}[info]${NC} %s\n" "$*"; }
pass()  { printf "${GRN}  ✓ PASS${NC}  %s\n" "$*"; }
fail()  { printf "${RED}  ✗ FAIL${NC}  %s\n" "$*"; FAIL_COUNT=$((FAIL_COUNT+1)); }
hdr()   { printf "\n${YLW}── Case %s · %s ──${NC}\n" "$1" "$2"; }

PASS_COUNT=0
FAIL_COUNT=0

# ─── 假设断言 helper ───────────────────────────────────────
assert_contains() {
  # $1 = 实际字符串；$2 = 期望子串；$3 = 描述
  if [[ "$1" == *"$2"* ]]; then pass "$3"; PASS_COUNT=$((PASS_COUNT+1))
  else fail "$3 — 期望含 \"$2\"，实际: \"$1\""; fi
}
assert_eq() {
  if [[ "$1" == "$2" ]]; then pass "$3"; PASS_COUNT=$((PASS_COUNT+1))
  else fail "$3 — 期望 \"$2\"，实际 \"$1\""; fi
}
assert_num() {
  # $1 actual $2 expected $3 desc
  if [[ "$1" == "$2" ]]; then pass "$3"; PASS_COUNT=$((PASS_COUNT+1))
  else fail "$3 — 期望 $2，实际 $1"; fi
}

# ─── HTTP/SQL 工具 ─────────────────────────────────────────
psql_q() { psql -h localhost -d chatops -Atq -c "$1"; }

reset_e2e() { curl -s -XPOST "${BASE}/admin/_e2e/reset" >/dev/null; }

trigger() {
  local msg="$1"
  curl -s -XPOST "${BASE}/admin/_e2e/trigger-capability" \
    -H 'content-type: application/json' \
    -d "$(jq -n --arg m "$msg" '{capabilityKey:"prd_submit", extraParams:{message:$m}}')"
}

mock_claude_review() {
  local decision="${1:-pass}"
  local findings_json="${2:-[]}"
  local markdown="${3:-mock response}"
  curl -s -XPOST "${BASE}/admin/_e2e/claude" \
    -H 'content-type: application/json' \
    -d "$(jq -n --arg d "$decision" --argjson f "$findings_json" --arg m "$markdown" \
      '{key:"prd-review", response:{decision:$d, findings:$f, markdown:$m}}')" >/dev/null
}

# 等 pipeline 跑完（最多 30s；看 prd_submit_events 的 prd_notify 条数达标即认为完成）
wait_pipeline() {
  local submission_id="$1"
  local timeout=${2:-30}
  local i=0
  while (( i < timeout )); do
    local notify_count
    notify_count=$(psql_q "SELECT COUNT(*) FROM prd_submit_events WHERE submission_id='${submission_id}' AND code='prd_notify';")
    if [[ "$notify_count" -ge 1 ]]; then return 0; fi
    sleep 1
    i=$((i+1))
  done
  return 1
}

latest_submission_id() {
  psql_q "SELECT submission_id FROM prd_submit_events ORDER BY id DESC LIMIT 1;"
}

# GitLab direct API（用于独立验证 MR 真实状态）
gitlab_token() {
  psql_q "SELECT value->>'token' FROM system_config WHERE key='gitlab';"
}
gitlab_get_mr() {
  local iid="$1"
  local token; token=$(gitlab_token)
  curl -s -H "PRIVATE-TOKEN: ${token}" \
    "${GITLAB_HOST}/api/v4/projects/$(jq -nr --arg p "$REPO" '$p | @uri')/merge_requests/${iid}"
}

# 整理 test DB：确保 u-trigger + email 存在
ensure_test_user() {
  psql -h localhost -d chatops -qc "
    INSERT INTO dingtalk_users (user_id, name, email)
    VALUES ('${TEST_USER_ID}', '测试 PM', '${TEST_EMAIL}')
    ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email
  " >/dev/null
}

# ─── Webhook 干扰检测 + 临时关停 ──────────────────────────
# 问题：如果用户在同一台/同一网络的**另一份 chatops** 实例部署了 passive
# doc-review-handler（未合入 main 的在途 feature），GitLab webhook 会把
# MR 更新事件转发给它；它会对 MR 再跑一遍 review，review 失败就**重加
# Draft: 前缀**——导致我们的 un-draft 路径看起来成功但 MR 状态被立即回退。
#
# 本脚本启动时检测是否有 MR 监听的 webhook，若有就暂时关 merge_requests_events；
# 退出时（trap EXIT）自动恢复，保证不误删生产配置。
DISABLED_HOOK_ID=""

gitlab_get() {
  curl -s -H "PRIVATE-TOKEN: $(gitlab_token)" "$1"
}
gitlab_put_json() {
  curl -s -XPUT -H "PRIVATE-TOKEN: $(gitlab_token)" \
    -H "Content-Type: application/json" "$1" -d "$2"
}

disable_mr_webhook_if_any() {
  local hooks
  hooks=$(gitlab_get "${GITLAB_HOST}/api/v4/projects/$(jq -nr --arg p "$REPO" '$p | @uri')/hooks")
  local hook_id
  hook_id=$(echo "$hooks" | jq -r '.[] | select(.merge_requests_events == true) | .id' | head -1)
  if [[ -z "$hook_id" || "$hook_id" == "null" ]]; then
    info "无监听 MR 事件的 webhook，跳过"
    return
  fi
  local hook_url
  hook_url=$(echo "$hooks" | jq -r --arg id "$hook_id" '.[] | select((.id|tostring) == $id) | .url')
  info "检测到监听 MR 的 webhook id=$hook_id url=$hook_url — 临时关 merge_requests_events"
  gitlab_put_json \
    "${GITLAB_HOST}/api/v4/projects/$(jq -nr --arg p "$REPO" '$p | @uri')/hooks/${hook_id}" \
    "$(jq -n --arg u "$hook_url" '{url:$u, merge_requests_events:false}')" >/dev/null
  DISABLED_HOOK_ID="$hook_id"
  DISABLED_HOOK_URL="$hook_url"
}

restore_mr_webhook() {
  if [[ -z "$DISABLED_HOOK_ID" ]]; then return; fi
  info "恢复 webhook id=$DISABLED_HOOK_ID (merge_requests_events=true)"
  gitlab_put_json \
    "${GITLAB_HOST}/api/v4/projects/$(jq -nr --arg p "$REPO" '$p | @uri')/hooks/${DISABLED_HOOK_ID}" \
    "$(jq -n --arg u "$DISABLED_HOOK_URL" '{url:$u, merge_requests_events:true}')" >/dev/null
}

trap restore_mr_webhook EXIT

# ─── Case C · 路径错兜底 ───────────────────────────────────
run_C() {
  hdr C "路径错兜底（regex trip）"
  reset_e2e
  local pre_count
  pre_count=$(psql_q "SELECT COUNT(*) FROM prd_submit_events;")

  local resp
  resp=$(trigger "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=docs/other/wrong.md")
  local output; output=$(echo "$resp" | jq -r '.result.output')
  assert_contains "$output" "MR 文件必须在 docs/prds/" '群回 "路径不合法" 提示'

  local post_count
  post_count=$(psql_q "SELECT COUNT(*) FROM prd_submit_events;")
  assert_eq "$post_count" "$pre_count" "事件表未被污染（拒前拒后同行数）"
}

# ─── Case D · 跨 repo ──────────────────────────────────────
run_D() {
  hdr D "跨 repo 兜底"
  reset_e2e
  local resp
  resp=$(trigger "@agent 提交PRD MR 工作地址=${GITLAB_HOST}/PAM/a/-/tree/x MR地址=${GITLAB_HOST}/PAM/b/-/tree/y MR文件=${MR_FILE}")
  local output; output=$(echo "$resp" | jq -r '.result.output')
  assert_contains "$output" "必须是同一个仓库" '群回 "跨 repo" 提示'
}

# ─── Case E · email 缺失 ───────────────────────────────────
run_E() {
  hdr E "email 缺失兜底"
  reset_e2e
  # 临时清 email
  psql -h localhost -d chatops -qc "UPDATE dingtalk_users SET email=NULL WHERE user_id='${TEST_USER_ID}';" >/dev/null

  local resp
  resp=$(trigger "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}")
  local output; output=$(echo "$resp" | jq -r '.result.output')
  assert_contains "$output" "未识别到你的企业邮箱" '群回 "邮箱未同步" 提示'

  # 恢复
  ensure_test_user
}

# ─── Case I · admin prompt migrate 持久化（B1）─────────────
run_I() {
  hdr I "admin 编辑 prompt migrate 持久化（B1）"
  local marker="[SMOKE_ADMIN_EDIT_$(date +%s)] 这是管理员自定义 prompt"
  psql -h localhost -d chatops -qc "
    UPDATE capabilities SET system_prompt = \$MARKER\$${marker}\$MARKER\$
    WHERE key='prd_ai_review_mr'
  " >/dev/null

  info "跑 pnpm migrate..."
  DATABASE_URL="postgres://zhangshanshan@localhost:5432/chatops" pnpm migrate > /tmp/e2e-migrate.log 2>&1

  local after
  after=$(psql_q "SELECT left(system_prompt, 60) FROM capabilities WHERE key='prd_ai_review_mr';")
  local is_default
  is_default=$(psql_q "SELECT (system_prompt = default_system_prompt)::text FROM capabilities WHERE key='prd_ai_review_mr';")

  assert_contains "$after" "SMOKE_ADMIN_EDIT_" "admin 编辑的 prompt 在 migrate 后保留"
  assert_eq "$is_default" "false" "system_prompt 与 default_system_prompt 不同（admin 自定义生效）"

  # 恢复默认，方便后续 case
  psql -h localhost -d chatops -qc "
    UPDATE capabilities SET system_prompt = default_system_prompt
    WHERE key='prd_ai_review_mr'
  " >/dev/null
}

# ─── Case F · 不存在的 projectPath → GitLab 404（N2）──────
# 注意：GitLab 对分支不存在异常宽容（创建空 diff 的 MR，甚至 has_conflicts=true
# 的 MR 也能建）；要强制 4xx 得用**不存在的 project**，findOpenMr 第一步就 404。
run_F() {
  hdr F "不存在的 projectPath → GitLab 404 + extractErrorMessage（N2）"
  reset_e2e

  local fake_url="${GITLAB_HOST}/no-such-group/no-such-repo"
  local resp
  resp=$(trigger "@agent 提交PRD MR 工作地址=${fake_url}/-/tree/${SRC} MR地址=${fake_url}/-/tree/${TGT} MR文件=${MR_FILE}")
  local sub_id; sub_id=$(latest_submission_id)

  if ! wait_pipeline "$sub_id" 30; then
    fail "pipeline 未在 30s 内跑完"
    return
  fi

  local create_mr_status
  create_mr_status=$(psql_q "SELECT status FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_create_mr';")
  assert_eq "$create_mr_status" "failed" "prd_create_mr stage failed"

  local err
  err=$(psql_q "SELECT data->>'error' FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_create_mr';")
  if [[ "$err" == *"HTTP "* ]]; then
    pass "错误被 extractErrorMessage 抽到 HTTP 状态码: $err"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    fail "错误缺 HTTP 前缀（N2 抽取失效）: $err"
  fi

  local notify_status
  notify_status=$(psql_q "SELECT status FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_notify';")
  assert_eq "$notify_status" "success" "stage 3 notify 仍然跑（onFailure:continue 兜底）"

  local dm_text
  dm_text=$(curl -s "${BASE}/admin/_e2e/messages?kind=direct" | jq -r '.[0].text // "null"')
  assert_contains "$dm_text" "PRD MR 提交失败" "DM 发出失败通知"
  assert_contains "$dm_text" "HTTP " "DM 里含 GitLab 原始错误（HTTP 状态码前缀）"
}

# ─── Case A · 正向 pass + un-draft ─────────────────────────
run_A() {
  hdr A "正向 pass + un-draft"
  reset_e2e
  ensure_test_user
  mock_claude_review "pass" "[]" "✅ PRD 结构完整、指标可度量，建议合并。"

  local resp
  resp=$(trigger "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}")
  info "handler 立即输出: $(echo "$resp" | jq -r '.result.output')"
  local sub_id; sub_id=$(latest_submission_id)
  info "submissionId: $sub_id"

  if ! wait_pipeline "$sub_id" 60; then
    fail "pipeline 未在 60s 内跑完"
    return
  fi

  # 4 行事件都 success
  local success_count
  success_count=$(psql_q "SELECT COUNT(*) FROM prd_submit_events WHERE submission_id='${sub_id}' AND status='success';")
  assert_num "$success_count" "4" "prd_submit_events 4 行都 success"

  # 读 mrIid + baseTitle
  local mr_iid; mr_iid=$(psql_q "SELECT data->>'mrIid' FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_create_mr';")
  local base_title; base_title=$(psql_q "SELECT data->>'baseTitle' FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_create_mr';")
  info "MR iid=$mr_iid title=$base_title"

  # title 是否取了最新 commit
  assert_contains "$base_title" "docs(prd): smoke 测试样例" "MR title 派生自最新 commit（验证 reverse 修复）"

  # review decision = pass
  local decision; decision=$(psql_q "SELECT data->>'decision' FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_ai_review_mr';")
  assert_eq "$decision" "pass" "review decision = pass"

  # draftCleared = true
  local cleared; cleared=$(psql_q "SELECT data->>'draftCleared' FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_ai_review_mr';")
  assert_eq "$cleared" "true" "un-draft 成功（Draft 已解除）"

  # GitLab 实际状态验证
  local mr_json; mr_json=$(gitlab_get_mr "$mr_iid")
  local mr_title; mr_title=$(echo "$mr_json" | jq -r '.title')
  local mr_work_in_progress; mr_work_in_progress=$(echo "$mr_json" | jq -r '.work_in_progress')
  local mr_labels; mr_labels=$(echo "$mr_json" | jq -r '.labels | join(",")')

  if [[ "$mr_title" == "Draft: "* ]]; then
    fail "GitLab MR title 仍带 Draft: 前缀 — $mr_title"
  else
    pass "GitLab MR title 无 Draft: 前缀 — $mr_title"
    PASS_COUNT=$((PASS_COUNT+1))
  fi
  assert_eq "$mr_work_in_progress" "false" "GitLab work_in_progress=false（merge 可点）"
  assert_contains "$mr_labels" "prd-active-review" "GitLab label 含 prd-active-review"

  # DM 到达
  local dm_text; dm_text=$(curl -s "${BASE}/admin/_e2e/messages?kind=direct" | jq -r '.[0].text // "null"')
  assert_contains "$dm_text" "✅" "DM 含 pass 标志"
  assert_contains "$dm_text" "已解除 Draft" 'DM 含 "已解除 Draft" 文案'
}

# ─── Case B · blocked 保持 Draft + findings 排序（B3）──────
run_B() {
  hdr B "blocked 保持 Draft + findings 排序（B3）"
  reset_e2e
  mock_claude_review "blocked" \
    '[{"severity":"info","title":"格式建议：用更清晰的缩进","detail":""},
      {"severity":"blocker","title":"成功指标缺度量方式","detail":"§1.3 只有口号"},
      {"severity":"warning","title":"非目标章节缺失","detail":""},
      {"severity":"blocker","title":"数据模型字段说明缺失","detail":""}]' \
    "⚠️ 有 blocker，保持 Draft"

  local resp
  resp=$(trigger "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}")
  local sub_id; sub_id=$(latest_submission_id)

  if ! wait_pipeline "$sub_id" 60; then
    fail "pipeline 未在 60s 内跑完"
    return
  fi

  local decision; decision=$(psql_q "SELECT data->>'decision' FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_ai_review_mr';")
  assert_eq "$decision" "blocked" "review decision = blocked"

  local cleared; cleared=$(psql_q "SELECT data->>'draftCleared' FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_ai_review_mr';")
  assert_eq "$cleared" "false" "Draft 未解除（保持 Draft）"

  local mr_iid; mr_iid=$(psql_q "SELECT data->>'mrIid' FROM prd_submit_events WHERE submission_id='${sub_id}' AND code='prd_create_mr';")
  local mr_title; mr_title=$(gitlab_get_mr "$mr_iid" | jq -r '.title')
  if [[ "$mr_title" == "Draft: "* ]]; then
    pass "GitLab MR 标题保持 Draft: 前缀 — $mr_title"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    fail "GitLab MR 标题已去 Draft 前缀（不该解除）— $mr_title"
  fi

  # B3 验证：DM 里 findings 摘要前 3 个中 blocker 优先
  local dm_text; dm_text=$(curl -s "${BASE}/admin/_e2e/messages?kind=direct" | jq -r '.[0].text // "null"')
  assert_contains "$dm_text" "MR 保持 Draft 状态" "DM 明确告知 MR 保持 Draft"
  # 检查 1. 2. 位置有 blocker 标签
  local line1; line1=$(echo "$dm_text" | grep "^1\." || true)
  local line2; line2=$(echo "$dm_text" | grep "^2\." || true)
  if [[ "$line1" == *"[blocker]"* ]] && [[ "$line2" == *"[blocker]"* ]]; then
    pass "findings 摘要按 severity 排序，两个 blocker 在最前（B3 验证）"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    fail "findings 排序不对 — line1=$line1 line2=$line2"
  fi
}

# ─── Case G · 重复提交 force-draft 重置（核心）─────────────
run_G() {
  hdr G "重复提交 force-draft 重置（核心闸门不变量）"
  reset_e2e

  # 第一轮：pass
  info "第一轮：review pass → un-draft"
  mock_claude_review "pass" "[]" "第一轮 pass"
  local resp1; resp1=$(trigger "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}")
  local sub1; sub1=$(latest_submission_id)
  wait_pipeline "$sub1" 60
  local mr_iid1; mr_iid1=$(psql_q "SELECT data->>'mrIid' FROM prd_submit_events WHERE submission_id='${sub1}' AND code='prd_create_mr';")
  local reused1; reused1=$(psql_q "SELECT data->>'reused' FROM prd_submit_events WHERE submission_id='${sub1}' AND code='prd_create_mr';")
  info "第一轮 MR !$mr_iid1, reused=$reused1"

  local title_after_1; title_after_1=$(gitlab_get_mr "$mr_iid1" | jq -r '.title')
  info "第一轮后 title: $title_after_1"
  if [[ "$title_after_1" == "Draft: "* ]]; then
    fail "第一轮 pass 后 MR 未解除 Draft"
    return
  fi

  # 第二轮：blocked，必须看到 wasForceDrafted=true + title 回到 Draft
  info "第二轮：review blocked → force-draft 重置"
  reset_e2e
  mock_claude_review "blocked" \
    '[{"severity":"blocker","title":"新增 blocker","detail":""}]' "第二轮被拒"
  local resp2; resp2=$(trigger "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}")
  local sub2; sub2=$(latest_submission_id)
  wait_pipeline "$sub2" 60

  local mr_iid2; mr_iid2=$(psql_q "SELECT data->>'mrIid' FROM prd_submit_events WHERE submission_id='${sub2}' AND code='prd_create_mr';")
  local reused2; reused2=$(psql_q "SELECT data->>'reused' FROM prd_submit_events WHERE submission_id='${sub2}' AND code='prd_create_mr';")
  local force_drafted2; force_drafted2=$(psql_q "SELECT data->>'wasForceDrafted' FROM prd_submit_events WHERE submission_id='${sub2}' AND code='prd_create_mr';")

  assert_eq "$mr_iid2" "$mr_iid1" "复用同一 MR iid"
  assert_eq "$reused2" "true" "prd_create_mr.data.reused=true"
  assert_eq "$force_drafted2" "true" "prd_create_mr.data.wasForceDrafted=true"

  local title_after_2; title_after_2=$(gitlab_get_mr "$mr_iid2" | jq -r '.title')
  if [[ "$title_after_2" == "Draft: "* ]]; then
    pass "MR 标题已重置回 Draft: 前缀 — $title_after_2"
    PASS_COUNT=$((PASS_COUNT+1))
  else
    fail "MR 标题未重置回 Draft（核心闸门失效！）— $title_after_2"
  fi

  local decision2; decision2=$(psql_q "SELECT data->>'decision' FROM prd_submit_events WHERE submission_id='${sub2}' AND code='prd_ai_review_mr';")
  assert_eq "$decision2" "blocked" "第二轮 review decision=blocked"
}

# ─── 主入口 ───────────────────────────────────────────────
usage() {
  grep "^# " "$0" | sed 's/^# //' | head -20
}

# 健康检查
check_env() {
  info "检查 server 健康 (${BASE})"
  local health
  health=$(curl -s "${BASE}/admin/_e2e/health" 2>/dev/null || echo "FAIL")
  if [[ "$health" != *'"e2eMode":true'* ]]; then
    echo "❌ server 未启动或 E2E_MODE 未开 (${BASE}/admin/_e2e/health 返回: $health)"
    echo "   启动方式: DATABASE_URL=postgres://... E2E_MODE=1 CLAUDE_MOCK=1 PORT=${PORT} pnpm dev"
    exit 1
  fi
  info "server OK: $health"
  ensure_test_user
}

main() {
  check_env
  disable_mr_webhook_if_any

  local cases=()
  if [[ $# -eq 0 ]] || [[ "$1" == "all" ]]; then
    cases=(C D E I F A B G)
  elif [[ "$1" == "all-fast" ]]; then
    cases=(C D E I)
  elif [[ "$1" == "all-gitlab" ]]; then
    cases=(F A B G)
  else
    for c in "$@"; do cases+=("$(echo "$c" | tr '[:lower:]' '[:upper:]')"); done
  fi

  info "即将跑的 case: ${cases[*]}"
  for c in "${cases[@]}"; do
    case "$c" in
      C|D|E|I|F|A|B|G) run_$c ;;
      *) echo "❌ 未知 case: $c"; usage; exit 1 ;;
    esac
  done

  printf "\n${YLW}──────────────────────────────${NC}\n"
  printf "通过 ${GRN}%d${NC}，失败 ${RED}%d${NC}\n" "$PASS_COUNT" "$FAIL_COUNT"
  if (( FAIL_COUNT > 0 )); then
    exit 1
  fi
  printf "${GRN}✅ 全部通过${NC}\n"
}

main "$@"
