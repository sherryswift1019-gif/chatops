---
stepsCompleted: [1, 2, 3, 4, 5, 6, 7, 8]
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/prd-validation-report.md
  - docs/product/ai-assistant-requirements.md
  - docs/product/ai-assistant-addendum.md
  - docs/chatops.md
  - docs/product/migration-analysis.md
  - docs/brainstorming/brainstorming-session-2026-04-14.md
workflowType: 'architecture'
project_name: 'ChatOps 研发 AI 助手'
user_name: 'Hanff'
date: '2026-04-15'
projectContext: 'brownfield'
parentPlatform: 'ChatOps'
lastStep: 8
status: 'complete'
completedAt: '2026-04-15'
---

# Architecture Decision Document - ChatOps 研发 AI 助手

**Author:** Hanff
**Date:** 2026-04-15

_本文档通过逐步协作发现构建。每一步的架构决策将追加到文档中。_

_关联文档：_
- _PRD：[prd.md](prd.md)_
- _PRD 验证报告：[prd-validation-report.md](prd-validation-report.md)_

## Project Context Analysis

### Requirements Overview

**Functional Requirements（55 条，分布在 9 个能力域）：**

| 能力域 | FR 数 | 架构含义 |
|--------|:----:|---------|
| IM 对话交互 | 6 | 扩展 DingTalkAdapter 支持图片/richText/引用回复；多平台统一消息抽象 |
| 代码访问与会话隔离 | 5 | **新增核心**：worktree 沙箱 + session 按 (user,product) 隔离 + 两级回收 |
| 知识层 | 8 | **新增核心**：AI 摘要（随代码）+ 独立知识库仓库 + index.json 匹配引擎 |
| Bug 分析与分级 | 8 | 分析 Agent 核心：多源输入、方案先行、置信度、自动分级 |
| 自动修复与 Review | 8 | **新增核心**：修复 Agent + Review Agent，独立角色协作 |
| 审批与流程编排 | 6 | 复用 ApprovalGate + 新增 GitLab label 状态机驱动 |
| Bug 根因归因与知识进化 | 3 | 新增归因表 + 统计层，驱动知识体系进化 |
| 权限与多租户 | 5 | 复用 ChatOps 四维 RBAC，扩展新 capability |
| 管理与监控 | 6 | 扩展管理后台 + Bug 修复实例页面 + 价值量化仪表盘 |

**Non-Functional Requirements（24 条，分布在 6 类别）：**

| 类别 | 关键量化约束 | 架构影响 |
|------|-------------|---------|
| Performance | 命中 ≤3s / 完整 ≤5min / 追问 ≤10s / 并发 10-30 | 高效 session 保持 + 低开销代码隔离 |
| Security | 脱敏 100% / CLI 硬限制 / 审计 ≥180 天 / 私有化 | Agent 权限在 CLI 层强制 + 独立脱敏层 |
| Scalability | 新产品 ≤1 天 / 10 并发 ≤100MB | 代码隔离方案选型关键 |
| Reliability | Session 自动重建 / 3 次降级 100% | 状态恢复 + 两级清理 + 兜底定时 |
| Observability | 核心指标 + Bug 实例可视化 + 日志 ≥30 天 | 指标落库 + 前端仪表盘 |
| Integration | 多 IM 平台 / GitLab / MCP / 模型可插拔 | Porygon backend 抽象 + Webhook 鉴权 |

### Scale & Complexity

**整体复杂度：中-高（Medium-High）**

**复杂度指标：**

| 维度 | 状态 |
|------|:----:|
| 实时功能 | ✅ 需要 |
| 多租户 | ✅ 需要（产品线 × 环境 × 角色 × 能力）|
| 监管合规 | ⚠️ 间接（客户侧私有化部署）|
| 集成复杂度 | 🔴 高（钉钉/飞书/GitLab/Harbor/SSH/MCP）|
| 用户交互复杂度 | 中（IM + Web 后台）|
| 数据复杂度 | 中（多文档层 + 状态机 + 知识库）|
| **Agent 协作复杂度** | 🔴 **高**（3 独立 Agent + 分级路由 + 自动降级）|

- **技术领域：** 全栈 B2B SaaS + AI Agent 编排
- **预估架构组件数：** 15-20 个模块（其中新增 ~8 个，扩展 ~7 个，复用 ~5 个）

### Technical Constraints & Dependencies

**硬约束（棕地基础，不可变）：**

- **平台**：Node.js + TypeScript（ES2022, NodeNext, strict），Fastify 5
- **前端**：React 18 + Vite + Ant Design 5（无全局状态）
- **数据库**：PostgreSQL 16，pg 驱动直连，纯 SQL + Repository 模式，**无 ORM**
- **AI 集成**：`@snack-kit/porygon` + `@modelcontextprotocol/sdk`
- **能力机制**：必须在 ChatOps 的 capability 路由下扩展新能力
- **工具注册**：MCP 工具自注册模式（registerTool + server.ts/mcp-server.ts 双 import）
- **数据库迁移**：schema-vN.sql 顺序执行，`IF NOT EXISTS` / `ALTER TABLE IF` 幂等
- **Claude CLI 工具限制**：`disallowedTools: ['Bash', 'Read', 'Edit', 'Write', ...]`，仅用 MCP 自定义工具

**软约束（推荐方向）：**

- 代码隔离倾向 `git clone --shared + sparse-checkout`（PRD 4 方案对比已做）
- 知识库存储倾向独立 Git 仓库 + index.json（addendum 3.1 待决策）
- 模型可插拔（Porygon backend 抽象层 - Growth 前置条件）

**待决策事项（来自 addendum）：**

1. 知识库存储：Git 仓库 vs PostgreSQL
2. 文档编辑入口目标用户：仅研发 vs 研发+非技术人员
3. `guide/` 目录命名

### Cross-Cutting Concerns Identified

| 关注点 | 影响范围 | 架构优先级 |
|-------|---------|:--------:|
| 多 Agent 协作契约 | 分析→修复→Review 的数据契约与 handoff | 🔴 高 |
| Session 与 Worktree 生命周期 | 所有分析/修复任务，跨 IM/Webhook/定时多入口 | 🔴 高 |
| GitLab Issue label 状态机 | 贯穿 Bug 完整生命周期（12 节点）| 🔴 高 |
| RBAC 四维权限矩阵 | 所有 capability/tool/产品线/环境 | 🟡 中 |
| 敏感信息脱敏 | 所有分析报告、日志、AI 回复 | 🟡 中 |
| 审计日志 | 所有分析/修复/审批决策 | 🟡 中 |
| 指标采集 | 所有 Agent 执行 + 知识库命中 + 用户评价 | 🟡 中 |
| 事件编排 | IM / GitLab Webhook / 定时任务三源触发 | 🟡 中 |
| AI 摘要同步更新 | 修复 Agent 内部流程 | 🟡 中 |
| Bug 根因归因 | Issue 关闭后的统计与知识进化 | 🟢 低（Growth 阶段重点）|

## Starter Template Evaluation

### 棕地项目说明

本项目为棕地（Brownfield）扩展。**ChatOps 平台即是项目的 Starter 基础**。不引入新的外部 starter 模板，所有新增能力在 ChatOps 平台上扩展。

### Primary Technology Domain

全栈 B2B SaaS 平台 + AI Agent 编排（Full-stack B2B SaaS + AI Agent Orchestration）

### 已由 ChatOps 平台确立的架构决策

#### 语言与运行时

- **Node.js + TypeScript**
- ES2022、NodeNext modules、strict mode
- 包管理器：**pnpm**

#### 后端

- **Fastify 5** 作为 HTTP 框架
- Zod 环境变量校验（`src/config.ts`）
- Pino 日志（默认）
- 单进程部署（Docker Compose）

#### 前端

- **React 18 + Vite + Ant Design 5** SPA
- 无全局状态管理（组件级 state）
- React Router v6
- axios（`web/src/api/`）
- Vite dev server（端口 5173，代理 `/admin` → `localhost:3000`）

#### 数据库

- **PostgreSQL 16**（pg 驱动直连）
- **纯 SQL + Repository 模式，无 ORM**
- 迁移：`src/db/schema.sql` → `schema-vN.sql` 顺序执行
- 字段：DB snake_case ↔ TS camelCase（`mapRow()` 转换）
- 所有查询用 `$1, $2` 参数化

#### AI 集成层

- **@snack-kit/porygon** 封装 Claude CLI
- **@modelcontextprotocol/sdk** 实现 MCP Server（stdio 子进程）
- Claude CLI 仅使用 MCP 自定义工具，disallowedTools 禁用所有内置工具

#### IM 适配层

- **dingtalk-stream-sdk-nodejs**（Stream 模式 WebSocket 长连接）
- **飞书 SDK**（HTTP Webhook 模式）

#### 其他

- **SSH**：ssh2 库（用于部署、日志采集）
- **Node-cron**：定时任务调度（`src/pipeline/scheduler.ts`）
- **测试**：Vitest
- **部署**：Docker Compose（postgres + migrate + chatops 三服务）

### 已由 ChatOps 平台确立的架构模式

**1. 请求流（IM 消息 → AI Agent → 工具）**

```
IM 消息 → IMAdapter → SessionManager → TaskQueue → ClaudeRunner
  → detectIntent → capability 路由 → 权限校验 → 工具筛选 → MCP Server 子进程
  → Claude 调用 tool → MCP Server → tool.execute() → 流式回传
```

**2. Capability 驱动的工具路由**

先识别意图 → 查 capability → 只暴露允许的工具给 Claude。

**3. Session Resume**

按 (platform, groupId) 管理 Claude session（8h TTL），支持追问复用上下文。

**4. 审批卡点**

ApprovalGate + ApprovalRouter + EscalationTimer，支持主备审批人超时升级。

