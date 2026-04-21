# TODO / Growth Backlog

> 统一的长期待办清单。短期 session-scoped 任务用 TodoWrite，跨会话持久事项记这里。
>
> 每条格式：**背景 → 现状 → 待做 → 决策/阻塞点**。
>
> 不放：已完成事项、代码里能查到的约定、短期调试记录（那些走 memory / commit message）。

---

## 1. L3 审批 DM 按钮化（Interactive Card + Stream）

**背景**：L3 审批流程当前发 DM（严益昌 `PipelineApprovalManager.requestApproval` → adapter.sendDirectMessage），但消息形态是 `sampleMarkdown` **纯文本**，用户必须在群里 `@ 机器人 approve #XX` / `reject #XX` / `reanalyze #XX` 才能完成审批。体验差，移动端不便，新人不知道规则。

**现状**：
- 回调链**已全部接通**（钉钉 Stream → dingtalk.ts `TOPIC_CARD` listener → `adapter.onCardAction` → server.ts → `PipelineApprovalManager.handleCallback`）
- `PipelineApprovalManager.handleCallback(approvalId, decision, approverId)` 已预留，只是没人调
- **唯一缺口**：`dingtalk.ts:sendDirectMessage` 当前发 `msgKey: 'sampleMarkdown'`，payload 里**没按钮**

**待做**：
1. 在钉钉开放平台创建**互动卡片模板**（Interactive Card）
   - 标题 + 正文变量（审批描述）+ 两按钮 approve / reject
   - 回调模式选 **Stream 订阅**（不选 HTTPS URL）—— 关键！这样 **不需要公网入口**
2. `dingtalk.ts:sendDirectMessage` 分支扩展
   - 入参 content 为 `InteractiveCard` 时走 `/v1.0/im/interactiveCards/send` API
   - 入参 content 为 `TextContent` 时保留原 `oToMessages/batchSend` + sampleMarkdown
3. 按钮 `action.value` 带 `l3-fix-${issueId}` + `approved|rejected`
   - 钉钉点击后 Stream 的 CARD_ACTION callbackData 里 taskId + action 会传进来，走原有 `handleCallback` 链路 resolve
4. `approval-manager.ts` 消息文案去掉"群内命令"提示（改为"点按钮审批"）
5. **保留**群内命令审批路径（`tryHandleCommand`）作为 fallback —— 卡片渲染失败时用户仍有出路

**关键技术点**：
- **不需要公网 HTTPS 入口**——Stream 模式下钉钉通过已建立的 WSS 反向推按钮事件，和当前收消息走同一通道
- 互动卡片 ≠ ActionCard（ActionCard 按钮只能跳 URL 或 `dtmd://` 代发消息，达不到"不打扰、直接返回结果"的要求）

**相关笔记**：auto-memory `l3-approval-callback.md`（历史接入失败的回顾）

---

## 2. pipeline 审批机制双轨清理（V1 approval vs V2 capability）

**背景**：两套审批路径并存

| 类型 | 审批人来源 | 当前使用 |
|------|-----------|---------|
| `stageType:'approval'` + `approverIds`（手工选钉钉用户）| pipeline 编辑器里下拉选 | **V1 遗留；V2 seed 零使用** |
| `stageType:'capability'` + `approve_l3` capability | 动态从 `projects.owner_id`（产品详情页"负责人"字段）推导 | **所有 V2 bug-fix pipeline** |

`notify_bug` 通知人也走 `projects.owner_id`（多 project 多人通知），与 `approverIds` 无关。

