# TODO：plan_review_loop / plan_human_escalation 链路重构

> 2026-05-09 测试 run #22 / 需求 #16 暴露的设计问题。本文是给"另起会话"看的自洽 brief，不依赖任何对话上下文。
>
> **配套 PRD**：[prd-plan-human-escalation-decision.md](prd-plan-human-escalation-decision.md) —— 上层产品定义（人审认知任务 / 决策树 / 界面 / 升级路径）；本文聚焦下层 3 个实现 bug（#4/#6/#7）。两份合起来才是完整设计。

## 1. 背景：实测发现的 3 个问题（互相耦合）

QI pipeline 的 plan 阶段链路当前是：

```
stage 2  plan_review_loop          (skill_with_review,  maxRounds=2, onFailure=continue)
            └─ plan-decomposer × N → plan-reviewer × N → 都不过 → max_rounds_exceeded
                                                                      ↓
stage 3  plan_human_escalation     (skill_with_approval, maxRounds=3, onFailure=stop)
            └─ plan-decomposer 再跑一次（带 priorReviewerNotes） → 通知人审 → 人决策
```

实测出 3 个不该混在一起的 bug：

### 问题 #4 — `plan_human_escalation` 设计错：先跑 skill 再通知

**现象**：stage 2 失败后，stage 3 不是直接通知人审，而是**又调一次 plan-decomposer 让 AI 再修一版**，再通知。流程慢（~3 分钟空等），且：

- 用户看到的是 **AI 重写后的 plan**，不是被 AI reviewer 拒掉的那一版
- AI reviewer 拒绝的具体原因丢失（用户看不到）
- "再修一版"自身没意义（见问题 #6 / #7：根本拿不到反馈）

**用户期望的逻辑**：
```
stage 3 round 1：不跑 skill，直接通知。Body 含：
                  - 当前 plan.md（stage 2 最后一轮 plan-decomposer 提交的那版，AI 拒了的）
                  - AI reviewer 的拒绝 notes（让人看懂为啥被否）
              人决策：
                  ✅ approved → 进 dev
                  ❌ rejected + 反馈 → round 2 才调 plan-decomposer，feedback = AI notes + 人类 reject reason
              超 maxRounds → stage failed
```

**实现选项**（任选其一，都需要新逻辑）：
- A. `skill_with_approval` 加 `skipFirstSkill: true` flag —— round 1 跳过 skill，直接 createWaiter；round 2+ 才跑 skill
- B. 新建节点类型 `human_approval_with_skill_loop`（"先通知，拒后再跑 skill"语义）
- C. 改造 stage 3 stageType 为新类型，配合 graph-builder 加新 builder 函数

推荐 **A**：改动最小，可复用到 spec_human_escalation / dev_human_escalation 等同类场景。

**需改文件**（粗估）：
- `src/pipeline/graph-builder.ts:buildSkillWithApprovalNode` —— for 循环 round 1 内加分支：`if (params.skipFirstSkill && round === 1) { 不跑 skill，直接构造 contextSummary 走 createWaiter }`
- `src/quick-impl/bootstrap.ts:plan_human_escalation 节点配置` —— 加 `skipFirstSkill: true`
- `src/pipeline/types.ts` —— `SkillWithApprovalParams` 加 `skipFirstSkill?: boolean`

### 问题 #6 — `skill_with_review` 失败 path 不持久化 reviewer notes

