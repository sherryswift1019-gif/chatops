# Pipeline 容器管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Pipeline 引擎新增 Docker 容器执行模式，参考 GitLab Runner Docker executor，支持 pipeline 级默认 image 与节点级 override；script 节点有 role 时走 SSH，无 role 时走本机 Docker 容器。

**Architecture:** `DockerExecutor` 类封装 `docker pull / run -d / exec / rm` 生命周期，通过 `child_process.spawn` 调用 Docker CLI。`executor.ts` 在 run 开始时按 `pipeline.containerImage` 决定是否创建并 setup `DockerExecutor`，注入 `stageContext.dockerExecutor`；`graph-builder.ts:buildScriptNode` 按优先级路由：`targetRoles` 非空 → SSH，否则检查节点 `containerImage`（per-node）或 `stageContext.dockerExecutor`（pipeline 默认）；`finalize()` 负责 teardown。

**Tech Stack:** Node.js child_process（spawn），TypeScript，PostgreSQL，React + Ant Design 5，Vitest

---

## File Map

| 操作 | 文件 | 说明 |
|---|---|---|
| 新建 | `src/db/schema-v50.sql` | ADD COLUMN container_image |
| 修改 | `src/db/migrate.ts` | 注册 v50 |
| 修改 | `src/db/repositories/test-pipelines.ts` | containerImage 字段 |
| 新建 | `src/pipeline/executors/docker.ts` | DockerExecutor 类 |
| 修改 | `src/pipeline/types.ts` | StageDefinition.containerImage |
| 修改 | `src/pipeline/graph-builder.ts` | StageContextBase.dockerExecutor + buildScriptNode routing |
| 修改 | `src/pipeline/executor.ts` | 创建/setup DockerExecutor |
| 修改 | `src/pipeline/graph-runner.ts` | finalize 中 teardown |
| 修改 | `web/src/types/index.ts` | TestPipeline.containerImage |
| 修改 | `web/src/pipeline-canvas/types.ts` | StageFields.containerImage |
| 修改 | `web/src/pipeline-canvas/panels/pruneStageFields.ts` | script 节点 containerImage 字段管理 |
| 新建 | `web/src/pipeline-canvas/panels/PipelineSettingsPanel.tsx` | pipeline 级 containerImage 表单 |
| 修改 | `web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx` | 新增"Pipeline 设置"按钮 |
| 修改 | `web/src/pipeline-canvas/PipelineCanvasPage.tsx` | 挂载 PipelineSettingsPanel Drawer |
| 修改 | `web/src/pipeline-canvas/panels/NodeInspector.tsx` | script 节点 containerImage override 字段 |

---

## Task 1: DB Schema + migrate.ts

**Files:**
- Create: `src/db/schema-v50.sql`
- Modify: `src/db/migrate.ts`

- [ ] **Step 1: 创建 schema-v50.sql**

```sql
-- v50: pipeline container image support
ALTER TABLE test_pipelines
  ADD COLUMN IF NOT EXISTS container_image TEXT DEFAULT NULL;
```

保存到 `src/db/schema-v50.sql`。

- [ ] **Step 2: 在 migrate.ts SCHEMA_FILES 末尾追加 v50**

在 `src/db/migrate.ts` 找到 `['v49', 'schema-v49.sql'],` 这一行，在其后追加：

```typescript
  ['v50', 'schema-v50.sql'],
```

- [ ] **Step 3: 本地验证迁移可运行**

```bash
pnpm migrate 2>&1 | tail -5
```

Expected: `✅ Database schema applied via _migrations tracker`（或 `already applied` 类消息）

- [ ] **Step 4: Commit**

```bash
git add src/db/schema-v50.sql src/db/migrate.ts
git commit -m "feat(db): schema-v50 pipeline container_image 列"
```

---

## Task 2: test-pipelines.ts Repository 更新

**Files:**
- Modify: `src/db/repositories/test-pipelines.ts`

- [ ] **Step 1: 在 TestPipeline interface 新增字段**

在 `TestPipeline` interface（约第 4 行）的 `graph: unknown | null` 后加：

```typescript
  containerImage: string | null
```

- [ ] **Step 2: 更新 mapRow**

在 `mapRow` 函数的 `graph: (r.graph ?? null) as unknown,` 后加：

```typescript
    containerImage: (r.container_image ?? null) as string | null,
```

- [ ] **Step 3: 更新 createTestPipeline — 参数接口**

在 `createTestPipeline` 参数对象类型中（`graph?: unknown` 之后）加：

```typescript
  containerImage?: string | null
```

- [ ] **Step 4: 更新 createTestPipeline — INSERT 语句**

将 INSERT 语句中的列列表和 VALUES 改为包含 `container_image`：

旧：
```typescript
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, enabled, trigger_params, variables, artifact_inputs, graph)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [data.productLineId ?? null, data.name, data.description ?? '', JSON.stringify(data.stages ?? []),
     JSON.stringify(data.serverRoles ?? {}), data.enabled ?? true,
     JSON.stringify(data.triggerParams ?? {}), JSON.stringify(data.variables ?? {}),
     JSON.stringify(data.artifactInputs ?? []),
     data.graph !== undefined ? JSON.stringify(data.graph) : null]
  )
```

