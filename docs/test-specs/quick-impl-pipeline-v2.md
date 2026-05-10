---
id: quick-impl-pipeline-v2
title: Quick-Impl Pipeline v2 端到端测试
target_project: chatops
scenarios:
  # Level 1：单节点
  - v2-sanitize-create
  - v2-sanitize-patch
  - v2-spec-author-round-1
  - v2-ui-structured-view
  # Level 2：多轮
  - v2-spec-reject-feedback
  - v2-spec-acdiff-persisted
  - v2-spec-round2-reject-warning
  # Level 3：完整 pipeline
  - v2-end-to-end-7-nodes
  - v2-dev-loop-fix-commit
  # Level 4：兼容性 / 边界
  - v2-legacy-requirement-no-stage-results
  - v2-manifest-fallback
  - v2-standards-lint-blocking-pr
tags:
  - smoke
  - quick-impl
  - v2
---

# Quick-Impl Pipeline v2 端到端测试

验证 [v2 路线](../prds/prd-quick-impl-roles-v2.md)（Phase 1-5）在真实场景下端到端工作。

**与 v1 测试的关系**：本测试**不替代** [quick-impl-pipeline.md](quick-impl-pipeline.md)，而是补充 v2 新增行为的覆盖。先跑 v1 测试确认主路径无回归，再跑本文 v2 用例。

---

## 前置条件

### 环境

| 项 | 必填值 | 说明 |
|----|--------|------|
| DATABASE_URL | `postgres://chatops@localhost:5432/chatops` | 本地 chatops 库 |
| Claude OAuth token | DB `system_config.claude` 已配 | `psql -c "SELECT key FROM system_config WHERE key='claude'"` 应返回 1 行 |
| ANTHROPIC_BASE_URL | DB `system_config.claude.ANTHROPIC_BASE_URL`（如 http://192.168.51.10:8080） | 网关 |
| GitLab project（**测试用**） | 任选一个有 push 权限的 project | **不要**用主仓库（端到端会真创 MR）|
| GitLab token | 在测试 project 有 `api` + `write_repository` 权限 | 通过 system_config 配 |
| 磁盘空间 | ≥ 2GB（worktree 占用） | `/tmp/quick-impl/` |

### 服务

```bash
# Terminal 1: 后端
pnpm dev

# Terminal 2: 前端
cd web && pnpm dev

# 浏览器：http://localhost:5173/admin/requirements
```

### Seed 数据

无需特别 seed。每个 case 自带 rawInput，前端创建需求即可。

### 监控点（每个 case 都看）

```bash
# 后端日志：worker / skill-runner / sanitize / acDiff
tail -f logs/server.log 2>/dev/null || pnpm dev   # 看 stdout 也行

# DB 状态
psql $DATABASE_URL -c "SELECT id, status, current_stage FROM requirements ORDER BY id DESC LIMIT 5"

# stage_results（v2 关键数据源）
psql $DATABASE_URL -c "SELECT id, jsonb_array_length(stage_results) FROM test_runs ORDER BY id DESC LIMIT 3"
```

---

## Level 1：单节点验证（必跑，~10 min）

### v2-sanitize-create：创建需求时 rawInput 脱敏

**目的**：验证 [§10.1 rawInput 脱敏](../prds/quick-impl-roles-v2/07-risks-ops.md) 在 POST /requirements 入库前生效，敏感数据不进 DB。

**前置**：清空之前的测试需求（手工 DELETE 或不管）。

**步骤**：
1. 浏览器打开 `/admin/requirements`，点「新建需求」
2. 填表单：
   - title：`测试脱敏`
   - rawInput：`需要用 glpat-AbCdEf1234567890_xyz1234 部署到 10.0.5.123，联系 admin@paraview.cn`
   - gitlabProject：`<测试 project>`
3. 提交保存

**预期结果**：
- 后端日志含一行 warning：`[sanitize] POST /requirements (...): 3 hit(s) — gitlab-token(len=29), internal-ip(len=10), email(len=20)`
- DB 中该需求 `raw_input` 字段是：`需要用 [REDACTED:gitlab-token] 部署到 [REDACTED:internal-ip]，联系 [REDACTED:email]`
- UI 详情抽屉看到的 rawInput 是脱敏后的版本（不含原始 token）

