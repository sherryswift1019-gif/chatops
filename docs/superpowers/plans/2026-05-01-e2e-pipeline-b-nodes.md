# E2E Pipeline B — 节点实现 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Pipeline B 图中除 e2e-fix-agent 和 collect-evidence 以外的全部节点（沙盒生命周期 + 测试主循环），以及 PipelineBState 类型定义。

**Architecture:** 每个节点是纯函数 `(state) => Partial<state>`，通过子进程调用约定脚本，解析 stdout 最后一行 JSON；git 操作直接用 child_process + git CLI；GitLab API 操作通过 resolveGitlabConfig()。

**Tech Stack:** TypeScript, LangGraph Annotation, child_process.spawn, Vitest

**前置条件:** Pipeline A 基础设施计划全部完成（DB repositories）；Plan B2 完成（evidence types）

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 新建 | `src/e2e/pipeline-b/types.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/init-run.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/setup-sandbox.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/deploy-initial.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/discover.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/pick-next-scenario.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/run-scenario.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/reset-iteration-branch.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/redeploy.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/healthcheck.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/mark-green.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/mark-unfixable.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/create-summary-mr.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/finalize-failed.ts` |
| 新建 | `src/e2e/pipeline-b/nodes/teardown-sandbox.ts` |
| 新建 | `src/__tests__/unit/pipeline-b-nodes.test.ts` |

---

### Task 1: PipelineBState 类型 + runScript 工具函数

**Files:**
- 新建: `src/e2e/pipeline-b/types.ts`

- [ ] **Step 1: 写 PipelineBState Annotation + 接口类型**

```typescript
// src/e2e/pipeline-b/types.ts
import { Annotation } from '@langchain/langgraph'

export interface ScenarioInfo {
  id: string
  name: string
  tags: string[]
}

export interface GovernorState {
  perScenarioAttempts: Record<string, number>
  totalElapsedMs: number
  totalAttempts: number
  runStartedAt: number
  limits: {
    maxPerScenarioAttempts: number
    maxRunHours: number
    maxTotalAttempts: number
    maxQueuedRuns: number
  }
}

export interface AiDiagnosis {
  verdict: 'product_bug' | 'test_flakiness' | 'infra_issue' | 'uncertain'
  rootCauseSummary: string
  fixCommitSha: string | null
  fixedFiles: string[]
  success: boolean
  failureReason: string
}

export interface SandboxHandle {
  envId: string
  kind: string
  endpoints: Record<string, string>
  internalRefs: Record<string, unknown>
  containerId?: string
  workdir?: string
}

export const PipelineBState = Annotation.Root({
  runId: Annotation<bigint>(),
  sandboxId: Annotation<bigint | null>({ default: () => null, reducer: (_, v) => v }),
  targetProjectId: Annotation<string>(),
  sourceBranch: Annotation<string>(),
  iterationBranch: Annotation<string>(),
  scenarioFilter: Annotation<{ ids?: string[]; tags?: string[] } | null>({ default: () => null, reducer: (_, v) => v }),
  sandboxHandle: Annotation<SandboxHandle | null>({ default: () => null, reducer: (_, v) => v }),
  projectScripts: Annotation<{ build: string; deploy: string; test: string; fix?: string }>({
    default: () => ({ build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' }),
    reducer: (_, v) => v,
  }),
  pendingScenarios: Annotation<ScenarioInfo[]>({ default: () => [], reducer: (_, v) => v }),
  currentScenario: Annotation<ScenarioInfo | null>({ default: () => null, reducer: (_, v) => v }),
  currentScenarioRunId: Annotation<bigint | null>({ default: () => null, reducer: (_, v) => v }),
  lastScenarioResult: Annotation<'pass' | 'fail' | 'error' | 'timeout' | null>({ default: () => null, reducer: (_, v) => v }),
  lastFixResult: Annotation<AiDiagnosis | null>({ default: () => null, reducer: (_, v) => v }),
  evidenceDirTemp: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  governorState: Annotation<GovernorState>({
    default: () => ({
      perScenarioAttempts: {},
      totalElapsedMs: 0,
      totalAttempts: 0,
      runStartedAt: Date.now(),
      limits: {
        maxPerScenarioAttempts: 3,
        maxRunHours: 4,
        maxTotalAttempts: 30,
        maxQueuedRuns: 2,
      },
    }),
    reducer: (_, v) => v,
  }),
  summaryMrUrl: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
  errorMessage: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
})

export type PipelineBStateType = typeof PipelineBState.State
```

- [ ] **Step 2: 新建 runScript 工具函数（`src/e2e/pipeline-b/run-script.ts`）**

```typescript
// src/e2e/pipeline-b/run-script.ts
import { spawn } from 'child_process'

export interface RunScriptResult {
  exitCode: number
  stdout: string
  stderr: string
  parsed: Record<string, unknown> | null
}

export function parseLastJsonLine(text: string): Record<string, unknown> | null {
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('{')) {
      try { return JSON.parse(line) } catch { /* skip */ }
    }
  }
  return null
}

export async function runScript(
  cmd: string,
  args: string[],
  opts: { timeout?: number; env?: Record<string, string>; cwd?: string } = {},
): Promise<RunScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    let settled = false
    const timer = opts.timeout
      ? setTimeout(() => {
          if (!settled) {
            settled = true
            child.kill('SIGTERM')
            setTimeout(() => child.kill('SIGKILL'), 3000)
            resolve({ exitCode: -1, stdout, stderr: stderr + '\n[timeout]', parsed: null })
          }
        }, opts.timeout)
      : null

    child.on('error', (err) => {
      if (!settled) {
        settled = true
        if (timer) clearTimeout(timer)
        reject(err)
      }
    })

    child.on('close', (code) => {
      if (!settled) {
        settled = true
        if (timer) clearTimeout(timer)
        const exitCode = code ?? -1
        resolve({ exitCode, stdout, stderr, parsed: parseLastJsonLine(stdout) })
      }
    })
  })
}
```

- [ ] **Step 3: Commit**

```bash
git add src/e2e/pipeline-b/types.ts src/e2e/pipeline-b/run-script.ts
git commit -m "feat(e2e): Pipeline B state annotation 类型定义 + runScript 工具函数"
```

---

### Task 2: 沙盒生命周期节点