**待决策**：
- 清理方案 A：删除 `stageType:'approval'` 的 UI（[TestPipelinesPage.tsx:415-416](../web/src/pages/TestPipelinesPage.tsx#L415-L416))、executor.executeApprovalStage、`approverIds` 字段 —— 减熵、边界清晰
- 保留方案 B：留着给未来非 bug-fix pipeline 可能用——但目前无已知需求
- 中庸：前端表单加"推荐用 approve_l3 capability"提示，executor 打 deprecation log

**现有合理性（已确认）**：
- `notify_bug` 遍历涉及 project owner 发 DM ✅
- `approve_l3` 只发审批请求给 primary project owner，非主 project owner 收 FYI DM（文案："Bug 涉及你负责的服务（非主仓库），主负责人 XX 正在审批方案。"）✅
- owner 来源统一 = 产品详情页 > project 表单 > "负责人"字段 = `projects.owner_id` ✅

---

## 3. 测试数据隔离 — 已做和未做的

**背景**：2026-04-20 发现 `chatops` 开发库曾被 e2e/integration 测试污染（mock project `PAM/pas-api`、stub prompt 残留）。污染的直接原因是 `DATABASE_URL` 被误设到生产库。

**已做（2026-04-20 同日）**：
- `helpers/db.ts:assertTestDbSafeToReset` 双重防御
  - B2：`NODE_ENV==='test'`——vitest 自动设置，非测试进程调 resetTestDb 立即 throw
  - B3：DB 里必须存在 `chatops_test_db_marker` 表（生产库绝无此表）
- 每次 DROP 重建 schema 后自动重种 marker 供下次校验
- 补 `mock-e2e/README.md` "测试库 bootstrap" 小节，含 psql 命令
- 详见 commit `ccb4c7d`

**未做**：
- **Claude agent 在 Bash 工具里的磁盘副作用未隔离**：`/tmp/analysis/fix-agent-*` / `/tmp/analysis/<uid>-detail-*` 累积；改 `~/.m2`；`mvn test` 起本地端口等——`cleanup-scheduler.ts` 覆盖有限
- **生产库被污染后的数据恢复**：开发库 `projects` / `dingtalk_users` / `product_line_members` 等被覆盖/清空，需要手工重 seed（本次事故的残留）
- **AI 运行态数据与真数据的"可丢弃标记"**：`bug_analysis_reports.run_mode='test'|'trial'|'prod'`，BugRunsPage 能按此过滤——目前真假混杂
- **Claude Bash tool 沙箱化**：container/chroot 避免污染本机开发环境——长期性

---

## 4. 通知人区分"owner 审批人"vs"owner 非审批人"的 DM 文案（可选）

**背景**：单 project 场景下 owner 和审批人是同一人，会收到两条 DM：
1. `approve_l3` 的审批请求（正在审批方案）
2. `notify_bug` 的修复成功（MR URL + AI Review 结论）

两条都叫"fix/issue-XX"等相似关键词，用户（= 你）反馈"感觉只收到审批请求"——可能是两条混淆。

**现状**：`approve_l3` / `notify_bug` 各管各的文案，互不感知对方身份。

**可做（低优先）**：
- `notify_bug` 检测收件人是否是**本轮 approval 的 approver**，若是 → DM 标题加前缀「【修复已完成 · 你批过的】」提升可分辨度
- 或者在第一条审批卡片上加"修复完成后系统会发第二条 DM 告知结果，请留意"的脚注

**决策依赖**：要看实战中真实困扰频率。单 project 这种高频还是低频？多 project 场景（owner ≠ approver）是否也需要？——等更多使用反馈。

---

## 5. 自动化测试污染开发库 — 根治方案：testcontainers

**背景**：2026-04-21 发现 `chatops` 开发库 `capabilities.system_prompt` 全部被清成 NULL、`projects` / `dingtalk_users` / `product_line_members` / `product_line_capabilities` 全空。历次事故追因无果，应用层 guard（§3 的 `assertTestDbSafeToReset` B2+B3 + `assertDatabaseUrlForTests`）一直在打补丁——每漏一条 repository 路径就被穿透一次。**结论：不再加应用层 assert，改物理隔离。**

**根治方案（已与用户确认）**：testcontainers 每次 vitest session 启动临时 PostgreSQL 容器，销毁时一起清掉。测试代码即使乱写，拓扑上也够不到开发库。

**实施步骤**：

1. 加 dev 依赖：`@testcontainers/postgresql` + `testcontainers`
2. 新增 [src/__tests__/setup/pg-container.ts](../src/__tests__/setup/pg-container.ts)
   - vitest `globalSetup` 钩子
   - 启动 `postgres:16` container，getConnectionUri() 写 `process.env.DATABASE_URL`
   - 跑 `migrate.ts` 建 schema
   - teardown 里 `container.stop()`
3. 改 [vitest.config.ts](../vitest.config.ts)
   - `test.globalSetup: ['./src/__tests__/setup/pg-container.ts']`
   - `test.fileParallelism: false` — **串行跑**，避免 suite 间数据串（用户确认选此档）
4. 删代码（防补丁回退）
   - [helpers/db.ts](../src/__tests__/helpers/db.ts)：`assertDatabaseUrlForTests` / `assertTestDbSafeToReset` 两个 guard 整删
   - `resetTestDb` 简化为 "drop schema + re-migrate"（不再 marker 校验）
   - 各 test suite 里 `beforeAll(assertDatabaseUrlForTests(...))` 调用全删（grep `assertDatabaseUrlForTests` 定位）
   - `chatops_test_db_marker` 表 bootstrap 文档从 `mock-e2e/README.md` 删
5. 保留
   - 各 suite `beforeAll(resetTestDb)` 数据清理照旧
   - `seed.sql` 本身（生产初始化用）
6. 验证
   - `pnpm test` 跑一遍全回归全绿
   - 开发库 `psql ... -c "SELECT COUNT(*) FROM capabilities WHERE system_prompt IS NOT NULL"` 前后对比，**不变**才算过

**成本**：
- 每次 `pnpm test` 启动 +6~10s container cold start（之后 session 内复用）
- 需要本机 docker（用户已有 docker-desktop）
- CI 里 GitLab Runner 已经 docker-in-docker，天然支持

**暂缓**：等钉钉流程验证完再动手。

---

## 6. Issue 模板标准化（7 段排版 + 原始材料保留 + 视觉转写）

**背景**：2026-04-21 验证 Porygon 全链路后发现，[analyzer.ts:buildMarkdownReport](../src/agent/analysis/analyzer.ts#L82) 当前只产出**浓缩的 AI 分析结论**（分类/根因/方案/影响模块/分析步骤），缺失关键信息——后续审批/重试/人工接手都拿不到足够材料做独立判断。

**核心问题**：

| 维度 | 现状 | 缺口 |
|---|---|---|
| 用户原始问题材料 | ❌ 完全丢失（钉钉原文 + 日志片段 + 截图都没进 Issue） | 审批人凭浓缩报告做决策 |
| 根因分析深度 | ⚠️ 只有 summary + file:line | 无证据链、无反证过程 |
| 影响范围评估 | ⚠️ 只列 `affected_modules` | 无回归风险、无业务影响 |
| 测试范围 | ❌ 无 | Reviewer / fix agent 没参考范围 |
| 不确定时的补充材料指引 | ⚠️ Schema B 只给单条 `verify_command` | 不是清单化、不指导人工补什么 |
| 图片输入 | ❌ 钉钉消息 images 字段没进 Issue | 纯文本 Issue 丢失视觉上下文 |

**7 段目标排版**：

```
## 1. 问题描述背景
   提问人 + 时间 + 项目/分支
   用户原文（cleanedPrompt 完整保留）
   附加材料：日志片段（>20KB 折叠 <details>）
   附加截图：AI 视觉转写的文字描述 + 原图上传到 GitLab 附件 ![](url)

## 2. 根因分析判断
   结论 summary + 文件:行号 + 证据链（3+ 条具体引用）+ 置信度 + 反证尝试

## 3. 解决方案
   多候选：summary / risk / effort / recommended / 改动点 file:line

## 4. 影响范围评估
   直接：被改函数/类、调用方（Grep）、继承/实现方
   间接：上游依赖、下游契约、schema/配置/数据迁移
   业务：触发频率、严重度、workaround

## 5. 测试范围
   必须通过（现有用例清单）
   建议新增（边界/并发/超长）
   回归范围（本模块 + 依赖方 smoke）

## 6. 不确定性 & 待补充材料（仅 confidence=low/medium 时出现）
   未验证点清单
   补充材料 [ ] checkbox list
   「补完后 `@机器人 reanalyze #XX` 重分析」

## 7. 分析步骤（<details> 折叠）
   Phase 1-4 推理过程
```

**实施改动点**：

1. **[src/agent/analysis/prompts.ts](../src/agent/analysis/prompts.ts)**（注：文件已删，prompt 存 DB `capabilities.analyze_bug.system_prompt`）
   - 扩 Schema A 字段：`evidence_chain[]` / `impact_assessment{direct, indirect, business}` / `test_scope{required, suggested, regression}` / `followup_materials[]`
   - 加视觉转写指令：`如用户附图，先用 Read/视觉能力转成文字描述写入 images_described[]`
   - prompt 增量 ~500-800 字

2. **[src/agent/analysis/analyzer.ts](../src/agent/analysis/analyzer.ts)**
   - `buildMarkdownReport` 重写为 7 段
   - 传参加 `userPrompt / senderName / timestamp / images`（当前 extraParams.message 已传，images 需新增管道）
   - `parseAnalysisOutput` 适配新 schema 字段
   - 超长保护：日志 >20KB → 折叠；description 整体 >60KB → 截断 + 附件链接

3. **钉钉 adapter**（次要）
   - [src/adapters/im/dingtalk.ts](../src/adapters/im/dingtalk.ts) 图片下载后传给 capability 调用（当前 runner 已有 images 引用，但 analyze_bug 路径未透传到 Issue 创建环节）

4. **GitLab 附件上传**（新增能力）
   - 调 `POST /api/v4/projects/:id/uploads` 上传图片，拿 markdown url
   - 新增 helper `src/agent/analysis/gitlab-upload.ts`

5. **测试 fixture 全更新**
   - mock-e2e / integration 测试里 `expect(issue.description).toContain(...)` 断言要对齐新 7 段结构

**改动规模**：~300 行代码 + prompt 改写 + 5-8 个测试 fixture 更新；合并了原本分散的"问题材料保留"+"图片视觉转写"+"影响评估深化"+"测试范围"+"补充材料清单化" 5 个子需求。

**受益方**：
- L3 审批人（有完整材料独立判断）
- retry 流程（原始材料可复用，不只浓缩版）
- 人工接手（materials for handover）
- AI Review agent（测试范围 + 影响评估 → 审查维度更清楚）

**阻塞点**：当前 Porygon 全链路刚跑通（2026-04-21），先不打断稳定性验证。建议安排在：
1. testcontainers §5 实施完（测试环境物理隔离 → 改 prompt/analyzer 不会再污染 dev）
2. 或 Porygon 改动 commit + 回归 2-3 轮稳定后
