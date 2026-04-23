# UI/UX 设计师 Agent — 产品需求文档

**作者:** sherryswift1019-gif  |  **日期:** 2026-04-22  |  **版本:** 1.0  |  **状态:** Draft

---

## 1. 愿景与目标

### 1.1 产品愿景（一句话）
为 UI/UX 设计师提供专业助手，通过渐进式对话将 PRD 或设计描述转化为结构化 Markdown 设计规范文档和可交互 HTML 原型，为下游 Dev Agent 和 Arch Agent 提供机器可读的设计输入。

### 1.2 项目目标
1. 将 PRD 转化为规范化、机器可读的设计文档，减少设计师文档编写负担
2. 生成可直接用于 PM/设计师 review 的 HTML 原型，提升沟通效率
3. 通过 UX 铁律强制保证设计文档质量（边界状态完整、一致性、易用性基线）
4. 产出可被下游 Dev Agent / Arch Agent 直接消费的标准化设计规范
5. 独立触发，接口预留，为后续 PRD Agent → UI Agent → Dev Agent 编排串联做好准备

### 1.3 成功指标

| 指标 | 目标值 | 度量方式 |
|------|--------|---------|
| 交付的设计规范文档章节完整率（11 章模板） | ≥ 95% | 自审维度 1 "格式完整性" 通过率 |
| 边界状态覆盖率 | 每页 4 种状态覆盖率 = 100% | 自审维度 2 检查结果 |
| 设计师满意度 | ≥ 4/5 分 | 交付后人工评分 |
| 首轮生成成功率（无需重新生成） | ≥ 80% | 用户是否触发重新生成 |

> 注: 本 PRD 本身采用 9 章模板（与 PRD Agent 对齐）；"11 章" 指的是 **Agent 交付的设计规范文档** 内部结构，两者不是同一层级。

---

## 2. 用户与场景

### 2.1 目标用户

| 角色 | 描述 | 核心诉求 |
|------|------|---------|
| UI/UX 设计师 | 主要使用者，通过 IM 或 Web 对话面板与 Agent 交互 | 快速产出规范设计文档，减少重复劳动 |
| 产品经理（PM） | 通过 HTML 原型 review 交互设计，确认功能实现方式 | 直观看到交互效果，提供反馈 |
| Dev Agent | 下游消费者，读取 Markdown 设计规范实现 UI | 清晰的组件规范、状态定义、交互行为 |
| Arch Agent | 下游消费者，读取信息架构章节理解系统结构 | 页面层级、数据流向、模块依赖 |

### 2.2 用户旅程

**旅程 1: 基于 PRD ID 创建设计文档（主流程）**
1. 设计师在 IM 中发送"帮我设计 PRD #42 的用户管理模块"
2. Agent 调用 `read_prd(42)` 加载 PRD，提取功能列表、目标用户、约束
3. Agent 摘要 PRD 关键信息，主动搜索竞品设计方案，追问补充信息（目标平台等）
4. Agent 提出 2-3 个设计方向（或设计师说"跳过"直接进入下一步）
5. 设计师选定方向，Agent 进行范围确认（做/不做/待定/影响现有）
6. 设计师说"开始写"，Agent 生成 Markdown 设计文档 + HTML 原型
7. Agent 自审设计文档（7 维度），自动修复问题（最多 2 轮）
8. IM 发送摘要 + HTML 原型链接；Web 可查看完整文档

**旅程 2: 自由描述触发**
1. 设计师描述"帮我设计一个数据大屏，显示实时部署状态"
2. Agent 识别为自由描述，追问缺失信息（目标用户、平台、数据来源）
3. 后续步骤同旅程 1 第 3-8 步

**旅程 3: Session 过期后恢复**
1. 设计师对话中途离开超过 30 分钟，Session 过期
2. 再次发消息，Agent 通过 DB 摘要恢复上下文（含已选设计方向、竞品结论、已完成页面列表）
3. Agent 主动报告当前进度，继续对话，不从头开始

---

## 3. 功能需求

### 3.1 渐进式对话流程 [P0]

**描述:** Agent 通过 4 阶段对话引导设计师完成设计文档创建。Phase 2 可由用户跳过，会话内模块数量不限，按对话自然节奏推进。

