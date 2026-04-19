# Pipeline 全链路动态编排 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Bug 修复主流程（分析 → 修复 → MR → Review → 通知 → 合并闭环）全部纳入 Pipeline 引擎驱动，每个环节独立可追踪可重试，业务数据落 `bug_fix_events` 表供阶段间传递和前端时间线展示。

**Architecture:** 所有 stage 统一用 `stageType=capability`（包括 L3 审批，改成 `approve_l3` handler 内部调 approval-manager）；`triggerParams={reportId}`，handler 从 `bug_fix_events` 反查业务数据；严益昌原创代码零改动（executor.ts / approval-manager.ts / webhook-waiter.ts / test-runs.ts / test-pipelines.ts）。

**Tech Stack:** TypeScript (NodeNext / strict), Fastify 5, PostgreSQL 16 (pg 直连, 无 ORM), React 18 + Ant Design 5 + Vite, Vitest, 钉钉 Stream SDK + GitLab API

**Spec reference:** `docs/superpowers/specs/2026-04-17-pipeline-full-orchestration-design.md`

---

## 实施修订说明（Task 17 执行过程中产生）

以下变更在实施过程中用户明确修订，**以下描述优先于 plan 正文**：

1. **取消触发人 DM 功能**（`notify_bug` 仅通知 project 负责人）
   - 原因：触发人通过 Bug 修复实例页面查看状态和事件时间线，不依赖 IM 推送
   - 影响范围：plan/spec 里所有"触发人 DM"相关描述失效
   - 具体规则：
     - `fix_success` / `fix_success_review_concerns`：发给 project owner（保留）
     - `l4_created`：发给**各涉及 project 负责人**（主仓 + 从仓 owner，去重）—— 见下方第 2 条修订，原先误判为"不发"
     - `approval_rejected` / `approval_timeout` / `approval_retry_analysis` / `fix_failed`：**不发任何 DM**（handler 直接返回 success，不写 notify 事件）
   - 代码已按此规则实施（commit `6682c06`），相关单测和集成测试已同步

2. **L4 通知澄清**（Task 18 后续修订）
   - 背景：spec 原有两处冲突（[spec:1059](../specs/2026-04-17-pipeline-full-orchestration-design.md#L1059) Pipeline description 说"通知触发人"，而 [spec:873](../specs/2026-04-17-pipeline-full-orchestration-design.md#L873) 行为矩阵表说"不发 DM"），第一轮实施（commit `6682c06`）按行为表做了"L4 不发"
   - 用户澄清：L4 = "Claude 判断无法自动修，Issue 已建，**等人工接手**" —— 属于**有明确下一步待办**的场景，必须发 DM 让 owner 知晓
   - 决策：L4 发 DM 给**各涉及 project 负责人**（主仓 + 从仓 owner，去重），不发触发人（与修订 1 保持一致）
   - 和 fix_failed 等失败场景的区别：失败类已决策终止或可由重试按钮自行发起，L4 是任务卡壳等待接手，语义完全不同
   - 影响范围：
     - notify-handler：`shouldNotifyOwners('l4_created')` 从 `false` 改 `true`，`buildMessage` 新增 `'l4_created'` 模板
     - spec 三处对齐（588 / 873 / 1059）
     - e2e 新增 `bug-l4-flow.spec.ts` 专测 L4 场景；原误导性的 `bug-l4-multi-project.spec.ts`（实际测 L2）重命名

---

## File Structure

### 新建文件

| 路径 | 职责 |
|------|-----|
| `src/db/schema-v11.sql` | 建 `bug_fix_events` 表、扩 `bug_analysis_reports`、插 capabilities、改 Pipeline seed |
| `src/db/repositories/bug-fix-events.ts` | `bug_fix_events` CRUD（create / findByReport / findByReportCode / findDistinctProjects / findLatestByProject） |
| `src/agent/approval/approve-l3-handler.ts` | L3 审批 capability handler：动态 approverIds + 从仓库知情 DM + 调 approval-manager |
| `src/agent/mr/mr-handler.ts` | `create_mr` capability handler：按 project 循环建 MR，主仓库 `Closes`、从仓库 `Related to` |
| `src/agent/notify/notify-handler.ts` | `notify_bug` capability handler：Pipeline 终态通知 |
| `src/__tests__/unit/bug-fix-events-repo.test.ts` | repo 单测 |
| `src/__tests__/unit/approve-l3-handler.test.ts` | handler 单测 |
| `src/__tests__/unit/create-mr-handler.test.ts` | handler 单测 |
| `src/__tests__/unit/notify-handler.test.ts` | handler 单测 |
| `src/__tests__/integration/l1-single-project-flow.test.ts` | AC1 集成测试 |
| `src/__tests__/integration/l3-multi-project-approval.test.ts` | AC2 集成测试 |
| `src/__tests__/integration/approval-timeout-retry.test.ts` | AC3 集成测试 |
| `src/__tests__/integration/create-mr-idempotency.test.ts` | AC4 集成测试 |
| `src/__tests__/integration/non-bug-classification.test.ts` | AC5 集成测试 |
| `src/__tests__/integration/reanalyze-flow.test.ts` | AC6 集成测试 |
| `src/__tests__/integration/mr-close-sync.test.ts` | AC7 集成测试 |

### 修改文件（hanff 自有模块）

| 路径 | 改动要点 |
|------|---------|
| `src/db/migrate.ts` | 追加 v11 迁移执行 |
| `src/db/repositories/bug-analysis-reports.ts` | 加 `pipeline_run_id` / `primary_project_path` 读写 + `updateStatus` 泛用扩展 |
| `src/agent/analysis/analyzer.ts` | 两阶段分析（筛选→详细）+ 多 project + 写 scope_identified/create_issue 事件 + `reuseIssueId` 模式 |
| `src/agent/fix/fix-runner.ts` | 读 `scope_identified` 列表 + 按 project 循环 + 写 `fix_attempt` + 删内嵌 `createMrViaApi` + 幂等检查 |
| `src/agent/review/reviewer.ts` | 多 MR 循环 + 写 GitLab MR Note + 幂等检查 |
| `src/agent/coordinator.ts` | 回写 `pipeline_run_id` + `onComplete` 推动 `bug_analysis_reports.status` + 非 bug 分支不启 Pipeline |
| `src/agent/worktree/manager.ts` | key 加 `project_path` 维度避免多 project 并发冲突 |
| `src/adapters/gitlab/issue-handler.ts` | 删 label/MR-created 的 capability dispatch + 新增 MR merged/closed → `bug_analysis_reports.status` 同步 |
| `src/admin/routes/bug-analysis-reports.ts` | 新增 `POST /admin/bug-reports/:id/retry` |
| `src/db/seed.sql` | L1/L2/L3 stages 更新（加 create_mr/notify_bug、L3 加 approve_l3）+ 新建 L4 Pipeline |
| `src/__tests__/unit/analyzer.test.ts` | 扩展多 project 和 reuseIssueId 场景 |
| `src/__tests__/unit/reviewer.test.ts` | 扩展多 MR + MR Note + 幂等 |
| `src/__tests__/unit/issue-handler.test.ts` | 改造为 MR merged/closed → status 同步 |
| `src/__tests__/unit/coordinator.test.ts` | 扩展 pipeline_run_id 回写 + onComplete |
| `src/__tests__/unit/worktree-manager.test.ts` | 扩展多 project 同分支不冲突 |
| `web/src/pages/BugRunsPage.tsx` | 按 `issue_id` 聚合 + 事件时间线 + 重试按钮 + 确认对话框 |
| `web/src/api/bug-analysis-reports.ts` | 新增 retry endpoint 调用 |

### 零改动文件（严益昌原创，硬约束）

以下文件本次实施**原则上不改**：

- `src/pipeline/executor.ts`
- `src/pipeline/types.ts`
- `src/pipeline/approval-manager.ts`
- `src/pipeline/webhook-waiter.ts`
- `src/db/repositories/test-runs.ts`
- `src/db/repositories/test-pipelines.ts`

**已批准例外**：
- **commit 89809d0（Task 7 期间）**：扩展 `src/pipeline/approval-manager.ts` 支持 `reanalyze` 决策 —
  `requestApproval` 返回类型 union 加 `retry_analysis` 分支，`tryHandleCommand` 正则从 `approve|reject` 扩为 `approve|reject|reanalyze`，审批 DM 文案增加 reanalyze 命令提示。经用户确认后执行。

**"零改动"定义域**：Task 18（commit c4eeead 开始）期间,以上 6 个文件零 commit 增量。早期 Task 7 的已批准例外见上。代码审查扫描 git 时请按"Task 18 开始点"为界区分。

---

## Task 1: schema-v11.sql（建表 + ALTER + capabilities INSERT + Pipeline seed UPDATE）

**Files:**
- Create: `src/db/schema-v11.sql`

**Rationale:** 这是整个改动的数据基座。所有后续 repo / handler / 前端都需要 `bug_fix_events` 表和 `bug_analysis_reports` 扩展字段存在。

**Spec ref:** "数据层 → schema-v11.sql 完整 DDL / DML"

- [ ] **Step 1: 创建 schema-v11.sql 文件并写入完整 DDL/DML**

```sql
-- schema-v11.sql: Pipeline 全链路动态编排
-- 1. 新建 bug_fix_events 表 + 索引
-- 2. bug_analysis_reports 扩展字段
-- 3. capabilities 表新增 3 条记录（approve_l3 / create_mr / notify_bug）
-- 4. test_pipelines 更新 L1/L2/L3 stages + 新建 L4

-- ============================================================
-- 1. bug_fix_events 表
-- ============================================================
CREATE TABLE IF NOT EXISTS bug_fix_events (
  id            SERIAL PRIMARY KEY,
  report_id     INTEGER NOT NULL REFERENCES bug_analysis_reports(id),
  project_path  VARCHAR(200),
  code          VARCHAR(50) NOT NULL,
  status        VARCHAR(20) NOT NULL DEFAULT 'success',
  duration_ms   INTEGER,
  data          JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_fix_events_report
  ON bug_fix_events(report_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bug_fix_events_project
  ON bug_fix_events(report_id, project_path, code);

-- ============================================================
-- 2. bug_analysis_reports 扩展字段
-- ============================================================
ALTER TABLE bug_analysis_reports
  ADD COLUMN IF NOT EXISTS pipeline_run_id INTEGER REFERENCES test_runs(id),
  ADD COLUMN IF NOT EXISTS primary_project_path VARCHAR(200);

-- status 字段是 VARCHAR，无需改 enum；业务层使用以下取值：
-- 'draft' | 'published' | 'pipeline_success' | 'completed' | 'aborted'

-- ============================================================
-- 3. capabilities 表新增 3 条记录
-- ============================================================
INSERT INTO capabilities (key, display_name, description, category, tool_names, needs_approval)
VALUES
  ('approve_l3', 'L3 方案审批',
   'L3 Bug 修复方案审批：给主仓库 owner 发审批 DM，给从仓库 owner 发知情 DM',
   'action', '[]'::jsonb, true),
  ('create_mr', '创建 MR',
   '对每个涉及的 project 创建 GitLab Merge Request，description 引用主 Issue',
   'action', '[]'::jsonb, false),
  ('notify_bug', '修复完成通知',
   'Pipeline 终态通知：成功/失败 DM 给 project 负责人和触发人',
   'action', '[]'::jsonb, false)
ON CONFLICT (key) DO NOTHING;

-- ============================================================
-- 4. test_pipelines 更新 L1/L2/L3 stages + 新建 L4
-- ============================================================

-- L1 Pipeline
UPDATE test_pipelines
SET stages = '[
  {
    "name": "L1 修复", "stageType": "capability", "capabilityKey": "fix_bug_l1",
    "timeoutSeconds": 1800, "retryCount": 0, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "创建 MR", "stageType": "capability", "capabilityKey": "create_mr",
    "timeoutSeconds": 300, "retryCount": 1, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "AI Review", "stageType": "capability", "capabilityKey": "ai_review_mr",
    "timeoutSeconds": 600, "retryCount": 0, "onFailure": "continue",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "通知", "stageType": "capability", "capabilityKey": "notify_bug",
    "timeoutSeconds": 120, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  }
]'::jsonb
WHERE name = 'L1-配置类';

-- L2 Pipeline
UPDATE test_pipelines
SET stages = '[
  {
    "name": "L2 修复", "stageType": "capability", "capabilityKey": "fix_bug_l2",
    "timeoutSeconds": 2400, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "创建 MR", "stageType": "capability", "capabilityKey": "create_mr",
    "timeoutSeconds": 300, "retryCount": 1, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "AI Review", "stageType": "capability", "capabilityKey": "ai_review_mr",
    "timeoutSeconds": 600, "retryCount": 0, "onFailure": "continue",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "通知", "stageType": "capability", "capabilityKey": "notify_bug",
    "timeoutSeconds": 120, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  }
]'::jsonb
WHERE name = 'L2-代码缺陷';

-- L3 Pipeline: approve_l3 是 stageType=capability（不是 approval）
UPDATE test_pipelines
SET stages = '[
  {
    "name": "方案审批", "stageType": "capability", "capabilityKey": "approve_l3",
    "timeoutSeconds": 3600, "retryCount": 0, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "L3 修复", "stageType": "capability", "capabilityKey": "fix_bug_l3",
    "timeoutSeconds": 2400, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "创建 MR", "stageType": "capability", "capabilityKey": "create_mr",
    "timeoutSeconds": 300, "retryCount": 1, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "AI Review", "stageType": "capability", "capabilityKey": "ai_review_mr",
    "timeoutSeconds": 600, "retryCount": 0, "onFailure": "continue",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  },
  {
    "name": "通知", "stageType": "capability", "capabilityKey": "notify_bug",
    "timeoutSeconds": 120, "retryCount": 2, "onFailure": "stop",
    "targetRoles": [], "parallel": false,
    "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
  }
]'::jsonb
WHERE name = 'L3-业务逻辑';

-- L4 Pipeline（新建，单 stage）
INSERT INTO test_pipelines (product_line_id, name, description, stages, enabled, trigger_params, variables)
SELECT
  id AS product_line_id,
  'L4-复杂问题' AS name,
  '无自动修复能力的 Bug 分析结果，仅创建 Issue 并通知触发人' AS description,
  '[
    {
      "name": "通知", "stageType": "capability", "capabilityKey": "notify_bug",
      "timeoutSeconds": 120, "retryCount": 2, "onFailure": "stop",
      "targetRoles": [], "parallel": false,
      "capabilityParams": {"reportId": "{{triggerParams.reportId}}"}
    }
  ]'::jsonb AS stages,
  true AS enabled,
  '{}'::jsonb AS trigger_params,
  '{}'::jsonb AS variables
FROM product_lines
WHERE name = 'PAM'
  AND NOT EXISTS (SELECT 1 FROM test_pipelines WHERE name = 'L4-复杂问题');
```

- [ ] **Step 2: 验证 SQL 语法**

在本地 psql 或 pgAdmin 空库上 dry-run：

```bash
# 前提：先执行 schema.sql 到 schema-v10.sql（有 migrate 脚本串起来）
psql $DATABASE_URL -f src/db/schema-v11.sql --set ON_ERROR_STOP=on
```

Expected: 无 ERROR 输出，所有 statement 执行成功。

- [ ] **Step 3: 验证迁移幂等（重跑一次）**

```bash
psql $DATABASE_URL -f src/db/schema-v11.sql --set ON_ERROR_STOP=on
```

Expected: 全部通过（因为所有 DDL 都用了 `IF NOT EXISTS` 或 `ON CONFLICT`）。

- [ ] **Step 4: Commit**

```bash
git add src/db/schema-v11.sql
git commit -m "feat(db): schema-v11 新增 bug_fix_events + Pipeline 全链路编排数据层"
```

---

## Task 2: migrate.ts 追加 v11 执行

**Files:**
- Modify: `src/db/migrate.ts`

**Rationale:** `schema-v11.sql` 必须挂到迁移脚本执行链里，否则上线后不会自动建表。

**Spec ref:** "schema-v11.sql 完整 DDL / DML → migrate.ts 追加"

- [ ] **Step 1: 读取当前 migrate.ts，找到现有 v10 执行位置**

```bash
grep -n "schema-v" src/db/migrate.ts
```

Expected: 看到 `v2` 到 `v10` 的执行顺序。

- [ ] **Step 2: 在 v10 之后追加 v11 执行**

参考现有 pattern（每个版本一行 `await executeSql` 调用），在 v10 行下面加：

```typescript
await executeSql(path.join(SCHEMA_DIR, 'schema-v11.sql'))
console.log('[migrate] schema-v11 applied')
```

- [ ] **Step 3: 本地跑迁移验证**

```bash
pnpm migrate
```

Expected: 输出包含 `[migrate] schema-v11 applied`，无错误。

- [ ] **Step 4: 验证表已建**

```bash
psql $DATABASE_URL -c "\d bug_fix_events"
psql $DATABASE_URL -c "SELECT column_name FROM information_schema.columns WHERE table_name='bug_analysis_reports' AND column_name IN ('pipeline_run_id','primary_project_path')"
psql $DATABASE_URL -c "SELECT key FROM capabilities WHERE key IN ('approve_l3','create_mr','notify_bug')"
psql $DATABASE_URL -c "SELECT name FROM test_pipelines WHERE name LIKE 'L_-%'"
```

Expected:
- `bug_fix_events` 表结构打印
- 两个新字段都返回
- 3 条 capability key 返回
- 4 条 Pipeline（L1/L2/L3/L4）返回

- [ ] **Step 5: Commit**

```bash
git add src/db/migrate.ts
git commit -m "feat(db): migrate 追加 schema-v11 执行"
```

---

## Task 3: bug-fix-events Repository

**Files:**
- Create: `src/db/repositories/bug-fix-events.ts`
- Create: `src/__tests__/unit/bug-fix-events-repo.test.ts`

**Rationale:** 所有 handler 都依赖这个 repo 写入/查询 events。必须先做完，handler 才能落地。

**Spec ref:** "阶段间数据传递：bug_fix_events 表" + "当前状态查询方式"

**API 设计**：

```typescript
// 写入
createEvent(params: {
  reportId: number
  projectPath: string | null
  code: string
  status?: 'success' | 'failed'
  durationMs?: number
  data?: Record<string, unknown>
}): Promise<BugFixEvent>

// 查询
findByReport(reportId: number): Promise<BugFixEvent[]>                       // 按 created_at asc
findByReportCode(reportId: number, code: string): Promise<BugFixEvent[]>     // 按 created_at asc
findDistinctProjects(reportId: number): Promise<string[]>                    // 只返非空 project_path
findLatest(reportId: number, projectPath: string | null, code: string): Promise<BugFixEvent | null>
findPrimaryCreateIssue(reportId: number): Promise<BugFixEvent | null>        // 读 data.isPrimary=true 那条
```

`BugFixEvent` 类型定义：

```typescript
export interface BugFixEvent {
  id: number
  reportId: number
  projectPath: string | null
  code: string
  status: 'success' | 'failed'
  durationMs: number | null
  data: Record<string, unknown>
  createdAt: Date
}
```

- [ ] **Step 1: 写失败测试 - createEvent 基础场景**

```typescript
// src/__tests__/unit/bug-fix-events-repo.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { setupTestDb, cleanDb } from '../helpers/db.js'
import { createEvent, findByReport } from '../../db/repositories/bug-fix-events.js'
import { createBugAnalysisReport } from '../../db/repositories/bug-analysis-reports.js'

describe('bug-fix-events repository', () => {
  beforeEach(async () => { await cleanDb() })

  it('creates an event with data JSON', async () => {
    const report = await createBugAnalysisReport({
      issueId: 1, issueUrl: 'http://x', productLineId: 1,
      level: 'l2', classification: 'bug', confidence: 'high', confidenceScore: 0.9,
      rootCauseSummary: '', solutionsJson: [], affectedModules: {}, analysisSteps: {}, metadata: {},
    })
    const event = await createEvent({
      reportId: report.id,
      projectPath: 'PAM/pas-6.0',
      code: 'scope_identified',
      data: { sourceBranch: 'master', affectedModules: ['auth'] },
    })
    expect(event.id).toBeGreaterThan(0)
    expect(event.projectPath).toBe('PAM/pas-6.0')
    expect(event.data.sourceBranch).toBe('master')

    const all = await findByReport(report.id)
    expect(all).toHaveLength(1)
    expect(all[0].id).toBe(event.id)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/bug-fix-events-repo.test.ts
```

Expected: FAIL with "Cannot find module '../../db/repositories/bug-fix-events.js'"

- [ ] **Step 3: 创建 repo 文件 + 最小实现（只够让测试通过）**

```typescript
// src/db/repositories/bug-fix-events.ts
import { pool } from '../pool.js'

export interface BugFixEvent {
  id: number
  reportId: number
  projectPath: string | null
  code: string
  status: 'success' | 'failed'
  durationMs: number | null
  data: Record<string, unknown>
  createdAt: Date
}

interface CreateEventInput {
  reportId: number
  projectPath: string | null
  code: string
  status?: 'success' | 'failed'
  durationMs?: number
  data?: Record<string, unknown>
}

function mapRow(r: any): BugFixEvent {
  return {
    id: r.id,
    reportId: r.report_id,
    projectPath: r.project_path,
    code: r.code,
    status: r.status,
    durationMs: r.duration_ms,
    data: r.data ?? {},
    createdAt: r.created_at,
  }
}

export async function createEvent(input: CreateEventInput): Promise<BugFixEvent> {
  const { rows } = await pool.query(
    `INSERT INTO bug_fix_events (report_id, project_path, code, status, duration_ms, data)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      input.reportId,
      input.projectPath,
      input.code,
      input.status ?? 'success',
      input.durationMs ?? null,
      JSON.stringify(input.data ?? {}),
    ],
  )
  return mapRow(rows[0])
}

