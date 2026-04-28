# PAM Proxy 部署流水线设计

**日期**：2026-04-28  
**状态**：已确认，待实现

---

## 概述

本次交付三个并行目标：

1. **通用自定义 Agent 节点**：`llm_agent` 节点新增 `custom` 模式，允许在画布上直接配置 system prompt 和工具白名单，无需预先创建 capability
2. **`diagnose_and_repair` Capability**：通用 LLM 修复能力，可独立 IM 调用，也可作为流水线 `llm_agent` 节点的 capabilityKey
3. **PAM Proxy 部署流水线**：8 节点 DAG，IM 参数采集 → 清理 → 分析安装包 → 下载解压 → 安装 → LLM 修复（失败时）→ 通知成功/通知失败

---

## 交付物 1：通用自定义 Agent 节点

### 类型定义扩展（`src/pipeline/types.ts`）

在 `StageDefinition` 新增：

```typescript
agentMode?: 'capability' | 'custom'  // 默认 'capability'，向后兼容
customPrompt?: string                  // agentMode='custom' 时必填
allowedTools?: string[]               // 可用 MCP 工具白名单，如 ['fetch_url', 'ssh_exec']
// outputFormat 已有，json 时将 Claude 输出解析为对象供下游 steps 引用
```

### 后端执行路径（`src/pipeline/graph-builder.ts`）

`buildCapabilityNode` 中新增分支：

- `agentMode === 'capability'`（或字段缺失）：走现有 `triggerCapability(capabilityKey)` 路径，零改动
- `agentMode === 'custom'`：新路径，用 `customPrompt` + `allowedTools` 直接启动 Claude runner，不经过 capability 系统；执行结果同样写入 `stepOutputs`

### 新增 MCP 工具：`fetch_url`

- 位置：`src/agent/tools/fetch-url.ts`
- 功能：简单 HTTP GET，返回 `{statusCode, body}`
- 仅在 `allowedTools` 包含 `"fetch_url"` 时对该节点可见
- 不暴露给普通 IM 对话的 Claude 会话

### 前端 NodeInspector（`web/src/pipeline-canvas/panels/NodeInspector.tsx`）

`llm_agent` 节点新增模式切换 Radio：

- **已有能力**（默认）：显示现有 `capabilityKey` Select 下拉
- **自定义**：
  - TextArea：系统提示词（`customPrompt`）
  - MultiSelect：可用工具（`allowedTools`），选项从后端 `/admin/pipeline/available-tools` 获取
  - Select：输出格式（`outputFormat`：string / json）

### 画布验证（`src/pipeline/graph-validation.ts`）

- `agentMode === 'capability'` 时：`capabilityKey` 必填（现有逻辑不变）
- `agentMode === 'custom'` 时：`customPrompt` 必填，`capabilityKey` 可为空

---

## 交付物 2：`diagnose_and_repair` Capability

### DB 记录（新迁移 schema-vN.sql）

```sql
INSERT INTO capabilities (key, name, description, enabled)
VALUES (
  'diagnose_and_repair',
  '诊断并修复',
  '分析失败步骤的日志，通过 SSH 施以修复并重试，最多 N 次（默认 4）',
  true
);
```

### System Prompt

```
你是一个 DevOps 故障修复专家。你的任务是分析一个失败操作的日志，找出根因，施以修复，然后重试。

输入上下文（通过 triggerParams 传入）：
- failedCommand: 失败的命令
- stdout: 命令的标准输出
- stderr: 命令的错误输出  
- serverHost: 目标服务器 host
- maxRetries: 最大重试次数（默认 4）

执行步骤：
1. 分析 stdout/stderr，判断失败原因
2. 通过 SSH 工具连入 serverHost 施以修复（清理残留文件、停止冲突进程、修复依赖等）
3. 重新运行 failedCommand，检查退出码
4. 若仍失败，分析新日志，继续修复，直到成功或达到 maxRetries 次
5. 最终返回 JSON：{"success": true/false, "attempts": N, "summary": "修复摘要"}

约束：
- 每次修复操作后必须重新运行命令验证效果
- 不要修改与本次失败无关的系统配置
- 达到 maxRetries 仍失败时，在 summary 中详细描述已尝试的修复步骤
```

