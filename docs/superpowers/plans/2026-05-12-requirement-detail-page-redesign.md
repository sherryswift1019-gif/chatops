# 需求详情页 UI 重新设计 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Quick-Impl 需求详情从 640px 抽屉升级为独立页 `/requirements/:id`，按"全局操作 / 当前焦点 / 详细内容"三层信息架构重新组织。

**Architecture:** Header (fixed) + 左栏 sticky 380px 三卡 + 右栏 Tab 四面板。前端 `effectiveStatus(detail)` 从 `stageResults + waiters` 派生细粒度状态（"Spec 等你决策"/"Plan 生成中"等），绕开后端 status 字段死状态 / 语义错位问题。零后端 / DB 改动。

**Tech Stack:** React 18 + Vite + Ant Design 5 + React Router v6 + axios + Vitest

**Spec:** [docs/superpowers/specs/2026-05-12-requirement-detail-page-redesign-design.md](../specs/2026-05-12-requirement-detail-page-redesign-design.md)

---

## 全局背景

- 主要文件：[web/src/pages/RequirementsPage.tsx](../../../web/src/pages/RequirementsPage.tsx)（1250 行，包含 Drawer 详情 + DecideModal + 三个内嵌组件）
- API 客户端：[web/src/api/requirements.ts](../../../web/src/api/requirements.ts)（不改）
- Helper：[web/src/pages/requirements-helpers.ts](../../../web/src/pages/requirements-helpers.ts)（保持不动，复用 KIND_LABEL / findStageForWaiter / buildDecisionModalTitle / buildDecisionOptions / shouldWarnPlanRework）
- 现有组件：[web/src/components/StageResultsTimeline.tsx](../../../web/src/components/StageResultsTimeline.tsx) 不动（详情页使用自己的 NodeRow，不复用此组件）
- 节点 ID（来自 [src/quick-impl/bootstrap.ts](../../../src/quick-impl/bootstrap.ts)）：`init_branch / spec_author / spec_ai_review / spec_human_gate / spec_commit_push / plan_author / plan_ai_review / plan_human_gate / plan_commit_push / dev_author / dev_ai_review / dev_human_gate / dev_push / e2e_skip_router / qi_e2e_runner / e2e_router / dev_fix_author / dev_fix_ai_review / e2e_im_intervention / e2e_intervention_router / e2e_sandbox_intervention / sandbox_intervention_router / final_approval / mr_create / cleanup / done`

## File Structure

**新增文件（17 个）**：

| 路径 | 责任 |
|---|---|
| `web/src/components/V2StructuredView.tsx` | v2 stage skillOutput 结构化展示（Collapse 列表） |
| `web/src/components/WaiterTimeline.tsx` | waiters 完整 timeline |
| `web/src/components/DecideModal.tsx` | 审批决策 Modal（Spec/Plan/Dev/Final/E2E intervention 通用）|
| `web/src/pages/RequirementDetailPage.tsx` | 详情页主组件（加载 + 布局容器 + 决策 modal 状态）|
| `web/src/pages/requirement-detail/effectiveStatus.ts` | status 派生函数 + NODE_RUNNING_LABEL + WAITER_KIND_LABEL |
| `web/src/pages/requirement-detail/effectiveStatus.test.ts` | 4 个分支单测 |
| `web/src/pages/requirement-detail/qi-stage-map.ts` | 节点 name → stepper 段 |
| `web/src/pages/requirement-detail/qi-stage-map.test.ts` | 映射完整性单测 |
| `web/src/pages/requirement-detail/usePolling.ts` | 5s 智能轮询 hook |
| `web/src/pages/requirement-detail/usePolling.test.ts` | 轮询行为单测 |
| `web/src/pages/requirement-detail/DetailHeader.tsx` | 顶部条 + stepper + 操作按钮 |
| `web/src/pages/requirement-detail/ProgressStepper.tsx` | 7 段 stepper |
| `web/src/pages/requirement-detail/DetailSidebar.tsx` | 左栏容器 |
| `web/src/pages/requirement-detail/PendingWaiterCard.tsx` | 焦点卡 |
| `web/src/pages/requirement-detail/MetaInfoCard.tsx` | 元信息卡 |
| `web/src/pages/requirement-detail/RawInputCard.tsx` | 原始输入卡 |
| `web/src/pages/requirement-detail/DetailTabs.tsx` | Tab 容器 + URL 同步 |
| `web/src/pages/requirement-detail/NodesTab.tsx` | 节点执行 Tab |
| `web/src/pages/requirement-detail/NodeRow.tsx` | 节点行（折叠/展开）|
| `web/src/pages/requirement-detail/NodeExpandedDetail.tsx` | 按 type 分发展开内容 |
| `web/src/pages/requirement-detail/NodeCommitsView.tsx` | git_commit_push 节点展开 |
| `web/src/pages/requirement-detail/NodeApprovalView.tsx` | human_gate 节点展开 |
| `web/src/pages/requirement-detail/NodeOutputView.tsx` | 通用 output 展开 |
| `web/src/pages/requirement-detail/SpecTab.tsx` | Spec Tab |
| `web/src/pages/requirement-detail/PlanTab.tsx` | Plan Tab |
| `web/src/pages/requirement-detail/ApprovalsTab.tsx` | 审批历史 Tab |

**修改文件（2 个）**：
- [web/src/pages/RequirementsPage.tsx](../../../web/src/pages/RequirementsPage.tsx) —— 删除 Drawer / V2StructuredView / WaiterTimeline / DecideModal / 决策 state / detail state，列表行点击改路由跳转
- [web/src/App.tsx](../../../web/src/App.tsx) —— 加 `/requirements/:id` 路由

---

## Task 1: 抽离共用组件 + effectiveStatus 派生

**目标**：把 RequirementsPage 内嵌的三个组件（V2StructuredView / WaiterTimeline / DecideModal）抽到 components/，新增 effectiveStatus 派生函数，列表页状态列接入。详情页之前列表页就能看到细粒度状态。

**Files:**
- Create: `web/src/pages/requirement-detail/effectiveStatus.ts`
- Create: `web/src/pages/requirement-detail/effectiveStatus.test.ts`
- Create: `web/src/components/V2StructuredView.tsx`
- Create: `web/src/components/WaiterTimeline.tsx`
- Create: `web/src/components/DecideModal.tsx`
- Modify: `web/src/pages/RequirementsPage.tsx`（删除内嵌定义、改 import、状态列接 effectiveStatus）

### Step 1.1: 写 effectiveStatus 测试（TDD）

- [ ] **Step 1.1.1: 创建测试文件**

Create `web/src/pages/requirement-detail/effectiveStatus.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { effectiveStatus } from './effectiveStatus'
import type { RequirementDetailDTO } from '../../api/requirements'

function makeDetail(overrides: Partial<RequirementDetailDTO>): RequirementDetailDTO {
  return {
    id: 1, title: 't', rawInput: '', status: 'developing',
    branch: null, baseBranch: 'main', gitlabProject: 'g/p',
    worktreePath: null, pipelineRunId: null, currentStage: null,
    specContent: null, planContent: null, mrUrl: null, abortReason: null,
    retryCounters: {}, source: 'web', createdBy: null, skipE2E: false,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', completedAt: null,
    waiters: [], stageResults: null,
    ...overrides,
  }
}

describe('effectiveStatus', () => {
  it('terminal status → original STATUS_CONFIG label', () => {
    expect(effectiveStatus(makeDetail({ status: 'merged' })).label).toBe('已合入')
    expect(effectiveStatus(makeDetail({ status: 'failed' })).label).toBe('失败')
    expect(effectiveStatus(makeDetail({ status: 'aborted' })).label).toBe('已中止')
    expect(effectiveStatus(makeDetail({ status: 'draft' })).label).toBe('草稿')
    expect(effectiveStatus(makeDetail({ status: 'queued' })).label).toBe('排队中')
  })

  it('pending waiter takes precedence over running node', () => {
    const d = makeDetail({
      status: 'developing',
      waiters: [{
        id: 1, requirementId: 1, pipelineRunId: 1, nodeId: 'spec_human_gate',
        approvalKind: 'spec', round: 1, decisionSet: 'binary',
        imPlatform: null, imGroupId: null, contextSummary: null,
        claimedBy: null, claimedAt: null, decision: null,
        rejectReason: null, budgetDelta: null, decidedBy: null,
        createdAt: '2026-01-01T00:00:00Z',
      }],
      stageResults: [
        { name: 'spec_author', type: 'llm_author', status: 'success' },
        { name: 'spec_human_gate', type: 'human_gate', status: 'running' },
      ],
    })
    expect(effectiveStatus(d).label).toBe('Spec 等你决策')
    expect(effectiveStatus(d).color).toBe('gold')
  })

  it('skips system orphan waiters', () => {
    const d = makeDetail({
      waiters: [{
        id: 1, requirementId: 1, pipelineRunId: 1, nodeId: 'x',
        approvalKind: 'spec', round: 1, decisionSet: 'binary',
        imPlatform: null, imGroupId: null, contextSummary: null,
        claimedBy: 'system', claimedAt: '2026-01-01T00:00:00Z',
        decision: 'aborted', rejectReason: null, budgetDelta: null,
        decidedBy: null, createdAt: '2026-01-01T00:00:00Z',
      }],
    })
    // 不应被识别为 pending waiter → 退到 STATUS_CONFIG.developing
    expect(effectiveStatus(d).label).toBe('开发中')
  })

  it('running node → node-specific label', () => {
    const d = makeDetail({
      status: 'developing',
      stageResults: [
        { name: 'init_branch', type: 'init_qi_branch', status: 'success' },
        { name: 'spec_author', type: 'llm_author', status: 'running' },
      ],
    })
    expect(effectiveStatus(d).label).toBe('Spec 生成中')
  })

  it('falls back to STATUS_CONFIG when no waiter and no running node', () => {
    const d = makeDetail({
      status: 'planning',
      stageResults: [{ name: 'init_branch', type: 'init_qi_branch', status: 'success' }],
    })
    expect(effectiveStatus(d).label).toBe('规划中')
  })

  it('all approval kinds have specific labels', () => {
    const kinds: Array<[string, string]> = [
      ['spec', 'Spec 等你决策'],
      ['plan', 'Plan 等你决策'],
      ['dev', 'Dev 等你决策'],
      ['final', '最终审批 等你决策'],
      ['qi_e2e_intervention', 'E2E 失败 等人工介入'],
      ['qi_sandbox_failed', 'Sandbox 失败 等介入'],
    ]
    for (const [kind, expected] of kinds) {
      const d = makeDetail({
        waiters: [{
          id: 1, requirementId: 1, pipelineRunId: 1, nodeId: 'x',
          approvalKind: kind as any, round: 1, decisionSet: 'binary',
          imPlatform: null, imGroupId: null, contextSummary: null,
          claimedBy: null, claimedAt: null, decision: null,
          rejectReason: null, budgetDelta: null, decidedBy: null,
          createdAt: '2026-01-01T00:00:00Z',
        }],
      })
      expect(effectiveStatus(d).label).toBe(expected)
    }
  })
})
```

- [ ] **Step 1.1.2: 运行测试，确认失败**

Run: `cd web && npx vitest run src/pages/requirement-detail/effectiveStatus.test.ts`

Expected: FAIL with `Cannot find module './effectiveStatus'`

### Step 1.2: 实现 effectiveStatus

- [ ] **Step 1.2.1: 创建实现文件**

Create `web/src/pages/requirement-detail/effectiveStatus.ts`:

```typescript
import type { RequirementDetailDTO, RequirementStatus, ApprovalWaiterDTO, V2StageResult } from '../../api/requirements'

export interface EffectiveStatus {
  label: string
  color: string
  tone: 'default' | 'processing' | 'success' | 'warning' | 'error'
}

// 与 RequirementsPage STATUS_CONFIG 同源 —— 终态 / 兜底用
const STATUS_LABELS: Record<RequirementStatus, EffectiveStatus> = {
  draft:       { label: '草稿',     color: 'default',    tone: 'default' },
  queued:      { label: '排队中',   color: 'processing', tone: 'processing' },
  spec_review: { label: '需求审核', color: 'gold',       tone: 'warning' },
  planning:    { label: '规划中',   color: 'cyan',       tone: 'processing' },
  developing:  { label: '开发中',   color: 'blue',       tone: 'processing' },
  reviewing:   { label: '代码审核', color: 'purple',     tone: 'warning' },
  testing:     { label: '测试中',   color: 'geekblue',   tone: 'processing' },
  mr_pending:  { label: 'MR 待审',  color: 'lime',       tone: 'processing' },
  mr_open:     { label: 'MR 已开',  color: 'success',    tone: 'success' },
  merged:      { label: '已合入',   color: 'success',    tone: 'success' },
  aborting:    { label: '中止中',   color: 'warning',    tone: 'warning' },
  aborted:     { label: '已中止',   color: 'default',    tone: 'default' },
  failed:      { label: '失败',     color: 'error',      tone: 'error' },
}

const WAITER_KIND_LABEL: Record<ApprovalWaiterDTO['approvalKind'], EffectiveStatus> = {
  spec:                  { label: 'Spec 等你决策',         color: 'gold',   tone: 'warning' },
  plan:                  { label: 'Plan 等你决策',         color: 'gold',   tone: 'warning' },
  dev:                   { label: 'Dev 等你决策',          color: 'gold',   tone: 'warning' },
  final:                 { label: '最终审批 等你决策',     color: 'gold',   tone: 'warning' },
  qi_e2e_intervention:   { label: 'E2E 失败 等人工介入',   color: 'orange', tone: 'warning' },
  qi_sandbox_failed:     { label: 'Sandbox 失败 等介入',   color: 'orange', tone: 'warning' },
  human_gate:            { label: '等你决策',              color: 'gold',   tone: 'warning' },
  escalation:            { label: 'AI 升级 等决策',        color: 'gold',   tone: 'warning' },
}

const NODE_RUNNING_LABEL: Record<string, EffectiveStatus> = {
  init_branch:        { label: '初始化分支中',    color: 'default',  tone: 'processing' },
  spec_author:        { label: 'Spec 生成中',     color: 'cyan',     tone: 'processing' },
  spec_ai_review:     { label: 'Spec AI 审查中',  color: 'cyan',     tone: 'processing' },
  spec_commit_push:   { label: 'Spec 提交中',     color: 'cyan',     tone: 'processing' },
  plan_author:        { label: 'Plan 生成中',     color: 'purple',   tone: 'processing' },
  plan_ai_review:     { label: 'Plan AI 审查中',  color: 'purple',   tone: 'processing' },
  plan_commit_push:   { label: 'Plan 提交中',     color: 'purple',   tone: 'processing' },
  dev_author:         { label: 'Dev 编码中',      color: 'blue',     tone: 'processing' },
  dev_ai_review:      { label: 'Dev AI 审查中',   color: 'blue',     tone: 'processing' },
  dev_push:           { label: 'Dev 推送中',      color: 'blue',     tone: 'processing' },
  qi_e2e_runner:      { label: 'E2E 测试中',      color: 'geekblue', tone: 'processing' },
  dev_fix_author:     { label: 'E2E 失败修复中',  color: 'orange',   tone: 'processing' },
  dev_fix_ai_review:  { label: '修复 AI 审查中',  color: 'orange',   tone: 'processing' },
  mr_create:          { label: '创建 MR 中',      color: 'lime',     tone: 'processing' },
  cleanup:            { label: '清理中',          color: 'default',  tone: 'processing' },
}

interface MinimalDetail {
  status: RequirementStatus
  waiters?: ApprovalWaiterDTO[]
  stageResults?: V2StageResult[] | null
}

/**
 * 从 detail 派生 UI 友好的细粒度状态：
 *   优先级：终态 > pending waiter > running 节点 > STATUS_CONFIG 兜底
 *
 * 详见 docs/superpowers/specs/2026-05-12-requirement-detail-page-redesign-design.md §「状态显示策略」
 */
export function effectiveStatus(detail: MinimalDetail): EffectiveStatus {
  const { status, waiters = [], stageResults = [] } = detail

  // 1. 终态优先
  if (status === 'draft' || status === 'queued' || status === 'merged' ||
      status === 'aborted' || status === 'failed') {
    return STATUS_LABELS[status]
  }

  // 2. pending waiter（排除 system orphan）
  const pending = waiters.find(w => !w.claimedBy && w.claimedBy !== 'system')
  if (pending) {
    const label = WAITER_KIND_LABEL[pending.approvalKind]
    if (label) return label
  }

  // 3. running 节点
  const running = (stageResults ?? []).find(s => s.status === 'running')
  if (running) {
    const label = NODE_RUNNING_LABEL[running.name]
    if (label) return label
  }

  // 4. 兜底
  return STATUS_LABELS[status]
}
```