**Files:**
- 新建: `src/e2e/pipeline-b/nodes/setup-sandbox.ts`
- 新建: `src/e2e/pipeline-b/nodes/deploy-initial.ts`
- 新建: `src/e2e/pipeline-b/nodes/teardown-sandbox.ts`
- 新建: `src/e2e/pipeline-b/nodes/healthcheck.ts`
- 新建: `src/e2e/pipeline-b/nodes/redeploy.ts`

- [ ] **Step 1: 写 setup-sandbox 节点**

```typescript
// src/e2e/pipeline-b/nodes/setup-sandbox.ts
import { writeFileSync, mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { createSandbox, updateSandboxStatus } from '../../../db/repositories/e2e-sandboxes.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType, SandboxHandle } from '../types.js'

export async function setupSandboxNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const deployScript = join(workDir, state.projectScripts.deploy)
  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-handle-'))
  const handleFile = join(handleDir, 'handle.json')

  const result = await runScript(
    deployScript,
    ['provision', `--branch=${state.sourceBranch}`, `--out-handle=${handleFile}`],
    { timeout: 600_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    await updateE2eRunStatus(state.runId, 'failed', { abortReason: `provision failed: ${result.stderr.slice(0, 300)}` })
    throw new Error(`setup-sandbox: provision failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
  }

  let handleJson: Record<string, unknown>
  try {
    const { readFileSync } = await import('fs')
    handleJson = JSON.parse(readFileSync(handleFile, 'utf8'))
  } catch (err) {
    throw new Error(`setup-sandbox: failed to read handle file: ${err}`)
  }

  const sandboxRecord = await createSandbox({
    e2eRunId: state.runId,
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    handle: handleJson,
  })

  const sandboxHandle: SandboxHandle = {
    envId: handleJson.envId as string,
    kind: (handleJson.kind as string) ?? 'docker-compose-local',
    endpoints: (handleJson.endpoints as Record<string, string>) ?? {},
    internalRefs: (handleJson.internalRefs as Record<string, unknown>) ?? {},
    containerId: handleJson.containerId as string | undefined,
    workdir: handleJson.workdir as string | undefined,
  }

  await updateSandboxStatus(sandboxRecord.id, 'ready', { readyAt: new Date() })

  console.log(`[PipelineB:setupSandbox] runId=${state.runId} sandboxId=${sandboxRecord.id} envId=${sandboxHandle.envId}`)
  return {
    sandboxId: sandboxRecord.id,
    sandboxHandle,
  }
}
```

- [ ] **Step 2: 写 deploy-initial 节点**

```typescript
// src/e2e/pipeline-b/nodes/deploy-initial.ts
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function deployInitialNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  if (!state.sandboxHandle) throw new Error('deploy-initial: sandboxHandle is null')

  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const buildScript = join(workDir, state.projectScripts.build)
  const deployScript = join(workDir, state.projectScripts.deploy)

  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-deploy-'))
  const handleFile = join(handleDir, 'handle.json')
  writeFileSync(handleFile, JSON.stringify(state.sandboxHandle))

  const imageName = `chatops-e2e-${state.runId}`
  const imageTag = `iter-${state.iterationBranch.replace(/\//g, '-')}`

  const buildResult = await runScript(buildScript, [], {
    timeout: 900_000,
    cwd: workDir,
    env: {
      IMAGE_NAME: imageName,
      IMAGE_TAG: imageTag,
    },
  })

  if (buildResult.exitCode !== 0) {
    throw new Error(`deploy-initial: build failed (exit ${buildResult.exitCode}): ${buildResult.stderr.slice(0, 400)}`)
  }

  const deployResult = await runScript(
    deployScript,
    ['deploy', `--handle=${handleFile}`],
    { timeout: 300_000, cwd: workDir },
  )

  if (deployResult.exitCode !== 0) {
    throw new Error(`deploy-initial: deploy failed (exit ${deployResult.exitCode}): ${deployResult.stderr.slice(0, 400)}`)
  }

  console.log(`[PipelineB:deployInitial] runId=${state.runId} build+deploy ok`)
  return {}
}
```

- [ ] **Step 3: 写 teardown-sandbox 节点**

```typescript
// src/e2e/pipeline-b/nodes/teardown-sandbox.ts
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { updateSandboxStatus, getSandboxByRunId } from '../../../db/repositories/e2e-sandboxes.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function teardownSandboxNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { sandboxHandle, sandboxId, runId, targetProjectId } = state

  if (!sandboxHandle) {
    console.log(`[PipelineB:teardownSandbox] runId=${runId} no sandboxHandle, skipping`)
    return {}
  }

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) {
    console.warn(`[PipelineB:teardownSandbox] project not found, skipping teardown`)
    return { sandboxHandle: null }
  }

  const workDir = project.workingDir ?? '.'
  const deployScript = join(workDir, state.projectScripts.deploy)
  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-teardown-'))
  const handleFile = join(handleDir, 'handle.json')
  writeFileSync(handleFile, JSON.stringify(sandboxHandle))

  const result = await runScript(
    deployScript,
    ['teardown', `--handle=${handleFile}`],
    { timeout: 120_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    console.warn(`[PipelineB:teardownSandbox] teardown exited ${result.exitCode}: ${result.stderr.slice(0, 200)}`)
  }

  if (sandboxId) {
    await updateSandboxStatus(sandboxId, 'torn_down', { destroyedAt: new Date() }).catch((err) => {
      console.warn(`[PipelineB:teardownSandbox] updateSandboxStatus failed: ${err}`)
    })
  }

  console.log(`[PipelineB:teardownSandbox] runId=${runId} envId=${sandboxHandle.envId} torn down`)
  return { sandboxHandle: null }
}
```

- [ ] **Step 4: 写 healthcheck 节点**

```typescript
// src/e2e/pipeline-b/nodes/healthcheck.ts
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function healthcheckNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  if (!state.sandboxHandle) throw new Error('healthcheck: sandboxHandle is null')

  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const deployScript = join(workDir, state.projectScripts.deploy)
  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-hc-'))
  const handleFile = join(handleDir, 'handle.json')
  writeFileSync(handleFile, JSON.stringify(state.sandboxHandle))

  const result = await runScript(
    deployScript,
    ['healthcheck', `--handle=${handleFile}`],
    { timeout: 60_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    throw new Error(`healthcheck: sandbox not healthy (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
  }

  console.log(`[PipelineB:healthcheck] runId=${state.runId} sandbox healthy`)
  return {}
}
```

- [ ] **Step 5: 写 redeploy 节点**

```typescript
// src/e2e/pipeline-b/nodes/redeploy.ts
import { join } from 'path'
import { writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { updateSandboxStatus, getSandboxByRunId } from '../../../db/repositories/e2e-sandboxes.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function redeployNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  if (!state.sandboxHandle) throw new Error('redeploy: sandboxHandle is null')

  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const deployScript = join(workDir, state.projectScripts.deploy)
  const handleDir = mkdtempSync(join(tmpdir(), 'e2e-redeploy-'))
  const handleFile = join(handleDir, 'handle.json')
  writeFileSync(handleFile, JSON.stringify(state.sandboxHandle))

  if (state.sandboxId) {
    await updateSandboxStatus(state.sandboxId, 'redeploying').catch(() => {})
  }

  const result = await runScript(
    deployScript,
    ['redeploy', `--handle=${handleFile}`],
    { timeout: 300_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    if (state.sandboxId) {
      await updateSandboxStatus(state.sandboxId, 'failed').catch(() => {})
    }
    throw new Error(`redeploy: failed (exit ${result.exitCode}): ${result.stderr.slice(0, 400)}`)
  }

  if (state.sandboxId) {
    await updateSandboxStatus(state.sandboxId, 'ready').catch(() => {})
  }

  console.log(`[PipelineB:redeploy] runId=${state.runId} redeployed ok`)
  return {}
}
```

- [ ] **Step 6: Commit**

```bash
git add src/e2e/pipeline-b/nodes/setup-sandbox.ts src/e2e/pipeline-b/nodes/deploy-initial.ts src/e2e/pipeline-b/nodes/teardown-sandbox.ts src/e2e/pipeline-b/nodes/healthcheck.ts src/e2e/pipeline-b/nodes/redeploy.ts
git commit -m "feat(e2e): Pipeline B 沙盒生命周期节点 (setup/deploy/teardown/healthcheck/redeploy)"
```

---

### Task 3: init_run 节点

**Files:**
- 新建: `src/e2e/pipeline-b/nodes/init-run.ts`

- [ ] **Step 1: 写 init-run 节点**

```typescript
// src/e2e/pipeline-b/nodes/init-run.ts
import { spawn } from 'child_process'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { createE2eRun, updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import type { PipelineBStateType } from '../types.js'

async function gitExec(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}

export async function initRunNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const iterationBranch = `test-iter/${state.runId}`
  const workDir = project.workingDir ?? '.'

  const gitlabConfig = await resolveGitlabConfig()
  const gitEnv: Record<string, string> = gitlabConfig.token
    ? { GIT_ASKPASS: 'echo', GIT_TOKEN: gitlabConfig.token }
    : {}

  const fetchResult = await gitExec(
    ['-C', workDir, 'fetch', 'origin', state.sourceBranch],
    { env: gitEnv },
  )
  if (fetchResult.exitCode !== 0) {
    throw new Error(`init-run: git fetch failed: ${fetchResult.stderr.slice(0, 300)}`)
  }

  const branchCheckResult = await gitExec(['-C', workDir, 'branch', '-r', '--list', `origin/${iterationBranch}`])
  const branchExists = branchCheckResult.stdout.trim().length > 0

  if (branchExists) {
    const checkoutResult = await gitExec(
      ['-C', workDir, 'checkout', iterationBranch],
      { env: gitEnv },
    )
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`init-run: git checkout existing branch failed: ${checkoutResult.stderr.slice(0, 300)}`)
    }
  } else {
    const checkoutResult = await gitExec(
      ['-C', workDir, 'checkout', '-b', iterationBranch, `origin/${state.sourceBranch}`],
      { env: gitEnv },
    )
    if (checkoutResult.exitCode !== 0) {
      throw new Error(`init-run: git checkout -b failed: ${checkoutResult.stderr.slice(0, 300)}`)
    }
  }

  await updateE2eRunStatus(state.runId, 'running', {
    iterationBranch,
    startedAt: new Date(),
  })

  console.log(`[PipelineB:initRun] runId=${state.runId} iterationBranch=${iterationBranch}`)
  return { iterationBranch }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/e2e/pipeline-b/nodes/init-run.ts
git commit -m "feat(e2e): Pipeline B init_run 节点 (DB 记录 + git checkout iteration_branch)"
```

---

### Task 4: 测试执行节点

**Files:**
- 新建: `src/e2e/pipeline-b/nodes/discover.ts`
- 新建: `src/e2e/pipeline-b/nodes/pick-next-scenario.ts`
- 新建: `src/e2e/pipeline-b/nodes/run-scenario.ts`

- [ ] **Step 1: 写 discover 节点**

```typescript
// src/e2e/pipeline-b/nodes/discover.ts
import { join } from 'path'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType, ScenarioInfo } from '../types.js'

export async function discoverNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const testScript = join(workDir, state.projectScripts.test)

  const result = await runScript(
    testScript,
    ['--discover', '--format=json'],
    { timeout: 120_000, cwd: workDir },
  )

  if (result.exitCode !== 0) {
    throw new Error(`discover: test.sh --discover failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
  }

  let scenarios: ScenarioInfo[] = []
  if (result.parsed && Array.isArray(result.parsed.scenarios)) {
    scenarios = result.parsed.scenarios as ScenarioInfo[]
  }

  const { scenarioFilter } = state
  if (scenarioFilter) {
    if (scenarioFilter.ids?.length) {
      const idSet = new Set(scenarioFilter.ids)
      scenarios = scenarios.filter((s) => idSet.has(s.id))
    } else if (scenarioFilter.tags?.length) {
      const tagSet = new Set(scenarioFilter.tags)
      scenarios = scenarios.filter((s) => s.tags.some((t) => tagSet.has(t)))
    }
  }

  console.log(`[PipelineB:discover] runId=${state.runId} found ${scenarios.length} scenarios`)
  return { pendingScenarios: scenarios }
}
```

- [ ] **Step 2: 写 pick-next-scenario 节点**

```typescript
// src/e2e/pipeline-b/nodes/pick-next-scenario.ts
import type { PipelineBStateType } from '../types.js'

export async function pickNextScenarioNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const next = state.pendingScenarios[0] ?? null

  if (!next) {
    console.log(`[PipelineB:pickNextScenario] runId=${state.runId} no pending scenarios`)
    return { currentScenario: null }
  }

  console.log(`[PipelineB:pickNextScenario] runId=${state.runId} next=${next.id} pending=${state.pendingScenarios.length}`)
  return { currentScenario: next }
}
```

- [ ] **Step 3: 写 run-scenario 节点**

```typescript
// src/e2e/pipeline-b/nodes/run-scenario.ts
import { join, mkdirSync } from 'path'
import { tmpdir } from 'os'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import {
  createScenarioRun,
  finishScenarioRun,
  getLatestAttemptNumber,
} from '../../../db/repositories/e2e-scenario-runs.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import { runScript } from '../run-script.js'
import type { PipelineBStateType } from '../types.js'

