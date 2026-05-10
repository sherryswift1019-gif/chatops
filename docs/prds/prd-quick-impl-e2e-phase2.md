# Quick-Impl 自有 E2E 节点 + 失败修复循环（Phase 2）

> 状态：已批准，待开发
> 计划起源：`/Users/zhangshanshan/.claude/plans/wiggly-twirling-dragonfly.md`
> 关联：[prd-quick-impl.md](prd-quick-impl.md) / [prd-quick-impl-roles-v2.md](prd-quick-impl-roles-v2.md)

## Context

QI（Quick-Impl 需求管理）流水线当前 `e2e_stub` 节点（[src/pipeline/node-types/e2e-stub.ts](../../src/pipeline/node-types/e2e-stub.ts)）是 Phase 1 占位，永远 pass。本次实现 Phase 2。

**产品分层**（关键）：

- **QI 内 e2e（本次范围）**：仅验证**当前 spec 范围内**新功能 / 修改是否生效——属于**验收**。Scenario 由 spec_author 同步生成，跟随 dev-loop commit 入仓
- **项目级 e2e（已存在，本次不动）**：跑全量回归，作为合并准入挡板，由现有 pipeline-b（[src/e2e/pipeline-b/runner.ts](../../src/e2e/pipeline-b/runner.ts)）承担。可以在 mr_create 之后挂独立节点调 pipeline-b（Phase 2.5/3 增强），不在本次范围

**完全独立于 pipeline-b**——QI 自己的 e2e 子系统从 sandbox provisioning 到 scenario 执行全部新写。**仅复用两个 agent 层原语**（不属 pipeline-b 基础设施）：
- [src/agent/e2e-scenario/runner.ts:runE2eScenario](../../src/agent/e2e-scenario/runner.ts) — 单 scenario 执行器（输入 scenario+sandboxHandle，输出 pass/fail）
- [src/e2e/pipeline-b/playbook/parse.ts:parsePlaybookYaml](../../src/e2e/pipeline-b/playbook/parse.ts) — 纯 zod YAML 校验器

**deploy.sh 是 target 项目自维护的协议**，谁都能调（不是 chatops 内部代码），QI 直接 `runScript('deploy.sh', ['provision', ...])` 即可，不复用 pipeline-b 的 setup-sandbox 节点。

**失败循环**：自动修 2 轮 → 第 3 轮 IM 卡片 3 按钮（再修 / 强制通过 / 终止）。

**不污染 GitLab**：QI 不直接 push 业务分支到 GitLab，sandbox provision 走本地 bare repo 当 origin。e2e 全绿后 mr_create 才正式 push GitLab + 建 MR。

**核心信念（决定 QI 成败）**：QI 流水线产出 MR 的可信度 100% 取决于 e2e scenario 的合规性。scenario 写得空洞 / 覆盖不全 / 不可观测，等于 QI 没做 e2e。下一节用硬+软+反模式三层定义"什么是合规 scenario"，是本方案的灵魂部分。

## E2E Scenario 合规标准（核心）

QI 的 spec_author 产出的每个 e2e scenario 必须同时满足以下 4 类约束。任何一类不满足就算不合规，spec_review_loop 应拒批让 spec_author 重写。

### A. 硬规则（zod schema 强制，运行时拒绝）

| 规则 | 校验 | 拒绝信息 |
|---|---|---|
| 数量下限 | `e2eScenarios.length ≥ 1` | "spec must include ≥1 e2e scenario" |
| 数量上限 | `e2eScenarios.length ≤ 5` | "max 5 scenarios per requirement (防 LLM 凑数)" |
| 步骤数 | `scenario.steps.length ≥ 1` | "scenario {id} has no steps" |
| 断言数 | `scenario.acceptance.length ≥ 1` | "scenario {id} has no acceptance assertion" |
| AC 关联 | `scenario.coversAC: string[]` 非空，每项匹配 `^AC-\d+$` 且必须在 `acceptanceCriteria[].id` 集合内 | "scenario {id} references unknown AC" |
| AC 全覆盖 | `acceptanceCriteria.map(.id)` 全集 ⊆ `⋃ scenarios.coversAC` | "AC-N not covered by any scenario" |
| 反向场景 | `scenario.kind: 'happy' \| 'negative'`，至少 1 个 `kind === 'negative'` | "must include ≥1 negative scenario (error/permission/boundary)" |
| ID 唯一 | `scenario.id` 在数组内唯一 + 匹配 `^[a-z][\w-]+$` | "duplicate or invalid scenario id" |