**5. 任务暂停/恢复**

TaskQueue 支持 `pending_approval` 状态，通过 `registerResumeExecutor` 注册恢复函数。

**6. 流水线引擎**

`test_pipelines` 多阶段（script/approval）+ SSH + 变量替换 + 重试 + HTML 报告。

**7. RBAC 双层权限**

Capability 级（`product_line_capabilities` 表）+ Tool 级（`DEFAULT_TOOL_ROLES` + `tool_permissions` 表）。

**8. Tool 自注册**

`registerTool()` 自注册到全局 registry；新增工具必须同时在 `server.ts` 和 `mcp-server.ts` 中 import。

**9. 数据库迁移**

创建 `schema-vN.sql`，在 `migrate.ts` 追加 `readFileSync` + `pool.query`，用 `IF NOT EXISTS` 保证幂等。

**10. Admin API 路由**

所有管理端点在 `/admin` 前缀下，`src/admin/routes/` 每个资源一个文件，通过 `src/admin/index.ts` 注册为 Fastify 插件。

### 新增能力需要遵循的扩展约定

基于 ChatOps 已建立的模式，新增能力必须：

1. **新增 MCP 工具**：`src/agent/tools/` 下实现 `AgentTool` + `registerTool()`；同步 import 到 `server.ts` 和 `mcp-server.ts`；在 `DEFAULT_TOOL_ROLES` 配置默认角色
2. **新增 capability**：数据库插入 `capabilities` 表（key / display_name / tool_names / system_prompt）+ 配置 `product_line_capabilities` 访问控制
3. **新增数据库迁移**：创建 `schema-vN.sql` + 在 `migrate.ts` 追加；创建 Repository（mapRow）
4. **新增 Admin API**：`src/admin/routes/xxx.ts` 导出注册函数；前端 `web/src/api/xxx.ts` + `web/src/pages/XxxPage.tsx`

### 不适用的传统 Starter 评估维度

| 维度 | 状态 |
|------|:----:|
| Language/TypeScript configuration | ✅ 已由 ChatOps 确定 |
| Styling solution | ✅ Ant Design 5 已确定 |
| Testing framework | ✅ Vitest 已确定 |
| Linting/Formatting | ✅ 随 ChatOps 配置（ESLint+Prettier 如有） |
| Build tooling | ✅ Vite + tsc 已确定 |
| Project structure | ✅ 已确立（`src/agent/`、`src/admin/`、`src/db/`、`src/pipeline/` 等）|
| State management | ✅ 无全局状态（React 组件级） |
| Routing | ✅ React Router v6 |
| Environment configuration | ✅ Zod + `.env` |

**Note:** 项目**不需要**"初始化命令"—— 直接在 ChatOps 代码库 clone 后 `pnpm install` 即可开始开发。

### 开发与部署命令（已确立）

```bash
# 后端开发（热重载）
pnpm dev

# 前端开发
cd web && pnpm dev

# 测试
pnpm test

# 数据库迁移
pnpm migrate

# Docker 镜像构建
./build.sh

# Docker 部署
./deploy.sh up
./deploy.sh logs
./deploy.sh restart
```

### Starter 决策结论

**Selected "Starter": ChatOps 平台（既有代码库）**

- **Rationale**: 棕地项目 PRD 明确要求复用 ChatOps 基础设施（NFR-SC1/2/3、FR38 ApprovalGate、FR36 Issue label 状态机、FR46 capability 扩展等）。引入外部 starter 会违反复用约束。
- **风险**：ChatOps 平台本身的技术债务会被继承。缓解：Step 4-6 架构决策中显式处理需扩展/修改的点。
- **业界对标启示**（来自 addendum）：Open SWE 的 Planner/Reviewer 多 Agent 架构与本项目设计对齐；Aider 的 commit 规范可以借鉴到修复 Agent；Qodo 的 RAG 方案可作为知识库查询的优化方向。这些不替代 starter，但在 Step 4-6 做具体实现决策时可参考。

## Core Architectural Decisions

### Decision Priority Analysis

**Critical Decisions（MVP 前必决）：**
- Decision 1.1: Agent 编排层设计
- Decision 1.2: Review Agent 独立性实现
- Decision 1.3: Agent Handoff 机制
- Decision 2.1: 代码隔离方案
- Decision 2.2: Worktree/Session 回收策略
- Decision 2.3: 并发粒度
- Decision 3.1: 知识库存储方案

**Important Decisions（架构基调）：**
- Decision 3.2: 图片附件存储
- Decision 4.1: GitLab Label 状态机驱动
- Decision 4.2: 多事件源处理
- Decision 6.1: 私有化部署打包
- Decision 6.2: 指标采集与仪表盘

**Deferred Decisions（Growth 阶段）：**
- Decision 5.1: 模型可插拔抽象层（MVP 单一入口，Growth 补抽象）
- 对象存储切换（MVP 本地目录，Growth 切云）
- Helm Chart（如客户需要 K8s 部署）

### Multi-Agent Orchestration（多 Agent 协作）

#### Decision 1.1：Agent 编排层设计

- **Decision**：采用 **Capability 即 Agent 角色 + AgentCoordinator 轻量级协调模块**
- **Rationale**：
  - 三个 Agent 角色（分析/修复/Review）各作为独立 capability：不同 key、不同 systemPrompt、不同 allowedTools
  - 复用 ChatOps 现有的 ClaudeRunner → MCP 子进程机制，改动最小
  - 新增 AgentCoordinator 模块（100-200 行代码，非独立服务）：订阅分析完成事件 → 触发修复 → 等待修复完成 → 触发 Review
  - 均衡方案：既不过度设计独立 Orchestrator 服务，也不把协作逻辑散落各处
- **Affects**：`src/agent/coordinator.ts`（新增）、`capabilities` 表（新增记录）、`src/agent/claude-runner.ts`（小幅扩展支持非 IM 触发）
- **Provided by ChatOps**：capability 路由、ClaudeRunner、MCP Server（完全复用）

#### Decision 1.2：Review Agent 独立性实现

- **Decision**：**独立 capability + 独立 CLI 调用**
- **Rationale**：
  - `ai_review_mr` capability 拥有独立 systemPrompt（审查视角）和独立 tool 清单（`review_mr_diff` 为主）
  - 通过独立 Claude CLI 子进程调用，与修复 Agent 进程完全隔离
  - 避免"修复思路已在上下文"带来的视角污染，符合 BMAD code-reviewer 设计哲学
  - 对比独立进程 + 独立 worktree（方案 C）：资源成本低，因 MR diff 不需要完整代码仓库
- **Affects**：新 capability `ai_review_mr`、新 MCP 工具 `review_mr_diff`

#### Decision 1.3：Agent Handoff 机制

- **Decision**：**DB 内部传递方案 + GitLab Issue 评论外部审计（双轨）**
- **Rationale**：
  - 新增 `bug_analysis_reports` 表：存储分析 Agent 完整结构化输出（根因、方案、置信度、级别、元数据）
  - 修复 Agent 从 DB 读取方案文档作为输入契约（结构化、类型安全、高速）
  - 同时在 GitLab Issue 评论写人类可读摘要 + 关键决策点（供人工 Review + 审计追溯）
  - 避免纯 GitLab 评论传递（rate limit 风险）和纯内存传递（重启丢失）
- **Affects**：新表 `bug_analysis_reports`、新 Repository、GitLab Issue 评论增强

### Code Isolation & Sandboxing（代码隔离）

#### Decision 2.1：代码隔离方案

- **Decision**：**Git worktree（--detach 模式）**
- **Rationale（用户选择，与 PRD 初始倾向不同）**：
  - Git 原生机制，创建速度秒级
  - 比 `git clone --shared` 对 Git 的侵入性更低（无需额外处理 alternates 机制）
  - 团队对 worktree 已有使用经验（superpowers 中已有 using-git-worktrees skill）
  - 使用 `--detach` 模式创建 worktree，不锁定分支名，允许多个会话并行分析同一分支
  - 对主仓库影响：在 `.git/worktrees/` 留注册项，清理需 `git worktree remove`（非 `rm -rf`）
  - **注意**：此决策替代 PRD 中 `git clone --shared + sparse-checkout` 的初始倾向
- **Affects**：新模块 `src/agent/code-sandbox.ts`、新 MCP 工具 `switch_version`
- **Trade-off 记录**：worktree 方案磁盘开销略大于 clone --shared（每个 ~500MB vs ~50MB），但 10 并发下仍可控（~5GB）

#### Decision 2.2：Worktree / Session 回收策略

- **Decision**：**统一 TTL 模式**
- **Rationale（用户选择，简化 PRD 原方案）**：
  - 所有 worktree 和关联 session 统一 TTL（建议 2 小时）
  - 过期后同时清理 worktree + session
  - 用户追问超过 TTL 需要重新 checkout，体验略差但实现简单
  - 配合**凌晨 3 点兜底扫描**清理所有 `/tmp/analysis-*` 目录
  - **注意**：此决策简化 PRD 中"两级回收（30min session 过期 / 2h worktree 清理）"方案
- **Affects**：`WorktreeManager` 定时清理任务、session 过期逻辑
- **Trade-off**：牺牲追问 30 min-2h 之间的"秒级响应"能力，换取代码简化

#### Decision 2.3：并发粒度

- **Decision**：**`(user, product, version, sessionId)` 独立 worktree**
- **Rationale**：
  - 目录命名：`/tmp/analysis/{user}-{product}-{version}-{sessionId}`
  - 同一用户在同一产品同一版本可以发起多个并行分析（如"分析 Bug A" 和 "分析 Bug B" 并行）
  - 最高隔离性，避免 session 间互相干扰
- **Affects**：WorktreeManager 命名策略

### Knowledge Storage（知识库存储 - Addendum 待决策 #1 确认）