export async function runScenarioNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { currentScenario, runId, targetProjectId, governorState } = state
  if (!currentScenario) throw new Error('run-scenario: currentScenario is null')

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const testScript = join(workDir, state.projectScripts.test)

  const attemptNumber = (await getLatestAttemptNumber(runId, currentScenario.id)) + 1

  const evidenceRoot = process.env.E2E_EVIDENCE_ROOT ?? '/var/chatops/e2e-evidence'
  const evidenceDir = join(evidenceRoot, String(runId), currentScenario.id, String(attemptNumber))
  mkdirSync(evidenceDir, { recursive: true })

  const scenarioRunRecord = await createScenarioRun({
    e2eRunId: runId,
    scenarioId: currentScenario.id,
    scenarioName: currentScenario.name,
    attemptNumber,
    startedAt: new Date(),
  })

  await updateE2eRunStatus(runId, 'running')

  const timeoutSec = Math.max(60, (governorState.limits.maxRunHours * 3600) / Math.max(1, state.pendingScenarios.length))
  const result = await runScript(
    testScript,
    ['--scenario', currentScenario.id, `--evidence-dir=${evidenceDir}`, `--timeout=${Math.floor(timeoutSec)}`],
    { timeout: (timeoutSec + 30) * 1000, cwd: workDir },
  )

  let scenarioResult: 'pass' | 'fail' | 'error' | 'timeout' = 'error'
  if (result.exitCode === 0) {
    scenarioResult = 'pass'
  } else if (result.exitCode === 1) {
    scenarioResult = (result.parsed?.result as string) === 'timeout' ? 'timeout' : 'fail'
  } else if (result.exitCode === -1) {
    scenarioResult = 'timeout'
  }

  const durationMs = typeof result.parsed?.duration_ms === 'number' ? result.parsed.duration_ms : undefined
  const summary = typeof result.parsed?.summary === 'string' ? result.parsed.summary : undefined

  await finishScenarioRun(scenarioRunRecord.id, scenarioResult, {
    finishedAt: new Date(),
    durationMs,
    evidenceDirUri: evidenceDir,
  })

  const newGovernorState = {
    ...governorState,
    totalAttempts: governorState.totalAttempts + 1,
    perScenarioAttempts: {
      ...governorState.perScenarioAttempts,
      [currentScenario.id]: (governorState.perScenarioAttempts[currentScenario.id] ?? 0) + 1,
    },
    totalElapsedMs: Date.now() - governorState.runStartedAt,
  }

  console.log(`[PipelineB:runScenario] runId=${runId} scenario=${currentScenario.id} attempt=${attemptNumber} result=${scenarioResult}`)
  return {
    lastScenarioResult: scenarioResult,
    currentScenarioRunId: scenarioRunRecord.id,
    evidenceDirTemp: evidenceDir,
    governorState: newGovernorState,
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/e2e/pipeline-b/nodes/discover.ts src/e2e/pipeline-b/nodes/pick-next-scenario.ts src/e2e/pipeline-b/nodes/run-scenario.ts
git commit -m "feat(e2e): Pipeline B 测试执行节点 (discover + pick_next_scenario + run_scenario)"
```

---

### Task 5: 修复辅助节点

**Files:**
- 新建: `src/e2e/pipeline-b/nodes/reset-iteration-branch.ts`
- 新建: `src/e2e/pipeline-b/nodes/mark-green.ts`
- 新建: `src/e2e/pipeline-b/nodes/mark-unfixable.ts`

- [ ] **Step 1: 写 reset-iteration-branch 节点**

```typescript
// src/e2e/pipeline-b/nodes/reset-iteration-branch.ts
import { spawn } from 'child_process'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import type { PipelineBStateType } from '../types.js'

async function gitExec(args: string[], opts: { env?: Record<string, string> } = {}): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      env: { ...process.env, ...(opts.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
    child.on('error', reject)
    child.on('close', (code) => resolve({ exitCode: code ?? -1, stdout, stderr }))
  })
}

