---
stepsCompleted: ['step-01-init', 'step-02-discovery', 'step-03-success', 'step-04-journeys', 'step-05-domain', 'step-06-innovation', 'step-07-project-type', 'step-08-scoping', 'step-09-functional', 'step-10-nonfunctional', 'step-11-polish', 'step-12-complete']
completedAt: '2026-04-15'
status: 'complete'
inputDocuments:
  - docs/product/ai-assistant-requirements.md
  - docs/brainstorming/brainstorming-session-2026-04-14.md
  - docs/product/migration-analysis.md
  - docs/chatops.md
documentCounts:
  briefs: 0
  research: 0
  brainstorming: 1
  projectDocs: 3
workflowType: 'prd'
classification:
  projectType: saas_b2b
  secondaryType: developer_tool
  domain: general
  complexity: medium
  projectContext: brownfield
---

# Product Requirements Document - ChatOps 研发 AI 助手

**Author:** Hanff
**Date:** 2026-04-15

## Executive Summary

### 产品定位

**ChatOps 研发 AI 助手** 是 ChatOps 平台的一个能力模块，聚焦「Bug 分析 → 修复 → 验证 → 知识沉淀」全流程闭环。与 Cursor/Copilot 等代码补全工具不同，本产品做的是**指挥官层**：接收问题 → 调度 Agent → 编排流程 → 人机协作验收 → 知识回流。

团队路径：**先内部跑通 PAM 产品线闭环，成熟后作为增值服务推客户。**

### 核心差异化

本产品不是 "AI 外包"，而是 "AI 正式员工" —— 越用越值钱：

| 能力 | 差异点 |
|------|--------|
| **多 Agent 独立协作** | 分析 / 修复 / Review 三角色解耦，独立 systemPrompt 和 CLI 权限硬限制 |
| **Bug 分级路由** | L1-L4 自动分级，不同级别走不同人机协作流程；3 次失败自动降级 |
| **文档分层 + 摘要同步** | AI 摘要随代码走 + 知识库独立 Git 仓库；修复 Agent 改代码时同步更新摘要 |
| **Bug 根因归因** | 追溯问题是「需求 / prompt / 摘要 / 编码」哪一环，反推知识体系进化 |
| **私有化 + 数据留存** | 客户知识库归客户所有，成为迁移壁垒（对比 Devin 等 SaaS 型竞品） |

### 目标用户

5 类研发协作角色：**研发 / 测试 / 运维 / 售后 / 交付**。内部 MVP 聚焦 PAM 产品线全团队覆盖；Growth 阶段推客户（银行 / 国企 / 关基行业研发）。

### 构建基础

复用 ChatOps 已有平台（IM 适配层、Agent 编排、审批流程、RBAC、流水线引擎），**新增部分聚焦 3 类能力**：
1. 分析 / 修复 / Review capability + MCP 工具
2. 代码隔离沙箱 + 知识库仓库 + AI 摘要体系
3. Bug 流程实例前端 + 价值量化仪表盘

### MVP 成功定义

完成**里程碑 1（分析闭环）+ 里程碑 2（修复闭环）**，覆盖 PAM 全产品线研发团队，L1 自动修复率 ≥90%，L2 70-80%，端到端有效率 ≥70%。

## Success Criteria

### User Success

研发 AI 助手面向 5 类研发协作角色提供**问题发现 → 修复 → 知识沉淀**的全流程能力，每类角色有不同的成功体验：

| 角色 | 核心成功体验 | 关键度量 |
|------|-------------|---------|
| **研发** | 收到 Bug 后不用再从零开始分析，AI 已给出根因+方案+置信度；L1/L2 级 Bug 的 MR 已经生成，Review 即合并 | Bug 修复时间缩短 ≥50% |
| **测试** | 回归测试失败自动触发分析，输出结构化失败原因，不用再定位日志堆栈 | 分析/排查环节人工耗时减少 70%（4h → 1h） |
| **运维/售后/交付** | 客户反馈的问题在钉钉群 @机器人即可获得分析报告；同类问题秒回（知识库命中）| 知识库命中率 3 个月后 ≥30% |
| **模块负责人** | L3 方案审批环节减少反复讨论，AI 已给出结构化方案，审批即可 | 方案审批轮次 ≤2 次 |

**用户关键"aha"时刻：**
- 钉钉 @机器人 描述 Bug 现象 → 秒级返回历史知识库命中的修复方案
- 首次看到 AI 自动创建的 MR（代码 + AI 摘要更新 + 测试通过）只需 Review 按钮点击即可完成修复
- Bug 修复时间从"发现 → 定位 → 修复 → 测试 → 合并"的多小时流程压缩到小时级甚至分钟级

### Business Success

#### 内部成功（MVP 阶段）

**定义：里程碑 1（分析闭环）+ 里程碑 2（修复闭环）完成并在 PAM 产品线全量使用**

| 指标 | 目标 | 衡量方式 |
|------|------|---------|
| **采用覆盖** | PAM 全产品线研发团队接入 | 所有 PAM 子模块（PAS/OSC/YAUM/BPM/Proxy）均有 Bug 通过 AI 助手处理 |
| **L1 自动修复率** | ≥90% | L1 配置类 Bug 中，AI 提 MR 无人工修改直接合并的比例 |
| **L2 自动修复率** | 70-80% | L2 简单代码 Bug 中，AI 提 MR 经人工 Review 后合并的比例 |
| **L3 方案采纳率** | ≥60% | L3 业务逻辑 Bug 中，AI 方案经审批通过的比例 |
| **L1+L2 覆盖占比** | ≥60% | L1/L2 级 Bug 占总 Bug 量的比例（验证分级路由价值） |
| **端到端有效率** | ≥70% | 综合知识库命中 + AI 修复成功率 |

#### 外部成功（推客户阶段，Growth+）

当内部 MVP 验证成功后，以下 4 个客户价值锚点共同支撑客户采购决策：

| 价值锚点 | 衡量指标 | 适用买单方 |
|---------|---------|----------|
| **效率提升 ROI** | 工时节省 × 研发单价的量化报告 | 研发总监 / CTO |
| **代码安全/合规** | CVE 扫描覆盖率、代码审计报告、敏感信息脱敏 | 安全部门 / 合规负责人 |
| **AI 正式员工** | 知识库条目数、Bug 模式识别数、代码健康趋势 | CTO / 数字化转型负责人 |
| **私有化 + 数据留存** | 支持完全私有化部署、客户知识库归客户所有 | 银行 / 国企 IT 负责人 |

#### 里程碑验收节奏（不设硬时间）

每个里程碑完成后评估成效，通过再进入下一阶段：

- **里程碑 0 验收**：平台基础设施扩展完成（图片消息 / stage 类型 / capability 注册 / Bug 修复实例页面可用）
- **里程碑 1 验收**：分析 Agent 输出"分析报告 + 置信度 + Bug 级别 + 修复方案"，知识库初始化并命中率初步达到 15%+
- **里程碑 2 验收（MVP 完成）**：L1 全自动到 MR，L2 半自动；AI 修复 Agent 可独立完成 fix 分支 → 测试 → MR 全流程
- **里程碑 3 验收**：Bug 根因归因可追溯、知识库自动沉淀、价值量化仪表盘上线

### Technical Success

| 维度 | 指标 | 目标 |
|------|------|------|
| **分析响应时延** | 首次分析耗时 | 知识库命中秒级，未命中 ≤4 分钟（当前基线） |
| **追问响应时延** | Session 复用时的响应 | 秒级（Claude CLI --resume） |
| **并发支持** | 同时在线分析任务数 | 10-30 路并发，无相互干扰 |
| **代码隔离开销** | 10 并发时的磁盘总占用 | ≤100MB（git clone --shared 方案） |
| **安全防护** | 敏感信息泄露事件数 | 0 次（分析报告强制脱敏） |
| **Agent 权限越界** | 权限违规事件数 | 0 次（CLI 层 --allowed-tools 硬限制） |
| **失败恢复** | AI 修复 3 次仍失败的处理 | 100% 自动降级为 L3 流程并通知研发 |
| **平台可扩展性** | 新产品接入所需时间 | ≤1 天（配置 Git 地址 → 自动生成 AI 摘要 → 可分析） |
| **模型可替换性** | 切换底层模型的改动范围 | 只涉及 Porygon backend 层，不改业务逻辑 |

### Measurable Outcomes

以下是内部 MVP 达标后对外宣传的量化成效模板：

```
本月 AI 助手战报：
- 处理 Bug 总数：XX 个
- AI 自动修复：XX 个（占比 XX%）
- 节省研发工时：约 XX 小时
- 知识库命中率：XX%
- 人工 Review 平均时长：XX 分钟
- L1+L2 修复成功率：XX%
```

这份报告既是内部价值证明，也是客户侧的价值量化入口。

