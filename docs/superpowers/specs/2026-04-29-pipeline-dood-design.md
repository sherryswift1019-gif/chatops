# Spec: Pipeline 节点容器化执行（DooD）

> 状态：草稿  
> 讨论背景：2026-04-29

---

## 一、背景与目标

当前 `llm_agent` 节点在执行能力（capability）时，`run_tests` 等 MCP 工具直接在 chatops
宿主容器里调 `child_process.exec`。chatops 镜像只装了 `git`，没有 Go / Python / Maven 等
项目依赖，多项目流水线无法在同一实例上运行。

本 spec 描述三件事：

1. **DooD（Docker outside of Docker）基础设施**：让 chatops 容器具备启动其他容器的能力
2. **节点级容器化执行**：`script` 和 `llm_agent`（两种模式）节点可配置运行镜像
3. **`custom` 模式 `allowedTools` 扩展**：UI 多选下拉里把所有已注册的平台 MCP 工具暴露出来，
   不再只有 `WebFetch` / `WebSearch` 两个内置工具

**不在本 spec 范围**：

- Skills 注入：后续单独 spec
- 外部 MCP server 接入（GitHub MCP / Jira MCP 等）：后续单独 spec
- `approval` / `wait_webhook` / `sql_query` / `http` / `dm` / `db_update` / `file_read` /
  `template_render` / `fan_out` / `switch`：平台级操作节点，不涉及运行环境

---

## 二、核心决策：执行路径分类

是否使用容器，**判定依据是工具/命令是否需要项目运行时**，不是节点模式。

### 2.1 三类执行路径

| 路径 | 例子 | 容器化处理 |
|------|------|-----------|
| **本地工作区命令执行** | `run_command`（原 `run_tests`）的 `execAsync(cmd, { cwd })` | ✅ 路由到 `docker exec` |
| **远程 SSH 执行** | `deploy` / `get_logs` / `check_env_status` 的 `sshExec()` | ❌ 打到目标服务器，与本地容器无关 |
| **文件操作 / API 调用** | `fix_code`（写文件）/ `read_code`（读文件）/ `create_mr`（GitLab API）/ `WebFetch` | ❌ chatops 容器执行即可，bind mount 保证文件路径一致 |

### 2.2 工具分类清单

**平台 MCP 工具**（`src/agent/tools/` 注册表）：

| 工具 | 类型 | 容器化 |
|------|------|-------|
| `run_command`（原 `run_tests`）| 本地工作区命令 | ✅ |
| `autotest` | 本地工作区命令 | ✅ |
| `switch_version` | 本地 git 操作（git 在 chatops 内有） | ❌ |
| `fix_code` / `read_code` | 文件操作 | ❌ |
| `deploy` / `get_logs` / `check_env_status` | 远程 SSH | ❌ |
| `create_mr` / `get_gitlab_commits` 等 | GitLab API | ❌ |
| `query_deployments` / `list_images` 等 | 平台数据查询 | ❌ |

**Claude 内置工具：**

| 工具 | 类型 | 容器化 |
|------|------|-------|
| `Bash` | 直接 shell 执行 | ⚠️ 无法路由 → **强制禁用** |
| `Read` / `Write` / `Edit` / `Glob` / `Grep` | 文件操作 | ❌ bind mount 保证路径一致 |
| `WebFetch` / `WebSearch` | HTTP 请求 | ❌ |

### 2.3 不可避免的取舍：禁用 `Bash`

Claude 的内置 `Bash` 工具直接在 chatops 容器跑 shell，**无法被工具层拦截或重定向到 `docker exec`**。如果 prompt 里写"运行 `go build`"，Claude 用 `Bash` 跑 → chatops 容器没有 Go → 必然失败。

**唯一干净的解法**：节点配置 `containerImage` 时，把 `Bash` 加入 `disallowedTools`。Claude 如需执行 shell 命令，只能走 `run_command` MCP 工具——后者会被路由到目标容器。

### 2.4 重命名 `run_tests` → `run_command`

现 `run_tests` 工具实际上接收任意 `command` 参数，不限于测试命令。改名让职责清晰：

```typescript
// 现在
{ name: 'run_tests', description: '在 worktree 内运行测试命令' }

// 改后
{ name: 'run_command', description: '在工作区执行 shell 命令（支持容器化运行时）' }
```