新：
```typescript
  const { rows } = await pool.query(
    `INSERT INTO test_pipelines (product_line_id, name, description, stages, server_roles, enabled, trigger_params, variables, artifact_inputs, graph, container_image)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [data.productLineId ?? null, data.name, data.description ?? '', JSON.stringify(data.stages ?? []),
     JSON.stringify(data.serverRoles ?? {}), data.enabled ?? true,
     JSON.stringify(data.triggerParams ?? {}), JSON.stringify(data.variables ?? {}),
     JSON.stringify(data.artifactInputs ?? []),
     data.graph !== undefined ? JSON.stringify(data.graph) : null,
     data.containerImage ?? null]
  )
```

- [ ] **Step 5: 更新 updateTestPipeline — 参数接口**

在 `updateTestPipeline` 参数的 `Partial<{...}>` 中（`graph: unknown | null` 之后）加：

```typescript
  containerImage?: string | null
```

- [ ] **Step 6: 更新 updateTestPipeline — UPDATE 语句**

旧（在 `graph = COALESCE($10, graph),` 之后，`updated_at = NOW()` 之前）：

```typescript
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.description ?? null,
     data.stages ? JSON.stringify(data.stages) : null,
     data.serverRoles ? JSON.stringify(data.serverRoles) : null,
     data.enabled ?? null,
     data.triggerParams ? JSON.stringify(data.triggerParams) : null,
     data.variables ? JSON.stringify(data.variables) : null,
     data.artifactInputs ? JSON.stringify(data.artifactInputs) : null,
     data.graph !== undefined ? (data.graph === null ? null : JSON.stringify(data.graph)) : null]
```

新：
```typescript
       container_image = COALESCE($11, container_image),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.description ?? null,
     data.stages ? JSON.stringify(data.stages) : null,
     data.serverRoles ? JSON.stringify(data.serverRoles) : null,
     data.enabled ?? null,
     data.triggerParams ? JSON.stringify(data.triggerParams) : null,
     data.variables ? JSON.stringify(data.variables) : null,
     data.artifactInputs ? JSON.stringify(data.artifactInputs) : null,
     data.graph !== undefined ? (data.graph === null ? null : JSON.stringify(data.graph)) : null,
     data.containerImage !== undefined ? data.containerImage : null]
```

**注意**：`containerImage` 为 `null` 表示清空，`undefined` 表示不修改（COALESCE 保留原值）。由于 SQL 的 `COALESCE($11, container_image)` 当 `$11=null` 时会保留旧值，无法将其清空为 null。需要用不同值来区分"不修改"和"清空"。修改如下：将 `COALESCE($11, container_image)` 改为 `CASE WHEN $11::text = '__CLEAR__' THEN NULL WHEN $11 IS NOT NULL THEN $11 ELSE container_image END`，调用方传 `'__CLEAR__'` 清空，`null` 不修改。

实际上更简单的方式：更新 API 时如果传了 `containerImage`（不管是 string 还是 null）则更新，不传则跳过。改为带条件的动态 SQL，或使用更简单的方式：

将参数值改为：
```typescript
     'containerImage' in data ? (data.containerImage ?? null) : undefined
```

然后修改 SQL 为：
```typescript
       container_image = CASE WHEN $11 IS NOT DISTINCT FROM NULL AND $12 = false THEN container_image
                              ELSE $11 END,
```

这样过于复杂。最简单的方式：不支持清空（设为 null），只支持设置为新值或不修改：

```typescript
     data.containerImage != null ? data.containerImage : null
```

配合 COALESCE：传非 null 字符串 → 更新；传 null/undefined → 不修改（保留旧值）。

前端不需要清空（留空 Input 即代表不清空，只是不传）。把 Task 9 的前端实现设计成"保存时若为空字符串则传 null，null 时不清空"——实际上清空功能通过传空字符串来实现，让后端把空字符串转为 null。

最终简单实现：

```typescript
     // containerImage: 传 null/undefined 保留旧值；传字符串（含空字符串）→ 更新（空串转 null）
     data.containerImage !== undefined ? (data.containerImage === '' ? null : data.containerImage) : null