## Product Scope

### MVP - Minimum Viable Product

**范围：里程碑 0 + 里程碑 1 + 里程碑 2**

核心能力：

- **平台基础设施扩展**（里程碑 0）
  - 图片消息支持（NormalizedMessage + DingTalkAdapter 扩展）
  - test_pipelines stage 类型扩展（capability / wait_webhook）
  - 研发 AI 助手 capability 注册（analyze_bug / fix_bug_l1 / fix_bug_l2 / ai_review_mr）
  - Bug 修复流程实例页面（扩展 TestRunsPage）
- **分析闭环**（里程碑 1）
  - 知识库仓库搭建（每个产品独立 Git 仓库，AI 扫描生成初始知识条目）
  - analyze_bug MCP 工具集（读代码、搜索知识库、创建 Issue、下载截图）
  - 置信度标签（AI 分析报告自标高/中/低）
  - 方案先行 + 自动分级（L1-L4）
  - 知识库查询命中（index.json 匹配，命中则秒回）
  - GitLab Issue Webhook 驱动
- **修复闭环**（里程碑 2）
  - 修复 Agent 工具集（改代码、运行测试、创建 MR、更新 AI 摘要）
  - Bug 修复流程定义（L1/L2/L3 流程模板）
  - 失败降级机制（3 次重试不过 → 自动降级 L3）
  - AI 摘要随修复同步更新
  - AI Review Agent（独立 capability ai_review_mr）
  - L3 方案审批（复用 ChatOps ApprovalGate）

**MVP 交付标准（与 Success Criteria 对应）：**
- PAM 全产品线接入使用
- L1 Bug 从 Issue 创建到 MR 创建全自动
- L2 Bug 半自动（需人工 Review MR）
- 端到端有效率 ≥70%

### Growth Features (Post-MVP)

**范围：里程碑 3 + 能力横向扩展**

- **进化闭环**（里程碑 3）
  - Bug 根因归因（每个 Bug 标记根因类型：需求/prompt/摘要/编码）
  - 知识库自动沉淀（Issue 关闭后自动生成知识条目）
  - 价值量化仪表盘（修复成功率、命中率、耗时趋势、工时节省）
  - L3 流程完整编排（方案审批 stage + fix capability 串联）
  - 多模型可插拔（抽象 Porygon backend 层）
- **能力横向扩展**（P1/P1.5 需求）
  - 代码 Review（钉钉发 MR 链接 → AI 给 Review 意见）
  - 发版影响分析（git diff 两个版本 → 影响评估）
  - SQL 审计（发 SQL → 语法/性能/安全检查）
  - 依赖漏洞扫描与修复（pom.xml CVE 扫描 + 自动 PR）
  - 初始化 SQL 生成（新增枚举/配置 → 自动生成 INSERT）
  - 环境巡检 / 值班告警处理 / 环境探测排障（P2 运维场景）
  - 钉钉问题转 GitLab Issue（@机器人说"转 Bug"）

### Vision (Future)

**范围：产品三层进化的第二、三层**

- **第二层：全产品知识大脑**
  - 对接钉钉文档、操作手册、白皮书等全量知识源
  - 服务全角色：产品、售前、交付、研发
  - 通过 MCP/CLI 长手脚对接外部系统
  - "AI 正式员工"定位，越用越值钱
- **第三层：越用越值钱的平台**
  - 客户知识库积累在平台上，迁移成本高
  - 数据壁垒 + 生态锁定
  - 可能的定价模式转型（工具订阅 → 员工工时）
- **无人值守代码工厂**
  - 全自动修复发布
  - 人只做知识管理和方案审批
  - Bug 模式识别驱动系统性优化
  - 主动出模块级 Bug 密度 / 质量趋势报告

## User Journeys

### Journey 1：研发小 A —— L1 配置类 Bug 一键闭环（成功路径）

**角色画像：** 小 A，PAM 产品线 pas-secret-task 模块研发，负责任务引擎。每个版本上线前总有 1-2 个初始化 SQL 漏加的问题，过去要定位根因、写 SQL、提 MR、跑测试，平均花 30 分钟。

**开场：** 周二下午 3 点，小 A 正在开发新功能。钉钉群里测试小王 @机器人发了一张截图："测试环境登录后提示「密码验证失败（TASK_PWD_4001）」"。

**进展：**
1. **AI 助手自动响应**：分析 Agent 查询知识库 → 未命中 → 启动完整分析
2. **独立 worktree 建立**：`git clone --shared` 创建隔离目录 `/tmp/analysis/wang-PAM-dev`，切到 dev 分支
3. **代码定位**：Agent 读 `docs/ai-summary/pas-secret-task.md` → 读 `PasswordTaskService` 源码 → 定位 `TASK_PWD_4001` 错误码
4. **根因判断**：错误码定义在 `ErrorCode.java`，但 `sql/202604011000.sql` 中缺少对应的 INSERT 语句
5. **AI 输出结构化方案**：
   - 分类：**L1 配置类**
   - 根因：初始化 SQL 缺少 TASK_PWD_4001 错误码定义
   - 置信度：**高（85%）**
   - 修复方案：在 `sql/` 目录新增 `202604151500.sql`，INSERT 错误码记录
6. **自动创建 GitLab Issue**：label = `fixing`，关联 pas-secret-task 模块
7. **修复 Agent 启动**：创建 fix 分支 `fix/issue-234`，写入新 SQL 文件，跑测试
8. **测试通过 → 创建 MR** 到 master，label = `ai-generated`
9. **钉钉 @小 A**："Issue #234（L1 TASK_PWD_4001）已修复，MR !567 待你 Review"

**高潮：** 小 A 打开 MR，diff 只有一个新 SQL 文件，10 秒看完，点击 "Approve & Merge"。

**结局：** Issue 自动关闭，知识库自动沉淀「TASK_PWD_4001 初始化 SQL 缺失」。总耗时：小 A 投入 30 秒，AI 自动完成剩余环节。过去 30 分钟的操作变成 30 秒。

**情绪曲线：** 好奇（什么问题） → 惊讶（AI 已经改完了） → 满意（一键合并）

**揭示的能力需求：**
- 钉钉消息解析（含截图）
- 知识库查询（先命中再分析）
- 代码隔离沙箱（git clone --shared）
- AI 摘要读取能力
- Bug 分级判断 + 置信度输出
- GitLab Issue 自动创建 + label 驱动流转
- AI 修复 Agent（改代码 + 跑测试 + 创建 MR）
- 钉钉 @通知（按模块负责人路由）

---

### Journey 2：研发小 B —— L3 业务逻辑方案审批（决策路径）

**角色画像：** 小 B，pas-bastion-host 模块负责人。对这块代码最熟悉，也最担心 AI 乱改。

**开场：** 周四早上，交付工程师钉钉反馈："客户现场堡垒机会话异常退出，错误码 SESSION_EXPIRED_9003"。

**进展：**
1. **AI 分析**：分析 Agent 读代码 → 定位到 `SessionManager.checkTimeout()` 的超时判断逻辑
2. **根因判断**：会话续期条件判断有缺陷，在"空闲 + 有活动连接"场景下会误判超时
3. **AI 输出结构化方案**：
   - 分类：**L3 业务逻辑**
   - 置信度：**中（65%）**
   - 方案 A：调整 `checkTimeout` 判断优先级，先检查活动连接
   - 方案 B：增加 `isConnectionActive()` 前置检查
   - 推荐方案 A（改动小，风险低）
4. **自动创建 Issue**：label = `needs-approval`，@模块负责人小 B
5. **钉钉 DM 卡片**：小 B 收到审批卡片，显示方案摘要 + "查看完整方案"链接

**高潮：** 小 B 查看方案，对比两个选项。发现方案 A 有个隐含风险：并发场景下 `lastActivityTime` 读取可能不一致。他在 GitLab Issue 评论里提出："推荐方案 B，但要加锁"。改 label 为 `approved` 并注明"按方案 B + 读写锁实现"。

**结局：**
1. Webhook 触发修复 Agent，按 B 方案 + 锁实现修复
2. 创建 MR → AI Review Agent 独立审查（从"这个改动是否有漏洞"视角） → 标记 `ai-approved`
3. 小 B 再次 Review，10 分钟看完 → 合并
4. 知识库沉淀「会话超时判断 + 并发锁」案例

**情绪曲线：** 警觉（复杂问题） → 参与（提出调整） → 信任（AI 按意见实现）

**揭示的能力需求：**
- 分析 Agent 输出多方案 + 推荐项
- 钉钉 DM 审批卡片（复用 ApprovalGate）
- GitLab label 驱动修复触发（Webhook）
- 修复 Agent 接收方案文档作为输入
- 独立 AI Review Agent（不同 systemPrompt，独立视角）
- 模块 → 负责人映射配置（需要管理后台）