#### Decision 3.1：知识库存储方案

- **Decision**：**独立 Git 仓库 + index.json 元数据匹配版本**
- **Rationale**：
  - 每个产品独立知识库仓库（`pam-knowledge.git` / `iam-knowledge.git` 等）
  - 目录结构：`guide/`（人写）+ `knowledge/`（AI 沉淀）+ `index.json`（索引）
  - Agent 分析前 clone 知识库到临时目录，按 index.json 匹配关键词/错误码/模块/版本
  - 版本天然支持 Git 历史、离线可用、严谨 review 流程
  - Trade-off 接受：人写文档入口需要 Web 编辑器（远期）或直接 Git 提交（MVP）
- **Affects**：`src/agent/knowledge/`（新模块）、MCP 工具 `search_knowledge`、新表 `product_knowledge_repos`
- **Implementation 顺序**：MVP 阶段人写文档只支持 Git 提交，Web 编辑器延到 Growth

#### Decision 3.2：图片附件存储

- **Decision**：**MVP 本地目录，Growth 对象存储（接口抽象）**
- **Rationale**：
  - MVP 阶段使用本地目录（`/opt/knowledge/images/`），Markdown 中相对路径引用
  - 设计存储接口 `KnowledgeImageStorage`，实现 `LocalFileStorage`
  - Growth 阶段新增 `MinIOStorage` / `OSSStorage` 实现，通过配置切换
  - 避免 MVP 阶段引入额外服务依赖
- **Affects**：`src/agent/knowledge/image-storage.ts`（接口 + 本地实现）

### Event Orchestration（事件编排）

#### Decision 4.1：GitLab Issue Label 状态机驱动

- **Decision**：**扩展现有 GitLabWebhookReceiver**
- **Rationale**：
  - 在 `src/adapters/gitlab/webhook-receiver.ts` 增加 Issue events 和 MR events 处理
  - 根据 label 变化调用对应 capability（通过 AgentCoordinator 路由）
  - 复用现有鉴权机制（`x-gitlab-token` 验证）
- **Affects**：`webhook-receiver.ts` 扩展、新 handler 文件 `src/adapters/gitlab/issue-handler.ts`
- **Label 状态机定义**（文档下一节）

#### Decision 4.2：多事件源处理

- **Decision**：**各自独立入口，MVP 阶段不引入事件总线**
- **Rationale**：
  - IM 入口：现有 IMAdapter → SessionManager → ClaudeRunner
  - GitLab 入口：GitLabWebhookReceiver → AgentCoordinator
  - 定时任务入口：node-cron → AgentCoordinator / cleanup tasks
  - 三个入口最终都调 AgentCoordinator 或直接调 capability
  - Growth 阶段如果需要更复杂编排，可引入 PostgreSQL LISTEN/NOTIFY
- **Affects**：无新组件，沿用现有架构

### Model Abstraction & Integration（模型抽象与集成）

#### Decision 5.1：模型可插拔实现时机

- **Decision**：**MVP 单一入口（Claude only），Growth 阶段引入 Porygon backend 抽象层**
- **Rationale**：
  - MVP 通过 `@snack-kit/porygon` 调用 Claude CLI，代码中不做多后端抽象
  - 所有 AI 调用经过统一入口 `src/agent/claude-runner.ts`，便于 Growth 阶段改造
  - Growth 阶段（推客户前）新增 backend 抽象层，支持国产模型 / 私有化模型
- **Affects**：MVP 仅 `claude-runner.ts`，Growth 新增 backend 层

#### Decision 5.2：GitLab API 限流

- **Decision**：**令牌桶 + 指数退避重试**
- **Rationale**：
  - 按 GitLab 实例维度维护令牌桶（默认 10 req/s，可配置）
  - 超限时自动退避重试（1s / 2s / 4s，最多 3 次）
  - 实现位置：`src/adapters/gitlab/rate-limiter.ts`（新增）
- **Affects**：所有 GitLab API 调用方改为走 rate-limiter 包装

### Infrastructure & Deployment（基础设施与部署）

#### Decision 6.1：私有化部署打包

- **Decision**：**Docker Compose 单机部署（MVP）**
- **Rationale**：
  - 沿用 ChatOps 现有的 Docker Compose（postgres + migrate + chatops 三服务）
  - 一客户一环境，完全数据隔离
  - Growth 阶段如需大客户 K8s 部署再补 Helm Chart
- **Affects**：无改动（复用现有 `docker-compose.yml`）
- **MVP 不做**：K8s / Helm / 多实例扩展

#### Decision 6.2：指标采集与运营仪表盘

- **Decision**：**PostgreSQL 统计表 + 前端 SQL 查询**
- **Rationale**：
  - 新增表：`metrics_daily`（日级聚合）、`bug_analysis_stats`（分析任务统计）、`knowledge_hit_stats`（命中统计）
  - Agent 执行完成时写统计行（异步、best-effort）
  - 前端价值量化仪表盘通过 Admin API 查询聚合数据
  - 不引入 Prometheus/Grafana，避免客户环境额外依赖
- **Affects**：新增 3 张表、新增 Admin API `/admin/metrics`、前端仪表盘页面

### Decision Impact Analysis

**实施序列（依赖顺序）：**

1. **底座扩展**（里程碑 0 基础）
   - 图片消息支持（DingTalkAdapter 扩展）
   - `test_pipelines.stages` 增加 `capability` / `wait_webhook` 类型
   - GitLabWebhookReceiver 增加 Issue events
   - 新增 6 个 capability 记录（数据库）
2. **基础组件**（依赖底座）
   - `WorktreeManager`（代码沙箱管理）
   - `KnowledgeRepository`（知识库 Git 仓库操作）
   - `AgentCoordinator`（Agent 协作协调器）
3. **分析闭环**（里程碑 1）
   - 分析 Agent capability + 工具集
   - 知识库 index.json 匹配引擎
   - `bug_analysis_reports` 表 + Repository
4. **修复闭环**（里程碑 2）
   - 修复 Agent capability + 工具集
   - AI 摘要同步更新工具
   - Review Agent capability + 工具
   - 失败降级机制
5. **可见性**（贯穿）
   - Bug 修复实例前端页面
   - 审计日志 + 统计表
   - 管理后台扩展

**跨组件依赖：**

- `AgentCoordinator` 依赖所有 3 个 Agent capability 就绪
- `bug_analysis_reports` 表被分析/修复/Review 三个 Agent 共享
- `WorktreeManager` 被分析 Agent 和修复 Agent 共享
- GitLab Webhook 的 label 事件驱动依赖分级路由流程就绪

### 与 PRD 的偏离说明

| 项 | PRD 倾向 | 架构决定 | 偏离原因 |
|---|---------|---------|---------|
| 代码隔离 | git clone --shared + sparse-checkout | Git worktree | 团队使用经验、对 Git 侵入小 |
| 回收策略 | 两级（30min session / 2h worktree） | 统一 TTL（2h） | 简化实现，接受追问体验略降 |

## Implementation Patterns & Consistency Rules

### Pattern Categories Defined

本步骤仅定义**研发 AI 助手新增能力**的一致性规则。ChatOps 平台已建立的规则（DB 命名、API 前缀、代码命名、测试位置等）详见 `docs/chatops.md`，不在本节重复。

### 1. Capability 命名规则

**规则：** 所有新增 capability 使用 `snake_case`，按 `<动作>_<对象>[_<修饰>]` 格式。

| ✅ 推荐 | ❌ 避免 |
|--------|---------|
| `analyze_bug` | `analyzeBug` / `AnalyzeBug` |
| `fix_bug_l1` / `fix_bug_l2` / `fix_bug_l3` | `fixBugLevel1` / `fix-bug-l1` |
| `ai_review_mr` | `review_merge_request` / `reviewMR` |
| `search_knowledge` | `knowledgeSearch` / `knowledge_query` |

**Agent 角色 capability 完整清单（MVP 必需）：**

- `analyze_bug` — 分析 Agent
- `fix_bug_l1` — L1 修复 Agent
- `fix_bug_l2` — L2 修复 Agent
- `fix_bug_l3` — L3 修复 Agent（等待方案 approved 后触发）
- `ai_review_mr` — Review Agent
- `search_knowledge` — 知识库查询（可被其他 capability 复用）

### 2. MCP 工具命名规则

**规则：** 所有新增 MCP 工具使用 `snake_case`，按 `<动词>_<对象>` 格式。

| Agent 归属 | 工具名 | 用途 |
|-----------|--------|------|
| Analysis | `read_code` | 读代码文件（受 allowed path 限制） |
| Analysis | `search_knowledge` | 查询知识库 index.json |
| Analysis | `create_issue` | 创建 GitLab Issue |
| Analysis | `download_image` | 下载钉钉图片 |
| Analysis/Fix | `switch_version` | Git worktree 切版本/分支 |
| Fix | `fix_code` | 修改代码文件 |
| Fix | `update_ai_summary` | 更新 AI 摘要文档 |
| Fix | `run_tests` | 运行单元测试 |
| Fix | `create_mr` | 创建 GitLab Merge Request |
| Review | `review_mr_diff` | 读取 MR diff 并评审 |

**禁止：** 单个工具跨 Agent 使用（除 `search_knowledge` 显式共享外）。每个工具的 `requiredRole` 明确归属某 Agent。

### 3. GitLab Issue Label 命名规则

**规则：** 所有 label 使用 `kebab-case`，按 `<状态分类>-<细节>` 格式。

**状态机 label（严格枚举）：**