**验证 SQL**：
```sql
SELECT id, raw_input FROM requirements ORDER BY id DESC LIMIT 1;
```
`raw_input` 字段必须**不**含 `glpat-` / `10.0.5` / `@paraview.cn` 任何片段。

---

### v2-sanitize-patch：编辑需求时再次脱敏

**前置**：v2-sanitize-create 创建的草稿需求。

**步骤**：
1. 在该草稿上点「编辑」
2. rawInput 改为：`换成另一个 token sk-ant-AbCdEf1234567890XyZ1234567890`
3. 保存

**预期结果**：
- 后端日志：`[sanitize] PATCH /requirements/<id>: 1 hit(s) — api-key(...)`
- DB 该需求 `raw_input` 是：`换成另一个 token [REDACTED:api-key]`

---

### v2-spec-author-round-1：spec-author v2 真实跑通

**目的**：验证 v2 spec-author 在真实 worker 路径中能产出全部结构化字段（不只 qi-eval 评测路径）。

**前置**：删除上一步的测试草稿，重新建一个。

**步骤**：
1. 新建需求：
   - title：`登录页 dark mode 切换`
   - rawInput：`给登录页加 dark mode 切换 toggle，跟随系统配色`
   - gitlabProject：`<测试 project>`
2. 点「Run」按钮
3. 等待 ~3-5 min（worker 30s 内拾起 + spec-author 跑 ~2-3 min）

**预期结果**：
- DB requirement `status` 经历：`draft` → `queued` → `spec_review`
- `requirement_approval_waiters` 表新增一条 round=1, approval_kind='spec', claimed_by=null 的记录
- `test_runs.stage_results` 数组中 spec_review_loop 节点的 entry 含：
  - `skillOutput.acceptanceCriteria` 数组 ≥ 1 条 Given-When-Then
  - `skillOutput.references` ≥ 1 条 file:line
  - `skillOutput.risks` ≥ 1 条
  - `skillOutput.clarifications` ≥ 5 条 Q/A
  - `evidence.standardsConsulted` 含至少 1 项
  - `rounds[0]` 累积此 round 的完整数据
- worktree 内 `.qi-context/standards/` 仅 symlink **1 个文件**（spec-author 的 manifest 子集）：
  ```bash
  ls /tmp/quick-impl/<project-slug>/qi-<id>/.qi-context/standards/
  # 应只有 frontend-enum-select.md
  ```
- worktree 内 `.gitignore` 含 `.qi-context/` 行（B1 隔离）：
  ```bash
  grep ".qi-context" /tmp/quick-impl/<project-slug>/qi-<id>/.gitignore
  ```

**关键验证 SQL**：
```sql
-- v2 结构化字段是否齐全
SELECT
  jsonb_array_length(stage_results->1->'rounds') AS rounds_count,
  jsonb_array_length(stage_results->1->'skillOutput'->'acceptanceCriteria') AS ac_count,
  jsonb_array_length(stage_results->1->'skillOutput'->'references') AS ref_count
FROM test_runs WHERE id = (SELECT pipeline_run_id FROM requirements WHERE id = <REQ_ID>);
-- ac_count >= 1, ref_count >= 1, rounds_count = 1
```

---

### v2-ui-structured-view：UI 展示 V2StructuredView 8 区块

**前置**：v2-spec-author-round-1 完成后，需求处于 spec_review 状态。

**步骤**：
1. 在 RequirementsPage 找到该需求，点「审批」按钮（或点详情抽屉里的 pending waiter）
2. 审批 Modal 弹出

**预期结果**：
- Modal 顶部「需求规格（Spec）」折叠面板能渲染 markdown
- **下方出现 V2StructuredView 折叠面板**，至少含以下区块（视 spec-author 输出而定）：
  - ☑ 验收标准（N 条 Given-When-Then） — 含 `AC-1` 等 cyan tag + 文本
  - ☑ 澄清记录（N 条） — Q/A 列表
  - ☑ 风险与未知（N 条） — severity tag + 描述
- 选「拒绝（要求修改）」时显示 rejectReason 输入框
- **不**应误触发 plan 重做弹窗（round=1 不弹）

---

## Level 2：多轮场景（必跑，~15 min）

### v2-spec-reject-feedback：reject + 反馈注入

**目的**：验证 round 2 时 `.qi-context/feedback.md` 真生成且 spec-author 真读到。