**验收标准:**
- [ ] Phase 1：Agent 识别输入类型（PRD/自由描述/PRD ID），提取或追问补全设计所需背景信息
- [ ] Phase 2：Agent 提出 2-3 个设计方向供选择；用户说"跳过"时直接进入 Phase 3
- [ ] Phase 3：Agent 结构化展示范围确认（做/不做/待定/影响现有），逐条请用户确认
- [ ] Phase 4：用户说"开始写"/"生成 HTML"等触发词后，进入文档生成
- [ ] 单次会话可处理多个模块，无数量限制
- [ ] 触发词识别：跳过 / 继续 / 开始写 / 生成 HTML / 就这样 / 差不多了

**来源:** 对话 Phase 1 — "类似于现在 PRD Agent 的这个模式；Phase 2 支持跳过；不限制模块数，类似日常会话"

### 3.2 输入解析 [P0]

**描述:** Agent 支持三种输入方式，自动识别，无需用户显式选择模式。

**验收标准:**
- [ ] 输入为 PRD Markdown 时：自动提取目标用户、功能列表、非功能约束、范围边界，摘要给用户确认
- [ ] 输入为自由描述时：识别缺失信息并追问（目标平台、参考竞品、目标用户等）
- [ ] 用户说"帮我设计 PRD #N"时：调用 `read_prd(N)` 拉取完整 PRD，无需手动粘贴
- [ ] 三种输入在 Phase 1 第一轮对话中完成识别

**来源:** 对话 Phase 1 — "两者都需要支持；需要 read_prd(id) 能力"

### 3.3 设计方向探索（多变体） [P1]

**描述:** Phase 2 中，Agent 提出 2-3 个设计方向摘要（文字描述，不是完整稿），用户选择或融合后确定一个方向推进。

**验收标准:**
- [ ] 每个设计方向包含：布局策略、核心交互模式、适用场景说明
- [ ] 每个方向说明选择该方向的理由（参考竞品研究结论或 PRD 约束）
- [ ] 用户说"跳过"时，Agent 直接进入 Phase 3，不生成变体
- [ ] 复杂交互（多步骤流程、数据密集型页面）时，Agent 主动建议进行方向探索

**来源:** 对话 Phase 2 — "有必要，复杂交互需要确认，简单的支持用户说跳过"

### 3.4 Markdown 设计文档生成 [P0]

**描述:** 基于全部对话内容，生成完整的 11 章 Markdown 设计规范文档，面向设计师/PM review 和下游 Agent 消费。

**验收标准:**
- [ ] 必须包含全部 11 章（顺序不可调整）：设计概览 / 信息架构 / 用户流程 / 页面规范 / 可复用组件规范 / 交互与动效规范 / 无障碍 / HTML 原型说明 / 对现有 UI 影响 / 验收标准 / 决策日志
- [ ] 第 4 章每个页面规范包含子节：页面目的 / 布局结构（文字描述）/ 组件清单（表格）/ 边界状态 / UX 检查项 checklist
- [ ] 组件清单表格列固定为：组件 | 类型 | 状态 | 数据来源 | 交互行为
- [ ] 边界状态每页必须包含 4 种：加载中 / 空数据 / 错误 / 无权限
- [ ] 每个页面规范有「来源」字段，追溯到 PRD 章节编号或对话轮次
- [ ] 第 1 章设计概览包含：关联 PRD ID（如有）、产线设计系统配置引用标识
- [ ] 调用 `save_design_doc` 保存完整文档

**来源:** 对话 Phase 1 — 用户确认 11 章结构（Agent 专业设计）；Phase 1 — "便于后续 Agent 读取的高质量规范文档"

### 3.5 HTML 原型生成 [P0]

**描述:** 生成单 HTML 内容（含全部设计页面和边界状态的半交互原型），作为代码资源存入 DB（对齐 PRD 文档 `prd_documents.content_markdown` 保存模式），通过动态路由 serve 供访问。

