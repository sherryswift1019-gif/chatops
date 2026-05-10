# Spec 07: 风险、安全、维护

> 主 PRD：[prd-quick-impl-roles-v2.md](../prd-quick-impl-roles-v2.md)
> 关联：[06-implementation.md](06-implementation.md)（实施过程的检查项）

本文集中所有风险评估、安全考虑、维护 owner。

实现任何 Phase 前都应快速扫一遍本文，对照 risk 列表确认缓解措施已落地。

---

## 1. 风险与缓解

### 1.1 高优风险（必须有缓解）

| # | 风险 | 概率 | 影响 | 缓解措施 | 落地 spec |
|---|------|------|------|---------|----------|
| R1 | Prompt 变长 → Claude 注意力稀释 → 反而比 v1 差 | 中 | 高 | manifest 精准注入 + inputs 蒸馏 + checklist 风格 + output schema 先行；Phase 3 跑 A/B 对照验证 | [04](04-prompt-strategy.md) |
| R2 | docs/standards/ 文件 Claude 不读 / 不引用 | 中 | 中 | role.md 显式要求 evidence.standardsConsulted 列出引用项；reviewer 把"是否引用"作为检查项；没列就标 fail | [01](01-roles.md), [02](02-data-flow.md) §1.3 |
| R3 | 流程数据未持久化（previousCommits / 蒸馏字段跨 round 丢失） | 中 | 高 | test_runs.stage_results JSONB 存结构化输出；零 schema 变更 | [02](02-data-flow.md) §5 |
| R4 | spec round 2 改 AC 后 plan 没级联失效 | 中 | 高 | acDiff 检测 + plan 节点重置 | [02](02-data-flow.md) §6 |
| R5 | rawInput 含敏感信息发到 Anthropic API | 低 | 高 | worker 入队前正则脱敏 + warning log | §2.1 |

### 1.2 中等风险（已设计兜底）

| # | 风险 | 缓解 | 落地 spec |
|---|------|------|----------|
| R6 | 输出 JSON 字段变多，下游解析失败 | skill-runner 解析时 graceful 兜底，新字段都是 optional | [02](02-data-flow.md) §1.5 |
| R7 | 单需求 token 消耗暴涨 | manifest 精准注入后单 role token 减 25-71%；总量由 Phase 3 评测确定，不预设具体数字 | [04](04-prompt-strategy.md) §4 |
| R8 | dev-loop 误改 standards 文件污染 MR | .qi-context/ 加入 worktree gitignore + reviewer 检查项 | [02](02-data-flow.md) §4, [01](01-roles.md) §3, §4 |
| R9 | Manifest 配置漂移（manifest / 实际文件 / role consume 三处不一致） | CI 单测扫三方一致；事实来源单一（manifest），PRD 表格仅供阅读 | [02](02-data-flow.md) §4, [06](06-implementation.md) §3.4 |
| R10 | stage_results 数据膨胀（JSONB 列爆） | rounds[] 只保留最近 2 轮完整结构；更早 round 摘要化 | [02](02-data-flow.md) §5 膨胀控制 |
| R11 | Plan 节点重置导致 token 放大（用户反复 reject spec） | 审批 UI 第二次 reject 后弹窗"会触发 plan 重做，确认继续？" | [06](06-implementation.md) Phase 4 验收 |
| R12 | manifest.json 缺失或解析失败 | skill-runner 加 try/catch + fallback "全 symlink + 全字段" 模式 | [02](02-data-flow.md) §4 skill-runner 实现 |
| R13 | 单次 LLM 评测分数随机噪声（±0.3 分）→ CI 误判 | regression CI 三层模式：per-PR 不 block 只评论 / nightly 3 次平均 / 周报趋势 | [05](05-evaluation.md) §4 |

### 1.3 低优风险（仅记录）

| # | 风险 | 备注 |
|---|------|------|
| R14 | docs/standards/ 跨 skill 复用冲突 | 当前仅 quick-impl 用，留备注；真有第二 skill 用再讨论 namespace（详见 [03](03-standards.md) §4）|
| R15 | CLAUDE.md 与 docs/standards/ 双写漂移 | Phase 5 重构 CLAUDE.md 为摘要 + link + lint 脚本 | [03](03-standards.md) §3 |
| R16 | Phase 0 baseline 只有 1 个 case，覆盖面有限 | baseline 是测试数据，决策接受；后续真实需求逐步覆盖 schema/migration 路径 | 用户已拍板 |

---

## 2. 安全考虑

### 2.1 rawInput 敏感信息脱敏

**风险**：用户在 rawInput 输入框可能粘贴 API key / 密码 / GitLab token / 内网 URL，当前会原样发到 Anthropic API → 违反数据合规。

**缓解**：

worker 入队前正则脱敏，匹配规则：

| 类型 | 正则 | 替换 |
|------|------|------|
| GitLab personal token | `glpat-[A-Za-z0-9_-]{20,}` | `[REDACTED:gitlab-token]` |
| Generic API key | `sk-[A-Za-z0-9-]{20,}` | `[REDACTED:api-key]` |
| Bearer token | `Bearer [A-Za-z0-9._~+/=-]{20,}` | `[REDACTED:bearer]` |
| 邮箱（按合规要求选择） | `[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}` | `[REDACTED:email]` |
| 内网 IP | `\b(10\|172\.(1[6-9]\|2\d\|3[01])\|192\.168)\.\d+\.\d+\b` | `[REDACTED:internal-ip]` |

