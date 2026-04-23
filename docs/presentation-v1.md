# ChatOps 项目汇报（v1 基础版）

> PPT 脚本 · 2026-04-23 · 共 17 页
> 每页格式：标题 + 要点列表，可直接用于幻灯片制作

---

## 封面

- **标题**：ChatOps — 以对话驱动的 DevOps 自动化平台
- **副标题**：IM × AI Agent × Pipeline × 审批闭环
- **汇报范围**：能力全貌、架构设计、当前进度、后续规划
- **日期**：2026-04-23

---

## P1 · 项目定位

**一句话**：把运维工作从"跳多个系统 + 人肉执行"变成"群里说一句，Agent 完成，人工兜底审批"。

- **面向对象**：研发团队、运维、测试、产品经理
- **接入通道**：钉钉 / 飞书群聊（双平台）
- **核心形态**：IM 群里 @机器人 → Claude Agent 理解意图 → 调用工具 → 完成运维操作
- **差异点**：不是简单的 IM 机器人，是 **企业级 RBAC + 审批 + 可编排 Pipeline + 可视化管理后台** 的完整平台

---

## P2 · 解决什么问题

**传统研发流转的痛点**

- 部署 / 回滚 / 日志 / MR 审核散落在 Jenkins、GitLab、K8s、Harbor、钉钉……上下文频繁切换
- 一线同学不熟 CI/CD 脚本，卡在工具链上
- 紧急故障时审批链路失灵，超时无人接手
- Bug 分析 & 修复高度依赖个人经验，知识沉淀难

**ChatOps 的切入点**

- **统一入口**：群里一句话完成跨系统操作
- **AI 协同**：Claude 理解自然语言 + 自动选工具
- **制度化兜底**：审批规则 + 超时升级 + 审计日志
- **可沉淀**：Pipeline、PRD、架构文档、Bug 报告全部结构化入库

---

## P3 · 整体架构

```
┌─ IM 层 ───────────────────────────────┐
│  钉钉 Stream SDK  │  飞书 Webhook     │
└──────────┬────────────────────────────┘
           ▼
┌─ 会话层 ──────────────────────────────┐
│  SessionManager  │  TaskQueue         │
│  (platform,groupId) → 会话 + 8h TTL  │
└──────────┬────────────────────────────┘
           ▼
┌─ 执行层 ──────────────────────────────┐
│  ┌─ Agent 直达 ─┐  ┌─ Pipeline 驱动 ─┐│
│  │ ClaudeRunner │  │ DAG Executor    ││
│  │ + MCP Server │  │ + Cron/IM/API   ││
│  └──────┬───────┘  └──────┬──────────┘│
│         └─────┬───────────┘           │
│               ▼                       │
│         42 个 MCP 工具                 │
└──────────┬────────────────────────────┘
           ▼
┌─ 数据层 ──────────────────────────────┐
│  PostgreSQL 16 (26 版本 schema)      │
│  GitLab / Harbor / SSH 远程资源       │
└───────────────────────────────────────┘
           ▲
┌─ 管理后台 ────────────────────────────┐
│  React 18 + Ant Design 5 SPA         │
│  27 个 Admin API 模块 · 19 个页面     │
└───────────────────────────────────────┘
```

---

## P4 · 能力全景（一页看规模）

| 维度 | 数量 | 说明 |
|------|------|------|
| MCP 工具 | **42** | 运维 / 代码 / 知识 / 审批 / Bug 修复 |
| Admin API 模块 | **27** | 配置、执行记录、权限、审计 |
| 前端页面 | **19** | 管理后台 SPA |
| DB Schema 版本 | **26** | 增量迁移，每版幂等 |
| IM 平台 | **2** | 钉钉 Stream + 飞书 Webhook |
| Pipeline Stage 类型 | **5** | script / capability / approval / im_input / wait_webhook |
| 触发方式 | **4** | Cron / IM 对话 / Web 手动 / API |
| 内置 AI Agent | **3** | Bug 分析、PRD、架构设计 |
| Bug 分级 | **4** | L1 配置 / L2 简单代码 / L3 业务 / L4 架构 |

---

## P5 · IM 接入层

**钉钉（DingTalk Stream 模式）**

- 长连接 WebSocket，订阅机器人消息 + 卡片回调
- 支持纯文本、富文本、引用回复、多图片
- 私信通道：Access Token → OpenAPI

**飞书（Feishu Webhook 模式）**

- HTTP 推送 + url_verification 握手
- 消息事件 + 卡片 `card.action.trigger`

**统一接口 NormalizedMessage**

- 文本 / 图片 / @ 引用 / 用户 & 群标识全部平台标准化
- InteractiveCard：title / body / actions，回调数据透传
- 新增平台只需实现 `IMAdapter` 接口