```

配合 `COALESCE($11, container_image)` 仍不能清空。改用显式条件：

**最终做法**：在 SQL 用 `$11` 直接赋值（不用 COALESCE），只在 `data.containerImage` 有定义时才执行更新（动态 SQL 拼接，或简单处理：传入 `undefined` 时传入 sentinel 空值跳过）。

**最简做法（follow existing pattern）**：`updateTestPipeline` 只在 `data.containerImage` 字段存在（`!== undefined`）时更新 container_image 列；用分支 SQL：

```typescript
export async function updateTestPipeline(id: number, data: Partial<{
  ...
  containerImage?: string | null
}>): Promise<TestPipeline | null> {
  const pool = getPool()
  // 动态构建 SET 子句
  const setClauses: string[] = []
  const values: unknown[] = [id]
  let idx = 2

  const addField = (col: string, val: unknown) => {
    setClauses.push(`${col} = $${idx++}`)
    values.push(val)
  }

  if (data.name !== undefined) addField('name', data.name)
  if (data.description !== undefined) addField('description', data.description)
  // ... etc
```

这改动太大了，会破坏现有代码。

**实际最简做法**：现有 `updateTestPipeline` 用 COALESCE 处理其他字段；对 `container_image` 使用不同方式：因为需要支持清空，用 `CASE WHEN $11::boolean THEN $12 ELSE container_image END` 传一个 flag。

实际上，看了现有代码，`updateTestPipeline` 用 `COALESCE($N, existing_col)` 方式，当传 `null` 时保留旧值。这意味着无法通过此函数将 `container_image` 清空为 null。

**对于本功能：** 这完全 OK。pipeline 的容器 image 设置后可以修改（传新值），不需要"清空"功能。用户如果想关闭 Docker 模式，可以通过 UI 清空 Input，我们在前端处理：**若用户清空了 Input 并保存，前端传空字符串，后端将空字符串存为空字符串（而非 null）。运行时用 `pipeline.containerImage?.trim()` 判断是否启用 Docker 模式**。

这样就不需要"清空到 null"逻辑了。使用 COALESCE 即可：传非 null 字符串 → 更新；不传或传 null → 保留旧值。

**结论**：用 COALESCE，前端保存时若用户清空了 Input，传空字符串（`''`），运行时 `pipeline.containerImage?.trim()` 为空则不启用 Docker。

OK，让我重新整理 Step 6：

- [ ] **Step 6（修订）: 更新 updateTestPipeline**

在 UPDATE SQL 的 `graph = COALESCE($10, graph),` 后加一行：

```
       container_image = COALESCE($11, container_image),
```

在 VALUES 数组末尾加：

```typescript
     data.containerImage ?? null
```

完整修改后的 `updateTestPipeline`：

```typescript
export async function updateTestPipeline(id: number, data: Partial<{
  name: string; description: string; stages: unknown[]
  serverRoles: Record<string, { count: number }>; enabled: boolean
  triggerParams: Record<string, unknown>; variables: Record<string, string>
  artifactInputs: unknown[]
  graph: unknown | null
  containerImage?: string | null
}>): Promise<TestPipeline | null> {
  const pool = getPool()
  const { rows } = await pool.query(
    `UPDATE test_pipelines SET
       name = COALESCE($2, name), description = COALESCE($3, description),
       stages = COALESCE($4, stages), server_roles = COALESCE($5, server_roles),
       enabled = COALESCE($6, enabled),
       trigger_params = COALESCE($7, trigger_params),
       variables = COALESCE($8, variables),
       artifact_inputs = COALESCE($9, artifact_inputs),
       graph = COALESCE($10, graph),
       container_image = COALESCE($11, container_image),
       updated_at = NOW()
     WHERE id = $1 RETURNING *`,
    [id, data.name ?? null, data.description ?? null,
     data.stages ? JSON.stringify(data.stages) : null,
     data.serverRoles ? JSON.stringify(data.serverRoles) : null,
     data.enabled ?? null,
     data.triggerParams ? JSON.stringify(data.triggerParams) : null,
     data.variables ? JSON.stringify(data.variables) : null,
     data.artifactInputs ? JSON.stringify(data.artifactInputs) : null,
     data.graph !== undefined ? (data.graph === null ? null : JSON.stringify(data.graph)) : null,
     data.containerImage ?? null]
  )
  return rows[0] ? mapRow(rows[0]) : null
}
```

- [ ] **Step 7: Commit**

```bash
git add src/db/repositories/test-pipelines.ts
git commit -m "feat(repo): test-pipelines 支持 containerImage 字段"
```

---

## Task 3: DockerExecutor

**Files:**
- Create: `src/pipeline/executors/docker.ts`

- [ ] **Step 1: 新建目录和文件**

```bash
mkdir -p src/pipeline/executors
```

- [ ] **Step 2: 写 DockerExecutor**

新建 `src/pipeline/executors/docker.ts`，完整内容：

```typescript
import { spawn } from 'child_process'

interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
}

function spawnAsync(cmd: string, args: string[]): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args)
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    proc.on('close', (code) => resolve({ exitCode: code ?? 0, stdout, stderr }))
    proc.on('error', reject)
  })
}

export class DockerExecutor {
  private containerName = ''
  private ready = false

  constructor(private readonly image: string) {}

  /** Pull image and start a detached container that stays alive via `sleep infinity`. */
  async setup(containerName: string): Promise<void> {
    this.containerName = containerName

    const pull = await spawnAsync('docker', ['pull', this.image])
    if (pull.exitCode !== 0) {
      throw new Error(`Failed to pull image ${this.image}: ${pull.stderr.trim()}`)
    }

    const run = await spawnAsync('docker', [
      'run', '-d',
      '--name', this.containerName,
      '-w', '/workspace',
      this.image,
      'sleep', 'infinity',
    ])
    if (run.exitCode !== 0) {
      throw new Error(`Failed to start container ${this.containerName}: ${run.stderr.trim()}`)
    }

    this.ready = true
  }

  /** Execute a shell command inside the running container. */
  async exec(command: string): Promise<ExecResult> {
    if (!this.ready) throw new Error('DockerExecutor.setup() has not been called')
    return spawnAsync('docker', ['exec', this.containerName, 'sh', '-c', command])
  }

