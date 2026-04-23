# 架构设计 Agent（Arch Agent）能力升级

> **状态**: drafting
> **PM**: zhangshanshan
> **产品线**: Demo 产线 (demo)
> **创建时间**: 2026-04-23

---

## 1. 愿景与目标

### 1.1 愿景

让架构设计文档成为 PRD 到代码之间的高质量中间层，为下游开发 Agent 提供无歧义的设计输入。

**一句话定义**: 将 Arch Agent 升级为三 Agent 协作模式，输出覆盖 C4 三层图、PRD 可追溯、含开发指引的架构设计文档。

### 1.2 目标

1. 新增 REVIEW Agent，从技术合理性、文档完整性、PRD 一致性 3 个维度串行审查架构文档
2. 新增 REPAIR Agent，根据 Review 意见自动修复可修复的问题，剩余问题交用户决策
3. 扩展架构文档结构，支持 C4 三层图（Context / Container / Component）
4. 新增 PRD 双层追溯字段（Component.covers[] + ADR.prdSource），确保架构可回溯到 PRD 需求
5. 新增现有系统影响分析章节（impacts[]），对齐 PRD Agent 的枚举定义
6. 新增开发指引章节，为下游开发 Agent 提供 Story 拆分建议、优先级顺序、接口契约摘要、环境依赖清单

### 1.3 成功指标

| 指标 | 目标值 | 度量方式 |
|------|--------|---------|
| Review Agent 机械校验通过率 | 首次生成文档通过率 ≥ 70% | save_arch 调用中 mechanicalErrors 为空的比例，按月统计 |
| 架构文档 PRD 追溯覆盖率 | 有 sourcePrdId 的文档中，Component.covers[] 不为空的比例 ≥ 90% | arch_documents 表中 content_json.components 字段统计，按月 |
| 开发指引章节完整率 | approved 状态文档中包含非空 developmentGuide 章节的比例 = 100% | arch_documents 表中 status=approved 且 content_json.developmentGuide 非空的比例，按月 |

---

## 2. 用户与场景

### 2.1 目标用户

**架构师（Architect）和技术负责人（Tech Lead）**

架构师在 IM 群聊或管理后台中与 Arch Agent 对话，基于已审批的 PRD 或独立输入，逐步完成架构设计。文档通过 Review + Repair 流程后，进入 approved 状态，供下游开发 Agent 直接使用。

### 2.2 使用场景

1. **有 PRD 输入场景**: PRD 审批通过 → 架构师在 IM 触发 Arch Agent → 输入 sourcePrdId → Agent 读取 PRD 内容 → 逐章节引导设计 → 机械校验 → Review 3 轮 → Repair → 人工确认 → approved
2. **独立使用场景**: 架构师直接发起对话 → 手动描述背景 → 逐章节设计 → 同上流程 → approved

---

## 3. 功能需求

### 3.1 Review Agent：3 轮串行技术审查

**优先级**: P0
**来源**: 用户在 Phase 2 明确说 "Review Agent 的审查重点：D（以上都要）；3 轮串行"

新增独立 REVIEW Agent，在 save_arch 成功后自动触发，串行执行 3 轮审查：
- 第 1 轮：**技术合理性**（NFR 覆盖、单点故障、安全边界）
- 第 2 轮：**文档完整性**（13 章是否填写、ADR 是否覆盖所有技术选型）
- 第 3 轮：**PRD 一致性**（功能需求是否都有对应组件，组件 covers[] 是否回溯到 PRD 需求 ID）

3 轮结果汇总为一份 reviewResult，写入 arch_documents.review_result 字段。

**验收标准**:
- 3 轮审查每轮输出独立 JSON 对象，包含 `dimension`（技术合理性/文档完整性/PRD 一致性）、`issues[]`（每条含 `severity: blocker|warning`、`field`、`message`）、`passed: boolean`
- 全部 3 轮通过（passed=true）时，arch_documents.status 自动更新为 `draft`；任一轮有 blocker 时 status 保持 `review_blocked`
- 3 轮总 latency ≤ 60 秒（P99，基于 Claude API 调用，不含排队等待）

**状态流转**:

| 字段 | 值 |
|------|---|
| trigger | save_arch 返回 success=true |
| stateChange | arch_documents.status: drafting → review_blocked（等待 review 完成） |
| notify | 无（异步静默执行，完成后通知） |
| nextActor | REVIEW Agent 依次执行 3 轮 |
| terminalState | 3 轮全通过 → status=draft；任一轮有 blocker → status=review_blocked，写入 reviewResult |

