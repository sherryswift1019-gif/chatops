# PRD 主动提交 MR · M4a 冒烟剧本

> **关联**: [prd-active-submit.md](prd-active-submit.md) · [prd-active-submit-dev-plan.md](prd-active-submit-dev-plan.md)
> **目的**: M4a 端到端验证 —— **GitLab 行为用真实仓库**（验证 Draft 闸门 / label / MR note），**Claude 和 IM 用 E2E mock**（不需要真钉钉 bot）
> **估算**: 0.3d（含环境准备）

---

## 0. 前置准备清单（30 分钟）

### 0.1 GitLab 测试仓库

准备一个你有 Maintainer 权限的 GitLab 仓库（下文用 `PAM/devops/chatops` 举例；你替换成自己的）：

- 仓库里有 **2 个分支**：例如 `prd-smoke`（source）和 `feat/docreview`（target）
- `prd-smoke` 分支里有 `docs/prds/test.md` 已提交，内容随便写（用于被 PRD review 审）
- `prd-smoke` 分支的**最新 commit 信息清楚**，例如：
  ```bash
  git commit -m "docs(prd): smoke 测试样例 v1"
  git push origin prd-smoke
  ```

**GitLab Token**: 需要 `api` scope 权限。在 GitLab 个人设置里新建 Personal Access Token。

### 0.2 本地环境变量

创建 `.env`（不提交）：

```bash
# DB（本地 pg，已含 chatops 数据库）
DATABASE_URL=postgres://zhangshanshan@localhost:5432/chatops

# GitLab —— 真实，用于验证 Draft / label / MR
GITLAB_URL=http://code.paraview.cn
GITLAB_TOKEN=<your-pat>

# E2E 模式：mock IM adapter + Claude CLI
E2E_MODE=1
CLAUDE_MOCK=1

# 触发 Porygon CLI backend（绕开 porygon HTTP）
PIPELINE_ENGINE=default
```

### 0.3 DB 侧前置数据

你的钉钉账号需要一条 `dingtalk_users` 行。替换 `<your-email>` 和 `<your-dingtalk-userid>`：

```sql
-- 进 psql
psql -h localhost -d chatops

-- 插/改测试用户
INSERT INTO dingtalk_users (user_id, name, email)
VALUES ('u-smoke-001', '测试 PM', 'smoke-pm@example.com')
ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email;

-- 确认 LOWER(email) 索引能命中
EXPLAIN SELECT user_id FROM dingtalk_users WHERE LOWER(email) = LOWER('smoke-pm@example.com');
-- 预期看到 'Index Scan using idx_dingtalk_users_email_lower'
```

### 0.4 启动 server

```bash
# 一定要带 E2E_MODE=1 和 CLAUDE_MOCK=1
pnpm migrate  # 确保 schema-v28 应用过
pnpm dev
```

另开一个 terminal，健康检查：

```bash
curl -s http://localhost:3000/admin/_e2e/health | jq
# 预期: {"e2eMode":true,"claudeMock":true}
```

看 server 日志里能看到：

```
[AgentCoordinator] registered handler: prd_submit
[prd_submit] handler registered
[AgentCoordinator] registered handler: prd_create_mr
[prd_create_mr] handler registered
[AgentCoordinator] registered handler: prd_ai_review_mr
[prd_ai_review_mr] handler registered
[AgentCoordinator] registered handler: prd_notify
[prd_notify] handler registered
```

### 0.5 冒烟用的 shell 变量（填一次，后面全用）

```bash
# 把下面的值替换成你的实际值，然后 source 一下
export REPO="PAM/devops/chatops"         # GitLab projectPath
export SRC="prd-smoke"                    # source 分支名
export TGT="feat/docreview"               # target 分支名
export MR_FILE="docs/prds/test.md"        # 仓库内路径
export USER_ID="u-smoke-001"              # 本次模拟的钉钉 userId（在 dingtalk_users 里）
export EMAIL="smoke-pm@example.com"       # 该用户的企业邮箱
export GITLAB_HOST="http://code.paraview.cn"
export WORK_URL="${GITLAB_HOST}/${REPO}/-/tree/${SRC}"
export MR_URL="${GITLAB_HOST}/${REPO}/-/tree/${TGT}"
```

---

## 1. 冒烟工具函数（直接粘 shell）

