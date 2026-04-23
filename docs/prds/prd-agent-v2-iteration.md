# PRD Agent V2.0 MVP 迭代设计

> 版本: v2.0-mvp
>
> 文档目的: 在 V1.0 / V1.1 基础上，用**最小必要改动**解决"生成 vs 审查规则不对称"这一核心问题。不包含多视角审查、验收摘要等更大改造——这些留到 V2.1+，依赖 V2.0 的数据决定。
>
> 适用读者: 开发者、后续 Agent 开发者。
>
> 依赖: [prd-agent-design.md](./prd-agent-design.md) V1 架构。本文档不重复 V1 内容。
>
> 核心承诺: **只做一件事** —— 把规则变成单一来源，让生成和审查使用同一份规则，并通过工具契约在保存时拦截 60% 以上的机械错误。

---

## 1. 为什么只做 MVP

更大的改造方案（4 Pass 审查、验收摘要、代码读取能力）讨论过后，识别出几个严重风险：

| 风险 | 后果 |
|------|------|
| 一次性上线范围过大，无灰度 | V2 比 V1 差时无法回退 |
| 没有 V1 的 baseline 数据 | 所有"改善"都是自证 |
| 用户视角 Pass 的 prompt 可行性未验证 | 可能引入大量噪声 findings |
| 结构化过度伤害 PRD 叙事性 | 产出变成"SQL 结果的 markdown 版"，PM 反感 |
| 4 Pass 延迟和成本未实测 | 上线后可能被 infra / 财务找上门 |

结论：**先做一件小事，拿数据说话**，再决定后面改什么。

V2.0 MVP 的唯一假设：**只要规则是单一来源 + save 时机械校验，审查反复问题会显著缓解**。这个假设不成立，后续更大改造都没意义。

---

## 2. V2.0 范围

### 2.1 一期做

1. **规则库单一来源**（`src/agent/prd/rules.ts`）：把现有 9 维审查 + 生成约束合并到一个规则文件，两处 prompt 动态渲染
2. **save_prd 结构化入参**：新增结构化字段（不替代 markdown，**双签名并存**），服务端机械校验
3. **Renderer 模板渲染**：从结构化字段生成 markdown，作为参考产物
4. **机械校验层**：在 save_prd 入口拦截来源缺失、枚举错误、5W 不全、破坏性变更无迁移策略等问题
5. **审查输出契约硬化**：Review 产出从"LLM 自由文本 + JSON 解析"改为 MCP 工具调用 `submit_review`，消除 JSON 解析失败这一类问题；附带 `dimension` 字段改为 `ruleId`（消除 prompt 与 rules.ts 飘移），以及保守的解析重试兜底（见 §7.4）

### 2.2 一期明确不做

- 审查流程结构改造（保留 V1 单次 9 维审查的**整体结构**，只改输出契约）
- 4 Pass 审查（延后到 V2.1，待 V2.0 数据支持）
- 验收摘要（Verification Digest）
- `search_codebase` 工具
- Phase 2 "7 组必问"的完整落地（V2.0 只在 rules.ts 里先占位，不强制）
- IM 交互式卡片
- Agent 对话流程的任何改动（Phase 1-4 完全保留 V1 行为）

### 2.3 不改的架构承诺

- V1 状态机不变
- V1 的 `prd_documents` 表不改 schema（只扩展 `content_json` 内部约定）
- V1 Markdown 作为最终产物的地位不变
- V1 现有 PRD 不自动升级、不被 V2 规则重审

---

## 3. 前置工作：Baseline 数据采集

**没有 baseline，V2.0 做完无法证明有效**。建议先做 1-2 周的数据采集。

### 3.1 采集口径

| 指标 | 数据来源 | 口径 |
|------|-------------|------|
| 一轮审查即通过率 | `review_history` | 首次 review 即 `status=approved` 占比 |
| 升级人工率 | `prd_documents.status` | `review_blocked` 占所有完成 PRD 比例 |
| 自审总耗时 | `review_history[*]` | 首次 review 到状态转出 reviewing 的时长 |
| 单份 PRD LLM 调用次数 | 需加埋点 | `porygon.run` 次数（create + review + repair）|
| findings 分类分布 | `review_result.findings` | 需先补 `ruleId` 字段；按类型聚合 |

