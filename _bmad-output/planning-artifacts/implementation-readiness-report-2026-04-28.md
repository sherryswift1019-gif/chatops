---
stepsCompleted: ["step-01-document-discovery", "step-02-prd-analysis", "step-03-epic-coverage-validation"]
filesIncluded:
  - _bmad-output/planning-artifacts/prd.md
  - _bmad-output/planning-artifacts/architecture.md
  - _bmad-output/planning-artifacts/epics.md
  - _bmad-output/planning-artifacts/prd-validation-report.md
---

# Implementation Readiness Assessment Report

**Date:** 2026-04-28
**Project:** chatops

---

## PRD Analysis

### Functional Requirements

**1. IM 对话交互（FR1–FR6）**

- FR1：研发/测试/运维/售后/交付可在钉钉群聊中 @机器人 提出问题，获得分析回复或自动流程触发
- FR2：分析 Agent 可解析钉钉消息中的图片（含 richText 图文混排、引用回复中的图片、纯图片消息），下载到本地临时目录供分析使用
- FR3：分析 Agent 可解析钉钉消息中的引用回复（repliedMsg），提取被引用内容（文本+图片）作为分析上下文
- FR4：研发可在钉钉群发送命令（混合策略：自然语言意图识别 + 前缀命令辅助 + 不确定时反问），系统路由到对应能力
- FR5：系统可向钉钉发送不同类型消息（普通 Markdown 回复、DM 审批卡片、@通知、分析进度实时推送）
- FR6：系统可在飞书 Webhook 入口接收消息并响应（与钉钉能力对等，图片支持以飞书 SDK 为准）

**2. 代码访问与会话隔离（FR7–FR11）**

- FR7：分析/修复 Agent 可按 (用户, 产品, 版本) 维度创建独立代码 worktree，多并发互不干扰
- FR8：系统可在创建代码 worktree 时使用低成本隔离策略（git clone --shared + sparse-checkout 或 worktree），不影响主仓库
- FR9：分析/修复 Agent 可在代码 worktree 中切换到指定版本/分支
- FR10：系统可维护 Claude CLI session，支持追问时复用上下文（--resume）并按 (senderId, product) 维度隔离
- FR11：系统可按两级回收机制自动清理过期 worktree 和 session（30 分钟 session 过期 / 2 小时 worktree 清理 / 凌晨 3 点兜底扫描）

**3. 知识层（FR12–FR19）**

- FR12：系统可为每个产品线维护独立 AI 摘要文档（随代码仓库走，每个版本/分支独立），分析 Agent 读取摘要作为上下文
- FR13：修复 Agent 可在提交代码变更时同步更新对应模块的 AI 摘要，随 fix 分支一起提交
- FR14：系统可为每个产品线维护独立知识库 Git 仓库（包含 guide/、knowledge/、index.json）
- FR15：分析 Agent 可查询知识库 index.json（按关键词、错误码、模块、版本匹配），命中时秒级返回历史方案
- FR16：系统可将知识库条目中的图片引用到对象存储（MinIO/OSS/本地目录），Markdown 与图片分开存储
- FR17：系统可在 Issue 关闭后自动沉淀「问题描述+根因+修复方案+diff 链接」为知识条目，更新 index.json
- FR18：系统可在新产品接入时 AI 主动扫描代码生成初始 AI 摘要和知识库结构（不依赖人工冷启动）
- FR19：人可通过 Git 提交向知识库仓库补充业务逻辑说明（guide/），通过 index.json 的 versions 元数据做版本匹配

**4. Bug 分析与分级（FR20–FR27）**

- FR20：分析 Agent 可接收来自钉钉消息、GitLab Issue（webhook）、自动化测试失败、监控告警等多种事件源的问题输入
- FR21：分析 Agent 可在分析前区分问题类型（Bug / 配置问题 / 使用问题），只有 Bug 才进入后续修复流程
- FR22：分析 Agent 可通过读代码、读日志、读配置、查知识库四类动作定位 Bug 根因
- FR23：分析 Agent 在输出分析报告时标注置信度（高 ≥80% / 中 50-80% / 低 <50%）
- FR24：分析 Agent 在分析根因的同时输出结构化修复方案（多选项+推荐项），方案作为后续修复 Agent 的输入契约
- FR25：分析 Agent 可自动判断 Bug 级别（L1 配置类 / L2 简单代码 / L3 业务逻辑 / L4 架构级），决定后续流程路由
- FR26：系统可在分析完成后自动创建 GitLab Issue（含产品线标签、模块标签、严重级别、分析报告评论）
- FR27：系统可根据分析结果回复钉钉（命中知识库秒回 / 完整分析报告 / 进度实时推送）

**5. 自动修复与 AI Review（FR28–FR35）**

- FR28：修复 Agent 可基于分析 Agent 产出的方案文档创建独立 fix 分支并在其上进行代码变更
- FR29：修复 Agent 可调用 MCP 工具进行代码修改、运行单元测试、创建 MR
- FR30：修复 Agent 在 commit message 中详细记录修复思路和尝试步骤
- FR31：修复 Agent 可按 Bug 级别走不同流程（L1：修→测试→MR→人工合并；L2：同 L1+需人工 Review；L3：需方案审批通过后才触发修复）
- FR32：系统可在单元测试失败时让修复 Agent 自动分析失败原因并再次尝试，Pipeline 内 retryCount 控制重试次数（默认 2 次，即最多 3 次尝试）
- FR33：系统可在 AI 自动化失败时通过 handover 统一入口转人工接手（V2 核心），保留 fix 分支、Issue 打 needs-manual label、DM 各涉及 project 的 owner+backup owner
- FR34：Review Agent 可在 MR 创建后独立审查 diff（使用不同 systemPrompt、不同权限），从"这个改动有没有问题"视角检查
- FR35：Review Agent 可在 MR 上打标签（ai-approved / ai-needs-attention）并写评论

