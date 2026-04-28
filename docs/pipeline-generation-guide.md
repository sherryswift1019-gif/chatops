# 流水线批量生成指南

> **用途**：本文档用于批量自动生成 ChatOps 流水线 JSON，覆盖所有节点类型、字段约束、模板语法和校验规则。  
> **信息来源**：直接从源码提取（`src/pipeline/types.ts`、`src/pipeline/graph-builder.ts`、`src/pipeline/node-types/*.ts`、`src/pipeline/graph-validation.ts`、`src/db/repositories/test-pipelines.ts`），准确率 ≥ 99%。

---

## 一、流水线 DB 字段（TestPipeline）

调用 `POST /admin/test-pipelines` 创建时，Body 字段如下：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 流水线名称，唯一性建议（系统不强制但业务依赖） |
| `description` | string | — | 描述，默认 `''` |
| `enabled` | boolean | — | 默认 `true` |
| `productLineId` | number \| null | — | 绑定产品线 ID；`null` 表示全局流水线 |
| `graph` | PipelineGraph \| null | — | DAG 图定义（见第二节）；`null` 时运行时 fallback 到 `stages` 列 |
| `stages` | StageDefinition[] | — | 遗留线性阶段（画布模式下由 `graph` 替代，不建议直接写） |
| `variables` | Record\<string, string\> | — | 流水线级变量，供模板 `{{vars.xxx}}` 引用，默认 `{}` |
| `triggerParams` | Record\<string, unknown\> | — | 默认触发参数，IM 触发 / dry-run 时的预设值，默认 `{}` |
| `containerImage` | string \| null | — | 流水线级 Docker 镜像（`script` 节点无 `targetRoles` 时使用）；节点级 `containerImage` 优先级更高 |
| `artifactInputs` | ArtifactInput[] | — | 制品输入配置，默认 `[]` |
| `serverRoles` | Record\<string, {count: number}\> | — | SSH 服务器角色配置，默认 `{}`（`graph` 模式下由运行时自动按 role 分配） |

**更新** 用 `PUT /admin/test-pipelines/:id`，仅传需要修改的字段即可（其余保持不变）。  
**仅更新画布图** 用 `PUT /admin/test-pipelines/:id/graph`，Body 为 `{ "graph": <PipelineGraph> }`。

---

## 二、PipelineGraph 结构

```json
{
  "nodes": [ /* PipelineNode[] */ ],
  "edges": [ /* PipelineEdge[] */ ]
}
```

### 2.1 PipelineNode

每个节点继承 `StageDefinition` 的全部字段，额外增加：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | ✅ | **ULID**（26字符，如 `01HW3K...`），图内全局唯一 |
| `position` | `{ x: number, y: number }` | ✅ | 画布坐标，批量生成时可设任意值（如 `{x: 0, y: i*120}`） |

**所有节点公共字段（来自 StageDefinition）：**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `stageType` | string | ✅ | — | 节点类型，见第三节完整列表 |
| `name` | string | ✅ | — | 节点名称（用于日志、步骤引用 `steps.<name>`） |
| `targetRoles` | string[] | ✅ | `[]` | SSH 服务器角色列表；空数组 → 走 Docker 路径（仅 `script` 节点有意义） |
| `parallel` | boolean | ✅ | `false` | 遗留字段（多服务器并行），画布模式下通常为 `false` |
| `timeoutSeconds` | number | ✅ | `600` | 节点超时秒数（approval/im_input/wait_webhook 同样遵守） |
| `retryCount` | number | ✅ | `0` | 失败重试次数（executor 节点支持；interrupt 节点无效） |
| `onFailure` | `'stop'` \| `'continue'` | ✅ | `'stop'` | 失败策略：`stop` 中止后续节点，`continue` 继续执行 |

> ⚠️ `targetRoles`、`parallel`、`timeoutSeconds`、`retryCount`、`onFailure` 这 5 个字段即使无意义也必须在 JSON 中出现（运行时不做 undefined 兼容）。

### 2.2 PipelineEdge