---

### Journey 3：研发小 C —— AI 修复失败自动降级（恢复路径）

**角色画像：** 小 C，pas-service 模块研发。过去对 AI 自动修复持怀疑态度，担心 AI 改坏代码。

**开场：** 周一上午，自动化测试失败 @机器人。AI 分析判断为 L2（简单代码），预期能自动修复。

**进展：**
1. **分级为 L2** → 修复 Agent 启动
2. **第 1 次修复尝试**：改了 `ParamValidator.validate()` → 单元测试不过
3. **Agent 自动分析测试失败原因** → 调整代码 → **第 2 次尝试** → 仍失败
4. **第 3 次尝试** → 失败
5. **自动降级触发**：
   - Issue label 从 `fixing` 改为 `needs-manual`
   - 分级升级为 L3
   - **保留 fix 分支现状**（不删除，不 revert）
   - 钉钉 @小 C："Issue #289 自动修复失败 3 次，已降级。fix 分支 `fix/issue-289` 保留，含 AI 尝试的代码变更。请接手。"
6. **小 C 接手**：
   - 切到 `fix/issue-289` 分支
   - 查看 AI 的 3 次 commit（commit message 记录了每次失败的原因和调整思路）
   - 发现 AI 漏了一个边界条件
   - 基于 AI 的第 3 次尝试继续修改，补上边界判断
   - 提交 → 测试通过 → MR 合并

**高潮：** 小 C 发现 AI 的前两次尝试虽然失败，但思路是对的，只是边界处理不全。省去了自己从零分析问题的 20 分钟。

**结局：**
1. Issue 关闭
2. 知识库沉淀「ParamValidator 边界条件遗漏」的 AI 失败 + 人工修正路径
3. Bug 根因归因记录：AI 摘要对 `ParamValidator` 的边界定义不完整 → 触发摘要补充

**情绪曲线：** 烦躁（又要修 Bug） → 意外（AI 的思路是对的） → 高效（基于 AI 结果继续改）

**揭示的能力需求：**
- 修复失败 3 次自动降级（不是无限重试）
- fix 分支保留策略（不删不 revert）
- AI commit message 详细记录（方便人工接手）
- 分级自动升级 + 通知
- Bug 根因归因（反推知识体系优化点）

---

### Journey 4：交付工程师老张 —— 客户反馈秒回（知识库命中）

**角色画像：** 老张，跟客户驻场 3 年。最烦的是客户描述问题语焉不详，又要远程爬日志、问研发，一来一回半天过去。

**开场：** 客户项目经理钉钉消息："我们这边堡垒机用 Chrome 打开 RDP 会话时显示 520 错误，很急"。

**进展：**
1. **老张在研发群 @机器人**："RDP 520 错误，客户是 Chrome 浏览器"
2. **AI 提取关键词**：`RDP`、`520`、`Chrome`
3. **知识库查询**：index.json 匹配到 `pam/rdp-520.md` 条目 → 关键词 + 模块 + 版本匹配
4. **秒级回复**（~2 秒）：
   ```
   ✅ 命中历史 Bug（pam/rdp-520.md）
   
   根因：RDP 代理服务的 WebSocket 升级握手在 Chrome 101+ 版本上
   由于 Sec-WebSocket-Protocol 头处理方式变化导致 520
   
   修复版本：v6.6.1.2
   
   临时方案：让客户切到 Firefox 或升级代理服务到 v6.6.1.2+
   
   相关 Issue：#142（已关闭）
   MR：!387
   ```
5. **老张回复客户**：截屏方案，告知客户升级代理服务版本

**高潮：** 整个过程 30 秒。老张没打扰任何研发人员，问题就解决了。

**结局：**
1. 老张给机器人评价"有用" → 知识库条目热度 +1
2. 统计仪表盘：本月命中率 +1
3. 当知识库命中率超过 30%，研发团队大部分问询被 AI 直接消化

**情绪曲线：** 焦虑（客户催单） → 安心（秒回答案） → 感激（不用等研发）

**揭示的能力需求：**
- 知识库 index.json 的关键词/错误码/模块快速匹配
- 知识库条目热度统计
- 钉钉群公共渠道（不局限于研发群）
- 历史 Issue/MR 链接回填到回复中
- 命中率仪表盘（价值量化）

---

### Journey 5：管理员小周 —— 新产品线接入配置

**角色画像：** 小周，ChatOps 平台管理员。现在要把 IAM 产品线接入研发 AI 助手。

**开场：** 周一早上，产品经理要求把 IAM 也纳入 AI 助手服务范围。

**进展：**
1. **登录 ChatOps 管理后台** → "产品线管理" 页面
2. **新增产品线"IAM"**：
   - 填写 Git 仓库地址：`git@gitlab.example.com:iam/iam-code.git`
   - 选择默认分支：`develop`
   - 添加成员（从钉钉用户同步）：iam-dev、iam-test、iam-ops
   - 分配角色：developer / tester / ops
3. **触发初始化任务**（异步）：
   - Platform clone IAM 仓库到本地缓存
   - AI 扫描代码，生成初始 `docs/ai-summary/` 结构
   - 生成模块 → 负责人映射建议（基于 CODEOWNERS 或 git blame）
   - 创建对应的独立知识库仓库 `iam-knowledge.git`
4. **小周 Review 初始化结果**：
   - AI 生成的 AI 摘要可能不准，小周 Review 后提 PR 修正
   - 模块 → 负责人映射需要人工确认（AI 只是建议）
5. **开通 capability**：
   - 在"能力管理"中为 IAM 产品线开启 `analyze_bug` / `fix_bug_l1` / `fix_bug_l2`
   - 暂不开启 L3（等成熟后再开）
6. **配置 GitLab Webhook**：
   - 在 IAM 仓库设置中添加 Webhook URL
   - 事件类型勾选：Issues events、Merge request events
7. **测试接入**：
   - 小周模拟创建一个 Issue，机器人是否自动分析
   - 测试通过 → 发布通知到 IAM 钉钉群

**高潮：** 整个接入流程在 1 天内完成。AI 自动完成了 80% 的配置工作（代码扫描、摘要生成、负责人建议），小周只做了 Review 和确认。

**结局：**
1. IAM 产品线正式接入，开始产生分析/修复数据
2. 2 周后反馈给研发团队，决定是否开放 L3
3. ChatOps 管理后台增加一行产品线的监控数据

**情绪曲线：** 责任（接入任务） → 省心（AI 自动扫描） → 成就（一天完成）

**揭示的能力需求：**
- 产品线管理后台（CRUD + Git 地址配置）
- AI 自动扫描生成初始 AI 摘要（不依赖人工编写）
- 模块 → 负责人映射自动建议（基于 git/CODEOWNERS）
- 知识库仓库自动创建
- 按产品线 × capability × 环境 × 角色的四维权限矩阵
- GitLab Webhook 自动化配置指引
- 接入测试验证流程

---

### Journey Requirements Summary

5 条核心旅程映射出的能力需求分组：

| 能力分组 | 涉及的能力 |
|---------|-----------|
| **IM 交互层** | 钉钉消息解析（含截图）、钉钉 DM 卡片、按角色/模块路由、引用回复解析、回复评价收集 |
| **代码隔离与访问** | git clone --shared 独立 worktree、Session 保持（--resume）、两级回收机制 |
| **知识层** | AI 摘要（随代码）、知识库仓库（独立）、index.json 快速匹配、业务逻辑说明（人写）、知识库条目热度统计 |
| **分析 Agent** | 读代码、读配置、输出结构化方案、置信度标签、Bug 分级判断、多方案推荐 |
| **修复 Agent** | 创建 fix 分支、改代码、更新 AI 摘要、跑测试、创建 MR、commit message 详细化 |
| **AI Review Agent** | 独立 systemPrompt、独立权限、MR diff 审查、ai-approved/ai-needs-attention 标签 |
| **流程编排** | L1/L2/L3/L4 分级路由、失败降级（3 次）、fix 分支保留策略、GitLab label 状态机驱动 |
| **审批** | 复用 ApprovalGate、L3 方案审批、MR 合并审批 |
| **管理后台** | 产品线 CRUD、成员与角色管理、能力配置、模块→负责人映射、审批规则、GitLab Webhook 配置引导 |
| **监控与量化** | Bug 修复实例页面、知识库命中率仪表盘、修复成功率仪表盘、价值量化战报 |
| **初始化能力** | 新产品线接入时自动扫描生成 AI 摘要、负责人自动建议、知识库仓库自动创建 |
| **Bug 根因归因** | 每个 Bug 标记根因类型（需求/prompt/摘要/编码）、反推知识体系优化点 |



## Domain-Specific Requirements

研发 AI 助手的领域本身（DevOps / AI 研发工具）不属于强监管行业，但目标客户（银行 / 国企 / 关基行业）所处环境衍生出若干**非监管但强约束**要求，需要产品层面预留能力：

