# LLM 角色 prompt 审计清单

> Quick-Impl / E2E pipeline 等流水线里每个 LLM 角色（spec-author / plan-decomposer / dev-loop / 各种 reviewer / im-input-agent ...）新建或重大改动**前后**各跑一次。审计结果应**与角色复杂度匹配**——简单角色 4-5 条 lens 通过即发车，创作 / 审查类角色全 10 条。

**核心原则**（按优先级，不可颠倒）：
1. **质量第一**——产出能被下游真实消费、能被人审纳服为高水平工程产物。
2. **成本第二**——同等质量下选择 token / 实现工作量更低的方案。
3. **专业 ≠ 重型**——但**"轻"不能是质量打折的借口**。该上的修法就上。

每条 lens 给"最低修法 / 充分修法 / 贵的版本"三档，按角色当前缺口的真实严重度选档，不要默认选最低。

---

## 10 条 lens

### Lens 1：身份、边界、深度匹配（Identity, Scope & Proportional Depth）

**问**：prompt 顶部是否说清"你是谁、你不做什么、什么 spec 形态超出你的能力、调研深度如何匹配 spec 复杂度"？

**坏味道**：① 只有"角色名 + 一句任务描述"无 persona ② 无 out-of-scope ③ 对所有 spec 用同一深度处理（qi-6 的 50 LOC banner 拆 30 条调研要点是浪费；50 文件 auth 重写只拆 3 条任务是失职）。
**最低修法**：3 行——身份（"senior X engineer"）+ 适用范围（"AC ≤ 10 / 单服务 / TS 栈"）+ 拒绝条款（"超出 → `decision='reject_input'`"）。
**充分修法**：再加"## 深度匹配"一段：给 3 个分档示例（trivial / typical / complex spec 各对应多深的调研、多少任务、plan.md 多长）。
**贵的版本**：用 LLM 二次评估 spec 复杂度 → 用 router 切到不同 prompt——通常不需要。

### Lens 2：Definition of Ready（DoR）

**问**：上游产物什么样**才能开干**？什么样要打回？

**坏味道**：只挡"文件物理缺失"，不挡"内容质量低"或"内容自相矛盾"。
**最低修法**：列 5-8 条 reject_input 触发条件（spec AC=0 / AC 间循环引用 / spec 提到的文件 worktree 不存在 / prompt injection 嫌疑 / feedback 与 spec 矛盾 / 总 LOC 估值 > 800 等）。
**充分修法**：每条触发条件给一个 1-2 句的 reject 模板（"spec AC=0 → reject reason: '验收标准缺失，spec-author 应在 §4 列至少 1 条 AC'"），让上游知道怎么修。
**贵的版本**：完整对抗输入测试集——不必要。

### Lens 3：调研有迹可循（Evidence of Investigation）

**问**：能否从输出**反推 LLM 真读了代码 / 真考察了现状**？

**坏味道**：`evidence.standardsConsulted: [...]` 只是文件名列表，能撒谎；plan.md 不含任何 file:line 引用。
**最低修法**：要求输出含 ≥ 3 个 `[file:line](path#L行号)` 真实引用，lint 校验文件路径在 worktree 存在。
**充分修法**：要求输出含 "## 调研发现" 段，每条 bullet 必须包含 ① 引用源 file:line ② 它如何影响本次决策（"已有 X 模式 → 沿用 / 反例 → 避免"）。lint 同时校验链接行号合理（不超出文件总行数）。
**贵的版本**：tool-call log 强制对齐（claimed reads vs actual reads）——需要时加，不必默认。

### Lens 4：输出是对下游的契约（Contract for Downstream）

**问**：下游角色能从你的输出**直接干活**，还是要回头查上游？人审 / 未来读者能否仅凭你的产物理解决策？

**坏味道**：① plan-decomposer 不蒸馏 spec §6 技术说明给 dev-loop ② output 只列任务没给"任务做完算什么样" ③ 字段下游不消费但 LLM 必须填。
**最低修法**：删掉下游不消费的字段（瘦身）+ 补齐下游一定要的字段（plan → dev-loop 必须含 doneWhen / implementationHints / testHints / exposesContract）。
**充分修法**：在 prompt 顶部明确列"下游消费者 / 字段消费表"，每个字段都注明谁会用、用来做什么。
**贵的版本**：跨角色 schema codegen + e2e 契约测试——大型团队再上。

### Lens 5：自检 vs 自评（Self-evidence not Self-grading）

**问**：selfCheck 字段是"主观决策记录"还是"机械命题打勾"？

