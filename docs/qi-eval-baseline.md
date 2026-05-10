# Quick-Impl V1 Baseline Evaluation Report

> **状态**：V1 baseline 已跑（spec-author，2026-05-08）
> **Spec**：[docs/prds/quick-impl-roles-v2/05-evaluation.md](prds/quick-impl-roles-v2/05-evaluation.md)
> **Phase**：Phase 0 — V1 baseline，作为后续 V2 对比基准

## 元信息

| 字段 | 值 |
|------|----|
| 评测日期 | 2026-05-08 |
| 评测人 | sherryswift1019（+ Claude 对照打分）|
| Case | login-remember-me |
| rawInput | "给登录页加记住密码 checkbox：勾选后下次访问自动回填用户名（不存密码）" |
| 对照素材 | [docs/test-specs/login-remember-me.md](test-specs/login-remember-me.md) — 人工 gold-standard spec（7 个 scenario） |
| Skill 版本 | v1（role.md 未改造，main 分支 04d9450）|
| 跑评测脚本 | `scripts/qi-eval.ts` 通过 ProductionSkillExecutor 走 Anthropic 网关 |

---

## V1 评分

### spec-author

#### 跑评测元信息

| 字段 | 值 |
|------|----|
| 跑完时间 | 2026-05-08 12:51 |
| 总耗时（durationMs）| 70,018 ms（~70 秒）|
| 输入 token | null（**v1 BUG**：JSON parse 失败时错误处理路径未采集 token）|
| 输出 token | null（同上）|
| runStatus | **parse_failed**（JSON.parse 在 line 2 col 29 失败）|
| 一致性校验通过 | ✓（spec.md AC count=0 === JSON.acceptanceCriteria.length=0，因为 v1 没 acceptanceCriteria 字段，校验自动 trivially pass）|
| schema 校验通过 | ✗ — JSON 解析失败 |
| artifact 是否生成 | ✓ — `qi-eval-spec-author.md` 53 行 |

#### 致命问题（V1 暴露的）

**JSON 输出 broken**：v1 SKILL.md 没要求 JSON 字段值转义引号，Claude 在 summary 里写 `"已撰写需求规格：登录页增加"记住用户名"复选框..."`，未转义的双引号破坏整个 JSON，下游解析全 fail。

跑了 2 次都失败，**不是偶发**：

```
"summary": "已撰写需求规格：登录页增加"记住用户名"复选框，纯前端 localStorage 方案..."
                                ^^^^^^^^^^ 未转义
```

下游 graph-runner 拿不到 acceptanceCriteria / risks / references 等结构化字段。

#### 5 项主观打分

| 维度 | 分数 | 简短理由 | 关键证据 |
|------|------|---------|---------|
| 清晰度 clarity | 4/5 | 段落分明、章节清晰、文案易懂；但"焦点优化"散落在功能描述末尾，没独立成节 | spec.md §3 末尾 |
| 完整性 completeness | **2/5** | 仅 6 章节（背景目标 / 功能描述 / 验收标准 / 技术说明 / 超出范围）。**缺**：非功能需求 / 风险与未知 / 回滚预案 / 澄清记录。**JSON 结构化字段全空**（除 summary/decision/notes 外）| spec.md 整体；output 缺 acceptanceCriteria/risks/references/clarifications |
| 可测性 testability | **2/5** | AC 是 checkbox 自由文本，**不是 Given-When-Then**；部分 AC 模糊（如"样式与暗色主题一致"无法直接转 test） | spec.md §3 验收标准 7 条 |
| 与代码契合度 codeAlignment | **2/5** | 只有文件路径 `web/src/pages/LoginPage.tsx`，**没具体到 line**；没引用 antd Form 现有模式；不知道当前 LoginPage 是 class / function；没有 references[] 结构化字段 | spec.md §4 技术说明 |
| 风险揭示 riskInsight | **1/5** | **完全没有风险章节**；没识别 XSS / localStorage 配额 / 多 tab 同步；超出范围只列 4 条；没有 OPEN_QUESTION | spec.md 整体 |
| **总分** | **11/25** | | |

#### 文字总结

V1 spec 表面看起来"还行"（章节齐全、文案规整），但**实际信息密度低**：

- **JSON 输出层 broken**：未转义双引号破坏 schema，整个结构化输出消失。这是底座 SKILL.md 契约不严的结果。
- **章节缺失严重**：非功能需求 / 风险 / 回滚 三大章节 v1 都没有，导致审批人无法判断 spec 是否真的可上线。
- **AC 不可测**：自由文本 checkbox，没格式约束。下游 plan-decomposer 拿不到结构化的 coverAC 引用。
- **与 codebase 完全脱钩**：没具体到 line、没引用现有模式、没考虑 LoginPage 当前实现。
- **风险揭示几乎为零**：纯前端 + localStorage 看似简单，但实际有 XSS / 多 tab 同步 / 配额溢出等风险，v1 完全没识别。

**对比人工 gold spec**（[login-remember-me.md](test-specs/login-remember-me.md)）：
- 人工 spec 列了 **7 个具体 scenario**，每个都是 Given-Steps-Expected 三段格式
- 人工 spec 有"实现注意"小节，标记了 Checkbox 文案改进建议（reviewer 视角）
- 人工 spec 明确指定 localStorage key（`chatops_remembered_username`）—— v1 AI 也猜对了同样的 key（巧合）

