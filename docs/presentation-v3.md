# ChatOps 项目汇报（v3 研发全流程版 · 含测试质量闭环）

> PPT 脚本 · 2026-04-23 · 共 25 页
> v3 升级点：自动化测试作为质量基石贯穿 MR / 编译 / 发布三大门禁
> 新增页面：测试规范与基础设施、测试闭环与自愈、发布前质量门

> **能力状态标记**
> `【现有】` = 已实现并在生产运行
> `【规划】` = 设计清晰，待实现或迭代中
> `【愿景】` = 方向明确，细节待对齐

---

## 封面

- **标题**：ChatOps — 研发全流程智能协同平台
- **副标题**：规范驱动 · 测试兜底 · 文档 → 代码 → 测试 → 部署的一站式闭环
- **汇报范围**：全流程能力地图、核心机制、当前进度、演进规划
- **日期**：2026-04-23

---

## P1 · 项目定位（v3 升级）

**一句话**：覆盖 **PRD 设计 → 代码开发 → MR 审核 → 测试 → 部署运维** 的全流程平台，让 AI 做能做的，让人做该做的，**规范和测试做裁判**。

- **四大阶段 + 两大裁判**：
  1. **设计阶段** — PRD & 架构文档 AI 协作生成，规范自动校验
  2. **开发阶段** — 平台托管 或 Claude Code 本地手动，双模式并存
  3. **评审阶段** — MR 多维度质量门（需求 / 代码 / 安全 / 规范 / **测试**）
  4. **运维阶段** — 部署 / 回滚 / Bug 分析修复，IM 对话式触发
- **两大裁判机制**：
  - **规范中枢**：公司 / 产品 markdown 规范动态加载
  - **测试中枢**：MR / 编译 / 发布三道强制门禁
- **质量承诺**：不过门禁的代码**永远到不了生产**

---

## P2 · 解决什么问题

**研发全链路痛点**

- PRD 质量参差不齐，评审靠人肉通读，漏点多
- 公司规范散落在文档 / 老员工脑中，新人 onboarding 难
- 代码开发依赖个人习惯，多语言 / 多租户 / 安全规范执行不一致
- **测试覆盖率无硬约束**：能测的测，不能测的 skip，发布后再救火
- **测试基础设施参差**：跑不起来、脚本缺失、镜像不统一，无法自动化
- MR review 耗时且主观，质量标准无法机器化校验
- 运维散落在 Jenkins、GitLab、K8s、Harbor，上下文切换频繁

**ChatOps 的切入点**

- **规范显性化**：所有规范以 markdown 进 GitLab 知识库，AI 随时读取
- **测试强约束**：覆盖率 + 脚本 + 环境 + 镜像纳入公司级规范，不合规不让过
- **文档入 Git**：PRD / 设计文档作为代码库一等公民，走 MR 卡点
- **开发模式双通道**：平台托管（全自动）+ 手动（Claude Code）统一汇入 MR 审核
- **MR 质量门**：需求 + 代码 + 安全 + 规范 + **测试**，自动修复直至过关
- **发布前质量门**：全量部署 + E2E 测试通过才能发版
- **运维对话化**：IM 群一句话触发流水线，审批 + 超时升级兜底

---

## P3 · 研发全流程视图（v3 加入测试中枢）

```
┌────────────────────────────────────────────────────────────────────┐
│   规范审核中枢 (GitLab 知识库)    │    测试中枢 (覆盖率 + 脚本规范) │
│   公司级 / 产品级 markdown        │    单测 ≥70% · 核心 ≥90%         │
└──────────┬────────────────────┬───┴──────────┬──────────────────────┘
           │                    │              │
           ▼                    ▼              ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│ ① 设计阶段   │    │ ② 开发阶段   │    │ ③ 评审阶段       │
│              │    │              │    │                  │
│ PRD Agent    │    │ 平台托管     │    │ MR 五维质量门    │
│ Arch Agent   │    │ (epic→story  │    │ - 需求匹配       │
│              │    │  →ATDD→code) │    │ - 代码质量       │
│ ↓ MD 提交    │    │   ∥          │    │ - 安全扫描       │
│ ↓ MR 卡点    │    │ 手动开发     │    │ - 公司规范       │
│ ↓ 规范校验   │    │ (Claude Code │    │ - 自动化测试     │
│ ↓ 人工会签   │    │  本地)       │    │ ↓ 不过→Bug Agent │
│              │    │              │    │ ↓ 自动修复→重跑   │
└──────┬───────┘    └──────┬───────┘    └──────┬───────────┘
       │                   │                   │
       └───────────────────┴───────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────────────┐
│              ④ 运维阶段（IM 对话式 + 发布前质量门）                 │
│   部署 / 回滚 / 日志 / Bug 分析                                     │
│   ↓ 发版前：全量部署测试 + E2E 测试 → 通过才允许发布                │
└────────────────────────────────────────────────────────────────────┘
```

