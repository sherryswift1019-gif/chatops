# ChatOps 平台设计文档

**日期：** 2026-04-11  
**状态：** 已确认  
**阶段：** Phase 1 完整规格 + Phase 2/3 扩展接口定义

---

## 1. 项目概述

以 Claude Code SDK 为大脑，以 IM 工具（钉钉、飞书）为交互界面，构建一个 AI 驱动的 DevSecOps 平台。用户在 IM 群中使用自然语言 @机器人，机器人通过 Claude Code Agent 理解意图、调用工具执行运维与研发任务，高风险操作须经人工审核后方可执行。

### 阶段规划

| 阶段 | 内容 | 说明 |
|------|------|------|
| Phase 1 | ChatOps 核心 | IM 接入、部署/日志/GitLab/Harbor 联动、RBAC、审核门 |
| Phase 2 | AI Dev 助手 | Bug 分析定位、代码审查、MR 审核、需求文档审核 |
| Phase 3 | 研发自动化 | 自动 Bug 修复、需求代码生成、自动化测试生成 |

本文档 Phase 1 为完整规格，Phase 2/3 定义扩展接口，不详细展开实现。

---

## 2. 技术栈

| 层次 | 选型 |
|------|------|
| 运行时 | Node.js (TypeScript) |
| AI 大脑 | Claude Code SDK (`@anthropic-ai/claude-code`) |
| 数据库 | PostgreSQL |
| IM 接入 | 钉钉 Outgoing Robot + Feishu Event Subscription |
| 容器编排 | kubectl / Helm（K8s）、Docker CLI（纯 Docker） |
| 镜像仓库 | Harbor API |
| 代码平台 | GitLab API + Webhook |

---

## 3. 整体架构

```
┌─────────────────────────────────────────────────────┐
│                   IM 适配器层                        │
│   DingTalkAdapter          FeishuAdapter             │
│         └──────────┬───────────┘                    │
│               IMAdapter 接口                         │
└─────────────────────┬───────────────────────────────┘
                      │ 统一消息事件
┌─────────────────────▼───────────────────────────────┐
│                 Session Manager                      │
│  群组 ID ↔ Claude Code Session 映射                  │
│  Task 状态机  |  并发队列  |  Session 持久化          │
└─────────────────────┬───────────────────────────────┘
                      │
┌─────────────────────▼───────────────────────────────┐
│             Claude Code Agent（大脑）                │
│                                                      │
│  DeployTool  LogTool  GitLabTool  HarborTool         │
│  CodeTool    ApprovalTool  RoleTool                  │
└──────┬───────────────────────────┬──────────────────┘
       │ 高风险操作触发              │ 工具执行
┌──────▼──────────────┐   ┌────────▼─────────────────┐
│   Approval Gate     │   │   异步任务执行器           │
│  审核规则路由        │   │   kubectl / docker / API  │
│  私信主审 → 备审    │   │   结果流式推回 IM          │
└──────┬──────────────┘   └──────────────────────────┘
       │
┌──────▼──────────────────────────────────────────────┐
│                  PostgreSQL                          │
│  users_roles | approval_rules | tasks                │
│  deployments | image_cache | gitlab_events           │
└─────────────────────────────────────────────────────┘

另：GitLab Webhook Receiver 独立监听，接收事件后更新 image_cache 和 gitlab_events。
```

---

## 4. IM 适配器层

### IMAdapter 接口

```typescript
interface IMAdapter {
  platform: 'dingtalk' | 'feishu'
  onMessage(handler: MessageHandler): void
  sendMessage(target: MessageTarget, content: TextContent): Promise<void>
  sendCard(target: MessageTarget, card: InteractiveCard): Promise<void>
  sendDirectMessage(userId: string, content: TextContent | InteractiveCard): Promise<void>
  getUserInfo(userId: string): Promise<UserInfo>
  onCardAction(handler: CardActionHandler): void
}

interface MessageTarget {
  type: 'group' | 'user'
  id: string
}

interface NormalizedMessage {
  platform: 'dingtalk' | 'feishu'
  groupId: string
  userId: string
  userName: string
  text: string         // @bot 过滤后的纯文本
  timestamp: number
  rawPayload: unknown
}
```

### 钉钉适配器

- 接收 Outgoing Robot Webhook POST 请求
- 验签（sign token）
- 回复使用 `webhook` 回调 URL（同步回复）或 `access_token` 主动发送

### 飞书适配器

- 订阅 `im.message.receive_v1` 事件
- 验证 `Verification Token`
- 使用飞书消息 API 主动发送

---

## 5. Session Manager

### Session 粒度

- **以 IM 群组为单位**，同一群共享一个 Claude Code Session
- Session 保留上下文：当前讨论的项目、最近部署记录、群内角色信息

### 任务状态机

每条操作请求对应一个独立 `Task`：