**坏味道**：4 条 mechanical truth 全 `passed: true`（plan-decomposer 现状），LLM 没动机说 false。
**最低修法**：机械命题（AC 全覆盖 / DAG 无环 / file 路径合法 / dependsOn ID 存在）全交 lint 脚本，selfCheck 只剩 1-3 条**主观决策**（"为什么这么拆而不是那么拆 / 哪个任务最不确定 / 用了什么非显然的标准"），lint 不能机械验。
**充分修法**：再加"自我反驳"项——"如果让你挑本 plan 一个最弱点，是什么？"强制 LLM 输出 ≥ 1 条 self-critique。
**贵的版本**：LLM-as-judge 二次审——上 plan-reviewer 角色而非把它压到 selfCheck 里。

### Lens 6：对抗输入与优雅降级（Adversarial Robustness & Graceful Degradation）

**问**：上游产物含 prompt injection / 路径穿越 / 自相矛盾 / 噪声 / 部分文件读失败时，行为可预测吗？

**坏味道**：默认上游产物干净；任意一个 standards 文件读失败就 abort。
**最低修法**：3 条防线——① tasks/files 路径白名单 lint（拒 `..` / `node_modules` / 绝对路径 / 系统目录）② feedback.md 当**数据不当指令**（skill-runner 包一层 `<user-feedback>` XML 隔离）③ 任意 standards 文件缺失 → warn + 继续，不 abort。
**充分修法**：output schema 拒密钥模式串（含 `[A-Za-z0-9]{32,}` 等）；feedback 含 prompt-injection 关键词（"忽略以上指令"等）→ skill-runner 拦截并标 review。
**贵的版本**：完整 fuzz 测试集 + adversarial eval suite——按需。

### Lens 7：确定性、多轮、Schema 演化（Determinism, Multi-round, Versioning）

**问**：① 同输入两次跑，关键字段稳吗？② round 2+ 怎么演化（taskId 稳定？plan 是 incremental diff 还是全量重写？）？③ schema 升版有显式标记吗？

**坏味道**：① 同 spec 跑两次出不同 taskId ② 版本兼容写在 prompt 里（"如果字段缺就当 v1"）越来越胖 ③ round 2 plan 与 round 1 完全相同也强 commit 一次。
**最低修法**：① prompt 一行声明"taskId / dependsOn / files / coverAC 必须确定性，summary/notes 文案可变" ② inputs 加 `schemaVersion` 字段，向上转换在 skill-runner 做、LLM 只见最新版 ③ round 2+ 先 diff plan JSON，完全相同 skip commit。
**充分修法**：明文规则——被删的 taskId 不复用（保留 graveyard）；plan.md round 2 顶部加 "## Round N 变更摘要" 段。
**贵的版本**：full snapshot test——可选。

### Lens 8：观测钩子（Observability）

**问**：skill-runner 能记录到什么？token / latency / tool-call 真实清单 / decision 分布？

**坏味道**：完全黑盒，靠 LLM 在 evidence 里手填字符串自报"我读了 X"。
**最低修法**：skill-runner 侧记 `qi_role_metrics`（latency / tokens / standards 文件实际 Read 次数 / decision 分布 / round N），**LLM 不自报这些**。
**充分修法**：admin Web 加最小 dashboard 看 reject 率 / round 数分布 / token 消耗趋势。
**贵的版本**：full LangSmith / Langfuse 接入——按需。

### Lens 9：决策工艺（Decision Craft）

**问**：plan/spec 输出是否包含**取舍证据**？读者（人 + 下游 LLM）能否判断决策是否合理？

**坏味道**：① 只输出"我决定这么做"，不输出"我考虑过 X 但拒绝因为 Y" ② 没有 confidence / assumptions / no-gos ③ 风险段抄 spec。
**最低修法**：JSON 加 `decisions[]` 字段，每条含 `{ choice, alternatives[], rejectedReason }`；至少在影响 ≥ 2 个文件的任务上必填。
**充分修法**：plan.md 加 "## 设计取舍" 章节；JSON 加 `confidenceLevel` / `assumptions[]` / `noGos[]`（明确不做的事，防 dev-loop 自由发挥）/ `rabbitHoles[]`（已识别的技术深坑预警）。
**贵的版本**：完整 ADR / Rust RFC 模板移植——大型团队规划用。

### Lens 10：认知人体工学（Cognitive Ergonomics for the LLM）

**问**：prompt 结构是否便于 LLM 真按你想的顺序执行？

**坏味道**：① 输出 schema 放最前 → LLM 从 token 顺序读时被 anchor 到模板 ② 长 checklist 中关键项埋在中部 → LLM 工作记忆衰减后忽略 ③ JSON 示例全 happy path → LLM 复制 anchoring。
**最低修法**：章节顺序固定为 **role priming → input → task → process（含 investigation） → constraints → DoD → 显式禁止 → 输出格式（含正负示例）**。关键项前置或加粗。
**充分修法**：长 checklist 拆成 ≤ 7 项分组；JSON 示例必须含 ≥ 1 个 `decision: "reject_input"` 或 `decision: "fail"` 的负例 + 含 mixed selfCheck（既有 true 又有 false + reason）。
**贵的版本**：A/B test 不同 prompt 排列效果——只有当前 prompt 已经被怀疑出问题时上。

