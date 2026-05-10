# Skill Reviewer 设计标准（v1）

> 适用范围：所有 quick-impl skill 中充当"审查者"角色的 role（如 plan-reviewer、code-quality-reviewer、未来的 e2e-reviewer 等），以及 pipeline bootstrap 中涉及 skill_with_review / skill_with_approval 的节点配置。
>
> 参考实现：`.claude/skills/quick-impl-artifact-author/roles/plan-reviewer.md`（v1，2026-05-09）

---

## 模式 1：Reviewer 双源输入（Artifact-Dual-Input）

**规则**：凡 generator 同时产出 JSON 输出 + 文件（.md / .yaml / .sql），reviewer **必须双源读取**，不能只信 JSON。

**理由**：JSON 里的结构数据（tasks[]、decisions[]）是 generator 的自我申报，markdown 文件是人工和下游节点实际消费的产物。两者可能不一致：
- JSON tasks 说有 5 个任务，plan.md 里只写了 4 个（P5 检查）
- JSON 说 §1 有调研，plan.md 里该段落只有空占位（P4 检查）

**实现方式**：

```
输入来源（inputs.json）：
  inputs.devOutput   → generator 完整 JSON 输出
  artifact_path      → 文件绝对路径（直接 Read）
```

reviewer 步骤里，必须同时执行：
1. 从 `inputs.devOutput` 读结构化字段
2. 用 Read 工具读 `artifact_path` 全文

**反例**：只看 `devOutput.tasks[].coverAC` 判断 AC 覆盖率，不读 plan.md——这样会漏掉文件内容与 JSON 的不一致。

---

## 模式 2：specCoverage[] 结构化覆盖证据

**规则**：凡涉及"X 覆盖 Y"的审查（plan 覆盖 spec AC、code 覆盖 plan task），reviewer 输出里**必须有逐条 coverage 数组**，而非仅整体 pass/fail。

**理由**：当 AI review 失败升级到人工节点时，审批人需要看到"哪个 AC 没覆盖、原因是什么"，而不是重读整个 plan/code。specCoverage 是人工决策的核心依据。

**schema**（参考 `SpecCoverageEntrySchema`）：

```typescript
{
  ac: "AC-3",
  covered: false,
  missingReason: "无任何 task 的 coverAC 包含 AC-3"
}
// 或
{
  ac: "AC-1",
  covered: true,
  evidence: [{ file: "docs/plans/qi-7.md" }]
}
```

**要求**：
- specCoverage 数量 == spec.acceptanceCriteria.length（不能漏项）
- `covered: false` 必须有 `missingReason`，不能空置
- `covered: true` 必须有 ≥1 条 evidence（file + 可选 line），不接受"看起来覆盖了"这类无证据判断

---

## 模式 3：检查项 Error vs Warn 分级

**规则**：reviewer checklist 里的每一项必须标 severity，`error` 和 `warn` 有明确的升降判断标准。

**判断方法**：

| 问题 | 答案 → severity |
|------|----------------|
| 这项失败会导致 dev 的工作全部无效吗？ | 是 → **error** |
| 这项失败只是降低质量，不阻断后续工作？ | 是 → **warn** |
| 这项结论能客观验证（数数/正则/集合运算）？ | 是 → 倾向 **error** |
| 这项结论需要主观判断（"内容够不够充实"）？ | 是 → 倾向 **warn** |

**fail 条件（写进 superRefine）**：

```typescript
// 任一 error 检查未通过 → fail
// 或 error 数量 ≥ 2 → fail（多项 error 累积也触发）
const errCount = val.planQualityIssues.filter(i => i.severity === 'error').length
if (errCount >= 2 && val.decision !== 'fail') {
  ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${errCount} error issues but decision is not fail`, path: ['decision'] })
}
```

**反例**：把"decisions[] 质量"设成 error——这是主观判断，设成 warn 即可；把"AC 覆盖缺失"设成 warn——AC 缺覆盖会让 dev 实现错方向，必须是 error。

---

## 模式 4：条件边路由（onFailure: 'continue' + condition edges）

**规则**：AI review 失败后需要路由到人工节点时，使用 `onFailure: 'continue'` + 条件边，而不是 `onFailure: 'stop'`。

**节点配置**：

```typescript
makeNode('plan_review_loop', {
  stageType: 'skill_with_review',
  onFailure: 'continue',   // ← 关键：失败不停止，允许边路由
  params: { ... },
})
```

**边配置**：

```typescript
// AI review 通过 → 进入 dev
{ source: 'plan_review_loop', target: 'dev_with_review_loop', condition: { kind: 'onSuccess' } }