export async function resetIterationBranchNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const project = await getE2eTargetProject(state.targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${state.targetProjectId}" not found`)

  const workDir = project.workingDir ?? '.'
  const gitlabConfig = await resolveGitlabConfig()
  const gitEnv: Record<string, string> = gitlabConfig.token
    ? { GIT_ASKPASS: 'echo', GIT_TOKEN: gitlabConfig.token }
    : {}

  const fetchResult = await gitExec(
    ['-C', workDir, 'fetch', 'origin'],
    { env: gitEnv },
  )
  if (fetchResult.exitCode !== 0) {
    throw new Error(`reset-iteration-branch: git fetch failed: ${fetchResult.stderr.slice(0, 300)}`)
  }

  const resetResult = await gitExec(
    ['-C', workDir, 'reset', '--hard', `origin/${state.sourceBranch}`],
  )
  if (resetResult.exitCode !== 0) {
    throw new Error(`reset-iteration-branch: git reset failed: ${resetResult.stderr.slice(0, 300)}`)
  }

  console.log(`[PipelineB:resetIterationBranch] runId=${state.runId} reset to origin/${state.sourceBranch}`)
  return {}
}
```

- [ ] **Step 2: 写 mark-green 节点**

```typescript
// src/e2e/pipeline-b/nodes/mark-green.ts
import type { PipelineBStateType } from '../types.js'