```bash
# 清洗 e2e 状态（Claude mock 队列 + MockIMAdapter 收件箱）
reset_e2e() {
  curl -s -XPOST http://localhost:3000/admin/_e2e/reset | jq
}

# 给 Claude 'prd-review' 键塞一条 mock 响应
mock_claude_review() {
  local decision="${1:-pass}"  # pass | blocked
  local findings_json="${2:-[]}"
  local markdown="${3:-智能评审测试（mock 响应）}"
  curl -s -XPOST http://localhost:3000/admin/_e2e/claude \
    -H 'content-type: application/json' \
    -d "{\"key\":\"prd-review\",\"response\":{\"decision\":\"$decision\",\"findings\":$findings_json,\"markdown\":$(echo "$markdown" | jq -Rs .)}}"
  echo
}

# 直接触发 prd_submit handler，传入模拟 IM 指令
trigger_prd_submit() {
  local msg="$1"
  curl -s -XPOST http://localhost:3000/admin/_e2e/trigger-capability \
    -H 'content-type: application/json' \
    -d "$(jq -Rn --arg m "$msg" --arg uid "$USER_ID" \
      '{capabilityKey: "prd_submit", extraParams: {message: $m}, __context_uid: $uid}')"
  echo
}

# 查 DM 收件箱
list_dms() {
  curl -s "http://localhost:3000/admin/_e2e/messages?kind=direct" | jq
}

# 查群发信箱
list_group_msgs() {
  curl -s "http://localhost:3000/admin/_e2e/messages?kind=group" | jq
}

# 查最近一次提交的事件
latest_submission_events() {
  psql -h localhost -d chatops -c "
    SELECT code, status, created_at
    FROM prd_submit_events
    WHERE submission_id = (
      SELECT submission_id FROM prd_submit_events
      ORDER BY id DESC LIMIT 1
    )
    ORDER BY id ASC
  "
}
```

> **注意**：`/admin/_e2e/trigger-capability` 端点里 `context.initiatorId` 固定是 `u-trigger`。若想模拟不同 userId，要么改该端点传参，要么直接用 `u-trigger` 作为测试 userId 并把对应 dingtalk_users.email 配好。下面的剧本默认用 `u-trigger`；请把 §0.3 的 SQL 里 `u-smoke-001` 换成 `u-trigger` 再插入。

```sql
-- 改成这样（上面 §0.3 SQL 的更新版）：
INSERT INTO dingtalk_users (user_id, name, email)
VALUES ('u-trigger', '测试 PM', 'smoke-pm@example.com')
ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email;
```

---

## 2. Case A · 正向：自动派生标题 + review pass + un-draft

**目的**：验证 happy path 全链路，Draft 闸门 pass 自动解除。

### 步骤

```bash
reset_e2e
mock_claude_review "pass" '[]' "✅ PRD 结构完整，所有章节齐全，指标可度量。"
trigger_prd_submit "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}"
sleep 8   # 等 pipeline 跑完
```

### 验证

**1）handler 立即返回的 output**（trigger 响应体）：

```
✅ 收到 PRD MR 提交请求（submissionId=prd-mr-test-...），结果将通过 DM 单聊发送给你
```

**2）事件表按序 4 行 success**：

```bash
latest_submission_events
```

预期：
```
        code        | status
--------------------+---------
prd_submit_requested| success
prd_create_mr       | success
prd_ai_review_mr    | success
prd_notify          | success
```

**3）GitLab UI 去看这个 MR**：

```bash
# 查事件拿 mrUrl
psql -h localhost -d chatops -c "SELECT data->>'mrUrl' AS url FROM prd_submit_events WHERE code='prd_create_mr' AND status='success' ORDER BY id DESC LIMIT 1;"
```

打开这个 URL，预期：
- 标题：`[PRD] docs(prd): smoke 测试样例 v1`（**不含 Draft: 前缀**）
- Labels：含 `prd-active-review`
- MR 评论区：最后一条是 AI review：**结论 ✅ pass**
- **Merge 按钮可点**（不是灰色）

**4）DM 收件箱**：

```bash
list_dms
```

预期 1 条 DM，body 含：
- `✅ 你提交的 PRD MR 已通过 AI review，**已解除 Draft，可以合并**：`
- MR URL
- `📋 AI Review 结论：✅ pass`
- `请在 GitLab 上完成 Approve + Merge`

**5）群发信箱**：