**5.V2 扩展 FR（FR56–FR59，2026-04-19）**

- FR56（revise 自动修订）：系统可响应 GitLab MR Close webhook 或 CI 失败 webhook，自动启动 revise-pipeline 重修被打回的 project；revise 轮次上限可配（默认 3），超上限自动转 handover
- FR57（tag 版本 Bug 处理）：analyzer 识别 Bug 提在 tag 上时，按 release_branch_pattern 推导 release 分支名；fix 基于 release 分支完成+merge 回 release 分支；master 不自动 cherry-pick；无法处理时直接 handover
- FR58（主备 owner 同发）：L3 审批/handover/其他需 owner 决策的 DM 场景，主 owner 和 backup owner 同时收到 DM；FCFS 首回答生效，另一方回复被幂等拦截
- FR59（任务前资源预检）：coordinator 启动任何 Pipeline 前执行 preflight check（磁盘/内存/进行中任务数/worktree 泄漏检测），不通过时拒绝启动+DM admin

**6. 审批与流程编排（FR36–FR41）**

- FR36：系统可使用 GitLab Issue labels 作为状态机驱动流转
- FR37：系统可根据 label 变化触发对应的编排动作（如 approved label → 触发修复 Agent）
- FR38：系统可在 L3 Bug 场景下向模块负责人发送钉钉 DM 审批卡片（复用 ChatOps ApprovalGate）
- FR39：系统可根据模块→负责人映射表自动路由审批/通知
- FR40：系统可在 MR 合并前要求人工 Review（所有级别），Release Notes 自动生成辅助决策
- FR41：系统可在 Issue 关闭时自动触发知识库沉淀（FR17）和 Bug 根因归因（FR42）

**7. Bug 根因归因与知识进化（FR42–FR44）**

- FR42：系统可为每个关闭的 Bug 记录根因类型（纯语法/空指针 / 业务逻辑错误 / 需求理解偏差 / 边界条件遗漏 / 跨模块冲突）
- FR43：系统可基于根因归因数据反推知识体系优化点
- FR44：系统可统计"同类根因重复 Bug"占比趋势

**8. 权限与多租户（FR45–FR49）**

- FR45：系统可按四级角色（developer/tester/ops/admin）、产品线、环境、capability 四维度做权限控制
- FR46：系统可为新增的 capability 配置产线×环境×角色的访问控制矩阵
- FR47：系统可通过 CLI 层 --allowed-tools 硬限制每个 Agent 的工具权限
- FR48：系统可在 AI 分析/修复时对密码、密钥、IP 等敏感信息自动脱敏
- FR49：admin 可管理产品线（新增/编辑/停用）、配置 Git 仓库路径、知识库仓库路径、默认分支、AI 摘要路径

**9. 管理与监控（FR50–FR55）**

- FR50：admin 可通过管理后台一键接入新产品线（配置 Git 地址→触发 AI 扫描生成摘要→生成模块→负责人建议→创建知识库仓库→配置 Webhook 指引）
- FR51：admin 可管理"模块→负责人"映射表（产品线×模块模式×钉钉 userId）
- FR52：研发/测试/运维可在前端查看每个 Bug 的 12 节点闭环流程进度（复用/扩展 TestRunsPage）
- FR53：用户可在前端查看价值量化仪表盘（修复成功率/命中率/平均耗时/工时节省估算）—— Growth 阶段
- FR54：admin 可导出审计日志（所有分析/修复/审批决策记录）
- FR55：系统可记录知识库条目的热度（命中次数、用户评价）

**总计 FR：59 条（FR1-FR49、FR52-FR59，跳过 FR50、FR51 因同属管理类，实际编号连续）**

---

### Non-Functional Requirements

**性能（NFR-P）**

- NFR-P1：知识库命中场景端到端时延 ≤3 秒（P95）
- NFR-P2：完整分析流程端到端时延 ≤5 分钟（P95），基线 4 分钟
- NFR-P3：session 复用场景追问响应时延 ≤10 秒（P95）
- NFR-P4：单次 L1 Bug 从 fix 分支创建到 MR 创建 ≤10 分钟（不含测试运行时间）
- NFR-P5：支持 10-30 路并发分析任务，并发间无相互干扰

**安全（NFR-S）**

- NFR-S1：分析报告/日志/AI 回复中自动过滤敏感信息，脱敏覆盖率 100%
- NFR-S2：通过 Claude CLI --allowed-tools 参数硬限制 Agent 权限
- NFR-S3：每个分析任务 worktree 独立，清理时彻底删除；不影响主仓库
- NFR-S4：所有决策记录入数据库，保留周期 ≥180 天，支持按产品线/用户/时间维度导出
- NFR-S5：所有组件支持完全私有化部署，客户数据不外泄
- NFR-S6：分析 Agent 不可通过用户输入修改代码或 Git 状态；修复 Agent 不接收外部消息，仅消费结构化输入

**可扩展性（NFR-SC）**

