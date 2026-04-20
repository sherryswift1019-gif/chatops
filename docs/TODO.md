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
