# 流水线制品输入选择 设计文档

**日期**：2026-04-18
**状态**：待实现

## 1 · 背景

目前流水线在群聊中被触发后，所有使用的资源（包名、URL 等）只能依赖：
- 静态写死在脚本里
- 或 pipeline 的静态 `variables`

这满足不了"部署 dev 分支最新安装包"之类的需求——dev 包的文件名/URL 每天都在变。

派拉内部有个文件服务器 `http://10.10.2.234:8000/pam/deploy`，支持 `?json=true` 列出目录下所有文件（含 `name / path / size / mtime / type`）。我们需要：

- 在 pipeline 配置中声明"这条流水线运行前需要选择哪些制品包"
- 人工/群聊触发时，Agent 自动拉列表、过滤、让用户文字选择
- 定时/API 触发时，走预配置的默认值或"最新"策略自动解析
- 无论哪条路径，选中值最终作为 runtime 变量注入 `{{vars.X}}`，供 stage 脚本使用

## 2 · 设计目标

- 不引入独立的"制品仓库"表或管理后台，配置内联在 pipeline 里
- 触发时人工和定时两条路径用**同一个 resolver**，避免行为分裂
- 变量注入走已有的 `{{vars.X}}` 通道，不改脚本模板语法
- 为未来扩展其它仓库类型（nexus / s3 / ...）留出接口点，但首版只实现 gohttpserver

## 3 · 数据模型

### 3.1 ArtifactInput 结构

```ts
interface ArtifactInput {
  name: string                  // 用户可见名称，如 "选择 PAM Docker 包"
  listUrl: string               // 列表接口基址，如 'http://10.10.2.234:8000/pam/deploy'
  glob: string                  // 过滤模式，如 'PAM-Docker-develop*.tar.gz'
  outputVar: string             // 选中后写入的 runtime var 名，如 'PACKAGE_URL'
  valueFrom: 'url' | 'name' | 'path'   // 默认 'url'——写入完整可下载 URL

  // —— 定时/API 触发兜底（至少二选一，否则定时必失败）——
  default?: string                                    // 字面值默认
  defaultStrategy?: 'latest-by-mtime' | 'first-match' // 规则策略

  authHeaders?: Record<string, string> // 可选鉴权，预留
}

interface TestPipeline {
  // ...既有字段...
  stages: StageDefinition[]           // 执行阶段，不再因本设计新增类型
  variables: Record<string, string>   // 既有的静态 vars
  artifactInputs: ArtifactInput[]     // 新增：触发前置条件
}
```

### 3.2 数据库迁移（`src/db/schema-v10.sql`）

> v8 / v9 已占用，本设计用 v10。

```sql
ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS artifact_inputs JSONB NOT NULL DEFAULT '[]';

ALTER TABLE test_runs
  ADD COLUMN IF NOT EXISTS runtime_vars JSONB NOT NULL DEFAULT '{}';
```

`artifact_inputs` 是 pipeline 上的声明；`runtime_vars` 记录每次 run 实际注入的运行时变量值，便于审计和失败复盘。

## 4 · 变量解析

### 4.1 触发时解析优先级

对每个 `artifactInputs[i]` 按以下顺序挑值：

1. `runtimeVars[outputVar]` 已传 → 直接用
2. `default` 字面值存在 → 直接用
3. `defaultStrategy` 存在 → 实时拉 `listUrl?json=true`，过滤 glob，按策略挑一个文件，按 `valueFrom` 取值
4. `triggerType == 'manual'` → 400 拒绝（错误提示引导走 Agent 对话流程）
5. 其它（scheduled / api）→ 400 拒绝，`test_runs.error` 写明缺失哪个 outputVar

### 4.2 变量合并

执行器构造 stage context 时：

```
variables = { ...pipeline.variables, ...runtimeVars }
```

runtime 覆盖静态。后续 `{{vars.X}}` 模板替换逻辑保持不变（`src/pipeline/variables.ts`）。

### 4.3 配置期校验

保存 pipeline 时（`PUT /admin/pipelines/:id`）：

- 若 `schedule` 非空 或 `trigger_params` 开放 API 触发：
  - 每个 `artifactInputs[i]` 必须有 `default` **或** `defaultStrategy`
  - 违反则 400，错误信息指向具体的 input name

纯手工/IM 触发的 pipeline 不强制，Agent 对话阶段问用户即可。

## 5 · 后端实现

### 5.1 新模块 `src/pipeline/artifact-resolver.ts`

