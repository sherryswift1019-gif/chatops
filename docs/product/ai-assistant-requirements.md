# 研发 AI 助手 - 产品需求清单

## 产品定位

**ChatOps 平台的"研发 AI 助手"能力模块**。ChatOps 是整个 DevOps 自动化平台，包含多种能力（运维部署、研发助手、测试流水线等），研发 AI 助手是其中聚焦"Bug 分析→修复→验证→知识沉淀"的能力。

**与 ChatOps 的关系**：
- **ChatOps** = 平台（IM 入口 + Agent 编排 + 审批 + 权限 + 流水线引擎 + 管理后台）
- **研发 AI 助手** = ChatOps 的一个能力模块（新增 capability + 流程定义 + 知识库）
- 复用 ChatOps 已有的 IM 适配器、Session 管理、审批机制、RBAC、流水线引擎、前端框架

**核心差异化**：不是 Copilot/Cursor 那样的代码补全工具，而是**研发全流程闭环**——从问题发现到修复上线到知识沉淀，AI 参与每个环节。

**先内部跑通 PAM 闭环，成熟后作为增值服务推给客户。**

> ChatOps 平台架构详见 [docs/ai-summary/chatops.md](../ai-summary/chatops.md)

## 产品决策记录

| 问题 | 决策 | 影响 |
|------|------|------|
| 产品名称 | **ChatOps**（研发 AI 助手是其中一个能力模块） | 统一平台品牌，多能力共存 |
| 服务范围 | 先内部再推客户 | 前期不考虑多租户，后期需要私有化部署能力 |
| 目标用户 | 研发 + 测试 + 运维 + 售后/交付 | 复用 ChatOps 四级 RBAC（developer/tester/ops/admin） |
| 短期目标 | 先跑通 PAM 闭环（1-2 月） | 优先实现闭环 10 个节点，功能深度优先于广度 |
| Bug 管理 | **统一使用 GitLab Issue**，不再对接禅道 | Issue 和代码同平台，commit 自动关联，Webhook 驱动流转 |
| AI 改代码 | AI 按 Bug 级别走不同流程（分级路由） | L1/L2 快通道（AI 直修 → MR），L3 保留方案审批，L4 纯辅助 |
| 平台集成 | 基于 ChatOps 平台，复用基础设施 | capability + test_pipelines 做流程编排，不新建独立系统 |
| 能力注册 | 新增 capability（analyze_bug / fix_bug 等） | 复用 ChatOps 的 capability 路由 + 意图识别机制 |
| 流程编排 | 复用 test_pipelines 表扩展 stage 类型 | 新增 capability / wait_webhook 类型 stage |
| 知识库 | 每个产品独立 Git 仓库，有版本概念 | 仅供 AI 内部使用，不做前端展示 |
| 意图识别 | 混合策略：AI 意图识别为主 + 前缀命令为辅 + 不确定时反问 | 同一个机器人覆盖所有能力 |
| 图片消息 | MVP 支持图片（NormalizedMessage 增加 images 字段） | 当前 ChatOps 不支持图片，需改造 |
| 流程实例页面 | MVP 必做，用户能看到每个 Bug 的流程进度 | 复用/扩展 ChatOps 前端 |
| 审批 | 复用 ChatOps ApprovalGate | 不满足再扩展 |
| 并发规模 | 10-30 人同时使用 | 需要代码隔离（git clone --shared）、Session 管理、资源回收 |
| 代码安全 | 可以接受云端分析（内部阶段） | 直接用 Claude Code CLI，不需要本地模型；推客户时再考虑私有化 |
| 团队 | 2-3 人兼职 | MVP 优先，避免过度设计 |

## 成功指标

| 指标 | 衡量方式 | 目标 |
|------|---------|------|
| **Bug 修复时间缩短** | 从发现到修复的平均时间 | 缩短 50%+ |
| **人工效率提升** | 分析/排查环节的人工耗时 | 减少 70%（4 小时 → 1 小时） |
| **知识复用率** | 命中知识库直接回复的比例 | 3 个月后达到 30%+ |
| **AI 自动修复率** | AI 提交的 MR 无需人工修改直接合并的比例 | 简单问题 80%+，复杂问题 50%+ |

## 核心风险：AI 能力是成败关键

**工程化部分**（钉钉、GitLab、Session 管理）是确定性的，一定能做。**AI 分析和修复的准确率才是产品价值的核心。**

### AI 各环节能力评估

| 环节 | 当前置信度 | 瓶颈 |
|------|:---------:|------|
| 分析问题（定位根因） | 60-70% | 缺少业务上下文，复杂调用链定位不准 |
| 制定方案（修复建议） | 50-60% | 方向通常对，但细节可能有误 |
| 修复代码（改代码） | 40-50% | 简单修复可以，复杂业务逻辑不靠谱 |
| AI Review | 70% | 能发现明显问题，细微逻辑漏洞可能漏 |

### 提升 AI 成功率的策略

| 策略 | 做法 | 预期提升 |
|------|------|---------|
| **AI 摘要精细化** | 每个类的核心逻辑、参数约束、边界条件写清楚 | 分析准确率 +10% |
| **历史修复学习** | 人工修复后存"Bug描述→实际diff"，AI 学习修复模式 | 修复成功率 +15% |
| **分级修复策略** | 简单问题（配置/SQL/枚举）AI 直接修，复杂问题出方案人工改 | 整体成功率表观 +20% |
| **测试验证重试** | AI 修完自动跑测试，不过则自动修正，最多重试 3 次 | 修复成功率 +10% |
| **prompt 工程** | 代码规范、项目惯例、常见陷阱写入 prompt | 修复质量 +10% |

### 分级路由策略（关键设计）

不是所有 Bug 都走同一个流程。**AI 自动判断 Bug 级别，不同级别走不同流程**，分级错误的代价可控（最多浪费 3 次重试后自动降级到人工）。

#### Bug 级别定义

| 级别 | 典型场景 | 预期成功率 |
|------|---------|:---------:|
| **L1 配置类** | 初始化 SQL 缺失、错误码没加、配置参数错误 | **90%+** |
| **L2 简单代码** | 空指针检查、参数校验遗漏、大小写转换 | **70-80%** |
| **L3 业务逻辑** | 流程错误、权限判断遗漏、并发问题 | **50-60%** |
| **L4 架构级** | 跨模块交互、性能优化、数据迁移 | **仅辅助** |

#### 分级路由流程

