# QI Spec Quality Standard v1

> 三个 LLM role（brainstorm-host / spec-author / spec-reviewer）共享的产品级 spec 质量规范。
> **改这里 = 改所有 role 的输出标准**。绝对不要在 role.md 中重复定义这些规则。

---

## §1 产品级 spec 的最低要求

一份合格的 spec 必须覆盖以下 5 个维度。brainstorm-host 产出 EnrichedInput 时应为每个维度收集原始信息；spec-author 撰写时必须将每个维度落实到可审查的字段；spec-reviewer 按此表逐项判断。

| 维度 | 描述 | 够（判定通过） | 不够（判定不足） |
|---|---|---|---|
| **WHO** | 用户角色与入口 | 明确角色名（如"管理员"、"运维工程师"）+ 触发路径（如"访问 /admin/xxx 页面"） | 泛指"用户"或"系统"，缺少入口路径 |
| **WHAT** | 核心行为与数据流 | 描述精确到能 grep 现有代码定位修改点，关键字段、接口、DB 表明确 | 抽象描述功能用途，无代码级锚点 |
| **AC** | 验收信号 | 可被 Playwright/HTTP/DB 客观判断真假的断言，Given-When-Then 格式 | 含主观形容词，或"通过"/"成功"/"OK"这类无信息量断言 |
| **Scope** | 范围边界 | in（做什么）和 out（不做什么）均明示 | 只列 in，out 留空或写"无" |
| **非功能** | perf / sec / 可观测 / 兼容 / A11y | 每条明示要求或附理由写"N/A" | 整节空白，或全写"无特殊要求"不给理由 |

### §1.1 非功能维度说明

非功能维度在 spec §6 中必须逐条呈现，不允许整节空白：

- **性能**：给出可量化指标（响应时间 P95 / 吞吐量 / 并发上限），或附理由写"N/A（纯前端渲染，无后端延迟路径）"
- **安全**：明确鉴权方式、数据校验边界、敏感字段处理规则；涉及 cookie/session 必须说明 SameSite/Secure 策略
- **可观测性**：新增 API endpoint 必须说明日志级别和告警条件；若无则写"N/A（纯 UI 改动，无新 API）"
- **兼容性**：说明最低支持浏览器版本 / 移动端 / API 版本向后兼容策略
- **可访问性（A11y）**：涉及表单 / 弹框 / 交互元素必须说明 ARIA label 和键盘导航支持；若完全无 UI 改动写"N/A"

### §1.2 最低 AC 数量

每份 spec 至少 1 条 AC，且每条 AC 必须对应 `scope.in` 中至少 1 个功能点。spec-reviewer S1 检查时遍历全部 AC，任何无法追溯的 AC 标 `covered: false`。

---

## §2 enrichedInput Schema 契约

`src/quick-impl/enriched-input-schema.ts` 中的 `EnrichedInput` Zod schema 是三方共识的数据合同。任何 role 都不应自行重定义这些字段的含义。brainstorm-host 的职责是尽量填满所有字段；当 `partial: true` 时，`missingFields` 明确列出哪些字段没有足够信息，spec-author 必须将这些字段对应的问题列为 `OPEN_QUESTION`，不允许以默认值掩盖信息缺口。

### 关键字段说明