- NFR-SC1：新产品线接入所需时间 ≤1 天
- NFR-SC2：10 路并发分析临时目录总占用 ≤100MB
- NFR-SC3：架构支持单客户完全独立部署，客户间无数据共享
- NFR-SC4：单产品线知识库条目数 ≤5000 时，index.json 匹配时延 <100ms

**可靠性（NFR-R）**

- NFR-R1：任务执行中断或节点重启后，pending_approval 状态任务可恢复执行
- NFR-R2：Claude session 失效时，系统自动重建新 session，不阻塞当前请求
- NFR-R3：AI 自动修复在任意可兜底场景 100% 触发 handover 机制
- NFR-R4：流水线失败分析属于 best-effort，失败不阻塞主流程
- NFR-R5：任何分析/修复过程的异常终止，主 Git 仓库状态不受影响

**可观测性（NFR-O）**

- NFR-O1：核心指标（分析任务数/修复成功率/知识库命中率/平均耗时/handover 次数）自动采集入库
- NFR-O2：所有审批请求、响应、超时升级事件可在管理后台查询
- NFR-O3：每个 Bug 的 12 节点闭环流程进度在前端可见，支持按产品线筛选
- NFR-O4：MCP 工具调用日志写入 /tmp/mcp-server.log，保留 ≥30 天

**集成（NFR-I）**

- NFR-I1：钉钉 Stream 长连接断开后自动重连，消息去重保留最近 200 条
- NFR-I2：GitLab 接口调用遵循令牌桶限流，超限时自动退避重试
- NFR-I3：底层 AI 模型通过 Porygon backend 层抽象，替换模型时只修改 backend 实现
- NFR-I4：GitLab Webhook 调用必须携带 x-gitlab-token 鉴权
- NFR-I5：MCP Server 启动失败/工具调用无响应等异常有日志记录和 Parent 进程超时回收

**总计 NFR：29 条（P×5 + S×6 + SC×4 + R×5 + O×4 + I×5）**

---

### Additional Requirements（约束与假设）

1. **私有化部署约束**：推客户阶段客户代码、知识库、AI 会话数据不出客户域
2. **模型可替换约束**：业务逻辑不耦合具体 AI 模型，通过 Porygon backend 层抽象
3. **GitLab / 钉钉 / 飞书 / MCP 协议**为硬依赖，外部契约变更须有版本兼容策略
4. **代码安全**：Agent 权限在 CLI 层强制限制（--allowed-tools），不依赖 Prompt 实现权限隔离
5. **资源约束**：2-3 人兼职团队，复用 ChatOps 平台降低实现成本
6. **UX 文档缺失**：无 UX 设计文档，将影响 UX 相关需求的评估完整性

---

### PRD Completeness Assessment

**优势：**
- PRD 结构完整，涵盖用户旅程、功能需求、非功能需求、技术约束、多租户模型
- FR 编号连续且有映射表，可追溯到业务旅程
- NFR 有可量化指标（时延、覆盖率、保留周期），便于验收
- V2 扩展 FR（FR56-FR59）已明确标记，不影响主流程评估

**需关注：**
- FR 编号存在不连续（FR50/FR51 标注为"管理类"但实际 FR 号连续），细节核查时需注意
- 部分 FR 依赖外部规范文档（V2 spec）作为细节补充，评估时需同步参考
- UX 设计文档缺失，前端相关 FR（FR5、FR27、FR52、FR53）的 UX 规范无法核对

---

## Epic 覆盖验证

### 覆盖矩阵