### 3.2 实施

- 管理后台新增"自审质量"页面，展示上述指标的周/月趋势
- 数据不足时 LLM 调用次数可从应用日志事后统计
- **硬下限：至少 10 份完成审查的 PRD**，不强求 2 周自然时间

### 3.3 为什么这一步不能跳

V2.0 上线后，必须用同一口径对比：一轮通过率从 X% 升到 Y% 了吗？升级率变化多少？LLM 成本变化多少？

否则 V2.0 做完只能靠"感觉变好了"——这不是工程态度，更不是汇报口径。

---

## 4. 核心设计 · 规则库（rules.ts）

### 4.1 数据结构

```typescript
// src/agent/prd/rules.ts
export type PrdRuleDimension =
  | 'format' | 'traceability' | 'measurable' | 'impact' | 'consistency' | 'closed_loop'
export type PrdRulePhase = 'discovery' | 'features' | 'scope' | 'draft'
export type PrdRuleSeverity = 'blocker' | 'warning' | 'info'

export interface PrdRule {
  id: string
  dimension: PrdRuleDimension
  severity: PrdRuleSeverity
  autoFix: boolean

  // 同一条规则的三种形态
  dialogueProbe?: string              // Phase 2 追问模板（可空）
  generatorInstruction: string        // Phase 4 生成约束
  reviewerCheck: string               // 审查检查项

  applicablePhases: PrdRulePhase[]

  // 机械校验（可选，用于 save_prd 拦截，零 LLM 开销）
  mechanicalCheck?: (prd: StructuredPrd) => MechanicalError[]

  // 元信息（治理用）
  createdAt: string                   // YYYY-MM-DD
  owner: 'product' | 'tech' | 'both'
}

export const PRD_RULES: PrdRule[] = [ /* 见 §4.2 */ ]
```

### 4.2 初版规则清单（10 条）

V2.0 MVP 只落这 10 条——都是当前 V1 审查已经在挑、但生成端没被告知的**最高 ROI** 批次。

| id | dimension | severity | mechanical | 来源 |
|----|-----------|----------|-----------|------|
| `chapter_complete` | format | blocker | ✓ | V1 D1 |
| `source_traceable` | traceability | blocker | ✓ | V1 D3 |
| `measurable_acceptance` | measurable | blocker | ✓ | V1 D4 |
| `no_soft_language` | measurable | warning | ✓ | V1 D4 |
| `no_impl_leak` | format | warning | ✗ | V1 D5 |
| `scope_consistent` | consistency | blocker | ✓ | V1 D6 |
| `no_contradiction` | consistency | blocker | ✗ | V1 D7 |
| `impact_enum` | impact | blocker | ✓ | V1 D9 |
| `breaking_change_detail` | impact | blocker | ✓ | V1 D9 |
| `closed_loop` | closed_loop | blocker | ✓ | **V2 新增** |

前 9 条是把 V1 已有的 9 维审查规则机械化；`closed_loop`（5W 闭环）是 V2 新增，用于解决"驳回按钮定义了但后续没写"这类不闭环问题。

`closed_loop` 的机械校验实现示意：

```typescript
function validate5W(prd: StructuredPrd): MechanicalError[] {
  const errors: MechanicalError[] = []
  for (const req of prd.functionalRequirements ?? []) {
    for (const action of req.actions ?? []) {
      const missing = ['trigger', 'stateChange', 'notify', 'nextActor', 'terminalState']
        .filter(f => !action[f as keyof typeof action])
      if (missing.length > 0) {
        errors.push({
          ruleId: 'closed_loop',
          field: `functionalRequirements[${req.id}].actions[${action.verb}]`,
          message: `动作"${action.verb}"缺少 5W 字段: ${missing.join(', ')}`
        })
      }
    }
  }
  return errors
}
```

### 4.3 三处消费点

三处动态渲染 prompt，都从 `PRD_RULES` 读取：

```typescript
// Phase 2 对话（按阶段过滤，且只取有 dialogueProbe 的）
renderDialogueProbes(phase: PrdRulePhase): string

// Phase 4 生成约束
renderGeneratorInstructions(): string

// 审查（V2.0 保留单轮 9 维，但 checks 从 rules.ts 渲染）
renderReviewerChecks(): string
```