```
pending_approval → approved → queued → executing → done
                → rejected → cancelled
                → timeout  → escalated → [pending_approval / rejected]
```

### 并发规则

| Task 状态 | 是否阻塞新任务进入 |
|-----------|----------------|
| `pending_approval` | **不阻塞**，群内其他操作照常处理 |
| `executing` | **阻塞**，新任务进入 `queued` 排队等待 |
| `queued` | 等待前一 `executing` 完成后自动启动 |

**示例：**
```
T+00: 张三触发"部署 user-service → prod"     → pending_approval（等审核）
T+01: 王五触发"部署 order-service → test"    → executing（直接执行）
T+03: 赵六触发"查询 payment 日志"            → queued（等 T+01 完成）
T+05: 审核人批准 T+00 的任务                 → queued（排在赵六之后）
```

### Session 生命周期

- 首次消息到达时创建
- 元数据（任务历史、角色绑定）持久化到 PostgreSQL
- Claude Code 上下文存内存；服务重启后，从 DB 读取该群最近 N 条任务历史，重新构建摘要上下文注入新 Session（不恢复完整对话，仅恢复关键状态：当前项目、最近部署、角色信息）
- 群组 24 小时无消息后，Session 自动释放

---

## 6. Claude Code Agent

### 工具清单（Phase 1）

| 工具 | 风险等级 | 描述 |
|------|---------|------|
| `QueryDeploymentsTool` | 低 | 查询部署历史、当前运行版本 |
| `ListImagesTool` | 低 | 查询 Harbor 最近 N 个可用镜像 |
| `GetLogsTool` | 低 | 拉取容器日志并 AI 分析 |
| `GetGitLabCommitsTool` | 低 | 查询最近提交、关联日志问题 |
| `DeployTool` | 中/高 | 执行部署（staging=中，prod=高） |
| `RollbackTool` | 高 | 回滚到指定版本 |
| `RestartTool` | 中 | 重启服务 |
| `ApprovalTool` | - | 触发审核门，挂起当前 Task |
| `ManageRoleTool` | 高 | 管理用户角色（Admin 专属） |

### Phase 2/3 工具扩展接口（预留）

```typescript
interface AgentTool {
  name: string
  description: string
  riskLevel: 'low' | 'medium' | 'high'
  requiredRole?: Role
  execute(params: unknown, context: TaskContext): Promise<ToolResult>
}
// Phase 2 工具：CodeReviewTool, BugAnalysisTool, MRReviewTool
// Phase 3 工具：BugFixTool, FeatureCodegenTool, TestGenTool
```

### 流式输出

Claude Code 中间思考过程以**分批消息**形式推回群内（IM 平台不支持真正的流式更新，采用"先发占位消息，逐步追加"的方式）。用户看到 Agent 推理过程，增强信任感。长操作以进度形式持续更新（"正在分析日志... 已找到 3 处异常..."）。钉钉使用消息 update API，飞书使用 `patch` 消息 API 实现原地更新。

---

## 7. Approval Gate

### 审核规则配置

审核规则存储于数据库，支持按 `action × env` 组合配置：

```typescript
interface ApprovalRule {
  action: string          // 'deploy' | 'rollback' | 'restart' | '*'
  env: string             // 'prod' | 'staging' | 'dev' | '*'
  primaryApprovers: string[]   // IM 用户 ID 列表（任一批准即通过）
  backupApprovers: string[]    // 升级后的审核人列表
  primaryTimeoutMin: number    // 主审超时时间（分钟），默认 10
  totalTimeoutMin: number      // 总超时时间（分钟），默认 20
}
```

**示例规则：**

```
action=deploy,    env=prod    → 主审: [ops-A, ops-B]  备审: [admin]     超时: 10/20min
action=deploy,    env=staging → 主审: [dev-lead]       备审: [ops-group] 超时: 10/20min
action=rollback,  env=*       → 主审: [ops-group]      备审: [admin]     超时: 5/15min
action=*,         env=prod    → 主审: [ops-group]      备审: [admin]     超时: 10/20min
```

**规则匹配优先级：** 精确匹配优先于通配符匹配。`action=deploy, env=prod` 比 `action=*, env=prod` 优先级更高。若无匹配规则，默认使用 `action=*, env=*` 兜底规则（若未配置兜底规则，则自动放行）。

### 审核流程

1. `ApprovalTool` 被调用 → 当前 Task 转为 `pending_approval`
2. 私信主审人列表，发送交互卡片（操作摘要 + 批准/拒绝按钮）
3. **T + primaryTimeoutMin**：若无响应，私信备审人，同时提醒主审"已升级"
4. **T + totalTimeoutMin**：全部超时 → Task 转为 `timeout` / `cancelled`，群内通知
5. 任意主审或备审点击批准 → Task 转为 `approved` → 进入执行队列
6. 拒绝 → Task 转为 `rejected` → Claude Code 收到信号，向群内说明并询问后续
7. 审核结果（谁批准/拒绝）回写原群，审核详情仅在私信可见

