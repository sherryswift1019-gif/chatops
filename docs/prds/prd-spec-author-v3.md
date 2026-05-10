# PRD: Quick-Impl spec-author v3 升级

**作者**：sherryswift1019 · **创建**：2026-05-09 · **状态**：实施中（M1-M4 代码完成 / 等部署）

> 实施细节见 [impl-spec-author-v3.md](impl-spec-author-v3.md) · v2 PRD 见 [prd-quick-impl-roles-v2.md](prd-quick-impl-roles-v2.md)

---

## 1. 背景与问题

### 1.1 v2 验证已经做对的事（不要破坏）

spec-author v2（[prd-quick-impl-roles-v2.md](prd-quick-impl-roles-v2.md)）评测 login-remember-me case 拿到 **23/25**（V1 11/25），主要提升在 Given-When-Then AC 强制、9 章节齐全、`references[].file:line` 引用。这些 v3 全部保留。

### 1.2 v2 用了之后暴露的两类问题

**问题 A — 审批人体验**（用户原话）：

> "审批 Modal 和 IM 通知都需要呈现总结性的内容。审批者重点要一眼就看到的内容是什么。需要你来给我优化。我要一眼能看到 spec-author 做了什么、让我 review 什么。"

具体表现：
- 审批 Modal 把 spec.md 整篇 markdown（200+ 行）推给审批人——他要从 9 章节里自己读出"该 review 什么"
- 钉钉/飞书卡片 body 截断到 1500 字符，移动端一屏看不完
- Round 2 时审批人要肉眼对比上一轮 spec.md 找 AC 改了什么

**问题 B — LLM 角色质量**（[llm-role-audit.md](../standards/llm-role-audit.md) 10 lens 体检）：

| Lens | v2 等级 | 缺口 |
|---|---|---|
| 5 自评 vs 自检 | F | DoD 12 条全 mechanical（"AC 用了 GWT 吗" / "5 维度齐全吗"），LLM 全打 ✓ 没信号 |
| 9 决策工艺 | D | 缺 confidenceLevel / decisions / noGos / reviewHints —— 审批人和 plan-decomposer 都没消费点 |
| 8 观测 | F | `standardsConsulted: string[]` 是 LLM 自填字符串（V2 A 评测里 LLM 把 `["frontend-enum-select.md"]` 写成了 `["CLAUDE.md"]`，不准确） |
| 6 对抗输入 | C | feedback.md 无 prompt-injection 防护、references 路径无白名单 |
| 2 DoR | D | 仅挡 rawInput 完全不可解；不挡内容质量低 / feedback 与 rawInput 矛盾 |

---

## 2. 用户故事 / 设计决策

### 2.1 审批人故事

**作为**审批人（钉钉/飞书收到卡片）→ **我希望**手机一屏（≤ 8 行）就看到"LLM 觉得我该 review 哪里"+ "LLM 替我做了哪些假设"+ 直达 Web 审批的链接 → **以便**5 秒内决定"快速批 / 打回 / 打开 Web 端深看"。

**作为**审批人（Web Modal）→ **我希望**顶部 5 段摘要（标题、评估、需 review 的点、LLM 假设、范围、Round 变化）→ 完整 spec.md 沉到 `<details>` 折叠区 → **以便**先 triage 再决定要不要看全文。

### 2.2 v3 5 个增量字段

