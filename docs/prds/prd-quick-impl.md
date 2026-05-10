# PRD: 快速实现流水线（Quick-Impl Pipeline）

**版本**：v2（方案 A · 节点折叠，无反向边） · **作者**：sherryswift1019 · **创建**：2026-05-07 · **更新**：2026-05-07

## 摘要 · 给关系人

### 我们要做什么

在 ChatOps 里加一条**「快速实现」流水线**。用户在管理后台输入一句话需求（如「新增用户注册页面」），系统自动跑一条 7 节点流水线：fork 分支 → AI 写 Spec（人工双端审批多轮）→ 拆 plan → TDD 写测试 + 实现 → AI Code Review（不通过自动修复）→ 自动化测试（Phase 1 stub）→ 人工最终审批 → 创建 GitLab MR。

技术骨架：复用 ChatOps 现有的 pipeline + LangGraph + IM adapter，新增 4 种节点类型（`skill_node` / `skill_with_approval` / `skill_with_review` / `mr_create`），蒸馏 1 个底座 Skill `quick-impl-artifact-author` 含 4 个 role manifest，挂在新「需求管理」页面 + 钉钉群双入口。

### 达到什么效果

**对研发同学**
- 一句话需求 → 30 分钟–几小时内自动产出可评审 MR
- 中位时长目标 < 1h（不含人审等待）
- 自动化通过率 ≥ 60%（不需要手改代码即可走到最终审批）
- 始终保留人工审批闸：Spec 阶段、最终 MR 阶段都得点头

**对工程团队**
- 把 Spec 编写、TDD、Code Review 这些重复劳动委托给 AI；人只做关键决策
- 每个产物（Spec / Plan / 代码 / Review）都在分支上 commit，可完整溯源
- 失败有兜底：循环预算用完触发 escalation，admin 决定 force_pass / +budget / abort

**Phase 分阶段**
- **Phase 1（2-3 周）**：Web 入口 + spec/final 双端审批 + e2e stub
- **Phase 2**：spec-compliance reviewer 拆出 + 真 e2e 接入 + skill 自评
- **Phase 3**：钉钉/飞书 @bot 创建需求 + SSE 实时进度 + GitLab webhook 回写
- **Phase 4**：多项目支持 + 自定义 pipeline 模板

### 影响范围与通知关系人

| 团队 / 角色 | 影响 | 通知重点 |
|---|---|---|
| **后端 / Pipeline 模块维护者** | [graph-builder.ts](../../src/pipeline/graph-builder.ts) switch 加 4 case · [graph-runner.ts](../../src/pipeline/graph-runner.ts) `streamGraph` 加 optional `signal: AbortSignal` 参数 + `resumeFromRequirementApproval()` 新增接口 · [scheduler.ts](../../src/pipeline/scheduler.ts) 加 quick-impl-worker hook | 这 3 个文件是核心，必须**全套 vitest 回归通过**才能合 |
| **后端 / Agent 模块维护者** | [claude-runner.ts](../../src/agent/claude-runner.ts) 接口扩展（新增可选参数 `mcpServerPath?` / `extraEnv?`）；新增专用 [src/quick-impl/mcp-server.ts](../../src/quick-impl/mcp-server.ts) 子进程 | 现有调用方（e2e-fix / e2e-scenario / session-manager）参数都是 optional 默认行为不变，但**编译要重过**所有调用方 |
| **前端 / 画布维护者** | [NodeInspector.tsx](../../web/src/pipeline-canvas/panels/NodeInspector.tsx) 过滤 `category='quick_impl_only'` 节点类型，避免画布新建 quick-impl 节点 | 一行过滤，零回归；Phase 4 才放开给画布 |
| **前端 / 管理后台维护者** | 新页面 `/admin/requirements`（列表 + 详情抽屉 + 新建表单）+ 新菜单项 | 独立页面，不动现有 UI |
| **DBA / 数据库维护者** | schema-v60 新增 `requirements` + `requirement_approval_waiters` 两表 + 4 个 `pipeline_node_types` + 3 个索引 + 1 个 `pipelines` 表新列 | 迁移幂等（IF NOT EXISTS），但**v60 是单向迁移**不可回滚；上线前先 staging 验 |
| **DevOps / SRE** | `/tmp/quick-impl/` 占磁盘（每活跃需求 ~ 仓库克隆大小）· 新 env：`WORKTREE_BASE_QI` / `QI_REPO_CACHE_BASE` · 新 system_config 命名空间 `quick_impl.*` | 默认 max_live_worktrees=10，最坏 10× 仓库占盘；监控告警阈值要更新；首次部署必须配 `default_gitlab_project` 否则 POST 报 400 |
| **AI 配额管理 / Claude OAuth token 持有人** | 每需求消耗 ~30+ ClaudeRunner 调用（spec 多轮 + dev-loop N task + reviewer + final），与 e2e、bug 分析共用同一 token | Phase 1 不限流仅监控；上线后观察一周 token 消耗，必要时升档 |
| **GitLab admin** | quick-impl 会自动：fetch / 创建本地分支 / push 新分支 / 调 GitLab API 建 MR + 加标签 `quick-impl auto-generated` | OAuth token 需要 `api` + `write_repository` 权限；目标 project 要给 ChatOps 用户 Maintainer 权限 |
| **审批系统 / ApprovalGate 维护者** | **Phase 1 零影响**（quick-impl 用独立 RequirementApprovalGate，不动主 ApprovalGate）；Phase 2 合并时再通知 | 但 Phase 2 计划合并 `approval_requests` 加 `object_type` 字段，届时主审批表会变 |
| **IM 适配器维护者（钉钉 / 飞书）** | Phase 1 新增审批 callback path `/admin/requirements/:id/approvals/:waiterId`；adapter 验签后转发 | 复用现有签名校验机制，无新机制；Phase 3 加 @bot 创建需求时影响更大 |
| **研发团队（最终用户）** | 新功能：需求管理页 + 一句话需求 + 多轮 Spec 审批 | 上线前出培训文档：怎么写好的一句话需求、Spec 审批要看什么、reject 的 reason 怎么写有效 |
| **公司 / 项目规范文档维护者** | spec-author skill 会读 `CLAUDE.md` + ~~新建 `docs/specs/STANDARDS.md`~~ → **v2 升级为 [docs/standards/](../standards/) 8 篇模块化规范** | v2 上线后 CLAUDE.md 改动需同步 docs/standards/，由 lint 脚本自动检查（Phase 5）|

### 上线前 / 内部协调清单

1. **Day 0 验证**（已完成 2026-05-07，结论见 [docs/quick-impl-day0-validation.md](../quick-impl-day0-validation.md)）：5 项全过，无需 Plan B
2. **首次部署配置**：`system_config.quick_impl.default_gitlab_project` 必填、`approval_im_group_id` 必填
3. **规范文档准备**：~~`docs/specs/STANDARDS.md` 写一份项目规范~~ → **已升级为 [docs/standards/](../standards/) 8 篇模块化规范**（v2 路线，详见 [docs/prds/prd-quick-impl-roles-v2.md](prd-quick-impl-roles-v2.md)）
4. **GitLab 权限**：确认 OAuth token 在目标 project 有 `api` + `write_repository`
5. **磁盘监控**：`/tmp/quick-impl/` 加监控阈值（建议 ≥ 80% 告警）
6. **Token 用量监控**：上线后第一周日报 token 消耗
7. **回归测试范围**：[src/pipeline/](../../src/pipeline/) 所有现有 pipeline / capability / im_input / wait_webhook / e2e 端到端跑一遍
8. **培训材料**：研发团队怎么用 + 审批人怎么写有效 reject reason + 失败 / escalation 处理 SOP
9. **v2 role 评测**（新增 2026-05-08）：[docs/qi-eval-baseline.md](../qi-eval-baseline.md) + [docs/qi-eval-v2.md](../qi-eval-v2.md) — V2 spec-author 总分 23/25（vs V1: 11/25，提升 +109%），manifest 精准注入策略验证有效。Phase 4 UI 已适配 v2 结构化字段（specCoverage / commits / acceptanceCriteria / openQuestions）+ spec round ≥ 2 reject 弹窗

### 风险一览

> Day 0 已消除前 3 条风险（验证报告 [docs/quick-impl-day0-validation.md](../quick-impl-day0-validation.md)）。

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| ~~LangGraph cancel API 不存在~~ | ✅ 已解 | - | RunnableConfig.signal 原生支持 |
| ~~ClaudeRunner kill 接口不暴露~~ | ✅ 已解 | - | Porygon.abort + EphemeralProcess.terminate |
| ~~porygon token 计数不暴露~~ | ✅ 已解 | - | AgentResultMessage 已有字段 |
| Skill 输出 JSON 格式不稳定 → 节点频繁 escalation | 中 | 高 | prompt 强约束 + zod 校验 + 输出兜底解析（§7.1） |
| Spec 质量差导致 5 轮 reject 仍不达标 | 中 | 中 | 规范文档质量决定上限；Phase 2 接 prd-review 自评 |
| 多需求并发抢 OAuth token 限流 | 低 | 中 | concurrency=2 起步保守 |
| Worktree 磁盘爆 | 低 | 高 | max_live_worktrees=10 硬上限 + cleanup 后 30min 清 |

---

## 1. 背景与目标

借鉴 Anthropic Superpowers 的 Skill 化研发逻辑，为 ChatOps 提供一条「一句话需求 → 自动开 MR」的端到端流水线。用户在管理后台或钉钉群输入一句话需求，平台自动完成：规范化 Spec → fork 分支 → 拆解 plan → 写测试 + TDD 实现 → AI Code Review → 自动化测试 → 人工审批 → 提 MR。每一关键步骤蒸馏成 Skill，由通用 `skill_*` 节点驱动。

