---
stepsCompleted: [1, 2, 3, 4, 'tea-integration-2026-04-28']
status: 'complete'
completedAt: '2026-04-28'
inputDocuments:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/test-artifacts/test-design/chatops-ai-assistant-handoff.md
workflowType: 'epics-and-stories'
project_name: 'ChatOps 研发 AI 助手'
user_name: 'Hanff'
date: '2026-04-15'
---

# ChatOps 研发 AI 助手 - Epic Breakdown

## Overview

本文档基于 PRD（55 FR + 24 NFR）和 Architecture（13 项核心决策 + 12 组一致性规则）的完整技术设计，将需求分解为**按用户价值交付**组织的 Epic 和 Story，为开发团队提供实现就绪的拆解。

**关联文档：**
- PRD：[prd.md](prd.md)
- Architecture：[architecture.md](architecture.md)

## Story 级通用约束（适用于所有 54 个 Story）

**以下 AC 隐式附加到每个 Story 的验收标准中，不再逐 Story 重复：**

### 测试要求

- **And** 新增/修改的后端代码有对应的单元测试文件（`src/__tests__/unit/<target>.test.ts`）
- **And** `pnpm test` 全部通过（0 失败）
- **And** 新增测试覆盖核心逻辑分支（不强制覆盖率数字，但 happy path + 主要 error path 必须覆盖）
- **And** 端到端验收 Story（1.11 / 3.7 / 4.7 / 5.5）需补充集成测试（`src/__tests__/integration/`）

### 代码规范

- **And** 遵循架构文档 Step 5 定义的 12 组一致性规则（命名 / 路径 / 格式 / 日志前缀 / 错误处理 / 枚举转换）
- **And** 新增 MCP 工具必须同时在 `server.ts` 和 `mcp-server.ts` 中 import
- **And** 新增 capability 必须在数据库有对应记录 + `product_line_capabilities` 配置
- **And** 数据库操作在 Repository 层，业务层不直写 SQL
- **And** 日志带组件前缀 `[Component]`，无静默 catch

### API 设计规范

- **And** Admin API 路由在 `/admin/` 前缀下，文件放 `src/admin/routes/`
- **And** API 响应格式统一：成功 `{ data: ... }`，失败 `{ error: { code: string, message: string } }`
- **And** HTTP 状态码遵循 RESTful 惯例（200 成功 / 201 创建 / 400 参数错误 / 404 不存在 / 500 内部错误）
- **And** 列表接口支持分页（`?page=1&pageSize=20`），返回 `{ data: [...], total: N }`
- **And** 所有查询用参数化 SQL（`$1, $2`），不拼接字符串

### Git 规范

- **And** 修复 Agent 的 commit 遵循 Aider 风格格式（Hypothesis / Changed / Test / Next）
- **And** 人工开发的 commit 使用 `feat/fix/refactor/test/docs` 前缀 + 中文描述
- **And** fix 分支命名 `fix/issue-{N}`，重试 `fix/issue-{N}-attempt-{M}`

### 安全规范

- **And** 所有 Agent 输出（分析报告、commit、钉钉回复）经 SensitiveInfoMasker 过滤
- **And** GitLab Webhook 必须验证 `x-gitlab-token`
- **And** Agent CLI 层 `--allowed-tools` 硬限制不可绕过

## Requirements Inventory

### Functional Requirements

**能力域 1：IM 对话交互（FR1-6）**

- FR1: 研发/测试/运维/售后/交付 可在钉钉群聊中 @机器人 提出问题，获得分析回复或自动流程触发
- FR2: 分析 Agent 可解析钉钉消息中的图片（含 richText 图文混排、引用回复中的图片、纯图片消息），并下载到本地临时目录供分析使用
- FR3: 分析 Agent 可解析钉钉消息中的引用回复（repliedMsg），提取被引用内容（文本 + 图片）作为分析上下文
- FR4: 研发 可在钉钉群发送飞书/钉钉 @机器人 命令（混合策略：自然语言意图识别 + 前缀命令辅助 + 不确定时反问），系统路由到对应能力
- FR5: 系统 可向钉钉发送不同类型的消息（普通 Markdown 回复、DM 审批卡片、@通知、分析进度实时推送）
- FR6: 系统 可在飞书 Webhook 入口接收消息并响应（与钉钉能力对等，但图片支持程度以飞书 SDK 为准）

**能力域 2：代码访问与会话隔离（FR7-11）**

- FR7: 分析/修复 Agent 可按 (用户, 产品, 版本) 维度创建独立的代码 worktree，多个并发分析互不干扰
- FR8: 系统 可在创建代码 worktree 时使用低成本隔离策略（Git worktree，决策见架构文档），不影响主仓库
- FR9: 分析/修复 Agent 可在代码 worktree 中切换到指定版本/分支（通过 switch_version MCP 工具）
- FR10: 系统 可维护 Claude CLI session，支持用户追问时复用上下文（--resume）并按 (senderId, product) 维度隔离
- FR11: 系统 可按统一 TTL 机制自动清理过期 worktree 和 session（2 小时 TTL + 凌晨 3 点兜底扫描）

**能力域 3：知识层（FR12-19）**

- FR12: 系统 可为每个产品线维护独立的 AI 摘要文档（随代码仓库走，每个版本/分支独立），分析 Agent 读取摘要作为上下文
- FR13: 修复 Agent 可在提交代码变更时同步更新对应模块的 AI 摘要，随 fix 分支一起提交（零额外维护成本）
- FR14: 系统 可为每个产品线维护独立的知识库 Git 仓库，包含 guide/、knowledge/、index.json
- FR15: 分析 Agent 可查询知识库 index.json（按关键词、错误码、模块、版本匹配），命中时在秒级返回历史方案
- FR16: 系统 可将知识库条目中的图片引用到对象存储（MVP 本地目录，Growth 对象存储），Markdown 与图片分开存储
- FR17: 系统 可在 Issue 关闭后自动将「问题描述 + 根因 + 修复方案 + diff 链接」沉淀为知识条目，更新 index.json
- FR18: 系统 可在新产品接入时 AI 主动扫描代码生成初始 AI 摘要和知识库结构（不依赖人工冷启动）
- FR19: 研发/内容运营 可通过 Git 提交（或远期管理后台编辑器）向知识库仓库补充业务逻辑说明（guide/），通过 index.json 的 versions 元数据做版本匹配

**能力域 4：Bug 分析与分级（FR20-27）**

- FR20: 分析 Agent 可接收来自钉钉消息、GitLab Issue（webhook）、自动化测试失败、监控告警等多种事件源的问题输入
- FR21: 分析 Agent 可在分析前先区分问题类型（Bug / 配置问题 / 使用问题），只有 Bug 才进入后续修复流程
- FR22: 分析 Agent 可通过读代码、读日志、读配置、查知识库四类动作定位 Bug 根因
- FR23: 分析 Agent 在输出分析报告时标注置信度（高 ≥80% / 中 50-80% / 低 <50%），用于管理用户预期
- FR24: 分析 Agent 在分析根因的同时输出结构化修复方案（可能多选项 + 推荐项），方案作为后续修复 Agent 的输入契约
- FR25: 分析 Agent 可自动判断 Bug 级别（L1 配置类 / L2 简单代码 / L3 业务逻辑 / L4 架构级），决定后续流程路由
- FR26: 系统 可在分析完成后自动创建 GitLab Issue（含产品线标签、模块标签、严重级别、分析报告评论）
- FR27: 系统 可根据分析结果回复钉钉（命中知识库秒回 / 完整分析报告 / 进度实时推送）