| 级别 | 流程 | 人工介入 |
|------|------|:--------:|
| **L1 配置类** | AI 分析 → AI 修复 → 自动测试 → 创建 MR → **人工合并** | 1 次 |
| **L2 简单代码** | AI 分析 → AI 修复 → 自动测试 → 创建 MR → **人工 Review + 合并** | 1 次 |
| **L3 业务逻辑** | AI 分析 → AI 出方案 → **人工确认方案** → AI 修复 → **人工 Review** → 合并 | 2 次 |
| **L4 架构级** | AI 出分析报告 → **人工全程接手** | 全程 |

#### 分级判断机制

- **AI 自动分级**：分析 Agent 在分析根因的同时输出 Bug 级别判断
- **不需要人工确认级别**：分级错误的代价是可控的（最多浪费 AI 三次重试）
- **自动降级**：L1/L2 修复失败 3 次 → 自动降级为 L3 流程（通知人工介入）

#### 失败处理

- 每个 Bug 修复在**独立 fix 分支**上进行（如 `fix/issue-123`），不污染主分支
- 修复失败 3 次 → 保留 fix 分支现状 → 通知研发接手（可在 AI 的基础上继续改，或回滚重来）
- 修复成功 → 创建 MR → 等待 Review 合并

**关键指标**：L1+L2 占 Bug 总量的 60%+，这部分做到 80% 自动修复就有很大价值。

## 已实现功能

### ChatOps 平台已有能力（可直接复用）

| 功能 | 来源 | 关键代码 | 说明 |
|------|:----:|---------|------|
| 钉钉机器人接入 | ChatOps | `adapters/im/dingtalk.ts` | Stream 模式，消息去重，sessionWebhook 缓存 |
| 飞书机器人接入 | ChatOps | `adapters/im/feishu.ts` | Webhook 模式 |
| Claude Agent 调用 | ChatOps | `agent/claude-runner.ts` | Porygon 封装 + MCP Server 子进程 |
| MCP 工具自注册 | ChatOps | `agent/tools/index.ts` | registerTool + capability 路由 |
| 会话管理 | ChatOps | `agent/session-manager.ts` | 按 groupId 管理，8h TTL，Session Resume |
| 任务队列 | ChatOps | `agent/task-queue.ts` | 串行执行 + pending_approval 暂停/恢复 |
| 意图识别 | ChatOps | `claude-runner.ts:detectIntent` | 读 capability 表做自然语言意图匹配 |
| 审批流程 | ChatOps | `approval/gate.ts` | 主备审批人 + 超时升级 + 卡片交互 |
| RBAC 权限 | ChatOps | `capabilities` + `tool_permissions` 表 | 四级角色 × 产线 × 环境 × 能力 |
| 产品线/项目/环境管理 | ChatOps | `product_lines` / `projects` / `environments` 表 | 已有 Git 地址、容器名、服务器等 |
| 流水线引擎 | ChatOps | `pipeline/executor.ts` | 多阶段 + SSH + 审批 + 重试 + 报告 |
| 定时调度 | ChatOps | `pipeline/scheduler.ts` | node-cron |
| AI 失败分析 | ChatOps | `pipeline/failure-analyzer.ts` | 脚本失败时 Claude 单轮分析原因 |
| GitLab Webhook | ChatOps | `adapters/gitlab/webhook-receiver.ts` | Pipeline 事件 → 镜像缓存 |
| 管理后台 + 前端 | ChatOps | `admin/routes/` + `web/src/pages/` | Fastify API + React SPA |

### 研发 AI 助手已实现能力（pas-error-analyzer）

| 功能 | 状态 | 入口 | 说明 |
|------|:----:|------|------|
| 错误截图分析 | ✅ | 钉钉/Web | 上传截图 + 版本号 → Claude 读代码分析 → 返回报告 |
| 多轮对话 | ✅ | 钉钉 | 同一人追问共享上下文（30 分钟 session） |
| GitLab Issue 创建/评论 | ✅ | Claude Code | 分析结果写入 GitLab Issue |

> **集成后**：pas-error-analyzer 的分析能力将迁入 ChatOps 作为 `analyze_bug` capability。

## 架构设计约束

### 与 ChatOps 平台的集成架构

```
┌─────────────────────────────────────────────────────────────────┐
│                     ChatOps 平台（已有）                          │
├──────────────────────────────────────────────────────────────────┤
│  IM 适配器（钉钉 Stream / 飞书 Webhook）                         │
│       ↓                                                        │
│  SessionManager → TaskQueue → ClaudeRunner                     │
│       ↓                                                        │
│  detectIntent → capability 路由                                 │
│       ├─ deploy / rollback / view_logs ...     ← 运维能力（已有）│
│       └─ analyze_bug / fix_bug / ai_review ... ← 研发 AI 助手   │
│       ↓                                        （新增 capability）│
│  MCP Server → Tools                                            │
│       ├─ execute_deploy / get_logs ...          ← 运维工具（已有）│
│       └─ analyze_code / create_fix / ...        ← 分析/修复工具  │
│       ↓                                        （新增 tools）    │
│  流程编排（复用 test_pipelines + test_runs）                      │
│       ├─ 测试流水线                              ← 已有          │
│       └─ Bug 修复流程（分级路由）                 ← 新增流程定义   │
│       ↓                                                        │
│  审批（复用 ApprovalGate）                                       │
│  前端管理后台（复用 + 扩展）                                      │
│  知识库（独立 Git 仓库，AI 内部使用）                              │
└─────────────────────────────────────────────────────────────────┘
```

### 新增 Capability 定义

| capability key | 显示名 | 工具集 | systemPrompt 要点 |
|---------------|--------|--------|-------------------|
| `analyze_bug` | Bug 分析 | analyze_code, search_knowledge, create_issue | 读代码定位根因 + 输出置信度 + 自动分级 + 生成修复方案 |
| `fix_bug_l1` | L1 配置修复 | fix_config, run_tests, create_mr | 直接修复 + 测试 + 提 MR |
| `fix_bug_l2` | L2 代码修复 | fix_code, run_tests, create_mr, update_ai_summary | 修复 + 测试 + 更新 AI 摘要 + 提 MR |
| `ai_review_mr` | AI Review | review_mr_diff | 独立视角审查 MR diff |

### Agent 角色隔离（映射到 ChatOps 权限体系）

