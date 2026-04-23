# ChatOps 项目汇报（v2 研发全流程版）

> PPT 脚本 · 2026-04-23 · 共 22 页
> v2 升级点：项目定位从 DevOps 自动化 → 研发全流程智能协同
> 新增页面：规范审核中枢、PRD/设计 MR 卡点、开发模式二选一、MR 审核质量门

> **能力状态标记**
> `【现有】` = 已实现并在生产运行
> `【规划】` = 设计清晰，待实现或迭代中
> `【愿景】` = 方向明确，细节待对齐

---

## 封面

- **标题**：ChatOps — 研发全流程智能协同平台
- **副标题**：规范驱动 · 文档 → 代码 → 部署的一站式闭环
- **汇报范围**：全流程能力地图、核心机制、当前进度、演进规划
- **日期**：2026-04-23

---

## P1 · 项目定位（v2 升级）

**一句话**：覆盖 **PRD 设计 → 代码开发 → MR 审核 → 部署运维** 的全流程平台，让 AI 做能做的，让人做该做的。

- **不只是 ChatBot**：IM 群聊只是入口之一，核心是 **全流程 + 可编排 + 可审计** 的平台
- **四大阶段**：
  1. **设计阶段** — PRD & 架构文档 AI 协作生成，规范自动校验
  2. **开发阶段** — 平台托管 或 Claude Code 本地手动，双模式并存
  3. **评审阶段** — MR 多维度质量门（需求 / 代码 / 安全 / 规范），不过自动修复
  4. **运维阶段** — 部署 / 回滚 / Bug 分析修复，IM 对话式触发
- **关键机制**：**规范即代码**（markdown 存 GitLab 知识库，动态加载）

---

## P2 · 解决什么问题

**研发全链路痛点**

- PRD 质量参差不齐，评审靠人肉通读，漏点多
- 公司规范散落在文档 / 老员工脑中，新人 onboarding 难
- 代码开发依赖个人习惯，多语言 / 多租户 / 安全规范执行不一致
- MR review 耗时且主观，质量标准无法机器化校验
- 运维散落在 Jenkins、GitLab、K8s、Harbor，上下文切换频繁

**ChatOps 的切入点**

- **规范显性化**：所有规范以 markdown 进 GitLab 知识库，AI 随时读取
- **文档入 Git**：PRD / 设计文档作为代码库一等公民，走 MR 卡点
- **开发模式双通道**：平台托管（全自动）+ 手动（Claude Code）统一汇入 MR 审核
- **MR 质量门**：需求匹配 + 代码质量 + 安全 + 公司规范，自动修复直至过关
- **运维对话化**：IM 群一句话触发流水线，审批 + 超时升级兜底

---

## P3 · 研发全流程视图（新增核心页）

```
┌──────────────────────────────────────────────────────────────────┐
│                    规范审核中枢（GitLab 知识库）                  │
│         公司级规范.md  │  产品级规范.md  │  动态加载到所有评审    │
└────────┬──────────────────┬────────────────────┬─────────────────┘
         │                  │                    │
         ▼                  ▼                    ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ ① 设计阶段   │    │ ② 开发阶段   │    │ ③ 评审阶段   │
│              │    │              │    │              │
│ PRD Agent    │    │ 平台托管     │    │ MR 质量门     │
│ Arch Agent   │    │ (epic→story  │    │ - 需求匹配    │
│              │    │  →ATDD→code) │    │ - 代码质量    │
│ ↓ MD 提交    │    │   ∥          │    │ - 安全扫描    │
│ ↓ MR 卡点    │    │ 手动开发     │    │ - 公司规范    │
│ ↓ 规范校验   │    │ (Claude Code │    │ ↓ 不过 → 自修 │
│ ↓ 人工会签   │    │  本地)       │    │ ↓ 过 → merge │
└──────┬───────┘    └──────┬───────┘    └──────┬───────┘
       │                   │                   │
       └───────────────────┴───────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    ④ 运维阶段（IM 对话式）                        │
│   部署 / 回滚 / 日志 / Bug 分析 → 修复 → MR → 回到 ③              │
└──────────────────────────────────────────────────────────────────┘
```

**关键闭环**：每个阶段的产物都是 **下一阶段的输入**，规范中枢贯穿所有评审点。

---