**能力域 5：自动修复与 AI Review（FR28-35）**

- FR28: 修复 Agent 可基于分析 Agent 产出的方案文档创建独立 fix 分支（如 fix/issue-123）并在其上进行代码变更
- FR29: 修复 Agent 可调用 MCP 工具进行代码修改、运行单元测试、创建 MR
- FR30: 修复 Agent 在 commit message 中详细记录修复思路和尝试步骤（Aider 风格：Hypothesis / Changed / Test / Next）
- FR31: 修复 Agent 可按 Bug 级别走不同流程（L1：修 → 测试 → MR → 人工合并；L2：同 L1 + 需人工 Review；L3：需方案审批通过后才能触发修复）
- FR32: 系统 可在单元测试失败时让修复 Agent 自动分析失败原因并再次尝试，最多重试 3 次
- FR33: 系统 可在修复重试 3 次仍失败时自动降级（label 改为 needs-manual，Bug 级别升级为 L3，保留 fix 分支现状，@通知研发接手）
- FR34: Review Agent 可在 MR 创建后独立审查 diff（使用不同 systemPrompt、不同权限），从"这个改动有没有问题"视角检查方案一致性、遗漏、质量和安全
- FR35: Review Agent 可在 MR 上打标签（ai-approved / ai-needs-attention）并写评论，辅助人工 Review

**能力域 6：审批与流程编排（FR36-41）**

- FR36: 系统 可使用 GitLab Issue labels 作为状态机驱动流转（needs-analysis → analyzing → graded → fixing / needs-approval / needs-manual → in-review → testing → ready-to-merge → merged → done）
- FR37: 系统 可根据 label 变化触发对应的编排动作（如 approved label → 触发修复 Agent）
- FR38: 系统 可在 L3 Bug 场景下向模块负责人发送钉钉 DM 审批卡片（复用 ChatOps ApprovalGate），展示方案摘要和完整方案链接
- FR39: 系统 可根据模块 → 负责人映射表自动路由审批/通知（如 pas-bastion-host → liaoss）
- FR40: 系统 可在 MR 合并前要求人工 Review（所有级别），Release Notes 自动生成辅助决策
- FR41: 系统 可在 Issue 关闭时自动触发知识库沉淀（FR17）和 Bug 根因归因（FR42）

**能力域 7：Bug 根因归因与知识进化（FR42-44）**

- FR42: 系统 可为每个关闭的 Bug 记录根因类型（纯语法/空指针 / 业务逻辑错误 / 需求理解偏差 / 边界条件遗漏 / 跨模块冲突）
- FR43: 系统 可基于根因归因数据反推知识体系优化点（当某根因类型占比 >20% 时生成补全建议）
- FR44: 系统 可统计"同类根因重复 Bug"占比趋势，作为知识体系进化的核心指标

**能力域 8：权限与多租户（FR45-49）**

- FR45: 系统 可按四级角色（developer / tester / ops / admin）、产品线、环境、capability 四个维度做权限控制
- FR46: 系统 可为研发 AI 助手新增的 capability 配置产线 × 环境 × 角色的访问控制矩阵
- FR47: 系统 可通过 CLI 层 --allowed-tools 硬限制每个 Agent 的工具权限
- FR48: 系统 可在 AI 分析/修复时对密码、密钥、IP 等敏感信息自动脱敏
- FR49: admin 可管理产品线（新增/编辑/停用）、配置产品线对应的 Git 仓库路径、知识库仓库路径、默认分支、AI 摘要路径

**能力域 9：管理与监控（FR50-55）**

- FR50: admin 可通过管理后台一键接入新产品线（配置 Git 地址 → 触发 AI 扫描生成摘要 → 生成模块→负责人建议 → 创建知识库仓库 → 配置 Webhook 指引）
- FR51: admin 可管理"模块 → 负责人"映射表（产品线 × 模块模式 × 钉钉 userId）
- FR52: 研发/测试/运维 可在前端查看每个 Bug 的 12 节点闭环流程进度（复用/扩展 TestRunsPage）
- FR53: 用户 可在前端查看价值量化仪表盘（修复成功率按 L1/L2/L3 分级统计、知识库命中率、平均分析/修复耗时、工时节省估算）— Growth 阶段
- FR54: admin 可导出审计日志（所有分析/修复/审批决策记录）
- FR55: 系统 可记录知识库条目的热度（命中次数、用户评价），辅助条目质量排序

### NonFunctional Requirements

**Performance（P1-P5）：**

- NFR-P1: 知识库命中场景下，从用户 @机器人 到返回历史方案的端到端时延 ≤3 秒（P95）
- NFR-P2: 知识库未命中，完整分析流程端到端时延 ≤5 分钟（P95），基线 4 分钟
- NFR-P3: session 复用场景下（Claude --resume），追问响应时延 ≤10 秒（P95）
- NFR-P4: 单次 L1 Bug 从 fix 分支创建到 MR 创建 ≤10 分钟（不含测试运行时间）
- NFR-P5: 支持 10-30 路并发分析任务，并发间无相互干扰、无共享状态冲突

**Security（S1-S6）：**

- NFR-S1: 分析报告、日志文件、AI 回复中自动过滤密码、密钥、Token、IP 地址、URL 中的敏感参数，脱敏覆盖率 100%
- NFR-S2: 通过 Claude CLI --allowed-tools 参数硬限制 Agent 权限，分析 Agent 不能 Edit/Write/Bash(write)，修复 Agent 不接收外部消息
- NFR-S3: 每个分析任务的代码 worktree 独立，清理时彻底删除；不影响主仓库
- NFR-S4: 所有分析/修复/审批/权限变更决策记录入数据库，保留周期 ≥180 天
- NFR-S5: 所有组件支持完全私有化部署，客户数据不外泄到平台方
- NFR-S6: 分析 Agent 不可通过用户输入修改代码或 Git 状态；修复 Agent 不接收外部消息，仅消费方案文档（结构化输入）

**Scalability（SC1-SC4）：**

- NFR-SC1: 新产品线接入所需时间 ≤1 天
- NFR-SC2: 10 路并发分析的临时目录总占用 ≤100MB（需优化）
- NFR-SC3: 架构支持单客户完全独立部署，客户间无数据共享
- NFR-SC4: 单产品线知识库条目数 ≤5000 时，index.json 匹配时延 <100ms

**Reliability（R1-R5）：**

- NFR-R1: 任务执行中断或节点重启后，pending_approval 状态任务可恢复执行
- NFR-R2: Claude session 失效时，系统自动清空 session 并重建新 session，不阻塞当前请求
- NFR-R3: 修复 Agent 3 次重试失败后 100% 触发自动降级
- NFR-R4: 流水线失败分析属于 best-effort，失败不阻塞主流程
- NFR-R5: 任何分析/修复过程中的异常终止，主 Git 仓库状态不受影响（worktree 隔离保障）

**Observability（O1-O4）：**

- NFR-O1: 核心指标自动采集并入库（分析任务数、修复成功率、知识库命中率、耗时、失败根因分布）
- NFR-O2: 所有审批请求、响应、超时升级事件可在管理后台查询
- NFR-O3: 每个 Bug 的 12 节点闭环流程进度在前端可见，支持按产品线筛选
- NFR-O4: MCP 工具调用日志写入 /tmp/mcp-server.log，流水线执行日志保留 ≥30 天