兼容性：保留 `run_tests` 作为 deprecated 别名一段时间，让旧 capability 配置不报错。

---

## 三、架构概览

### 3.1 执行模型

```
LangGraph（外层调度）
  └── 节点执行函数（graph-builder.ts）
        │
        ├── script 节点
        │     有 containerImage → DockerExecutor.exec(script)
        │     有 targetRole    → SSH exec（现有行为不变）
        │
        ├── llm_agent 节点（capability 模式）
        │     固定接入 chatops MCP server（同现状）
        │     有 containerImage → 起容器 + 注入 dockerContainerName + 禁 Bash
        │     无 containerImage → 现有行为
        │
        ├── llm_agent 节点（custom 模式）
        │     接入 chatops MCP server（新增；现状是裸 Porygon）
        │     allowedTools 多选含全部平台 MCP 工具 + Claude 内置工具
        │     有 containerImage → 起容器 + 注入 dockerContainerName + 禁 Bash
        │     无 containerImage → 命令在 chatops 容器执行
        │
        └── 其他节点 → 无容器，现有行为不变
```

### 3.2 容器与 LangGraph 的关系

LangGraph 完全不感知容器，只管 DAG 遍历、条件边、interrupt/resume。容器生命周期
完全在节点执行函数内部管理：**起容器 → 执行 → 拆容器**，对 LangGraph 透明。

### 3.3 容器层级（参照 GitLab CI 的 global image / per-job image）

```
test_pipelines.container_image      ← pipeline 级默认镜像（已有，v50）

PipelineNode.containerImage         ← 节点级覆盖（优先于 pipeline 级，已有）
```

节点若不配置 `containerImage`，回落到 pipeline 级默认；pipeline 级也未配置则不起容器。

### 3.4 跨节点文件共享

`testdata` 目录由 named volume 改为宿主机 bind mount。所有节点容器挂载同一目录
（路径与 chatops 容器内完全一致），节点 A 写入的文件在节点 B 的容器里直接可见，
等价于 GitLab CI 的 artifacts 但无需显式声明。

### 3.5 `custom` 模式：接入 MCP server + 扩展 `allowedTools` 选项

**当前现状：**

`runCustomAgent` 用裸 `createPorygon`，未配置 `mcpServers`，所以平台 MCP 工具不可用。
UI 的 `allowedTools` 多选只提供两个 Claude 内置工具：

```
WebFetch（HTTP 抓取）
WebSearch（搜索）
```

**本 spec 改动：**

1. **后端**：`runCustomAgent` 总是接入 chatops MCP server（`mcp-server.ts`），
   让平台所有 MCP 工具对 Claude 可用。`allowedTools` (Porygon `onlyTools`) 作为白名单
   控制 Claude 实际能用哪些。

2. **前端**：`allowedTools` 下拉选项扩展为"全部平台工具 + Claude 内置工具"，分组展示：
   ```
   ── 平台 MCP 工具 ──
     run_command       在工作区执行 shell 命令（支持容器化）
     fix_code          修改代码文件
     read_code         读取代码
     deploy            执行部署
     get_logs          查询容器日志
     create_mr         创建 GitLab MR
     ... (从 /admin/tools API 拉)

   ── Claude 内置工具 ──
     WebFetch          HTTP 抓取
     WebSearch         搜索
   ```

3. **新增 admin API**：`GET /admin/tools` 暴露已注册的 MCP 工具列表（name / description / riskLevel）。

### 3.6 容器化与工具选择的关系

`containerImage` 和 `allowedTools` 是**两个正交配置**，组合矩阵：

```
allowedTools 含 run_command + containerImage 有
  → 完整容器化能力（Claude 在容器里跑 shell 命令）

allowedTools 含 run_command + containerImage 空
  → 在 chatops 容器跑 shell（现有行为）

allowedTools 不含 run_command + containerImage 有
  → 容器起来但 Claude 调不到 shell 工具（UI 给 warning）

allowedTools 不含 run_command + containerImage 空
  → 纯推理 / 信息检索任务
```

---

## 四、基础设施变更

### 4.1 宿主机初始化（一次性）

```bash
sudo mkdir -p /srv/chatops/test-runs
sudo chown -R 1000:1000 /srv/chatops/test-runs

# 查 docker group gid，写入 .env
echo "DOCKER_GID=$(getent group docker | cut -d: -f3)" >> .env
```

