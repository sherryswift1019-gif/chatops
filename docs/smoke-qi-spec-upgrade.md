# QI Spec Stage Upgrade — Smoke Manual

> 完成时间：2026-05-13
> Worktree branch：`worktree-spec-stage-upgrade`
> 设计文档：[design](superpowers/specs/2026-05-12-spec-stage-upgrade-design.md)
> 实施计划：[plan](superpowers/plans/2026-05-12-spec-stage-upgrade-plan.md)

## 概览

QI spec 阶段升级，将 22 节点流水线的 spec 阶段扩展为：

```
init_branch -> spec_brainstorm -> spec_author -> spec_ai_review
                                        ^              |
                                        +-- retry -----+  onFailure (aiReviewMaxRounds=3 保护)
                                                       |
                                                       v  onSuccess
                                              spec_human_gate -> spec_commit_push
                                                  ^                    |
                                                  +-- reject (REJECT_CAP=2 保护)
                                                                       v
                                                               plan_author ...
```

## 1. 数据迁移（用户自行决定时机）

清空 QI 历史执行记录（一次性）：

```bash
# 先停 backend（脚本会 abort 如果 3000 端口还在跑）
pkill -f "tsx.*src/server.ts" || true

# Dry-run 看会清什么
pnpm qi-clean

# 真清 + seed system_config qi 默认
pnpm qi-clean --yes
```

期望输出：
- `seeded system_config qi = {"aiReviewMaxRounds":3,"tokenBudgetPerRequirement":250000}`
- DB tables 清空（test_runs / checkpoints / requirements 相关执行记录）
- `/tmp/quick-impl/qi-*` worktrees 删除
- GitLab remote `feat/qi-*` branches 删除

## 2. 启动服务

```bash
# 后端（热重载）
pnpm dev

# 另一个终端，前端
cd web && pnpm dev
```

## 3. 数据库迁移

```bash
pnpm migrate
```

确认迁移包含：
- `schema-v65.sql` — retry_counters JSONB 扩展（ai_review_rounds + last_ai_review_notes）
- `schema-v1015.sql` — 同上（备注：schema-v65 与 v1015 等价，deploy 时按 SCHEMA_FILES 顺序）
- `schema-v1013.sql` — pipeline_run_state 表（brainstorm 状态持久化）
- `schema-v1014.sql` — llm_brainstorm 节点类型注册

## 4. Web 端发起需求

1. 打开 `http://localhost:5173/admin/requirements/new`
2. rawInput：`加个登录页`（或任意功能描述）
3. 提交后跳转到需求详情页

## 5. Brainstorm Tab（当前 skeleton mode）

详情页 Brainstorm Tab 展示：
- 系统提问（选项 A/B/C/D + 自由文本输入框）
- 提交后后端返回 `no_active_brainstorm_waiter`（skeleton mode 正常行为）

**注意：** `.claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md` 在 `.gitignore` 保护下，需在主仓库手动 sync 后多轮交互才完整生效（见第 8 节 deferred 工作）。

## 6. Spec Tab

需求流水线推进到 spec_author 节点后：
- Spec Tab 展示 spec.md 内容（Markdown 渲染）
- 标题区显示当前 stage + status

## 7. AI Review / 人审流程

**Approvals Tab 场景一：AI review pass**
- 展示 5 段结构摘要（问题背景 / AC 列表 / 风险 / 亮点 / 决策建议）
- 折叠区含完整 spec.md
- 决策"通过" → spec_commit_push 走 `merge --no-ff`，保留各 round 的 commits

**Approvals Tab 场景二：AI review fail 升级人工**
- 摘要顶部展示醒目 Alert（"AI reviewer 未通过"）
- 展示历次 AI review notes（round 1 / round 2 / ... 折叠）
- 人工审批人在 notes 基础上做最终决策

**AI review 回路保护：**
- 每次 AI fail → `incrementAiReviewRound` → 回到 spec_author 重写
- `aiReviewMaxRounds`（默认 3，来自 `system_config.qi`）到达上限后直接升人工，不再 retry

**人工拒绝保护：**
- `REJECT_CAP = 2`：同一节点人工拒绝超过 2 次后，流水线进入 error 状态

## 8. 故障注入：AI fail 回路（集成测试覆盖）

无法在 worktree 直接演示（role.md gitignored），但有集成测试覆盖：

```bash
# 运行 spec 阶段 E2E 集成测试
npx vitest run src/__tests__/integration/qi-spec-stage-e2e.integration.test.ts

# 运行所有 QI 相关测试
./test.sh --filter qi-
```

## 9. 测试执行

```bash
# 全套测试（约 200s+）
./test.sh

# 仅 QI 相关
./test.sh --filter qi-

# TypeScript 类型检查
./test.sh --typecheck

# 前端类型检查
cd web && pnpm build
```

## 10. 已知 deferred 工作

详见 `docs/superpowers/deferred-claude-skill-edits.md`：

