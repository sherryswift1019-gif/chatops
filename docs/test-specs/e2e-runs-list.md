---
id: e2e-runs-list
title: E2E 运行列表页
target_project: chatops
scenarios:
  - runs-list-empty
  - runs-list-with-data
  - runs-create-default
  - runs-create-tag-filter
  - runs-create-id-filter
  - runs-create-governor-overrides
  - runs-abort-active-run
  - runs-navigate-to-detail
tags:
  - smoke
  - e2e-runs
---

# E2E 运行列表页（/e2e-runs）

`E2eRunsPage` — 展示所有 e2e_runs 记录，支持新建 Run、中止 active Run、点击跳转详情页。

## 前置条件

- `chatops` 项目行已在 `e2e_target_projects`
- 用户已登录 admin
- Mock API `POST /admin/e2e-runs` → 202 + `{ runId: "1", status: "pending" }` （新建场景用）
- Mock API `POST /admin/e2e-runs/:id/abort` → 200 （中止场景用）

## Seed 数据（各场景差异）

| 场景 | 写什么 |
|---|---|
| runs-list-empty | 不写 `e2e_runs` |
| runs-list-with-data | INSERT 3 条不同 status 的 run |
| runs-create-* | 不 seed run，只 seed chatops 项目（已有） |
| runs-abort-active-run | INSERT 1 条 `status='running'` 的 run |
| runs-navigate-to-detail | INSERT 1 条 run |

---

## 场景

### runs-list-empty：无 Run 记录时显示空状态

**目的**：验证 `e2e_runs` 表为空时，Table 显示「暂无 E2E Run 记录」。

**步骤**：
1. 不 seed 任何 run
2. 访问 `/e2e-runs`

**预期结果**：
- Table 空状态文字包含「暂无 E2E Run 记录」
- 右上角「新建 Run」按钮可见

---

### runs-list-with-data：有 Run 记录时正常渲染列表

**目的**：验证 Table 正确显示 Run ID、项目名、源分支、触发方式、状态 Tag、迭代分支、启动时间。

**Seed**：
```sql
INSERT INTO e2e_runs (target_project_id, trigger_type, trigger_actor,
                      source_branch, iteration_branch, status)
VALUES
  ('chatops', 'manual', 'alice', 'main', 'test-iter/1', 'running'),
  ('chatops', 'im',     null,    'main', 'test-iter/2', 'passed'),
  ('chatops', 'api',    null,    'feat-x','test-iter/3','aborted');
```

**步骤**：
1. Seed 后访问 `/e2e-runs`

**预期结果**：
- Table 有 3 行
- status `running` 行 Tag 文案「运行中」，颜色 processing（蓝色动画）
- status `passed` 行 Tag 文案「通过」，颜色 success（绿）
- status `aborted` 行 Tag 文案「已中止」，颜色 default（灰）
- "迭代分支" 列显示为可点击的 code 链接
- "项目" 列显示 `chatops` 项目的 displayName（来自 `e2e_target_projects`）

---

### runs-create-default：新建 Run — 全部场景 + main 分支

**目的**：验证点击「新建 Run」→ 填写最少必填项 → 提交，API 被调用，列表刷新。

**前置**：Mock `POST /admin/e2e-runs → 202 { runId: "1", status: "pending" }`

**步骤**：
1. 访问 `/e2e-runs`，点击「新建 Run」
2. 弹出 Modal 「新建 E2E Run」
3. 在「被测项目」Select 中选择 `ChatOps`（chatops 的 displayName）
4. 「源分支」已默认为 `main`（initialValues），不修改
5. 「场景过滤」保持「全部」Radio
6. 点击「确定」

**预期结果**：
- `POST /admin/e2e-runs` 被调用，body 含 `{ targetProjectId: "chatops", sourceBranch: "main" }`，不含 `scenarioFilter`
- `message.success` toast「Run 已创建」出现
- Modal 关闭
- 列表刷新后有新的 run 行

---

### runs-create-tag-filter：新建 Run — 按 tag 过滤场景

**目的**：验证选择「按 tag」Radio 后出现 Tag 列表输入框，提交时 scenarioFilter.tags 正确。

**步骤**：
1. 点击「新建 Run」
2. 选「被测项目」= chatops
3. 点击「按 tag」Radio
4. 「Tag 列表」Input 填入 `smoke,login`
5. 点击「确定」

**预期结果**：
- `POST /admin/e2e-runs` body 含 `{ scenarioFilter: { tags: ["smoke", "login"] } }`
- 「Tag 列表」输入框在选择「按 tag」后才出现，在「全部」时不可见

---

### runs-create-id-filter：新建 Run — 按场景 ID 过滤

**目的**：验证选择「按 ID」Radio 后出现「场景 ID 列表」输入框，提交时 scenarioFilter.ids 正确。

**步骤**：
1. 点击「新建 Run」
2. 选「被测项目」= chatops
3. 点击「按 ID」Radio
4. 填入 `login-success,checkout-flow`
5. 确定

**预期结果**：
- `POST /admin/e2e-runs` body 含 `{ scenarioFilter: { ids: ["login-success", "checkout-flow"] } }`

---

### runs-create-governor-overrides：新建 Run — 展开 Governor 高级面板填入覆盖值

**目的**：验证展开「Governor 覆盖（高级）」折叠面板后，填入的数值正确出现在请求 body 中。

**步骤**：
1. 点击「新建 Run」，选被测项目
2. 点击「Governor 覆盖（高级）」Collapse Panel 展开
3. 「单场景最大重试次数」填入 `5`
4. 「最大运行时长（小时）」填入 `2`
5. 确定

**预期结果**：
- `POST /admin/e2e-runs` body 含 `{ governorOverrides: { maxPerScenarioAttempts: 5, maxRunHours: 2 } }`

---

### runs-abort-active-run：中止 running 状态的 Run

**目的**：验证「中止」按钮只对 running/awaiting_fix 可见，点击 Popconfirm 确认后调用 abort API。

**Seed**：
```sql
INSERT INTO e2e_runs (target_project_id, trigger_type, source_branch, iteration_branch, status)
VALUES ('chatops', 'manual', 'main', 'test-iter/1', 'running');
```

Mock `POST /admin/e2e-runs/1/abort → 200 { ok: true }`，之后 GET 返回 status=`aborted`。

**步骤**：
1. Seed + Mock 后访问 `/e2e-runs`
2. 找到 running run 行，点击「中止」按钮（StopOutlined）
3. 出现 Popconfirm，点「中止」确认按钮

**预期结果**：
- abort API `POST /admin/e2e-runs/1/abort` 被调用
- `message.success` toast 含「Run #1 已发送中止指令」
- 列表刷新，该行 status Tag 变为「已中止」
- 对 `passed` / `aborted` 状态的行，「中止」按钮不渲染（操作列为空）

---

### runs-navigate-to-detail：点击 Run ID 链接导航到详情页

**目的**：验证点击「#1」链接导航到 `/e2e-runs/1`。

**Seed**：INSERT 1 条 run，id 为已知值。

**步骤**：
1. 访问 `/e2e-runs`，找到第一行 Run ID 列的「#1」链接，点击

**预期结果**：
- 页面导航到 `/e2e-runs/1`（URL 改变）
- 详情页开始加载