- [ ] **Step 1.2.2: 运行测试，确认通过**

Run: `cd web && npx vitest run src/pages/requirement-detail/effectiveStatus.test.ts`

Expected: PASS, 6 tests

### Step 1.3: 抽离 V2StructuredView

- [ ] **Step 1.3.1: 创建 V2StructuredView.tsx**

Create `web/src/components/V2StructuredView.tsx`，复制 [RequirementsPage.tsx:75-442](web/src/pages/RequirementsPage.tsx#L75) 的 `RISK_COLOR` 常量和 `V2StructuredView` 函数定义（含全部 12 个 items：ac / oq / cl / risks / reviewHints / noGos / acDiff / stdConsulted / selfCheck / cov / commits / scope / fr）。

```typescript
import React from 'react'
import { Collapse, Tag, Space, Typography } from 'antd'
import { CheckOutlined } from '@ant-design/icons'
import type { V2StageResult } from '../api/requirements'

const { Text } = Typography

const RISK_COLOR: Record<'low' | 'medium' | 'high', string> = {
  low: 'green', medium: 'gold', high: 'red',
}

/**
 * 展示某 stage 的 v2 结构化输出。根据可用字段渲染不同区块。
 * - spec stage：AC 列表 / 澄清问题 / 风险 / openQuestions / reviewHints / noGos / acDiff
 * - dev / reviewer stage：commits 列表 / specCoverage 矩阵 / scopeViolations / fileRisks
 * - 共用：standardsConsulted / selfCheck
 */
export function V2StructuredView({ stage }: { stage: V2StageResult | undefined }) {
  if (!stage || !stage.skillOutput) return null
  const so = stage.skillOutput

  const items: Array<{ key: string; label: React.ReactNode; children: React.ReactNode }> = []

  if (so.acceptanceCriteria && so.acceptanceCriteria.length > 0) {
    items.push({
      key: 'ac',
      label: <Space><CheckOutlined /><span>验收标准（{so.acceptanceCriteria.length} 条 Given-When-Then）</span></Space>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.acceptanceCriteria.map(ac => (
            <li key={ac.id} style={{ marginBottom: 6 }}>
              <Tag color="cyan">{ac.id}</Tag>
              <Text>{ac.text}</Text>
            </li>
          ))}
        </ul>
      ),
    })
  }

  if (so.openQuestions && so.openQuestions.length > 0) {
    items.push({
      key: 'oq',
      label: <Space><Tag color="orange">待澄清</Tag><span>{so.openQuestions.length} 条</span></Space>,
      children: (
        <div>
          <Text type="warning" style={{ fontSize: 12 }}>
            AI 标记的不确定点。当前版本仅展示，后续支持"补充信息"输入框（Phase 4+）。
          </Text>
          <ul style={{ paddingLeft: 20, marginTop: 8 }}>
            {so.openQuestions.map((q, i) => <li key={i}>{q}</li>)}
          </ul>
        </div>
      ),
    })
  }

  if (so.clarifications && so.clarifications.length > 0) {
    items.push({
      key: 'cl',
      label: <span>澄清记录（{so.clarifications.length} 条）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0, fontSize: 13 }}>
          {so.clarifications.map((c, i) => (
            <li key={i} style={{ marginBottom: 6 }}>
              {c.kind && (
                <Tag color={c.kind === 'assumption' ? 'gold' : 'blue'} style={{ marginRight: 4 }}>
                  {c.kind === 'assumption' ? '🤔 假设' : '📋 事实'}
                </Tag>
              )}
              <Text strong>Q: </Text><Text>{c.q}</Text><br />
              <Text strong>A: </Text>
              <Text type={c.a === 'OPEN_QUESTION' ? 'warning' : 'secondary'}>{c.a}</Text>
              {c.userMayDisagreeIf && (
                <div style={{ fontSize: 12, marginTop: 2, color: '#fa8c16' }}>
                  ⚠ 反对条件：{c.userMayDisagreeIf}
                </div>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  if (so.risks && so.risks.length > 0) {
    items.push({
      key: 'risks',
      label: <span>风险与未知（{so.risks.length} 条）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.risks.map((r, i) => (
            <li key={i}>
              <Tag color={RISK_COLOR[r.severity]}>{r.severity}</Tag>
              <Text>{r.desc}</Text>
            </li>
          ))}
        </ul>
      ),
    })
  }

  if (so.reviewHints && so.reviewHints.length > 0) {
    const sorted = [...so.reviewHints].sort((a, b) => {
      const order: Record<string, number> = { high: 0, medium: 1, low: 2 }
      return (order[a.severity] ?? 9) - (order[b.severity] ?? 9)
    })
    items.push({
      key: 'reviewHints',
      label: (
        <Space>
          <Tag color="purple">⚠ LLM 提示</Tag>
          <span>需 review 的点（{so.reviewHints.length} 条）</span>
        </Space>
      ),
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {sorted.map((h, i) => (
            <li key={i} style={{ marginBottom: 8 }}>
              <Tag color={RISK_COLOR[h.severity]}>{h.severity}</Tag>
              <Text strong>{h.point}</Text>
              <div style={{ fontSize: 12, marginTop: 2, color: '#888' }}>{h.reason}</div>
            </li>
          ))}
        </ul>
      ),
    })
  }

  if (so.noGos && so.noGos.length > 0) {
    items.push({
      key: 'noGos',
      label: <span><Tag color="red">禁区</Tag>明确不实现（{so.noGos.length} 条）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.noGos.map((n, i) => (
            <li key={i} style={{ marginBottom: 6 }}>
              <Text>{n.desc}</Text>
              {n.reason && (
                <Text type="secondary" style={{ fontSize: 12 }}> — {n.reason}</Text>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  if (stage.acDiff && (
    (stage.acDiff.added?.length ?? 0) +
    (stage.acDiff.removed?.length ?? 0) +
    (stage.acDiff.changed?.length ?? 0) > 0
  )) {
    const { added = [], removed = [], changed = [] } = stage.acDiff
    items.push({
      key: 'acDiff',
      label: (
        <Space>
          <Tag color="blue">Round 变化</Tag>
          <span>+{added.length} -{removed.length} ~{changed.length}</span>
        </Space>
      ),
      children: (
        <div style={{ fontSize: 13 }}>
          {added.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <Text strong style={{ color: '#52c41a' }}>新增：</Text>
              <ul style={{ paddingLeft: 20, margin: 0 }}>
                {added.map((a) => (
                  <li key={a.id}><Tag color="green">+ {a.id}</Tag>{a.text}</li>
                ))}
              </ul>
            </div>
          )}
          {removed.length > 0 && (
            <div style={{ marginBottom: 6 }}>
              <Text strong style={{ color: '#f5222d' }}>删除：</Text>
              <ul style={{ paddingLeft: 20, margin: 0 }}>
                {removed.map((id) => (
                  <li key={id} style={{ textDecoration: 'line-through', color: '#999' }}>
                    <Tag color="red">- {id}</Tag>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {changed.length > 0 && (
            <div>
              <Text strong style={{ color: '#faad14' }}>修订：</Text>
              <ul style={{ paddingLeft: 20, margin: 0 }}>
                {changed.map((c) => (
                  <li key={c.id} style={{ marginBottom: 6 }}>
                    <Tag color="orange">~ {c.id}</Tag>
                    <div style={{ fontSize: 12, color: '#888', textDecoration: 'line-through' }}>
                      {c.oldText}
                    </div>
                    <div style={{ fontSize: 13 }}>{c.newText}</div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ),
    })
  }

  const stdConsulted = stage.evidence?.standardsConsulted
  if (stdConsulted && stdConsulted.length > 0) {
    items.push({
      key: 'stdConsulted',
      label: <span>引用规范（{stdConsulted.length} 项）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0, fontSize: 12 }}>
          {stdConsulted.map((s, i) => (
            <li key={i}>
              {typeof s === 'string' ? (
                <Text code>{s}</Text>
              ) : (
                <>
                  <Text code>{s.file}</Text>
                  {' '}— <Text type="secondary">{s.usedFor}</Text>
                </>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  const selfCheck = stage.evidence?.selfCheck
  if (selfCheck && selfCheck.length > 0) {
    items.push({
      key: 'selfCheck',
      label: <span>LLM 自检（{selfCheck.length} 条）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0, fontSize: 13 }}>
          {selfCheck.map((sc, i) => {
            const isSubjective = 'answer' in sc
            return (
              <li key={i} style={{ marginBottom: 6 }}>
                {isSubjective ? (
                  <>
                    <Text strong>💡 {sc.item}</Text>
                    <div style={{ marginTop: 2 }}>
                      <Text type="secondary">{(sc as { answer: string }).answer}</Text>
                    </div>
                  </>
                ) : (
                  <>
                    <Tag color={(sc as { passed: boolean }).passed ? 'success' : 'error'}>
                      {(sc as { passed: boolean }).passed ? '✓' : '✗'}
                    </Tag>
                    <Text>{sc.item}</Text>
                    {(sc as { reason?: string }).reason && (
                      <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>
                        {(sc as { reason: string }).reason}
                      </div>
                    )}
                  </>
                )}
              </li>
            )
          })}
        </ul>
      ),
    })
  }

  if (so.specCoverage && so.specCoverage.length > 0) {
    const covered = so.specCoverage.filter(x => x.covered).length
    items.push({
      key: 'cov',
      label: (
        <Space>
          <Tag color={covered === so.specCoverage.length ? 'success' : 'warning'}>
            {covered}/{so.specCoverage.length} AC 已覆盖
          </Tag>
        </Space>
      ),
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.specCoverage.map(c => (
            <li key={c.ac} style={{ marginBottom: 6 }}>
              <Tag color={c.covered ? 'success' : 'error'}>{c.ac}</Tag>
              {c.covered ? (
                <Text type="secondary" style={{ fontSize: 12 }}>
                  ✓ 证据：{c.evidence.map(e => `${e.file}${e.line ? ':' + e.line : ''}`).join(' · ')}
                </Text>
              ) : (
                <Text type="warning" style={{ fontSize: 12 }}>✗ {c.missingReason}</Text>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  if (so.commits && so.commits.length > 0) {
    items.push({
      key: 'commits',
      label: <span>Commits（{so.commits.length} 个）</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0, fontSize: 12 }}>
          {so.commits.map((c, i) => (
            <li key={i}>
              <Tag color={c.tsc === 'pass' ? 'success' : 'error'}>{c.tsc}</Tag>
              {c.isFix && <Tag color="orange">fix r{c.round ?? 2}</Tag>}
              <Text code>{c.sha.slice(0, 7)}</Text>
              {' '}{c.message}
              {c.vitest && (
                <Text type="secondary"> · vitest {c.vitest.passed}p/{c.vitest.failed}f</Text>
              )}
            </li>
          ))}
        </ul>
      ),
    })
  }

  if (so.scopeViolations && so.scopeViolations.length > 0) {
    items.push({
      key: 'scope',
      label: <span><Tag color="red">越界改动</Tag>{so.scopeViolations.length} 个</span>,
      children: (
        <ul style={{ paddingLeft: 20, margin: 0 }}>
          {so.scopeViolations.map((v, i) => (
            <li key={i}><Text code>{v.file}</Text> — <Text type="warning">{v.reason}</Text></li>
          ))}
        </ul>
      ),
    })
  }

  if (so.fileRisks && so.fileRisks.length > 0) {
    items.push({
      key: 'fr',
      label: <span>变更影响分析（{so.fileRisks.length} 个文件）</span>,
      children: (
        <div>
          {so.fileRisks.map((r, i) => (
            <div key={i} style={{ marginBottom: 8 }}>
              <Text code>{r.file}</Text> <Tag color={RISK_COLOR[r.risk]}>{r.risk}</Tag>
              <div style={{ fontSize: 12, marginTop: 4 }}>
                <div>职责：{r.role}</div>
                <div>影响：{r.impact}</div>
                <div><Text strong>重点 review：</Text>{r.focusOn}</div>
              </div>
            </div>
          ))}
        </div>
      ),
    })
  }

  if (items.length === 0) return null

  return <Collapse size="small" style={{ marginBottom: 16 }} items={items} />
}
```

### Step 1.4: 抽离 WaiterTimeline

- [ ] **Step 1.4.1: 创建 WaiterTimeline.tsx**

Create `web/src/components/WaiterTimeline.tsx`:

```typescript
import { Timeline, Tag, Space, Typography, Badge } from 'antd'
import type { ApprovalWaiterDTO, ApprovalDecision } from '../api/requirements'
import { KIND_LABEL } from '../pages/requirements-helpers'

const { Text } = Typography

const DECISION_CONFIG: Record<ApprovalDecision, { color: string; label: string }> = {
  approved:       { color: 'success', label: '通过' },
  rejected:       { color: 'error',   label: '拒绝' },
  rejected_plan:  { color: 'error',   label: '拒绝 plan' },
  rejected_spec:  { color: 'error',   label: '拒绝 spec' },
  force_passed:   { color: 'warning', label: '强制通过' },
  budget_extended:{ color: 'blue',    label: '延期' },
  aborted:        { color: 'default', label: '中止' },
  fix:            { color: 'processing', label: '再修一轮' },
}

const CLAIMED_BY_LABEL: Record<NonNullable<ApprovalWaiterDTO['claimedBy']>, string> = {
  im: 'IM 群',
  web: '管理后台',
  retry: '重试',
  abort: '中止',
  system: '系统',
}

function formatRelativeDuration(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms) || ms < 0) return '刚刚'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时`
  const day = Math.floor(hr / 24)
  return `${day} 天`
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function WaiterTimeline({ waiters }: { waiters: ApprovalWaiterDTO[] }) {
  // 过滤 orphan waiter（system-aborted）—— LangGraph interrupt-replay 时 buildHumanGateNode
  // 会创建一个 orphan waiter，由 invalidateWaiter 标 claimed_by='system' + decision='aborted'，
  // 是后端实现细节，不展示。
  const visible = waiters.filter(w => w.claimedBy !== 'system')
  if (visible.length === 0) return <Text type="secondary">暂无审批记录</Text>
  return (
    <Timeline
      items={visible.map(w => {
        const isPending = !w.claimedBy
        const dec = w.decision ? DECISION_CONFIG[w.decision] : null
        return {
          color: isPending ? 'blue' : (dec?.color === 'success' ? 'green' : dec?.color === 'error' ? 'red' : 'gray'),
          children: (
            <div>
              <Space size={6} wrap>
                <Text strong>{KIND_LABEL[w.approvalKind] ?? w.approvalKind}</Text>
                <Text type="secondary">第 {w.round} 轮</Text>
                {isPending && <Badge status="processing" text="等待决策" />}
                {dec && <Tag color={dec.color}>{dec.label}</Tag>}
              </Space>

              {isPending && (
                <div style={{ marginTop: 4, fontSize: 12, color: '#8C8C8C' }}>
                  已等待 {formatRelativeDuration(w.createdAt)}
                  {w.imPlatform && w.imGroupId && <span> · 已推送至 {w.imPlatform} 群</span>}
                </div>
              )}

              {!isPending && (
                <div style={{ marginTop: 4, fontSize: 12, color: '#8C8C8C' }}>
                  {w.claimedAt && <span>{formatDateTime(w.claimedAt)}</span>}
                  {w.decidedBy && <span> · 由 {w.decidedBy} 决策</span>}
                  {w.claimedBy && <span>（{CLAIMED_BY_LABEL[w.claimedBy]}）</span>}
                </div>
              )}

              {w.budgetDelta != null && (
                <div style={{ marginTop: 4, fontSize: 12 }}>
                  <Tag color="blue">预算 +{w.budgetDelta}</Tag>
                </div>
              )}

              {w.rejectReason && (
                <div style={{
                  marginTop: 6, padding: '6px 10px',
                  background: '#FFF1F0', borderLeft: '3px solid #FF4D4F',
                  borderRadius: 4, fontSize: 12,
                  whiteSpace: 'pre-wrap', color: '#434343',
                }}>
                  <Text strong style={{ color: '#CF1322' }}>拒绝原因</Text>
                  <div style={{ marginTop: 2 }}>{w.rejectReason}</div>
                </div>
              )}
            </div>
          ),
        }
      })}
    />
  )
}

// 给详情页焦点卡复用
export { formatRelativeDuration, formatDateTime, DECISION_CONFIG, CLAIMED_BY_LABEL }
```

### Step 1.5: 抽离 DecideModal

- [ ] **Step 1.5.1: 创建 DecideModal.tsx**

Create `web/src/components/DecideModal.tsx`:

```typescript
import { useMemo, useState } from 'react'
import { Modal, Form, Input, Select, Collapse, Checkbox, Space, Typography, message } from 'antd'
import { FileTextOutlined } from '@ant-design/icons'
import {
  requirementsApi,
  type ApprovalWaiterDTO,
  type ApprovalDecision,
  type RequirementDetailDTO,
} from '../api/requirements'
import {
  findStageForWaiter, shouldWarnPlanRework,
  buildDecisionModalTitle, buildDecisionOptions,
} from '../pages/requirements-helpers'
import MarkdownViewer from './MarkdownViewer'
import { V2StructuredView } from './V2StructuredView'

const { Text } = Typography
const { TextArea } = Input

interface Props {
  open: boolean
  waiter: ApprovalWaiterDTO | null
  requirementId: number
  detail: RequirementDetailDTO | null
  onClose: () => void
  /** 决策成功回调，父组件 fetch detail + 清 URL ?openWaiter */
  onDecided: () => void
}

export function DecideModal({ open, waiter, requirementId, detail, onClose, onDecided }: Props) {
  const [form] = Form.useForm()
  const selectedDecision = Form.useWatch('decision', form)
  const [loading, setLoading] = useState(false)

  // PRD §7 step 6：从 contextSummary 解析 task IDs 与 AI notes，给 rejected_plan 表单用
  const planEscalationOptions = useMemo(() => {
    const cs = waiter?.contextSummary ?? ''
    const taskIds = Array.from(cs.matchAll(/\|\s*(T\d+)\s*\|/g)).map(m => m[1])
    const uniqueTasks = Array.from(new Set(taskIds))
    const aiNotes: string[] = []
    const noteSection = cs.match(/AI Reviewer 拒绝原因[\s\S]*?(?=\n\n###|\n\n##|$)/)
    if (noteSection) {
      const noteLines = noteSection[0].matchAll(/^\d+\.\s+[🔴🟡⚪]\s+(.+?)(?:\s+·\s+`[^`]+`)?$/gm)
      for (const m of noteLines) aiNotes.push(m[1].trim())
    }
    return { taskIds: uniqueTasks, aiNotes }
  }, [waiter?.contextSummary])

  const handleSubmit = async (values: {
    decision: ApprovalDecision
    rejectReason?: string
    budgetDelta?: number
    decidedBy?: string
    targetTaskId?: string
    citedAiNotes?: string[]
  }) => {
    if (!waiter) return

    if (shouldWarnPlanRework(waiter, values.decision)) {
      const confirmed = await new Promise<boolean>((resolve) => {
        Modal.confirm({
          title: '提醒：可能触发 plan 重做',
          content: (
            <div>
              <p>spec 已是第 <Text strong>{waiter.round}</Text> 轮，再次拒绝可能让 AI 修改验收标准（AC）。</p>
              <p>如果新一轮 AC 与上一轮有差异（acDiff 非空），系统会<Text strong type="warning">自动重置 plan 节点</Text>让 plan-decomposer 重新拆任务。</p>
              <p>这会消耗额外 token，并可能让已 commit 的代码失效。确认继续吗？</p>
            </div>
          ),
          okText: '确认拒绝',
          cancelText: '取消',
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        })
      })
      if (!confirmed) return
    }

    setLoading(true)
    try {
      const res = await requirementsApi.decide(requirementId, waiter.id, {
        decision: values.decision,
        rejectReason: values.rejectReason ?? null,
        budgetDelta: values.budgetDelta ?? null,
        decidedBy: values.decidedBy ?? null,
        targetTaskId: values.targetTaskId === '__GLOBAL__' ? null : (values.targetTaskId ?? null),
        citedAiNotes: values.citedAiNotes ?? null,
      })
      if (res.ok) {
        message.success(res.resumed ? '已决策，流水线已恢复' : '已决策（流水线未恢复，可能已离线）')
        onDecided()
      }
    } catch (e: any) {
      const data = e?.response?.data
      if (data?.error === 'already claimed') {
        message.warning(`已被 ${data.claimedBy} 端率先决策`)
      } else {
        message.error('决策失败')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title={buildDecisionModalTitle(waiter)}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={loading}
      okText="提交决策"
      cancelText="取消"
      width={720}
      destroyOnClose
    >
      {(waiter?.contextSummary || detail?.specContent) && (
        <Collapse
          size="small"
          defaultActiveKey={['spec']}
          style={{ marginBottom: 16 }}
          items={[{
            key: 'spec',
            label: <Space><FileTextOutlined /><span>需求规格（Spec）— 请阅读后再决策</span></Space>,
            children: (
              <div style={{ maxHeight: 400, overflowY: 'auto', fontSize: 13 }} className="spec-markdown">
                <MarkdownViewer source={waiter?.contextSummary ?? detail?.specContent ?? ''} />
              </div>
            ),
          }]}
        />
      )}
      <V2StructuredView stage={findStageForWaiter(detail?.stageResults ?? null, waiter)} />
      <Form form={form} layout="vertical" onFinish={handleSubmit}>
        <Form.Item name="decision" label="决策" rules={[{ required: true, message: '请选择决策' }]}>
          <Select
            options={buildDecisionOptions(
              waiter,
              detail?.retryCounters as { reject_counts?: Record<string, number> } | null,
            )}
          />
        </Form.Item>
        {(selectedDecision === 'rejected' || selectedDecision === 'rejected_plan' || selectedDecision === 'rejected_spec') && (
          <Form.Item name="rejectReason" label="拒绝原因" rules={[{ required: true, message: '请说明拒绝原因' }]}>
            <TextArea rows={3} placeholder="请具体说明需要修改的内容..." />
          </Form.Item>
        )}
        {selectedDecision === 'rejected_plan' && waiter?.decisionSet === 'plan_escalation' && (
          <>
            <Form.Item
              name="targetTaskId"
              label="问题在哪个 task？"
              tooltip="选具体 task → plan-decomposer 下轮只修订该 task；选全局问题 → 整体重拆"
            >
              <Select
                placeholder="选择 task 或全局问题"
                options={[
                  { value: '__GLOBAL__', label: '🌐 全局问题（整体粒度 / 任务划分错）' },
                  ...planEscalationOptions.taskIds.map(id => ({ value: id, label: `📌 ${id}` })),
                ]}
                allowClear
              />
            </Form.Item>
            {planEscalationOptions.aiNotes.length > 0 && (
              <Form.Item
                name="citedAiNotes"
                label='勾选你认可的 AI 拒绝理由（人审"已确认是真问题"的子集）'
                tooltip="未勾选的 AI notes 视为 nitpick，下轮可降级为 warn"
              >
                <Checkbox.Group options={planEscalationOptions.aiNotes.map(n => ({ value: n, label: n }))} />
              </Form.Item>
            )}
          </>
        )}
        {selectedDecision === 'budget_extended' && (
          <Form.Item name="budgetDelta" label="追加预算（轮次）" rules={[{ required: true, message: '请输入追加轮次' }]}>
            <Input type="number" min={1} placeholder="例如 2" />
          </Form.Item>
        )}
        <Form.Item name="decidedBy" label="决策人">
          <Input placeholder="留空使用当前登录用户" />
        </Form.Item>
      </Form>
    </Modal>
  )
}
```

### Step 1.6: 修改 RequirementsPage 引用抽出的组件 + 状态列接 effectiveStatus

- [ ] **Step 1.6.1: 删除 RequirementsPage 中的内嵌组件**

Edit `web/src/pages/RequirementsPage.tsx`：

删除以下代码块（已抽离到 components/）：
- `STATUS_CONFIG` 常量（lines 30-44）—— **保留**，列表本地依赖
- `DECISION_CONFIG` 常量（lines 46-55）—— 删除
- `RISK_COLOR` 常量 + `V2StructuredView` 函数（lines 75-442）—— 删除
- `formatRelativeDuration` 函数（lines 444-455）—— 删除
- `formatDateTime` 函数（lines 457-462）—— 删除
- `CLAIMED_BY_LABEL` 常量 + `WaiterTimeline` 函数（lines 464-538）—— 删除

- [ ] **Step 1.6.2: 加 import**

在 RequirementsPage.tsx 顶部 import 区域追加：
```typescript
import { effectiveStatus } from './requirement-detail/effectiveStatus'
```

- [ ] **Step 1.6.3: 删除现已不用的 antd imports**

`Timeline`, `Badge`, `Collapse`, `Divider` 等如果在 RequirementsPage 内不再使用，从 import 中移除。临时保留 —— Drawer / DecideModal 部分还在使用，等 Task 6 一并清理。

- [ ] **Step 1.6.4: 列表状态列改用 effectiveStatus**

Edit `web/src/pages/RequirementsPage.tsx`，找到 `columns` 数组中 status 列定义（行 843-848）：

```typescript
{
  title: '状态',
  dataIndex: 'status',
  width: 110,
  render: s => <StatusTag status={s} />,
},
```

改为：

```typescript
{
  title: '状态',
  width: 140,
  render: (_, row) => {
    // 列表项是 RequirementDTO，没有 waiters/stageResults，effectiveStatus 退化为按 status 兜底
    const eff = effectiveStatus({ status: row.status })
    return <Tag color={eff.color}>{eff.label}</Tag>
  },
},
```

注：列表 API 返回 `RequirementDTO`（无 waiters/stageResults），所以 effectiveStatus 只会走"终态优先 → 兜底"两个分支，不会显示"Spec 等你决策"等细分。详情页才能看到完整派生（因为 `RequirementDetailDTO` 有 waiters/stageResults）。

- [ ] **Step 1.6.5: 删除原 StatusTag 内部组件**

如果 `StatusTag` 函数定义只剩列表列使用，且已被 effectiveStatus 替代，删除 lines 65-68 的 StatusTag 定义。Drawer 里第二处使用（line 1020）也需要替换：

Find: `<Descriptions.Item label="状态"><StatusTag status={detail.status} /></Descriptions.Item>`

Replace with:
```tsx
<Descriptions.Item label="状态">
  <Tag color={effectiveStatus(detail).color}>{effectiveStatus(detail).label}</Tag>
</Descriptions.Item>
```

- [ ] **Step 1.6.6: 删除 DecideModal 内嵌渲染替换为新组件**

Edit `web/src/pages/RequirementsPage.tsx`：删除 lines 1167-1247 (`/* 审批决策 Modal */` 整个 Modal 块)，替换为：

```typescript
{decideState.waiter && (
  <DecideModal
    open={decideState.open}
    waiter={decideState.waiter}
    requirementId={decideState.requirementId}
    detail={detail}
    onClose={() => setDecideState(s => ({ ...s, open: false }))}
    onDecided={() => {
      setDecideState(s => ({ ...s, open: false }))
      if (detail) openDetail(detail.id)
      load()
    }}
  />
)}
```

并 import：
```typescript
import { DecideModal } from '../components/DecideModal'
```

删除 `decideForm` / `decideLoading` / `handleDecide` / `planEscalationOptions` / `selectedDecision` 等已不再使用的 state 和 useMemo（lines 580-826）。保留 `decideState` 和 `openDecide` —— 列表页仍需要触发 modal 打开。

- [ ] **Step 1.6.7: 抽屉里的 WaiterTimeline 引用改 import**

Find: `<WaiterTimeline waiters={detail.waiters} />`（line 1079）

不改，但顶部 import 加：
```typescript
import { WaiterTimeline } from '../components/WaiterTimeline'
```

### Step 1.7: 类型检查 + 运行测试

- [ ] **Step 1.7.1: TypeScript 检查**

Run: `cd web && npx tsc --noEmit`

Expected: 无 error

- [ ] **Step 1.7.2: 运行 effectiveStatus 测试**

Run: `cd web && npx vitest run src/pages/requirement-detail/effectiveStatus.test.ts`

Expected: PASS, 6 tests

- [ ] **Step 1.7.3: 启动 dev server 手动验证列表页**

Run: `cd web && pnpm dev`

打开 http://localhost:5173/requirements

验证：
- 列表加载正常
- 状态列显示和原来一致（因为列表数据无 waiters/stageResults，effectiveStatus 退到兜底）
- 点击行打开 Drawer 详情正常
- Drawer 里点「审批决策」弹出 DecideModal 正常（V2StructuredView 数据展示完整）
- 决策提交后刷新行为正常

### Step 1.8: 提交

- [ ] **Step 1.8.1: Git commit**

```bash
git add web/src/pages/requirement-detail/effectiveStatus.ts \
        web/src/pages/requirement-detail/effectiveStatus.test.ts \
        web/src/components/V2StructuredView.tsx \
        web/src/components/WaiterTimeline.tsx \
        web/src/components/DecideModal.tsx \
        web/src/pages/RequirementsPage.tsx

git commit -m "$(cat <<'EOF'
refactor(web/requirements): 抽离 V2StructuredView/WaiterTimeline/DecideModal 到 components + 列表状态接 effectiveStatus

为详情页独立化做铺垫。effectiveStatus 派生函数从 stageResults+waiters
推导细粒度状态（Spec 等你决策/Plan 生成中等），列表页同步接入，列表本身
因为 DTO 无 waiters/stageResults 会退到兜底，详情页改造后才有效。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: RequirementDetailPage 骨架 + 路由 + 智能轮询

**目标**：新建详情页路由 `/requirements/:id`，加载 detail，搭好 Header + 左右栏空容器，轮询 hook 运行。访问能看到标题和 effectiveStatus 徽章，不渲染业务卡片。

**Files:**
- Create: `web/src/pages/requirement-detail/usePolling.ts`
- Create: `web/src/pages/requirement-detail/usePolling.test.ts`
- Create: `web/src/pages/RequirementDetailPage.tsx`
- Modify: `web/src/App.tsx`

### Step 2.1: 写 usePolling 测试

- [ ] **Step 2.1.1: 创建测试文件**

Create `web/src/pages/requirement-detail/usePolling.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { usePolling } from './usePolling'

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fetches once on mount', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    renderHook(() => usePolling(fetcher, { active: true, intervalMs: 5000 }))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('polls every intervalMs when active', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    renderHook(() => usePolling(fetcher, { active: true, intervalMs: 5000 }))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(5000); await vi.runOnlyPendingTimersAsync() })
    expect(fetcher).toHaveBeenCalledTimes(2)
    await act(async () => { vi.advanceTimersByTime(5000); await vi.runOnlyPendingTimersAsync() })
    expect(fetcher).toHaveBeenCalledTimes(3)
  })

  it('does not poll when active=false', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    renderHook(() => usePolling(fetcher, { active: false, intervalMs: 5000 }))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { vi.advanceTimersByTime(15000); await vi.runOnlyPendingTimersAsync() })
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('refetches when refetch() is called', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    const { result } = renderHook(() => usePolling(fetcher, { active: false, intervalMs: 5000 }))
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await act(async () => { await result.current.refetch() })
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('tracks lastFetchedAt', async () => {
    const fetcher = vi.fn().mockResolvedValue('result')
    const { result } = renderHook(() => usePolling(fetcher, { active: true, intervalMs: 5000 }))
    expect(result.current.lastFetchedAt).toBeNull()
    await act(async () => { await vi.runOnlyPendingTimersAsync() })
    expect(result.current.lastFetchedAt).toBeInstanceOf(Date)
  })
})
```

注：vitest UI 测试 hook 需要 `@testing-library/react`。如果没装：`cd web && pnpm add -D @testing-library/react`（先 grep 现有 package.json 确认）。

- [ ] **Step 2.1.2: 检查 testing-library/react 是否已装**

Run: `cd web && grep "@testing-library/react" package.json`

Expected: 已装 → 跳过下一步；未装 → 跑：
```bash
cd web && pnpm add -D @testing-library/react @types/react-dom
```

- [ ] **Step 2.1.3: 运行测试确认失败**

Run: `cd web && npx vitest run src/pages/requirement-detail/usePolling.test.ts`

Expected: FAIL with `Cannot find module './usePolling'`

### Step 2.2: 实现 usePolling

- [ ] **Step 2.2.1: 创建 usePolling.ts**

Create `web/src/pages/requirement-detail/usePolling.ts`:

```typescript
import { useEffect, useState, useRef, useCallback } from 'react'

interface Options {
  /** 是否启用轮询（false 时仅 mount 触发一次 fetch） */
  active: boolean
  /** 轮询间隔（ms），默认 5000 */
  intervalMs?: number
  /** tab visibility hidden 时是否暂停轮询，默认 true */
  pauseOnHidden?: boolean
}

export interface UsePollingResult<T> {
  data: T | null
  lastFetchedAt: Date | null
  loading: boolean
  error: unknown
  refetch: () => Promise<T | null>
}

/**
 * 智能轮询：mount 立即拉一次，active 时按 intervalMs 周期拉，tab 切走时暂停。
 * 决策 Modal 等场景调用方传 active=false 即可暂停。
 */
export function usePolling<T>(
  fetcher: () => Promise<T>,
  options: Options,
): UsePollingResult<T> {
  const { active, intervalMs = 5000, pauseOnHidden = true } = options
  const [data, setData] = useState<T | null>(null)
  const [lastFetchedAt, setLastFetchedAt] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher

  const refetch = useCallback(async (): Promise<T | null> => {
    setLoading(true)
    try {
      const result = await fetcherRef.current()
      setData(result)
      setLastFetchedAt(new Date())
      setError(null)
      return result
    } catch (e) {
      setError(e)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  // mount 立即拉一次
  useEffect(() => {
    void refetch()
  }, [refetch])

  // 轮询调度（依赖 active）
  useEffect(() => {
    if (!active) return

    const isHidden = () =>
      pauseOnHidden && typeof document !== 'undefined' && document.visibilityState === 'hidden'

    const tick = async () => {
      if (!isHidden()) {
        await refetch()
      }
      timerRef.current = setTimeout(tick, intervalMs)
    }

    timerRef.current = setTimeout(tick, intervalMs)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [active, intervalMs, pauseOnHidden, refetch])

  // visibility 变化：从 hidden 回到 visible 立即拉一次
  useEffect(() => {
    if (!pauseOnHidden || typeof document === 'undefined') return
    const handler = () => {
      if (document.visibilityState === 'visible' && active) {
        void refetch()
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [active, pauseOnHidden, refetch])

  return { data, lastFetchedAt, loading, error, refetch }
}
```

- [ ] **Step 2.2.2: 运行测试，确认通过**

Run: `cd web && npx vitest run src/pages/requirement-detail/usePolling.test.ts`

Expected: PASS, 5 tests

### Step 2.3: 创建 RequirementDetailPage 骨架

- [ ] **Step 2.3.1: 创建主页面文件**

Create `web/src/pages/RequirementDetailPage.tsx`:

```typescript
import { useState, useEffect, useCallback } from 'react'
import { useParams, useSearchParams, useNavigate } from 'react-router-dom'
import { Spin, Result, Button, Tag, Space, Typography } from 'antd'
import { ArrowLeftOutlined, ReloadOutlined } from '@ant-design/icons'
import {
  requirementsApi,
  type RequirementDetailDTO,
  type ApprovalWaiterDTO,
} from '../api/requirements'
import { effectiveStatus } from './requirement-detail/effectiveStatus'
import { usePolling } from './requirement-detail/usePolling'
import { DecideModal } from '../components/DecideModal'

const { Text } = Typography

function isValidId(s: string | undefined): s is string {
  if (!s) return false
  return /^\d+$/.test(s)
}

function formatRelativeSeconds(date: Date | null): string {
  if (!date) return '—'
  const sec = Math.floor((Date.now() - date.getTime()) / 1000)
  if (sec < 5) return '刚刚'
  if (sec < 60) return `${sec}s 前`
  const min = Math.floor(sec / 60)
  return `${min}m 前`
}

export default function RequirementDetailPage() {
  const { id: idStr } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()

  // 1. 路径参数校验
  if (!isValidId(idStr)) {
    return (
      <Result
        status="404"
        title="无效的需求 ID"
        subTitle="路径必须形如 /requirements/123"
        extra={<Button onClick={() => navigate('/requirements')}>返回列表</Button>}
      />
    )
  }
  const id = Number(idStr)

  // 2. DecideModal 状态（用于暂停轮询）
  const [decideWaiter, setDecideWaiter] = useState<ApprovalWaiterDTO | null>(null)
  const decideOpen = decideWaiter !== null

  // 3. 数据加载 + 轮询
  // active 策略：决策 Modal 打开时暂停；其它情况都 5s 轮询。
  // 终态需求每 5s 一次空 GET 代价可忽略，省去 chicken-and-egg 的派生 active 复杂度。
  const fetcher = useCallback(() => requirementsApi.get(id), [id])
  const { data: detail, loading, error, lastFetchedAt, refetch } = usePolling<RequirementDetailDTO>(
    fetcher,
    {
      active: !decideOpen,
      intervalMs: 5000,
    },
  )

  // 4. URL ?openWaiter=M 直达决策
  useEffect(() => {
    const wStr = searchParams.get('openWaiter')
    if (!wStr || !detail) return
    const wid = Number(wStr)
    if (!Number.isFinite(wid)) return
    const w = detail.waiters?.find(x => x.id === wid && !x.claimedBy)
    if (!w) return
    setDecideWaiter(w)
    const next = new URLSearchParams(searchParams)
    next.delete('openWaiter')
    setSearchParams(next, { replace: true })
  }, [detail, searchParams, setSearchParams])

  // 5. 错误兜底
  if (error && !detail) {
    return (
      <Result
        status="404"
        title="需求不存在或已被删除"
        extra={<Button onClick={() => navigate('/requirements')}>返回列表</Button>}
      />
    )
  }

  // 6. 加载中
  if (!detail) {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', padding: 80 }}>
        <Spin size="large" />
      </div>
    )
  }

  const eff = effectiveStatus(detail)

  return (
    <div style={{ background: '#F6F7FA', minHeight: 'calc(100vh - 56px)' }}>
      {/* Header 占位（Task 5 替换为 DetailHeader 组件）*/}
      <div style={{
        position: 'sticky', top: 0, zIndex: 10,
        background: '#FFFFFF', padding: '16px 24px',
        borderBottom: '1px solid #EEF0F4',
      }}>
        <Space size="middle">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/requirements')}>
            返回
          </Button>
          <Text strong style={{ fontSize: 16 }}>
            需求 #{detail.id} — {detail.title}
          </Text>
          <Tag color={eff.color}>{eff.label}</Tag>
        </Space>
        <div style={{ float: 'right', display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            上次更新 {formatRelativeSeconds(lastFetchedAt)}
          </Text>
          <Button
            icon={<ReloadOutlined />}
            size="small"
            loading={loading}
            onClick={() => void refetch()}
          >
            刷新
          </Button>
        </div>
      </div>

      {/* 左右栏占位（Task 3 / 4 / 5 填充）*/}
      <div style={{ display: 'flex', gap: 16, padding: 16 }}>
        <div style={{ width: 380, flexShrink: 0 }}>
          <div style={{ padding: 16, background: '#FFFFFF', borderRadius: 8, border: '1px dashed #ccc' }}>
            <Text type="secondary">左栏占位（Task 3 填充）</Text>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ padding: 16, background: '#FFFFFF', borderRadius: 8, border: '1px dashed #ccc' }}>
            <Text type="secondary">右栏 Tab 占位（Task 4/5 填充）</Text>
          </div>
        </div>
      </div>

      {/* 决策 Modal */}
      <DecideModal
        open={decideOpen}
        waiter={decideWaiter}
        requirementId={id}
        detail={detail}
        onClose={() => setDecideWaiter(null)}
        onDecided={() => {
          setDecideWaiter(null)
          void refetch()
        }}
      />
    </div>
  )
}
```

### Step 2.4: 注册路由

- [ ] **Step 2.4.1: 编辑 App.tsx**

Edit `web/src/App.tsx`，在 lines 36 附近 lazy imports 区域追加：

```typescript
const RequirementDetailPage  = lazy(() => import('./pages/RequirementDetailPage'))
```

在 lines 258-260 `<Route path="/requirements" ... />` 之后追加：

```typescript
<Route path="/requirements/:id" element={
  <Suspense fallback={null}><RequirementDetailPage /></Suspense>
} />
```

### Step 2.5: 验证

- [ ] **Step 2.5.1: TypeScript 检查**

Run: `cd web && npx tsc --noEmit`

Expected: 无 error

- [ ] **Step 2.5.2: 启动 dev server**

Run: `cd web && pnpm dev`

打开 http://localhost:5173/requirements/1

验证：
- 页面加载，展示标题 `需求 #1 — XXX` + 状态徽章
- 状态徽章颜色 / 标签符合 effectiveStatus 派生（如果需求正在 spec_author 跑，徽章应该是 'Spec 生成中' cyan）
- 「返回」按钮点击回 `/requirements`
- 「刷新」按钮可点，loading 状态正确
- 「上次更新 Xs 前」每 5s 跳动
- 看 Chrome DevTools Network：每 5s 一次 GET `/admin/requirements/1`

打开 http://localhost:5173/requirements/abc（无效 id）

验证：
- 显示「无效的需求 ID」错误页

打开 http://localhost:5173/requirements/99999（不存在 id）

验证：
- 显示「需求不存在或已被删除」错误页

### Step 2.6: 提交

- [ ] **Step 2.6.1: Git commit**

```bash
git add web/src/pages/requirement-detail/usePolling.ts \
        web/src/pages/requirement-detail/usePolling.test.ts \
        web/src/pages/RequirementDetailPage.tsx \
        web/src/App.tsx

git commit -m "$(cat <<'EOF'
feat(web/requirements): 详情页路由 + 骨架 + 智能轮询 hook

新增 /requirements/:id 路由，加载 detail 并按 5s 轮询。usePolling hook
支持 visibilitychange 暂停。页面 Header 已接入 effectiveStatus 派生状态。
左右栏暂为占位，Task 3-5 填充。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: 左栏三卡（焦点卡 + 元信息卡 + 原始输入卡）

**目标**：实现左栏三个卡片，焦点卡触发 DecideModal。

**Files:**
- Create: `web/src/pages/requirement-detail/DetailSidebar.tsx`
- Create: `web/src/pages/requirement-detail/PendingWaiterCard.tsx`
- Create: `web/src/pages/requirement-detail/MetaInfoCard.tsx`
- Create: `web/src/pages/requirement-detail/RawInputCard.tsx`
- Modify: `web/src/pages/RequirementDetailPage.tsx`

### Step 3.1: PendingWaiterCard

- [ ] **Step 3.1.1: 创建组件**

Create `web/src/pages/requirement-detail/PendingWaiterCard.tsx`:

```typescript
import { Button, Space, Typography } from 'antd'
import { ExclamationCircleOutlined } from '@ant-design/icons'
import type { ApprovalWaiterDTO } from '../../api/requirements'
import { KIND_LABEL } from '../requirements-helpers'
import { formatRelativeDuration } from '../../components/WaiterTimeline'

const { Text } = Typography

interface Props {
  waiter: ApprovalWaiterDTO
  onDecide: () => void
}

export function PendingWaiterCard({ waiter, onDecide }: Props) {
  const source = waiter.imPlatform && waiter.imGroupId
    ? `${waiter.imPlatform} 群已推送`
    : '仅 web 端可决策'

  return (
    <div style={{
      background: '#FFFBE6',
      border: '1px solid #faad14',
      borderRadius: 8,
      padding: 16,
      marginBottom: 16,
    }}>
      <Space size={8} style={{ marginBottom: 8 }}>
        <ExclamationCircleOutlined style={{ color: '#faad14', fontSize: 18 }} />
        <Text strong style={{ fontSize: 14 }}>待你决策</Text>
      </Space>
      <div style={{ fontSize: 13, color: '#5C6578', lineHeight: 1.8 }}>
        <div>{KIND_LABEL[waiter.approvalKind] ?? waiter.approvalKind} · 第 {waiter.round} 轮</div>
        <div>已等待 {formatRelativeDuration(waiter.createdAt)}</div>
        <div>{source}</div>
      </div>
      <Button
        type="primary"
        block
        style={{ marginTop: 12 }}
        onClick={onDecide}
      >
        前往决策 →
      </Button>
    </div>
  )
}
```

### Step 3.2: MetaInfoCard

- [ ] **Step 3.2.1: 创建组件**

Create `web/src/pages/requirement-detail/MetaInfoCard.tsx`:

```typescript
import { Tag, Typography } from 'antd'
import type { RequirementDetailDTO } from '../../api/requirements'
import { formatDateTime } from '../../components/WaiterTimeline'

const { Text } = Typography

interface Props {
  detail: RequirementDetailDTO
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, marginBottom: 8, fontSize: 13 }}>
      <div style={{ width: 90, color: '#8C8C8C', textAlign: 'right', flexShrink: 0 }}>{label}</div>
      <div style={{ flex: 1, color: '#1A1F2E', wordBreak: 'break-all' }}>{children}</div>
    </div>
  )
}

export function MetaInfoCard({ detail }: Props) {
  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid #EEF0F4',
      borderRadius: 8,
      padding: 16,
      marginBottom: 16,
    }}>
      <Text strong style={{ display: 'block', marginBottom: 12, fontSize: 14 }}>元信息</Text>

      <Row label="GitLab">{detail.gitlabProject}</Row>
      <Row label="基础分支">{detail.baseBranch}</Row>
      {detail.branch && <Row label="功能分支">{detail.branch}</Row>}
      {detail.skipE2E && <Row label="E2E"><Tag color="orange">已跳过</Tag></Row>}
      {detail.pipelineRunId != null && <Row label="Pipeline">#{detail.pipelineRunId}</Row>}
      {detail.mrUrl && (
        <Row label="MR">
          <a href={detail.mrUrl} target="_blank" rel="noreferrer">{detail.mrUrl}</a>
        </Row>
      )}
      <Row label="创建时间">{formatDateTime(detail.createdAt)}</Row>
      <Row label="创建者">{detail.createdBy ?? '—'}</Row>
      {detail.abortReason && (
        <Row label="中止原因">
          <Text type="danger">{detail.abortReason}</Text>
        </Row>
      )}
    </div>
  )
}
```

### Step 3.3: RawInputCard

- [ ] **Step 3.3.1: 创建组件**

Create `web/src/pages/requirement-detail/RawInputCard.tsx`:

```typescript
import { useState } from 'react'
import { Button, Typography } from 'antd'

const { Text } = Typography

interface Props {
  rawInput: string
}

export function RawInputCard({ rawInput }: Props) {
  const [expanded, setExpanded] = useState(false)
  const isShort = rawInput.length <= 100
  const showExpand = !isShort && !expanded

  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid #EEF0F4',
      borderRadius: 8,
      padding: 16,
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <Text strong style={{ fontSize: 14 }}>原始输入</Text>
        {!isShort && (
          <Button type="link" size="small" onClick={() => setExpanded(e => !e)} style={{ padding: 0 }}>
            {expanded ? '折叠' : '展开'}
          </Button>
        )}
      </div>
      <div
        style={{
          fontSize: 13,
          color: '#1A1F2E',
          background: '#F6F7FA',
          padding: '8px 12px',
          borderRadius: 6,
          whiteSpace: 'pre-wrap',
          maxHeight: showExpand ? 80 : undefined,
          overflow: showExpand ? 'hidden' : undefined,
          position: 'relative',
        }}
      >
        {rawInput}
        {showExpand && (
          <div style={{
            position: 'absolute',
            bottom: 0, left: 0, right: 0,
            height: 24,
            background: 'linear-gradient(to bottom, transparent, #F6F7FA)',
            pointerEvents: 'none',
          }} />
        )}
      </div>
    </div>
  )
}
```

### Step 3.4: DetailSidebar 容器

- [ ] **Step 3.4.1: 创建容器**

Create `web/src/pages/requirement-detail/DetailSidebar.tsx`:

```typescript
import type { RequirementDetailDTO, ApprovalWaiterDTO } from '../../api/requirements'
import { PendingWaiterCard } from './PendingWaiterCard'
import { MetaInfoCard } from './MetaInfoCard'
import { RawInputCard } from './RawInputCard'

interface Props {
  detail: RequirementDetailDTO
  onDecide: (waiter: ApprovalWaiterDTO) => void
}

export function DetailSidebar({ detail, onDecide }: Props) {
  const pendingWaiter = detail.waiters?.find(w => !w.claimedBy && w.claimedBy !== 'system') ?? null

  return (
    <div style={{
      width: 380,
      flexShrink: 0,
      position: 'sticky',
      top: 72,  // 跟 Header 高度（content padding 16 + header sticky height ≈ 56）
      alignSelf: 'flex-start',
      maxHeight: 'calc(100vh - 88px)',
      overflowY: 'auto',
    }}>
      {pendingWaiter && (
        <PendingWaiterCard
          waiter={pendingWaiter}
          onDecide={() => onDecide(pendingWaiter)}
        />
      )}
      <MetaInfoCard detail={detail} />
      <RawInputCard rawInput={detail.rawInput} />
    </div>
  )
}
```

### Step 3.5: 在 DetailPage 接入 Sidebar

- [ ] **Step 3.5.1: 编辑 DetailPage**

Edit `web/src/pages/RequirementDetailPage.tsx`：

替换左栏占位（`<div style={{ width: 380, flexShrink: 0 }}> ... </div>`）为：

```tsx
<DetailSidebar
  detail={detail}
  onDecide={(w) => setDecideWaiter(w)}
/>
```

并在文件顶部 import：
```typescript
import { DetailSidebar } from './requirement-detail/DetailSidebar'
```

外层 flex 容器的 `padding` 和 `sticky top` 联动：DetailPage 主 div 不变，DetailSidebar 内的 sticky top 设为 72px（header 56 + content padding 16）。

### Step 3.6: 验证

- [ ] **Step 3.6.1: TypeScript 检查**

Run: `cd web && npx tsc --noEmit`

Expected: 无 error

- [ ] **Step 3.6.2: 手动验证（浏览器）**

打开 `/requirements/<有 pending waiter 的 id>`：
- 焦点卡显示在左栏顶部，黄色边框，包含 kind / round / 等待时长 / IM 来源
- 点「前往决策」按钮 → DecideModal 弹出，操作正常
- 决策后焦点卡消失

打开 `/requirements/<无 pending waiter 的 id>`：
- 焦点卡不显示
- 元信息卡 / 原始输入卡正常
- 滚动右栏（占位）时左栏 sticky 不动

打开 `/requirements/<rawInput 短文本的 id>`：
- 没有「展开」按钮，全文直接展示

打开 `/requirements/<rawInput 长文本的 id>`：
- 默认 clamp 80px 高度，底部渐变遮罩
- 点「展开」展示全文，按钮变「折叠」

### Step 3.7: 提交

- [ ] **Step 3.7.1: Git commit**

```bash
git add web/src/pages/requirement-detail/PendingWaiterCard.tsx \
        web/src/pages/requirement-detail/MetaInfoCard.tsx \
        web/src/pages/requirement-detail/RawInputCard.tsx \
        web/src/pages/requirement-detail/DetailSidebar.tsx \
        web/src/pages/RequirementDetailPage.tsx

git commit -m "$(cat <<'EOF'
feat(web/requirements): 详情页左栏三卡 + 焦点卡决策入口

PendingWaiterCard（黄边焦点卡，pending waiter 唯一决策入口）/
MetaInfoCard（紧凑 2 列布局）/ RawInputCard（默认 clamp + 展开）。
焦点卡 → DecideModal，决策后立即 refetch。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: 右栏 Tab 容器 + 节点执行 Tab

**目标**：右栏 4 个 Tab，节点执行 Tab 完整实现（折叠/展开 / 失败节点重试 / 按 type 分发展开内容）。

**Files:**
- Create: `web/src/pages/requirement-detail/DetailTabs.tsx`
- Create: `web/src/pages/requirement-detail/NodesTab.tsx`
- Create: `web/src/pages/requirement-detail/NodeRow.tsx`
- Create: `web/src/pages/requirement-detail/NodeExpandedDetail.tsx`
- Create: `web/src/pages/requirement-detail/NodeCommitsView.tsx`
- Create: `web/src/pages/requirement-detail/NodeApprovalView.tsx`
- Create: `web/src/pages/requirement-detail/NodeOutputView.tsx`
- Modify: `web/src/pages/RequirementDetailPage.tsx`

### Step 4.1: NodeCommitsView

- [ ] **Step 4.1.1: 创建组件**

Create `web/src/pages/requirement-detail/NodeCommitsView.tsx`:

```typescript
import { Tag, Typography } from 'antd'
import type { V2StageResult } from '../../api/requirements'

const { Text } = Typography

export function NodeCommitsView({ stage }: { stage: V2StageResult }) {
  const commits = stage.skillOutput?.commits ?? []
  if (commits.length === 0) {
    return (
      <Text type="secondary" style={{ fontSize: 12 }}>
        {stage.output ? stage.output : '无 commit 记录'}
      </Text>
    )
  }
  return (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>
        Commits（{commits.length} 个）
      </Text>
      <ul style={{ paddingLeft: 20, margin: 0, fontSize: 12 }}>
        {commits.map((c, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            <Tag color={c.tsc === 'pass' ? 'success' : 'error'}>{c.tsc}</Tag>
            {c.isFix && <Tag color="orange">fix r{c.round ?? 2}</Tag>}
            <Text code>{c.sha.slice(0, 7)}</Text>
            {' '}{c.message}
            {c.vitest && (
              <Text type="secondary"> · vitest {c.vitest.passed}p/{c.vitest.failed}f</Text>
            )}
          </li>
        ))}
      </ul>
      {stage.output && (
        <div style={{ marginTop: 12 }}>
          <Text type="secondary" style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>
            {stage.output}
          </Text>
        </div>
      )}
    </div>
  )
}
```

### Step 4.2: NodeApprovalView

- [ ] **Step 4.2.1: 创建组件**

Create `web/src/pages/requirement-detail/NodeApprovalView.tsx`:

```typescript
import { Tag, Typography } from 'antd'
import type { ApprovalWaiterDTO, V2StageResult } from '../../api/requirements'
import { DECISION_CONFIG, formatDateTime, CLAIMED_BY_LABEL } from '../../components/WaiterTimeline'
import { KIND_LABEL } from '../requirements-helpers'

const { Text } = Typography

interface Props {
  stage: V2StageResult
  waiters: ApprovalWaiterDTO[]
}

export function NodeApprovalView({ stage, waiters }: Props) {
  // 找该节点对应的最近一个 claimed waiter（按 createdAt 倒序）
  const nodeWaiters = waiters
    .filter(w => w.nodeId === stage.name && w.claimedBy && w.claimedBy !== 'system')
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())

  if (nodeWaiters.length === 0) {
    return <Text type="secondary" style={{ fontSize: 12 }}>无审批记录</Text>
  }

  const latest = nodeWaiters[0]
  const dec = latest.decision ? DECISION_CONFIG[latest.decision] : null

  return (
    <div style={{ fontSize: 13 }}>
      <div style={{ marginBottom: 6 }}>
        <Text strong>{KIND_LABEL[latest.approvalKind]} · 第 {latest.round} 轮</Text>
        {dec && <Tag color={dec.color} style={{ marginLeft: 8 }}>{dec.label}</Tag>}
      </div>
      <div style={{ fontSize: 12, color: '#5C6578' }}>
        {latest.claimedAt && <span>{formatDateTime(latest.claimedAt)}</span>}
        {latest.decidedBy && <span> · 由 {latest.decidedBy} 决策</span>}
        {latest.claimedBy && <span>（{CLAIMED_BY_LABEL[latest.claimedBy]}）</span>}
      </div>
      {latest.budgetDelta != null && (
        <div style={{ marginTop: 4 }}>
          <Tag color="blue">预算 +{latest.budgetDelta}</Tag>
        </div>
      )}
      {latest.rejectReason && (
        <div style={{
          marginTop: 6, padding: '6px 10px',
          background: '#FFF1F0', borderLeft: '3px solid #FF4D4F',
          borderRadius: 4, fontSize: 12,
          whiteSpace: 'pre-wrap', color: '#434343',
        }}>
          <Text strong style={{ color: '#CF1322' }}>拒绝原因</Text>
          <div style={{ marginTop: 2 }}>{latest.rejectReason}</div>
        </div>
      )}
      {nodeWaiters.length > 1 && (
        <Text type="secondary" style={{ fontSize: 11 }}>
          该节点共 {nodeWaiters.length} 轮决策，仅显示最近一轮。完整历史请看「审批历史」Tab。
        </Text>
      )}
    </div>
  )
}
```

### Step 4.3: NodeOutputView

- [ ] **Step 4.3.1: 创建组件**

Create `web/src/pages/requirement-detail/NodeOutputView.tsx`:

```typescript
import { Typography } from 'antd'
import type { V2StageResult } from '../../api/requirements'

const { Text } = Typography

export function NodeOutputView({ stage }: { stage: V2StageResult }) {
  if (!stage.output && !stage.error) {
    return <Text type="secondary" style={{ fontSize: 12 }}>该节点无输出</Text>
  }
  return (
    <div>
      {stage.output && (
        <pre style={{
          background: '#F6F8FA',
          border: '1px solid #E4E7EE',
          borderRadius: 6,
          padding: 12,
          fontSize: 12,
          margin: 0,
          whiteSpace: 'pre-wrap',
          maxHeight: 320,
          overflowY: 'auto',
        }}>
          {stage.output}
        </pre>
      )}
    </div>
  )
}
```

### Step 4.4: NodeExpandedDetail（按 type 分发）

- [ ] **Step 4.4.1: 创建分发组件**

Create `web/src/pages/requirement-detail/NodeExpandedDetail.tsx`:

```typescript
import { Typography } from 'antd'
import type { ApprovalWaiterDTO, V2StageResult } from '../../api/requirements'
import { V2StructuredView } from '../../components/V2StructuredView'
import { QiE2eProgress } from '../QiE2eProgress'
import { NodeCommitsView } from './NodeCommitsView'
import { NodeApprovalView } from './NodeApprovalView'
import { NodeOutputView } from './NodeOutputView'

const { Text } = Typography

interface Props {
  stage: V2StageResult
  waiters: ApprovalWaiterDTO[]
  /** 整个 stageResults 列表，给 qi_e2e_runner 节点用 */
  allStages: V2StageResult[]
}

export function NodeExpandedDetail({ stage, waiters, allStages }: Props) {
  // error 优先：失败节点先展示 error
  const errorBlock = stage.error ? (
    <div style={{
      background: '#FFF1F0',
      border: '1px solid #FFCCC7',
      borderRadius: 6,
      padding: 10,
      marginBottom: 12,
      fontSize: 12,
      color: '#CF1322',
      whiteSpace: 'pre-wrap',
    }}>
      <Text strong style={{ color: '#CF1322' }}>错误</Text>
      <div style={{ marginTop: 4 }}>{stage.error}</div>
    </div>
  ) : null

  // 按 type 分发主体
  let body: React.ReactNode
  switch (stage.type) {
    case 'llm_author':
    case 'llm_review':
      body = <V2StructuredView stage={stage} />
      break
    case 'git_commit_push':
      body = <NodeCommitsView stage={stage} />
      break
    case 'human_gate':
      body = <NodeApprovalView stage={stage} waiters={waiters} />
      break
    case 'qi_e2e_runner':
      // QiE2eProgress 接收 stageResults 数组（按现签名），传入全部 stages 让它筛选
      body = <QiE2eProgress stageResults={allStages} />
      break
    case 'mr_create':
    case 'init_qi_branch':
    case 'cleanup':
    case 'switch':
    case 'end':
    case 'im_input':
    default:
      body = <NodeOutputView stage={stage} />
  }

  return (
    <div style={{ paddingLeft: 24, paddingTop: 8, paddingBottom: 8 }}>
      {errorBlock}
      {body}
    </div>
  )
}
```

### Step 4.5: NodeRow（折叠 / 展开 / 重试按钮）

- [ ] **Step 4.5.1: 创建 NodeRow**

Create `web/src/pages/requirement-detail/NodeRow.tsx`:

```typescript
import React from 'react'
import { Tag, Space, Typography, Button, Popconfirm } from 'antd'
import {
  CheckCircleOutlined, CloseCircleOutlined,
  SyncOutlined, ClockCircleOutlined,
  MinusCircleOutlined, DownOutlined, RightOutlined,
  ReloadOutlined,
} from '@ant-design/icons'
import type { ApprovalWaiterDTO, V2StageResult } from '../../api/requirements'
import { NodeExpandedDetail } from './NodeExpandedDetail'

const { Text } = Typography

const STATUS_META: Record<V2StageResult['status'], { color: string; icon: React.ReactNode; label: string }> = {
  pending:  { color: 'default',    icon: <ClockCircleOutlined />,           label: 'pending' },
  running:  { color: 'processing', icon: <SyncOutlined spin />,             label: 'running' },
  waiting:  { color: 'warning',    icon: <ClockCircleOutlined />,           label: 'waiting' },
  success:  { color: 'success',    icon: <CheckCircleOutlined />,           label: 'success' },
  failed:   { color: 'error',      icon: <CloseCircleOutlined />,           label: 'failed' },
  skipped:  { color: 'default',    icon: <MinusCircleOutlined />,           label: 'skipped' },
}

function fmtDuration(ms?: number): string {
  if (!ms) return ''
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}m`
}

interface Props {
  stage: V2StageResult
  expanded: boolean
  onToggle: () => void
  waiters: ApprovalWaiterDTO[]
  allStages: V2StageResult[]
  onRetry?: (nodeName: string) => Promise<void>
}

export function NodeRow({ stage, expanded, onToggle, waiters, allStages, onRetry }: Props) {
  const meta = STATUS_META[stage.status] ?? STATUS_META.pending
  const isFailed = stage.status === 'failed'

  return (
    <div style={{
      borderLeft: isFailed ? '3px solid #ff4d4f' : '3px solid transparent',
      paddingLeft: 12,
      marginBottom: 4,
    }}>
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 8px',
          cursor: 'pointer',
          borderRadius: 6,
          ...(expanded ? { background: '#F6F7FA' } : {}),
        }}
      >
        <span style={{ color: meta.color === 'success' ? '#52c41a' : meta.color === 'error' ? '#ff4d4f' : meta.color === 'processing' ? '#1677ff' : '#8c8c8c' }}>
          {meta.icon}
        </span>
        <Text strong style={{ flex: 1 }}>{stage.name}</Text>
        <Tag color={meta.color}>{meta.label}</Tag>
        <Text type="secondary" style={{ fontSize: 12 }}>{stage.type}</Text>
        {stage.durationMs ? (
          <Text type="secondary" style={{ fontSize: 12 }}>· {fmtDuration(stage.durationMs)}</Text>
        ) : null}
        {expanded ? <DownOutlined style={{ fontSize: 10, color: '#8c8c8c' }} /> : <RightOutlined style={{ fontSize: 10, color: '#8c8c8c' }} />}
      </div>

      {expanded && (
        <>
          <NodeExpandedDetail stage={stage} waiters={waiters} allStages={allStages} />
          {isFailed && onRetry && (
            <div style={{ paddingLeft: 24, marginTop: 8, marginBottom: 12 }}>
              <Popconfirm
                title={`从「${stage.name}」节点重试？`}
                description="将截断该节点之后的所有结果，从此节点重新执行。"
                onConfirm={() => onRetry(stage.name)}
                okText="重试"
                cancelText="取消"
              >
                <Button danger icon={<ReloadOutlined />} size="small">
                  从此节点重试
                </Button>
              </Popconfirm>
            </div>
          )}
        </>
      )}
    </div>
  )
}
```

### Step 4.6: NodesTab

- [ ] **Step 4.6.1: 创建 NodesTab**

Create `web/src/pages/requirement-detail/NodesTab.tsx`:

```typescript
import { useState, useEffect, useRef } from 'react'
import { Space, Switch, Typography, message } from 'antd'
import type { RequirementDetailDTO } from '../../api/requirements'
import { requirementsApi } from '../../api/requirements'
import { NodeRow } from './NodeRow'

const { Text } = Typography

interface Props {
  detail: RequirementDetailDTO
  onRetried: () => void
}

export function NodesTab({ detail, onRetried }: Props) {
  const stageResults = detail.stageResults ?? []
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [autoExpandedTracked, setAutoExpandedTracked] = useState<Set<string>>(new Set())
  const [showSkipped, setShowSkipped] = useState(false)

  // 自动展开 failed / running 节点（只首次，用户手动 collapse 后不再强制展开）
  useEffect(() => {
    const next = new Set(expanded)
    const tracked = new Set(autoExpandedTracked)
    let changed = false
    for (const sr of stageResults) {
      if ((sr.status === 'failed' || sr.status === 'running') && !tracked.has(sr.name)) {
        next.add(sr.name)
        tracked.add(sr.name)
        changed = true
      }
    }
    if (changed) {
      setExpanded(next)
      setAutoExpandedTracked(tracked)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageResults])

  const toggle = (name: string) => {
    setExpanded(s => {
      const next = new Set(s)
      if (next.has(name)) next.delete(name); else next.add(name)
      return next
    })
  }

  const handleRetry = async (nodeName: string) => {
    try {
      await requirementsApi.retryFromNode(detail.id, nodeName)
      message.success(`已从节点「${nodeName}」重试`)
      onRetried()
    } catch (err: any) {
      message.error(`重试失败：${err?.response?.data?.error ?? err.message}`)
    }
  }

  if (stageResults.length === 0) {
    return <Text type="secondary">流水线尚未启动，点「运行」开始</Text>
  }

  const skippedCount = stageResults.filter(s => s.status === 'skipped').length
  const visible = showSkipped ? stageResults : stageResults.filter(s => s.status !== 'skipped')

  // 能否触发重试：requirement.status==='failed' 或 stageResults 含 failed
  const canRetry = detail.status === 'failed' || stageResults.some(s => s.status === 'failed')

  return (
    <div>
      {visible.map((sr) => (
        <NodeRow
          key={sr.name}
          stage={sr}
          expanded={expanded.has(sr.name)}
          onToggle={() => toggle(sr.name)}
          waiters={detail.waiters ?? []}
          allStages={stageResults}
          onRetry={canRetry ? handleRetry : undefined}
        />
      ))}
      {skippedCount > 0 && (
        <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid #EEF0F4', fontSize: 12, color: '#8c8c8c' }}>
          <Space>
            <span>跳过节点 {skippedCount} 个</span>
            <Switch size="small" checked={showSkipped} onChange={setShowSkipped} />
            <span>{showSkipped ? '已展开' : '已隐藏'}</span>
          </Space>
        </div>
      )}
    </div>
  )
}
```

### Step 4.7: DetailTabs

- [ ] **Step 4.7.1: 创建 DetailTabs（暂只有 nodes Tab）**

Create `web/src/pages/requirement-detail/DetailTabs.tsx`:

```typescript
import { Tabs } from 'antd'
import { useSearchParams } from 'react-router-dom'
import type { RequirementDetailDTO } from '../../api/requirements'
import { NodesTab } from './NodesTab'

const VALID_TABS = new Set(['nodes', 'spec', 'plan', 'approvals'])

interface Props {
  detail: RequirementDetailDTO
  onRetried: () => void
}

export function DetailTabs({ detail, onRetried }: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab') ?? 'nodes'
  const activeTab = VALID_TABS.has(tabFromUrl) ? tabFromUrl : 'nodes'

  const handleTabChange = (key: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', key)
    setSearchParams(next, { replace: true })
  }

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 8, padding: 16, border: '1px solid #EEF0F4' }}>
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          {
            key: 'nodes',
            label: '节点执行',
            children: <NodesTab detail={detail} onRetried={onRetried} />,
          },
          {
            key: 'spec',
            label: 'Spec',
            children: <div>（Task 5 填充）</div>,
          },
          {
            key: 'plan',
            label: 'Plan',
            children: <div>（Task 5 填充）</div>,
          },
          {
            key: 'approvals',
            label: '审批历史',
            children: <div>（Task 5 填充）</div>,
          },
        ]}
      />
    </div>
  )
}
```

### Step 4.8: 接入 DetailPage

- [ ] **Step 4.8.1: 编辑 DetailPage**

Edit `web/src/pages/RequirementDetailPage.tsx`：

替换右栏占位（`<div style={{ flex: 1, minWidth: 0 }}> ... </div>`）为：

```tsx
<div style={{ flex: 1, minWidth: 0 }}>
  <DetailTabs detail={detail} onRetried={() => void refetch()} />