| 字段 | brainstorm-host 怎么产 | spec-author 怎么消费 | spec-reviewer 怎么验证 |
|---|---|---|---|
| `actors.triggerer` | 从对话中识别发起人角色 | 写入 spec §1 背景与目标，AC 中的 Given 角色 | S1 检查：AC Given 角色是否与 triggerer 一致 |
| `actors.primaryUsers` | 列出所有受影响的用户群体 | 写入 spec §3 功能描述，识别需要权限控制的场景 | S1 检查：AC 覆盖了所有 primaryUsers 的核心路径 |
| `actors.verifier` | 识别最终验收人（人工测试者） | e2eScenarios 以 verifier 视角设计步骤和断言 | specCoverage 中确认 scenario 步骤符合 verifier 操作习惯 |
| `objective.userValue` | 从对话中提炼用户直接受益 | 每条 AC 必须反向链接此字段（见 §3） | S1 检查：是否存在无法追溯到 userValue 的 AC |
| `objective.businessValue` | 从对话中提炼业务收益 | 写入 spec §1 目标，reviewHints 中标记高价值风险 | S5 检查：reviewHints 是否漏判了影响 businessValue 的风险 |
| `objective.successSignal` | 从对话中识别成功可观测指标 | 转化为 e2eScenarios 的验收断言（acceptance 字段） | S2 检查：断言是否确实可观测 |
| `scope.in` | 列出本次要实现的具体功能点 | acceptanceCriteria 一一对应 scope.in 中每个功能点 | S1 检查：每条 AC 能溯源到 scope.in 某个条目 |
| `scope.out` | 列出明确不做的内容 | 转化为 JSON noGos[] + spec §10 超出范围 | S4 检查：noGos 边界是否与 scope.out 一致 |
| `scope.deferred` | 列出暂缓的功能 | 写入 spec §10 超出范围，标注"本期不做" | S4 检查：deferred 功能未混入当前 AC |
| `noGos` | 从对话识别明确禁止的行为 | 直接合并进 JSON noGos[]，补充技术边界 | S4 检查：JSON noGos 覆盖了 enrichedInput.noGos 的全部条目 |
| `historicalRefs` | 记录历史版本、已弃用方案、相关 PR | spec-author 对照 existing/deprecated 决策是否仍适用 | S7 检查：references 中是否引用了 historicalRefs 指向的历史代码 |
| `codebaseEvidence` | brainstorm 阶段已查证的 file:line | **直接复用**，不允许重新 grep 同一目标（见 §5） | S7 检查：references 是否与 codebaseEvidence 保持一致 |
| `conversationSummary` | 对话全程摘要 | 写入 spec §2 澄清记录作为背景 | 检查 spec §2 是否与 conversationSummary 语义一致 |
| `qaTurnCount` | 对话轮次数 | 判断 partial=true 时是否需要开放更多 openQuestions | 若 qaTurnCount < 3 且 partial=false，注意是否遗漏澄清 |
| `partial` | 信息是否不完整 | partial=true 时强制列 openQuestions，不允许凑默认值掩盖 | S3 检查：partial=true 时 openQuestions 是否存在且非空 |
| `missingFields` | 具体缺失的字段名 | 对应 openQuestions 中每个 OPEN_QUESTION 条目 | 核实 missingFields 中列出的字段在 spec 中是否有声明处理方式 |

### businessWindow 字段

`businessWindow` 为可选字段，记录截止日期、上游依赖和优先级。spec-author 应将 `priority: "critical"` 或存在 `deadline` 的需求标注在 reviewHints 中，提醒审批人重点关注时间约束。

### schema 版本管理

EnrichedInput schema 版本字段（`schemaVersion: "v1"`）由 brainstorm-host 写入，spec-author 和 spec-reviewer 不修改它。如果 schema 升级到 v2，必须同步更新本文档 §2 章节。

---

## §3 AC 质量准则

### Given-When-Then 格式（硬规则，lint L3 兜底）

每条 acceptanceCriteria 的 text 必须严格匹配 Given-When-Then 三段结构。lint L3 机械校验格式；本节为语义层要求，补充 lint 无法判断的内容质量：

- **Given**：描述前置状态（用户角色、系统状态、必要数据）。不允许写"Given 用户"这种无角色信息的空壳；必须明确用户身份（如"Given 已登录的管理员"）
- **When**：描述触发动作（具体 HTTP method + path / UI 操作 + 目标元素 / 定时触发条件）。不允许用被动语态（"当操作被触发"）；必须是主动明确动作
- **Then**：描述可观测结果（响应码 + body 字段 / UI 元素出现 / DB 表行状态）。此处是主观词黑名单的重灾区，见下方反模式黑名单

### spec.md §4 与 JSON acceptanceCriteria 的一致性

spec.md §4 中的 AC 列表数量必须等于 JSON `acceptanceCriteria[]` 数组长度（lint L10 校验）。两者之间 AC id 和文本必须完全一致，不允许 spec.md §4 比 JSON 多出或缺少条目。

### "可观测断言" 定义

断言必须满足：能被 Playwright 自动化测试、HTTP 客户端、或 DB 查询客观判断真假，无需人工主观判断。

合格示例：
- "页面 URL 跳转到 /dashboard"
- "API 返回 status=201 且 body.userId 为非空字符串"
- "数据库 user_sessions 表中 user_id=X 的行存在且 expires_at > NOW()"
- "HTTP 响应 header 包含 Set-Cookie: session=...; SameSite=Strict"

不合格示例：
- "用户体验良好"（主观）
- "功能正常工作"（无信息量）
- "界面美观协调"（无法自动化）

### 反模式黑名单（命中即 reviewer S2 fail）

