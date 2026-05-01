---
id: e2e-run-detail
title: E2E 运行详情页
target_project: chatops
scenarios:
  - run-detail-header-info
  - run-detail-governor-stats
  - run-detail-sandbox-card
  - run-detail-timeline-empty
  - run-detail-timeline-scenarios
  - run-detail-evidence-drawer
  - run-detail-ai-diagnosis
  - run-detail-abort-active
  - run-detail-abort-hidden-for-finished
  - run-detail-back-button
tags:
  - smoke
  - e2e-run-detail
---

# E2E 运行详情页（/e2e-runs/:runId）

`E2eRunDetailPage` — 展示单次 e2e run 的完整信息：Header（状态/Governor/分支）、沙盒 Card、场景时间线、evidence Drawer。

## 前置条件

- `chatops` 项目行已在 `e2e_target_projects`
- 用户已登录 admin

## Seed 数据模板

基础 run（被各场景复用，按需扩展）：
```sql
INSERT INTO e2e_runs (target_project_id, trigger_type, source_branch, iteration_branch, status, governor_state)
VALUES ('chatops', 'manual', 'main', 'test-iter/1', 'running',
  '{
    "runStartedAt": <now-ms>,
    "totalAttempts": 3,
    "perScenarioAttempts": {"login-success": 1, "approval-flow": 2},
    "limits": {"maxPerScenarioAttempts": 3, "maxRunHours": 4, "maxTotalAttempts": 30}
  }'
);
```

---

## 场景

### run-detail-header-info：Header 显示 Run ID、项目、状态 Tag

**目的**：验证 RunHeader 卡片渲染正确。

**Seed**：INSERT 1 条 `status='running'` run，`source_branch='main'`，`iteration_branch='test-iter/1'`。

**步骤**：
1. 访问 `/e2e-runs/<id>`

**预期结果**：
- Card 头部显示「Run #<id>」+ 项目名
- Status Tag 文案「运行中」，颜色为 processing（蓝色动画）
- 「源分支」区域显示 `main`（code 样式）
- 「迭代分支」区域显示 `test-iter/1`（code 链接）
- 「刷新」按钮可见

---

### run-detail-governor-stats：Governor 统计信息正确渲染

**目的**：验证 governor_state 中的 totalAttempts / limits 被正确展示。

**Seed**：INSERT run，`governor_state.totalAttempts=3`，`limits.maxTotalAttempts=30`，`limits.maxRunHours=4`，`limits.maxPerScenarioAttempts=3`。

**步骤**：
1. 访问详情页

**预期结果**：
- 显示「尝试 3/30」
- 显示「/ 4h」（maxRunHours）
- 显示「单场景重试 ≤ 3」

---

### run-detail-sandbox-card：沙盒卡片正确渲染

**目的**：验证存在沙盒记录时，沙盒 Card 展示 kind、status、envId 及 endpoints。

**Seed**：在上面 run 的基础上，INSERT 1 条 `e2e_sandboxes` 关联此 run：
```sql
INSERT INTO e2e_sandboxes (e2e_run_id, kind, status, handle)
VALUES (<runId>, 'docker-compose-local', 'ready',
  '{"envId":"test-iter-1","endpoints":{"web":"http://localhost:13001","api":"http://localhost:13002"},"modules":[],"internalRefs":{}}'
);
```

**步骤**：
1. 访问详情页

**预期结果**：
- 显示「沙盒」Card
- "类型" 显示 `docker-compose-local`
- "状态" Tag 显示 `ready`（绿色 success）
- "环境 ID" 显示 `test-iter-1`
- Endpoints 区域显示 `web → http://localhost:13001` 和 `api → http://localhost:13002`

---

### run-detail-timeline-empty：无场景记录时显示空状态

**目的**：验证 `e2e_scenario_runs` 为空时，场景时间线 Card 显示「暂无场景执行记录」。

**Seed**：INSERT run，不 INSERT 任何 scenario_run。

**步骤**：
1. 访问详情页

**预期结果**：
- 「场景时间线」Card 可见
- 显示文字「暂无场景执行记录」
- 没有任何 Collapse Panel

---

### run-detail-timeline-scenarios：场景时间线正确渲染多次 attempt

**目的**：验证有多个 scenario_run 时，按 scenarioId 分组展示，每 attempt 显示次序、结果 Tag、耗时。

**Seed**：
```sql
-- login-success: 1次通过
INSERT INTO e2e_scenario_runs (e2e_run_id, scenario_id, scenario_name, attempt_number, result, duration_ms, started_at)
VALUES (<runId>, 'login-success', '登录成功', 1, 'pass', 3200, NOW() - INTERVAL '5 min');

-- approval-flow: 2次，第1次失败，第2次通过
INSERT INTO e2e_scenario_runs (e2e_run_id, scenario_id, scenario_name, attempt_number, result, duration_ms, started_at)
VALUES
  (<runId>, 'approval-flow', '审批流程', 1, 'fail', 8100, NOW() - INTERVAL '4 min'),
  (<runId>, 'approval-flow', '审批流程', 2, 'pass', 5200, NOW() - INTERVAL '2 min');
```