**Integration（I1-I5）：**

- NFR-I1: 钉钉 Stream 长连接断开后自动重连，消息去重保留最近 200 条
- NFR-I2: GitLab 接口调用遵循令牌桶限流，超限时自动退避重试
- NFR-I3: 底层 AI 模型通过 Porygon backend 层抽象（MVP 仅 Claude，Growth 扩展），替换模型时只改 backend 实现
- NFR-I4: GitLab Webhook 调用必须携带 x-gitlab-token，与 GITLAB_WEBHOOK_SECRET 匹配才被处理
- NFR-I5: MCP Server 启动失败、工具调用无响应等异常有日志记录和 Parent 进程超时回收

### Additional Requirements

**Starter 说明：** 无需初始化命令。ChatOps 平台（既有代码库）即是 starter，clone + `pnpm install` 即可开发。

**架构预置依赖（里程碑 0 - 实施起点）：**

- 数据库 schema-v8 迁移（7 张新表：bug_analysis_reports / module_owners / product_knowledge_repos / root_cause_attributions / knowledge_hit_stats / bug_analysis_stats / metrics_daily）
- 新增 6 个 capability 记录（analyze_bug / fix_bug_l1 / fix_bug_l2 / fix_bug_l3 / ai_review_mr / search_knowledge）
- DingTalkAdapter 扩展图片支持（NormalizedMessage 增加 images 字段）
- GitLabWebhookReceiver 扩展 Issue/MR events 处理
- test_pipelines.stages 扩展 capability / wait_webhook 类型
- WorktreeManager（Agent 开发前置）
- KnowledgeRepository（Agent 开发前置）
- AgentCoordinator 骨架（先支持最简 Agent 调度）

**Agent 间一致性约束（12 组规则）：**

- Capability / MCP 工具 / GitLab Label 的命名规则（snake_case / kebab-case 各自严格约定）
- Bug 级别、分类、置信度、根因类型的枚举转换规则
- Worktree 路径 / fix 分支 / 知识库 / AI 摘要的路径命名规则
- index.json / bug_analysis_reports / AI commit message 的结构化格式规则
- 日志前缀、错误处理与降级、Session 与 Worktree 生命周期、枚举转换的执行规则

**与 PRD 的 2 处偏离（架构决策文档已记录）：**

1. 代码隔离方案：Git worktree（替代 PRD 的 git clone --shared + sparse-checkout）
2. 回收策略：统一 TTL（替代 PRD 的两级回收）

### FR Coverage Map

| FR # | Epic | 说明 |
|------|:----:|------|
| FR1 | 1 | 钉钉 @机器人基础入口 |
| FR2 | 1 | 钉钉图片消息解析 |
| FR3 | 1 | 钉钉引用回复解析 |
| FR4 | 1 | 混合意图识别策略 |
| FR5 | 1 | 多种钉钉消息类型 |
| FR6 | 8 | 飞书入口扩展（Growth） |
| FR7 | 1 | Worktree 按 (user,product,version) 维度 |
| FR8 | 1 | Git worktree 隔离策略 |
| FR9 | 1 | switch_version 工具 |
| FR10 | 1 | Claude --resume session 按 (senderId,product) 隔离 |
| FR11 | 1 | 统一 TTL 回收 + 凌晨 3 点兜底 |
| FR12 | 1 | AI 摘要读取（分析前置） |
| FR13 | 3 | AI 摘要随修复同步更新 |
| FR14 | 2 | 知识库 Git 仓库 |
| FR15 | 2 | index.json 匹配（命中核心） |
| FR16 | 2 | 图片本地存储（MVP） |
| FR17 | 7 | Issue 关闭自动沉淀 |
| FR18 | 6 | AI 主动扫描生成初始摘要 |
| FR19 | 2 | 研发/内容运营通过 Git 提交 guide |
| FR20 | 1 / 8 | 钉钉+Issue 在 Epic 1；其他事件源（Pipeline/告警）在 Epic 8 |
| FR21 | 1 | 问题分类（Bug/Config/Usage） |
| FR22 | 1 | 分析 Agent 四类动作 |
| FR23 | 1 | 置信度标签 |
| FR24 | 1 | 结构化修复方案（Agent handoff 契约） |
| FR25 | 1 | 自动分级（L1-L4） |
| FR26 | 1 | GitLab Issue 自动创建 |
| FR27 | 1 | 钉钉回复（命中秒回 / 完整报告 / 进度推送） |
| FR28 | 3 | fix 分支创建 |
| FR29 | 3 | 修复工具集（fix_code/run_tests/create_mr） |
| FR30 | 3 | Aider 风格 commit message |
| FR31 | 3 / 4 / 5 | L1 在 Epic 3 / L2 在 Epic 4 / L3 在 Epic 5 |
| FR32 | 4 | 3 次自动重试 |
| FR33 | 4 | 失败降级机制 |
| FR34 | 4 | AI Review Agent |
| FR35 | 4 | Review Agent label + 评论 |
| FR36 | 3 | GitLab Issue label 状态机 |
| FR37 | 3 | label 变化触发编排 |
| FR38 | 5 | 钉钉 DM 审批卡片（ApprovalGate） |
| FR39 | 5 | 模块 → 负责人映射路由 |
| FR40 | 4 | MR 合并前人工 Review |
| FR41 | 7 | Issue 关闭触发沉淀 + 归因 |
| FR42 | 7 | 根因类型记录 |
| FR43 | 7 | 归因反推知识体系优化 |
| FR44 | 7 | 同类根因重复率统计 |
| FR45 | 1 | 四维 RBAC（复用 ChatOps） |
| FR46 | 1 | 新 capability × 产线 × 环境 × 角色配置 |
| FR47 | 1 | CLI --allowed-tools 硬限制 |
| FR48 | 4 | 敏感信息脱敏 |
| FR49 | 1 | 产品线管理扩展（Git/知识库/摘要路径配置） |
| FR50 | 6 | 新产品线接入向导 |
| FR51 | 5 / 6 | 后端数据在 Epic 5 / 前端配置页在 Epic 6 |
| FR52 | 6 | Bug 修复实例前端 |
| FR53 | 7 | 价值量化仪表盘（Growth） |
| FR54 | 6 | 审计日志导出 |
| FR55 | 2 | 知识库条目热度统计 |

**覆盖验证：** 55/55 FR 全部映射到 Epic，无遗漏。

## Epic List

### Epic 1: 基础设施与首次可用的 Bug 分析

**Goal:** 研发/测试/运维/售后/交付 可在钉钉 @机器人提出 Bug 问题，AI 返回包含根因、置信度、Bug 级别、结构化修复方案的完整分析报告，并自动创建 GitLab Issue。

**FRs covered:** FR1, FR2, FR3, FR4, FR5, FR7, FR8, FR9, FR10, FR11, FR12, FR20（钉钉+Issue 部分）, FR21, FR22, FR23, FR24, FR25, FR26, FR27, FR45, FR46, FR47, FR49

**M0 质量门禁（PR Gate）：** 现有 30 个单元测试 100% 通过；新 capability 路由单元测试覆盖；`RB-INT-001`（RBAC 拒绝无权限角色）+ `RB-INT-002`（CLI --allowed-tools 硬限制）集成测试全绿

