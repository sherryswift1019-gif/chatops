# ChatOps 项目汇报（v5 研发全流程版 · 含 Skills 商店）

> PPT 脚本 · 2026-04-23 · 共 27 页
> v5 升级点：新增「Skills 商店」模块，动态编排 AI 能力包

> **能力状态标记**
> `【现有】` = 已实现并在生产运行
> `【规划】` = 设计清晰，待实现或迭代中
> `【愿景】` = 方向明确，细节待对齐

---

## 封面

- **标题**：ChatOps — 研发全流程智能协同平台
- **副标题**：规范驱动 · 测试兜底 · 自我迭代 · Skills 可组合 · 一站式闭环
- **汇报范围**：全流程能力地图、核心机制、当前进度、演进规划
- **日期**：2026-04-23

---

## P1 · 项目定位（v5 升级）

**一句话**：覆盖 **PRD 设计 → 代码开发 → MR 审核 → 测试 → 部署运维** 的全流程平台，让 AI 做能做的，让人做该做的，**规范和测试做裁判，经验让平台自我进化，Skills 让能力可组合复用**。

- **四大阶段 + 三大裁判机制 + Skills 商店**：
  1. **设计阶段** / **开发阶段** / **评审阶段** / **运维阶段**
  2. 规范中枢 / 测试中枢 / 学习中枢
  3. **Skills 商店**（v5 新）— AI 能力包按场景动态装配
- **质量承诺**：不过门禁的代码到不了生产，同一错误不犯第二次，**能力复用不重复造轮子**

---

## P2 · 解决什么问题

**研发全链路痛点**

- PRD 质量参差、规范散落、代码习惯不一
- 测试覆盖率无硬约束、基础设施参差
- MR review 耗时主观，质量标准无法机器化
- 经验难沉淀，同类错误反复犯
- **AI 能力碎片化**：找 bug、修 bug、写 ATDD、做 code review……每个场景都要重新写 prompt，缺乏可复用单元（v5 新增痛点）
- 运维散落在多系统，上下文切换频繁

**ChatOps 的切入点**

- 规范显性化 + 测试强约束 + 文档入 Git + 双通道开发 + 五维 MR 门禁 + 发布前质量门
- 自我迭代：bug→回归、PRD→prompt、override→样本库
- **Skills 可组合**（v5 新）：把"找 bug 的最佳实践""修 bug 的标准流程""写 ATDD 的结构化模板"封装成 Skill，按任务类型按产品线动态装配到 Claude Code
- 运维对话化：IM 触发流水线 + 审批超时升级

---

## P3 · 研发全流程视图（v5 加入 Skills 商店）

```
┌────────────────────────────────────────────────────────────────────────┐
│  规范中枢        │  测试中枢         │  学习中枢       │  Skills 商店  │
│  公司/产品 MD    │  覆盖率/脚本规范  │  prompt 补丁    │  能力包装配   │
│  （硬约束）      │  （硬门禁）       │  （经验沉淀）   │  （能力复用） │
└──────┬─────────────┬─────────────────┬─────────────────┬─────────────┘
       │             │                 │                 │
       └─────────────┴─────────────────┴─────────────────┘
                     ▼（四中枢共同作用于每个阶段）
┌──────────────┐    ┌──────────────┐    ┌──────────────────┐
│ ① 设计阶段   │    │ ② 开发阶段   │    │ ③ 评审阶段       │
│ PRD / Arch   │ →  │ 托管 / 手动   │ →  │ MR 五维质量门    │
│ → MD MR 卡点 │    │ ATDD 驱动    │    │ 不过→自愈闭环    │
└──────┬───────┘    └──────┬───────┘    └──────┬───────────┘
       └───────────────────┴───────────────────┘
                           ▼
┌────────────────────────────────────────────────────────────────────────┐
│              ④ 运维阶段（IM 对话式 + 发布前质量门）                     │
└────────────────────────────────────────────────────────────────────────┘
                           ▲
                    事件 → 学习中枢 → 回流到 Skills 和 prompt
```

---

## P4 · 整体架构（v5 更新）

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
│  ↑ 动态注入：规范 + Skills + 学习补丁  │
│  DAG Executor (Cron/IM/API/Web)       │
│  MCP 工具库（42+）+ Skills 商店（v5） │
└──────────┬────────────────────────────┘
           ▼
