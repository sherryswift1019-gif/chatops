# BugRunsPage UI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 BugRunsPage 从"Card+Collapse 按 Issue 聚合"的形态**回正为 Table+Drawer**，对齐 PRD §0.4 "复用/扩展 TestRunsPage" 的原意。默认显示所有产品线（产品线降级为可选筛选器），详情全字段展示。

**Architecture:** 分 5 阶段：
1. 后端先开口（schema v14 加 `completed_at` + list 接口 productLineId 可选化 + 加 issueId 筛选）
2. 前端 API 层同步类型
3. 前端页面重写（Table + URL query 同步）
4. 前端详情 Drawer 新建（5 个 Section 全字段展示）
5. e2e 测试对齐（bugpage-* 5 个 spec 重写）

严益昌原创 6 文件（executor / types / approval-manager / webhook-waiter / test-runs-repo / test-pipelines-repo）**零改动**——本次仅触达 `bug_analysis_reports` 相关的 repository/route/前端。

**Tech Stack:** TypeScript + Fastify 5 + PostgreSQL + React 18 + Ant Design 5 + react-router-dom v6 + Vitest + Playwright

**溯源依据（Why 这个 refactor 存在）**：
- PRD §0.4：`| [扩展] | 复用/扩展 TestRunsPage，展示每个 Bug 的流程进度 |`
- 2026-04-17 plan Task 15 自行引入了"按 issue_id 聚合 + Collapse/Tree"的实现路径，偏离 PRD 原意
- 2026-04-20 spec §前端展示增补了完整 UI 约定（Table 形态 / Drawer 详情 / 后端接口扩展），本 plan 是落地实施

---

## File Structure

**后端改动**（3 文件 + 1 新 schema）：
- Create: `src/db/schema-v14.sql` — 加 `bug_analysis_reports.completed_at`
- Modify: `src/db/migrate.ts` — 追加 v14 执行
- Modify: `src/db/repositories/bug-analysis-reports.ts` — 加 `completed_at` 映射 + `updateReportStatus` 终态时同步写入 + `listReportsByProductLinePaged` 加 `issueId` 可选参数 + 改支持 `productLineId?` + SELECT 返回 `product_line_name`
- Modify: `src/admin/routes/bug-analysis-reports.ts` — list 接口去 `productLineId` 强制校验 + 加 `issueId` 参数

**前端改动**（3 文件 + 1 新组件）：
- Modify: `web/src/api/bug-analysis-reports.ts` — `Report` 类型加 `completed_at` / `product_line_name` 字段，`list()` 签名 `productLineId` 改可选 + 加 `issueId`
- Modify: `web/src/pages/BugRunsPage.tsx` — **完全重写**：Table + URL query sync + 筛选工具栏，移除 IssueCard/Collapse 代码
- Create: `web/src/components/BugRunDetailDrawer.tsx` — 新组件，5 个 Section，被 BugRunsPage 引用

**e2e 改动**（5 文件全重写断言）：
- Modify: `src/__tests__/mock-e2e/bugpage-empty.spec.ts`
- Modify: `src/__tests__/mock-e2e/bugpage-filter.spec.ts`
- Modify: `src/__tests__/mock-e2e/bugpage-pagination.spec.ts`
- Modify: `src/__tests__/mock-e2e/bugpage-report-modal.spec.ts`
- Modify: `src/__tests__/mock-e2e/bugpage-timeline.spec.ts`

**受影响的其它 e2e**（可能需要微调断言）：
- `bug-l1-full-flow.spec.ts` / `bug-l2-full-flow.spec.ts` / `bug-l3-*.spec.ts` / `bug-l4-flow.spec.ts` / `bug-l1-failure.spec.ts` / `bug-handover.spec.ts` / `bug-fix-exhausted-handover.spec.ts` / `bug-non-bug-flow.spec.ts` / `bug-mr-close.spec.ts`
- 规则：凡断言 `IssueCard` / `.ant-collapse` / `text=/Issue #\d+/` 定位元素的地方都要改，Task 13 统一处理

---

## Phase 1: 后端开口

### Task 1: schema-v14 加 `completed_at` 字段

**Files:**
- Create: `src/db/schema-v14.sql`
- Modify: `src/db/migrate.ts`（末尾追加 v14 加载块）

- [ ] **Step 1: 写 schema-v14.sql**

```sql
-- schema-v14.sql: bug_analysis_reports 加 completed_at 字段
--
-- 背景：前端列表"完成时间"列需要独立时间戳（不能用 updated_at，后者会被中间字段更新污染）
-- 写入时机：status 变为终态（completed / aborted / pending_manual）时
-- 幂等：已非空时不再覆盖
ALTER TABLE bug_analysis_reports
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMP;

COMMENT ON COLUMN bug_analysis_reports.completed_at IS
  '终态（completed/aborted/pending_manual）时由 updateReportStatus 写入，历史数据为 NULL';
```

- [ ] **Step 2: migrate.ts 追加 v14 加载**

找到 migrate.ts 末尾 v13 加载块，后面追加：

