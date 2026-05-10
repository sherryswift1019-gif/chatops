# PRD: Quick-Impl Role 规范迭代 v2

**版本**：v0.2（拆分版）· **作者**：sherryswift1019 · **创建**：2026-05-08 · **更新**：2026-05-08

> 本文是**主索引**。详细方案拆分到 [docs/prds/quick-impl-roles-v2/](quick-impl-roles-v2/) 下 7 个 spec 文件，按主题组织。
> 实施时按 [§5 Phase × Spec 矩阵](#5-phase--spec-索引) 找到对应 phase 该读哪些 specs。

---

## 摘要

升级 `quick-impl-artifact-author` 这个底座 Skill 下的 4 个 role 规范（spec-author / plan-decomposer / dev-loop / code-quality-reviewer），让 AI 自动产出的 spec / plan / 代码 / review 报告达到"工程师正常水准"，而不是"AI 凑齐章节就过"。

### 三件大事

1. **横切层**：升级 SKILL.md 底座 + 新建 [docs/standards/](../standards/) 项目规范库 + role-manifest.json 精准注入 + stage_results 持久化 + 节点级联失效 → [02-data-flow.md](quick-impl-roles-v2/02-data-flow.md), [03-standards.md](quick-impl-roles-v2/03-standards.md)
2. **各 role 深化**：4 个 role.md 重写，引入"先澄清后撰写"、TDD 顺序、按任务 commit、引用 standards checklist、specCoverage 矩阵 → [01-roles.md](quick-impl-roles-v2/01-roles.md)
3. **评测闭环**：用 [docs/test-specs/login-remember-me.md](../test-specs/login-remember-me.md) baseline + LLM-as-judge + 三层 regression CI → [05-evaluation.md](quick-impl-roles-v2/05-evaluation.md)

### 工期

合计 5-6 天，分 6 个 Phase（含可选 Phase 5）。详见 [06-implementation.md](quick-impl-roles-v2/06-implementation.md) §1。

### Top 3 风险

| 风险 | 缓解 |
|------|------|
| Prompt 变长 → Claude 注意力稀释 | manifest 精准注入 + checklist 风格 + A/B 对照验证（[04](quick-impl-roles-v2/04-prompt-strategy.md)） |
| 流程数据未持久化（跨 round 丢失） | test_runs.stage_results JSONB 存结构化输出（[02](quick-impl-roles-v2/02-data-flow.md) §5） |
| spec round 2 改 AC 后 plan 没级联失效 | acDiff 检测 + plan 节点重置（[02](quick-impl-roles-v2/02-data-flow.md) §6） |

完整风险清单见 [07-risks-ops.md](quick-impl-roles-v2/07-risks-ops.md) §1。

---

## 1. 现状诊断

### 1.1 横切问题（4 个 role 都有）

1. **CLAUDE.md 硬约定没注入** — 项目规范（GitLab 配置 / Tool 自注册 / Schema 编号 / Repository / 前端枚举字段）4 个 role 都不知道
2. **`.qi-context/standards/` 形同虚设** — SKILL.md 提了一嘴，role 没有任何一处要求读、要求引用
3. **拒绝反馈不闭环** — round 2 拿不到上一轮的 reject_reason / reviewer notes，等于重新瞎猜
4. **JSON 输出 schema 太弱** — 除 reviewer 的 fileRisks 外都只有 summary/decision/notes，人工审批拿不到结构化决策依据

### 1.2 各 role 具体问题

#### spec-author
- 没有"先澄清后撰写"步骤 → 模糊需求直接 fail
- 章节单薄：缺非功能需求、风险与未知、回滚预案
- 验收标准格式无约束（自由文本 checkbox）
- 没要求引用 codebase 现有实现

#### plan-decomposer
- 任务粒度无量化标准
- **没强制测试任务**（容易拆 5 个开发任务 0 个测试任务）
- 数据库迁移没单独识别
- 没显式依赖图，没和 spec AC 挂钩

#### dev-loop（问题最重）
- **commit 策略错了**：实现完所有任务后一次性 commit
- "必要时 tsc"等于不强制
- 没和项目 `./test.sh` 工具链对接
- fail 之后下一轮怎么继承上一次部分 commit 没说

#### code-quality-reviewer
- 检查项太泛，没引用项目特定 checklist
- 没有 spec coverage 审查
- 范围审查缺失（是否超出 plan）

---

## 2. 设计目标（success criteria）

| # | 目标 | 验证方式 |
|---|------|---------|
| G1 | 4 个 role 输出的 JSON 都有结构化 `evidence` 字段 | 跑 evaluation harness 看输出 JSON |
| G2 | 多轮 reject 时下一轮 inputs.json 包含 previousRound 反馈 + feedback.md | 模拟 reject，看下一轮 inputs.json + worktree feedback.md |
| G3 | spec-author 模糊需求时输出 clarifications[] 而非直接 fail | 用 vague rawInput 跑测试 |
| G4 | plan-decomposer 输出 tasks[] 中每个 type=feature 配 ≥1 个 type=test | schema 校验 |
| G5 | dev-loop 输出 commits[] 数量 ≥ tasks 数量；每个 commit 都有 sha + 任务号 | git log 自动校验 |
| G6 | reviewer 输出 specCoverage[] 覆盖 spec 中所有 AC | 对照 spec AC 计数 |
| G7 | 同一 rawInput 跑 v1 vs v2，5 项主观打分平均提升 ≥ 30% | Phase 0 baseline 对比 |

---

## 3. 影响范围与通知关系人

| 团队 / 角色 | 影响 | 通知重点 |
|---|---|---|
| **后端 / Quick-Impl 维护者** | skill-runner.ts / worker.ts / graph-builder.ts / graph-runner.ts / test-runs repo 改造 | 改动集中，标准 vitest 回归 |
| **DBA** | **不动 schema** | 零影响 |
| **AI 配额** | 单 role token 增加 +180~+620%（vs v1），但一次通过率提升后总量预期持平 | Phase 1 跑完观察一周对比 |
| **公司规范文档维护者** | docs/standards/ 新建 8 篇；CLAUDE.md 后续重构为摘要 + link（Phase 5）| 后续 CLAUDE.md 改动需同步 docs/standards/，由 lint 脚本自动检查 |
| **Quick-Impl 用户** | spec / plan / review 输出格式变 | 出"如何读 v2 输出"快速指南 |
| **前端管理后台维护者** | RequirementsPage 适配新输出字段 + reject 弹窗（Phase 4） | 独立改动 |

完整风险评估 / 安全考虑 / 维护 owner 见 [07-risks-ops.md](quick-impl-roles-v2/07-risks-ops.md)。

---

## 4. 详细方案索引

| Spec | 内容 | 实施 Phase |
|------|------|-----------|
| [01-roles.md](quick-impl-roles-v2/01-roles.md) | 4 个 role 详细设计：任务步骤 / 文档结构 / 输出 JSON schema / DoD checklist | Phase 2 |
| [02-data-flow.md](quick-impl-roles-v2/02-data-flow.md) | SKILL.md 底座 / inputs.json / feedback.md / role-manifest.json / stage_results 持久化 / 节点级联失效 | Phase 1 |
| [03-standards.md](quick-impl-roles-v2/03-standards.md) | 8 篇 standards 文件预期内容 + 编写约定（必须 / 不得 / 检查方式三段式）+ CLAUDE.md 同步策略 | Phase 1 / Phase 5 |
| [04-prompt-strategy.md](quick-impl-roles-v2/04-prompt-strategy.md) | Prompt 优化 4 条已采纳（S1-S4）+ 3 条推迟（S5-S7）+ 量化预期 + A/B 对照验证 | Phase 2 / Phase 3 |
| [05-evaluation.md](quick-impl-roles-v2/05-evaluation.md) | Evaluation harness 设计 / 主观打分 / LLM-as-judge / regression CI 三层模式 | Phase 0 / Phase 3 / Phase 5 |
| [06-implementation.md](quick-impl-roles-v2/06-implementation.md) | 6 个 Phase 实施计划 + 完整文件清单 + 单元 / 集成测试覆盖 + 回滚 | 所有 Phase |
| [07-risks-ops.md](quick-impl-roles-v2/07-risks-ops.md) | 风险清单（R1-R16）+ 安全考虑（rawInput 脱敏 / 治理）+ 维护 owner 矩阵 + 决策记录 | 所有 Phase |

---

## 5. Phase × Spec 索引

实施每个 Phase 时只读对应的 specs，避免跨文件查找。

| Phase | 工作 | 必读 specs |
|-------|------|-----------|
| **0** | scripts/qi-eval.ts + baseline 报告 + judge prompt | [05](quick-impl-roles-v2/05-evaluation.md), [06](quick-impl-roles-v2/06-implementation.md) §1, §3 |
| **1** | SKILL.md v2 + standards/ 8 文件 + role-manifest.json + skill-runner / worker / graph-builder / graph-runner 改造 + stage_results 持久化 + acDiff | [02](quick-impl-roles-v2/02-data-flow.md), [03](quick-impl-roles-v2/03-standards.md), [06](quick-impl-roles-v2/06-implementation.md) §2, §3 |
| **2** | 4 个 role.md v2 + zod schema + dev-loop 细节（fix commit / vitest --related / .qi-context 检查） | [01](quick-impl-roles-v2/01-roles.md), [04](quick-impl-roles-v2/04-prompt-strategy.md) §2 |
| **3** | 重跑 evaluation；A/B 对照；调 role.md；视情况启用 S7 | [04](quick-impl-roles-v2/04-prompt-strategy.md) §5, [05](quick-impl-roles-v2/05-evaluation.md) §3 |
| **4** | 同步主 quick-impl PRD + Web UI 适配 + 第二次 reject 弹窗 | [01](quick-impl-roles-v2/01-roles.md)（输出字段）, [02](quick-impl-roles-v2/02-data-flow.md) §6（acDiff 弹窗触发条件） |
| **5（可选）** | regression CI + CLAUDE.md 重构 + lint + rawInput 脱敏 + judge 校准 | [05](quick-impl-roles-v2/05-evaluation.md) §4, [03](quick-impl-roles-v2/03-standards.md) §3, [07](quick-impl-roles-v2/07-risks-ops.md) §2.1 |

每个 Phase 的验收标准在 [06-implementation.md](quick-impl-roles-v2/06-implementation.md) §1。

---

## 6. 决策记录（2026-05-08 拍板）

- [x] **docs/standards/ 内容来源**：从 CLAUDE.md 抽取（保持单一来源）
- [x] **Phase 0 baseline case**：只跑 login-remember-me 一个
- [x] **v1/v2 切换策略**：直接替换，不做 feature flag 共存
- [x] **specCoverage 判定**：AI 自判 + 给证据，人工只做"是否同意"
- [x] **stage_results 膨胀控制**：rounds[] 只保留最近 N=2 轮完整结构
- [x] **第二次 reject 弹窗**：Phase 4 内做
- [x] **regression CI 模式**：混合三层（per-PR 不 block / nightly 3 次平均阻塞 / 周报趋势）

完整决策记录见 [07-risks-ops.md](quick-impl-roles-v2/07-risks-ops.md) §3.3。

---

## 7. 后续展望（不在本次范围）

- 把 docs/standards/ 抽象为可订阅机制，多个 skill 共享
- spec / plan 审批 UI 嵌入 specCoverage 矩阵可视化
- spec clarifications 完整 UX（"待澄清"区块 + amend 输入而非 reject）
- pipeline 节点级状态机增强：联动重置策略可配置
- LLM-as-judge prompt 自动校准

---

## 8. 文件结构总览

```
docs/prds/
├── prd-quick-impl-roles-v2.md          # 本文（主索引）
└── quick-impl-roles-v2/
    ├── 01-roles.md                     # 4 个 role 设计
    ├── 02-data-flow.md                 # 数据流 + 持久化
    ├── 03-standards.md                 # standards 8 篇内容大纲
    ├── 04-prompt-strategy.md           # prompt 优化策略
    ├── 05-evaluation.md                # 评测 + CI
    ├── 06-implementation.md            # 实施计划 + 文件清单
    └── 07-risks-ops.md                 # 风险 + 安全 + 维护
```

实施前请按 §5 Phase × Spec 矩阵找到对应 specs 阅读。每个 spec 自包含、可独立读，避免跨文件查找。