// AI review 失败 → 升级人工
{ source: 'plan_review_loop', target: 'plan_human_escalation', condition: { kind: 'onFailure' } }

// 人工通过 → 进入 dev
{ source: 'plan_human_escalation', target: 'dev_with_review_loop', condition: { kind: 'onSuccess' } }
```

**选择依据**：

| 场景 | 配置 |
|------|------|
| 失败直接终止 pipeline | `onFailure: 'stop'`，无需条件边 |
| 失败路由到另一个节点 | `onFailure: 'continue'` + `condition: { kind: 'onFailure' }` 边 |

**禁止**：不要在 `onFailure` 字段上写节点名（历史遗留写法），用条件边表达路由语义更清晰。

---

## 模式 5：skill 节点 stepOutputs 必须暴露 lastArtifactPath + skillOutput

**规则**：所有产出 artifact 文件的 skill 节点（skill_node / skill_with_review / skill_with_approval），成功时 stepOutputs 里**必须包含 `lastArtifactPath` 和 `skillOutput`**。

**理由**：下游节点通过模板 `{{steps.X.output.lastArtifactPath}}` 引用文件路径，通过 `{{steps.X.output.skillOutput.tasks}}` 引用完整 JSON。缺少这两个字段，下游只能写死路径，无法动态组合。

**graph-builder 实现（skill_with_review 成功分支）**：

```typescript
const extendedDevOutput = parseFencedJsonFromRaw(devResult.rawOutput) ?? devResult.output
return {
  stepOutputs: {
    [nodeId]: {
      status: 'success',
      output: {
        round,
        review: reviewResult.output,
        tasksDone: ...,
        fixRounds: round - 1,
        lastArtifactPath: artifactPath,   // ← 文件绝对路径
        skillOutput: extendedDevOutput,   // ← 完整 JSON（raw 优先，解析 fenced JSON）
      },
    },
  },
}
```

**下游引用示例**：

```typescript
// dev_with_review_loop 引用 plan_review_loop 产出
inputs: {
  planPath:  '{{steps.plan_review_loop.output.lastArtifactPath}}',
  planTasks: '{{steps.plan_review_loop.output.skillOutput.tasks}}',
}
```

---

## 模式 6：priorReviewerNotes 透传到人工升级节点

**规则**：当 AI review 失败升级到人工节点时，**必须把 AI reviewer 的 notes 传给人工节点**，让人工在 AI 失败结论的基础上决策，而不是从零重判。

**配置示例**：

```typescript
makeNode('plan_human_escalation', {
  stageType: 'skill_with_approval',
  params: {
    inputs: {
      priorReviewerNotes: '{{steps.plan_review_loop.output.review.notes}}',
      // ↑ AI reviewer 的 notes[]，包含每条检查失败的具体原因
    },
  },
})
```

**generator（plan-decomposer）接收 priorReviewerNotes 后的行为**：在人工升级轮次里，generator 读取 `priorReviewerNotes` 作为最高优先级修改指令，比 `reviewNotes` 更权威（因为人工已经看过 AI 审查结论，选择了 fix 而非直接通过）。

**反例**：人工升级节点 inputs 里不带任何 AI 审查上下文——审批人看不到 AI 发现了什么，只能靠自己重读 plan，降低了人工升级的价值。

---

## 快速 Checklist（新建 reviewer role 时对照）

- [ ] 输入：同时声明 `devOutput`（JSON）和 `artifact_path`（文件路径，用 Read 读取）
- [ ] 检查项：每项标 severity（error / warn），fail 条件写进 `superRefine`
- [ ] 输出：有 `specCoverage[]`，数量 == spec.acceptanceCriteria.length，covered=false 有 missingReason
- [ ] 输出：有 `planQualityIssues[]`（或同义数组），每项含 checkId + severity + message
- [ ] DoD 自检：角色文档末尾有 checklist，至少包含"10 项全填"和"specCoverage 数量对齐"
- [ ] pipeline 节点：onFailure 配置与条件边一致（stop 或 continue + condition edge，不混用）
- [ ] pipeline 节点：stepOutputs 包含 lastArtifactPath + skillOutput
- [ ] 人工升级节点：inputs 里透传 AI reviewer notes
