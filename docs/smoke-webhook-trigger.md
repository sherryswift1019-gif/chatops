# Pipeline Webhook Trigger 冒烟手册

## 准备

1. 启动服务：`./deploy.sh up`（或 `pnpm dev`）
2. 确认管理后台可登录：`http://localhost:3000/admin`

## 步骤

### 1. 创建 Webhook

1. 进入任意一条已启用的 Pipeline 详情页
2. 点击工具栏「Webhook 触发器」按钮
3. 点「新建 Webhook」，填写名称（如 `ci`），点「创建」
4. **弹出 URL**，复制完整 URL（含 token），点「我已保存」

预期：列表出现一条记录，token 显示前 8 字符 + 省略号，触发次数为 0。

### 2. 触发 Pipeline

```bash
curl -X POST <上面复制的URL> \
  -H 'Content-Type: application/json' \
  -d '{"foo":"bar","commits":[{"id":"abc123"}]}'
```

预期响应：
```json
{ "runId": 123, "statusUrl": "/admin/api/test-runs/123", "triggeredAt": "..." }
```

### 3. 验证执行记录

1. 进入「执行历史」，看到新的 run，`triggered_by` 显示 `webhook:N:ci`
2. 点进 run 详情，查看 `trigger_params` 完整包含请求 payload

### 4. Rotate Token

1. 点 Webhook 列表里的 Rotate 按钮（刷新图标），确认
2. 弹出新 URL，复制，「我已保存」
3. 用**旧** URL 触发：预期 `401 invalid webhook token`
4. 用**新** URL 触发：预期 `202`

### 5. 禁用 Webhook

1. 将 Webhook 的 enabled 开关关闭
2. 用 URL 触发：预期 `401 invalid webhook token`（与不存在 token 响应相同，防探测）

### 6. 删除 Webhook

1. 点删除，确认
2. 用 URL 触发：预期 `401`