- **私有化部署**：客户环境完全隔离，代码、知识库、AI 会话数据不出客户域。推客户阶段必须满足。
- **代码安全与脱敏**：AI 分析/修复时对密码、密钥、IP 等敏感信息自动脱敏；Agent 权限在 CLI 层强制限制（`--allowed-tools`），分析 Agent 不能 Edit/Write/Bash(write)。
- **模型可替换**：不同客户对 AI 厂商有不同限制（部分客户不可用 Claude），底层模型通过 Porygon backend 层抽象，业务逻辑不耦合具体模型。
- **集成契约**：GitLab API、钉钉 Stream、飞书 Webhook、MCP 协议为硬依赖，外部契约变更须有版本兼容策略。

> **注：** 详细的技术约束（加密、审计日志、审计报告模板、租户隔离实现）由后续架构文档（Architecture）和安全设计文档承接。本 PRD 仅声明能力边界。

## Innovation & Novel Patterns

### Detected Innovation Areas

#### 1. 多 Agent 独立角色协作（而非单 Agent 多任务）

本产品将"分析 / 修复 / Review"三个认知活动**解耦为独立 Agent**，每个 Agent 有独立身份、独立 systemPrompt、独立权限（CLI 层 `--allowed-tools` 硬限制）：

| Agent | 视角 | 输入 | 输出 | 权限 |
|-------|------|------|------|------|
| 分析 Agent | "怎么改能修好" | Bug 描述、截图、日志 | 根因 + 方案 + 置信度 + 分级 | Read/Glob/Grep（无 Edit/Write/Bash） |
| 修复 Agent | 按方案执行 | 方案文档（来自分析） | 代码变更 + AI 摘要更新 + 测试 + MR | 读写代码 + Git + 跑测试，不接外部消息 |
| Review Agent | "这个改动有没有问题" | MR diff + 原方案 | ai-approved / ai-needs-attention 标签 + 评论 | 只读 MR，独立 systemPrompt |

**与业界常规做法的差异：** Cursor/Copilot/Devin 大多是单 Agent 多任务（同一个 session 既分析又修改），本产品借鉴 BMAD code-reviewer 模式，**强制多角色隔离**，防止盲点 + 提供独立视角。

#### 2. Bug 分级路由 + 自动降级

**创新点：** 不是所有 Bug 都走同一流程。AI 在分析阶段同时输出 Bug 级别（L1-L4），按级别路由到不同人机协作模式。

| 级别 | 流程 | 人工介入次数 |
|:----:|------|:------------:|
| L1 配置类 | AI 分析 → AI 修复 → 测试 → MR → **人工合并** | 1 |
| L2 简单代码 | AI 分析 → AI 修复 → 测试 → MR → **人工 Review + 合并** | 1 |
| L3 业务逻辑 | AI 分析 → AI 方案 → **人工审批方案** → AI 修复 → **人工 Review** | 2 |
| L4 架构级 | AI 分析报告 → **人工全程接手** | 全程 |

**自动降级：** L1/L2 修复失败 3 次 → 自动升级为 L3 流程，**保留 fix 分支现状**，研发基于 AI 尝试结果继续改。

**与业界常规做法的差异：** Devin 等竞品对所有任务给"全自动"承诺，本产品承认 AI 能力分级，**让分级错误的代价可控**（3 次重试后自动降级）。

#### 3. 文档分层架构：AI 摘要 + 独立知识库

**创新点：** 区分"随代码走的文档"（AI 摘要）和"独立版本演进的文档"（知识库），用元数据实现版本匹配。

```
必选层 1 — AI 摘要（跟代码仓库走）：
  pas-6.0/docs/ai/           ← AI 自动生成，每个版本/分支独立
  
必选层 2 — 代码本身：
  Agent clone 代码后直接读

增强层 — 知识库仓库（独立 Git 仓库）：
  pam-knowledge.git
  ├── guide/                  ← 人写的业务逻辑说明
  ├── knowledge/              ← AI 自动沉淀的历史 Bug 知识
  └── index.json              ← 版本元数据匹配
```

**创新价值：** 人写的业务逻辑说明**不需要放进每个代码分支**，通过 index.json 的 versions 元数据做匹配。避免文档复制 × 版本爆炸。

#### 4. AI 摘要随代码同步更新

**创新点：** 修复 Agent 改代码时，**同步更新模块的 AI 摘要**，一起提交到 fix 分支。

**价值：** AI 摘要始终和代码同步，零额外维护成本，分析准确率不会因摘要过时而下降。这解决了"文档总是落后于代码"的老问题。

#### 5. Bug 根因归因机制（驱动知识体系进化）

**创新点：** 不只统计 Bug 数量，而是**追溯每个 Bug 的根因类型**：

```
需求描述 → prompt → AI 摘要 → AI 理解 → AI 写代码
```

| 根因类型 | 说明 | 驱动优化 |
|---------|------|---------|
| 纯语法/空指针 | AI 编码能力不足 | 换模型或加代码规范 |
| 业务逻辑错误 | prompt/摘要没说清业务规则 | 补充 AI 摘要的业务约束 |
| 需求理解偏差 | PRD 描述模糊或遗漏 | 反推需求文档质量 |
| 边界条件遗漏 | 场景覆盖不足 | 补充测试用例模板 |
| 跨模块冲突 | 依赖关系没文档化 | 补充架构约束到 AI 摘要 |

**创新价值：** 现在代码都是 AI 写的，**Bug 的 owner 不一定是 AI 编码能力差**，可能是提示词问题或需求没说清。归因机制让整个知识体系（不只是代码）持续进化。

#### 6. 置信度标签 + 方案先行

**创新点：**
- **置信度标签**：AI 分析报告自标可信度（高/中/低），管理用户预期。防止因偶尔分析不准导致用户对整个产品失去信任。
- **方案先行**：分析阶段就输出结构化修复方案，修复 Agent 基于方案执行而不是重新理解问题。减少修复 Agent 的理解偏差。

#### 7. 产品三层进化路径（飞轮壁垒）

```
第一层：研发效率工具（MVP）
  ↓
第二层：全产品知识大脑（全角色 AI 同事）
  ↓
第三层：越用越值钱的平台（数据壁垒 + 生态锁定）
```

**创新价值：** 不是静态工具，而是**越用越值钱**的资产。客户知识库积累在平台上，迁移成本高 → 天然生态锁定。

### Market Context & Competitive Landscape

| 竞品 | 定位 | 本产品差异化 |
|------|------|-------------|
| **Devin** (Cognition Labs) | AI 软件工程师，承接完整任务 | 支持私有化部署、全代码库知识常驻、MR 后全流程（测试、发布、知识沉淀） |
| **GitHub Copilot Workspace** | Copilot 的进阶版，做到 MR | MR 之后的测试验证、知识沉淀是盲区 |
| **Cursor / Claude Code** | 代码编辑器内的 AI 助手 | 本产品是**指挥官层**（编排/流程），与编辑器层**互补不竞争** |
| **字节青训 / 通义灵码** 等国内类 Copilot | 代码补全为主 | 本产品做全流程（分析 → 修复 → Review → 知识沉淀）+ 私有化 |

**核心差异化 Slogan：** 不是"AI 外包"，而是"**AI 正式员工**"——越待越值钱，知识沉淀归客户所有。

### Validation Approach

#### 创新有效性的验证路径

| 创新点 | 关键假设 | 验证方式 | 验收线 |
|-------|---------|---------|--------|
| 多 Agent 协作 | 独立 Review Agent 能发现修复 Agent 遗漏的问题 | 对比有无 Review Agent 的 MR 质量 | Review Agent 标记的问题中 ≥30% 是修复 Agent 漏过的 |
| 分级路由 | L1+L2 占 Bug 总量 ≥60% | PAM 近 3 月 Bug 数据统计 | 占比达标则路由价值成立 |
| 自动降级 | 3 次重试后人工接手的代价 ≤ 不重试直接人工 | 对比 AI 尝试后人工耗时 vs 直接人工耗时 | AI 尝试至少缩短 20% 人工耗时 |
| AI 摘要随代码更新 | 更新负担在可承受范围 | 修复 Agent 同步更新摘要的 token 消耗 / 耗时 | 单次修复额外耗时 ≤1 分钟 |
| Bug 根因归因 | 归因能真正驱动知识体系优化 | 3 个月后统计"同类根因重复 Bug"占比 | 重复 Bug 占比下降 ≥20% |
| 知识库命中 | 历史 Bug 能秒回新问题 | 命中率统计 | 3 个月后 ≥30% |

#### MVP 验证计划