**现象**：[graph-builder.ts:1765-1893](../../src/pipeline/graph-builder.ts#L1765) 里 reviewer 的拒绝原因只活在循环内的局部变量 `reviewNotes`，**只在 success path 写入 stepOutputs**：

```ts
// 1864-1875: 只在 success path 写
stepOutputs: {
  [nodeId]: { output: { review: reviewResult.output, ... } }
}

// 1885-1893: failed path（max_rounds_exceeded）—— 啥都不写
return { stageResults: finishedResult({ ... failed ... }) }
```

→ stage 失败时所有轮的 reviewer notes 都丢了。

**修复方向**：失败 path 也写 stepOutputs，含 last `review` + 全部 `reviewHistory[]`：

```ts
stepOutputs: {
  [nodeId]: {
    status: 'failed' as const,
    output: {
      review: lastReviewResult.output,        // 最后一轮 reviewer 输出（拒绝原因）
      reviewHistory: allReviewResults,        // 全部轮的 reviewer 输出（按 round 排）
      tasksDone: lastDevResult.output.tasksDone ?? [],
      lastArtifactPath: artifactPath,
      lastDevSkillOutput: extendedLastDevOutput,
      maxRoundsExceeded: true,
    }
  }
}
```

**需改文件**：
- `src/pipeline/graph-builder.ts:buildSkillWithReviewNode` failed path（~1885 行）
- `src/__tests__/integration/` 加 `skill-with-review-failed-stepoutputs.test.ts` 验证 failed path 也产 stepOutputs

### 问题 #7 — `plan_human_escalation.priorReviewerNotes` 永远空

**现象**：节点配置 ([bootstrap.ts](../../src/quick-impl/bootstrap.ts) 搜 `plan_human_escalation`)：

```yaml
priorReviewerNotes: "{{steps.plan_review_loop.output.review.notes}}"
```

但 `plan_review_loop` 失败时 `stepOutputs.plan_review_loop` 不存在（见问题 #6），所以模板渲染成 undefined → plan-decomposer 在 stage 3 拿到空字符串 → **裸跑**，根本没基于 reviewer 反馈修订。

依赖 #6 修完后，这条自动修复（stepOutputs.review.notes 真有值了）。

但即使 #6 修了，配合 #4 的实现 A（skipFirstSkill）后，stage 3 round 1 不再跑 plan-decomposer，所以 priorReviewerNotes 在 round 1 不会被消费。它仅在 round 2+（人拒绝后再跑 skill）才有用，且届时 feedback 包含 AI notes + 人类 reject reason 两路反馈合并。

## 2. 三个问题的耦合关系

```
#6 修了                     →  #7 自动好（priorReviewerNotes 不再空）
#4 重设计 (skipFirstSkill)  →  停止"先跑 skill 再通知"的浪费
#4 + #6 + #7 一起做         →  stage 3 通知体含 AI 拒绝原因（来自修好的 stepOutputs）
                              →  人审拒绝时 plan-decomposer 拿到 AI notes + 人 reason 真改 plan
```

三个一起做才完整，单做任一个收益有限。

## 3. 建议的实现顺序

| Step | 任务 | 验收 |
|---|---|---|
| 1 | 修 #6：`skill_with_review` failed path 写 stepOutputs（含 reviewHistory[]） | failed run 的 LangGraph 状态里 `stepOutputs.<nodeId>.output.review.notes` 非空；加 1 个集成测 |
| 2 | 改造 stage 3 通知体：把 `steps.plan_review_loop.output.review.notes` 拼进 contextSummary（plan kind 当前是 `readFileSync(plan.md)`，要扩展） | 钉钉/Modal 通知体顶部多一段"AI Reviewer 拒绝原因"；改 [graph-builder.ts:1429-1432](../../src/pipeline/graph-builder.ts#L1429) plan kind 分支 |
| 3 | 修 #4：`SkillWithApprovalParams` 加 `skipFirstSkill?: boolean`；`buildSkillWithApprovalNode` round 1 内分支跳过 skill 直接 createWaiter | round 1 通知秒到（不再等 plan-decomposer）；round 2+ 拒绝后才跑 skill；加 2 个集成测（first-skip / second-runs-skill） |
| 4 | bootstrap.ts 给 plan_human_escalation 加 `skipFirstSkill: true` | 默认走新行为 |
| 5 | 写 plan v3 摘要 builder（同 spec v3）：`src/pipeline/approval-summary/plan.ts`；通知体 5 段：当前 plan 概览 / 上轮 AI 否决理由 / 任务列表 / 风险 / 折叠区原文 | 钉钉精简版 ≤ 250 字；Web 版 5 段 + 折叠 |

## 4. 需要先确认的设计点（开会讨论）

1. **skipFirstSkill 是否泛化为通用 flag**：spec_human_escalation / dev_human_escalation 以后是否都用？还是只给 plan？
2. **AI Reviewer notes 在通知体里的位置 / 长度**：放最顶？放 details 折叠？字符上限？
3. **rejected 后 round 2 是否仍调 skill**：还是说"维持人审 maxRounds 次都不再跑 skill"（更纯人工模式）？
4. **maxRounds 语义重新定义**：当前 plan_human_escalation `maxRounds=3` 含义不明（是 skill 跑 3 次还是人审 3 次？skipFirstSkill 后变成"人审 3 次 + skill 跑 2 次"？）
5. **plan kind v3 摘要要不要做**：跟 spec v3 摘要平级；不做则 stage 3 通知体仍是 plan.md 全文
6. **plan-reviewer 拒绝原因**："notes 数组" 全展开 vs 只展前 3 条 + 计数；severity 排序

## 5. 测试矩阵建议

跟 spec v3 一样要补集成测，覆盖整条 wiring（这是本次测试暴露的根本痛点：单测有，wiring 没人验）：

| 场景 | 验收点 |
|---|---|
| stage 2 plan_review_loop 失败 | stepOutputs.<nodeId>.output.review.notes 有值；reviewHistory.length === 2 |
| stage 3 round 1 进入 | waiter.context_summary 含 "AI Reviewer 拒绝原因" 段 + plan.md 内容；**未触发 plan-decomposer 重跑**（看 .qi-context/inputs.json mtime 不变 / 没新 commit） |
| stage 3 round 1 approved | pipeline 进 dev_with_review_loop；run 状态 success |
| stage 3 round 1 rejected + 反馈 | round 2 plan-decomposer 跑，inputs 含 AI notes + 人类 reject reason；新 plan.md commit |
| stage 3 maxRounds 用尽 | run 状态 failed，error 含具体最后一轮 reject reason |

## 6. 当前已修的相邻 bug（参考，避免重复）

本次会话已修：
- **#1 spec 摘要 wiring**（`s.name===nodeId` → `currentSkillOutput`）：[graph-builder.ts:1444-1448](../../src/pipeline/graph-builder.ts#L1444)
- **#2 Final Approval e2e 字段**（`e2e_stub` → `qi_e2e_runner`，`.status` → `.result/.skipped/...`）：[graph-builder.ts:1424](../../src/pipeline/graph-builder.ts#L1424) + [final.ts](../../src/pipeline/approval-summary/final.ts)
- **#3 run 终态 onFailure: continue**：[graph-runner.ts:summarizeStatus](../../src/pipeline/graph-runner.ts#L539)
- **#5 spec / plan commit message 太泛**：[spec-author.md](../../.claude/skills/quick-impl-artifact-author/roles/spec-author.md) §4 + [plan-decomposer.md](../../.claude/skills/quick-impl-artifact-author/roles/plan-decomposer.md) §6

这 4 个跟本 TODO 的 #4/#6/#7 不冲突。

## 7. 启动会话时的输入示例

> 我要按 docs/prds/todo-plan-escalation-redesign.md 改 plan_human_escalation 链路。先按 §3 顺序做 step 1（#6 失败 path 写 stepOutputs），写完 + 加集成测 + 跑 test.sh + commit，再继续 step 2。

或先看 §4 那 6 个待确认点逐项确认设计后再动手。