| FR # | PRD 需求摘要 | Epic 覆盖 | 状态 |
|------|------------|----------|------|
| FR1 | 钉钉 @机器人入口 | Epic 1 | ✅ 已覆盖 |
| FR2 | 钉钉图片消息解析 | Epic 1 (Story 1.3) | ✅ 已覆盖 |
| FR3 | 钉钉引用回复解析 | Epic 1 (Story 1.3) | ✅ 已覆盖 |
| FR4 | 混合意图识别策略 | Epic 1 | ✅ 已覆盖 |
| FR5 | 多种钉钉消息类型 | Epic 1 | ✅ 已覆盖 |
| FR6 | 飞书入口扩展 | Epic 8 (Story 8.1) | ✅ 已覆盖（Growth） |
| FR7 | 独立代码 worktree | Epic 1 (Story 1.5) | ✅ 已覆盖 |
| FR8 | Git worktree 隔离策略 | Epic 1 (Story 1.5) | ✅ 已覆盖 |
| FR9 | switch_version 工具 | Epic 1 (Story 1.9) | ✅ 已覆盖 |
| FR10 | Claude session 复用 | Epic 1 | ✅ 已覆盖 |
| FR11 | 统一 TTL 回收机制 | Epic 1 (Story 1.5) | ✅ 已覆盖 |
| FR12 | AI 摘要读取 | Epic 1 | ✅ 已覆盖 |
| FR13 | AI 摘要随修复同步更新 | Epic 3 (Story 3.2) | ✅ 已覆盖 |
| FR14 | 知识库 Git 仓库 | Epic 2 | ✅ 已覆盖 |
| FR15 | index.json 匹配引擎 | Epic 2 (Story 2.1/2.2) | ✅ 已覆盖 |
| FR16 | 图片本地存储 | Epic 2 (Story 2.3) | ✅ 已覆盖 |
| FR17 | Issue 关闭自动沉淀 | Epic 7 (Story 7.2) | ✅ 已覆盖 |
| FR18 | AI 主动扫描生成初始摘要 | Epic 6 (Story 6.2) | ✅ 已覆盖 |
| FR19 | 人工 Git 提交 guide | Epic 2 (Story 2.6) | ✅ 已覆盖 |
| FR20 | 多事件源接收 | Epic 1/Epic 8 | ✅ 已覆盖 |
| FR21 | 问题分类（Bug/Config/Usage） | Epic 1 (Story 1.10) | ✅ 已覆盖 |
| FR22 | 分析 Agent 四类动作 | Epic 1 (Story 1.10) | ✅ 已覆盖 |
| FR23 | 置信度标签 | Epic 1 (Story 1.10) | ✅ 已覆盖 |
| FR24 | 结构化修复方案 | Epic 1 (Story 1.10) | ✅ 已覆盖 |
| FR25 | 自动分级（L1-L4） | Epic 1 (Story 1.10) | ✅ 已覆盖 |
| FR26 | GitLab Issue 自动创建 | Epic 1 (Story 1.9) | ✅ 已覆盖 |
| FR27 | 钉钉回复（秒回/报告/进度） | Epic 1 | ✅ 已覆盖 |
| FR28 | fix 分支创建 | Epic 3 (Story 3.3) | ✅ 已覆盖 |
| FR29 | 修复工具集 | Epic 3 (Story 3.1) | ✅ 已覆盖 |
| FR30 | Aider 风格 commit message | Epic 3 (Story 3.4) | ✅ 已覆盖 |
| FR31 | L1/L2/L3 分级修复流程 | Epic 3/4/5 | ✅ 已覆盖 |
| FR32 | 3 次自动重试 | Epic 4 (Story 4.2) | ✅ 已覆盖 |
| FR33 | AI 失败 handover（简化版） | Epic 4 (Story 4.3) | ⚠️ **部分覆盖**（仅 fix 3 轮失败，未覆盖 revise 3 轮/L4/低信心/用户主动/GitLab label 触发等 V2 触发源） |
| FR34 | AI Review Agent 独立审查 | Epic 4 (Story 4.6) | ✅ 已覆盖 |
| FR35 | Review Agent label + 评论 | Epic 4 (Story 4.6) | ✅ 已覆盖 |
| FR36 | GitLab label 状态机 | Epic 3 (Story 3.6) | ✅ 已覆盖 |
| FR37 | label 变化触发编排 | Epic 3 (Story 3.6) | ✅ 已覆盖 |
| FR38 | L3 钉钉 DM 审批卡片 | Epic 5 (Story 5.4) | ✅ 已覆盖 |
| FR39 | 模块→负责人映射路由 | Epic 5 (Story 5.1/5.2) | ✅ 已覆盖 |
| FR40 | MR 合并前人工 Review | Epic 4 | ✅ 已覆盖 |
| FR41 | Issue 关闭触发沉淀+归因 | Epic 7 | ✅ 已覆盖 |
| FR42 | Bug 根因类型记录 | Epic 7 (Story 7.1) | ✅ 已覆盖 |
| FR43 | 归因反推知识体系优化 | Epic 7 (Story 7.4) | ✅ 已覆盖 |
| FR44 | 同类根因重复率统计 | Epic 7 (Story 7.3) | ✅ 已覆盖 |
| FR45 | 四维 RBAC | Epic 1 | ✅ 已覆盖 |
| FR46 | 新 capability 访问控制矩阵 | Epic 1 | ✅ 已覆盖 |
| FR47 | CLI --allowed-tools 硬限制 | Epic 1 (Story 1.7) | ✅ 已覆盖 |
| FR48 | 敏感信息脱敏 | Epic 4 (Story 4.1) | ✅ 已覆盖 |
| FR49 | 产品线管理扩展 | Epic 1/Epic 6 | ✅ 已覆盖 |
| FR50 | 新产品线接入向导 | Epic 6 (Story 6.3/6.4) | ✅ 已覆盖 |
| FR51 | 模块→负责人映射配置前端 | Epic 5/6 (Story 6.5) | ✅ 已覆盖 |
| FR52 | Bug 修复实例前端 | Epic 6 (Story 6.6) | ✅ 已覆盖 |
| FR53 | 价值量化仪表盘 | Epic 7 (Story 7.6) | ✅ 已覆盖（Growth） |
| FR54 | 审计日志导出 | Epic 6 (Story 6.7) | ✅ 已覆盖 |
| FR55 | 知识库条目热度统计 | Epic 2 (Story 2.4) | ✅ 已覆盖 |
| **FR56** | revise 自动修订（MR 打回/CI 失败触发重修） | **未找到** | ❌ **缺失** |
| **FR57** | tag 版本 Bug 处理（release 分支推导+fix） | **未找到** | ❌ **缺失** |
| **FR58** | 主备 owner 同发（FCFS 首回答生效） | **未找到** | ❌ **缺失** |
| **FR59** | 任务前资源预检（磁盘/内存/worktree 泄漏） | **未找到** | ❌ **缺失** |

### 缺失需求

#### 关键缺失 FR

**FR56（revise 自动修订）**
- 完整文本：系统可响应 GitLab MR Close webhook 或 CI 失败 webhook，自动启动 revise-pipeline 重修被打回的 project；Claude 通过 MCP 工具主动读 MR comment/CI 日志获取打回意见；revise 轮次上限可配（默认 3），超上限自动转 handover
- 影响：这是 V2 workflow 的核心能力之一，影响 MR 被拒后的自动重修路径；缺失会导致 MR 打回后无法自动续修，需全人工介入
- 建议：在 Epic 4 或新增 Epic（或 Epic 4 内新增 Story）中覆盖