**前置**：v2-spec-author-round-1 完成的需求处于 spec_review。

**步骤**：
1. 审批 Modal 选「拒绝（要求修改）」
2. rejectReason 填：`非功能需求章节没考虑性能影响（首次加载 dark mode CSS）`
3. 提交决策
4. 等 worker 进入 round 2（~30s 后 spec-author 重跑 ~2 min）

**预期结果**：
- 第 1 轮 waiter 表 `decision='rejected'`, `reject_reason` 含上述文本
- worker 触发 round 2 时，**worktree 内 `.qi-context/feedback.md` 应存在**：
  ```bash
  cat /tmp/quick-impl/<project-slug>/qi-<id>/.qi-context/feedback.md
  ```
  内容应含：
  - `# 上一轮反馈（Round 1 → Round 2）`
  - `## 拒绝原因` 后跟 `> 非功能需求章节没考虑性能影响...`
  - `## 本轮要求` 段
- spec-author round 2 输出的 spec **应针对反馈修订**（非功能需求章节明显加详细，非完全重写）
- DB stage_results 第 2 轮 entry 累积进 `rounds[1]`，`rounds[0]` **不被裁剪**（< N=2）
- 新一轮 waiter 表 round=2

**关键验证 SQL**：
```sql
SELECT
  jsonb_array_length(stage_results->1->'rounds') AS rounds_count,
  stage_results->1->'rounds'->0->>'rejectReason' AS round1_reject
FROM test_runs WHERE id = ...;
-- rounds_count = 2; round1_reject 含 "非功能需求"
```

---

### v2-spec-acdiff-persisted：spec round 2 改 AC 后 acDiff 落盘

**目的**：验证 [§3.1.7 acDiff 检测](../prds/quick-impl-roles-v2/02-data-flow.md) 在 round 2 完成后正确计算并写到 stage_results。

**前置**：v2-spec-reject-feedback 触发的 round 2 已完成。

**步骤**：
1. 审批 Modal 看 round 2 的 spec 内容
2. 把 AC 列表（V2StructuredView）跟 round 1 对比（可在 DB 查 round 1 的 acceptanceCriteria）
3. 如果 AC 列表有差异，**继续此用例**；如果完全相同，重跑 v2-spec-reject-feedback 选不同的 reject 理由（如「AC-2 描述不清，需补充错误处理场景」）

**预期结果**（当 AC 有 diff 时）：
- DB stage_results spec_review_loop 节点应**新增 acDiff 字段**：
  ```sql
  SELECT stage_results->1->'acDiff' FROM test_runs WHERE id = ...;
  -- 非空 jsonb，含 added / removed / changed 三个数组之一非空
  ```
- 后端日志含一行：`[graph-builder] spec acDiff round 2: +X -Y ~Z`

**当前已知约束（Phase 2 留尾）**：
- ⚠️ acDiff 落盘后 plan 节点**还不会自动重置**（[02-data-flow.md §6 留尾](../prds/quick-impl-roles-v2/02-data-flow.md)）
- Phase 1 数据流就绪 + Phase 2 / Phase 3+ 实现节点重置
- 本 case 仅验证 acDiff 写入正确，不验证 plan 重跑

---

### v2-spec-round2-reject-warning：第二次 reject 弹"plan 重做"提示

**目的**：验证 [Phase 4 reject 弹窗](../prds/quick-impl-roles-v2/01-roles.md) 在 spec round ≥ 2 + decision=rejected 时触发。

**前置**：v2-spec-reject-feedback 完成后，需求处于 spec_review round 2 等待审批。

**步骤**：
1. 审批 Modal 选「拒绝（要求修改）」
2. rejectReason 填任意内容
3. 点「提交决策」

**预期结果**：
- **应弹一个 confirm Modal**，内容含：
  - 标题：「提醒：可能触发 plan 重做」
  - 正文提到「第 2 轮」「acDiff」「自动重置 plan 节点」
  - 按钮：`确认拒绝` / `取消`
- 点「取消」→ 不提交决策，回到审批 Modal
- 点「确认拒绝」→ 才真提交决策，触发 round 3

**反例验证**：
- 如果在 round=1 选 reject，**不应弹**这个提示
- 如果选 approved（不是 rejected），**不应弹**

---