</div>
```

并 import：
```typescript
import { DetailTabs } from './requirement-detail/DetailTabs'
```

### Step 4.9: 验证

- [ ] **Step 4.9.1: TypeScript 检查**

Run: `cd web && npx tsc --noEmit`

Expected: 无 error

- [ ] **Step 4.9.2: 浏览器验证**

打开 `/requirements/<跑过流水线的 id>`：
- 节点 Tab 默认激活，展示节点 timeline
- 失败节点默认展开 + 红左边框 + 「从此节点重试」按钮
- 运行中节点默认展开（蓝色 SyncOutlined spin 图标）
- 点节点行 → 展开/折叠切换；展开后按 type 显示对应内容（llm_author → V2StructuredView，human_gate → NodeApprovalView 等）
- 点「从此节点重试」→ Popconfirm → 重试成功后 refetch
- 跳过节点底部「显示/隐藏」toggle 正常

刷新浏览器：节点展开状态丢失（因为没持久化展开 state），但因 5s 轮询，failed/running 节点会再次自动展开 —— 这是符合设计的。

切到「Spec」/「Plan」/「审批历史」Tab，URL 变化为 `?tab=spec` 等，刷新后保留。占位文本显示。

### Step 4.10: 提交

- [ ] **Step 4.10.1: Git commit**

```bash
git add web/src/pages/requirement-detail/NodeCommitsView.tsx \
        web/src/pages/requirement-detail/NodeApprovalView.tsx \
        web/src/pages/requirement-detail/NodeOutputView.tsx \
        web/src/pages/requirement-detail/NodeExpandedDetail.tsx \
        web/src/pages/requirement-detail/NodeRow.tsx \
        web/src/pages/requirement-detail/NodesTab.tsx \
        web/src/pages/requirement-detail/DetailTabs.tsx \
        web/src/pages/RequirementDetailPage.tsx