E2eScenarioInlineSchema 完整定义：
```ts
export const E2eScenarioInlineSchema = z.object({
  id: z.string().regex(/^[a-z][\w-]+$/, 'scenario id must be kebab-case starting with letter'),
  name: z.string().min(1),
  kind: z.enum(['happy', 'negative']),
  coversAC: z.array(z.string().regex(/^AC-\d+$/)).min(1),
  tags: z.array(z.string()).default([]),
  steps: z.array(z.string().min(1)).min(1),
  acceptance: z.array(z.string().min(1)).min(1),
})
```

### B. 软规则（spec_review_loop reviewer prompt 强制审查）

reviewer 收到 spec 后**必须逐 scenario 检查**，任一项不达标即拒批：

1. **步骤具体性**：每个 step 必须包含「动作动词 + 具体目标 + 具体数据」三要素
   - ✅ "POST /api/users 提交 body `{username:'admin', email:'a@b.c'}`，期望返回 201"
   - ✅ "在登录页输入用户名 `admin` 密码 `Test123!`，点击 `[data-testid=login-btn]` 按钮"
   - ❌ "用户登录系统"（动作模糊、无数据、无目标元素）
   - ❌ "测试创建用户功能"（meta 描述，不是动作）

2. **acceptance 可观测**：每个断言必须能被 Playwright/HTTP/DB 客观判断真假
   - ✅ "页面出现文本 `登录成功`"
   - ✅ "API 返回 status=201 且 body.userId 是非空字符串"
   - ✅ "数据库 users 表 username='admin' 的行存在且 created_at > 测试开始时间"
   - ❌ "用户体验良好"（主观）
   - ❌ "功能正常工作"（无信息量）
   - ❌ "应该能登录"（应然≠实然，不是可执行断言）

3. **数据来源明确**：scenario 用到的具体数据要么在 step 里凭空生成（明确写出值），要么 spec 里声明为 fixture / seed。**禁止**步骤里出现"使用某个用户"这种引用未定义对象的措辞

4. **独立可执行**：scenario 之间不依赖执行顺序 / 不共享状态。每个 scenario 必须能从空库 / 全新 sandbox 独立跑通

5. **范围聚焦**：scenario 仅验证本需求 spec.acceptanceCriteria 范围内的代码路径。不测试已有功能（那是项目级回归责任），不测试 spec 未声明的边界

6. **覆盖深度**：单个 scenario 不要试图覆盖 ≥3 个 AC，每个 AC 至少应有 1 个独立 scenario。一个 scenario 覆盖 N 个 AC 时 reviewer 要质疑是否拆分更清晰

### C. 反模式（自动触发拒批的明确黑名单）

reviewer prompt 列出禁用模式，命中即拒：
- 步骤含 "应该" / "正常" / "正确" 等应然表述
- acceptance 含 "通过" / "成功" / "OK" 单字成立的断言
- 步骤是"测试 X"、"验证 Y"这种 meta-描述（应该是动作）
- scenario 跨多个独立功能（比如同一 scenario 既测登录又测注册）
- 完全照抄 acceptanceCriteria 的文本作为 acceptance（没翻译成可观测断言）
- 引用 spec 未定义的概念 / 角色 / 数据
- happy 场景占比 100%（缺反向）

### D. 三层落地

