# Spec 审批卡片低自信信号强化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `spec_human_gate` 审批 reviewer 一眼看到 `confidenceLevel: 'low'` 信号，避免被埋在 web summary 第 1 段的平铺文字里。

**Architecture:** 三处改动都在 [src/pipeline/approval-summary/](../../../src/pipeline/approval-summary/) 模块内：(1) 在 `i18n.ts` 加 hint 文案；(2) 在 `shared.ts:computeHeuristicHint` 把 `confidenceLevel='low'` 提到最高优先级；(3) 在 `spec.ts` web 第 1 段加视觉强化 + IM 摘要插一行 low 提示。不动 graph-builder / bootstrap / human_gate 节点。

**Tech Stack:** TypeScript (ES2022 + NodeNext), Vitest, zod schema (SpecAuthorOutput).

**Spec:** [docs/superpowers/specs/2026-05-12-spec-low-confidence-signal-design.md](../specs/2026-05-12-spec-low-confidence-signal-design.md)

---

## File Structure

| File | Responsibility | This plan touches |
|---|---|---|
| [src/pipeline/approval-summary/i18n.ts](../../../src/pipeline/approval-summary/i18n.ts) | 字符串常量 | +1 key: `HINT_LOW_CONFIDENCE` |
| [src/pipeline/approval-summary/shared.ts](../../../src/pipeline/approval-summary/shared.ts) | 共享 helpers, hint 计算 | 改 `computeHeuristicHint` 优先级（low 排首） |
| [src/pipeline/approval-summary/spec.ts](../../../src/pipeline/approval-summary/spec.ts) | spec 阶段 web/im 摘要 | 改第 1 段 confidenceLevel 渲染 + IM 加 low 行 |
| [src/\_\_tests\_\_/unit/spec-summary-builder.test.ts](../../../src/__tests__/unit/spec-summary-builder.test.ts) | 已有测试套 | +5 个 case 覆盖 8 个 AC |

---

## Task 1: Hint 优先级重排 — `confidenceLevel='low'` 排到最高

