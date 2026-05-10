---
id: quick-impl-pipeline
title: Quick-Impl 流水线
target_project: chatops
scenarios:
  - qi-list-empty
  - qi-list-with-data
  - qi-create-validation
  - qi-create-success
  - qi-edit-draft-only
  - qi-delete-draft-only
  - qi-run-button-draft-only
  - qi-run-enqueue
  - qi-spec-approval-ui
  - qi-spec-approve
  - qi-spec-reject-loop
  - qi-final-approval
  - qi-abort-during-pipeline
  - qi-detail-drawer-mr-link
  - qi-already-claimed
tags:
  - smoke
  - quick-impl
---

# Quick-Impl 流水线（/requirements）

Quick-Impl 是「一句话需求 → 自动产出 MR」的 AI 流水线，入口在需求管理页面（`/requirements`）。

**流水线节点顺序**：
```
init_qi_branch → spec_review_loop(审批) → plan_author → dev_with_review_loop → e2e_stub → final_approval(审批) → mr_create
```

**需求状态流转**：
`draft` → `queued` → `spec_review` → `planning` → `developing` → `reviewing` → `testing` → `mr_open` / `failed` / `aborted`

## 前置条件

- 用户已登录 admin
- GitLab 配置已填写（`system_config.gitlab`）
- `requirements` 表、`test_runs` 表、`requirement_approval_waiters` 表存在

## Seed 数据（各场景差异）

| 场景 | Seed 内容 |
|------|-----------|
| qi-list-empty | 清空 `requirements` 表 |
| qi-list-with-data | INSERT 5 条不同状态的需求（见下方） |
| qi-create-* / qi-run-* | 不 seed（测试创建动作本身） |
| qi-spec-approval-ui / qi-spec-approve / qi-spec-reject-loop | INSERT 1 条 `spec_review` 状态需求 + 1 条 active waiter |
| qi-final-approval | INSERT 1 条 `testing` 状态需求 + 1 条 final_approval waiter |
| qi-abort-during-pipeline | INSERT 1 条 `developing` 状态需求 |
| qi-detail-drawer-mr-link | INSERT 1 条 `mr_open` 状态需求（含 spec/plan/mrUrl） |
| qi-already-claimed | INSERT 1 条 spec_review 需求 + 1 条已 claimed waiter |

### Seed：需求列表多状态数据

```sql
INSERT INTO requirements (title, raw_input, status, gitlab_project, base_branch, source)
VALUES
  ('登录页记住密码',    '给登录页加记住密码 checkbox',              'draft',       'PAM/devops/chatops', 'main', 'web'),
  ('审批邮件通知',     '审批时发邮件给审批人',                      'spec_review', 'PAM/devops/chatops', 'main', 'web'),
  ('导出报表功能',     '需求列表支持导出 CSV',                      'developing',  'PAM/devops/chatops', 'main', 'web'),
  ('性能优化',         '首屏加载时间优化到 2 秒以内',               'mr_open',     'PAM/devops/chatops', 'main', 'web'),
  ('旧功能废弃',       '移除废弃的 v1 API',                         'failed',      'PAM/devops/chatops', 'main', 'web');
```

### Seed：spec_review 阶段等待审批

```sql
INSERT INTO requirements (id, title, raw_input, status, gitlab_project, base_branch, source, branch, worktree_path)
VALUES (100, '审批邮件通知', '审批时发邮件给审批人', 'spec_review', 'PAM/devops/chatops', 'main', 'web', 'feat/qi-100', '/tmp/quick-impl/qi-100');

INSERT INTO requirement_approval_waiters
  (requirement_id, pipeline_run_id, node_id, approval_kind, round, decision_set)
VALUES (100, 99, 'spec_review_loop', 'escalation', 1, 'escalation');
-- 注意 claimed_by IS NULL 表示未决策
```

---

## 场景

### qi-list-empty：需求列表为空状态