```ts
interface ArtifactFile {
  name: string
  path: string
  size: number
  mtime: number
  downloadUrl: string     // listUrl 拼 path 得到
  isFile: boolean         // dir 的过滤掉
}

// Agent 和管理后台"测试列表"按钮都调用
export async function listArtifacts(input: Pick<ArtifactInput, 'listUrl' | 'glob' | 'authHeaders'>): Promise<ArtifactFile[]>

// 触发时解析"某一个 input 的值"，按 4.1 的优先级
export async function resolveArtifact(
  input: ArtifactInput,
  providedRuntimeVar?: string
): Promise<string>   // 返回按 valueFrom 取出的字符串
```

实现注意：
- gohttpserver 的 JSON 响应通过 `listUrl + '?json=true'` 获取
- 响应中的 `path` 字段是**服务器根相对**路径（无前导斜杠，如 `'pam/deploy/xxx.tar.gz'`）
- `downloadUrl = new URL('/' + path, listUrl).toString()` —— 取 listUrl 的 origin，拼 `/` + path
- `valueFrom: 'url'` 取 downloadUrl；`'path'` 取上述 path 原值；`'name'` 取文件名
- `glob` 用轻量实现（转正则即可），支持 `*` `?`；不引入 micromatch 这种重依赖
- 目录项（`type == 'dir'`）统一过滤掉，不参与 glob 匹配

### 5.2 Admin 路由

- `GET /admin/pipelines/:id`：响应增加 `artifactInputs`
- `PUT /admin/pipelines/:id`：接受 `artifactInputs` + 执行 4.3 校验
- `POST /admin/pipelines/:id/run`：body 增加 `runtimeVars?: Record<string,string>`
- `POST /admin/artifacts/list`：body `{ listUrl, glob?, authHeaders? }`，调 `listArtifacts` 返回结果。用于管理后台"预览 glob 命中哪些文件"和 Agent 工具共用逻辑

### 5.3 触发统一入口

`triggerPipelineRun(pipelineId, { triggerType, triggeredBy, runtimeVars })` 放在 `src/pipeline/executor.ts`：

```
1. 读 pipeline（含 artifactInputs）
2. 对每个 input 调 resolveArtifact(input, runtimeVars[input.outputVar])
   —— 失败（未提供、仓库不通、无匹配）→ 抛明确错误
3. 把所有解析结果合进 runtimeVars
4. 创建 test_runs 记录（runtime_vars 列写入最终 merged 结果）
5. 正常执行 stages
```

IM 适配器、定时调度器、管理后台手动触发按钮、MCP 工具 全部走这一条路径。

## 6 · MCP 工具

按 `src/agent/tools/` 自注册约定新增/扩展。

### 6.1 `list_artifacts`

```ts
{
  name: 'list_artifacts',
  description: '列出制品仓库中符合 glob 的文件。触发流水线前让用户选包时使用。',
  parameters: {
    listUrl: string,
    glob?: string,
    authHeaders?: Record<string,string>
  },
  returns: 'files[]{ name, size, mtime, downloadUrl }'
}
```

内部调 `listArtifacts`，按 mtime 倒序，截断前 10 返回；若被截断，多返回一个 `truncated: true` 字段提示 Agent。

### 6.2 `get_pipeline_artifact_inputs`

```ts
{
  name: 'get_pipeline_artifact_inputs',
  description: '读取 pipeline 声明的制品输入需求，触发前先调用，知道要问用户哪几项。',
  parameters: { pipelineId: number },
  returns: 'ArtifactInput[]'
}
```

### 6.3 扩展已有 trigger 工具

Pipeline 触发类工具（例：`trigger_pipeline`、或管理后台调用的"运行"接口）参数增加 `runtimeVars?: Record<string,string>`，透传到 `triggerPipelineRun`。

**不影响 `deploy` 类工具**——它们面向"按分支/环境快速部署"场景，与本设计的"流水线触发 = 部署一个完整新环境"用途不同，保持独立。

所有新工具在 `src/server.ts` 和 `src/agent/mcp-server.ts` 添加 `import './tools/<name>.js'`。

## 7 · 前端（管理后台）

### 7.1 pipeline 编辑页

在 `web/src/pages/PipelineEditor/`（或对应文件）新增"制品输入"分节：

- 表格编辑 `artifactInputs`，每行字段：name / listUrl / glob / outputVar / valueFrom / default / defaultStrategy
- 每行提供"预览匹配"按钮，调 `/admin/artifacts/list` 弹窗显示当前 glob 命中的文件列表（校验 glob 是否写对）
- 页面顶部感知：若 pipeline 开启定时（schedule 非空）且存在 input 未配 default/strategy，保存按钮禁用 + 明确红字提示

