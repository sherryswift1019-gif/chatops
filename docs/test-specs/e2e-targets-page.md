---
id: e2e-targets-page
title: 被测项目详情页
target_project: chatops
scenarios:
  - targets-page-loads
  - targets-page-edit-open
  - targets-repo-test-ok
  - targets-repo-test-fail
  - targets-save-changes
tags:
  - smoke
  - e2e-targets
---

# 被测项目详情页（/e2e-targets）

`E2eTargetsPage` — 展示 chatops 项目配置详情，支持编辑。

## 前置条件

- `chatops` 项目行已由 schema-v1000.sql 硬编码写入 `e2e_target_projects`
- 用户已登录 admin

## Seed 数据

无需额外写入，chatops 行已在 schema 中。

Mock GitLab server（4001）需要：

```
GET /api/v4/projects/group%2Fchatops → 200 （测试"测试"按钮成功路径）
GET /api/v4/projects/group%2Finvalid → 404 （测试"测试"按钮失败路径）
```

---

## 场景

### targets-page-loads：页面基本渲染

**目的**：验证 `/e2e-targets` 能正常加载并显示 chatops 项目的关键信息。

**步骤**：
1. 以 admin 身份登录
2. 访问 `/e2e-targets`
3. 等待 Spin 消失（最多 10s）

**预期结果**：
- 页面标题「被测项目详情」可见
- Descriptions 中 "项目 ID" 行显示 `chatops`（code 样式）
- "GitLab 仓库" 行有可见的链接文字
- "默认分支" 行有 Tag 显示 `main`
- "沙盒类型" 行有蓝色 Tag 显示 `docker-compose-local`
- "build" / "deploy" / "test" 三行均显示对应脚本路径（code 样式）
- 右上角有「编辑」按钮（EditOutlined 图标）

---

### targets-page-edit-open：点击编辑打开 Modal，字段预填充

**目的**：验证「编辑」按钮打开 Modal 且表单字段与当前项目值一致。

**步骤**：
1. 以 admin 身份登录，访问 `/e2e-targets`
2. 等待页面加载完成
3. 点击「编辑」按钮

**预期结果**：
- 标题为「编辑被测项目」的 Modal 打开
- "显示名称" Input 已填入 `chatops` 的 displayName
- "GitLab 仓库地址" Input 已填入当前 gitlabRepo 值
- "默认分支" Input 已填入 `main`
- "沙盒类型" Select 已选中 `Docker Compose（本地）`
- build / deploy / test 的 Input 已填入各自路径
- "fix" Input 为空（第一期 fix 可选）

---

### targets-repo-test-ok：测试按钮——GitLab 可达

**目的**：验证在编辑 Modal 中点击「测试」按钮，GitLab 仓库可达时显示成功提示。

**步骤**：
1. 打开编辑 Modal
2. 确保 "GitLab 仓库地址" 填的是 mock server 中有 `200` 响应的地址
3. 点击 Input 右侧的「测试」按钮（ApiOutlined 图标）
4. 等待按钮 loading 消失

**预期结果**：
- 显示 `type="success"` 的 Alert（绿色，CheckCircleOutlined 图标）
- Alert message 包含"成功"或"可访问"之类的正向文本

---

### targets-repo-test-fail：测试按钮——仓库不存在

**目的**：验证 GitLab 仓库返回 404 时，「测试」按钮显示错误提示。

**步骤**：
1. 打开编辑 Modal
2. 将 "GitLab 仓库地址" 改为一个 mock server 会 404 的地址（如 `group/invalid`）
3. 点击「测试」按钮
4. 等待 loading 消失

**预期结果**：
- 显示 `type="error"` 的 Alert（红色，CloseCircleOutlined 图标）
- Alert message 包含"失败"或"无法访问"之类的负向文本

---

### targets-save-changes：保存编辑后页面刷新显示新值

**目的**：验证修改显示名称后点击「确定」，页面详情自动更新。

**步骤**：
1. 打开编辑 Modal
2. 将 "显示名称" 改为 `ChatOps（E2E 测试）`
3. 点击 Modal「确定」按钮
4. 等待 Modal 关闭，message.success 出现

**预期结果**：
- Modal 关闭
- 详情页 Descriptions 中"显示名称"行更新为 `ChatOps（E2E 测试）`
- 页面无需手动刷新即可看到新值（`onSaved` 直接 setState）