**目的**：验证无需求时列表显示空状态提示，并提供「新建需求」入口。

**步骤**：
1. 清空 `requirements` 表，访问 `/requirements`

**预期结果**：
- Table 显示空状态，含「暂无需求记录」或类似提示
- 右上角「新建需求」按钮可见可点

---

### qi-list-with-data：需求列表多状态正常渲染

**目的**：验证不同状态需求的行展示正确，状态 Tag 颜色/文案符合规范。

**Seed**：INSERT 5 条不同状态需求（见上方）

**步骤**：
1. 访问 `/requirements`

**预期结果**：
- Table 有 5 行，每行展示：需求标题、GitLab 项目、状态 Tag
- `draft` 行：Tag 文案「草稿」，「运行」按钮可见
- `spec_review` 行：Tag 文案含「Spec 审核」，「审批」入口可见，无「运行」按钮
- `developing` 行：Tag 含「开发中」，无「运行」按钮，无「审批」按钮
- `mr_open` 行：Tag 含「MR 已开」，显示 MR 链接（若 mr_url 已填）
- `failed` 行：Tag 含「失败」，颜色为红色

---

### qi-create-validation：新建需求 — 必填项校验

**目的**：验证「新建需求」Modal 的必填项校验（标题、原始需求、GitLab 项目）。

**步骤**：
1. 点击「新建需求」按钮
2. 不填任何字段，直接点「确定」

**预期结果**：
- 「标题」字段下方出现「请输入需求标题」或类似提示
- 「原始需求」字段出现必填提示
- 「GitLab 项目」字段出现必填提示
- Modal 未关闭，表单不提交

---

### qi-create-success：新建需求 — 成功创建为草稿

**目的**：验证填写完整信息后创建需求，新记录以 `draft` 状态出现在列表。

**步骤**：
1. 点击「新建需求」
2. 「标题」填入 `测试需求：自动化创建`
3. 「原始需求」填入 `给报表页面增加日期范围过滤器`
4. 「GitLab 项目」填入 `PAM/devops/chatops`
5. 「基础分支」填入 `main`（或保持默认）
6. 点击「确定」

**预期结果**：
- Modal 关闭，`message.success` Toast「需求已创建」出现
- 列表刷新，新行出现，状态 Tag 为「草稿」
- 新行有「运行」按钮，有「编辑」按钮，有「删除」按钮

---

### qi-edit-draft-only：编辑需求 — 仅 draft 状态可编辑

**目的**：验证非 `draft` 状态的需求不显示编辑入口，或编辑被禁用。

**Seed**：INSERT 1 条 `draft` 需求 + 1 条 `spec_review` 需求

**步骤**：
1. 找到 `draft` 行，点击「编辑」，修改标题为 `已编辑标题`，确定
2. 找到 `spec_review` 行，检查是否有「编辑」入口

**预期结果**：
- `draft` 行编辑成功，列表中标题更新为「已编辑标题」
- `spec_review` 行无「编辑」按钮，或编辑按钮不可点（disabled）

---

### qi-delete-draft-only：删除需求 — 仅 draft/queued 可删

**目的**：验证删除操作有二次确认，且仅对 `draft`/`queued` 状态需求可用。

**Seed**：INSERT 1 条 `draft` 需求 + 1 条 `developing` 需求

**步骤**：
1. 找到 `draft` 行，点击「删除」
2. 出现 Popconfirm 确认弹窗，点「确认删除」
3. 检查 `developing` 行是否存在「删除」按钮

**预期结果**：
- `draft` 行删除成功，列表行消失，Toast「已删除」出现
- `developing` 行无「删除」按钮（进行中的需求不可删）

---

### qi-run-button-draft-only：运行按钮仅 draft 状态可见

**目的**：验证「运行」按钮只在 `draft` 状态时出现，其他状态不展示。

**Seed**：INSERT `draft` / `spec_review` / `mr_open` / `failed` 各 1 条