```
┌─────────────────────────────────────────────────────────────┐
│                     钉钉 / GitLab Webhook                     │
└──────────┬──────────────────────────────────┬───────────────┘
           │                                  │
           ▼                                  ▼
┌─────────────────────┐            ┌─────────────────────┐
│   分析 Agent（沙箱） │            │   修复 Agent         │
├─────────────────────┤            ├─────────────────────┤
│ 权限：               │            │ 权限：               │
│  ✅ 读代码（Read）   │            │  ✅ 读写代码         │
│  ✅ 读数据库配置      │            │  ✅ Git commit/push │
│  ✅ SSH 只读命令      │            │  ✅ 运行测试         │
│  ✅ 写 GitLab 评论   │            │  ✅ 更新 AI 摘要     │
│  ❌ 不能改代码        │            │  ❌ 不接收外部消息   │
│  ❌ 不能 Git push    │            │  ❌ 不能直接操作生产  │
├─────────────────────┤            ├─────────────────────┤
│ 输入：               │            │ 输入：               │
│  钉钉消息、GitLab    │            │  L1/L2：分析报告     │
│  Issue、截图、日志    │            │  L3：审批通过的方案   │
├─────────────────────┤            ├─────────────────────┤
│ 输出：               │            │ 输出：               │
│  分析报告 + Bug 分级  │            │  代码变更 + AI 摘要更新│
│  修复方案            │            │  Git commit + MR     │
│  GitLab Issue/评论   │            │  测试结果            │
└─────────────────────┘            └─────────────────────┘
```

### 分级路由与人工卡点

**核心设计**：不同级别的 Bug 走不同流程，减少不必要的人工介入。L1/L2 走快通道，L3 保留方案审批，L4 纯辅助。

#### L1/L2 快通道（AI 直接修复）

```
GitLab Issue / 钉钉反馈
  → 分析 Agent 分析 + 自动分级（L1/L2）
  → 创建 GitLab Issue（label: fixing）
  → 修复 Agent 创建 fix 分支 → 修复代码 → 更新 AI 摘要 → 自动测试
    ├─ 测试通过 → 创建 MR → 人工 Review 合并
    └─ 3 次失败 → 自动降级为 L3 流程（通知研发接手 fix 分支）
```

#### L3 流程（方案需审批）

```
分析 Agent 分析 + 自动分级（L3）
  → 创建 GitLab Issue + 修复方案（label: needs-approval）
  → 钉钉 @模块负责人审批
  → 负责人在 GitLab 改 label 为 approved
  → Webhook 触发修复 Agent → 修复代码 → 创建 MR → 人工 Review 合并
```

#### L4 流程（纯辅助）

```
分析 Agent 分析 + 自动分级（L4）
  → 创建 GitLab Issue + 分析报告（label: needs-manual）
  → 钉钉通知研发 → 人工全程接手
```

#### 人工介入汇总

| 级别 | 人工卡点 | 说明 |
|:----:|:--------:|------|
| L1 | 1 次（合并 MR） | 配置类变更，Review 负担极低 |
| L2 | 1 次（Review + 合并 MR） | 简单代码，需要看一下改动是否合理 |
| L3 | 2 次（审批方案 + Review MR） | 业务逻辑复杂，方向错了改代码全白费 |
| L4 | 全程 | AI 仅提供分析报告 |

### 安全防护

| 风险 | 防护措施 |
|------|---------|
| 提示词注入 | 分析 Agent 在沙箱中，无法修改代码；修复 Agent 不接收外部消息 |
| 恶意 Bug 批量创建 | L1/L2 在独立 fix 分支修复，不合并主分支直到人工 Review；L3 需要人工审批方案 |
| 代码误修改 | 修复 Agent 提交到独立 fix 分支，需要 MR 审批才能合并到主分支；失败 3 次自动降级 |
| 敏感信息泄露 | 分析报告中脱敏处理（密码、密钥、IP 等） |
| Agent 权限越界 | CLI 层面限制 `--allowed-tools`，分析 Agent 不给 Edit/Write/Bash(write) |

### 多用户并发隔离

**问题**：多人同时 @机器人 分析不同产品、不同版本的代码，共享 Git 仓库会互相踩踏。

**隔离维度**：用户 × 产品 × 版本

```
/tmp/analysis/
├── userA-PAM-dev/           ← 用户A 分析 PAM dev分支
├── userA-PAM-v6.6.1.2/     ← 用户A 分析 PAM 另一个版本
├── userB-IAM-master/        ← 张三 分析 IAM master
└── userC-SDP-v3.0/          ← 李四 分析 SDP
```

**方案**：每个分析任务创建隔离的代码目录，多种方案可选。

#### 代码隔离方案对比

| 方案 | 磁盘（10 并发） | 创建速度 | 清理方式 | 对主仓库影响 | git log/blame |
|------|:-:|:-:|:-:|:-:|:-:|
| Git worktree | 5GB（每个 ~500MB） | 秒级 | `worktree remove` | 有（注册在 .git） | 可用 |
| **git clone --shared + sparse-checkout（推荐）** | **~50MB** | 秒级 | **直接 rm -rf** | **无** | 可用 |
| git archive 导出 | ~30MB | 快 | rm -rf | 无 | ❌ 不可用 |
| Docker 容器 | 大（镜像+代码） | 慢（启动容器） | docker rm | 无 | 可用 |

#### 推荐方案：git clone --shared + sparse-checkout

```bash
# 创建隔离目录（共享 objects，磁盘几乎零额外开销）
git clone --shared --no-checkout /path/to/pas-6.0 /tmp/analysis-{id}
cd /tmp/analysis-{id}
git checkout {branch} -- pas-bastion-host/ pas-common/ pas-service/

# 分析完成后直接删除，不影响主仓库
rm -rf /tmp/analysis-{id}
```

**优势**：
- `--shared` 不复制 git objects，和主仓库共享，磁盘几乎零开销
- sparse-checkout 只取分析需要的模块，不用拉整个仓库
- 清理简单：`rm -rf` 即可，不像 worktree 需要 `git worktree remove`
- 对主仓库无副作用，不会在 `.git/worktrees/` 留残留
- 支持 git log / blame / diff，分析能力完整

```
钉钉消息进来
  → 1. 识别产品（PAM / IAM / SDP）→ 确定 Git 仓库和 AI 摘要
  → 2. 识别版本（dev / v6.7.0）→ 未指定则用 develop
  → 3. 识别用户（senderId）→ session 上下文
  → 4. git worktree add --detach /tmp/analysis/{product}-{version}-{sessionId} {branch}
  → 5. claude -p（cwd = 独立工作目录）
  → 6. 分析完成 → git worktree remove
```

**产品注册表**（需要配置界面管理）：