### 4.2 Dockerfile

```dockerfile
# 在现有 git 安装行追加 docker-ce-cli
RUN apt-get update && apt-get install -y --no-install-recommends git docker-ce-cli \
 && rm -rf /var/lib/apt/lists/* \
 && git config --system user.email "chatops@paraview.cn" \
 && git config --system user.name "ChatOps Agent"
```

### 4.3 docker-compose.yml 和 docker-compose.prod.yml（两个文件同步）

```yaml
chatops:
  environment:
    DATABASE_URL: postgres://chatops:chatops@postgres:5432/chatops
    PORT: "3000"
    TEST_DATA_DIR: /data/chatops/test-runs
    HOST_TEST_DATA_DIR: /srv/chatops/test-runs       # 新增：宿主机侧路径
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock       # 新增：DooD
    - /srv/chatops/test-runs:/data/chatops/test-runs  # 改：named volume → bind mount
  group_add:
    - "${DOCKER_GID:-999}"                            # 新增：加入 docker group

# volumes 块删除 testdata 条目
```

---

## 五、后端变更

### 5.1 `src/pipeline/executors/docker.ts`

`setup()` 增加可选的 testdata 目录挂载参数：

```typescript
interface SetupOptions {
  dataDirMount?: { hostPath: string }   // 挂载 HOST_TEST_DATA_DIR → TEST_DATA_DIR
}

async setup(containerName: string, opts: SetupOptions = {}): Promise<void> {
  // docker pull ...
  const args = ['run', '-d', '--name', containerName, '-w', '/workspace']
  if (opts.dataDirMount) {
    const containerDataDir = process.env.TEST_DATA_DIR ?? '/data/chatops/test-runs'
    args.push('-v', `${opts.dataDirMount.hostPath}:${containerDataDir}`)
  }
  args.push(this.image, 'sleep', 'infinity')
  // docker run ...
}
```

`exec(command)` 不变：`docker exec <name> sh -c <command>`

### 5.2 `src/agent/tools/types.ts`

```typescript
export interface TaskContext {
  taskId: string
  groupId: string
  platform: string
  initiatorId: string
  initiatorRole: Role | null
  cwd?: string
  productLineId?: number
  originalPrompt?: string
  dockerContainerName?: string   // 新增：节点运行容器名
}
```

### 5.3 `run_command` 工具（重命名 + 容器路由）

新建 `src/agent/tools/run-command.ts`，从 `run-tests.ts` 迁移并改名：

```typescript
const runCommandTool: AgentTool = {
  name: 'run_command',
  description: '在工作区执行 shell 命令。配置了运行容器时自动路由进容器。',
  riskLevel: 'medium',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的 shell 命令' },
      timeout: { type: 'number', description: '超时（毫秒），默认 300000' },
    },
    required: ['command'],
  },
  async execute(params, ctx) {
    const { command, timeout } = params as { command: string; timeout?: number }
    const cwd = ctx.cwd
    if (!cwd) return { success: false, output: '未设置工作目录（cwd）' }
    const timeoutMs = timeout ?? 300_000

    try {
      let stdout: string, stderr: string
      if (ctx.dockerContainerName) {
        // 容器挂载了 testdata，路径与 ctx.cwd 完全一致，直接 cd 进去执行
        const r = await execAsync(
          `docker exec ${ctx.dockerContainerName} sh -c "cd ${cwd} && ${command}"`,
          { timeout: timeoutMs }
        )
        stdout = r.stdout; stderr = r.stderr
      } else {
        const r = await execAsync(command, { cwd, timeout: timeoutMs })
        stdout = r.stdout; stderr = r.stderr
      }
      return { success: true, output: `...\n${stdout.slice(-2000)}\n${stderr.slice(-500)}` }
    } catch (err) {
      // 同 run_tests 现有错误处理
    }
  },
}

registerTool(runCommandTool)
// 兼容旧 capability 配置：保留 run_tests 别名
registerTool({ ...runCommandTool, name: 'run_tests', description: '[deprecated] 改用 run_command' })
```

`autotest.ts` 等其他本地命令执行工具同样适配 `dockerContainerName` 分支。  
`switch_version.ts` / `fix_code.ts` / `deploy.ts` / `get_logs.ts` 等不需要改动（见 §2.2 分类）。

