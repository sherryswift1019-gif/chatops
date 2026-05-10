# Spec 02: 数据流与持久化

> 主 PRD：[prd-quick-impl-roles-v2.md](../prd-quick-impl-roles-v2.md)
> 关联：[01-roles.md](01-roles.md)（消费这些数据的 role）· [03-standards.md](03-standards.md)（symlink 内容来源）

本文定义 v2 横切层的所有数据契约和持久化机制：底座契约 / inputs.json / feedback.md / role-manifest / stage_results / 节点级联失效。

实现 Phase 1 时只需读本文 + 03。

---

## 1. SKILL.md 底座契约（升级）

[.claude/skills/quick-impl-artifact-author/SKILL.md](../../../.claude/skills/quick-impl-artifact-author/SKILL.md) 在 v2 新增 4 段：

### 1.1 错误处理

- `.qi-context/` 不存在 / 缺关键文件 → 输出 `decision: "fail"` + notes 说明
- `artifact_path` 不可写 → 同上
- 工具调用 fail（Bash 报错 / Read 文件不存在）→ 重试一次后 fail

### 1.2 previousRound 语义

如果 `inputs.json` 含 `previousRound` 字段或 `.qi-context/feedback.md` 存在：
- **任务步骤第一步必须读取并理解上一轮反馈**
- 修订时**不要重写整个文档/代码**，保留已被认可的部分
- 输出 JSON 的 `evidence` 中说明针对反馈做了什么调整

### 1.3 Standards 引用约定

- 必须读取 `.qi-context/standards/` 下与本 role 相关的文件（manifest 决定 symlink 哪些）
- 输出 JSON 的 `evidence.standardsConsulted[]` 列出实际引用的项
- 没列出 standardsConsulted 视为未引用 → reviewer 标 fail

### 1.4 自检 checklist

- 完成任务前对照本 role 的 DoD checklist 自查（详见 [01-roles.md](01-roles.md) 各 role DoD 节）
- 未通过项写到 `evidence.selfCheck` 中（即使 decision=pass 也要列）

### 1.5 输出 JSON schema 共性（所有 role）

```json
{
  "summary": "一句话描述本次执行结果（必填，≤500字）",
  "decision": "pass" | "fail",
  "notes": [{"severity": "warn"|"error", "msg": "...", "file": "..."}],
  "evidence": {
    "standardsConsulted": ["docs/standards/xxx.md", ...],
    "selfCheck": [{"item": "...", "passed": true|false}]
  }
  // role-specific 字段：详见 01-roles.md
}
```

**这个 JSON block 必须是回复的最后内容**，不能在后面追加任何文字。

---

## 2. inputs.json schema

skill-runner 准备的 `.qi-context/inputs.json`：

```typescript
interface Inputs {
  requirement_id: number;
  worktree_path: string;
  branch: string;
  base_branch: string;
  artifact_path: string;
  retry_counters: Record<string, number>;
  inputs: Record<string, unknown>;  // role-specific，由 role-manifest.json 决定填哪些字段

  // 新增字段（仅在 round > 1 时存在）
  previousRound?: {
    round: number;
    decision: 'rejected' | 'fail';
    rejectReason?: string;          // 人工 reject 时的 reason
    reviewerNotes?: Array<{         // reviewer fail 时的 notes
      severity: 'warn' | 'error';
      msg: string;
      file?: string;
    }>;
    previousArtifactPath?: string;  // 上一轮产出文件路径（spec / plan）
    previousCommits?: string[];     // dev-loop 上一轮的 commit SHA
    acDiff?: {                      // spec 改了 AC 时存在（详见 §6 节点级联失效）
      added: AC[];
      removed: string[];            // AC id 列表
      changed: AC[];
    };
  };
}
```