**实现**：
- 函数：`sanitizeRawInput(rawInput: string): { sanitized: string, hits: Array<{type, original}> }`
- 命中后写 warning 到 application log（含 hits 类型 + 原始片段长度，不写原始内容）
- 调用点：[src/quick-impl/worker.ts](../../../src/quick-impl/worker.ts) 入队前

**单测覆盖**：详见 [06-implementation.md](06-implementation.md) §3.5

### 2.2 manifest / standards 配置变更治理

role-manifest.json 和 docs/standards/ 是关键配置，改动影响所有需求的产出。

**治理措施**：

1. **CODEOWNERS**：[.claude/CODEOWNERS](../../../.claude/CODEOWNERS)（如不存在则新建）标记：
   ```
   /.claude/skills/quick-impl-artifact-author/role-manifest.json @backend-quick-impl-team
   /docs/standards/                                              @project-standards-team
   ```

2. **PR 审查**：上述文件改动必须人工 review

3. **后续可考虑**：
   - DB 表 `qi_config_audit` 记录 manifest 变更历史 + 操作人 + diff
   - 每次 manifest 改动自动跑 evaluation（per-PR）

### 2.3 跨 skill 共享 standards 的 namespace 风险

当前 docs/standards/ 是项目级，仅 quick-impl 消费。**当前不解决**，留备注。

详见 [03-standards.md](03-standards.md) §4。

### 2.4 worktree 内的 standards/ 不应被 dev-loop 改动

已在 [02-data-flow.md](02-data-flow.md) §4 / [01-roles.md](01-roles.md) §3, §4 / [06-implementation.md](06-implementation.md) §3.1 闭环：
- skill-runner 设置 `.qi-context/` 为 worktree gitignore
- reviewer 把 `git diff 含 .qi-context/` 作为 fail 条件
- 单测覆盖

---

## 3. 维护与后续 owner

### 3.1 owner 矩阵

| 模块 | Owner | 维护要求 |
|------|-------|---------|
| `.claude/skills/quick-impl-artifact-author/SKILL.md` + 4 个 role.md | 后端 Quick-Impl 维护者 | role.md 改动必须跑 evaluation；分数低于 baseline 不得合并 |
| `.claude/skills/quick-impl-artifact-author/role-manifest.json` | 后端 Quick-Impl 维护者 + Code Owner | 改动需 PR review；CI 校验 zod schema + 三方一致 |
| `docs/standards/*.md` | 项目规范文档维护者 + 改动相关模块的 owner | 与 CLAUDE.md 同步更新（Phase 5 后由 lint 脚本自动检查） |
| `scripts/qi-eval*.ts` + judge prompt | 后端 Quick-Impl 维护者 | Phase 0/3 阶段产出，后续维护 LLM-as-judge prompt |
| `scripts/qi-standards-lint.ts` | 项目规范文档维护者 | Phase 5 产出，CI 跑 |
| 前端审批 UI（specCoverage / commits / openQuestions / reject 弹窗） | 前端管理后台维护者 | Phase 4 产出 |
| evaluation 报告归档 | 后端 Quick-Impl 维护者 | 每次跑完归档到 `docs/qi-eval-{type}-{date}.md`，PR 描述 link |

### 3.2 跑 evaluation 的硬约束

**Phase 0 / Phase 3 evaluation 必须人工跑**，归档报告作为决策证据。

理由：
- 前期 LLM-as-judge 还没校准，人工打分作为 ground truth
- v2 上线是大事，不能让 CI 单方面决定
- 人工归档强迫 owner 看一眼、签字

Phase 5 后 CI 才接管 regression（详见 [05-evaluation.md](05-evaluation.md) §4）。

### 3.3 决策记录（2026-05-08 拍板）

- [x] **docs/standards/ 内容来源**：从 [CLAUDE.md](../../../CLAUDE.md) 抽取（保持单一来源）。后续 CLAUDE.md 反过来用 markdown link 引用 docs/standards/，避免双写漂移
- [x] **Phase 0 baseline case**：只跑 login-remember-me 一个（baseline 是测试数据，不纠结覆盖面；schema/migration 路径的回归依靠后续真实需求验证）
- [x] **v1/v2 切换策略**：直接替换（role.md 是配置文件，回退就是 `git revert`），不做 feature flag 共存
- [x] **specCoverage 判定**：AI 自判 + 给证据（file:line），人工最终审批只做"是否同意"决策。如果 AI 漏判某条 AC 没覆盖，由人工 reject 触发 round 2 修订
- [x] **stage_results 膨胀控制**：rounds[] 只保留最近 N=2 轮完整结构化输出，更早 round 摘要化
- [x] **第二次 reject 弹窗**：Phase 4 内做（spec round ≥ 2 改 AC 时弹"会触发 plan 重做，确认继续？"）
- [x] **regression CI 模式**：混合三层（per-PR 不 block / nightly 3 次平均阻塞 / 周报趋势）

### 3.4 后续展望（不在本次范围）

- 把 docs/standards/ 抽象为可订阅机制，多个 skill 共享
- spec / plan 审批 UI 嵌入 specCoverage 矩阵可视化（当前只 review 阶段有）
- spec clarifications 完整 UX：审批 UI 把 openQuestions 单独成"待澄清"区块，提供"补充信息"输入框，用户补充后作为 round 2 的 amend 输入而非 reject
- pipeline 节点级状态机增强：spec round 变化 → plan/dev 联动重置策略可配置（当前 hardcoded "AC diff 非空必重跑 plan"）
- LLM-as-judge prompt 自动化校准（用人工抽查的 10% 数据自动 fine-tune judge prompt）