export async function findByReport(reportId: number): Promise<BugFixEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM bug_fix_events WHERE report_id = $1 ORDER BY created_at ASC, id ASC`,
    [reportId],
  )
  return rows.map(mapRow)
}
```

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/unit/bug-fix-events-repo.test.ts
```

Expected: PASS

- [ ] **Step 5: 加入其他查询方法的测试**

```typescript
// 在同一个文件 describe 内追加

it('findByReportCode filters by code', async () => {
  const report = await createBugAnalysisReport({ /* ...同上 */ } as any)
  await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'scope_identified', data: {} })
  await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'fix_attempt', data: {} })
  await createEvent({ reportId: report.id, projectPath: 'PAM/b', code: 'scope_identified', data: {} })

  const scopes = await findByReportCode(report.id, 'scope_identified')
  expect(scopes).toHaveLength(2)
  expect(scopes.every(e => e.code === 'scope_identified')).toBe(true)
})

it('findDistinctProjects returns unique non-null project_paths', async () => {
  const report = await createBugAnalysisReport({ /* ... */ } as any)
  await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'scope_identified', data: {} })
  await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'fix_attempt', data: {} })
  await createEvent({ reportId: report.id, projectPath: 'PAM/b', code: 'scope_identified', data: {} })
  await createEvent({ reportId: report.id, projectPath: null, code: 'analysis', data: {} })

  const projects = await findDistinctProjects(report.id)
  expect(projects.sort()).toEqual(['PAM/a', 'PAM/b'])
})

it('findLatest returns the most recent event for a project+code', async () => {
  const report = await createBugAnalysisReport({ /* ... */ } as any)
  const e1 = await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'fix_attempt', status: 'failed', data: { attempt: 1 } })
  const e2 = await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'fix_attempt', status: 'success', data: { attempt: 2 } })
  const latest = await findLatest(report.id, 'PAM/a', 'fix_attempt')
  expect(latest?.id).toBe(e2.id)
  expect((latest?.data as any).attempt).toBe(2)
})

it('findPrimaryCreateIssue returns the create_issue event with isPrimary=true', async () => {
  const report = await createBugAnalysisReport({ /* ... */ } as any)
  await createEvent({ reportId: report.id, projectPath: 'PAM/a', code: 'create_issue', data: { issueIid: 1, isPrimary: true } })
  const primary = await findPrimaryCreateIssue(report.id)
  expect((primary?.data as any).issueIid).toBe(1)
})
```

- [ ] **Step 6: 补完 repo 方法实现**

```typescript
// src/db/repositories/bug-fix-events.ts 追加

export async function findByReportCode(reportId: number, code: string): Promise<BugFixEvent[]> {
  const { rows } = await pool.query(
    `SELECT * FROM bug_fix_events WHERE report_id = $1 AND code = $2 ORDER BY created_at ASC, id ASC`,
    [reportId, code],
  )
  return rows.map(mapRow)
}

export async function findDistinctProjects(reportId: number): Promise<string[]> {
  const { rows } = await pool.query(
    `SELECT DISTINCT project_path FROM bug_fix_events
     WHERE report_id = $1 AND project_path IS NOT NULL`,
    [reportId],
  )
  return rows.map(r => r.project_path as string)
}

export async function findLatest(
  reportId: number,
  projectPath: string | null,
  code: string,
): Promise<BugFixEvent | null> {
  const { rows } = await pool.query(
    `SELECT * FROM bug_fix_events
     WHERE report_id = $1 AND project_path IS NOT DISTINCT FROM $2 AND code = $3
     ORDER BY id DESC LIMIT 1`,
    [reportId, projectPath, code],
  )
  return rows[0] ? mapRow(rows[0]) : null
}