`inputs.<role-specific-字段>` 由 [role-manifest.json](#4-role-manifestjson) 声明，详见 §4。

---

## 3. .qi-context/feedback.md（多轮反馈自然语言版）

skill-runner 在 round > 1 时除了写 inputs.json，还在 `.qi-context/feedback.md` 写一份 markdown，更适合 Claude 阅读：

```markdown
# 上一轮反馈（Round N-1 → Round N）

## 决策
rejected by 张某某 at 2026-05-08 14:30

## 拒绝原因
> （用户填写的 reject_reason 原文）

## Reviewer 标记
- error: src/foo.ts 没有处理空数组情况
- warn: src/bar.ts 命名不符合现有风格

## 上一轮产出
路径：/path/to/previous/artifact.md
（部分内容 inline，长则只列路径）

## 本轮要求
针对以上反馈修订，不要重写整个文档/代码。保留已被认可的部分。
```

### feedback.md vs inputs.previousRound 双轨道

- inputs.previousRound 是结构化字段（程序消费）
- feedback.md 是自然语言（Claude 消费效果更好）
- skill-runner 同时维护两份，role.md 第一步读 feedback.md（不读 inputs.previousRound）

---

## 4. role-manifest.json（精准注入声明）

**问题背景**：8 篇 standards × 平均 80 行 = 640 行；每个 role 全 symlink 加上 SKILL.md + role.md，单 role 上下文 ~960 行 → Claude 注意力散（详见 [04-prompt-strategy.md](04-prompt-strategy.md)）。

**解决**：在 [.claude/skills/quick-impl-artifact-author/role-manifest.json](../../../.claude/skills/quick-impl-artifact-author/role-manifest.json) 声明每个 role 的 standards 子集 + inputs 字段子集。

```json
{
  "spec-author": {
    "standards": ["frontend-enum-select.md"],
    "inputs": ["rawInput"]
  },
  "plan-decomposer": {
    "standards": ["db-schema-versioning.md", "test-conventions.md", "frontend-enum-select.md"],
    "inputs": ["specPath", "specAcceptanceCriteria"]
  },
  "dev-loop": {
    "standards": ["*"],
    "inputs": ["planPath", "planTasks", "previousCommits"]
  },
  "code-quality-reviewer": {
    "standards": ["*"],
    "inputs": ["specAcceptanceCriteria", "planTasks", "branch"]
  }
}
```

`"*"` 表示全部。

### Standards 分发矩阵（事实来源：role-manifest.json）

| Standards 文件 | spec-author | plan-decomposer | dev-loop | reviewer |
|---|:---:|:---:|:---:|:---:|
| gitlab-config.md | - | - | ✓ | ✓ |
| tool-registration.md | - | - | ✓ | ✓ |
| db-schema-versioning.md | - | ✓ | ✓ | ✓ |
| repository-pattern.md | - | - | ✓ | ✓ |
| frontend-enum-select.md | ✓ | ✓ | ✓ | ✓ |
| commit-conventions.md | - | - | ✓ | ✓ |
| test-conventions.md | - | ✓ | ✓ | ✓ |
| code-style.md | - | - | ✓ | ✓ |
| **本 role symlink 数量** | **1** | **3** | **8** | **8** |

> 注：本表格仅供阅读。事实来源是 role-manifest.json，PRD 不维护重复信息（避免漂移）。CI 单测扫 manifest 自动校验该矩阵。

### Inputs 精准供给

| Role | 必传输入 | 不传 | 理由 |
|------|---------|------|------|
| spec-author | rawInput | 无需 plan / 代码 | 上游就一句话 |
| plan-decomposer | specPath（文件路径） + specAcceptanceCriteria（结构化数组） | 无需 git diff | spec 已生成，AC 蒸馏后给 |
| dev-loop | planPath + planTasks + previousCommits | **不传 spec 全文** | plan 已蒸馏过，给 spec 反而干扰 |
| reviewer | specAcceptanceCriteria + planTasks + branch | **不传 spec/plan 散文** | 看结构化 AC + git diff 就够 |

### skill-runner 实现

1. 启动时读 `role-manifest.json`，**zod schema 校验**（standards 字段值必须存在于 docs/standards/ 真实文件名，否则 fail-fast）
2. `.qi-context/standards/` 目录只 symlink manifest 声明的子集
3. `.qi-context/inputs.json` 的 `inputs` 字段只填 manifest 声明的字段
4. 创建 worktree 时把 `.qi-context/` 加到 worktree 内的 `.gitignore`
5. 加载失败兜底：manifest 文件不存在或解析失败 → 降级到"全 symlink + 全字段"模式 + warning log

### CI 单测覆盖

- manifest zod 校验：standards 值不存在时 fail-fast
- 三方一致测试：扫 docs/standards/ 实际文件 + manifest standards 字段 + role consume 列表

---

## 5. stage_results 持久化层

**问题**：v2 引入大量结构化输出（spec.acceptanceCriteria / plan.tasks / dev.commits），下游节点和 round 2 都需要消费。但 ClaudeRunner stdout 解析的 JSON 当前**只在 graph node 内存**，跨节点 / 跨 round 会丢。

**方案**：复用现有 `test_runs.stage_results` JSONB 字段（**零 schema 变更**），每个 skill 节点完成后由 skill-runner 写入。

### 数据结构（向后兼容，新字段 optional）

```typescript
test_runs.stage_results = {
  [stageIndex: number]: {
    // v1 保留
    status: 'pass' | 'fail',
    summary: string,
    durationMs: number,

    // v2 新增
    artifactPath?: string,
    skillOutput?: {
      // role-specific 字段，spec-author 例：
      acceptanceCriteria?: AC[],
      openQuestions?: string[],
      risks?: Risk[],
      // dev-loop 例：
      commits?: Commit[],
      failedTasks?: TaskRef[],
      // ...（详见 01-roles.md 各 role 输出 schema）
    },
    evidence?: {
      standardsConsulted: string[],
      selfCheck: SelfCheckItem[]
    },

    // 多轮场景：rounds 数组每 round append 一项
    rounds?: Array<{
      round: number,
      // 同上结构
    }>,

    // §6 节点级联失效
    acDiff?: {
      added: AC[],
      removed: string[],
      changed: AC[]
    }
  }
}
```

### 消费路径

- **下游节点（同 run）**：plan-decomposer 节点的 inputs.specAcceptanceCriteria 来自 `stage_results[specStageIdx].skillOutput.acceptanceCriteria`，graph-builder 在节点产出后蒸馏
- **同节点跨 round**：skill_with_approval 循环内部，round N 的 inputs.previousRound.previousCommits 来自 `stage_results[currentStageIdx].rounds[N-1].skillOutput.commits`
- **artifact_path 备份**：spec.md / plan.md 文件本身仍写到 worktree（artifact_path），但 skill-runner 在 worktree cleanup 前把内容 snapshot 到 `requirements.spec_content` / `plan_content`（已有列）

### 膨胀控制（决策：N=2）

`rounds[]` 数组只保留**最近 2 轮**完整结构化输出，更早的 round 仅保留摘要：

```json
{
  "round": 1,
  "decision": "rejected",
  "summary": "已撰写需求规格...",
  "rejectReason": "缺少 localStorage 清除时机说明"
  // skillOutput / evidence 等字段被裁剪
}
```

理由：审批人和 round N 主要消费 round N-1 的反馈，更早的轮次只需可追溯。skill-runner 写入前裁剪。单测覆盖裁剪逻辑。

### 实现锚点

- [src/quick-impl/skill-runner.ts](../../../src/quick-impl/skill-runner.ts) 解析 ClaudeRunner JSON 后调 [src/db/repositories/test-runs.ts](../../../src/db/repositories/test-runs.ts) 的 `appendStageResult(testRunId, stageIdx, result)`
- 新增 `appendStageResult` 方法（仅 JSON merge，无 schema 变更）

---

## 6. 节点级联失效（spec round 2 改 AC 后 plan 重置）

**场景**：spec round 1 输出 AC-1/2/3 → plan 拆好任务 coverAC=['AC-1', 'AC-3'] → spec 被 reject，round 2 改成 AC-1/2/4。plan 现在引用了不存在的 AC-3，且没 cover AC-4。

### 检测：acDiff

spec-author round > 1 完成后，skill-runner 比对：
- `stage_results[specIdx].rounds[N-1].skillOutput.acceptanceCriteria`（上一轮）
- `stage_results[specIdx].rounds[N].skillOutput.acceptanceCriteria`（本轮）

差异写入 `stage_results[specIdx].acDiff`：

```json
{
  "added": [{"id": "AC-4", "text": "..."}],
  "removed": ["AC-3"],
  "changed": [{"id": "AC-1", "oldText": "...", "newText": "..."}]
}
```

### 重置：plan_author 节点

graph-runner 在 spec_review_loop 退出后检查 acDiff：
- `acDiff` 非空 → 调 LangGraph state 接口**重置 plan_author 节点状态**（status=pending）→ graph 自然 re-execute plan
- 重新跑的 plan-decomposer 拿到 inputs.previousRound.acDiff，决定哪些任务保留 / 哪些重拆

### 实现锚点

- [src/quick-impl/skill-runner.ts](../../../src/quick-impl/skill-runner.ts) 加 `diffAcceptanceCriteria(prev, curr)` 工具函数
- [src/pipeline/graph-runner.ts](../../../src/pipeline/graph-runner.ts) `resumeFromQiApproval` 在 spec 节点完成后检查 acDiff，调 LangGraph state 接口重置下游节点

### 留尾问题

plan 重跑后 dev_with_review_loop 是否也要重置？取决于 plan diff：
- plan tasks 变化（任务 add / remove）→ dev 也重跑
- 仅文字描述变 → dev 保留

Phase 2 实现时基于 plan 的 tasks diff 细化判定逻辑。