1. **Schema 层**（zod）：A 类硬规则代码强制；spec_author 输出不合规 → 解析阶段直接 fail，触发 spec_author 重写（同 reviewer 拒批走相同 retry 循环）
2. **Reviewer 层**（spec_review_loop）：B/C 类软规则写进 reviewer prompt 作为 checklist；reviewer 输出 `notes` 引用具体 scenario.id + 不合规理由，spec_author 下轮针对性修
3. **Eval 层**（qi-eval 抽样）：上线后定期跑 `docs/qi-eval-*` 抽样人工评分，把"scenario 质量"作为独立维度（与 spec 完整性、commit 规范并列）；不达标的反哺 spec-author / reviewer prompt

**实施前提**：上线前必须有 ≥3 条**真实需求 e2e** 跑通整套流程做 calibration，验证 schema + reviewer 拦得住反模式。否则 e2e 通过率高但实际验收形同虚设——QI 失去意义。

## 状态机改造

QI 当前 graph（[src/quick-impl/bootstrap.ts:38-176](../../src/quick-impl/bootstrap.ts)）线性：
```
init_branch → spec_review_loop → plan_author → dev_with_review_loop → e2e_stub → final_approval → mr_create
```

改造后（替换 `e2e_stub`）：
```
dev_with_review_loop                         dev-loop 同时把 scenario YAML commit 进 worktree
        ↓
   qi_e2e_runner (新)                        内部：parse → push bare → setupSandbox → runE2eScenario×N → teardown
        ↓
   ┌── result=pass ──→ final_approval
   ↓ result=fail
   e2e_failure_router (复用 switch)          读 attempt
   ├── attempt < 2 → dev_loop_for_e2e_fix → qi_e2e_runner (回环)
   └── attempt >= 2 → e2e_im_intervention (新 im_input)
                          ↓
                    ┌── decision=fix         → dev_loop_for_e2e_fix → qi_e2e_runner
                    ├── decision=force_pass  → final_approval
                    └── decision=abort       → graph end (status=failed)
```

**push 到本地 bare 不暴露为独立节点**，藏在 `qi_e2e_runner` 内部（push + setup + scenario × N + teardown 是单个原子操作，失败重试整体重跑）。

### Graph state 字段（全走 stepOutputs，不动 PipelineStateAnnotation）
- `steps.qi_e2e_runner.output.attempt: number` — 节点入口反查 `pipeline_run_steps` 历史自增
- `steps.qi_e2e_runner.output.result: 'pass' | 'fail' | 'sandbox_failed'`
- `steps.qi_e2e_runner.output.failureReport: { scenarios: [{id, name, result, failureReason, claudeTraceTail, artifactsDir}] } | null`
- `steps.qi_e2e_runner.output.scenariosRun: number / passed: number / failed: number / durationMs`
- `steps.e2e_im_intervention.output.decision: 'fix' | 'force_pass' | 'abort'` / `humanNote / decidedBy / decidedAt`

`dev_loop_for_e2e_fix` 复用 `skill_with_review` 节点（独立 nodeId 避免 lockfile 串），`params.inputs` 模板（graph-builder 已支持 dot-walk）：
```
inputs.failureReport = '{{steps.qi_e2e_runner.output.failureReport}}'
inputs.humanNote     = '{{steps.e2e_im_intervention.output.humanNote}}'
inputs.attempt       = '{{steps.qi_e2e_runner.output.attempt}}'
```

## Spec_author 输出扩展

[src/quick-impl/role-output-schemas.ts:65](../../src/quick-impl/role-output-schemas.ts) `SpecAuthorOutputSchema` 加字段 `e2eScenarios`（**optional 而非 .min(1)**，避免 in-flight v8 run 在 spec_author 阶段炸；运行时在 qi_e2e_runner 节点入口校验）。

**superRefine 校验**（仅当 `e2eScenarios` 存在时运行）：AC 全覆盖 / 数量上限 5 / ≥1 negative / id 唯一。