export async function findPrimaryCreateIssue(reportId: number): Promise<BugFixEvent | null> {
  const { rows } = await pool.query(
    `SELECT * FROM bug_fix_events
     WHERE report_id = $1 AND code = 'create_issue' AND (data->>'isPrimary')::boolean = true
     ORDER BY id DESC LIMIT 1`,
    [reportId],
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 7: 运行所有测试确认通过**

```bash
npx vitest run src/__tests__/unit/bug-fix-events-repo.test.ts
```

Expected: PASS 4 tests

- [ ] **Step 8: Commit**

```bash
git add src/db/repositories/bug-fix-events.ts src/__tests__/unit/bug-fix-events-repo.test.ts
git commit -m "feat(db): bug-fix-events repository + 单测"
```

---

## Task 4: bug-analysis-reports repository 扩展

**Files:**
- Modify: `src/db/repositories/bug-analysis-reports.ts`

**Rationale:** coordinator 和 retry endpoint 需要读写 `pipeline_run_id` / `primary_project_path`，并能更新 `status`。

**Spec ref:** "数据层 → bug_analysis_reports 扩展"、"coordinator onComplete 回调"

- [ ] **Step 1: 读现有 repo 代码，了解 mapRow + createBugAnalysisReport 的 pattern**

```bash
sed -n '1,80p' src/db/repositories/bug-analysis-reports.ts
```

Expected: 看到 `mapRow` 把 DB row 映射成 `BugAnalysisReport` 类型，camelCase。

- [ ] **Step 2: 扩展 `BugAnalysisReport` 类型加两个字段**

在接口定义中加：

```typescript
export interface BugAnalysisReport {
  // ... 已有字段
  pipelineRunId: number | null
  primaryProjectPath: string | null
}
```

- [ ] **Step 3: 扩展 `mapRow` 把 DB 新字段映射进去**

```typescript
function mapRow(r: any): BugAnalysisReport {
  return {
    // ... 已有映射
    pipelineRunId: r.pipeline_run_id ?? null,
    primaryProjectPath: r.primary_project_path ?? null,
  }
}
```

- [ ] **Step 4: 扩展 `createBugAnalysisReport` 支持写入 `primaryProjectPath`**

`INSERT INTO bug_analysis_reports` 列表加 `primary_project_path`，对应占位符加 `$N`，function 入参 `CreateInput` 加 `primaryProjectPath?: string | null`。

- [ ] **Step 5: 新增 `setPipelineRunId(reportId, runId)`**

```typescript
export async function setPipelineRunId(reportId: number, runId: number): Promise<void> {
  await pool.query(
    `UPDATE bug_analysis_reports SET pipeline_run_id = $2, updated_at = NOW() WHERE id = $1`,
    [reportId, runId],
  )
}
```

- [ ] **Step 6: 改造 `updateStatus` 接受所有 status 值**

现有 `updateStatus(id, status)` 实现就支持任意字符串（VARCHAR），只确认它能接受新的 `'pipeline_success'`。如果签名收窄了类型，改成：

```typescript
export async function updateStatus(
  reportId: number,
  status: 'draft' | 'published' | 'pipeline_success' | 'completed' | 'aborted',
): Promise<BugAnalysisReport | null> {
  // 原实现保留
}
```

- [ ] **Step 7: 本地 tsc 检查**

```bash
npx tsc --noEmit
```

Expected: 无 type error。

- [ ] **Step 8: 写一个扩展测试验证新字段读写**

在 `src/__tests__/unit/bug-analysis-reports-repo.test.ts`（若无则创建）加：

```typescript
it('setPipelineRunId writes pipeline_run_id', async () => {
  const report = await createBugAnalysisReport({ /* ...基础字段 */ } as any)
  await setPipelineRunId(report.id, 999)
  const reloaded = await getBugAnalysisReportById(report.id)
  expect(reloaded?.pipelineRunId).toBe(999)
})

it('primaryProjectPath round-trips through create + get', async () => {
  const report = await createBugAnalysisReport({
    /* ... */,
    primaryProjectPath: 'PAM/pas-6.0',
  } as any)
  const reloaded = await getBugAnalysisReportById(report.id)
  expect(reloaded?.primaryProjectPath).toBe('PAM/pas-6.0')
})
```

- [ ] **Step 9: 运行测试**

```bash
npx vitest run src/__tests__/unit/bug-analysis-reports-repo.test.ts
```

Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/db/repositories/bug-analysis-reports.ts src/__tests__/unit/bug-analysis-reports-repo.test.ts
git commit -m "feat(db): bug-analysis-reports 扩展 pipeline_run_id + primary_project_path"
```

---

## Task 5: worktree/manager.ts key 加 project_path 维度

**Files:**
- Modify: `src/agent/worktree/manager.ts`
- Modify: `src/__tests__/unit/worktree-manager.test.ts`

**Rationale:** 多 project 并行修复时，不加 project_path 会导致两个仓库 clone 到同一目录产生冲突。这个改造**必须在 fix-runner 改造之前完成**，否则多 project 场景跑不起来。

**Spec ref:** "需要改造的地方 → worktree/manager.ts key 加 project_path 维度（含示例）"

- [ ] **Step 1: 读 worktree/manager.ts 了解 key 现状**

```bash
grep -n "product_line\|branch\|path" src/agent/worktree/manager.ts | head -30
```

Expected: 找到当前 key 生成逻辑（通常是字符串拼接 `${productLineId}-${branch}` 或类似）。

- [ ] **Step 2: 写失败测试 - 多 project 同 branch 不冲突**

```typescript
// src/__tests__/unit/worktree-manager.test.ts
import { describe, it, expect } from 'vitest'
import { makeWorktreeKey } from '../../agent/worktree/manager.js'

describe('worktree manager', () => {
  it('different projects with same branch yield different keys', () => {
    const k1 = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/pas-6.0', branch: 'fix/bug-123' })
    const k2 = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/pas-api', branch: 'fix/bug-123' })
    expect(k1).not.toBe(k2)
  })

  it('same project + same branch yields same key (stable)', () => {
    const k1 = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/pas-6.0', branch: 'fix/bug-123' })
    const k2 = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/pas-6.0', branch: 'fix/bug-123' })
    expect(k1).toBe(k2)
  })

  it('key is filesystem-safe (no slashes in output path segment)', () => {
    const key = makeWorktreeKey({ productLineId: 1, projectPath: 'PAM/java-code/pas-6.0', branch: 'fix/bug-123' })
    expect(key).not.toContain('/')  // 路径分隔符需替换为 - 或其他
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/worktree-manager.test.ts
```

Expected: FAIL（或者 `makeWorktreeKey` 未导出）。

- [ ] **Step 4: 改造 `makeWorktreeKey` 或等价函数**

新签名：

```typescript
export function makeWorktreeKey(params: {
  productLineId: number
  projectPath: string      // 如 'PAM/pas-6.0' 或 'PAM/java-code/pas-6.0'
  branch: string
}): string {
  // 把路径分隔符替换成 - 避免文件系统冲突
  const safeProject = params.projectPath.replace(/\//g, '-')
  const safeBranch = params.branch.replace(/\//g, '-')
  return `${params.productLineId}-${safeProject}-${safeBranch}`
}
```

**同时修改所有调用方**：搜索 `grep -rn "makeWorktreeKey\|worktree.*key" src/` 找到所有使用点，确保都传入 `projectPath`。

- [ ] **Step 5: 确认所有调用点已更新**

```bash
grep -rn "makeWorktreeKey\|acquireWorktree\|releaseWorktree" src/ --include='*.ts'
```

Expected: 所有调用点都传了 `projectPath`（不传的地方会编译错误）。

- [ ] **Step 6: 运行测试**

```bash
npx vitest run src/__tests__/unit/worktree-manager.test.ts
```

Expected: PASS 3 tests

- [ ] **Step 7: Commit**

```bash
git add src/agent/worktree/manager.ts src/__tests__/unit/worktree-manager.test.ts
git commit -m "refactor(worktree): key 加 project_path 维度，支持多 project 并行修复"
```

---

## Task 6: analyzer.ts 改造（多 project + bug_fix_events 写入 + reuseIssueId）

**Files:**
- Modify: `src/agent/analysis/analyzer.ts`
- Modify: `src/__tests__/unit/analyzer.test.ts`

**Rationale:** analyzer 是整个链路的入口，产出 `scope_identified` 事件让后续 handler 有源可查。reuseIssueId 模式支撑失败重试。

**Spec ref:** "analyze_bug 扩展（不再只做分析）" + "失败重试（复用 Issue）模式"

**关联 AC:** AC1（单 project）、AC2（多 project 的分析侧）、AC3（重试复用 Issue）、AC5（非 bug 分类不创建 Issue）、AC6（重新分析走 reuseIssueId）

**改动清单：**
1. 两阶段分析（阶段 A 筛选 project 列表、阶段 B 并行 clone 每个 project 做根因分析）
2. 创建主 Issue（主仓库，description 列出所有涉及 project）
3. 写 `bug_fix_events`：`analysis`（Bug 级）→ 多条 `scope_identified`（每 project 一条）→ `create_issue`（主仓库）
4. `bug_analysis_reports.status` 按 classification 设 `published` 或 `completed`
5. 写 `primary_project_path`
6. 新增 `reuseIssueId` 入参支持复用现有 Issue（调 `POST /issues/:iid/notes` 而不是创建新 Issue）

- [ ] **Step 1: 写失败测试 - 单 project bug 场景**

```typescript
// src/__tests__/unit/analyzer.test.ts 新增 describe
describe('analyzer multi-project support', () => {
  it('writes analysis + scope_identified + create_issue events for bug classification', async () => {
    // mock Claude CLI 两次调用：阶段A 返回 [{projectPath:'PAM/pas-6.0', isPrimary:true}], 阶段B 返回根因+l2
    // mock GitLab create_issue 返回 {iid:123}
    const result = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't1', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'user' },
      extraParams: { message: '登录 500', productLineId: 1 },
    })
    expect(result.success).toBe(true)
    expect(result.data).toMatchObject({ classification: 'bug', level: 'l2' })

    // 验证 events
    const events = await findByReport((result.data as any).reportId)
    const codes = events.map(e => e.code)
    expect(codes).toContain('analysis')
    expect(codes).toContain('scope_identified')
    expect(codes).toContain('create_issue')

    // 验证 bug_analysis_reports 字段
    const report = await getBugAnalysisReportById((result.data as any).reportId)
    expect(report?.status).toBe('published')
    expect(report?.primaryProjectPath).toBe('PAM/pas-6.0')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/analyzer.test.ts
```

Expected: FAIL

- [ ] **Step 3: 改造 analyzer.ts 的 handleAnalyzeBug**

新增 `reuseIssueId?: number` 参数。流程改造为：

```typescript
// 伪代码骨架
export async function handleAnalyzeBug(opts: TriggerOptions): Promise<TriggerResult> {
  const { message, productLineId, reuseIssueId } = opts.extraParams ?? {}

  // 阶段 A：筛选（单 clone 主仓库 + projects 列表传给 Claude）
  const projects = await getProjectsByProductLine(productLineId as number)
  const filterResult = await runClaudeFilter(message as string, projects)
  // filterResult = { involvedProjects: [{projectPath, isPrimary}, ...], primaryProjectPath }

  // 阶段 B：对每个涉及的 project 并行 clone + 详细分析
  const analysisResults = await Promise.all(
    filterResult.involvedProjects.map(p => runClaudeDetailedAnalysis(p.projectPath, message as string))
  )
  // 合并成一份结构化结果 + Markdown 报告全文
  const merged = mergeAnalysisResults(analysisResults)  // { level, classification, rootCauseSummary, solutionsJson, markdownFull }

  // 创建 Issue（或复用）
  let issueIid: number, issueUrl: string
  if (merged.classification === 'bug') {
    if (reuseIssueId) {
      // 复用模式：向原 Issue 加 comment
      const existing = await gitlabPostIssueNote({
        projectPath: filterResult.primaryProjectPath,
        issueIid: reuseIssueId,
        body: `🔄 第 N 次分析\n\n${merged.markdownFull}`,
      })
      issueIid = reuseIssueId
      issueUrl = existing.issueUrl
    } else {
      const created = await gitlabCreateIssue({
        projectPath: filterResult.primaryProjectPath,
        title: extractTitleFromMarkdown(merged.markdownFull),
        description: merged.markdownFull,
      })
      issueIid = created.iid
      issueUrl = created.url
    }
  }

  // 写 bug_analysis_reports
  const report = await createBugAnalysisReport({
    issueId: merged.classification === 'bug' ? issueIid! : 0,  // 非 bug 时 issue_id 字段怎么处理看现有约定
    issueUrl: merged.classification === 'bug' ? issueUrl! : '',
    productLineId,
    level: merged.level,
    classification: merged.classification,
    confidence: merged.confidence,
    confidenceScore: merged.confidenceScore,
    rootCauseSummary: merged.rootCauseSummary,
    solutionsJson: merged.solutionsJson,
    affectedModules: merged.affectedModules,
    analysisSteps: merged.analysisSteps,
    metadata: {},
    primaryProjectPath: filterResult.primaryProjectPath,  // 新字段
  })

  // 写 bug_fix_events(analysis)
  await createEvent({
    reportId: report.id,
    projectPath: null,
    code: 'analysis',
    data: {
      durationMs: Date.now() - startTime,
      level: merged.level,
      confidence: merged.confidence,
      classification: merged.classification,
      rootCauseSummary: merged.rootCauseSummary,
      productLineId,
      projects: filterResult.involvedProjects.map(p => ({
        projectPath: p.projectPath,
        sourceBranch: p.sourceBranch,
        affectedModules: merged.affectedModulesByProject[p.projectPath] ?? [],
      })),
    },
  })

  if (merged.classification !== 'bug') {
    await updateStatus(report.id, 'completed')
    return { success: true, output: '非 bug 类型，分析完成', data: { reportId: report.id, classification: merged.classification, level: merged.level } }
  }

  // bug 分类：写 scope_identified × N + create_issue
  await updateStatus(report.id, 'published')
  for (const p of filterResult.involvedProjects) {
    await createEvent({
      reportId: report.id,
      projectPath: p.projectPath,
      code: 'scope_identified',
      data: {
        sourceBranch: p.sourceBranch,
        affectedModules: merged.affectedModulesByProject[p.projectPath] ?? [],
        isPrimary: p.isPrimary,
      },
    })
  }
  await createEvent({
    reportId: report.id,
    projectPath: filterResult.primaryProjectPath,
    code: 'create_issue',
    data: { issueIid, issueUrl, isPrimary: true, isReused: !!reuseIssueId },
  })

  return {
    success: true,
    output: `Bug 分析完成: ${merged.classification} / ${merged.level}，涉及 ${filterResult.involvedProjects.length} 个 project`,
    data: { reportId: report.id, classification: merged.classification, level: merged.level },
  }
}
```

**关键实现细节**：
- `runClaudeFilter`、`runClaudeDetailedAnalysis` 走 Claude CLI（参照现有实现的 `claudeRun` 调用）
- `gitlabCreateIssue` / `gitlabPostIssueNote` 用已有的 axios 封装（见 [analyzer.ts:65-88](src/agent/analysis/analyzer.ts#L65-L88)）
- 错误处理：Issue 创建失败直接抛错不落库（spec 明确要求）

- [ ] **Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/unit/analyzer.test.ts
```

Expected: PASS

- [ ] **Step 5: 加多 project 场景测试**

```typescript
it('multi-project: writes N scope_identified rows', async () => {
  // mock 阶段 A 返回 [PAM/pas-6.0 (primary), PAM/pas-api]
  const result = await handleAnalyzeBug({ /* ... */ } as any)
  const events = await findByReportCode((result.data as any).reportId, 'scope_identified')
  expect(events).toHaveLength(2)
  expect(events.find(e => (e.data as any).isPrimary === true)?.projectPath).toBe('PAM/pas-6.0')
  expect(events.find(e => (e.data as any).isPrimary === false)?.projectPath).toBe('PAM/pas-api')
})

it('non-bug classification skips Issue and returns completed', async () => {
  // mock 阶段 B 返回 classification='usage_issue'
  const result = await handleAnalyzeBug({ /* ... */ } as any)
  const report = await getBugAnalysisReportById((result.data as any).reportId)
  expect(report?.status).toBe('completed')
  // 无 create_issue 事件
  const events = await findByReportCode((result.data as any).reportId, 'create_issue')
  expect(events).toHaveLength(0)
})

it('reuseIssueId posts a note instead of creating a new issue', async () => {
  // mock gitlabPostIssueNote 验证被调用，gitlabCreateIssue 验证未被调用
  const mockPostNote = vi.fn().mockResolvedValue({ issueUrl: 'http://reused' })
  vi.mocked(gitlabPostIssueNote).mockImplementation(mockPostNote)
  const mockCreate = vi.fn()
  vi.mocked(gitlabCreateIssue).mockImplementation(mockCreate)

  await handleAnalyzeBug({ extraParams: { reuseIssueId: 123, productLineId: 1, message: 'retry' }, /* ... */ } as any)

  expect(mockPostNote).toHaveBeenCalled()
  expect(mockCreate).not.toHaveBeenCalled()
})
```

- [ ] **Step 6: 运行所有测试**

```bash
npx vitest run src/__tests__/unit/analyzer.test.ts
```

Expected: PASS 4 tests (1 原有 + 3 新)

- [ ] **Step 7: Commit**

```bash
git add src/agent/analysis/analyzer.ts src/__tests__/unit/analyzer.test.ts
git commit -m "feat(analyzer): 两阶段分析 + 多 project + bug_fix_events 写入 + reuseIssueId"
```

---

## Task 7: approve-l3-handler（新 capability handler）

**Files:**
- Create: `src/agent/approval/approve-l3-handler.ts`
- Create: `src/__tests__/unit/approve-l3-handler.test.ts`

**Rationale:** L3 审批改成 capability 化，executor.ts 和 approval-manager.ts 零改动，动态 approverIds 在 handler 内部决定。

**Spec ref:** "approve_l3 capability handler"

**关联 AC:** AC2（主仓库 owner 审批、从仓库 owner 知情）、AC3（超时）、AC6（reanalyze 决策）

- [ ] **Step 1: 写失败测试 - 成功审批路径**

```typescript
// src/__tests__/unit/approve-l3-handler.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleApproveL3 } from '../../agent/approval/approve-l3-handler.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'

describe('approve_l3 handler', () => {
  beforeEach(async () => {
    await cleanDb()
    // 装一个 mock IMAdapter
    PipelineApprovalManager.initialize([{
      sendDirectMessage: vi.fn().mockResolvedValue(undefined),
    } as any])
  })

  it('approves → returns success', async () => {
    // 准备数据：创建 report + 两个 scope_identified + 两个 project 都有 owner
    const report = await setupL3Report({ primaryProject: 'PAM/pas-6.0', otherProject: 'PAM/pas-api' })

    // mock requestApproval 返回 'approved'
    vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('approved')

    const result = await handleApproveL3({
      capabilityKey: 'approve_l3',
      context: { taskId: 't', groupId: 'g', platform: 'pipeline', initiatorId: 'p', initiatorRole: 'admin' },
      extraParams: { reportId: report.id },
    })

    expect(result.success).toBe(true)

    // 验证 approval 事件已写
    const events = await findByReportCode(report.id, 'approval')
    expect(events).toHaveLength(1)
    expect((events[0].data as any).decision).toBe('approved')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/approve-l3-handler.test.ts
```

Expected: FAIL - "Cannot find module '.../approve-l3-handler.js'"

- [ ] **Step 3: 创建 handler 最小实现**

```typescript
// src/agent/approval/approve-l3-handler.ts
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findByReportCode } from '../../db/repositories/bug-fix-events.js'
import { getProjectByGitlabPath } from '../../db/repositories/projects.js'
import { findOwner } from '../../db/repositories/module-owners.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'

export async function handleApproveL3(opts: TriggerOptions): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) {
    return { success: false, error: 'missing_reportId', output: '参数错误: 缺少 reportId' }
  }

  // 1. 查 report 拿 primary_project_path + issue_id
  const report = await getBugAnalysisReportById(reportId)
  if (!report) return { success: false, error: 'report_not_found', output: `报告 ${reportId} 不存在` }
  if (!report.primaryProjectPath) {
    return { success: false, error: 'no_primary_project', output: '报告缺少 primary_project_path' }
  }

  // 2. 查主仓库 owner
  const primary = await getProjectByGitlabPath(report.primaryProjectPath)
  const primaryOwnerId = primary?.ownerId
    ?? (await findOwner(report.productLineId, report.primaryProjectPath))?.ownerUserId
  if (!primaryOwnerId) {
    return { success: false, error: 'no_primary_owner', output: `主仓库 ${report.primaryProjectPath} 未配置负责人` }
  }

  // 3. 查从仓库 owner 列表（去重，排除主仓库 owner）
  const scopes = await findByReportCode(reportId, 'scope_identified')
  const otherOwnerIds = new Set<string>()
  for (const s of scopes) {
    if (s.projectPath === report.primaryProjectPath) continue
    const proj = await getProjectByGitlabPath(s.projectPath!)
    const oid = proj?.ownerId
      ?? (await findOwner(report.productLineId, s.projectPath!))?.ownerUserId
    if (oid && oid !== primaryOwnerId) otherOwnerIds.add(oid)
  }

  // 4. 发知情 DM 给从仓库 owner（直接调 IM adapter，不走 approval-manager）
  const mgr = PipelineApprovalManager.getInstance()
  const adapter = (mgr as any).adapters?.[0]
  if (adapter && otherOwnerIds.size > 0) {
    const summary = truncate(report.rootCauseSummary ?? '', 200)
    const fyiText = buildFyiMessage({
      issueUrl: report.issueUrl,
      primaryProjectPath: report.primaryProjectPath,
      primaryOwnerName: primary?.ownerName ?? primaryOwnerId,
      summary,
    })
    await Promise.all(
      Array.from(otherOwnerIds).map(oid =>
        adapter.sendDirectMessage(oid, { text: fyiText }).catch((err: unknown) => {
          console.error('[approve_l3] FYI DM failed for', oid, err)
        }),
      ),
    )
  }

  // 5. 请求主仓库 owner 审批
  const startTime = Date.now()
  const description = buildApprovalDescription(report, scopes)
  const decision = await mgr.requestApproval(
    [primaryOwnerId],
    description,
    3600_000,
    String(report.issueId),
  )

  // 6. 写 approval 事件
  await createEvent({
    reportId,
    projectPath: null,
    code: 'approval',
    status: decision === 'approved' ? 'success' : 'failed',
    durationMs: Date.now() - startTime,
    data: { decision, approverId: primaryOwnerId, approverName: primary?.ownerName },
  })

  // 7. 映射决策到返回值
  if (decision === 'approved') return { success: true, output: '审批通过' }
  return {
    success: false,
    error: decision,   // 'rejected' / 'timeout' / 'retry_analysis'
    output: `审批结果: ${decision}`,
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '...' : s
}

function buildFyiMessage(p: {
  issueUrl: string
  primaryProjectPath: string
  primaryOwnerName: string
  summary: string
}): string {
  return `ℹ️ L3 修复方案知情\n\nBug 涉及你负责的服务（非主仓库），主负责人 ${p.primaryOwnerName} 正在审批方案。\n\nIssue: ${p.issueUrl}\n主仓库: ${p.primaryProjectPath}\n\n方案摘要: ${p.summary}\n\n如对方案有疑问，请直接联系主负责人。`
}

function buildApprovalDescription(report: any, scopes: any[]): string {
  const projects = scopes.map(s => `- ${s.projectPath}${(s.data?.isPrimary) ? '（主仓库）' : ''}`).join('\n')
  return `## L3 Bug 修复方案审批\n\nIssue: ${report.issueUrl}\n\n涉及 project:\n${projects}\n\n根因摘要: ${report.rootCauseSummary ?? ''}`
}

registerCapabilityHandler('approve_l3', handleApproveL3)
```

**注意**：`getProjectByGitlabPath` / `findOwner` 是现有 repo 的函数，如果不存在需要补建（参照 `src/db/repositories/module-owners.ts`）。

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/__tests__/unit/approve-l3-handler.test.ts
```

Expected: PASS 1 test

- [ ] **Step 5: 加其他测试场景**

```typescript
it('rejected → returns failure with error=rejected', async () => {
  vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('rejected')
  const result = await handleApproveL3({ extraParams: { reportId: report.id } } as any)
  expect(result.success).toBe(false)
  expect(result.error).toBe('rejected')
})

it('timeout → returns failure with error=timeout', async () => {
  vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('timeout')
  const result = await handleApproveL3({ extraParams: { reportId: report.id } } as any)
  expect(result.error).toBe('timeout')
})

it('retry_analysis → returns failure with error=retry_analysis', async () => {
  vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('retry_analysis')
  const result = await handleApproveL3({ extraParams: { reportId: report.id } } as any)
  expect(result.error).toBe('retry_analysis')
})

it('deduplicates owners: same user owns multiple projects → only one FYI DM', async () => {
  // 设置: 从仓库 A 和 B 都是 user-x 负责
  const result = await handleApproveL3({ /* ... */ } as any)
  expect(mockSendDirectMessage).toHaveBeenCalledTimes(1)
})

it('excludes primary owner from FYI recipients', async () => {
  // 设置: 从仓库的 owner 恰好是主仓库 owner
  await handleApproveL3({ /* ... */ } as any)
  expect(mockSendDirectMessage).not.toHaveBeenCalled()  // 主 owner 的审批 DM 由 approval-manager 发，不重复
})

it('returns no_primary_owner when primary repo has no owner configured', async () => {
  // 主仓库 owner_id = '' + module_owners 查不到
  const result = await handleApproveL3({ extraParams: { reportId: reportWithNoPrimaryOwner.id } } as any)
  expect(result.error).toBe('no_primary_owner')
})
```

- [ ] **Step 6: 跑完所有测试**

```bash
npx vitest run src/__tests__/unit/approve-l3-handler.test.ts
```

Expected: PASS 6 tests

- [ ] **Step 7: 注册到 MCP server 和服务启动时**

```bash
grep -n "registerFixHandlers\|registerAnalysisBugHandler" src/server.ts
```

参照同样 pattern 在 `src/server.ts` 启动序列加 `import './agent/approval/approve-l3-handler.js'`（让 `registerCapabilityHandler` 调用生效）。

- [ ] **Step 8: Commit**

```bash
git add src/agent/approval/approve-l3-handler.ts src/__tests__/unit/approve-l3-handler.test.ts src/server.ts
git commit -m "feat(approval): approve_l3 capability handler + 动态审批人"
```

---

## Task 8: create-mr-handler（新 capability handler）

**Files:**
- Create: `src/agent/mr/mr-handler.ts`
- Create: `src/__tests__/unit/create-mr-handler.test.ts`

**Rationale:** 把 `createMrViaApi` 从 fix-runner 里拆出来，改成独立 capability，支持多 project 循环，幂等。

**Spec ref:** "create_mr（新 capability handler）"

**关联 AC:** AC1、AC2（主仓库 Closes + 从仓库 Related to）、AC4（幂等）

**关键规则**：
- 主仓库 MR description 写 `Closes #<mainIssueIid>`
- 从仓库 MR description 写 `Related to PAM/<主仓库>#<mainIssueIid>`（不自动关 Issue）
- 涉及多 project 时 description 顶部加 `⚠️ 此修复涉及 N 个服务...` 提示
- 幂等：查 `bug_fix_events(code='create_mr', project_path=当前)` 若存在则跳过

- [ ] **Step 1: 写失败测试 - 单 project 创建 MR**

```typescript
// src/__tests__/unit/create-mr-handler.test.ts
import { describe, it, expect, vi } from 'vitest'
import { handleCreateMr } from '../../agent/mr/mr-handler.js'

describe('create_mr handler', () => {
  it('creates MR for each project with fix_attempt success', async () => {
    const report = await setupReportWithFix({
      projects: [{ path: 'PAM/pas-api', isPrimary: true, branch: 'fix/bug-1' }],
      mainIssueIid: 100,
    })
    vi.mocked(gitlabCreateMr).mockResolvedValue({ iid: 55, url: 'http://mr/55' })

    const result = await handleCreateMr({
      extraParams: { reportId: report.id },
    } as any)

    expect(result.success).toBe(true)
    expect(gitlabCreateMr).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: 'PAM/pas-api',
      description: expect.stringContaining('Closes #100'),
    }))

    const events = await findByReportCode(report.id, 'create_mr')
    expect(events).toHaveLength(1)
    expect((events[0].data as any).mrIid).toBe(55)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/create-mr-handler.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现 handler**

```typescript
// src/agent/mr/mr-handler.ts
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import { createEvent, findByReportCode, findDistinctProjects, findLatest, findPrimaryCreateIssue } from '../../db/repositories/bug-fix-events.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import axios from 'axios'

export async function handleCreateMr(opts: TriggerOptions): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) return { success: false, error: 'missing_reportId', output: '参数错误: 缺少 reportId' }

  const report = await getBugAnalysisReportById(reportId)
  if (!report) return { success: false, error: 'report_not_found', output: `报告 ${reportId} 不存在` }

  const primaryIssue = await findPrimaryCreateIssue(reportId)
  if (!primaryIssue) {
    return { success: false, error: 'no_primary_issue', output: '找不到主 Issue 事件，无法关联 MR' }
  }
  const mainIssueIid = (primaryIssue.data as any).issueIid as number
  const primaryProjectPath = primaryIssue.projectPath!

  // 找所有修复成功的 project
  const projects = await findDistinctProjects(reportId)
  const projectsToMr: Array<{ path: string; branch: string; targetBranch: string; isPrimary: boolean }> = []
  for (const p of projects) {
    const latest = await findLatest(reportId, p, 'fix_attempt')
    if (!latest || latest.status !== 'success') continue
    projectsToMr.push({
      path: p,
      branch: (latest.data as any).branch,
      targetBranch: (latest.data as any).targetBranch ?? 'master',
      isPrimary: p === primaryProjectPath,
    })
  }

  if (projectsToMr.length === 0) {
    return { success: false, error: 'no_successful_fixes', output: '无成功修复的 project' }
  }

  const multiProject = projectsToMr.length > 1
  const results: Array<{ path: string; mrIid: number; mrUrl: string }> = []
  const errors: Array<{ path: string; error: string }> = []

  for (const p of projectsToMr) {
    // 幂等检查
    const existing = await findLatest(reportId, p.path, 'create_mr')
    if (existing && existing.status === 'success') {
      results.push({ path: p.path, mrIid: (existing.data as any).mrIid, mrUrl: (existing.data as any).mrUrl })
      continue
    }

    const description = buildMrDescription({
      isPrimary: p.isPrimary,
      mainIssueIid,
      primaryProjectPath,
      multiProjectCount: projectsToMr.length,
    })

    try {
      const mr = await gitlabCreateMr({
        projectPath: p.path,
        sourceBranch: p.branch,
        targetBranch: p.targetBranch,
        title: buildMrTitle(report, p.path),
        description,
      })
      await createEvent({
        reportId,
        projectPath: p.path,
        code: 'create_mr',
        status: 'success',
        data: { mrIid: mr.iid, mrUrl: mr.url, branch: p.branch, isPrimary: p.isPrimary },
      })
      results.push({ path: p.path, mrIid: mr.iid, mrUrl: mr.url })
    } catch (err) {
      const msg = (err as any)?.message ?? String(err)
      await createEvent({
        reportId,
        projectPath: p.path,
        code: 'create_mr',
        status: 'failed',
        data: { error: msg, branch: p.branch, isPrimary: p.isPrimary },
      })
      errors.push({ path: p.path, error: msg })
    }
  }

  if (errors.length > 0) {
    return {
      success: false,
      error: 'gitlab_api_error',
      output: `部分 project 创建 MR 失败: ${errors.map(e => e.path).join(', ')}`,
    }
  }

  return {
    success: true,
    output: `创建 ${results.length} 个 MR: ${results.map(r => `${r.path}#${r.mrIid}`).join(', ')}`,
  }
}

function buildMrDescription(p: {
  isPrimary: boolean
  mainIssueIid: number
  primaryProjectPath: string
  multiProjectCount: number
}): string {
  const lines: string[] = []
  if (p.multiProjectCount > 1) {
    lines.push(`⚠️ 此修复涉及 ${p.multiProjectCount} 个服务，请协调各 MR 的合并顺序。`)
    lines.push(`主仓库 MR 合并后会关闭 Issue；请优先合并主仓库 MR。`)
    lines.push('')
  }
  if (p.isPrimary) {
    lines.push(`Closes #${p.mainIssueIid}`)
  } else {
    lines.push(`Related to ${p.primaryProjectPath}#${p.mainIssueIid}`)
  }
  lines.push('')
  lines.push('本 MR 由 ChatOps AI 助手自动创建。')
  return lines.join('\n')
}

function buildMrTitle(report: any, projectPath: string): string {
  return `[${report.level.toUpperCase()}] ${report.rootCauseSummary?.slice(0, 60) ?? 'Bug 修复'} (${projectPath})`
}

async function gitlabCreateMr(params: {
  projectPath: string
  sourceBranch: string
  targetBranch: string
  title: string
  description: string
}): Promise<{ iid: number; url: string }> {
  const gitlabUrl = process.env.GITLAB_URL
  const gitlabToken = process.env.GITLAB_TOKEN
  if (!gitlabUrl || !gitlabToken) throw new Error('缺少 GITLAB_URL 或 GITLAB_TOKEN')

  const { data } = await axios.post(
    `${gitlabUrl}/api/v4/projects/${encodeURIComponent(params.projectPath)}/merge_requests`,
    {
      source_branch: params.sourceBranch,
      target_branch: params.targetBranch,
      title: params.title,
      description: params.description,
      labels: 'ai-generated',
    },
    { headers: { 'PRIVATE-TOKEN': gitlabToken } },
  )
  return { iid: data.iid, url: data.web_url }
}

registerCapabilityHandler('create_mr', handleCreateMr)
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/__tests__/unit/create-mr-handler.test.ts
```

Expected: PASS 1

- [ ] **Step 5: 加其他场景测试**

```typescript
it('multi-project: primary uses Closes, others use Related to', async () => {
  const report = await setupReportWithFix({
    projects: [
      { path: 'PAM/pas-6.0', isPrimary: true, branch: 'fix/bug-1' },
      { path: 'PAM/pas-api', isPrimary: false, branch: 'fix/bug-1' },
    ],
    mainIssueIid: 100,
  })
  vi.mocked(gitlabCreateMr).mockResolvedValue({ iid: 1, url: 'x' })

  await handleCreateMr({ extraParams: { reportId: report.id } } as any)

  const calls = vi.mocked(gitlabCreateMr).mock.calls
  const primaryCall = calls.find(c => c[0].projectPath === 'PAM/pas-6.0')
  const secondaryCall = calls.find(c => c[0].projectPath === 'PAM/pas-api')

  expect(primaryCall?.[0].description).toContain('Closes #100')
  expect(primaryCall?.[0].description).not.toContain('Related to')
  expect(secondaryCall?.[0].description).toContain('Related to PAM/pas-6.0#100')
  expect(secondaryCall?.[0].description).not.toMatch(/Closes #\d/)
})

it('multi-project adds coordination warning in description', async () => {
  await handleCreateMr({ /* 2 projects */ } as any)
  const descriptions = vi.mocked(gitlabCreateMr).mock.calls.map(c => c[0].description)
  for (const d of descriptions) {
    expect(d).toContain('此修复涉及 2 个服务')
  }
})

it('idempotent: skips projects that already have create_mr event', async () => {
  const report = await setupReportWithFix({ /* ... */ })
  // 预置一条 create_mr 事件
  await createEvent({
    reportId: report.id,
    projectPath: 'PAM/pas-api',
    code: 'create_mr',
    status: 'success',
    data: { mrIid: 99, mrUrl: 'old', branch: 'fix/bug-1', isPrimary: true },
  })

  await handleCreateMr({ extraParams: { reportId: report.id } } as any)

  expect(gitlabCreateMr).not.toHaveBeenCalled()
})

it('partial failure: records failed event, returns gitlab_api_error', async () => {
  vi.mocked(gitlabCreateMr)
    .mockResolvedValueOnce({ iid: 1, url: 'a' })
    .mockRejectedValueOnce(new Error('GitLab 500'))

  const result = await handleCreateMr({ /* 2 projects */ } as any)
  expect(result.success).toBe(false)
  expect(result.error).toBe('gitlab_api_error')
  const events = await findByReportCode(report.id, 'create_mr')
  expect(events.filter(e => e.status === 'failed')).toHaveLength(1)
})
```

- [ ] **Step 6: 注册 handler**

在 `src/server.ts` 加 `import './agent/mr/mr-handler.js'`。

- [ ] **Step 7: 跑所有测试**

```bash
npx vitest run src/__tests__/unit/create-mr-handler.test.ts
```

Expected: PASS 5 tests

- [ ] **Step 8: Commit**

```bash
git add src/agent/mr/mr-handler.ts src/__tests__/unit/create-mr-handler.test.ts src/server.ts
git commit -m "feat(mr): create_mr capability handler + 多 project + Closes/Related to"
```

---

## Task 9: notify-handler（新 capability handler）

**Files:**
- Create: `src/agent/notify/notify-handler.ts`
- Create: `src/__tests__/unit/notify-handler.test.ts`

**Rationale:** 把通知从 coordinator.onComplete 搬到 Pipeline stage，好处：通知失败可追踪可重试，状态可见。

**Spec ref:** "notify_bug（新 capability handler）" + "DM 通知策略"

**关联 AC:** AC1（成功通知）、AC2（按 project 去重）

**通知场景决策树**：

```
report.classification != 'bug'（L4 只有 notify_bug stage）:
  → 通知触发人："已创建 Issue..."（如有 Issue）或 "分析结果: ..."

有 approval 事件：
  decision='rejected'     → 通知触发人："审批被拒"
  decision='timeout'      → 通知触发人："审批超时"
  decision='retry_analysis' → 通知触发人："触发重新分析"（本 Pipeline 终止，新 Pipeline 会再发）

有 fix_attempt 全部成功 + create_mr 事件：
  ai_review label:
    ai-approved       → 触发人 + 各 project owner: "Bug 已修复，MR 等待合并"
    ai-needs-attention → 触发人 + 各 project owner: "AI Review 发现问题，请关注 MR"
  无 ai_review 事件（continue onFailure 场景） → 触发人 + 各 project owner: "Bug 已修复（Review 跳过）"

fix_attempt 全部失败：
  → 通知触发人："修复失败，需要人工介入"
```

- [ ] **Step 1: 写失败测试 - L2 全成功路径**

```typescript
// src/__tests__/unit/notify-handler.test.ts
it('L2 全成功: 触发人 + 各 project owner 各一条', async () => {
  const report = await setupFullSuccessL2({
    projects: [{ path: 'PAM/pas-api', ownerId: 'u-api' }],
    mrIid: 55,
    reviewLabel: 'ai-approved',
    triggeredBy: 'u-trigger',
  })

  const result = await handleNotify({ extraParams: { reportId: report.id } } as any)

  expect(result.success).toBe(true)
  const events = await findByReportCode(report.id, 'notify')
  expect(events).toHaveLength(2)  // u-api + u-trigger
  expect(events.every(e => e.status === 'success')).toBe(true)

  // 触发人消息包含所有 MR
  const triggerMsg = events.find(e => (e.data as any).userId === 'u-trigger')
  expect((triggerMsg?.data as any).mrIids).toEqual([55])
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/notify-handler.test.ts
```

Expected: FAIL

- [ ] **Step 3: 实现 handler**

```typescript
// src/agent/notify/notify-handler.ts
import type { TriggerOptions, TriggerResult } from '../coordinator.js'
import { registerCapabilityHandler } from '../coordinator.js'
import { createEvent, findByReport, findByReportCode, findDistinctProjects, findLatest } from '../../db/repositories/bug-fix-events.js'
import { getBugAnalysisReportById } from '../../db/repositories/bug-analysis-reports.js'
import { getProjectByGitlabPath } from '../../db/repositories/projects.js'
import { findOwner } from '../../db/repositories/module-owners.js'
import { getTestRunById } from '../../db/repositories/test-runs.js'
import { PipelineApprovalManager } from '../../pipeline/approval-manager.js'

type MessageKind =
  | 'l4_created'
  | 'approval_rejected'
  | 'approval_timeout'
  | 'approval_retry_analysis'
  | 'fix_success'
  | 'fix_success_review_concerns'
  | 'fix_failed'

export async function handleNotify(opts: TriggerOptions): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) return { success: false, error: 'missing_reportId', output: '参数错误: 缺少 reportId' }

  const report = await getBugAnalysisReportById(reportId)
  if (!report) return { success: false, error: 'report_not_found', output: `报告 ${reportId} 不存在` }

  // 1. 决策通知场景
  const scenario = await decideScenario(reportId, report)

  // 2. 计算触发人 + 各 project owner
  const triggeredBy = await getTriggeredByFromRun(report.pipelineRunId)
  const projectOwners = await gatherProjectOwners(reportId, report.productLineId)

  // 3. 构造消息并发送
  const mgr = PipelineApprovalManager.getInstance()
  const adapter = (mgr as any).adapters?.[0]
  if (!adapter) return { success: false, error: 'no_adapter', output: '无可用 IM adapter' }

  const failures: string[] = []

  // 先发各 project owner（去重）
  const uniqueOwners = new Map<string, { projectPaths: string[]; mrIids: number[] }>()
  for (const po of projectOwners) {
    if (!po.ownerId) continue
    const entry = uniqueOwners.get(po.ownerId) ?? { projectPaths: [], mrIids: [] }
    entry.projectPaths.push(po.projectPath)
    if (po.mrIid) entry.mrIids.push(po.mrIid)
    uniqueOwners.set(po.ownerId, entry)
  }

  for (const [ownerId, info] of uniqueOwners) {
    const text = buildMessage(scenario.kind, {
      role: 'owner',
      report,
      scenario,
      projectPaths: info.projectPaths,
      mrIids: info.mrIids,
    })
    if (!text) continue  // 某些场景不通知 owner（如审批相关消息只通知触发人）

    try {
      await adapter.sendDirectMessage(ownerId, { text })
      await createEvent({
        reportId, projectPath: null, code: 'notify',
        status: 'success',
        data: { userId: ownerId, role: 'owner', messageKind: scenario.kind, mrIids: info.mrIids },
      })
    } catch (err) {
      const msg = (err as any)?.message ?? String(err)
      await createEvent({
        reportId, projectPath: null, code: 'notify',
        status: 'failed',
        data: { userId: ownerId, role: 'owner', messageKind: scenario.kind, mrIids: info.mrIids, error: msg },
      })
      failures.push(`owner ${ownerId}: ${msg}`)
    }
  }

  // 发触发人（汇总）
  if (triggeredBy) {
    const allMrIids = projectOwners.map(p => p.mrIid).filter((n): n is number => !!n)
    const text = buildMessage(scenario.kind, {
      role: 'initiator',
      report,
      scenario,
      projectPaths: projectOwners.map(p => p.projectPath),
      mrIids: allMrIids,
    })
    if (text) {
      try {
        await adapter.sendDirectMessage(triggeredBy, { text })
        await createEvent({
          reportId, projectPath: null, code: 'notify',
          status: 'success',
          data: { userId: triggeredBy, role: 'initiator', messageKind: scenario.kind, mrIids: allMrIids },
        })
      } catch (err) {
        const msg = (err as any)?.message ?? String(err)
        await createEvent({
          reportId, projectPath: null, code: 'notify',
          status: 'failed',
          data: { userId: triggeredBy, role: 'initiator', messageKind: scenario.kind, mrIids: allMrIids, error: msg },
        })
        failures.push(`initiator ${triggeredBy}: ${msg}`)
      }
    }
  }

  if (failures.length > 0) {
    return { success: false, error: 'im_api_error', output: `DM 失败: ${failures.join('; ')}` }
  }
  return { success: true, output: `已发送通知 ${uniqueOwners.size + (triggeredBy ? 1 : 0)} 条` }
}

// 场景判断辅助函数 + 消息模板
async function decideScenario(reportId: number, report: any) { /* ... */ }
async function getTriggeredByFromRun(runId: number | null) { /* ... */ }
async function gatherProjectOwners(reportId: number, productLineId: number) { /* ... */ }
function buildMessage(kind: MessageKind, ctx: any): string | null { /* 按 DM 通知策略表 */ }

registerCapabilityHandler('notify_bug', handleNotify)
```

**messageKind → 文案模板**（实现要参考 spec 的"DM 通知策略"表）：

```
l4_created:       "已创建 Issue #{iid}，此问题需要人工处理\n{issueUrl}\n{rootCause}"
approval_rejected: "L3 修复方案审批被拒绝\nIssue: {url}"
approval_timeout:  "L3 审批超时，Pipeline 已终止，可在 Bug 修复实例页面重试"
approval_retry_analysis: "L3 审批方案需重新分析，新一轮分析将自动开始"
fix_success (initiator): "Bug 已自动修复，{N} 个 MR 等待合并:\n{MR 列表}"
fix_success (owner):     "你负责的 {project} 服务已自动修复，MR 等待合并:\n{自己 project 的 MR}"
fix_success_review_concerns (owner): "⚠️ AI Review 发现问题，请关注你的 MR: {MR URL}"
fix_failed: "修复失败，需要人工介入\nIssue: {url}\n失败原因: {error}"
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/__tests__/unit/notify-handler.test.ts
```

- [ ] **Step 5: 加测试场景**

```typescript
it('same owner for multiple projects: only one DM with combined MR list', async () => {
  const report = await setupFullSuccessL2({
    projects: [
      { path: 'PAM/a', ownerId: 'u-shared', mrIid: 1 },
      { path: 'PAM/b', ownerId: 'u-shared', mrIid: 2 },
    ],
  })
  await handleNotify({ extraParams: { reportId: report.id } } as any)
  const ownerNotifies = (await findByReportCode(report.id, 'notify'))
    .filter(e => (e.data as any).role === 'owner')
  expect(ownerNotifies).toHaveLength(1)
  expect((ownerNotifies[0].data as any).mrIids.sort()).toEqual([1, 2])
})

it('DM failure: records failed event, continues other recipients, returns stage=failed', async () => {
  vi.spyOn(adapter, 'sendDirectMessage')
    .mockRejectedValueOnce(new Error('网络错误'))  // owner 1 失败
    .mockResolvedValue(undefined)                    // 其他成功

  const result = await handleNotify({ /* ... */ } as any)
  expect(result.success).toBe(false)
  expect(result.error).toBe('im_api_error')
  const failed = (await findByReportCode(report.id, 'notify')).filter(e => e.status === 'failed')
  expect(failed).toHaveLength(1)
})

it('no owner configured: skips that project silently, returns success if others succeed', async () => {
  // owner_id 空 + module_owners 查不到
  const result = await handleNotify({ /* 1 owner 空 + 触发人有 */ } as any)
  expect(result.success).toBe(true)  // 触发人 DM 成功即可
})

it('approval_timeout scenario: only notifies initiator, no owner DM', async () => {
  const report = await setupWithApprovalEvent('timeout')
  await handleNotify({ extraParams: { reportId: report.id } } as any)
  const events = (await findByReportCode(report.id, 'notify'))
  expect(events).toHaveLength(1)
  expect((events[0].data as any).role).toBe('initiator')
  expect((events[0].data as any).messageKind).toBe('approval_timeout')
})
```

- [ ] **Step 6: 注册 handler**

`src/server.ts` 加 `import './agent/notify/notify-handler.js'`。

- [ ] **Step 7: 跑所有测试**

```bash
npx vitest run src/__tests__/unit/notify-handler.test.ts
```

Expected: PASS 5+ tests

- [ ] **Step 8: Commit**

```bash
git add src/agent/notify/notify-handler.ts src/__tests__/unit/notify-handler.test.ts src/server.ts
git commit -m "feat(notify): notify_bug capability handler + 多场景消息模板"
```

---

## Task 10: fix-runner.ts 改造（多 project + 删内嵌 createMr/handleFixComplete）

**Files:**
- Modify: `src/agent/fix/fix-runner.ts`
- Modify: `src/__tests__/unit/fix-runner.test.ts`（若无则创建）

**Rationale:** 现在 fix-runner 单仓库 + 修复完内嵌调 createMrViaApi + handleFixComplete，新设计把这两个职责拆出去，fix-runner 只负责修复 + 写 fix_attempt 事件。

**Spec ref:** "fix-runner.ts 修改"

**关联 AC:** AC1、AC2（多 project 并行修复）、AC4（幂等）

**改动：**
1. 删除内嵌的 `createMrViaApi` 调用
2. 删除 `handleFixComplete` 调用
3. 删除 `retryWithDowngrade`（重试由 Pipeline retryCount 控制）
4. 从 `bug_fix_events(code='scope_identified')` 读待修复 project 列表
5. 对每个 project 分别 clone worktree（带 project_path 区分）+ 修复 + 写 `fix_attempt` 事件
6. 幂等：跳过已 `fix_attempt(status='success')` 的 project

- [ ] **Step 1: 读现有 fix-runner.ts，列出要删的代码**

```bash
grep -n "createMrViaApi\|handleFixComplete\|retryWithDowngrade" src/agent/fix/fix-runner.ts
```

Expected: 找到这三个调用位置，准备删除。

- [ ] **Step 2: 写失败测试 - 多 project 修复**

```typescript
// src/__tests__/unit/fix-runner.test.ts
it('fixes each project in scope_identified, writes fix_attempt per project', async () => {
  const report = await setupReport({
    projects: [
      { path: 'PAM/pas-6.0', sourceBranch: 'master', modules: ['auth'] },
      { path: 'PAM/pas-api', sourceBranch: 'master', modules: ['config'] },
    ],
  })

  // mock clone + claude fix + test
  vi.mocked(runClaudeFix).mockResolvedValue({ branch: 'fix/bug-1', testPassed: true })

  const result = await handleFixBug({
    capabilityKey: 'fix_bug_l2',
    context: { /* ... */ } as any,
    extraParams: { reportId: report.id },
  }, 'l2')

  expect(result.success).toBe(true)

  const events = await findByReportCode(report.id, 'fix_attempt')
  expect(events).toHaveLength(2)
  expect(events.every(e => e.status === 'success')).toBe(true)
  expect(new Set(events.map(e => e.projectPath))).toEqual(new Set(['PAM/pas-6.0', 'PAM/pas-api']))
})

it('idempotent: skips project that already has successful fix_attempt', async () => {
  const report = await setupReport({ projects: [{ path: 'PAM/a' }, { path: 'PAM/b' }] })
  await createEvent({
    reportId: report.id, projectPath: 'PAM/a', code: 'fix_attempt', status: 'success',
    data: { branch: 'fix/old', attempt: 1 },
  })

  vi.mocked(runClaudeFix).mockResolvedValue({ branch: 'fix/new', testPassed: true })

  await handleFixBug({ extraParams: { reportId: report.id } } as any, 'l2')

  // runClaudeFix 只被调用一次（PAM/b），PAM/a 跳过
  expect(runClaudeFix).toHaveBeenCalledTimes(1)
  expect(vi.mocked(runClaudeFix).mock.calls[0][0].projectPath).toBe('PAM/b')
})

it('partial failure: records failed event, returns stage=failed', async () => {
  const report = await setupReport({ projects: [{ path: 'PAM/a' }, { path: 'PAM/b' }] })
  vi.mocked(runClaudeFix)
    .mockResolvedValueOnce({ branch: 'fix/a', testPassed: true })  // a 成功
    .mockResolvedValueOnce({ branch: 'fix/b', testPassed: false })  // b 测试失败

  const result = await handleFixBug({ extraParams: { reportId: report.id } } as any, 'l2')
  expect(result.success).toBe(false)
  const failed = (await findByReportCode(report.id, 'fix_attempt')).filter(e => e.status === 'failed')
  expect(failed).toHaveLength(1)
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/fix-runner.test.ts
```

Expected: FAIL (需要改造)

- [ ] **Step 4: 改造 fix-runner.ts 的 handleFixBug**

```typescript
// 伪代码骨架
export async function handleFixBug(opts: TriggerOptions, level: string): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) return { success: false, error: 'missing_reportId', output: '...' }

  const report = await getBugAnalysisReportById(reportId)
  if (!report) return { success: false, error: 'report_not_found', output: '...' }

  // 读所有 scope_identified，决定要修哪些 project
  const scopes = await findByReportCode(reportId, 'scope_identified')
  if (scopes.length === 0) {
    return { success: false, error: 'no_scope', output: '缺少 scope_identified 事件' }
  }

  const failures: string[] = []
  const successes: string[] = []

  for (const scope of scopes) {
    const projectPath = scope.projectPath!

    // 幂等检查
    const existingSuccess = await findLatest(reportId, projectPath, 'fix_attempt')
    if (existingSuccess && existingSuccess.status === 'success') {
      successes.push(projectPath)
      continue
    }

    const data = scope.data as any
    const sourceBranch = data.sourceBranch ?? 'master'
    const affectedModules = data.affectedModules ?? []

    // 决定重试次数（从历史 fix_attempt 里数出来，作为本次 attempt 序号）
    const history = await findByReport(reportId)
    const prevAttempts = history.filter(e => e.code === 'fix_attempt' && e.projectPath === projectPath).length
    const attempt = prevAttempts + 1

    try {
      const fixResult = await runFixForProject({
        reportId,
        productLineId: report.productLineId,
        projectPath,
        sourceBranch,
        affectedModules,
        rootCauseSummary: report.rootCauseSummary,
        solutionsJson: report.solutionsJson,
        level,
        signal: opts.signal,
      })

      await createEvent({
        reportId, projectPath, code: 'fix_attempt',
        status: fixResult.testPassed ? 'success' : 'failed',
        data: {
          branch: fixResult.branch,
          targetBranch: sourceBranch,
          testResult: fixResult.testPassed,
          attempt,
          error: fixResult.testPassed ? undefined : fixResult.error,
        },
      })

      if (fixResult.testPassed) {
        successes.push(projectPath)
      } else {
        failures.push(`${projectPath}: 测试未通过`)
      }
    } catch (err) {
      const msg = (err as any)?.message ?? String(err)
      await createEvent({
        reportId, projectPath, code: 'fix_attempt',
        status: 'failed',
        data: { attempt, error: msg },
      })
      failures.push(`${projectPath}: ${msg}`)
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      error: 'fix_failed',
      output: `修复失败: ${failures.join('; ')}`,
    }
  }
  return { success: true, output: `修复完成 ${successes.length} 个 project` }
}

// runFixForProject 封装单 project 修复：acquire worktree（带 projectPath） → clone → Claude 修复 → run test → 返回结果
async function runFixForProject(params: {
  reportId: number
  productLineId: number
  projectPath: string
  sourceBranch: string
  affectedModules: string[]
  rootCauseSummary: string
  solutionsJson: unknown
  level: string
  signal?: AbortSignal
}): Promise<{ branch: string; testPassed: boolean; error?: string }> {
  // 用 makeWorktreeKey({ productLineId, projectPath, sourceBranch })
  // 跑 Claude fix（带 signal）
  // 跑 tests
  // 返回结果
}
```

**关键删除清单**：
- 删原 `createMrViaApi` 的定义和调用
- 删 `handleFixComplete` 的调用（通知现在由 notify_bug stage 负责）
- 删 `retryWithDowngrade`（Pipeline 的 retryCount 代替）

- [ ] **Step 5: 运行测试**

```bash
npx vitest run src/__tests__/unit/fix-runner.test.ts
```

Expected: PASS 3 tests

- [ ] **Step 6: 跑全仓单测确认无回归**

```bash
pnpm test
```

Expected: 所有测试 PASS（包括现有的 analyzer/coordinator/fix-runner 老测试）。若有老测试引用已删除的 `createMrViaApi`，需要一起清理。

- [ ] **Step 7: Commit**

```bash
git add src/agent/fix/fix-runner.ts src/__tests__/unit/fix-runner.test.ts
git commit -m "refactor(fix-runner): 多 project 修复 + 删内嵌 MR/通知逻辑 + 幂等"
```

---

## Task 11: reviewer.ts 改造（多 MR + 写 GitLab Note + 幂等）

**Files:**
- Modify: `src/agent/review/reviewer.ts`
- Modify: `src/__tests__/unit/reviewer.test.ts`（若无则创建）

**Rationale:** 现在 reviewer 单 MR + 只加 label。新设计需要：循环多 MR、把 Review 评语写到 GitLab MR Note、幂等跳过已 review 的 MR。

**Spec ref:** "ai_review_mr 修改"

**关联 AC:** AC1、AC2（多 MR review）

- [ ] **Step 1: 写失败测试 - 多 MR Review**

```typescript
// src/__tests__/unit/reviewer.test.ts
it('reviews each MR with create_mr event, writes GitLab Note + ai_review event', async () => {
  const report = await setupReportWithMrs({
    mrs: [
      { project: 'PAM/pas-6.0', mrIid: 55 },
      { project: 'PAM/pas-api', mrIid: 77 },
    ],
  })

  vi.mocked(runClaudeReview).mockResolvedValue({ label: 'ai-approved', summary: '代码合理' })
  vi.mocked(gitlabPostMrNote).mockResolvedValue({})

  const result = await handleReviewMr({
    extraParams: { reportId: report.id },
  } as any)

  expect(result.success).toBe(true)
  expect(gitlabPostMrNote).toHaveBeenCalledTimes(2)
  expect(gitlabPostMrNote).toHaveBeenCalledWith(expect.objectContaining({
    projectPath: 'PAM/pas-6.0',
    mrIid: 55,
    body: expect.stringContaining('代码合理'),
  }))

  const events = await findByReportCode(report.id, 'ai_review')
  expect(events).toHaveLength(2)
})

it('multi-project: Review body prepends cross-service warning', async () => {
  await handleReviewMr({ /* 2 MRs */ } as any)
  const calls = vi.mocked(gitlabPostMrNote).mock.calls
  expect(calls[0][0].body).toContain('此为跨服务修复的一部分')
})

it('idempotent: skips MRs that already have ai_review event', async () => {
  const report = await setupReportWithMrs({ mrs: [{ project: 'PAM/a', mrIid: 1 }, { project: 'PAM/b', mrIid: 2 }] })
  await createEvent({
    reportId: report.id, projectPath: 'PAM/a', code: 'ai_review', status: 'success',
    data: { mrIid: 1, label: 'ai-approved' },
  })

  await handleReviewMr({ extraParams: { reportId: report.id } } as any)
  expect(runClaudeReview).toHaveBeenCalledTimes(1)
  expect(vi.mocked(runClaudeReview).mock.calls[0][0].mrIid).toBe(2)
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/reviewer.test.ts
```

Expected: FAIL

- [ ] **Step 3: 改造 reviewer.ts**

```typescript
// src/agent/review/reviewer.ts 伪代码
export async function handleReviewMr(opts: TriggerOptions): Promise<TriggerResult> {
  const reportId = Number(opts.extraParams?.reportId)
  if (!reportId) return { success: false, error: 'missing_reportId', output: '...' }

  const createMrEvents = await findByReportCode(reportId, 'create_mr')
  const successMrs = createMrEvents.filter(e => e.status === 'success')
  if (successMrs.length === 0) {
    return { success: false, error: 'no_mrs', output: '无可 Review 的 MR' }
  }

  const multiProject = successMrs.length > 1
  const failures: string[] = []

  for (const mrEvent of successMrs) {
    const projectPath = mrEvent.projectPath!
    const mrIid = (mrEvent.data as any).mrIid as number

    // 幂等
    const existing = await findLatest(reportId, projectPath, 'ai_review')
    if (existing && existing.status === 'success') continue

    try {
      const review = await runClaudeReview({ projectPath, mrIid, signal: opts.signal })

      // 写 GitLab Note
      const prefix = multiProject ? '⚠️ 此为跨服务修复的一部分，请确保所有 MR 都通过 Review 后再协调合并。\n\n' : ''
      const body = `${prefix}## 🤖 AI Review 结果\n\n**结论:** ${review.label}\n\n${review.summary}`
      await gitlabPostMrNote({ projectPath, mrIid, body })

      // 写 label（保留现有逻辑）
      await gitlabUpdateMrLabels({ projectPath, mrIid, labelToAdd: review.label })

      await createEvent({
        reportId, projectPath, code: 'ai_review', status: 'success',
        data: { label: review.label, mrIid, reviewSummary: review.summary },
      })
    } catch (err) {
      const msg = (err as any)?.message ?? String(err)
      await createEvent({
        reportId, projectPath, code: 'ai_review', status: 'failed',
        data: { mrIid, error: msg },
      })
      failures.push(`MR ${projectPath}#${mrIid}: ${msg}`)
    }
  }

  // ai_review stage 在 Pipeline 配置里 onFailure=continue，即使 return failed 不阻断 Pipeline
  if (failures.length > 0) {
    return { success: false, error: 'review_failed', output: `Review 失败: ${failures.join('; ')}` }
  }
  return { success: true, output: `完成 Review ${successMrs.length} 个 MR` }
}

async function gitlabPostMrNote(params: { projectPath: string; mrIid: number; body: string }): Promise<void> {
  const gitlabUrl = process.env.GITLAB_URL
  const gitlabToken = process.env.GITLAB_TOKEN
  if (!gitlabUrl || !gitlabToken) throw new Error('缺少 GITLAB_URL/TOKEN')

  await axios.post(
    `${gitlabUrl}/api/v4/projects/${encodeURIComponent(params.projectPath)}/merge_requests/${params.mrIid}/notes`,
    { body: params.body },
    { headers: { 'PRIVATE-TOKEN': gitlabToken } },
  )
}
```

**关键**：保留现有的 label 更新逻辑（`ai-approved` / `ai-needs-attention`），只是**新增** Note 写入。

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/__tests__/unit/reviewer.test.ts
```

Expected: PASS 3+ tests

- [ ] **Step 5: 全仓回归**

```bash
pnpm test
```

Expected: 全部 PASS

- [ ] **Step 6: Commit**

```bash
git add src/agent/review/reviewer.ts src/__tests__/unit/reviewer.test.ts
git commit -m "feat(reviewer): 多 MR Review + GitLab Note 写入 + 幂等"
```

---

## Task 12: issue-handler.ts 瘦身 + MR merged/closed 状态同步

**Files:**
- Modify: `src/adapters/gitlab/issue-handler.ts`
- Modify: `src/__tests__/unit/issue-handler.test.ts`

**Rationale:** 老的 "label/MR-created → 触发 capability" 逻辑会和 Pipeline 双触发冲突。删掉它，保留 MR merge/close → `bug_analysis_reports.status` 同步。

**Spec ref:** "issue-handler.ts 瘦身 + MR 合并/关闭状态同步"

**关联 AC:** AC1（MR merged → completed）、AC7（MR closed → aborted）

- [ ] **Step 1: 读现有 issue-handler.ts 记录要删的函数**

```bash
cat src/adapters/gitlab/issue-handler.ts
```

记下 `handleMergeRequestEvent` / `handleIssueEvent` 里触发 capability 的分支。

- [ ] **Step 2: 写失败测试 - MR merged → status=completed**

```typescript
// src/__tests__/unit/issue-handler.test.ts
it('MR merged webhook → updates bug_analysis_reports.status to completed + writes lifecycle_sync event', async () => {
  const report = await setupReportWithCreateMr({
    projectPath: 'PAM/pas-6.0',
    mrIid: 55,
    initialStatus: 'pipeline_success',
  })

  await handleGitLabWebhook({
    object_kind: 'merge_request',
    object_attributes: { iid: 55, action: 'merge', /* ... */ },
    project: { path_with_namespace: 'PAM/pas-6.0' },
  } as any)

  const updated = await getBugAnalysisReportById(report.id)
  expect(updated?.status).toBe('completed')

  const events = await findByReportCode(report.id, 'lifecycle_sync')
  expect(events).toHaveLength(1)
  expect((events[0].data as any).mrAction).toBe('merge')
  expect((events[0].data as any).targetStatus).toBe('completed')
})

it('MR closed (not merged) → updates to aborted', async () => {
  const report = await setupReportWithCreateMr({ projectPath: 'PAM/a', mrIid: 10 })
  await handleGitLabWebhook({
    object_kind: 'merge_request',
    object_attributes: { iid: 10, action: 'close' },
    project: { path_with_namespace: 'PAM/a' },
  } as any)
  const updated = await getBugAnalysisReportById(report.id)
  expect(updated?.status).toBe('aborted')
})

it('MR open/update action: no status change (old label/MR-created dispatch deleted)', async () => {
  const report = await setupReportWithCreateMr({ projectPath: 'PAM/a', mrIid: 10, initialStatus: 'pipeline_success' })
  await handleGitLabWebhook({
    object_kind: 'merge_request',
    object_attributes: { iid: 10, action: 'open' },
    project: { path_with_namespace: 'PAM/a' },
  } as any)
  const updated = await getBugAnalysisReportById(report.id)
  expect(updated?.status).toBe('pipeline_success')  // unchanged
  // 旧的 ai_review_mr 触发逻辑已废除 → 验证 triggerCapability 未被调
  expect(mockTriggerCapability).not.toHaveBeenCalled()
})

it('MR merged twice (GitLab may retry webhook): idempotent, no duplicate lifecycle_sync', async () => {
  const report = await setupReportWithCreateMr({ projectPath: 'PAM/a', mrIid: 10 })
  const payload = {
    object_kind: 'merge_request',
    object_attributes: { iid: 10, action: 'merge' },
    project: { path_with_namespace: 'PAM/a' },
  }
  await handleGitLabWebhook(payload as any)
  await handleGitLabWebhook(payload as any)

  const events = await findByReportCode(report.id, 'lifecycle_sync')
  expect(events).toHaveLength(1)  // 第二次应跳过
})

it('MR not related to any report: webhook no-op', async () => {
  // 不预置 create_mr 事件
  await handleGitLabWebhook({
    object_kind: 'merge_request',
    object_attributes: { iid: 99999, action: 'merge' },
    project: { path_with_namespace: 'OTHER/repo' },
  } as any)
  // 无抛错，无事件写入
})

it('Issue webhook: ignored (old label-driven logic removed)', async () => {
  await handleGitLabWebhook({
    object_kind: 'issue',
    object_attributes: { action: 'update', labels: [{ title: 'approved' }] },
    project: { path_with_namespace: 'PAM/a' },
  } as any)
  expect(mockTriggerCapability).not.toHaveBeenCalled()
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/issue-handler.test.ts
```

Expected: 多条 FAIL（老逻辑会触发 capability、新逻辑未写）

- [ ] **Step 4: 改造 issue-handler.ts**

```typescript
// src/adapters/gitlab/issue-handler.ts
import { getBugAnalysisReportById, updateStatus } from '../../db/repositories/bug-analysis-reports.js'
import { createEvent, findLatest } from '../../db/repositories/bug-fix-events.js'
import { pool } from '../../db/pool.js'

// TODO: 保留 webhook 接收做 Bug 修复实例生命周期闭环（MR merge/close → status 同步）
//       Label/MR-created 的 capability 分发已废除，改由 Pipeline 内部驱动

export async function handleGitLabWebhook(event: any): Promise<void> {
  if (event.object_kind === 'merge_request') {
    await handleMrEvent(event)
    return
  }
  // 其他事件（Issue 更新等）：仅记日志，不分发
  console.log('[gitlab-webhook] ignored event:', event.object_kind, event.object_attributes?.action)
}

async function handleMrEvent(event: any): Promise<void> {
  const action = event.object_attributes?.action as string
  if (action !== 'merge' && action !== 'close') {
    console.log('[gitlab-webhook] MR action ignored:', action)
    return
  }

  const iid = event.object_attributes?.iid as number
  const projectPath = event.project?.path_with_namespace as string
  if (!iid || !projectPath) return

  // 反查 create_mr 事件
  const { rows } = await pool.query(
    `SELECT report_id FROM bug_fix_events
     WHERE code = 'create_mr'
       AND project_path = $1
       AND (data->>'mrIid')::int = $2
     ORDER BY id DESC LIMIT 1`,
    [projectPath, iid],
  )
  if (rows.length === 0) {
    console.log(`[gitlab-webhook] MR ${projectPath}#${iid} not managed by us, skip`)
    return
  }

  const reportId = rows[0].report_id as number
  const report = await getBugAnalysisReportById(reportId)
  if (!report) return

  // 幂等：已是终态则跳过
  if (report.status === 'completed' || report.status === 'aborted') {
    console.log(`[gitlab-webhook] report ${reportId} already terminal (${report.status}), skip`)
    return
  }

  const targetStatus = action === 'merge' ? 'completed' : 'aborted'
  await updateStatus(reportId, targetStatus)
  await createEvent({
    reportId,
    projectPath,
    code: 'lifecycle_sync',
    data: { mrIid: iid, mrAction: action, targetStatus },
  })
  console.log(`[gitlab-webhook] report ${reportId} → ${targetStatus} (MR ${action})`)
}
```

**删除**：原有的 `approved` label 触发 `fix_bug_l3` 和 MR open 触发 `ai_review_mr` 的分支全部删掉。

- [ ] **Step 5: 跑测试**

```bash
npx vitest run src/__tests__/unit/issue-handler.test.ts
```

Expected: PASS 6 tests

- [ ] **Step 6: 全仓回归**

```bash
pnpm test
```

Expected: 全部 PASS（老集成测试若有 label 触发场景要跟着改或删）。

- [ ] **Step 7: Commit**

```bash
git add src/adapters/gitlab/issue-handler.ts src/__tests__/unit/issue-handler.test.ts
git commit -m "refactor(issue-handler): 删 label/MR-created dispatch + 新增 MR merge/close 状态同步"
```

---

## Task 13: coordinator.ts（pipeline_run_id 回写 + onComplete 回调 + 非 bug 降级）

**Files:**
- Modify: `src/agent/coordinator.ts`
- Modify: `src/__tests__/unit/coordinator.test.ts`

**Rationale:** coordinator 是连接 analyzer 和 Pipeline 的胶水。需要：
1. 把 `runPipeline` 返回的 runId 回写到 `bug_analysis_reports.pipeline_run_id`
2. 在 `onComplete` 回调里根据 Pipeline 终态更新 `bug_analysis_reports.status`（`pipeline_success` / `aborted`）
3. 非 bug 分类时不触发 Pipeline（analyzer 内部已设 completed）

**Spec ref:** "coordinator 触发逻辑" + "onComplete 回调（关键：推动生命周期状态）"

**关联 AC:** AC1（正常触发）、AC3（失败设 aborted）、AC5（非 bug 不触发 Pipeline）、AC6（retry_analysis 触发新分析）

- [ ] **Step 1: 读现有 coordinator.ts 的 handleAnalysisComplete**

```bash
sed -n '80,150p' src/agent/coordinator.ts
```

记住现有 pattern。

- [ ] **Step 2: 写失败测试 - bug 分类触发 Pipeline + 回写 runId**

```typescript
// src/__tests__/unit/coordinator.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleAnalysisComplete } from '../../agent/coordinator.js'
import * as executor from '../../pipeline/executor.js'

describe('coordinator handleAnalysisComplete', () => {
  beforeEach(async () => { await cleanDb() })

  it('bug classification → triggers Pipeline and writes pipeline_run_id', async () => {
    const report = await setupBugReport({ level: 'l2' })
    vi.spyOn(executor, 'runPipeline').mockResolvedValue(77)  // 返回 runId

    await handleAnalysisComplete(report.id, 'l2', 'bug', 'u-trigger')

    expect(executor.runPipeline).toHaveBeenCalledWith(
      expect.any(Number),              // pipelineId
      {},                              // serverAssignment
      'api',
      'u-trigger',
      expect.any(Function),            // onComplete 回调
      { reportId: report.id },         // triggerParams
      expect.any(String),              // summary
    )

    const updated = await getBugAnalysisReportById(report.id)
    expect(updated?.pipelineRunId).toBe(77)
  })

  it('non-bug classification: does not trigger Pipeline', async () => {
    const report = await setupReport({ classification: 'usage_issue' })
    vi.spyOn(executor, 'runPipeline')
    await handleAnalysisComplete(report.id, 'l4', 'usage_issue', 'u-trigger')
    expect(executor.runPipeline).not.toHaveBeenCalled()
  })

  it('onComplete(success) → updates status to pipeline_success', async () => {
    const report = await setupBugReport({ level: 'l2' })
    let capturedOnComplete: Function | null = null
    vi.spyOn(executor, 'runPipeline').mockImplementation(async (_id, _sa, _tt, _tb, onComplete) => {
      capturedOnComplete = onComplete!
      return 100
    })

    await handleAnalysisComplete(report.id, 'l2', 'bug', 'u-trigger')
    // 模拟 Pipeline 完成
    await capturedOnComplete!({ runId: 100, pipelineName: 'L2', status: 'success', errorMessage: '', stageResults: [], durationMs: 1000 })

    const updated = await getBugAnalysisReportById(report.id)
    expect(updated?.status).toBe('pipeline_success')
  })

  it('onComplete(failed) → updates status to aborted', async () => {
    const report = await setupBugReport({ level: 'l3' })
    let capturedOnComplete: Function | null = null
    vi.spyOn(executor, 'runPipeline').mockImplementation(async (_i, _s, _t, _u, oc) => {
      capturedOnComplete = oc!
      return 101
    })
    await handleAnalysisComplete(report.id, 'l3', 'bug', 'u-t')
    await capturedOnComplete!({ status: 'failed', /* ... */ })
    const updated = await getBugAnalysisReportById(report.id)
    expect(updated?.status).toBe('aborted')
  })

  it('retry_analysis decision: triggers new analysis + new Pipeline', async () => {
    // 这个场景比较复杂：approve_l3 handler 返回 error='retry_analysis'，
    // coordinator onComplete 看到 result.status='failed' 并检查最新 approval 事件
    // 如果 decision=retry_analysis，自动调 handleAnalyzeBug({reuseIssueId})
    const report = await setupBugReport({ level: 'l3' })
    await createEvent({
      reportId: report.id, projectPath: null, code: 'approval', status: 'failed',
      data: { decision: 'retry_analysis', approverName: 'u-owner' },
    })

    let capturedOnComplete: Function | null = null
    vi.spyOn(executor, 'runPipeline').mockImplementation(async (_i, _s, _t, _u, oc) => {
      capturedOnComplete = oc!; return 200
    })
    const analyzeSpy = vi.spyOn(require('../../agent/analysis/analyzer.js'), 'handleAnalyzeBug')

    await handleAnalysisComplete(report.id, 'l3', 'bug', 'u-t')
    await capturedOnComplete!({ status: 'failed', errorMessage: 'retry_analysis' })

    expect(analyzeSpy).toHaveBeenCalledWith(expect.objectContaining({
      extraParams: expect.objectContaining({ reuseIssueId: report.issueId, productLineId: report.productLineId }),
    }))
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

```bash
npx vitest run src/__tests__/unit/coordinator.test.ts
```

Expected: FAIL

- [ ] **Step 4: 改造 coordinator.ts**

```typescript
// src/agent/coordinator.ts 改造片段
import { setPipelineRunId, updateStatus, getBugAnalysisReportById } from '../db/repositories/bug-analysis-reports.js'
import { findByReportCode } from '../db/repositories/bug-fix-events.js'
import { runPipeline } from '../pipeline/executor.js'
import { findPipelineByLevel } from '../db/repositories/test-pipelines.js'

// 签名保持：(reportId, level, classification, triggeredBy)
// 但里面要根据 classification 分支
export async function handleAnalysisComplete(
  reportId: number,
  level: string,
  classification: string,
  triggeredBy: string,
): Promise<void> {
  // 非 bug → analyzer 内已设 status='completed'，直接返回
  if (classification !== 'bug') {
    console.log(`[coordinator] skip pipeline for non-bug report ${reportId}`)
    return
  }

  const report = await getBugAnalysisReportById(reportId)
  if (!report) throw new Error(`report ${reportId} not found`)

  // 查对应 Pipeline
  const pipeline = await findPipelineByLevel(report.productLineId, level)  // 按 name 'L1-配置类' 等匹配
  if (!pipeline) {
    console.error(`[coordinator] no pipeline for level ${level}, downgrade to direct capability`)
    // 降级：本版简化为直接报错，用户从 Bug 修复实例重试
    await updateStatus(reportId, 'aborted')
    return
  }

  const onComplete = async (result: { status: 'success' | 'failed'; errorMessage?: string }) => {
    try {
      if (result.status === 'success') {
        await updateStatus(reportId, 'pipeline_success')
        return
      }

      await updateStatus(reportId, 'aborted')

      // 检查是不是 retry_analysis 决策
      const approvals = await findByReportCode(reportId, 'approval')
      const lastApproval = approvals[approvals.length - 1]
      if (lastApproval && (lastApproval.data as any).decision === 'retry_analysis') {
        console.log(`[coordinator] retry_analysis → trigger new analyze_bug with reuseIssueId=${report.issueId}`)
        const { handleAnalyzeBug } = await import('./analysis/analyzer.js')
        await handleAnalyzeBug({
          capabilityKey: 'analyze_bug',
          context: { taskId: `retry-${reportId}`, groupId: 'pipeline', platform: 'api', initiatorId: triggeredBy, initiatorRole: 'user' },
          extraParams: {
            productLineId: report.productLineId,
            reuseIssueId: report.issueId,
            message: `[重新分析] 基于 Issue #${report.issueId} 的历史内容重新分析`,
          },
        })
      }
    } catch (err) {
      console.error(`[coordinator] onComplete error for report ${reportId}:`, err)
    }
  }

  const runId = await runPipeline(
    pipeline.id,
    {},
    'api',
    triggeredBy,
    onComplete,
    { reportId },
    `L${level.toUpperCase()} Bug 修复`,
  )

  await setPipelineRunId(reportId, runId)
}
```

**注意**：`findPipelineByLevel` 可能需要在 `src/db/repositories/test-pipelines.ts` 中新增（小辅助函数，不改严益昌原有 repo 的核心方法）。如果 repo 属于严益昌代码（不能改），则在 coordinator 里直接 `SELECT * FROM test_pipelines WHERE product_line_id=$1 AND name=$2`，name 按 level 匹配 `L1-配置类` / `L2-代码缺陷` / `L3-业务逻辑` / `L4-复杂问题`。

- [ ] **Step 5: 运行测试**

```bash
npx vitest run src/__tests__/unit/coordinator.test.ts
```

Expected: PASS 5 tests

- [ ] **Step 6: 全仓回归**

```bash
pnpm test
```

Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add src/agent/coordinator.ts src/__tests__/unit/coordinator.test.ts
git commit -m "feat(coordinator): 回写 pipeline_run_id + onComplete 推动 status + retry_analysis 分支"
```

---

## Task 14: retry endpoint（POST /admin/bug-reports/:id/retry）

**Files:**
- Modify: `src/admin/routes/bug-analysis-reports.ts`
- Modify: `web/src/api/bug-analysis-reports.ts`
- Create: `src/__tests__/integration/retry-endpoint.test.ts`

**Rationale:** Bug 修复实例页面的"重试"按钮需要后端 endpoint。

**Spec ref:** "API 接口定义 → POST /admin/bug-reports/:id/retry"、"失败重试"

**关联 AC:** AC3

- [ ] **Step 1: 写失败测试**

```typescript
// src/__tests__/integration/retry-endpoint.test.ts
import { build } from '../../server.js'

describe('POST /admin/bug-reports/:id/retry', () => {
  let app: any
  beforeEach(async () => { app = await build(); await cleanDb() })
  afterEach(async () => { await app.close() })

  it('returns 404 when report does not exist', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/bug-reports/99999/retry', /* auth cookie */ })
    expect(res.statusCode).toBe(404)
    expect(res.json().error).toBe('REPORT_NOT_FOUND')
  })

  it('returns 409 when report.status is not aborted', async () => {
    const r = await setupReport({ status: 'completed' })
    const res = await app.inject({ method: 'POST', url: `/admin/bug-reports/${r.id}/retry` })
    expect(res.statusCode).toBe(409)
    expect(res.json().error).toBe('REPORT_NOT_RETRYABLE')
  })

  it('successful retry: calls analyzer with reuseIssueId, returns new report/run id', async () => {
    const oldReport = await setupReport({ status: 'aborted', issueId: 123, issueUrl: 'http://gitlab/x', primaryProjectPath: 'PAM/a', productLineId: 1 })
    vi.mocked(handleAnalyzeBug).mockResolvedValue({
      success: true,
      data: { reportId: 42, level: 'l2', classification: 'bug' },
    })
    vi.spyOn(executor, 'runPipeline').mockResolvedValue(77)

    const res = await app.inject({ method: 'POST', url: `/admin/bug-reports/${oldReport.id}/retry` })

    expect(res.statusCode).toBe(200)
    expect(res.json().data).toMatchObject({
      newReportId: 42,
      newRunId: 77,
      issueId: 123,
      issueUrl: 'http://gitlab/x',
    })
    expect(handleAnalyzeBug).toHaveBeenCalledWith(expect.objectContaining({
      extraParams: expect.objectContaining({ reuseIssueId: 123 }),
    }))
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/integration/retry-endpoint.test.ts
```

Expected: FAIL (route 未实现)

- [ ] **Step 3: 在 admin route 实现 endpoint**

```typescript
// src/admin/routes/bug-analysis-reports.ts 追加
app.post<{ Params: { id: string } }>('/bug-reports/:id/retry', async (req, reply) => {
  const reportId = Number(req.params.id)
  if (!Number.isFinite(reportId)) {
    return reply.code(400).send({ success: false, error: 'INVALID_ID', message: '非法的报告 ID' })
  }

  const report = await getBugAnalysisReportById(reportId)
  if (!report) {
    return reply.code(404).send({ success: false, error: 'REPORT_NOT_FOUND', message: '报告不存在' })
  }

  if (report.status !== 'aborted') {
    return reply.code(409).send({
      success: false,
      error: 'REPORT_NOT_RETRYABLE',
      message: `报告状态为 ${report.status}，无需重试`,
    })
  }

  if (!report.issueId) {
    return reply.code(409).send({ success: false, error: 'NO_ISSUE', message: '报告无关联 Issue，无法复用' })
  }

  try {
    // 调 analyzer 的 reuseIssueId 模式
    const { handleAnalyzeBug } = await import('../../agent/analysis/analyzer.js')
    const result = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: {
        taskId: `retry-${reportId}`,
        groupId: 'admin',
        platform: 'admin',
        initiatorId: (req as any).user?.id ?? 'admin',
        initiatorRole: 'admin',
      },
      extraParams: {
        productLineId: report.productLineId,
        reuseIssueId: report.issueId,
        message: `[重试] 基于 Issue #${report.issueId} 的历史内容重新分析`,
      },
    })

    if (!result.success) {
      return reply.code(502).send({ success: false, error: 'GITLAB_API_ERROR', message: result.output })
    }

    const newReportId = (result.data as any).reportId as number
    const newLevel = (result.data as any).level as string
    const newClass = (result.data as any).classification as string

    // 触发 Pipeline（仅 bug 时；reuseIssueId 模式下可能还是 bug）
    let newRunId: number | undefined
    if (newClass === 'bug') {
      const { handleAnalysisComplete } = await import('../../agent/coordinator.js')
      await handleAnalysisComplete(newReportId, newLevel, newClass, 'admin')
      const reloaded = await getBugAnalysisReportById(newReportId)
      newRunId = reloaded?.pipelineRunId ?? undefined
    }

    return reply.send({
      success: true,
      data: {
        newReportId,
        newRunId,
        issueId: report.issueId,
        issueUrl: report.issueUrl,
      },
    })
  } catch (err) {
    const msg = (err as any)?.message ?? String(err)
    return reply.code(500).send({ success: false, error: 'INTERNAL_ERROR', message: msg })
  }
})
```

- [ ] **Step 4: 前端 API 调用**

```typescript
// web/src/api/bug-analysis-reports.ts 追加
export async function retryBugReport(id: number): Promise<{
  newReportId: number
  newRunId?: number
  issueId: number
  issueUrl: string
}> {
  const { data } = await axios.post(`/admin/bug-reports/${id}/retry`)
  if (!data.success) throw new Error(data.message ?? data.error)
  return data.data
}
```

- [ ] **Step 5: 运行测试**

```bash
npx vitest run src/__tests__/integration/retry-endpoint.test.ts
```

Expected: PASS 3 tests

- [ ] **Step 6: Commit**

```bash
git add src/admin/routes/bug-analysis-reports.ts web/src/api/bug-analysis-reports.ts src/__tests__/integration/retry-endpoint.test.ts
git commit -m "feat(admin): POST /admin/bug-reports/:id/retry + 前端 API"
```

---

## Task 15: BugRunsPage 前端改造（按 issue_id 聚合 + 时间线 + 重试按钮）

**Files:**
- Modify: `web/src/pages/BugRunsPage.tsx`
- Modify: `web/src/api/bug-analysis-reports.ts`（若需补接口）

**Rationale:** 前端是用户看到的唯一界面，需要按 issue_id 把多轮分析聚合显示，展示事件时间线，失败态显示重试按钮。

**Spec ref:** "前端改动 → Bug 修复实例页面" + "失败重试" 前端部分

**关联 AC:** AC3（重试按钮显示/隐藏）

- [ ] **Step 1: 读现有 BugRunsPage.tsx 了解已有结构**

```bash
wc -l web/src/pages/BugRunsPage.tsx
grep -n "issue_id\|issueId" web/src/pages/BugRunsPage.tsx
```

- [ ] **Step 2: 加 API: 按 issue_id 聚合查询**

后端 `src/admin/routes/bug-analysis-reports.ts` 加一个 `GET /admin/bug-reports?groupByIssue=true` 或者用客户端 JS 聚合都行。按 MVP 原则直接在前端 group by：

```typescript
// web/src/pages/BugRunsPage.tsx
const { data: reports } = useQuery(...)