| 项目 | 说明 |
|---|---|
| `.claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md` | gitignored，需在主仓库手动 sync |
| `.claude/skills/quick-impl-artifact-author/roles/spec-author.md` | enrichedInput 3 状态分支逻辑待同步 |
| `.claude/skills/quick-impl-artifact-author/roles/spec-reviewer.md` | round 2+ 逐项追踪逻辑待同步 |
| T11 token_total 写入侧 | gate 逻辑已实现，写入侧未接通（gate 暂不生效） |
| T20 buildLlmBrainstormNode | skeleton 实现，LLM 完整路径待 role.md sync 后生效 |
| T22.5 brainstorm 24h timeout integration test | 依赖完整 brainstorm path，暂 deferred |
| aiReviewMaxRounds 语义微调 | retry-limit vs review-limit 语义详见 deferred-ai-review-rounds-semantic.md |

## 11. 改动文件清单

### 新增

| 路径 | 职责 |
|---|---|
| `src/quick-impl/enriched-input-schema.ts` | brainstorm/spec-author/reviewer 共享的 zod schema |
| `src/quick-impl/qi-config.ts` | `loadQiConfig()` 读 aiReviewMaxRounds / tokenBudgetPerRequirement |
| `src/db/schema-v65.sql` | retry_counters JSONB 扩展（ai_review_rounds + last_ai_review_notes） |
| `src/db/schema-v1015.sql` | 同上（schema rename 后实际文件） |
| `src/db/schema-v1013.sql` | pipeline_run_state 表 |
| `src/db/schema-v1014.sql` | llm_brainstorm 节点类型注册 |
| `src/pipeline/node-types/llm-brainstorm.ts` | brainstorm 节点 stage type 定义 |
| `src/admin/routes/brainstorm.ts` | POST /admin/requirements/:id/brainstorm/answer |
| `src/quick-impl/brainstorm-state.ts` | advanceBrainstormState 状态机 |
| `src/quick-impl/brainstorm-parser.ts` | 5-section markdown 解析器 |
| `web/src/api/brainstorm.ts` | 前端 API 层 |
| `web/src/pages/requirement-detail/BrainstormTab.tsx` | Web 端多轮答题 UI |
| `docs/standards/qi-spec-quality.md` | spec 阶段单一规范文档 |
| `scripts/check-qi-standards-consistency.ts` | 三方规范一致性 CI lint |
| `src/__tests__/unit/qi-enriched-input-schema.test.ts` | enrichedInput schema 单测 |
| `src/__tests__/unit/qi-brainstorm-state.test.ts` | brainstorm 状态机单测 |
| `src/__tests__/unit/qi-ai-review-loop.test.ts` | AI review 自循环单测 |
| `src/__tests__/unit/qi-spec-stage-e2e-behavior.test.ts` | E2E 场景行为 smoke 测试 |
| `src/__tests__/integration/qi-spec-stage-e2e.integration.test.ts` | spec 阶段全链路 E2E |

### 修改

| 路径 | 变更要点 |
|---|---|
| `src/pipeline/graph-builder.ts` | REJECT_CAP 3→2 / handleAiReviewFailure / buildLlmBrainstormNode skeleton / buildLlmReviewNode budget gate + fail handling / spec_ai_review condition topology |
| `src/quick-impl/bootstrap.ts` | 拓扑加 spec_brainstorm 节点 + spec_ai_review 出口改条件分支 + spec_commit_push mergeStrategy + 版本 16→18 |
| `src/pipeline/node-types/git-commit-push.ts` | mergeStrategy preserve-rounds（merge --no-ff） |
| `src/pipeline/node-types/llm-review.ts` | SpecReviewOutputSchema + round 2+ 逐项追踪 |
| `src/pipeline/approval-summary/spec.ts` | 含 AI 历次 notes + contextSummary |
| `src/pipeline/approval-summary/index.ts` | spec summary dispatcher |
| `src/quick-impl/skill-runner.ts` | linkBrainstormArtifacts wire |
| `src/pipeline/im-input-agent.ts` | parseBrainstormAnswer（选项 ID + 自由文本双格式） |
| `src/scripts/qi-clean.ts` | seed system_config qi 默认 |
| `src/db/repositories/requirements.ts` | incrementAiReviewRound / getLastAiReviewNotes / getBrainstormState |
| `src/db/migrate.ts` | SCHEMA_FILES 追加新 schema |
| `src/__tests__/helpers/db.ts` | SCHEMA_FILES 追加新 schema |
| `web/src/pages/requirement-detail/index.tsx` | 加 Brainstorm Tab |
| `web/src/pages/requirement-detail/NodeApprovalView.tsx` | 含 AI 历次 notes + contextSummary 展示 |

## 12. 合并到 main 后需手动操作

1. 同步 `.claude/skills/quick-impl-artifact-author/roles/brainstorm-host.md` 到主仓库
2. 同步 `.claude/skills/quick-impl-artifact-author/roles/spec-author.md`（enrichedInput 3 状态分支）
3. 同步 `.claude/skills/quick-impl-artifact-author/roles/spec-reviewer.md`（round 2+ 逐项追踪）
4. 同步 `.claude/skills/quick-impl-artifact-author/role-manifest.json`（brainstorm-host 注册）
5. 运行 `pnpm migrate` 应用 schema-v1015/v1013/v1014
6. 可选：`pnpm qi-clean --yes` 清空历史执行记录并 seed 新默认配置