export async function markGreenNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { currentScenario, pendingScenarios, runId } = state
  if (!currentScenario) return {}

  const remaining = pendingScenarios.filter((s) => s.id !== currentScenario.id)

  console.log(`[PipelineB:markGreen] runId=${runId} scenario=${currentScenario.id} PASSED remaining=${remaining.length}`)
  return {
    pendingScenarios: remaining,
    currentScenario: null,
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
  }
}
```

- [ ] **Step 3: 写 mark-unfixable 节点**

```typescript
// src/e2e/pipeline-b/nodes/mark-unfixable.ts
import { finishScenarioRun } from '../../../db/repositories/e2e-scenario-runs.js'
import type { PipelineBStateType } from '../types.js'

export async function markUnfixableNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { currentScenario, currentScenarioRunId, pendingScenarios, runId, lastFixResult } = state
  if (!currentScenario) return {}

  if (currentScenarioRunId) {
    const aiDiagnosis = lastFixResult ?? {
      verdict: 'uncertain' as const,
      rootCauseSummary: 'max fix attempts exceeded',
      fixCommitSha: null,
      fixedFiles: [],
      success: false,
      failureReason: 'exhausted all fix attempts',
    }
    await finishScenarioRun(currentScenarioRunId, 'unfixable', {
      finishedAt: new Date(),
      evidenceManifest: { aiDiagnosis },
    }).catch((err) => {
      console.warn(`[PipelineB:markUnfixable] finishScenarioRun failed: ${err}`)
    })
  }

  const remaining = pendingScenarios.filter((s) => s.id !== currentScenario.id)

  console.log(`[PipelineB:markUnfixable] runId=${runId} scenario=${currentScenario.id} UNFIXABLE remaining=${remaining.length}`)
  return {
    pendingScenarios: remaining,
    currentScenario: null,
    currentScenarioRunId: null,
    lastScenarioResult: null,
    lastFixResult: null,
    evidenceDirTemp: null,
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/e2e/pipeline-b/nodes/reset-iteration-branch.ts src/e2e/pipeline-b/nodes/mark-green.ts src/e2e/pipeline-b/nodes/mark-unfixable.ts
git commit -m "feat(e2e): Pipeline B 修复辅助节点 (reset_iteration_branch + mark_green + mark_unfixable)"
```

---

### Task 6: 终止节点

**Files:**
- 新建: `src/e2e/pipeline-b/nodes/create-summary-mr.ts`
- 新建: `src/e2e/pipeline-b/nodes/finalize-failed.ts`

- [ ] **Step 1: 写 create-summary-mr 节点**

```typescript
// src/e2e/pipeline-b/nodes/create-summary-mr.ts
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import type { PipelineBStateType } from '../types.js'

export async function createSummaryMrNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { runId, iterationBranch, sourceBranch, targetProjectId } = state

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: "${targetProjectId}" not found`)

  const gitlabConfig = await resolveGitlabConfig()
  if (!gitlabConfig.url || !gitlabConfig.token) {
    console.warn(`[PipelineB:createSummaryMr] gitlab config incomplete, skipping MR creation`)
    await updateE2eRunStatus(runId, 'passed', { finishedAt: new Date() })
    return {}
  }

  const encodedRepo = encodeURIComponent(project.gitlabRepo)
  const apiUrl = `${gitlabConfig.url.replace(/\/$/, '')}/api/v4/projects/${encodedRepo}/merge_requests`

  const body = {
    source_branch: iterationBranch,
    target_branch: sourceBranch,
    title: `e2e: auto-fix run #${runId}`,
    description: `由 Pipeline B (Test-and-Fix Loop) 自动创建。\n\nRun ID: ${runId}\n源分支: ${sourceBranch}\n迭代分支: ${iterationBranch}`,
    remove_source_branch: false,
  }

  let mrUrl: string | null = null
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'PRIVATE-TOKEN': gitlabConfig.token,
    }

    const fetchFn: typeof fetch = globalThis.fetch
    const response = await fetchFn(apiUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    if (response.ok) {
      const data = (await response.json()) as { web_url?: string }
      mrUrl = data.web_url ?? null
      console.log(`[PipelineB:createSummaryMr] runId=${runId} MR created: ${mrUrl}`)
    } else {
      const text = await response.text()
      console.warn(`[PipelineB:createSummaryMr] GitLab API ${response.status}: ${text.slice(0, 300)}`)
    }
  } catch (err) {
    console.warn(`[PipelineB:createSummaryMr] fetch failed: ${err}`)
  }

  await updateE2eRunStatus(runId, 'passed', {
    finishedAt: new Date(),
    summaryMrUrl: mrUrl ?? undefined,
  })

  return { summaryMrUrl: mrUrl }
}
```

- [ ] **Step 2: 写 finalize-failed 节点**

```typescript
// src/e2e/pipeline-b/nodes/finalize-failed.ts
import { updateE2eRunStatus } from '../../../db/repositories/e2e-runs.js'
import type { PipelineBStateType } from '../types.js'

export function governorCheck(state: PipelineBStateType): 'continue' | 'over_budget' {
  const g = state.governorState
  const nowMs = Date.now()

  if (nowMs - g.runStartedAt > g.limits.maxRunHours * 3600 * 1000) {
    return 'over_budget'
  }

  if (g.totalAttempts >= g.limits.maxTotalAttempts) {
    return 'over_budget'
  }

  return 'continue'
}

export async function finalizeFailedNode(state: PipelineBStateType): Promise<Partial<PipelineBStateType>> {
  const { runId, governorState } = state

  const nowMs = Date.now()
  const elapsedMs = nowMs - governorState.runStartedAt
  let reason = 'governor_over_budget'

  if (elapsedMs > governorState.limits.maxRunHours * 3600 * 1000) {
    reason = `over_time_limit: ${Math.round(elapsedMs / 60000)}min elapsed (limit ${governorState.limits.maxRunHours}h)`
  } else if (governorState.totalAttempts >= governorState.limits.maxTotalAttempts) {
    reason = `over_total_attempts: ${governorState.totalAttempts} (limit ${governorState.limits.maxTotalAttempts})`
  }

  await updateE2eRunStatus(runId, 'failed', {
    finishedAt: new Date(),
    abortReason: reason,
  })

  console.log(`[PipelineB:finalizeFailed] runId=${runId} reason=${reason}`)
  return { errorMessage: reason }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/e2e/pipeline-b/nodes/create-summary-mr.ts src/e2e/pipeline-b/nodes/finalize-failed.ts
git commit -m "feat(e2e): Pipeline B 终止节点 (create_summary_mr + finalize_failed + governorCheck)"
```

---

### Task 7: 所有节点单测

**Files:**
- 新建: `src/__tests__/unit/pipeline-b-nodes.test.ts`

- [ ] **Step 1: 写单测**

```typescript
// src/__tests__/unit/pipeline-b-nodes.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({
  spawn: vi.fn(),
}))