**步骤**：
1. 访问 `/requirements`，观察各行操作列

**预期结果**：
- `draft` 行：「运行」按钮可见
- `spec_review` 行：无「运行」按钮
- `mr_open` 行：无「运行」按钮
- `failed` 行：无「运行」按钮（需手动重置为 draft 才能重跑）

---

### qi-run-enqueue：点击运行 — 需求进入队列

**目的**：验证点击「运行」后需求状态变为 `queued`，并显示等待提示。

**Seed**：INSERT 1 条 `draft` 需求

**步骤**：
1. 找到 `draft` 行，点击「运行」按钮

**预期结果**：
- `message.success` Toast 出现，含「已加入队列」或「worker 将在 30 秒内启动」
- 列表刷新，该行状态 Tag 变为「排队中」
- 「运行」按钮消失（状态已非 draft）
- 约 30 秒内状态进一步变为 `spec_review`（worker 启动流水线后）

---

### qi-spec-approval-ui：Spec 审批弹窗 — 字段与选项校验

**目的**：验证进入 `spec_review` 状态时，审批弹窗能正确打开，包含所有必要字段。

**Seed**：spec_review 阶段需求 + active waiter（见上方）

**步骤**：
1. 找到 `spec_review` 状态的需求行，点击「审批」按钮（或在详情抽屉中点击）
2. 审批弹窗打开

**预期结果**：
- 弹窗标题含「审批」或「Spec 审核」
- 「决策」下拉框存在，包含以下选项：
  - ✅ 通过
  - ❌ 拒绝（要求修改）
  - ⚡ 强制通过（跳过评审）
  - ⏳ 延期（追加预算）
  - 🛑 中止需求
- 选择「拒绝」后出现「拒绝原因」输入框
- 选择「延期」后出现「追加预算」数值输入框
- 选择「通过」时上述附加字段隐藏
- 「确定」按钮存在

---

### qi-spec-approve：Spec 审批通过 — 流水线恢复执行

**目的**：验证选择「通过」并提交后，审批记录更新，流水线恢复，需求进入下一阶段。

**Seed**：spec_review 需求 + active waiter（同上）

**步骤**：
1. 打开审批弹窗
2. 「决策」选择「✅ 通过」
3. 「决策人」填入 `qa-engineer`（可选）
4. 点击「确定」

**预期结果**：
- `message.success` Toast：「已决策，流水线已恢复」
- 弹窗关闭
- 列表刷新，需求状态从 `spec_review` 推进至 `planning`（或更后的阶段）
- 后端 `requirement_approval_waiters` 表中对应行 `claimed_by='web'`，`decision='approved'`

---

### qi-spec-reject-loop：Spec 审批拒绝 — Claude 重新生成

**目的**：验证选择「拒绝」并填写原因后，流水线不中止，Claude 根据修改意见重新生成 Spec，产生新一轮 waiter。

**Seed**：spec_review 需求 + active waiter（round=1）

**步骤**：
1. 打开审批弹窗，选「❌ 拒绝（要求修改）」
2. 「拒绝原因」填入 `验收标准不够清晰，请补充"取消勾选"的行为描述`
3. 点击「确定」

**预期结果**：
- Toast「已决策，流水线已恢复」
- 需求状态短暂回到类似生成中的状态（Claude 重新跑 spec-author）
- 约 1-3 分钟后，需求再次进入 `spec_review`，出现新的审批入口（round=2）
- `requirement_approval_waiters` 表中出现 round=2 的新 waiter，round=1 的 waiter `decision='rejected'`

---

### qi-final-approval：Final Approval — 最终确认 MR 前人工把关

**目的**：验证流水线到 `final_approval` 节点时，无 Spec 生成步骤（skill=null），直接进入审批等待，审批通过后触发 MR 创建。