**三道测试门禁**

- **编译门**：产品项目的编译脚本必须内嵌测试，测试失败 → 编译失败
- **MR 门**：MR 审核时强制跑测试 + 覆盖率检查
- **发布门**：发版前全量部署测试 + E2E 通过才能发

---

## P4 · 整体架构

```
┌─ IM 层 ───────────────────────────────┐
│  钉钉 Stream SDK  │  飞书 Webhook     │
└──────────┬────────────────────────────┘
           ▼
┌─ 会话层 ──────────────────────────────┐
│  SessionManager  │  TaskQueue         │
└──────────┬────────────────────────────┘
           ▼
┌─ 执行层 ──────────────────────────────┐
│  ClaudeRunner + MCP Server            │
│  DAG Executor (Cron/IM/API/Web)       │
│  MCP 工具库（42+）                     │
└──────────┬────────────────────────────┘
           ▼
┌─ 规范 & 测试层（v3 新）───────────────┐
│  规范中枢：GitLab 知识库 markdown     │
│  测试中枢：覆盖率阈值 + 脚本模板库     │
│  product_knowledge_repos 索引         │
└──────────┬────────────────────────────┘
           ▼
┌─ 数据层 ──────────────────────────────┐
│  PostgreSQL 16 · GitLab · Harbor     │
│  SSH 远程资源                          │
└───────────────────────────────────────┘
           ▲
┌─ 管理后台 ────────────────────────────┐
│  React 18 + Ant Design 5 SPA         │
└───────────────────────────────────────┘
```

---

## P5 · 能力全景（v3 更新）

| 维度 | 数量 | 说明 |
|------|------|------|
| 研发阶段覆盖 | **4** | 设计 / 开发 / 评审 / 运维 |
| 开发模式 | **2** | 平台托管（全自动）/ 手动（Claude Code） |
| MR 审核维度 | **5** | 需求 / 代码 / 安全 / 公司规范 / 自动化测试 |
| 测试门禁 | **3** | 编译门 / MR 门 / 发布门 |
| 覆盖率硬约束 | **2 档** | 总体 ≥ 70% · 核心模块 ≥ 90% |
| 内置 AI Agent | **3+** | Bug 分析、PRD、架构（规划：Epic/Story、规范审核、测试修复） |
| MCP 工具 | **42** | 运维 / 代码 / 知识 / 审批 / Bug 修复 |
| Admin API 模块 | **27** | 配置、执行记录、权限、审计 |
| 前端页面 | **19** | 管理后台 SPA |
| DB Schema 版本 | **26** | 增量迁移，每版幂等 |
| IM 平台 | **2** | 钉钉 Stream + 飞书 Webhook |
| Pipeline Stage 类型 | **5** | script / capability / approval / im_input / wait_webhook |
| 触发方式 | **4** | Cron / IM 对话 / Web 手动 / API |
| Bug 分级 | **4** | L1 配置 / L2 简单代码 / L3 业务 / L4 架构 |

---

## P6 · 规范审核中枢（v3 加入测试规范）

**核心理念**：规范不是文档，是**可执行的校验器**。

**规范分层**

- **公司级规范**（全产品线共享）：
  - 多语言 / 多租户 / 认证防护 / UX 交互 / UI 配色
  - 日志 / 错误码 / API 契约
  - **自动化测试规范**（v3 新增）：覆盖率阈值、脚本入口、环境约定、基础镜像
  - **项目脚本规范**（v3 新增）：编译 / 打包 / 测试脚本的命名与职责