vi.mock('../../e2e/pipeline-b/run-script.js', () => ({
  runScript: vi.fn(),
  parseLastJsonLine: vi.fn((text: string) => {
    const lines = text.trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (line.startsWith('{')) {
        try { return JSON.parse(line) } catch { /* skip */ }
      }
    }
    return null
  }),
}))

vi.mock('../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-runs.js', () => ({
  createE2eRun: vi.fn(),
  updateE2eRunStatus: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-sandboxes.js', () => ({
  createSandbox: vi.fn(),
  updateSandboxStatus: vi.fn(),
  getSandboxByRunId: vi.fn(),
}))

vi.mock('../../db/repositories/e2e-scenario-runs.js', () => ({
  createScenarioRun: vi.fn(),
  finishScenarioRun: vi.fn(),
  getLatestAttemptNumber: vi.fn(),
}))

vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn(),
}))

import { runScript } from '../../e2e/pipeline-b/run-script.js'
import { getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'
import { createSandbox, updateSandboxStatus } from '../../db/repositories/e2e-sandboxes.js'
import { updateE2eRunStatus } from '../../db/repositories/e2e-runs.js'
import { createScenarioRun, finishScenarioRun, getLatestAttemptNumber } from '../../db/repositories/e2e-scenario-runs.js'
import { resolveGitlabConfig } from '../../config/gitlab.js'

import { setupSandboxNode } from '../../e2e/pipeline-b/nodes/setup-sandbox.js'
import { deployInitialNode } from '../../e2e/pipeline-b/nodes/deploy-initial.js'
import { teardownSandboxNode } from '../../e2e/pipeline-b/nodes/teardown-sandbox.js'
import { healthcheckNode } from '../../e2e/pipeline-b/nodes/healthcheck.js'
import { redeployNode } from '../../e2e/pipeline-b/nodes/redeploy.js'
import { discoverNode } from '../../e2e/pipeline-b/nodes/discover.js'
import { pickNextScenarioNode } from '../../e2e/pipeline-b/nodes/pick-next-scenario.js'
import { runScenarioNode } from '../../e2e/pipeline-b/nodes/run-scenario.js'
import { markGreenNode } from '../../e2e/pipeline-b/nodes/mark-green.js'
import { markUnfixableNode } from '../../e2e/pipeline-b/nodes/mark-unfixable.js'
import { createSummaryMrNode } from '../../e2e/pipeline-b/nodes/create-summary-mr.js'
import { finalizeFailedNode, governorCheck } from '../../e2e/pipeline-b/nodes/finalize-failed.js'
import type { PipelineBStateType, GovernorState } from '../../e2e/pipeline-b/types.js'

const PROJECT_MOCK = {
  id: 'chatops',
  displayName: 'ChatOps',
  gitlabRepo: 'devops/chatops',
  defaultBranch: 'main',
  workingDir: '/workspace/chatops',
  scripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
  capabilities: {},
  defaultSandboxKind: 'docker-compose-local',
  createdAt: new Date().toISOString(),
}

const SANDBOX_HANDLE = {
  envId: 'test-env-42',
  kind: 'docker-compose-local',
  endpoints: { api: 'http://localhost:13042' },
  internalRefs: {},
  containerId: 'abc123',
  workdir: '/workspace/chatops',
}

const DEFAULT_GOVERNOR: GovernorState = {
  perScenarioAttempts: {},
  totalElapsedMs: 0,
  totalAttempts: 0,
  runStartedAt: Date.now(),
  limits: {
    maxPerScenarioAttempts: 3,
    maxRunHours: 4,
    maxTotalAttempts: 30,
    maxQueuedRuns: 2,
  },
}

const BASE_STATE: PipelineBStateType = {
  runId: 42n,
  sandboxId: null,
  targetProjectId: 'chatops',
  sourceBranch: 'main',
  iterationBranch: 'test-iter/42',
  scenarioFilter: null,
  sandboxHandle: null,
  projectScripts: { build: 'build.sh', deploy: 'deploy.sh', test: 'test.sh' },
  pendingScenarios: [],
  currentScenario: null,
  currentScenarioRunId: null,
  lastScenarioResult: null,
  lastFixResult: null,
  evidenceDirTemp: null,
  governorState: DEFAULT_GOVERNOR,
  summaryMrUrl: null,
  errorMessage: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getE2eTargetProject).mockResolvedValue(PROJECT_MOCK as any)
  vi.mocked(createSandbox).mockResolvedValue({ id: 1n, status: 'provisioning', handle: {}, kind: 'docker-compose-local', createdAt: new Date() } as any)
  vi.mocked(updateSandboxStatus).mockResolvedValue(undefined)
  vi.mocked(updateE2eRunStatus).mockResolvedValue(undefined)
  vi.mocked(createScenarioRun).mockResolvedValue({ id: 100n, e2eRunId: 42n, scenarioId: 'login', attemptNumber: 1 } as any)
  vi.mocked(finishScenarioRun).mockResolvedValue(undefined)
  vi.mocked(getLatestAttemptNumber).mockResolvedValue(0)
  vi.mocked(resolveGitlabConfig).mockResolvedValue({ url: 'https://gitlab.example.com', token: 'tok', skipTlsVerify: false })
})

