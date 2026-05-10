# Spec 06: 实施计划与验证

> 主 PRD：[prd-quick-impl-roles-v2.md](../prd-quick-impl-roles-v2.md)
> 关联：所有其他 specs（每个 Phase 引用对应 specs）

本文是实施总纲：6 个 Phase 的工作量、产出、验收 + 完整文件清单 + 单元 / 集成测试覆盖。

执行任何一个 Phase 前先读本文 §1，找到对应 Phase 引用的 specs 再读。

---

## 1. Phase 计划与依赖

| Phase | 工作量 | 主要产出 | 依赖 specs |
|-------|--------|---------|-----------|
| **0** | 0.5 天 | scripts/qi-eval.ts + login-remember-me baseline 报告 + judge prompt | [05-evaluation.md](05-evaluation.md) |
| **1** | 1.5 天 | SKILL.md v2 + docs/standards/ 8 文件 + role-manifest.json + skill-runner 改造 + stage_results 持久化 + acDiff 检测 | [02-data-flow.md](02-data-flow.md) + [03-standards.md](03-standards.md) |
| **2** | 2 天 | 4 个 role.md v2（按 [01-roles.md](01-roles.md) 落地）+ zod schema + dev-loop fix commit / vitest --related / .qi-context 检查 | [01-roles.md](01-roles.md) + [04-prompt-strategy.md](04-prompt-strategy.md) |
| **3** | 1 天 | 重跑 evaluation；A/B 对照（manifest 精准 vs 一股脑）；调 role.md 细节；视情况启用 S7 | [04-prompt-strategy.md](04-prompt-strategy.md) + [05-evaluation.md](05-evaluation.md) |
| **4** | 0.5 天 | 同步主 quick-impl PRD §标准准备清单 + Web UI 适配新输出字段 + 第二次 reject 弹窗 | [01-roles.md](01-roles.md)（输出字段）+ [02-data-flow.md](02-data-flow.md) §6（acDiff 触发条件） |
| **5（可选）** | 1 天 | regression CI 接入 + CLAUDE.md 重构 + lint 脚本 + rawInput 脱敏 + judge prompt 校准 | [05-evaluation.md](05-evaluation.md) §4 + [03-standards.md](03-standards.md) §3 + [07-risks-ops.md](07-risks-ops.md) §2.1 |

合计 5-6 天（含 Phase 5）。Phase 0/1 串行；Phase 1/2 内部子任务可并行；Phase 5 可在 Phase 3 后另派。

### Phase 验收标准

#### Phase 0
- `docs/qi-eval-baseline.md` 落盘
- 5 项主观打分（每个 role）
- JSON schema 校验脚本可跑
- artifact 一致性校验脚本可跑

#### Phase 1
- 跑 baseline case：inputs.json 含 previousRound（手工触发 round 2），feedback.md 生成正确
- spec round 2 改 AC 触发 plan 节点重置（手工验证）
- test_runs.stage_results 写入结构化 skillOutput（DB 查询验证）
- manifest zod 校验：故意写错 standards 名 → fail-fast
- spec-author 只 symlink 1 篇 standards（手工 ls 验证）

#### Phase 2
- 跑 baseline case，4 个 role 输出都通过 schema + 一致性校验
- dev-loop round 2 不重做已 commit 任务（git log + skippedTasks[] 验证）
- reviewer 检测到 .qi-context/ 改动 → 标 fail

#### Phase 3
- `docs/qi-eval-v2.md` 落盘
- 主观分提升 ≥ 30%（v2 vs v1 baseline）
- A/B 对照：B 不输 A 且 token 显著少
- 如 S7 启用，二次评测分数提升

#### Phase 4
- UI 能展示 specCoverage 矩阵 + commits 列表 + acceptanceCriteria 列表 + openQuestions
- spec round ≥ 2 改 AC 时弹"会触发 plan 重做，确认继续？"对话框
- clarifications/openQuestions 展示为可输入区块（C3 占位，暂不闭环）
- 弹窗触发条件可单测

#### Phase 5
- role.md / standards / manifest 改动触发 CI 评测
- CLAUDE.md 与 docs/standards/ 不漂移（lint 通过）
- rawInput 脱敏：含 GitLab token 的输入命中正则 + 替换 + warning log
- judge prompt 校准：人工打分 vs LLM-as-judge 差异 ≤ 1 分

---

## 2. 文件清单

### 2.1 新建