**验收标准:**
- [ ] 单 HTML 文件，内嵌 CSS/JS，零外部依赖
- [ ] 所有设计页面通过导航/Tab 可切换查看
- [ ] 页面内半交互：弹窗开关、Tab 切换、表单验证提示、边界状态（加载/空/错误）可点击切换
- [ ] 硬编码假数据，内容真实（不用"Lorem Ipsum"或无意义占位文字）
- [ ] HTML 内容保存至 `design_documents.prototype_html`（TEXT），不落磁盘、不用对象存储
- [ ] 访问路由 `/prototypes/:token`：fastify 查 DB 按 token 返回 HTML（Content-Type: text/html），token 为 32 字节随机值，不可枚举
- [ ] URL 有效期 ≥ 7 天（DB 字段 `prototype_expires_at` 控制，过期返回 410 Gone）
- [ ] 原型覆盖的页面范围在设计文档第 8 章（HTML 原型说明）中声明
- [ ] 视觉风格遵循产线设计系统配置（颜色、字体、间距）
- [ ] HTML 原型在 Chrome / Safari / Firefox 最新版可正常渲染

**来源:** 对话 Phase 2 — "单 HTML 文件 + 半交互，硬编码假数据，保存到服务器提供链接访问"

### 3.6 设计自审 [P0]

**描述:** 文档生成后，独立 Claude 实例对 Markdown 设计文档进行 7 维度检查，自动修复，最多 2 轮。HTML 原型不做自动审查。

**验收标准:**
- [ ] 7 维度强制检查，每个维度有明确 Pass/Fail 判断标准：
  - 维度 1 格式完整性：11 章是否全部存在
  - 维度 2 边界状态覆盖：每个页面是否有加载/空/错误/无权限 4 种状态
  - 维度 3 来源可追溯：每个页面规范是否有来源字段
  - 维度 4 组件一致性：同一文档内相同交互模式是否使用相同组件
  - 维度 5 验收标准完整：每个页面是否有可检验的验收条件
  - 维度 6 HTML 覆盖对齐：HTML 原型覆盖页面与第 8 章声明是否一致
  - 维度 7 UX 基线检查：每页 UX checklist 是否全部勾选
- [ ] 发现问题自动修复，最多 2 轮迭代
- [ ] 修不了的问题升级为"待人工审查"，附具体问题描述
- [ ] HTML 原型不进行自动检查，交设计师人工 review

**来源:** 对话 Phase 2 — "不做 HTML 自动检查，token 消耗高，交给设计师人工审查"

### 3.7 知识库检索 [P1]

**描述:** Phase 1/2 对话中，Agent 主动检索现有设计文档和知识库，避免风格不一致，发现可复用资产。

**验收标准:**
- [ ] 已有设计文档检索能力（工具名随 §8 实现方案确定）：用模块名/功能关键词检索已有设计文档；找到时告知用户并询问是否对齐或复用
- [ ] `search_knowledge`：检索平台级通用信息（产线设计配置、已有组件规范）
- [ ] 检索结果摘要给用户确认，不直接写入设计文档

**来源:** 对话 Phase 2 — 用户确认需要设计文档检索能力 + `search_knowledge`；工具名 `search_design_docs` 为草案名称，最终工具名随 §8 实现方案确认后确定

### 3.8 竞品研究 [P1]

**描述:** Phase 1/2 中，Agent 主动通过 web 搜索研究竞品设计方案，摘要给设计师确认后影响设计方向。

**验收标准:**
- [ ] Agent 在 Phase 1 背景了解时主动触发竞品搜索，无需设计师显式要求
- [ ] 搜索结论以摘要形式呈现，用户确认后方可影响设计决策
- [ ] 搜索结论写入 `competitorInsights` 字段持久化，session 过期不重复搜索
- [ ] 只写搜索确认的事实，不写主观推断（铁律 5）

**来源:** 对话 Phase 2 — "需要 Agent 自己去搜索"

### 3.9 上下文持久化 [P0]

**描述:** 每轮对话结束时，Agent 将当前状态摘要写入 DB，支持 session 过期后无感恢复。

**验收标准:**
- [ ] 第 2 轮对话起，每轮末尾调用 `update_design_context`
- [ ] 首次调用传 `designId=null`，工具创建 drafting 状态记录并返回 ID；后续带 ID 调用
- [ ] 持久化字段：`phase` / `contextSummary` / `selectedDirection` / `competitorInsights` / `completedPages` / `designSystemRef`
- [ ] Session 过期后用户回来，Agent 报告当前进度，基于摘要继续（不从头开始）
- [ ] Phase 1 第一轮对话不调用持久化（避免无效记录堆积），第二轮起触发

