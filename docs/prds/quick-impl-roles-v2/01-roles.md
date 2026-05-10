# Spec 01: 4 个 Role 升级设计

> 主 PRD：[prd-quick-impl-roles-v2.md](../prd-quick-impl-roles-v2.md)
> 关联：[02-data-flow.md](02-data-flow.md)（输入输出契约）· [03-standards.md](03-standards.md)（standards 内容）· [04-prompt-strategy.md](04-prompt-strategy.md)（写 role.md 风格约定）

本文定义 quick-impl-artifact-author 下 4 个 role 的 v2 详细设计。每个 role 独立成节，包含任务步骤 / 文档结构 / 输出 JSON schema / DoD 检查项。

实现 Phase 2 时只需读本文 + 02 + 04。

---

## 1. spec-author v2

**职责**：把用户一句话需求扩写成结构化 spec。

### 任务步骤

1. **读上下文**：读 `.qi-context/inputs.json` + `.qi-context/feedback.md`（如存在，详见 [02-data-flow.md](02-data-flow.md)）
2. **澄清阶段**：列出 5-8 个澄清问题（如"用户身份认证用什么方式？" "是否需要兼容老版本？"），用 codebase Read/Grep 自答；自答不出的标记为 `OPEN_QUESTION`
3. **撰写阶段**：按下面文档结构写 spec 到 `artifact_path`
4. **自检阶段**：对照 DoD checklist 自查，结果填到输出 JSON 的 `evidence.selfCheck`

### Spec 文档结构

```markdown
# 需求规格：{标题}

## 1. 背景与目标
## 2. 澄清记录
（澄清问题 + 自答 / OPEN_QUESTION）
## 3. 功能描述
## 4. 验收标准
- AC-1: Given {context}, When {action}, Then {outcome}
- AC-2: ...
## 5. 非功能需求
（性能 / 安全 / 可观测性 / 兼容性，不适用写"N/A 因为..."）
## 6. 技术说明
（必须引用现有 codebase: file:line）
## 7. 风险与未知
## 8. 回滚预案
## 9. 超出范围
```

### 输出 JSON schema

```json
{
  "summary": "...",
  "decision": "pass" | "fail",
  "notes": [{"severity": "warn"|"error", "msg": "...", "file": "..."}],
  "evidence": {
    "standardsConsulted": ["docs/standards/frontend-enum-select.md"],
    "selfCheck": [{"item": "AC 全部用 Given-When-Then 格式", "passed": true}]
  },
  "acceptanceCriteria": [
    {"id": "AC-1", "format": "given-when-then", "text": "..."}
  ],
  "openQuestions": ["..."],
  "risks": [{"desc": "...", "severity": "high"|"medium"|"low"}],
  "references": [{"file": "src/login/...", "line": 42, "purpose": "现有登录逻辑"}],
  "clarifications": [{"q": "...", "a": "..." | "OPEN_QUESTION"}]
}
```

### DoD 自检 checklist

- AC 全部用 Given-When-Then 格式
- 每条 AC 都可测试（无"系统应该高性能"等模糊描述）
- 至少 1 条 references 引用 codebase 现有实现
- 非功能需求 5 个维度（性能/安全/可观测/兼容/可访问性）都有结论（不适用必须写 N/A 理由）
- 风险与未知章节非空（至少列 1 条 OPEN_QUESTION 或 risk）
- evidence.standardsConsulted 至少包含 1 项

### fail 条件（收紧）

只有"连澄清问题都列不出来"才 fail；模糊需求一律输出 `clarifications` + 合理默认值，仍 pass。

### 一致性约束（A4）

输出 JSON 的 `acceptanceCriteria[]` 数量必须等于 spec.md 第 4 节列表项数量。evaluation harness 自动校验。

---

## 2. plan-decomposer v2

**职责**：读已审批的 spec，拆解为带依赖图的任务清单。

### 任务步骤

1. 读 `inputs.json`（含 `specPath` + `specAcceptanceCriteria` 蒸馏数组）+ feedback.md（如存在）
2. 读 spec 文档全文（理解非功能需求与风险章节）
3. 浏览 worktree 现有架构（用 Read/Grep）
4. 拆任务，写 plan 文档到 `artifact_path`
5. 自检（DoD checklist）

### 强约束（v2 新增）

- 每个 `type='feature'` 任务必须配 ≥1 个 `type='test'` 任务
- 涉及 schema 变更必须有 `type='migration'` 任务，标记新 schema 文件号（参考 [03-standards.md](03-standards.md) 的 `db-schema-versioning.md`）
- 每个任务必须 `coverAC: ['AC-1', ...]` 引用 spec 的验收标准；spec 所有 AC 必须至少被一个任务 cover
- 每个任务必须有 `estimatedFiles` + `estimatedLoc`（粗略数量级，方便审批人判断改动量）