### 5.4 Admin API：`src/admin/routes/tools.ts`（新增）

新增端点暴露已注册的 MCP 工具列表，供前端 `allowedTools` 下拉拉取：

```typescript
// GET /admin/tools
// 返回：[{ name, description, riskLevel, requiredRole }]
fastify.get('/admin/tools', async () => {
  return Array.from(getRegistry().values()).map(t => ({
    name: t.name,
    description: t.description,
    riskLevel: t.riskLevel,
    requiredRole: t.requiredRole ?? null,
  }))
})
```

注册到 `src/admin/index.ts`。

### 5.5 `src/pipeline/executor-hooks.ts` — `runCapability`

`capability` 模式只处理容器生命周期（MCP server 走现有 `claude-runner.ts` 路径，本身就有）：

```typescript
async runCapability(stage, ctx, triggerParams, runtimeVars) {
  const capabilityKey = stage.capabilityKey
  if (!capabilityKey) return { status: 'failed', ... }

  const effectiveImage = stage.containerImage?.trim() ?? ctx.pipelineContainerImage?.trim()
  let dockerContainerName: string | undefined
  let dockerExecutor: DockerExecutor | undefined

  if (effectiveImage) {
    dockerContainerName = `chatops-cap-${ctx.runId}-${ctx.stageIndex}`
    dockerExecutor = new DockerExecutor(effectiveImage)
    const hostDataDir = process.env.HOST_TEST_DATA_DIR
    await dockerExecutor.setup(
      dockerContainerName,
      hostDataDir ? { dataDirMount: { hostPath: hostDataDir } } : {}
    )
  }

  try {
    const result = await Promise.race([
      triggerCapability({
        capabilityKey,
        context: {
          taskId: `pipeline-${ctx.runId}-stage-${ctx.stageIndex}`,
          groupId: 'pipeline',
          platform: 'pipeline',
          initiatorId: 'pipeline-executor',
          initiatorRole: 'admin',
          ...(dockerContainerName ? { dockerContainerName } : {}),
        },
        extraParams: resolveCapabilityParams(stage.capabilityParams, triggerParams, runtimeVars),
        _suppressInvocationLog: true,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('capability 执行超时')), (stage.timeoutSeconds ?? 1200) * 1000)
      ),
    ])
    return { status: result.success ? 'success' : 'failed', output: result.output ?? '', error: result.error }
  } catch (err) {
    return { status: 'failed', output: `capability 执行失败: ${String(err)}`, error: String(err) }
  } finally {
    await dockerExecutor?.teardown().catch(e =>
      console.warn('[executor-hooks] container teardown failed:', e)
    )
  }
}
```

### 5.6 `src/pipeline/executor-hooks.ts` — `runCustomAgent`

`custom` 模式：**总是接入 chatops MCP server**，加上容器生命周期管理：