┌─ 四中枢（v5）─────────────────────────┐
│  规范中枢 / 测试中枢 / 学习中枢       │
│  Skills 商店（v5 新）                  │
└──────────┬────────────────────────────┘
           ▼
┌─ 数据层 ──────────────────────────────┐
│  PostgreSQL 16 · GitLab · Harbor     │
└───────────────────────────────────────┘
           ▲
┌─ 管理后台 ────────────────────────────┐
│  React 18 + Ant Design 5 SPA         │
│  含 Skills 商店页面（v5）             │
└───────────────────────────────────────┘
```

---

## P5 · 能力全景（v5 更新）

| 维度 | 数量 | 说明 |
|------|------|------|
| 研发阶段覆盖 | **4** | 设计 / 开发 / 评审 / 运维 |
| 核心中枢 | **4** | 规范 / 测试 / 学习 / **Skills 商店** |
| 开发模式 | **2** | 平台托管 / 手动 |
| MR 审核维度 | **5** | 需求 / 代码 / 安全 / 公司规范 / 自动化测试 |
| 测试门禁 | **3** | 编译 / MR / 发布 |
| 自迭代能力 | **9** | 5 知识沉淀 + 2 运行时自愈 + 2 协作反馈 |
| Skills 预置分类 | **6** | 设计 / 开发 / Bug / 测试 / 评审 / 运维 |
| 覆盖率硬约束 | **2 档** | 总体 ≥ 70% · 核心 ≥ 90% |
| 内置 AI Agent | **3+** | Bug 分析、PRD、架构（规划中 5+） |
| MCP 工具 | **42** | 7 大类 |
| Admin API 模块 | **27** | 配置、执行、权限、审计 |
| 前端页面 | **19** | 管理后台 SPA |
| DB Schema 版本 | **26** | 增量迁移 |
| IM 平台 | **2** | 钉钉 / 飞书 |
| Pipeline Stage 类型 | **5** | script / capability / approval / im_input / wait_webhook |
| 触发方式 | **4** | Cron / IM / Web / API |
| Bug 分级 | **4** | L1 / L2 / L3 / L4 |

---

## P6 · 规范审核中枢

**核心理念**：规范不是文档，是**可执行的校验器**。

**规范分层**

- **公司级**：多语言 / 多租户 / 认证防护 / UX / UI / 日志 / 错误码 / API 契约 / 测试规范 / 脚本规范
- **产品级**：领域模型 / 术语词典 / 权限模型 / 命名约定

**加载**【规划】：GitLab markdown → 审核时动态注入 → 改 MD 即生效，commit sha 锚定

**4 大卡点**：PRD 评审 / Epic-Story 拆分 / MR 代码 / MR 测试

---

## P7 · PRD & 设计评审闭环

**原则**：**不管用户怎么写，只审核最终 markdown**

```
编写（PRD Agent / Claude Code / 任意编辑器）
  → 文档进项目 Git → 发起 MR
  → AI 评审（完整性 / 规范 / 可实现性 / 已有一致性）
  → 人工会签（产品 / 架构 / 安全）
  → 不通过改 → 重审 → 合入 → 作为开发输入
