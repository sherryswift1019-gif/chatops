# Spec 审批卡片低自信信号强化 — Design

**Date**: 2026-05-12
**Scope**: `src/pipeline/approval-summary/` (i18n / shared / spec)
**Touches**: 3 source files + 1 test file
**Does NOT touch**: graph-builder, bootstrap, condition.kind, plan.ts

## 1. Goal

让 `spec_human_gate` 审批 reviewer 一眼看到 `confidenceLevel: 'low'` 信号，避免被埋在 web summary 第 1 段的平铺文字里。

## 2. Why now

QI pipeline v12 拓扑下 `spec_human_gate` 已经强制 `mode: 'required'`（每个 spec 都走人审），所以"流程上要不要让人看"不是问题。问题是**人看了也容易漏**：

- [shared.ts:31](../../../src/pipeline/approval-summary/shared.ts#L31) 的 hint 优先级 `reviewHints.high > risks.high > round≥3 > confidenceLevel='high'` — **`confidenceLevel='low'` 不触发任何 hint**
- [spec.ts:72-74](../../../src/pipeline/approval-summary/spec.ts#L72-L74) Web summary 第 1 段把 `置信度: low` 平铺成普通文字，无颜色无加粗
- [spec.ts:200-220](../../../src/pipeline/approval-summary/spec.ts#L200-L220) IM summary 完全不含 confidence 字段

`confidenceLevel` 是 spec-author v3 已经在产出的字段（[role-output-schemas.ts:127](../../../src/quick-impl/role-output-schemas.ts#L127)），只是消费侧没用满。

## 3. Design

### 3.1 加新 hint 文案 — i18n.ts

```ts
HINT_LOW_CONFIDENCE: '⚠️ LLM 自信度低，请细审 assumptions 与 reviewHints',
```

### 3.2 重排 hint 优先级 — shared.ts:computeHeuristicHint

新优先级（从最高到最低）：

```
confidenceLevel === 'low'    [NEW, 最高]
  > reviewHints.high
  > risks.high
  > round ≥ 3 / budgetExtended
  > confidenceLevel === 'high'
```

**Why low > high-risk**：low 是元信号 — 连 LLM 自己都不确定 spec 是否对，比"有 high 风险但 LLM 自信"更值得 reviewer 慢看。high-risk 信号在第 2 段 reviewHints 已经按 severity 排序+红色标记，不靠 hint 也能看到；low confidence 没有第二个曝光位。

### 3.3 Web summary 第 1 段加视觉强化 — spec.ts:72-74

把当前：

```ts
evalParts.push(`${SpecSummaryI18n.CONFIDENCE_PREFIX} ${skillOutput.confidenceLevel}`)
```

改成按等级加 emoji + 加粗：

| confidenceLevel | 渲染 |
|---|---|
| `high` | `🟢 置信度: high` |
| `medium` | `🟡 置信度: medium` |
| `low` | `🔴 **置信度: low**` |

与 risks 段的 `🔴/🟡/🟢` 视觉体系对齐。

### 3.4 IM summary 加 low 提示 — spec.ts:200-220

在 title 行下、hint 行之前插入：

```ts
if (skillOutput.confidenceLevel === 'low') {
  imLines.push('🔴 低自信，需细审')
}
```

只有 `low` 触发。high / medium 维持现状（IM 字数 250 紧）。当前 IM summary 5 行约 100 字，加这行还有 buffer。

## 4. Acceptance Criteria

- **AC-1**: `computeHeuristicHint({ confidenceLevel: 'low' })` 返回 `HINT_LOW_CONFIDENCE`，**即使**同时存在 high reviewHints / high risks / round≥3
- **AC-2**: `computeHeuristicHint({ confidenceLevel: 'high' })` 仍返回 `HINT_QUICK_PASS`（不回归）
- **AC-3**: `computeHeuristicHint({})`（无 confidenceLevel）按旧优先级走（不回归）
- **AC-4**: Web summary 在 `confidenceLevel='low'` 时含字符串 `🔴 **置信度: low**`
- **AC-5**: Web summary 在 `confidenceLevel='high'` 时含 `🟢 置信度: high`（不加粗）
- **AC-6**: IM summary 在 `confidenceLevel='low'` 时含字符串 `🔴 低自信，需细审`
- **AC-7**: IM summary 在 `confidenceLevel='high'/'medium'` 时**不含** `低自信` 字样
- **AC-8**: IM summary 总长度 ≤ 250 字符（`truncateImSummary` 不被触发到截断）

## 5. e2e Scenarios

### 5.1 happy: low confidence + low risks
- Given: spec-author 输出 `confidenceLevel: 'low'`，无 high risks，无 high reviewHints
- When: `buildSpecApprovalSummary` 跑完
- Then:
  - web 含 `🔴 **置信度: low**`
  - web 的 hint 行含 `LLM 自信度低，请细审`
  - im 第二行含 `🔴 低自信，需细审`

### 5.2 negative: low confidence + high reviewHints 共存（优先级冲突）
- Given: `confidenceLevel: 'low'` + `reviewHints: [{severity:'high'}]`
- When: hint 计算
- Then: 返回 `HINT_LOW_CONFIDENCE`（NOT `HINT_HIGH_RISK`），证明 low 优先级最高

### 5.3 negative: 不回归 high confidence 快速批
- Given: `confidenceLevel: 'high'`, 无 high risks, round=1
- Then: hint 返回 `HINT_QUICK_PASS`，web 含 `🟢 置信度: high`，im 不含 `低自信`

## 6. Risks

| Severity | Risk | Mitigation |
|---|---|---|
| medium | HINT_HIGH_RISK 被 LOW_CONFIDENCE 盖住，reviewer 漏看高风险 | hint 文案明确引导到 reviewHints 段（"请细审 assumptions 与 reviewHints"）；reviewHints 段本身保留 high severity 红色标记 |
| low | IM 摘要超 250 字 | 实测当前 5 行约 100 字，加 1 行裕量足；`truncateImSummary` 兜底 |

## 7. NoGos

- 不动 [bootstrap.ts](../../../src/quick-impl/bootstrap.ts) 拓扑（spec 阶段已 `mode: required`，加任何节点是 dead code）
- 不扩 [graph-builder.ts](../../../src/pipeline/graph-builder.ts) 的 `condition.kind`（本次范围用不到字段值路由）
- 不动 [plan.ts](../../../src/pipeline/approval-summary/plan.ts) — plan-author 也产出 confidenceLevel 但本次只解决 spec 阶段；plan 同款改动留 follow-up
- 不改 spec-author / spec-reviewer 的 prompt / role 文件

## 8. References

- [src/pipeline/approval-summary/i18n.ts](../../../src/pipeline/approval-summary/i18n.ts) — hint 文案常量
- [src/pipeline/approval-summary/shared.ts:15-34](../../../src/pipeline/approval-summary/shared.ts#L15-L34) — `computeHeuristicHint`
- [src/pipeline/approval-summary/spec.ts:72-86](../../../src/pipeline/approval-summary/spec.ts#L72-L86) — web summary 第 1 段
- [src/pipeline/approval-summary/spec.ts:200-220](../../../src/pipeline/approval-summary/spec.ts#L200-L220) — IM summary 组装
- [src/quick-impl/role-output-schemas.ts:127](../../../src/quick-impl/role-output-schemas.ts#L127) — `confidenceLevel: z.enum(['high','medium','low']).optional()`
- [src/__tests__/unit/spec-summary-builder.test.ts](../../../src/__tests__/unit/spec-summary-builder.test.ts) — 既有测试套，加 4 个 case