**Seed**：
```sql
INSERT INTO requirements (id, title, raw_input, status, gitlab_project, base_branch, source, branch, worktree_path)
VALUES (101, '性能优化', '首屏加载优化到 2 秒', 'testing', 'PAM/devops/chatops', 'main', 'web', 'feat/qi-101', '/tmp/quick-impl/qi-101');

INSERT INTO requirement_approval_waiters
  (requirement_id, pipeline_run_id, node_id, approval_kind, round, decision_set, context_summary)
VALUES (101, 102, 'final_approval', 'escalation', 1, 'escalation', 'Branch: feat/qi-101 | E2E: pass (stub)');
```

**步骤**：
1. 找到 `testing` 状态的「性能优化」需求，打开审批弹窗
2. 审批弹窗的上下文摘要区域可见（含分支名和 E2E 结果）
3. 选「✅ 通过」，点「确定」

**预期结果**：
- Toast「已决策，流水线已恢复」
- 需求状态最终变为 `mr_open`
- 需求行出现 MR 链接（指向 GitLab MR）
- `requirement_approval_waiters` 中该 waiter `decision='approved'`

---

### qi-abort-during-pipeline：中止进行中的流水线

**目的**：验证在流水线执行过程中（非终态），可以通过「中止」决策终止流程，需求状态变为 `aborted`。

**Seed**：INSERT 1 条 `developing` 状态需求 + 任意一个 active waiter（模拟 dev 节点等待中）

**步骤**：
1. 找到 `developing` 需求，打开审批弹窗（或列表行的中止按钮）
2. 选「🛑 中止需求」
3. 点击「确定」

**预期结果**：
- Toast「已决策，流水线已恢复」或「已中止」
- 需求状态变为 `aborted`（或 `aborting` → `aborted`）
- 「运行」按钮不出现（aborted 状态需手动重置为 draft）
- `requirement_approval_waiters` 中对应 waiter `decision='aborted'`

---

### qi-detail-drawer-mr-link：详情抽屉 — Spec / Plan / MR 链接展示

**目的**：验证点击需求行打开详情抽屉，能展示 Spec 摘要、计划摘要和 MR 链接。

**Seed**：
```sql
INSERT INTO requirements
  (title, raw_input, status, gitlab_project, base_branch, source, branch,
   spec_content, plan_content, mr_url)
VALUES
  ('导出报表功能', '需求列表支持导出 CSV', 'mr_open', 'PAM/devops/chatops', 'main', 'web',
   'feat/qi-200',
   '# 需求规格：导出报表\n## 背景\n需求列表缺乏导出能力...',
   '# 实现计划\n## 任务列表\n1. 添加 Export 按钮...',
   'http://code.paraview.cn/PAM/devops/chatops/-/merge_requests/74');
```

**步骤**：
1. 点击「导出报表功能」需求行（或点击详情按钮），打开详情抽屉

**预期结果**：
- 抽屉标题含需求标题
- 「Spec」区域显示 spec_content 前几百字（markdown 渲染或纯文本）
- 「计划」区域显示 plan_content
- 「MR」区域显示可点击的 GitLab MR 链接，链接地址正确
- 状态 Tag 显示「MR 已开」

---

### qi-already-claimed：审批竞争 — 已被另一端抢先决策

**目的**：验证当 waiter 已被其他渠道（如 IM 端）决策后，Web 端再次提交时收到正确的冲突提示。

**Seed**：INSERT 1 条 spec_review 需求 + 1 条已 claimed（`claimed_by='im'`，`decision='approved'`）的 waiter

**步骤**：
1. 找到该需求的审批入口（此时 waiter 已被 claimed，但前端未刷新）
2. 尝试提交「通过」决策

**预期结果**：
- 后端返回 409 `{ error: 'already claimed', claimedBy: 'im' }`
- 前端显示 `message.warning`：「已被 im 端率先决策」（或类似文案）
- 弹窗不关闭（让用户知道操作未生效）
- 刷新后需求状态已推进（因为 IM 端已通过）