**来源:** 对话 Phase 2 — Agent 决策，用户授权；复用 PRD Agent 持久化模式 + 4 个设计专属字段

### 3.10 System Prompt — 7 条铁律 [P0]

**描述:** Agent 行为由 system prompt 的 7 条铁律定义，不可绕过，不依赖用户提醒。

**验收标准:**
- [ ] **铁律 1 结构锚定**：设计文档中每个页面必须追溯到 PRD 功能需求或用户对话确认；禁止凭空新增页面
- [ ] **铁律 2 边界状态强制**：每个页面必须包含加载中/空数据/错误/无权限 4 种状态，无需用户提出
- [ ] **铁律 3 一致性强制**：同一文档内相同交互模式使用相同组件；不一致必须在决策日志写明理由
- [ ] **铁律 4 重大决策透明**：影响用户心智模型的选择（单页 vs 多步骤向导 / 表格 vs 卡片 / Modal vs 独立页 / Tab vs 侧边导航）必须说明理由后确认；细节执行层面（按钮居右、hover 高亮等）直接做
- [ ] **铁律 5 竞品事实锚定**：竞品研究结论只写搜索确认事实，不写主观推断
- [ ] **铁律 6 来源强制**：每个页面规范有来源字段，追溯到 PRD 章节编号或对话轮次
- [ ] **铁律 7 UX 基线强制**（5 条，无需用户提出，Agent 主动保证）：
  - 错误信息标准：必须包含"发生了什么 + 用户下一步怎么做"，禁止写"操作失败"/"Error 500"
  - 破坏性操作可撤销：删除/清空/不可逆提交必须有确认弹窗或撤销入口
  - 每页单一主操作（Primary CTA）：多个同等权重按钮时主动指出并建议层级
  - 用户操作即时反馈：每个操作的 loading 态、成功/失败提示必须在组件清单的交互行为列写明
  - 表单验证内联：验证必须内联（不能只在提交时报错），错误信息必须具体说明原因

**来源:** 对话 Phase 2 — 用户确认前 6 条铁律；对话补充 — "UX 设计要考虑使用者的便利、易用性"，Agent 专业落地为铁律 7

### 3.11 IM 交付通知 [P0]

**描述:** 文档生成并自审通过后，通过 IM 向设计师发送设计文档摘要和 HTML 原型链接。

**验收标准:**
- [ ] 自审通过后，IM 发送：模块名 + 设计文档摘要（页面列表、关键设计决策）+ HTML 原型 URL
- [ ] HTML 原型 URL 可直接在浏览器访问，无需额外登录
- [ ] 发送渠道为触发本次对话的 IM 群/会话

**来源:** 对话 Phase 2 — "一样的（与 PRD Agent 交付方式一致）"

### 3.12 产线级设计系统配置 [P0]

**描述:** 产线级全局配置，包含设计系统参数，作为 Agent system prompt 的全局上下文注入；Agent 服务多个项目，每个项目独立配置。

**验收标准:**
- [ ] 产线配置支持字段：组件库标识符（如 ant-design-5 / material-ui）、颜色 token、字体 token、间距 token
- [ ] HTML 原型和设计文档第 1 章引用产线配置，不在文档内重复定义
- [ ] 多产线部署时，每个产线独立配置，互不干扰
- [ ] 配置字段为可选，未配置时 Agent 在 Phase 1 追问设计师

**来源:** 对话 Phase 1 — "在产线上配置，作为产线的全局上下文；agent 服务于多个项目，每个项目可能不一样，支持配置"

### 3.13 Web 端对话面板 [P1]

**描述:** 在 Web Admin 提供对话面板，设计师可通过 Web 与 Agent 交互，参照 PRD Agent Chat 同构实现（DB 独立建表，对齐 Arch Agent 模式）。

**验收标准:**
- [ ] 参照 `PrdChatPage` 组件和 `usePrdChatStream` SSE hook 同构实现 `DesignChatPage` + `useDesignChatStream`，结构与行为对齐 PRD Agent
- [ ] Web 对话面板支持查看设计文档历史和对话历史
- [ ] 对话历史持久化到 DB（独立表 `design_chat_sessions` / `design_chat_messages`），设计师可跨 session 查看
- [ ] Web Admin 导航新增"设计文档"菜单入口