```typescript
async runCustomAgent(stage, ctx, triggerParams, runtimeVars) {
  const rawPrompt = stage.customPrompt ?? ''
  if (!rawPrompt.trim()) return { status: 'failed', output: '', error: 'customPrompt is empty' }

  // ... resolveVariables 展开 prompt（现有逻辑不变）

  // 1. 起容器（如配置）
  const effectiveImage = stage.containerImage?.trim() ?? ctx.pipelineContainerImage?.trim()
  let dockerContainerName: string | undefined
  let dockerExecutor: DockerExecutor | undefined
  if (effectiveImage) {
    dockerContainerName = `chatops-cust-${ctx.runId}-${ctx.stageIndex}`
    dockerExecutor = new DockerExecutor(effectiveImage)
    const hostDataDir = process.env.HOST_TEST_DATA_DIR
    await dockerExecutor.setup(
      dockerContainerName,
      hostDataDir ? { dataDirMount: { hostPath: hostDataDir } } : {}
    )
  }

  // 2. disallowedTools：容器化时强制禁 Bash；非容器化保持现有 Bash 默认禁用
  // (custom 模式 Bash 在任何情况下都禁用，没有 chatops 容器执行项目命令的语义)
  const baseDisallowed = ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep']
  const allowedTools = Array.isArray(stage.allowedTools) && stage.allowedTools.length > 0
    ? stage.allowedTools : undefined

  // 3. 始终挂上 chatops MCP server（让平台工具对 allowedTools 可见）
  const mcpServerPath = join(__dirname, '..', 'agent', 'mcp-server.ts')
  const mcpServers = {
    chatops: {
      command: 'node',
      args: ['--import', 'tsx/esm', mcpServerPath],
    },
  }

  // 4. CHATOPS_TASK_CONTEXT 透传给 MCP server 子进程
  const taskContext: TaskContext = {
    taskId: `pipeline-cust-${ctx.runId}-${ctx.stageIndex}`,
    groupId: 'pipeline',
    platform: 'pipeline',
    initiatorId: 'pipeline-executor',
    initiatorRole: 'admin',
    cwd: ctx.logDir,  // 或更精确的 worktree 路径
    ...(dockerContainerName ? { dockerContainerName } : {}),
  }

  try {
    const porygon = createPorygon({ /* 现有配置 */ })
    const result = await porygon.run({
      prompt,
      ...(allowedTools ? { onlyTools: allowedTools } : { disallowedTools: baseDisallowed }),
      mcpServers,
      envVars: {
        ...(await buildClaudeEnv()),
        CHATOPS_TASK_CONTEXT: JSON.stringify(taskContext),
      },
    })
    return { status: 'success', output: result.trim() }
  } catch (err) {
    return { status: 'failed', output: `custom agent 执行失败 [${stage.name}]: ${String(err)}`, error: String(err) }
  } finally {
    await dockerExecutor?.teardown().catch(e =>
      console.warn('[executor-hooks] custom container teardown failed:', e)
    )
  }
}
```

**注意**：`onlyTools` 白名单需要使用 Claude/Porygon 实际识别的工具名格式。MCP 工具在 Claude 那边通常以 `mcp__<server>__<tool>` 形式出现（如 `mcp__chatops__run_command`）。前端选项的 `value` 字段需要匹配此格式，或后端在传给 Porygon 前做映射。

### 5.7 `src/pipeline/executor.ts` — pipeline 级容器镜像透传

```typescript
const stageContext: StageContextBase = {
  runId: run.id,
  // ... 现有字段
  dockerExecutor,                                          // pipeline 级 script 共享（现有）
  pipelineContainerImage: pipelineContainerImage ?? undefined,  // 新增：供 runCapability/runCustomAgent 回落
}
```

### 5.8 `src/pipeline/graph-builder.ts` — `StageContextBase` 新增字段

```typescript
export interface StageContextBase extends Omit<StageContext, 'stageIndex'> {
  dockerExecutor?: DockerExecutor
  pipelineContainerImage?: string    // 新增
}
```

---

## 六、前端变更

### 6.1 `NodeInspector.tsx` — `llm_agent` 改动

```tsx
// script 节点：不变
if (t === 'script') {
  return (<><ContainerImageField /><ScriptField /></>)
}

// llm_agent 节点
if (t === 'llm_agent') {
  const agentMode = getFieldValue('agentMode') ?? 'capability'
  const containerImage = getFieldValue('containerImage')
  const allowed = getFieldValue('allowedTools') as string[] | undefined
  const hasRunCommand = allowed?.some(t => t === 'run_command' || t === 'mcp__chatops__run_command')

  return (
    <>
      {/* 现有 capability/custom 切换 UI */}
      <ContainerImageField
        extra="留空则继承 pipeline 级默认镜像。配置后 Claude 内置 Bash 自动禁用，shell 命令需走 run_command 工具。"
        placeholder="harbor.xxx/golang:1.21"
      />

      {agentMode === 'capability' && (
        <>{/* 现有 capabilityKey 等字段 */}</>
      )}

      {agentMode === 'custom' && (
        <>
          {/* 现有 customPrompt 字段 */}
          <Form.Item
            label="可用工具"
            name="allowedTools"
            extra="不选则禁用文件读写/Bash 等内置工具。MCP 平台工具按需勾选。"
          >
            <Select
              mode="multiple"
              placeholder="按需选择 Claude 可调用的工具"
              showSearch
              optionFilterProp="label"
              options={[
                {
                  label: '平台 MCP 工具',
                  options: mcpTools.map(t => ({
                    value: `mcp__chatops__${t.name}`,
                    label: `${t.name} — ${t.description}`,
                  })),
                },
                {
                  label: 'Claude 内置工具',
                  options: [
                    { value: 'WebFetch', label: 'WebFetch — HTTP 抓取' },
                    { value: 'WebSearch', label: 'WebSearch — 搜索' },
                  ],
                },
              ]}
            />
          </Form.Item>

          {/* 配了容器但没选 run_command 时 warning */}
          {containerImage && !hasRunCommand && (
            <Alert
              type="warning"
              showIcon
              message="配置了运行容器，但未选 run_command 工具，Claude 调用 shell 命令将失败。"
            />
          )}
        </>
      )}
    </>
  )
}
```