```bash
list_group_msgs
```

> 走 `/admin/_e2e/trigger-capability` 直接调 handler 不经 claude-runner，所以群回复不会被 MockIMAdapter 记录。看**handler 的 output 字段**即可（trigger 响应体里）。

---

## 3. Case B · 正向：review blocked（findings 排序验证）

**目的**：验证 blocked 路径 MR 保持 Draft，DM 展示 findings 按 severity 排序。

### 步骤

```bash
reset_e2e
mock_claude_review "blocked" \
  '[{"severity":"info","title":"标题可以更精简","detail":""},
    {"severity":"blocker","title":"成功指标缺度量方式","detail":"§1.3 只说提升体验，无数字"},
    {"severity":"warning","title":"未列非目标","detail":""},
    {"severity":"blocker","title":"数据模型缺字段说明","detail":""}]' \
  "⚠️ 发现两个 blocker，MR 保持 Draft"

trigger_prd_submit "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}"
sleep 8
```

### 验证

**1）事件**：4 行 success；`prd_ai_review_mr.data.decision = 'blocked'`

```bash
psql -h localhost -d chatops -c "
  SELECT data->>'decision' AS decision, data->>'draftCleared' AS cleared
  FROM prd_submit_events
  WHERE code='prd_ai_review_mr' ORDER BY id DESC LIMIT 1;
"
# 预期 decision=blocked, cleared=false
```

**2）GitLab MR**：标题**仍带 `Draft: [PRD] ...`** → Merge 按钮灰（"Can't merge — this merge request is still a draft"）

**3）DM**：应含

```
⚠️ AI Review 发现问题，**MR 保持 Draft 状态，任何人都无法 Merge**
...
Findings 摘要：
1. [blocker] 成功指标缺度量方式
2. [blocker] 数据模型缺字段说明
3. [warning] 未列非目标
```

**关键点**：摘要 3 条里**两个 blocker 先出**（虽然 Claude 返回里 info 在第 1 位），这就是 B3 按 severity 排序的验证。

---

## 4. Case C · 负向：MR 文件路径错

**目的**：校验 `/^docs/prds/.+\.md$/` 正则兜底。

```bash
reset_e2e
trigger_prd_submit "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=docs/other/xx.md"
```

### 验证

- Trigger 响应体 `result.output` 含：`❌ MR 文件必须在 docs/prds/ 路径下，且以 .md 结尾`
- 事件表：**没有任何新行**（`prd_submit_requested` 都不落）

```bash
psql -h localhost -d chatops -c "SELECT COUNT(*) FROM prd_submit_events WHERE data->>'rawCommand' LIKE '%docs/other/xx.md%';"
# 预期 0
```

---

## 5. Case D · 负向：跨 repo（两 URL projectPath 不同）

```bash
reset_e2e
trigger_prd_submit "@agent 提交PRD MR 工作地址=${GITLAB_HOST}/PAM/a/-/tree/${SRC} MR地址=${GITLAB_HOST}/PAM/b/-/tree/${TGT} MR文件=${MR_FILE}"
```

### 验证

- Trigger 响应体 `result.output` 含：`❌ 工作地址与 MR 地址必须是同一个仓库`
- 事件表：无新行

---

## 6. Case E · 负向：email 未同步

```bash
# 临时删 email
psql -h localhost -d chatops -c "UPDATE dingtalk_users SET email = NULL WHERE user_id='u-trigger';"

reset_e2e
trigger_prd_submit "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}"

# 恢复
psql -h localhost -d chatops -c "UPDATE dingtalk_users SET email='${EMAIL}' WHERE user_id='u-trigger';"
```

### 验证

- Trigger 响应体 `result.output` 含：`❌ 未识别到你的企业邮箱，请联系管理员同步通讯录`
- 事件表：无新行

---

## 7. Case F · 负向：source 分支不存在（GitLab 错误被 `extractErrorMessage` 抽出）

```bash
reset_e2e
mock_claude_review "pass" '[]' "mock"
trigger_prd_submit "@agent 提交PRD MR 工作地址=${GITLAB_HOST}/${REPO}/-/tree/no-such-branch-xxx MR地址=${MR_URL} MR文件=${MR_FILE}"
sleep 8
```

### 验证

**1）事件**：`prd_create_mr` = failed（stage 2 review 跑不了；stage 3 notify 仍 success）