- **产品级规范**（per 产品线）：
  - 领域模型、术语词典、权限模型、命名约定

**规范来源与加载**【规划】

- 存放位置：**GitLab 知识库仓库**（`product_knowledge_repos` 表）
- 格式：markdown
- 加载机制：审核触发时 → 读 GitLab 最新 markdown → 注入审核 Agent
- **改 markdown 即生效**，无需发版
- 支持版本锚定：MR 评审引用"规范 @ commit sha"以便追溯

**使用场景（4 大卡点）**

1. **PRD / 设计文档评审** — 产品规范、领域模型、术语
2. **Epic / Story 拆分评审**【规划】 — 非功能性规范是否覆盖
3. **MR 代码评审** — 多语言 key、多租户字段、认证中间件
4. **MR 测试评审**（v3 新增）— 覆盖率达标、测试脚本合规

**工具支撑**

- 【现有】`search_knowledge`、`read_prd`、`read_arch`
- 【规划】`load_company_standards`、`load_product_standards`、`check_standard_compliance`、`check_test_standards`

---

## P7 · PRD & 设计评审闭环

**核心原则**：**不管用户怎么写，只审核最终 markdown**。

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

---

## P8 · 开发阶段：双模式并存

### 模式 A：平台托管开发【愿景 / 迭代中】

```
PRD + 设计文档（已评审通过）
    ↓
[Agent 1] Epic 拆分
    ↓ MR: docs/epics/*.md
[Agent 2] Epic Review（按 PRD + 公司规范）
    ↓
[Agent 3] Story 拆分
    ↓ MR: docs/stories/*.md
[Agent 4] Story Review
    ↓
[Agent 5] ATDD 用例生成（Given / When / Then）
    ↓ 代码：tests/acceptance/*.test.ts
[Agent 6] Story 实现（Claude Code 按 ATDD 驱动）
    ↓
[Agent 7] Code Self-Review + 本地跑测试
    ↓
每个 Story 一个 MR → 进入 MR 五维质量门
```

### 模式 B：手动开发【现有】

- 开发者本地用 **Claude Code** 或其他工具
- 直接提交 MR
- 流程灵活，适合紧急修复 / 探索性开发

### 两种模式的汇聚点

- **统一走 MR 五维质量门**
- **统一规范 + 测试硬约束**
- **统一记录** → `audit_log`

---

## P9 · 平台托管开发的关键机制

**Epic / Story 粒度**

- Epic：对齐产品规划粒度（1-2 周）
- Story：独立可交付单元（半天到 2 天）
- Story 粒度的 MR：**每个 MR 只做一件事**

**ATDD（验收测试驱动开发）**【愿景】

- 每个 Story 先写 Acceptance Test
- Given / When / Then 结构
- 包含非功能性验收（响应时间、租户隔离、权限边界）
- 代码实现阶段：**必须让 ATDD 通过**
- ATDD 是 MR 测试门禁的核心输入

**质量门内置**

- Epic / Story 拆分完成 → 对应 Review Agent 卡点
- ATDD 写完 → 语法 / 覆盖度检查
- Story 代码完成 → 本地跑 ATDD + 单测 + 覆盖率
- 全过 → 提交 MR，进入五维质量门

---

## P10 · MR 审核质量门（v3 五维）

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
│   - 命名 / 结构规范                              │
│                                                 │
│ ③ 安全                                           │
│   - SQL 注入 / XSS / CSRF                       │
│   - 敏感信息泄露（密钥 / Token）                 │
│   - 依赖漏洞 / 认证授权                          │
│                                                 │
│ ④ 公司级规范（从知识库动态加载）                 │
│   - 多语言 / 多租户 / 认证防护                   │
│   - UX 交互 / UI 配色（Design Token）           │
│                                                 │
│ ⑤ 自动化测试（v3 核心新增）                      │
│   - 单测 + 集成测试覆盖率 ≥ 70%                  │
│   - 核心模块覆盖率 ≥ 90%                         │
│   - 测试全部通过                                 │
│   - ATDD 用例执行（如适用）                      │
└─────────────────────────────────────────────────┘
```

**闭环机制**【规划】

```
MR 提交 → 触发审核 Pipeline
            ↓
         五维并发审核
            ↓
     全部通过？
        /       \
      是         否
      ↓          ↓
  允许 merge   自动修复 Agent
               ↓
        [如果是测试失败] → 见 P12 测试闭环
        [其他维度]       → 基于审核意见直接改代码
               ↓
           push 新 commit
               ↓
           重新触发审核 ↺
               ↓
        达到最大重试 N 次仍不过 → 通知人工介入