### 输出 JSON schema

```json
{
  "summary": "...",
  "decision": "pass" | "fail",
  "notes": [...],
  "evidence": {...},
  "tasks": [
    {
      "id": "T1",
      "type": "feature" | "test" | "migration" | "doc",
      "title": "...",
      "files": ["src/login/LoginPage.tsx"],
      "coverAC": ["AC-1", "AC-2"],
      "dependsOn": [],
      "estimatedLoc": 50,
      "notes": "..."
    },
    {
      "id": "T2",
      "type": "test",
      "title": "测试: T1 的单元测试",
      "files": ["src/__tests__/unit/login.test.tsx"],
      "coverAC": ["AC-1", "AC-2"],
      "dependsOn": ["T1"],
      "estimatedLoc": 80
    }
  ],
  "migrations": [
    {"file": "src/db/schema-v62.sql", "table": "...", "rollbackPlan": "..."}
  ]
}
```

### DoD 自检 checklist

- 所有 spec AC 都被至少 1 个任务的 coverAC 覆盖
- 每个 feature 任务至少有 1 个 test 任务依赖它
- 任务粒度合理（≤3 文件 / ≤200 LOC，超过的拆开）
- 涉及 DB schema 必有 migration 任务
- dependsOn 形成的图无环

### previousRound 处理（spec AC 改了的情况）

如果 `previousRound.acDiff` 非空（spec round 2 改了 AC），保留仍 cover 当前 AC 的任务，重拆涉及变更 AC 的任务。在 notes 中说明哪些任务被保留 / 重拆。详见 [02-data-flow.md](02-data-flow.md) §节点级联失效。

---

## 3. dev-loop v2（改动最大）

**职责**：按 plan 实现代码，TDD 顺序，按任务 commit。

### 任务步骤

1. 读 `inputs.json`（含 `planPath` + `planTasks` + `previousCommits`）+ feedback.md（如存在）
2. 如果 `previousCommits` 非空（round 2+），先 `git log` 看哪些任务已 commit
3. 按任务依赖顺序逐项实现（见下面 TDD 顺序）
4. 自检（DoD checklist）

### commit 策略（v2 改动核心）

**round 1**：按任务 commit，每个任务一个 commit
- commit message：`feat(qi-{requirement_id}): T{n} {任务标题}`

**round 2+：追加 fix commit**（不改写历史）
- 已 commit 且 reviewer 未标 error 的任务跳过，写入输出 `skippedTasks[]`
- 需要修订的任务：在历史 commit 之上加新 fix commit
- commit message：`fix(qi-{requirement_id}): T{n} 修订 — {reviewer 反馈摘要}`
- 不 reset / 不 rebase / 不 amend

**理由**：git log 完整可追溯、reviewer round 2 看完整 diff、避免 rebase 冲突。

### TDD 顺序（type='test' 任务在 type='feature' 任务前）

1. 写测试 → `pnpm exec vitest --related --run <test-file>` 必须红
2. 实现代码 → 再跑测试必须绿
3. `pnpm exec tsc --noEmit` 通过
4. `git add <specific-files>`（不要 `-A`）+ commit
5. 进下一个任务

### "受影响 vitest" 判定

- 优先：`pnpm exec vitest --related --run <changed-file>`（vitest 内置追踪 import 关系）
- fallback（`--related` 无返回时）：按文件名匹配 `src/__tests__/**/{basename}*.test.ts`
- 命令模板必须写在本 role.md 里，不要让 Claude 自己拼

### worktree 隔离

- skill-runner 已在创建 worktree 时把 `.qi-context/` 加入 `.gitignore`（详见 [02-data-flow.md](02-data-flow.md)）
- 即使误用 `git add -A` 也不会带进 commit
- 但仍**强烈建议** `git add` 时显式列文件

### 输出 JSON schema

```json
{
  "summary": "...",
  "decision": "pass" | "fail",
  "notes": [...],
  "evidence": {...},
  "commits": [
    {
      "taskId": "T1",
      "sha": "abc1234",
      "message": "feat(qi-7): T1 添加 Checkbox 组件",
      "filesChanged": ["web/src/login/LoginPage.tsx"],
      "tsc": "pass",
      "vitest": {
        "command": "pnpm exec vitest --related --run web/src/login/LoginPage.tsx",
        "passed": 5,
        "failed": 0
      }
    },
    {
      "taskId": "T2",
      "sha": "def5678",
      "message": "fix(qi-7): T2 修订 — 处理空数组",
      "round": 2,
      "isFix": true,
      "filesChanged": ["src/foo.ts"],
      "tsc": "pass",
      "vitest": {...}
    }
  ],
  "skippedTasks": [{"taskId": "T3", "reason": "round 1 已 commit 且 reviewer 未标记"}],
  "failedTasks": []
}
```