```

---

## P8 · 开发阶段：双模式并存

- **模式 A 平台托管**【愿景】：Epic→Story→ATDD→Code→Self-Review→MR
- **模式 B 手动**【现有】：Claude Code 本地 → MR
- **汇聚点**：统一走 MR 五维质量门 + 统一规范 + 统一测试约束

---

## P9 · 平台托管开发的关键机制

- **Epic 1-2 周 / Story 0.5-2 天**
- **ATDD 驱动**：Given/When/Then 含非功能验收，代码必须让 ATDD 通过
- **MR 粒度小**，一个 MR 做一件事

---

## P10 · MR 审核质量门（五维）

```
① 需求匹配   ② 代码质量   ③ 安全   ④ 公司规范   ⑤ 自动化测试
```

**闭环**：不过 → 自动修复 Agent → 重审 → 达上限通知人工

---

## P11 · 自动化测试：质量基石

**覆盖率**：总体 ≥ 70% · 核心 ≥ 90%

**基础设施（强制）**：`scripts/{build,package,test}.sh` + `Dockerfile.{base,test}` + `test-setup.sh` + `coverage.config`

**三道门**：编译门（build.sh 内嵌测试）/ MR 门 / 发布门

---

## P12 · 测试失败的自愈闭环

```
测试失败 → Bug Agent 开合规 Issue → Fix Agent 修复 → push → 重审 ↺
3 次不过 → 群通知 owner + 人工接管
```

---

## P13 · 发布前质量门

全量部署测试 + E2E + 回归测试 → 全过才允许发版
QA 角色从手工跑用例 → 探索性测试 + 真实场景 E2E 设计

---

## P14 · AI 自我修复与自我迭代

### 知识沉淀（历史 → prompt）

| # | 能力 | 产物 |
|---|------|------|
| **A1** | Bug 修复强制附 E2E 回归用例 | 回归测试库 |
| **A2** | PRD commit → 项目级优化提示词 | `project_prompt_supplements` |
| **A3** | MR 评审失败聚类 → 代码反模式手册 | Review Agent 项目 prompt |
| **A4** | 规范违反 → 规范库自生长 | AI 自动向知识库提 MR |
| **A5** | 自动修复失败 → Agent 盲区手册 | `ai_blind_spots` 表 |

### 运行时自愈 & 协作反馈

| # | 能力 | 行为 |
|---|------|------|
| **B3** | 部署失败 → 自动回滚 + 根因 Bug Issue | rollback + 带 diff 开 bug |
| **B5** | Claude 异常 → 模型降级 | Opus → Sonnet → Haiku，恢复后回升 |
| **D1** | 人工 override → 误判样本库 | `ai_override_samples`（反面训练） |
| **D4** | 探索测试 → E2E 用例孵化 | 引导补 E2E + 规范条目 |

**闭环**：事件 → 入库 → 汇总 → 产物 → 注入下一次 AI 上下文 → 行为改善 ↺

---

## P15 · Skills 商店（v5 新增 · 核心模块）

**核心理念**：MCP 工具是**原子能力**（一次调用做一件事），Skills 是**组合能力**（把 prompt + 多工具使用模式 + 最佳实践 + 示例打包成可复用单元），按场景动态注入 Claude Code。

### 分类（6 大类，按研发场景映射）

| 分类 | Skill 示例 | 用途 |
|------|-----------|------|
| **设计类** | prd-writing、arch-drafting、domain-modeling | 设计阶段任务 |
| **开发类** | atdd-authoring、multi-tenant-refactor、api-contract、i18n-retrofit | 开发阶段任务 |
| **Bug 类** | bug-hunting（找 bug）、root-cause-analysis、bug-fixing-pattern | Bug 分析与修复 |
| **测试类** | unit-test-gen、e2e-authoring、coverage-boost | 测试阶段任务 |
| **评审类** | code-review、security-audit、standards-compliance | MR 评审维度 |
| **运维类** | deploy-playbook、log-diagnosis、incident-response | 运维阶段任务 |

### 配置粒度（分层绑定）

```
全局默认          —— 某类任务默认用哪些 skills
   ↓ 产品线覆盖
产品线级          —— 某条产线的专属 skills（如 PAM 专用）
   ↓ Capability 覆盖
能力级            —— 某个 capability 绑定特定 skills
   ↓ 场景级
场景级            —— 如 Bug L1 vs L4 分别绑不同 skills
```

规则：**下层覆盖上层**；管理后台可视化配置。

### 动态注入链路

```
任务触发（capability / pipeline stage / IM 消息）
       ↓
  识别任务类型 + 产品线 + 场景
       ↓
  匹配 Skill 绑定规则 → 选出应加载的 Skills
       ↓
  组装上下文（顺序固定）
    1. 基础 system prompt
    2. 公司规范 MD
    3. 产品规范 MD
    4. Skills 组合（v5 新）
    5. 项目 prompt 补丁（v4 学习中枢）
       ↓
  启动 Claude Code 会话
```

### 来源与导入

- **内置官方 Skills**（平台出厂预置）
- **用户自定义 Skill**（管理后台 Web 编辑器）
- **GitLab 仓库导入**（`skill.yaml` + 关联 `.md`，按仓库托管 + 版本管理）
- **打包导入**（zip / tar，一次多个 skill）
- **版本管理**：每个 skill 带 semver，可回滚

### Skill 格式约定【规划】

```yaml
# skill.yaml
name: bug-hunting
version: 1.2.0
category: bug
description: 系统化定位 bug 根因的最佳实践
tools_required:           # 依赖的 MCP 工具
  - read_code
  - get_logs
  - analyze_bug