  /** Force-remove the container. Safe to call even if container doesn't exist. */
  async teardown(): Promise<void> {
    if (!this.containerName) return
    await spawnAsync('docker', ['rm', '-f', this.containerName]).catch(() => {})
    this.ready = false
  }
}
```

- [ ] **Step 3: 写单元测试**

新建 `src/__tests__/unit/docker-executor.test.ts`：

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as childProcess from 'child_process'
import { EventEmitter } from 'events'
import { DockerExecutor } from '../../pipeline/executors/docker.js'

function mockSpawn(exitCode = 0, stdout = '', stderr = '') {
  const proc = new EventEmitter() as ReturnType<typeof childProcess.spawn>
  ;(proc as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stdout = new EventEmitter()
  ;(proc as unknown as { stdout: EventEmitter; stderr: EventEmitter }).stderr = new EventEmitter()
  setImmediate(() => {
    (proc as unknown as { stdout: EventEmitter }).stdout.emit('data', Buffer.from(stdout))
    ;(proc as unknown as { stderr: EventEmitter }).stderr.emit('data', Buffer.from(stderr))
    proc.emit('close', exitCode)
  })
  return proc
}

describe('DockerExecutor', () => {
  let spawnSpy: ReturnType<typeof vi.spyOn>
  let callArgs: string[][]

  beforeEach(() => {
    callArgs = []
    spawnSpy = vi.spyOn(childProcess, 'spawn').mockImplementation((_cmd, args) => {
      callArgs.push(args as string[])
      return mockSpawn(0)
    })
  })

  it('setup: calls docker pull then docker run -d', async () => {
    const exec = new DockerExecutor('node:18')
    await exec.setup('chatops-run-42')
    expect(callArgs[0]).toEqual(['pull', 'node:18'])
    expect(callArgs[1]).toContain('run')
    expect(callArgs[1]).toContain('chatops-run-42')
    expect(callArgs[1]).toContain('sleep')
  })

  it('exec: calls docker exec with sh -c', async () => {
    const executor = new DockerExecutor('node:18')
    await executor.setup('chatops-run-42')
    await executor.exec('echo hello')
    const execArgs = callArgs.find(a => a[0] === 'exec')!
    expect(execArgs).toContain('chatops-run-42')
    expect(execArgs).toContain('echo hello')
  })

  it('teardown: calls docker rm -f', async () => {
    const executor = new DockerExecutor('node:18')
    await executor.setup('chatops-run-42')
    await executor.teardown()
    const rmArgs = callArgs.find(a => a[0] === 'rm')!
    expect(rmArgs).toContain('-f')
    expect(rmArgs).toContain('chatops-run-42')
  })

  it('setup fails if docker pull returns non-zero', async () => {
    spawnSpy.mockImplementationOnce(() => mockSpawn(1, '', 'image not found'))
    const executor = new DockerExecutor('nonexistent:image')
    await expect(executor.setup('chatops-run-1')).rejects.toThrow('Failed to pull image')
  })

  it('exec throws if setup not called', async () => {
    const executor = new DockerExecutor('node:18')
    await expect(executor.exec('ls')).rejects.toThrow('setup() has not been called')
  })
})
```

- [ ] **Step 4: 运行测试验证**

```bash
npx vitest run src/__tests__/unit/docker-executor.test.ts
```

Expected: 5 tests pass

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/executors/docker.ts src/__tests__/unit/docker-executor.test.ts
git commit -m "feat(pipeline): DockerExecutor — docker run/exec/rm 封装"
```

---

## Task 4: types.ts + StageContextBase 更新

**Files:**
- Modify: `src/pipeline/types.ts`
- Modify: `src/pipeline/graph-builder.ts`

- [ ] **Step 1: 在 StageDefinition 加 containerImage 字段**

在 `src/pipeline/types.ts` 的 `StageDefinition` interface 中，在 `script?: string` 之后加：

```typescript
  containerImage?: string
