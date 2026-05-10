# Spec 05: Evaluation Harness 与 Regression CI

> 主 PRD：[prd-quick-impl-roles-v2.md](../prd-quick-impl-roles-v2.md)
> 关联：[04-prompt-strategy.md](04-prompt-strategy.md)（A/B 对照需求）· [01-roles.md](01-roles.md)（每个 role 的 DoD 是评测维度的来源）

本文定义评测脚本结构 / 主观打分流程 / regression CI 三层模式。

实现 Phase 0（baseline）和 Phase 3（v2 对比）按本文执行；Phase 5 接入 CI。

---

## 1. Phase 0 baseline 设计

### 1.1 baseline case

用 [docs/test-specs/login-remember-me.md](../../test-specs/login-remember-me.md)：
- **rawInput**：`"给登录页加记住密码 checkbox：勾选后下次访问自动回填用户名（不存密码）"`
- 已有完整人工 spec（7 个 scenario），可作为 v2 spec-author 输出的对照参考

### 1.2 评测脚本结构

新建 `scripts/qi-eval.ts`：

```typescript
// 不走完整 pipeline（避免人审等待），直接调 runSkill()
async function evalRole(roleName: string, mode: 'v1' | 'v2-compact' | 'v2-full') {
  // 1. 准备 .qi-context（按 mode 决定 standards / inputs）
  // 2. 调 runSkill()
  // 3. 解析 ClaudeRunner JSON 输出
  // 4. 跑校验 + 打分
  // 5. 返回结果对象
}

// 主流程
async function main() {
  const results = {
    'spec-author': {
      v1: await evalRole('spec-author', 'v1'),
      v2_compact: await evalRole('spec-author', 'v2-compact'),
      v2_full: await evalRole('spec-author', 'v2-full'),
    },
    // ... 4 个 role
  };
  await writeReport('docs/qi-eval-{date}.md', results);
}
```

### 1.3 评测维度

#### 结构化校验（自动）

- **JSON schema 校验**（zod）：每个 role 输出 schema 详见 [01-roles.md](01-roles.md)
- **artifact 一致性校验**：
  - spec.md 第 4 节 AC 数量 == JSON `acceptanceCriteria[]` 数量
  - plan.md 任务编号列表 == JSON `tasks[]` id 列表（一一对应）
- **manifest 三方一致校验**：详见 [02-data-flow.md](02-data-flow.md) §4 CI 单测

#### 主观打分（5 项 × 1-5 分）

| 维度 | 看什么 | 1 分 | 5 分 |
|------|--------|------|------|
| 清晰度 | spec / plan 是否容易读懂 | 大量术语堆砌 / 表意模糊 | 段落分明 / 术语解释 |
| 完整性 | 章节 / 字段是否齐全 | 缺关键章节（验收标准 / 风险）| 9 章节齐全 + 结构化字段全填 |
| 可测性 | AC 是否可执行 / 任务是否可验证 | "系统应该高性能" | Given-When-Then + 具体阈值 |
| 与代码契合度 | references 是否准确 | 完全不引代码 | 引 ≥3 处现有 file:line + 解释 |
| 风险揭示 | 是否识别非显而易见的坑 | "无明显风险" | 列具体边界 / 安全 / 性能风险 |

总分 25。基线（v1）一般 8-12 分；v2 目标 ≥ 16 分（提升 ≥ 30%）。

---

## 2. 主观打分由谁打

### Phase 0 baseline + Phase 3 v2 对比

**用户自己打**（数据小、能容忍偏见、责任明确）。

### 后续 regression（Phase 5+）

**LLM-as-judge**：Claude Sonnet 4.6 跑专门的 judge prompt，rubric 与上面 5 项打分一致。

新建 `scripts/qi-eval-judge-prompt.md`：

```markdown
# Judge Prompt: Quick-Impl Role Output Evaluator

你是 quick-impl-artifact-author 输出的质量评估者。给定一个 role 的 input + output，按 5 项维度打分（1-5）。

## 输入

- role: "spec-author" | "plan-decomposer" | "dev-loop" | "code-quality-reviewer"
- input: 该 role 的 inputs.json
- output: ClaudeRunner 解析后的完整 JSON 输出
- artifactContent: 如有 artifact_path（spec.md / plan.md），包含其内容

## 任务

针对 5 项维度逐项评分：
1. 清晰度（1-5）
2. 完整性（1-5）
3. 可测性（1-5）
4. 与代码契合度（1-5）
5. 风险揭示（1-5）

每项给：
- 分数
- 简短理由（≤2 句）
- 关键证据（file:line / JSON 字段 / spec 章节）

## 输出 JSON schema

{
  "scores": {
    "clarity": {"score": 4, "reason": "...", "evidence": "..."},
    "completeness": {...},
    "testability": {...},
    "codeAlignment": {...},
    "riskInsight": {...}
  },
  "totalScore": 18,
  "summary": "一句话总结"
}
```