**spec_review_loop reviewer prompt 加审查维度**（chatops-skills/reviewer 文档）：除了既有 spec 完整性 / 风险 / references 维度，新加 "E2E Scenario 合规" 维度，把 B/C 类软规则 + 反模式黑名单作为 checklist。**reviewer 必须逐 scenario 列点评**。

**字段 schema 跟现有 playbook 对齐**：参考 [src/e2e/pipeline-b/playbook/types.ts:107](../../src/e2e/pipeline-b/playbook/types.ts) 的 zod 结构，dev-loop 序列化成 YAML 时直接复用 playbook 格式。

## Dev-loop 写 scenario 文件

dev-loop role prompt（chatops-skills 仓库 `dev-loop.md`）增加段落：

> 收到 `inputs.spec` 时，从 `spec.e2eScenarios` 序列化 YAML 写到 worktree `docs/test-playbooks/qi-{requirementId}.yaml`。该文件随业务代码一并按 task commit。

YAML 序列化模板：
```yaml
playbook_id: qi-{requirementId}
title: "{spec.title}"
scenarios:
  - id: {scenario.id}
    name: {scenario.name}
    tags: [{tags}]
    steps:
      - {step}
    acceptance:
      - {acceptance}
```

**为什么放在 `docs/test-playbooks/`**：与项目级 playbook 同位，合并后是项目仓库的一部分，后期人工可以给这些 scenario 手动加 `smoke` tag 提升为项目级回归，无需迁移路径。

## QI 自有 sandbox/workspace 管理（独立于 pipeline-b）

新建 [src/quick-impl/qi-sandbox.ts](../../src/quick-impl/qi-sandbox.ts)：

```ts
export interface QiSandboxHandle {
  sandboxDir: string         // QI 专用 workspace 路径
  envId: string
  endpoints: Record<string, string>
  containerId?: string
  workdir?: string
  internalRefs?: Record<string, unknown>
}

export async function provisionQiSandbox(opts: {
  requirementId: number
  attempt: number
  bareRepoPath: string       // 本地 bare 当 origin
  branch: string             // qi 分支名
  targetProjectId: string
}): Promise<QiSandboxHandle>

export async function teardownQiSandbox(handle: QiSandboxHandle): Promise<void>

export class SandboxProvisionError extends Error { ... }
```

**`provisionQiSandbox` 内部流程**：
1. `sandboxDir = /data/chatops/test-runs/qi-workspaces/<requirementId>/<attempt>/`（env 覆盖 `QI_SANDBOX_DIR_BASE`，沿用既有 `/data/chatops/test-runs` 挂卷点免改 docker-compose）
2. `git clone <bareRepoPath> <sandboxDir> --branch <branch>`（自实现）
3. 反查 `e2e_target_projects.scripts.deploy`（默认 `deploy.sh`）
4. `runScript('<sandboxDir>/deploy.sh', ['provision', '--branch=<branch>', '--out-handle=<sandboxDir>/.qi-handle.json'], { cwd: sandboxDir, env: {PG_HOST:'postgres', E2E_SANDBOX_DB_URL:''}})`
5. 解析 `.qi-handle.json` → 返回 `QiSandboxHandle`
6. 任一步失败 → 抛 `SandboxProvisionError`（外层路由识别走 `qi_sandbox_failed` IM 分支）

**`teardownQiSandbox`**：`runScript('<sandboxDir>/deploy.sh', ['teardown', '--handle=<.qi-handle.json>'])` → 成功后 `rm -rf <sandboxDir>`。

**与 pipeline-b 的 sandbox 隔离**：路径不同 / 不写 e2e_sandboxes 表 / 不在 pipeline-b graph state 里登记 / 不被 pipeline-b startup-recovery 误抓。

**孤儿清理**：[src/quick-impl/worker.ts:runCleanupTick](../../src/quick-impl/worker.ts) 加扫描 `qi-workspaces/` 子目录，按路径反推 requirementId，QI run 终态 30min+ 则 `teardownQiSandbox` + rm -rf。