```

- [ ] **Step 2: 在 StageContextBase 加 dockerExecutor 字段**

在 `src/pipeline/graph-builder.ts` 中找到 `export interface StageContextBase {` 定义（约第 70 行），在最后一个字段 `triggerUserId?: string` 之后加：

```typescript
  /** DockerExecutor instance for script nodes without a role. Set by executor.ts when pipeline.containerImage is configured. */
  dockerExecutor?: import('./executors/docker.js').DockerExecutor
```

- [ ] **Step 3: 类型检查**

```bash
./test.sh --typecheck 2>&1 | tail -10
```

Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/pipeline/types.ts src/pipeline/graph-builder.ts
git commit -m "feat(types): StageDefinition.containerImage + StageContextBase.dockerExecutor"
```

---

## Task 5: graph-builder.ts buildScriptNode Docker routing

**Files:**
- Modify: `src/pipeline/graph-builder.ts`

- [ ] **Step 1: 添加 runScriptInDocker helper**

在 `src/pipeline/graph-builder.ts` 的 `buildScriptNode` 函数定义之前（约第 214 行），插入：

```typescript
import type { DockerExecutor } from './executors/docker.js'
import { resolveVariables, type VariableContext } from './variables.js'
```

（如果 `resolveVariables` 已经 import 则跳过）

然后在 `buildScriptNode` 之前插入 helper 函数：

```typescript
async function runScriptInDocker(
  stage: StageDefinition,
  ctxBase: StageContextBase,
  stageIndex: number,
  executor: DockerExecutor,
): Promise<StageExecutionResult> {
  const script = stage.script ?? ''
  if (!script.trim()) return { status: 'success', output: 'No script to execute' }

  const varCtx: VariableContext = {
    productLine: ctxBase.productLine ?? { name: '', displayName: '' },
    pipeline: ctxBase.pipeline ?? { id: ctxBase.runId, name: '' },
    run: ctxBase.run ?? { id: ctxBase.runId, triggeredBy: '', triggerType: '' },
    stage: { name: stage.name, index: stageIndex },
    server: { host: '', port: 0, username: '', name: '', role: '' },
    vars: (ctxBase.variables ?? {}) as Record<string, string>,
  }
  const resolvedScript = resolveVariables(script, varCtx)

  const result = await executor.exec(resolvedScript)
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n')
  if (result.exitCode !== 0) {
    return { status: 'failed', output, error: `exit code ${result.exitCode}` }
  }
  return { status: 'success', output }
}
```

- [ ] **Step 2: 修改 buildScriptNode**

找到 `buildScriptNode` 函数（约第 222 行）。当前实现：

```typescript
function buildScriptNode(
  stage: StageDefinition,
  index: number,
  ctxBase: StageContextBase,
  hooks: StageHooks,
) {
  return async () => {
    const targetServers = resolveTargetServers(stage, ctxBase.servers)
    if (targetServers.length === 0) {
      return {
        currentStageIndex: index,
        stageResults: skippedResult(stage, 'No servers for target roles'),
      }
    }
    const startedAt = nowIso()
    const startedMs = Date.now()
    const ctx: StageContext = { ...ctxBase, stageIndex: index }
    let exec: StageExecutionResult
    try {
      exec = await hooks.runScript(stage, ctx, targetServers)
    } catch (err) {
      exec = {
        status: 'failed',
        output: `script hook error: ${String(err)}`,
        error: String(err),
      }
    }
    return {
      currentStageIndex: index,
      stageResults: finishedResult(stage, startedAt, startedMs, exec),
    }
  }
}
```

替换为：

```typescript
function buildScriptNode(
  stage: StageDefinition,
  index: number,
  ctxBase: StageContextBase,
  hooks: StageHooks,
) {
  return async () => {
    const targetServers = resolveTargetServers(stage, ctxBase.servers)
    const startedAt = nowIso()
    const startedMs = Date.now()
    let exec: StageExecutionResult

    if (targetServers.length > 0) {
      // SSH path — existing behaviour unchanged
      const ctx: StageContext = { ...ctxBase, stageIndex: index }
      try {
        exec = await hooks.runScript(stage, ctx, targetServers)
      } catch (err) {
        exec = { status: 'failed', output: `script hook error: ${String(err)}`, error: String(err) }
      }
    } else {
      // Docker path
      const nodeImage = stage.containerImage?.trim()
      if (nodeImage) {
        // Per-node override: spin up a dedicated container just for this node
        const { DockerExecutor } = await import('./executors/docker.js')
        const containerName = `chatops-node-${ctxBase.runId}-${index}`
        const nodeExecutor = new DockerExecutor(nodeImage)
        await nodeExecutor.setup(containerName)
        try {
          exec = await runScriptInDocker(stage, ctxBase, index, nodeExecutor)
        } finally {
          await nodeExecutor.teardown()
        }
      } else if (ctxBase.dockerExecutor) {
        // Pipeline-level shared executor
        exec = await runScriptInDocker(stage, ctxBase, index, ctxBase.dockerExecutor)
      } else {
        exec = {
          status: 'failed',
          output: 'No executor configured: set a role or container image',
          error: 'no_executor',
        }
      }
    }

    return {
      currentStageIndex: index,
      stageResults: finishedResult(stage, startedAt, startedMs, exec),
    }
  }
}
```

- [ ] **Step 3: 写 buildScriptNode Docker routing 单元测试**

在 `src/__tests__/unit/graph-builder.test.ts`（已存在）中找到 script 节点测试区域，添加以下测试（追加到文件末尾或合适位置）：

```typescript
describe('buildScriptNode Docker routing', () => {
  it('routes to dockerExecutor when no targetRoles and dockerExecutor present', async () => {
    const execMock = vi.fn().mockResolvedValue({ exitCode: 0, stdout: 'hello', stderr: '' })
    const teardownMock = vi.fn().mockResolvedValue(undefined)
    const mockExecutor = { exec: execMock, teardown: teardownMock, setup: vi.fn() } as unknown as import('../../pipeline/executors/docker.js').DockerExecutor

    const stage: StageDefinition = {
      name: 'docker-step',
      stageType: 'script',
      targetRoles: [],
      parallel: false,
      timeoutSeconds: 60,
      retryCount: 0,
      onFailure: 'stop',
      script: 'echo hello',
    }

    // Build a minimal graph with one docker script node
    const node: PipelineNode = { ...stage, id: 'n1', position: { x: 0, y: 0 } }
    const graph: PipelineGraph = {
      nodes: [node],
      edges: [],
    }
    const ctxBase: StageContextBase = {
      runId: 1,
      servers: {},
      logDir: '/tmp',
      dockerExecutor: mockExecutor,
    }

    const compiled = buildGraphFromPipeline(graph, ctxBase, {}, {})
    // Run through graph stream
    const result = await compiled.invoke({ currentStageIndex: 0, stageResults: [] }, { configurable: { thread_id: 'test' } })
    
    expect(execMock).toHaveBeenCalledWith('echo hello')
    expect(result.stageResults[0]?.status).toBe('success')
  })

  it('returns failed when no targetRoles and no executor configured', async () => {
    const stage: StageDefinition = {
      name: 'orphan-step',
      stageType: 'script',
      targetRoles: [],
      parallel: false,
      timeoutSeconds: 60,
      retryCount: 0,
      onFailure: 'continue',
      script: 'echo test',
    }
    const node: PipelineNode = { ...stage, id: 'n1', position: { x: 0, y: 0 } }
    const graph: PipelineGraph = { nodes: [node], edges: [] }
    const ctxBase: StageContextBase = { runId: 1, servers: {}, logDir: '/tmp' }

    const compiled = buildGraphFromPipeline(graph, ctxBase, {}, {})
    const result = await compiled.invoke({ currentStageIndex: 0, stageResults: [] }, { configurable: { thread_id: 'test-2' } })
    
    expect(result.stageResults[0]?.status).toBe('failed')
    expect(result.stageResults[0]?.output).toContain('No executor configured')
  })
})
```

**注意**：检查 `graph-builder.test.ts` 现有的 import 语句，确认 `buildGraphFromPipeline`、`PipelineGraph`、`PipelineNode`、`StageDefinition`、`StageContextBase` 均已 import。如缺少则补充。

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/__tests__/unit/graph-builder.test.ts
```

Expected: existing tests still pass + 2 new tests pass

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/graph-builder.ts src/__tests__/unit/graph-builder.test.ts
git commit -m "feat(pipeline): buildScriptNode Docker routing — role→SSH, no-role→Docker"
```

---

## Task 6: executor.ts DockerExecutor 生命周期

**Files:**
- Modify: `src/pipeline/executor.ts`

- [ ] **Step 1: 在 executor.ts 顶部新增 import**

在 `src/pipeline/executor.ts` 已有的 import 块末尾追加：

```typescript
import { DockerExecutor } from './executors/docker.js'
```

- [ ] **Step 2: 在 stageContext 构建后创建 DockerExecutor**

找到 `executor.ts` 中构建 `stageContext` 的代码块（约第 152 行）：

```typescript
  const stageContext: StageContextBase = {
    runId: run.id,
    servers: serverMap,
    logDir,
    ...
  }
```

在 `const hooks = buildDefaultHooks(logDir)` 之前，`stageContext` 定义之后，插入：

```typescript
  // Docker executor: create and setup if pipeline has a default container image.
  let dockerExecutor: DockerExecutor | undefined
  const pipelineContainerImage = (pipeline as unknown as { containerImage?: string }).containerImage?.trim()
  if (pipelineContainerImage) {
    dockerExecutor = new DockerExecutor(pipelineContainerImage)
    await dockerExecutor.setup(`chatops-run-${run.id}`)
    stageContext.dockerExecutor = dockerExecutor
  }
```

**注意**：`getTestPipelineById` 返回的 `TestPipeline` 类型在本 Task 中已包含 `containerImage`（Task 2），但 `executor.ts` 拿到的类型可能需要类型断言直到类型传播到位。如遇 TS 错误，改用 `(pipeline as TestPipeline & { containerImage?: string })` 直到 Task 2 的类型更新生效。

- [ ] **Step 3: 在 run 失败时 teardown**

在 `resolveError` 处理的 `if (resolveError)` 块（约第 117 行，`await finishTestRun(run.id, 'failed', ...)` 之前），在 `finishTestRun` 之前加：

```typescript
  if (resolveError) {
    await dockerExecutor?.teardown().catch(() => {})
    await finishTestRun(run.id, 'failed', '', `制品输入解析失败: ${resolveError.message}`)
    return run.id
  }
```

- [ ] **Step 4: 类型检查**

```bash
./test.sh --typecheck 2>&1 | tail -10
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add src/pipeline/executor.ts
git commit -m "feat(pipeline): executor.ts 创建/setup DockerExecutor"
```

---

## Task 7: graph-runner.ts finalize 中 teardown

**Files:**
- Modify: `src/pipeline/graph-runner.ts`

- [ ] **Step 1: 在 finalize 函数开头添加 teardown**

在 `src/pipeline/graph-runner.ts` 找到 `async function finalize(ctx: RunContext, opts: ... = {})` 函数体（约第 462 行）。

在函数体最开始（`const meta = runRegistry.get(ctx.runId)` 之前），插入：

```typescript
  // Tear down Docker container if used (before any async DB ops so cleanup
  // happens even if downstream throws; ignore teardown failures).
  await ctx.stageContext.dockerExecutor?.teardown().catch((err: unknown) =>
    console.warn('[graph-runner] docker teardown failed:', err),
  )
```

- [ ] **Step 2: 类型检查**

```bash
./test.sh --typecheck 2>&1 | tail -10
```

Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/graph-runner.ts
git commit -m "feat(pipeline): graph-runner finalize teardown DockerExecutor"
```

---

## Task 8: 前端类型更新 + pruneStageFields

**Files:**
- Modify: `web/src/types/index.ts`
- Modify: `web/src/pipeline-canvas/types.ts`
- Modify: `web/src/pipeline-canvas/panels/pruneStageFields.ts`

- [ ] **Step 1: 在 TestPipeline interface 加 containerImage**

在 `web/src/types/index.ts` 的 `TestPipeline` interface（第 67 行）中，在 `schedule?: string` 之前加：

```typescript
  containerImage?: string | null
```

- [ ] **Step 2: 在 StageFields 加 containerImage**

在 `web/src/pipeline-canvas/types.ts` 的 `StageFields` interface（约第 33 行），在 `script?: string` 之后加：

```typescript
  containerImage?: string
```

- [ ] **Step 3: 更新 pruneStageFields**

在 `web/src/pipeline-canvas/panels/pruneStageFields.ts` 的 `cleared` 对象（约第 27 行）中，在 `script: undefined` 之后加：

```typescript
    containerImage: undefined,
```

在 `case 'script':` 的返回（约第 38 行）保持 `containerImage` 不变（切换到 script 时保留已有值；切换离开时由 `cleared` 清空）：

```typescript
    case 'script':
      return { ...base, ...cleared, script: '', containerImage: prev.stageType === 'script' ? prev.containerImage : undefined }
```

- [ ] **Step 4: 类型检查**

```bash
cd web && pnpm build 2>&1 | tail -10
```

Expected: build succeeds（or only unrelated warnings）

- [ ] **Step 5: Commit**

```bash
git add web/src/types/index.ts web/src/pipeline-canvas/types.ts web/src/pipeline-canvas/panels/pruneStageFields.ts
git commit -m "feat(frontend): 前端类型 TestPipeline + StageFields 新增 containerImage"
```

---

## Task 9: PipelineSettingsPanel + CanvasToolbar + PipelineCanvasPage

Pipeline 级别 `containerImage` 的编辑入口：CanvasToolbar 新增"Pipeline 设置"按钮，点击打开 Drawer，内含 `PipelineSettingsPanel`。

**Files:**
- Create: `web/src/pipeline-canvas/panels/PipelineSettingsPanel.tsx`
- Modify: `web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx`
- Modify: `web/src/pipeline-canvas/PipelineCanvasPage.tsx`

- [ ] **Step 1: 创建 PipelineSettingsPanel.tsx**

新建 `web/src/pipeline-canvas/panels/PipelineSettingsPanel.tsx`：

```tsx
import { Form, Input, Button, message } from 'antd'
import { updateTestPipeline } from '../../api/test-pipelines'
import type { TestPipeline } from '../../types'

interface Props {
  pipeline: TestPipeline
  onSaved: (updated: TestPipeline) => void
}

export default function PipelineSettingsPanel({ pipeline, onSaved }: Props) {
  const [form] = Form.useForm<{ containerImage: string }>()

  const handleSave = async () => {
    const values = await form.validateFields()
    const image = values.containerImage?.trim() ?? ''
    try {
      const updated = await updateTestPipeline(pipeline.id, { containerImage: image || null })
      onSaved(updated)
      void message.success('已保存')
    } catch {
      void message.error('保存失败')
    }
  }

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={{ containerImage: pipeline.containerImage ?? '' }}
    >
      <Form.Item
        name="containerImage"
        label="默认容器镜像"
        extra="script 节点无 role 时使用此 image 在本机 Docker 容器内执行；留空则关闭 Docker 模式"
      >
        <Input placeholder="例如：node:18、harbor.internal/myapp:latest" allowClear />
      </Form.Item>
      <Form.Item>
        <Button type="primary" onClick={handleSave}>保存</Button>
      </Form.Item>
    </Form>
  )
}
```

- [ ] **Step 2: 更新 CanvasToolbar — 新增 onSettings prop 和按钮**

在 `web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx` 的 `Props` interface 中（`onWebhooks?: () => void` 之后）加：

```typescript
  onSettings?: () => void
