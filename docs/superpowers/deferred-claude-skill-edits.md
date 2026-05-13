# Deferred .claude/ Skill Edits

> .claude/ 在 .gitignore 里，worktree 不带这些文件。本文档跟踪所有需要 **merge 回 main 后**在主仓库手动 sync 的 role.md / role-manifest.json 改动。

**主仓库路径**: `/Users/zhangshanshan/AI-ChatOps/.claude/skills/quick-impl-artifact-author/`

---

## 来自 T10 (spec-reviewer round 2+ tracking)

文件：`roles/spec-reviewer.md`

### 修订 1: S1 措辞改 enrichedInput

找到 "7 项检查" 表的 S1 行，把：
> S1: 每个 AC 反向链接 rawInput 中可识别的需求点

改为：
> S1: 每个 AC 反向链接 enrichedInput.objective 或 enrichedInput.scope.in 中的可识别需求点（rawInput 仅作冗余兜底，brainstorm failed 退化路径时使用） ← qi-spec-quality.md §3 兜底

### 修订 2: S3 加 degraded=true 收紧

S3 行末追加：
> 若 `devOutput.degraded === true`，则 `clarifications[]` 中 `kind=assumption` 项必须**逐一覆盖** `devOutput.missingFields` 的每一条；缺一即 S3 fail。 ← qi-spec-quality.md §1 / §2 兜底

### 修订 3: S2 / S4-S7 §X 尾标

每条末尾加引用：
- S2 ... ← qi-spec-quality.md §3 兜底
- S4 ... ← qi-spec-quality.md §1 (noGos) / §6 兜底
- S5 ... ← qi-spec-quality.md §1 (reviewHints) 兜底
- S6 ... ← qi-spec-quality.md §1 (risks) / §6 兜底
- S7 ... ← qi-spec-quality.md §5 兜底

### 修订 4: 新增 "## Round 2+ 逐项追踪" 章节（DoD checklist 之前）

```markdown
## Round 2+ 逐项追踪

`round >= 2` 时 reviewer **必须**读 `inputs.previousReviewNotes` 数组（即上一轮你给出的 notes），对每条做以下三选一判定，结果填入 `resolvedFromPrevious[]`：

- `resolved`：作者已采纳反馈，给出具体改动证据（如 "改为 status=201 断言"）
- `still-failing`：作者未改 / 改错方向 / 改不到位
- `not-applicable`：上轮反馈本身有误 / 不适用本轮 spec

输出 schema：

\```json
{
  "round": 2,
  "decision": "pass" | "fail",
  "resolvedFromPrevious": [
    { "previousNote": "AC-3 主观词", "status": "resolved", "evidence": "改为 status=201 断言" },
    { "previousNote": "reviewHints 空", "status": "still-failing", "evidence": "本轮 reviewHints 仍为空" }
  ],
  "newIssues": [/* 本轮新发现，应接近空 */],
  "decisionBasis": "上轮 5 项中 4 项 resolved、1 项 still-failing。新发现 0 项。fail。"
}
\```

**重要**：本轮 `newIssues` **应该接近空**。如果你大量发现"新问题"且与上轮 notes 重叠不大，说明你**标准漂移**——会被 lint 标 warn。
```

### 修订 5: 新增 "## warn 规则"

在 "fail 条件" 后加：

```markdown
## warn 规则（不阻断但写入 notes）

- 若 `round >= 2` 且 `newIssues.length > resolvedFromPrevious.length`，输出一条 `{ severity: 'warn', msg: 'reviewer 标准漂移嫌疑 - 新发现 > 已解决' }`。lint 自动检测并注入（见 buildLlmReviewNode），无需 reviewer 自己标。
```

---

## 后续待添加（执行 T13 / T16 时记录）

- [ ] T13: spec-author.md 升级 (3 状态分支 + degraded 信号 + E2E 章节迁出)
- [ ] T13: role-manifest.json 加 spec-author/reviewer inputs 扩展 + 注册 brainstorm-host
- [ ] T16: 新建 brainstorm-host.md
- [ ] SKILL.md: 加 enrichedInput 输入说明

---

## Sync 时机

在 worktree merge 回 main **之后**，在 `/Users/zhangshanshan/AI-ChatOps/` 主仓库直接 Edit 上述文件。注意 `.claude/` 改动**不会进 git commit history**——这是项目本身的设计选择（CLAUDE.md 没有说要追踪 skills 配置）。

---

## 非 .claude/ 类 deferred work

虽然不属于 `.claude/` skill 改动，但同样是 plan 没覆盖、本 implementation 不实现的 follow-up：

### Token usage 写入侧（从 T11 review 发现）

T11 (commit 05e6267) 实现了 budget gate：从 `pipeline_run_state.data.token_total` SUM 拿累计 token，超 budget 跳过 AI review。但 **plan 里没有任何 task 实施"LLM 节点跑完写入 token_total"**。当前 gate 因为 `getCumulativeTokenUsage` 永远返回 0，**实际不生效**。

修法（merge 后另开 follow-up PR）：
- 在 `buildLlmAuthorNode` / `buildLlmReviewNode` / `buildLlmBrainstormNode`（T20 加）的 LLM call 之后：
  ```typescript
  await pool.query(
    `INSERT INTO pipeline_run_state(pipeline_run_id, data) VALUES ($1, $2::jsonb)`,
    [runId, JSON.stringify({ node_id: nodeId, token_total: result.tokenUsage?.total ?? 0 })],
  )
  ```
- Porygon (skill runner) 返回值需要 surface `tokenUsage.total`（参考现有 LLM call 框架）
- 加单测验证"超 budget 时 gate 真生效"

scope：1-2 task，约 1 天工程量。可作为 Phase 2。