```json
{
  "id": "01HW3K...",        // ULID，图内全局唯一
  "source": "<nodeId>",     // 来源节点 id
  "target": "<nodeId>",     // 目标节点 id
  "condition": { ... }      // 可选，见 2.3
}
```

**入口节点**：`edges` 中没有任何 `target` 指向的节点为入口（唯一入口，fallback 取 `nodes[0]`）。

**终止节点**：没有任何 `source` 出边的节点自动连接 END。

### 2.3 边条件（ConditionSpec）

不设 `condition` 时，边始终触发。三种形式：

```json
{ "kind": "onSuccess" }            // 前驱节点成功时走此边
{ "kind": "onFailure" }            // 前驱节点失败时走此边
{ "kind": "expression", "expression": "status == 'success' && steps.nodeA.output.count > 0" }
```

表达式上下文变量（见第五节）：
- `status` — 前驱节点状态（`'success'` / `'failed'` / `'skipped'`）
- `output` — 前驱节点 output 字符串
- `steps.<nodeId>.output.<key>` — 任意祖先节点的结构化输出

---

## 三、节点类型详细说明

### 3.1 `script` — Shell 脚本

```json
{
  "id": "01HW...", "name": "部署脚本", "stageType": "script",
  "targetRoles": ["web"],      // SSH 角色；空数组 → Docker 路径
  "containerImage": null,      // per-node Docker 镜像覆盖（优先于流水线级 containerImage）
  "script": "cd /app && ./deploy.sh {{vars.branch}}",
  "parallel": false, "timeoutSeconds": 300, "retryCount": 0, "onFailure": "stop",
  "position": { "x": 0, "y": 0 }
}
```

**执行路径选择（互斥）：**
1. `targetRoles` 非空 → SSH 到对应服务器执行
2. `targetRoles` 为空 + `containerImage` 非空 → 为本节点单独启动临时 Docker 容器
3. `targetRoles` 为空 + `containerImage` 为空 + 流水线级 `containerImage` 非空 → 共享 Docker 容器
4. 以上都无 → **节点失败**（`No executor configured`）

`script` 字段支持所有变量模板（见第四节）。

### 3.2 `approval` — 审批

```json
{
  "id": "01HW...", "name": "上线审批", "stageType": "approval",
  "approverIds": ["dingUserId1", "{{triggerParams.primaryOwnerId}}"],
  "approvalDescription": "请审批 {{triggerParams.env}} 环境部署",
  "approverIdsResolver": null,   // 指定后 approverIds/approvalDescription 静态字段被忽略
  "targetRoles": [], "parallel": false, "timeoutSeconds": 3600,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 120 }
}
```

- `approverIds` 必填（非空数组），支持 `{{triggerParams.xxx}}` 占位符
- `approverIdsResolver`：指定后**运行时**忽略 `approverIds` 静态字段，改用注册的 resolver 动态查询；但图校验（`PUT /graph` 端点）仍强制要求 `approverIds` 非空，因此使用 `approverIdsResolver` 时须在 `approverIds` 提供一个占位符（如 `["__resolver__"]`）
- 审批结果 → **通过**（`success`）/ **拒绝/超时**（`failed`）
- 校验：`approverIds` 为空数组时图校验报错（无论是否设置 `approverIdsResolver`）

### 3.3 `llm_agent` — AI Agent capability 调用

```json
{
  "id": "01HW...", "name": "代码审查", "stageType": "llm_agent",
  "capabilityKey": "code_review",
  "capabilityParams": { "mrUrl": "{{triggerParams.mrUrl}}" },
  "outputFormat": "json",        // 'json'（默认）或 'string'
  "targetRoles": [], "parallel": false, "timeoutSeconds": 600,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 240 }
}
```

- `capabilityKey` 必填，对应 `capabilities` 表的 `key`
- `outputFormat: 'json'` 时：Agent 必须输出 JSON 对象，否则节点失败；输出写入 `steps.<nodeId>.output.*`
- `outputFormat: 'string'` 时：输出原样写入 `steps.<nodeId>.output` 为字符串

### 3.4 `wait_webhook` — 等待外部 Webhook