---

### 3.2 Repair Agent：Review 意见自动修复

**优先级**: P0
**来源**: agent_inferred，Phase 2，用户选定 Review Agent 3 轮串行后，Agent 推断需配套自动修复流程；用户明确确认"可以，对齐 PRD Agent 的多 Agent 模式"

新增 REPAIR Agent，在 Review 完成且有 blocker 时触发。Repair Agent 读取 reviewResult，对每条 blocker 尝试自动修复：可修复的直接更新 structured 字段并重新调用 save_arch；不可修复的（需人工决策）列出清单，通知架构师。

**验收标准**:
- Repair Agent 对每条 blocker 给出 `fixable: true|false` 判断，fixable=true 的条目必须在输出中有对应 `fixedField` 和 `fixedValue`
- Repair 后重新调用 save_arch，mechanicalErrors 数量相比 repair 前减少 ≥ 1 条
- 不可修复的 blocker 以结构化清单（含 field + message + suggestedAction）展示给用户，每条不超过 50 字

**状态流转**:

| 字段 | 值 |
|------|---|
| trigger | Review 完成且 reviewResult 含 blocker |
| stateChange | arch_documents.status: review_blocked → repairing |
| notify | 无（异步静默） |
| nextActor | REPAIR Agent 逐条处理 blocker |
| terminalState | 可修复项修复完成 → 重新 save_arch → 重新触发 Review；不可修复项 → 展示给用户，status=review_blocked 待人工干预 |

---

### 3.3 C4 三层图表

**优先级**: P0
**来源**: 用户在 Phase 2 明确说 "A：3 层全要（Context + Container + Component，最完整）"

扩展 StructuredArch.overview，在现有 componentDiagram（组件层）基础上新增：
- `contextDiagram`：系统上下文层，展示系统与外部用户/系统的边界关系
- `containerDiagram`：容器层，展示系统内主要运行单元及其通信方式

3 张图均为 Mermaid 格式，机械校验要求 contextDiagram 和 containerDiagram 非空，P0 工作流必须有 sequenceDiagram。

**验收标准**:
- contextDiagram 字符串包含有效 Mermaid 关键词（graph、flowchart、C4Context 之一）且长度 ≥ 50 字符
- containerDiagram 字符串包含有效 Mermaid 关键词且长度 ≥ 50 字符
- save_arch 机械校验：contextDiagram 或 containerDiagram 为空时返回 blocker（ruleId: `c4_diagrams_complete`）
- Renderer 渲染输出中，Context 图在 Container 图之前，Component 图在 Container 图之后，顺序固定

---

### 3.4 PRD 双层追溯字段

**优先级**: P1
**来源**: 用户在 Phase 2 明确说 "C：两者都要——Component 知道覆盖哪些需求，ADR 知道决策动机来自哪里"

在 StructuredArch 中新增两处追溯字段：
- `ComponentItem.covers`（string[]，可选）：该组件覆盖的 PRD 功能需求 ID 列表（如 `['3.1', '3.2']`），独立使用时允许为空
- `AdrItem.prdSource`（string，可选）：该 ADR 的决策动机来自哪条 PRD 需求或 NFR（如 "来自 PRD#42 需求 3.3：响应时间 P99 < 500ms"）

**验收标准**:
- ComponentItem 接口新增 `covers?: string[]` 字段，Renderer 在组件表格中渲染为逗号分隔的需求 ID 列
- AdrItem 接口新增 `prdSource?: string` 字段，Renderer 在 ADR 章节中渲染为独立行
- 当 arch.sourcePrdId 存在且所有 components 的 covers 均为空时，机械校验返回 warning（ruleId: `prd_coverage_missing`），不阻断保存

---

### 3.5 现有系统影响分析章节

**优先级**: P1
**来源**: 用户在 Phase 2 明确说 "A：模块级，和 PRD 的 impacts[] 对齐"

新增 `StructuredArch.impacts[]`，结构对齐 PRD 的 PrdImpactItem：
- `module`：模块名
- `type`：7 值枚举（行为变更/接口变更/数据结构变更/UI 变更/行为复用/性能影响/无直接影响）
- `compatibility`：3 值枚举（完全兼容/向后兼容/破坏性变更）
- `description`：影响描述
- `source`：来源可追溯（phase/quote/type）