**实施方案（分表，对齐 Arch Agent 既有模式）:**

对齐 [schema-v24.sql](src/db/schema-v24.sql) 中 Arch Agent 的既有做法（`arch_chat_sessions` / `arch_chat_messages` 独立建表），UX Agent 同样独立建表，各 Agent DB 层解耦，PRD / Arch / UX 互不影响：

1. **DB 新增表**（schema-v25）：`design_chat_sessions` / `design_chat_messages`，结构与 `prd_chat_sessions` / `arch_chat_sessions` 同构；不修改任何现有表
2. **后端新增路由**：`src/admin/routes/design-chat.ts`，参照 `prd-chat.ts` 实现；`streamWebChat` capability 指向 `create_design_doc`
3. **前端新增页面**：`DesignChatPage.tsx` + `useDesignChatStream.ts`，参照 `PrdChatPage` / `usePrdChatStream` 同构实现；session_key 命名空间 `design-chat-*`
4. **PRD / Arch Agent 既有基础设施零改动**：`prd-chat.ts` / `PrdChatPage` / `usePrdChatStream` / `prd_chat_*` 表、`arch_chat_*` 表均不受影响

**来源:** 对话 Phase 3 — "Web 端对话面板放在一期一起做"

---

## 4. 非功能需求

| 类别 | 需求 | 指标 |
|------|------|------|
| 性能 | 文档生成首 token 响应 | < 3s |
| 存储 | HTML 原型单文件大小 | < 5MB（存 PG TEXT 字段，PG 单行理论 1GB，5MB 远在安全区） |
| 可用性 | HTML 原型 URL 有效期 | ≥ 7 天（DB 字段 `prototype_expires_at` 控制） |
| 可用性 | Session 恢复 | 见 §3.9（摘要持久化 + 30 分钟 TTL 后基于摘要恢复） |
| 安全 | HTML 原型访问控制 | `/prototypes/:token` 路由，token = 32 字节随机值（base64url），不可枚举 |
| 兼容性 | HTML 原型浏览器支持 | Chrome / Safari / Firefox 最新版正常渲染 |

---

## 5. 与现有系统集成

- **PRD 文档系统**: 复用 `read_prd(id)` 工具，只读访问已有 PRD
- **知识库系统**: 复用 `search_knowledge` 工具
- **IM 适配层（钉钉/飞书）**: 复用现有消息发送和接收能力
- **ClaudeRunner**: 复用现有 session 管理机制（30 分钟 TTL + session resume）
- **Web Admin Chat 基础设施**: 参照 `PrdChatPage` / `usePrdChatStream` / `prd-chat.ts` 模式同构实现 `DesignChatPage` / `useDesignChatStream` / `design-chat.ts`（对齐 Arch Agent 分表模式）
- **产线配置系统**: 读取产线级设计系统配置，注入为 Agent 全局上下文

---

## 6. 对现有功能的影响

### 6.1 受影响清单