```bash
psql -h localhost -d chatops -c "
  SELECT code, status, data->>'error' AS err
  FROM prd_submit_events
  WHERE submission_id = (SELECT submission_id FROM prd_submit_events ORDER BY id DESC LIMIT 1)
  ORDER BY id;
"
```

**关键：error 字段应含 GitLab 真实 message**（N2 验证）——形如：
```
HTTP 404: 404 Branch Not Found
```
或类似，不是笼统的 `Request failed with status code 404`。

**2）DM**：应含

```
🛑 PRD MR 提交失败，**MR 保持 Draft（如已创建）**
失败阶段：prd_create_mr
错误：HTTP 404: ...（GitLab 原文）
...
请联系管理员或重新提交。
```

---

## 8. Case G · 关键：重复提交触发 Draft 闸门重置 ⭐

**目的**：验证核心不变量 —— 二次 @agent 时，**无论上次 pass/blocked**，stage 1 一定把 MR 重置回 Draft。

### 步骤

**第一轮**（Case A 同步骤；跑完后 MR 已 un-draft）：

```bash
reset_e2e
mock_claude_review "pass" '[]' "第一轮通过"
trigger_prd_submit "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}"
sleep 8
```

确认 GitLab 上 MR 标题**无 Draft: 前缀** → Merge 可点。

**第二轮**（模拟 PM 推了 blocker 内容后再 @agent）：

```bash
reset_e2e
mock_claude_review "blocked" '[{"severity":"blocker","title":"新增 blocker 测试","detail":"第二轮"}]' "第二轮被拒"
trigger_prd_submit "@agent 提交PRD MR 工作地址=${WORK_URL} MR地址=${MR_URL} MR文件=${MR_FILE}"
sleep 8
```

### 验证（关键）

**1）事件**：复用路径被命中

```bash
psql -h localhost -d chatops -c "
  SELECT data->>'reused' AS reused,
         data->>'wasForceDrafted' AS force_drafted,
         data->>'mrIid' AS mr_iid
  FROM prd_submit_events
  WHERE code='prd_create_mr' AND status='success'
  ORDER BY id DESC LIMIT 2;
"
```

预期第 1 行（最新，第二轮）：`reused=t, force_drafted=t`
预期第 2 行（第一轮）：`reused=f, force_drafted=f`

**2）GitLab MR 标题变回 `Draft: [PRD] ...`**（重要 —— 就算上次已解除，stage 1 强制回到 Draft）

**3）GitLab MR 评论区**：两条 AI review note（第一轮 pass + 第二轮 blocked），history 保留

**4）DM**：第二轮的 DM 应当是 `prd_submit_blocked` 文案（`MR 保持 Draft 状态`）

---

## 9. Case H · 次要：commit log 派生降级

**目的**：验证 source 分支全是 fixup! commits 时标题回退 slug。

**准备**（只有想测这条才做）：

```bash
# 在 GitLab test repo 的 source 分支上 push 几条都是 fixup 类的 commit
git checkout prd-smoke
git commit --allow-empty -m "fixup! tmp debug"
git commit --allow-empty -m "WIP: still drafting"
git push origin prd-smoke
```

然后跑 Case A 一次（`reset_e2e; mock_claude_review pass; trigger_prd_submit ...`），观察：

```bash
psql -h localhost -d chatops -c "
  SELECT data->>'baseTitle' AS title, data->>'titleSource' AS source
  FROM prd_submit_events WHERE code='prd_create_mr' AND status='success'
  ORDER BY id DESC LIMIT 1;
"
# 预期 title='[PRD] test', source='fallback'（slug 就是 MR 文件的 basename）
```

**跑完别忘了把那几条 fixup commit 清掉**（`git reset --hard` + force push 或者重置分支）以免污染后续 Case。

---

## 10. Case I · 管理员编辑 prompt 持久化验证（B1）

```bash
# 手改 prompt
psql -h localhost -d chatops -c "
  UPDATE capabilities
  SET system_prompt = '[CUSTOM] 这是 admin 的自定义 prompt'
  WHERE key='prd_ai_review_mr';
"

# 再跑 migrate
pnpm migrate

# 确认改动保留
psql -h localhost -d chatops -c "
  SELECT left(system_prompt, 40) AS prompt,
         (system_prompt = default_system_prompt) AS is_default
  FROM capabilities WHERE key='prd_ai_review_mr';
"
# 预期: prompt 以 '[CUSTOM]' 开头, is_default=false
# 说明 admin 编辑保留，default 仍刷新为代码版

# 恢复默认
psql -h localhost -d chatops -c "
  UPDATE capabilities SET system_prompt = default_system_prompt
  WHERE key='prd_ai_review_mr';
"
```