**FR57（tag 版本 Bug 处理）**
- 完整文本：analyzer 识别 Bug 提在 tag 上时，按 release_branch_pattern 推导 release 分支名；分支不存在则从 tag 自动建分支；fix 基于 release 分支；master 不自动 cherry-pick；无法处理时直接 handover
- 影响：PAM 产品在 release 分支上修 bug 是常见场景，缺失会导致 tag Bug 无法走自动修复路径
- 建议：在 Epic 3 或 Epic 4 中增加 Story 覆盖 tag Bug 分支处理逻辑

**FR58（主备 owner 同发）**
- 完整文本：L3 审批/handover/其他需 owner 决策的 DM 场景，主 owner 和 backup owner 同时收到 DM；任一方在有效时间内回复 → 首回答生效（FCFS），另一方回复被幂等拦截
- 影响：Epic 5 中的 L3 审批和 Epic 4 中的 handover 通知均依赖此机制；缺失会导致 backup owner 无法接收通知，单点故障风险高
- 建议：在 Epic 5 (Story 5.4) 或新 Story 中覆盖

**FR59（任务前资源预检）**
- 完整文本：coordinator 启动任何 Pipeline 前执行 preflight check（磁盘/内存/进行中任务数/worktree 泄漏检测），不通过时拒绝启动+DM admin
- 影响：这是系统稳定性的保障机制，缺失会导致高负载下雪崩失败；在 Story 1.7（AgentCoordinator 骨架）中应该覆盖
- 建议：在 Epic 1 (Story 1.7) 中补充 AC 覆盖 preflight check 逻辑

#### 部分覆盖的 FR

**FR33（handover 统一入口 —— 仅覆盖"fix 3 轮失败"触发源）**
- Epic 4 Story 4.3 描述了"3 次修复失败后自动降级"，但 PRD V2 FR33 还包含以下触发源：
  - revise 3 轮失败（依赖 FR56）
  - L4 分类直接触发 handover
  - 低信心分析触发 handover
  - 用户在前端主动点"转人工"
  - owner 在 GitLab 主动打 needs-manual label
  - tag bug 无法处理（依赖 FR57）
- 建议：在 Epic 4 Story 4.3 的 AC 中补充上述所有触发源的处理逻辑

### 覆盖率统计

| 项目 | 数量 |
|------|------|
| PRD 总 FR | 59 条（FR1-FR55 + FR56-FR59） |
| Epic 覆盖 FR | 55 条（FR1-FR55 全覆盖） |
| 完全缺失 FR | 4 条（FR56、FR57、FR58、FR59） |
| 部分覆盖 FR | 1 条（FR33 仅覆盖部分触发源） |
| 覆盖率 | 55/59 = **93.2%**（含部分覆盖，否则 56/59 = 94.9%） |

**注：** Epic 文档页眉标注"55 FR + 24 NFR"，但实际 PRD 有 59 FR + 29 NFR（V2 扩展未同步到 Epic）。Epic 文档内的 NFR 列表实际也列出了 29 条，页眉数字为旧版本遗留，不影响实质评估。

---

## UX 对齐评估

### UX 文档状态

**❌ 未找到 UX 设计文档**（`_bmad-output/planning-artifacts/` 目录下无 *ux*.md 文件）

### UI 需求是否隐含

**是**。PRD 和 Epics 中明确提及以下前端能力：

| 需求来源 | 前端功能 |
|---------|---------|
| FR5 | 钉钉 DM 审批卡片、@通知、分析进度实时推送 |
| FR38 | L3 方案审批钉钉 DM 卡片（ApprovalGate） |
| FR52 | Bug 修复实例前端页面（12 节点闭环进度） |
| FR53 | 价值量化仪表盘（修复成功率/命中率/耗时/工时节省） |
| FR49/FR50 | 产品线管理与接入向导后台 |
| FR51 | 模块→负责人映射配置后台页面 |
| FR54 | 审计日志导出前端入口 |
| Story 6.6 | Bug 实例列表 + 12 节点进度图（含 data-testid 规范） |
| Story 7.6 | 价值量化仪表盘折线图 + 汇总数据（含 data-testid 规范） |

### 对齐问题

**1. UX 规范完全缺失 —— 高风险**

没有 UX 设计文档意味着：
- Bug 修复实例页面（Story 6.6）的信息架构、交互流程、状态展示方式完全依赖开发者自行决策
- 12 节点流程图的可视化方案（节点图 vs 时间轴 vs 表格）无规范约束
- 仪表盘（Story 7.6）的指标展示布局无设计参考
- L3 审批卡片的钉钉消息卡片格式无 UX 规范

**2. 钉钉卡片设计缺乏规范**

FR38 要求向模块负责人发送 DM 审批卡片，含"方案摘要 + 查看完整方案链接 + Approve/Reject 按钮"。但：
- 没有卡片 JSON 模板或视觉规范
- Epic 5 Story 5.4 AC 仅描述功能，未规定卡片布局格式
- 钉钉消息卡片格式如设计不当，可能在 IM 中显示异常

**3. 进度实时推送的用户体验未定义**

FR27 提到"分析进度实时推送"，但未定义：
- 推送频率（每步推？还是关键节点推？）
- 消息格式（纯文字？Markdown？ProgressBar？）
- 防打扰策略（同一 Bug 的多次推送如何组织）

### 警告