**步骤**：
1. Seed 后访问详情页

**预期结果**：
- 场景时间线有 2 个 Collapse Panel（login-success / approval-flow）
- `login-success` Panel 头部图标为绿色 CheckCircleOutlined，Tag「通过」
- `approval-flow` Panel 展开后有 2 条 List 项：
  - 「第 1 次」 → Tag「失败」（红色 error）
  - 「第 2 次」 → Tag「通过」（绿色 success）
- 每条 List 项显示耗时（`3.2s` / `8.1s` / `5.2s`）

---

### run-detail-evidence-drawer：点击「查看证据」打开 Drawer 渲染 manifest

**目的**：验证点击「查看证据」按钮后，Drawer 打开并正确显示 summary、contextHint、artifacts。

**Seed**：在 `approval-flow` attempt #1 的 scenario_run 行中写入 `evidence_manifest`：
```json
{
  "summary": "approval-flow 在第 2 个连接超时",
  "contextHint": "重点看 stderr",
  "artifacts": [
    { "kind": "stderr", "module": null, "mimeType": "text/plain",
      "path": "artifacts/stderr-1.txt", "description": "完整 stderr 输出" }
  ]
}
```

**步骤**：
1. 访问详情页，展开 `approval-flow` Collapse Panel
2. 找到 attempt #1 行的「查看证据」按钮，点击

**预期结果**：
- 右侧 Drawer 打开，标题含「approval-flow · 第 1 次」
- Summary 区域显示「approval-flow 在第 2 个连接超时」
- Context Hint 区域显示「重点看 stderr」
- Artifacts 区域列出 1 条 `stderr-1.txt`（text 类型 → 渲染为 pre 文本框，或下载链接）

---

### run-detail-ai-diagnosis：Drawer 展示 AI 诊断结果

**目的**：验证 `aiDiagnosis` 字段存在时，Drawer 中 AI 诊断 Section 显示 verdict、根因摘要、修复 commit。

**Seed**：在 evidence_manifest 中加入 `aiDiagnosis`：
```json
{
  "aiDiagnosis": {
    "verdict": "product_bug",
    "rootCauseSummary": "approval coordinator 在多 project 时跳过了第二个 project 的通知",
    "fixCommitSha": "abc12345",
    "fixedFiles": ["src/agent/coordinator.ts"],
    "success": true,
    "failureReason": null
  }
}
```

**步骤**：
1. 打开含此 evidence_manifest 的 attempt 的 Drawer

**预期结果**：
- Drawer 底部有「AI 诊断」Divider
- "判定" 行显示 `product_bug`，有 success 状态 Badge（绿点）
- "根因摘要" 行显示完整摘要文字
- "修复 Commit" 行显示 `abc12345`（code 样式，8位截断）
- "修改文件" 行显示 `src/agent/coordinator.ts`（code tag）

---

### run-detail-abort-active：active 状态显示「中止」按钮并可操作

**目的**：验证 run.status 为 `running` / `awaiting_fix` / `pending` 时，Header 中「中止」按钮（StopOutlined）可见，点击 Popconfirm 确认后调用 abort API。

**Seed**：INSERT `status='running'` run。Mock `POST /admin/e2e-runs/<id>/abort → 200 { ok: true }`，之后 GET 返回 `status='aborted'`。

**步骤**：
1. 访问详情页，点击「中止」按钮
2. Popconfirm 弹出，点「中止」确认

**预期结果**：
- abort API 被调用
- `message.success` toast「已发送中止指令」
- Header Status Tag 变为「已中止」（需 polling/刷新，实际 5s polling 会触发）
- 「中止」按钮消失（`aborted` 不在 ACTIVE_STATUSES）

---

### run-detail-abort-hidden-for-finished：completed 状态不显示「中止」按钮

**目的**：验证 run.status 为 `passed` / `failed` / `aborted` 时，Header 中不渲染「中止」按钮。

**Seed**：分别 INSERT `status='passed'` 和 `status='failed'` 的 run，各跑一次验证。

**步骤**：
1. 分别访问 `passed` 和 `failed` run 的详情页

**预期结果**：
- Header 中不渲染任何包含 StopOutlined 的按钮
- 只有「刷新」按钮可见

---

### run-detail-back-button：点击返回按钮导航到列表页

**目的**：验证页面左上角「返回列表」按钮正常导航。

**步骤**：
1. 访问 `/e2e-runs/<id>`
2. 点击「返回列表」按钮（ArrowLeftOutlined）

**预期结果**：
- URL 变为 `/e2e-runs`
- 列表页正常加载