describe('setupSandboxNode', () => {
  it('provision 成功 → sandboxHandle 非空 + sandboxId 写入', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"envId":"test-env-42","kind":"docker-compose-local","endpoints":{},"internalRefs":{}}',
      stderr: '',
      parsed: { envId: 'test-env-42', kind: 'docker-compose-local', endpoints: {}, internalRefs: {} },
    })

    vi.doMock('fs', () => ({
      writeFileSync: vi.fn(),
      mkdtempSync: vi.fn(() => '/tmp/e2e-handle-xyz'),
      readFileSync: vi.fn(() => JSON.stringify({ envId: 'test-env-42', kind: 'docker-compose-local', endpoints: {}, internalRefs: {} })),
    }))

    const result = await setupSandboxNode({ ...BASE_STATE })
    expect(result.sandboxId).toBeTruthy()
    expect(result.sandboxHandle).not.toBeNull()
    expect(result.sandboxHandle?.envId).toBe('test-env-42')
  })

  it('provision 失败 → throws Error', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'docker: no space left on device',
      parsed: null,
    })

    await expect(setupSandboxNode({ ...BASE_STATE })).rejects.toThrow('provision failed')
  })
})

describe('deployInitialNode', () => {
  it('build + deploy 成功 → returns empty patch', async () => {
    vi.mocked(runScript)
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"artifact":"chatops:iter","kind":"docker-image"}', stderr: '', parsed: { artifact: 'chatops:iter', kind: 'docker-image' } })
      .mockResolvedValueOnce({ exitCode: 0, stdout: '{"deployedAt":"2026-05-01"}', stderr: '', parsed: { deployedAt: '2026-05-01' } })

    const result = await deployInitialNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE })
    expect(result).toEqual({})
  })

  it('build 失败 → throws', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '',
      stderr: 'Error: build context missing',
      parsed: null,
    })

    await expect(deployInitialNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE })).rejects.toThrow('build failed')
  })

  it('sandboxHandle null → throws', async () => {
    await expect(deployInitialNode({ ...BASE_STATE })).rejects.toThrow('sandboxHandle is null')
  })
})

describe('teardownSandboxNode', () => {
  it('teardown 成功 → sandboxHandle 清空', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null })

    const result = await teardownSandboxNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE, sandboxId: 1n })
    expect(result.sandboxHandle).toBeNull()
    expect(updateSandboxStatus).toHaveBeenCalledWith(1n, 'torn_down', expect.any(Object))
  })

  it('no sandboxHandle → returns empty patch without calling runScript', async () => {
    const result = await teardownSandboxNode({ ...BASE_STATE })
    expect(result).toEqual({})
    expect(runScript).not.toHaveBeenCalled()
  })

  it('teardown 非 0 exit → 依然清空 sandboxHandle (幂等)', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'already down', parsed: null })

    const result = await teardownSandboxNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE, sandboxId: 1n })
    expect(result.sandboxHandle).toBeNull()
  })
})

describe('healthcheckNode', () => {
  it('exit 0 → returns empty patch', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null })
    const result = await healthcheckNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE })
    expect(result).toEqual({})
  })

  it('exit 非 0 → throws', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'unhealthy', parsed: null })
    await expect(healthcheckNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE })).rejects.toThrow('not healthy')
  })

  it('sandboxHandle null → throws', async () => {
    await expect(healthcheckNode({ ...BASE_STATE })).rejects.toThrow('sandboxHandle is null')
  })
})

describe('redeployNode', () => {
  it('redeploy 成功 → status 更新为 ready', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 0, stdout: '', stderr: '', parsed: null })
    const result = await redeployNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE, sandboxId: 1n })
    expect(result).toEqual({})
    expect(updateSandboxStatus).toHaveBeenCalledWith(1n, 'ready')
  })

  it('redeploy 失败 → throws + sandbox status=failed', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'OOM', parsed: null })
    await expect(redeployNode({ ...BASE_STATE, sandboxHandle: SANDBOX_HANDLE, sandboxId: 1n })).rejects.toThrow('redeploy: failed')
    expect(updateSandboxStatus).toHaveBeenCalledWith(1n, 'failed')
  })
})

describe('discoverNode', () => {
  it('--discover 成功 → pendingScenarios 设置', async () => {
    const scenarios = [
      { id: 'login-success', name: 'Login Success', tags: ['smoke'] },
      { id: 'create-prd', name: 'Create PRD', tags: ['core'] },
    ]
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ scenarios }),
      stderr: '',
      parsed: { scenarios },
    })

    const result = await discoverNode({ ...BASE_STATE })
    expect(result.pendingScenarios).toHaveLength(2)
    expect(result.pendingScenarios![0].id).toBe('login-success')
  })

  it('tag filter 生效', async () => {
    const scenarios = [
      { id: 'login-success', name: 'Login Success', tags: ['smoke'] },
      { id: 'create-prd', name: 'Create PRD', tags: ['core'] },
    ]
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ scenarios }),
      stderr: '',
      parsed: { scenarios },
    })

    const result = await discoverNode({ ...BASE_STATE, scenarioFilter: { tags: ['smoke'] } })
    expect(result.pendingScenarios).toHaveLength(1)
    expect(result.pendingScenarios![0].id).toBe('login-success')
  })

  it('exit 非 0 → throws', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: 'no tests found', parsed: null })
    await expect(discoverNode({ ...BASE_STATE })).rejects.toThrow('--discover failed')
  })
})

describe('pickNextScenarioNode', () => {
  it('有 pending scenarios → currentScenario 设为第一个', async () => {
    const scenarios = [
      { id: 'login-success', name: 'Login', tags: [] },
      { id: 'create-prd', name: 'PRD', tags: [] },
    ]
    const result = await pickNextScenarioNode({ ...BASE_STATE, pendingScenarios: scenarios })
    expect(result.currentScenario?.id).toBe('login-success')
  })

  it('空 pending → currentScenario null', async () => {
    const result = await pickNextScenarioNode({ ...BASE_STATE, pendingScenarios: [] })
    expect(result.currentScenario).toBeNull()
  })
})