---

## 11. 零回归验证（M4a 必过）

bug-fix 路径不受影响：

```bash
# 手动跑一次 bug-fix 全链路（需要有效的 analyze_bug capability）
curl -s -XPOST http://localhost:3000/admin/_e2e/analyze-and-dispatch \
  -H 'content-type: application/json' \
  -d '{"productLineId":1,"message":"测试 bug：xxx 功能不工作","initiatorId":"u-trigger"}' | jq
```

- `bug_fix_events` 应有新行（不是 `prd_submit_events`）
- 触发的 pipeline 是 L1/L2/L3 之一（不是 1776868085）
- 与 PRD 链路物理隔离：无 `prd_*` 事件污染

---

## 12. 故障排查

| 症状 | 可能原因 | 诊断命令 |
|------|----------|----------|
| `trigger_prd_submit` 返回 `{"error":"capabilityKey required"}` | 请求体格式错 | `curl -v` 看 body |
| handler 没调 | capability 白名单没生效 | `grep HANDLER_CAPABILITIES src/agent/claude-runner.ts` 应含 `'prd_submit'` |
| MR 没开 | GitLab token 权限不够 / `projectPath` 错 | 看 `prd_create_mr.data.error`（含 `HTTP 404: ...` 的 GitLab 原文） |
| MR 开了但 review 没跑 | Claude mock 没塞 | `curl -s /admin/_e2e/health` 确认 `claudeMock:true`；重新 `mock_claude_review` |
| review 没解除 Draft | 要么 decision=blocked，要么 PUT 权限不够 | `data->>'draftClearError'` 会有 GitLab 错误（N1 修正后） |
| DM 没到 | email 反查失败 | 查 `dingtalk_users` 行是否存在且 email 非空 |
| Pipeline 卡住 | stage timeout | 查 `test_runs.status`；检查 `prd_submit_events` 是否 4 行都到了 |

### 反 pattern 快捷查看（全在一个 SQL 里）

```sql
-- 最近一次 submission 的完整链路
WITH latest AS (
  SELECT submission_id FROM prd_submit_events ORDER BY id DESC LIMIT 1
)
SELECT
  code, status, duration_ms, created_at,
  data->>'reused' AS reused,
  data->>'wasForceDrafted' AS force_drafted,
  data->>'mrIid' AS mr_iid,
  data->>'decision' AS decision,
  data->>'draftCleared' AS draft_cleared,
  data->>'error' AS error
FROM prd_submit_events
WHERE submission_id IN (SELECT submission_id FROM latest)
ORDER BY id;
```

---

## 13. 冒烟通过判据

**核心 5 条必过**（缺一个都不算 M4a 通过）：

- [ ] Case A 正向全通（事件 4/4 + MR 标题无 Draft + Merge 可点 + DM 到达）
- [ ] Case B blocked 路径 MR **保持 Draft** + findings 按 severity 排序
- [ ] Case G 重复提交 **force-draft 重置** 成立（wasForceDrafted=true + 标题变回 Draft:）
- [ ] Case C/D/E 三个用户侧兜底分支都正确回提示
- [ ] Case I admin 编辑 prompt 经 migrate 保留

**推荐过**（强化信心，非必须）：
- [ ] Case F GitLab 错误抽取正确（含 `HTTP xxx: ...` 前缀）
- [ ] Case H commit log fallback 生效
- [ ] 零回归验证通过

---

## 14. 收尾

冒烟通过后：

```bash
# 把 smoke 过程中产生的 test MR 关掉（如不想留）
# 到 GitLab UI 点 Close

# 清空 smoke 遗留的 DM/群消息 mock 记录
curl -XPOST http://localhost:3000/admin/_e2e/reset

# 若有 DB 清理需要：清除 smoke 的 prd_submit_events
psql -h localhost -d chatops -c "
  DELETE FROM prd_submit_events
  WHERE submission_id LIKE 'prd-mr-test-%';
"
```

提交冒烟日志到 branch 并开 MR（本 feature 的最终交付）。
