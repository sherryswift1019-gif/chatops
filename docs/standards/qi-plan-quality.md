# QI Plan 质量标准（qi-plan-quality v1）

> 三个 plan 阶段 role 的 single source of truth：
> - [plan-decomposer.md](../../.claude/skills/quick-impl-artifact-author/roles/plan-decomposer.md)（生产侧）
> - [plan-reviewer.md](../../.claude/skills/quick-impl-artifact-author/roles/plan-reviewer.md)（工程视角 review）
> - [product-reviewer.md](../../.claude/skills/quick-impl-artifact-author/roles/product-reviewer.md)（产品视角 review，Phase 3 启用）
>
> 关联：[qi-spec-quality.md](./qi-spec-quality.md)（spec 阶段同构标准）

---

## §1 产品级 plan 的最低要求

合格 plan 必须同时满足两条线的覆盖：

### 工程交付维度
- **AC 全覆盖**：spec.acceptanceCriteria 每个 ID 都被至少 1 个 task.coverAC 引用
- **feature→test 配对**：每个 estimatedLoc ≥ 10 的 feature task 必须有 ≥ 1 个 test task 在 dependsOn 中
- **DAG 无环**：tasks[].dependsOn 必须形成有向无环图
- **INVEST 切片**：每个任务符合 Independent / Negotiable / Valuable / Estimable / Small / Testable（详见 §3）
- **doneWhen 客观可验**：3-5 条具体可执行断言，无空洞词（详见 §5）
- **调研留痕**：plan.md §1 至少 3 条 `[path:line](path#Lline)` 引用 worktree 真实代码

### 产品交付维度（Phase 3 启用，灰度 warn-only）
- **P11 可观测性**：涉及"用户行为"的 feature task 必须有埋点 / metrics task 配对
- **P12 灰度策略**：高 impact task（影响所有用户 / 改关键 API / 改 DB）必须声明 `featureFlag` / `canary` / `rolloutPlan`
- **P13 回滚预案**：高 impact feature task 必须有 `rollbackPlan`（migration 已强制）
- **P14 用户感知**：UI feature task 的 `doneWhen` 必须覆盖 error / empty / loading 三态
- **P15 NFR 覆盖**：spec.risks 含 perf / security / compat 的，plan 必须有对应 task

---

## §2 Plan tasks schema 契约

权威定义：[src/quick-impl/role-output-schemas.ts:PlanTaskSchema](../../src/quick-impl/role-output-schemas.ts)（zod 是 single source of truth）。

核心字段：

```typescript
PlanTask = {
  id: 'T\\d+',
  type: 'feature' | 'test' | 'migration' | 'refactor' | 'chore',
  title: string,
  files: string[],                              // 全列，含 test / fixture / 配置
  coverAC: string[],                            // 引用 spec.acceptanceCriteria.id
  dependsOn: string[],                          // 仅引用本 plan task id
  estimatedLoc?: number,                        // ±50% 区间合理
  doneWhen?: string[],                          // 3-5 条客观可验断言（§5）
  implementationHints?: {
    reuseFrom?: Array<{ file, line?, why }>,
    insertAt?: { file, afterLine },             // file:line 必须真实存在（lint L9/L10）
    watchOut?: string[],
  },
  testHints?: {                                  // type=test 必填
    framework: string,
    casesTitles: string[],                       // ≥ 2 条
  },
  exposesContract?: unknown,                    // 跨任务接口
  // 产品级字段（Phase 3 启用）
  rollbackPlan?: string,
  featureFlag?: string,
  observability?: { metrics?: string[], logs?: string[] },
  userPerceptionStates?: ('error' | 'empty' | 'loading' | 'success')[],
}
```

---

## §3 任务粒度准则（INVEST）

按 INVEST 切片：

| 维度 | 含义 |
|---|---|
| **I**ndependent | 可独立 PR / 独立部署 / 独立回滚（dependsOn 仅排序，不破坏独立性） |
| **N**egotiable | title 描述结果不描述实现路径 |
| **V**aluable | 每任务对 AC 有可观测贡献。**< 10 LOC 集成胶水合并到主 feature**，不单拆 |
| **E**stimable | estimatedLoc 给 ±50% 区间 |
| **S**mall | 典型 50-150 LOC，硬上限 250 LOC（超 → 拆） |
| **T**estable | feature 必有 test 任务 dependsOn（**例外**：< 10 LOC 集成胶水可与 feature 同 commit 共测试） |

task type：

| type | 用途 | 必有 test? |
|---|---|---|
| `feature` | 功能实现 | ✅（除 < 10 LOC 集成胶水） |
| `test` | 测试代码 | N/A |
| `migration` | DB schema 变更 | ✅（迁移幂等性测试） |
| `refactor` | 不改行为的结构调整 | 已有测试覆盖即可 |
| `chore` | 配置 / CI / docs（罕见） | ❌ |

---

## §4 调研留痕标准

### 4.1 路径白名单（lint L1 强制）