### DoD 自检 checklist

- `commits[].length` ≥ `planTasks` 中未 skip 的任务数（一任务一 commit）
- 每个 commit 都通过 tsc
- 每个 feature 任务对应的 test 任务先跑红再跑绿
- git diff 不含 `.qi-context/` 改动
- 没有改 plan 之外的文件（除非属于"必要的关联修改"，需在 notes 解释）

---

## 4. code-quality-reviewer v2

**职责**：审查 dev-loop 产出的代码变更，给人工审批结构化决策依据。

### 任务步骤

1. 读 `inputs.json`（含 `specAcceptanceCriteria` + `planTasks` + `branch`）
2. 查看变更：
   - `git -C {worktree_path} diff origin/main..HEAD --name-only`
   - `git -C {worktree_path} diff origin/main..HEAD`
3. **standards 检查**（本 role 拿到全部 8 篇 standards，逐项 grep）
4. **spec 覆盖检查**（每条 AC 是否被代码覆盖）
5. **范围检查**（是否超出 plan）
6. **风险评估**（fileRisks，保留 v1 设计）
7. 输出 JSON

### 检查项（基于 [03-standards.md](03-standards.md)）

| 检查项 | 命令 / 标准 | 违反行为 |
|--------|------------|---------|
| GitLab 配置 | `git diff` 中 `process.env.GITLAB_URL` / `GITLAB_TOKEN` 不应出现（除 `src/pipeline/executor.ts:29` 例外） | error |
| Tool 自注册 | 新增 `src/agent/tools/*.ts` 必须在 `src/server.ts` + `src/agent/mcp-server.ts` 都加 import | error |
| DB schema 编号 | 新增 `src/db/schema-v*.sql` 必须同步 `src/db/migrate.ts` + `src/__tests__/helpers/db.ts` 的 SCHEMA_FILES | error |
| Repository 模式 | 新增 repo 用参数化 SQL（无字符串拼接）+ mapRow 函数 | error |
| 前端枚举字段 | 新增表单字段是引用枚举 → 必须 Select 而非 Input | warn |
| commit 粒度 | dev-loop 输出的 commits 是否按任务粒度（不是一次性大 commit） | error |
| 测试约束 | 每个 feature commit 都对应有 test commit 在前 / 同 commit | warn |
| .qi-context 改动 | `git diff` 不应含 `.qi-context/` 路径 | error，直接 fail |

### 输出 JSON schema

```json
{
  "summary": "一句话总体结论，说明实现质量和主要风险",
  "decision": "pass" | "fail",
  "notes": [
    {"severity": "warn"|"error", "msg": "具体问题描述", "file": "src/xxx.ts"}
  ],
  "evidence": {
    "standardsConsulted": ["docs/standards/gitlab-config.md", ...],
    "selfCheck": [...]
  },
  "specCoverage": [
    {
      "ac": "AC-1",
      "covered": true,
      "evidence": [{"file": "web/src/login/LoginPage.tsx", "line": 42}]
    },
    {
      "ac": "AC-3",
      "covered": false,
      "missingReason": "代码中没有处理 localStorage 清除的逻辑"
    }
  ],
  "scopeViolations": [
    {"file": "src/unrelated.ts", "reason": "改动了不在 plan 中的文件"}
  ],
  "fileRisks": [
    {
      "file": "web/src/pages/LoginPage.tsx",
      "role": "登录入口，所有用户必经路径",
      "impact": "改动了表单初始值和提交逻辑",
      "risk": "medium",
      "focusOn": "localStorage 读写的边界情况；表单 reset 时是否会意外清除已填内容"
    }
  ]
}
```

### DoD 自检 checklist

- specCoverage 覆盖所有 spec AC（数量等于 `inputs.specAcceptanceCriteria.length`）
- 每条 covered=true 的 AC 都有 evidence file:line
- standards 全部 8 篇都在 standardsConsulted 中
- 8 项 standards 检查都执行过（即使没违反也要写到 selfCheck）
- fileRisks 中 high/medium 风险项必须给出 focusOn 具体描述

### fail 条件

任意 standards 检查标记 error → fail。
.qi-context/ 出现在 diff → fail。
其余按 fileRisks 综合判断。