```json
{
  "id": "01HW...", "name": "等待 CI", "stageType": "wait_webhook",
  "webhookTag": "ci_result",     // 必填，全局唯一 tag，对应 /webhook/:tag 路由
  "targetRoles": [], "parallel": false, "timeoutSeconds": 1800,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 360 }
}
```

- `webhookTag` 必填，非空字符串
- Webhook 到达时 payload 写入 `runtimeVars`（Object 展开；非 Object 写入 `__webhook_<tag>`）

### 3.5 `im_input` — IM 对话式参数采集

```json
{
  "id": "01HW...", "name": "采集部署参数", "stageType": "im_input",
  "imInputConfig": {
    "prompt": "请告知部署目标环境（dev/staging/prod）：",
    "paramSchema": {
      "type": "object",
      "properties": {
        "env": { "type": "string", "enum": ["dev", "staging", "prod"] }
      },
      "required": ["env"]
    },
    "timeoutSeconds": 300         // 可选，默认 600
  },
  "targetRoles": [], "parallel": false, "timeoutSeconds": 600,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 480 }
}
```

- `imInputConfig.prompt` 必填，非空字符串
- `imInputConfig.paramSchema` 必填，JSON Schema 对象
- 采集成功后参数写入 `runtimeVars`，下游节点通过 `{{vars.env}}` 引用
- 校验：`imInputConfig` 缺失或 `prompt` 为空时图校验报错

### 3.6 `sql_query` — 数据库查询（SELECT）

```json
{
  "id": "01HW...", "name": "查询用户", "stageType": "sql_query",
  "params": {
    "sqlTemplate": "SELECT id, name FROM users WHERE product_line_id = $1",
    "params": ["{{triggerParams.productLineId}}"]
  },
  "targetRoles": [], "parallel": false, "timeoutSeconds": 30,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 0 }
}
```

- `params.sqlTemplate` 必填，参数化 SQL（`$1, $2, ...`）
- `params.params` 可选，占位符值数组（支持模板字符串）
- 输出：`{ rows: [ {...}, ... ] }`，通过 `{{steps.<id>.output.rows[0].name}}` 引用

### 3.7 `http` — HTTP 请求

```json
{
  "id": "01HW...", "name": "调用 GitLab API", "stageType": "http",
  "params": {
    "method": "POST",
    "url": "https://gitlab.example.com/api/v4/projects/{{triggerParams.projectId}}/pipelines",
    "headers": { "PRIVATE-TOKEN": "{{vars.gitlabToken}}" },
    "body": { "ref": "{{triggerParams.branch}}" },
    "timeoutMs": 30000
  },
  "targetRoles": [], "parallel": false, "timeoutSeconds": 60,
  "retryCount": 1, "onFailure": "stop", "position": { "x": 0, "y": 0 }
}
```

- `params.url` 必填
- `params.method` 支持：`GET` / `POST` / `PUT` / `DELETE` / `PATCH`（默认 `GET`）
- `params.headers` 可选，key-value 对，值支持模板
- `params.body` 可选，Object 自动 `JSON.stringify`，字符串原样传递
- `params.timeoutMs` 可选，默认 30000ms
- 输出：`{ statusCode, headers, body }`（JSON 响应自动解析）；2xx → success，其余 → failed

### 3.8 `db_update` — 数据库写入（INSERT/UPDATE/DELETE）

```json
{
  "id": "01HW...", "name": "写入事件", "stageType": "db_update",
  "params": {
    "sqlTemplate": "INSERT INTO events (run_id, type) VALUES ($1, $2)",
    "params": ["{{run.id}}", "deploy_started"]
  },
  "targetRoles": [], "parallel": false, "timeoutSeconds": 30,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 0 }
}
```

- `params.sqlTemplate` 必填，参数化 SQL
- 输出：`{ rowsAffected: number }`

### 3.9 `dm` — 发送 IM 私信

```json
{
  "id": "01HW...", "name": "通知负责人", "stageType": "dm",
  "params": {
    "platform": "dingtalk",
    "userId": "{{triggerParams.ownerId}}",
    "text": "流水线 {{pipeline.name}} 执行完成，结果：{{steps.deploy.output.status}}"
  },
  "targetRoles": [], "parallel": false, "timeoutSeconds": 30,
  "retryCount": 0, "onFailure": "continue", "position": { "x": 0, "y": 0 }
}
```

