# Impl: spec-author v3 实施细节

**作者**：sherryswift1019 · **创建**：2026-05-09 · **状态**：M1-M4 代码完成 / 等部署灰度

> 产品决策见 [prd-spec-author-v3.md](prd-spec-author-v3.md) · 后人接手：从 §3 文件改动清单 + §6 关键 file:line 索引开始

---

## 1. 实施现状（截至 2026-05-09）

### 已完成（本地）

| Milestone | sub-task | 产物 | 测试 |
|---|---|---|---|
| **M1** | qi-spec-lint.ts (12 规则) + role-output-schemas.ts v3 升级 + fixture 4 份 + .gitlab-ci.yml 加 lint job (warn-only) | 脚本 380 LOC | 20 lint + 12 schema |
| **M2** | role.md v2 → v3（266→396 行）+ V2StructuredView 加 5 段渲染 + rehype-raw/sanitize 依赖 + qi-eval 实跑 v3 baseline | role 提示词 + V2 渲染 | qi-eval pass + 17 helpers 不退化 |
| **M3** | approval-summary 模块（5 文件）+ graph-builder 替换 + IM 改造 + useSearchParams openWaiter + MarkdownViewer rehypeRaw + skill-runner feedback.md 加 prev 段 | 600+ LOC 新模块 | 19 builder + 4 manager + 6 DB meta merge |
| **M4** | plan-decomposer.md 加 specNoGos 三段（W4 warn-only）+ v3 baseline JSON 落地 | prompt 改动 | 复用 M3 测试 |

**总体**：78 单测全过 + tsc 前后端干净。

### 部署阶段必做（不能本地做）

| sub-task | 阻塞原因 | 后续动作 |
|---|---|---|
| M3.10 staging 端到端冒烟 | 需起 dev 服务 + 真创建 requirement 走 pipeline | 部署到 staging + 前端 sanitize 实测 `<table>` 正常渲染 |
| M3.11 prod 灰度三步 | 10% → 50% → 100% 各 24h + SQL 监控 | 按 §5 灰度时序执行；任一健康指标超阈值回滚 `QI_SPEC_V3_SUMMARY_PERCENT=0` |
| M4.1 灰度 100% | 依赖 M3.11 通过 | flag 全量 |
| M4.2 移除 feature flag 代码 | 必须 100% 灰度通过才安全删 | `grep -r 'QI_SPEC_V3_SUMMARY' src/` 命中 0 |
| M4.3 qi-spec-lint CI 硬阻断 | 需 W3 误报率观察 < 5% | `.gitlab-ci.yml` 删 `allow_failure: true` |
| W5 plan-decomposer specNoGos 切硬 | warn-only 跑 1 周观察 | 单独 PR 改 plan-decomposer.md DoR 触发条件 |

---

## 2. 架构图

```
spec-author v3 LLM 跑完 → 产出 JSON + spec.md
                           │
                           ▼
                graph-builder.ts 1316-1369
                  ├─ parseFencedJsonFromRaw → extendedOutput
                  ├─ diffAcceptanceCriteria → acDiff
                  ├─ 计算 usesV3SummaryForMeta（基于 env / 缓存）
                  └─ appendStageResult 落盘 skillOutput + acDiff + meta
                                        │
                                        ▼
                graph-builder.ts 1380-1465 createWaiter contextSummary IIFE
                  ├─ baseApprovalKind === 'final'  → buildFinalApprovalSummary
                  ├─ baseApprovalKind === 'plan'   → readFileSync(plan.md) [未改]
                  └─ baseApprovalKind === 'spec/escalation':
                       if usesV3Summary → buildSpecApprovalSummary({skillOutput, specMd, round, acDiff, feedbackMd, prevSkillOutput})
                       else → readFileSync(spec.md)（兜底）
                                        │
                                        ▼ {web, im}
                          waiters.context_summary = web
                          interruptPayload.imSummary = im（闭包传出）
                                        │
                          ┌─────────────┴─────────────┐
                          ▼                           ▼
                graph-runner.ts dispatchInterrupt    Web Modal
                  → sendQiApprovalCard               RequirementsPage
                     (imSummary 优先 / contextSummary 1500 截断兜底)   useSearchParams ?id=N&openWaiter=M
                     URL: ?id=N&openWaiter=M         → 自动弹决策 Modal
```