⚠️ **WARNING（中优先级）：** UX 文档缺失，但 6 个前端 Story（6.4/6.5/6.6/7.6/5.4 钉钉卡片/FR5 消息格式）均有明确 UI 需求。建议在实施前完成以下最小 UX 规范：
1. Bug 修复实例页面的信息架构草图（12 节点节点图布局）
2. L3 审批钉钉卡片 JSON 模板
3. 分析进度实时推送的频率策略和消息格式

⚠️ **WARNING（低优先级）：** 价值量化仪表盘（FR53，Growth 阶段）可在 Growth 前补充 UX 规范，MVP 阶段不阻塞。

### 架构与 UX 对齐情况

虽无 UX 文档，但对比架构文档中涉及前端的部分：
- 管理后台使用 React 18 + Ant Design 5（ChatOps 既有技术栈），前端组件能力具备
- NFR-O3 要求 Bug 流程进度在前端可见，架构中 bug_analysis_reports + GitLab label 状态机提供数据支撑 ✅
- 实时推送需要 SSE 或 WebSocket，架构文档中无明确说明（潜在风险）

---

## Epic 质量审查

### Epic 结构验证

#### 用户价值导向检查

| Epic | 标题 | 用户价值 | 是否为技术里程碑 | 评估 |
|------|------|---------|--------------|------|
| Epic 1 | 基础设施与首次可用的 Bug 分析 | ✅ 研发可获得完整分析报告+Issue | 标题含"基础设施"，但 Goal 用户导向 | ⚠️ 标题部分技术化 |
| Epic 2 | 知识库历史经验秒回 | ✅ 售后可秒级获得历史方案 | ❌ 否 | ✅ |
| Epic 3 | L1 自动修复闭环 | ✅ L1 Bug 全自动到 MR | ❌ 否 | ✅ |
| Epic 4 | AI Review Agent + L2 自动修复 | ✅ L2 半自动修复+AI Review | ❌ 否 | ✅ |
| Epic 5 | L3 方案审批流程 | ✅ 负责人收到 DM 卡片审批 | ❌ 否 | ✅ |
| Epic 6 | 管理后台与新产品线接入 | ✅ 管理员一天内接入新产品线 | ❌ 否 | ✅ |
| Epic 7 | Bug 根因归因与知识进化（Growth） | ✅ 运营查看根因趋势仪表盘 | ❌ 否 | ✅ Growth |
| Epic 8 | 多入口扩展与模型可插拔（Growth） | ✅ 飞书用户也能使用 | ❌ 否 | ✅ Growth |

**评注：** Epic 1 标题中"基础设施"一词偏技术化，但 Goal 描述是用户导向的（"研发/测试/运维/售后/交付可在钉钉 @机器人提出 Bug 问题..."），可接受。

#### Epic 独立性验证

| Epic | 依赖关系 | 独立性评估 |
|------|---------|----------|
| Epic 1 | 无前置 Epic | ✅ 完全独立 |
| Epic 2 | 需要 Epic 1（WorktreeManager, AgentCoordinator） | ✅ 正向依赖，合理 |
| Epic 3 | 需要 Epic 1（代码隔离沙箱, analyze_bug 输出） | ✅ 正向依赖，合理 |
| Epic 4 | 需要 Epic 3（fix 工具集, fix 分支） | ✅ 正向依赖，合理 |
| Epic 5 | 需要 Epic 1/3/4（审批流, 修复 Agent） | ✅ 正向依赖，合理 |
| Epic 6 | 需要 Epic 1（产品线管理数据） | ✅ 正向依赖，合理 |
| Epic 7 | 需要 Epic 3/4/5（Bug 全生命周期数据） | ✅ 正向依赖，合理（Growth） |
| Epic 8 | 需要 Epic 1（基础 Agent 框架） | ✅ 正向依赖，合理（Growth） |

---

### 🔴 关键违规（Critical Violations）

**C1：Story 3.6 前向依赖 Epic 4（违反 Epic 独立性规则）**

- **位置：** Epic 3 / Story 3.6 「GitLab Label 状态机驱动」
- **问题原文：**
  > "Given Issue label 变为 in-review / When MR 存在 / Then 触发 ai_review_mr（Epic 4）"
- **违规原因：** Story 3.6 的 AC 明确引用了 Epic 4 中才实现的 `ai_review_mr` capability。这意味着 Story 3.6 的 AC 在 Epic 3 完成时**无法通过**，因为 ai_review_mr 尚未实现。开发者在验收 Story 3.6 时会面临"AC 提到的触发器不可测试"的困境。
- **修复建议：** 将 Story 3.6 的 AC 分为两段：
  1. **Epic 3 Story 3.6（当前范围）：** label 状态机驱动 + `in-review` 转换正确 → 此时 ai_review_mr 触发不在范围内，AC 应注释"触发 ai_review_mr 在 Epic 4 启用后验证"
  2. **Epic 4 Story 4.6（新增 AC）：** `ai_review_mr` 触发在 in-review label 变化时自动触发

---

### 🟠 重大问题（Major Issues）

**M1：Story 1.1 创建了所有 7 张表，包含 Growth 阶段才使用的表**