### Epic 2: 知识库历史经验秒回

**Goal:** 交付工程师/售后 在钉钉问问题时，系统秒级（≤3s）命中知识库返回历史方案。研发/内容运营 可通过 Git 提交向知识库补充业务逻辑说明。

**FRs covered:** FR14, FR15, FR16, FR19, FR55

**M1 质量门禁（Nightly Gate，Epic 1+2 全部完成后验证）：** R-001/R-002/R-004/R-006 全部 MITIGATED；`AN-INT-001~006` P0/P1 全绿；脱敏套件 `AN-INT-003` 100%；分析 P95 ≤ 4 分钟

### Epic 3: L1 自动修复闭环

**Goal:** L1 配置类 Bug 从 Issue 创建到 MR 创建全自动，研发一键合并即完成修复。

**FRs covered:** FR13, FR28, FR29, FR30, FR31（L1 部分）, FR36, FR37

### Epic 4: AI Review Agent + L2 自动修复

**Goal:** L2 简单代码 Bug 半自动修复；独立 AI Review Agent 在 MR 创建后审查，标记高风险处；失败时 3 次重试后自动降级。

**FRs covered:** FR31（L2 部分）, FR32, FR33, FR34, FR35, FR40, FR48

### Epic 5: L3 方案审批流程

**Goal:** L3 业务逻辑 Bug 走人工方案审批流程。模块负责人收到钉钉 DM 卡片，审查 AI 方案后 approve，触发后续修复。

**FRs covered:** FR31（L3 部分）, FR38, FR39, FR51（后端数据）

**M2 质量门禁（Nightly Gate，Epic 3+4+5 全部完成后验证）：** R-003/R-005/R-007 全部 MITIGATED；`FX-INT-001~008` P0/P1 全绿；10 并发修复 Agent 内存增量 ≤ 100MB

### Epic 6: 管理后台与新产品线接入

**Goal:** 管理员一天内接入新产品线。前端可视化 Bug 12 节点闭环流程。审计日志可导出。

**FRs covered:** FR18, FR50, FR51（前端配置页）, FR52, FR54

### Epic 7: Bug 根因归因与知识进化（Growth）

**Goal:** 每个 Bug 关闭后自动归因根因类型，驱动知识库自动沉淀。运营可查看根因分布趋势和价值量化仪表盘。

**FRs covered:** FR17, FR41, FR42, FR43, FR44, FR53

### Epic 8: 多入口扩展与模型可插拔（Growth）

**Goal:** 飞书用户也能使用；自动化测试失败/监控告警自动触发分析；底层模型可替换为国产/私有化模型（推客户前置）。

**FRs covered:** FR6, FR20（自动化测试/告警部分）

---

## Epic 1: 基础设施与首次可用的 Bug 分析

**Goal:** 研发/测试/运维/售后/交付 可在钉钉 @机器人提出 Bug 问题，AI 返回包含根因、置信度、Bug 级别、结构化修复方案的完整分析报告，并自动创建 GitLab Issue。

### Story 1.1: Schema v8 迁移与 Capability 注册

As a 系统管理员,
I want 通过数据库迁移创建 AI 助手所需的 7 张新表并注册 6 个新 capability,
So that 后续 Agent 开发和管理功能有数据层和路由层支撑.

**Acceptance Criteria:**

**Given** pnpm migrate 执行
**When** schema-v8.sql 运行
**Then** 创建 bug_analysis_reports / module_owners / product_knowledge_repos / root_cause_attributions / knowledge_hit_stats / bug_analysis_stats / metrics_daily 7 张表
**And** capabilities 表插入 analyze_bug / fix_bug_l1 / fix_bug_l2 / fix_bug_l3 / ai_review_mr / search_knowledge 6 条记录
**And** 迁移幂等（重复执行不报错）
**And** 7 个对应 Repository 文件创建完毕，含 mapRow 转换

### Story 1.2: 扩展 test_pipelines Stage 类型

As a 开发者,
I want test_pipelines 支持 capability 和 wait_webhook 两种新 stage 类型,
So that Bug 修复流程可以用流水线引擎编排.

**Acceptance Criteria:**

**Given** 流水线配置含 capability 类型的 stage
**When** executor 执行到该 stage
**Then** 调用指定 capability 而非 SSH 脚本
**And** 现有 script/approval 类型行为不变
**Given** wait_webhook 类型 stage
**When** executor 执行到该 stage
**Then** 暂停执行，等待外部 Webhook 恢复

### Story 1.3: DingTalkAdapter 图片消息扩展

As a 研发,
I want 钉钉机器人解析图片消息（richText、引用回复、纯图片）,
So that 分析 Agent 能看到错误截图.

**Acceptance Criteria:**

**Given** 用户发送 richText 图文混排消息
**When** handleRobotMessage 接收
**Then** NormalizedMessage.images 包含所有图片的本地文件路径
**Given** 用户 @机器人 回复含图片的消息
**When** handleRobotMessage 接收
**Then** 从 repliedMsg 中提取文本和图片
**And** 消息去重保留最近 200 条（复用现有机制）

### Story 1.4: GitLabWebhookReceiver Issue/MR 事件扩展

As a 系统,
I want GitLab Webhook 接收 Issue 和 MR 事件（创建、label 变化）,
So that Agent 可由 GitLab 事件驱动.

**Acceptance Criteria:**

**Given** GitLab Issue 创建事件 POST 到 /webhook/gitlab
**When** webhook-receiver 处理
**Then** 通过 x-gitlab-token 验证后派发到 issue-handler
**Given** Issue label 变化事件
**When** issue-handler 接收
**Then** 按 label 类型路由（needs-analysis → 触发分析、approved → 触发修复）
**And** MR 创建事件派发到 mr-handler
**And** 日志前缀 [GitLab]
**And** [TEA-HO-INT-003] 同一 Issue 的并发 Webhook 幂等处理：重复 label 变化事件只触发一次 Agent（advisory lock + 幂等键）

### Story 1.5: WorktreeManager 代码沙箱

As a 分析/修复 Agent,
I want 通过 WorktreeManager 管理 Git worktree 生命周期,
So that 多并发分析互不干扰.

**Acceptance Criteria:**

**Given** 调用 acquire({ userId, product, version, sessionId })
**When** 执行
**Then** 创建 /tmp/analysis/{userId}-{product}-{version}-{sessionId} 目录
**And** 执行 git worktree add --detach 到指定版本（detach 模式避免同一分支被多个 worktree 锁定）
**And** 返回 Worktree 对象含 path
**Given** 调用 release(worktree)
**When** 执行
**Then** 标记为可回收，不立即删除
**Given** 凌晨 3 点定时任务
**When** cleanup-scheduler 触发
**Then** 清理所有超过 2 小时 TTL 的 worktree + 对应 session
**And** [TEA-FX-INT-003] 每个 worktree 路径含唯一标识（`/tmp/<uuid>/`），并发任务目录互相独立、无文件系统共享
**And** [TEA-FX-UNIT-001] `(bugId, agentType)` 唯一键约束：同一 Bug 同类型 Agent 的第二次 acquire 必须等待锁而非直接创建新目录

### Story 1.6: KnowledgeRepository 基础（Git 仓库读取）

As a 分析 Agent,
I want 读取产品线的知识库 Git 仓库文件,
So that 后续命中匹配可以使用.

**Acceptance Criteria:**