当 impacts 中有 compatibility=破坏性变更 的条目时，`breakingChanges[]` 必须有对应详述。

**验收标准**:
- impacts[] 枚举值与 PRD 对齐：type 传入非枚举值时 save_arch 返回 blocker
- compatibility 限于 3 个枚举值，传入其他值时 save_arch 返回 blocker
- impacts 为空时 save_arch 返回 blocker（ruleId: `impacts_required`）
- impacts 中任一条目 compatibility=破坏性变更 且 breakingChanges 无对应条目时，save_arch 返回 blocker（ruleId: `breaking_change_detail`）

---

### 3.6 开发指引章节

**优先级**: P1
**来源**: 用户在 Phase 2 明确说 "B：新增独立章节——Story 拆分建议、开发优先级顺序、关键接口契约摘要、本地环境依赖清单"

新增 `StructuredArch.developmentGuide` 字段，包含 4 个子字段：
- `storyBreakdown`：Story 拆分建议，按组件/功能边界列出，每条含 title + description + relatedComponents
- `developmentOrder`：开发优先级顺序，有序数组，每条含 step + component + reason
- `keyInterfaces`：关键接口契约摘要，每条含 name + endpoint/method + description
- `localEnvDeps`：本地环境依赖清单，每条含 name + version + purpose

**验收标准**:
- developmentGuide 下 storyBreakdown 数组长度 ≥ 1，每条含非空 title 字段；status=approved 时该约束为 blocker，drafting 时为 warning
- developmentOrder 数组长度 ≥ 1，每条 step 为正整数且不重复
- Renderer 将 developmentGuide 渲染为独立章节，位于 readinessChecklist 之前

---

### 3.7 Bug 修复：arch-documents.ts pool 未定义

**优先级**: P0
**来源**: 代码库探索发现，arch-documents.ts 约第 95-99 行直接引用 pool 变量，但该文件未导入 getPool()

修复 `src/db/repositories/arch-documents.ts` 中存在的变量引用错误，确保对 arch_documents 表的增删改查操作正常执行，不抛出运行时错误。

**验收标准**:
- 修复后对 arch_documents 表的增删改查操作不抛出 ReferenceError
- 修复后 `npx vitest run src/__tests__/unit/save-arch-tool.test.ts` 通过率 = 100%（验证 arch-documents 数据库操作正常）

---

## 4. 非功能需求

各功能验收标准中已包含，关键指标汇总：

| 类别 | 指标 | 目标 |
|------|------|------|
| 性能 | Review 3 轮总 latency | P99 ≤ 60 秒（不含排队） |
| 可靠性 | Repair 后机械校验通过率 | 每次 repair 至少减少 1 条 blocker |
| 完整性 | approved 文档开发指引覆盖率 | = 100% |

---

## 5. 与现有系统集成

复用以下现有模块：

- `src/agent/arch/` 现有骨架（prompts/rules/renderer/structured-types/mechanical-check）
- `src/agent/tools/save-arch.ts`、`read-arch.ts`、`update-arch-context.ts`、`search-existing-arch.ts`（4 个 MCP 工具）
- `src/db/repositories/arch-documents.ts`、`arch-chat.ts`（DB 层）
- PRD Agent 的 `impacts[]` 枚举定义（对齐复用，不重复定义）

---

## 6. 对现有功能的影响

### 6.1 受影响模块清单

| 模块 | 影响类型 | 兼容性 | 说明 | 来源 |
|------|---------|--------|------|------|
| src/agent/arch/structured-types.ts | 接口变更 | 向后兼容 | 新增 contextDiagram、containerDiagram、ComponentItem.covers[]、AdrItem.prdSource、impacts[]、breakingChanges[]、developmentGuide 字段；旧字段全部保留，新字段均为可选 | agent_inferred，Phase 2，C4 图/PRD 追溯/impacts/开发指引 4 个功能均要求扩展类型定义，用户逐一确认 |
| src/agent/arch/rules.ts | 行为变更 | 完全兼容 | 新增 5 条规则（c4_diagrams_complete、prd_coverage_missing、impacts_required、breaking_change_detail、development_guide_complete）；现有 9 条规则逻辑不变 | agent_inferred，Phase 2，每个新功能对应配套机械校验规则，用户确认"规则要和功能一起加" |
| src/agent/arch/renderer.ts | 行为变更 | 完全兼容 | 新增 Context 图、Container 图、impacts 章节、developmentGuide 章节渲染；ADR 章节新增 prdSource 行；Component 表格新增 covers 列 | agent_inferred，Phase 2，新增字段均需渲染到 Markdown 文档，用户确认章节顺序要求 |
| src/agent/arch/prompts.ts | 行为变更 | 破坏性变更 | 从单一 CREATE prompt 拆分为 CREATE / REVIEW / REPAIR 三个独立 prompt | user_said，Phase 2，用户明确说"Review Agent 的审查重点：D（以上都要）；3 轮串行"，触发 REVIEW/REPAIR prompt 必须独立 |
| src/db/repositories/arch-documents.ts | 行为变更 | 完全兼容 | 修复 arch-documents.ts 中存在的变量引用错误，确保数据库操作正常执行 | codebase_fact，代码库探索发现 arch-documents.ts 约第 95-99 行存在变量引用错误 |