```

---

## P11 · 自动化测试：质量基石（v3 新增）

**核心定位**：测试不是可选项，是**公司级强制规范**。

### 覆盖率硬约束

| 范围 | 阈值 |
|------|------|
| 单测 + 集成测试 总体覆盖率 | **≥ 70%** |
| 核心模块覆盖率 | **≥ 90%** |

不达标 → MR 卡住、编译失败、发布禁止。

### 测试基础设施规范（公司级）

每个产品项目**必须**提供以下标准化材料（纳入规范审核）：

```
project-root/
├── scripts/
│   ├── build.sh      # 编译脚本
│   ├── package.sh    # 打包脚本
│   └── test.sh       # 测试脚本
├── Dockerfile.base   # 依赖基础镜像定义
├── Dockerfile.test   # 测试环境镜像
├── test-setup.sh     # 测试环境准备脚本
└── coverage.config   # 覆盖率工具配置
```

**不同语言的脚本入口统一约定**

- `./scripts/test.sh` 是**唯一入口**，内部按语言适配（Go / Java / Node / Python / Rust）
- ChatOps 调用时只需 `bash scripts/test.sh`，不关心底层工具链
- 产品可选用 gradle / maven / pnpm / pytest / cargo，但对外统一

### 编译脚本强制集成测试（v3 关键约束）

```
./scripts/build.sh
    ↓
  ┌─────────────────────┐
  │ 1. 拉依赖            │
  │ 2. 跑单测 + 集成测试 │ ← 必须
  │ 3. 跑覆盖率检查      │ ← 必须
  │ 4. 编译产物          │
  │ 5. 产出制品          │
  └─────────────────────┘
  任一步失败 → 编译失败，非零退出码
```

**含义**：**编译脚本里不跑测试 = 违反公司规范**，审核不过。

### 触发时机

- **编译门**：产品自身 build.sh 每次运行（开发者本地 + CI）
- **MR 门**：MR 触发审核 Pipeline 时自动跑【规划】
- **发布门**：发版流程前的强制检查【规划】

### 工具支撑【规划】

- `check_test_coverage` — 覆盖率达标检查
- `validate_test_infra` — 测试基础设施合规检查（脚本 / 镜像 / 环境）
- `run_project_tests` — 标准化调用 `./scripts/test.sh`

---

## P12 · 测试失败的自愈闭环（v3 新增）

**核心价值**：测试不过 = 自动开 bug → 自动修 → 自动重跑，**人工不用介入，直到绿灯**。

### 闭环链路

```
MR 审核 Pipeline → ⑤ 测试维度
         ↓
    跑 ./scripts/test.sh
         ↓
   ┌────失败─────────────────┐
   │                         │
   │  [Bug Agent 触发]       │
   │  ├─ 解析失败日志        │
   │  ├─ 定位根因（调 analyze_bug）
   │  ├─ 自动提交合规 Bug Issue
   │  │   ├─ 标题：[AUTO] 测试失败 - xxx
   │  │   ├─ 关联 MR / Pipeline 链接
   │  │   ├─ 分级：L1-L3（复用 Bug 分级体系）
   │  │   └─ 修复方案 & 置信度                
   │  ↓                      │
   │  [Fix Agent 触发]       │
   │  ├─ 修代码 / 补测试     │
   │  ├─ 本地验证通过        │
   │  └─ push 到 MR 分支     │
   │         ↓               │
   │     重新触发审核 ↺      │
   └─────────────────────────┘
         ↓ 通过
    进入其他维度校验
         ↓ 全部通过
     允许 Merge