---

## P6 · AI Agent 核心

**运行链路**

- `@snack-kit/porygon` 启动 Claude CLI 作为子进程
- MCP Server（stdio 协议）暴露工具给 Claude
- 会话按 `(platform, groupId)` 维度管理，8 小时 TTL

**Claude 模型**

- 默认 Opus 4.7，支持热替换
- OAuth Token 可写入 system_config.claude（Web UI 配置，无需重启）

**三类内置 Agent**

1. **Bug 分析 Agent** — 4 阶段（根因 → 模式 → 假设验证 → 方案），输出 L1-L4 分级 + 置信度
2. **PRD Agent** — 多轮对话生成结构化 PRD，带 baseline 埋点
3. **架构设计 Agent** — 架构文档生成，schema-v24 新增

---

## P7 · MCP 工具库（42 个，分 7 大类）

| 类别 | 工具示例 | 数量 |
|------|---------|------|
| 运维 / 部署 | execute_deploy、execute_rollback、execute_restart、switch_version、get_logs、check_environment_status | 8 |
| 代码 / 仓库 | read_code、list_gitlab_branches、create_mr、review_mr_diff、submit_review、create_issue | 7 |
| 制品 / 镜像 | list_artifacts、download_image、get_pipeline_artifact_inputs | 3 |
| 知识 / 文档 | read_prd、save_prd、read_arch、save_arch、search_knowledge、search_existing_prds | 9 |
| Bug 修复 | fix_code、run_tests、update_ai_summary | 3 |
| 审批 / 工作流 | request_approval | 1 |
| 管理 / 权限 | manage_role、list_projects、ssh-utils | 3 |

**关键设计**

- **自注册机制**：`registerTool()` + 文件 import 即完成注册
- **RBAC**：tool_permissions 表支持 **按产品线覆盖** 默认角色策略

---

## P8 · 审批工作流（Gate → Router → Escalation）

**三段式**

1. **Gate** — 请求入口，规则命中则进 `pending_approval`，否则直通
2. **Router** — 四层优先级匹配：`(action, env) > (action, *) > (*, env) > (*, *)`
3. **Escalation** — 超时升级策略
   - 一级超时 → 转备选审批人
   - 二级超时 → 自动取消 + 群通知

**规则维度**

- primaryApprovers / backupApprovers
- primaryTimeoutMin / totalTimeoutMin
- action × env 的笛卡尔组合 + 通配符

**与 Pipeline 联动**

- Pipeline 的 `approval` stage 支持静态人和 **动态 resolver**（按 Bug Level / 仓库 owner 取审批人）

---

## P9 · Pipeline 引擎（可视化 DAG）

**5 种 Stage 类型**

- `script` — bash / shell
- `capability` — 触发 AI Agent 能力
- `approval` — 人工审批（静态 or 动态）
- `im_input` — IM 群里多轮对话采集参数（schema-v19）
- `wait_webhook` — 等外部信号恢复

**4 种触发方式**

- **Cron** — node-cron 调度，自动服务器分配 + 闲置检查
- **IM 对话** — 聊天中触发 capability 自动拉起 pipeline
- **Web 手动** — 管理后台按钮
- **API** — 外部系统调用

**关键能力**

- SSH 远程执行（密码 / 密钥）
- 变量插值：`{{triggerParams.*}}` / `{{run.id}}` / `{{pipeline.name}}`
- 制品输入解析：glob + 最新时间 + 默认策略
- 条件分支：`onSuccess` / `onFailure` / 表达式跳转

---

## P10 · IM 驱动的流水线（v19 新能力）

**核心价值**：把"填表单"从 Web 搬进群聊，**对话即参数采集**。

**链路**

```
IM 消息 → capability 有 default_pipeline_id → runPipeline
            ↓
         im_input stage 触发 interrupt()
            ↓
         im-router 注册 (platform, groupId) ↔ (runId, stageIndex)
            ↓
         im-notifier 推 prompt 到群
            ↓
         用户 IM 回复 → resumeFromImInput 恢复执行
```

**关键保障**

- `im-input-agent` 启发式识别参数（key=value / enum / 单字段 / 取消）
- race-winner claim：多人抢同一消息时的一致性

**冒烟手册**：`docs/smoke-im-pipeline.md`

---

## P11 · Bug 分析 & 自动修复流程

**4 级 Bug 分级**（v25 起内置 4 个 Pipeline 模板）

| 等级 | 类型 | 自动化程度 |
|------|------|----------|
| L1 | 配置类 | **全自动** → 创建 MR + AI Review + 通知 owner |
| L2 | 简单代码 | **全自动** |
| L3 | 业务逻辑 | **全自动** |
| L4 | 架构级 | **仅分析**，不自动改代码 |