```
needs-analysis          ← 初始态（Issue 创建后）
  ↓
analyzing               ← 分析 Agent 运行中
  ↓
graded                  ← 已分级
  ↓
  ├── fixing            ← L1/L2：自动进入修复
  ├── needs-approval    ← L3：等待方案审批
  └── needs-manual      ← L4：人工全程
  ↓
approved                ← L3 方案审批通过
  ↓
fixing                  ← 修复 Agent 运行中
  ↓
in-review               ← MR 创建，Review Agent 审查中
  ↓
  ├── ai-approved       ← Review Agent 标记通过
  └── ai-needs-attention ← Review Agent 标记需关注
  ↓
testing                 ← 合入测试分支，集成测试中
  ↓
ready-to-merge          ← 测试通过，可合主分支
  ↓
merged → done           ← 关闭
```

**辅助 label：**

- `ai-generated` — MR 由 AI 创建
- `level-l1` / `level-l2` / `level-l3` / `level-l4` — Bug 级别（冗余于分析报告，便于筛选）
- `confidence-high` / `confidence-medium` / `confidence-low` — 置信度

**禁止：**
- 使用 camelCase 或 PascalCase label
- 使用 `bug` / `urgent` 等非状态含义 label 驱动流程（可作为分类标签但不影响状态机）

### 4. Bug 级别与分类命名规则

**规则：** 所有枚举值使用大写的短标识符，但数据库存储时统一小写。

**Bug 级别：**

| 应用层（代码/日志/回复）| 数据库存储 |
|------------------------|-----------|
| `L1` | `l1` |
| `L2` | `l2` |
| `L3` | `l3` |
| `L4` | `l4` |

**问题分类（Bug vs 其他）：**

| 应用层 | 数据库存储 | 说明 |
|-------|-----------|------|
| `Bug` | `bug` | 真 Bug，进入修复流程 |
| `Config Issue` | `config_issue` | 配置问题，不进修复流程但记录 |
| `Usage Issue` | `usage_issue` | 使用问题，直接回复不记录 |

**置信度：**

| 应用层 | 数据库存储 | 范围 |
|-------|-----------|------|
| `High` | `high` | ≥ 80% |
| `Medium` | `medium` | 50-80% |
| `Low` | `low` | < 50% |

**根因类型（Bug 归因）：**

| 应用层 | 数据库存储 | 说明 |
|-------|-----------|------|
| `Syntax` | `syntax` | 纯语法/空指针（AI 编码能力） |
| `Business Logic` | `business_logic` | prompt/摘要业务规则缺失 |
| `Requirement` | `requirement` | 需求描述模糊 |
| `Boundary` | `boundary` | 边界条件遗漏 |
| `Cross Module` | `cross_module` | 跨模块依赖 |

### 5. 路径与文件命名规则

**Worktree 路径：**

```
/tmp/analysis/{user_id}-{product}-{version}-{session_id}
```

示例：`/tmp/analysis/liaoss-PAM-dev-abc123xyz`

**Fix 分支命名：**

```
fix/issue-{number}[-attempt-{N}]
```

示例：`fix/issue-234`（首次）、`fix/issue-234-attempt-2`（第二次重试）

**知识库仓库结构：**

```
{product}-knowledge.git/
├── index.json                     ← 索引文件
├── guide/                         ← 人写业务逻辑说明
│   └── {topic}.md
└── knowledge/                     ← AI 沉淀历史 Bug
    └── {module}/
        └── {error-code-or-topic}.md
```

示例：`pam-knowledge.git/knowledge/pas/pgsql-case.md`

**AI 摘要路径（随代码仓库）：**

```
{repo}/docs/ai/
├── INDEX.md
└── {module}.md
```

示例：`pas-6.0/docs/ai/pas-secret-task.md`

### 6. index.json Schema

**规则：** 知识库索引文件使用 **snake_case** JSON 字段（与 DB 保持一致）。

```json
{
  "entries": [
    {
      "id": "pgsql-case",
      "type": "knowledge",
      "keywords": ["pgsql", "postgresql", "大小写", "验密失败"],
      "error_codes": ["TASK_PWD_4001"],
      "modules": ["pas-secret-task", "Jdbc4Protocol"],
      "product": "PAM",
      "versions": ">=6.0",
      "file": "knowledge/pas/pgsql-case.md",
      "hit_count": 12,
      "created_at": "2026-04-15T08:00:00Z",
      "updated_at": "2026-04-15T08:00:00Z"
    }
  ]
}
```

**版本匹配语法：** 使用语义化版本范围（`>=6.0`、`>=6.5,<7.0`、`*` 等）。

### 7. Bug 分析报告的结构化输出格式

**规则：** 分析 Agent 的输出为 **JSON**（供修复 Agent 消费）+ **Markdown**（供 GitLab Issue 评论）双格式。

**JSON 结构（入 `bug_analysis_reports` 表的 metadata 字段）：**

```json
{
  "level": "l2",
  "confidence": "medium",
  "confidence_score": 0.65,
  "classification": "bug",
  "root_cause": {
    "type": "business_logic",
    "summary": "会话续期判断在空闲+活动连接场景下误判超时",
    "file": "src/session/SessionManager.java",
    "line_range": [142, 168]
  },
  "solutions": [
    {
      "id": "option-a",
      "summary": "调整 checkTimeout 判断优先级",
      "recommended": true,
      "risk": "low",
      "effort": "small"
    },
    {
      "id": "option-b",
      "summary": "增加 isConnectionActive 前置检查",
      "recommended": false,
      "risk": "medium",
      "effort": "medium"
    }
  ],
  "affected_modules": ["pas-bastion-host"],
  "analysis_steps": [
    "读 Issue 和截图",
    "定位 SessionManager 的 checkTimeout",
    "对比 v6.6.1.2 和 dev 分支差异",
    "...（Phase 1-4 追踪链）"
  ]
}
```

**Markdown 格式（写入 GitLab Issue 评论）：** 人类可读摘要，附上 JSON 完整报告的链接（指向 `bug_analysis_reports` 表记录）。

### 8. AI Commit Message 格式

**规则：** 修复 Agent 的每次 commit 都遵循以下格式（借鉴 Aider，addendum 2.4）：

```
fix(l1|l2|l3): <issue_title> - attempt <N>/3

Hypothesis: <此次修改基于的假设>
Changed: <改了什么>
Test: <测试结果 pass/fail>
Next: <如果 fail，下一步计划>

Issue: #<issue_id>
Confidence: <high|medium|low>
```

**示例：**

```
fix(l2): ParamValidator 边界条件 - attempt 2/3

Hypothesis: 空字符串在 validate 时应返回 false
Changed: ParamValidator.validate() 增加 str.isEmpty() 检查
Test: UnitTest pass, IntegrationTest fail on null case
Next: 下一次尝试补 null 分支

Issue: #289
Confidence: medium
```

**禁止：** 单行简短 commit message 或仅含"fix xxx"的无上下文提交。

### 9. 日志前缀规则

**规则：** 所有日志行以 `[Component]` 前缀开头，便于按组件过滤。

| 组件 | 前缀 |
|------|------|
| AgentCoordinator | `[AgentCoordinator]` |
| 分析 Agent | `[AnalysisAgent]` |
| 修复 Agent | `[FixAgent]` |
| Review Agent | `[ReviewAgent]` |
| WorktreeManager | `[Worktree]` |
| KnowledgeRepository | `[Knowledge]` |
| GitLab 适配器 | `[GitLab]` |

**日志级别：**
- `INFO`：正常流程里程碑（Agent 启动、完成、状态切换）
- `WARN`：非致命异常（重试、降级触发）
- `ERROR`：失败需人工介入
- `DEBUG`：开发期详细追踪，默认不打开

### 10. 错误处理与降级规则

**规则：**

- **可恢复错误**（网络抖动、临时限流）：自动重试 3 次 + 指数退避（1s/2s/4s）
- **不可恢复错误**（代码错误、数据冲突）：立即抛出 + 日志 ERROR + 通知相关人
- **AI 能力不足**（修复失败）：按分级路由自动降级（L1→L3 / L2→L3 / L3→人工接手）
- **禁止"静默失败"**：任何 catch 块必须有日志或重抛

### 11. Session 与 Worktree 生命周期一致性

**规则：** 任何 Agent 启动前必须通过 `WorktreeManager.acquire()` 获取 worktree，结束后通过 `WorktreeManager.release()` 标记。禁止直接操作目录。

```typescript
// 正确用法
const worktree = await worktreeManager.acquire({
  userId, product, version, sessionId
});
try {
  // Agent 使用 worktree.path
} finally {
  await worktreeManager.release(worktree);
}

// 错误用法：直接 mkdir/rm
fs.mkdirSync('/tmp/analysis/xxx');  // ❌ 不允许
```

### 12. 统一的枚举转换规则

**规则：** 所有枚举类型在 DB 与 TS 之间转换遵循同一函数。

```typescript
// 提供统一转换工具
// src/shared/enum-converter.ts
export const bugLevelToDB = (level: 'L1' | 'L2' | 'L3' | 'L4'): string =>
  level.toLowerCase();
export const bugLevelFromDB = (s: string): 'L1' | 'L2' | 'L3' | 'L4' =>
  s.toUpperCase() as any;
```

**禁止：** 分散的 `if/else` 或 `switch` 转换（难维护、易漏）。

### Enforcement Guidelines

**所有 AI 开发 agent 在实施新 capability 时必须：**

1. ✅ 遵守 ChatOps 已确立的模式（见 `docs/chatops.md`）
2. ✅ 使用本文档定义的命名规则（capability / tool / label / 枚举值）
3. ✅ 通过 `registerTool()` 自注册新工具 + 双 import（`server.ts` + `mcp-server.ts`）
4. ✅ 新 capability 在数据库插入记录 + 配置 `product_line_capabilities`
5. ✅ Agent 必须通过 `WorktreeManager` 获取/释放 worktree（禁止裸 fs 操作）
6. ✅ commit message 遵循 Aider 风格（至少 3 段：Hypothesis / Changed / Test）
7. ✅ 日志必须带组件前缀 `[Component]`
8. ✅ 错误必须被处理（重试 / 降级 / 日志），禁止静默 catch