## QI 本地 bare repo 工具

新建 [src/quick-impl/qi-bare-repo.ts](../../src/quick-impl/qi-bare-repo.ts)：

- `QI_LOCAL_REMOTE_BASE`：env 覆盖，默认 `~/.chatops-repos-qi-bare`
- `ensureBareRepo(gitlabProject) → bareRepoPath`：幂等 `git init --bare`
- `pushToBare(worktreePath, branch, bareRepoPath)`：`git -C <wt> push <bare> <branch>:<branch> --force-with-lease`
- `removeBareBranch(bareRepoPath, branch)`：终态清理

**共享策略**：per-project（一个项目所有 QI run 共用一个 bare，按 `feat/qi-${requirementId}` 分支隔离）。

清理：`runCleanupTick` 在 `safeRemoveWorktree` 后追加 `removeBareBranch`，复用 30min 宽限。

## 失败报告组装

新建 [src/quick-impl/qi-e2e-failure-report.ts](../../src/quick-impl/qi-e2e-failure-report.ts)：

`buildQiFailureReport(scenarioResults: RunScenarioResult[]): FailureReport`：
- 过滤 `result !== 'pass'` 的 scenario
- 抽 `failureReason` / `claudeTrace` 末 8KB / `artifactsDir`

## init_qi_branch 节点扩展

[src/pipeline/node-types/init-qi-branch.ts:106](../../src/pipeline/node-types/init-qi-branch.ts) 节点输出加：
- `bareRepoPath: string` — 调 `ensureBareRepo` 拿
- 在 worktree 内 `git remote add qi-local <bareRepoPath>`（origin 保持指向 GitLab，给 mr_create 用）

## 三个新节点类型

### 1. `qi_e2e_runner`（新建 [src/pipeline/node-types/qi-e2e-runner.ts](../../src/pipeline/node-types/qi-e2e-runner.ts)）

execute 流程：
1. **解析 scenario**：读 `<worktreePath>/docs/test-playbooks/qi-{requirementId}.yaml`，复用 `parsePlaybookYaml` 校验。**附加 v9-only 合规校验**（数量 / AC 覆盖 / negative）
2. **反查 attempt**：从 `pipeline_run_steps` 同 nodeId 历史出现次数
3. **push 到 bare**：`pushToBare(worktreePath, branch, bareRepoPath)`
4. **反查 targetProjectId**：`requirement.gitlabProject` ↔ `e2e_target_projects.gitlabRepo` 字符串匹配
5. **provision sandbox**：`await provisionQiSandbox(...)`。**sandbox 阶段失败抛 `SandboxProvisionError`**，不进 fix-loop
6. **runId 撞库防御**：传 `-BigInt(requirementId)`（负值不撞 e2e_runs.id 正自增）
7. **evidenceDir 规划**：`<sandboxDir>/evidence/<scenario.id>/<attempt>/`，跟 sandboxDir 一起清
8. **try-finally 跑 scenarios**：teardown 在 finally
9. **判定与组装**：所有 pass → `result: 'pass'`；任一 fail → `result: 'fail' + failureReport`；sandbox 阶段失败 → `result: 'sandbox_failed'`

dryRun：通过 [src/pipeline/dryrun-stub.ts](../../src/pipeline/dryrun-stub.ts) 自动按 outputSchema 生成 stub。

### 2. `im_input`（新建 [src/pipeline/node-types/im-input.ts](../../src/pipeline/node-types/im-input.ts)）

跨模块改动清单：