```

### 对接现有能力

- **复用 Bug 分析 Agent**【现有】：4 阶段分析 + L1-L4 分级
- **复用 fix-runner**【现有】：串行修复 + MR 创建
- **复用 MR 对账**【现有】：`MR_RECONCILE_INTERVAL_MS` 定期回查
- **新增**【规划】：测试失败 → Bug Issue 的适配层（格式化失败日志 → bug 模板）

### 合规 Bug Issue 模板（示例）

```markdown
## [AUTO] 测试失败 - UserAuthService.login

**来源**：MR !1234 · Pipeline #5678
**失败用例**：tests/auth/login.test.ts:42
**失败原因**：Expected 200, got 401
**AI 分级**：L2（简单代码）· 置信度：High

**可能原因**：
- 认证中间件顺序变更导致的 401
- 新增的租户校验未正确处理测试 fixture

**建议修复**：
- 调整 middleware 注册顺序
- 补充 test fixture 的 tenant_id 字段
```

### 重试上限与人工兜底

- 默认最多自动修复 **3 次**
- 超过上限 → 群通知 owner + 人工接管
- 所有尝试记入 `auto_fix_history` 表【规划】

---

## P13 · 发布前质量门：全量测试 + E2E（v3 新增）

**核心理念**：MR 门保障**单点质量**，发布门保障**系统质量**。

### 发布前三件事

```
产品发版流程
    ↓
┌─────────────────────────────────────┐
│ ① 全量部署测试                       │
│   - 在准生产环境部署完整系统         │
│   - 验证配置、迁移、依赖服务         │
│   - 冒烟接口级别的健康检查            │
│                                     │
│ ② E2E 端到端测试                     │
│   - 完整业务流程串联                 │
│   - 真实数据场景                     │
│   - 性能基线（响应时间 / 吞吐）       │
│                                     │
│ ③ 回归测试                           │
│   - 历史 Bug 用例全量回跑            │
│   - 核心场景冒烟用例                 │
└─────────────────────────────────────┘
    ↓
  全部通过？
    /        \
   是          否
   ↓           ↓
允许发布   触发测试闭环（P12）
              ↓
         修复完成后重新触发