```

在 JSX 中，找到 Webhook 按钮附近，加一个 Settings 按钮：

在 `{p.onWebhooks && <Button onClick={p.onWebhooks}>Webhook 触发器</Button>}` 之前插入：

```tsx
        {p.onSettings && (
          <Button onClick={p.onSettings}>Pipeline 设置</Button>
        )}
```

- [ ] **Step 3: 更新 PipelineCanvasPage — 挂载 Drawer**

在 `web/src/pipeline-canvas/PipelineCanvasPage.tsx` 中：

**3a. 新增 import**（在已有 import 块末尾）：
```tsx
import PipelineSettingsPanel from './panels/PipelineSettingsPanel'
```

**3b. 新增 state**（在 `const [webhooksOpen, setWebhooksOpen] = useState(false)` 附近）：
```tsx
const [settingsOpen, setSettingsOpen] = useState(false)
```

**3c. 更新 CanvasToolbar** 调用，加 `onSettings` prop：
```tsx
onSettings={() => setSettingsOpen(true)}
```

**3d. 新增 Settings Drawer**（在 Webhooks Drawer 之后）：
```tsx
        <Drawer
          title="Pipeline 设置"
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          width={480}
          destroyOnClose
        >
          {pipeline && (
            <PipelineSettingsPanel
              pipeline={pipeline}
              onSaved={(updated) => {
                setPipeline(updated)
                setSettingsOpen(false)
              }}
            />
          )}
        </Drawer>