| 产品 | Git 仓库 | AI 摘要 | 说明 |
|------|---------|---------|------|
| PAM(PAS) | PAM/java-code/pas | docs/ai-summary/ | 核心后端 |
| PAM(OSC) | PAM/java-code/osc | docs/ai-summary/osc.md | 用户权限 |
| PAM(YAUM) | PAM/java-code/yaum | docs/ai-summary/yaum.md | 统一认证 |
| PAM(BPM) | PAM/java-code/bpm | docs/architecture/bpm-server.md | 审批引擎 |
| PAM(Proxy) | PAM/java-code/proxy | docs/ai-summary/ssh-proxy.md, rdp-proxy.md | 代理服务 |
| IAM | IAM/java-code/iam | 待生成 | 待接入 |
| SDP | SDP/java-code/sdp | 待生成 | 待接入 |
| PASG | PAM/java-code/pasg | 待生成 | 待接入 |

新产品接入流程：配置 Git 地址 → 自动 clone → 自动生成 AI 摘要 → 可分析

### Claude CLI Session 保持

**问题**：当前每次调用 `claude -p` 都是无状态的新进程，追问时要重新读文档和代码，耗时且浪费 token。

**方案**：利用 Claude CLI 的 `--resume` 参数保持会话。

```
用户首次提问：
  → claude -p "分析这个错误" --output-format stream-json
  → 记录返回的 session_id

用户追问：
  → claude -p "还有其他原因吗" --resume {session_id}
  → 直接基于上下文回答，不需要重新读文档
```

**Session 维度**：senderId + product（同一个人分析同一个产品共享 session）

**生命周期**：

```
用户提问 → 创建 worktree + session
    │
    ├─ 用户追问 → 复用 worktree + --resume session
    │
    ├─ 30 分钟无活动 → session 标记过期（worktree 保留）
    │   └─ 用户再追问 → 新建 session，但 worktree 代码还在，不用重新 checkout
    │
    ├─ 2 小时无活动 → 强制清理 worktree + 丢弃 session
    │
    └─ 兜底：每天凌晨 3 点清理所有 /tmp/analysis-* 目录
```

**两级回收机制**：
| 级别 | 超时 | 回收内容 | 用户追问时 |
|------|------|---------|-----------|
| 一级 | 30 分钟 | session 过期 | 新建 session，worktree 还在可复用 |
| 二级 | 2 小时 | session + worktree 全清 | 需要重新 checkout |
| 兜底 | 凌晨 3 点 | 清理所有临时目录 | 防止磁盘泄漏 |

**效果对比**：

| | 无 session（当前） | 有 session |
|---|:-:|:-:|
| 追问响应 | 4 分钟（从零开始） | 秒级 |
| Token 消耗 | 每次全量 prompt | 增量 |
| 上下文理解 | 无 | 有，越聊越精准 |

### 单机器人多 Agent 路由

**设计**：一个钉钉机器人，根据消息内容路由到不同 Agent，通过 `--allowed-tools` 硬限制权限。

```
钉钉机器人（一个 clientId）
    │
    ├─ "分析错误" / 截图        → 分析 Agent（Read,Glob,Grep）
    ├─ "修复 #123"             → 修复 Agent（Read,Edit,Write,Bash）
    ├─ "检查服务状态"           → 运维 Agent（Read,Bash）
    └─ "写升级 SQL"            → 工具 Agent（Read,Grep,Write）
```

| Agent | allowed-tools | 能做 | 不能做 |
|-------|--------------|------|--------|
| 分析 | Read,Glob,Grep | 读代码、搜索 | 改文件、执行命令 |
| 修复 | Read,Edit,Write,Bash,Glob,Grep | 改代码、跑测试 | 直接 push |
| 运维 | Read,Bash | SSH 查日志、查状态 | 改代码 |
| 工具 | Read,Grep,Glob,Write | 生成 SQL/文档 | 执行 SQL、改业务代码 |

**权限靠 CLI 参数强制限制**，不靠提示词，提示词注入也绕不过去。

## 产品功能闭环

从一个问题的完整生命周期：

```
发现问题 → 分析问题 → [判断分类] → 记录问题 → AI 分级 → [按级别路由] → 修复代码 → AI Review → 人工 Review → 测试验证 → 发布上线 → 沉淀知识
```

**注意**：先分析再记录。分析后判断是 Bug 才创建 Issue，配置/使用问题直接回复不记录。

| 节点 | 触发 | AI 做什么 | 输出 | 状态 |
|------|------|----------|------|:----:|
| **1. 发现问题** | 钉钉反馈 / 监控告警 / 日志采集 / 自动化测试失败 / 回归测试 / 安全扫描 | 接收并理解问题 | 结构化问题描述 | ✅ |
| **2. 分析问题** | 自动触发 | 读代码、读日志、定位根因 | 分析报告 + 问题分类 | ✅ |
| **3. 判断分类** | 分析完自动判断 | 区分是 Bug / 配置问题 / 使用问题 | 只有 Bug 才进入后续流程 | ⚠️ 待实现 |
| **4. 记录问题** | 确认是 Bug 后 | 创建 GitLab Issue（关联产品/版本/标签） | Issue ID + 链接 | ✅ |
| **5. AI 分级** | 自动触发 | 判断 Bug 级别（L1-L4），决定后续路由 | Bug 级别 + Issue label | ⚠️ 待实现 |
| **6. 方案审批** | **仅 L3**：钉钉 @模块负责人 | L1/L2 跳过此步；L3 研发确认方案 | Issue label → `approved` | ⚠️ 待实现 |
| **7. 修复代码** | L1/L2：分级后自动触发；L3：审批通过后触发 | 修复 Agent 在 fix 分支改代码、写测试、更新 AI 摘要、创建 MR | Git commit + MR | ❌ 待实现 |
| **8. AI Review** | MR 创建后（独立 Review Agent） | 不同于修复 Agent 的视角检查：方案一致性、遗漏、质量、安全 | ai-approved / ai-needs-attention | ❌ 待实现 |
| **9. 人工 Review** | AI Review 完成后 | 研发看 AI 标记的重点，快速审批 | MR approved | ❌ 待实现 |
| **10. 测试验证** | MR approved 后，分两阶段 | 阶段一：Pipeline 单元测试（不过 AI 自动修正重试 3 次）；阶段二：合并测试分支 → 部署测试环境 → 集成/E2E 测试 | 测试报告 | ❌ 待实现 |
| **11. 发布上线** | 集成测试通过 | 创建 MR 到主分支 → 人工 Review 合并 → Issue 自动关闭 | 状态流转 | ❌ 待实现 |
| **12. 沉淀知识** | Issue 关闭后 | 问题+方案+修复 diff 存入知识库（AI 摘要已在步骤 7 随代码一起更新） | 知识条目 | ❌ 待实现 |

### 闭环中的人工卡点