**Given** 产品线配置中有 knowledge_repo_url
**When** ensureLocalCache({ productLineId }) 调用
**Then** clone 到 /var/cache/chatops-knowledge/{product}/（已有则 pull）
**Given** readFile({ productLineId, path }) 调用且路径合法
**When** 执行
**Then** 返回文件内容
**And** 路径越界（..、绝对路径）时抛出异常

### Story 1.7: AgentCoordinator 骨架

As a 系统,
I want AgentCoordinator 订阅事件并触发 capability,
So that Agent 由事件驱动而非硬编码调用.

**Acceptance Criteria:**

**Given** triggerCapability({ capabilityKey, context }) 调用
**When** 执行
**Then** 查 capabilities 表获取 systemPrompt 和 tool_names
**And** 通过 ClaudeRunner 启动 MCP 子进程
**And** 日志前缀 [AgentCoordinator]
**And** 异常有 ERROR 级日志且不静默
**And** [TEA-HO-INT-001] 分析 Agent 完成 → label 变化 → 修复 Agent 触发的成功路径集成测试全覆盖（`@p0 @integration @agent-handoff`）
**And** [TEA-HO-INT-002] 分析/修复 Agent 状态超过阈值（20 分钟）时，孤儿扫描定时任务检测并 DM 告警 Bug owner（`@p0 @integration @agent-handoff`）
**And** [TEA-RB-INT-001] 无 `analyze_bug` 权限的角色调用 triggerCapability 时返回 403，操作被拒（`@p0 @integration @security`）
**And** [TEA-RB-INT-002] ClaudeRunner 启动 Agent 时 `--allowed-tools` 仅包含 MCP 工具集，尝试调用 Bash/Read/Write 被硬限制拦截（`@p0 @integration @security`）

### Story 1.8: 分析工具集 — read_code / download_image

As a 分析 Agent,
I want read_code 和 download_image MCP 工具,
So that 我能读代码和下载截图.

**Acceptance Criteria:**

**Given** Claude 调用 read_code({ path })
**When** path 在 worktree 内
**Then** 返回文件内容
**And** path 越界时返回错误
**Given** Claude 调用 download_image({ downloadCode })
**When** 执行
**Then** 通过钉钉 API 下载图片到本地临时文件
**And** 返回本地路径
**And** server.ts 和 mcp-server.ts 均 import 这两个工具

### Story 1.9: 分析工具集 — switch_version / create_issue

As a 分析 Agent,
I want switch_version 和 create_issue MCP 工具,
So that 我能切版本和创建 GitLab Issue.

**Acceptance Criteria:**

**Given** Claude 调用 switch_version({ productLineId, branch })
**When** worktree 存在
**Then** 执行 git checkout 并返回结果
**Given** Claude 调用 create_issue({ productLineId, title, body, labels })
**When** 执行
**Then** 通过 GitLab API 创建 Issue（经 rate-limiter）
**And** 返回 Issue 编号和 URL
**And** 默认 label 含 needs-analysis

### Story 1.10: analyze_bug Capability 完整逻辑

As a 研发,
I want analyze_bug 实现完整的分析流程（分类 → 分级 → 置信度 → 方案），
So that 分析报告满足 FR21-25.

**Acceptance Criteria:**

**Given** 钉钉消息或 GitLab Issue 触发 analyze_bug
**When** Agent 执行
**Then** 按 systematic-debugging Phase 1-4 流程分析
**And** 输出 JSON 格式分析报告（含 level / confidence / classification / solutions）写入 bug_analysis_reports 表
**And** Markdown 摘要追加到 GitLab Issue 评论
**And** Issue label 从 needs-analysis → analyzing → graded
**And** 附加 level-l1/l2/l3/l4 和 confidence-high/medium/low label
**And** classification 为 config_issue / usage_issue 时不创建 Issue，直接回复钉钉
**And** [TEA-AN-UNIT-001] Bug 自动分级单元测试覆盖 L1/L2/L3/L4 全部边界条件，含边界值与模糊分级情况（`@p0 @unit @bug-grading`）

### Story 1.11: 端到端首次可用分析验收

As a 研发,
I want @机器人 描述 Bug 后获得完整分析报告 + GitLab Issue,
So that 验证 MVP 分析闭环可用.

**Acceptance Criteria:**

**Given** 钉钉 @机器人 发送"TASK_PWD_4001 密码验证失败" + 截图
**When** 消息进入系统
**Then** 钉钉回复包含分析报告摘要 + Issue 链接
**And** GitLab Issue 含完整分析评论 + 正确的 label
**And** bug_analysis_reports 表有对应记录
**And** 端到端 P95 ≤ 5 分钟
**And** 10 路并发无相互干扰
**And** worktree 在分析完成后标记为可回收

---

## Epic 2: 知识库历史经验秒回

**Goal:** 交付工程师/售后 在钉钉问问题时，系统秒级（≤3s）命中知识库返回历史方案。研发可通过 Git 提交补充知识。

### Story 2.1: index.json 匹配引擎

As a 分析 Agent,
I want 知识库 index.json 的关键词/错误码/模块/版本匹配引擎,
So that 我能秒级命中历史方案.

**Acceptance Criteria:**

**Given** index.json 含多条 entry
**When** IndexMatcher.search({ keywords, errorCodes, modules, version }) 调用
**Then** 返回按匹配度排序的结果（关键词 OR + 模块 AND + 版本范围匹配）
**And** 匹配时延 < 100ms（NFR-SC4）
**And** 版本匹配支持 semver 范围语法（>=6.0, >=6.5,<7.0, *）

### Story 2.2: search_knowledge MCP 工具

As a 分析 Agent,
I want search_knowledge MCP 工具,
So that 分析前先查知识库.

**Acceptance Criteria:**

**Given** Claude 调用 search_knowledge({ query, product, version })
**When** 执行
**Then** 从 query 提取关键词/错误码，调用 IndexMatcher
**And** 命中时返回完整 Markdown 内容 + 历史 Issue/MR 链接
**And** 未命中时返回 "no_match"
**And** 命中时写入 knowledge_hit_stats 表（hit_count +1）

### Story 2.3: 知识库图片本地存储

As a 系统,
I want 知识库图片存储到本地目录（/opt/knowledge/images/）,
So that Markdown 可通过相对路径引用图片.

**Acceptance Criteria:**

**Given** KnowledgeImageStorage.save({ productLineId, imageBuffer, filename }) 调用
**When** 执行
**Then** 文件保存到 /opt/knowledge/images/{product}/{filename}
**And** 返回相对路径供 Markdown 引用
**And** 接口抽象为 KnowledgeImageStorage interface（Growth 阶段可切换为 MinIO/OSS）

### Story 2.4: 知识库热度统计

As a 运营,
I want 每次命中自动更新热度统计,
So that 能排序知识库条目价值.

**Acceptance Criteria:**

**Given** search_knowledge 命中某条目
**When** 写入 knowledge_hit_stats
**Then** hit_count 递增，last_hit_at 更新
**And** Admin API /admin/knowledge-stats 可查询按命中次数排序的条目列表

### Story 2.5: 命中查询前置到分析流程

As a 研发/售后,
I want 分析前先查知识库，命中时秒级返回,
So that 常见问题不用等 4 分钟完整分析.

**Acceptance Criteria:**

