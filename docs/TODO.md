# TODO / Growth Backlog

> 统一的长期待办清单。短期 session-scoped 任务用 TodoWrite，跨会话持久事项记这里。
>
> 每条格式：**背景 → 现状 → 待做 → 决策/阻塞点**。
>
> 不放：已完成事项、代码里能查到的约定、短期调试记录（那些走 memory / commit message）。

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

**过渡措施（2026-04-21）**：
1. `assertDatabaseUrlForTests` 的 URL 名字约定已放宽为"仅非空校验"，因 GitLab CI postgres service 默认 db 名是 `chatops`。
2. `assertTestDbSafeToReset` 加第三分支：marker 缺失 + public schema 完全空时视为全新空库，自动 bootstrap marker 后通过（CI 的全新 postgres 容器走此路径；开发库/生产库必有业务表，走原 throw 路径）。

真正根治仍走本节的 testcontainers 方案。

---

## 6. Issue 模板标准化（7 段排版 + 原始材料保留 + 视觉转写）

**状态**：⚠️ 部分完成（2026-04-21）

**已完成**：
- ✅ 7 段排版框架（§1 问题描述背景 → §7 分析步骤折叠）— [analyzer.ts:139 buildIssueDescription](../src/agent/analysis/analyzer.ts#L139)
- ✅ `images_described[]` Schema 字段 — [analyzer.ts:48](../src/agent/analysis/analyzer.ts#L48)
- ✅ analyze_bug prompt 升级到 4025B（7 段要求 + 8 条硬约束） — seed.sql
- ✅ Issue 实际生成 7 段（L2 实测 Issue #135 验证通过）

**未完成**（延后，见 §12）：
- ❌ 图片视觉转写（adapter 把 images 透传给 Porygon vision backend）
- ❌ 图片上传到 GitLab 附件（`POST /api/v4/projects/:id/uploads`）
- ⚠️ Schema A 扩展字段（evidence_chain / impact_assessment / test_scope / followup_materials）部分字段 prompt 里要求了但 parseAnalysisOutput 没硬校验

**原设计文档**（7 段完整定义 + 实施改动点 + 受益方）保留在本节历史快照中，供后续 §12 参考：

**背景**：2026-04-21 验证 Porygon 全链路后发现，原 buildMarkdownReport 只产出浓缩的 AI 分析结论（分类/根因/方案/影响模块/分析步骤），缺失关键信息——后续审批/重试/人工接手都拿不到足够材料做独立判断。

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

---

## 7. ✅ fix-logic.ts rebase 失败被当 success 通过的 bug（已修复 2026-04-21）

**已修复 commit**：本次（fix-logic.ts 一行改 + fix-logic-preload.test.ts 3 个新单测）。

**保留历史记录**以防 regress：

**背景**：2026-04-21 Porygon 全链路连续 2 次验证（L2/test、L2/ai-chatops-dev），每次都在 fix_bug_l2 阶段看到：

```
[FixAgent] rebase 失败: Command failed: git rebase origin/<branch>
[AgentCoordinator] completed: fix_bug_l2 { success: true }   ← 应该 false
```

Pipeline 没有停在这里，继续走 create_mr + push，MR 被创建出来。**但 push 出去的 fix 分支其实没成功 rebase 到目标分支**，合并时可能出现意外。

**根因**：

[src/agent/fix/branch-manager.ts:70](../src/agent/fix/branch-manager.ts#L70) `rebaseOnTarget` 的返回契约：

| 场景 | 返回 |
|---|---|
| rebase 成功 | `{ success: true, conflict: false }` |
| rebase 遇冲突（CONFLICT / could not apply） | `{ success: false, conflict: true }` |
| **rebase 其他失败**（fetch 挂了 / 分支不存在 / 策略错误 / 网络超时...） | **`{ success: false, conflict: false }`** ← 上游没处理 |

[src/agent/fix/fix-logic.ts:161-164](../src/agent/fix/fix-logic.ts#L161) 上游判定：

```ts
const rebaseResult = await rebaseOnTarget(worktree.path, input.sourceBranch)
if (rebaseResult.conflict) {  // ← 只判 conflict
  return { branch, testPassed: false, ... error: '与 XX 存在冲突，需要人工解决' }
}
// 非冲突的失败 fall through → pushBranch → return { testPassed: true }
```

**修复**（一行）：

```ts
if (!rebaseResult.success) {
  return {
    branch,
    testPassed: false,
    output,
    error: rebaseResult.conflict
      ? `与 ${input.sourceBranch} 存在冲突，需要人工解决`
      : `rebase 失败（非冲突），查后端日志定位`,
  }
}
```

**验证**：
- 单测 [branch-manager.test.ts](../src/__tests__/unit/branch-manager.test.ts) 或 fix-logic 层加 case：mock `rebaseOnTarget` 返回 `{ success: false, conflict: false }` → 期望 `testPassed: false`
- 真实钉钉重发一次 bug，观察 rebase 失败时 Pipeline 是否正确 stop

**影响评估**：
- 在 rebase 无冲突但失败的场景下，Pipeline 会正确终止（原本错误地继续 push）
- 之前两次"看起来跑通"的 L2 case 其实都有这个 bug 的后遗症——push 上去的分支可能没真的 rebase 干净
- 改动范围小（1 文件 3-4 行）
- Pipeline retryCount=2 仍然会触发重试，但至少第一次失败能被正确识别

**优先级**：**高**（影响所有已验证"跑通"的 pipeline，每次都污染 push 的分支）

**实施时机**：可以立刻做，不阻塞任何其他工作。

---

## 8. L3 审批 approvalKey 串线风险（多轮 pipeline 共用 issueId key）

**背景**：2026-04-21 L3 卡片化验证后发现的潜在 bug。卡片 outTrackId 和 pending Map key 都来自 [approval-manager.ts:29](../src/pipeline/approval-manager.ts#L29) 的 `approvalKey = l3-fix-${issueId}`，**不带 reportId 维度**。

**串线场景**：
1. Issue #42 第一轮 pipeline → `pending.set("l3-fix-42", resolver_r101)` → 发 card1 → owner 没点
2. 人工 reanalyze / 超时后新一轮 pipeline → `pending.set("l3-fix-42", resolver_r102)` ← 覆盖
3. owner 回头点 card1（outTrackId=l3-fix-42）→ 钉钉回传 → `pending.get("l3-fix-42")` 命中 r102
4. **r101 卡片的点击把 r102 审批决了**，r102 卡片形同虚设

**触发条件**：
- 同 issue 跨 pipeline 轮的旧卡片在钉钉 UI 上还"活"着（没超时到 timeoutMs）
- owner 点了旧卡
- 实际概率取决于 timeoutMs 配置 + reanalyze 频率，当前未量化

**降低风险**：
- `bug_fix_events.code='approval'` 的 `reportId` 来自 pipeline handler 上下文，**DB 审计轨迹不会串**（能反查"本轮审批对应哪个 report"）
- 串线只影响 pipeline Promise resolve 指向，DB 里只多一条 event

**为什么先不改**（2026-04-21 用户决策）：
- 唯一正解是 `approvalKey = l3-fix-${reportId}`，改动点集中在 [approval-manager.ts:29](../src/pipeline/approval-manager.ts#L29)（key 生成）+ 23-28（加 reportId 参数）+ 62-83（tryHandleCommand 按 issueId 反查）
- approval-manager.ts 是严益昌原创代码（[spec 1585 行](superpowers/specs/2026-04-17-bug-fix-workflow-orchestration-design.md#L1585) 零改动硬约束）
- 当前业务场景下同 issue 跨轮 pending 的窗口较短，权衡后接受风险

**等何时做**：
- 出现真实用户投诉"审批结果错了" 或
- `Pipeline 状态持久化`（memory `pipeline-state-persistence.md`）要落 DB 时一并重构（`pipeline_approvals` 表天然带 reportId 外键）

**临时规避**：观察 `bug_fix_events.code='approval'` 的 `data.decision` 和 pipeline 实际跑的结果是否一致；出异常第一时间查日志 `[DingTalk] Card callback parsed OK: outTrackId=...` 看是否归错 report。

---

## 9. Bug 修复实例列表"触发人"列易混淆

**背景**：2026-04-21 用户反馈 BugRunsPage 的"触发人"列显示"女皇驾到"，以为是机器人名字，实际是**用户本人的钉钉昵称**。

**现状（无 bug）**：
- DB `bug_analysis_reports.triggered_by` 存钉钉 staffId（`183832601538060368`）
- 前端通过 `dingtalk_users` 表反查 name 显示（[BugRunsPage.tsx:89](../web/src/pages/BugRunsPage.tsx#L89)）
- 取值链路正确，`dingtalk_users` 是从钉钉同步的组织人员表，不含 bot

**容易混淆的点**：
- 钉钉 DM 会话抬头显示的是**对方/自己**昵称；群里机器人发消息时头像旁显示的是机器人 app 名；二者在不同场景下都可能和"女皇驾到"这个名字对应，导致用户分不清
- 列名"触发人"在 IT 语境下泛指"谁触发"，但这张表语义就是"提问人"（发钉钉消息问 bug 的那个用户）

**可做（低优先）**：
- 列名改"提问人"，语义更明确
- 渲染时如果 `triggeredBy == 当前登录 admin.userId`，显示"你（XXX）"
- 加头像 avatar 辅助识别（`dingtalk_users.avatar` 字段已有，空值时才降级）

**决策依赖**：等类似疑问再出现一次再做，单次误会不改。

---

## 10. retry 语义纠偏（跳过 analyze 直接跑 Pipeline）

**背景**：2026-04-21 测试发现前端 BugRunsPage 的"重试"按钮当前走 [admin/routes/bug-analysis-reports.ts](../src/admin/routes/bug-analysis-reports.ts) 的 retry endpoint，实现是**重跑整条 handleAnalyzeBug**（3-6 分钟 + ~$0.60 成本）——这是 `reanalyze` 语义，不是 `retry` 语义。

**问题**：
- 老 report 已经完成过一次 analyze，`level / classification / rootCauseSummary / solutionsJson / affectedModules / analysisSteps` 字段都在表里
- 用户点"重试"意图是"**方案没变，重跑修复 + MR + Review**"，不是"重新分析"
- 当前实现多花 3-6 分钟 + $0.60，且 Claude 每次 analyze 结果不稳定（可能给出不同 level/solutions）

**retry vs reanalyze 应该分离**：

| 命令 | 用途 | 跑 analyze？ |
|---|---|---|
| **retry**（前端"重试"按钮）| 方案没变，再跑一遍 fix → create_mr → review → notify | ❌ 跳过，直接复用老 report 字段 |
| **reanalyze**（群里 `@机器人 reanalyze #XX`）| 方案不对，重新分析 | ✅ 跑 |

**修复方案**：改造 `POST /bug-reports/:id/retry`：

```ts
app.post('/bug-reports/:id/retry', async (req, reply) => {
  const oldReport = await getBugAnalysisReportById(reportId)
  // 要求 oldReport.status='aborted'（现状已有校验）

  // 复用老 report 的 analyze 结果字段，创建新 report
  const newReport = await createBugAnalysisReport({
    issueId: oldReport.issueId,
    issueUrl: oldReport.issueUrl,
    productLineId: oldReport.productLineId,
    level: oldReport.level,
    classification: oldReport.classification,
    confidence: oldReport.confidence,
    confidenceScore: oldReport.confidenceScore,
    rootCauseSummary: oldReport.rootCauseSummary,
    solutionsJson: oldReport.solutionsJson,
    affectedModules: oldReport.affectedModules,
    analysisSteps: oldReport.analysisSteps,
    metadata: { ...oldReport.metadata, retryFrom: oldReport.id },
    primaryProjectPath: oldReport.primaryProjectPath,
    triggeredBy: initiatorId,
    agentSessionId: `retry-${oldReport.id}`,
  })

  // 不跑 analyze，直接触发 Pipeline
  if (oldReport.classification === 'bug') {
    await handleAnalysisComplete(newReport.id, oldReport.level, oldReport.classification, initiatorId)
  }

  return reply.send({
    success: true,
    data: { newReportId: newReport.id, retryFrom: oldReport.id, /*...*/ },
  })
})
```

**好处**：
- **秒级返回**（仅 DB INSERT + 触发 Pipeline，几百 ms）—— 不再需要 fire-and-forget 异步
- 省 **$0.60 / 次** Claude 成本
- 结果稳定（复用已审过的方案，Claude 不会重新下不同结论）
- 前端 UX 瞬响：`retryBugReport` 能立即返回 `newReportId`，提示"新 report #N 已创建，正在跑 Pipeline"

**改动规模**：~40 行

- `src/admin/routes/bug-analysis-reports.ts` retry handler 改造（移除 fire-and-forget，改为同步 INSERT + 触发 Pipeline）
- `web/src/api/bug-analysis-reports.ts` `RetryBugReportResult` 改回含 `newReportId`
- `web/src/pages/BugRunsPage.tsx` Modal 文案改回同步"已启动新一轮：报告 #XX"
- 测试 fixture：`src/__tests__/**/*retry*` 如有"会跑 analyze"的断言要改

**影响评估**：
- 优点：行为符合 retry 语义，UX 质变，成本降低
- 风险：老 report 的 analyze 结果可能已 stale（代码改了但分析没跟上）——但这就是 `reanalyze` 命令存在的理由，用户可自选
- 兼容：老 retry 行为（跑 analyze）就是 reanalyze，reanalyze 已单独存在无需迁移

**优先级**：中-高（fire-and-forget 暂时缓解了 UX，但语义错误 + 成本浪费都是硬伤）

**实施时机**：当前 Porygon / ai_review_mr worktree / 强制终止按钮 / Issue 7 段模板 / retry 异步化 这一批改动 commit 并稳定 2-3 天后再做。

---

## 11. ✅ Handover 区块字段契约错配（已完成 2026-04-22）

**背景**：BugRunDetailDrawer 的"Handover"区块（[BugRunDetailDrawer.tsx:361-395](../web/src/components/BugRunDetailDrawer.tsx#L361-L395)）有 **3 个字段常年为 `—`**：接手人 / 修复分支 / 失败摘要。根因是前端读的字段名 vs 后端写入的字段名不对齐，加上"失败摘要"源头根本没生产过。

**修复两批**：

**第一批（2026-04-21 commit 8a70302）**：
- ✅ **接手人**：后端 handover 事件 data 冗余写 `owner`（查 `projects.owner_id` → fallback `module_owners`）
- ✅ **修复分支**：后端同时写 `fixBranch` + `fixBranchUrl`（拼 `${gitlabBase}/${projectPath}/-/tree/${fixBranch}`）
- ✅ **失败摘要（前端兜底）**：`failureSummary` 为空时整个 `Descriptions.Item` 不渲染

**第二批（2026-04-22 本次）—— 失败摘要数据源扩展**：
- ✅ [coordinator.ts:357-381](../src/agent/coordinator.ts#L357-L381) —— 触发 `fix_exhausted` handover 前，按 projectPath 聚合每个 project **最后一次** failed 的 `fix_attempt.data.error`（每条 ≤200 字、总长 ≤1000 字）写入 `checkAndTriggerHandover` 的 context
- ✅ [request-handover-handler.ts:116-119, 184](../src/agent/handover/request-handover-handler.ts#L116-L119) —— 解析 `ctx.failureSummary` 并写入 `bug_fix_events.handover.data.failureSummary`
- ✅ 单测：coordinator fix_exhausted 分支 + request-handover "传入 context" 用例均加断言

**为什么不改 fix-runner / retry-handler**：聚合点放在 coordinator onComplete 最省事——那里已经查了 `fix_attempt` events，直接复用数组；fix-runner 只管"每次 attempt 的 error 落盘"不变；契约更干净。

**注意**：旧的 handover 事件不会回填 owner / fixBranchUrl / failureSummary，只影响新产生的事件。

---

## 12. ✅ L3 审批能力恢复（已完成 2026-04-21）

**状态**：已通过 **resolver 抽象方案** 恢复，3 组 skip 测试全部解开。

**最终方案**（优于原 TODO 草案的模板展开）：
- `StageDefinition` 加 `approverIdsResolver?: string` 字段（[types.ts](../src/pipeline/types.ts)）
- 新建 [src/pipeline/approval-resolvers.ts](../src/pipeline/approval-resolvers.ts) —— resolver 注册表（同 capability handler 模式）
- 新建 [src/agent/approval/resolvers.ts](../src/agent/approval/resolvers.ts) —— 业务 resolver 实现（目前含 `primary_project_owner`）
- graph-builder.buildApprovalNode resolver 优先 + approverIds 模板展开 fallback
- coordinator.handleAnalysisComplete 迁了 FYI DM（给从仓库 owner 发知情）+ 把 reportId 塞进 runtimeVars（resume 时 reloadContext 合并，avoid triggerParams 丢失）
- graph-runner.reloadContext 合并 pipeline.triggerParams + run.runtimeVars
- 删 approve-l3-handler.ts + server.ts 注册 + unit spec
- seed.sql L3 pipeline 首 stage 改为 `{stageType:'approval', approverIdsResolver:'primary_project_owner'}`
- 前端 Pipeline 编辑器下拉加"AI 能力"选项 + approverIdsResolver 字段（[TestPipelinesPage.tsx](../web/src/pages/TestPipelinesPage.tsx)）

**为何选 resolver 而非模板展开**：真实业务里审批人几乎都是 context-dependent（L3 主仓库 owner / 报销金额判定 / 生产 OPS 产品线负责人）。resolver 让 pipeline 只声明"策略名"，运行时业务代码决定具体人。模板展开是静态耍小聪明，长期会积累技术债。

**已解开的回归 spec（全绿）**：
- [l3-multi-project-approval.test.ts](../src/__tests__/integration/l3-multi-project-approval.test.ts) —— 重写：approval approved / rejected 两条路径
- [approval-timeout-retry.test.ts](../src/__tests__/integration/approval-timeout-retry.test.ts) —— 重写：stage.timeoutSeconds=1 触发 graph-runner 内置 timeout
- `reanalyze-flow.test.ts` —— **删除**（retry_analysis 决策已被 main LangGraph 改造移除，无测义）

**未来扩展**：
- resolver 库扩充——报销审批、产品线负责人、security review 等
- 钉钉 adapter 的 onCardAction → server.ts handleCallback 链路在实测钉钉 L3 中验证

**背景**：2026-04-21 合并 main 到 dev 时，main 的 LangGraph 改造把 `PipelineApprovalManager.requestApproval` / `tryHandleCommand` 等 legacy API 换成 `throw Error('legacy API removed')`，主线改走 graph-runner 的 approval interrupt + `requestCard`。dev 分支保留的 `approve-l3-handler.ts` 还在调用 legacy `requestApproval`，运行时必崩。

**应急处理（已做）**：
- seed.sql L3 pipeline stages 删除 `approve_l3` stage，退化为 L2 流程（fix_bug_l3 → create_mr → ai_review → notify，无审批）
- `approve-l3-handler.ts` 内 `requestApproval` 调用从 4 参改 3 参，让编译过（运行时仍会 throw，但 L3 pipeline 不再调此路径）
- `claude-runner.ts` Step 0 的群内命令 fallback 整块删除（tryHandleCommand 已移除）
- `_e2e.ts` 两个审批测试 endpoint 返回 `deprecated: true` 占位

**效果**：L1/L2/L3/L4 流程都能跑，但 L3 失去"方案审批"环节，与 L2 同构。

**待恢复（完整 L3 审批）**：

主线 main 的审批机制：
- pipeline stage 用 `stageType:'approval'` + `approverIds`（不是 capability）
- graph-runner 跑到此 stage 触发 `interrupt(APPROVAL_INTERRUPT, { approverIds, description })`
- `initGraphRunnerDispatchers` 里监听 interrupt → 调 `PipelineApprovalManager.requestCard` 发钉钉互动卡片
- 用户点卡片按钮 → Stream TOPIC_CARD → server.ts onCardAction → `mgr.handleCallback` → Command.resume 恢复 graph

**主要挑战**：`approverIds` 在 approval stage 定义时要求**静态列表**，而 approve_l3 原设计是**运行时动态查 primary owner**（先 `projects.owner_id` 再 fallback `module_owners`）。

**迁移方案**（草案）：

1. **pipeline stage 加 shim 变量**：seed.sql L3 pipeline 加回一条 approval stage，`approverIds: ["{{variables.primaryOwnerId}}"]`
2. **coordinator 预计算 owner**：触发 L3 pipeline 时，`handleAnalysisComplete` 先查 primary project owner，写入 `triggerParams.primaryOwnerId` 或 `variables.primaryOwnerId`
3. **graph-builder 模板解析**：如果当前 graph-builder 不支持 `approverIds` 模板展开，加一段 substitution 逻辑
4. **多 project FYI DM**：原 approve-l3-handler 还发 FYI DM 给非主 owner 让他们知情。迁移时需要在 approval stage 前补一个 capability stage（或扩展 graph-runner 的 interrupt payload）发 FYI
5. **删除 approve-l3-handler.ts + register 调用 + e2e 占位 endpoint**
6. **seed.sql 恢复 L3 pipeline 的"方案审批"stage**（用 stageType:'approval' 新语义）

**改动规模**：~1-2 天（含多 project FYI DM 迁移、端到端测试）

**优先级**：**高**（L3 审批是产品核心能力，不能长期缺失）

**阻塞点**：等 merge 的这一批改动上线稳定后立刻做；在稳定前优先保证 L1/L2/L4 可用。

**已 skip 的回归（2026-04-21）**：
- [integration/approval-timeout-retry.test.ts](../src/__tests__/integration/approval-timeout-retry.test.ts) 整个 `AC3: 审批超时 → aborted → retry 复用 Issue` describe
- [integration/l3-multi-project-approval.test.ts](../src/__tests__/integration/l3-multi-project-approval.test.ts) 整个 `AC2: L3 多 project 审批 + 主/从仓库` describe
- [integration/reanalyze-flow.test.ts](../src/__tests__/integration/reanalyze-flow.test.ts) `retry_analysis` case

恢复 L3 审批能力后，需要把这 3 组 spec 去掉 skip 并重跑（可能需要改造为 graph-runner interrupt 语义）。

---

## 13. Issue 模板 — 视觉转写 + GitLab 附件上传（§6 剩余）

**状态**：📌 待做（§6 主体已完成，这是剩余的两条子需求）

**背景**：§6 Issue 模板 7 段排版已落地，但"视觉内容"还没接入：
- 钉钉消息 images 字段仍然没进 Issue（adapter → Porygon vision 管道未打通）
- 图片也没上传到 GitLab 附件（Issue description 里没有 `![](url)` 图链）

**实施改动点**：

1. **钉钉 adapter 透传 images**（[src/adapters/im/dingtalk.ts](../src/adapters/im/dingtalk.ts)）
   - 下载图片（dingtalk image_key → image 内容）
   - 传给 capability 调用（当前 runner 已有 images 引用，但 analyze_bug 路径未透传）

2. **Porygon vision 后端**（新依赖）
   - createPorygon 配置加 vision-capable model 或切 Sonnet-with-vision
   - analyze_bug 调用时 prompt 附上 image 数据

3. **GitLab 附件上传**（新增 helper）
   - `src/agent/analysis/gitlab-upload.ts` 调 `POST /api/v4/projects/:id/uploads`
   - 返回的 `markdown` 字段（如 `![image](/uploads/abc/xxx.png)`）插到 Issue §1 末尾

4. **analyzer.parseAnalysisOutput**
   - 当前允许 `images_described[]` 字段但没强校验；视觉转写上线后这个字段应始终填
   - Schema A 扩展字段 `evidence_chain[]` / `impact_assessment` / `test_scope` / `followup_materials` 的硬校验也一并加

**改动规模**：~150 行代码（adapter ~30 + upload helper ~50 + analyzer schema ~30 + 集成 ~40） + prompt 里"视觉转写"指令已在（验证 prompt 是否要求 vision 输出）

**阻塞点**：需先确认 Porygon/Claude 的 vision 能力如何暴露（API 调用形式、模型选择），以及内网代理是否支持 image 传输。