```

### 与 Pipeline 引擎的集成

- 新增 Pipeline 模板：`release-qa-gate`【规划】
- Stage 编排：
  1. `script` — 部署到准生产环境
  2. `script` — 跑全量部署测试
  3. `script` — 跑 E2E 测试
  4. `script` — 跑回归测试
  5. `approval` — 发布负责人 + QA 会签
  6. `capability` — 触发正式发版
- 任何 script 失败 → 自动回滚准生产环境 + 触发 Bug Issue

### 测试人员的角色转变

- **过去**：测试人员手工跑用例、手工记录、手工提 bug
- **现在**：
  - 机器跑大部分用例
  - 测试人员聚焦 **探索性测试** + **用户体验** + **真实场景 E2E 设计**
  - 平台提供"**合格版本**"作为测试起点（通过 MR 门 + 自动化测试后的版本）

### 产出物

- 测试报告自动归档
- 覆盖率趋势图
- 发布质量评分卡（自动评分）
- 失败用例沉淀到回归测试库

---

## P14 · IM 接入层

**钉钉（DingTalk Stream 模式）**

- 长连接 WebSocket，订阅机器人消息 + 卡片回调
- 支持纯文本、富文本、引用回复、多图片

**飞书（Feishu Webhook 模式）**

- HTTP 推送 + url_verification 握手
- 消息事件 + 卡片 `card.action.trigger`

**统一接口 NormalizedMessage**

- 文本 / 图片 / @ 引用 / 用户 & 群标识全部平台标准化
- InteractiveCard：title / body / actions，回调数据透传

---

## P15 · AI Agent 核心

**运行链路**：`@snack-kit/porygon` 启动 Claude CLI → MCP Server (stdio) → 工具库
**会话管理**：按 `(platform, groupId)` 维度，8 小时 TTL
**模型**：默认 Opus 4.7，OAuth Token 走 system_config（Web UI 热改）

**当前内置 Agent**

1. **Bug 分析 Agent**【现有】 — 4 阶段 + L1-L4 分级
2. **PRD Agent**【现有】 — 多轮对话 + baseline 埋点
3. **架构设计 Agent**【现有】 — schema-v24

**规划中的 Agent**

4. **Epic / Story 拆分 & Review Agent**
5. **ATDD 生成 Agent**
6. **规范审核 Agent**
7. **MR 质量门 Agent**（五维并发）
8. **测试修复 Agent**（对接 Bug Issue → 自动修复闭环）
9. **发布质量门 Agent**（E2E + 回归）

---

## P16 · MCP 工具库

**现有 42 个工具，7 大类**

| 类别 | 示例 | 数量 |
|------|------|------|
| 运维 / 部署 | execute_deploy、rollback、restart、switch_version、get_logs | 8 |
| 代码 / 仓库 | read_code、create_mr、review_mr_diff、submit_review | 7 |
| 制品 / 镜像 | list_artifacts、download_image | 3 |
| 知识 / 文档 | read_prd、save_prd、search_knowledge、read_arch | 9 |
| Bug 修复 | fix_code、run_tests、update_ai_summary | 3 |
| 审批 / 工作流 | request_approval | 1 |
| 管理 / 权限 | manage_role、list_projects、ssh-utils | 3 |

**规划新增（v3 新能力对应）**

- 规范类：`load_company_standards`、`load_product_standards`、`check_standard_compliance`
- 开发类：`split_epic`、`review_epic`、`split_story`、`review_story`、`generate_atdd`
- **测试类（v3 核心新增）**：
  - `run_project_tests` — 标准化调用 `./scripts/test.sh`
  - `check_test_coverage` — 覆盖率达标检查
  - `validate_test_infra` — 脚本 / 镜像 / 环境合规检查
  - `create_bug_from_test_failure` — 测试失败自动提 Bug Issue
  - `run_e2e_tests` / `run_deployment_tests` — 发布前全量验证
- MR 质量门：`qa_gate_check`、`auto_fix_from_review`

---

## P17 · 审批工作流（Gate → Router → Escalation）

1. **Gate** — 规则命中则 `pending_approval`，否则直通
2. **Router** — 四层优先级：`(action, env) > (action, *) > (*, env) > (*, *)`
3. **Escalation** — 一级超时转备选，二级超时自动取消 + 群通知

**规则维度**：primary / backup 审批人、primary / total 超时
**与 Pipeline 联动**：`approval` stage 支持静态 + 动态 resolver（按 Bug Level / owner）

---

## P18 · Pipeline 引擎（可视化 DAG）

**5 种 Stage**：script / capability / approval / im_input / wait_webhook
**4 种触发**：Cron / IM 对话 / Web 手动 / API
**关键能力**：SSH 远程执行、变量插值、制品解析、条件分支

**v3 新增 Pipeline 模板**【规划】

- `mr-quality-gate` — MR 五维并发审核
- `release-qa-gate` — 发布前全量部署 + E2E + 回归

---

## P19 · IM 驱动的流水线（v19 能力）

**核心价值**：把"填表单"从 Web 搬进群聊。

**链路**

```
IM 消息 → capability.default_pipeline_id → runPipeline
         ↓
      im_input stage → interrupt()
         ↓
      im-router 注册 (platform, groupId) ↔ (runId, stageIndex)
         ↓
      im-notifier 推 prompt 到群
         ↓
      用户 IM 回复 → resumeFromImInput 恢复