**校准**：用人工打分对照 LLM-as-judge 抽查 10%（前期）。如果差异 > 1 分则调整 judge prompt。

---

## 3. 评测时机

| 时机 | 跑什么 | 谁触发 |
|------|--------|--------|
| Phase 0 baseline | 不动 role.md，跑 v1 | 手工 |
| Phase 3 v2 对比 | v2 + manifest 精准注入 | 手工 |
| Phase 3 A/B 对照 | v2-compact vs v2-full | 手工 |
| Phase 3 触发式 S7 | S7 启用后再跑一次 | 手工，按需 |
| Phase 5+ regression | 详见 §4 CI 三层模式 | CI |

---

## 4. Regression CI 三层模式

防止后续维护 role.md / standards / manifest 时静默回退。**单次 LLM 评测分数有 ±0.3 分随机噪声**，靠单次结果 block PR 会高 false positive，所以分三层。

### 4.1 触发文件

- `.claude/skills/quick-impl-artifact-author/**`
- `docs/standards/**`
- `scripts/qi-eval*.{ts,md}`

### 4.2 三层模式

| 触发时机 | 跑什么 | 阻塞行为 | 噪声处理 |
|---------|--------|---------|---------|
| **per-PR**（仅触发文件改动时）| zod schema 校验 + manifest 三方一致 + 单次 LLM-as-judge（≤5 min）| 分数低于 baseline - 0.5：**评论提醒，不 block** | 单次跑，仅作 early signal |
| **nightly**（cron 每日 02:00）| 同 case × 3 次取平均 + LLM-as-judge | 平均分低于 baseline - 0.5：**自动开回退 PR**（revert 触发 commit）+ 通知 owner | 3 次平均消除大部分随机性 |
| **周报**（每周一）| 滚动 baseline 趋势图 + 历史 7 天平均 | 连续 7 天下滑 ≥ 1 分：人工介入 | 长周期趋势防止单次劣化锁死 |

### 4.3 rolling baseline

每次 nightly 通过的平均分写入 `docs/qi-eval-baseline.md`，作为下次评测对照。这避免 baseline 一次定死后无法跟随产品迭代。

格式：

```markdown
# Quick-Impl Eval Rolling Baseline

| Date | spec-author | plan-decomposer | dev-loop | reviewer | Notes |
|------|------------|-----------------|----------|----------|-------|
| 2026-05-08 | 16.5 | 17.2 | 18.0 | 17.5 | Phase 3 baseline |
| 2026-05-15 | 16.8 | 17.0 | 18.2 | 17.6 | nightly avg |
| ... | | | | | |
```

每次跑 nightly 自动 append 一行。

### 4.4 实现路径

- **Phase 3 后短期**：手动跑 + PR 模板加 checkbox "已跑 qi-eval 且分数不低于 baseline"
- **Phase 5**：CI job
  - `qi-eval-regression-pr`（per-PR）
  - `qi-eval-regression-nightly`（cron 02:00）
  - `qi-eval-weekly-trend`（cron 周一 09:00）
- **配置文件**：`.gitlab-ci.yml` 新增 stage `qi-eval`

### 4.5 报告归档

每次评测落 `docs/qi-eval-{type}-{date}.md`：
- type: `baseline` / `v2` / `nightly` / `weekly`
- 报告内容：5 项打分 + 输出 JSON snapshot + 与上次对比 diff

PR 描述里 link 当次报告。

---

## 5. Phase 0 / Phase 3 evaluation 必须人工跑

**这是硬约束**：

- Phase 0 baseline：人工跑、人工打分、归档报告
- Phase 3 v2 对比 + A/B 对照：人工跑、人工打分、归档报告
- 报告作为 v2 上线的决策证据

**理由**：
- 前期 LLM-as-judge 还没校准，人工打分作为 ground truth
- v2 上线是大事，不能让 CI 单方面决定
- 人工归档强迫 owner 看一眼、签字

Phase 5 后 CI 才接管 regression，前期不依赖。