| 文件 | 改动 |
|---|---|
| [src/pipeline/graph-builder.ts](../../src/pipeline/graph-builder.ts) | 新增 `QI_IM_INPUT_INTERRUPT` 常量；stageType switch 加 `case 'im_input'`；新建 `buildImInputNode` |
| [src/pipeline/graph-runner.ts](../../src/pipeline/graph-runner.ts) | `dispatchInterrupt` 加 `qi_im_input` 分支 |
| [src/pipeline/qi-approval-manager.ts](../../src/pipeline/qi-approval-manager.ts) | `sendQiApprovalCard` 加 `kind: 'qi_e2e_intervention' \| 'qi_sandbox_failed'` 分支（3 / 2 按钮）；`handleQiCardCallback` 解析 `'fix' / 'force_pass' / 'abort'` |
| [src/adapters/im/dingtalk.ts](../../src/adapters/im/dingtalk.ts) | action 归一化扩 `fix / force_pass / abort` 直通 |
| [src/db/repositories/requirement-approval-waiters.ts](../../src/db/repositories/requirement-approval-waiters.ts) | `ApprovalDecision` 加 `'fix' \| 'force_pass'`；`decision_set` 加 `'qi_e2e_intervention'` |
| [src/admin/routes/requirements.ts](../../src/admin/routes/requirements.ts) | waiter 列表 / 介入 API 兼容新 decision 值（人工 web 兜底） |
| schema-v62.sql | `requirement_approval_waiters.decision` 列 CHECK 约束扩 3 值 |

**钉钉卡片 4096 字符限**：仅放摘要（失败 scenario 名 + AC + 失败 acceptance 1 行），claudeTrace 完全不放，靠 web 详情页。

### 3. failure_router（不新增节点，复用 `switch`）

三分叉：
- `result === 'pass'` → final_approval
- `result === 'sandbox_failed'` → e2e_im_intervention（kind='qi_sandbox_failed'，retry/abort 二值）
- `result === 'fail' && attempt < 2` → dev_loop_for_e2e_fix → qi_e2e_runner
- `result === 'fail' && attempt >= 2` → e2e_im_intervention（kind='qi_e2e_intervention'，3 按钮）

## 并发控制 + 总耗时透明度

**并发控制**：`QI_E2E_CONCURRENCY` env，默认 **1**（串行最稳）；worker.ts 加 semaphore，进入 qi_e2e_runner 前 acquire。

**总耗时透明度**：
- 单 scenario 30min × 5 = 2.5h；fix 2 轮 ×3 = 7.5h；全程最坏 12h+，平均 2-4h
- web UI 必须有 **QI run 进度页**：实时阶段 / 当前 attempt / 当前 scenario / failureReport 详情
- IM 通知关键转折：dev-loop 完成、进入 qi_e2e_runner、e2e 第 N 轮失败、IM 介入、final_approval
- 用户提交需求时显示"预计耗时" 2-6h 范围

## 数据库改动

新建 [src/db/schema-v62.sql](../../src/db/schema-v62.sql)：

```sql
-- 1. 注册新节点类型
INSERT INTO pipeline_node_types(...) VALUES
  ('qi_e2e_runner', ...),
  ('im_input', ...)
ON CONFLICT (key) DO UPDATE SET ...;

-- 2. e2e_stub 保留（in-flight v8 run 仍用），不删
UPDATE pipeline_node_types SET name = name || ' (deprecated)' WHERE key = 'e2e_stub';

-- 3. requirement_approval_waiters.decision_set 扩 'qi_e2e_intervention'，decision 值允许 'fix'/'force_pass'/'abort'
```

[src/db/migrate.ts:81](../../src/db/migrate.ts) `SCHEMA_FILES` 追加 `['v62', 'schema-v62.sql']`。同步 [src/__tests__/helpers/db.ts](../../src/__tests__/helpers/db.ts)。

[src/quick-impl/bootstrap.ts:15](../../src/quick-impl/bootstrap.ts) `QUICK_IMPL_TEMPLATE_VERSION` 8 → 9。

## 文件级改动清单

**新增**：
- [src/db/schema-v62.sql](../../src/db/schema-v62.sql)
- [src/quick-impl/qi-sandbox.ts](../../src/quick-impl/qi-sandbox.ts)
- [src/quick-impl/qi-bare-repo.ts](../../src/quick-impl/qi-bare-repo.ts)
- [src/quick-impl/qi-e2e-failure-report.ts](../../src/quick-impl/qi-e2e-failure-report.ts)
- [src/pipeline/node-types/qi-e2e-runner.ts](../../src/pipeline/node-types/qi-e2e-runner.ts)
- [src/pipeline/node-types/im-input.ts](../../src/pipeline/node-types/im-input.ts)
- 测试文件