**Pattern 审查：**

- Code Review 时必须检查命名与格式合规
- 违反模式的 PR 需说明理由（如 ChatOps 已有的反例，暂不修改）
- 新模式引入须更新本文档

### Pattern Examples

**Good Examples:**

```typescript
// ✅ Capability 注册
const analyzeBug: Capability = {
  key: 'analyze_bug',
  displayName: 'Bug 分析',
  toolNames: ['read_code', 'search_knowledge', 'create_issue', 'download_image'],
  systemPrompt: '...',
};

// ✅ 状态机驱动
async function handleIssueLabelChange(issue: Issue, oldLabel: string, newLabel: string) {
  log.info('[AgentCoordinator] Issue label changed', { issue: issue.iid, oldLabel, newLabel });
  if (newLabel === 'needs-analysis') {
    await triggerCapability('analyze_bug', { issue });
  } else if (newLabel === 'approved') {
    const level = await getBugLevel(issue);
    await triggerCapability(`fix_bug_${level.toLowerCase()}`, { issue });
  }
}

// ✅ 枚举统一转换
const reportRow: BugAnalysisReportRow = {
  level: bugLevelToDB(report.level),
  confidence: confidenceToDB(report.confidence),
  classification: classificationToDB(report.classification),
};
```

**Anti-Patterns:**

```typescript
// ❌ 直接操作 worktree 目录
fs.mkdirSync(`/tmp/analysis/${userId}-${product}`);

// ❌ 枚举 inline 转换
const dbLevel = report.level === 'L1' ? 'l1' :
                report.level === 'L2' ? 'l2' : 'l3';

// ❌ 无上下文 commit
await git.commit({ message: 'fix bug' });

// ❌ 静默 catch
try {
  await search_knowledge(...);
} catch (e) { /* ignore */ }

// ❌ 错误的 capability 命名
const cap = { key: 'analyzeBug', ... };  // 应为 analyze_bug
```

## Project Structure & Boundaries

### 棕地结构原则

ChatOps 已有的目录结构保持不变，**新增能力按"功能域扩展"策略**，在现有目录下添加子目录和文件。所有命名遵循 Step 5 定义的规则。

### Complete Project Directory Structure（只展示 AI 助手相关的新增/扩展）

```
chatops/
├── src/
│   ├── agent/
│   │   ├── claude-runner.ts              [EXT]  扩展支持非 IM 触发（由 AgentCoordinator 调用）
│   │   ├── session-manager.ts            [EXT]  扩展按 (user, product, sessionId) 维度
│   │   ├── task-queue.ts                 [KEEP] 复用
│   │   ├── mcp-server.ts                 [EXT]  新 import 新增工具
│   │   │
│   │   ├── coordinator.ts                [NEW]  AgentCoordinator：订阅事件、触发 Agent、handoff 协调
│   │   │
│   │   ├── worktree/
│   │   │   ├── manager.ts                [NEW]  WorktreeManager：acquire/release/cleanup
│   │   │   └── cleanup-scheduler.ts      [NEW]  凌晨 3 点定时清理
│   │   │
│   │   ├── knowledge/
│   │   │   ├── repository.ts             [NEW]  Git 仓库 clone/pull/commit 操作
│   │   │   ├── index-matcher.ts          [NEW]  index.json 查询匹配（关键词/错误码/模块/版本）
│   │   │   ├── image-storage.ts          [NEW]  图片存储接口 + LocalFileStorage 实现
│   │   │   ├── hit-tracker.ts            [NEW]  命中热度统计
│   │   │   └── types.ts                  [NEW]  KnowledgeEntry/IndexFile 类型
│   │   │
│   │   ├── analysis/
│   │   │   ├── analyzer.ts               [NEW]  analyze_bug capability 主逻辑
│   │   │   ├── bug-classifier.ts         [NEW]  Bug vs Config vs Usage 分类
│   │   │   ├── level-detector.ts         [NEW]  L1-L4 级别判定
│   │   │   ├── confidence.ts             [NEW]  置信度校准与打分
│   │   │   └── report-builder.ts         [NEW]  结构化分析报告构造（JSON + Markdown 双格式）
│   │   │
│   │   ├── fix/
│   │   │   ├── fix-runner.ts             [NEW]  修复 Agent 主逻辑（L1/L2/L3 复用）
│   │   │   ├── retry-handler.ts          [NEW]  3 次重试 + 自动降级
│   │   │   ├── branch-manager.ts         [NEW]  fix 分支创建/保留/命名
│   │   │   └── commit-builder.ts         [NEW]  Aider 风格 commit message
│   │   │
│   │   ├── review/
│   │   │   ├── reviewer.ts               [NEW]  Review Agent 主逻辑
│   │   │   └── review-report.ts          [NEW]  Review 结果 → label + 评论
│   │   │
│   │   ├── masking/
│   │   │   └── sensitive-info.ts         [NEW]  敏感信息脱敏（密码/密钥/IP）
│   │   │
│   │   └── tools/
│   │       ├── index.ts                  [KEEP] Tool registry
│   │       ├── types.ts                  [EXT]  新增 DEFAULT_TOOL_ROLES 条目
│   │       │
│   │       # 分析 Agent 工具
│   │       ├── read-code.ts              [NEW]
│   │       ├── search-knowledge.ts       [NEW]
│   │       ├── create-issue.ts           [NEW]
│   │       ├── download-image.ts         [NEW]
│   │       ├── switch-version.ts         [NEW]  共享给分析/修复
│   │       │
│   │       # 修复 Agent 工具
│   │       ├── fix-code.ts               [NEW]
│   │       ├── update-ai-summary.ts      [NEW]
│   │       ├── run-tests.ts              [NEW]
│   │       ├── create-mr.ts              [NEW]
│   │       │
│   │       # Review Agent 工具
│   │       └── review-mr-diff.ts         [NEW]
│   │
│   ├── adapters/
│   │   ├── im/
│   │   │   ├── types.ts                  [EXT]  NormalizedMessage 增加 images 字段
│   │   │   ├── dingtalk.ts               [EXT]  parseRichText / parseRepliedMsg / downloadImage
│   │   │   └── feishu.ts                 [EXT]  图片支持（如飞书 SDK 允许）
│   │   │
│   │   └── gitlab/
│   │       ├── webhook-receiver.ts       [EXT]  新增 Issue / MR events 处理
│   │       ├── issue-handler.ts          [NEW]  label 状态机驱动
│   │       ├── mr-handler.ts             [NEW]  MR 事件处理（触发 Review Agent）
│   │       ├── rate-limiter.ts           [NEW]  令牌桶 + 退避重试
│   │       └── api-client.ts             [NEW]  GitLab API 封装（经 rate-limiter 包装）
│   │
│   ├── db/
│   │   ├── schema-v8.sql                 [NEW]  AI 助手表定义
│   │   ├── migrate.ts                    [EXT]  追加 v8 迁移
│   │   │
│   │   └── repositories/
│   │       ├── bug-analysis-reports.ts   [NEW]  bug_analysis_reports CRUD
│   │       ├── module-owners.ts          [NEW]  模块 → 负责人映射
│   │       ├── product-knowledge-repos.ts [NEW]  产品线 → 知识库仓库映射
│   │       ├── root-cause-attribution.ts [NEW]  Bug 根因归因记录
│   │       ├── metrics-daily.ts          [NEW]  日级指标
│   │       ├── knowledge-hit-stats.ts    [NEW]  知识库命中统计
│   │       └── bug-analysis-stats.ts     [NEW]  分析任务统计
│   │
│   ├── admin/
│   │   ├── index.ts                      [EXT]  注册新路由
│   │   │
│   │   └── routes/
│   │       ├── module-owners.ts          [NEW]  /admin/module-owners
│   │       ├── product-knowledge.ts      [NEW]  /admin/product-knowledge
│   │       ├── bug-analysis-reports.ts   [NEW]  /admin/bug-analysis-reports
│   │       └── metrics.ts                [NEW]  /admin/metrics（Growth）
│   │
│   ├── pipeline/
│   │   ├── executor.ts                   [EXT]  支持 capability / wait_webhook stage 类型
│   │   └── types.ts                      [EXT]  StageType 增加新类型
│   │
│   ├── approval/
│   │   └── gate.ts                       [KEEP] 复用（L3 方案审批 / MR 合并审批）
│   │
│   ├── shared/                           [NEW 目录]
│   │   ├── enum-converter.ts             [NEW]  Bug 级别/分类/置信度/根因类型转换
│   │   ├── logger.ts                     [NEW 或 EXT]  带 [Component] 前缀封装
│   │   └── types.ts                      [NEW]  跨模块共享类型
│   │
│   ├── server.ts                         [EXT]  注册新工具/路由 import
│   └── config.ts                         [EXT]  新增环境变量（KNOWLEDGE_IMAGE_DIR 等）
│
├── web/
│   └── src/
│       ├── pages/
│       │   ├── TestRunsPage.tsx          [EXT]  支持 Bug 修复流程类型的运行展示
│       │   ├── BugRunsPage.tsx           [NEW]  Bug 修复实例列表（12 节点闭环进度）
│       │   ├── BugAnalysisReportsPage.tsx [NEW]  分析报告列表/详情
│       │   ├── ModuleOwnersPage.tsx      [NEW]  模块负责人配置
│       │   ├── ProductKnowledgePage.tsx  [NEW]  知识库配置
│       │   └── MetricsPage.tsx           [NEW]  价值量化仪表盘（Growth）
│       │
│       └── api/
│           ├── bug-analysis-reports.ts   [NEW]
│           ├── module-owners.ts          [NEW]
│           ├── product-knowledge.ts      [NEW]
│           └── metrics.ts                [NEW]
│
├── docs/
│   ├── architecture/
│   │   ├── ai-assistant-architecture.md  [LINK] 本文档的 docs 副本或指针
│   │   └── existing/                     [KEEP] ChatOps 已有架构文档
│   └── ai-summary/                       [KEEP] ChatOps 平台的 AI 摘要（这是"平台的"不是"研发助手知识库"）
│
└── _bmad-output/
    └── planning-artifacts/
        ├── prd.md
        ├── prd-validation-report.md
        └── architecture.md               ← 本文档
```