根据 Bug 级别，人工介入次数不同：

| 级别 | 卡点 | 为什么 | AI 怎么辅助 |
|:----:|------|--------|-----------|
| **L1/L2** | 人工 Review MR（1 次） | 代码合并必须有人把关 | AI Review Agent 先过一遍，标记重点；L1 配置类 Review 负担极低 |
| **L3** | 审批方案 + Review MR（2 次） | 业务逻辑复杂，方向错了改代码全白费 | 按模块自动 @负责人，标注 Bug 级别和置信度 |
| **L4** | 全程人工 | AI 仅辅助分析 | 自动生成分析报告 |
| **所有级别** | 合并主分支 | 发布必须有人确认 | 自动生成 Release Notes 辅助决策 |

### 审批通知机制

按模块配置负责人，分析定位到哪个模块就 @谁：

```
分析定位到 pas-bastion-host 模块，分级为 L3
  → 查模块→负责人映射表 → 负责人: liaoss
  → 钉钉 @liaoss "Issue #xx（L3）方案已生成，请审批"
  → liaoss 在 GitLab 改 label 为 approved
  → Webhook 触发修复 Agent

分析定位到 pas-secret-task 模块，分级为 L2
  → 创建 Issue（label: fixing）
  → 修复 Agent 自动开始修复（无需审批）
  → 修复完成 → 钉钉 @hanff "Issue #xx（L2）MR 已创建，请 Review"
```

模块→负责人映射表（需要配置界面管理）：

| 模块 | 负责人 | 钉钉 userId |
|------|--------|-----------|
| pas-bastion-host | liaoss | 待配置 |
| pas-secret-task | hanff | 183832601538060368 |
| pas-service | — | 待配置 |
| osc-* | — | 待配置 |
| yaum-* | — | 待配置 |

### 测试验证流程

```
修复 Agent 在 fix 分支完成修复
  │
  ├─ Pipeline 1：单元测试
  │   ├─ 不通过 → AI 自动修正（最多重试 3 次）
  │   │   └─ 3 次仍不过 → 自动降级：通知研发接手 fix 分支
  │   └─ 通过 ↓
  │
  ├─ 创建 MR → AI Review → 人工 Review
  │
  ├─ 合并到测试分支 → 自动部署测试环境
  │
  ├─ Pipeline 2：集成测试 / E2E 测试
  │   ├─ 不通过 → 通知研发介入
  │   └─ 通过 ↓
  │
  └─ 创建 MR（目标：主分支）→ 人工 Review → 合并 → Issue 自动关闭
```

### AI Review 设计

**修复 Agent 和 Review Agent 必须是独立角色**（类似 BMAD 的 code-reviewer）：

| | 修复 Agent | Review Agent |
|---|---|---|
| 视角 | "怎么改能修好" | "这个改动有没有问题" |
| Prompt | 修复方案 + 代码规范 | 审查清单 + 常见陷阱 |
| 输入 | Bug 描述 + 方案文档 | MR diff + 原方案 |
| 输出 | 代码变更 + MR | 评论 + 标签 |

自己 review 自己有盲点，独立 Agent 用不同视角检查更可靠。

### 事件驱动编排

用 **GitLab Issue labels** 作为状态机驱动流转：

```
┌──────────────────────────────────────────────────┐
│                  编排器（Orchestrator）              │
│                                                    │
│  监听事件源：                                        │
│  ├─ 钉钉 Stream（用户消息）                          │
│  ├─ GitLab Webhook（Issue/MR/Pipeline 事件）        │
│  └─ 定时任务（日志采集、巡检）                        │
│                                                    │
│  状态流转（Issue labels）：                           │
│  needs-analysis → analyzing → graded               │
│  → L1/L2: fixing → in-review → testing             │
│  → L3: needs-approval → approved → fixing → ...    │
│  → L4: needs-manual                                │
│  → ready-to-merge → merged → done                  │
└──────────────────────────────────────────────────┘
```

## 需求清单

### P0 - 核心场景

#### 1. Bug 自动分析 + 分级
- **触发**：GitLab Issue 创建（Webhook）/ 钉钉反馈后自动创建 Issue
- **动作**：读 Issue 详情 → 下载截图 → 切到对应版本 → Claude 分析 → 自动分级（L1-L4）→ 方案写入 Issue 评论 → 按级别路由后续流程
- **价值**：新 Bug 无需人工介入，自动产出分析报告并启动修复流程

#### 2. 代码提交关联 Issue
- **触发**：Git push 后 webhook（GitLab CI）
- **动作**：解析 commit message 中的 Issue ID（如 `#123` 或 `closes #123`）→ GitLab API 自动关闭对应 Issue
- **价值**：开发提交代码后 Issue 状态自动流转，不需要手动操作

#### 3. 钉钉错误分析（已实现，待优化）
- **触发**：钉钉 @机器人 + 截图/文字描述
- **动作**：Claude 分析 → 回复钉钉
- **优化方向**：分析速度（当前 4 分钟）、进度实时推送、引用回复解析

### P1 - 效率工具

#### 4. 代码 Review
- **触发**：钉钉发 MR/PR 链接
- **动作**：读取 MR diff → 分析代码变更 → 检查风险点（空指针、SQL 注入、性能问题） → 回复 review 意见
- **价值**：辅助 code review，降低遗漏率

#### 5. 发版影响分析
- **触发**：钉钉说"检查 v6.7.0 和 v6.6.1 的差异"
- **动作**：git diff 两个版本 → 列出改动模块、影响的接口、数据库变更 → 评估风险
- **价值**：发版前快速了解改动范围，辅助测试计划制定

#### 6. SQL 审计
- **触发**：钉钉发 SQL 脚本
- **动作**：检查 SQL 语法、性能（缺索引、全表扫描）、安全性（注入风险）、与现有表结构兼容性
- **价值**：数据库变更前的自动审查

### P2 - 运维场景

#### 7. 环境巡检
- **触发**：定时（每天早上）或钉钉手动触发
- **动作**：SSH 到目标服务器 → 检查服务状态、端口、磁盘、日志异常 → 输出巡检报告
- **价值**：替代人工巡检，提前发现问题

#### 8. 值班告警处理
- **触发**：钉钉收到监控告警（Prometheus/Grafana）
- **动作**：自动 SSH 查日志 → 关联代码分析原因 → 给出处理建议 → 回复钉钉
- **价值**：告警响应从"看到 → 登录 → 查日志 → 分析"缩短为自动化