---

## 3. 文件改动清单

### 3.1 新增（10 个文件）

| 路径 | LOC | 用途 |
|---|---|---|
| `scripts/qi-spec-lint.ts` | 380 | spec-author v3 输出 12 lint 规则 CLI |
| `src/__tests__/fixtures/spec-author/v3-minimal.json` | 50 | 最小合法 v3 输出 fixture |
| `src/__tests__/fixtures/spec-author/v3-full.json` | 100 | 全字段 v3 fixture（含 reviewHints / noGos / scenarios）|
| `src/__tests__/fixtures/spec-author/v2-legacy.json` | 50 | 老 V2-B 评测产出（schemaVersion 缺，跳过 v3 superRefine）|
| `src/__tests__/fixtures/spec-author/v3-rejected.json` | 30 | 反例 fixture（缺 self-critique / 全 fact clarifications）|
| `src/__tests__/unit/qi-spec-lint.test.ts` | 230 | 20 lint 用例（含 L9 ±5 行容忍 / `--report` / `--json`）|
| `src/__tests__/unit/role-output-schemas.test.ts` | 200 | 12 schema 兼容性用例（v3 正面 / v3 反面 / v2 老数据）|
| `src/__tests__/unit/spec-summary-builder.test.ts` | 290 | 19 builder 用例（hint 三档 / IM ≤ 250 / 折叠区 / 性能 < 50ms）|
| `src/__tests__/unit/qi-approval-manager-v3.test.ts` | 110 | 4 IM 卡片用例（imSummary 优先 / 1500 兜底 / openWaiter URL）|
| `src/__tests__/integration/test-runs-meta-merge.test.ts` | 180 | 6 DB 集成测（meta 浅合并 / 缺失不清空 / rounds + meta 独立合并）|
| `src/pipeline/approval-summary/i18n.ts` | 35 | 中文文案常量 + severityOrder |
| `src/pipeline/approval-summary/shared.ts` | 96 | computeHeuristicHint / parseFeedbackForSummary / truncateImSummary / formatStandard / riskIcon |
| `src/pipeline/approval-summary/spec.ts` | 200 | buildSpecApprovalSummary 主函数（5 段摘要 + 折叠区 + IM ≤ 250）|
| `src/pipeline/approval-summary/final.ts` | 110 | buildFinalApprovalSummary（从 graph-builder.ts:1354-1418 抽出）|
| `src/pipeline/approval-summary/index.ts` | 25 | 路由 + 公共 helper 导出 |
| `docs/qi-eval-2026-05-09-spec-author-v3-A.json` | — | v3 baseline 评测产物 |
| `docs/prds/prd-spec-author-v3.md` | 200 | 本次升级产品 PRD |
| `docs/prds/impl-spec-author-v3.md` | — | 本文档 |

### 3.2 修改（11 个文件）