### 7.2 手动触发对话框

管理后台的"手动运行"按钮点开后：
- 若 pipeline 有 artifactInputs，弹出表单逐项填写（可直接填 URL，也可点"从仓库选"按钮调 `list_artifacts`）
- 表单提交即调 `POST /admin/pipelines/:id/run` 带 `runtimeVars`

## 8 · Agent 对话流程

### 8.1 典型交互

```
用户：部署 dev 最新包到测试环境
Agent：[调 get_pipeline_artifact_inputs → 返回 1 项：PAM Docker 包]
Agent：[调 list_artifacts(listUrl, glob)]
Agent：找到以下包，请回复编号或文件名：
       1. PAM-Docker-develop.tar.gz    6.3 GB  2026-04-15 14:30
       2. PAM-Docker-6.7.0.10.tar.gz   6.1 GB  2026-04-10 09:12
       3. PAM-Docker-6.6.1.3.tar.gz    4.7 GB  2026-03-20 17:45
用户：1
Agent：[调 trigger_pipeline(id, { PACKAGE_URL: 'http://.../PAM-Docker-develop.tar.gz' })]
Agent：已触发流水线 #1234，使用包：PAM-Docker-develop.tar.gz
```

### 8.2 工具使用约束（写进工具 description 和系统提示）

- 触发流水线前**必须先调** `get_pipeline_artifact_inputs`
- 若返回非空，不得跳过选择直接拼默认值
- `list_artifacts` 结果多时按 mtime 倒序展示前 10，追加提示"需要更多选项请说"
- 用户回复无法映射到列表项时，再问一次；连续两次解析失败则终止本次触发并说明原因

### 8.3 定时触发路径

调度器调用 `triggerPipelineRun` 时不传 `runtimeVars`，resolver 自动按 `default` / `defaultStrategy` 挑。完全无人工介入。

## 9 · 错误处理 / 边界

| 场景 | 处理 |
|------|------|
| listUrl 不可达 | `ARTIFACT_REPO_UNREACHABLE`；Agent 友好提示；定时触发则 run failed 并写明原因 |
| glob 无匹配 | 返回空；Agent 提示"没匹配，核对 glob 或换输入"；定时触发 run failed |
| 匹配结果全是目录 | `isFile=false` 过滤；若过滤后为空，当"无匹配"处理 |
| 用户文字回复无法解析（非编号非文件名） | Agent 重问一次，连错两次则放弃本次触发 |
| 必传 outputVar 缺失 | 触发接口 400，错误体列出缺失 input.name |
| defaultStrategy 期间 listUrl 超时 | 15s timeout；定时触发 → run failed；手动触发 → 错误冒泡到用户 |

## 10 · 涉及文件清单

**新增**
- `src/pipeline/artifact-resolver.ts`
- `src/agent/tools/list-artifacts.ts`
- `src/agent/tools/get-pipeline-artifact-inputs.ts`
- `src/db/schema-v10.sql`

**修改**
- `src/pipeline/types.ts`（ArtifactInput 接口）
- `src/pipeline/executor.ts`（triggerRun 签名 + runtimeVars 合并）
- `src/db/repositories/test-pipelines.ts`（读/写 artifact_inputs 列）
- `src/db/repositories/test-runs.ts`（写 runtime_vars 列）
- `src/db/migrate.ts`（执行 schema-v10）
- `src/admin/routes/pipelines.ts`（GET/PUT 返回 artifactInputs、PUT 校验、POST run 接收 runtimeVars）
- `src/admin/routes/artifacts.ts` **新增** 路由（POST /admin/artifacts/list）
- `src/server.ts` / `src/agent/mcp-server.ts`（import 新工具）
- `web/src/pages/PipelineEditor/...`（制品输入编辑 UI + 预览匹配）
- `web/src/api/pipelines.ts`（新增 artifacts.list + 手动 run 的 runtimeVars 参数）

**不动**
- `src/agent/tools/deploy.ts` 及其它 deploy 类工具：面向分支/环境的快速部署，与本设计的"流水线部署完整新环境"用途不同

## 11 · 非目标（YAGNI）

- 独立的"制品仓库"管理页面、复用配置
- 多仓库类型（nexus / s3）的实现 —— type 字段保留但首版只做 gohttpserver
- IM 交互卡片/按钮选择 —— 首版纯文本编号列表
- artifact-select 作为执行阶段（executor 层面不新增 stage 类型）