1. **里程碑 1（分析闭环）验收后**：验证 "分析质量 + 分级准确率 + 置信度校准" 三个核心假设
2. **里程碑 2（修复闭环）验收后**：验证 "AI 自动修复成功率 + Review 盲点检出率 + 自动降级价值"
3. **里程碑 3（进化闭环）验收后**：验证 "根因归因 + 知识库命中率 + 价值量化" 三个飞轮假设

### Risk Mitigation

| 创新风险 | 潜在问题 | 缓解策略 |
|---------|---------|---------|
| **AI 分析质量不稳定** | 偶发错误 → 用户信任崩塌 | 置信度标签 + 最小 MVP 模式（环节可选）+ 只在置信度 ≥80% 时进入自动修复流程 |
| **多 Agent 协作复杂度** | Agent 间信息传递偏差 | 方案先行（结构化方案文档作为 Agent 间的契约）+ commit message 详细化（可回溯） |
| **分级错误代价** | AI 分级错误 → 流程走错 | 3 次失败自动降级 + fix 分支保留 + 人工可接手 |
| **自动修复越改越乱** | 修复 Agent 在错误方向上深度调试 | 3 次重试上限 + 保留所有尝试 commit（不 revert） |
| **知识库冷启动** | 没有历史数据，命中率低 | AI 主动扫描初始化（不等 Bug 喂数据）+ 能自动补的自动补，不能的问人 |
| **用户不愿学习新流程** | 流程长，用户只走前 2 步 | 最小 MVP 模式，每个环节可选；从分析闭环开始逐步开启修复、review、测试等 |
| **客户无法用 Claude** | 合规/本地化要求 | Porygon backend 层抽象，支持模型可插拔 |
| **AI 生成代码版权** | 客户对 AI 代码归属有疑虑 | AI 生成的 MR 明确标记（label: ai-generated），人工 Review 作为合并前提 |



## SaaS B2B Specific Requirements

### Project-Type Overview

研发 AI 助手作为 ChatOps 平台的能力模块，沿用 ChatOps 的 **SaaS B2B 多租户架构**。MVP 阶段服务内部（单租户逻辑，但已具备多租户结构），Growth 阶段支持客户私有化部署。

### Tenant Model（多租户模型）

**租户维度**：`产品线（product_line）× 环境（environment）× 角色（role）`

| 隔离对象 | 隔离策略 | 来源 |
|---------|---------|------|
| 代码仓库 | 每个产品线独立 Git 仓库（PAM/IAM/SDP）| 产品注册表配置 |
| 知识库 | 每个产品线独立知识库 Git 仓库（pam-knowledge.git / iam-knowledge.git） | 新增 |
| AI 摘要 | 跟代码走（每个版本/分支独立） | 自动生成 |
| 产品线成员 | `product_line_members` 表 | ChatOps 已有 |
| 环境定义 | `environments` 表（dev/test/staging/prod） | ChatOps 已有 |
| 连接配置 | `product_line_envs` 表（runtime: docker/k8s + connection_config JSONB） | ChatOps 已有 |
| 能力访问控制 | `product_line_capabilities` 表（产线 × 能力 × 环境 × 角色） | ChatOps 已有 |
| 独立 worktree | `/tmp/analysis/{user}-{product}-{version}` | 新增（代码隔离沙箱） |

**每个客户（推客户阶段）独立部署**：完全私有化，一客一环境，数据不跨客户。

### RBAC Matrix（权限矩阵）

沿用 ChatOps 的**四级 RBAC** + **双层权限控制**，针对研发 AI 助手新增能力扩展配置：

**角色等级：**

| 角色 | 典型人员 | 默认权限范围 |
|------|---------|-----------|
| developer | 研发 | 分析、查看 MR、Review；无高风险操作 |
| tester | 测试 | 分析、触发测试流水线 |
| ops | 运维 | 分析、部署、SSH 排障 |
| admin | 管理员 | 全部 + 配置管理（产线/能力/权限规则） |

**研发 AI 助手新增 capability 的默认角色配置：**

| Capability | 默认开放角色 | 触发方式 |
|-----------|-------------|---------|
| `analyze_bug` | 全角色 | 钉钉 @机器人 / GitLab Issue Webhook |
| `fix_bug_l1` | 系统内部（事件驱动） | analyze_bug 分级判断后自动触发 |
| `fix_bug_l2` | 系统内部（事件驱动） | 同上 |
| `fix_bug_l3` | 系统内部（需审批） | L3 方案 approved label 后触发 |
| `ai_review_mr` | 系统内部（事件驱动） | MR 创建后自动触发 |
| `search_knowledge` | 全角色 | analyze 前置步骤 |

**双层权限控制：**
1. **Capability 级**：通过 `product_line_capabilities` 配置 产线 × 能力 × 环境 × 角色
2. **Tool 级**：通过 `DEFAULT_TOOL_ROLES` + `tool_permissions` 表覆盖

### Integration List（集成清单）

| 集成对象 | 用途 | 状态 | 契约关键点 |
|---------|------|:----:|----------|
| **钉钉 Stream API** | 主要 IM 入口 | ✅ 已接 | Stream 模式长连接、msgId 去重、sessionWebhook 缓存；**需扩展图片消息支持** |
| **飞书 Webhook** | 备选 IM 入口 | ✅ 已接 | HTTP Webhook；目前不支持图片（跟进） |
| **GitLab API** | Issue / MR / Webhook 触发 | ✅ 部分接入 | 已支持 Issue 创建/评论/关闭；**需扩展 Issue 事件监听**（Webhook） |
| **GitLab CI** | 代码提交关联 Issue | ✅ 已接 | Pipeline 事件 → image_cache 表（已用于部署） |
| **SSH（ssh2 lib）** | 远程命令执行、日志采集 | ✅ 已接 | 用于环境巡检、日志采集、部署 |
| **Harbor** | 镜像仓库 | ✅ 已接 | 部署时拉镜像 |
| **Claude API（via Porygon）** | AI 推理 | ✅ 已接 | 通过 `@snack-kit/porygon` 封装；MCP 子进程启动；**模型可插拔能力待抽象** |
| **知识库 Git 仓库** | 每个产品线独立 Git（pam-knowledge.git 等） | ❌ 新增 | 独立 repo + index.json 版本元数据 |
| **对象存储（MinIO/OSS/本地目录）** | 图片附件存储 | ❌ 新增 | 与 Markdown 分开，仅存引用 URL |
| **Prometheus / Grafana** | 监控告警联动 | ⚠️ 远期 | P2 告警处理场景用 |

### Compliance Requirements（合规要求）

> 详细合规条款见 `Domain-Specific Requirements` 章节。

**PRD 层面的合规约束：**

- **代码/数据不出客户域**：推客户阶段必须支持完全私有化部署
- **AI 会话隔离**：客户会话数据、知识库归客户所有，平台不留存客户数据
- **敏感信息脱敏**：分析报告/日志处理时自动过滤密码、密钥、IP 等
- **Agent 权限强制隔离**：CLI 层 `--allowed-tools` 硬限制，不依赖 Prompt
- **审批可审计**：所有审批决策记录入库，可导出审计日志（利用 ChatOps 已有 `approval_requests` 表）
- **多模型可插拔**：客户侧可切换到国产模型 / 私有化模型

### Subscription Tiers（订阅层级）

**MVP 阶段：不划分订阅层级。** 内部使用为主，推客户阶段（Growth+）再设计分层和定价模型。

### Technical Architecture Considerations

**复用 ChatOps 已有的架构骨架：**

- **请求流**：IM 适配器 → SessionManager → TaskQueue → ClaudeRunner → MCP Server → Tools → DB
- **多 Agent 编排**：capability 驱动的工具路由（ClaudeRunner 按 capability 筛选工具给 Claude）
- **Session 保持**：Claude `--resume`，按 (platform, groupId) 管理，8h TTL
- **审批集成**：ApprovalGate + ApprovalRouter + EscalationTimer，L3 方案审批 / MR 合并审批复用
- **流水线集成**：`test_pipelines` 表 stage 类型扩展（增加 capability / wait_webhook 类型）

**研发 AI 助手新增的架构要素：**

| 要素 | 作用 |
|------|------|
| 代码隔离沙箱 | `git clone --shared + sparse-checkout` 创建隔离 worktree |
| Session × product 维度 | 按 (senderId, product) 复用 session，多维度隔离 |
| 两级回收机制 | 30 分钟 session 过期 + 2 小时 worktree 清理 + 凌晨 3 点兜底 |
| 知识库 index.json 匹配引擎 | 关键词/错误码/模块/版本匹配，毫秒级响应 |
| GitLab label 状态机 | 通过 Issue label 驱动流程流转（needs-analysis → graded → fixing → in-review → testing → done） |
| Bug 根因归因存储 | 每个 Issue 关闭后记录根因类型，驱动知识体系优化 |

### Implementation Considerations

#### 数据库变更