以下模式出现在 AC Then 子句中，立即判 S2 fail：

- 主观形容词：**"应该"、"正常"、"协调"、"友好"、"良好"、"直观"、"完善"**
- 无信息量断言：**"通过"、"成功"、"OK"**（trim 后单字成立的断言）
- 复制粘贴：**直接将 acceptanceCriteria 文本复制为 e2eScenarios.acceptance**（未翻译成可观测断言）

### AC 反向链接要求

每条 AC 必须能追溯到 `enrichedInput.objective.userValue`、`enrichedInput.objective.successSignal` 或 `enrichedInput.scope.in` 中的某个具体条目。spec-reviewer 的 specCoverage 字段正是记录这个追溯关系（`covered: true/false`）。

`rawInput` 仅作退化路径的冗余兜底：当 brainstorm-host 未能产出完整 EnrichedInput（partial=true 且 enrichedInput 不可用）时，才允许直接从 rawInput 推导 AC 锚点。

### clarifications 字段质量准则

clarifications[] 同时服务两个消费者：人工审批者（判断哪些默认决定需要 challenge）和下游 plan-decomposer（理解需求边界）。

- **kind=fact**：你从 codebase 读到的客观事实，例如"当前登录页无 Checkbox（grep 验证）"。此类条目无需 `userMayDisagreeIf`
- **kind=assumption**：你替用户做的默认决定，必须填 `userMayDisagreeIf`，说明用户在何种情况下会否决该假设。这是审批人 triage 最快入口
- 每份 spec 至少 1 条 kind=assumption（lint L11 校验）——任何非 trivial 需求必然有默认决定，全 fact 表示 spec-author 回避了决策

常见需要标 assumption 的决策类型：
- 默认值选择（"首次访问默认不勾选"）
- 兼容性边界（"不支持 IE11"）
- 降级策略（"第三方 API 超时时返回空列表而非报错"）
- 权限粒度（"普通用户无法访问该页面，返回 403"）

---

## §4 e2eScenarios 合规标准

e2eScenarios 是 spec 的可执行契约，由 QI E2E 测试框架直接消费。不合规的 scenario 会被 spec 节点直接拒批。spec.md §5 中的 scenario 数量必须等于 JSON `e2eScenarios[]` 数组长度（lint L10 校验），且顺序对应一致。

### A. 硬规则（schema 强制，不达标直接 fail）

| 规则 | 说明 |
|---|---|
| 数量 | `1 ≤ e2eScenarios.length ≤ 5`（防 LLM 凑数） |
| 步骤 | 每个 scenario `steps.length ≥ 1` |
| 断言 | 每个 scenario `acceptance.length ≥ 1` |
| AC 关联 | 每个 scenario `coversAC` 数组非空，每项匹配 `^AC-\d+$` 且必须在 `acceptanceCriteria[].id` 集合内 |
| AC 全覆盖 | `acceptanceCriteria` 全集 ⊆ `⋃ scenarios.coversAC`（每个 AC 都被至少 1 个 scenario 覆盖） |
| 反向场景 | 至少 1 个 `kind === 'negative'`（错误输入 / 权限不足 / 边界值） |
| ID 唯一 | `scenario.id` 在数组内唯一 + 匹配 `^[a-z][\w-]+$`（kebab-case） |

### B. 软规则（自检 + reviewer 兜底）

1. **步骤具体性**：每个 step 必须包含「动作动词 + 具体目标 + 具体数据」三要素
   - 合格："POST /api/users 提交 body `{username:'admin', email:'a@b.c'}`，期望返回 201"
   - 合格："在登录页输入用户名 `admin` 密码 `Test123!`，点击 `[data-testid=login-btn]` 按钮"
   - 不合格："用户登录系统"（动作模糊、无数据、无目标元素）
   - 不合格："测试创建用户功能"（meta 描述，不是动作）

2. **acceptance 可观测**：每个断言必须能被 Playwright/HTTP/DB 客观判断真假
   - 合格："页面出现文本 `登录成功`"
   - 合格："API 返回 status=201 且 body.userId 是非空字符串"
   - 合格："数据库 users 表 username='admin' 的行存在且 created_at > 测试开始时间"
   - 不合格："用户体验良好"（主观）
   - 不合格："功能正常工作"（无信息量）
   - 不合格："应该能登录"（应然不等于实然，不是可执行断言）

3. **数据来源明确**：scenario 用到的具体数据要么在 step 里凭空生成（明确写出值），要么 spec 里声明为 fixture / seed。禁止步骤里出现"使用某个用户"这种引用未定义对象的措辞