git commit -m "$(cat <<'EOF'
feat(web/requirements): 详情页右栏 Tab + 节点执行 Tab 完整实现

节点 timeline 行可点击展开，按 type 分发（llm_author/llm_review →
V2StructuredView; git_commit_push → NodeCommitsView; human_gate →
NodeApprovalView; qi_e2e_runner → QiE2eProgress; 其它 → output 文本）。
失败节点默认展开 + 红边框 + 「从此节点重试」。Tab 状态写 URL。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: qi-stage-map + Stepper + Header + Spec/Plan/Approvals Tab

**目标**：补齐右栏剩余 3 个 Tab，新增 DetailHeader + 7 段 ProgressStepper，详情页核心功能完成。

**Files:**
- Create: `web/src/pages/requirement-detail/qi-stage-map.ts`
- Create: `web/src/pages/requirement-detail/qi-stage-map.test.ts`
- Create: `web/src/pages/requirement-detail/ProgressStepper.tsx`
- Create: `web/src/pages/requirement-detail/DetailHeader.tsx`
- Create: `web/src/pages/requirement-detail/SpecTab.tsx`
- Create: `web/src/pages/requirement-detail/PlanTab.tsx`
- Create: `web/src/pages/requirement-detail/ApprovalsTab.tsx`
- Modify: `web/src/pages/requirement-detail/DetailTabs.tsx`
- Modify: `web/src/pages/RequirementDetailPage.tsx`