**修改**：
- [src/quick-impl/bootstrap.ts](../../src/quick-impl/bootstrap.ts)
- [src/quick-impl/role-output-schemas.ts](../../src/quick-impl/role-output-schemas.ts)
- [src/pipeline/graph-builder.ts](../../src/pipeline/graph-builder.ts)
- [src/pipeline/graph-runner.ts](../../src/pipeline/graph-runner.ts)
- [src/pipeline/node-types/init-qi-branch.ts](../../src/pipeline/node-types/init-qi-branch.ts)
- [src/quick-impl/worker.ts](../../src/quick-impl/worker.ts)
- [src/pipeline/qi-approval-manager.ts](../../src/pipeline/qi-approval-manager.ts)
- [src/adapters/im/dingtalk.ts](../../src/adapters/im/dingtalk.ts)
- [src/db/repositories/requirement-approval-waiters.ts](../../src/db/repositories/requirement-approval-waiters.ts)
- [src/admin/routes/requirements.ts](../../src/admin/routes/requirements.ts)
- [src/db/migrate.ts](../../src/db/migrate.ts)
- web/ 前端 — QI run 进度页 + failureReport 详情
- chatops-skills 仓库（**前置 Gate 0a**）：`spec-author.md` / `dev-loop.md` / `spec-reviewer` prompt

**保留不删**：[src/pipeline/node-types/e2e-stub.ts](../../src/pipeline/node-types/e2e-stub.ts) — in-flight v8 run 兼容

**完全不动**（绝对隔离）：
- [src/e2e/workspace.ts](../../src/e2e/workspace.ts)
- [src/e2e/pipeline-b/](../../src/e2e/pipeline-b/) 整个目录
- [src/db/repositories/e2e-sandboxes.ts](../../src/db/repositories/e2e-sandboxes.ts) / [e2e-runs.ts](../../src/db/repositories/e2e-runs.ts)

**只读复用**（不修改）：
- [src/agent/e2e-scenario/runner.ts:runE2eScenario](../../src/agent/e2e-scenario/runner.ts)
- [src/e2e/pipeline-b/playbook/parse.ts:parsePlaybookYaml](../../src/e2e/pipeline-b/playbook/parse.ts)

## 实施顺序（11 commits + 2 前置 gate）

每 commit 必须 `pnpm exec tsc --noEmit` 干净通过；dev-loop 不 push，全部完成后人工统一 review。

**前置 Gate（必须先做完才动后端代码）**：

- **Gate 0a — chatops-skills prompt 合并**：先在 chatops-skills 仓库改 `spec-author.md` / `dev-loop.md` / spec-reviewer 合并到 main
- **Gate 0b — deploy.sh 兼容性 audit**：选 1-2 个候选 target 项目（含 chatops 自己），手动用本地 bare 跑 `deploy.sh provision`，确认不 hardcode GitLab URL

**正式 Commits**：