4. **独立可执行**：scenario 之间不依赖执行顺序，不共享状态。每个 scenario 必须能从空库 / 全新 sandbox 独立跑通

5. **范围聚焦**：scenario 仅验证本需求 acceptanceCriteria 范围内的代码路径。不测试已有功能（那是项目级回归责任），不测试 spec 未声明的边界

6. **覆盖深度**：单个 scenario 不要试图覆盖 ≥3 个 AC，每个 AC 至少应有 1 个独立 scenario

### C. 反模式黑名单（命中即拒）

- 步骤含"应该" / "正常" / "正确"等应然表述
- acceptance 含"通过" / "成功" / "OK"单字成立的断言
- 步骤是"测试 X"、"验证 Y"这种 meta 描述
- scenario 跨多个独立功能（同一 scenario 既测登录又测注册）
- 完全照抄 acceptanceCriteria 的文本作为 acceptance（没翻译成可观测断言）
- 引用 spec 未定义的概念 / 角色 / 数据
- happy 场景占比 100%（缺反向场景）

---

## §5 调研留痕标准

### §5.1 references[] 路径合规

- `references[].file` 必须匹配路径白名单（lint L1）：`src/**/*.ts`、`web/src/**/*.ts`、`docs/**/*.md` 等项目内路径
- 禁止使用 `../`、绝对路径、`node_modules` 内路径
- `references[].line` 指定的行号必须在 worktree 中真实存在（lint L9，±5 行容忍）
- line 指向的代码内容必须与该 reference 的 `purpose` 描述语义相关（spec-reviewer S7 检查）

### §5.2 codebaseEvidence 复用要求

- spec-author 必须优先复用 `enrichedInput.codebaseEvidence` 中已查证的 file:line，不允许重新 grep 同一目标文件的同一目的
- 如发现 codebaseEvidence 中某条 file:line 已失效（文件移动 / 行号漂移），在 `notes` 加 warn 标出，不阻断 spec 产出
- 确需新增 references 时（brainstorm 阶段未覆盖的模块），spec-author 自行查证后加入，同时在 clarifications 注明
- spec.md §7 中 references 数量必须等于 JSON `references[]` 数组长度（lint L10 校验）

### lint L1-L12 分工说明

qi-spec-lint.ts（`scripts/qi-spec-lint.ts`）承担所有 mechanical 校验，三方 role 不重复这些规则，只做人工/语义层判断：

| Lint 规则 | 说明 | 谁兜底 |
|---|---|---|
| L1 | references[].file 路径白名单 | lint（自动） |
| L2 | acceptanceCriteria[].id 唯一 + `^AC-\d+$` | lint（自动） |
| L3 | acceptanceCriteria[].text GWT 格式 | lint（自动） |
| L4 | e2eScenarios 数量 [1,5] + ≥1 negative + ID kebab-case 唯一 | lint（自动） |
| L5 | 每个 AC.id 被某 scenario.coversAC 引用 | lint（自动） |
| L6 | scenarios.steps 应然词黑名单 | lint（自动） |
| L7 | scenarios.acceptance 单字断言黑名单 | lint（自动） |
| L8 | risks.length ≥ 1 + 拒"无明显风险" | lint（自动） |
| L9 | references file:line 在 worktree 存在（±5 行容忍） | lint + S7（语义） |
| L10 | spec.md §4/§5/§7/§8 项数 == JSON 字段长度 | lint（自动） |
| L11 | clarifications ≥ 1 条 kind="assumption" | lint + S3（质量） |
| L12 | selfCheck.length ≤ 3 + ≥ 1 条含"最弱点/最不确定" | lint（自动） |

spec-reviewer 执行 S1~S7 检查时不重复上表 lint 已覆盖的 mechanical 判断，只做语义层补充（S3 关注 assumption 描述质量而非数量；S7 关注 line 指向代码是否语义相关）。

`enrichedInput.historicalRefs` 记录了历史版本、已弃用方案、相关 PR 的指针。spec-author 必须对照 `relation: "deprecated"` 和 `relation: "past_attempt"` 的条目，在 spec §7 或 clarifications 中声明是否复用、弃用或规避。不处理 historicalRefs = 隐藏历史包袱，属于 spec-reviewer S7 warn 项。

---

## §6 反模式黑名单（共享）

以下行为在任何 role 中均视为 spec 质量问题，spec-reviewer 对应项目直接判 fail 或 warn。