```typescript
const schemaV14 = readFileSync(join(__dirname, 'schema-v14.sql'), 'utf8')
await pool.query(schemaV14)
console.log('[migrate] schema-v14 applied')
```

并更新末尾 console.log：
```typescript
console.log('✅ Database schema applied (v1 ~ v14, 含 completed_at)')
```

- [ ] **Step 3: 跑 migrate 验证**

```bash
pnpm migrate
```

Expected: 输出 `[migrate] schema-v14 applied`

- [ ] **Step 4: 验证字段存在**

```bash
docker exec chatops-postgres-1 psql -U chatops -d chatops -c "\d bug_analysis_reports" | grep completed_at
```

Expected: `completed_at | timestamp without time zone`

- [ ] **Step 5: Commit**

```bash
git add src/db/schema-v14.sql src/db/migrate.ts
git commit -m "feat(db): schema-v14 加 completed_at 字段（终态时间独立字段）"
```

---

### Task 2: repository 加 `completed_at` 读写 + `updateReportStatus` 幂等写入

**Files:**
- Modify: `src/db/repositories/bug-analysis-reports.ts`
- Test: `src/__tests__/integration/full-analysis-flow.test.ts`（已有，复用验证）+ 新增 `src/__tests__/unit/bug-analysis-reports-repo.test.ts`

- [ ] **Step 1: 写失败的 repository 单测**

`src/__tests__/unit/bug-analysis-reports-repo.test.ts`（新建）：

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createBugAnalysisReport,
  updateReportStatus,
  getBugAnalysisReportById,
} from '../../db/repositories/bug-analysis-reports.js'
import { resetTestDb, getTestPool } from '../helpers/db.js'

describe('bug-analysis-reports repository — completed_at', () => {
  beforeEach(async () => {
    await resetTestDb()
    // seed 一个 product line
    await getTestPool().query(`INSERT INTO product_lines (name, display_name) VALUES ('pam','PAM')`)
  })

  it('终态状态 (completed) 触发 completed_at 写入', async () => {
    const r = await createBugAnalysisReport({
      issueId: 1, issueUrl: 'x', productLineId: 1, level: 'l2',
      classification: 'bug', confidence: 'high',
      solutionsJson: [], status: 'draft',
    })
    await updateReportStatus(r.id, 'completed')
    const fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeInstanceOf(Date)
  })

  it('终态状态 (aborted) 也触发写入', async () => {
    const r = await createBugAnalysisReport({ /* 同上 */ } as any)
    await updateReportStatus(r.id, 'aborted')
    const fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeInstanceOf(Date)
  })

  it('终态状态 (pending_manual) 也触发写入', async () => {
    const r = await createBugAnalysisReport({ /* 同上 */ } as any)
    await updateReportStatus(r.id, 'pending_manual')
    const fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeInstanceOf(Date)
  })

  it('非终态 (published / pipeline_success) 不写 completed_at', async () => {
    const r = await createBugAnalysisReport({ /* 同上 */ } as any)
    await updateReportStatus(r.id, 'published')
    let fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeNull()

    await updateReportStatus(r.id, 'pipeline_success')
    fresh = await getBugAnalysisReportById(r.id)
    expect(fresh!.completedAt).toBeNull()
  })

  it('幂等：已有 completed_at 不被二次写入覆盖', async () => {
    const r = await createBugAnalysisReport({ /* 同上 */ } as any)
    await updateReportStatus(r.id, 'completed')
    const firstCompleteAt = (await getBugAnalysisReportById(r.id))!.completedAt!

    await new Promise(res => setTimeout(res, 50))
    await updateReportStatus(r.id, 'completed')  // 重复调用
    const secondCompleteAt = (await getBugAnalysisReportById(r.id))!.completedAt!

    expect(secondCompleteAt.getTime()).toBe(firstCompleteAt.getTime())
  })
})
```

- [ ] **Step 2: 运行失败**

```bash
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test src/__tests__/unit/bug-analysis-reports-repo.test.ts
```

Expected: FAIL —— `completedAt` 字段不存在于 Report 类型或未映射

- [ ] **Step 3: 实现改动**

`src/db/repositories/bug-analysis-reports.ts`：

**3.1 Report 接口加字段**（在 interface 定义里）：

```typescript
export interface BugAnalysisReport {
  // ... 原有字段
  completedAt: Date | null
  productLineName?: string  // join 时带
}
```

**3.2 `mapRow()` 函数加字段映射**：

```typescript
function mapRow(r: Record<string, unknown>): BugAnalysisReport {
  return {
    // ... 原有字段
    completedAt: (r.completed_at ?? null) as Date | null,
    productLineName: r.product_line_name as string | undefined,
  }
}
```

**3.3 修改 `updateReportStatus` 函数**（终态时写 `completed_at`，幂等）：

```typescript
const TERMINAL_STATUSES = new Set(['completed', 'aborted', 'pending_manual'])