```

**保障**：im-input-agent 启发式识别 + race-winner claim

---

## P20 · Bug 分析 & 自动修复流程

**4 级分级**（v25 起内置 4 个 Pipeline 模板）

| 等级 | 类型 | 自动化 |
|------|------|--------|
| L1 | 配置类 | 全自动 |
| L2 | 简单代码 | 全自动 |
| L3 | 业务逻辑 | 全自动 |
| L4 | 架构级 | 仅分析 |

**v3 新接入场景**

- **测试失败 → Bug Issue → 自动修复**（P12 闭环）
- 复用 4 阶段分析 + fix-runner 串行
- MR 状态对账继续保障最终一致性

---

## P21 · 管理后台

**现有 19 页面** — 基础配置 / 能力与规则 / 流水线 / AI 工作台 / 可观测 / 用户

**v3 规划新增页面**

- **规范中枢**：公司 / 产品规范索引 + 版本
- **Epic / Story 看板**：托管开发进度
- **MR 质量门**：五维得分 + 自动修复历史
- **测试质量看板（v3 核心）**：
  - 覆盖率趋势图（per 产品线 / per 项目）
  - 测试失败 TopN + 自动修复成功率
  - 基础设施合规度（脚本 / 镜像 / 环境）
- **发布质量评分卡**：历次发版的 E2E / 回归 / 部署测试通过率

---

## P22 · 数据库与演进

**现有 26 版本**（关键里程碑 v19-v26）：IM Pipeline、Owner 重构、分支能力、PRD V2、架构 Agent、PAM bootstrap、system_prompt 同步

**v3 规划新增表**

- `epics` / `stories` — Epic/Story 拆分产物
- `atdd_cases` — ATDD 用例
- `mr_quality_reviews` — MR 五维审核记录
- `standards_versions` — 规范版本锚定（关联 commit sha）
- `auto_fix_history` — 自动修复重试链路
- **测试相关（v3 核心）**：
  - `test_runs` — 每次测试执行记录（含覆盖率）
  - `test_coverage_history` — 覆盖率时序
  - `test_infra_audits` — 测试基础设施合规检查结果
  - `release_qa_reports` — 发布前质量门执行记录

---

## P23 · 部署与 CI

**Docker 两层构建**：base（依赖层）+ app（业务层）
**GitLab CI**：build-base（lockfile 变更）+ build-app（master/tag 推送）
**deploy.sh**：`up | down | restart | logs | status | migrate`

**配置管理**：`.env` 最小化（`DATABASE_URL`），凭证走 `system_config` 表（Web UI 热改）

---

## P24 · 关键工程规范（v3 扩展）

**ChatOps 平台自身规范**

- GitLab 配置统一入口：`resolveGitlabConfig()`
- Tool 自注册三步走
- 迁移文件幂等：`IF NOT EXISTS` + `ALTER TABLE IF`
- 命名对齐：DB `snake_case` ↔ TS `camelCase`
- 前端表单：枚举字段 Select 化

**产品项目必须遵守的公司级规范（v3 核心）**

| 类别 | 强制要求 |
|------|----------|
| 文档 | PRD / 设计文档以 markdown 存项目 git，走 MR 评审 |
| 规范载体 | 公司 / 产品规范 markdown 存 GitLab 知识库 |
| 测试入口 | `./scripts/test.sh` 统一入口，不分语言 |
| 测试覆盖率 | 总体 ≥ 70%，核心 ≥ 90% |
| 编译脚本 | **`./scripts/build.sh` 必须跑测试，测试失败 = 编译失败** |
| 打包脚本 | `./scripts/package.sh` 输出标准制品 |
| 基础镜像 | `Dockerfile.base` / `Dockerfile.test` 必备 |
| 环境准备 | `test-setup.sh` 可幂等执行 |

**违反后果**：规范审核中枢不过 → MR 拒绝合入。

---

## P25 · 价值、成果与规划

**已实现价值**

- **统一运维入口**：IM 对话 → 部署 / 回滚 / 日志 / MR 审核
- **AI 辅助设计**：PRD / 架构文档多轮对话 + 结构化入库
- **Bug 自动化**：L1-L3 全自动闭环
- **企业级兜底**：审批 + 超时升级 + 审计日志

**v2 目标（规划中）**

- 规范中枢上线 — 公司 / 产品规范 markdown 化
- PRD / 设计文档 MR 卡点
- 平台托管开发 MVP — Epic/Story + ATDD
- MR 五维质量门 — 并发审核 + 自动修复

**v3 目标（v3 核心新增）**

- **测试基础设施规范化** — 脚本 / 镜像 / 环境模板统一
- **MR 测试门禁** — 覆盖率硬约束 + 测试失败自愈闭环
- **发布前质量门** — 全量部署 + E2E + 回归自动化
- **编译即测试** — build.sh 强制集成测试，测试失败 = 编译失败

**更长期愿景**

- 多 IM 平台（企业微信 / Slack）
- 多租户 / 跨产线隔离
- 更多 Agent 场景（测试用例生成、发布说明、值班机器人）
- 成本与可观测（Claude Token / 执行耗时 / 失败率看板）

> 🎯 核心目标：**让 AI 做能做的，让人做该做的，规范和测试做裁判。**