- **扩展** `test_pipelines.stages` 的 stage 类型：增加 `capability` / `wait_webhook`
- **新增** `capabilities` 记录：analyze_bug / fix_bug_l1 / fix_bug_l2 / fix_bug_l3 / ai_review_mr / search_knowledge
- **新增** 产品注册表：{product_line_id, git_repo, knowledge_repo, ai_summary_path}
- **新增** 模块 → 负责人映射表：{product_line_id, module_pattern, owner_user_id}
- **新增** Bug 根因归因表：{issue_id, root_cause_type, context}

#### 前端扩展

- **Bug 修复实例页面**：扩展 `TestRunsPage`，展示每个 Bug 的 12 节点闭环进度
- **产品线管理扩展**：增加 Git 仓库/知识库/AI 摘要路径配置入口
- **模块→负责人映射配置**：管理后台新页面
- **价值量化仪表盘**（里程碑 3）：修复成功率、命中率、耗时趋势

#### MCP 工具新增（严格区分 Agent）

| 工具 | 归属 Agent | Required Role |
|------|-----------|---------------|
| `read_code` | 分析 Agent | developer+ |
| `search_knowledge` | 分析 Agent | 全角色 |
| `create_issue` | 分析 Agent | developer+ |
| `download_image` | 分析 Agent | 全角色 |
| `fix_code` | 修复 Agent | system-only（不对外） |
| `update_ai_summary` | 修复 Agent | system-only |
| `run_tests` | 修复 Agent | system-only |
| `create_mr` | 修复 Agent | system-only |
| `switch_version` | 分析/修复 Agent | system-only |
| `review_mr_diff` | Review Agent | system-only |



## Project Scoping & Phased Development

> 本节在 `Product Scope` 的三层划分（MVP / Growth / Vision）基础上做**战略层收敛**：定义 MVP 哲学、关键 Must-Have 识别、分阶段路线图与风险应对。

### MVP Strategy & Philosophy

**MVP 类型：问题解决型 MVP（Problem-Solving MVP）**

**核心判断：** 本产品不是 C 端消费者工具（不追求体验精致度），不是早期平台（需要先起平台的网络效应），也不是急于收入验证（内部先用）。最紧迫的问题是：**验证 AI 能否把 Bug 分析和修复做到足够好，让研发信任它**。

**MVP 哲学的三个必要条件：**

1. **使用者愿意说"这有用"** — 研发看到 AI 自动生成的 MR 点一下就合并，真实省了时间
2. **投资方/决策层看到价值** — L1 自动修复率 ≥90%、端到端有效率 ≥70% 等核心指标达标
3. **快速学习路径** — 按里程碑验收节奏走，每个里程碑完成后可以停下来评估、调整

**资源约束：** 2-3 人兼职团队，靠**复用 ChatOps 平台**降低实现成本。

### Must-Have Analysis（MVP 必备能力）

按"没有它产品就失败"的标准筛选：

| 能力 | 是否 Must-Have | 理由 |
|------|:-------------:|------|
| 钉钉 @机器人 入口（含图片） | ✅ 必备 | 没有入口无法触发（现有纯文本入口不够用） |
| 独立代码 worktree 沙箱 | ✅ 必备 | 多用户并发分析的基础，无法妥协 |
| AI 摘要读取 | ✅ 必备 | 分析质量的关键；摘要缺失会导致分析不准 |
| 知识库 index.json 匹配 | ✅ 必备 | "秒回"能力依赖此；同时是命中率指标的来源 |
| 置信度标签 | ✅ 必备 | 管理用户预期，防信任崩塌 |
| Bug 分级（L1-L4） | ✅ 必备 | 分级路由是核心设计，不分级就退化为单流程 |
| L1/L2 自动修复 | ✅ 必备 | MVP 的差异化价值，没有就只是个分析工具 |
| AI 修复失败 3 次自动降级 | ✅ 必备 | 没有这个兜底，AI 失控风险太高 |
| AI 摘要随修复同步更新 | ✅ 必备 | 摘要维护成本的关键设计，落后即产品失败 |
| 独立 AI Review Agent | ✅ 必备 | 没有独立视角，修复 Agent 盲点无法被发现 |
| GitLab Issue Webhook 驱动 | ✅ 必备 | 事件驱动编排依赖此 |
| Bug 修复实例页面（前端） | ✅ 必备 | 用户需要能看到流程进度，否则黑盒无法信任 |
| 产品线管理后台扩展 | ✅ 必备 | 接入新产品需要，不能硬编码 |
| L3 方案审批流程 | ⚠️ 争议 | L3 MVP 阶段可以退化为"AI 只分析，L3 全部转人工"，节省实现成本 |
| 价值量化仪表盘 | ❌ Growth | MVP 阶段可以靠人工数据汇总代替 |
| 多模型可插拔 | ❌ Growth | MVP 阶段只用 Claude 即可 |
| 自动化测试失败触发分析 | ❌ Growth | 先做 Issue 驱动，测试触发可以后面做 |
| 代码 Review / SQL 审计 / 依赖扫描 | ❌ Growth | P1/P1.5 能力，横向扩展 |
| 运维场景（巡检 / 告警） | ❌ Growth | P2 能力，里程碑 3 之后 |

### Progressive Feature Roadmap（阶段化路线图）

与现有 `Product Scope` 的 MVP/Growth/Vision 相映射：

#### Phase 1（MVP）= 里程碑 0+1+2

**核心用户价值交付：**
- 研发：L1/L2 Bug 从 Issue 创建到 MR 创建全自动 / 半自动
- 售后/交付：钉钉群提问 → 知识库秒回
- 管理员：新产品线一天内完成接入

**必要用户旅程支持：**
- Journey 1（研发 - L1 闭环）✅
- Journey 2（研发 - L3 方案审批）✅（但可退化为转人工）
- Journey 3（研发 - 失败降级）✅
- Journey 4（售后 - 秒回）✅
- Journey 5（管理员 - 产品线接入）✅

**MVP 验收门槛：**
- 覆盖 PAM 全产品线研发
- L1 自动修复率 ≥90%
- L2 自动修复率 70-80%
- 端到端有效率 ≥70%

#### Phase 2（Growth）= 里程碑 3 + 能力横向扩展

**新增价值：**
- 价值量化仪表盘（支持对外展示）
- Bug 根因归因（驱动知识体系进化）
- 多模型可插拔（推客户前置条件）
- 横向能力扩展：代码 Review、SQL 审计、CVE 扫描、发版影响分析

**路径优先级：**
1. 里程碑 3（进化闭环）先做 — 支撑对外销售
2. 多模型可插拔 — 推客户硬门槛
3. 横向能力扩展 — 按客户需求反推

#### Phase 3（Expansion）= Vision 三层进化的第二、三层

- 第二层：全产品知识大脑，对接钉钉文档 / 操作手册 / 白皮书
- 第三层：越用越值钱的平台（客户知识库锁定）
- 无人值守代码工厂（全自动修复发布）

### Risk-Based Scoping（风险驱动的范围管控）

#### 技术风险（最关键）

| 风险 | 可能性 | 影响 | 缓解策略 |
|------|:-----:|:----:|---------|
| AI 分析准确率低于预期（置信度校准失败） | 中 | 高 | MVP 前期大量跑测试数据 + 置信度阈值可调 + 人工兜底 |
| 多 Agent 协作复杂度高（方案传递偏差） | 中 | 中 | 方案文档结构化 + commit message 详细化 + AI Review Agent 独立视角 |
| 代码隔离方案不稳定（git clone --shared 在大仓库上的性能） | 低 | 中 | 先用 Git worktree 兜底 + 灰度切 shared 方案 |
| Claude CLI --resume session 失效 | 低 | 低 | 失败时自动重建 session（已有逻辑） |

**简化初始实现：** L3 流程 MVP 可以退化为"AI 只出分析报告，L3 不做自动修复"，大幅降低 MVP 实现复杂度。

#### 市场风险

| 风险 | 可能性 | 影响 | 缓解策略 |
|------|:-----:|:----:|---------|
| 内部研发不愿用（信任感不足） | 中 | 高 | 最小 MVP 模式，每个环节可选；先从分析闭环推；定期透出成效数据 |
| 客户不愿付费（认为效率工具不值钱） | 中 | 中 | Growth 阶段强化代码安全/合规价值锚点；私有化部署差异化 |
| Devin 等竞品快速迭代（私有化 + 全流程差异化被抹平） | 低 | 中 | 聚焦垂直领域数据（AI 摘要 + 知识库） + 客户知识库绑定 |

#### 资源风险