`tasks[].files` / `migrations[].file` 必须满足以下 glob 之一：
- `src/**/*.{ts,tsx,sql}`
- `web/src/**/*.{ts,tsx,css}`
- `scripts/**/*.{ts,sh}`
- `docs/**/*.md`
- 顶层：`.gitlab-ci.yml` / `Dockerfile*` / `package.json` / `pnpm-lock.yaml` / `tsconfig*.json` / `vitest.config.*` / `vite.config.*`

**禁止**：`..` / `node_modules/` / `.git/` / 绝对路径 / 系统目录。

### 4.2 file:line 引用真实性（lint L9 / L10 强制）

- L9: tasks[].files / implementationHints.reuseFrom[].file / implementationHints.insertAt.file 在 worktree 必须真实存在
- L10: implementationHints.insertAt.afterLine / reuseFrom[].line 必须 ≤ 文件 EOF

### 4.3 调研发现 markdown 引用（lint L7 强制）

plan.md §1 调研发现段至少 3 条 markdown link：`[text](path#L行号) — 发现: ...`

### 4.4 复用 codebaseEvidence（spec 升级 §3.1 强制约束）

如 `enrichedInput.codebaseEvidence` 非空，plan-decomposer **必须复用**这些 file:line，不允许重新 grep 同一目标。如发现 reference 错误，notes 指出（健康的 double check）。

---

## §5 doneWhen 质量准则

### 5.1 反空洞词黑名单（reviewer P3 强制）

`doneWhen[]` 不允许含以下词的字符串（不区分大小写）：
- "功能正常 / 正常 / 正确 / 工作正常 / 运行正常"
- "通过 / pass / 成功 / success / works / OK / fine"
- "可以 / 能够 / 应该"
- "没问题 / 无问题"

### 5.2 客观可验定义

每条 doneWhen 必须：
- 描述**可观测**的状态（"按钮渲染在 Y 位置"、"点击触发 onClick 回调"、"localStorage 写入 key=rememberMe"）
- 不依赖主观判断（"用户体验好"❌）
- 可被 dev-loop 在 commit 时机械验证（运行测试 / grep DOM / 查 localStorage 等）

### 5.3 UE 三态覆盖（P14 强制，Phase 3 启用）

涉及 UI 的 feature task，doneWhen 必须覆盖：
- **error**：错误态（如"API 失败时显示 toast"）
- **empty**：空态（如"列表无数据显示 empty placeholder"）
- **loading**：加载态（如"提交时按钮 disabled + spinner"）
- success 默认覆盖（不强制单独列）

---

## §6 决策证据 decisions[] 准则

### 6.1 何时必填

任一即必填：
- 任务粒度选择（合并 vs 拆分）
- migration 任务设计
- 多文件影响一个 AC 时的归属
- 复用现有 helper vs 新建

### 6.2 凑数判定（reviewer P8 强制）

`decisions[].alternatives` 不能是：
- 单元素数组：`["不这么做"]`
- 极端化 strawman：`["用 Rust 重写"]`、`["不用任何库自己写"]`
- 同义反复：`["不拆"]`（如 choice="拆 T1+T2"）

---

## §7 反模式黑名单（共享）

以下行为在 plan-decomposer / plan-reviewer / product-reviewer 中均**禁止**：

1. 引用 worktree 不存在的 file:line（幻觉，lint L9/L10 兜底）
2. 列了 standardsConsulted 但 finding 不体现影响
3. tasks[].files 缺 fixture / 配置 / 测试文件（必须 git add 时全部）
4. dependsOn 引用 previousRound 中的 ID 但当轮不存在
5. decisions[].alternatives 编造未真考虑过的选项
6. plan.md 含「依赖图」/「数据库变更说明」/「风险」段（spec 已有）
7. 重新 grep `enrichedInput.codebaseEvidence` 已查证目标（违反 §4.4）
8. 凑数 selfCheck 全打勾不写 self-critique（必有 1 条"本 plan 最弱点"）

---

## §8 各 role 引用义务

| Role | 必读章节 | 引用方式 |
|---|---|---|
| plan-decomposer | §1 工程交付维度、§2 schema、§3 INVEST、§4 调研留痕、§5 doneWhen、§6 decisions、§7 反模式 | role.md 在 §1 / §5 / §11 等处标 `← qi-plan-quality.md §X` |
| plan-reviewer | §5 doneWhen 准则（P3）、§6 decisions（P8）、§7 反模式 | role.md 在 P3/P8 章节标引用 |
| product-reviewer（Phase 3）| §1 产品交付维度 (P11-P15)、§2 产品级字段、§5.3 UE 三态 | role.md 在 P11-P15 章节标引用 |
| qi-plan-lint.ts | §2 Schema（L11 worktreeHeadSha）、§3 INVEST 数字阈值（L 系列）、§4 路径白名单（L1） | 代码内注释标引用 |

**闭环验证**：`scripts/check-qi-standards-consistency.ts` 检查：
1. 三个 role.md 都引用了本文档
2. 本文档 §X 在 lint / role.md 里都被使用（无 dead chapter）
3. `PlanTaskSchema` 在 zod + qi-plan-lint.ts + 三个 role.md 中字段一致