### Step 5.1: 写 qi-stage-map 测试

- [ ] **Step 5.1.1: 创建测试文件**

Create `web/src/pages/requirement-detail/qi-stage-map.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  STEPPER_STAGES, mapNodeNameToStage, stageStatus,
  type StepperStage, type V2StageResultLike,
} from './qi-stage-map'

function n(name: string, status: V2StageResultLike['status']): V2StageResultLike {
  return { name, status }
}

describe('qi-stage-map', () => {
  it('exposes 7 stages in order', () => {
    expect(STEPPER_STAGES).toEqual(['init', 'spec', 'plan', 'dev', 'review', 'e2e', 'mr'])
  })

  it('maps init_branch to init', () => {
    expect(mapNodeNameToStage('init_branch')).toBe('init')
  })

  it('maps spec_* nodes to spec', () => {
    expect(mapNodeNameToStage('spec_author')).toBe('spec')
    expect(mapNodeNameToStage('spec_ai_review')).toBe('spec')
    expect(mapNodeNameToStage('spec_human_gate')).toBe('spec')
    expect(mapNodeNameToStage('spec_commit_push')).toBe('spec')
  })

  it('maps plan_* nodes to plan', () => {
    expect(mapNodeNameToStage('plan_author')).toBe('plan')
    expect(mapNodeNameToStage('plan_commit_push')).toBe('plan')
  })

  it('maps dev_* nodes to dev (including dev_push, excluding dev_fix_*)', () => {
    expect(mapNodeNameToStage('dev_author')).toBe('dev')
    expect(mapNodeNameToStage('dev_ai_review')).toBe('dev')
    expect(mapNodeNameToStage('dev_push')).toBe('dev')
    expect(mapNodeNameToStage('dev_fix_author')).toBe('e2e')
    expect(mapNodeNameToStage('dev_fix_ai_review')).toBe('e2e')
  })

  it('maps qi_e2e_runner + e2e_* + sandbox_* to e2e', () => {
    expect(mapNodeNameToStage('qi_e2e_runner')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_skip_router')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_router')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_im_intervention')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_intervention_router')).toBe('e2e')
    expect(mapNodeNameToStage('e2e_sandbox_intervention')).toBe('e2e')
    expect(mapNodeNameToStage('sandbox_intervention_router')).toBe('e2e')
  })

  it('maps final_approval to review', () => {
    expect(mapNodeNameToStage('final_approval')).toBe('review')
  })

  it('maps mr_create / cleanup / done to mr', () => {
    expect(mapNodeNameToStage('mr_create')).toBe('mr')
    expect(mapNodeNameToStage('cleanup')).toBe('mr')
    expect(mapNodeNameToStage('done')).toBe('mr')
  })

  it('returns null for unknown nodes', () => {
    expect(mapNodeNameToStage('foo_bar')).toBeNull()
  })

  describe('stageStatus', () => {
    it('empty / all skipped → pending', () => {
      expect(stageStatus('spec', [])).toBe('pending')
      expect(stageStatus('spec', [n('spec_author', 'skipped')])).toBe('pending')
    })

    it('any failed → failed', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'failed'),
      ])).toBe('failed')
    })

    it('any running → running', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'running'),
      ])).toBe('running')
    })

    it('any waiting → running', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_human_gate', 'waiting'),
      ])).toBe('running')
    })

    it('all success (non-skipped) → done', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'success'),
        n('spec_human_gate', 'success'),
        n('spec_commit_push', 'success'),
      ])).toBe('done')
    })

    it('any success + remaining pending → running (部分完成)', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'pending'),
      ])).toBe('running')
    })

    it('all pending → pending', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'pending'),
        n('spec_ai_review', 'pending'),
      ])).toBe('pending')
    })

    it('skipped 不参与判定', () => {
      expect(stageStatus('spec', [
        n('spec_author', 'success'),
        n('spec_ai_review', 'skipped'),
        n('spec_human_gate', 'success'),
        n('spec_commit_push', 'success'),
      ])).toBe('done')
    })
  })
})
```