| 风险 | 可能性 | 影响 | 缓解策略 |
|------|:-----:|:----:|---------|
| 团队 2-3 人兼职，开发速度慢 | 高 | 中 | 复用 ChatOps 平台，避免重复造轮子；不设硬时间，按里程碑验收 |
| 个别关键人员中断参与 | 中 | 高 | 关键设计（分级路由 / 多 Agent 协作 / 摘要同步）保证文档完备 |
| 客户侧部署支持人力不足 | 中 | 低（MVP 阶段） | MVP 不推客户，Growth 阶段前配齐部署文档和一键安装脚本 |

#### 关键简化决策（如果资源 / 时间压力大）

按可以放弃的优先级（从可放弃到不可放弃）：

1. **最先砍**：L3 自动修复流程（退化为 AI 只分析）— 减少 30% 开发量
2. **其次砍**：AI 摘要随修复同步更新（人工维护）— 减少 15% 开发量，但后患大
3. **再次砍**：AI Review Agent（靠人工 Review）— 减少 20% 开发量，但 Review 质量下降
4. **最后砍**：多 Agent 隔离（合并为单 Agent）— 减少 10%，但权限风险上升
5. **绝不能砍**：独立 worktree 沙箱、置信度标签、知识库 index.json、Bug 分级路由、失败降级机制



## Functional Requirements

> **能力契约提醒：** 以下 FR 是所有下游工作（UX 设计 / 架构 / Epic 拆解）的唯一能力清单。**未列入的能力不会被实现**。如有遗漏需显式补充。

### 1. IM 对话交互（IM Conversation）

- **FR1**：研发/测试/运维/售后/交付 可在钉钉群聊中 @机器人 提出问题，获得分析回复或自动流程触发
- **FR2**：分析 Agent 可解析钉钉消息中的图片（含 richText 图文混排、引用回复中的图片、纯图片消息），并下载到本地临时目录供分析使用
- **FR3**：分析 Agent 可解析钉钉消息中的引用回复（repliedMsg），提取被引用内容（文本 + 图片）作为分析上下文
- **FR4**：研发 可在钉钉群发送飞书/钉钉 @机器人 命令（混合策略：自然语言意图识别 + 前缀命令辅助 + 不确定时反问），系统路由到对应能力
- **FR5**：系统 可向钉钉发送不同类型的消息（普通 Markdown 回复、DM 审批卡片、@通知、分析进度实时推送）
- **FR6**：系统 可在飞书 Webhook 入口接收消息并响应（与钉钉能力对等，但图片支持程度以飞书 SDK 为准）

### 2. 代码访问与会话隔离（Code Access & Session Isolation）

- **FR7**：分析/修复 Agent 可按 (用户, 产品, 版本) 维度创建独立的代码 worktree，多个并发分析互不干扰
- **FR8**：系统 可在创建代码 worktree 时使用低成本隔离策略（git clone --shared + sparse-checkout 或 worktree），不影响主仓库
- **FR9**：分析/修复 Agent 可在代码 worktree 中切换到指定版本/分支（通过 switch_version MCP 工具或 Bash）
- **FR10**：系统 可维护 Claude CLI session，支持用户追问时复用上下文（--resume）并按 (senderId, product) 维度隔离
- **FR11**：系统 可按两级回收机制自动清理过期 worktree 和 session（30 分钟 session 过期 / 2 小时 worktree 清理 / 凌晨 3 点兜底扫描）

### 3. 知识层（Knowledge Layer）

- **FR12**：系统 可为每个产品线维护独立的 AI 摘要文档（随代码仓库走，每个版本/分支独立），分析 Agent 读取摘要作为上下文
- **FR13**：修复 Agent 可在提交代码变更时同步更新对应模块的 AI 摘要，随 fix 分支一起提交（零额外维护成本）
- **FR14**：系统 可为每个产品线维护独立的知识库 Git 仓库（pam-knowledge.git 等），包含 guide/（人写业务逻辑）、knowledge/（AI 沉淀历史 Bug）、index.json（索引）
- **FR15**：分析 Agent 可查询知识库 index.json（按关键词、错误码、模块、版本匹配），命中时在秒级返回历史方案
- **FR16**：系统 可将知识库条目中的图片引用到对象存储（MinIO/OSS/本地目录），Markdown 与图片分开存储
- **FR17**：系统 可在 Issue 关闭后自动将「问题描述 + 根因 + 修复方案 + diff 链接」沉淀为知识条目，更新 index.json
- **FR18**：系统 可在新产品接入时 AI 主动扫描代码生成初始 AI 摘要和知识库结构（不依赖人工冷启动）
- **FR19**：人 可通过 Git 提交（或远期管理后台编辑器）向知识库仓库补充业务逻辑说明（guide/），通过 index.json 的 versions 元数据做版本匹配

### 4. Bug 分析与分级（Bug Analysis & Grading）

- **FR20**：分析 Agent 可接收来自钉钉消息、GitLab Issue（webhook）、自动化测试失败、监控告警等多种事件源的问题输入
- **FR21**：分析 Agent 可在分析前先区分问题类型（Bug / 配置问题 / 使用问题），只有 Bug 才进入后续修复流程
- **FR22**：分析 Agent 可通过读代码、读日志、读配置、查知识库四类动作定位 Bug 根因
- **FR23**：分析 Agent 在输出分析报告时标注置信度（高 ≥80% / 中 50-80% / 低 <50%），用于管理用户预期
- **FR24**：分析 Agent 在分析根因的同时输出结构化修复方案（可能多选项 + 推荐项），方案作为后续修复 Agent 的输入契约
- **FR25**：分析 Agent 可自动判断 Bug 级别（L1 配置类 / L2 简单代码 / L3 业务逻辑 / L4 架构级），决定后续流程路由
- **FR26**：系统 可在分析完成后自动创建 GitLab Issue（含产品线标签、模块标签、严重级别、分析报告评论）
- **FR27**：系统 可根据分析结果回复钉钉（命中知识库秒回 / 完整分析报告 / 进度实时推送）

### 5. 自动修复与 AI Review（Auto Fix & AI Review）

- **FR28**：修复 Agent 可基于分析 Agent 产出的方案文档创建独立 fix 分支（如 `fix/issue-123`）并在其上进行代码变更
- **FR29**：修复 Agent 可调用 MCP 工具进行代码修改、运行单元测试、创建 MR（通过 GitLab API）
- **FR30**：修复 Agent 在 commit message 中详细记录修复思路和尝试步骤（便于人工接手时快速理解）
- **FR31**：修复 Agent 可按 Bug 级别走不同流程（L1：修 → 测试 → MR → 人工合并；L2：同 L1 + 需人工 Review；L3：需方案审批通过后才能触发修复）
- **FR32**：系统 可在单元测试失败时让修复 Agent 自动分析失败原因并再次尝试，最多重试 3 次
- **FR33**：系统 可在修复重试 3 次仍失败时自动降级（label 改为 needs-manual，Bug 级别升级为 L3，保留 fix 分支现状，@通知研发接手）
- **FR34**：Review Agent 可在 MR 创建后独立审查 diff（使用不同 systemPrompt、不同权限），从"这个改动有没有问题"视角检查方案一致性、遗漏、质量和安全
- **FR35**：Review Agent 可在 MR 上打标签（ai-approved / ai-needs-attention）并写评论，辅助人工 Review 快速定位重点

### 6. 审批与流程编排（Approval & Workflow）

- **FR36**：系统 可使用 GitLab Issue labels 作为状态机驱动流转（needs-analysis → analyzing → graded → fixing / needs-approval / needs-manual → in-review → testing → ready-to-merge → merged → done）
- **FR37**：系统 可根据 label 变化触发对应的编排动作（如 approved label → 触发修复 Agent）
- **FR38**：系统 可在 L3 Bug 场景下向模块负责人发送钉钉 DM 审批卡片（复用 ChatOps ApprovalGate），展示方案摘要和完整方案链接
- **FR39**：系统 可根据模块 → 负责人映射表自动路由审批/通知（如 pas-bastion-host → liaoss，pas-secret-task → hanff）
- **FR40**：系统 可在 MR 合并前要求人工 Review（所有级别），Release Notes 自动生成辅助决策
- **FR41**：系统 可在 Issue 关闭时自动触发知识库沉淀（FR17）和 Bug 根因归因（FR42）

### 7. Bug 根因归因与知识进化（Root Cause & Knowledge Evolution）

- **FR42**：系统 可为每个关闭的 Bug 记录根因类型（纯语法/空指针 / 业务逻辑错误 / 需求理解偏差 / 边界条件遗漏 / 跨模块冲突）
- **FR43**：系统 可基于根因归因数据反推知识体系优化点（如"业务逻辑错误"集中出现时提示补充 AI 摘要的业务约束）
- **FR44**：系统 可统计"同类根因重复 Bug"占比趋势，作为知识体系进化的核心指标

### 8. 权限与多租户（Permission & Multi-tenant）