**Files:**
- Modify: [src/pipeline/approval-summary/i18n.ts](../../../src/pipeline/approval-summary/i18n.ts) (+1 line)
- Modify: [src/pipeline/approval-summary/shared.ts:11-34](../../../src/pipeline/approval-summary/shared.ts#L11-L34)
- Test: [src/__tests__/unit/spec-summary-builder.test.ts](../../../src/__tests__/unit/spec-summary-builder.test.ts) (+3 cases)

**Covers AC-1 / AC-2 / AC-3**

### Step 1.1 — Write failing test for low-confidence hint (AC-1)

- [ ] **Step 1.1**: Append to [spec-summary-builder.test.ts](../../../src/__tests__/unit/spec-summary-builder.test.ts) (在最后一个 `})` close 之前)：

```typescript
  // ─── Low Confidence Signal（AC-1/2/3/4/5/6/7/8）──────────────────────
  it('AC-1: confidenceLevel=low 优先级最高 — 同时存在 high reviewHints / high risks / round=3 时仍返回 HINT_LOW_CONFIDENCE', () => {
    const skillOutput = loadFixture('v3-minimal.json')
    skillOutput.confidenceLevel = 'low'
    ;(skillOutput as { reviewHints: Array<{ severity: string; point: string; reason: string }> }).reviewHints = [
      { severity: 'high', point: 'X', reason: 'Y' },
    ]
    ;(skillOutput as { risks: Array<{ severity: string; desc: string }> }).risks = [
      { severity: 'high', desc: 'Z' },
    ]
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 3,
    })
    expect(web).toContain('LLM 自信度低，请细审')
    expect(web).not.toContain('看起来可快速批')
    expect(web).not.toContain('建议 escalation')
  })

  it('AC-2: confidenceLevel=high 仍返回 HINT_QUICK_PASS（不回归）', () => {
    const skillOutput = loadFixture('v3-minimal.json')  // 已是 high + 全 low risk + 空 reviewHints
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('看起来可快速批')
    expect(web).not.toContain('LLM 自信度低')
  })

  it('AC-3: 无 confidenceLevel 字段时按旧优先级走（high reviewHint → HINT_HIGH_RISK）', () => {
    const skillOutput = loadFixture('v3-minimal.json') as { reviewHints: Array<{ severity: string; point: string; reason: string }>; confidenceLevel?: string }
    delete skillOutput.confidenceLevel
    skillOutput.reviewHints = [{ severity: 'high', point: 'X', reason: 'Y' }]
    const { web } = buildSpecApprovalSummary({
      skillOutput: skillOutput as Parameters<typeof buildSpecApprovalSummary>[0]['skillOutput'],
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('建议关注下方 high 风险')
    expect(web).not.toContain('LLM 自信度低')
  })
```

### Step 1.2 — Run test, verify RED

- [ ] **Step 1.2**: Run test, confirm fail.

Run: `CI=true npx vitest run src/__tests__/unit/spec-summary-builder.test.ts -t "AC-1|AC-2|AC-3"`

Expected: 3 tests fail. AC-1 fail because no `LLM 自信度低` string exists yet. AC-3 likely pass (preserves behavior). AC-2 pass (already works). Continue if at least AC-1 fails.

### Step 1.3 — Add `HINT_LOW_CONFIDENCE` to i18n

- [ ] **Step 1.3**: In [src/pipeline/approval-summary/i18n.ts](../../../src/pipeline/approval-summary/i18n.ts) inside `SpecSummaryI18n`, add the new key alongside the other `HINT_*` constants:

```typescript
  HINT_QUICK_PASS: '看起来可快速批',
  HINT_HIGH_RISK: '建议关注下方 high 风险',
  HINT_ESCALATION: '建议 escalation',
  HINT_LOW_CONFIDENCE: '⚠️ LLM 自信度低，请细审 assumptions 与 reviewHints',
```

### Step 1.4 — Reorder priority in shared.ts

- [ ] **Step 1.4**: Modify [src/pipeline/approval-summary/shared.ts](../../../src/pipeline/approval-summary/shared.ts#L11-L34) — update the jsdoc and add early return for `confidenceLevel === 'low'`:

```typescript
/**
 * 启发式审批助手 hint。优先级：confidenceLevel='low' > reviewHints.high > risks.high > round≥3 > confidenceLevel='high'
 * 矛盾时 low confidence 优先于 high risk —— 元信号（LLM 自己都不确定）比内容信号更重要；
 * high risk 在 reviewHints/risks 段已有红色标记，不靠 hint 也能看到，但 low confidence 没有第二个曝光位。
 */
export function computeHeuristicHint(args: {
  skillOutput: SpecAuthorOutput | null
  round: number
  budgetExtended?: boolean
}): string {
  const { skillOutput, round, budgetExtended } = args
  if (!skillOutput) return ''

  if (skillOutput.confidenceLevel === 'low') return SpecSummaryI18n.HINT_LOW_CONFIDENCE

  const reviewHints = skillOutput.reviewHints ?? []
  if (reviewHints.some((h) => h.severity === 'high')) return SpecSummaryI18n.HINT_HIGH_RISK

  const risks = skillOutput.risks ?? []
  if (risks.some((r) => r.severity === 'high')) return SpecSummaryI18n.HINT_HIGH_RISK

  if (round >= 3 || budgetExtended) return SpecSummaryI18n.HINT_ESCALATION

  if (skillOutput.confidenceLevel === 'high') return SpecSummaryI18n.HINT_QUICK_PASS

  return ''
}
```

### Step 1.5 — Run tests, verify GREEN

- [ ] **Step 1.5**: Run all three new tests + verify no regression on existing tests.

Run: `CI=true npx vitest run src/__tests__/unit/spec-summary-builder.test.ts`

Expected: All tests pass including new AC-1 / AC-2 / AC-3.

### Step 1.6 — Typecheck

- [ ] **Step 1.6**: Run typecheck.

Run: `pnpm exec tsc --noEmit`

Expected: no output (silent success).

### Step 1.7 — Commit

- [ ] **Step 1.7**: Commit.

```bash
git add src/pipeline/approval-summary/i18n.ts src/pipeline/approval-summary/shared.ts src/__tests__/unit/spec-summary-builder.test.ts
git commit -m "feat(approval-summary): low-confidence hint 优先级最高

confidenceLevel=low 是元信号（LLM 自己都不确定），比 high risk 更值得
reviewer 慢看。high risk 在 reviewHints/risks 段已有红色标记，不靠 hint 也
能看到；low confidence 没有第二个曝光位。

新优先级：confidenceLevel='low' > reviewHints.high > risks.high > round≥3 >
confidenceLevel='high'。

Closes AC-1/2/3 (docs/superpowers/specs/2026-05-12-spec-low-confidence-signal-design.md)"
```

---

## Task 2: Web summary 第 1 段加视觉强化

**Files:**
- Modify: [src/pipeline/approval-summary/spec.ts:72-74](../../../src/pipeline/approval-summary/spec.ts#L72-L74)
- Test: [src/__tests__/unit/spec-summary-builder.test.ts](../../../src/__tests__/unit/spec-summary-builder.test.ts) (+2 cases)

**Covers AC-4 / AC-5**

### Step 2.1 — Write failing tests for web visual marker

- [ ] **Step 2.1**: Append to spec-summary-builder.test.ts (在 Task 1 加的 case 之后)：

```typescript
  it('AC-4: confidenceLevel=low → web 含 🔴 **置信度: low**（加粗）', () => {
    const skillOutput = loadFixture('v3-minimal.json')
    skillOutput.confidenceLevel = 'low'
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('🔴 **置信度: low**')
  })

  it('AC-5: confidenceLevel=high → web 含 🟢 置信度: high（不加粗）', () => {
    const skillOutput = loadFixture('v3-minimal.json')  // 已是 high
    const { web } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(web).toContain('🟢 置信度: high')
    expect(web).not.toContain('🔴 **置信度')
  })
```

### Step 2.2 — Run tests, verify RED

- [ ] **Step 2.2**: Confirm fail.

Run: `CI=true npx vitest run src/__tests__/unit/spec-summary-builder.test.ts -t "AC-4|AC-5"`

Expected: both fail with messages like `expected '## 📋 Spec 评审 · 第 1 轮 ...' to contain '🔴 **置信度: low**'`.

### Step 2.3 — Implement web visual emphasis

- [ ] **Step 2.3**: Modify [spec.ts:72-74](../../../src/pipeline/approval-summary/spec.ts#L72-L74) — replace the single push with per-level rendering:

```typescript
  // 1. 本次评估
  const evalParts: string[] = []
  if (skillOutput.confidenceLevel) {
    const conf = skillOutput.confidenceLevel
    const icon = conf === 'low' ? '🔴' : conf === 'medium' ? '🟡' : '🟢'
    const text = `${SpecSummaryI18n.CONFIDENCE_PREFIX} ${conf}`
    evalParts.push(conf === 'low' ? `${icon} **${text}**` : `${icon} ${text}`)
  }
```

### Step 2.4 — Run tests, verify GREEN

- [ ] **Step 2.4**: Run full test file to confirm no regression.

Run: `CI=true npx vitest run src/__tests__/unit/spec-summary-builder.test.ts`

Expected: all tests pass.

### Step 2.5 — Typecheck

- [ ] **Step 2.5**: Run typecheck.

Run: `pnpm exec tsc --noEmit`

Expected: silent success.

### Step 2.6 — Commit

- [ ] **Step 2.6**: Commit.

```bash
git add src/pipeline/approval-summary/spec.ts src/__tests__/unit/spec-summary-builder.test.ts
git commit -m "feat(approval-summary): web summary §1 置信度按等级加 emoji+加粗

low → 🔴 **置信度: low**（加粗）
medium → 🟡 置信度: medium
high → 🟢 置信度: high

与 risks 段的 🔴/🟡/🟢 视觉体系对齐。

Closes AC-4/5 (docs/superpowers/specs/2026-05-12-spec-low-confidence-signal-design.md)"
```

---

## Task 3: IM summary 加 low-confidence 行

**Files:**
- Modify: [src/pipeline/approval-summary/spec.ts:200-220](../../../src/pipeline/approval-summary/spec.ts#L200-L220)
- Test: [src/__tests__/unit/spec-summary-builder.test.ts](../../../src/__tests__/unit/spec-summary-builder.test.ts) (+3 cases)

**Covers AC-6 / AC-7 / AC-8**

### Step 3.1 — Write failing tests for IM low-confidence row

- [ ] **Step 3.1**: Append to spec-summary-builder.test.ts:

```typescript
  it('AC-6: confidenceLevel=low → IM 含 🔴 低自信，需细审', () => {
    const skillOutput = loadFixture('v3-minimal.json')
    skillOutput.confidenceLevel = 'low'
    const { im } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(im).toContain('🔴 低自信，需细审')
  })

  it('AC-7: confidenceLevel=high/medium → IM 不含 低自信 字样', () => {
    const high = loadFixture('v3-minimal.json')
    high.confidenceLevel = 'high'
    const { im: imHigh } = buildSpecApprovalSummary({
      skillOutput: high,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(imHigh).not.toContain('低自信')

    const med = loadFixture('v3-minimal.json')
    med.confidenceLevel = 'medium'
    const { im: imMed } = buildSpecApprovalSummary({
      skillOutput: med,
      specMdContent: SAMPLE_SPEC_MD,
      round: 1,
    })
    expect(imMed).not.toContain('低自信')
  })

  it('AC-8: low-confidence + 满字段 IM 长度仍 ≤ 250 字符', () => {
    const skillOutput = loadFixture('v3-full.json')
    skillOutput.confidenceLevel = 'low'
    const { im } = buildSpecApprovalSummary({
      skillOutput,
      specMdContent: SAMPLE_SPEC_MD,
      round: 2,
    })
    expect(im.length).toBeLessThanOrEqual(250)
    expect(im).toContain('🔴 低自信，需细审')
  })
```

### Step 3.2 — Run tests, verify RED

- [ ] **Step 3.2**: Confirm fail.

Run: `CI=true npx vitest run src/__tests__/unit/spec-summary-builder.test.ts -t "AC-6|AC-7|AC-8"`

Expected: AC-6 / AC-8 fail (`expected to contain '🔴 低自信，需细审'`). AC-7 may pass already.

### Step 3.3 — Add IM low row

- [ ] **Step 3.3**: Modify [spec.ts:201-203](../../../src/pipeline/approval-summary/spec.ts#L201-L203) — insert low row right after title:

```typescript
  // ===== IM 摘要（≤ 250 字符）=====
  const imLines: string[] = []
  imLines.push(`🤖 ${SpecSummaryI18n.TITLE} · 第 ${round} 轮`)
  if (skillOutput.confidenceLevel === 'low') {
    imLines.push('🔴 低自信，需细审')
  }
  if (hint) imLines.push(`💡 ${hint}`)
```

注意：只在 `confidenceLevel === 'low'` 时插入，high / medium 不插（避免 250 字预算紧张）。

### Step 3.4 — Run tests, verify GREEN

- [ ] **Step 3.4**: Run full test file.

Run: `CI=true npx vitest run src/__tests__/unit/spec-summary-builder.test.ts`

Expected: all tests pass.

### Step 3.5 — Typecheck

- [ ] **Step 3.5**: Run typecheck.

Run: `pnpm exec tsc --noEmit`

Expected: silent success.

### Step 3.6 — Commit

- [ ] **Step 3.6**: Commit.

```bash
git add src/pipeline/approval-summary/spec.ts src/__tests__/unit/spec-summary-builder.test.ts
git commit -m "feat(approval-summary): IM 摘要 low confidence 插一行 🔴 提示

confidenceLevel='low' 时在 title 下、hint 上方插入 '🔴 低自信，需细审'。
high/medium 不插以保 ≤250 字预算；当前 5 行约 100 字，加 1 行裕量足。

Closes AC-6/7/8 (docs/superpowers/specs/2026-05-12-spec-low-confidence-signal-design.md)"
```

---

## Task 4: 收尾验证

**Files:** none (verification only)

### Step 4.1 — Re-run full relevant test set

- [ ] **Step 4.1**: Run all summary tests + dispatch tests to catch any cross-file regression.

Run: `CI=true npx vitest run src/__tests__/unit/spec-summary-builder.test.ts src/__tests__/unit/human-gate-summary-dispatch.test.ts src/__tests__/unit/qi-approval-manager.test.ts`

Expected: all pass.

### Step 4.2 — Full backend typecheck

- [ ] **Step 4.2**: Run.

Run: `pnpm exec tsc --noEmit`

Expected: silent.

### Step 4.3 — Manual smoke

- [ ] **Step 4.3**: 手动验证 — 不强制（用户自行决定）：在管理后台触发一个新需求到 spec_human_gate，确认决策弹窗：
  - 当 spec-author 输出 `confidenceLevel: 'low'` 时，第 1 段含 `🔴 **置信度: low**`，hint 行含 `⚠️ LLM 自信度低`
  - 当 spec-author 输出 `confidenceLevel: 'high'` 时，第 1 段含 `🟢 置信度: high`，hint 行含 `看起来可快速批`
  - IM 卡片（如配 approver）body 在 low 时第二行是 `🔴 低自信，需细审`

如生成 spec 实际的 confidenceLevel 不易制造，可跳过此步 — AC 已由 8 个自动测试覆盖。

---

## NoGos（来自 spec §7）

- 不动 [bootstrap.ts](../../../src/quick-impl/bootstrap.ts) 拓扑
- 不扩 [graph-builder.ts](../../../src/pipeline/graph-builder.ts) 的 `condition.kind`
- 不动 [plan.ts](../../../src/pipeline/approval-summary/plan.ts)（plan-author confidenceLevel 留 follow-up）
- 不改 spec-author / spec-reviewer role 文件