**V2.0 最核心的收益**：改 `rules.ts` 里的一条，生成和审查两处 prompt 同步更新。彻底消除当前 `CREATE_PRD_SYSTEM_PROMPT` 和 `REVIEW_PRD_SYSTEM_PROMPT` 两份文件互相飘移的问题。

### 4.4 规则演进机制（避免失控）

- 每条规则必须有 `createdAt` 和 `owner`
- `rules.ts` 变更走 CODEOWNERS：新增 / 修改 / 删除规则需 product + tech 双 review
- 季度 review：统计各规则被触发次数，长期零触发的规则 archive
- **版本化**：V2.0 上线时冻结 `rules-v1` 快照；后续规则变更只影响新 PRD，旧 PRD 继续用创建时的规则版本

---

## 5. save_prd 结构化改造

### 5.1 双签名并存（关键决策）

V2.0 **不废弃** V1 的 `contentMarkdown` 入参。`save_prd` 同时接受两种形态：

```typescript
// V1 签名（保留）
save_prd({ contentMarkdown: string, summary: string })

// V2 新签名（推荐）
save_prd({ structured: StructuredPrd })
```

**向后兼容策略**：

- 传 `structured` → 机械校验 + renderer → 同时写 `content_json.structuredPrd` 和 `content_markdown`
- 传 `contentMarkdown` → 走 V1 路径 → 只写 `content_markdown`，`structuredPrd = null`
- V1 已存在的 PRD：读写保留 V1 行为，不反向升级

这样 V2 上线当天：
- 正在进行的对话（PM 和 Agent 在聊）：Agent 按新 prompt 走，调新签名；老的 save_prd 调用仍可用
- 已保存的 V1 PRD：只读展示正常；PM 修改时 Agent 识别 `structuredPrd == null` 即按 V1 行为

### 5.2 结构化字段定义

保留**自由文本区**，避免结构化过度伤害叙事：

```typescript
interface StructuredPrd {
  meta: { title: string; productLineId: number; pmName?: string }

  goals: {
    vision: string                  // 自由文本（PM 原话 / 叙事）
    oneLineStatement: string        // 一句话（15 字内，Phase 1 就确定，不依赖 LLM 后续总结）
    objectives: string[]
    successMetrics: Array<{ metric: string; target: string; measurement: string }>
  }

  users: {
    primarySegment: string
    narrative?: string              // 自由文本（用户旅程叙事）
    journeys?: UserJourney[]
  }

  functionalRequirements: Array<{
    id: string                      // "3.1"
    name: string
    priority: 'P0' | 'P1' | 'P2'
    description: string             // 自由文本（设计推导 / 权衡）
    source: {                       // 强制（mechanical 校验）
      phase: number
      quote: string
      type: 'user_said' | 'agent_inferred' | 'codebase_fact'
    }
    acceptanceCriteria: string[]    // 每条必须含数字或字段名
    actions?: Array<{               // 可选；有 actions 就必须完整 5W
      verb: string
      trigger: string
      stateChange: string
      notify: string
      nextActor: string
      terminalState: string
    }>
  }>

  impacts: Array<{
    module: string
    type: '行为变更' | '接口变更' | '数据结构变更' | 'UI 变更' | '行为复用' | '性能影响' | '无直接影响'
    compatibility: '完全兼容' | '向后兼容' | '破坏性变更'
    description: string
    source: string
  }>

  breakingChanges: Array<{          // impacts 有破坏性变更则必填
    current: string
    after: string
    affectedParties: string[]
    migrationSteps: string
    rollbackStrategy: string
  }>

  scope: {
    inScope: string[]
    outOfScope: Array<{ item: string; reason: string }>
    tbd: Array<{ item: string; needsInput?: string }>
  }

  decisionLog?: Array<{
    decision: string
    rationale: string               // 自由文本
    alternatives?: string[]
    decidedAt: string
  }>

  narrative?: string                // 全局自由文本，保留 PM 叙事
}
```

**设计原则**：

- 结构化只覆盖**可被机械校验**的字段（source、枚举、5W、验收数字）
- 叙事、推导、权衡、旅程全部作为自由文本
- Renderer 按"骨架（结构化）+ 肉（自由文本）"拼成 markdown，**保留叙事感**