- [ ] **Step 5.1.2: 运行测试确认失败**

Run: `cd web && npx vitest run src/pages/requirement-detail/qi-stage-map.test.ts`

Expected: FAIL with `Cannot find module './qi-stage-map'`

### Step 5.2: 实现 qi-stage-map

- [ ] **Step 5.2.1: 创建实现文件**

Create `web/src/pages/requirement-detail/qi-stage-map.ts`:

```typescript
export const STEPPER_STAGES = ['init', 'spec', 'plan', 'dev', 'review', 'e2e', 'mr'] as const
export type StepperStage = typeof STEPPER_STAGES[number]

export interface V2StageResultLike {
  name: string
  status: 'pending' | 'running' | 'waiting' | 'success' | 'failed' | 'skipped'
}

export type StageStatusValue = 'pending' | 'running' | 'failed' | 'done'

/**
 * 把节点 name 映射到 stepper 段。
 * 节点 ID 来源：src/quick-impl/bootstrap.ts makeNode 第一个参数。
 */
export function mapNodeNameToStage(name: string): StepperStage | null {
  if (name === 'init_branch') return 'init'

  // dev_fix_* 在 e2e 阶段（E2E 失败后修复 loop）
  if (name === 'dev_fix_author' || name === 'dev_fix_ai_review') return 'e2e'

  if (name.startsWith('spec_')) return 'spec'
  if (name.startsWith('plan_')) return 'plan'
  if (name.startsWith('dev_')) return 'dev'

  if (name === 'qi_e2e_runner') return 'e2e'
  if (name.startsWith('e2e_')) return 'e2e'
  if (name.startsWith('sandbox_')) return 'e2e'

  if (name === 'final_approval') return 'review'

  if (name === 'mr_create' || name === 'cleanup' || name === 'done') return 'mr'

  return null
}

/**
 * 计算一个 stepper 段的聚合状态。
 * 见 docs/superpowers/specs/2026-05-12-requirement-detail-page-redesign-design.md §「Stepper 状态算法」
 */
export function stageStatus(stage: StepperStage, allResults: V2StageResultLike[]): StageStatusValue {
  const nodes = allResults.filter(n => mapNodeNameToStage(n.name) === stage)
  const nonSkipped = nodes.filter(n => n.status !== 'skipped')

  if (nonSkipped.length === 0) return 'pending'
  if (nonSkipped.some(n => n.status === 'failed')) return 'failed'
  if (nonSkipped.some(n => n.status === 'running' || n.status === 'waiting')) return 'running'
  if (nonSkipped.every(n => n.status === 'success')) return 'done'
  if (nonSkipped.some(n => n.status === 'success')) return 'running'  // 部分完成
  return 'pending'
}
```