| 路径 | 行号 | 改动概要 | 兼容性 |
|---|---|---|---|
| `.claude/skills/quick-impl-artifact-author/roles/spec-author.md` | 全文（266→396）| v3 prompt 重写：顶部加 schemaVersion + Lens 矩阵；JSON schema 模板加 v3 字段；新增 4 章节（reviewHints 怎么写 / clarifications.kind 决策树 / confidenceLevel 自评 / selfCheck 瘦身）；DoD 12 条精简到 3 条主观 | 老 in-flight pipeline 不影响（schemaVersion 缺时跳过 v3 superRefine） |
| `.claude/skills/quick-impl-artifact-author/roles/plan-decomposer.md` | §2.1 / §3 / §5 | 加 `specNoGos` 输入字段（§2.1） + DoR 触发模板（§3）+ Step 1 反向约束（§5）；W4 warn-only 上线策略 | bootstrap.ts 已透传 spec 整对象，spec.noGos 天然可读，无需改 graph-builder |
| `src/quick-impl/role-output-schemas.ts` | L60-114 | ClarificationSchema 加 kind/userMayDisagreeIf；新增 ReviewHintSchema/NoGoSchema；EvidenceSchema 升级为 union（兼容老 string[] 和老 selfCheck mechanical 形态）；SpecAuthorOutputSchema 加 schemaVersion/confidenceLevel/reviewHints/noGos；superRefine 仅 schemaVersion='v2' 触发 3 条 v3 约束 | 全 optional + union；v2 老数据 parse pass |
| `src/quick-impl/skill-runner.ts` | L227-302 | PreviousRoundData 加 prevReviewHints/prevAssumptions；renderFeedbackMarkdown 加两段渲染 | 全 optional 字段 |
| `src/pipeline/graph-builder.ts` | L43-46 / L1228-1465 | 加 import approval-summary；提取 prevSkillOutput；appendStageResult 加 metaPatch（含 usesV3Summary 缓存）；createWaiter contextSummary IIFE 替换为 buildSpec/FinalApprovalSummary；interruptPayload 加 imSummary | feature flag 路由：env 缺/false 时走老 readFileSync 兜底 |
| `src/pipeline/graph-runner.ts` | L460-470 | sendQiApprovalCard 调用加 imSummary 透传 | 老调用方零影响（imSummary 缺则降级走老逻辑）|
| `src/pipeline/qi-approval-manager.ts` | L47-119 | sendQiApprovalCard 签名加 imSummary；body 优先 imSummary 否则降级 contextSummary 1500 截断；URL 加 `&openWaiter=N` | 旧链接 `?id=N` 仍可用 |
| `src/db/repositories/test-runs.ts` | L42-46 / L180-185 / L221 | StageResult 加 `meta?: Record<string, unknown>`；AppendStageResultPatch 加 meta；浅合并语义（防 P0-2 类 bug） | 老数据无 meta 字段，新代码处理 undefined |
| `web/src/api/requirements.ts` | L73-119 | skillOutput 类型加 v3 字段；evidence 升级为 union | 全 optional |
| `web/src/pages/RequirementsPage.tsx` | L1-15 / L84-285 / L600-650 / L1010-1110 | V2StructuredView 加 5 段渲染（reviewHints/acDiff/standardsConsulted/selfCheck/noGos）+ clarifications 加 kind/userMayDisagreeIf 显示；useSearchParams + 2 useEffect 处理 ?id=N&openWaiter=M；2 处直接 ReactMarkdown 统一到 MarkdownViewer | 老 waiter 行（spec.md 整篇）仍正常渲染 |
| `web/src/components/MarkdownViewer.tsx` | 全文 | 加 rehypeRaw + rehypeSanitize（allowlist 含 details/summary/table/code className="language-*"）| 默认 GitHub schema + 加 details/summary tag |
| `web/package.json` | deps | 加 rehype-raw 7.0 + rehype-sanitize 6.0 | bundle +60KB |
| `.gitlab-ci.yml` | L194-237 | 加 qi-spec-lint job（warn-only 灰度）+ rules.changes 触发 | allow_failure: true（W4 后改 false）|

---

## 4. 关键接口签名

### `buildSpecApprovalSummary` (核心函数)

```ts
// src/pipeline/approval-summary/spec.ts
export function buildSpecApprovalSummary(args: {
  skillOutput: SpecAuthorOutput | null   // null → 降级 spec.md 截断
  specMdContent: string                  // 折叠区底部完整 spec.md
  round: number
  acDiff?: AcDiff | null
  feedbackMd?: string | null             // round 2+ 时上轮反馈
  prevSkillOutput?: SpecAuthorOutput | null   // round 2+ assumption 去重（暂未启用）
  budgetExtended?: boolean
}): { web: string; im: string }
```

边界规则：
- `reviewHints` 显示前 5 条 + "另有 N 条详见折叠区"
- `noGos` 显示前 8 条
- `assumptions` 表格 ≤ 6 行
- `spec.md > 50KB` 时 `<details>` 不带 `open`（默认收起防 ReactMarkdown 卡顿）
- IM 摘要硬限 ≤ 250 字符

启发式 hint 优先级：`reviewHints.high > risks.high > round≥3 > confidenceLevel='high'`

### `qi-spec-lint` 12 规则