- `params.platform` 必填：`'dingtalk'` 或 `'feishu'`
- `params.userId` 必填
- `params.text` 必填（v1 不支持卡片）
- 输出：`{ messageId, deliveredAt }`

### 3.10 `file_read` — 读取文件

```json
{
  "id": "01HW...", "name": "读取配置", "stageType": "file_read",
  "params": {
    "path": "/etc/app/config.json",
    "target": "local",          // 'local'（默认）或服务器 name（走 SSH cat）
    "maxBytes": 1048576         // 可选，默认 1MiB
  },
  "targetRoles": [], "parallel": false, "timeoutSeconds": 30,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 0 }
}
```

- `params.path` 必填
- 输出：`{ content: string, size: number, truncated?: true }`

### 3.11 `template_render` — 模板渲染

```json
{
  "id": "01HW...", "name": "生成消息", "stageType": "template_render",
  "params": {
    "template": "你好 {{vars.userName}}，MR #{{triggerParams.mrIid}} 已合并到 {{triggerParams.targetBranch}}",
    "vars": { "userName": "{{triggerParams.reviewerName}}" }   // 可选，局部覆盖 vars
  },
  "targetRoles": [], "parallel": false, "timeoutSeconds": 10,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 0 }
}
```

- `params.template` 必填，支持全套变量模板（见第四节）
- 输出：`{ text: string }`，通过 `{{steps.<id>.output.text}}` 引用

### 3.12 `fan_out` — 遍历数组并行执行

```json
{
  "id": "01HW...", "name": "批量通知", "stageType": "fan_out",
  "params": {
    "source": "{{steps.queryUsers.output.rows}}",  // 必填，模板解析后必须是数组
    "as": "user",                                   // 必填，scope 变量名
    "parallel": 3,                                  // 可选，并发数，默认 3，最少 1
    "onItemFailure": "continue",                    // 可选：'continue'（默认）/ 'stop' / 'aggregate'
    "body": [
      {
        "id": "notify",
        "nodeTypeKey": "dm",
        "params": {
          "platform": "dingtalk",
          "userId": "{{user.user_id}}",             // 通过 scope 引用 item 字段
          "text": "Hello {{user.name}}"
        }
      }
    ]
  },
  "targetRoles": [], "parallel": false, "timeoutSeconds": 300,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 0 }
}
```

**重要约束：**
- `params.source` 必填，模板解析后必须是数组
- `params.as` 必填，scope 变量名（`{{<as>.<field>}}`）
- `params.body` 必填，非空数组；每个 body 节点格式：`{ id, nodeTypeKey, params }`
- `body` 内**不允许**嵌套 `fan_out`
- `body` 内**不允许**出现 interrupt 类节点：`approval` / `llm_agent` / `im_input` / `wait_webhook`
- `body` 内支持的节点类型：`sql_query` / `http` / `db_update` / `dm` / `file_read` / `template_render`
- 输出：`{ items: [<每个子运行最后一个 body 节点的 output>], failed: [{index, item, error}] }`

### 3.13 `switch` — 条件路由

```json
{
  "id": "01HW...", "name": "环境路由", "stageType": "switch",
  "params": {
    "cases": [
      { "when": "triggerParams.env == 'prod'", "target": "nodeIdProd" },
      { "when": "triggerParams.env == 'staging'", "target": "nodeIdStaging" }
    ],
    "default": "nodeIdDev"    // 必填，所有 cases 不匹配时的目标节点 id
  },
  "targetRoles": [], "parallel": false, "timeoutSeconds": 10,
  "retryCount": 0, "onFailure": "stop", "position": { "x": 0, "y": 0 }
}
```