```

**注意**：`setPipeline` 是 `PipelineCanvasPage` 的 state setter。检查 `useState` 定义确保变量名正确（可能是 `setPipeline`）。

- [ ] **Step 4: 构建检查**

```bash
cd web && pnpm build 2>&1 | tail -10
```

Expected: no TypeScript errors

- [ ] **Step 5: Commit**

```bash
git add web/src/pipeline-canvas/panels/PipelineSettingsPanel.tsx \
        web/src/pipeline-canvas/toolbar/CanvasToolbar.tsx \
        web/src/pipeline-canvas/PipelineCanvasPage.tsx
git commit -m "feat(frontend): PipelineSettingsPanel — pipeline 级 containerImage 配置"
```

---

## Task 10: NodeInspector — Script 节点 containerImage Override

**Files:**
- Modify: `web/src/pipeline-canvas/panels/NodeInspector.tsx`

- [ ] **Step 1: 找到 script 节点表单区域**

在 `NodeInspector.tsx` 的 JSX 中找到以下代码（约第 408 行）：

```tsx
if (t === 'script') return (
  <>
    <Form.Item name="targetRoles" label="目标角色">
      <Select mode="multiple" options={availableRoles.map(r => ({ value: r, label: r }))} />
    </Form.Item>
    <Form.Item name="script" label="脚本">
      <Input.TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 12 }} />
    </Form.Item>
  </>
)
```

- [ ] **Step 2: 加入 containerImage 字段**

将上述代码改为：

```tsx
if (t === 'script') {
  const roles: string[] = getFieldValue('targetRoles') ?? []
  const hasRoles = roles.length > 0
  const inheritedImage = pipeline?.containerImage ?? null
  return (
    <>
      <Form.Item name="targetRoles" label="目标角色">
        <Select mode="multiple" options={availableRoles.map(r => ({ value: r, label: r }))} />
      </Form.Item>
      <Form.Item
        name="containerImage"
        label="容器镜像（覆盖 pipeline 默认）"
        extra={
          hasRoles
            ? '已配置 role，此节点走 SSH 执行'
            : inheritedImage
              ? `继承自 pipeline：${inheritedImage}`
              : '无 pipeline 默认镜像，需填写或为该节点配置 role'
        }
      >
        <Input
          placeholder="留空则继承 pipeline 默认"
          disabled={hasRoles}
          allowClear
        />
      </Form.Item>
      <Form.Item name="script" label="脚本">
        <Input.TextArea rows={8} style={{ fontFamily: 'monospace', fontSize: 12 }} />
      </Form.Item>
    </>
  )
}
```

**注意**：
- `pipeline` 对象需要从组件 props 传入（或从 context 获取）。检查 `NodeInspector` 的 `Props` interface，如果已有 `pipelineId` 但没有 `pipeline` 对象，可以通过 parent（`PipelineCanvasPage`）传入完整 `pipeline` 对象，或只传 `pipelineContainerImage?: string | null` 字段。
- 推荐：在 `Props` 中加 `pipelineContainerImage?: string | null`，在 `PipelineCanvasPage` 中传 `pipeline?.containerImage`。

**Step 2b: 更新 Props**

在 `NodeInspector` 的 `Props` interface 中，在已有字段末尾加：

```typescript
  pipelineContainerImage?: string | null