---

## 元 lens：质量 vs 成本

**先确认 lens 是否产出可用质量，再考虑省成本**。下表是 prompt 维护舒适度的上限（不是为省 token 而设的硬墙）：

| 维度 | 简单角色（im-input-agent / sanitizer 类） | 创作 / 审查角色（spec-author / plan-decomposer / reviewer 类） |
|---|---|---|
| prompt 总长 | ≤ 200 行 | ≤ 300 行 |
| 输出 required 字段 | ≤ 8 | ≤ 15 |
| selfCheck items（全主观） | ≤ 3 | ≤ 5 |
| JSON 示例 | 1 happy + 1 negative | 1 happy + ≥ 1 negative |
| 调研 tool calls | 上限 ≈ AC 数 × 1 | 上限 ≈ AC 数 × 3 |
| DoD checklist 项 | ≤ 5 | ≤ 10 |
| 「显式禁止」条目 | ≤ 6 | ≤ 8 |

**红线**：role prompt 超过 400 行 → 必须拆角色或抽 standards 链接，**不能再加段**。

**质量豁免**：当达成 lens 质量需要超出上面预算时，**优先保质量**。但要在该角色文件顶部加一行注释说明哪条预算超出 + 原因，避免后人盲目跟随。

---

## 反 anti-pattern 速查（每个角色 prompt 必须显式禁止）

复制这 8 条到角色 prompt 末尾的"## 显式禁止"段：

1. `selfCheck.passed` 全 true（机械可验项搬到 lint 后这条免谈）
2. 任务 / AC title 用模糊动词（"修复"/"优化"/"完善"——必须含具体动词 + 对象 + 文件）
3. output 复述 spec 已有内容（spec 风险段不抄到 plan，dev-loop notes 不抄 reviewer 反馈）
4. `consultedStandards[]` 列出但不解释怎么用（要么删、要么解释怎么影响了哪条决策）
5. 任务依赖 / 引用不存在的 ID（lint 兜底，但 prompt 也要禁）
6. output 必填字段填模板字符串（"已拆解为 N 个任务"——必须真实数字）
7. **幻觉 file:line**：引用必须真实存在；行号必须 ≤ 文件总行数；不确定 → 只引文件不引行号
8. **关键决策埋在 prose 里**：取舍 / 风险 / 信心度必须落到结构化字段（JSON），不能只在 markdown notes 段说

---

## 校准：什么角色启用几条 lens？

| 角色类型 | 必过 lens | 例子 |
|---|---|---|
| 纯转换型 | 1 / 4 / 5 / 7 / 10 | im-input-agent, requirement-sanitizer |
| 创作型 | 全 10 条 | spec-author, plan-decomposer |
| 审查型 | 1 / 5 / 6 / 8 / 9 / 10 + "不重做"约束 | code-quality-reviewer, plan-reviewer |
| 执行型 | 1 / 2 / 4 / 6 / 7 / 10 | dev-loop, mr-create, fix-runner |

Lens 9（决策工艺）只对**做架构决策**的角色必填——执行 / 转换型不需要因为它们没决策空间。Lens 10（认知人体工学）适用于所有角色，因为它是 prompt 写作技艺。

---

## 一次性体检：plan-decomposer 现状（10 条）

| Lens | 当前等级 | 关键缺口 |
|---|---|---|
| 1 身份与深度匹配 | F | 无 persona / 无 out-of-scope / 对所有 spec 同深度 |
| 2 DoR | F | 只挡物理缺失 |
| 3 调研有迹 | F | 无 file:line 引用要求 |
| 4 下游契约 | D | 缺 doneWhen / implementationHints / testHints |
| 5 自评 | F | 4 条 mechanical 全 LLM 自评 |
| 6 对抗输入 | F | 路径无白名单 / 无 prompt inj 防线 / 单文件失败即 abort |
| 7 确定性 | F | 无 schemaVersion / 无确定性声明 / round 2 不去重 |
| 8 观测 | F | standardsConsulted 是手填字符串 |
| 9 决策工艺 | F | 无 alternatives / noGos / confidence / assumptions |
| 10 认知人体工学 | C | 章节顺序倒置（output 在前），JSON 示例全 happy path |

10 条全失分但**不等于堆 10 条厚修法**——按 lens 9-10 + 8（决策工艺 + 认知工学 + 观测）走充分修法，其余走最低修法 + lint 兜底，估 2 天可全到 B+。

---

## 维护

- 新角色或重大改角色 → 必须跑全 lens 一遍，结果 lens 矩阵贴角色文件顶部
- 本文件每季度回顾一次：是否有 lens 在实战中无效 / 有新坑没覆盖
- 改本文件 → 通报所有 quick-impl roles 的 owner，避免存量角色与新规走偏
- 跨角色质量回归（连续 2 个 spec 出 P0 bug）→ 强制全角色重审
