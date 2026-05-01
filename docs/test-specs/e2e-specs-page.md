---
id: e2e-specs-page
title: 测试规约管理页
target_project: chatops
scenarios:
  - specs-list-empty
  - specs-list-with-data
  - specs-status-badges
  - specs-trigger-generate
  - specs-skip-action
  - specs-pr-link-visible
tags:
  - smoke
  - e2e-specs
---

# 测试规约管理页（/e2e-specs）

`E2eSpecsPage` — 列出 chatops 项目下所有测试规约，显示生成状态，支持触发 Pipeline A。

## 前置条件

- chatops 项目行已在 `e2e_target_projects`
- 用户已登录 admin
- Mock GitLab server（4001）无需特殊配置（不涉及 GitLab 调用）

## Seed 数据（各场景差异说明）

| 场景 | 写什么 |
|---|---|
| specs-list-empty | 不写 `e2e_specs`，表为空 |
| specs-list-with-data / specs-status-badges | INSERT 多条不同 `generation_status` 的 spec 行 |
| specs-trigger-generate | INSERT 1 条 `pending` spec；mock `POST /admin/e2e-specs/:id/generate` → 202 |
| specs-skip-action | INSERT 1 条非 `skipped` spec；mock `POST /admin/e2e-specs/:id/skip` → 200 |
| specs-pr-link-visible | INSERT 1 条 `pr_open` spec，`generated_pr_url` 有值 |

---

## 场景

### specs-list-empty：无规约时显示空状态文字

**目的**：验证 `e2e_specs` 表为空时，Table 显示自定义的空状态提示，而不是通用"暂无数据"。

**步骤**：
1. 以 admin 身份登录
2. 不 seed 任何 spec 行
3. 访问 `/e2e-specs`
4. 等待 Table 加载完成

**预期结果**：
- Table 显示空状态文字，内容含「docs/test-specs/」目录提示
- 不显示任何数据行

---

### specs-list-with-data：有规约时正常渲染列表

**目的**：验证 Table 正确展示 spec 的规约路径、标题、状态、生成脚本路径列。

**Seed**：
```sql
INSERT INTO e2e_specs (target_project_id, spec_path, title, content_hash, generation_status)
VALUES
  ('chatops', 'docs/test-specs/login.md',    '登录流程',   'hash-a', 'committed'),
  ('chatops', 'docs/test-specs/pipeline.md', '流水线管理', 'hash-b', 'pending');
```

**步骤**：
1. Seed 后访问 `/e2e-specs`
2. 等待 Table 加载

**预期结果**：
- Table 有 2 行
- 第一行"规约路径"列显示 `docs/test-specs/login.md`（code 样式）
- 第一行"标题"列显示「登录流程」
- 第二行"操作"列有「生成」按钮（ThunderboltOutlined）
- 第一行（committed）"操作"列有「重生成」按钮

---

### specs-status-badges：各状态 Badge 颜色正确

**目的**：验证 7 种 `generation_status` 对应的 Tag 颜色和文案均正确。

**Seed**：为 7 种状态各插入 1 行。

| status | 期望 Tag 文案 | 期望颜色 |
|---|---|---|
| `pending` | 待生成 | default（灰） |
| `generating` | 生成中 | processing（蓝色动画） |
| `pr_open` | PR 已创建 | blue |
| `committed` | 已合入 | success（绿） |
| `baseline_failed` | Baseline 失败 | error（红） |
| `blocked_on_baseline_bug` | 产品 Bug 阻塞 | warning（橙） |
| `skipped` | 已跳过 | default |

**步骤**：
1. Seed 7 行，访问 `/e2e-specs`

**预期结果**：
- 7 行均可见，每行状态列 Tag 文案和颜色与上表对应
- `generating` 行的 Badge 有动画旋转（`status="processing"`）

---

### specs-trigger-generate：点击「生成」按钮触发 Pipeline A

**目的**：验证点击「生成」后按钮进入 loading 状态，API 被调用，列表自动刷新。

**Seed**：
```sql
INSERT INTO e2e_specs (target_project_id, spec_path, title, content_hash, generation_status)
VALUES ('chatops', 'docs/test-specs/login.md', '登录流程', 'hash-a', 'pending');
```

Mock API：`POST /admin/e2e-specs/1/generate → 202`，响应后 `GET /admin/e2e-specs?targetProjectId=chatops` 返回 status=`generating`。

**步骤**：
1. Seed + Mock 后访问 `/e2e-specs`
2. 找到「生成」按钮，点击

**预期结果**：
- 按钮变为 loading 旋转状态
- `POST /admin/e2e-specs/1/generate` 被调用一次
- `message.success` toast 出现，含「已触发生成」
- 列表刷新后状态 Tag 变为「生成中」

---

### specs-skip-action：点击「跳过」后该 spec 状态更新

**目的**：验证「跳过」按钮调用 skip API 后，spec 状态变为 `skipped`，操作列不再显示「跳过」按钮。

**Seed**：INSERT 1 条 `pending` spec。

Mock API：`POST /admin/e2e-specs/1/skip → 200`，之后 GET 返回 status=`skipped`。

**步骤**：
1. Seed + Mock 后访问 `/e2e-specs`
2. 找到「跳过」按钮（Tooltip 含「跳过 Stage 1」），点击

**预期结果**：
- skip API 被调用一次
- 列表刷新后该行状态变为「已跳过」
- 操作列不再显示「跳过」按钮（`spec.generationStatus === 'skipped'` 时不渲染）

---

### specs-pr-link-visible：pr_open 状态显示「查看 PR」链接

**目的**：验证 `generated_pr_url` 有值时，"PR" 列渲染为可点击的外链。

**Seed**：
```sql
INSERT INTO e2e_specs (target_project_id, spec_path, title, content_hash,
                       generation_status, generated_pr_url, generated_artifact_path)
VALUES ('chatops', 'docs/test-specs/login.md', '登录流程', 'hash-a',
        'pr_open', 'https://gitlab.example.com/mr/99', 'tests/e2e/login.spec.ts');
```

**步骤**：
1. Seed 后访问 `/e2e-specs`

**预期结果**：
- "PR" 列显示「查看 PR」链接，`href` 为 `https://gitlab.example.com/mr/99`，`target="_blank"`
- "生成的脚本" 列显示 `tests/e2e/login.spec.ts`（code 样式）