总分 11/25，**v2 目标 ≥ 16/25（提升 ≥ 30%）实际期望可上 19+**。

---

### plan-decomposer

**未跑**。V1 spec-author 输出的 JSON 解析失败 → 下游 plan-decomposer 拿不到结构化 specAcceptanceCriteria → 即使强行跑也是与 v2 不可比较的状态。

跳过到 Phase 3 v2 评测时端到端跑。

---

### dev-loop / code-quality-reviewer

V1 baseline 阶段跳过（依赖完整 pipeline + 真代码改动），Phase 3 端到端跑后补。

---

## V1 主要问题验证（来自 [01-roles.md](prds/quick-impl-roles-v2/01-roles.md) 列出的 V1 问题）

### spec-author

- [x] **没有"先澄清后撰写"步骤** — 确认。模糊需求时直接写默认假设（如"localStorage key 命名"），没列澄清问题
- [x] **章节单薄：缺非功能需求 / 风险 / 回滚** — 确认。v1 输出只有 5 章节
- [x] **验收标准格式无约束** — 确认。AC 是 checkbox 自由文本
- [x] **没要求引用 codebase** — 确认。只列文件名，没 line number
- [x] **JSON schema 不严格（新发现）** — 确认。未转义引号 → parse 失败

---

## V1 → V2 改进重点（具体优先级）

| 优先级 | 维度 | V1 得分 | V2 必改点 | 落地 spec |
|-------|------|--------|----------|----------|
| **P0** | JSON 输出 broken | broken | SKILL.md **强制 JSON 字段值转义引号** + output schema 顶部先行（让 Claude 第一眼看到目标 schema 长什么样）| [02 §1](prds/quick-impl-roles-v2/02-data-flow.md), [04 S4](prds/quick-impl-roles-v2/04-prompt-strategy.md) |
| **P0** | 可测性 | 2/5 | **强制 Given-When-Then AC 格式** + JSON 输出结构化 acceptanceCriteria[] | [01 §1](prds/quick-impl-roles-v2/01-roles.md) |
| **P0** | 风险揭示 | 1/5 | **强制风险与未知章节非空**（至少 1 条 risk 或 OPEN_QUESTION）；DoD checklist 自检 | [01 §1](prds/quick-impl-roles-v2/01-roles.md) DoD |
| **P1** | 完整性 | 2/5 | **新增章节**：非功能需求 / 回滚 / 澄清记录；**新增结构化字段**：risks[] / references[] / clarifications[] | [01 §1](prds/quick-impl-roles-v2/01-roles.md) Spec 文档结构 |
| **P1** | 与代码契合度 | 2/5 | **强制 references[] file:line**；任务步骤要求"先 grep 现有实现再写" | [01 §1](prds/quick-impl-roles-v2/01-roles.md) 任务步骤 §2 |
| **P2** | 错误路径 token 采集 | null | qi-eval.ts 修脚本：catch 错误时也采集 token（需要从 ClaudeRunner.usage 拿）| Phase 5 评测脚本完善 |

---

## V1 → V2 预期对比

基于上面 P0 改进，**预期 V2 spec-author 在同一 case 上**：

| 维度 | V1 | V2 预期 | 提升关键点 |
|------|----|---------|---------|
| 清晰度 | 4 | 4 | 章节多了反而可能稀释，保持 4 |
| 完整性 | 2 | 5 | 新增 4 章节 + 4 结构化字段 |
| 可测性 | 2 | 4-5 | Given-When-Then 强制 |
| 与代码契合度 | 2 | 4 | references[] file:line |
| 风险揭示 | 1 | 4 | 强制非空 + DoD 自检 |
| **总分** | **11** | **17-22** | 提升 55%~100% |

V2 目标 ≥ 16/25 比较稳，乐观看 20/25。

---

## 附录

### A. 报告 JSON 文件

- [docs/qi-eval-2026-05-08-spec-author-v1.json](qi-eval-2026-05-08-spec-author-v1.json) — 完整 raw output / artifact 内容 / 一致性校验

### B. V1 spec.md 完整内容

存放在 worktree：`/var/folders/9m/.../qi-eval-login-remember-me-spec-author-2026-05-08T12-51-40-736Z/docs/qi-eval-spec-author.md`

跑完时已 review 完，可以清理：
```bash
git worktree remove --force /var/folders/9m/158mh4rd7pz_xsm54qgg582c0000gn/T/qi-eval-login-remember-me-spec-author-2026-05-08T12-51-40-736Z
git branch -D qi-eval/login-remember-me-spec-author-2026-05-08T12-51-40-736Z
```

### C. 后续

- Phase 1 开工：用本报告的 P0/P1 改进点指导 SKILL.md / role.md / standards 的具体内容
- Phase 3 跑 v2 评测 → 落 `docs/qi-eval-2026-XX-XX-v2.md`，对比本 baseline
- Phase 3 跑 manifest A/B 对照 → 落 `docs/qi-eval-2026-XX-XX-ab.md`