---

## 8. GitLab 集成

### Webhook 事件处理

| 事件 | 处理动作 |
|------|---------|
| `push` | 记录提交信息到 `gitlab_events`，群内静默更新 |
| `pipeline` (success) | 更新 `image_cache`（tag、摘要、构建时间、commit SHA）；群内可配置是否推送通知 |
| `pipeline` (failed) | 群内推送失败通知，附构建日志链接 |
| `merge_request` | 记录 MR 信息；Phase 2 触发 AI 代码审查 |

### 镜像缓存

```typescript
interface ImageCache {
  project: string
  tag: string
  digest: string
  builtAt: Date
  commitSha: string
  commitMessage: string
  pipelineId: number
}
```

`ListImagesTool` 优先查 DB 缓存（TTL 5 分钟），缓存失效才调 Harbor API。

---

## 9. 数据模型（PostgreSQL）

```sql
-- 用户角色
user_roles (id, platform, user_id, user_name, role, group_id, created_by, created_at)

-- 审核规则
approval_rules (id, action, env, primary_approvers jsonb, backup_approvers jsonb,
                primary_timeout_min, total_timeout_min, created_at)

-- 任务记录
tasks (id, group_id, platform, initiator_id, intent text, status,
       tool_name, tool_params jsonb, result jsonb,
       created_at, approved_at, approved_by, executed_at, done_at)

-- 审核记录
approval_requests (id, task_id, approver_id, approver_type,  -- primary/backup
                   sent_at, responded_at, decision,  -- approved/rejected/timeout
                   dm_message_id)

-- 部署历史
deployments (id, project, env, image_tag, image_digest,
             deployed_by, approved_by, deployed_at, status)

-- 镜像缓存
image_cache (id, project, tag, digest, built_at,
             commit_sha, commit_message, pipeline_id, synced_at)

-- GitLab 事件
gitlab_events (id, event_type, project, payload jsonb, received_at)
```

---

## 10. 目录结构（Phase 1）

```
chatops/
├── src/
│   ├── adapters/
│   │   ├── im/
│   │   │   ├── interface.ts          # IMAdapter 接口定义
│   │   │   ├── dingtalk.ts           # 钉钉适配器
│   │   │   └── feishu.ts             # 飞书适配器
│   │   └── gitlab/
│   │       └── webhook-receiver.ts   # GitLab Webhook 接收器
│   ├── agent/
│   │   ├── session-manager.ts        # Session 生命周期管理
│   │   ├── task-queue.ts             # Task 状态机 + 并发队列
│   │   └── tools/                    # 工具插件目录
│   │       ├── deploy.ts
│   │       ├── logs.ts
│   │       ├── gitlab.ts
│   │       ├── harbor.ts
│   │       ├── approval.ts
│   │       └── role.ts
│   ├── approval/
│   │   ├── gate.ts                   # Approval Gate 主逻辑
│   │   ├── router.ts                 # 审核规则路由
│   │   └── escalation.ts            # 超时升级逻辑
│   ├── db/
│   │   ├── schema.sql
│   │   └── repositories/            # 各表的 CRUD 封装
│   └── server.ts                     # HTTP 入口（IM Webhook + GitLab Webhook）
├── docs/
│   └── superpowers/
│       └── specs/
│           └── 2026-04-11-chatops-platform-design.md
├── .gitignore
└── package.json
```

---

## 11. Phase 2/3 扩展点

Phase 1 完成后，以下接口已预留，Phase 2/3 只需注册新工具，无需修改核心逻辑：

- **新 AgentTool**：实现 `AgentTool` 接口后注册到工具集即可
- **新审核规则**：通过 DB 配置，无需代码变更
- **新 IM 平台**：实现 `IMAdapter` 接口，在 `server.ts` 中注册

Phase 2 关键扩展：
- `CodeReviewTool`：克隆 MR 代码，Claude Code 分析并生成审查意见，发回 GitLab MR 评论
- `BugAnalysisTool`：结合日志 + 提交历史，定位 Bug 根因
- `MRReviewTool`：自动触发（GitLab MR webhook）或手动触发，结果私信给 MR 审核人

---

## 12. 关键非功能约束

| 约束 | 要求 |
|------|------|
| IM Webhook 响应 | < 3 秒（立即回复"已收到，处理中..."，后续异步推送结果） |
| 审核超时 | 主审 10 分钟，自动升级备审；总超时 20 分钟自动取消 |
| Session 并发 | 同一群同时只有一个 executing 任务，其余排队 |
| 审核消息载体 | 审核请求私信给审核人，结果（谁批准）回写原群 |
| 镜像缓存 TTL | 5 分钟（GitLab Pipeline 事件实时更新，缓存为辅） |