## P4 · 整体架构

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
│       MCP 工具库（42+）                │
│   运维 / 代码 / 规范 / 审核 / 修复     │
└──────────┬────────────────────────────┘
           ▼
┌─ 规范 & 知识层 ───────────────────────┐
│  GitLab 知识库（公司/产品规范 .md）   │
│  product_knowledge_repos 索引         │
└──────────┬────────────────────────────┘
           ▼
┌─ 数据层 ──────────────────────────────┐
│  PostgreSQL 16 · 26 版本 schema      │
│  GitLab / Harbor / SSH 远程资源       │
└───────────────────────────────────────┘
           ▲
┌─ 管理后台 ────────────────────────────┐
│  React 18 + Ant Design 5 SPA         │
│  27 个 Admin API · 19 个页面          │
└───────────────────────────────────────┘
```

---

## P5 · 能力全景（v2 更新）

| 维度 | 数量 | 说明 |
|------|------|------|
| 研发阶段覆盖 | **4** | 设计 / 开发 / 评审 / 运维 |
| 开发模式 | **2** | 平台托管（全自动）/ 手动（Claude Code） |
| MR 审核维度 | **4+** | 需求 / 代码 / 安全 / 公司规范（多语言 / 多租户 / 认证 / UX / UI） |
| 内置 AI Agent | **3+** | Bug 分析、PRD、架构设计（规划：Epic/Story Agent、规范审核 Agent） |
| MCP 工具 | **42** | 运维 / 代码 / 知识 / 审批 / Bug 修复 |
| Admin API 模块 | **27** | 配置、执行记录、权限、审计 |
| 前端页面 | **19** | 管理后台 SPA |
| DB Schema 版本 | **26** | 增量迁移，每版幂等 |
| IM 平台 | **2** | 钉钉 Stream + 飞书 Webhook |
| Pipeline Stage 类型 | **5** | script / capability / approval / im_input / wait_webhook |
| 触发方式 | **4** | Cron / IM 对话 / Web 手动 / API |
| Bug 分级 | **4** | L1 配置 / L2 简单代码 / L3 业务 / L4 架构 |

---

## P6 · 规范审核中枢（新增 · 核心能力）

**核心理念**：规范不是文档，是**可执行的校验器**。

**规范来源**

- 存放位置：**GitLab 知识库仓库**（per 产品线配置在 `product_knowledge_repos` 表）【现有索引能力】
- 格式：markdown
- 层级：
  - **公司级规范**（全产品线共享）：多语言 / 多租户 / 认证防护 / UX 交互 / UI 配色 / 日志 / 错误码
  - **产品级规范**（per 产品线）：领域模型、API 契约、权限模型、命名约定

**加载机制**【规划】

- 审核触发时 → 读 GitLab 最新 markdown → 作为 system prompt 注入审核 Agent
- 规范变更无需发版，**改 markdown 即生效**
- 支持版本锚定：MR 评审引用"规范 @ commit sha"以便追溯

**使用场景（3 大卡点）**

1. **PRD / 设计文档评审** — 检查文档是否遵循产品规范（领域模型、术语）
2. **Epic / Story 拆分评审**【规划】 — 检查拆分是否覆盖非功能规范
3. **MR 代码评审** — 检查代码是否遵循公司规范（多语言 key、多租户字段、认证中间件）

**工具支撑**

- 【现有】`search_knowledge`、`read_prd`、`read_arch`
- 【规划】`load_company_standards`、`load_product_standards`、`check_standard_compliance`

---

## P7 · PRD & 设计评审闭环（新增）

**核心原则**：**不管用户怎么写，只审核最终 markdown**。工具链不重要，文档质量重要。

**流程**

```
① 用户编写 PRD / 设计文档
   ├─ 方式 A：PRD Agent 多轮对话生成【现有】
   ├─ 方式 B：Claude Code 本地编辑【现有】
   ├─ 方式 C：任意编辑器手写
   └─ 方式 D：从其他系统导入
           ↓