### error 级（spec-reviewer 判 fail）

**凭空加 AC（见 §3 AC 反向链接要求）**
某条 AC 在 rawInput 和 enrichedInput 中都找不到锚点——既无 `scope.in` 对应条目，也无 `objective.userValue` 或 `objective.successSignal` 对应目标。`specCoverage.covered: false` 即为此情形。常见来源：spec-author 想"补充完整性"而加入实际未被用户提出的功能约束。

**AC Then 子句含主观词（spec-reviewer S2 fail）**
命中以下词语的 Then 子句不可自动化验证，直接 fail：
"应该"、"正常"、"协调"、"友好"、"良好"、"直观"、"完善"、"通过"、"成功"、"OK"

**noGos 空泛占位（spec-reviewer S4 fail）**
noGos[] 中出现"不实现额外功能"、"不做多余改动"等无法 reject 具体 plan task 的描述。合格的 noGos 条目必须明确到具体技术行为，如"不修改 session 表结构"、"不实现 OAuth 2.0 流程"——plan-decomposer 遇到触及禁区的 task 会执行 `reject_input`，所以描述必须足够具体。

**assumptions 缺 userMayDisagreeIf（spec-reviewer S3 fail）**
kind=assumption 的 clarification 条目未填 `userMayDisagreeIf`，导致审批人无法快速判断哪些默认决定需要人工 challenge。任何非 trivial spec 必然有 ≥1 条 assumption，lint L11 校验数量，本规则校验质量。

### warn 级（spec-reviewer 写 notes，不阻断 plan-decomposer）

**凑数 reviewHints**
`reviewHints[]` 中全部条目 severity=low 且描述空泛（如"请审批人确认 spec 是否完整"、"建议 review AC-1"），没有说明"为什么这条最该 review"。这种情形等同于信息噪声，审批人收到后无决策依据。正确做法：写不出有价值的 hints 时，给空数组——不要凑数。

**凑数 risks**
`risks[]` 全部 severity=low + 描述空泛，强烈怀疑漏判。例如：纯前端 localStorage 改动未提 XSS 风险；schema 迁移未提回滚复杂度；第三方 API 依赖未提不可用降级。

**confidenceLevel 失真**
confidenceLevel=high 但 spec 涉及陌生模块、新引入依赖、多模块联动、或存在 ≥1 条 high severity risk。错误的 confidenceLevel 会让审批人忽视本该重点 review 的 spec，失去信号价值。

**selfCheck 机械打勾（lint L12 兜底）**
selfCheck 条目中无"最弱点"或"最不确定"关键词，或全部条目是 mechanical 格式（`passed: true/false`）而非主观判断格式（`item: "为什么 X"，answer: "..."`）。v3 已将 mechanical 校验全部移至 qi-spec-lint.ts L1-L12；selfCheck 只保留主观判断。

---

## §7 各 role 引用义务

| Role | 必读章节 | 产出义务 |
|---|---|---|
| brainstorm-host | §1 / §2 / §6 | 产出满足 §2 EnrichedInput schema 的 JSON；对照 §1 确认 5 维度信息已收集；避免 §6 error 级反模式 |
| spec-author | §1 / §2 / §3 / §4 / §5 / §6 | AC 遵守 §3 格式与黑名单；e2eScenarios 通过 §4 A/B/C 全检；references 遵守 §5 留痕标准；输出前对照 §6 全部反模式自查 |
| spec-reviewer | §1 / §2 / §3 / §4 / §5 / §6 | 验证 spec-author 是否遵守上述全部规则；specCoverage 每条标注 §3 的反向链接情况；S1~S7 全部检查填入 selfCheck |

### 引用声明格式

各 role.md 文件头必须包含以下引用声明（替换 `{role-name}` 为实际 role 名称）：

```
> 质量标准：[docs/standards/qi-spec-quality.md](../../../docs/standards/qi-spec-quality.md)
> 本 role.md **不重复定义** §1~§7 中的规则，只保留本 role 特有的操作步骤、输出 schema 和 fail 条件。
```

### 规则冲突处理

如果某 role.md 中有与本文档冲突的规则描述，以本文档为准。role.md 中冗余的规则定义应在下一次 role.md 更新时删除，避免 drift。

发现 role.md 与本文档冲突时的处理流程：
1. 以本文档（qi-spec-quality.md）为权威版本
2. 在 role.md 对应位置加注释引用本文档对应章节
3. 下一轮 role.md 版本升级时将冗余规则彻底删除，改为引用