**目标用户**：研发团队成员希望快速把模糊需求落成可审查代码改动，而不必从零写 Spec、拆任务、起分支、写样板测试。

**北极星指标**：从需求提交到 MR 创建的中位时长 < 1 小时（不含人工审批等待）；自动化通过率（不需要人工修改代码即可走到 final_approval）≥ 60%。

## 2. 用户故事

- 作为研发，我在管理后台输入「新增一个用户注册页面」，平台自动产出 Spec 给我审，我提点意见后再次审过，等大约 30 分钟后收到 MR 链接，打开评审即可合并。
- 作为研发组长，我在钉钉群 `@chatops 新建需求 ...`（一期暂未启用），群内得到 Spec 卡片可直接审批通过/打回。
- 作为运维 / 平台管理员，我在「需求管理」页面看到所有进行中需求的当前阶段、循环计数、worktree 目录，必要时点 abort 终止。

## 3. 整体架构

### 3.1 关键设计决策

**多轮交互一律在单节点内部完成，不画图反向边**。原因：[graph-validation.ts:53-73](../../src/pipeline/graph-validation.ts#L53-L73) 的 DFS 三色 cycle 检测会拒绝任何回环边；项目里 wait_webhook、im_input 都是「单节点 interrupt 多轮循环」的成熟模式，本设计对齐之。

### 3.2 数据流

```
  用户                                        管理后台                IM 群
   │                                            │                      │
   ▼                                            ▼                      ▼
┌─────────────────────────────────────────────────────────────────────────┐
│  POST /admin/requirements   { rawInput, gitlabProject?, baseBranch? }   │
└────────────────────────────┬────────────────────────────────────────────┘
                             ▼
                 ┌─────────────────────────┐
                 │ requirements 表 INSERT  │
                 │ status = 'queued'       │
                 │   或 'spec_review'      │
                 └────────────┬────────────┘
                              │ (concurrency 检查)
                              ▼
                 ┌─────────────────────────┐
                 │ runPipeline             │
                 │  ('quick-impl', ...)    │
                 └────────────┬────────────┘
                              ▼
   ┌──────────────────────── Pipeline Graph (纯 DAG) ───────────────────┐
   │                                                                    │
   │   START                                                            │
   │     │                                                              │
   │     ▼                                                              │
   │  [1] init_branch  (script)                                         │
   │     │  · 取 worktree（QUICK_IMPL_MAX_LIVE_WORKTREES 检查）         │
   │     │  · git fetch + git checkout -b feat/qi-<id>                  │
   │     │  · 写 requirements.branch / worktree_path                    │
   │     ▼                                                              │
   │  [2] spec_review_loop  (skill_with_approval, budget=5)             │
   │     │  · 内部多轮：生成 spec.md → 双端审批 → reject 回生           │
   │     │  · 见 §6.2 + 图 2                                            │
   │     ▼                                                              │
   │  [3] plan_author  (skill_node)                                     │
   │     │  · 产 plan.md（任务粒度 ≤30min）                             │
   │     ▼                                                              │
   │  [4] dev_with_review_loop  (skill_with_review, fix_budget=2)       │
   │     │  · 内部多轮：dev-loop 写测+实现 → reviewer pass/fail          │
   │     │  · 见 §6.3 + 图 3                                            │
   │     ▼                                                              │
   │  [5] e2e_stub  (script, Phase 1 恒 pass)                           │
   │     │                                                              │
   │     ▼                                                              │
   │  [6] final_approval  (skill_with_approval, generator=null, b=3)    │
   │     │  · 不再生成产物，仅双端审批                                  │
   │     ▼                                                              │
   │  [7] mr_create  (mr_create 节点类型)                               │
   │     │  · git push + GitLab API 建 MR                               │
   │     │  · 写 requirements.mr_url + status='mr_pending'              │
   │     ▼                                                              │
   │   END                                                              │
   │                                                                    │
   └────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (任意节点失败 / over-budget)
                 ┌─────────────────────────┐
                 │ requirements.status     │
                 │ = 'failed' / 'aborted'  │
                 │ + abort_reason          │
                 └─────────────────────────┘
```

**复用模块**：[src/pipeline/graph-builder.ts:buildImInputNode](../../src/pipeline/graph-builder.ts) 单节点多轮 interrupt 模式 / [src/pipeline/graph-runner.ts:resumeFromImInput](../../src/pipeline/graph-runner.ts) resume 机制 / [src/agent/worktree/manager.ts](../../src/agent/worktree/manager.ts) worktree 抽象 / [src/agent/e2e-scenario/runner.ts](../../src/agent/e2e-scenario/runner.ts) skill 加载范式 / [src/pipeline/im-router.ts](../../src/pipeline/im-router.ts) race-winner claim 思想。

**新增模块**：`src/quick-impl/`（worktree / skill-runner / bootstrap / approval-claim） · `src/pipeline/node-types/{skill-node, skill-with-approval, skill-with-review, mr-create}.ts` · `.claude/skills/quick-impl-artifact-author/` · `web/src/pages/RequirementsPage.tsx`。

### 3.3 requirements.status 状态机推进规则

每节点自维护（不在 graph END 统一写）。原因：节点级写让前端实时看到阶段变化，调试也更直观。

| 转换 | 谁写 | 触发点 |
|---|---|---|
| `draft` → `queued` | POST /requirements handler | 创建时 concurrency 已满 |
| `draft` / `queued` → `spec_review` | POST handler 或 quick-impl-worker | 拉起 pipeline run |
| `spec_review` → `planning` | spec_review_loop 节点 exit success | approval=approved |
| `planning` → `developing` | plan_author 节点 exit success | skill 退出码 0 |
| `developing` → `reviewing` | dev_with_review_loop 进入 Step B | reviewer skill 启动前 |
| `reviewing` → `developing` | dev_with_review_loop 回 Step A | review fail + fixRound++ |
| `reviewing` → `testing` | dev_with_review_loop 节点 exit success | reviewer pass |
| `testing` → `mr_pending` | e2e_stub 节点 exit success | Phase 1 恒 pass；Phase 2 真测 pass |
| `mr_pending` → `mr_open` | mr_create 节点 exit success | GitLab API 返回 MR url |
| `mr_open` → `merged` | 详情页「标记已合并」按钮 / Phase 3 GitLab webhook | 手动 / 自动 |
| `*` → `aborted` | POST /abort handler | 用户主动终止 |
| `*` → `failed` | graph-runner terminal handler | 任意节点 onFailure='stop' 触发 + 非 abort 路径 |

写入实现：每个 quick-impl 节点 execute 入口/出口调 `setRequirementStatus(reqId, newStatus, currentStage)` 原子函数，函数内部走 `UPDATE requirements SET status=$1, current_stage=$2, updated_at=now() WHERE id=$3 AND status NOT IN ('aborted','merged','failed')`（终态不被覆盖）。

## 4. 数据模型（schema-v60）

### 4.1 requirements 表（git 分支的索引）

```sql
CREATE TABLE requirements (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,                   -- Array.from(raw_input).slice(0,30).join('')
  raw_input       TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'draft',
  branch          TEXT,                            -- feat/qi-<id>
  base_branch     TEXT NOT NULL DEFAULT 'main',
  gitlab_project  TEXT NOT NULL,
  worktree_path   TEXT,
  pipeline_run_id INT REFERENCES test_runs(id),
  current_stage   TEXT,
  spec_path       TEXT,
  plan_path       TEXT,
  spec_content    TEXT,                            -- worktree 清理前快照
  plan_content    TEXT,                            -- worktree 清理前快照
  mr_url          TEXT,
  abort_reason    TEXT,
  retry_counters  JSONB NOT NULL DEFAULT '{}'::jsonb,
                  -- {dev_completed_tasks: [0,1,2], spec_rounds: 2, fix_rounds: 1,
                  --  retry_attempt: 1, abort_pid: null}
                  -- 字段名沿用 retry_counters（不重命名以免迁移老数据），
                  -- 但实际包含进度状态、abort 信号、重试代次等
  source          TEXT NOT NULL DEFAULT 'web',     -- web | im | api
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ
);
```

**status 状态机**：`draft` → `queued`（受 concurrency 限制）→ `spec_review` → `planning` → `developing` → `reviewing` → `testing`（Phase 1 stub）→ `mr_pending`（人工审批中）→ `mr_open`（MR 已建）→ `merged` / `aborted` / `failed`。

### 4.2 requirement_approval_waiters（双端审批等待表）

仅供 `skill_with_approval` 节点的内部循环使用。每一轮 INSERT 一新行；旧行保留作历史。

```sql
CREATE TABLE requirement_approval_waiters (
  id              SERIAL PRIMARY KEY,
  requirement_id  INT NOT NULL REFERENCES requirements(id) ON DELETE CASCADE,
  pipeline_run_id INT NOT NULL,
  node_id         TEXT NOT NULL,                   -- 节点 ID（用于多 skill_with_approval 区分）
  approval_kind   TEXT NOT NULL,                   -- spec | final | escalation
  round           INT NOT NULL DEFAULT 1,
  decision_set    TEXT NOT NULL DEFAULT 'binary',  -- binary | escalation
  im_platform     TEXT,
  im_group_id     TEXT,
  context_summary TEXT,                            -- 推卡片用的上下文摘要（已模板解析）
  claimed_by      TEXT,                            -- 'im' | 'web' | NULL
  claimed_at      TIMESTAMPTZ,
  decision        TEXT,                            -- approved | rejected | force_passed | budget_extended | aborted
  reject_reason   TEXT,
  budget_delta    INT,                             -- decision=budget_extended 时管理员追加几轮
  decided_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一 (requirement_id, node_id) 同时只能有一个未 claim 的 waiter
CREATE UNIQUE INDEX idx_req_waiter_active
  ON requirement_approval_waiters(requirement_id, node_id)
  WHERE claimed_by IS NULL;

-- 详情页拉历史 / 按 round 排序需要的索引
CREATE INDEX idx_req_waiter_history
  ON requirement_approval_waiters(requirement_id, created_at);

-- 跨 pipeline_run 反查（如清理孤儿 waiter）
CREATE INDEX idx_req_waiter_run
  ON requirement_approval_waiters(pipeline_run_id);
```

**Race-winner claim**：审批节点 enter loop 时 INSERT 一行 unclaimed waiter，IM 群推卡片，Web 页面显示按钮。任一端先到先 `UPDATE ... WHERE claimed_by IS NULL RETURNING *`，更新影响行数 0 则失败（已被另一端 claim），返回幂等 `{claimed: false, by: 'im'}` 给晚到方。

### 4.3 节点类型注册（pipeline_node_types）

新增 4 条：`skill_node` / `skill_with_approval` / `skill_with_review` / `mr_create`。详细 param_schema 见 [schema-v60.sql](../../src/db/schema-v60.sql)。

### 4.4 全局配置

`system_config.quick_impl`（一期）：

```json
{
  "default_gitlab_project": "group/repo",
  "default_base_branch": "main",
  "spec_sources": ["CLAUDE.md", "docs/specs/STANDARDS.md"],
  "concurrency": 2,
  "max_live_worktrees": 10,
  "approval_im_platform": "dingtalk",
  "approval_im_group_id": "<groupId>",
  "template_version": 1
}
```

启动时 `bootstrap.ts` 比对 `template_version` 与代码常量 `QUICK_IMPL_TEMPLATE_VERSION`，不一致则重建 pipeline 模板（不影响 in-flight runs）。

### 4.5 循环状态由 LangGraph 自动持久化

skill_with_approval / skill_with_review 节点内部的 `round` / `rejectHistory` / `fixRound` / `reviewNotes` 等状态全部存在 LangGraph state，由 PostgresSaver checkpointer 自动持久化。**不新建 `node_loop_states` 表**。重启后 interrupt 等待状态可恢复（同 im_input），但 generator 中段执行不可恢复（见 §13.1）。

## 5. Pipeline 模板（启动时由 bootstrap.ts 注入）

### 5.1 模板结构

7 个节点（见 §3.2 数据流图），bootstrap.ts 用 TS 写而非 SQL 硬编码（更易演进）。

### 5.1.1 e2e_stub Phase 1 配置

```json
{
  "id": "e2e_stub",
  "stageType": "script",
  "onFailure": "stop",
  "params": {
    "command": "echo '{\"status\":\"pass (stub)\",\"e2e_url\":null,\"durationMs\":0}'",
    "outputCapture": "json_stdout"
  }
}
```

`outputCapture='json_stdout'` 让 script 节点把 stdout 解析成 JSON 写到 `steps.e2e_stub.output`。Phase 2 替换为调现有 e2e pipeline 的 wait-webhook 节点。

### 5.2 模板版本管理

```
QUICK_IMPL_TEMPLATE_VERSION = 1   // 写在 bootstrap.ts
                                  // Phase 2 e2e 接真接 → 升 2
                                  // Phase 4 改自定义模板 → 升 N

bootstrap.ts:
  读 system_config.quick_impl.template_version
  if 不存在 or 不等：
    INSERT/UPDATE pipeline 定义（沿用同一 pipeline_id，更新 graph）
    UPDATE system_config = 新版本
  else：
    skip
```

In-flight test_runs 仍用旧 graph（LangGraph state 已持久化），不受影响。

## 6. 三种新节点类型

### 6.1 skill_node（一次性产出，无循环）

**节点定义**（注意 `onFailure` / `id` / `stageType` 是节点级字段，不在 param 内）：

```json
{
  "id": "plan_author",
  "stageType": "skill_node",
  "onFailure": "stop",
  "params": {
    "skill": "quick-impl-artifact-author",
    "role": "plan-decomposer",
    "inputs": { "spec": "{{steps.spec_review_loop.output.finalArtifactPath}}" },
    "maxTurns": 40,
    "timeoutMs": 1800000,
    "commitMessage": "chore(qi): {{role}} for #{{requirement.id}}"
  }
}
```

`onFailure='stop'` 走现有 [graph-builder.ts:shouldStopAfter](../../src/pipeline/graph-builder.ts#L196) 路径，触发 skip-rest sink → graph END。terminal handler 检测到 status='running' 且没成功落到 mr_create → 写 `requirements.status='failed'`、`abort_reason=<节点失败原因>`。

输出：`{commitSha, artifactPath, summary}`。

用于 `plan_author` 节点。其余 init_branch / e2e_stub / mr_create 同样在节点级配 `onFailure='stop'`。

### 6.2 skill_with_approval（生成 + 双端审批 + reject 回生）

参数：

```json
{
  "skill": "quick-impl-artifact-author",        // 可空（generator 关闭，final_approval 用）
  "role": "spec-author",                         // 可空
  "approvalKind": "spec",                        // spec | final | escalation
  "budgetMax": 5,
  "decisionSet": "binary",                       // binary | escalation
  "imGroupId": "<groupId>",
  "imPlatform": "dingtalk",
  "contextSummary": "{{steps.dev_with_review_loop.output.lastCommitSha}} ...",
  "inputs": { "specSources": "{{config.quick_impl.spec_sources}}" },
  "maxTurns": 60,
  "timeoutMs": 1800000
}
```

`contextSummary`（generator=null 时必填）：传给 IM 卡片 + Web 详情页的审批上下文摘要。final_approval 的典型值：`"分支: {{requirement.branch}} | tasks 完成: {{steps.dev_with_review_loop.output.tasksDone}} | review 通过: {{steps.dev_with_review_loop.output.reviewLog.lastDecision}} | 改动文件数: {{...}}"`。skill-runner 在 INSERT waiter 时把模板解析后写到 waiter 行的一个新字段 `context_summary TEXT`。

输出：`{decision, rounds, finalArtifactPath, finalCommit, rejectHistory}`。

#### 6.2.1 内部循环（图 2）

```
              enter spec_review_loop
                      │
                      │  state.round = 0
                      │  state.rejectHistory = []
                      ▼
   ┌─────────── ↻ LOOP HEAD ↻ ────────────┐
   │                                      │
   │  ┌────────────────────────────────┐  │
   │  │ Step A: generator              │  │
   │  │  ─ skill-runner 启 ClaudeRunner │  │
   │  │  ─ 加载 SKILL.md +              │  │
   │  │    roles/spec-author.md        │  │
   │  │  ─ inputs.json:                │  │
   │  │    { rawInput, specSources,    │  │
   │  │      rejectHistory }           │  │
   │  │  ─ commit_artifact 落盘         │  │
   │  │  ─ 返回 {commitSha, path}      │  │
   │  │  ─ skill 关闭 → 跳过此步       │  │
   │  └─────────────┬──────────────────┘  │
   │                ▼                     │
   │  ┌────────────────────────────────┐  │
   │  │ Step B: post-approval          │  │
   │  │  ─ INSERT waiter               │  │
   │  │    (round = state.round+1)     │  │
   │  │  ─ im-notifier 推卡片           │  │
   │  │  ─ Web 详情抽屉显示按钮         │  │
   │  └─────────────┬──────────────────┘  │
   │                ▼                     │
   │     ┌───────────────────────┐        │
   │     │ interrupt(wait)       │ ◄─ graph-runner 持有 task
   │     └─────────┬─────────────┘        │
   │               │                      │
   │   IM 端 ─┐    │    ┌── Web 端        │
   │         ▼    ▼    ▼                 │
   │  ┌────────────────────────────────┐  │
   │  │ Step C: claim                  │  │
   │  │  ─ UPDATE waiter SET           │  │
   │  │    claimed_by=$1               │  │
   │  │    WHERE claimed_by IS NULL    │  │
   │  │  ─ 影响行数=1 → resume 节点    │  │
   │  │  ─ =0 → 晚到方收 false         │  │
   │  └─────────────┬──────────────────┘  │
   │                ▼                     │
   │       ┌────────┴─────────┐           │
   │       │ decision?        │           │
   │       └──────────────────┘           │
   │       │       │       │              │
   │   approve  reject  round+1≥budget   │
   │       │       │       │              │
   │       │       ▼       ▼              │
   │       │  append    ┌─────────────┐   │
   │       │  history,  │ ESCALATION  │   │
   │       │  round++   │ 子流程      │   │
   │       │  ↺ 回 A    │ (见 §6.4)   │   │
   │       │            └──────┬──────┘   │
   │       ▼                   │          │
   │   ┌──────────┐  force/+B  │          │
   │   │ exit:    │   回 LOOP  │          │
   │   │ {rounds, │            │          │
   │   │  ...}    │   abort    │          │
   │   └──────────┘   节点失败 │          │
   └──────────────────────────────────────┘
```

`final_approval` 节点 = `skill_with_approval` with `skill=null` —— 跳过 Step A，直接 Step B。reject 含义为「驳回 MR」，本次需求标 failed（不再有内容可重生）。

### 6.3 skill_with_review（生成 + AI Reviewer + fail 修复）

参数：

```json
{
  "skill": "quick-impl-artifact-author",
  "role": "dev-loop",
  "reviewerSkill": "quick-impl-artifact-author",
  "reviewerRole": "code-quality-reviewer",
  "fixBudget": 2,
  "inputs": { "plan": "{{steps.plan_author.output.artifactPath}}" },
  "maxTurns": 200,
  "reviewerMaxTurns": 30,
  "timeoutMs": 3600000,
  "reviewerTimeoutMs": 600000
}
```

`maxTurns=200` 是因为 dev-loop 跑 N 个 task × 红绿循环（每 task 最少 4 turn：写测/跑/实现/跑），N=5 时基础 20 turn，加上探索/调试余量给 200。`timeoutMs=3600000`（1h）覆盖跨多 task 总时长；reviewer 单独限 10min/30 turn 因为是只读分析。

输出：`{lastCommitSha, fixRounds, reviewLog, tasksDone}`。

- `reviewLog`: `Array<{round: number, decision: 'pass'|'fail', notes: ReviewNote[], at: string}>`，每轮 reviewer 跑完追加一条
- `tasksDone`: 已完成的 task index 数组（供 final_approval contextSummary 引用）

#### 6.3.1 内部循环（图 3）

```
              enter dev_with_review_loop
                      │
                      │  state.fixRound = 0
                      │  state.reviewNotes = null
                      ▼
   ┌────────── ↻ LOOP HEAD ↻ ──────────┐
   │                                   │
   │  ┌─────────────────────────────┐  │
   │  │ Step A: dev-loop generator  │  │
   │  │  ─ ClaudeRunner #dev         │  │
   │  │  ─ inputs:                   │  │
   │  │    {plan, reviewNotes?}     │  │
   │  │  ─ skill 内部循环 plan tasks│  │
   │  │  ─ task 完成时              │  │
   │  │    commit_artifact          │  │
   │  │    → 推 task_completed 事件  │  │
   │  │    → update                 │  │
   │  │      requirements.retry_    │  │
   │  │      counters.dev_completed │  │
   │  │  ─ 返回 {lastCommitSha,     │  │
   │  │    tasksDone}               │  │
   │  └─────────────┬───────────────┘  │
   │                ▼                  │
   │  ┌─────────────────────────────┐  │
   │  │ Step B: AI Reviewer         │  │
   │  │  ─ 启**全新** ClaudeRunner   │  │
   │  │    （零对话历史）           │  │
   │  │  ─ inputs: spec, plan,      │  │
   │  │    git diff base..HEAD      │  │
   │  │  ─ 输出 JSON:               │  │
   │  │    {decision: pass|fail,    │  │
   │  │     notes: [...]}           │  │
   │  └─────────────┬───────────────┘  │
   │                ▼                  │
   │       ┌────────┴────────┐         │
   │       │ decision?       │         │
   │       └─────────────────┘         │
   │       │              │            │
   │     pass         fail             │
   │       │              │            │
   │       │  fixRound+1 ≥ budget?    │
   │       │     │            │        │
   │       │    no           yes       │
   │       │     ▼            ▼        │
   │       │  reviewNotes   ┌────────┐ │
   │       │  = notes       │ESCAL.  │ │
   │       │  fixRound++    │子流程  │ │
   │       │  ↺ 回 Step A   │见§6.4 │ │
   │       │                └────────┘ │
   │       ▼                           │
   │   ┌──────────┐                    │
   │   │ exit:    │                    │
   │   │ {fixRds, │                    │
   │   │  ...}    │                    │
   │   └──────────┘                    │
   └───────────────────────────────────┘

注：dev-loop 子 agent 内部跑 N 个 task 是 skill 提示词层面的循环（不是图节点层面）。
    Step A 整体超时（30min）/ maxTurns 用尽 → 节点失败 → escalation。
    重启续跑：入口检查 retry_counters.dev_completed_tasks 跳过已完成 task。
```

### 6.4 escalation 子流程（复用 skill_with_approval kind=escalation）

任意 skill_with_* 节点循环用尽 budget / 关键失败时，触发 escalation：

```
触发 escalation
   │
   ▼
原节点内部 INSERT escalation waiter
   ─ approval_kind = 'escalation'
   ─ decision_set = 'escalation'
   ─ budgetMax = 1
   │
   ▼
推 IM 卡片 + Web 详情页：
   显示 4 个按钮 + 当前上下文摘要
   [force_passed] [budget_extended +N] [aborted] [rejected]
   │
   ▼
admin 决策（race-claim 与普通 binary 同机制）
   │
   ▼
分支：
  ─ force_passed     → 节点直接 exit（output 仍带 round 历史）
  ─ budget_extended  → state.budgetMax += N，回 LOOP HEAD 重生成
  ─ aborted/rejected → 节点失败 → requirements.status='aborted' → 整 pipeline END
```

escalation 不是独立节点，是 skill_with_* 节点内部的子状态。**复用同一份 waiter 表 + claim 机制**，仅 decision_set 不同。

### 6.5 mr_create 节点类型

不用 script 拼 shell（GitLab token、MR template、错误处理太复杂）。新建专用类型：

```json
{
  "key": "mr_create",
  "param_schema": {
    "gitlabProject": "{{requirement.gitlab_project}}",
    "branch": "{{requirement.branch}}",
    "baseBranch": "{{requirement.base_branch}}",
    "titleTemplate": "[quick-impl] {{requirement.title}}",
    "descriptionTemplate": "<!-- 默认 description 模板见 §6.5.1 -->",
    "labels": ["quick-impl", "auto-generated"],
    "removeSourceBranchAfterMerge": true,
    "squashCommits": false
  },
  "output_schema": {
    "mrUrl": "string",
    "mrIid": "number",
    "rebaseHint": "string|null"           // 主分支已演进时的提示文案
  }
}
```

实现 [src/pipeline/node-types/mr-create.ts](../../src/pipeline/node-types/mr-create.ts) 调 GitLab REST API（`resolveGitlabConfig()` 拿 token）。

#### 6.5.1 默认 description 模板

```markdown
> 由 ChatOps quick-impl 自动生成 · 需求 #{{requirement.id}}
> 详情页：{{base_url}}/admin/requirements/{{requirement.id}}

## 需求
{{requirement.raw_input}}

## Spec
{{spec_excerpt_300chars}}
完整：[docs/specs/qi-{{requirement.id}}.md]({{spec_blob_url}})

## 任务清单
{{plan_task_list_markdown}}

## Review 摘要
- AI Code Review: {{steps.dev_with_review_loop.output.reviewLog.lastDecision}}（修复 {{fixRounds}} 轮）
- 自动化测试: {{e2e_status}}（Phase 1 stub）

## Commits
{{commit_list_short}}

{{#if rebaseHint}}
## ⚠️ 提示
{{rebaseHint}}
{{/if}}
```

模板变量解析在 mr-create 节点 execute 时由节点自己拼装（不走 pipeline `{{vars.x}}` 通用解析，因为含 `{{#if}}` 条件块和分支 commit 列表查询）。模板字符串支持运维在 `system_config.quick_impl.mr_description_template` 覆盖。

#### 6.5.1.1 派生字段表

mr-create 节点 execute 时按下表组装本地变量空间，再做模板渲染：

| 变量 | 来源 | 算法 |
|---|---|---|
| `requirement.id` / `requirement.raw_input` | DB | SELECT FROM requirements |
| `requirement.title` | DB | 同上 |
| `base_url` | env / system_config | `process.env.PUBLIC_BASE_URL` 或 `system_config.public_base_url`（缺失走 fallback `http://localhost:3000`） |
| `spec_excerpt_300chars` | 文件 | `requirements.spec_content` 取前 300 字（worktree 已清时）；否则 `cat docs/specs/qi-<id>.md \| head -c 300` |
| `spec_blob_url` | git + GitLab | `<gitlab_url>/<gitlab_project>/-/blob/<branch>/docs/specs/qi-<id>.md` |
| `plan_task_list_markdown` | 文件 | 解析 plan.md frontmatter `tasks` 字段渲染为 markdown checklist |
| `steps.dev_with_review_loop.output.reviewLog.lastDecision` | LangGraph state | 见 §6.3 输出 schema：reviewLog 最后一条记录的 decision 字段 |
| `fixRounds` | LangGraph state | `steps.dev_with_review_loop.output.fixRounds` |
| `e2e_status` | LangGraph state | `steps.e2e_stub.output.status`（Phase 1 恒 'pass (stub)'） |
| `commit_list_short` | git | `git log <base_branch>..HEAD --pretty='- %h %s' --max-count=20` |
| `rebaseHint` | git 检测 | 见 §6.5.2 |

**重要补充**：dev_with_review_loop 输出 schema 必须明确 `reviewLog` 结构。补在 §6.3 输出：`reviewLog: [{round, decision: 'pass|fail', notes: [...]}]`，`lastDecision` 是 `reviewLog[reviewLog.length-1].decision`。

#### 6.5.2 base 分支冲突检测

节点 execute 前先 `git fetch origin <baseBranch>` + `git merge-base --is-ancestor origin/<baseBranch> HEAD`：
- 是 ancestor → 无冲突，rebaseHint=null
- 不是 ancestor → main 已演进，`git rev-list --count HEAD..origin/<baseBranch>` 拿落后数 → rebaseHint=`"base branch has advanced N commits since fork"`

不自动 rebase（Phase 1 不做），由 reviewer 在 GitLab 上处理。

## 7. Skill 设计（底座 + 4 个 role）

```
.claude/skills/quick-impl-artifact-author/
├── SKILL.md                          # 底座
└── roles/
    ├── spec-author.md
    ├── plan-decomposer.md
    ├── dev-loop.md                   # Phase 1 内嵌 test + tdd 单循环
    └── code-quality-reviewer.md      # Phase 1 含简版 spec 合规
```

### 7.1 底座 SKILL.md（节选要点）

```markdown
---
name: quick-impl-artifact-author
description: 快速实现流水线产物作者，按 role 参数生成 spec/plan/code/review 产物并 commit
trigger: 由 ChatOps quick-impl pipeline 的 skill_* 节点触发
---

# 底座契约

1. 输入由 skill-runner 注入到 cwd（当前 worktree）下的 `.qi-context/` 目录：
   - `.qi-context/role.md` —— role 提示词
   - `.qi-context/inputs.json` —— 模板解析后的输入；**额外固定包含**：
     - `requirement_id`（== env QI_REQUIREMENT_ID，做交叉校验）
     - `worktree_path`、`branch`、`base_branch`
     - `retry_counters`（dev-loop 用 dev_completed_tasks 跳过已完成 task）
     - `artifact_path`（节点指定的产物落盘位置）
   - `.qi-context/standards/` —— spec_sources 文件软链
2. 产物路径必须用 inputs.json 给的 `artifact_path`，禁止自行决定路径
3. 提交必须通过 `commit_artifact` MCP 工具，禁止通过 bash 直接 git commit
4. 输出契约：会话**结束前最后一条消息**必须含一个 ```json ...``` fenced block。skill-runner 解析算法（按优先级）：
   - (a) 抓最后一条消息里**最后一个** ```json``` 围栏 block，JSON.parse
   - (b) 失败 → 抓最后一条消息里最后一个平衡 `{...}` 段尝试 JSON.parse
   - (c) 都失败 → 节点失败 + ClaudeRunner stdout/stderr 全文落 `logs/quick-impl/qi-<id>/<nodeId>-<round>.log`
   解析成功的 JSON Schema：
   ```json
   {
     "summary": "string (必填，≤500 字)",
     "decision": "pass|fail",                // 仅 reviewer role 必填
     "notes": [{"severity":"warn|error","msg":"...","file":"...","line":123}],
     "tasksDone": [0, 1, 2]                   // 仅 dev-loop role 必填
   }
   ```
   skill-runner 用 zod 校验 schema，校验失败按 (c) 处理。
5. 严禁 push、merge、checkout、删除任何文件之外的 git 操作
6. 多任务循环（dev-loop / plan-decomposer 用）：
   - **plan-decomposer** 必须输出 dense 0..N-1 索引（不能跳号），任务列表元数据写在
     plan.md frontmatter `tasks: [{index:0,title:...}, {index:1,...}]`
   - **dev-loop** 每完成一个 task 调一次 commit_artifact，task_index 必须 dense 递增
     （不允许 0,1,3 跳过 2）；handler 校验非 dense → reject 调用
   - phase 参数（'red'|'green'）：phase='green' 时 handler 推 task_completed 事件 +
     update `requirements.retry_counters.dev_completed_tasks`；phase='red' 不更新（红测试还没绿，不算完成）
```

### 7.2 各 role manifest（节选要点）

**spec-author.md**：读 raw_input + spec_sources，结合 grep 出的代码现状，产出含「目标 / 用户故事 / 接口 / 数据模型 / 验收标准 / 风险」的 spec.md。如果 inputs.rejectHistory 非空，必须在 Spec 顶部「修订记录」区段引用每条 reason 并说明本次改了什么。

**plan-decomposer.md**：读 spec.md，输出任务列表，每条任务 ≤ 30 分钟、含验收测试描述、标注 deps。任务粒度以「能写一个失败测试」为最小单位。任务编号 0..N-1（与 retry_counters.dev_completed_tasks 对应）。

**dev-loop.md**：读 plan.md + 入口检查 `retry_counters.dev_completed_tasks` 跳过已完成 task；循环每个未完成 task：(a) 写失败测试 → commit_artifact(taskIndex=i, phase='red')；(b) 跑测试确认红；(c) 实现源码 → commit_artifact(taskIndex=i, phase='green')；(d) 跑测试确认绿。任一步异常立即停。如果 inputs.reviewNotes 非空，按 notes 修复（视为「带评审反馈的重写」，可能涉及多个旧 task 的代码）。

**code-quality-reviewer.md**：在隔离 ClaudeRunner 中跑（不带前几节点的对话历史）；读 spec.md + plan.md + `git diff base_branch...HEAD`；按「Spec 合规 / 单测覆盖 / 命名清晰 / 边界处理 / 错误处理」5 维输出 pass/fail + notes。

## 8. Worktree 与 Git 流程

### 8.1 路径与生命周期

```
/tmp/quick-impl/qi-<id>/         # 每需求独占 worktree
  ├── .git                       # 链接到主仓
  ├── feat/qi-<id>               # 当前分支
  ├── docs/specs/qi-<id>.md
  ├── docs/plans/qi-<id>.md
  ├── tests/...
  ├── src/...
  └── .qi-context/               # skill 输入 staging（每个 skill 节点重写）
```

- 首次 `init_branch` 节点：fork 自 `origin/<base_branch>`（fresh fetch）
- 中间节点：在同一 worktree 内 commit
- pipeline 结束（merged/aborted/failed）→ 30 分钟后由 cleanup hook 移除 worktree（保留远端分支）
- 清理前：把 spec.md / plan.md 内容写回 `requirements.spec_content` / `plan_content` 列保存
- 启动时若发现 worktree 存在但 requirement 已结束 → 立即清理
- **测试 / 开发隔离**：`WORKTREE_BASE_QI` env 覆盖根路径；测试用 `/tmp/quick-impl-test-<pid>/` 防多开发者本地撞同目录

#### 8.1.1 Cleanup 与活跃进程的竞态防护

worktree 内放一个 lockfile：`/tmp/quick-impl/qi-<id>/.qi-lock`，内容为当前 ClaudeRunner 子进程的 pid + 启动时间。

- skill-runner 启 ClaudeRunner 前 **写 lockfile**（exclusive flock）
- ClaudeRunner 退出后（成功 / 失败 / SIGTERM）**删 lockfile**
- cleanup hook 入口检查：
  1. lockfile 存在 → 读取 pid，`kill -0 <pid>` 检查进程存活
     - 存活 → 跳过本次 cleanup（下个 tick 再试）
     - 不存活 → lockfile 是孤儿（前次崩溃残留），删 lockfile 后继续
  2. lockfile 不存在 → 安全删 worktree

abort 流程同样依赖 lockfile：POST /abort 把 pid 通过 lockfile 读到，向其发 SIGTERM；轮询 lockfile 消失（最多 60s）后写 status='aborted'。

### 8.2 Git cache 与鉴权

push / fetch / clone 走 [src/config/git-auth.ts](../../src/config/git-auth.ts) `injectGitlabAuth`，与现有 worktree-manager 一致。

**Cache 路径独立于 e2e / bug-analysis**：`~/.chatops-repos-qi/<projectSlug>/` 而非 `~/.chatops-repos/`，避免两个 worktree 系统同时操作 `.git/index.lock` 冲突。env 覆盖：`QI_REPO_CACHE_BASE`。

### 8.3 Branch 命名

Phase 1：`feat/qi-<id>`（不带语义 slug，避免引入中文转拼音依赖）。retry 触发新分支：`feat/qi-<id>-r2`、`-r3`。Phase 4 加语义 slug。

### 8.4 commit_artifact MCP 工具

#### 8.4.1 工具暴露机制：专用 mcp-server-quick-impl 子进程

skill-runner 启 ClaudeRunner 时不调主 [src/agent/mcp-server.ts](../../src/agent/mcp-server.ts)，而是启**专用** [src/quick-impl/mcp-server.ts](../../src/quick-impl/mcp-server.ts) 子进程。专用 server 只 register `commit_artifact` 一个工具，不 register 主 server 的 deploy / rollback / db_update / script 等。

ClaudeRunner 接口扩展（[src/agent/claude-runner.ts](../../src/agent/claude-runner.ts)）：

```typescript
interface ClaudeRunnerOptions {
  // ... existing fields
  mcpServerPath?: string                // 默认指向主 mcp-server.ts；quick-impl 指向 quick-impl/mcp-server.ts
  extraEnv?: Record<string, string>     // 注入到子进程的额外 env
}
```

主 server 路径不动；现有 e2e / session-manager 等调用方默认值兼容（可选参数，未传 = 用主 server）。**不实现「主 server 按 env 过滤工具」机制**——侵入性大，Phase 2 再评估。

#### 8.4.2 子进程生命周期

per-skill-invocation：每次 skill_runner.run() 启一个 mcp-server-quick-impl 子进程，跑完即退。**不共享长生命周期实例**——隔离干净，进程崩溃影响面小。

#### 8.4.3 工具签名

```typescript
// commit_artifact MCP tool
inputSchema: {
  path: string,            // 相对 worktree 的产物路径（e.g. "docs/specs/qi-5.md"）
  message: string,         // commit message
  body?: string,           // commit body（可选，多行 description）
  task_index?: number,     // dev-loop 用，0..N-1
  phase?: 'red' | 'green'  // dev-loop 用，phase='green' 触发 task_completed 事件
}

// 返回
output: { commitSha: string, filesChanged: number }
```

#### 8.4.4 校验（handler 启动时读 env 进闭包）

- env `QI_REQUIREMENT_ID` 必填，缺失直接 reject
- cwd 必须在 `/tmp/quick-impl/qi-<QI_REQUIREMENT_ID>/`（防路径穿越）
- 当前分支匹配 `feat/qi-<QI_REQUIREMENT_ID>(-r\d+)?$`（防写错分支）
- commit message 非空、≤ 200 字符、不含 `[skip ci]` `[ci skip]` 等逃逸字符
- 改动文件不写 `.git/`、`.github/`、`.gitlab-ci.yml`、`.env*`、`*.pem`、`*.key`（敏感文件白名单反查）
- 单次 commit 改动文件数 ≤ 50（防失控批量）
- task_index 与 phase 同时给或同时不给；phase='green' 时由 handler 同步 update `requirements.retry_counters.dev_completed_tasks` 并发布 pipeline_run_event

## 9. API 接口

```
POST   /admin/requirements
       body: { rawInput, title?, gitlabProject?, baseBranch? }
       → 201 { id, status, pipelineRunId }
       # 不传 gitlabProject 用 system_config.quick_impl.default_gitlab_project
       # 没配 default 时 → 400

GET    /admin/requirements?status=&page=&size=
       → 200 { items: [...], total }

GET    /admin/requirements/:id
       → 200 { ...row, stages: [...], approvals: [...], loopStates: [...] }
       # loopStates 来自 LangGraph state stepOutputs，含 round / rejectHistory 等

POST   /admin/requirements/:id/abort           body: { reason }
POST   /admin/requirements/:id/retry           body: { fromStage }
POST   /admin/requirements/:id/approvals/:waiterId
       body: { decision, reason?, budgetDelta?, source: 'web'|'im' }
       → 200 { claimed: bool, by: 'im'|'web' }
       # decision ∈ {approved, rejected, force_passed, budget_extended, aborted}
       # decision_set='binary' 时只接受前 2 个，escalation 时接受全 5 个
       # 服务端按 waiter.decision_set 校验

GET    /admin/requirements/:id/events           SSE（Phase 1 可先 polling）
```

权限：所有端点要求 admin session（复用现有 admin auth），不细分角色。Phase 2 增加 RBAC。

## 10. 前端页面

新页面 [web/src/pages/RequirementsPage.tsx](../../web/src/pages/RequirementsPage.tsx)：

- 顶部：「新建需求」按钮 + 状态筛选 Tag
- 列表表格：id / title / status / branch（点开 GitLab）/ current_stage / MR 链接 / 创建人 / 创建时间
- 行点击 → 详情抽屉

详情抽屉 [web/src/pages/RequirementDetailDrawer.tsx](../../web/src/pages/RequirementDetailDrawer.tsx)：

- 顶部：raw_input 全文 + 状态 + abort 按钮
- Timeline：每个 stage 的 status / 时长 / 输出 snapshot 摘要
  - skill_with_approval 节点显示当前 round / max budget / rejectHistory 时间线
  - skill_with_review 节点显示 fixRound / 最近 reviewNotes
- Spec / Plan 预览 Tab：从 worktree 读 `docs/specs/qi-<id>.md` 文件渲染 markdown（worktree 已清则读 requirements.spec_content）
- 待审批面板：当 status ∈ {spec_review, mr_pending, escalation} 时显示按钮组
  - binary：approve / reject（reject 弹原因输入框）
  - escalation：force_passed / budget_extended (+N 输入) / aborted / rejected
- 循环计数：spec_reject_history 等显示

「新建需求」表单字段：
- 一句话需求（textarea，必填，长度 5..500）
- 标题（自动 `Array.from(rawInput).slice(0,30).join('')`，可改）
- 项目（一期：只读展示 default_gitlab_project；不传则后端用默认）
- 基线分支（默认 main，可改）

数据获取策略 Phase 1：
- 列表：5s polling + 提交后 invalidate 立即重拉
- 详情：3s polling（接近 interrupt 时手动点刷新）
- Phase 3 升级 SSE

导航菜单加「需求管理」一项，路由 `/admin/requirements`。

### 10.1 节点类型不暴露给画布编辑器（Phase 1）

`skill_node` / `skill_with_approval` / `skill_with_review` / `mr_create` 这 4 个新类型 Phase 1 仅由 quick-impl 模板使用，不让用户在画布抽屉新建。前端实现：[web/src/pipeline-canvas/panels/NodeInspector.tsx](../../web/src/pipeline-canvas/panels/NodeInspector.tsx) 的节点类型 Select 数据源加过滤项 `nodeType.category !== 'quick_impl_only'`，schema-v60 在 INSERT 这 4 个类型时设 `category='quick_impl_only'`。

由此**不需要**在 [src/pipeline/dryrun-runner.ts](../../src/pipeline/dryrun-runner.ts) 注册副作用——画布永远画不出这些节点，dry-run 自然不会触发它们。Phase 4 开放给画布时再补 dryrun 注册。

quick-impl pipeline 本身在 test_pipelines 列表里也标 `is_system=true`（schema-v60 给 test_pipelines 加 `is_system BOOLEAN NOT NULL DEFAULT FALSE` 若不存在；命名沿用 v4 [capabilities.is_system](../../src/db/schema-v4.sql) 先例），管理后台「Pipeline 管理」页过滤掉 `is_system=true`，避免运维误编辑。

## 11. 资源约束与配额

| 资源 | 上限 | 配置项 | 超限行为 |
|---|---|---|---|
| 同时活跃 requirements | 2 | `system_config.quick_impl.concurrency` | 新需求 status=`queued`，活跃数下降时由 quick-impl-worker 拉起 |
| 同时活跃 worktree | 10 | `system_config.quick_impl.max_live_worktrees` | init_branch 节点失败 |
| 单 skill_* 节点超时 | 30 min | param.timeoutMs | 节点失败 → escalation |
| 单 skill_* 节点 maxTurns | 40 | param.maxTurns | 节点失败 → escalation |
| spec_review_loop budget | 5 | param.budgetMax | escalation |
| final_approval budget | 3 | param.budgetMax | escalation |
| dev_with_review_loop fix budget | 2 | param.fixBudget | escalation |

`quick-impl-worker` 复用现有 [src/pipeline/scheduler.ts](../../src/pipeline/scheduler.ts) 的 cron tick：每个 tick 检查 (a) 是否有 queued requirement 可拉起 (b) 是否有 finished requirement 的 worktree 可清理。**不新增独立进程**。

## 12. 失败与恢复

### 12.1 进程崩溃恢复

LangGraph PostgresSaver 已经持久化每个节点的 LOOP 状态（round, rejectHistory）。重启后：
- skill_with_* 节点处于 interrupt 等待 → 直接 resume 继续等
- skill_with_* 节点处于 generator 中段 → ClaudeRunner 子进程已死，无法续跑；标记节点失败 → escalation 自动触发，admin 选择
- 用户在 escalation 选 `budget_extended` 等于强制重新进入 loop（重跑 generator）

### 12.2 dev_loop 中段重启

- skill 入口检查 `requirements.retry_counters.dev_completed_tasks` 已完成 task 列表
- 已完成的 task 跳过，从下一个 task 续跑
- 任务完成事件由 `commit_artifact` handler 在 phase='green' 时发出（含 taskIndex），handler 同步 update retry_counters
- skill 提示词约定 phase='red' 时不更新 retry_counters（红测试还没绿，不算完成）

### 12.3 Skill 输出格式异常

skill-runner 解析末条消息 JSON 失败：节点失败 → escalation。日志保留 ClaudeRunner stdout/stderr 供排查。

### 12.4 GitLab push 失败

push 失败（认证/网络）→ mr_create 节点失败 → escalation。手动 retry 走 mr_create 重做。

### 12.5 Branch 冲突

主分支演进导致 MR 冲突：Phase 1 不自动 rebase，由 reviewer 在 GitLab 上解决。但 mr_create 节点入口先做一次 `git merge-base` 检测，主分支已变 → 在 MR description 顶部加「⚠️ base branch has advanced N commits since fork」提示。

### 12.6 MR 合并后状态回写

Phase 1：详情页提供「标记为已合并」按钮，手动触发 status='merged'。Phase 3 接 GitLab webhook 自动回写。

### 12.7 Abort 流程

POST `/admin/requirements/:id/abort` body `{reason}`：

```
1. requirements.status = 'aborting' + abort_reason 写库（确保后续节点不会推进）
2. 调 porygon.abort(backend, sessionId)（一行 API）：底层 EphemeralProcess.terminate()
   先发 SIGTERM、超时后 SIGKILL；同时活跃的 AbortController.abort() 触发
3. 通过 runRegistry 取该 run 的 AbortController 调 .abort()，
   LangGraph 的 graph.stream() 因 RunnableConfig.signal abort 抛错跳出
4. 若节点正处于 interrupt 等待（无 ClaudeRunner 活跃）：同 controller.abort() 也能跳出 stream loop
5. pipeline 节点抛错 → 路由到 onFailure='stop' → END
6. terminal handler 检测 status='aborting' → 写 status='aborted'
7. 30 min 后 worktree cleanup（按 §8.1.1 流程；lockfile 由 ClaudeRunner exit 自动清）
8. 所有未 claim 的 waiter UPDATE 设 claimed_by='abort', decision='aborted'（解 UNIQUE INDEX 让 retry 不冲突）
```

实现要点（Day 0 验证已确认 LangGraph 原生支持，**不需要新增 graph-runner.cancel() 主路径接口**）：

- `streamGraph(ctx, input, signal?: AbortSignal)` 加一个 optional 参数
- runRegistry 改为 `Map<runId, { controller: AbortController, ... }>`
- POST /abort 入口：`runRegistry.get(runId)?.controller.abort()` 即可触发链路收尾
- porygon 子进程 SIGTERM/SIGKILL 由 [Porygon.abort(backend, sessionId)](../../node_modules/.pnpm/@snack-kit+porygon@0.10.0/node_modules/@snack-kit/porygon/dist/index.d.ts) 内置实现

回归面缩小：从「新增主路径接口」缩到「给 streamGraph 加 optional 参数 + runRegistry 类型变更」。

### 12.8 Retry 流程

POST `/admin/requirements/:id/retry` body `{fromStage}`：

```
1. 校验：requirements.status ∈ {failed, aborted}（运行中 / 已合并不允许 retry）
2. 校验：fromStage ∈ {spec_review_loop, plan_author, dev_with_review_loop, e2e_stub, final_approval, mr_create}
3. retry_counters.retry_attempt += 1（记次）
4. 决定新分支名：原 branch='feat/qi-5' → 新 branch='feat/qi-5-r2'（按 retry_attempt 编号）
5. 起新 worktree（独立路径 /tmp/quick-impl/qi-5/r2/，旧的保留 30 min 后清）
6. retry_counters.dev_completed_tasks 处理：
   - fromStage 在 dev_with_review_loop 之前 → 清空（重新开发）
   - fromStage = dev_with_review_loop → 清空（视为想重做开发）
   - fromStage 在 dev_with_review_loop 之后 → 保留（保留进度）
7. 老 unclaimed waiter UPDATE claimed_by='retry', decision='aborted'
8. 老 pipeline_run 状态置 'aborted'（如果还在 running，先走 §12.7 abort 流程）
9. status = 'spec_review' / 对应 fromStage 起始状态
10. 创建新 pipeline_run，从 fromStage 节点起跑（pipeline 模板支持指定 entry node，
    或 graph-runner 加 startFromNode 参数；两条路 Phase 1 选「graph-runner 加 startFromNode」更简）
11. 详情页时间轴新加一条「Retry r2 starting from <fromStage>」分隔
```

**关键决策**：retry 创建新 pipeline_run，old 保留作历史。详情页 timeline 显示 r1 / r2 折叠分组。

新分支策略保证：旧分支（含老 commit）在远端保留，可对照看；reviewer 评 MR 时只关心最新 r2 分支。

## 13. 测试策略

### 13.1 单元测试（不依赖 DB）

- `skill-runner.test.ts` —— mock ClaudeRunner，断言 SKILL.md + role 拼接正确、JSON 输出解析、超时处理、QI_REQUIREMENT_ID env 注入
- `worktree-manager.test.ts` —— mock fs/git，断言路径隔离、TTL 行为、与 e2e worktree 不冲突
- `commit-artifact-handler.test.ts` —— cwd / branch / 文件路径校验、改动数上限
- `approval-claim.test.ts` —— claim race（IM 先 / Web 先 / 同时）、budget 上限触发 escalation、reject reason 注入

### 13.2 集成测试（testcontainer postgres）

- `requirements-repository.test.ts` —— 状态转换、retry_counters bump
- `skill-with-approval-loop.test.ts` —— generator → claim → reject → re-generate → approve 退出；budget exceed → escalation；escalation budget_extended → 回 LOOP；escalation aborted → 节点失败
- `skill-with-review-loop.test.ts` —— fail → re-generate → pass；fail 满 fix_budget → escalation
- `dev-loop-resume.test.ts` —— 中段崩溃恢复，已完成 task 跳过
- `quick-impl-pipeline.test.ts` —— 端到端：mock skill 输出 + mock GitLab API，POST 创建 → spec_review_loop 多轮 → ... → mr_create stub → status='mr_pending'
- `pipeline-graph-skill-types.test.ts` —— graph-builder switch 加 3 种 case 后回归现有 llm_agent / im_input 节点

### 13.3 前端

- `RequirementsPage.test.tsx` —— 列表渲染、新建表单字段校验、状态筛选

### 13.4 不在 Phase 1 测试范围

- 真实 ClaudeRunner 子进程
- 真实 GitLab push / MR
- 真实钉钉 callback 路径

## 14. 安全考量

1. **commit_artifact 工具沙箱化**：cwd 必须 ∈ `/tmp/quick-impl/qi-<QI_REQUIREMENT_ID>/`，分支必须 `feat/qi-<QI_REQUIREMENT_ID>(-r\d+)?$`，否则拒绝
2. **专用 MCP server 隔离**：skill_* 子 agent 启的是 mcp-server-quick-impl 子进程，只 register `commit_artifact`，物理上看不到 deploy / rollback / db_update / script
3. **审批端点幂等**：claim 失败返回 200 但 `claimed: false`，避免双击重试乱状态
4. **GitLab token 不落 worktree**：远端 URL 的 token 通过 `injectGitlabAuth` 临时注入，不写 `.git/config`
5. **Spec sources 路径穿越**：`spec_sources` 数组项校验在 repo 内（不能 `../../etc/passwd`）
6. **IM callback 鉴权**：审批 callback 走 IM adapter 已有签名验证；`/admin/requirements/:id/approvals/:waiterId` 端点同时校验 admin session（Web 路径），IM adapter 转发时带 source='im' 跳过 session 校验但要求 adapter 已验签
7. **escalation budget_extended 输入校验**：admin 输入的 N 限制在 [1, 5]，避免无限延长

## 15. IM 卡片与 Web 审批面板内容

### 15.1 spec_review_loop / final_approval IM 卡片（binary）

```
┌──────────────────────────────────────────┐
│ 🔍 ChatOps Quick-Impl 审批 [需求 #5]      │
├──────────────────────────────────────────┤
│ 标题：新增用户注册页面                    │
│ 阶段：spec 审批 (轮次 2/5)                │
│ 创建人：@xxx                              │
│                                          │
│ {{contextSummary}}                       │
│ （spec 节点为空时由 generator 输出       │
│   summary 自动填）                       │
│                                          │
│ 上次驳回原因（如有）：                    │
│ > xxx                                    │
│                                          │
│ 📄 完整 Spec：[详情链接]                  │
│                                          │
│  [✅ 通过]  [❌ 驳回（输入原因）]          │
└──────────────────────────────────────────┘
```

按钮 callback URL：`{base_url}/admin/requirements/<id>/approvals/<waiterId>` POST `{decision, reason?, source: 'im'}`。卡片更新（如果钉钉/飞书支持）：claim 后改文案为「已被 Web 端处理」并禁用按钮；不支持则晚到方点按钮收到 `{claimed: false, by: 'web'}` 后弹 toast。

### 15.2 escalation IM 卡片

```
┌──────────────────────────────────────────┐
│ ⚠️ Quick-Impl Escalation [需求 #5]        │
├──────────────────────────────────────────┤
│ 节点：spec_review_loop                    │
│ 触发原因：5 轮审批均被驳回                │
│                                          │
│ 最近 3 轮驳回摘要：                       │
│ - 轮 3: ...                              │
│ - 轮 4: ...                              │
│ - 轮 5: ...                              │
│                                          │
│  [🚀 强制通过]  [⏰ 延长 budget]          │
│  [🚫 终止需求]  [↩️ 驳回（同 reject）]     │
└──────────────────────────────────────────┘
```

钉钉/飞书 IM 卡片不支持原生数字输入；`budget_extended` 在 IM 端固定按 `system_config.quick_impl.escalation_default_budget_delta`（默认 2）追加；要自定义 N 必须走 Web 详情面板。

### 15.3 Web 审批面板（详情抽屉内）

binary：两个 Ant Design Button + Modal 输入 reason。
escalation：四个 Button；budget_extended 弹 InputNumber [1, 5]。

提交后的请求按 §9 接口发送，响应 `{claimed: true|false}` 决定是否 invalidate 详情数据。

### 15.4 通知策略

- pipeline 进入 spec_review / final_approval / escalation：推 IM 卡片 + Web Toast 通知（当详情页打开时）
- pipeline 失败 / 完成：仅推 IM @ 创建人

### 15.5 卡片大小限制与字段截断

钉钉 markdown 卡片 ~12KB，飞书 ~30KB。统一按 8KB 总长 + 单字段 1KB 限制（保留 IM 端到端余量）。

**字段截断策略**（im-notifier 拼卡片时执行）：

| 字段 | 上限 | 超出处理 |
|---|---|---|
| `contextSummary` | 1024 字符 | 末尾加 `… [完整内容见详情页]` |
| 单条 `rejectReason` | 512 字符 | 截断 + `…` |
| `rejectHistory` | 最近 3 条 | 旧的合并为「+ N 条更早的驳回」 |
| 整卡 markdown | 8192 字符 | 触发兜底：替换正文为「内容超长，请到 Web 详情页查看」+ 仅保留按钮 |

### 15.6 IM 推送失败与降级

im-notifier `send(card)` 失败时：

```
attempt 1 失败 → 等 5s
attempt 2 失败 → 等 15s
attempt 3 失败 → 等 30s
attempt 4 失败 → 降级模式：
  · 只创建 Web waiter（已经创建）
  · 写 pipeline_run_events: qi.im_delivery_failed
  · skill_with_approval 节点继续 interrupt 等 Web 决策（不视为节点失败）
  · 详情页 banner 显示「IM 通知发送失败，请在此审批」
  · admin 集中通知群另发一条文本告警（独立通道，不阻塞）
```

避免 escalation 自循环（escalation 卡片同样可能 IM 推失败）：escalation 卡片走同一降级路径，4 次失败仅 Web 可决策。

## 16. 可观测性与审计

### 16.1 pipeline_run_events 新事件类型

复用现有 [pipeline-b 的 event bus](../../src/agent/e2e-event-bus)（Phase 3 SSE 用）。Phase 1 仍然写入 events 表，前端 polling：

| event_type | payload | 触发点 |
|---|---|---|
| `qi.requirement_created` | `{id, source, gitlabProject}` | POST 创建 |
| `qi.queued` | `{id, queueDepth}` | concurrency 满拉队 |
| `qi.stage_entered` | `{id, stageName}` | 节点 enter |
| `qi.skill_started` | `{id, role, round?, fixRound?}` | skill-runner 启 ClaudeRunner |
| `qi.skill_finished` | `{id, role, summary, durationMs, tokensUsed?}` | ClaudeRunner 退出（含失败） |
| `qi.commit_artifact` | `{id, taskIndex?, phase?, commitSha, filesChanged}` | commit_artifact handler |
| `qi.approval_posted` | `{id, kind, round, waiterId}` | INSERT waiter |
| `qi.approval_decided` | `{id, kind, decision, by, decidedBy, reason?, budgetDelta?}` | claim 成功 |
| `qi.escalation_triggered` | `{id, nodeId, cause}` | budget exhausted / generator failed |
| `qi.mr_created` | `{id, mrUrl, mrIid}` | mr_create 节点成功 |
| `qi.terminal` | `{id, finalStatus, abortReason?}` | pipeline END |

### 16.2 日志

skill-runner 把 ClaudeRunner stdout/stderr 写入 `logs/quick-impl/qi-<id>/<nodeId>-<round>.log`，**保留 7 天**。失败时详情页提供「下载日志」入口（admin only）。

### 16.3 Token 用量监控

ClaudeRunner 退出时从 porygon `AgentResultMessage` 直接取 `inputTokens` / `outputTokens` / `costUsd`（[Day 0 验证 #2](../quick-impl-day0-validation.md) 已确认 porygon 0.10.0 暴露这些字段），写入 `qi.skill_finished` event 的 `tokensUsed` 字段；详情页累加显示「本次需求总 token 消耗 / 累计 cost」。Phase 1 不限流，仅展示。

## 17. 服务启动顺序

server.ts 启动主路径在现有的基础上插入 quick-impl 初始化，**严格顺序**：

```
1. config.ts 加载（已有）
2. DB 连接 + migrate.ts 跑迁移（已有）— 保证 v60 schema 已 apply
3. 加载 system_config（已有）— 包括 quick_impl 配置块
4. ApprovalGate / IMAdapters 初始化（已有）
5. 【新】src/quick-impl/index.ts initialize：
   5a. 校验 system_config.quick_impl.default_gitlab_project（缺失只 warn 不阻塞）
   5b. bootstrap.ts pg_advisory_lock + 比对 template_version + 重建模板（如需）
   5c. 注册 commit_artifact event listener（监听 task_completed → update retry_counters）
   5d. 注册 IM callback path /admin/requirements/.../approvals/...（adapter 中转用）
6. Pipeline scheduler 启动（已有）+ 【新】挂 quick-impl-worker hook：
   6a. 每 tick 检查 queued requirement 拉起一个（受 concurrency 限制）
   6b. 每 tick 检查需 cleanup 的 worktree（terminal 后 30min）
7. Fastify 路由注册（已有）+ 【新】admin/routes/requirements.ts
8. server.listen
```

启动失败模式：
- v60 migrate 失败 → 启动失败（已有迁移机制）
- bootstrap pg_advisory_lock 拿不到（HA 多实例并发）→ 等 30s 重试 3 次，仍失败 → 启动失败（保证只有一个实例改 template）
- system_config 缺失 default_gitlab_project → 启动 OK，但首个 POST /admin/requirements 报 400

### 17.1 Day 0 验证清单（开工第一天必做）

下列依赖**已于 2026-05-07 完成验证**（[docs/quick-impl-day0-validation.md](../quick-impl-day0-validation.md)），全部通过，无需走 Plan B：

| 验证项 | 结论 | 依据 |
|---|---|---|
| `@snack-kit/porygon` 暴露 ClaudeRunner kill 接口 | ✅ `Porygon.abort(backend, sessionId)` + `EphemeralProcess.terminate()` 多层暴露，自动 SIGTERM→SIGKILL | porygon@0.10.0 d.ts |
| porygon 暴露 token 计数 | ✅ `AgentResultMessage` 含 `inputTokens` / `outputTokens` / `costUsd` / `durationMs` | 同上 |
| LangGraph 运行中 cancel 支持 | ✅ 原生 `RunnableConfig.signal: AbortSignal`，`graph.stream(input, {signal})` 即可 | @langchain/core@1.1.40 |
| pipeline 主表实际表名 | ⚠️ 表名 `test_pipelines`（非 `pipelines`），run 表 `test_runs`（非 `pipeline_runs`），文档已全文修正 | schema-v3.sql |
| 现有 system_managed 类标记 | ⚠️ test_pipelines 没有；但 capabilities.is_system 是 v4 已有先例，schema-v60 加 `is_system` 与之一致 | schema-v4.sql |

## 18. 实施分期

### Phase 1（最小可用，目标 2-3 周）

| Day | 工作 |
|---|---|
| 1-2 | schema-v60 + repositories + migration tests |
| 3-4 | worktree manager + skill-runner（mock ClaudeRunner 跑通） |
| 5-6 | approval-claim + 双端 race 单测 |
| 7-9 | 三个新节点类型实现（skill_node / skill_with_approval / skill_with_review）+ graph-builder dispatch |
| 10 | mr_create 节点类型 + escalation 子流程 |
| 11-12 | bootstrap pipeline 模板 + e2e_stub + scheduler hook（queued worker + worktree cleanup） |
| 13-14 | admin 路由 + 前端列表页 + 详情抽屉 |
| 15-16 | 4 个 role manifest + SKILL.md + 端到端跑通 |
| 17 | 集成测试 + docs/smoke-quick-impl.md |

**出口标准**：管理后台一句话需求 → spec 多轮审批 → 自动开 MR；reject 循环、escalation 各分支跑通；进程重启 interrupt 能恢复。

### Phase 2

- approval_requests 加 `object_type` 字段，把 RequirementApproval 合并进主 ApprovalGate
- spec-compliance reviewer skill 拆出（独立子 agent）
- e2e_stub 替换为现有 e2e pipeline 调用 + 修复循环
- spec-author 调 prd-review skill 自评一轮
- skill 内容 hash 写入 snapshot（提示版本可追溯）

### Phase 3

- 钉钉 / 飞书 `@bot 新建需求 <文本>` 入口
- 全局配额 / spec_sources 配置 UI
- 详情页 SSE 实时 timeline
- GitLab webhook 自动回写 status='merged'

### Phase 4

- 多 GitLab 项目支持（项目下拉）
- 自定义 pipeline 模板（画布编辑 quick-impl 变体）
- 4 个新节点类型暴露给画布 + dryrun-runner 注册副作用
- 中文转拼音 slug
- 失败需求复盘报告自动生成
- per-requirement Claude token + duration 报表

## 19. 已知限制与未来工作

1. **Plan 任务级进度不可见**：dev_with_review_loop 单节点内部循环 N 个 task，画布上只看到一个节点。Phase 1 通过 `commit_artifact` task_completed 事件 + 详情页 timeline 缓解，但仍非画布原生。Phase 4 考虑 dynamic fan-out。
2. **Skill 提示版本不可追溯**：节点启动时加载 SKILL.md 当前内容，不记录版本。Phase 2 加 skill content hash 写入 snapshot。
3. **Skill 文件 mid-flight reload**：一个需求多节点之间，运维改了 dev-loop.md 重启服务，下个节点会用新 skill 内容。Phase 1 不锁版本，可能导致同一需求前后节点提示不一致。Phase 2 在节点启动时把 skill 文件 hash + 内容 snapshot 一起写入 stepOutputs，保证一致性。
4. **Generator 中段崩溃不可续跑**：仅靠 escalation 让 admin 决策。
5. **Reject reason 历史无截断**（DB 层）：history 数组无上限。Phase 2 截至最近 3 条 + 摘要。IM 卡片端已有截断（§15.5）。
6. **不支持中途修改需求文本**：raw_input 不可变，要改只能 abort 重建。
7. **Token 配额无硬限**：与 e2e、bug 分析共享同一 OAuth token，Phase 1 仅监控不限流。
8. **prd-review skill 自评未启用**：Phase 1 spec-author 自己产 spec 不调 prd-review。Phase 2 加。
9. **审批 claim 不可撤销**：用户点 approve 后无法 undo，必须重新跑一轮（设计选择，避免状态机歧义）。
10. **IM 端 escalation budget_extended 数字固定**：IM 卡片不支持数字输入，按 system_config 默认值；自定义 N 必须 Web 端。
11. **HA 多实例 bootstrap 竞争**：Phase 1 通过 pg_advisory_lock 串行化，但失败时无 backoff。Phase 2 完善。
12. **retry_counters 字段名不准**：实际包含进度状态、abort 信号、重试代次等，不只是 retry 计数。命名 debt 留着，不重命名以免迁移老数据。
13. **POST /requirements 无限流**：Phase 1 任意 admin 可瞬间塞 N 个进队列（受 concurrency 限制只跑 2 个，但队列无界）。Phase 2 加单 user 60s 内最多 5 个的硬限。
14. **用户输入未做 markdown escape**：Phase 1 raw_input / abort_reason / reject_reason 直接进 IM 卡片 + MR description，理论上有 markdown 注入风险（如 `]()`、` 代码块逃逸）。Phase 2 后端入库前做 escape：`<` `>` `[` `]` `*` `\` `` ` ``。
15. **pipeline_run_events 表无 retention 策略**：每需求 ~50 条事件，半年后表会很大。Phase 1 沿用现有 events 表的 retention（如有）；Phase 2 单独配 quick-impl 90 天 retention。
16. **WORKTREE_BASE_QI env 与 system_config 重复**：Phase 1 env 优先（用于测试覆盖），生产值在 system_config。两套配置可能割裂。Phase 2 统一用 system_config，env 仅作 emergency override。
17. **graph-runner 改动是 optional 参数而非主路径接口**：Day 0 验证发现 LangGraph 原生支持 `RunnableConfig.signal`，§12.7 abort 走 `streamGraph(ctx, input, signal?)` + `runRegistry: Map<runId, {controller}>`，回归面比预估小很多。
18. **dev-loop 任务编号必须 dense**：plan-decomposer / dev-loop 不允许跳号。如 skill 输出 `[0,1,3]`，commit_artifact handler 会 reject。这是契约，需要 prompt 强约束 + 单测验证。