### 6.2 破坏性变更详述

**prompts.ts：单 prompt → 三 Agent prompt**

| 字段 | 内容 |
|------|------|
| 现状 | prompts.ts 导出单一字符串变量（CREATE prompt），被 arch agent runner 直接引用 |
| 变更后 | 导出 3 个变量：CREATE_ARCH_SYSTEM_PROMPT、REVIEW_ARCH_SYSTEM_PROMPT、REPAIR_ARCH_SYSTEM_PROMPT，调用方按场景选择 |
| 影响方 | src/agent/arch/ 内的 agent runner/协调器；src/agent/coordinator.ts（如有引用 arch prompt） |
| 迁移步骤 | 1. 将现有单 prompt 变量重命名为 CREATE_ARCH_SYSTEM_PROMPT；2. 新增 REVIEW 和 REPAIR prompt；3. 更新所有 import 引用；4. arch agent 调用逻辑按阶段选择对应 prompt |
| 回滚策略 | 回滚只需还原 prompts.ts 到单变量导出并恢复调用方 import，不涉及数据库数据变更，可随时回滚 |

### 6.3 回归测试建议

- prompts.ts 拆分后，需验证 CREATE 流程完整对话可触达 save_arch
- structured-types.ts 新增字段后，需验证旧格式文档仍可正常读取和渲染
- rules.ts 新规则加入后，需验证现有通过的 arch 文档不被新规则误判为 blocker

---

## 7. 范围边界

### 一期做

- REVIEW Agent（3 轮串行：技术合理性 / 文档完整性 / PRD 一致性）
- REPAIR Agent（自动修复可修复 blocker，不可修复的列清单给用户）
- C4 三层图表（Context + Container + Component，Mermaid 格式，机械校验强制非空）
- PRD 双层追溯（ComponentItem.covers[] + AdrItem.prdSource）
- 现有系统影响分析章节（impacts[] + breakingChanges[]，枚举对齐 PRD）
- 开发指引章节（storyBreakdown / developmentOrder / keyInterfaces / localEnvDeps）
- arch-documents.ts pool 未定义 bug 修复

### 不做 / 二期

| 条目 | 原因 |
|------|------|
| API 接口级影响分析（精确到接口 diff） | 粒度太细，留给开发 Agent 处理 |
| C4 第 4 层（Code 级图表） | 与代码实现绑定，属于开发 Agent 职责 |
| 自动生成 Story/Task 并写入任务系统 | 属于开发 Agent 职责范围 |

---

## 8. 待定事项

（无）

---

## 9. 决策日志

| 决策 | 理由 | 备选方案 | 决策时间 |
|------|------|---------|---------|
| Review Agent 采用 3 轮串行而非 1 次并行 | 用户明确选择串行，每轮输出更清晰，便于 Repair Agent 按维度处理 | 1 次并行输出（更快，但 3 维度混在一起难以 Repair） | 2026-04-23 |
| C4 图表要求 3 层全部必填 | 用户选择"3 层全要"，覆盖广是核心质量维度之一 | 仅 Container+Component；全部选填 | 2026-04-23 |
| PRD 追溯采用组件级 + ADR 级双层追溯 | 用户选择"两者都要"，从功能需求到技术决策全链路可追溯 | 仅组件级；仅 ADR 级 | 2026-04-23 |
| 新增独立开发指引章节而非强化 readinessChecklist | 用户选择方案 B，独立章节让开发 Agent 有专门的消费入口 | 强化 readinessChecklist（不新增章节） | 2026-04-23 |