- **FR45**：系统 可按四级角色（developer / tester / ops / admin）、产品线、环境、capability 四个维度做权限控制
- **FR46**：系统 可为研发 AI 助手新增的 capability（analyze_bug / fix_bug_l1 / fix_bug_l2 / fix_bug_l3 / ai_review_mr / search_knowledge）配置产线 × 环境 × 角色的访问控制矩阵
- **FR47**：系统 可通过 CLI 层 `--allowed-tools` 硬限制每个 Agent 的工具权限（分析 Agent 只读、修复 Agent 读写代码但不接收外部消息、Review Agent 只读 MR）
- **FR48**：系统 可在 AI 分析/修复时对密码、密钥、IP 等敏感信息自动脱敏
- **FR49**：admin 可管理产品线（新增/编辑/停用）、配置产品线对应的 Git 仓库路径、知识库仓库路径、默认分支、AI 摘要路径

### 9. 管理与监控（Admin & Monitoring）

- **FR50**：admin 可通过管理后台一键接入新产品线（配置 Git 地址 → 触发 AI 扫描生成摘要 → 生成模块→负责人建议 → 创建知识库仓库 → 配置 Webhook 指引）
- **FR51**：admin 可管理"模块 → 负责人"映射表（产品线 × 模块模式 × 钉钉 userId）
- **FR52**：研发/测试/运维 可在前端查看每个 Bug 的 12 节点闭环流程进度（复用/扩展 TestRunsPage）
- **FR53**：用户 可在前端查看价值量化仪表盘（修复成功率按 L1/L2/L3 分级统计、知识库命中率、平均分析/修复耗时、工时节省估算）—— Growth 阶段
- **FR54**：admin 可导出审计日志（所有分析/修复/审批决策记录，利用 ChatOps 已有 approval_requests / tasks 表）
- **FR55**：系统 可记录知识库条目的热度（命中次数、用户评价），辅助条目质量排序

---

**FR 覆盖映射：**

| PRD 章节 | 覆盖的 FR |
|---------|-----------|
| Success Criteria - 用户成功体验 | FR1, FR15, FR27, FR52 |
| Success Criteria - L1/L2/L3 成功率 | FR25, FR28-FR35 |
| Success Criteria - 知识库命中率 | FR15, FR17, FR55 |
| Journey 1 - L1 快通道 | FR1-5, FR7-11, FR12-15, FR20-27, FR28-32, FR34-36 |
| Journey 2 - L3 方案审批 | FR24, FR26, FR31, FR38-40, FR36-37 |
| Journey 3 - 失败降级 | FR30, FR32-33, FR42-44 |
| Journey 4 - 售后秒回 | FR1, FR15, FR27, FR55 |
| Journey 5 - 新产品接入 | FR18, FR49-51 |
| Innovation - 多 Agent 协作 | FR34-35, FR47 |
| Innovation - Bug 根因归因 | FR42-44 |
| Innovation - AI 摘要随更新 | FR13 |
| SaaS B2B - Tenant Model | FR45-46, FR49 |
| SaaS B2B - Integration | FR2-3, FR6, FR20, FR26, FR29, FR36-37, FR50 |
| SaaS B2B - Compliance | FR47-48, FR54 |


## Non-Functional Requirements

> 以下 NFR 定义了**产品需要做得多好**，每条均具备可测量性。部分指标与 `Success Criteria > Technical Success` 重叠但角度不同——此处聚焦能力实现的质量约束。

### Performance（性能）

- **NFR-P1（分析响应时延）**：知识库命中场景下，从用户 @机器人 到返回历史方案的端到端时延 ≤3 秒（P95）
- **NFR-P2（完整分析时延）**：知识库未命中，完整分析流程（含 clone → 读代码 → AI 推理 → 产出报告）端到端时延 ≤5 分钟（P95），基线 4 分钟
- **NFR-P3（追问响应时延）**：session 复用场景下（Claude --resume），追问响应时延 ≤10 秒（P95）
- **NFR-P4（修复 Agent 耗时）**：单次 L1 Bug 从 fix 分支创建到 MR 创建 ≤10 分钟（不含测试运行时间）
- **NFR-P5（并发处理能力）**：支持 10-30 路并发分析任务，并发间无相互干扰、无共享状态冲突

### Security（安全）

- **NFR-S1（敏感信息脱敏）**：分析报告、日志文件、AI 回复中自动过滤密码、密钥、Token、IP 地址、URL 中的敏感参数，脱敏覆盖率 100%
- **NFR-S2（Agent 权限强制隔离）**：通过 Claude CLI `--allowed-tools` 参数硬限制 Agent 权限，分析 Agent 不能 Edit/Write/Bash(write)，修复 Agent 不接收外部消息（不可被 prompt 注入攻击）
- **NFR-S3（代码隔离安全）**：每个分析任务的代码 worktree 独立，清理时 `rm -rf` 彻底删除；不影响主仓库（git objects 共享但只读）
- **NFR-S4（审计可追溯）**：所有分析/修复/审批/权限变更决策记录入数据库，保留周期 ≥180 天，支持按产品线/用户/时间维度导出审计日志
- **NFR-S5（私有化部署）**：所有组件支持完全私有化部署，客户数据（代码、知识库、会话、审计日志）不外泄到平台方
- **NFR-S6（防提示词注入）**：分析 Agent 不可通过用户输入修改代码或 Git 状态；修复 Agent 不接收外部消息，仅消费方案文档（结构化输入）

### Scalability（可扩展性）

- **NFR-SC1（产品线扩展）**：新产品线接入所需时间 ≤1 天（配置 Git 地址 → 自动扫描生成 AI 摘要 → 可分析）
- **NFR-SC2（代码隔离磁盘开销）**：10 路并发分析的临时目录总占用 ≤100MB（通过 git clone --shared + sparse-checkout 共享 objects）
- **NFR-SC3（多客户部署）**：架构支持单客户完全独立部署，客户间无数据共享或跨实例调用（推客户阶段生效）
- **NFR-SC4（知识库规模）**：单产品线知识库条目数 ≤5000 时，index.json 匹配时延 <100ms；超过后支持演进到 SQLite 全文检索或向量数据库，迁移不影响现有流程

### Reliability（可靠性）

- **NFR-R1（任务队列可靠性）**：任务执行中断或节点重启后，pending_approval 状态任务可恢复执行（利用 ChatOps 已有 TaskQueue registerResumeExecutor 机制）
- **NFR-R2（Session 失效恢复）**：Claude session 失效时，系统自动清空 session 并重建新 session，不阻塞当前请求
- **NFR-R3（自动降级机制）**：修复 Agent 3 次重试失败后 100% 触发自动降级（label 切换 + fix 分支保留 + @通知），无手动介入需求
- **NFR-R4（failure-analyzer 独立性）**：流水线失败分析属于 best-effort，失败不阻塞主流程（复用 ChatOps 已有机制）
- **NFR-R5（分析失败不污染主仓库）**：任何分析/修复过程中的异常终止，主 Git 仓库状态不受影响（worktree 隔离保障）

### Observability（可观测性）

- **NFR-O1（核心指标采集）**：以下指标自动采集并入库，支持按产品线/时间维度聚合查询
  - 分析任务数（总量、按级别 L1-L4 分布）
  - 修复成功率（按 L1/L2/L3 分级）
  - 知识库命中率
  - 平均分析耗时、平均修复耗时
  - 失败降级次数、失败根因类型分布
- **NFR-O2（审批流程可见性）**：所有审批请求、响应、超时升级事件可在管理后台查询（复用 ChatOps `approval_requests` 表）
- **NFR-O3（Bug 流程实例可视化）**：每个 Bug 的 12 节点闭环流程进度在前端可见，支持按产品线筛选
- **NFR-O4（日志归档）**：MCP 工具调用日志写入 `/tmp/mcp-server.log`，流水线执行日志写入 `{TEST_DATA_DIR}/`，保留 ≥30 天

### Integration（集成）

- **NFR-I1（钉钉 Stream 可靠性）**：Stream 长连接断开后自动重连，消息去重保留最近 200 条（复用 ChatOps 已有机制）
- **NFR-I2（GitLab API 限流保护）**：GitLab 接口调用遵循令牌桶限流（按 GitLab 实例限额），超限时自动退避重试
- **NFR-I3（模型可替换性）**：底层 AI 模型通过 Porygon backend 层抽象，替换不同模型（Claude / 国产 / 私有化）时只修改 backend 实现，不改业务逻辑
- **NFR-I4（Webhook 鉴权）**：GitLab Webhook 调用必须携带 `x-gitlab-token`，与 `GITLAB_WEBHOOK_SECRET` 匹配才被处理
- **NFR-I5（MCP 协议稳定）**：MCP Server 作为 Claude CLI 子进程启动，启动失败、工具调用无响应等异常有日志记录（`/tmp/mcp-server.log`）和 Parent 进程超时回收