#### 9. 环境探测排障
- **触发**：钉钉说"检查 192.168.8.173 的服务状态"
- **动作**：SSH 连接 → 检查端口、进程、Docker 容器、网络连通性、防火墙规则 → 报告
- **价值**：远程排障不需要手动 SSH，类似今晚排查 173 代理机的过程自动化

#### 钉钉问题转 GitLab Issue
- **触发**：钉钉群里 @机器人 说"转 Bug" / 分析完成后自动提示是否创建 Issue
- **动作**：提取钉钉消息中的问题描述、截图、环境信息、版本号 → 调 GitLab API 创建 Issue（自动填写标题、复现步骤、产品标签、严重级别标签） → 如果已有分析结果，一并写入评论 → 回复钉钉 Issue 链接
- **价值**：客户/测试在钉钉群反馈的问题直接转为 GitLab Issue，不需要手动填表，信息不丢失

### P1.5 - 安全合规

#### 依赖漏洞扫描与修复
- **触发**：定时（每周）/ 钉钉手动触发 / 新版本发布前
- **动作**：扫描 pom.xml 中的依赖 → 查询 CVE 漏洞库 → 评估影响（哪些模块用了、是否可被利用） → 给出升级方案（目标版本、兼容性风险） → 可选自动提交 PR
- **价值**：安全合规要求，客户（银行/国企）定期要求提供漏洞修复报告

#### 初始化 SQL 生成
- **触发**：钉钉说"生成 xxx 功能的初始化 SQL" / 代码提交后检测到新增枚举/配置
- **动作**：读代码中新增的错误码、权限资源、平台配置、字典项等 → 结合现有 SQL 脚本规范（`sql/` 目录命名格式 `YYYYMMDDHHmm.sql`） → 自动生成 INSERT 语句 → 支持 MySQL/PostgreSQL/达梦多数据库方言
- **价值**：新功能上线经常忘记写初始化脚本，导致部署后报错（如配置缺失、错误码不存在）

### P2.5 - 质量保障

#### 10. 运行日志采集分析
- **触发**：定时采集 / 钉钉手动触发 / 告警联动
- **动作**：SSH 采集目标环境的运行日志（PAS/OSC/YAUM/代理服务） → 提取 ERROR/WARN/异常堆栈 → 关联代码定位问题 → 判断是代码 Bug 还是环境/配置问题 → 输出分析报告
- **价值**：不依赖用户截图上报，主动发现生产环境的潜在代码问题（如空指针、SQL 异常、连接泄漏），在用户感知之前修复

### P3 - 知识沉淀

#### 10. 新人答疑
- **触发**：钉钉提问代码/架构问题
- **动作**：读架构文档 + AI 摘要 + 代码 → 解释逻辑、画调用链、给出示例
- **价值**：新人入职快速了解系统，不需要反复问老员工

#### 11. 知识库沉淀
- **触发**：每次分析完成后自动触发
- **动作**：将分析结果（错误描述 + 根因 + 修复方案）存入知识库 → 新问题先匹配历史
- **价值**：同类问题秒回，分析时间从 4 分钟降到 0

**知识库存储方案**：

```
知识条目（Markdown + JSON）→ Git 仓库（轻量，版本控制）
图片附件              → 对象存储（MinIO/OSS/本地目录，不进 Git）
```

为什么分开：
- Markdown 文件 3-5 年内不超过 5000 条（~250MB），grep 搜索毫秒级，Git 管理没问题
- 图片每个 200KB-2MB，1000 条 Bug 就可能有 2GB+，放 Git 会导致仓库膨胀、clone 变慢

目录结构：
```
docs/knowledge/
├── index.json                  ← 索引文件，关键词/错误码/模块快速匹配
├── pas/
│   ├── pgsql-case.md           ← 问题描述 + 根因 + 方案 + 截图文字描述
│   ├── rdp-520.md
│   └── websocket-502.md
└── osc/
    └── rbac-denied.md

/opt/knowledge/images/          ← 图片存储（不进 Git）
├── pas/
│   ├── pgsql-case-1.png
│   └── rdp-520-1.png
└── osc/
```

索引文件（index.json）：
```json
[
  {
    "id": "pgsql-case",
    "keywords": ["pgsql", "postgresql", "大小写", "验密失败", "create user"],
    "errorCodes": ["TASK_PWD_4001"],
    "modules": ["pas-secret-task", "Jdbc4Protocol"],
    "product": "PAM",
    "file": "pas/pgsql-case.md"
  }
]
```

查询流程：
```
用户问题进来
  → 提取关键词/错误码/模块名
  → 匹配 index.json
    → 命中 → 读对应 Markdown → 直接回复（秒级）
    → 未命中 → 走完整分析流程（4分钟）→ 分析完自动写入知识库
```

图片处理：
- 分析时 Claude 生成截图的**文字描述**写在 Markdown 里
- 原始图片存到对象存储，Markdown 用 URL 引用
- 搜索匹配用文字描述，不依赖图片

量级预估与演进：
| 阶段 | 条目数 | 存储方案 |
|------|:------:|---------|
| 当前~2 年 | <1000 | Markdown + JSON 文件，grep 搜索 |
| 2~5 年 | 1000-5000 | 同上，仍然够用 |
| 5000+ | 超过 | 迁移到 SQLite 全文检索或向量数据库 |

#### 12. AI 摘要随代码同步更新
- **触发**：修复 Agent 修改代码时自动触发（不是独立需求，而是修复工作流的一部分）
- **动作**：修复 Agent 改完代码后 → 检测变更涉及的模块 → 更新对应的 AI 摘要文档 → 和代码变更一起提交到 fix 分支
- **价值**：AI 摘要始终和代码同步，零额外维护成本，分析准确率不会因摘要过时而下降

## 产品战略（头脑风暴产出）

> 来源：2026-04-14 头脑风暴，完整记录见 `_bmad-output/brainstorming/brainstorming-session-2026-04-14.md`

### 产品三层进化路径

```
第一层：研发效率工具（MVP，当前阶段）
  — Bug 自动分析、L1/L2 自动修复、知识库秒回
  — 先 PAM 内部跑通，验证成效

第二层：全产品知识大脑
  — 对接钉钉文档、操作手册、白皮书等全量知识源
  — 服务全角色：产品、售前、交付、研发
  — 通过 MCP/CLI 对接外部系统（"装上手脚"）

第三层：越用越值钱的平台
  — 客户知识库积累在平台上，迁移成本高
  — 数据壁垒 + 生态锁定，不是技术壁垒
```

### 核心壁垒：B+C

技术编排层没有壁垒（"大自然的搬运工"），真正的护城河是：
- **B — 工程化编排层**：分级路由、Agent 协作、知识库、工作流，做得深才有价值
- **C — 垂直领域数据**：AI 摘要、知识库、修复模式积累，用得越久越值钱