1. **schema-v62 + 类型层**：schema-v62.sql + migrate.ts 注册 + waiters TS 类型加 `'fix'/'force_pass'`、decision_set 加 `'qi_e2e_intervention'`
2. **bare repo 工具**：`qi-bare-repo.ts` + 单测
3. **QI sandbox 工具**：`qi-sandbox.ts`（含 `SandboxProvisionError`）+ 单测
4. **qi-e2e-failure-report**：组装工具 + 单测
5. **spec-author schema 扩展**：`SpecAuthorOutputSchema` + `superRefine` + 反模式拦截测试
6. **qi_e2e_runner 节点**：注册 + 全链路 + 单测；`SandboxProvisionError` 路径单独测
7. **im_input 节点 + 跨模块改动**：im-input + graph-runner dispatchInterrupt 分支 + qi-approval-manager 卡片 + dingtalk action 归一化 + admin API + 单测
8. **worker.ts 并发控制 + 清理扩展**：QI_E2E_CONCURRENCY semaphore + cleanup 扩展 + IM waiter expires_at sweeper + 单测
9. **web UI QI run 进度页**：实时阶段 + failureReport 详情 + IM 卡片"查看详情"链接
10. **bootstrap graph 改造**：QUICK_IMPL_TEMPLATE_VERSION = 9；e2e_stub 替换为子机；init_qi_branch 输出 bareRepoPath
11. **集成测试 + qi-eval 校准**：`qi-e2e-fix-loop.integration.test.ts`；选 ≥3 条真实需求做 calibration

## 风险点 + 缓解

1. **chatops 重启 → sandbox 残留**：用文件系统 + `.qi-handle.json` 单源，cleanup tick 扫 `qi-workspaces/` 反推 requirementId
2. **bare repo 磁盘累积**：per-project 共享 + ref 级清理 + 5GB 硬上限
3. **IM 介入超时无回复**：worker.ts 5min sweeper 扫 `expires_at` → `decision='abort'` resume
4. **用户 abort QI run 级联清理**：`setRequirementStatus(aborted)` 触发 sandbox 扫描清理
5. **scenario 不合规（最严重）**：三层防御（schema / reviewer / qi-eval），上线前 ≥3 条真实需求 calibration
6. **sandbox provision 失败 ≠ 代码 bug**：`SandboxProvisionError` 走 `qi_sandbox_failed` IM 分支，不进 dev-loop fix-loop
7. **scenario 数量 / 超时**：runE2eScenario 30min/scenario 既有；schema 限 ≤5；节点级总超时 `maxTotalMs=180min`
8. **YAML parse / 合规失败**：节点 fail，failureReport 写"YAML 不合规"，dev-loop 收反馈修
9. **runE2eScenario runId 撞库**：传 `-BigInt(requirementId)` 负值；admin SSE 端验证负 id 行为
10. **target 项目 deploy.sh 不兼容本地 bare**：Gate 0b audit 拦截
11. **多 QI run 并发 → ClaudeRunner 串扰**：`QI_E2E_CONCURRENCY=1` 串行起步
12. **chatops-skills prompt 与代码 schema 失步**：Gate 0a 强制 prompt 先合并；schema 改动必须先发 chatops-skills PR

## 验证 (End-to-End Verification)

0. Gate 0a / 0b 已完成
1. **本地单元 + 集成测试**：`./test.sh --filter "qi-bare-repo|qi-e2e-failure-report|qi-sandbox|qi-e2e-runner|im-input|spec-author-schema|qi-e2e-fix-loop"` 全绿
2. **回归 pipeline-b 现有 e2e**：admin UI 触发一次手动 E2E（trigger_type=manual）跑通
3. **本地起 dev**：`pnpm migrate` 应用 v62；`pnpm dev`；`cd web && pnpm dev`
4. **Scenario 合规反模式抽测**：手动构造反模式确认 schema / reviewer 都拦得住
5. **创建 QI 需求走完整流程**（≥3 条不同类型需求做 calibration）
6. **sandbox_failed 路径专测**：故意搞坏 deploy.sh provision
7. **Web UI 进度页验证**
8. **GitLab 验证**：流程结束前确认 GitLab 没有 `feat/qi-...` 分支
9. **mr_create**：final_approval 通过后 mr_create 推 origin + 建 MR
10. **abort 级联**：abort QI run 时 sandbox 被回收 + evidence dir 被清
11. **磁盘清理**：终态 30min+ 后 bare ref 删 / worktree 删 / qi-workspaces 删
12. **qi-eval 抽样**：跑 [scripts/qi-eval.ts](../../scripts/qi-eval.ts) 把 e2eScenarios 质量纳入评分