### 独立 IM 使用

注册为普通 capability 后，用户可在 IM 群里直接触发：
> 「帮我看看 192.168.1.10 上的 PAM 安装为什么失败」

Claude 通过 im_input 式对话采集必要上下文（failedCommand、日志片段、serverHost）后执行。

---

## 交付物 3：PAM Proxy 部署流水线

### 流水线元数据

- **名称**：PAM Proxy部署
- **触发方式**：IM 触发（绑定 capability 或 IM trigger）
- **产线**：运维产线（需在管理后台手动选择）

### 节点图（8 节点）

```
[1 IM参数采集] → [2 清理旧部署] → [3 分析选择安装包] → [4 下载并解压] → [5 执行安装]
                                                                           ↓成功        ↓失败
                                                                     [7 通知成功] ← [6 诊断修复] → [8 通知失败]
```

> **运行时说明**：`{{steps.X.output.Y}}` 中的 X 为节点的 ULID（在画布创建节点时自动分配）。下方节点详情中的 `steps.analyzePackage`、`steps.install`、`steps.repair` 为示意名称，实现时需替换为实际 ULID。

### 节点详情

**节点 1 — IM 参数采集**（`im_input`）
```json
{
  "stageType": "im_input",
  "name": "IM 参数采集",
  "imInputConfig": {
    "prompt": "请提供 PAM Proxy 部署信息：\n- branch（分支名，如 main）\n- env（环境，如 staging / prod）\n- pam_address（PAM 服务地址，如 192.168.1.100:8080）",
    "paramSchema": {
      "type": "object",
      "required": ["branch", "env", "pam_address"],
      "properties": {
        "branch":      {"type": "string", "title": "分支"},
        "env":         {"type": "string", "title": "环境", "enum": ["staging", "prod"]},
        "pam_address": {"type": "string", "title": "PAM_ADDRESS"}
      }
    },
    "timeoutSeconds": 600
  }
}
```

**节点 2 — 清理旧部署**（`script`，role=proxy）
```json
{
  "stageType": "script",
  "name": "清理旧部署",
  "targetRoles": ["proxy"],
  "onFailure": "stop",
  "script": "# TODO: 清理脚本待提供\necho '清理完成（placeholder）'"
}
```

**节点 3 — 分析选择安装包**（`llm_agent`，自定义模式）
```json
{
  "stageType": "llm_agent",
  "name": "分析选择安装包",
  "agentMode": "custom",
  "allowedTools": ["fetch_url"],
  "outputFormat": "json",
  "onFailure": "stop",
  "customPrompt": "请访问以下 URL 获取安装包文件列表：\nhttp://10.10.2.234:8000/pam/deploy/Proxy-Deploy/{{triggerParams.branch}}?json=true\n\n从返回的 files 数组中，找出 mtime 最大的、文件名不以 .sha256 结尾的文件。\n\n只返回以下 JSON，不要任何其他内容：\n{\"filename\": \"<文件名>\", \"downloadUrl\": \"http://10.10.2.234:8000/pam/deploy/Proxy-Deploy/{{triggerParams.branch}}/<文件名>\"}"
}
```

**节点 4 — 下载并解压**（`script`，role=proxy）
```json
{
  "stageType": "script",
  "name": "下载并解压",
  "targetRoles": ["proxy"],
  "onFailure": "stop",
  "script": "curl -fSL \"{{steps.analyzePackage.output.downloadUrl}}\" -o /tmp/pam-proxy-deploy.tar.gz\nmkdir -p /tmp/pam-proxy-deploy\ntar -xzf /tmp/pam-proxy-deploy.tar.gz -C /tmp/pam-proxy-deploy --strip-components=1"
}
```