模型层设计为**可插拔**，支持多模型切换（客户可能无法使用 Claude，需支持国产/私有化模型）。

### 竞品差异化（对比 Devin 等）

| 维度 | Devin/Copilot Workspace | 本产品 |
|------|------------------------|--------|
| 私有化部署 | 不支持 | **支持**（银行/国企硬需求） |
| 全代码库知识 | 临时分析，用完即走 | **常驻**，持续积累知识库 |
| MR 之后的流程 | 到 MR 就结束 | **全流程**：测试、发布、知识沉淀 |
| 定位 | "AI 外包" | **"AI 正式员工"**，越待越值钱 |

### Bug 根因归因机制

每个 Bug 是信息链条的诊断机会，追溯根因驱动知识体系进化：

```
需求描述 → prompt → AI 摘要 → AI 理解 → AI 写代码
```

| Bug 根因 | 说明什么 | 该优化什么 |
|---------|---------|-----------|
| 纯语法/空指针 | AI 编码能力不足 | 换模型或加代码规范 |
| 业务逻辑错误 | prompt/摘要没说清业务规则 | 补充 AI 摘要的业务约束 |
| 需求理解偏差 | PRD 描述模糊或遗漏 | 反推需求文档质量 |
| 边界条件遗漏 | 场景覆盖不足 | 补充测试用例模板 |
| 跨模块冲突 | 依赖关系没文档化 | 补充架构约束到 AI 摘要 |

### 知识库主动建设

不等 Bug 喂数据，AI 主动初始化知识库：
- 接入新项目时，AI 先全量扫描分析，生成初始知识库
- 能自动补充的（代码结构、模块关系、常见模式）AI 自己补
- 需要业务理解的，AI 提出问题由人回答后补充

### 文档分层架构

AI 分析/修复时的文档上下文由三层组成，**前两层是必选，第三层是增强项**：

```
必选层 1 — AI 摘要（跟代码仓库走）：
  pas-6.0/docs/ai/           ← AI 自动生成，每个版本/分支独立生成
  ├── INDEX.md                   不需要人管，Token 的事情
  ├── bastion-host.md
  └── secret.md

必选层 2 — 代码本身：
  Agent clone 代码后直接读

增强层 — 知识库仓库（独立 Git 仓库，不跟版本走）：
  pam-knowledge.git
  ├── guide/                  ← 人写的业务逻辑说明（一处编写，元数据匹配版本）
  │   └── password-rotation.md
  ├── knowledge/              ← AI 自动沉淀的历史 Bug 知识条目
  │   └── pas/pgsql-case.md
  └── index.json              ← 索引（关键词/模块/版本范围匹配）
```

#### 版本匹配策略

人写的文档不需要放进每个代码分支。**人只写一份，通过 index.json 元数据做版本匹配**：

```json
{
  "id": "password-rotation-logic",
  "type": "guide",
  "modules": ["pas-secret-task"],
  "versions": ">=6.5",
  "file": "guide/password-rotation.md"
}
```

Agent 分析时：
1. clone 代码仓库（切到对应版本）→ 读 `docs/ai/`（AI 摘要）
2. 查询知识库 index.json → 按模块 + 版本匹配 → 拉取匹配的 guide 和 knowledge 文档
3. 合并为上下文

#### 文档编辑入口

| 文档类型 | 谁写 | 编辑入口 | 提交方式 |
|---------|------|---------|---------|
| AI 摘要 | AI 自动 | 修复 Agent 改代码时同步更新 | 随代码一起提交到 fix 分支 |
| 业务逻辑说明 | 人 | ChatOps 管理后台 Web 编辑器（远期）/ 直接 Git 提交 | 提交到知识库仓库 |
| 历史 Bug 知识 | AI 自动 | Issue 关闭后自动生成 | 自动提交到知识库仓库 |

#### 文档更新权限

AI 摘要和业务逻辑说明**AI 都可以改，人来 Review**（通过 MR）。

### 流程环节可选

12 节点闭环不强制全部走完，支持**最小 MVP 模式**：
- 最小闭环：分析 → 记录 Issue → 人工修复（AI 只做分析）
- 标准闭环：分析 → 分级 → 自动修复 → Review → 合并
- 完整闭环：全 12 节点

用户可根据团队成熟度和信任度，逐步开启更多环节。

### 置信度标签

AI 分析报告自标可信度，管理用户预期：
- **高置信度（80%+）**：直接参考，L1/L2 可自动进入修复流程
- **中置信度（50-80%）**：建议人工复核关键判断
- **低置信度（<50%）**：仅供参考，建议人工分析

防止因偶尔分析不准导致用户对整个产品失去信任。

### 方案先行

分析阶段不只输出"根因是什么"，同时输出"建议怎么修"：
- 分析 Agent 在定位根因的同时，生成结构化修复方案
- 修复 Agent 基于方案执行，不是从头理解问题
- 减少修复 Agent 的理解偏差，提高修复成功率

### 价值量化

AI 自证价值的数据能力（远期）：
- 平均分析耗时、修复耗时趋势
- AI 修复成功率（按 L1-L4 分级统计）
- 知识库命中率
- 人工节省工时估算

## 实施路线图

> 标注 `[ChatOps 已有]` 表示复用平台现有能力，`[新增]` 表示需要新开发，`[扩展]` 表示在现有代码基础上扩展。

### 里程碑 0：平台基础设施扩展（在 ChatOps 上为研发 AI 助手做准备）

| 序号 | 任务 | 类型 | 说明 |
|:----:|------|:----:|------|
| 0.1 | **图片消息支持** | [扩展] | NormalizedMessage 增加 images 字段，DingTalkAdapter 下载图片 base64 |
| 0.2 | **扩展 stage 类型** | [扩展] | test_pipelines 的 stage 类型从 `script/approval` 扩展到 `capability/wait_webhook` |
| 0.3 | **注册研发 AI 助手 capabilities** | [新增] | 数据库插入 analyze_bug / fix_bug_l1 / fix_bug_l2 / ai_review_mr 等 capability |
| 0.4 | **Bug 修复流程实例页面** | [扩展] | 复用/扩展 TestRunsPage，展示每个 Bug 的流程进度 |

**交付标准**：ChatOps 平台具备承接研发 AI 助手的能力，新 capability 注册完毕，前端能看到 Bug 修复实例

### 里程碑 1：分析闭环（让"分析"做到极致）

在自动修复之前，先把分析链路做扎实。分析准确率是一切的基础。即使不做自动修复，光分析能力就已经对交付/售后有价值。