**约束：**
- `params.cases` 必填，非空数组；每项 `{ when: string, target: string }`
- `params.default` 必填，非空字符串，目标节点 id
- `when` 是表达式字符串（见第五节）
- `cases[i].target` 和 `default` 必须是图中已存在的节点 id，且不能指向自身
- **（关键）`cases[i].target` 和 `default` 所指向的每个目标节点必须有对应的出边（`source = switch节点id`，`target = 对应目标id`）**；若出边不存在，该目标不在运行时 routeMap 中，路由将静默落到 END 而非报错
- `switch` 节点的边**不需要**设置 `condition`；路由完全由 executor 输出的 `matchedTarget` 决定

---

## 四、变量模板语法

模板格式：`{{<路径>}}` 或 `{{<路径> | <过滤器>}}`

### 4.1 命名空间与优先级

| 优先级 | 命名空间 | 示例 | 说明 |
|---|---|---|---|
| 最高 | `<scopeName>.*` | `{{user.name}}` | `fan_out` body 内的 scope 变量 |
| 2 | `steps.<nodeId>.output.*` | `{{steps.queryUsers.output.rows[0].id}}` | 祖先节点输出（结构化） |
| 3 | `vars.*` | `{{vars.branch}}` | 流水线变量 + im_input/wait_webhook 采集值 |
| 最低 | `triggerParams.*` | `{{triggerParams.env}}` | 触发时传入的参数 |

**其他内置路径（不区分优先级，直接解析）：**

```
{{productLine.name}}        {{productLine.displayName}}
{{pipeline.id}}             {{pipeline.name}}
{{run.id}}                  {{run.triggeredBy}}        {{run.triggerType}}
{{stage.name}}              {{stage.index}}
{{server.host}}             {{server.port}}            {{server.username}}
{{server.name}}             {{server.role}}
```

### 4.2 JSONPath 子集

支持点记法和数组索引：

```
{{steps.q1.output.rows[0].userId}}
{{steps.http1.output.body.data.items[2].name}}
```

⚠️ **不支持** `array[*].field` glob 展开（v1 限制）。

### 4.3 过滤器

| 过滤器 | 说明 |
|---|---|
| `\| urlEncode` | URL 编码 |
| `\| jsonStringify` | JSON.stringify |
| `\| lower` | 转小写 |
| `\| upper` | 转大写 |

示例：`{{triggerParams.branch | urlEncode}}`

### 4.4 未解析占位符

路径解析失败（key 不存在）时，模板字符串**保留原字面值**（不清空为空字符串），方便排查。

---

## 五、表达式语言（边条件 / switch.when）

用于：
- `PipelineEdge.condition.expression`
- `switch` 节点 `params.cases[i].when`

### 5.1 语法

```
表达式 ::= 布尔表达式
布尔表达式 ::= 比较表达式 (('&&' | '||') 比较表达式)*
比较表达式 ::= primary (op primary)?
op ::= '==' | '!=' | '<' | '<=' | '>' | '>=' | 'contains'
primary ::= '(' 布尔表达式 ')' | 字面量 | 路径
字面量 ::= '单引号字符串' | 数字 | true | false
路径 ::= 标识符 ('.' 标识符)*
```

### 5.2 上下文变量（边条件）

表达式在边条件中的可用变量：

| 路径 | 说明 |
|---|---|
| `status` | 前驱节点状态：`'success'` / `'failed'` / `'skipped'` |
| `output` | 前驱节点 output（字符串） |
| `steps.<nodeId>.output.<key>` | 任意祖先节点结构化输出 |
| `vars.<key>` | 运行时变量 |
| `triggerParams.<key>` | 触发参数 |

### 5.3 switch.when 上下文

```
steps.<nodeId>.output.<key>    triggerParams.<key>    vars.<key>
```

### 5.4 示例

```
status == 'success'
status == 'failed' && output contains 'timeout'
steps.queryUsers.output.count > 0
triggerParams.env == 'prod'
```

---

## 六、图校验规则

调用 `PUT /admin/test-pipelines/:id/graph` 时自动校验，以下情形报错：