| ID | 规则 | 触发条件 |
|---|---|---|
| L1 | references 路径白名单 | 拒 `..` / `node_modules` / 绝对路径 |
| L2 | AC id 唯一 + `^AC-\d+$` | 重复 / 格式错 |
| L3 | AC text Given-When-Then | 不匹配 `/^Given .+[,，]\s*When .+[,，]\s*Then /` |
| L4 | e2eScenarios 数量 ∈ [1,5] + ≥1 negative + ID kebab-case | 越界 / 全 happy / 大写 ID |
| L5 | 每个 AC.id 都被 scenarios.coversAC 引用 | 未覆盖 |
| L6 | scenarios.steps 反模式黑名单 | 含"应该/应当/正常/理论上"（"正确"已移除避免误杀"正确密码"）|
| L7 | scenarios.acceptance 反模式 | trim 后等于"通过/成功/OK/正常/完成"单字 |
| L8 | risks 非空 + 拒"无明显风险" | 含"无明显/风险/任何" |
| L9 | references file:line 容忍 ±5 行 | warn-only |
| L10 | spec.md §4/§5/§7/§8 项数对齐（需 --spec-md）| 章节项数 ≠ JSON 字段长度 |
| L11 | clarifications ≥ 1 条 kind=assumption | v3 仅在 schemaVersion='v2' 时强校验 |
| L12 | selfCheck.length ≤ 3 + ≥ 1 条 self-critique 关键词 | v3 仅在 schemaVersion='v2' 时强校验 |

CLI：`--spec` 必填 / `--spec-md` 可选 / `--worktree` 可选 / `--report` warn-only / `--json` 机器可读 · 退出码 0/1/2

---

## 5. 灰度时序 + 监控 SQL

### 5.1 4 周时序

| 周 | Milestone | 内容 | flag 状态 |
|---|---|---|---|
| W1 | M1 | qi-spec-lint warn-only + schema 升级 + 前端类型扩展 | flag 默认 false；CI lint allow_failure |
| W2 | M2 | role.md v3 + V2StructuredView + rehype 依赖 + 巡检 | flag 仍 false |
| W3 | M3 | 摘要 + Modal/IM 灰度三步：staging 100% → prod 10% (24h) → 50% (24h) → 100% (24h) | `QI_SPEC_V3_SUMMARY=true`；`PERCENT` 阶梯 |
| W4 | M4 | qi-spec-lint 硬阻断 + 移 flag + plan-decomposer specNoGos warn-only + 评测出 v3 baseline | flag 删除 |
| W5 | follow-up | plan-decomposer specNoGos 切硬 reject_input | — |

### 5.2 灰度健康指标 SQL（M3.11 期间手动跑）

```sql
SELECT
  COUNT(*) FILTER (WHERE sr->'meta'->>'zodParseStatus' = 'failed')::float
    / NULLIF(COUNT(*), 0) AS fail_rate,
  COUNT(*) FILTER (WHERE sr->'meta'->>'summaryFallback' = 'true')::float
    / NULLIF(COUNT(*), 0) AS fallback_rate,
  AVG((sr->'meta'->>'reviewHintsCount')::int) AS avg_hints,
  COUNT(*) FILTER (WHERE sr->'meta'->>'confidenceLevel' = 'high')::float
    / NULLIF(COUNT(*), 0) AS high_confidence_ratio
FROM test_runs, jsonb_array_elements(stage_results) AS sr
WHERE sr->>'name' = 'spec_review_loop'
  AND started_at > NOW() - INTERVAL '1 hour';
```

阈值（任一超阈值 → `QI_SPEC_V3_SUMMARY_PERCENT=0` 立即停止灰度）：
- `fail_rate` < 5%
- `fallback_rate` < 10%
- `avg_hints` ∈ [0.5, 3]（低于 0.5 说明全 0；高于 3 说明凑数）
- `high_confidence_ratio` < 0.95（all-high 异常）

### 5.3 数据库一致性检查（W3 期间）

```sql
-- 期望 5+ 行含 "## 本次评估"
SELECT context_summary FROM requirement_approval_waiters
WHERE created_at > '<flag-on-time>'
  AND approval_kind = 'spec'
ORDER BY id DESC LIMIT 5;

-- 灰度期外的 spec waiter 不应有 v3 摘要
SELECT id FROM requirement_approval_waiters
WHERE approval_kind = 'spec'
  AND context_summary NOT LIKE '%本次评估%'
  AND created_at > '<flag-on-time>'
  AND requirement_id % 100 < <PERCENT>;  -- 应为 0 行
```

---

## 6. 关键文件 file:line 索引（实施 / 调试时跳转）