### 5.3 服务端流程

```
Agent 传 structured input
      ↓
mechanicalValidate(input, PRD_RULES)    ← 扫所有 mechanicalCheck
      ↓ 失败 → 返回 errors（含 ruleId + field + message）
              → Agent 收到后必须修正，再 retry save_prd
      ↓ 通过
renderPrdMarkdown(input)                ← 模板渲染
      ↓
persist:
  content_json.structuredPrd = input
  content_json.rulesVersion = 'rules-v1'
  content_markdown = rendered
```

### 5.4 Renderer

新增 `src/agent/prd/renderer.ts`，按 V1 模板结构（9 章节）渲染。模板固定，章节顺序稳定——下游消费零改动。

---

## 6. 机械校验（V2.0 最大 ROI 的改动）

### 6.1 效果

这一层是 V2.0 的核心杠杆。**纯程序，零 LLM 成本**，拦截的典型问题：

| 问题 | V1 现象 | V2.0 后 |
|------|---------|---------|
| 功能需求缺 source | 审查时 blocker，repair 也修不了（信息不在对话里）| save 直接拒绝，Agent 回去问 PM |
| 影响类型写"可能变化" | 审查时 blocker | save 直接拒绝，只接受枚举值 |
| 破坏性变更缺迁移策略 | 审查时 blocker | save 直接拒绝 |
| 动作按钮无下文（不闭环）| V1 根本挑不出来 | save 直接拒绝 |
| 验收标准"提升友好度" | 审查时 warning | save 直接拒绝（需含数字/字段名）|

### 6.2 落地文件

- `src/agent/prd/mechanical-check.ts`：各规则的 mechanicalCheck 函数实现
- `src/agent/tools/save-prd.ts`：入口调用 `mechanicalValidate(input, PRD_RULES)`

---

## 7. Prompt 改造（最小改动）

### 7.1 CREATE_PRD_SYSTEM_PROMPT

基于 `rules.ts` 动态渲染约束，**不改 Phase 1-4 对话结构**。只在 Phase 4 生成 PRD 的段落追加：

```
生成 PRD 时必须通过所有 save_prd 机械校验。具体约束:
${renderGeneratorInstructions()}

任何校验失败，save_prd 会返回 errors 数组；你必须根据 errors 修正后 retry。
```

### 7.2 REVIEW_PRD_SYSTEM_PROMPT

V2.0 保持**单轮审查**的整体流程结构，两处改动：

- **checks 动态渲染**：从硬编码改为 `renderReviewerChecks()` 读 `rules.ts`。规则变更时审查端自动同步
- **输出契约变更**：不再让 LLM 输出 JSON 文本，改为强制调用 MCP 工具 `submit_review`（详见 §7.4）。prompt 里关于 "输出格式 / JSON 结构 / 严格 JSON / 不要尾随逗号" 等约束全部删除，替换为 "审查完成后必须调用 `submit_review` 工具提交结果"
- **dimension 字段改 ruleId**：原 `dimension: 1-9 的整数` 替换为 `ruleId: string`（对应 `rules.ts` 的规则 id，如 `"closed_loop"`、`"source_traceable"`）。避免 "rules.ts 加了第 10 条但 prompt 还写 1-9" 的飘移

### 7.3 REPAIR_PRD_SYSTEM_PROMPT

findings 结构以 `ruleId` 为主键（替代 `dimension`）。Repair prompt 能根据 ruleId 反查 `rules.ts` 的 `generatorInstruction`，知道正确写法。

### 7.4 审查输出契约硬化（防 JSON 解析失败）