`mcpTools` 通过新增 `web/src/api/tools.ts` 在面板挂载时拉 `/admin/tools`。

### 6.2 `pruneStageFields.ts` — 切换节点类型时清理 `containerImage`

```typescript
// 节点类型切换：containerImage 仅在 script 和 llm_agent 保留
containerImage: (next === 'script' || next === 'llm_agent')
  ? prev.containerImage
  : undefined
```

`agentMode` 切换不再清理 `containerImage`（capability ↔ custom 都保留）。  
`allowedTools` 字段在两种 agentMode 下含义不同，已有清理逻辑保持。

---

## 七、执行流程（完整时序）

**capability 模式举例：**

```
executor.ts:runPipeline
  ① 读 pipeline.containerImage
  ② 对 script 节点：若有 pipeline.containerImage，起 shared dockerExecutor（现有）
  ③ stageContext 加入 pipelineContainerImage
  ④ startRun(stageContext, hooks, ...)

  LangGraph 调度到 llm_agent(capability) 节点
    executor-hooks.ts:runCapability
      ⑤ effectiveImage = stage.containerImage ?? pipelineContainerImage
      ⑥ 如有 effectiveImage：
           docker pull <image>
           docker run -d --name chatops-cap-<runId>-<i>
                     -v /srv/chatops/test-runs:/data/chatops/test-runs
                     <image> sleep infinity
      ⑦ triggerCapability({ context: { ..., dockerContainerName } })

    coordinator → claude-runner.ts
      ⑧ disallowedTools 追加 'Bash'
      ⑨ CHATOPS_TASK_CONTEXT = JSON.stringify({ ..., dockerContainerName, cwd })
      ⑩ Porygon 起 Claude CLI + chatops MCP server

    Claude 执行任务
      ⑪ Claude 不能用 Bash（被 disallowed），调 run_command MCP tool
      ⑫ run_command 看到 ctx.dockerContainerName 非空
           → docker exec chatops-cap-<runId>-<i> sh -c "cd <cwd> && go test ./..."
      ⑬ 命令在目标容器内执行，结果返回 Claude

  finally：docker rm -f chatops-cap-<runId>-<i>
```

**custom 模式举例（allowedTools=[run_command, fix_code] + containerImage=python:3.11）：**

```
LangGraph 调度到 llm_agent(custom) 节点
  executor-hooks.ts:runCustomAgent
    ① 起容器 chatops-cust-<runId>-<i>（python:3.11）
    ② 构造 Porygon options：
         mcpServers: { chatops: { command: 'node', args: [...] } }
         onlyTools: ['mcp__chatops__run_command', 'mcp__chatops__fix_code']
         envVars.CHATOPS_TASK_CONTEXT = { ..., dockerContainerName, cwd }
    ③ porygon.run(options)

  Claude 执行用户 prompt（只能用 run_command + fix_code）
    ④ run_command → docker exec chatops-cust-<runId>-<i> sh -c "cd <cwd> && pytest"
    ⑤ fix_code → 在 chatops 容器写文件（bind mount，目标容器立即可见）

  finally：docker rm -f chatops-cust-<runId>-<i>
```

---

## 八、约束与边界条件

### 容器镜像要求

- 必须包含 `sh`（用于 `docker exec sh -c`）
- 镜像内**不需要** Node.js / Claude CLI / chatops 任何组件
- 需要包含任务所需的运行时（Go / Python / Java / Node.js 等）

### `Bash` 内置工具的处理

- `custom` 模式：`Bash` 始终在 `disallowedTools` 默认列表里（无论是否容器化）
- `capability` 模式：节点配置 `containerImage` 时，`disallowedTools` 自动追加 `Bash`
- 原因：Claude 内置 `Bash` 直接在 chatops 容器跑，无法路由到目标容器，会用错运行环境
- Claude 如需执行 shell 命令，必须用 `run_command` MCP 工具