**Given** 用户 @机器人 描述问题
**When** analyze_bug 启动前
**Then** 先调用 search_knowledge
**And** 命中时直接回复钉钉（≤ 3 秒 P95，NFR-P1）
**And** 未命中时继续完整分析流程
**And** 回复中标注"命中历史知识库"或"启动完整分析"

### Story 2.6: 知识库人工编辑支持（Git 提交）

As a 研发/内容运营,
I want 通过 Git 提交向知识库 guide/ 目录补充业务逻辑说明,
So that 人工知识能进入 AI 上下文.

**Acceptance Criteria:**

**Given** 用户向 pam-knowledge.git 提交新 guide/password-rotation.md
**When** KnowledgeRepository 下次 pull 更新
**Then** index.json 可手动编辑增加条目（MVP 不自动检测新文件）
**And** Agent 分析时按 versions 元数据匹配对应 guide 文件

---

## Epic 3: L1 自动修复闭环

**Goal:** L1 配置类 Bug 从 Issue 创建到 MR 创建全自动，研发一键合并即完成修复。

### Story 3.1: 修复工具集 — fix_code / run_tests / create_mr

As a 修复 Agent,
I want fix_code / run_tests / create_mr 三个 MCP 工具,
So that 我能修改代码、跑测试、创建 MR.

**Acceptance Criteria:**

**Given** Claude 调用 fix_code({ path, content })
**When** path 在 worktree 内
**Then** 写入文件内容
**Given** Claude 调用 run_tests({ command })
**When** 执行
**Then** 在 worktree 内运行指定测试命令并返回 stdout/stderr + exit code
**Given** Claude 调用 create_mr({ title, description, sourceBranch, targetBranch, labels })
**When** 执行
**Then** 通过 GitLab API 创建 MR（经 rate-limiter）
**And** 返回 MR 编号和 URL
**And** 三个工具均在 server.ts 和 mcp-server.ts import

### Story 3.2: update_ai_summary 工具

As a 修复 Agent,
I want update_ai_summary MCP 工具,
So that 修复代码时同步更新模块 AI 摘要.

**Acceptance Criteria:**

**Given** Claude 调用 update_ai_summary({ module, changes_description })
**When** 执行
**Then** 读取 docs/ai/{module}.md，追加变更说明
**And** 文件写入 worktree（后续随 fix 分支一起提交）
**And** 如果摘要文件不存在，创建基础模板

### Story 3.3: Fix 分支管理

As a 修复 Agent,
I want 自动创建独立 fix 分支,
So that 修复不污染主分支.

**Acceptance Criteria:**

**Given** 修复 Agent 启动
**When** branch-manager.createFixBranch({ issueId }) 调用
**Then** 创建 fix/issue-{issueId} 分支
**And** 重试时创建 fix/issue-{issueId}-attempt-{N}
**And** 分支从目标版本 checkout 而来

### Story 3.4: Aider 风格 Commit Message Builder

As a 修复 Agent,
I want 每次 commit 遵循 Aider 风格格式,
So that 人工接手时能快速理解 AI 的思路.

**Acceptance Criteria:**

**Given** 修复 Agent 提交代码
**When** commit-builder.build({ level, issueTitle, attempt, hypothesis, changed, testResult, next }) 调用
**Then** commit message 格式为：
```
fix(l1): {issueTitle} - attempt {N}/3

Hypothesis: {hypothesis}
Changed: {changed}
Test: {testResult}
Next: {next}

Issue: #{issueId}
Confidence: {confidence}
```

### Story 3.5: fix_bug_l1 Capability

As a 系统,
I want fix_bug_l1 capability 实现 L1 完整修复逻辑,
So that 配置类 Bug 全自动修复.

**Acceptance Criteria:**

**Given** AgentCoordinator 触发 fix_bug_l1（含 reportId）
**When** Agent 执行
**Then** 从 bug_analysis_reports 读取方案
**And** 创建 fix 分支 → 修复代码 → 更新 AI 摘要 → 跑测试 → 创建 MR
**And** MR label 含 ai-generated + level-l1
**And** Issue label 从 fixing → in-review
**And** 钉钉 @模块负责人通知 MR 待 Review
**And** [TEA-FX-INT-001] L1 全自动路径集成测试：Issue → Worktree → Patch → CI 绿 → MR 创建，全程无人工干预（`@p0 @integration`）
**And** [TEA-FX-INT-002] MR 创建前必须校验 GitLab Pipeline 状态为 `success`，CI 未绿时不创建 MR（`@p0 @integration`）

### Story 3.6: GitLab Label 状态机驱动

As a 系统,
I want Issue label 变化自动触发 Agent,
So that 流程由事件驱动.

**Acceptance Criteria:**

**Given** Issue label 变为 graded 且 level-l1
**When** issue-handler 接收
**Then** label 自动加 fixing
**And** AgentCoordinator 触发 fix_bug_l1
**Given** Issue label 变为 in-review
**When** MR 存在
**Then** 触发 ai_review_mr（Epic 4）
**And** [TEA-HO-UNIT-001] GitLab label 状态机 12 节点全路径转移单元测试覆盖，含非法转移拒绝和并发场景（`@p0 @unit @agent-handoff`）

### Story 3.7: L1 端到端验收

As a 研发,
I want L1 Bug 从分析到 MR 全自动完成,
So that 我只需一键合并.

**Acceptance Criteria:**

**Given** 钉钉反馈 L1 Bug（如初始化 SQL 缺失）
**When** 系统完整处理
**Then** 分析报告 + Issue + fix 分支 + 代码变更 + AI 摘要更新 + 测试通过 + MR 全部自动完成
**And** 钉钉通知研发"MR 已创建，请 Review"
**And** MR diff 仅含必要变更
**And** 研发点击 Approve & Merge 即完成

---

## Epic 4: AI Review Agent + L2 自动修复

**Goal:** L2 简单代码 Bug 半自动修复；独立 AI Review Agent 审查 MR；失败时 3 次重试后自动降级。

### Story 4.1: 敏感信息脱敏层

As a 系统,
I want 分析报告和 AI 回复自动脱敏,
So that 密码/密钥/IP 不泄露.

**Acceptance Criteria:**

**Given** 文本经过 SensitiveInfoMasker.mask(text)
**When** 文本含密码/密钥/Token/IP/URL 敏感参数
**Then** 替换为 [MASKED_PASSWORD] / [MASKED_KEY] / [MASKED_IP] 等
**And** 脱敏后文本保持可读性
**And** 所有 Agent 输出（分析报告、commit、钉钉回复）均经此过滤
**And** [TEA-AN-INT-003] 脱敏函数参数化单元测试套件覆盖手机号/邮箱/内网 IP/Token 四类，零漏检（`@p0 @unit @security`）；脱敏为纯函数，可直接导入测试

### Story 4.2: Retry Handler（3 次自动重试）

As a 修复 Agent,
I want 测试失败时自动重试（最多 3 次）,
So that 临时性失败不浪费人工.

**Acceptance Criteria:**

**Given** 修复 Agent 提交后 run_tests 失败
**When** retry-handler 接管
**Then** 分析测试失败原因 → 调整代码 → 再次提交 → 再跑测试
**And** 每次尝试使用新 commit（Aider 格式记录 attempt N/3）
**And** 最多重试 3 次

### Story 4.3: 自动降级逻辑

As a 系统,
I want 3 次修复失败后自动降级为 L3,
So that 不会无限重试.

**Acceptance Criteria:**