**图例：**
- `[NEW]`：全新文件
- `[EXT]`：扩展已有文件
- `[KEEP]`：不动

### Database Schema（v8 新增）

```sql
-- src/db/schema-v8.sql

-- 1. Bug 分析报告（Agent 间 handoff 契约）
CREATE TABLE IF NOT EXISTS bug_analysis_reports (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER NOT NULL,
  issue_url TEXT NOT NULL,
  product_line_id INTEGER NOT NULL REFERENCES product_lines(id),
  agent_session_id TEXT,
  level VARCHAR(8) NOT NULL,              -- l1/l2/l3/l4
  classification VARCHAR(16) NOT NULL,     -- bug/config_issue/usage_issue
  confidence VARCHAR(8) NOT NULL,          -- high/medium/low
  confidence_score NUMERIC(3,2),
  root_cause_summary TEXT,
  solutions_json JSONB NOT NULL,           -- Solutions 数组
  affected_modules JSONB,                  -- 模块字符串数组
  analysis_steps JSONB,                    -- Phase 1-4 追踪
  metadata JSONB,                          -- 完整结构化报告
  status VARCHAR(16) NOT NULL DEFAULT 'draft', -- draft/published/superseded
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bug_reports_issue ON bug_analysis_reports(issue_id);
CREATE INDEX IF NOT EXISTS idx_bug_reports_product ON bug_analysis_reports(product_line_id);

-- 2. 模块 → 负责人映射
CREATE TABLE IF NOT EXISTS module_owners (
  id SERIAL PRIMARY KEY,
  product_line_id INTEGER NOT NULL REFERENCES product_lines(id),
  module_pattern TEXT NOT NULL,            -- 如 pas-bastion-host 或通配符 pas-*
  owner_user_id TEXT NOT NULL,             -- 钉钉 userId
  backup_owner_user_id TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_module_owners_unique
  ON module_owners(product_line_id, module_pattern);

-- 3. 产品线 → 知识库仓库映射
CREATE TABLE IF NOT EXISTS product_knowledge_repos (
  id SERIAL PRIMARY KEY,
  product_line_id INTEGER NOT NULL UNIQUE REFERENCES product_lines(id),
  code_repo_url TEXT NOT NULL,
  code_default_branch TEXT NOT NULL DEFAULT 'develop',
  knowledge_repo_url TEXT NOT NULL,
  ai_summary_path TEXT NOT NULL DEFAULT 'docs/ai',
  image_storage_config JSONB,              -- {type: 'local'|'minio'|'oss', config: {...}}
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 4. Bug 根因归因
CREATE TABLE IF NOT EXISTS root_cause_attributions (
  id SERIAL PRIMARY KEY,
  issue_id INTEGER NOT NULL,
  report_id INTEGER REFERENCES bug_analysis_reports(id),
  root_cause_type VARCHAR(32) NOT NULL,    -- syntax/business_logic/requirement/boundary/cross_module
  context TEXT,
  attributed_by TEXT,                      -- 'ai' | 'user:<id>'
  attributed_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 5. 知识库命中统计
CREATE TABLE IF NOT EXISTS knowledge_hit_stats (
  id SERIAL PRIMARY KEY,
  entry_id TEXT NOT NULL,                  -- index.json 中的 id
  product_line_id INTEGER NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 6. 分析任务统计
CREATE TABLE IF NOT EXISTS bug_analysis_stats (
  id SERIAL PRIMARY KEY,
  report_id INTEGER REFERENCES bug_analysis_reports(id),
  duration_ms INTEGER NOT NULL,
  cache_hit BOOLEAN NOT NULL DEFAULT FALSE,
  token_count INTEGER,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- 7. 日级指标聚合（Growth）
CREATE TABLE IF NOT EXISTS metrics_daily (
  id SERIAL PRIMARY KEY,
  date DATE NOT NULL,
  product_line_id INTEGER REFERENCES product_lines(id),
  metric_key VARCHAR(64) NOT NULL,
  metric_value NUMERIC NOT NULL,
  metadata JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_metrics_daily_unique
  ON metrics_daily(date, product_line_id, metric_key);
```

### Architectural Boundaries

#### API Boundaries

**外部 API（客户/用户直接调用）：**

| 路径 | 用途 | 鉴权 |
|------|------|------|
| `/webhook/dingtalk` | 钉钉 Stream 回调 | ChatOps 现有 |
| `/webhook/feishu` | 飞书 Webhook | ChatOps 现有 |
| `/webhook/gitlab` | GitLab Webhook | `x-gitlab-token` 验证 |

**管理 API（后台专用，/admin 前缀）：**

| 路径 | 资源 | 备注 |
|------|------|------|
| `/admin/product-lines` | ChatOps 已有 | 扩展知识库配置字段 |
| `/admin/module-owners` | 模块负责人 | **新增** |
| `/admin/product-knowledge` | 知识库配置 | **新增** |
| `/admin/bug-analysis-reports` | 分析报告查询 | **新增** |
| `/admin/metrics` | 价值仪表盘数据 | **新增（Growth）** |
| `/admin/capabilities` | ChatOps 已有 | 自动注册 AI 助手 capability |

**内部调用边界（Agent 间）：**

- 分析 Agent → 修复 Agent：通过 `bug_analysis_reports` 表传递（**DB 契约**）
- 分析 Agent → GitLab：通过 `api-client.ts` 写 Issue 评论（**外部审计**）
- 修复 Agent → Review Agent：通过 GitLab MR events（**事件驱动**）
- 任意 Agent → WorktreeManager：`acquire()` / `release()`（**必经网关**）
- 任意 Agent → KnowledgeRepository：`search()` / `write()`（**必经网关**）

#### Component Boundaries

**后端组件：**

```
HTTP 层（Fastify） 
    ↓
IM 适配层（dingtalk/feishu）
    ↓
Session 层（SessionManager / TaskQueue）
    ↓
Agent 编排层（AgentCoordinator）
    ↓
Agent 实现层（Analysis/Fix/Review）
    ↓
MCP 工具层（tools/*）
    ↓
基础设施层（WorktreeManager / KnowledgeRepository / GitLab API / DB Repository）
```

**层间契约：**
- 上层只依赖下层接口，不依赖实现（通过 TypeScript interface 约束）
- 跨层调用禁止（如 HTTP 层不能直接调工具层）
- Agent 层之间不直接调用，一律经 AgentCoordinator

**前端组件：**

```
页面（pages/*）
    ↓
API 层（api/*，axios 封装）
    ↓
后端 /admin/* API
```

Ant Design 5 组件作为 UI 原子，页面组合业务逻辑。

#### Data Boundaries

**Database 访问约束：**

- 所有 SQL 在 `src/db/repositories/*`，业务层只调 repository
- 不在 route/agent 层直接写 SQL
- 跨表事务在 repository 层使用 `pool.connect()` + `BEGIN/COMMIT`
- 新表必须经 `schema-vN.sql` 迁移（不用运行时 `CREATE TABLE`）

**JSONB 字段约束：**

- JSONB 字段必须有 TypeScript 类型定义
- 存入前 `JSON.stringify`，读取后 `JSON.parse`（Node pg 驱动自动处理）
- 查询 JSONB 字段使用 `-> / ->>` 操作符，不用 `::text`

**Knowledge Base 访问约束：**

- 知识库 Git 仓库**只能**通过 `KnowledgeRepository` 类访问
- 本地缓存路径：`/var/cache/chatops-knowledge/{product}/`（启动时 clone，定期 pull）
- Agent 分析时从本地缓存读 + index.json 匹配（避免每次分析都 clone）

### Requirements to Structure Mapping

**FR 能力域 → 代码模块映射：**

| FR 能力域 | 主要代码位置 | 数据库表 |
|---------|------------|--------|
| FR1-6 IM 对话交互 | `adapters/im/` | — |
| FR7-11 代码访问与会话隔离 | `agent/worktree/`, `agent/session-manager.ts` | — |
| FR12-19 知识层 | `agent/knowledge/`, `agent/tools/search-knowledge.ts`, `agent/tools/update-ai-summary.ts` | `product_knowledge_repos`, `knowledge_hit_stats` |
| FR20-27 Bug 分析与分级 | `agent/analysis/`, `agent/tools/read-code.ts`, `agent/tools/create-issue.ts` | `bug_analysis_reports`, `bug_analysis_stats` |
| FR28-35 自动修复与 Review | `agent/fix/`, `agent/review/`, `agent/tools/fix-code.ts` 等 | — |
| FR36-41 审批与流程编排 | `adapters/gitlab/issue-handler.ts`, `agent/coordinator.ts`, `approval/gate.ts`（复用） | `module_owners` |
| FR42-44 Bug 根因归因 | `agent/analysis/bug-classifier.ts`, `db/repositories/root-cause-attribution.ts` | `root_cause_attributions` |
| FR45-49 权限与多租户 | ChatOps 已有 `capabilities` / `product_line_capabilities` | 复用 |
| FR50-55 管理与监控 | `admin/routes/`, `web/src/pages/` | `metrics_daily` |

**NFR → 实现位置：**