| 路径 | 内容 | 来源 spec | Phase |
|------|------|----------|-------|
| `docs/prds/prd-quick-impl-roles-v2.md` | 主索引 | 本 PRD | 0 |
| `docs/prds/quick-impl-roles-v2/01-roles.md` | role 设计 | 01 | 0 |
| `docs/prds/quick-impl-roles-v2/02-data-flow.md` | 数据流 | 02 | 0 |
| `docs/prds/quick-impl-roles-v2/03-standards.md` | standards 内容大纲 | 03 | 0 |
| `docs/prds/quick-impl-roles-v2/04-prompt-strategy.md` | prompt 策略 | 04 | 0 |
| `docs/prds/quick-impl-roles-v2/05-evaluation.md` | 评测 + CI | 05 | 0 |
| `docs/prds/quick-impl-roles-v2/06-implementation.md` | 实施（本文）| 06 | 0 |
| `docs/prds/quick-impl-roles-v2/07-risks-ops.md` | 风险/安全/维护 | 07 | 0 |
| `.claude/skills/quick-impl-artifact-author/role-manifest.json` | 精准注入声明 | 02 §4 | 1 |
| `docs/standards/gitlab-config.md` | GitLab 配置标准 | 03 §2.1 | 1 |
| `docs/standards/tool-registration.md` | Tool 自注册标准 | 03 §2.2 | 1 |
| `docs/standards/db-schema-versioning.md` | Schema 编号标准 | 03 §2.3 | 1 |
| `docs/standards/repository-pattern.md` | Repository 标准 | 03 §2.4 | 1 |
| `docs/standards/frontend-enum-select.md` | 前端枚举字段标准 | 03 §2.5 | 1 |
| `docs/standards/commit-conventions.md` | commit 标准 | 03 §2.6 | 1 |
| `docs/standards/test-conventions.md` | 测试标准 | 03 §2.7 | 1 |
| `docs/standards/code-style.md` | 代码风格标准 | 03 §2.8 | 1 |
| `scripts/qi-eval.ts` | 评测脚本 | 05 §1.2 | 0 |
| `scripts/qi-eval-judge-prompt.md` | LLM-as-judge prompt | 05 §2 | 0 |
| `scripts/qi-standards-lint.ts` | CLAUDE.md vs standards 漂移检查 | 03 §3 | 5 |
| `docs/qi-eval-baseline.md` | Phase 0 产出 | 05 §1 | 0 |
| `docs/qi-eval-v2.md` | Phase 3 产出 | 05 §1 | 3 |

### 2.2 修改

| 路径 | 改动 | 来源 spec | Phase |
|------|------|----------|-------|
| `.claude/skills/quick-impl-artifact-author/SKILL.md` | 底座升级（错误处理 / previousRound / standards 引用 / 自检 / 输出 schema 共性）| 02 §1 | 1 |
| `.claude/skills/quick-impl-artifact-author/roles/spec-author.md` | v2 重写 | 01 §1 | 2 |
| `.claude/skills/quick-impl-artifact-author/roles/plan-decomposer.md` | v2 重写 | 01 §2 | 2 |
| `.claude/skills/quick-impl-artifact-author/roles/dev-loop.md` | v2 重写 | 01 §3 | 2 |
| `.claude/skills/quick-impl-artifact-author/roles/code-quality-reviewer.md` | v2 重写 | 01 §4 | 2 |
| [src/quick-impl/skill-runner.ts](../../../src/quick-impl/skill-runner.ts) | 按 manifest symlink + feedback.md + worktree gitignore + appendStageResult + acDiff | 02 §4-6 | 1 |
| [src/quick-impl/worker.ts](../../../src/quick-impl/worker.ts) | 多轮触发透传 reject_reason；rawInput 入队前脱敏（Phase 5）| 02 §3, 07 §2.1 | 1 / 5 |
| [src/pipeline/graph-builder.ts](../../../src/pipeline/graph-builder.ts) `buildSkillWithApprovalNode` | 写 inputs.previousRound；从 stage_results 读上游蒸馏字段 | 02 §3, §5 | 1 |
| [src/pipeline/graph-runner.ts](../../../src/pipeline/graph-runner.ts) `resumeFromQiApproval` | 检查 acDiff，触发 plan 节点重置 | 02 §6 | 1 |
| [src/db/repositories/test-runs.ts](../../../src/db/repositories/test-runs.ts) | 新增 `appendStageResult(testRunId, stageIdx, result)` | 02 §5 | 1 |
| `.claude/CODEOWNERS`（如不存在则新建）| 标记 manifest / standards 配置文件 owner | 07 §2.2 | 5 |
| [CLAUDE.md](../../../CLAUDE.md) | 8 块约定改写为摘要 + link | 03 §3 | 5 |
| [web/src/pages/RequirementsPage.tsx](../../../web/src/pages/RequirementsPage.tsx) | 展示 specCoverage / commits / acceptanceCriteria / openQuestions + reject 弹窗 | 01 输出 schema | 4 |

### 2.3 不动

- DB schema（test_runs.stage_results 已有 JSONB 列，无需新表 / 新列）
- pipeline graph 结构（4 个节点类型不变）
- 现有 quick-impl pipeline 逻辑（除 skill-runner / graph-builder / graph-runner）

---

## 3. 单元测试覆盖