② 文档提交到项目 Git（与代码同仓）
   路径约定（示例）：docs/prd/*.md、docs/arch/*.md
           ↓
③ 发起 MR —— 评审卡点【规划】
   ├─ AI 自动评审
   │   ├─ 完整性：背景 / 目标 / 用户故事 / 验收标准 / 非功能性
   │   ├─ 规范符合：命名、术语、领域模型、API 契约
   │   ├─ 可实现性：技术可行 / 工作量估算是否合理
   │   └─ 与已有 PRD 一致性（通过 search_existing_prds）
   ├─ 人工会签：产品 / 架构 / 安全
   └─ 不通过 → 自动提建议 → 作者修改 → 重审
           ↓
④ MR 合并 → 文档进主干 → 作为开发阶段输入
```

**为什么文档进 Git**

- 与代码同仓库，变更有 diff、评审可追溯
- AI 开发阶段可直接读到最新文档
- 审计链路天然闭环（谁改了 PRD、什么时候改、为什么改）

**与现有 PRD Agent 的关系**

- PRD Agent 负责**生成**，GitLab MR 评审负责**把关**
- 用户可以不用 PRD Agent，但不能跳过 MR 评审

---

## P8 · 开发阶段：双模式并存（新增 · 核心能力）

**设计哲学**：不强制一种开发模式，让团队按场景选最合适的。

### 模式 A：平台托管开发【愿景 / 迭代中】

**标准流程**（全自动）：

```
PRD + 设计文档（已评审通过）
    ↓
[Agent 1] Epic 拆分
    ↓ MR: docs/epics/*.md
[Agent 2] Epic Review（按 PRD + 公司规范）
    ↓
[Agent 3] Story 拆分（每个 epic 拆成独立可交付单元）
    ↓ MR: docs/stories/*.md
[Agent 4] Story Review（验收标准清晰、粒度合理）
    ↓
[Agent 5] ATDD 用例生成（Given / When / Then）
    ↓ 代码：tests/acceptance/*.test.ts
[Agent 6] Story 实现（Claude Code 按 ATDD 驱动）
    ↓
[Agent 7] Code Self-Review
    ↓
每个 Story 一个 MR → 进入 P10 MR 质量门
```

**特点**

- 每一步都有 **独立评审 / 回退节点**
- Story 粒度的 MR → 易 review、易回滚
- 开发进度在管理后台可视化

### 模式 B：手动开发【现有】

- 开发者本地用 **Claude Code** 或其他工具
- 直接提交 MR
- 流程灵活，适合紧急修复 / 探索性开发

### 两种模式的汇聚点

- **统一走 MR 审核质量门**（下一页）
- **统一规范**：都要通过 P6 规范审核中枢的校验
- **统一记录**：都进 audit_log，可溯源

---

## P9 · 平台托管开发的关键机制（新增）

**为什么需要拆 Epic / Story**

- Epic：对齐产品规划粒度（1-2 周）
- Story：独立可交付单元（半天到 2 天）
- Story 粒度的 MR：**每个 MR 只做一件事**，review 效率翻倍

**ATDD（验收测试驱动开发）**【愿景】

- 每个 Story 先写 Acceptance Test
- Given：前置条件（用户 / 数据 / 环境）
- When：用户动作
- Then：预期结果（包含非功能性，如"响应时间 < 200ms"、"带租户隔离"）
- 代码实现阶段：**必须让 ATDD 通过**

**质量门内置**

- Epic 拆分完成 → Epic Review Agent 卡点
- Story 拆分完成 → Story Review Agent 卡点
- ATDD 写完 → 语法 / 覆盖度检查
- Story 代码完成 → 本地跑 ATDD + 单测
- 全过 → 提交 MR，进入 P10

**所需能力**【规划 / 待实现】

- Epic/Story 数据表 & Agent
- ATDD 模板库（按语言 / 框架）
- Story 级进度看板（前端新页面）

---

## P10 · MR 审核质量门（新增 · 核心能力）

**四大审核维度**

```
┌─────────────────────────────────────────────────┐
│              MR 审核质量门                       │
├─────────────────────────────────────────────────┤
│ ① 需求匹配度                                     │
│   - 代码变更 ↔ Story 验收标准                   │
│   - 缺失 / 多余功能检测                          │
│                                                 │
│ ② 代码质量                                       │
│   - 可读性 / 复杂度 / 重复代码                   │
│   - 单元测试覆盖                                 │
│   - 命名 / 结构规范                              │
│                                                 │
│ ③ 安全                                           │
│   - SQL 注入 / XSS / CSRF                       │
│   - 敏感信息泄露（密钥 / Token）                 │
│   - 依赖漏洞                                     │
│   - 认证 / 授权中间件使用                        │
│                                                 │
│ ④ 公司级规范（从知识库动态加载）                 │
│   - 多语言：i18n key 完整、无硬编码文案          │
│   - 多租户：关键表带 tenant_id、查询带过滤        │
│   - 认证防护：接口鉴权、越权检查                 │
│   - UX 交互：统一组件、一致交互模式              │
│   - UI 配色：Design Token、禁用硬编码色值        │
└─────────────────────────────────────────────────┘
```

**闭环机制**【规划】

```
MR 提交 → 触发审核 Pipeline
            ↓
         四维审核并发
            ↓
     全部通过？
        /       \
      是         否
      ↓          ↓
  允许 merge   自动修复 Agent
               ↓
           改代码 / 补测试
               ↓
           push 新 commit
               ↓
           重新触发审核 ↺
               ↓
           达到最大重试 N 次仍不过 → 通知人工介入
```

**关键特性**

- **门禁 = Merge 权限**：不过不让 merge（GitLab 原生 approval rule 集成）
- **自动修复**：审核意见直接转成修复任务
- **人工兜底**：特殊情况可授权人工 override（审计留痕）

**现有能力**

- 【现有】`review_mr_diff` 工具（AI 审查 diff）
- 【现有】`submit_review` 工具（提交 MR 评审）
- 【现有】L1-L3 自动修复流程（Bug 场景）

**待补齐**【规划】

- 审核 Pipeline 模板（四维并发）
- 公司规范动态加载到 Review Agent
- Merge 门禁与 GitLab 联动
- 自动修复重试上限 & 人工介入通知

---

## P11 · IM 接入层

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

## P12 · AI Agent 核心

**运行链路**

- `@snack-kit/porygon` 启动 Claude CLI 作为子进程
- MCP Server（stdio 协议）暴露工具给 Claude
- 会话按 `(platform, groupId)` 维度管理，8 小时 TTL

**Claude 模型**

- 默认 Opus 4.7，支持热替换
- OAuth Token 可写入 system_config.claude（Web UI 配置，无需重启）

**当前内置 Agent**

1. **Bug 分析 Agent**【现有】 — 4 阶段（根因 → 模式 → 假设验证 → 方案），输出 L1-L4 分级 + 置信度
2. **PRD Agent**【现有】 — 多轮对话生成结构化 PRD，带 baseline 埋点
3. **架构设计 Agent**【现有】 — 架构文档生成，schema-v24 新增

**规划中的 Agent**【规划】

4. **Epic / Story 拆分 & Review Agent**
5. **ATDD 生成 Agent**
6. **规范审核 Agent**（公司级 + 产品级动态加载）
7. **MR 质量门 Agent**（四维并发）
8. **自动修复 Agent**（闭环到 MR 审核）

---

## P13 · MCP 工具库（42 个 + 规划扩展）

**现有 42 个工具，7 大类**

| 类别 | 工具示例 | 数量 |
|------|---------|------|
| 运维 / 部署 | execute_deploy、execute_rollback、execute_restart、switch_version、get_logs、check_environment_status | 8 |
| 代码 / 仓库 | read_code、list_gitlab_branches、create_mr、review_mr_diff、submit_review、create_issue | 7 |
| 制品 / 镜像 | list_artifacts、download_image、get_pipeline_artifact_inputs | 3 |
| 知识 / 文档 | read_prd、save_prd、read_arch、save_arch、search_knowledge、search_existing_prds | 9 |
| Bug 修复 | fix_code、run_tests、update_ai_summary | 3 |
| 审批 / 工作流 | request_approval | 1 |
| 管理 / 权限 | manage_role、list_projects、ssh-utils | 3 |

**规划新增（v2 新能力对应）**【规划】

- `load_company_standards` / `load_product_standards` — 规范动态加载
- `check_standard_compliance` — 规范符合性检查
- `split_epic` / `review_epic` — Epic 拆分 & 评审
- `split_story` / `review_story` — Story 拆分 & 评审
- `generate_atdd` / `run_atdd` — ATDD 用例生成 & 执行
- `qa_gate_check` — MR 四维质量门并发入口
- `auto_fix_from_review` — 基于审核意见自动修复

**自注册机制 + RBAC** 保持不变。

---

## P14 · 审批工作流（Gate → Router → Escalation）

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

## P15 · Pipeline 引擎（可视化 DAG）

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

## P16 · IM 驱动的流水线（v19 新能力）

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

## P17 · Bug 分析 & 自动修复流程

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

**与 P10 MR 质量门的关系**

- Bug 修复的 MR **同样走 MR 质量门**
- 不过门 → 自动修复 Agent 再修 → 重审

---

## P18 · 管理后台

**前端** — React 18 + Ant Design 5 SPA，Vite dev server 代理 `/admin` → 3000

**19 个现有页面（按功能分 6 组）**

- **基础配置**：SystemConfig、ProductLineList/Detail、Projects、Environments、TestServers
- **能力与规则**：Capabilities、ApprovalRules、ToolPermissions
- **流水线**：TestPipelines（可视化画布）、TestRuns
- **AI 工作台**：PrdDocuments、PrdChat、PrdMetrics、BugRuns
- **可观测**：Metrics、AuditLog
- **用户**：DingTalkUsers、Login、ChangePassword

**规划新增页面**【规划】

- **规范中枢**：公司规范 / 产品规范索引 + 版本
- **Epic / Story 看板**：托管开发进度
- **MR 质量门**：审核记录 + 维度分项得分 + 自动修复历史
- **开发模式概览**：托管 vs 手动的分布与效率指标

**表单规范**（CLAUDE.md）

- 枚举字段强制 Select 下拉 + stale 值兼容展示
- 只有"新建枚举"才用 Input
- 通配符 `*` 作为列表首项特殊标记

---

## P19 · 数据库与演进

**技术选型**：PostgreSQL 16，**无 ORM，纯 SQL + Repository 模式**。

**现有 26 版本演进**（关键里程碑）

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

**规划新增表**【规划】

- `epics` / `stories` — Epic/Story 拆分产物
- `atdd_cases` — ATDD 用例
- `mr_quality_reviews` — MR 四维审核记录
- `standards_versions` — 规范版本锚定（MR 关联到 commit sha）
- `auto_fix_history` — 自动修复重试链路

**迁移幂等**：`IF NOT EXISTS` + `ALTER TABLE IF` 保证多次执行安全。

---

## P20 · 部署与 CI

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

## P21 · 关键工程规范（团队协作约束）

- **GitLab 配置统一入口**：`resolveGitlabConfig()`，禁止裸调 `process.env`（例外：`src/pipeline/executor.ts:29`）
- **Tool 自注册**：新增工具三步走（建文件 + 双 import + DEFAULT_TOOL_ROLES）
- **迁移文件幂等**：新表 `IF NOT EXISTS`、新列 `ADD COLUMN IF NOT EXISTS`
- **命名对齐**：DB `snake_case` ↔ TS `camelCase`，repository `mapRow()` 做转换
- **前端表单**：枚举字段 Select 化，stale 值兼容
- **规范存储**【规划】：公司 / 产品规范必须以 markdown 存 GitLab 知识库，不允许代码内硬编码

---

## P22 · 价值、成果与规划

**已实现价值**

- **统一运维入口**：IM 对话 → 部署 / 回滚 / 日志 / MR 审核
- **AI 辅助设计**：PRD / 架构文档多轮对话生成，结构化入库
- **Bug 自动化**：L1-L3 全自动闭环（分析 → 修复 → MR → 通知）
- **企业级兜底**：审批规则 + 超时升级 + 审计日志

**v2 目标（规划中）**

- **规范中枢上线** — 公司 / 产品规范 markdown 化，AI 可读
- **PRD / 设计文档 MR 卡点** — 文档进 Git + 评审闭环
- **平台托管开发 MVP** — Epic/Story 拆分 + ATDD + 自动编码
- **MR 四维质量门** — 需求 / 代码 / 安全 / 规范并发审核 + 自动修复
- **开发效率指标** — 托管 vs 手动的周期 / 质量对比

**更长期愿景**

- 多 IM 平台（企业微信 / Slack）
- 多租户 / 跨产线隔离
- 更多 Agent 场景（测试用例生成、发布说明、值班机器人）
- 成本与可观测（Claude Token / 执行耗时 / 失败率看板）

> 🎯 核心目标：**让 AI 做能做的，让人做该做的，规范做裁判。**