| NFR 类别 | 实现位置 |
|---------|---------|
| Performance（P1-P5） | `agent/knowledge/index-matcher.ts`（命中秒级），`agent/worktree/manager.ts`（隔离开销），`agent/session-manager.ts`（并发管理） |
| Security（S1-S6） | `agent/masking/sensitive-info.ts`，Agent capability 的 `allowedTools` 配置，`adapters/gitlab/webhook-receiver.ts` 鉴权 |
| Scalability（SC1-SC4） | `admin/routes/product-knowledge.ts`（接入流程），`agent/worktree/`（共享 objects） |
| Reliability（R1-R5） | `agent/fix/retry-handler.ts`，`agent/session-manager.ts`（恢复），`agent/worktree/cleanup-scheduler.ts`（兜底） |
| Observability（O1-O4） | `db/repositories/metrics-daily.ts`，前端 `MetricsPage.tsx`，`shared/logger.ts` |
| Integration（I1-I5） | `adapters/gitlab/rate-limiter.ts`，现有 IM 适配层 |

### Integration Points

#### Internal Communication（内部通信）

| 通信 | 机制 | 实现 |
|------|------|------|
| HTTP → Agent | 函数调用 | `coordinator.triggerCapability()` |
| Agent → MCP 工具 | MCP JSON-RPC | Porygon 子进程 + stdio |
| Agent 完成 → 下一个 Agent | 事件 + DB | AgentCoordinator 订阅事件，读 bug_analysis_reports |
| GitLab Webhook → Agent | HTTP → AgentCoordinator | `issue-handler.ts` 路由到 capability |
| 定时任务 → 清理 | node-cron | `cleanup-scheduler.ts` |

#### External Integrations（外部集成）

| 系统 | 协议 | 实现 |
|------|------|------|
| Claude API（via Porygon） | Claude CLI + MCP | `agent/claude-runner.ts` |
| GitLab | HTTPS REST | `adapters/gitlab/api-client.ts`（经 rate-limiter） |
| 钉钉 | Stream（WebSocket） | `adapters/im/dingtalk.ts` |
| 飞书 | HTTPS Webhook | `adapters/im/feishu.ts` |
| 知识库 Git 仓库 | Git CLI / simple-git 库 | `agent/knowledge/repository.ts` |
| SSH（部署/日志） | SSH protocol | `pipeline/ssh.ts`（复用） |
| Harbor | HTTPS | 现有 |
| 对象存储（Growth） | S3 兼容 API | `agent/knowledge/image-storage.ts`（MinIO/OSS 实现） |

#### Data Flow（数据流）

**L1 Bug 完整数据流示例：**

```
1. 钉钉消息 @机器人
   → DingTalkAdapter.handleRobotMessage()
   → NormalizedMessage（含 images[]）

2. SessionManager → TaskQueue → ClaudeRunner
   → detectIntent → 'analyze_bug' capability

3. AnalysisAgent.run():
   3.1 acquire Worktree（WorktreeManager）
   3.2 switch_version（MCP tool）→ checkout 版本
   3.3 search_knowledge（MCP tool）→ KnowledgeRepository.search()
       → 未命中
   3.4 read_code（MCP tool）→ 读代码
   3.5 bug_classifier → classification = 'bug'
   3.6 level_detector → level = 'l1'
   3.7 confidence → 'high' (0.85)
   3.8 report_builder → 构造结构化报告
   3.9 create_issue（MCP tool）→ GitLab API
   3.10 insert into bug_analysis_reports
   3.11 GitLab Issue 加 label 'graded' + 'level-l1' + 'fixing'

4. GitLab Webhook（label 'fixing' 变化）
   → WebhookReceiver → IssueHandler.handle()
   → AgentCoordinator.trigger('fix_bug_l1', { issueId, reportId })

5. FixAgent.run():
   5.1 acquire new Worktree（或复用）
   5.2 读 bug_analysis_reports（获取方案）
   5.3 fix_code（MCP tool）→ 修改代码
   5.4 update_ai_summary（MCP tool）→ 更新摘要
   5.5 run_tests（MCP tool）→ 通过
   5.6 create_mr（MCP tool）→ GitLab API
   5.7 GitLab Issue label 'in-review' + MR label 'ai-generated'

6. GitLab Webhook（MR 创建）
   → WebhookReceiver → MRHandler.handle()
   → AgentCoordinator.trigger('ai_review_mr', { mrId })

7. ReviewAgent.run():
   7.1 review_mr_diff（MCP tool）→ 读 MR diff
   7.2 LLM 审查 → 报告
   7.3 MR 加 label 'ai-approved' 或 'ai-needs-attention'
   7.4 MR 评论写入审查结论

8. 钉钉通知 @小 A（模块负责人）："MR 已 AI Review 通过，请合并"
```

### File Organization Patterns

#### 配置文件

- 根目录：`.env` / `.env.example` / `docker-compose.yml` / `package.json`
- TypeScript：`tsconfig.json`（根）+ `web/tsconfig.json`（前端）
- Vite：`web/vite.config.ts`
- Vitest：`vitest.config.ts`
- ESLint/Prettier：随 ChatOps 已有配置

#### 源代码组织

**新增文件的归属原则：**
- 属于**某 Agent 业务逻辑**：放 `agent/<agent-name>/`
- 属于**跨 Agent 共享**：放 `agent/knowledge/` 或 `agent/worktree/`
- 属于**MCP 工具**：放 `agent/tools/<tool-name>.ts`（扁平）
- 属于**HTTP 适配**：放 `adapters/<platform>/`
- 属于**Admin 路由**：放 `admin/routes/<resource>.ts`
- 属于**数据访问**：放 `db/repositories/<entity>.ts`
- 属于**跨模块共享**（枚举转换/日志）：放 `shared/`

#### 测试组织

**沿用 ChatOps 已有模式：** `src/__tests__/unit/` 与 `src/__tests__/integration/`

**新增测试文件命名：**
- `src/__tests__/unit/agent-coordinator.test.ts`
- `src/__tests__/unit/worktree-manager.test.ts`
- `src/__tests__/unit/knowledge-index-matcher.test.ts`
- `src/__tests__/unit/bug-level-detector.test.ts`
- `src/__tests__/unit/retry-handler.test.ts`
- `src/__tests__/integration/full-bug-fix-flow.test.ts`（端到端 L1 闭环测试）

#### 静态资源

- ChatOps 前端构建产物：`web/dist/`（由 `build.sh` 打包进 Docker 镜像）
- 知识库图片（本地）：`/opt/knowledge/images/`（容器卷挂载）
- Worktree 临时目录：`/tmp/analysis/`（容器内临时）
- 日志：`/var/log/chatops/` + `/tmp/mcp-server.log`
- 测试报告：`/data/chatops/test-runs/`（复用 ChatOps）

### Development Workflow Integration

**开发流程：**

1. 本地开发：`pnpm dev`（后端热重载 3000）+ `cd web && pnpm dev`（前端 5173）
2. 数据库迁移：`pnpm migrate`（自动执行到 schema-v8）
3. 单元测试：`pnpm test` / `npx vitest run src/__tests__/unit/agent-coordinator.test.ts`
4. 集成测试：`pnpm test:integration`（需 docker-compose 起 postgres）
5. 打包：`./build.sh`（多阶段 Docker build）
6. 部署：`./deploy.sh up`

**新能力开发 checklist（给 AI agent）：**

```
新增 capability 工作流:
  1. [ ] src/db/schema-v8.sql 如需新表则追加（或 schema-v9+ 避免冲突）
  2. [ ] src/db/repositories/<entity>.ts 创建 Repository + mapRow
  3. [ ] src/agent/<agent-name>/ 创建 Agent 业务模块
  4. [ ] src/agent/tools/<tool-name>.ts 创建 MCP 工具（registerTool）
  5. [ ] src/agent/tools/types.ts 追加 DEFAULT_TOOL_ROLES
  6. [ ] src/server.ts 追加 import './agent/tools/<tool-name>.js'
  7. [ ] src/agent/mcp-server.ts 追加相同 import
  8. [ ] 数据库插入 capability 记录（或通过迁移 INSERT）
  9. [ ] src/admin/routes/<resource>.ts 如需管理入口则新增
  10. [ ] src/admin/index.ts 注册新路由
  11. [ ] web/src/api/<resource>.ts + web/src/pages/<Resource>Page.tsx
  12. [ ] src/__tests__/unit/<target>.test.ts 补单测
  13. [ ] 运行 pnpm test 全通过
  14. [ ] 运行 pnpm dev 手工验收
```

**构建流程（现有，不改动）：**

```
pnpm install
→ tsc 类型检查（后端）
→ cd web && pnpm build（前端 Vite 产物到 web/dist/）
→ docker build 多阶段（node:20 编译 → alpine 运行）
→ docker compose up
```

**部署结构：**

- 单 Docker 容器运行 Fastify 服务（含静态文件服务 web/dist/）
- 独立 postgres 容器
- 独立 migrate 容器（一次性执行 schema-vN.sql 后退出）
## Architecture Validation Results

### Coherence Validation ✅

**Decision Compatibility（决策兼容性）：**

| 决策组合 | 兼容性 | 说明 |
|---------|:-----:|------|
| Capability+Coordinator × ChatOps 现有 capability 路由 | ✅ | 在现有路由机制下增加 capability 和协调模块 |
| Git worktree × Docker 部署 | ✅ | worktree 在容器内 `/tmp/analysis/`，主仓库 volume 挂载 |
| 独立 Review CLI × Porygon 多子进程 | ✅ | Porygon 天然支持多实例 |
| DB 传递方案 × PostgreSQL | ✅ | JSONB 字段存储结构化方案 |
| Git 仓库知识库 × PostgreSQL 统计表 | ✅ | 内容归 Git，元数据/命中统计归 DB |

**无技术冲突。** 所有决策基于 ChatOps 已建立栈。