**节点 5 — 执行安装**（`script`，role=proxy）
```json
{
  "stageType": "script",
  "name": "执行安装",
  "targetRoles": ["proxy"],
  "onFailure": "continue",
  "script": "cd /tmp/pam-proxy-deploy\nPAM_ADDRESS={{triggerParams.pam_address}} ./install.sh"
}
```

**节点 6 — 诊断修复**（`llm_agent`，capability 模式，仅节点 5 失败时触发）
```json
{
  "stageType": "llm_agent",
  "name": "诊断修复",
  "agentMode": "capability",
  "capabilityKey": "diagnose_and_repair",
  "onFailure": "continue",
  "params": {
    "failedCommand": "PAM_ADDRESS={{triggerParams.pam_address}} ./install.sh",
    "stdout": "{{steps.install.output.stdout}}",
    "stderr": "{{steps.install.output.stderr}}",
    "serverHost": "{{server.host}}",
    "maxRetries": 4
  }
}
```

**节点 7 — 通知成功**（`dm`）
```json
{
  "stageType": "dm",
  "name": "通知成功",
  "params": {
    "platform": "{{triggerParams.imPlatform}}",
    "userId": "{{triggerParams.imUserId}}",
    "text": "✅ PAM Proxy 部署成功 | 分支: {{triggerParams.branch}} | 环境: {{triggerParams.env}} | 地址: {{triggerParams.pam_address}}"
  }
}
```

**节点 8 — 通知失败**（`dm`）
```json
{
  "stageType": "dm",
  "name": "通知失败",
  "params": {
    "platform": "{{triggerParams.imPlatform}}",
    "userId": "{{triggerParams.imUserId}}",
    "text": "❌ PAM Proxy 部署失败，已重试 4 次，请人工介入 | 分支: {{triggerParams.branch}} | 环境: {{triggerParams.env}}"
  }
}
```

### 条件边（8 个节点）

| 源节点 | 目标节点 | 条件 |
|--------|----------|------|
| 节点 5 | 节点 7 | `onSuccess` |
| 节点 5 | 节点 6 | `onFailure` |
| 节点 6 | 节点 7 | `onSuccess` |
| 节点 6 | 节点 8 | `onFailure` |

---

## 变量约定

| 变量 | 来源 | 说明 |
|------|------|------|
| `triggerParams.branch` | im_input 节点 1 | 分支名 |
| `triggerParams.env` | im_input 节点 1 | 环境名 |
| `triggerParams.pam_address` | im_input 节点 1 | PAM 服务地址 |
| `triggerParams.imPlatform` | IM 触发时系统注入 | dingtalk / feishu |
| `triggerParams.imUserId` | IM 触发时系统注入 | 触发用户 ID |
| `steps.analyzePackage.output.downloadUrl` | 节点 3 输出 | 安装包下载 URL |
| `steps.install.output.stdout` | 节点 5 输出 | 安装日志 |
| `steps.install.output.stderr` | 节点 5 输出 | 安装错误 |

---

## 待解决项

- 清理脚本内容（节点 2）：用户后续提供，当前为 placeholder
- `fetch_url` MCP 工具需新增（简单 HTTP GET wrapper）
- `diagnose_and_repair` capability 的 schema-vN 版本号需在实现时按当前最大版本号 +1 确定
- `triggerParams.imPlatform` / `triggerParams.imUserId` 的注入需验证：当前代码在 `StageContext` 里有 `triggerPlatform/triggerUserId`，但 `dm` 节点从 `triggerParams` 读取——需在 graph-runner/graph-builder 中确认这两个 key 是否已注入 `triggerParams`，否则需补充注入逻辑
- 节点 ULID：画布创建流水线后，`steps.analyzePackage.output.downloadUrl`、`steps.install.output.stdout` 等引用中的节点名需替换为实际 ULID

---

## 不在范围内

- 审批节点（后续单独补充审批规则能力）
- 群消息通知（当前 `dm` 节点仅支持私信，群通知能力待后续扩展）
- 多 proxy 节点并行部署