// groupBy issue_id
const grouped = useMemo(() => {
  const map = new Map<number, BugAnalysisReport[]>()
  for (const r of reports ?? []) {
    const arr = map.get(r.issueId) ?? []
    arr.push(r)
    map.set(r.issueId, arr)
  }
  // 每组内按 createdAt DESC
  for (const arr of map.values()) arr.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return map
}, [reports])
```

- [ ] **Step 3: 渲染分组树（Ant Design Collapse / Tree）**

```tsx
{Array.from(grouped.entries()).map(([issueId, rounds]) => (
  <Card key={issueId} title={`Issue #${issueId} - ${rounds[0].rootCauseSummary.slice(0, 40)}`}>
    {rounds.map((r, idx) => (
      <Collapse defaultActiveKey={idx === 0 ? [r.id] : []} key={r.id}>
        <Panel
          key={r.id}
          header={<RoundHeader report={r} roundNumber={rounds.length - idx} />}
          extra={renderRetryButton(r)}
        >
          <EventTimeline reportId={r.id} />
          {r.pipelineRunId && (
            <Link to={`/admin/test-runs/${r.pipelineRunId}`}>查看执行记录</Link>
          )}
        </Panel>
      </Collapse>
    ))}
  </Card>
))}
```

- [ ] **Step 4: 重试按钮 + 确认对话框**

```tsx
function renderRetryButton(report: BugAnalysisReport) {
  if (report.status !== 'aborted') return null
  return (
    <Button
      type="primary"
      danger
      onClick={(e) => {
        e.stopPropagation()
        Modal.confirm({
          title: '确认重新开始处理吗？',
          content: '将产生新一轮分析和新的 Pipeline 实例（消耗 Claude token）。',
          onOk: async () => {
            try {
              const res = await retryBugReport(report.id)
              message.success(`已启动新一轮：报告 #${res.newReportId}${res.newRunId ? ` / 执行 #${res.newRunId}` : ''}`)
              queryClient.invalidateQueries(['bug-reports'])
            } catch (err: any) {
              message.error(`重试失败: ${err.message}`)
            }
          },
        })
      }}
    >
      重试
    </Button>
  )
}
```

- [ ] **Step 5: 事件时间线组件**

```tsx
function EventTimeline({ reportId }: { reportId: number }) {
  const { data: events } = useQuery(['bug-fix-events', reportId], () => fetchEvents(reportId))
  if (!events) return <Spin />
  return (
    <Timeline mode="left">
      {events.map(e => (
        <Timeline.Item
          key={e.id}
          color={e.status === 'failed' ? 'red' : 'green'}
          label={dayjs(e.createdAt).format('MM-DD HH:mm:ss')}
        >
          <EventContent event={e} />
        </Timeline.Item>
      ))}
    </Timeline>
  )
}

function EventContent({ event }: { event: BugFixEvent }) {
  // 按 code 渲染不同内容
  switch (event.code) {
    case 'analysis': return <span>分析完成 / level={event.data.level} / classification={event.data.classification}</span>
    case 'scope_identified': return <span>锁定 {event.projectPath}（{event.data.isPrimary ? '主仓库' : '从仓库'}）</span>
    case 'create_issue': return <a href={event.data.issueUrl}>创建 Issue #{event.data.issueIid}</a>
    case 'fix_attempt': return <span>{event.status === 'success' ? '✅' : '❌'} {event.projectPath} 修复 (attempt={event.data.attempt})</span>
    case 'create_mr': return <a href={event.data.mrUrl}>MR !{event.data.mrIid} ({event.projectPath})</a>
    case 'ai_review': return <span>AI Review: {event.data.label}</span>
    case 'approval': return <span>审批: {event.data.decision} ({event.data.approverName})</span>
    case 'notify': return <span>{event.status === 'success' ? '✅' : '❌'} 通知 {event.data.userId} ({event.data.messageKind})</span>
    case 'lifecycle_sync': return <span>MR {event.data.mrAction} → {event.data.targetStatus}</span>
    default: return <span>{event.code}</span>
  }
}
```

- [ ] **Step 6: 后端补 GET /admin/bug-reports/:id/events**

```typescript
// src/admin/routes/bug-analysis-reports.ts 追加
app.get<{ Params: { id: string } }>('/bug-reports/:id/events', async (req, reply) => {
  const reportId = Number(req.params.id)
  const events = await findByReport(reportId)
  return reply.send({ data: events })
})
```

前端 API：

```typescript
// web/src/api/bug-analysis-reports.ts
export async function fetchEvents(reportId: number): Promise<BugFixEvent[]> {
  const { data } = await axios.get(`/admin/bug-reports/${reportId}/events`)
  return data.data
}
```

- [ ] **Step 7: 构建 + 本地预览**

```bash
cd web && pnpm build
```

Expected: TypeScript 无错误，构建通过。

- [ ] **Step 8: 手动冒烟**

启动本地 dev server：

```bash
pnpm dev                    # 后端
cd web && pnpm dev          # 前端（:5173）
```

浏览器打开 Bug 修复实例页面，验证：
- 同一 Issue 的多轮分析被聚合展示
- aborted 状态的报告有"重试"按钮
- 点按钮弹确认对话框
- 时间线显示各 event

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/BugRunsPage.tsx web/src/api/bug-analysis-reports.ts src/admin/routes/bug-analysis-reports.ts
git commit -m "feat(web): Bug 修复实例页 - 按 Issue 聚合 + 时间线 + 重试按钮"
```

---

## Task 16: TestRunsPage 本会话改动回滚

**Files:**
- Modify: `web/src/pages/TestRunsPage.tsx`
- Modify: `web/src/api/test-runs.ts`
- Modify: `web/src/types/index.ts`
- Modify: `src/admin/routes/test-runs.ts`
- Modify: `src/db/repositories/test-runs.ts`（**仅回滚本会话新增的 summary 相关**）
- Modify: `src/pipeline/executor.ts`（**仅回滚本会话新增的 summary 参数；其他一律不动**）
- Modify: `src/agent/coordinator.ts`（**回滚本会话新增的 summary 和 initiatorId 透传**）
- Modify: `src/agent/analysis/analyzer.ts`（**回滚本会话新增的 initiatorId 透传**）
- Delete: `src/db/schema-v10.sql`
- Modify: `src/db/migrate.ts`（**回滚本会话新增的 v10 引用**）

**Rationale:** 之前会话里把业务数据（摘要、触发人、hasReport）加到执行记录页面，现在业务展示统一到 Bug 修复实例页面，需要把这些改动回滚，不让执行记录页面承担业务职责。

**Spec ref:** "回滚：执行记录页面改动"

**⚠️ 严益昌代码零改动原则**：

`src/pipeline/executor.ts`、`src/db/repositories/test-runs.ts`、`src/agent/coordinator.ts` 这几个文件，**只回滚本会话"新增的"那几行**（summary 参数、initiatorId 透传、hasReport 检查），其他一律不动。等于让这些文件回到本会话开始前的状态。

**保留的改动**（不回滚，见 spec "保留的改动"）：
- `TestRunsPage.tsx` 的暗色主题 token 修复（`colorFillTertiary` 等）
- 流水线名称更新（`L1-配置类` 等）
- `hooks/block-git-ops.sh` 的修复

- [ ] **Step 1: 用 git 查看本会话对这些文件的改动**

```bash
git log --oneline --all -- src/pipeline/executor.ts src/db/repositories/test-runs.ts src/agent/coordinator.ts src/agent/analysis/analyzer.ts | head -20
git diff 91edbe9 -- src/pipeline/executor.ts | head -50
```

Expected: 识别出本会话的 diff 片段。

- [ ] **Step 2: 按 spec 回滚清单逐个文件处理**

**`src/pipeline/executor.ts`** — 删除 `runPipeline` 签名里新增的 `summary?: string` 参数，删除相关传递逻辑。确认 diff 只影响本会话新增行。

```bash
git checkout 91edbe9 -- src/pipeline/executor.ts
```

如果 `91edbe9` 之后还有其他必要改动（比如 `claude-cli.ts` AbortController 改动），用 `git show` 找到那次提交再 cherry-pick 相关片段。

**`src/db/repositories/test-runs.ts`** — 删除 `summary` 字段相关代码。

```bash
git checkout 91edbe9 -- src/db/repositories/test-runs.ts
```

**`src/agent/coordinator.ts`** — 回滚 `handleAnalysisComplete` 中的 summary 传递和 initiatorId（Task 13 会重新加回符合新设计的 initiatorId 使用）。谨慎：Task 13 的改动要在这个回滚**之后**基础上做。

**执行顺序建议**：本 Task 16 的 executor.ts / test-runs.ts 回滚**在 Task 13 coordinator 改造之前做**，避免冲突。

**`web/src/pages/TestRunsPage.tsx`** — 回滚到 `91edbe9` 然后**手动恢复**暗色主题 token 修复片段（用 `git diff 91edbe9...HEAD -- web/src/pages/TestRunsPage.tsx` 检查有哪些修复要保留）。

```bash
git checkout 91edbe9 -- web/src/pages/TestRunsPage.tsx
# 再手动打回暗色主题修复（或从后续提交 cherry-pick 相关片段）
```

**`web/src/api/test-runs.ts`** — 删除 `hasReport` 字段：

```bash
git checkout 91edbe9 -- web/src/api/test-runs.ts
```

**`web/src/types/index.ts`** — 删除 `TestRun.summary` 字段：

直接编辑，删除相关 interface 字段。

**`src/admin/routes/test-runs.ts`** — 详情接口去掉 `hasReport` 检查：

```bash
git checkout 91edbe9 -- src/admin/routes/test-runs.ts
```

**`src/agent/analysis/analyzer.ts`** — 本 Task 只回滚 initiatorId 透传（Task 6 会重新加符合新设计的 initiatorId 使用）。和 coordinator 的执行顺序类似：Task 16 先回滚，Task 6 再改造。

**`src/db/schema-v10.sql` + `src/db/migrate.ts`**：

```bash
rm src/db/schema-v10.sql
# 然后编辑 migrate.ts 删除 v10 执行行
```

- [ ] **Step 3: 运行数据库迁移回滚**

```bash
# 如果本地库已经跑过 v10，需要手动 drop 掉 summary 字段
psql $DATABASE_URL -c "ALTER TABLE test_runs DROP COLUMN IF EXISTS summary"
```

- [ ] **Step 4: 跑全仓 tsc + tests**

```bash
npx tsc --noEmit
pnpm test
```

Expected: 无类型错误；所有测试通过。

- [ ] **Step 5: 前端构建验证**

```bash
cd web && pnpm build
```

Expected: 构建成功。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "revert(test-runs): 回滚执行记录页业务数据，业务展示统一到 Bug 修复实例页"
```

**⚠️ 重要**：这个 Task 必须在 Task 6（analyzer 改造）和 Task 13（coordinator 改造）**之前完成**，否则 Task 6/13 的新 initiatorId 会被回滚掉。推荐实施顺序调整为：1-5 → **16** → 6-15 → 17-18。

---

## Task 17: 集成测试（7 个 AC 的端到端覆盖）

**Files:**
- Create: `src/__tests__/integration/l1-single-project-flow.test.ts` (AC1)
- Create: `src/__tests__/integration/l3-multi-project-approval.test.ts` (AC2)
- Create: `src/__tests__/integration/approval-timeout-retry.test.ts` (AC3)
- Create: `src/__tests__/integration/create-mr-idempotency.test.ts` (AC4)
- Create: `src/__tests__/integration/non-bug-classification.test.ts` (AC5)
- Create: `src/__tests__/integration/reanalyze-flow.test.ts` (AC6)
- Create: `src/__tests__/integration/mr-close-sync.test.ts` (AC7)

**Rationale:** 单测覆盖了每个 handler 的局部行为；集成测试验证多个 handler 组合起来在真实 Postgres + mock GitLab 下能跑通整个 AC 场景。

**Spec ref:** "测试用例清单 → 集成测试"

**通用 setup**：所有集成测试用 `src/__tests__/helpers/db.ts` 提供的 `setupTestDb` + 真实 Postgres（schema.sql → schema-v11.sql 全部迁移）。GitLab/Claude CLI 全 mock。

- [ ] **Step 1: 创建 L1 单 project 集成测试（AC1）**

```typescript
// src/__tests__/integration/l1-single-project-flow.test.ts
describe('AC1: L2 单 project 端到端', () => {
  beforeEach(async () => { await cleanDb(); seedPAMProductLine(); seedPipelines(); })

  it('整条链路跑通：analyze → fix → create_mr → review → notify → MR merge → completed', async () => {
    // 1. mock Claude: classification=bug / level=l2 / 1 project
    mockClaudeAnalysis({ projects: [{ path: 'PAM/pas-api', isPrimary: true }], level: 'l2', classification: 'bug' })
    mockClaudeFix({ testPassed: true })
    mockClaudeReview({ label: 'ai-approved', summary: '代码合理' })

    // 2. mock GitLab: create issue/mr/note
    mockGitLabCreateIssue({ iid: 123, url: 'http://gitlab/PAM/pas-api/-/issues/123' })
    mockGitLabCreateMr({ iid: 55, url: 'http://gitlab/PAM/pas-api/-/merge_requests/55' })
    mockGitLabPostMrNote()
    mockGitLabPostIssueNote()

    // 3. 触发 analyze_bug
    const result = await handleAnalyzeBug({
      capabilityKey: 'analyze_bug',
      context: { taskId: 't1', groupId: 'g1', platform: 'dingtalk', initiatorId: 'u1', initiatorRole: 'user' },
      extraParams: { message: '登录接口返回 500', productLineId: 1 },
    })
    expect(result.success).toBe(true)
    const reportId = (result.data as any).reportId

    // 4. 触发 coordinator（会跑 runPipeline）
    await handleAnalysisComplete(reportId, 'l2', 'bug', 'u1')

    // 5. 等 Pipeline 跑完（runPipeline 是 async，但集成测试里 handler mock 都是同步 resolve，可以 await 它自己）
    // 实际要确认 pipeline_run_id 已回写，stages 都成功
    const report = await getBugAnalysisReportById(reportId)
    expect(report?.pipelineRunId).toBeTruthy()
    expect(report?.status).toBe('pipeline_success')

    // 6. 验证事件
    const events = await findByReport(reportId)
    const codes = events.map(e => e.code)
    expect(codes).toContain('analysis')
    expect(codes).toContain('scope_identified')
    expect(codes).toContain('create_issue')
    expect(codes).toContain('fix_attempt')
    expect(codes).toContain('create_mr')
    expect(codes).toContain('ai_review')
    expect(codes).toContain('notify')

    // 7. 模拟 webhook MR merged
    await handleGitLabWebhook({
      object_kind: 'merge_request',
      object_attributes: { iid: 55, action: 'merge' },
      project: { path_with_namespace: 'PAM/pas-api' },
    } as any)

    const final = await getBugAnalysisReportById(reportId)
    expect(final?.status).toBe('completed')
  })
})
```

- [ ] **Step 2: L3 多 project 审批集成测试（AC2）**

```typescript
// src/__tests__/integration/l3-multi-project-approval.test.ts
describe('AC2: L3 多 project 审批', () => {
  it('主仓库 owner 收审批 DM + 从仓库 owner 收 FYI，approve 后完整跑完', async () => {
    mockClaudeAnalysis({
      projects: [
        { path: 'PAM/pas-6.0', isPrimary: true },
        { path: 'PAM/pas-api', isPrimary: false },
      ],
      level: 'l3',
      classification: 'bug',
    })
    mockClaudeFix({ testPassed: true })
    mockClaudeReview({ label: 'ai-approved' })
    mockGitLabAll()

    const sendDmSpy = vi.spyOn(mockAdapter, 'sendDirectMessage')

    const r = await handleAnalyzeBug({ /* ... */ } as any)
    const reportId = (r.data as any).reportId

    // 启动 Pipeline（会跑到 approve_l3 stage，然后等 approval）
    const pipelinePromise = handleAnalysisComplete(reportId, 'l3', 'bug', 'u1')

    // 等 approve_l3 发出 DM
    await sleepUntil(() => sendDmSpy.mock.calls.length >= 2)  // 主审批 + 1 FYI

    // 验证 DM 收件人
    const dmRecipients = sendDmSpy.mock.calls.map(c => c[0])
    expect(dmRecipients).toContain('u-primary')  // 主仓库 owner
    expect(dmRecipients).toContain('u-other')    // 从仓库 owner

    // 验证 FYI 消息不含 approve 命令
    const fyiCall = sendDmSpy.mock.calls.find(c => c[0] === 'u-other')
    expect(fyiCall?.[1].text).not.toContain('approve #')

    // 模拟主仓库 owner 回复 approve
    PipelineApprovalManager.getInstance().tryHandleCommand('approve #1001')  // issueId=1001

    await pipelinePromise

    const report = await getBugAnalysisReportById(reportId)
    expect(report?.status).toBe('pipeline_success')

    // 验证 2 个 MR
    const mrEvents = await findByReportCode(reportId, 'create_mr')
    expect(mrEvents).toHaveLength(2)

    // 主仓库 MR description 含 Closes
    // 从仓库 MR description 含 Related to
    const primaryMrCall = mockGitLab.createMr.mock.calls.find(c => c[0].projectPath === 'PAM/pas-6.0')
    expect(primaryMrCall?.[0].description).toMatch(/Closes #\d+/)
    const secondaryMrCall = mockGitLab.createMr.mock.calls.find(c => c[0].projectPath === 'PAM/pas-api')
    expect(secondaryMrCall?.[0].description).toContain('Related to PAM/pas-6.0#')
  })

  it('从仓库 owner 回复 approve 命令无效', async () => {
    // 和上面类似但主 owner 不回复，模拟从仓库 owner 回复
    await handleAnalysisComplete(reportId, 'l3', 'bug', 'u1')
    // 从仓库 owner 回复 approve
    // approval-manager 按 approverIds 验证，不放行
    // timeout 后 Pipeline 终止
    // ...
  })
})
```

- [ ] **Step 3: AC3 审批超时重试集成测试**

```typescript
// src/__tests__/integration/approval-timeout-retry.test.ts
it('审批超时 → bug_analysis_reports=aborted → POST /retry → 新 report + 新 Pipeline', async () => {
  // 1. 起 L3 Pipeline
  const r1 = await handleAnalyzeBug({ /* ... */ } as any)
  const r1Id = (r1.data as any).reportId

  // 2. 模拟审批超时（mock PipelineApprovalManager.requestApproval 立即返回 'timeout'）
  vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('timeout')
  await handleAnalysisComplete(r1Id, 'l3', 'bug', 'u1')

  const r1Final = await getBugAnalysisReportById(r1Id)
  expect(r1Final?.status).toBe('aborted')

  // 3. 调用 retry endpoint
  const res = await app.inject({ method: 'POST', url: `/admin/bug-reports/${r1Id}/retry` })
  expect(res.statusCode).toBe(200)
  const { newReportId } = res.json().data

  // 4. 验证新 report 存在，issue_id 同旧 report
  const r2 = await getBugAnalysisReportById(newReportId)
  expect(r2?.id).not.toBe(r1Id)
  expect(r2?.issueId).toBe(r1Final!.issueId)

  // 5. 验证老 Issue 被加了 comment（调 gitlabPostIssueNote）
  expect(mockGitLabPostIssueNote).toHaveBeenCalledWith(expect.objectContaining({
    issueIid: r1Final!.issueId,
    body: expect.stringContaining('🔄 第'),
  }))
})
```

- [ ] **Step 4: AC4 create_mr 幂等集成测试**

```typescript
// src/__tests__/integration/create-mr-idempotency.test.ts
it('Pipeline stage 重试时，已成功的 project 跳过重复创建', async () => {
  // 准备：report + fix_attempt 全部成功 + 1 个 create_mr 已成功 + 2 个失败
  const report = await setupReportWith3Projects({
    fixAllSuccess: true,
    existingCreateMr: [{ project: 'PAM/a', mrIid: 10 }],  // 只有 a 已有 MR
  })

  // 第一次 create_mr handler：a 失败（GitLab 429）、b 成功、c 失败
  mockGitLab.createMr
    .mockRejectedValueOnce(new Error('429'))
    .mockResolvedValueOnce({ iid: 20, url: 'b' })
    .mockRejectedValueOnce(new Error('429'))
  // 注：a 的 mock 不会被调用因为 a 已有 create_mr success

  await handleCreateMr({ extraParams: { reportId: report.id } } as any)
  // 第二次（Pipeline 重试）
  mockGitLab.createMr.mockResolvedValue({ iid: 30, url: 'x' })  // 都成功
  await handleCreateMr({ extraParams: { reportId: report.id } } as any)

  // 验证每个 project 最终各有一条 success
  for (const p of ['PAM/a', 'PAM/b', 'PAM/c']) {
    const latest = await findLatest(report.id, p, 'create_mr')
    expect(latest?.status).toBe('success')
  }
  // a 的 mrIid 应该还是 10（未被覆盖）
  const aFinal = await findLatest(report.id, 'PAM/a', 'create_mr')
  expect((aFinal?.data as any).mrIid).toBe(10)
})
```

- [ ] **Step 5: AC5 非 bug 分类集成测试**

```typescript
// src/__tests__/integration/non-bug-classification.test.ts
it('usage_issue 分类：不创建 Issue，不触发 Pipeline，status=completed', async () => {
  mockClaudeAnalysis({ classification: 'usage_issue', level: 'l4' })
  const r = await handleAnalyzeBug({ /* ... */ } as any)
  expect(r.success).toBe(true)

  const reportId = (r.data as any).reportId
  const report = await getBugAnalysisReportById(reportId)
  expect(report?.status).toBe('completed')

  const createIssueEvents = await findByReportCode(reportId, 'create_issue')
  expect(createIssueEvents).toHaveLength(0)
  expect(mockGitLabCreateIssue).not.toHaveBeenCalled()

  // 触发 coordinator - 应该不跑 Pipeline
  const runPipelineSpy = vi.spyOn(executor, 'runPipeline')
  await handleAnalysisComplete(reportId, 'l4', 'usage_issue', 'u1')
  expect(runPipelineSpy).not.toHaveBeenCalled()
})
```

- [ ] **Step 6: AC6 reanalyze 集成测试**

```typescript
// src/__tests__/integration/reanalyze-flow.test.ts
it('主仓库 owner 选择 reanalyze → 旧 Pipeline 终止 + 新分析 + 新 Pipeline', async () => {
  vi.spyOn(PipelineApprovalManager.prototype, 'requestApproval').mockResolvedValue('retry_analysis')

  const r1 = await handleAnalyzeBug({ /* ... */ } as any)
  await handleAnalysisComplete((r1.data as any).reportId, 'l3', 'bug', 'u1')

  // r1 已终止
  const r1Final = await getBugAnalysisReportById((r1.data as any).reportId)
  expect(r1Final?.status).toBe('aborted')

  // coordinator onComplete 应该自动触发新一轮分析（检查 handleAnalyzeBug 被调用第二次，带 reuseIssueId）
  const analyzeSpy = vi.mocked(handleAnalyzeBug)
  const retryCall = analyzeSpy.mock.calls.find(c => c[0].extraParams?.reuseIssueId)
  expect(retryCall).toBeTruthy()

  // 新 report 已产生，issueId 相同
  const allReports = await listBugAnalysisReports()
  expect(allReports).toHaveLength(2)
  expect(allReports[0].issueId).toBe(allReports[1].issueId)
})
```

- [ ] **Step 7: AC7 MR close → aborted 集成测试**

```typescript
// src/__tests__/integration/mr-close-sync.test.ts
it('MR 被手动关闭（未合并） → bug_analysis_reports.status=aborted', async () => {
  const report = await setupCompletedPipeline({
    status: 'pipeline_success',
    mrIid: 77,
    projectPath: 'PAM/pas-6.0',
  })

  await handleGitLabWebhook({
    object_kind: 'merge_request',
    object_attributes: { iid: 77, action: 'close' },
    project: { path_with_namespace: 'PAM/pas-6.0' },
  } as any)

  const updated = await getBugAnalysisReportById(report.id)
  expect(updated?.status).toBe('aborted')

  const syncEvents = await findByReportCode(report.id, 'lifecycle_sync')
  expect(syncEvents).toHaveLength(1)
  expect((syncEvents[0].data as any).mrAction).toBe('close')
})
```

- [ ] **Step 8: 跑所有集成测试**

```bash
npx vitest run src/__tests__/integration/
```

Expected: 7 个 AC 文件全部 PASS

- [ ] **Step 9: Commit**

```bash
git add src/__tests__/integration/l1-single-project-flow.test.ts src/__tests__/integration/l3-multi-project-approval.test.ts src/__tests__/integration/approval-timeout-retry.test.ts src/__tests__/integration/create-mr-idempotency.test.ts src/__tests__/integration/non-bug-classification.test.ts src/__tests__/integration/reanalyze-flow.test.ts src/__tests__/integration/mr-close-sync.test.ts
git commit -m "test(integration): 7 个 AC 端到端覆盖"
```

---

## Task 18: 文档更新 + Growth Backlog + 部署演练

**Files:**
- Modify: `CLAUDE.md`
- Create: `docs/product/growth-backlog-pipeline-state-persistence.md`（如缺）
- Create: `docs/product/growth-backlog-notification-template.md`（如缺）

**Rationale:** 上线前把新架构信息同步到项目文档，把"本次不做"项挂到 Growth Backlog，方便后续迭代。

- [ ] **Step 1: 更新 CLAUDE.md 中的架构说明**

找到 `CLAUDE.md` 里现有的"请求流"图，把它更新为新设计：

```markdown
### 请求流（Bug 修复链路）

```
IM 消息 → Adapter → SessionManager → ClaudeRunner → Claude 分析
                                        ↓
                                  bug_analysis_reports (draft → published)
                                  bug_fix_events (analysis/scope_identified/create_issue)
                                        ↓
                     coordinator → runPipeline(level Pipeline)
                                        ↓
            ┌──── L3 only: approve_l3 (capability，调 approval-manager)
            ↓
     fix_bug_lN → create_mr → ai_review_mr → notify_bug (全 capability stages)
                                        ↓
                     onComplete → bug_analysis_reports.status
                                        ↓
                     GitLab webhook (MR merge/close) → status 同步闭环
```
```

- [ ] **Step 2: CLAUDE.md 补充"Pipeline 全链路编排"章节**

简单描述：
- 所有 stage 都是 capability 类型
- `triggerParams={reportId}`，handler 反查 `bug_fix_events`
- 新增 handler 参照 `src/agent/analysis/analyzer.ts` 的 `registerCapabilityHandler` 模式

- [ ] **Step 3: 写 Growth Backlog 文档**

```bash
mkdir -p docs/product
cat > docs/product/growth-backlog-pipeline-state-persistence.md << 'EOF'
# Growth Backlog - Pipeline 审批状态持久化

## 背景
`PipelineApprovalManager.pending` 是内存 Map，进程重启后 pending 审批丢失，Pipeline 将永远等待审批不前进。

## 本次（2026-04）未做的原因
本轮改动已较大，优先把多 project + Pipeline 解耦跑通。

## 临时规避
进程重启时管理员手动在 Bug 修复实例页面重试失败 Pipeline。

## 待做方案
- 新建 `pipeline_approvals` 表持久化 pending 审批
- 服务启动时从 DB 恢复 pending 审批
- 需要考虑进程间互斥（多实例部署）
EOF

cat > docs/product/growth-backlog-notification-template.md << 'EOF'
# Growth Backlog - DM 通知模板配置化

## 背景
当前 `notify_bug` / `approve_l3` 的 DM 消息模板硬编码在 TypeScript 里。

## 本次未做
优先跑通主流程。

## 待做方案
- `notification_templates` 表：`kind` (scenario key) / `locale` / `template` (支持 handlebars)
- 管理后台 UI 编辑模板
- handler 渲染时查表渲染
EOF
```

- [ ] **Step 4: 更新部署清单走查**

对照 spec 的"部署清单"章节，验证实际实施到位：

```bash
# 1. schema-v11.sql DDL review
cat src/db/schema-v11.sql

# 2. capabilities 记录
psql $DATABASE_URL -c "SELECT key, display_name, needs_approval FROM capabilities WHERE key IN ('approve_l3','create_mr','notify_bug')"

# 3. Pipeline 配置
psql $DATABASE_URL -c "SELECT name, jsonb_array_length(stages) AS stage_count FROM test_pipelines WHERE name LIKE 'L_-%' ORDER BY name"

# 4. 环境变量
env | grep -E 'GITLAB_URL|GITLAB_TOKEN|DATABASE_URL|CLAUDE_CODE_OAUTH_TOKEN'

# 5. module_owners 数据
psql $DATABASE_URL -c "SELECT product_line_id, module_pattern, owner_user_id FROM module_owners WHERE product_line_id IN (SELECT id FROM product_lines WHERE name='PAM')"
```

Expected: 所有检查项都有合理数据。

- [ ] **Step 5: 跑一次完整的 pnpm test + 前端 build**

```bash
pnpm test
cd web && pnpm build
```

Expected: 所有测试通过，构建成功。

- [ ] **Step 6: 手动 E2E 烟雾测试（上线前）**

本地 dev server 跑起来，走一遍 4 条分支：

```
# 终端 1
pnpm dev

# 终端 2
cd web && pnpm dev
```

在钉钉测试群 @ 机器人，分别提 4 类问题：

1. **L1 配置类**："这个 bug 应该是配置没加" → 走 L1 Pipeline
2. **L2 代码缺陷**："登录接口 500" → 走 L2 Pipeline
3. **L3 业务逻辑**："跨模块的业务状态不一致" → 走 L3 Pipeline，需要审批
4. **L4 复杂问题** / usage_issue："这个功能怎么用？" → 不触发 Pipeline

验证：
- 每条消息能走通对应分支
- Bug 修复实例页面显示对应 report + 事件时间线
- L3 审批 DM 能收到 + approve 命令有效
- L2 跑完后 MR 被 review，打上 label
- MR 手动合并后 Issue 自动关闭，前端 status 变为 completed
- 重试按钮在 aborted 态显示

- [ ] **Step 7: Commit**

```bash
git add CLAUDE.md docs/product/
git commit -m "docs: 更新 CLAUDE.md + Growth Backlog（审批持久化 / 通知模板）"
```

- [ ] **Step 8: 最后一步 - 创建 PR**

```bash
git push -u origin dev/ai-assistant
gh pr create --base master --title "feat: Pipeline 全链路动态编排（Bug 修复主流程纳入 Pipeline）" --body "$(cat <<'EOF'
## Summary

- Pipeline 全链路 capability 化：analyze_bug 独立 + approve_l3/fix_bug_lN/create_mr/ai_review_mr/notify_bug 入 Pipeline
- 新建 bug_fix_events 事件流表，handler 间数据通过 DB 传递
- 多 project Bug 修复支持（主仓库 + 从仓库 + 动态审批人）
- Bug 修复实例生命周期闭环：Pipeline onComplete + GitLab webhook MR merge/close
- Bug 修复实例页面：按 Issue 聚合、事件时间线、失败重试按钮

## Test plan
- [ ] 数据库迁移（schema-v11）
- [ ] 单元测试：analyzer / approve_l3 / create_mr / notify_bug / fix-runner / reviewer / issue-handler / coordinator / worktree
- [ ] 集成测试：7 个 AC 全覆盖
- [ ] 前端构建通过
- [ ] 手动 E2E：钉钉 4 分支
- [ ] 配置清单 review：capabilities / Pipeline / module_owners
- [ ] 回滚方案就绪

参考文档：
- spec: docs/superpowers/specs/2026-04-17-pipeline-full-orchestration-design.md
- plan: docs/superpowers/plans/2026-04-17-pipeline-full-orchestration.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## 实施顺序总结

**推荐实施顺序**（考虑 Task 16 回滚要早执行）：

```
阶段 A. 基础设施（必须最先）
  Task 16  回滚本会话执行记录页业务数据改动（避免后续 Task 的新改动被覆盖）
  Task 1   schema-v11.sql
  Task 2   migrate.ts 追加 v11

阶段 B. Repositories（无业务逻辑依赖）
  Task 3   bug-fix-events repo
  Task 4   bug-analysis-reports 扩展

阶段 C. 工具链（独立 refactor）
  Task 5   worktree key 加 project_path

阶段 D. Handlers（内部互相独立，可并行）
  Task 6   analyzer.ts 改造（多 project + reuseIssueId）
  Task 7   approve-l3-handler（新建）
  Task 8   create-mr-handler（新建）
  Task 9   notify-handler（新建）
  Task 10  fix-runner.ts 改造
  Task 11  reviewer.ts 改造
  Task 12  issue-handler.ts 瘦身

阶段 E. 协调层 + API（依赖 handlers 就绪）
  Task 13  coordinator.ts（pipeline_run_id + onComplete）
  Task 14  retry endpoint

阶段 F. 前端（依赖后端 API）
  Task 15  BugRunsPage

阶段 G. 测试 + 部署
  Task 17  集成测试（7 个 AC）
  Task 18  文档 + Growth Backlog + PR
```

---

**Plan complete and saved to** `docs/superpowers/plans/2026-04-17-pipeline-full-orchestration.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**

---

## E2E 验收完成报告（2026-04-19 追加）

Task 18 最终范围（用户决定后扩展）：**文档 + Growth Backlog + E2E 验收（18 场景）**。按 subagent-driven-development 流程执行完成，全部场景绿。

### Phase 拆分 + commit

| Phase | 内容 | Commit | 状态 |
|---|---|---|---|
| 1.1 | Playwright 装 + 目录 + config | c4eeead | ✅ |
| 1.2 | base.sql fixture（pam / 4 pipelines / 2 projects） | ea7fcac | ✅ |
| 1.3 | Claude mock 分叉 + `_e2e` 端点 + MockIMAdapter（11 单测） | 0a6d1ee | ✅ |
| 1.4 | GitLab mock server + globalSetup + playwright webServer | 5bd9399 | ✅ |
| 1.5 | health.spec 6/6 + 修 1.3/1.4 遗留（auth bypass / reuse / GITLAB_URL 冲突 / vitest exclude） | 2f02f2d | ✅ |
| 2 | bug-l1-full-flow 样板脚本（严格 UI 全通） | 44d3a52 | ✅ |
| 3A-W1 | L1 失败 / L2 全链路 / L3 approve / L3 reject | fab3a3e | ✅ |
| 3A-W2 | L3 超时[降级-DB] / 多 project / 重试 UI / MR close | 8cfed74 | ✅ |
| 3B | BugRunsPage 5 场景（3 个[降级-UI gap 产品侧]） | d67821e | ✅ |
| 3C | approval cmd approve/reject/reanalyze（[简化-跳过 intent]） | f48fdf6 | ✅ |

### 最终绿灯指标

- `pnpm test`（vitest）：**295 pass / 4 skipped**（与 Task 17 完成时相同，无倒退）
- `pnpm test:e2e`（Playwright）：**23 pass**（6 smoke + 17 业务 + 0 flaky）
- `npx tsc --noEmit`：零错误
- 硬约束文件（executor.ts / types.ts / approval-manager.ts / webhook-waiter.ts / test-runs repo / test-pipelines repo）**Task 18 期间零改动**（Task 7 期间对 approval-manager.ts 的 reanalyze 扩展是已批准例外，见前文"零改动文件"章节）

### E2E 基础设施

**产品代码增量**（e2e-only 分支，默认不触发，生产零影响）：
- `src/agent/mocks/e2e-store.ts` — in-memory mock 响应队列 + 消息记录
- `src/adapters/im/mock.ts` — MockIMAdapter（含入站模拟）
- `src/admin/routes/_e2e.ts` — 7 个控制端点（claude / reset / messages / health / analyze-and-dispatch / approve / im/incoming）
- `src/agent/analysis/claude-runs.ts` / `fix-logic.ts` / `claude-review.ts` — `CLAUDE_MOCK=1` 短路分叉
- `src/agent/worktree/manager.ts` — `E2E_MODE=1` 返回虚拟 worktree
- `src/admin/auth/session-plugin.ts` — `/_e2e/*` 前缀白名单
- `src/server.ts` — `E2E_MODE=1` 时用 MockIMAdapter 替代 DingTalk/Feishu

**测试代码**（23 个 spec）：
- 1 个 smoke: `health.spec.ts`
- 17 个业务: `bug-l1/l2/l3/l4-*` + `bug-retry` + `bug-mr-close` + `bugpage-*` + `approval-cmd-*`
- fixture: `base.sql`
- helpers: `global-setup.ts` / `global-teardown.ts` / `per-test.ts`
- mock: `gitlab-server.ts`

### 产品 Backlog（E2E 跑出的 gap，用户后续决策）

以下是 e2e 降级/简化处所暴露的产品侧待决策项，**都不阻塞本次 plan 收尾**：

| # | 项目 | 发现处 | 现状 | 建议 |
|---|---|---|---|---|
| G1 | `approve_l3` timeout 不可测 | Phase 3A 场景 5 | handler 硬编码 `timeoutMs=3600000`，stage `timeoutSeconds` 未透传；stage-level timeout 先触发但 handler 不监听 signal | 后续改 handler：从 `capabilityParams.approvalTimeoutMs` 读，或监听 `opts.signal` 自写 aborted 事件 |
| G2 | BugRunsPage 无 status 筛选 | Phase 3B B1 | DB status 有 5 态但前端只当 Tag 显示 | PRD 补需求 |
| G3 | BugRunsPage 无分页器 | Phase 3B B2 | 前端硬编码 `limit=50`，后端 API 无 offset/page | 需求 + 后端 API 扩参 |
| G4 | 无"查看分析报告 markdown"弹窗 | Phase 3B B4 | `analysis_steps` / `solutions_json` 等结构化数据未渲染 | 需求 + 前端组件 |
| G5 | `fix_failed` / `approval_rejected` 不发失败 DM | Phase 3A W1 | `notify_bug` 里 `shouldNotifyOwners=false`，失败场景触发人/owner 都不知情 | 产品层决策：失败是否通知 owner |
| G6 | ClaudeRunner intent 检测无法在 e2e mock | Phase 3C 简化 | `detectIntent` 会 spawn 真 claude CLI | 可选：intent 检测也加 `CLAUDE_MOCK` 分叉 |

### Node 环境

本机默认 Node 18.20.8 跑 vitest 4 报 `node:util.styleText` 导出缺失。临时方案：测试时 `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`。未升级全局 Node（按用户早期意向）。

### 跑 e2e 的前置条件

1. Postgres 起、`DATABASE_URL` 设好
2. 前端 build 好：`cd web && pnpm build`
3. `export PATH=/opt/homebrew/opt/node@22/bin:$PATH`
4. `pnpm test:e2e` — Playwright 自动启 mock server + 后端（E2E_MODE / CLAUDE_MOCK / GITLAB_URL 指 mock / PORT=3001 / fake token）

### 已关闭 → 不再推进的项

- ~~Task 18 "PR"~~ — 用户未授权 push，保留本地 commit。后续用户自行决定 push/PR 时机。