describe('runScenarioNode', () => {
  const stateWithScenario = {
    ...BASE_STATE,
    sandboxHandle: SANDBOX_HANDLE,
    currentScenario: { id: 'login-success', name: 'Login', tags: ['smoke'] },
  }

  it('pass → lastScenarioResult=pass + governor totalAttempts 自增', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 0,
      stdout: '{"result":"pass","summary":"ok","duration_ms":1234}',
      stderr: '',
      parsed: { result: 'pass', summary: 'ok', duration_ms: 1234 },
    })

    const result = await runScenarioNode(stateWithScenario)
    expect(result.lastScenarioResult).toBe('pass')
    expect(result.governorState?.totalAttempts).toBe(1)
    expect(result.governorState?.perScenarioAttempts?.['login-success']).toBe(1)
  })

  it('fail → lastScenarioResult=fail', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: 1,
      stdout: '{"result":"fail","summary":"selector not found","duration_ms":500}',
      stderr: '',
      parsed: { result: 'fail', summary: 'selector not found', duration_ms: 500 },
    })

    const result = await runScenarioNode(stateWithScenario)
    expect(result.lastScenarioResult).toBe('fail')
    expect(result.currentScenarioRunId).toBeTruthy()
  })

  it('timeout (exitCode=-1) → lastScenarioResult=timeout', async () => {
    vi.mocked(runScript).mockResolvedValueOnce({
      exitCode: -1,
      stdout: '',
      stderr: '[timeout]',
      parsed: null,
    })

    const result = await runScenarioNode(stateWithScenario)
    expect(result.lastScenarioResult).toBe('timeout')
  })

  it('currentScenario null → throws', async () => {
    await expect(runScenarioNode({ ...BASE_STATE })).rejects.toThrow('currentScenario is null')
  })
})

describe('markGreenNode', () => {
  it('移除 currentScenario from pendingScenarios', async () => {
    const scenarios = [
      { id: 'login-success', name: 'Login', tags: [] },
      { id: 'create-prd', name: 'PRD', tags: [] },
    ]
    const result = await markGreenNode({
      ...BASE_STATE,
      currentScenario: scenarios[0],
      pendingScenarios: scenarios,
    })
    expect(result.pendingScenarios).toHaveLength(1)
    expect(result.pendingScenarios![0].id).toBe('create-prd')
    expect(result.currentScenario).toBeNull()
  })

  it('currentScenario null → returns empty patch', async () => {
    const result = await markGreenNode({ ...BASE_STATE })
    expect(result).toEqual({})
  })
})

describe('markUnfixableNode', () => {
  it('移除 currentScenario + finishScenarioRun 调用', async () => {
    const scenarios = [
      { id: 'login-success', name: 'Login', tags: [] },
      { id: 'create-prd', name: 'PRD', tags: [] },
    ]
    const result = await markUnfixableNode({
      ...BASE_STATE,
      currentScenario: scenarios[0],
      currentScenarioRunId: 100n,
      pendingScenarios: scenarios,
    })
    expect(result.pendingScenarios).toHaveLength(1)
    expect(result.currentScenario).toBeNull()
    expect(finishScenarioRun).toHaveBeenCalledWith(100n, 'unfixable', expect.any(Object))
  })
})

describe('createSummaryMrNode', () => {
  it('GitLab API 成功 → summaryMrUrl 写入 + run=passed', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ web_url: 'https://gitlab.example.com/devops/chatops/-/merge_requests/99' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await createSummaryMrNode({
      ...BASE_STATE,
      sandboxHandle: SANDBOX_HANDLE,
    })

    expect(result.summaryMrUrl).toContain('merge_requests/99')
    expect(updateE2eRunStatus).toHaveBeenCalledWith(42n, 'passed', expect.any(Object))
  })

  it('GitLab config 无 token → 跳过 MR 创建 + run=passed', async () => {
    vi.mocked(resolveGitlabConfig).mockResolvedValue({ url: '', token: '', skipTlsVerify: false })

    const result = await createSummaryMrNode({ ...BASE_STATE })
    expect(result).toEqual({})
    expect(updateE2eRunStatus).toHaveBeenCalledWith(42n, 'passed', expect.any(Object))
  })
})

describe('finalizeFailedNode', () => {
  it('更新 run status=failed + 写入 errorMessage', async () => {
    const result = await finalizeFailedNode({ ...BASE_STATE })
    expect(updateE2eRunStatus).toHaveBeenCalledWith(42n, 'failed', expect.any(Object))
    expect(result.errorMessage).toBeTruthy()
  })
})

describe('governorCheck', () => {
  it('未超限 → continue', () => {
    const result = governorCheck({ ...BASE_STATE })
    expect(result).toBe('continue')
  })

  it('totalAttempts >= limit → over_budget', () => {
    const state = {
      ...BASE_STATE,
      governorState: {
        ...DEFAULT_GOVERNOR,
        totalAttempts: 30,
      },
    }
    expect(governorCheck(state)).toBe('over_budget')
  })

  it('run 时间超限 → over_budget', () => {
    const state = {
      ...BASE_STATE,
      governorState: {
        ...DEFAULT_GOVERNOR,
        runStartedAt: Date.now() - 5 * 3600 * 1000,
      },
    }
    expect(governorCheck(state)).toBe('over_budget')
  })
})
```

- [ ] **Step 2: 运行测试**

```bash
npx vitest run src/__tests__/unit/pipeline-b-nodes.test.ts --reporter=verbose
# 预期: 所有测试 PASS
```

- [ ] **Step 3: Commit**

```bash
git add src/__tests__/unit/pipeline-b-nodes.test.ts
git commit -m "feat(e2e): Pipeline B 节点单测 (mock spawn, vitest)"
```

---

## 验收标准

- [ ] `npx vitest run src/__tests__/unit/pipeline-b-nodes.test.ts` → 所有测试 PASS
- [ ] `npx tsc --noEmit` → 0 errors（所有节点 + 类型文件编译通过）
- [ ] `src/e2e/pipeline-b/types.ts` 包含完整 `PipelineBState` Annotation（含 `governorState` + 所有字段）
- [ ] 所有节点遵守纯函数签名 `(state: PipelineBStateType) => Promise<Partial<PipelineBStateType>>`
- [ ] `create-summary-mr.ts` 通过 `resolveGitlabConfig()` 读取 GitLab 配置（不直接读 `process.env`）
- [ ] `reset-iteration-branch.ts` 通过 `resolveGitlabConfig()` 读取 git 凭据
- [ ] `teardown-sandbox.ts` 幂等：`sandboxHandle` 为 null 时直接返回空 patch
- [ ] `finalize-failed.ts` 导出 `governorCheck` 函数供图组装（B5）使用