**Given** retry-handler 3 次全部失败
**When** 降级触发
**Then** Issue label 从 fixing → needs-manual
**And** Bug 级别从 l1/l2 升级为 l3
**And** fix 分支保留（不删不 revert）
**And** 钉钉 @模块负责人通知"自动修复失败，请接手 fix 分支"
**And** 降级 100% 触发（NFR-R3）

### Story 4.4: fix_bug_l2 Capability

As a 系统,
I want fix_bug_l2 实现 L2 修复逻辑（含重试/降级）,
So that 简单代码 Bug 也能自动修复.

**Acceptance Criteria:**

**Given** AgentCoordinator 触发 fix_bug_l2
**When** Agent 执行
**Then** 复用 L1 修复框架（fix 分支 + 工具 + commit）
**And** 增加 retry-handler 3 次重试
**And** 失败触发降级
**And** 成功则创建 MR（label: ai-generated + level-l2）

### Story 4.5: review_mr_diff MCP 工具

As a Review Agent,
I want review_mr_diff 工具读取 MR diff,
So that 我能审查代码变更.

**Acceptance Criteria:**

**Given** Claude 调用 review_mr_diff({ mrId })
**When** 执行
**Then** 通过 GitLab API 获取 MR diff 内容
**And** 返回变更文件列表 + 各文件 diff
**And** 不含主仓库无关文件

### Story 4.6: ai_review_mr Capability（独立进程）

As a 系统,
I want ai_review_mr 以独立 Claude CLI 子进程运行,
So that 审查视角与修复 Agent 隔离.

**Acceptance Criteria:**

**Given** MR 创建后 AgentCoordinator 触发 ai_review_mr
**When** Agent 执行
**Then** 使用独立 systemPrompt（"审查者"视角）
**And** 仅有 review_mr_diff 工具（只读）
**And** 输出审查评论（方案一致性、遗漏、安全）
**And** MR 加 label ai-approved 或 ai-needs-attention
**And** 评论中标注高风险行

### Story 4.7: L2 端到端验收（含 Review）

As a 研发,
I want L2 Bug 自动修复 + AI Review 后合并,
So that 验证 L2 + Review 闭环.

**Acceptance Criteria:**

**Given** L2 Bug 触发修复
**When** 修复成功
**Then** MR 创建 → AI Review 自动启动 → 标记 ai-approved/ai-needs-attention
**And** 钉钉通知研发"MR + AI Review 完成，请合并"
**Given** 修复 3 次失败
**When** 降级触发
**Then** fix 分支保留 + 通知研发接手

---

## Epic 5: L3 方案审批流程

**Goal:** L3 业务逻辑 Bug 走人工方案审批。模块负责人钉钉收到审批卡片，approve 后触发修复。

### Story 5.1: module_owners 数据层

As a admin,
I want 管理模块→负责人映射,
So that L3 审批能自动路由到正确的人.

**Acceptance Criteria:**

**Given** module_owners 表已创建（Story 1.1）
**When** 调用 ModuleOwnerRepository.findOwner({ productLineId, module })
**Then** 按 module_pattern 模糊匹配返回 owner_user_id
**And** 无匹配时返回 null（fallback 到产品线管理员）

### Story 5.2: 模块路径→负责人匹配逻辑

As a 系统,
I want 从分析报告的 affected_modules 自动找到负责人,
So that 审批通知精准.

**Acceptance Criteria:**

**Given** 分析报告含 affected_modules: ["pas-bastion-host"]
**When** 匹配逻辑执行
**Then** 查 module_owners 表匹配到 liaoss
**And** 返回钉钉 userId 供审批卡片使用

### Story 5.3: fix_bug_l3 Capability

As a 系统,
I want fix_bug_l3 在方案 approved 后触发修复,
So that L3 Bug 也有 AI 辅助修复.

**Acceptance Criteria:**

**Given** Issue label 从 needs-approval → approved
**When** Webhook 触发
**Then** AgentCoordinator 触发 fix_bug_l3
**And** 读取 bug_analysis_reports 获取审批通过的方案
**And** 按方案执行修复（复用 L2 修复框架含重试/降级）

### Story 5.4: L3 钉钉 DM 审批卡片

As a 模块负责人,
I want 收到钉钉 DM 审批卡片查看方案,
So that 我能快速决策.

**Acceptance Criteria:**

**Given** 分析报告分级为 L3
**When** AgentCoordinator 处理
**Then** Issue label 设为 needs-approval
**And** 通过 ApprovalGate 向模块负责人发送钉钉 DM 卡片
**And** 卡片含方案摘要 + "查看完整方案"链接（指向 GitLab Issue）
**And** 卡片按钮："Approve" / "Reject"

### Story 5.5: L3 端到端验收

As a 模块负责人,
I want L3 Bug 从分析→审批→修复→Review 完整闭环,
So that 复杂 Bug 有 AI 辅助.

**Acceptance Criteria:**

**Given** L3 Bug 触发分析
**When** 完整流程执行
**Then** 分析报告 → 钉钉 DM 审批 → 负责人 approve → 修复 Agent 启动 → MR + AI Review → 通知合并
**And** 负责人 reject 时 Issue label 设为 needs-manual

---

## Epic 6: 管理后台与新产品线接入

**Goal:** 管理员一天内接入新产品线。Bug 修复实例可视化。审计日志可导出。

### Story 6.1: product_knowledge_repos 管理 API

As a admin,
I want 通过管理后台配置产品线的 Git 仓库/知识库/AI 摘要路径,
So that 新产品线接入有数据支撑.

**Acceptance Criteria:**

**Given** POST /admin/product-knowledge { productLineId, codeRepoUrl, knowledgeRepoUrl, aiSummaryPath }
**When** 执行
**Then** 写入 product_knowledge_repos 表
**And** GET /admin/product-knowledge 返回所有配置
**And** PUT 支持更新

### Story 6.2: AI 摘要主动扫描生成

As a admin,
I want 接入新产品线时 AI 自动扫描代码生成初始 AI 摘要,
So that 不需要人工从零编写.

**Acceptance Criteria:**

**Given** 新产品线接入且 code_repo_url 已配置
**When** 触发 AI 摘要初始化
**Then** clone 代码仓库 → 按模块目录结构生成 docs/ai/{module}.md
**And** 输出结果包含模块列表和每个摘要的摘要（供人工 Review）
**And** 生成 module_owners 建议（基于 CODEOWNERS 或 git blame 频率）

### Story 6.3: 新产品线接入向导 API

As a admin,
I want 一键接入新产品线的后端 API,
So that 前端可调用.

**Acceptance Criteria:**

**Given** POST /admin/product-knowledge/onboard { productLineId }
**When** 执行
**Then** 依次：clone 代码 → AI 扫描生成摘要 → 生成负责人建议 → 创建知识库仓库 → 返回 Webhook 配置指引
**And** 异步执行（长时任务），返回 taskId 供轮询
**And** 接入全程 ≤ 1 天（NFR-SC1）

### Story 6.4: 新产品线接入向导前端页面

As a admin,
I want 管理后台有产品线接入向导页面,
So that 接入流程可视化.

**Acceptance Criteria:**

**Given** admin 进入 ProductKnowledgePage
**When** 填写 Git 地址、默认分支、点击"开始接入"
**Then** 展示接入进度（clone / 扫描 / 摘要生成 / 知识库创建 / Webhook 指引）
**And** 完成后展示 Webhook 配置步骤说明（可复制 URL + token）