- [ ] **Step 5.2.2: 运行测试确认通过**

Run: `cd web && npx vitest run src/pages/requirement-detail/qi-stage-map.test.ts`

Expected: PASS, 17 tests

### Step 5.3: ProgressStepper

- [ ] **Step 5.3.1: 创建 stepper 组件**

Create `web/src/pages/requirement-detail/ProgressStepper.tsx`:

```typescript
import { Tooltip, Typography } from 'antd'
import {
  CheckCircleFilled, CloseCircleFilled,
  SyncOutlined, MinusCircleFilled,
} from '@ant-design/icons'
import type { V2StageResult } from '../../api/requirements'
import { STEPPER_STAGES, type StepperStage, stageStatus } from './qi-stage-map'
import { mapNodeNameToStage } from './qi-stage-map'

const { Text } = Typography

const STAGE_LABEL: Record<StepperStage, string> = {
  init: 'Init', spec: 'Spec', plan: 'Plan',
  dev: 'Dev', review: 'Review', e2e: 'E2E', mr: 'MR',
}

interface Props {
  stageResults: V2StageResult[]
  skipE2E: boolean
}

export function ProgressStepper({ stageResults, skipE2E }: Props) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 0, fontSize: 12 }}>
      {STEPPER_STAGES.map((stage, idx) => {
        const isE2eSkipped = stage === 'e2e' && skipE2E
        const status = isE2eSkipped ? 'skipped' : stageStatus(stage, stageResults)
        const isLast = idx === STEPPER_STAGES.length - 1

        const subnodes = stageResults
          .filter(n => mapNodeNameToStage(n.name) === stage)
          .map(n => `${n.name}: ${n.status}`).join('\n')

        let dot: React.ReactNode
        let dotColor: string
        switch (status) {
          case 'done':
            dot = <CheckCircleFilled />; dotColor = '#52c41a'; break
          case 'running':
            dot = <SyncOutlined spin />; dotColor = '#1677ff'; break
          case 'failed':
            dot = <CloseCircleFilled />; dotColor = '#ff4d4f'; break
          case 'skipped':
            dot = <MinusCircleFilled />; dotColor = '#bfbfbf'; break
          case 'pending':
          default:
            dot = <span style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid #d9d9d9', display: 'inline-block' }} />
            dotColor = '#d9d9d9'
        }

        return (
          <Tooltip
            key={stage}
            title={
              isE2eSkipped
                ? '已配置 skipE2E=true，整段 E2E 跳过'
                : subnodes || `${STAGE_LABEL[stage]}：尚未到达`
            }
            overlayInnerStyle={{ whiteSpace: 'pre-line', fontSize: 12 }}
          >
            <div style={{ display: 'flex', alignItems: 'center' }}>
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, minWidth: 64 }}>
                <span style={{ color: dotColor, fontSize: 14 }}>{dot}</span>
                <Text style={{ fontSize: 11, color: status === 'pending' ? '#8c8c8c' : '#1A1F2E' }}>
                  {STAGE_LABEL[stage]}
                </Text>
              </div>
              {!isLast && (
                <div style={{
                  width: 24,
                  height: 2,
                  background: status === 'done' ? '#52c41a' : '#EEF0F4',
                  marginTop: -16,
                }} />
              )}
            </div>
          </Tooltip>
        )
      })}
    </div>
  )
}
```

### Step 5.4: DetailHeader

- [ ] **Step 5.4.1: 创建 Header 组件**

Create `web/src/pages/requirement-detail/DetailHeader.tsx`:

```typescript
import { Button, Tag, Space, Typography, Popconfirm, message } from 'antd'
import {
  ArrowLeftOutlined, ReloadOutlined,
  PlayCircleOutlined, StopOutlined,
} from '@ant-design/icons'
import { useNavigate } from 'react-router-dom'
import type { RequirementDetailDTO, RequirementStatus } from '../../api/requirements'
import { requirementsApi } from '../../api/requirements'
import { effectiveStatus } from './effectiveStatus'
import { ProgressStepper } from './ProgressStepper'

const { Text } = Typography

const STOPPABLE_STATUSES: RequirementStatus[] = [
  'queued', 'spec_review', 'planning', 'developing',
  'reviewing', 'testing', 'mr_pending', 'mr_open',
]

function formatRelativeSeconds(date: Date | null): string {
  if (!date) return '—'
  const sec = Math.floor((Date.now() - date.getTime()) / 1000)
  if (sec < 5) return '刚刚'
  if (sec < 60) return `${sec}s 前`
  const min = Math.floor(sec / 60)
  return `${min}m 前`
}

interface Props {
  detail: RequirementDetailDTO
  lastFetchedAt: Date | null
  loading: boolean
  onRefresh: () => void
  onActed: () => void
}

export function DetailHeader({ detail, lastFetchedAt, loading, onRefresh, onActed }: Props) {
  const navigate = useNavigate()
  const eff = effectiveStatus(detail)

  const handleRun = async () => {
    try {
      await requirementsApi.run(detail.id)
      message.success('已加入队列，worker 将在 30 秒内启动流水线')
      onActed()
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '启动失败')
    }
  }

  const handleStop = async () => {
    try {
      await requirementsApi.abort(detail.id)
      message.success('需求已停止')
      onActed()
    } catch (e: any) {
      message.error(e?.response?.data?.error ?? '停止失败')
    }
  }

  return (
    <div style={{
      position: 'sticky', top: 0, zIndex: 10,
      background: '#FFFFFF', padding: '16px 24px',
      borderBottom: '1px solid #EEF0F4',
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Space size="middle">
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={() => navigate('/requirements')}>
            返回
          </Button>
          <Text strong style={{ fontSize: 16 }}>
            需求 #{detail.id} — {detail.title}
          </Text>
          <Tag color={eff.color}>{eff.label}</Tag>
        </Space>
        <Space size={12}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            上次更新 {formatRelativeSeconds(lastFetchedAt)}
          </Text>
          <Button icon={<ReloadOutlined />} size="small" loading={loading} onClick={onRefresh}>
            刷新
          </Button>
        </Space>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <ProgressStepper
          stageResults={detail.stageResults ?? []}
          skipE2E={detail.skipE2E}
        />
        <Space>
          {detail.status === 'draft' && (
            <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleRun} size="small">
              运行
            </Button>
          )}
          {STOPPABLE_STATUSES.includes(detail.status) && (
            <Popconfirm
              title="确定要停止该需求吗？"
              description="停止后将标记为已中止，pipeline 将被终止。"
              onConfirm={handleStop}
              okText="停止"
              okButtonProps={{ danger: true }}
              cancelText="取消"
            >
              <Button danger icon={<StopOutlined />} size="small">中止</Button>
            </Popconfirm>
          )}
        </Space>
      </div>
    </div>
  )
}
```

### Step 5.5: SpecTab / PlanTab

- [ ] **Step 5.5.1: 创建 SpecTab**

Create `web/src/pages/requirement-detail/SpecTab.tsx`:

```typescript
import { useState } from 'react'
import { Button, Typography, message } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import MarkdownViewer from '../../components/MarkdownViewer'

const { Text } = Typography

interface Props {
  source: string | null
  emptyText: string
}

export function SpecTab({ source, emptyText }: Props) {
  const [copyLoading, setCopyLoading] = useState(false)

  if (!source) {
    return <Text type="secondary">{emptyText}</Text>
  }

  const handleCopy = async () => {
    setCopyLoading(true)
    try {
      await navigator.clipboard.writeText(source)
      message.success('已复制')
    } catch {
      message.error('复制失败')
    } finally {
      setCopyLoading(false)
    }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Button icon={<CopyOutlined />} size="small" loading={copyLoading} onClick={handleCopy}>
          复制
        </Button>
      </div>
      <MarkdownViewer source={source} />
    </div>
  )
}
```

- [ ] **Step 5.5.2: 创建 PlanTab**

Create `web/src/pages/requirement-detail/PlanTab.tsx`:

```typescript
import { SpecTab } from './SpecTab'

interface Props {
  source: string | null
}

export function PlanTab({ source }: Props) {
  // PlanTab 复用 SpecTab 渲染（同样是 markdown + copy）；空态文案不同
  return <SpecTab source={source} emptyText="Plan 尚未生成" />
}
```

### Step 5.6: ApprovalsTab

- [ ] **Step 5.6.1: 创建 ApprovalsTab**

Create `web/src/pages/requirement-detail/ApprovalsTab.tsx`:

```typescript
import type { ApprovalWaiterDTO } from '../../api/requirements'
import { WaiterTimeline } from '../../components/WaiterTimeline'

interface Props {
  waiters: ApprovalWaiterDTO[]
}

export function ApprovalsTab({ waiters }: Props) {
  return <WaiterTimeline waiters={waiters} />
}
```

### Step 5.7: 接 DetailTabs

- [ ] **Step 5.7.1: 编辑 DetailTabs**

Edit `web/src/pages/requirement-detail/DetailTabs.tsx`，把三个占位 children 替换：