- **位置：** Epic 1 / Story 1.1 「Schema v8 迁移与 Capability 注册」
- **问题：** Story 1.1 一次性创建 7 张表：`bug_analysis_reports`（Epic 1 即用）、`module_owners`（Epic 5 才用）、`product_knowledge_repos`（Epic 6 才用）、`root_cause_attributions`（Epic 7 Growth）、`knowledge_hit_stats`（Epic 2 才用）、`bug_analysis_stats`（Epic 7 Growth）、`metrics_daily`（Epic 7 Growth）。3 张表（root_cause_attributions / bug_analysis_stats / metrics_daily）属于 Growth 阶段（Epic 7），在 MVP 中完全用不到。
- **影响：** 前置积累了无用的 schema，增加了当前 Story 的范围和测试负担；Growth 阶段如果 schema 有调整，需要额外迁移。
- **建议（可接受，但需知情）：** 对于 brownfield 项目，一次性集中 schema 迁移是常见做法（减少迁移文件数量）。本项目使用 `src/db/migrate.ts` + `SCHEMA_FILES` 列表的机制，将所有表放在一个 schema 文件也是可行的。如果团队接受这种方式，建议在 Story 1.1 的描述中注明"含 Growth 阶段预置表"，避免开发者困惑。如果要严格拆分，建议 Growth 表单独放入 schema-v9.sql 在 Epic 7 前迁移。

**M2：FR33 在 Story 4.3 中实现了简化版本，遗漏 V2 多触发源**

- **位置：** Epic 4 / Story 4.3 「自动降级逻辑」
- **问题：** Story 4.3 只覆盖了"fix 3 次失败自动降级"这一个触发源，但 PRD V2 FR33 还包含：
  - **revise 3 轮失败** —— 依赖 FR56（revise-pipeline），完全未覆盖
  - **L4 分类直接触发 handover** —— Story 1.10 (analyze_bug) AC 中无此处理
  - **低信心分析触发 handover** —— 置信度 < 50% 时是否触发？Story 1.10 无此 AC
  - **用户在前端主动点"转人工"** —— Story 6.6 没有此按钮（只有"触发修复按钮"）
  - **owner 在 GitLab 主动打 needs-manual label** —— Webhook handler 无此处理
  - **tag bug 无法处理时 handover** —— FR57 完全未覆盖
- **影响：** 当前 Epic 实现的 handover 机制不完整，上线后若遇到 L4 Bug 或用户手动打 label，系统无法正确触发 handover。
- **建议：** 在 Story 4.3 中补充上述 3 个 MVP 范围内的触发源（L4、低信心、GitLab label 手动触发）；FR56/FR57 相关触发源在新 Epic 中覆盖。

**M3：FR59（任务前资源预检）在 Story 1.7 中缺失**

- **位置：** Epic 1 / Story 1.7 「AgentCoordinator 骨架」
- **问题：** FR59 要求 coordinator 启动任何 Pipeline 前执行 preflight check（磁盘/内存/进行中任务数/worktree 泄漏检测），但 Story 1.7 的 AC 中没有任何关于 preflight check 的条目。
- **影响：** 高负载场景下若无资源预检，可能触发雪崩（内存耗尽/磁盘耗尽/过多并发 Agent）
- **建议：** 在 Story 1.7 的 AC 中补充 preflight check 相关验收条件：
  - `Given` triggerCapability 调用且磁盘剩余 < 500MB / 进行中任务 ≥ 30
  - `Then` 拒绝启动 + 返回错误信息 + DM admin

**M4：V2 扩展 FR56/FR57/FR58 没有任何 Epic 归属**

- **覆盖情况：** FR56（revise 自动修订）、FR57（tag 版本 Bug 处理）、FR58（主备 owner 同发）均未出现在任何 Epic 的 FRs covered 列表或 Story AC 中
- **影响：**
  - FR56：MR 打回后无自动重修能力，用户体验断档
  - FR57：tag 上的 Bug 无法走自动修复路径，PAM 产品的 hotfix 场景受影响
  - FR58：L3 审批和 handover 场景仅通知主 owner，若主 owner 离线则审批/接手阻塞
- **建议：** 将 FR56/FR57/FR58 加入 Epic 4 的扩展 Story（或新 Epic 9），并更新 FR Coverage Map

---

### 🟡 轻微问题（Minor Concerns）

**N1：Epic 1 体量较大（11 个 Story），可能影响迭代节奏**
- Epic 1 包含 11 个 Story，且 Story 1.11（端到端验收）依赖前 10 个 Story 全部完成。这意味着 Epic 1 的完整验收可能需要较长时间。
- 建议：可将 Story 1.1-1.7（平台基础设施）拆分为 Epic 0，Story 1.8-1.11（分析 Agent）保留为 Epic 1，与 PRD 里程碑 0/1 对应。这是可选优化，不影响正确性。

**N2：Story 6.6 将 E2E 测试框架要求（data-testid）混入功能 AC**
- Story 6.6 的 AC 中包含 `[TEA-UI-E2E]` 前缀的 data-testid 属性要求。这属于测试基础设施需求而非功能验收标准。
- 建议：将 data-testid 要求移入独立的测试注释区域（如"测试要求"小节），或在通用约束中统一声明，而不是嵌入功能 AC。

**N3：Story 2.6（知识库人工编辑）验收标准过于宽松**
- Story 2.6 AC 中"index.json 可手动编辑增加条目（MVP 不自动检测新文件）"这一表述是可接受的，但"用户"如何通过 Git 提交触发 KnowledgeRepository 更新的具体 AC 不完整。没有明确测试条件覆盖"人工提交 Guide 后 Agent 实际能读取到"的验证路径。

**N4：Growth 阶段 Epic（7/8）在 Epic List 中位置合理，但里程碑标记不统一**
- Epic 7 和 Epic 8 标注了"(Growth)"，但 Stories 内部没有统一的"Growth"标签，可能导致开发者不清楚哪些 Story 属于 MVP 范围。