**背景**：V1 的 `parsePrdReviewOutput` 对 LLM 自由文本做 `{...}` 抓取 + `JSON.parse` 一次，失败直接升级人工（[src/agent/prd/prd-agent.ts:118-137](src/agent/prd/prd-agent.ts#L118-L137) + [:316-354](src/agent/prd/prd-agent.ts#L316-L354)）。常见失败：尾随逗号 / 注释 `//` / 截断 / 中文引号混入。解析失败是**终态**，比 blocker 更苛刻——一次格式错就打回 PM。

V2.0 既然已经在 `save_prd` 引入"工具契约 + 机械校验"思路，同理顺势把 **review 产出做成 MCP 工具调用**：

```typescript
// src/agent/tools/submit-review.ts（新增）
export const submitReviewTool: AgentTool = {
  name: 'submit_review',
  description: '提交 PRD 自审结果。Review Agent 完成审查后必须调用此工具提交 findings。',
  inputSchema: {
    type: 'object',
    required: ['status', 'findings'],
    properties: {
      status: { enum: ['pass', 'blocked', 'warnings_only'] },
      summary: { type: 'string' },
      findings: {
        type: 'array',
        items: {
          type: 'object',
          required: ['ruleId', 'severity', 'location', 'issue'],
          properties: {
            ruleId: { type: 'string' },         // 对应 rules.ts 的 id
            severity: { enum: ['blocker', 'warning', 'info'] },
            location: { type: 'string' },
            issue: { type: 'string' },
            suggestion: { type: 'string' },
            canAutoFix: { type: 'boolean' },
            autoFixBlockedReason: { type: ['string', 'null'] },
            ownership: { enum: ['pm', 'admin', 'business'] }
          }
        }
      },
      recommendation: {
        type: 'object',
        properties: {
          action: { enum: ['approve', 'approve_with_edits', 'reject'] },
          reason: { type: 'string' },
          confidence: { enum: ['high', 'medium', 'low'] }
        }
      }
    }
  },
  handler: async (input) => { /* 直接返回结构化结果，由 runPrdReview 捕获 */ }
}
```

**调用侧改造**：`runClaudeOnce` 调 review 时 `tools: [submitReviewTool]`，并读取工具调用结果而非返回文本。LLM 不再能返回自由文本作为审查结果——schema 由 MCP 强校验，类型错误 / 枚举错误会直接拒绝，不会污染持久化。

**退路（解析重试）**：即便迁到 tool call，仍保留一层轻兜底——若 Porygon/Claude 某次没调工具、退化为文本输出，发一条 repair：

```
你上次没有调用 submit_review 工具。请只调用一次 submit_review 工具提交审查结果，
不要输出任何自由文本。
```

重试 1 次仍失败才升级人工。比 V1 "一次失败就升级" 的策略经济。

**净效果**：

| 类别 | V1 | V2.0 |
|------|----|----|
| JSON 解析失败终态 | 直接 review_blocked | 消除（schema 由 MCP 强校验） |
| LLM 偶发格式漂移 | 直接升级 | tool call 退化 → 1 次 repair 重试 → 再失败才升级 |
| dimension/ruleId 飘移 | prompt 写死 1-9 | prompt 无枚举，ruleId 由 rules.ts 单一来源 |

---

## 8. 上线策略：Feature Flag + 灰度 + 回退

### 8.1 环境变量控制

在 [src/config.ts](src/config.ts) 新增：

```
PRD_AGENT_V2_MODE = 'off' | 'shadow' | 'on'    // 默认 off
```

- `off`：完全走 V1，不动（跳过整个 AI 自审链路；PRD 保存后直接 `draft`）
- `shadow`：**单轮 V2 观测**——走 V2 的 prompt + `submit_review` 契约跑一轮，findings 入库（供 [PRD 指标](/prd-metrics) 统计），但**无论 blocker 数量多少都强制 `draft`、不进入自修复**。用于在全量切换前观测"V2 审查是否会误杀过多"。
  - 本模式不是 V1/V2 并行跑（做 parallel shim 投入不成正比）；baseline 数据由 `off` 阶段采集。
- `on`：走完整 V2 路径（N 轮自修复 + blocker 升级）。

实现位置：[src/agent/prd/prd-agent.ts](src/agent/prd/prd-agent.ts) 的 `PRD_AGENT_V2_MODE` 分支。

### 8.2 上线节奏

| 阶段 | 时长 | 行为 | 通过标准 |
|------|------|------|---------|
| **Baseline 采集** | 1-2 周 | `off` | ≥ 10 份完成审查的 PRD，baseline 指标可信（通过 [prd_documents.metrics](src/db/schema-v18.sql) 埋点采集）|
| **Shadow 观测** | 1 周 | `shadow` | V2 单轮跑出的 findings 按 ruleId 分布合理（见 [PRD 指标页](web/src/pages/PrdMetricsPage.tsx)），无某条规则误杀率 > 50% |
| **灰度开启** | 1 周 | 10% PRD 走 `on` | 一轮通过率 ≥ V1、升级率 ≤ V1 |
| **全量切换** | 持续 | 全部走 `on` | 持续监控指标 |

### 8.3 回退条件（硬性）

任一达标即回退到 `off`：

- 一轮通过率低于 V1 baseline 的 80%
- 升级人工率高于 V1 baseline 的 120%
- `save_prd` 的错误拒绝率 > 40%（说明 Agent 无法适配新签名）
- PM 反馈 "Renderer 生成的 markdown 读不下去" 占比 > 20%

---

## 9. 数据模型改动

### 9.1 最小改动

- **不加新表**
- `prd_documents.content_json` 的结构约定扩展：

```typescript
{
  phase: ...,
  dialogueRounds: ...,
  contextSummary: ...,

  // V2 新增（V1 PRD 为 null）
  structuredPrd: StructuredPrd | null,
  rulesVersion: string | null         // 生成时规则版本快照 tag
}
```

- `review_result.findings[*]` 结构变更：
  - 新增 `ruleId` 字段（对应 rules.ts 规则 id）——作为新 PRD 的首要键
  - 保留 `dimension` 字段（V1 兼容；V2 PRD 写入时同步填充 `dimension = ruleId`，消费方按需读取）

### 9.2 Schema v8

新增 `src/db/schema-v8.sql`：baseline metrics 相关埋点（可选字段 `metrics JSONB`），不改现有字段定义。幂等：`ALTER TABLE IF`。

---

## 10. 验证方式

| # | 场景 | 验证内容 |
|---|------|---------|
| 1 | 规则单一来源 | 改 rules.ts 中一条的 generatorInstruction → CREATE prompt 渲染同步变化；改 reviewerCheck → REVIEW prompt 同步变化 |
| 2 | save_prd 机械拦截（source 缺失）| 传结构化 input 但某 functionalRequirement.source 为空 → 返回 error，不入库 |
| 3 | save_prd 机械拦截（枚举错误）| impacts.type = "可能变化" → 返回 error |
| 4 | save_prd 机械拦截（5W 不全）| functionalRequirement.actions 有 verb 但 terminalState 空 → 返回 error |
| 5 | Renderer 稳定性 | 同一 structured input 调两次 renderMarkdown → 输出完全相同 |
| 6 | V1 兼容（写） | 传 V1 签名 contentMarkdown → 走 V1 路径正常保存，structuredPrd = null |
| 7 | V1 PRD 读取 | read_prd 对 V1 PRD（无 structuredPrd）→ 正常返回 markdown，前端不崩 |
| 8 | V1 PRD 修改 | V1 PRD 走 Phase 7 修改流程 → Agent 识别无 structuredPrd → 走 V1 修改路径 |
| 9 | Feature flag 回退 | 设 PRD_AGENT_V2_MODE=off → 立即恢复 V1 行为，无需重启 |
| 10 | Shadow 模式 | 设为 shadow → V1 路径正常；后台记录 V2 机械 errors 但不阻塞 |
| 11 | 一轮通过率改善 | 灰度期对比 baseline：一轮通过率应上升 |
| 12 | findings ruleId 聚合 | 能从 review_result 按 ruleId 聚合，输出"哪些规则最常违反"报表 |
| 13 | 审查 tool call 契约 | review Agent 产出一次合法的 `submit_review` 调用 → result 正常写入；不调用任何工具 → 触发 1 次 repair 重试 |
| 14 | 审查 schema 强校验 | 故意让 review 传 `severity: "critical"`（非枚举）→ MCP 拒绝，review 视为解析失败走 repair 重试路径 |
| 15 | 审查重试后仍失败 | 2 次都没调 `submit_review` / 调用参数仍非法 → 升级 `review_blocked`，finding 标注 "自审契约失败（重试 1 次仍无合法 submit_review 调用）" |
| 16 | ruleId 一致性 | rules.ts 新增一条规则后，review 产出的 finding.ruleId 能命中新规则；删除一条规则后，review 不再产出对应 ruleId |

---

## 11. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 结构化过度，叙事感丢失 | 保留 `narrative`/`description`/`rationale` 等自由文本字段；Renderer 按"骨架 + 肉"拼装 |
| Agent 不会填结构化字段，save 失败率高 | Shadow 先观察失败率；Repair prompt 反查 generatorInstruction；双签名并存给 Agent 降级路径 |
| 规则库膨胀 | V2.0 强制只落 10 条；CODEOWNERS 控制增量；季度 review |
| 机械校验误伤 | 10 条规则先跑 shadow，看 error 分布；有争议规则 severity 先设 warning 不 blocker |
| V1 PRD 修改走 V1 路径导致规则不一致 | 已在 §4.4 说明：规则版本化，旧 PRD 锁在创建时的规则版本 |
| Baseline 采集不足 | 硬下限 10 份 PRD；不够延长采集期 |
| Renderer 产出和 Agent 自写 markdown 差异大，PM 困惑 | Shadow 期做 diff 对比；Renderer 模板尽量贴近 V1 Agent 写法 |
| Porygon/Claude 某次不调 `submit_review`，改为自由文本输出 | 退路见 §7.4：一次 repair 提示重试；重试仍失败才升级人工（仍比 V1 "一次失败就升级" 经济） |
| `submit_review` schema 校验过严，常见 LLM 输出被拒绝率高 | Shadow 期统计被拒比率；若 >10%，放宽可选字段 / 补 LLM 示例；必要时降级部分枚举为 warning |

---

## 12. 如果 V2.0 MVP 成功 / 失败

### 12.1 成功的定义

灰度全量切换后 2 周，满足：

- 一轮通过率**相对 V1 提升 ≥ 20%**（绝对值看 baseline）
- 升级人工率**相对 V1 下降 ≥ 20%**
- 单份 PRD LLM 调用次数**不增加**（机械校验不吃 LLM）
- PM 侧无"Renderer 输出读不下去"的负反馈

成功后：启动 V2.1 设计，重点是 4 Pass 审查架构，**基于 V2.0 收集的实际 findings ruleId 分布**来决定 "用户视角"等新 Pass 是否值得做。

### 12.2 失败的定义与下一步

任一回退条件触发：

1. 环境变量切回 `off`，V2 代码保留但不生效
2. 分析失败原因：
   - Agent 无法适配结构化签名 → 回炉 prompt，考虑保留 V1 签名为主路径
   - 机械校验误伤 → 降级规则严重性、修正 mechanicalCheck 逻辑
   - Renderer 产出差 → 模板改造
3. 修正后重回 shadow 阶段
4. 两轮修正仍失败 → 放弃 V2.0 代码化方案，把"规则单一来源"通过纯文档约定实现——**即使如此，baseline 采集价值不变**，可服务于任何后续方案

---

## 13. 实现文件清单

### 新建（7 个）

| 文件 | 用途 |
|------|------|
| `src/agent/prd/rules.ts` | 规则注册中心（初版 10 条）|
| `src/agent/prd/renderer.ts` | structured → markdown 模板渲染 |
| `src/agent/prd/mechanical-check.ts` | 各规则的机械校验函数 |
| `src/agent/prd/structured-types.ts` | StructuredPrd 等类型定义 |
| `src/agent/tools/submit-review.ts` | Review Agent 提交自审结果的 MCP 工具（替代 JSON 文本输出）|
| `src/db/schema-v8.sql` | baseline metrics 埋点 schema |
| `src/admin/routes/prd-metrics.ts` | baseline + V2 指标查询 API |

### 修改（8 个）

| 文件 | 改动 |
|------|------|
| `src/agent/prd/prompts.ts` | CREATE/REVIEW/REPAIR prompt 从 rules.ts 动态渲染；REVIEW 改为要求调用 `submit_review` 工具（不再输出 JSON 文本）；findings 以 `ruleId` 为主键 |
| `src/agent/prd/prd-agent.ts` | 读 PRD_AGENT_V2_MODE flag 路由；review 不再调 `parsePrdReviewOutput`，改为读取 `submit_review` 工具调用结果；新增"未调用工具 / schema 校验失败 → 1 次 repair 重试" 兜底 |
| `src/agent/tools/save-prd.ts` | 双签名支持；机械校验入口；调 renderer |
| `src/agent/tools/read-prd.ts` | 返回结构扩展 structuredPrd（兼容 null）|
| `src/agent/mcp-server.ts` | `import './tools/submit-review.js'`（工具自注册） |
| `src/db/repositories/prd-repo.ts` | content_json.structuredPrd 读写；review_result.findings.ruleId |
| `src/config.ts` | 新增 PRD_AGENT_V2_MODE（Zod 枚举 off / shadow / on）|
| `web/src/pages/PrdDocumentsPage.tsx` | 详情页兼容无 structuredPrd 的 V1 PRD；finding 展示优先用 ruleId |

### 新增前端（1 个）

| 文件 | 用途 |
|------|------|
| `web/src/pages/PrdMetricsPage.tsx` | baseline + V2 指标展示 |

---

## 14. 时间预估

| 阶段 | 预估 | 说明 |
|------|------|------|
| Baseline 采集（埋点 + 等数据）| 1-2 周自然时长 | 埋点开发 2-3 天，其余等数据积累 |
| rules.ts + structured-types.ts | 2-3 天 | 初版 10 条规则 + 类型 |
| mechanical-check.ts | 2-3 天 | 各规则的校验逻辑 |
| renderer.ts | 2-3 天 | 模板对齐 V1 格式 |
| save_prd 改造 + prompt 动态渲染 | 3-4 天 | 双签名 + 兼容测试 |
| Feature flag + shadow 模式 | 1-2 天 | 环境变量路由 |
| `submit_review` 工具 + 审查契约迁移 | 2-3 天 | 工具实现 + prompt 改造 + prd-agent 读工具调用结果 + 重试兜底 |
| 前端兼容 + 指标页 | 2-3 天 | 兼容处理 + metrics 展示 |
| Shadow 运行 + 灰度 | 2-3 周自然时长 | 观察 + 小步放量 |

**开发实际工作量约 2-3 周，含数据等待共 6-8 周**。

---

## 15. 相对 V1 的差异（仅列 V2.0 范围内）

| 维度 | V1 | V2.0 | 改动理由 |
|------|----|----|---------|
| 规则定义 | 两份 prompt 独立 | rules.ts 单一来源 | 消除生成/审查飘移 |
| save_prd 入参 | 只有 contentMarkdown | 双签名，structured 可选 | 兼容 V1；为机械校验铺路 |
| 机械校验 | 无 | save_prd 入口 10 条规则 | 拦截 60% 问题不耗 LLM |
| 闭环校验 | 无 | `closed_loop` 规则 + 5W 字段 | 解决"按钮无下文"类不闭环 |
| findings 主键 | `dimension` (1-9 整数) | `ruleId` (string) | 与 rules.ts 单一来源对齐，消除飘移 |
| 审查输出契约 | LLM 自由文本 → JSON.parse 一次 → 失败直接升级 | MCP 工具 `submit_review` 调用 + schema 强校验 + 1 次 repair 重试兜底 | 消除"自审 JSON 解析失败"这一分类终态 |
| 审查架构 | 单轮 9 维 | 单轮（流程不变，只改输出契约）；4 Pass 延后 V2.1 | 降低 V2.0 风险 |
| PRD 产出 | Markdown | Markdown（Renderer 生成）| 下游消费零改动 |

---

## 16. 对 V2.1+ 的前瞻

V2.0 MVP 达标后，V2.1 可讨论的议题：

- **4 Pass 审查**（专业 / 用户 / 对抗 / 结构）：基于 V2.0 的 findings ruleId 分布判断每个 Pass 的 ROI；尤其"用户视角 Pass"要先跑 prompt 原型验证可行性，不行则砍掉
- **验收摘要（Digest）**：依赖 V2.0 的 structuredPrd，状态转换触发生成；包括"Agent 推断"标记等验收向设计
- **search_codebase 工具**：让 Agent 能验证"现有模块真的长这样吗"
- **7 组 PM 必问的完整落地**：V2.0 只在 rules.ts 占位；V2.1 根据 Phase 2 对话效果决定是否强制
- **preSaveSelfCheck 自检层**：对应前讨论中"三层兜底"的中间层

V2.1 每一项都依赖 V2.0 数据基础，而不是空设想。