**闭环**

1. Bug 报告录入 → 触发 analyze_bug capability
2. 4 阶段分析 → 分级 + 置信度 + 方案
3. L1-L3：fix-runner 串行执行（避免多分支冲突）→ 创建 MR
4. MR 状态对账：`MR_RECONCILE_INTERVAL_MS` 定期回查

---

## P12 · 管理后台

**前端** — React 18 + Ant Design 5 SPA，Vite dev server 代理 `/admin` → 3000

**19 个页面（按功能分 6 组）**

- **基础配置**：SystemConfig、ProductLineList/Detail、Projects、Environments、TestServers
- **能力与规则**：Capabilities、ApprovalRules、ToolPermissions
- **流水线**：TestPipelines（可视化画布）、TestRuns
- **AI 工作台**：PrdDocuments、PrdChat、PrdMetrics、BugRuns
- **可观测**：Metrics、AuditLog
- **用户**：DingTalkUsers、Login、ChangePassword

**表单规范（CLAUDE.md）**

- 枚举字段强制 Select 下拉 + stale 值兼容展示
- 只有"新建枚举"才用 Input
- 通配符 `*` 作为列表首项特殊标记

---

## P13 · 数据库与演进

**技术选型**：PostgreSQL 16，**无 ORM，纯 SQL + Repository 模式**。

**26 版本演进**（关键里程碑）

| 版本 | 核心能力 |
|------|---------|
| v19 | IM 驱动 Pipeline（capability.default_pipeline_id） |
| v20 | Owner 模型重构（模块级 → 项目级） |
| v21 | view_branches 能力 |
| v22 | trigger_sources 显式化 |
| v23 | PRD Agent V2.0 baseline 埋点 |
| v24 | 架构设计 Agent（arch_documents 三表） |
| v25 | PAM 产线 bootstrap + L1-L4 Pipeline 模板 |
| v26 | 内置 capability 的 system_prompt 同步 |

**迁移幂等**：`IF NOT EXISTS` + `ALTER TABLE IF` 保证多次执行安全。

---

## P14 · 部署与 CI

**Docker 两层构建**

- `Dockerfile.base` — Node + pnpm 依赖层，仅 lockfile 变更时重建
  - Tags：`chatops-base:latest` + `chatops-base:deps-{sha8}`
- `Dockerfile` — 业务层多阶段，复用 base，前端 + 后端同步编译

**GitLab CI**（code.paraview.cn，内网 Runner）

- `build-base` — lockfile / Dockerfile.base 变更触发
- `build-app` — master 推送或 tag 触发

**部署脚本**

- `./deploy.sh up | down | restart | logs | status | migrate`
- Compose 编排：PostgreSQL + migrate + ChatOps 三容器

**配置管理**

- `.env` 只放必需的（`DATABASE_URL`）
- IM 平台凭证、GitLab 凭证、Claude Token 走 `system_config` 表（Web UI 改，无需重启）

---

## P15 · 关键工程规范（团队协作约束）

- **GitLab 配置统一入口**：`resolveGitlabConfig()`，禁止裸调 `process.env`（例外：`src/pipeline/executor.ts:29`）
- **Tool 自注册**：新增工具三步走（建文件 + 双 import + DEFAULT_TOOL_ROLES）
- **迁移文件幂等**：新表 `IF NOT EXISTS`、新列 `ADD COLUMN IF NOT EXISTS`
- **命名对齐**：DB `snake_case` ↔ TS `camelCase`，repository `mapRow()` 做转换
- **前端表单**：枚举字段 Select 化，stale 值兼容

---

## P16 · 价值与成果（占位，待补具体数据）

- **效率**：单次部署从 ~N 分钟 → ~N 秒
- **覆盖**：支持 N 条产线、N 个项目、N 个环境
- **稳定性**：审批超时升级机制保障紧急故障处置
- **沉淀**：N 份 PRD、N 份架构文档、N 份 Bug 报告入库
- **使用度**：日均 IM 触发 N 次、周活跃用户 N 人

> 待补充：具体业务数据 / 用户反馈 / 真实案例

---

## P17 · 后续规划（占位）

> 等待补充具体想法和规范

可能的方向（预留）：

- Pipeline 引擎架构重构（capability 死板、不支持 loop 等已在议题中）
- 更多 IM 平台接入（企业微信、Slack）
- 可观测 & 成本分析（Claude Token、执行耗时、失败率）
- 多租户 / 跨产线隔离
- 更多 Agent 场景（测试用例生成、发布说明生成等）