export async function updateReportStatus(id: number, status: string): Promise<void> {
  const pool = getPool()
  if (TERMINAL_STATUSES.has(status)) {
    // 幂等：只在 completed_at 为 NULL 时写入
    await pool.query(
      `UPDATE bug_analysis_reports
       SET status = $1, updated_at = NOW(),
           completed_at = COALESCE(completed_at, NOW())
       WHERE id = $2`,
      [status, id],
    )
  } else {
    await pool.query(
      `UPDATE bug_analysis_reports SET status = $1, updated_at = NOW() WHERE id = $2`,
      [status, id],
    )
  }
}
```

**3.4 所有 SELECT 查询加 `completed_at` 返回** （`SELECT * FROM bug_analysis_reports` 原本就返回所有列，不需要改；但 join `product_lines.name` 的查询要加 alias）

- [ ] **Step 4: 测试通过**

```bash
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test src/__tests__/unit/bug-analysis-reports-repo.test.ts
```

Expected: 5 tests pass

全仓回归：
```bash
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test
```

Expected: 全绿（既有测试不破）

- [ ] **Step 5: Commit**

```bash
git add src/db/repositories/bug-analysis-reports.ts src/__tests__/unit/bug-analysis-reports-repo.test.ts
git commit -m "feat(repo): updateReportStatus 终态时幂等写 completed_at"
```

---

### Task 3: list 接口去必填 + 加 `issueId` 筛选 + 返回 `product_line_name`

**Files:**
- Modify: `src/admin/routes/bug-analysis-reports.ts`
- Modify: `src/db/repositories/bug-analysis-reports.ts`（`listReportsByProductLinePaged` 加可选参数）
- Test: `src/__tests__/unit/admin-bug-reports.test.ts`（已有，追加用例）

- [ ] **Step 1: 写失败的 route 单测**

在 `src/__tests__/unit/admin-bug-reports.test.ts` 追加：

```typescript
describe('GET /admin/bug-analysis-reports — productLineId 可选化 + issueId 筛选', () => {
  it('不传 product_line_id 时返回所有产品线的 report（不再 400）', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/bug-analysis-reports' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.error).toBeUndefined()
    expect(Array.isArray(body.data)).toBe(true)
  })

  it('传 issueId 时按 issue_id 筛选', async () => {
    // seed: 同一 issue 下 3 条 report
    // 省略 seed 代码
    const res = await app.inject({ method: 'GET', url: '/admin/bug-analysis-reports?issueId=42' })
    const body = res.json()
    expect(body.data.every((r: any) => r.issue_id === 42)).toBe(true)
  })

  it('返回字段含 product_line_name', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/bug-analysis-reports' })
    const body = res.json()
    if (body.data.length > 0) {
      expect(body.data[0]).toHaveProperty('product_line_name')
    }
  })

  it('返回字段含 completed_at（未完成时为 null）', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/bug-analysis-reports' })
    const body = res.json()
    if (body.data.length > 0) {
      expect(body.data[0]).toHaveProperty('completed_at')
    }
  })
})
```

- [ ] **Step 2: 运行失败**

```bash
pnpm test src/__tests__/unit/admin-bug-reports.test.ts
```

Expected: 第一个 case FAIL（当前 `if (!productLineId) return { error: ... }` 400）

- [ ] **Step 3: 实现改动**

**3.1 Repository `listReportsByProductLinePaged` 改签名**（`productLineId` 改可选 + 加 `issueId` 参数 + SELECT 加 join）：

```typescript
export async function listReportsByProductLinePaged(opts: {
  productLineId?: number  // 改可选
  issueId?: number         // 新增
  statuses?: string[] | null
  levels?: string[] | null
  page: number
  limit: number
}): Promise<{ data: BugAnalysisReport[]; total: number }> {
  const conds: string[] = []
  const params: unknown[] = []

  if (opts.productLineId != null) {
    params.push(opts.productLineId)
    conds.push(`b.product_line_id = $${params.length}`)
  }
  if (opts.issueId != null) {
    params.push(opts.issueId)
    conds.push(`b.issue_id = $${params.length}`)
  }
  if (opts.statuses && opts.statuses.length > 0) {
    params.push(opts.statuses)
    conds.push(`b.status = ANY($${params.length})`)
  }
  if (opts.levels && opts.levels.length > 0) {
    params.push(opts.levels)
    conds.push(`b.level = ANY($${params.length})`)
  }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : ''

  const offset = (opts.page - 1) * opts.limit
  const { rows } = await getPool().query(
    `SELECT b.*, p.name AS product_line_name
     FROM bug_analysis_reports b
     LEFT JOIN product_lines p ON p.id = b.product_line_id
     ${where}
     ORDER BY b.created_at DESC
     LIMIT ${opts.limit} OFFSET ${offset}`,
    params,
  )
  const { rows: countRows } = await getPool().query(
    `SELECT count(*) AS total FROM bug_analysis_reports b ${where}`,
    params,
  )
  return { data: rows.map(mapRow), total: Number(countRows[0].total) }
}
```

**3.2 Route handler 去必填 + 加 `issueId` query 解析**（[src/admin/routes/bug-analysis-reports.ts:38-65](src/admin/routes/bug-analysis-reports.ts#L38-L65)）：

```typescript
app.get('/bug-analysis-reports', async (req) => {
  const query = req.query as Record<string, unknown>
  const productLineId = query.product_line_id ? Number(query.product_line_id) : undefined
  const issueId = query.issueId ? Number(query.issueId) : undefined

  const statuses = parseCsvEnum(query.status, VALID_STATUSES)
  const levels = parseCsvEnum(query.level, VALID_LEVELS)
  const page = Math.max(1, Number(query.page) || 1)
  const pageSize = Math.min(100, Math.max(1, Number(query.pageSize) || 20))

  const result = await listReportsByProductLinePaged({
    productLineId, issueId, statuses, levels, page, limit: pageSize,
  })
  return { data: result.data, total: result.total, page, pageSize }
})
```

> 注：移除老的 `hasPaging` 分支和 `listReportsByProductLine(productLineId, limit)` 调用——统一走分页。

- [ ] **Step 4: 测试通过**

```bash
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test src/__tests__/unit/admin-bug-reports.test.ts
```

Expected: 新增 4 cases pass + 既有 cases 不破

全仓回归：
```bash
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test
```

Expected: 全绿

- [ ] **Step 5: Commit**

```bash
git add src/admin/routes/bug-analysis-reports.ts src/db/repositories/bug-analysis-reports.ts src/__tests__/unit/admin-bug-reports.test.ts
git commit -m "feat(api): list 接口 productLineId 可选 + issueId 筛选 + 返回 product_line_name"
```

---

## Phase 2: 前端 API 层

### Task 4: 前端 API 类型更新 + list 签名扩展

**Files:**
- Modify: `web/src/api/bug-analysis-reports.ts`

- [ ] **Step 1: 读现状**

```bash
cat web/src/api/bug-analysis-reports.ts
```

确认当前 `BugReport` / `list()` 的定义。

- [ ] **Step 2: 修改类型 + 函数签名**

```typescript
export interface BugReport {
  id: number
  issue_id: number
  issue_url: string
  product_line_id: number
  product_line_name?: string      // 新增
  level: string | null
  classification: string | null
  status: string
  root_cause_summary: string | null
  created_at: string
  updated_at: string
  completed_at: string | null     // 新增
  // ... 其它已有字段
}