---

### 最佳实践合规核查

| 检查项 | Epic 1 | Epic 2 | Epic 3 | Epic 4 | Epic 5 | Epic 6 | Epic 7 | Epic 8 |
|--------|:------:|:------:|:------:|:------:|:------:|:------:|:------:|:------:|
| Epic 交付用户价值 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Epic 可独立运行 | ✅ | ✅ | ⚠️ S3.6 前向依赖 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stories 大小合适 | ⚠️ 11个较多 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 无前向依赖 | ✅ | ✅ | ❌ S3.6→Epic 4 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 数据库按需创建 | ⚠️ 预创建7表 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| 验收标准清晰 | ✅ | ⚠️ S2.6 宽松 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| FR 可追溯 | ✅ | ✅ | ✅ | ⚠️ FR33 不完整 | ✅ | ✅ | ✅ | ✅ |

---

## 总结与建议

### 总体就绪状态

**⚠️ NEEDS WORK（需要完善后实施）**

**核心 MVP（FR1-FR55）的规划质量很高**，PRD、架构、Epic 三层文档对齐良好，55 个 MVP FR 全部映射到 Epic，验收标准清晰可测。但存在以下需要在实施前解决的问题：

---

### 必须在实施前处理的关键问题

**P0 - 阻断型（建议实施前修复）**

| 编号 | 问题 | 位置 | 影响 |
|------|------|------|------|
| P0-1 | Story 3.6 前向依赖 Epic 4 的 ai_review_mr | Epic 3 Story 3.6 | Story 3.6 AC 在 Epic 3 完成时无法通过验收 |
| P0-2 | FR33 handover 触发源不完整（L4/低信心/用户主动/GitLab label 触发未覆盖） | Epic 4 Story 4.3 | L4 Bug 和低信心场景无 handover，风险未兜底 |
| P0-3 | FR59 preflight check 在 Story 1.7 中缺失 | Epic 1 Story 1.7 | 高并发下无资源预检，可能雪崩 |

**P1 - 重要（在对应 Epic 实施前补充）**

| 编号 | 问题 | 位置 | 影响 |
|------|------|------|------|
| P1-1 | FR56（revise 自动修订）无 Epic 归属 | 无 | MR 打回后无自动续修能力 |
| P1-2 | FR57（tag 版本 Bug 处理）无 Epic 归属 | 无 | tag 上的 Bug 无法走自动修复路径 |
| P1-3 | FR58（主备 owner 同发）无 Epic 归属 | 无 | L3 审批和 handover 单点故障风险 |
| P1-4 | UX 设计文档缺失（Bug 实例页、审批卡片、进度推送格式） | 无 | 前端 Story 6.4/6.5/6.6/5.4 实现标准不一 |

**P2 - 建议（可在实施中同步处理）**

| 编号 | 问题 | 建议 |
|------|------|------|
| P2-1 | Story 1.1 预创建 Growth 阶段表（3 张） | 注明"含 Growth 预置表"或拆分 schema 文件 |
| P2-2 | 进度实时推送（FR27）的实现方式（SSE/WebSocket）架构未说明 | 在 Story 1.10 或架构补充中明确 |
| P2-3 | Story 6.6 data-testid 要求嵌入功能 AC | 移入通用测试约束或独立注释 |
| P2-4 | Story 2.6 验收标准不完整 | 补充"人工提交 Guide 后 Agent 实际能读取"的端到端 AC |

---

### 推荐行动步骤

1. **立即（实施 Epic 3 前）：** 修复 Story 3.6 的前向依赖——将"触发 ai_review_mr"从 Story 3.6 AC 中移除，改为注释"此触发在 Epic 4 实施后验证"

2. **立即（实施 Epic 4 前）：** 在 Story 4.3 中补充 L4、低信心、用户主动转人工、GitLab label 手动触发等 handover 触发源 AC

3. **立即（实施 Epic 1 前）：** 在 Story 1.7 中补充 FR59 preflight check 的 AC（磁盘/内存/并发任务数检查）

4. **在 Epic 4 或新 Epic 中：** 为 FR56/FR57/FR58 创建对应 Story 并更新 FR Coverage Map

5. **在前端 Story 实施前（Story 6.4/6.6/5.4）：** 完成最小 UX 规范（Bug 实例页信息架构草图 + L3 审批卡片 JSON 模板 + 进度推送频率策略）

6. **可选优化：** 将 Epic 1 拆分为 Epic 0（平台基础设施，Story 1.1-1.7）+ Epic 1（分析 Agent，Story 1.8-1.11），与 PRD 里程碑 0/1 对应

---

### 最终说明

本次评估共发现 **12 个问题**，覆盖 **4 个类别**（FR 覆盖缺口 × 5、UX 缺失 × 1、Epic 质量 × 4、轻微问题 × 4）。

**核心 MVP 路径质量评级：⭐⭐⭐⭐ / 5**（优秀，3 个 P0 问题需在实施前修复）

**V2 功能规划完整性：⭐⭐ / 5**（FR56-FR59 完全缺失 Epic 规划，需在 V2 冲刺前补充）

**文档一致性：⭐⭐⭐⭐ / 5**（PRD-架构-Epic 三层高度一致，V2 扩展同步缺失是主要短板）

---

**评估日期：** 2026-04-28
**评估范围：** PRD（prd.md）/ 架构（architecture.md）/ Epics（epics.md）
**评估人：** Implementation Readiness Skill（ChatOps 研发 AI 助手项目）