### 3.1 skill-runner.ts 测试

- manifest 子集 symlink 正确（spec-author 只 1 篇 / dev-loop 全部 8 篇）
- feedback.md 内容正确（含 reject reason / reviewer notes / 上一轮 artifact 路径）
- manifest zod 校验：standards 字段值不存在时 fail-fast
- manifest 加载失败 fallback：文件缺失 / 格式错 → 降级到一股脑 + warning log
- `.qi-context/` 已加入 worktree gitignore
- appendStageResult 写入 test_runs.stage_results（含 rounds[] 累积逻辑）
- rounds[] 膨胀控制：N=2 时第 3 轮把 round 1 裁剪为摘要
- diffAcceptanceCriteria 在 AC 增 / 删 / 改时返回非空 diff
- inputs.json 字段过滤：manifest 未声明的字段不出现

### 3.2 输出 JSON schema 测试

每个 role 一组 fixture（pass / fail / 边界 case）：
- spec-author（含 clarifications 场景）
- plan-decomposer（含 migrations 场景）
- dev-loop（含 round 2 fix commit + skippedTasks 场景）
- code-quality-reviewer（含 specCoverage 全覆盖 + 部分缺失场景）

### 3.3 一致性校验测试

- spec.md 第 4 节 AC 数量 vs JSON `acceptanceCriteria[]` 数量
- plan.md 任务编号 vs JSON `tasks[]` id

### 3.4 manifest 三方一致测试

扫 `docs/standards/` 实际文件 + `role-manifest.json` standards 字段 + role-specific consume 列表（`01-roles.md` 每个 role 的 standards 引用 inline 列表），三方一致。

### 3.5 rawInput 脱敏测试（Phase 5）

每种正则规则一组 fixture：
- GitLab token: `glpat-xxxx...` → `[REDACTED:gitlab-token]`
- API key: `sk-xxxx...` → `[REDACTED:api-key]`
- 内网 IP: `10.0.0.1` → `[REDACTED:internal-ip]`

---

## 4. 集成测试场景

### 4.1 完整 quick-impl pipeline（用 login-remember-me case）

跑一遍端到端，验证：
- 7 个节点都正常执行
- stage_results 每个节点都有 skillOutput 写入
- 最终 MR 创建成功

### 4.2 spec round 2（人工 reject round 1）

- round 1 输出 spec → 人工 reject（带 reject reason "缺少 localStorage 清除时机说明"）
- round 2 spec-author 看 feedback.md，针对性修订
- stage_results 包含 round 1 + round 2 两份记录

### 4.3 spec round 2 改 AC（级联失效）

- round 1 输出 AC-1/2/3
- round 2 输出 AC-1/2/4（删 3 加 4）
- 验证：
  - acDiff 写入 stage_results
  - plan 节点状态被重置
  - plan-decomposer round 2 拿到 acDiff，重拆涉及变更 AC 的任务

### 4.4 dev-loop round 2（追加 fix commit）

- round 1 输出 commits=[T1, T2, T3]
- reviewer 标记 T2 文件有 bug，fail
- round 2 dev-loop：
  - T1, T3 进 skippedTasks（reason: "round 1 已 commit 且 reviewer 未标记"）
  - T2 添加新 fix commit（不 reset / 不 amend）
- 验证 git log: T1 / T2 / T3 / T2-fix 四个 commit 顺序

### 4.5 dev-loop 误改 .qi-context/

- 模拟 dev-loop `git add -A` 试图带入 `.qi-context/feedback.md`
- 验证 .gitignore 拦截
- 即使绕过 gitignore（手工 git add -f），reviewer 检测到 .qi-context/ 改动 → 标 fail

---

## 5. Token 消耗监控

Phase 1 上线后第一周日报每需求 token 消耗，对比迭代前。

**重点关注完成同一需求的累计 token**（含多轮 reject），不只看单轮。

监控指标：
- 单 role 单次平均 token（spec-author / plan-decomposer / dev-loop / reviewer）
- 单需求累计 token（含所有 round + 所有节点）
- vs v1 同期对比

如果累计 token 涨幅 > 30%，回看是否：
- manifest 配置不够精准（某 role 拿了不必要的 standards）
- 多轮 reject 频率上升（v2 反而更难通过）

无论哪种都要 Phase 3 评测复盘。

---

## 6. 部署 / 回滚

### 部署

- 直接合 PR，role.md / standards / manifest 是配置文件，不需要 DB 迁移
- skill-runner.ts 改动需要重启 chatops 服务
- worker.ts / graph-builder.ts / graph-runner.ts 同上

### 回滚

- v2 出问题：`git revert` 即回到 v1
- skill-runner.ts 设计了 manifest 加载兜底（文件不存在降级到一股脑），所以单独 revert manifest.json 也能正常工作
- DB 不需要回滚（stage_results 新字段都是 optional）