```

**Step 2c: 更新 JSX 使用**

将上面 `inheritedImage` 改为：

```typescript
const inheritedImage = pipelineContainerImage ?? null
```

**Step 2d: 更新 PipelineCanvasPage 中的 NodeInspector 调用**

找到 `<NodeInspector` 组件调用，加：

```tsx
pipelineContainerImage={pipeline?.containerImage}
```

- [ ] **Step 3: 确认 Form 的 containerImage 值能被 onChange 保存**

在 `NodeInspector.tsx` 中找到 `onChange(node!.id, all)` 的调用（约第 293 行）。确认 `all` 来自 `form.getFieldsValue()`，这会自动包含 `containerImage` 字段（因为它已注册为 `Form.Item name="containerImage"`）。无需额外改动。

- [ ] **Step 4: 构建检查**

```bash
cd web && pnpm build 2>&1 | tail -15
```

Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add web/src/pipeline-canvas/panels/NodeInspector.tsx
git commit -m "feat(frontend): NodeInspector script 节点 containerImage override 字段"
```

---

## Self-Review Checklist

- [x] **Spec coverage:**
  - §1 Executor 抽象层 → Task 3 (DockerExecutor) + Task 5 (routing)
  - §2 数据模型 DB 变更 → Task 1 + Task 2
  - §2 TypeScript 类型 → Task 4 + Task 8
  - §3 DockerExecutor lifecycle → Task 3 + Task 6 + Task 7
  - §4.1 Pipeline 级 containerImage UI → Task 9
  - §4.2 NodeInspector override → Task 10
  - §5 错误处理 → Task 5 Step 2（no executor configured）、Task 6 Step 3（teardown on resolveError）、DockerExecutor（pull/run failure throw）
  - §5 并发隔离 → containerName `chatops-run-${runId}` 在 Task 6 + `chatops-node-${runId}-${index}` 在 Task 5
  - §5 Dry-run → 现有 `wrapSideEffect` 已拦截 script 节点；Docker executor 不在 dry-run 中 setup（dryrun-runner 不调用 executor.ts 的 setup 路径）；选"真跑"时 graph-builder 的 Docker 路径会执行（per-node executor 对 dry-run 透明）✅

- [x] **类型一致性:** `dockerExecutor` 在 `StageContextBase`（Task 4）、`executor.ts`（Task 6）、`graph-builder.ts`（Task 5）中均引用 `DockerExecutor`（来自 `./executors/docker.js`）

- [x] **无 placeholder/TODO**