经 3 轮 review，敲定 v3 schema 增量字段（[role-output-schemas.ts:60-114](../../src/quick-impl/role-output-schemas.ts#L60)）：

| 字段 | 给谁消费 | 为什么必须 |
|---|---|---|
| `reviewHints[]: {severity, point, reason}` | 审批人 Modal/IM 顶部"需 review 的点" | 让 LLM 主动标记"我心虚的地方"；空数组合法（不强求；防凑数）|
| `confidenceLevel: high/medium/low` | 审批助手启发式 hint | 进 hint 优先级队列：reviewHints.high > risks.high > round≥3 > confidenceLevel |
| `clarifications[].kind: fact/assumption` + `userMayDisagreeIf?` | 审批人 Modal "LLM 替你做的决定"段 | 把"LLM 替用户做的默认决定"显式化——审批人最该 challenge 的层 |
| `noGos[]: {desc, reason?}` | plan-decomposer | 跨角色硬约束：plan-decomposer 拆任务触及禁区 → reject_input |
| `schemaVersion: "v2"` | skill-runner / superRefine 触发 | 显式标记 v3 strict 校验；不匹配版本走兼容降级 |

**故意不加**的字段（v3 评估时考虑过但弃用）：
- `decisions[]`（plan-decomposer 已有；spec-author 重复加易凑数）
- `assumptions[]` 独立字段（折叠进 clarifications.kind=assumption 即可，避免双字段同步）
- `roundChanges[].ackStatus`（让 LLM 自评"我有没有响应反馈"会变成 selfCheck v2 翻版——全 ✓ 没信号）

### 2.3 selfCheck 瘦身（v2 → v3）

v2 12 条全 mechanical → v3 限 ≤ 3 条主观判断 + **强制 1 条 self-critique**（必含"最弱点 / 最不确定"关键词）。

**机械可验项全部移到 [scripts/qi-spec-lint.ts](../../scripts/qi-spec-lint.ts) L1-L12**：路径白名单 / AC GWT / e2eScenarios 数量与 negative / coversAC 全覆盖 / 反模式黑名单 / risks 非空等。

### 2.4 审批 Modal / IM 改造决策

**Modal（Web）**：[graph-builder.ts:1424](../../src/pipeline/graph-builder.ts#L1424) 替换 `readFileSync(spec.md)` 为 `buildSpecApprovalSummary({skillOutput, specMdContent, round, acDiff, feedbackMd, prevSkillOutput})` 返回 `{web, im}`，web 写入 `waiters.context_summary`。

5 段摘要 + 折叠区（[approval-summary/spec.ts](../../src/pipeline/approval-summary/spec.ts)）：

```
## 📋 Spec 评审 · 第 N 轮

> 💡 本次评估：置信 high · 全 low risk
> 建议：看起来可快速批

### ⚠️ 需要你 review 的点
1. 🟡 AC-5 主观断言不可测
   选 X 而非 Y，但 Y 也合理

### 📝 LLM 替你做的决定
| 主题 | 默认决定 | 反对条件 |
|---|---|---|
| localStorage 过期 | 永不过期 | 安全合规要 N 天过期 |

### 📊 范围
5 AC · 2 e2e (1✓1✗) · 涉及 4 file:line 锚点

### 🔄 Round 2 上轮反馈 ↔ 本轮变化（两栏不强对应仅供参考）
| 上轮反馈 | 本轮 AC 变化 |
|---|---|
| AC-3 文案模糊 | ✏️ AC-3 修订 |
| 漏多 Tab 同步 | ➕ AC-6 新增 |

---
<details><summary>📋 验收标准 (5 条)</summary>...</details>
<details><summary>📍 涉及代码 (4 处)</summary>...</details>
<details><summary>❓ 完整澄清问题 (7 条)</summary>...</details>
<details open><summary>📄 完整 spec.md (9 章节)</summary>...</details>
```

**IM（钉钉/飞书）**：精炼到 ≤ 250 字符纯文本（移动端一屏可见）：

```
🤖 Spec 评审 · 第 1 轮
💡 看起来可快速批
⚠️ 🟡 AC-5 主观断言不可测
📝 2 条假设需确认
📊 5 AC · 2 e2e · 0 risks
```

**直达审批 Modal 链接**：钉钉/飞书卡片 URL 升级为 `?id=N&openWaiter=M`，前端 useSearchParams + useEffect 自动弹决策 Modal。

### 2.5 灰度策略（4 周）

env 双开关：`QI_SPEC_V3_SUMMARY=true`（总开关）+ `QI_SPEC_V3_SUMMARY_PERCENT=N`（0-100 整数控制比例）。

第一次进入 spec_review_loop 时基于 env 计算 `usesV3Summary`，**缓存到 stage_results.meta**——后续 resume / 跨轮直接读缓存（避免 in-flight pipeline 因 env 中途变化漂移）。

| 周 | 内容 | flag 状态 |
|---|---|---|
| W1 | qi-spec-lint warn-only + schema 升级（向下兼容） | flag=false |
| W2 | role.md v3 + V2StructuredView 新段落 + rehype-raw/sanitize | flag=false |
| W3 | 摘要 + Modal/IM 改造灰度三步：10% → 50% → 100% 各 24h | flag=true; PERCENT 阶梯增 |
| W4 | qi-spec-lint CI 硬阻断 + 移除 feature flag + plan-decomposer specNoGos warn-only | flag 删除 |
| W5 | plan-decomposer specNoGos 切硬 reject_input | — |

灰度健康指标（每步过渡前 SQL 查 1h 内）：
- zod parse fail 率 < 5%
- 摘要降级 readFileSync 比例 < 10%
- reviewHints 空数组比例 ∈ [30%, 70%]（< 5% 凑数 / > 80% 偷懒）
- confidenceLevel 分布非 all-high
- admin Web `/requirements/:id` P95 < 500ms

任一指标超阈值 → `QI_SPEC_V3_SUMMARY_PERCENT=0` 立即停止灰度。

---

## 3. 影响面

| 区域 | 改动 | 兼容性 |
|---|---|---|
| **审批人体验**（Web Modal） | 顶部 5 段摘要 + 折叠区 + 直达 Modal 链接 | 老 waiter 行（spec.md 原文）仍正常渲染（无 `<details>` 标签也能显示）|
| **审批人体验**（IM 卡片） | body ≤ 250 字符精炼摘要 + URL 加 `&openWaiter=N` | 旧链接 `?id=N` 仍可用；前端 useSearchParams 容错 |
| **spec-author prompt** | role.md 266 → 396 行；新章节"reviewHints 怎么写" / "clarifications.kind 决策树" / "confidenceLevel 自评准则" / "selfCheck 瘦身要求" | 老 v2 in-flight 输出（无 schemaVersion）跳过 v3 superRefine，不影响 |
| **plan-decomposer** | §2.1 加 `specNoGos` 输入字段 + §3 DoR 加触发条件 + §5 Step 1 反向约束 | 上线策略 W4 warn-only / W5 切硬 reject_input |
| **CI** | 加 `qi-spec-lint` job（warn-only 灰度）；`.gitlab-ci.yml` 加 50 行 | M4.3 切硬阻断需先观察 W3 误报率 |
| **数据库 schema** | 零迁移（meta 字段加在 stage_results JSONB 里，无新表新列） | — |
| **前端依赖** | `web/package.json` 加 rehype-raw / rehype-sanitize | bundle size +60KB |

**故意不影响**的区域：
- e2eScenarios 5 条强约束（v2 已稳定）
- requirement_approval_waiters 表 schema（无迁移）
- dev-loop / code-quality-reviewer 角色（独立 PRD 升级）

---

## 4. 验收标准（产品视角）

### 4.1 必须达到

- [ ] 审批人 Web Modal 顶部 5 段摘要（≤ 10 行）+ 完整 spec.md 沉到折叠区
- [ ] 钉钉/飞书 IM 卡片 body ≤ 250 字符（移动端一屏可见）
- [ ] 审批人能从 IM 卡片直达 Web 审批 Modal（一次点击，不用再翻列表）
- [ ] LLM 输出含 reviewHints / noGos / confidenceLevel / clarifications.kind 4 类新字段
- [ ] login-remember-me eval ≥ 23/25 不退化
- [ ] 4 周灰度三步无任一健康指标超阈值

### 4.2 应该达到

- [ ] selfCheck 项数 v2 12 → v3 ≤ 3 条主观判断 + ≥ 1 条 self-critique
- [ ] plan-decomposer 在 task 触及 specNoGos 时给出 reject_input（W5 切硬后）
- [ ] qi-spec-lint 误报率 < 5%（W3 观察期）
- [ ] CI 自动跑 lint，不合规 spec 在 PR 阶段就被拦下

---

## 5. 不在本次范围（noGos）

- LLM-as-judge 自动评分（属 [05-evaluation.md](quick-impl-roles-v2/05-evaluation.md) Phase 5 范围）
- code-quality-reviewer / dev-loop 同步升级（独立 PRD）
- spec.md markdown 渲染层 i18n（中文文案集中到 [approval-summary/i18n.ts](../../src/pipeline/approval-summary/i18n.ts)，英文化留作后续）
- 多 spec / 多 plan 跨需求复用机制
- 审批 Modal 加历史趋势数据 dashboard（reject 率 / 平均 round 数等；R3 follow-up）

---

## 6. Top 5 风险

| # | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | LLM selfCheck 漏"最弱点"关键词 → zod fail 死循环 | 中 | 高 | superRefine 仅 schemaVersion='v2' 触发；safeParse 失败降级 readFileSync |
| R2 | LLM 凑 reviewHints 稀释信号 | 高 | 中 | role prompt 显式"不凑数"；lint 不强制；摘要"无主动提示请抽查" |
| R3 | rehype-raw XSS（spec.md 含恶意 HTML）| 低 | 中 | rehype-sanitize allowlist + spec.md 来自 LLM；PrdDocumentsPage 等用户输入处必须配 sanitize |
| R4 | qi-spec-lint M4 硬阻断后误报阻断 CI | 中 | 高 | W3 跑 1 周观察 < 5% 误报；保留 `--report` 紧急逃生；`QI_SPEC_V3_SUMMARY_PERCENT=0` 1 行回滚 |
| R5 | feature flag 多机不一致 | 中 | 中 | docker-compose env 一致；灰度按 `requirement_id % 100 < PERCENT` 路由（与 env 解耦） |

完整 12 条风险见 [impl-spec-author-v3.md §风险登记表](impl-spec-author-v3.md#完整风险登记表)。

---

## 7. 关联文档

- 实施细节：[impl-spec-author-v3.md](impl-spec-author-v3.md)
- v2 PRD：[prd-quick-impl-roles-v2.md](prd-quick-impl-roles-v2.md)
- 10-lens 审计标准：[docs/standards/llm-role-audit.md](../standards/llm-role-audit.md)
- v3 评测基线：[docs/qi-eval-2026-05-09-spec-author-v3-A.json](../qi-eval-2026-05-09-spec-author-v3-A.json)
- 角色定义：[.claude/skills/quick-impl-artifact-author/roles/spec-author.md](../../.claude/skills/quick-impl-artifact-author/roles/spec-author.md) v3