| 规则 | 说明 |
|---|---|
| 节点 id 唯一 | 图内不能有重复 id |
| 边引用合法 | `edge.source` / `edge.target` 必须指向已存在节点 |
| 无环 | DFS 三色标记检测，有环报错 |
| 表达式语法 | `edge.condition.expression` 和 `switch.cases[i].when` 预解析，语法错报错 |
| 跨节点步骤引用 | `{{steps.<id>.output.*}}` 中的 id 必须是当前节点的**祖先**节点 id |
| `llm_agent` | `capabilityKey` 必填 |
| `wait_webhook` | `webhookTag` 必填 |
| `im_input` | `imInputConfig.prompt` 必填、`paramSchema` 必须是 object |
| `approval` | `approverIds` 必须是非空数组 |
| `fan_out` | `params.body` 必须是非空数组 |
| `switch` | `params.cases` 非空数组、`params.default` 非空字符串；target/default 引用的节点必须存在且不自环 |
| `outputFormat` | 只允许 `'string'` 或 `'json'`，不允许其他值 |

---

## 七、完整示例

### 7.1 线性流水线（三节点：采集参数 → 执行脚本 → 通知）

```json
{
  "name": "部署流水线示例",
  "description": "IM 采集环境参数后执行部署脚本，完成后通知",
  "enabled": true,
  "triggerParams": { "env": null, "branch": "main" },
  "variables": { "appName": "myapp" },
  "graph": {
    "nodes": [
      {
        "id": "01HWAAAA0000000000000001",
        "name": "采集环境",
        "stageType": "im_input",
        "imInputConfig": {
          "prompt": "请输入部署环境（dev/staging/prod）和分支：",
          "paramSchema": {
            "type": "object",
            "properties": {
              "env": { "type": "string", "enum": ["dev", "staging", "prod"] },
              "branch": { "type": "string" }
            },
            "required": ["env", "branch"]
          },
          "timeoutSeconds": 300
        },
        "targetRoles": [], "parallel": false,
        "timeoutSeconds": 360, "retryCount": 0, "onFailure": "stop",
        "position": { "x": 0, "y": 0 }
      },
      {
        "id": "01HWAAAA0000000000000002",
        "name": "执行部署",
        "stageType": "script",
        "script": "cd /app && git checkout {{vars.branch}} && ./deploy.sh {{vars.env}}",
        "containerImage": null,
        "targetRoles": ["web"],
        "parallel": false, "timeoutSeconds": 600, "retryCount": 0, "onFailure": "stop",
        "position": { "x": 0, "y": 120 }
      },
      {
        "id": "01HWAAAA0000000000000003",
        "name": "通知负责人",
        "stageType": "dm",
        "params": {
          "platform": "dingtalk",
          "userId": "{{triggerParams.ownerId}}",
          "text": "{{vars.appName}} 已部署到 {{vars.env}} (分支: {{vars.branch}})"
        },
        "targetRoles": [], "parallel": false,
        "timeoutSeconds": 30, "retryCount": 0, "onFailure": "continue",
        "position": { "x": 0, "y": 240 }
      }
    ],
    "edges": [
      { "id": "01HWEDGE000000000000001", "source": "01HWAAAA0000000000000001", "target": "01HWAAAA0000000000000002" },
      { "id": "01HWEDGE000000000000002", "source": "01HWAAAA0000000000000002", "target": "01HWAAAA0000000000000003", "condition": { "kind": "onSuccess" } }
    ]
  }
}
```

### 7.2 分支流水线（switch 路由到不同节点）

```json
{
  "graph": {
    "nodes": [
      {
        "id": "01HWBBBB0000000000000001", "name": "环境路由", "stageType": "switch",
        "params": {
          "cases": [
            { "when": "triggerParams.env == 'prod'", "target": "01HWBBBB0000000000000003" }
          ],
          "default": "01HWBBBB0000000000000002"
        },
        "targetRoles": [], "parallel": false,
        "timeoutSeconds": 10, "retryCount": 0, "onFailure": "stop",
        "position": { "x": 0, "y": 0 }
      },
      {
        "id": "01HWBBBB0000000000000002", "name": "非生产部署", "stageType": "script",
        "script": "./deploy-nonprod.sh {{triggerParams.env}}",
        "containerImage": null, "targetRoles": ["web"],
        "parallel": false, "timeoutSeconds": 300, "retryCount": 0, "onFailure": "stop",
        "position": { "x": -200, "y": 120 }
      },
      {
        "id": "01HWBBBB0000000000000003", "name": "生产审批", "stageType": "approval",
        "approverIds": ["{{triggerParams.ownerId}}"],
        "approvalDescription": "确认部署 {{triggerParams.branch}} 到生产环境",
        "targetRoles": [], "parallel": false,
        "timeoutSeconds": 7200, "retryCount": 0, "onFailure": "stop",
        "position": { "x": 200, "y": 120 }
      }
    ],
    "edges": [
      { "id": "01HWEDGE000000000000010", "source": "01HWBBBB0000000000000001", "target": "01HWBBBB0000000000000002" },
      { "id": "01HWEDGE000000000000011", "source": "01HWBBBB0000000000000001", "target": "01HWBBBB0000000000000003" }
    ]
  }
}
```