### Story 6.5: 模块负责人配置前端页面

As a admin,
I want 管理后台配置模块→负责人映射,
So that L3 审批路由准确.

**Acceptance Criteria:**

**Given** admin 进入 ModuleOwnersPage
**When** 添加 { productLineId, modulePattern: "pas-bastion-host", ownerUserId }
**Then** 写入 module_owners 表
**And** 支持 CRUD + 钉钉用户选择器（从 dingtalk_users 同步）

### Story 6.6: Bug 修复实例前端页面

As a 研发/测试/运维,
I want 查看每个 Bug 的 12 节点闭环流程进度,
So that 知道每个 Bug 处在什么阶段.

**Acceptance Criteria:**

**Given** 进入 BugRunsPage
**When** 选择产品线筛选
**Then** 列表展示所有 Bug（Issue 编号、标题、当前 label 状态、级别、置信度）
**And** 点击详情进入 12 节点进度图（needs-analysis → ... → done）
**And** 每个节点显示时间戳和关联操作（分析报告链接 / MR 链接 / Review 结论）
**And** [TEA-UI-E2E] 以下元素必须加 `data-testid` 属性以支持 E2E 自动化：
  - Bug 列表行：`data-testid="bug-instance-row"`
  - 状态标签：`data-testid="bug-status-badge"`
  - AI 置信度标签：`data-testid="bug-confidence-badge"`
  - 详情页分析报告区域：`data-testid="analysis-report"`
  - 详情页 MR 链接：`data-testid="mr-link"`
  - 详情页触发修复按钮：`data-testid="trigger-fix-btn"`

### Story 6.7: 审计日志导出

As a admin,
I want 导出审计日志,
So that 合规审查有据可查.

**Acceptance Criteria:**

**Given** GET /admin/audit-log?productLineId=X&from=2026-01-01&to=2026-04-15
**When** 执行
**Then** 返回所有分析/修复/审批/权限变更记录
**And** 支持 JSON 导出
**And** 数据保留 ≥ 180 天（NFR-S4）

---

## Epic 7: Bug 根因归因与知识进化（Growth）

**Goal:** Bug 关闭后自动归因 + 知识沉淀。运营可查看根因分布和价值仪表盘。

### Story 7.1: 根因归因逻辑

As a 系统,
I want 每个 Bug 关闭时记录根因类型,
So that 能追溯问题源头.

**Acceptance Criteria:**

**Given** Issue 关闭（label → done）
**When** 归因逻辑触发
**Then** 从 bug_analysis_reports 读取分析数据
**And** AI 判断根因类型（syntax / business_logic / requirement / boundary / cross_module）
**And** 写入 root_cause_attributions 表

### Story 7.2: Issue 关闭触发知识库沉淀

As a 系统,
I want Issue 关闭后自动生成知识条目,
So that 知识库自动增长.

**Acceptance Criteria:**

**Given** Issue 关闭且 classification = bug
**When** 沉淀逻辑触发
**Then** 从 bug_analysis_reports + MR diff 构建 Markdown 条目
**And** 写入 knowledge/{module}/{error-code-or-topic}.md
**And** 更新 index.json 添加新条目
**And** Git commit 到知识库仓库

### Story 7.3: 同类根因重复率统计

As a 运营,
I want 查看同类根因重复率趋势,
So that 发现系统性问题.

**Acceptance Criteria:**

**Given** GET /admin/metrics/root-cause-trends?months=3
**When** 执行
**Then** 返回按根因类型分组的月度统计
**And** 标注占比 >20% 的根因类型为"高频"

### Story 7.4: 根因反推知识体系优化建议

As a 运营,
I want 当某根因类型占比 >20% 时系统生成优化建议,
So that 驱动知识体系进化.

**Acceptance Criteria:**

**Given** business_logic 类根因占比超过 20%
**When** 统计触发
**Then** 生成建议"AI 摘要中补充对应模块的业务规则约束"
**And** 在管理后台展示建议列表

### Story 7.5: metrics_daily 定时聚合任务

As a 系统,
I want 每日凌晨聚合前一天的指标数据,
So that 仪表盘可查询.

**Acceptance Criteria:**

**Given** 凌晨 1 点 node-cron 触发
**When** 聚合逻辑执行
**Then** 统计前一天的：分析任务数、按级别分布、修复成功率、知识库命中率、平均耗时
**And** 写入 metrics_daily 表
**And** 按 product_line_id 分别统计

### Story 7.6: 价值量化仪表盘前端

As a 运营,
I want 查看价值量化仪表盘,
So that AI 自证价值.

**Acceptance Criteria:**

**Given** 进入 MetricsPage
**When** 选择产品线和时间范围
**Then** 展示折线图：分析任务数趋势、修复成功率（按 L1/L2/L3 分级）、知识库命中率、平均耗时
**And** 展示汇总数据：总节省工时估算、自动修复 Bug 数、命中率
**And** [TEA-UI-E2E] 修复率指标区域加 `data-testid="fix-rate-metric"` 以支持 E2E 自动化

---

## Epic 8: 多入口扩展与模型可插拔（Growth）

**Goal:** 飞书用户也能使用；自动化测试/监控告警自动触发分析；模型可替换。

### Story 8.1: 飞书 Webhook 图片消息支持

As a 飞书用户,
I want 飞书入口也能识别和处理图片消息,
So that 飞书团队也能用 AI 助手.

**Acceptance Criteria:**

**Given** 飞书 Webhook 收到含图片的消息
**When** FeishuAdapter 处理
**Then** NormalizedMessage.images 包含图片路径
**And** 后续流程与钉钉入口一致

### Story 8.2: GitLab Pipeline 失败触发分析

As a 测试,
I want Pipeline 失败时自动触发 Bug 分析,
So that 不需要手动 @机器人.

**Acceptance Criteria:**

**Given** GitLab Pipeline 事件 status=failed
**When** webhook-receiver 接收
**Then** 提取失败 stage 日志 → 触发 analyze_bug
**And** 分析报告关联 Pipeline ID
**And** 钉钉通知相关研发

### Story 8.3: Prometheus/Grafana 监控告警接入

As a 运维,
I want 监控告警自动触发分析,
So that 告警处理自动化.

**Acceptance Criteria:**

**Given** Prometheus Alertmanager Webhook 发送告警到 /webhook/alert
**When** 接收
**Then** 提取告警指标 + 时间范围 → 触发 analyze_bug（含 SSH 查日志能力）
**And** 分析报告标注"告警触发"

### Story 8.4: Porygon Backend 抽象层

As a 系统,
I want Porygon backend 层可替换底层模型,
So that 推客户时能切国产模型.

**Acceptance Criteria:**

**Given** 配置 AI_BACKEND=claude 或 AI_BACKEND=custom
**When** ClaudeRunner 启动
**Then** 根据配置选择对应 backend 实现
**And** Claude backend 为默认，行为与现有一致
**And** 业务逻辑不依赖具体模型 API

### Story 8.5: 国产模型 Backend 样例实现

As a 系统,
I want 一个国产模型 backend 的样例实现,
So that 推客户时能快速适配.

**Acceptance Criteria:**

**Given** AI_BACKEND=example-cn
**When** ClaudeRunner 启动
**Then** 使用样例 backend（调用通用 OpenAI-compatible API 格式）
**And** 文档说明如何适配新模型
**And** 测试用例覆盖 backend 切换