| 改动主题 | 路径 + 行 |
|---|---|
| schema 升级 | [src/quick-impl/role-output-schemas.ts:60-200](../../src/quick-impl/role-output-schemas.ts#L60) |
| graph-builder 摘要替换 | [src/pipeline/graph-builder.ts:1380-1465](../../src/pipeline/graph-builder.ts#L1380) |
| graph-builder appendStageResult 加 meta | [src/pipeline/graph-builder.ts:1320-1369](../../src/pipeline/graph-builder.ts#L1320) |
| graph-builder feature flag 路由 | [src/pipeline/graph-builder.ts:1340-1351](../../src/pipeline/graph-builder.ts#L1340) |
| graph-builder interruptPayload imSummary | [src/pipeline/graph-builder.ts:1466-1480](../../src/pipeline/graph-builder.ts#L1466) |
| graph-runner imSummary 透传 | [src/pipeline/graph-runner.ts:443-471](../../src/pipeline/graph-runner.ts#L443) |
| qi-approval-manager IM body | [src/pipeline/qi-approval-manager.ts:47-119](../../src/pipeline/qi-approval-manager.ts#L47) |
| skill-runner feedback.md 加 prev 段 | [src/quick-impl/skill-runner.ts:227-302](../../src/quick-impl/skill-runner.ts#L227) |
| StageResult.meta 浅合并 | [src/db/repositories/test-runs.ts:42-46, 180-221](../../src/db/repositories/test-runs.ts#L42) |
| role prompt | [.claude/skills/quick-impl-artifact-author/roles/spec-author.md](../../.claude/skills/quick-impl-artifact-author/roles/spec-author.md) |
| plan-decomposer specNoGos | [.claude/skills/quick-impl-artifact-author/roles/plan-decomposer.md:31-42, 73, 120](../../.claude/skills/quick-impl-artifact-author/roles/plan-decomposer.md#L31) |
| approval-summary 模块 | [src/pipeline/approval-summary/](../../src/pipeline/approval-summary/) |
| V2StructuredView 5 段渲染 | [web/src/pages/RequirementsPage.tsx:84-285](../../web/src/pages/RequirementsPage.tsx#L84) |
| useSearchParams openWaiter | [web/src/pages/RequirementsPage.tsx:600-650](../../web/src/pages/RequirementsPage.tsx#L600) |
| Modal Spec MarkdownViewer 统一 | [web/src/pages/RequirementsPage.tsx:1010-1110](../../web/src/pages/RequirementsPage.tsx#L1010) |
| MarkdownViewer rehype-raw + sanitize | [web/src/components/MarkdownViewer.tsx](../../web/src/components/MarkdownViewer.tsx) |
| API DTO v3 字段 | [web/src/api/requirements.ts:73-119](../../web/src/api/requirements.ts#L73) |
| qi-plan-lint 范式参考 | [scripts/qi-plan-lint.ts](../../scripts/qi-plan-lint.ts) |
| waiters 表 schema | [src/db/schema-v60.sql:42](../../src/db/schema-v60.sql#L42) |

---

## 7. 测试矩阵

### 7.1 单测（本地可跑）

```bash
# 准备本地测试库（Docker 不可用时；本地有 PostgreSQL）
psql -d chatops_test -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public; \
  CREATE TABLE chatops_test_db_marker (id INT PRIMARY KEY); \
  INSERT INTO chatops_test_db_marker (id) VALUES (1)"

# 跑全套 v3 测试
export CI=true NODE_ENV=test DATABASE_URL="postgresql://$(whoami)@localhost:5432/chatops_test"
pnpm exec vitest run \
  src/__tests__/unit/qi-spec-lint.test.ts \
  src/__tests__/unit/role-output-schemas.test.ts \
  src/__tests__/unit/spec-summary-builder.test.ts \
  src/__tests__/unit/qi-approval-manager-v3.test.ts \
  src/__tests__/integration/test-runs-meta-merge.test.ts \
  web/src/pages/requirements-helpers.test.ts
# 期望：78 测试全过
```

### 7.2 评测（消耗 token）

```bash
pnpm exec tsx scripts/qi-eval.ts --role spec-author --case login-remember-me --mode v2-compact --execute
# 期望：decision=pass / consistency ✓ / schema validation ✓
# 输出：docs/qi-eval-2026-05-09-spec-author-v2-compact.json
# 与基线对照：v3 vs V2-B 23/25 不退化
```

### 7.3 端到端冒烟（部署后）

```
1. pnpm dev          # 起后端
2. cd web && pnpm dev
3. admin Web 创建 QI requirement
4. 等到 spec_review_loop → 浏览器打开 /requirements
5. 验证：
   - Modal 顶部 5 段摘要（"本次评估"/"需要 review 的点"/"LLM 替你做的决定"）
   - <details> 折叠区可展开
   - V2StructuredView 含 reviewHints/acDiff/noGos 段
6. 拒绝 → 等 round 2 → 验摘要含"Round 2 变化"段
7. 复制 ?id=N&openWaiter=M 到新窗口 → 自动弹决策 Modal
8. 钉钉/飞书收到的卡片 body ≤ 250 字符
```

---

## 8. 回滚策略

| Milestone | 回滚方式 |
|---|---|
| M1 lint 上 CI | `git revert` lint commit；DB 不动；`.gitlab-ci.yml` allow_failure 已 true |
| M2 schema + role.md | role.md 由 LLM 读，无运行时；schema 是纯加 optional 字段，老数据不需要回滚 |
| M3 摘要 + Modal/IM | `QI_SPEC_V3_SUMMARY_PERCENT=0` 1 行 env 翻转回滚；DB 中已落入的新 contextSummary 行不主动回写（前端能正常渲染） |
| M4 硬阻断 | `.gitlab-ci.yml` qi-spec-lint job allow_failure 翻 true |

无任何 schema-vN.sql 迁移；waiters 表 / stage_results JSONB 列结构零变更。

---

## 9. 工期细化（实际 vs 估算）

| Milestone | plan 估算 | 实际 |
|---|---|---|
| M1 (W1) | 4.25d | ~3d（fixture 集中节省时间）|
| M2 (W2) | 3.6d | ~2.5d（V2StructuredView 改动比预估小）|
| M3 (W3 代码层) | 7.6d | ~4d（M3.10/M3.11 部署任务推后；本地集成测用本地 postgres 替代 testcontainer）|
| M4 (W4 本地代码) | 1.5d | ~1d（M4.4c 发现无需改 graph-builder）|
| **合计本地代码** | **16.95d** | **~10.5d** |
| M3.10/M3.11/M4.1-M4.3 | 部署阶段 | TODO（≥ 4 天，含 72h 灰度观察） |

实际短于估算的原因：
- bootstrap.ts 已天然透传 spec 整对象，省去 graph-builder 改动（M4.4c）
- final 节点抽出复用了 graph-builder 现成代码（M3.1）
- 集成测部分用本地 postgres 替代 testcontainer，跳过 Docker setup

---

## 10. 完整风险登记表（12 条）

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | LLM selfCheck 漏"最弱点"关键词 → zod fail 死循环 | 中 | 高 | superRefine 仅 schemaVersion='v2' 触发；safeParse 失败降级 readFileSync |
| R2 | LLM 凑 reviewHints 稀释信号 | 高 | 中 | role prompt 显式"不凑数"；lint 不强制；摘要"无主动提示请抽查" |
| R3 | IM 卡片 250 字符不够 | 中 | 中 | buildImTeaser 优先级队列；固定后缀"→ Web 看完整摘要"；单测断言边界 |
| R4 | Round 2 acDiff zip 无对应关系审批人误判 | 中 | 中 | 文案明示"两栏不强对应"；颜色编码 added/removed/changed |
| R5 | rehype-raw XSS（spec.md 含恶意 HTML）| 低 | 中 | rehype-sanitize allowlist；spec.md 来自 LLM 非用户输入；PrdDocumentsPage 等渲染用户输入处必须配 sanitize |
| R6 | 老 waiter 行新前端显示丑 | 高 | 低 | ReactMarkdown 兼容 plain markdown；V2StructuredView 数据缺自动隐藏 |
| R7 | qi-spec-lint M4 硬阻断后误报阻断 CI | 中 | 高 | W3 跑 1 周观察误报率；保留 `--report` 紧急逃生；`PERCENT=0` 1 行回滚 |
| R8 | v3 schema 上线时 in-flight pipeline 已 round 2 等审批 | 高 | 低 | 全 optional 字段；schemaVersion=undefined → 跳过 v3 superRefine；usesV3Summary 缓存到 stage_results.meta |
| R9 | feature flag 多机不一致 | 中 | 中 | docker-compose env 一致；灰度按 `requirement_id % 100 < PERCENT` 与 env 解耦 |
| R10 | ?openWaiter=M 在 waiter 已 claim 后弹 Modal 困惑 | 低 | 低 | useEffect 判断 `!w.claimedBy` 才 setDecideState |
| R11 | confidenceLevel='high' 但 risks 含 high → hint 矛盾 | 中 | 低 | 启发式优先级 reviewHints.high > risks.high > round≥3 > confidenceLevel；单测覆盖 |
| R12 | zod superRefine 失败堆栈不易读 | 中 | 低 | superRefine message 含 schemaVersion + path 上下文；safeParse 失败打印 first 3 issues |

---

## 11. Commit / PR 约定

参 [docs/standards/commit-conventions.md](../standards/commit-conventions.md)：

- 每 milestone 一个 PR；PR 内按 sub-task commit：
  ```
  feat(qi-spec-v3): M1.1-M1.2 add scripts/qi-spec-lint.ts (L1-L12 rules)
  feat(qi-spec-v3): M1.3 add 4 fixtures + 20 lint test cases
  feat(qi-spec-v3): M1.4-M1.5 upgrade role-output-schemas v3 + 12 schema tests
  feat(qi-spec-v3): M1.6 extend web/src/api/requirements.ts types
  ci(qi-spec-v3):   M1.7 add qi-spec-lint job (warn-only)

  feat(qi-spec-v3): M2.1 rewrite spec-author.md v2 → v3 (266→396 lines)
  feat(qi-spec-v3): M2.3 V2StructuredView render reviewHints/acDiff/standardsConsulted/selfCheck/noGos
  feat(qi-spec-v3): M2.5 add rehype-raw + rehype-sanitize for M3.8 prep
  fix(qi-spec-lint): remove "正确" from L6 antipattern blacklist (false-positive on "正确密码")
  docs(qi-eval):    M2.2 v3 baseline qi-eval-2026-05-09-spec-author-v3-A.json

  feat(qi-spec-v3): M3.1 approval-summary module (spec/final/shared/i18n/index)
  feat(qi-spec-v3): M3.2 19 spec-summary-builder unit tests
  feat(qi-spec-v3): M3.3 graph-builder feature flag routing + meta cache
  feat(qi-spec-v3): M3.4 QiApprovalInterruptValue.imSummary + graph-runner forward
  feat(qi-spec-v3): M3.5 qi-approval-manager imSummary + URL openWaiter
  test(qi-spec-v3): M3.6 4 imSummary cases + 6 DB meta-merge integration cases
  feat(qi-spec-v3): M3.7 RequirementsPage useSearchParams ?id&openWaiter
  feat(qi-spec-v3): M3.8 MarkdownViewer rehype-raw + sanitize allowlist
  feat(qi-spec-v3): M3.9 skill-runner feedback.md prevReviewHints/prevAssumptions

  feat(qi-spec-v3): M4.4 plan-decomposer specNoGos consumption (warn-only)
  docs(qi-eval):    M4.5 v3-A baseline rename
  docs(qi-spec-v3): add prd-spec-author-v3.md + impl-spec-author-v3.md
  ```

- 不 rebase / amend / `--no-verify` / force push

---

## 12. 后续迭代

| 优先级 | 项目 | 触发时机 |
|---|---|---|
| P1 | M3.10 staging 端到端冒烟 | 部署到 staging 后立即 |
| P1 | M3.11 prod 灰度三步 + SQL 监控 | staging 通过后 |
| P1 | M4.2 移除 feature flag 代码 | M3.11 100% 灰度通过 |
| P2 | W5 plan-decomposer specNoGos 切硬 reject_input | W4 warn-only 跑 1 周 |
| P3 | LLM-as-judge 5 项打分自动化 | Phase 5 |
| P3 | code-quality-reviewer / dev-loop v3 升级 | 独立 PRD |
| P3 | spec.md i18n 英文化 | 国际化需求触发 |
| P3 | 审批 Modal 历史趋势 dashboard（reject 率 / round 数）| reviewer 提需求 |