**Pattern Consistency（模式一致性）：** Step 5 的 12 组一致性规则全部与 Step 4 的 6 组决策对齐。命名规范在 Step 6 的目录结构中完整落地。ChatOps 已建立的模式（snake_case DB、camelCase TS、tool 自注册、schema-vN 迁移）在新增部分被严格遵守。

**Structure Alignment（结构对齐）：** Step 6 目录结构完整支持 Step 4 决策。每个新增组件都有明确归属目录。边界清晰：Agent 层不直连 DB（必经 repository），不直接操作 fs（必经 WorktreeManager）。

### Requirements Coverage Validation ✅

**Functional Requirements Coverage: 55/55 = 100%**

所有 9 个 FR 能力域均有对应架构组件支撑（详见 Step 6 的 FR→Structure 映射表）。

**Non-Functional Requirements Coverage: 24/24 = 100%**

6 个 NFR 类别的指标均有实现位置（详见 Step 6 的 NFR→实现位置映射表）。

**Epic/Feature Coverage：**

- 里程碑 0（平台基础设施扩展）：图片/stage 类型/capability 注册/Bug 修复实例页面 — 全部覆盖
- 里程碑 1（分析闭环）：知识库 / analyze_bug 工具集 / 置信度 / 方案先行 / 命中查询 / Webhook 驱动 — 全部覆盖
- 里程碑 2（修复闭环）：修复工具集 / 流程定义 / 失败降级 / 摘要同步 / Review Agent / L3 审批 — 全部覆盖
- 里程碑 3（进化闭环，Growth）：根因归因 / 知识库自动沉淀 / 价值量化仪表盘 / L3 流程编排 / 多模型 — 架构已为此预留入口

### Implementation Readiness Validation ✅

| 评估项 | 结果 |
|-------|:----:|
| 所有 FR 能定位到代码位置 | ✅ Step 6 映射表 |
| 命名规则完备 | ✅ Step 5 的 12 组规则 |
| 文件归属原则清晰 | ✅ Step 6 归属原则 |
| AI agent 开发 checklist | ✅ 14 项 checklist |
| 复杂决策提供代码示例 | ✅ 5 组正反例 |
| DB Schema 已定义 | ✅ schema-v8.sql 含 7 张表 |

**Confidence Level: 高**

### Gap Analysis Results

**Critical Gaps（阻碍实现）：0** ✅

无阻碍实施的关键缺口。

**Important Gaps（可改进，不阻碍）：4**

| # | Gap | 建议补充位置 |
|---|-----|------------|
| 1 | AI 摘要自动扫描生成（FR18）具体子流程未细化 | Step 8 或独立设计文档 `docs/ai-summary-generation.md` |
| 2 | Review Agent 的"不同视角" systemPrompt 具体内容 | 实施时 capability 表 INSERT 时填充 |
| 3 | 知识库 Git 仓库的冷启动流程（首次初始化） | 产品线接入向导流程（Journey 5）细化 |
| 4 | metrics_daily 聚合任务（谁触发、频率） | 使用 node-cron 每日凌晨聚合前一天数据 |

**Nice-to-Have Gaps（优化项）：4**

| # | Gap | 说明 |
|---|-----|------|
| 1 | systematic-debugging Phase 1-4 在 analyze_bug systemPrompt 的详细步骤 | addendum 已列方法论，实施时转化为 prompt |
| 2 | Review Agent 评审 checklist 具体条目 | 参考 Aider/OpenSWE 的 review 规范 |
| 3 | 价值量化仪表盘图表类型 | UX 设计阶段决定（MVP 后） |
| 4 | 对象存储切换配置接口细节 | Growth 阶段补充 |

### Validation Issues Addressed

所有 Critical Gaps 已处理（无）。4 个 Important Gaps 在 Step 8 的实施建议中明确提出。4 个 Nice-to-Have Gaps 标记为 Growth 阶段或 UX 设计阶段关注项。

### Architecture Completeness Checklist

**✅ Requirements Analysis**
- [x] 项目上下文已分析（10 个横切关注点 + 预估 15-20 组件）
- [x] 规模与复杂度评估（中-高，全栈 B2B SaaS + AI Agent 编排）
- [x] 技术约束识别（ChatOps 棕地硬约束 + 3 个待决策事项）
- [x] 横切关注点映射（10 项已排优先级）

**✅ Architectural Decisions**
- [x] 13 项关键决策已文档化（6 组）
- [x] 技术栈完全锚定 ChatOps 已有栈
- [x] 集成模式定义（GitLab label 状态机、Agent handoff）
- [x] 性能考虑（worktree 共享、session 复用、knowledge 命中）

**✅ Implementation Patterns**
- [x] 命名规则（capability / tool / label / 枚举）
- [x] 结构规则（目录归属、测试命名）
- [x] 通信模式（Agent 间 handoff、事件驱动）
- [x] 流程模式（错误处理、降级、commit 格式）

**✅ Project Structure**
- [x] 完整目录结构（标注 NEW / EXT / KEEP）
- [x] 组件边界（API / 内部调用 / 数据 / 外部集成）
- [x] 集成点映射（10 个外部系统）
- [x] FR → Structure 映射（9 个能力域）

### Architecture Readiness Assessment

**Overall Status: READY FOR IMPLEMENTATION** ✅

**Confidence Level: 高**

**Key Strengths:**

1. **完全锚定 ChatOps 棕地基础**：复用 Fastify / PostgreSQL / Porygon / MCP / ApprovalGate / RBAC / TestPipelines，学习曲线低，风险小
2. **分 Agent 协作架构清晰**：Capability + AgentCoordinator 均衡方案，借鉴 Open SWE Planner/Reviewer 成熟模式
3. **可测试、可度量**：每个 NFR 都有明确的实现位置，100% 需求覆盖
4. **命名与模式完备**：12 组一致性规则防止多 AI agent 实现冲突
5. **渐进式部署友好**：MVP Docker Compose 单机，Growth 再扩展 Helm / 对象存储 / 多模型

**Areas for Future Enhancement:**

1. **里程碑 3（Growth）相关组件**：Bug 根因归因归因统计、价值量化仪表盘、多模型抽象 — 架构已预留，实施留到 Growth
2. **AI 摘要自动扫描生成**：FR18 的子流程需要独立设计文档
3. **Review Agent systemPrompt 调优**：需要实际数据验证后持续优化
4. **知识库规模演进**：5000+ 条目后考虑 SQLite 全文检索或向量 DB（已在 PRD 标记）

### Implementation Handoff

**AI Agent Guidelines（实施时必读）：**

- 遵循本文档所有架构决策（Step 4 的 13 项）
- 严格执行所有一致性规则（Step 5 的 12 组）
- 按照目录结构和文件归属原则（Step 6）新建文件
- 遇到任何架构问题先查本文档，再查 PRD，最后咨询人类

**First Implementation Priority（实施起点）：**

**里程碑 0：平台基础设施扩展**（优先级最高）

1. `src/db/schema-v8.sql` — 新增 7 张表
2. `src/db/repositories/` — 新增 7 个 Repository
3. `src/adapters/im/dingtalk.ts` — 扩展图片支持（NormalizedMessage + parseMessage）
4. `src/adapters/gitlab/webhook-receiver.ts` — 扩展 Issue/MR 事件
5. `src/pipeline/executor.ts` — 扩展 stage 类型（capability / wait_webhook）
6. 数据库插入 6 个 capability 记录（analyze_bug / fix_bug_l1/l2/l3 / ai_review_mr / search_knowledge）
7. `src/agent/worktree/manager.ts` — WorktreeManager 实现（Agent 开发的前置依赖）
8. `src/agent/knowledge/repository.ts` — KnowledgeRepository 实现（同上）
9. `src/agent/coordinator.ts` — AgentCoordinator 骨架（先支持最简单的 Agent 调度）

完成里程碑 0 后再进入里程碑 1（分析闭环）→ 里程碑 2（修复闭环）→ 里程碑 3（Growth）。

**Implementation Sequence：**

```
里程碑 0（基础设施）
    ↓
里程碑 1（分析闭环 - MVP 部分 1）
  - analyze_bug capability
  - 知识库查询引擎  - bug_classifier + level_detector + confidence
  - 分析工具集
  - GitLab Issue 创建与 label
    ↓
里程碑 2（修复闭环 - MVP 部分 2）
  - fix_bug_l1/l2/l3 capability
  - retry-handler
  - AI 摘要同步更新
  - ai_review_mr capability
  - L3 方案审批
    ↓
里程碑 3（进化闭环 - Growth）
  - 根因归因
  - 知识库自动沉淀
  - 价值量化仪表盘
  - 多模型抽象
```









### 开发与部署命令（已确立）

```bash
# 后端开发（热重载）
pnpm dev

# 前端开发
cd web && pnpm dev

# 测试
pnpm test

# 数据库迁移
pnpm migrate

# Docker 镜像构建
./build.sh

# Docker 部署
./deploy.sh up
./deploy.sh logs
./deploy.sh restart
```

### Starter 决策结论

**Selected "Starter": ChatOps 平台（既有代码库）**

- **Rationale**: 棕地项目 PRD 明确要求复用 ChatOps 基础设施（NFR-SC1/2/3、FR38 ApprovalGate、FR36 Issue label 状态机、FR46 capability 扩展等）。引入外部 starter 会违反复用约束。
- **风险**：ChatOps 平台本身的技术债务会被继承。缓解：Step 4-6 架构决策中显式处理需扩展/修改的点。
- **业界对标启示**（来自 addendum）：Open SWE 的 Planner/Reviewer 多 Agent 架构与本项目设计对齐；Aider 的 commit 规范可以借鉴到修复 Agent；Qodo 的 RAG 方案可作为知识库查询的优化方向。这些不替代 starter，但在 Step 4-6 做具体实现决策时可参考。


