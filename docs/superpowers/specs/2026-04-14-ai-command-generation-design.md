# AI 辅助命令生成设计

## 1. 背景与动机

流水线阶段配置中，涉及远程执行的能力（env_cleanup、env_init、deploy、rollback、restart、custom_script）都有一个 `commands` textarea 让用户编写 shell 命令。但手写 shell 命令门槛较高，用户可能不熟悉具体的命令语法。

### 目标

在 commands textarea 旁提供"AI 生成"按钮，用户输入自然语言意图描述，Claude API 当场生成 shell 命令，用户预览确认后填入。

## 2. 交互流程

```
commands textarea 旁显示「AI 生成」按钮
    ↓ 点击
弹窗：输入意图描述（如"停止 app 服务，清理日志和临时文件"）
    ↓ 提交
弹窗显示：加载中...
    ↓ Claude API 返回
弹窗显示：生成的命令预览（monospace，可编辑）
    ↓ 用户点「确认填入」
命令覆盖写入 textarea
```

## 3. 后端 API

### `POST /admin/ai/generate-commands`

**请求体：**
```json
{
  "intent": "停止 app-server 服务，清理 /opt/app 下的日志和临时文件",
  "capabilityKey": "env_cleanup",
  "capabilityName": "环境清理",
  "targetRoles": ["app", "db"]
}
```

**响应体：**
```json
{
  "commands": "systemctl stop app-server\nrm -rf /opt/app/logs/*\nrm -rf /opt/app/tmp/*"
}
```

**实现：**
- 直接调用 Anthropic API（`@anthropic-ai/sdk`），不走 Porygon（单轮生成，不需要 agent 能力）
- 使用 `claude-haiku` 模型（快速、低成本，命令生成不需要强推理）
- System prompt：

```
你是一个 Linux 运维专家。根据以下上下文，生成对应的 shell 命令。
- 每行一条命令
- 只输出可执行的 shell 命令，不要解释、不要注释、不要 markdown 格式
- 命令应该安全、幂等，适合自动化执行
```

- User message：

```
能力类型: {{capabilityName}}
目标服务器角色: {{targetRoles.join(', ')}}
用户意图: {{intent}}
```

- 项目已有 `@anthropic-ai/sdk` 依赖（用于 Porygon），无需新增依赖
- API key 从 `process.env.ANTHROPIC_API_KEY` 读取（已有）

## 4. 前端组件

### 修改 `StageParamsForm.tsx`

当渲染 `format === 'textarea'` 字段时，在 TextArea 右上角添加「AI 生成」按钮。

按钮仅在 textarea 字段上显示（非所有 textarea——只有 `commands` 类型的才需要，通过 JSON Schema 中添加 `x-ai-assist: true` 扩展标识）。

### 新建 `AiCommandModal.tsx`

弹窗组件，包含：
- 意图输入框（Input.TextArea，2-3 行）
- "生成"按钮（调用后端 API）
- 生成结果预览区（Input.TextArea，monospace，可编辑）
- "确认填入"按钮（回调写入 form）
- loading 状态

Props：
```typescript
{
  open: boolean
  capabilityKey: string
  capabilityName: string
  targetRoles: string[]
  onConfirm: (commands: string) => void
  onCancel: () => void
}
```

## 5. 数据模型变更

### JSON Schema 扩展

在需要 AI 辅助的 textarea 字段的 param_schema 中添加 `x-ai-assist: true`：

```json
{
  "commands": {
    "type": "string",
    "format": "textarea",
    "title": "执行命令",
    "x-ai-assist": true
  }
}
```

需要更新 schema-v4.sql 中以下能力的 param_schema（给 commands 字段加 `x-ai-assist`）：
- env_init、env_cleanup、deploy、rollback、restart、custom_script

## 6. 关于"意图模式"

不需要专门的 UI 支持。由于 Claude 是流水线执行引擎，用户可以直接在 commands 里写自然语言意图（如"清理旧版本文件"），Claude 执行时会自动理解并转为实际命令。这是架构的天然能力，不需要额外开发。

## 7. 影响范围

**后端：**
- 新建 `src/admin/routes/ai.ts` — AI 辅助 API
- 修改 `src/admin/index.ts` — 注册路由
- 修改 `src/db/schema-v4.sql` — 给 commands 字段加 `x-ai-assist`

**前端：**
- 新建 `web/src/components/AiCommandModal.tsx` — AI 生成弹窗
- 修改 `web/src/components/StageParamsForm.tsx` — textarea 旁加按钮
- 新建 `web/src/api/ai.ts` — AI API 客户端

## 8. 验证方式

1. 打开流水线管理 → 新增流水线 → 添加"环境清理"阶段
2. 在"执行命令"textarea 旁看到「AI 生成」按钮
3. 点击弹出意图输入框，输入"停止 nginx 服务并清理缓存"
4. 点生成，等待 1-2 秒，预览区显示生成的 shell 命令
5. 可在预览区编辑命令
6. 点"确认填入"，命令写入 textarea
7. 切换到"部署服务"能力，验证"执行命令"字段同样有 AI 生成按钮
8. 没有 `x-ai-assist` 标记的 textarea 字段（如 silentConfig）不显示按钮