| 现有模块/功能 | 影响类型 | 描述 | 兼容性 | 迁移/回滚策略 | 来源 |
|--------------|---------|------|--------|-------------|------|
| 产线配置系统 | 数据结构变更 | 新增设计系统参数字段（组件库标识符、颜色/字体/间距 token） | 向后兼容（字段可选，未配置时为 null，现有产线无影响） | 无需迁移脚本，字段可选 | Phase 3 范围确认 |
| PRD 文档系统 / read_prd | 行为复用 | 复用 read_prd 工具，只读，不改动 PRD 数据或接口 | 完全兼容 | — | Phase 2 — 用户确认 |
| search_knowledge | 行为复用 | 直接复用，不改动工具实现 | 完全兼容 | — | Phase 2 — 用户确认 |
| IM 适配层（钉钉/飞书） | 行为复用 | 复用消息发送/接收，不改动适配器代码 | 完全兼容 | — | Phase 2 — 用户确认 |
| PrdChatPage / usePrdChatStream / prd-chat.ts | 模式参照 | 新建 DesignChatPage / useDesignChatStream / design-chat.ts 同构实现，不修改 PRD Agent 现有文件 | 完全兼容（零改动） | 删除新增文件即可回滚 | Review 修订（2026-04-23）|
| arch_chat_sessions / arch_chat_messages | 无影响 | 分表方案下 Arch Agent 既有表保持不变 | 完全兼容 | — | Review 修订（2026-04-23）|
| Web Admin 导航 | UI 变更 | 新增"设计文档"菜单项和页面路由 | 完全兼容 | 移除菜单项即可回滚 | Phase 3 范围确认 |
| DB Schema | 数据结构变更 | 新增 `design_documents`（含 `prototype_html` TEXT / `prototype_token` TEXT UNIQUE / `prototype_expires_at` TIMESTAMPTZ 三字段）/ `design_chat_sessions` / `design_chat_messages` 三张表（schema-v25），不修改任何现有表 | 完全兼容 | drop 三张新表即可回滚 | Review 修订（2026-04-23）|
| HTML 原型 serve 路由 | 新增 | 新增 `/prototypes/:token` 路由，fastify 查 DB 返回 HTML（Content-Type: text/html） | 完全兼容（新增路由） | 移除路由即可回滚 | Review 修订（2026-04-23）|

### 6.2 破坏性变更详述

本期无破坏性变更。分表方案下所有 PRD / Arch Agent 既有表结构、路由、前端组件均零改动；UX Agent 新增的 DB 表、后端路由、前端页面均为纯新增文件。

### 6.3 回归测试建议

- [ ] 产线配置：新增设计系统字段为 null 时，HTML 原型和文档生成不报错（向后兼容验证）
- [ ] read_prd 工具：UI/UX Agent 调用后 PRD 数据不被修改（只读验证）
- [ ] Web Admin 导航：新增菜单项不影响现有页面路由和权限
- [ ] PRD Agent Web 对话面板：UX Agent 上线后 PRD Agent session 创建 / SSE 流 / 历史查看功能回归正常（验证零影响）
- [ ] Arch Agent 既有表：`arch_chat_*` / `arch_documents` 数据不受 v25 迁移影响
- [ ] DB 迁移：新增 design_* 三张表后现有表数据完整性不受影响
- [ ] IM 交付：设计文档消息发送不影响现有 PRD Agent 消息的发送路径
- [ ] HTML 原型 serve 路由：`/prototypes/:token` 正确返回 HTML（Content-Type: text/html）；过期 token 返回 410 Gone；非法 token 返回 404

---

## 7. 范围边界

### 在范围内（一期）
- 4 阶段渐进式对话流程（Phase 2 可跳过，会话内模块数量不限）
- 三种输入方式（PRD Markdown / 自由描述 / PRD ID）
- 设计方向探索（多变体，用户可跳过）
- 11 章 Markdown 设计规范文档生成
- 单文件半交互 HTML 原型生成（服务器 URL 访问）
- 设计自审（Markdown 文档，7 维度，最多 2 轮自修复）
- 知识库检索（已有设计文档检索能力 + `search_knowledge`，工具名见 §8 待定）
- 竞品研究（Agent 主动 web 搜索）
- 上下文持久化（PRD Agent 模式 + 4 个设计专属字段）
- System Prompt（7 条铁律含 UX 基线强制）
- IM 交付通知（设计文档摘要 + HTML 原型链接）
- 产线级设计系统配置（全局上下文注入）
- Web 端对话面板（参照 PRD Agent Chat 模式同构实现，DB 独立建表）

### 明确排除
- HTML 原型自动自审（token 消耗高，交设计师人工 review）
- Figma 注释输出
- 与 PRD Agent / Dev Agent 的自动编排串联（后续编排层实现，接口预留）

---

## 8. 待定事项

- [ ] `search_design_docs` 是新建独立工具还是扩展现有 `search_existing_prds`？（建议新建，职责分离，待技术评审确认）
- [ ] 竞品研究 web search：复用现有 web_search 实现还是新建专用工具？（待确认平台现有 web search 能力）

---

## 9. 决策日志