| 序号 | 任务 | 类型 | 说明 | 依赖 |
|:----:|------|:----:|------|------|
| 1.1 | **知识库仓库搭建** | [新增] | 每个产品独立 Git 仓库（pam-knowledge.git 等），AI 扫描生成初始知识条目 | 无 |
| 1.2 | **analyze_bug 工具集** | [新增] | MCP 工具：读代码、搜索知识库、创建 Issue、下载截图分析 | 0.1, 0.3 |
| 1.3 | **置信度标签** | [新增] | 分析报告输出时自标置信度（高/中/低） | 1.2 |
| 1.4 | **方案先行** | [新增] | 分析 Agent 输出根因的同时输出结构化修复方案 + 自动分级（L1-L4） | 1.2 |
| 1.5 | **知识库查询命中** | [新增] | 新问题先匹配知识库 index.json，命中则秒回 | 1.1 |
| 1.6 | **GitLab Issue Webhook 驱动** | [扩展] | 在现有 GitLabWebhookReceiver 上扩展 Issue 事件监听 | 无 |

**交付标准**：钉钉 @机器人 → 秒回（知识库命中）或 分析报告 + 置信度 + Bug 级别 + 修复方案

### 里程碑 2：修复闭环（L1/L2 快通道）

分析闭环稳定后，接上修复能力。核心差异化阶段。

| 序号 | 任务 | 类型 | 说明 | 依赖 |
|:----:|------|:----:|------|------|
| 2.1 | **修复 Agent 工具集** | [新增] | MCP 工具：改代码、运行测试、创建 MR、更新 AI 摘要 | 里程碑 1 |
| 2.2 | **Bug 修复流程定义** | [扩展] | 在 test_pipelines 中定义 L1/L2/L3 修复流程模板（stages JSONB） | 0.2 |
| 2.3 | **失败降级机制** | [新增] | 3 次重试不过 → 自动降级为 L3（通知研发接手 fix 分支） | 2.1 |
| 2.4 | **AI 摘要随修复更新** | [新增] | 修复工具改代码时同步更新 AI 摘要，一起提交 | 2.1 |
| 2.5 | **AI Review Agent** | [新增] | 独立 capability（ai_review_mr），审查 MR diff | 2.1 |
| 2.6 | **审批流程（L3）** | [ChatOps 已有] | 复用 ApprovalGate，L3 方案审批 → 修复 | 2.2 |

**交付标准**：L1 Bug 从 Issue 创建到 MR 创建全自动，L2 半自动（需人工 Review MR）

### 里程碑 3：进化闭环（让系统越来越聪明）

飞轮转起来，越用越值钱。

| 序号 | 任务 | 类型 | 说明 | 依赖 |
|:----:|------|:----:|------|------|
| 3.1 | **Bug 根因归因** | [新增] | 每个 Bug 标记根因类型（需求/prompt/摘要/编码），驱动知识体系优化 | 里程碑 2 |
| 3.2 | **知识库自动沉淀** | [新增] | Issue 关闭后自动生成知识条目，写入产品知识仓库 | 里程碑 2 |
| 3.3 | **价值量化仪表盘** | [新增] | 修复成功率、知识库命中率、平均耗时趋势 | 3.1, 3.2 |
| 3.4 | **L3 流程（方案审批）** | [扩展] | 在流程编排中串联 approval stage + fix capability | 里程碑 2 |
| 3.5 | **多模型可插拔** | [扩展] | 抽象 Porygon backend 层，支持模型切换 | 推客户前 |

**交付标准**：Bug 根因可追溯、知识库自动增长、AI 成效可量化

### 里程碑关系

```
里程碑 0（平台扩展）     里程碑 1（分析闭环）     里程碑 2（修复闭环）     里程碑 3（进化闭环）
  图片 + stage 扩展   →   分析 + 方案 + 分级  →   自动修复 + Review   →   归因 + 知识沉淀 + 量化
  + capability 注册      独立可用，已有价值       核心差异化              越用越值钱的飞轮
  + 前端实例页面
```

每个里程碑完成后都可以停下来评估成效，不用一口气做完。

## 技术依赖

| 依赖 | 当前状态 | 来源 |
|------|---------|------|
| Claude Code CLI + Porygon | ✅ 已集成 | ChatOps 已有 |
| 钉钉 Stream SDK | ✅ 已集成 | ChatOps 已有 |
| 飞书 SDK | ✅ 已集成 | ChatOps 已有 |
| MCP Server（自定义工具） | ✅ 已集成 | ChatOps 已有 |
| GitLab API | ✅ 已对接（Issue 创建/编辑/关闭/评论） | ChatOps 已有 |
| GitLab Webhook（Pipeline 事件） | ✅ 已对接 | ChatOps 已有 |
| GitLab Webhook（Issue 事件） | ❌ 待扩展 | 在现有 webhook-receiver 上扩展 |
| PostgreSQL + Repository | ✅ 已集成 | ChatOps 已有 |
| 审批流程（ApprovalGate） | ✅ 已集成 | ChatOps 已有 |
| 流水线引擎（test_pipelines） | ✅ 已集成 | ChatOps 已有，stage 类型需扩展 |
| RBAC 权限体系 | ✅ 已集成 | ChatOps 已有 |
| 管理后台 + 前端 | ✅ 已集成 | ChatOps 已有，需扩展 Bug 修复实例页面 |
| SSH 远程执行 | ✅ 已集成 | ChatOps 已有 |
| 图片消息处理 | ❌ 待开发 | NormalizedMessage + DingTalkAdapter 扩展 |
| 知识库存储 | ⚠️ 已设计（独立 Git 仓库 + index.json），待实现 | 新增 |
| 对象存储（图片） | ❌ 待部署（MinIO/OSS/本地目录） | 新增 |
| Prometheus/Grafana | ❌ 待对接 | 远期 |

## 文档索引

| 文档 | 路径 |
|------|------|
| ChatOps 平台架构（AI 摘要） | `docs/ai-summary/chatops.md` |
| 钉钉集成设计 | `pas-error-analyzer/docs/design-dingtalk-integration.md` |
| GitLab API 集成 | `docs/integration/gitlab-api.md` |
| AI 摘要文档 | `docs/ai-summary/` |
| Bug 修复方案 | `docs/bugfix/` |
| 产品需求清单 | `docs/product/ai-assistant-requirements.md`（本文档） |
| 头脑风暴记录 | `_bmad-output/brainstorming/brainstorming-session-2026-04-14.md` |

---

*最后更新：2026-04-15*
*持续补充中*