> ⚠️ switch 路由由 `matchedTarget`（即 `params.cases[i].target` 或 `params.default`）决定，边的 `condition` 不需要设置。但**每个 target 节点都必须有一条从 switch 节点出发的出边**，否则运行时 `routeMap` 不含该节点，路由静默落 END（图校验不检查此项，是运行时陷阱）。本例两条边分别对应 `default` 和 `cases[0].target`，均已覆盖。

---

## 八、API 快速参考

```
GET    /admin/test-pipelines                    # 列表（?product_line_id=N 过滤）
GET    /admin/test-pipelines/:id                # 单条
POST   /admin/test-pipelines                    # 创建（Body: TestPipeline 字段）
PUT    /admin/test-pipelines/:id                # 更新（Body: 部分字段）
DELETE /admin/test-pipelines/:id                # 删除

GET    /admin/test-pipelines/:id/graph          # 获取图（null 时自动线性化 stages）
PUT    /admin/test-pipelines/:id/graph          # 更新图（Body: { graph: PipelineGraph }）
                                                # 自动执行图校验，失败返回 400 + errors

POST   /admin/test-runs                         # 触发运行（Body: { pipelineId, servers?, triggerType? }）
```

---

## 九、批量生成注意事项

1. **节点 id 必须使用 ULID**（26 字符，按时间单调递增）。批量生成时可用固定前缀 + 序号伪造，或调用 `ulidx` 库生成。
2. **`position` 建议设合理坐标**：横向分支用 x 偏移，纵向链式用 y 偏移（步长 120-160px）。
3. **`graph` 与 `stages` 的关系**：现有系统画布模式只读写 `graph`，`stages` 列可传空数组 `[]`；运行时优先使用 `graph`，`graph=null` 时 fallback 读 `stages`。
4. **`switch` 节点必须为每个可能的目标加一条出边**：`params.cases[i].target` 和 `params.default` 各对应一条 `{ source: switchId, target: targetId }` 边；若出边缺失，路由静默落 END。边的 `condition` 字段可留空（switch 路由不依赖 condition）。
5. **`fan_out body` 节点的 id**：body 内的节点 id 仅在子运行内有意义，可以是简单字符串（`"dm1"`），无需 ULID。
6. **变量引用的 `nodeId` 是画布节点的 `id` 字段**，不是 `name`；确保 `steps.<id>.output.*` 中的 id 与节点 id 完全一致。
7. **`onFailure: 'stop'` 是默认值**，只要下游节点不需要在失败后继续，不必特意指定 `'continue'`。
8. **审批 timeout 建议 ≥ 3600**（1小时），生产场景建议 7200~86400。
9. **`im_input` timeoutSeconds**（采集超时）与 StageDefinition 的 `timeoutSeconds`（节点超时）独立，前者在 `imInputConfig` 内，后者在节点顶层——两者均需设置，建议 `imInputConfig.timeoutSeconds` ≤ 节点 `timeoutSeconds`。
10. **`http` body 是 Object 时自动添加 `Content-Type: application/json`**，无需手动指定。
11. **`approval + approverIdsResolver`**：使用动态 resolver 时，`approverIds` 字段仍需提供一个非空占位符数组（如 `["__resolver__"]`）才能通过 `PUT /graph` 端点的图校验；运行时 `approverIdsResolver` 会覆盖此静态值。