| 决策 | 依据 | 来源 |
|------|------|------|
| 核心职责：辅助设计师基于 PRD 出设计文档 | 用户明确描述 | Phase 1 对话 |
| 产出物：Markdown 设计文档 + HTML 原型 | 用户明确说明，参考 GStack 能力 | Phase 1 对话 |
| 参考 GStack design-html / design-shotgun 能力 | 用户提供 GitHub 链接，Agent 检索确认 | Phase 1 — GStack 检索结果 |
| HTML 原型为单文件半交互（非多页面跳转） | 便于 IM 单 URL 分享；Dev Agent 读一个文件理解全部状态 | Phase 2 对话 — Agent 提议，用户认可 |
| HTML 原型不做自动自审 | token 消耗高，设计师可直观 review | Phase 2 对话 — 用户决策 |
| Phase 2 设计方向探索可跳过 | 简单场景不需要多变体探索 | Phase 2 对话 — 用户决策 |
| 会话内模块数量不限 | 类似日常会话，不设硬限制 | Phase 2 对话 — 用户决策 |
| 产线设计系统配置在产线级全局配置中管理 | Agent 服务多项目，每个项目配置不同 | Phase 1 对话 — 用户决策 |
| 设计文档采用 11 章结构（含无障碍章节） | 无障碍是专业设计文档必需，也是 Dev Agent 实现时需要明确的 | Phase 1 对话 — Agent 专业判断，用户确认 |
| 第 4 章边界状态（4 种）强制 | 大多数设计文档只写正常态，导致 Dev Agent 实现时自行发挥 | Phase 1 对话 — Agent 专业判断，用户确认 |
| 上下文持久化新增 4 个设计专属字段 | 标准字段不足以支持设计对话恢复（方向选择、竞品结论不可丢失） | Phase 2 对话 — Agent 决策，用户授权 |
| Agent 定位：结构跟随 PRD，设计主动提议，用户最终拍板 | 用户非设计专业，Agent 专业判断是核心价值；但结构属于业务决策 | Phase 2 对话 — Agent 决策，用户确认 |
| 铁律 7 UX 基线强制（5 条具体规则） | 用户提出 UX 易用性要求；Agent 将原则落地为可检查的具体规则 | Phase 2 补充对话 |
| Web 端对话面板放一期 | 用户明确要求一期做；git 状态显示 PRD Chat 基础设施已存在可参照 | Phase 3 对话 |
| 竞品研究由 Agent 主动触发 | 用户希望 Agent 自己搜索，不需要设计师指定竞品 | Phase 2 对话 — 用户决策 |
| Chat 基础设施采用分表方案（`design_chat_sessions` / `design_chat_messages` 独立建表，前后端同构新建） | 对齐 [schema-v24.sql](src/db/schema-v24.sql) 中 Arch Agent 既有做法 —— 原定合表方案（Phase 3 对话）与代码库现状冲突，Arch Agent 一期已独立建表；继续合表需回迁 `arch_chat_*`，工作量大于收益。分表后各 Agent DB 层完全解耦，PRD / Arch / UX 三套互不影响，UI 层复制成本可接受 | Phase 3 对话（2026-04-22） → Review 修订（2026-04-23）|
| HTML 原型采用 DB 存储（`design_documents.prototype_html` TEXT），对齐 PRD 文档 `prd_documents.content_markdown` 保存模式 | 平台当前零对象存储集成，且无 Nginx 层（fastify 直暴端口）；DB 存储随 PG 备份自然持久化，无需新增 volume / 对象存储 SDK / 凭据管理；5MB 单文件远在 PG TEXT 安全区 | Review 修订（2026-04-23） — 用户决策 |
| HTML 原型 URL 使用 `/prototypes/:token` 动态路由，token 存 DB | 对齐 PRD 文档访问模式（动态路由 + DB 查询），统一鉴权/审计路径；不走静态文件 serve 避免缓存/权限绕过 | Review 修订（2026-04-23） |
| 3.7 验收标准改为能力维度（不锁定工具名 `search_design_docs`），工具名随 §8 实现方案确定 | §8 列为待定（新建独立工具 vs 扩展 `search_existing_prds` 加 `kind` 参数），两种方案工具名不同；在 3.7 锁定工具名会导致若走扩展方案时验收标准天然无法通过 | 自审驳回 blocker 修复（2026-04-22）|