```typescript
import { Tabs } from 'antd'
import { useSearchParams } from 'react-router-dom'
import type { RequirementDetailDTO } from '../../api/requirements'
import { NodesTab } from './NodesTab'
import { SpecTab } from './SpecTab'
import { PlanTab } from './PlanTab'
import { ApprovalsTab } from './ApprovalsTab'

const VALID_TABS = new Set(['nodes', 'spec', 'plan', 'approvals'])

interface Props {
  detail: RequirementDetailDTO
  onRetried: () => void
}

export function DetailTabs({ detail, onRetried }: Props) {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabFromUrl = searchParams.get('tab') ?? 'nodes'
  const activeTab = VALID_TABS.has(tabFromUrl) ? tabFromUrl : 'nodes'

  const handleTabChange = (key: string) => {
    const next = new URLSearchParams(searchParams)
    next.set('tab', key)
    setSearchParams(next, { replace: true })
  }

  return (
    <div style={{ background: '#FFFFFF', borderRadius: 8, padding: 16, border: '1px solid #EEF0F4' }}>
      <Tabs
        activeKey={activeTab}
        onChange={handleTabChange}
        items={[
          {
            key: 'nodes',
            label: '节点执行',
            children: <NodesTab detail={detail} onRetried={onRetried} />,
          },
          {
            key: 'spec',
            label: 'Spec',
            children: <SpecTab source={detail.specContent} emptyText="Spec 尚未生成" />,
          },
          {
            key: 'plan',
            label: 'Plan',
            children: <PlanTab source={detail.planContent} />,
          },
          {
            key: 'approvals',
            label: '审批历史',
            children: <ApprovalsTab waiters={detail.waiters ?? []} />,
          },
        ]}
      />
    </div>
  )
}
```

### Step 5.8: 接 DetailHeader 到 DetailPage

- [ ] **Step 5.8.1: 编辑 DetailPage**

Edit `web/src/pages/RequirementDetailPage.tsx`：

替换 Header 占位部分（`<div style={{ position: 'sticky', top: 0, ... }}>` 整段）为：

```tsx
<DetailHeader
  detail={detail}
  lastFetchedAt={lastFetchedAt}
  loading={loading}
  onRefresh={() => void refetch()}
  onActed={() => void refetch()}
/>
```

并 import：
```typescript
import { DetailHeader } from './requirement-detail/DetailHeader'
```

删除 DetailPage 中不再使用的 import（ArrowLeftOutlined / ReloadOutlined / Button / Tag / Space / Typography / formatRelativeSeconds 等如果只 Header 用），但保留 Spin / Result。

### Step 5.9: 验证

- [ ] **Step 5.9.1: TypeScript 检查 + 单测**

Run: `cd web && npx tsc --noEmit && npx vitest run src/pages/requirement-detail/`

Expected: tsc 无 error；qi-stage-map (17) + effectiveStatus (6) + usePolling (5) = 28 tests pass

- [ ] **Step 5.9.2: 浏览器验证**

打开 `/requirements/1`：
- Header 顶部 sticky，含返回 / 标题 / 状态徽章 / 刷新 / 上次更新
- 第二行：7 段 stepper + 操作按钮（运行/中止 按状态条件渲染）
- stepper 颜色正确：done(绿) / running(蓝转) / failed(红) / pending(灰圈) / skipped(灰减)
- 当 skipE2E=true：E2E 段灰色 minus 图标
- hover stepper 每段 → Tooltip 显示该段子节点和状态
- 「运行」点击：draft 状态显示 → 触发 enqueue + refetch
- 「中止」点击：运行状态显示 → Popconfirm → abort + refetch

切到 Spec Tab：
- 显示完整 markdown 全文（无高度限制）
- 「复制」按钮点击复制成功

切到 Plan Tab：
- 同 Spec；空态显示「Plan 尚未生成」

切到 审批历史 Tab：
- 完整 WaiterTimeline 展示（含已 claimed + pending）

### Step 5.10: 提交

- [ ] **Step 5.10.1: Git commit**

```bash
git add web/src/pages/requirement-detail/qi-stage-map.ts \
        web/src/pages/requirement-detail/qi-stage-map.test.ts \
        web/src/pages/requirement-detail/ProgressStepper.tsx \
        web/src/pages/requirement-detail/DetailHeader.tsx \
        web/src/pages/requirement-detail/SpecTab.tsx \
        web/src/pages/requirement-detail/PlanTab.tsx \
        web/src/pages/requirement-detail/ApprovalsTab.tsx \
        web/src/pages/requirement-detail/DetailTabs.tsx \
        web/src/pages/RequirementDetailPage.tsx

git commit -m "$(cat <<'EOF'
feat(web/requirements): 详情页 stepper + header 操作 + Spec/Plan/Approvals Tab

7 段 ProgressStepper 按"全部 success 才标完成"判定，每段子节点 hover 看
详情。DetailHeader 接管返回/标题/状态/刷新/stepper/运行+中止按钮。
SpecTab/PlanTab 渲染 markdown + 复制，ApprovalsTab 复用 WaiterTimeline。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: 列表页瘦身 + 旧链接兼容重定向

**目标**：删除列表页 Drawer / 抽屉里的 DecideModal 触发逻辑 / 抽屉相关 state，列表行点击改路由跳转。旧 `?id=N&openWaiter=M` 兼容重定向。

**Files:**
- Modify: `web/src/pages/RequirementsPage.tsx`

### Step 6.1: 删除 Drawer 相关代码

- [ ] **Step 6.1.1: 编辑 RequirementsPage 删除 detail 相关 state**

Edit `web/src/pages/RequirementsPage.tsx`：

删除以下 state 和 hook（lines 553-636 附近）：

```typescript
// Detail drawer
const [detailOpen, setDetailOpen] = useState(false)
const [detail, setDetail] = useState<RequirementDetailDTO | null>(null)
const [detailLoading, setDetailLoading] = useState(false)

// Decide modal
const [decideState, setDecideState] = useState<DecideModalState>(...)
```

以及：
- `openDetail` 函数
- 处理 `?id=N` query 的 useEffect（替换为重定向逻辑，下一步详述）
- 处理 `?openWaiter=M` query 的 useEffect（删除）
- `openDecide` 函数
- `activePendingWaiter` derived 变量

保留：
- `items / total / loading / page / filterStatus` 等列表 state
- `createOpen / createForm / createLoading` 等新建 state
- `editTarget / editForm / editLoading` 等编辑 state
- `runningIds / stoppingIds / deletingIds` 行级 state
- 所有列表操作函数（load / handleCreate / handleEdit / handleDelete / handleRun / handleStop）

- [ ] **Step 6.1.2: 添加旧链接重定向**

Edit `web/src/pages/RequirementsPage.tsx`：

替换原 `useEffect(() => { /* 第一步：URL ?id=N → 自动打开详情抽屉 */ ... }, [searchParams])` 整段为：

```typescript
// 旧链接兼容：/requirements?id=N&openWaiter=M → /requirements/N?openWaiter=M
useEffect(() => {
  const idStr = searchParams.get('id')
  if (!idStr) return
  const id = Number(idStr)
  if (!Number.isFinite(id)) return
  // 保留 openWaiter 等其它 query
  const next = new URLSearchParams(searchParams)
  next.delete('id')
  const qs = next.toString()
  navigate(`/requirements/${id}${qs ? `?${qs}` : ''}`, { replace: true })
}, [searchParams, navigate])
```

并 import：
```typescript
import { useNavigate } from 'react-router-dom'
```

并在组件顶部加：
```typescript
const navigate = useNavigate()
```

- [ ] **Step 6.1.3: 列表行点击改路由跳转**

Edit `web/src/pages/RequirementsPage.tsx`：

找到列表 columns 中 title 列：
```typescript
{
  title: '需求标题',
  dataIndex: 'title',
  render: (title, row) => (
    <Button type="link" style={{ padding: 0, fontWeight: 500 }} onClick={() => openDetail(row.id)}>
      {title}
    </Button>
  ),
},
```

改为：
```typescript
{
  title: '需求标题',
  dataIndex: 'title',
  render: (title, row) => (
    <Button type="link" style={{ padding: 0, fontWeight: 500 }} onClick={() => navigate(`/requirements/${row.id}`)}>
      {title}
    </Button>
  ),
},
```

找到操作列中的「详情」按钮：
```typescript
<Button size="small" onClick={() => openDetail(row.id)}>详情</Button>
```

改为：
```typescript
<Button size="small" onClick={() => navigate(`/requirements/${row.id}`)}>详情</Button>
```

- [ ] **Step 6.1.4: 删除 Drawer 渲染**

Edit `web/src/pages/RequirementsPage.tsx`：

删除整段 `<Drawer ...>...</Drawer>`（约 150 行）—— 这一段从 `{/* 详情抽屉 */}` 注释开始，到 `</Drawer>` 结束。

- [ ] **Step 6.1.5: 删除 DecideModal 渲染**

Edit `web/src/pages/RequirementsPage.tsx`：

删除 `{decideState.waiter && <DecideModal ... />}` 整段（Task 1 已替换为新组件渲染，现在彻底删掉，因为列表页不再触发审批 modal —— 已转移到详情页）。

也删除残留的 `decideState` 相关引用。

- [ ] **Step 6.1.6: 清理不再使用的 imports**

Edit `web/src/pages/RequirementsPage.tsx`：

从 import 清单删除不再使用的：
- `Drawer`
- `Descriptions`
- `Divider`
- `MarkdownViewer`（如果列表页不再用 markdown）
- `findStageForWaiter, KIND_LABEL, buildDecisionModalTitle, buildDecisionOptions`（如果列表页不再用）
- `StageResultsTimeline`（如果列表页不再用）
- `QiE2eProgress`（同上）
- `DecideModal`（已不再渲染）
- `WaiterTimeline`（已不再用）
- `CheckOutlined`、`FileTextOutlined`、`ReloadOutlined` 等抽屉相关 icon

具体删什么取决于 Step 6.1.1-6.1.5 删了多少。**实施时遵循 TypeScript / ESLint 报错指引清理**：
```bash
cd web && npx tsc --noEmit
```
按报错逐个删除未使用的 import。

- [ ] **Step 6.1.7: 删除 shouldWarnPlanRework 不再需要的 import**

`shouldWarnPlanRework` 已搬到 DecideModal 组件内部使用，列表页不再需要。从 import 中删除。

### Step 6.2: 验证

- [ ] **Step 6.2.1: TypeScript 检查**

Run: `cd web && npx tsc --noEmit`

Expected: 无 error

- [ ] **Step 6.2.2: 单测**

Run: `cd web && npx vitest run`

Expected: 全部 PASS

- [ ] **Step 6.2.3: 浏览器全链路验证**

打开 `/requirements`：
- 列表正常加载
- 点击「需求标题」/「详情」按钮 → 跳转 `/requirements/N`
- 新建 / 编辑 Modal 正常
- 行级运行 / 停止 / 删除按钮正常

打开 `/requirements?id=3`（旧链接）：
- 自动重定向到 `/requirements/3`
- 详情页正常加载

打开 `/requirements?id=3&openWaiter=12`（IM 卡片旧链接）：
- 自动重定向到 `/requirements/3?openWaiter=12`
- 详情页加载完成后 DecideModal 自动弹出

完整跑通一遍：
1. 列表创建草稿需求
2. 点详情进详情页
3. 详情页点「运行」
4. 等流水线进 spec_human_gate（status 应该是「Spec 等你决策」徽章）
5. 左栏焦点卡显示，点「前往决策」
6. DecideModal 弹出，提交决策（approved）
7. 焦点卡消失，节点 timeline 继续推进
8. 状态徽章随节点变化（Plan 生成中 → Plan AI 审查中 → ...）
9. 终态后徽章变成「已合入」或「失败」

### Step 6.3: 提交

- [ ] **Step 6.3.1: Git commit**

```bash
git add web/src/pages/RequirementsPage.tsx

git commit -m "$(cat <<'EOF'
refactor(web/requirements): 列表页删除 Drawer 详情和 DecideModal，跳详情页路由

列表行/标题/详情按钮统一跳 /requirements/N。旧 ?id=N&openWaiter=M 链接
自动 navigate(replace) 到新路由，IM 审批卡片现有链接零改动可工作。
约 -350 行：删除 Drawer 渲染、抽屉相关 state、handleDecide、planEscalationOptions。

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
EOF
)"
```

---

## 全套验收

完成 Task 1-6 后，再次跑：

- [ ] **最终验收 1: 全套单测**

Run: `cd web && npx vitest run`

Expected: 全部 PASS（含新增 28 个测试）

- [ ] **最终验收 2: TypeScript**

Run: `cd web && npx tsc --noEmit`

Expected: 无 error

- [ ] **最终验收 3: 后端单测（确保前端改动没影响后端契约）**

Run: `cd .. && ./test.sh`

Expected: 全部 PASS（应该 100% 不变，因为没动后端）

- [ ] **最终验收 4: 浏览器 E2E 流程**

完整跑一遍：
1. `/requirements` 列表 → 创建 + 运行需求
2. 详情页加载，stepper 显示当前进度
3. Spec 阶段卡 human_gate → 焦点卡 → 决策（rejected） → 焦点卡消失，新一轮 spec_author 开始
4. 第二轮 spec → human_gate → 决策（approved） → plan 阶段开始
5. ...一直到 mr_open 终态
6. URL 复用：`/requirements/N?tab=spec` 刷新保留 Tab
7. IM 审批卡片旧链接验证：手动构造 `/requirements?id=N&openWaiter=M` → 自动跳新路径并弹 modal

---

## Spec 覆盖审查

| Spec 章节 | Plan 任务 |
|---|---|
| 路由（兼容 `?id=N`）| Task 2 (新增 /requirements/:id) + Task 6 (旧链接重定向) |
| Header（含 stepper / 操作 / 刷新）| Task 5 (DetailHeader + ProgressStepper) |
| Stepper 阶段映射 + 状态算法 | Task 5 (qi-stage-map + 17 test) |
| 左栏焦点卡 | Task 3 (PendingWaiterCard) |
| 左栏元信息卡 | Task 3 (MetaInfoCard) |
| 左栏原始输入卡 | Task 3 (RawInputCard) |
| 右栏 4 Tab | Task 4 (DetailTabs + NodesTab) + Task 5 (SpecTab/PlanTab/ApprovalsTab) |
| 节点 timeline 按 type 分发 | Task 4 (NodeExpandedDetail + NodeCommitsView/NodeApprovalView/NodeOutputView/V2StructuredView) |
| 失败节点重试 + 红边框 | Task 4 (NodeRow + NodesTab) |
| DecideModal 抽离 + 兼容 IM 链接 | Task 1 (DecideModal 抽离) + Task 2 (URL ?openWaiter=M 弹) |
| effectiveStatus 派生 | Task 1 (effectiveStatus.ts + 6 test) |
| 列表页同步 effectiveStatus | Task 1 (列表状态列改) |
| 5s 智能轮询 + visibility 暂停 + decide modal 暂停 | Task 2 (usePolling + 5 test) + Task 3 (decide 暂停) |
| 列表页瘦身（删 Drawer / DecideModal）| Task 6 |