### `run_command`（原 `run_tests`）的职责

- 接收任意 shell 命令，不限于测试
- 看到 `ctx.dockerContainerName` → `docker exec` 进容器
- 否则在 chatops 容器内 `execAsync`（现有行为）
- 别名 `run_tests` 保留向后兼容，标记 deprecated

### `custom` 模式总是接入 chatops MCP server

- 不需要用户额外开关，`runCustomAgent` 总是注入 `mcpServers`
- `allowedTools` (Porygon `onlyTools`) 控制 Claude 能调用哪些工具
- 用户没选任何 MCP 工具 → MCP server 起来但 Claude 用不上，无副作用

### 配了容器但未选 `run_command` 的处理

- 不视为错误，UI Alert 提示用户
- 容器照常起来照常拆，只是 Claude 没办法触发容器内命令
- 适合"只用 fix_code 改代码、不跑测试"等少见场景

### 容器安全边界

- 项目容器不含 DB 连接串、chatops OAuth token 等内部凭证
- `docker exec` 执行的命令由 MCP 工具发起，Claude 不能直接操纵容器生命周期
- 容器以 `sleep infinity` 保活，仅通过 `docker exec` 接受命令，teardown 在 finally 块强制执行

### 跨节点文件共享

- testdata bind mount 在所有节点容器内路径与 chatops 容器内完全一致
- 节点 A 容器写入 `cwd` 的文件，节点 B 容器直接可读，无需显式 artifact 声明
- `ctx.cwd`（worktree 路径）在容器内外是同一个字符串

### DooD 安全注意事项

- chatops 容器挂载 `/var/run/docker.sock`，等同于宿主机 docker 权限
- 建议在宿主机层面限制 chatops 可拉取的镜像来源（Harbor 白名单）
- 节点容器不挂 docker socket，无法再起子容器

---

## 九、改动文件汇总

| 文件 | 类型 | 说明 |
|------|------|------|
| `Dockerfile` | 基础设施 | 加 `docker-ce-cli` |
| `docker-compose.yml` | 基础设施 | socket 挂载 + bind mount + group_add |
| `docker-compose.prod.yml` | 基础设施 | 同上 |
| `src/pipeline/executors/docker.ts` | 后端 | `setup()` 加 `dataDirMount` 参数 |
| `src/pipeline/graph-builder.ts` | 后端 | `StageContextBase` 加 `pipelineContainerImage` |
| `src/pipeline/executor.ts` | 后端 | stageContext 注入 `pipelineContainerImage` |
| `src/pipeline/executor-hooks.ts` | 后端 | `runCapability` 起/拆容器；`runCustomAgent` 同样 + 接入 chatops MCP server |
| `src/agent/tools/types.ts` | 后端 | `TaskContext` 加 `dockerContainerName` |
| `src/agent/tools/run-command.ts` | 后端（新增）| 从 `run-tests.ts` 迁移 + 改名 + 支持 `docker exec` |
| `src/agent/tools/run-tests.ts` | 后端 | 保留为 deprecated 别名（注册同一份逻辑，不同 name） |
| `src/agent/tools/autotest.ts` 等本地命令工具 | 后端 | 适配 `docker exec` 分支 |
| `src/agent/tools/types.ts` `DEFAULT_TOOL_ROLES` | 后端 | 加 `run_command` 角色映射 |
| `src/agent/tools/index.ts` | 后端 | 暴露 `getRegistry()` 给 admin 路由 |
| `src/agent/claude-runner.ts` | 后端 | capability 路径 containerImage 配了时 `disallowedTools` 追加 'Bash' |
| `src/admin/routes/tools.ts` | 后端（新增）| `GET /admin/tools` 列出已注册 MCP 工具 |
| `src/admin/index.ts` | 后端 | 注册 tools 路由 |
| `web/src/api/tools.ts` | 前端（新增）| `/admin/tools` 客户端封装 |
| `web/src/pipeline-canvas/panels/NodeInspector.tsx` | 前端 | `llm_agent` 两种模式都展示 `containerImage`；custom 的 `allowedTools` 下拉扩展为分组（平台 + 内置）；warning |
| `web/src/pipeline-canvas/panels/pruneStageFields.ts` | 前端 | `containerImage` 在 `script` 和 `llm_agent` 都保留 |