export interface ListReportsParams {
  productLineId?: number           // 改可选
  issueId?: number                 // 新增
  status?: string
  level?: string
  page?: number
  pageSize?: number
}

export async function listBugReports(params: ListReportsParams = {}): Promise<{
  data: BugReport[]
  total: number
  page: number
  pageSize: number
}> {
  const qs = new URLSearchParams()
  if (params.productLineId != null) qs.set('product_line_id', String(params.productLineId))
  if (params.issueId != null) qs.set('issueId', String(params.issueId))
  if (params.status) qs.set('status', params.status)
  if (params.level) qs.set('level', params.level)
  if (params.page != null) qs.set('page', String(params.page))
  if (params.pageSize != null) qs.set('pageSize', String(params.pageSize))
  const res = await http.get(`/admin/bug-analysis-reports?${qs.toString()}`)
  return res.data
}
```

- [ ] **Step 3: typecheck 通过**

```bash
cd web && pnpm typecheck
```

Expected: 0 error

- [ ] **Step 4: Commit**

```bash
git add web/src/api/bug-analysis-reports.ts
git commit -m "feat(web-api): listBugReports 签名扩展（productLineId 可选 + issueId + completed_at 字段）"
```

---

## Phase 3: 前端页面重写

### Task 5: BugRunDetailDrawer 新组件（5 个 Section 全字段展示）

**Files:**
- Create: `web/src/components/BugRunDetailDrawer.tsx`

- [ ] **Step 1: 写组件框架**

```typescript
import { Drawer, Descriptions, Tag, Collapse, Timeline, Empty, Space, Button, message } from 'antd'
import { useEffect, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import type { BugReport } from '../api/bug-analysis-reports'
import { listBugReports, getReportEvents } from '../api/bug-analysis-reports'

interface Props {
  open: boolean
  report: BugReport | null
  onClose: () => void
}

export function BugRunDetailDrawer({ open, report, onClose }: Props) {
  const [events, setEvents] = useState<BugFixEvent[]>([])
  const [rounds, setRounds] = useState<BugReport[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!open || !report) return
    setLoading(true)
    Promise.all([
      getReportEvents(report.id),
      listBugReports({ issueId: report.issue_id, productLineId: report.product_line_id, pageSize: 100 }),
    ]).then(([evs, roundsResult]) => {
      setEvents(evs.data)
      setRounds(roundsResult.data.sort((a, b) => a.id - b.id))
    }).finally(() => setLoading(false))
  }, [open, report])

  if (!report) return null

  return (
    <Drawer title={`Bug 修复实例 #${report.id}`} open={open} onClose={onClose} width={960} loading={loading}>
      {/* Section 1: 基础元数据 */}
      <Descriptions title="基础元数据" column={2} bordered size="small" items={[
        { label: 'Report ID', children: report.id },
        { label: 'Issue', children: <a href={report.issue_url} target="_blank" rel="noreferrer">#{report.issue_id}</a> },
        { label: '产品线', children: <Tag>{report.product_line_name}</Tag> },
        { label: '等级', children: <LevelTag level={report.level} /> },
        { label: '分类', children: <ClassificationTag classification={report.classification} /> },
        { label: '状态', children: <StatusTag status={report.status} /> },
        { label: '触发人', children: report.metadata?.initiatorId ?? '—' },
        { label: '置信度', children: `${report.confidence} (${report.confidence_score})` },
        { label: '主仓库', children: report.primary_project_path ?? '—' },
        { label: 'Pipeline Run', children: report.pipeline_run_id ? <a href={`/test-runs?id=${report.pipeline_run_id}`}>#{report.pipeline_run_id}</a> : '—' },
        { label: 'Agent Session', children: report.agent_session_id ?? '—' },
        { label: '创建时间', children: formatTime(report.created_at) },
        { label: '更新时间', children: formatTime(report.updated_at) },
        { label: '完成时间', children: report.completed_at ? formatTime(report.completed_at) : '—' },
      ]} />

      {/* Section 2: 分析内容 */}
      <AnalysisSection report={report} />

      {/* Section 3: 执行结果（从 events 聚合） */}
      <ExecutionSection events={events} />

      {/* Section 4: 多轮历史（仅当 rounds.length > 1） */}
      {rounds.length > 1 && <RoundsSection rounds={rounds} currentId={report.id} />}

      {/* Section 5: 本轮事件时间线 */}
      <TimelineSection events={events} />
    </Drawer>
  )
}
```

（子组件 `AnalysisSection` / `ExecutionSection` / `RoundsSection` / `TimelineSection` / `LevelTag` / `ClassificationTag` / `StatusTag` 同文件内定义或另拆，细节按 spec §前端展示→详情视图实现）

- [ ] **Step 2: typecheck**

```bash
cd web && pnpm typecheck
```

Expected: 0 error

- [ ] **Step 3: 暂不写组件单测（本项目前端无组件测试基础设施，验证通过 e2e 覆盖）**

- [ ] **Step 4: Commit**

```bash
git add web/src/components/BugRunDetailDrawer.tsx
git commit -m "feat(web): BugRunDetailDrawer 新组件（5 Section 全字段展示）"
```

---

### Task 6: BugRunsPage 重写（Table + URL query sync）

**Files:**
- Modify: `web/src/pages/BugRunsPage.tsx`（完全重写）

- [ ] **Step 1: 重写页面骨架**

```typescript
import { Card, Table, Tag, Button, Space, Select, message } from 'antd'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { ColumnsType } from 'antd/es/table'
import type { BugReport } from '../api/bug-analysis-reports'
import { listBugReports, retryBugReport, handoverBugReport } from '../api/bug-analysis-reports'
import { listProductLines } from '../api/product-lines'
import { BugRunDetailDrawer } from '../components/BugRunDetailDrawer'

export function BugRunsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState<BugReport[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [productLines, setProductLines] = useState<{ id: number; name: string; display_name: string }[]>([])
  const [selectedReport, setSelectedReport] = useState<BugReport | null>(null)

  // URL query → state
  const productLineId = searchParams.get('productLine') ? Number(searchParams.get('productLine')) : undefined
  const status = searchParams.get('status') || undefined
  const level = searchParams.get('level') || undefined
  const page = Number(searchParams.get('page') || 1)
  const pageSize = Number(searchParams.get('pageSize') || 20)

  const load = async () => {
    setLoading(true)
    try {
      const result = await listBugReports({ productLineId, status, level, page, pageSize })
      setData(result.data)
      setTotal(result.total)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [productLineId, status, level, page, pageSize])
  useEffect(() => { listProductLines().then(setProductLines) }, [])

  const setFilter = (key: string, value: string | number | undefined) => {
    const next = new URLSearchParams(searchParams)
    if (value == null || value === '') next.delete(key)
    else next.set(key, String(value))
    next.delete('page')  // 筛选变化时重置到第 1 页
    setSearchParams(next, { replace: true })
  }

  const columns: ColumnsType<BugReport> = [
    { title: '产品线', dataIndex: 'product_line_name', width: 120, render: (v) => v ? <Tag>{v}</Tag> : '—' },
    { title: '摘要', dataIndex: 'root_cause_summary', ellipsis: { showTitle: true }, render: (v) => v || '—' },
    { title: '等级', dataIndex: 'level', width: 80, render: (v) => <LevelTag level={v} /> },
    { title: '状态', dataIndex: 'status', width: 120, render: (v) => <StatusTag status={v} /> },
    { title: '触发人', dataIndex: 'metadata', width: 120, render: (m) => m?.initiatorId ?? '—' },
    { title: '创建时间', dataIndex: 'created_at', width: 160, render: formatTime, sorter: true, defaultSortOrder: 'descend' },
    { title: '完成时间', dataIndex: 'completed_at', width: 160, render: (v) => v ? formatTime(v) : '—' },
    {
      title: '操作', width: 280, fixed: 'right',
      render: (_, record) => (
        <Space size="small">
          <Button size="small" onClick={() => setSelectedReport(record)}>详情</Button>
          {record.issue_url && <Button size="small" type="link" href={record.issue_url} target="_blank">查看 Issue</Button>}
          {record.status === 'aborted' && (
            <>
              <Button size="small" type="primary" onClick={() => handleRetry(record)}>重试</Button>
              <Button size="small" onClick={() => handleHandover(record)}>转人工</Button>
            </>
          )}
        </Space>
      )
    }
  ]

  return (
    <Card title="Bug 修复实例" extra={
      <Space>
        <Select placeholder="产品线" allowClear style={{ width: 160 }} value={productLineId}
          onChange={(v) => setFilter('productLine', v)}
          options={productLines.map(p => ({ value: p.id, label: p.display_name }))} />
        <Select placeholder="状态" allowClear style={{ width: 140 }} value={status}
          onChange={(v) => setFilter('status', v)}
          options={['draft','published','pipeline_success','pending_manual','completed','aborted'].map(s => ({ value: s, label: s }))} />
        <Select placeholder="等级" allowClear style={{ width: 100 }} value={level}
          onChange={(v) => setFilter('level', v)}
          options={['l1','l2','l3','l4'].map(l => ({ value: l, label: l.toUpperCase() }))} />
      </Space>
    }>
      <Table rowKey="id" columns={columns} dataSource={data} loading={loading}
        pagination={{
          current: page, pageSize, total,
          onChange: (p, ps) => {
            const next = new URLSearchParams(searchParams)
            next.set('page', String(p))
            next.set('pageSize', String(ps))
            setSearchParams(next, { replace: true })
          }
        }} />
      <BugRunDetailDrawer open={!!selectedReport} report={selectedReport} onClose={() => setSelectedReport(null)} />
    </Card>
  )
}
```

- [ ] **Step 2: typecheck 通过**

```bash
cd web && pnpm typecheck
```

Expected: 0 error

- [ ] **Step 3: 本地 dev 冒烟**

```bash
# 后端已跑
# 前端 dev
cd web && pnpm dev
# 浏览器打开 http://localhost:5173/bug-runs
# 1. 无筛选：看到全部 report（至少 1 条 seed 数据）
# 2. 选产品线：URL 变 ?productLine=1
# 3. 选状态：URL 变 ?productLine=1&status=aborted
# 4. 刷新：筛选保留
# 5. 点"详情"按钮：Drawer 打开
```

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/BugRunsPage.tsx
git commit -m "refactor(web): BugRunsPage → Table + URL query sync（对齐 PRD §0.4 原意）"
```

---

## Phase 4: e2e 测试对齐

### Task 7: bugpage-empty.spec.ts 重写

**Files:**
- Modify: `src/__tests__/mock-e2e/bugpage-empty.spec.ts`

- [ ] **Step 1: 理解原断言**

原 spec 验证"未选产品线 + 选后无报告 → 分别显示两种 Empty 占位"。新语义：
- 未选产品线 → **显示全部**（有数据时 Table 有行；无数据时 Empty "暂无 Bug 修复实例"）
- 选了产品线但该线无数据 → Empty "当前筛选条件下无结果"

- [ ] **Step 2: 重写**

```typescript
test('不带筛选默认显示全部实例', async ({ page }) => {
  await page.goto('/bug-runs')
  // 至少 1 行（或全量 Empty 文案）
  const rowsCount = await page.locator('.ant-table-tbody tr.ant-table-row').count()
  const emptyVisible = await page.locator('.ant-empty').isVisible().catch(() => false)
  expect(rowsCount > 0 || emptyVisible).toBe(true)
})

test('选产品线无数据时显示筛选空态', async ({ page }) => {
  // seed：在一个没有 bug report 的产品线（比如新建的 other 产品线）
  await page.goto('/bug-runs?productLine=<empty_pl_id>')
  await expect(page.locator('.ant-empty').getByText(/当前筛选条件下无结果/)).toBeVisible()
})
```

- [ ] **Step 3: 跑 e2e**

```bash
pnpm test:e2e bugpage-empty.spec.ts
```

Expected: 2 tests pass

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/mock-e2e/bugpage-empty.spec.ts
git commit -m "test(e2e): bugpage-empty 改断言 Table 空态 + 筛选空态"
```

---

### Task 8: bugpage-filter.spec.ts 重写

**Files:**
- Modify: `src/__tests__/mock-e2e/bugpage-filter.spec.ts`

- [ ] **Step 1: 原断言定位 `.ant-collapse` + "IssueCard"，新版要改为 Table row 行数**

- [ ] **Step 2: 重写示例**

```typescript
test('productLine + status + level 叠加筛选', async ({ page }) => {
  // seed: 2 个产品线 × 2 个状态 × 2 个等级 = 8 条 report
  await page.goto('/bug-runs')
  // 初始：8 行
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(8)

  // 选产品线 PAM
  await page.getByPlaceholder('产品线').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'PAM' }).click()
  await expect(page).toHaveURL(/productLine=\d+/)
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(4)

  // 叠加状态 aborted
  await page.getByPlaceholder('状态').click()
  await page.locator('.ant-select-item-option').filter({ hasText: 'aborted' }).click()
  await expect(page).toHaveURL(/productLine=\d+&status=aborted/)
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2)
})