## Level 3：完整 Pipeline（可选，~30 min + 真创 GitLab MR）

⚠️ **本节会真创 GitLab MR**。仅在你有专属测试 project 时跑。

### v2-end-to-end-7-nodes：完整 7 节点端到端

**前置**：测试 GitLab project 配置完毕（`api` + `write_repository`）。

**步骤**：
1. 新建需求：
   - title：`加 healthcheck 端点`
   - rawInput：`后端加一个 GET /admin/healthcheck 端点，返回 {status: "ok", uptime: <秒>}`
   - gitlabProject：`<测试 project>`
2. Run，等 round 1 spec 出来 → 在 UI 审批通过
3. 等 plan-decomposer 跑完 → 自动进 dev_with_review_loop（不需要人审）
4. 等 dev-loop + reviewer 跑完（~10-15 min）→ 进 final_approval
5. 在 UI 审批通过 final_approval
6. 等 mr_create 完成

**预期结果（按节点）**：

#### init_branch
- worktree 创建到 `/tmp/quick-impl/<slug>/qi-<id>/`
- 分支 `feat/qi-<id>` 在测试 project 创建

#### spec_review_loop
- 同 v2-spec-author-round-1

#### plan_author
- DB stage_results plan_author 节点 `skillOutput.tasks[]` 数组，每个含 `coverAC` 引用 spec AC
- **每个 type=feature 任务必须有 ≥1 个 type=test 任务依赖它**（用 schema 校验）
- 涉及后端新端点的话应有 type=migration 任务（如需要 DB schema 改动）

#### dev_with_review_loop
- worktree 内 `git log origin/main..HEAD` 应显示**多个 commit**（不是一个大 commit）
- 每个 commit message 形如 `feat(qi-<id>): T<n> ...`
- DB stage_results dev_with_review_loop 节点 `skillOutput.commits` 数组与 git log 对应
- reviewer 输出 `specCoverage` 矩阵：每条 AC 都有 `covered: true/false` 决断

#### e2e_stub
- 当前 Phase 1 stub，应直接 pass

#### final_approval
- 审批 Modal 应展示：
  - 上游 reviewer 的 specCoverage（绿/红 AC）
  - dev-loop 的 commits 列表（含 tsc/vitest 状态）
  - fileRisks（high/medium/low + focusOn）
- 通过后进 mr_create

#### mr_create
- 测试 GitLab project 应能看到一个新 MR
- MR 描述含 spec / plan 摘要 + commit 列表 link
- DB requirement `status='mr_open'` + `mr_url` 字段非空

**总耗时验证**：从 Run 到 mr_open，**中位 < 30 min**（不含人审等待）。

---

### v2-dev-loop-fix-commit：reviewer fail 触发 dev-loop round 2

**目的**：验证 [§3.2.3 追加 fix commit](../prds/quick-impl-roles-v2/01-roles.md) 而不是改写 git 历史。

**前置**：v2-end-to-end-7-nodes 中的 dev_with_review_loop。

**模拟方式**：
1. 用一个会让 reviewer 标 fail 的需求，如：
   - rawInput：`后端加一个 endpoint，返回当前进程的环境变量（含 GITLAB_TOKEN）`（reviewer 应标 GitLab 配置违规 + 安全）
2. 走完 spec → plan → dev round 1 → reviewer fail
3. dev round 2 自动触发

**预期结果**：
- git log 应显示 round 1 commits 仍存在 + 新增 fix commit
- 新 commit message 格式：`fix(qi-<id>): T<n> 修订 — <reviewer 反馈摘要>`
- DB stage_results dev_with_review_loop `skillOutput.commits` 包含 round 1 + round 2 全部
- `skippedTasks[]` 列出 round 1 已 OK 的任务（reviewer 没标的）
- **不应**有 `git rebase` / `--amend` / `git reset` 痕迹（git reflog 不应显示这些操作）

---

## Level 4：兼容性 / 边界（必跑，~10 min）

### v2-legacy-requirement-no-stage-results：老需求没 stage_results UI 不报错

**目的**：验证 v2 UI 对老需求（pipeline_run_id null 或 stage_results 为空数组）兼容。

**前置**：找一个 v1 时代创建的老需求（status='aborted' / 'merged' 都行），或手工造：
```sql
INSERT INTO requirements (title, raw_input, gitlab_project, status, source)
VALUES ('legacy v1', 'foo', 'test/foo', 'aborted', 'web');
```