applicable_scope:          # 适用场景过滤
  bug_levels: [L1, L2, L3]
prompt_file: prompt.md     # 主 prompt 内容
examples_dir: examples/    # few-shot 示例
```

### 与其他模块的关系

| 模块 | 关系 |
|------|------|
| MCP 工具 | Skill **消费** 工具；一个 skill 可引用多个工具 |
| 规范中枢 | 规范说"不能做什么"（硬约束）；Skills 说"怎么做漂亮"（软能力） |
| 学习中枢 | 学习中枢的产物（项目 prompt 补丁）可**孵化**成新 Skill 或 Skill 新版本 |
| Pipeline | Pipeline 的 `capability` stage 可指定 Skills 覆盖规则 |

### 管理后台页面（新增）

- **Skills 商店首页**：分类浏览 + 搜索 + 使用量排序
- **Skill 详情**：版本 / 文档 / 使用示例 / 依赖工具
- **绑定配置**：全局 / 产品线 / capability / 场景四层绑定可视化
- **使用度量**：每个 skill 的触发次数、成功率、平均耗时

---

## P16 · IM 接入层

- **钉钉** Stream 模式：WebSocket 长连 + 卡片回调
- **飞书** Webhook 模式：HTTP 推送 + card.action.trigger
- **统一接口** NormalizedMessage：文本 / 图片 / @引用 / 群标识跨平台标准化

---

## P17 · AI Agent 核心

**运行链路**：porygon 启动 Claude CLI → MCP Server → **动态注入 Skills**（v5 新）→ 工具库

**会话**：`(platform, groupId)` · 8h TTL
**模型**：Opus 4.7 默认 + 热替换 + 降级（B5）

**现有 Agent**：Bug 分析 · PRD · 架构
**规划 Agent**：Epic/Story 拆分 & Review · ATDD 生成 · 规范审核 · MR 质量门 · 测试修复 · 发布质量门 · **Skills 编排 Agent**（v5 新：根据任务类型自动选 skills）

---

## P18 · MCP 工具库

**现有 42 个**（7 大类）：运维 / 代码 / 制品 / 知识 / Bug 修复 / 审批 / 管理

**规划新增**

- 规范类 / 开发类 / 测试类 / MR 质量门类 / 自迭代类（见 v3-v4）
- **Skills 管理类（v5）**：
  - `list_applicable_skills` — 按任务类型查找可用 skills
  - `install_skill_from_url` — 从 GitLab 仓库导入 skill
  - `configure_skill_binding` — 修改绑定规则

---

## P19 · 审批工作流

Gate → Router → Escalation
Router 四层优先级：`(action, env) > (action, *) > (*, env) > (*, *)`
Escalation：一级超时转备选 / 二级超时取消 + 群通知

---

## P20 · Pipeline 引擎（可视化 DAG）

**5 种 Stage**：script / capability / approval / im_input / wait_webhook
**4 种触发**：Cron / IM / Web / API

**Capability stage 的 Skills 扩展**【规划】：可在 stage 定义时覆盖默认 skills 绑定

**新增模板**：`mr-quality-gate` / `release-qa-gate` / `learning-summary`

---

## P21 · IM 驱动的流水线（v19 能力）

`im_input` stage → interrupt → 等用户 IM 回复 → resume
保障：启发式参数识别 + race-winner claim

---

## P22 · Bug 分析 & 自动修复

**4 级分级**：L1/L2/L3 全自动，L4 仅分析
**v4 强化**：修复 MR 必须带 E2E 回归用例、失败 → 盲区登记
**v5 强化**：L1/L2/L3/L4 可**各自绑定不同 Skills**（如 L4 绑 architecture-review，L1 绑 config-diff）

---

## P23 · 管理后台

**现有 19 页面** — 基础配置 / 能力规则 / 流水线 / AI 工作台 / 可观测 / 用户

**规划新增页面**

- 规范中枢、Epic/Story 看板、MR 质量门、测试质量看板、发布质量评分卡
- 学习中枢看板（回归曲线 / prompt 补丁 / 反模式 / 盲区 / override 热力）
- **Skills 商店页面（v5 核心）**：
  - 分类浏览 + 搜索 + 导入（GitLab / 打包）
  - 绑定配置（全局 / 产线 / capability / 场景）
  - 使用度量（触发次数 / 成功率 / 耗时）
  - 版本管理（发布 / 回滚）

---

## P24 · 数据库演进

**现有 26 版本**（关键 v19-v26）

**v3-v5 规划新增表**

- v3 测试 / 评审：`test_runs`、`test_coverage_history`、`mr_quality_reviews`、`auto_fix_history` 等
- v4 学习中枢：`regression_test_cases`、`project_prompt_supplements`、`review_antipatterns`、`standards_violations`、`ai_blind_spots`、`ai_override_samples`
- **v5 Skills 商店（新）**：
  - `skills` — skill 定义（name / version / category / content / tools_required）
  - `skill_versions` — 版本历史
  - `skill_bindings` — 绑定规则（scope_type / scope_id / skill_id / priority）
  - `skill_invocations` — 使用记录（用于度量）
  - `skill_imports` — 导入来源审计（GitLab URL / commit sha / 导入人）

---

## P25 · 部署与 CI

- **Docker 两层**：base（依赖）+ app（业务）
- **GitLab CI**：build-base + build-app
- **deploy.sh**：`up | down | restart | logs | status | migrate`
- **配置**：`.env` 最小化，凭证走 `system_config` 表

---

## P26 · 关键工程规范

**ChatOps 平台自身**

- `resolveGitlabConfig()` 统一入口、Tool 自注册、迁移幂等、命名对齐、前端表单 Select 化

**产品项目必须遵守的公司级规范**

| 类别 | 强制要求 |
|------|----------|
| 文档 | PRD / 设计文档 markdown 进项目 git，走 MR 评审 |
| 规范载体 | 公司 / 产品规范 markdown 存 GitLab 知识库 |
| 测试入口 | `./scripts/test.sh` 统一入口，不分语言 |
| 测试覆盖率 | 总体 ≥ 70%，核心 ≥ 90% |
| 编译脚本 | **`./scripts/build.sh` 必须跑测试，测试失败 = 编译失败** |
| 打包脚本 | `./scripts/package.sh` 输出标准制品 |
| 基础镜像 | `Dockerfile.base` / `Dockerfile.test` 必备 |
| 环境准备 | `test-setup.sh` 可幂等执行 |
| Bug 修复 | **修复 MR 必须带 E2E 回归用例**（v4） |
| **Skill 导入（v5）** | **外部 Skill 必须走 GitLab 仓库或签名打包导入，禁止直接 DB 插入** |

---

## P27 · 价值、成果与规划

**已实现价值**

- 统一运维入口（IM 对话式）
- AI 辅助设计（PRD / 架构）
- Bug 自动化闭环（L1-L3）
- 企业级兜底（审批 / 超时升级 / 审计）

**v2 目标**：规范中枢 · PRD/设计 MR 卡点 · 托管开发 MVP · MR 五维质量门

**v3 目标**：测试基础设施规范化 · MR 测试门禁 · 发布前质量门 · 编译即测试

**v4 目标**：9 项自迭代能力（Bug→E2E 回归 / PRD→prompt 补丁 / 反模式手册 / 规范自生长 / 盲区手册 / 部署自愈 / 模型降级 / override 样本 / E2E 孵化）

**v5 目标**（本次新增）

- **Skills 商店上线** — 6 大类预置能力包
- **动态注入** — 运行时按任务 / 产线 / 场景装配
- **导入机制** — GitLab 仓库 + 打包导入 + 版本管理
- **使用度量** — 每个 skill 的调用次数、成功率、耗时
- **Skills 编排 Agent** — 根据任务自动挑 skills
- **与学习中枢协同** — 项目 prompt 补丁可孵化成新 Skill

**更长期愿景**

- 多 IM 平台（企业微信 / Slack）
- 多租户 / 跨产线隔离
- 成本与可观测看板
- **Skill 社区 / 跨团队分享**（v5 衍生方向）

> 🎯 核心目标：**让 AI 做能做的，让人做该做的，规范和测试做裁判，经验让平台自我进化，Skills 让能力可组合复用。**