test('URL 直接带筛选参数进入时筛选生效', async ({ page }) => {
  await page.goto('/bug-runs?status=aborted')
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toContainText(/aborted/)
})
```

- [ ] **Step 3: 跑 e2e**

```bash
pnpm test:e2e bugpage-filter.spec.ts
```

Expected: pass

- [ ] **Step 4: Commit**

```bash
git add src/__tests__/mock-e2e/bugpage-filter.spec.ts
git commit -m "test(e2e): bugpage-filter 改为 Table row 筛选 + URL query 断言"
```

---

### Task 9: bugpage-pagination.spec.ts 重写

**Files:**
- Modify: `src/__tests__/mock-e2e/bugpage-pagination.spec.ts`

- [ ] **Step 1: 原断言"25 条 IssueCard 分页"，新版改 Table pagination**

- [ ] **Step 2: 重写**

```typescript
test('25 条 report，pageSize=20 → 第 1 页 20，第 2 页 5', async ({ page }) => {
  // seed: 25 条 report
  await page.goto('/bug-runs?pageSize=20')
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(20)
  await expect(page.locator('.ant-pagination-total-text')).toContainText('25')

  // 翻到第 2 页
  await page.locator('.ant-pagination-item-2').click()
  await expect(page).toHaveURL(/page=2/)
  await expect(page.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(5)
})
```

- [ ] **Step 3: 跑 e2e**
- [ ] **Step 4: Commit**
```bash
git commit -m "test(e2e): bugpage-pagination 改 Table pagination + URL page 参数"
```

---

### Task 10: bugpage-report-modal.spec.ts 重写（改为 Drawer）

**Files:**
- Modify: `src/__tests__/mock-e2e/bugpage-report-modal.spec.ts`（按新语义应改名 `bugpage-detail-drawer.spec.ts`，先保留旧文件名避免 rename 引入噪音）

- [ ] **Step 1: 原断言"查看报告 Modal 打开"，新版改 Drawer**

- [ ] **Step 2: 重写**

```typescript
test('点击"详情"按钮打开 Drawer，含全字段', async ({ page }) => {
  await page.goto('/bug-runs')
  await page.locator('.ant-table-tbody tr.ant-table-row').first().getByRole('button', { name: '详情' }).click()

  const drawer = page.locator('.ant-drawer-content')
  await expect(drawer).toBeVisible({ timeout: 10_000 })

  // Section 1 基础元数据
  await expect(drawer.getByText('基础元数据')).toBeVisible()
  await expect(drawer.getByText(/Report ID/)).toBeVisible()
  await expect(drawer.locator('a[href*="/issues/"]')).toBeVisible()  // Issue URL

  // Section 5 时间线
  await expect(drawer.locator('.ant-timeline-item').first()).toBeVisible()
})
```

- [ ] **Step 3: 跑 e2e**
- [ ] **Step 4: Commit**
```bash
git commit -m "test(e2e): bugpage-report-modal 改为 Drawer 断言（5 Section）"
```

---

### Task 11: bugpage-timeline.spec.ts 重写

**Files:**
- Modify: `src/__tests__/mock-e2e/bugpage-timeline.spec.ts`

- [ ] **Step 1: 原断言 Timeline 直接渲染在列表中，新版改 Drawer 内 Timeline**

- [ ] **Step 2: 重写**

```typescript
test('Drawer 内 Timeline 渲染全部事件', async ({ page }) => {
  // seed: SQL 注入 8 条 events
  await page.goto('/bug-runs')
  await page.locator('.ant-table-tbody tr.ant-table-row').first().getByRole('button', { name: '详情' }).click()
  const drawer = page.locator('.ant-drawer-content')
  await expect(drawer).toBeVisible()

  // Section 5 时间线
  await expect(drawer.locator('.ant-timeline-item')).toHaveCount(8, { timeout: 10_000 })
})
```

- [ ] **Step 3: 跑 e2e**
- [ ] **Step 4: Commit**
```bash
git commit -m "test(e2e): bugpage-timeline 改为 Drawer 内 Timeline 断言"
```

---

### Task 12: 统一回归（跑全部 mock-e2e）+ 受影响 spec 快速修

**Files:**
- Potentially modify: 任何断言 `.ant-collapse` / `IssueCard` / `text=/Issue #\d+/` 的 e2e spec

- [ ] **Step 1: 跑全部 mock-e2e**

```bash
pnpm test:e2e 2>&1 | tee /tmp/e2e-regress.log
grep -E "passed|failed" /tmp/e2e-regress.log | tail -5
```

Expected: 可能有 5-10 个失败，全都是定位元素改了

- [ ] **Step 2: 归类修**

对每个失败 spec，常见修改是：

| 原定位 | 新定位 |
|---|---|
| `page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' })` | `page.locator('.ant-card').filter({ hasText: 'Bug 修复实例' })` 保持 |
| `pageCard.locator('.ant-select').first()` 选产品线（必选） | `page.getByPlaceholder('产品线')` 选产品线（可选） |
| `page.locator('text=/Issue #\\d+/').first()` | `page.locator('.ant-table-tbody tr').first()` |
| `page.locator('.ant-tag').filter({ hasText: /^pending_manual$/ })` | 直接 Table 行内 `.filter({ hasText: /pending_manual/ })` |

- [ ] **Step 3: 一次性 Commit（多 spec 批量改）**

```bash
git add src/__tests__/mock-e2e/
git commit -m "test(e2e): bug-* 系列 spec 对齐新 UI（Table row + Drawer）"
```

- [ ] **Step 4: 全仓回归**

```bash
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test   # 单测
pnpm test:e2e                                                                    # e2e
```

Expected: 双绿

- [ ] **Step 5: 最终 commit（如有 leftover）**

```bash
git status
# 如有未提交改动：
git commit -m "test: 最终对齐"
```

---

## Phase 5: 清理与归档

### Task 13: 老 plan 标记 superseded + 总收尾

**Files:**
- Modify: `docs/superpowers/plans/2026-04-17-bug-fix-workflow-orchestration.md`（头部加 note）

- [ ] **Step 1: 在 2026-04-17 plan 开头加 superseded 注记**

```markdown
> **⚠️ 2026-04-20 更新**：本 plan 的 Task 15（BugRunsPage 前端改造）里"按 issue_id 聚合 + Collapse/Tree"的实现路径偏离了 PRD §0.4 "复用/扩展 TestRunsPage" 的原意。实际落地后 UX 不达标。
>
> UI 回正见 [2026-04-20-bugruns-ui-refactor.md](./2026-04-20-bugruns-ui-refactor.md)，spec 的 UI 约定章节已补齐（见 [2026-04-17-bug-fix-workflow-orchestration-design.md §前端展示→UI 约定（2026-04-20 追加补齐）](../specs/2026-04-17-bug-fix-workflow-orchestration-design.md)）。
>
> Task 15 的产物（IssueCard / Collapse 代码）已在 2026-04-20 refactor 中整体替换为 Table + Drawer。
```

- [ ] **Step 2: typecheck + vitest + e2e 一轮最终验证**

```bash
pnpm typecheck && cd web && pnpm typecheck && cd ..
DATABASE_URL=postgres://chatops:chatops@localhost:5432/chatops_test pnpm test
pnpm test:e2e
```

Expected: 全绿

- [ ] **Step 3: 本地 dev 手工冒烟清单**

- [ ] 不选产品线直接打开 /bug-runs → 看到所有实例列表
- [ ] 选产品线 → URL 变 ?productLine=X
- [ ] 叠加状态筛选 → URL 多一项 ?status=aborted
- [ ] 刷新 → 筛选保留
- [ ] 点"详情"按钮 → Drawer 5 个 Section 显示
- [ ] 多轮 Issue 下的 report → Drawer 里"多轮历史"Collapse 显示
- [ ] `aborted` 状态行 → "重试" + "转人工" 按钮显示
- [ ] 非 `aborted` 行 → 只有"详情" + "查看 Issue"

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-04-17-bug-fix-workflow-orchestration.md
git commit -m "docs(plan): 2026-04-17 plan 标记 Task 15 被 04-20 refactor superseded"
```

- [ ] **Step 5: 整体 push（不自动推，等用户同意）**

```bash
# 等用户指令
git log --oneline origin/dev/ai-assistant..HEAD
# git push origin dev/ai-assistant
```

---

## 实施顺序总结

```
Phase 1 后端   → Task 1 (schema v14)
             → Task 2 (repo completed_at 幂等)
             → Task 3 (list 接口扩展)

Phase 2 API   → Task 4 (前端 API 类型)

Phase 3 前端  → Task 5 (Drawer 新组件)
             → Task 6 (BugRunsPage 重写)

Phase 4 e2e   → Task 7-11 (bugpage-*.spec.ts 5 文件)
             → Task 12 (其它 spec 批量对齐)

Phase 5 收尾  → Task 13 (老 plan superseded 注记 + 最终验证)
```

**关键断言**（回归 PRD 原意的证据）：
- `web/src/pages/BugRunsPage.tsx` import `Table` 而非 `Collapse`
- 行数减到 ~200 行左右（从当前 ~500 行）
- `src/admin/routes/bug-analysis-reports.ts` 不再有 `if (!productLineId) return { error }` 的强校验
- spec §前端展示→UI 约定章节被视为权威参考

**Growth Backlog**（本 refactor 不做，归 V2）：
- "只看我的"快捷筛选（`initiator_id = 当前登录用户`）
- 列定义可配置（列显示/隐藏/顺序）
- 详情 Drawer 内"多轮对比"视图（diff 视图）
- 导出 CSV
- `completed_at` 历史数据回填脚本
- Table 客户端排序（目前仅 `created_at` 后端默认 desc）