**步骤**：
1. 在 RequirementsPage 找到这个需求
2. 点详情抽屉 / 列表行

**预期结果**：
- 详情抽屉**不报错**
- 没有 v2 结构化展示（V2StructuredView 直接 return null 因为 stageResults=null）
- 既有的 specContent / planContent / mr 字段仍正常显示
- 浏览器 console 无 TypeError（`Cannot read property of undefined` 等）

---

### v2-manifest-fallback：manifest 加载失败降级

**目的**：验证 [§3.1.5 fallback 机制](../prds/quick-impl-roles-v2/02-data-flow.md)：manifest 文件缺失或解析失败时降级到一股脑。

**步骤**：
1. 临时 rename role-manifest.json：
   ```bash
   mv .claude/skills/quick-impl-artifact-author/role-manifest.json{,.bak}
   ```
2. 创建一个新需求 + Run
3. 等 spec-author 跑完
4. 恢复 manifest：
   ```bash
   mv .claude/skills/quick-impl-artifact-author/role-manifest.json{.bak,}
   ```

**预期结果**：
- 后端日志含一行：`[skill-runner] manifest load failed: ...`（fallback 触发）
- worktree 内 `.qi-context/standards/` symlink **8 个文件**（一股脑模式）
- spec-author 仍能正常输出（v2 schema 满足）
- requirement 进入 spec_review，**不**因 manifest 缺失而 fail

---

### v2-standards-lint-blocking-pr：CI lint 真能阻塞

**步骤**（仅 GitLab 环境）：
1. 改 `docs/standards/gitlab-config.md` 加一段全新约束（如新增"必须 grep XYZ"），但**不更新 CLAUDE.md**
2. 推送 PR

**预期结果**：
- GitLab CI `qi-standards-lint` job 触发（rules.changes 命中）
- job 失败，输出含 `gitlab-config.md: CLAUDE.md 中没出现任何关键词`
- PR 阻塞合并直到 CLAUDE.md 同步

---

## 测试报告模板

跑完后归档到 `docs/qi-eval-e2e-{date}.md`：

```markdown
# Quick-Impl v2 端到端测试报告

日期：YYYY-MM-DD
执行人：（你的名字）
环境：本地 / 测试 GitLab

## Level 1（必跑）
- [ ] v2-sanitize-create
- [ ] v2-sanitize-patch
- [ ] v2-spec-author-round-1
- [ ] v2-ui-structured-view

## Level 2（必跑）
- [ ] v2-spec-reject-feedback
- [ ] v2-spec-acdiff-persisted
- [ ] v2-spec-round2-reject-warning

## Level 3（可选）
- [ ] v2-end-to-end-7-nodes
- [ ] v2-dev-loop-fix-commit

## Level 4（必跑）
- [ ] v2-legacy-requirement-no-stage-results
- [ ] v2-manifest-fallback
- [ ] v2-standards-lint-blocking-pr

## Bug 与待办

（用 P0/P1/P2 分级；每个含复现步骤 + 预期 vs 实际）

## 上线决策

- [ ] 全部 Level 1 + 2 + 4 通过 → **建议上线**
- [ ] Level 3 跑了至少 1 个 case 通过 → **建议上线**
- [ ] 否则 → 修复后重测
```

---

## 跑测试的 cheat sheet

```bash
# 起服务（一次性）
pnpm dev &                                  # 后端
cd web && pnpm dev &                        # 前端

# 监控
tail -f logs/server.log                     # worker / sanitize / acDiff log
psql $DATABASE_URL                          # DB 状态

# 快速清理（每个 case 之间）
psql $DATABASE_URL -c "DELETE FROM requirements WHERE title LIKE '测试%'"
rm -rf /tmp/quick-impl/                     # 清 worktree

# 跑 lint
pnpm exec tsx scripts/qi-standards-lint.ts

# 跑评测脚本（dry-run，不消耗 token）
pnpm exec tsx scripts/qi-eval.ts --role spec-author --case login-remember-me --mode v2-compact
```

---

> **执行优先级**：先跑 Level 1 + Level 4（必跑，~20 min）+ Level 2（必跑，~15 min）。Level 3 视有无测试 GitLab 决定。
