# E2E Pipeline A — 图实现 + 前端 UI 计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 Pipeline A 完整 LangGraph 图（AI 生成脚本 → static_check → baseline self-correct → commit + auto-merge）、Admin API、以及前端 `/e2e-specs` 和 `/e2e-targets` 两个页面。

**Architecture:** Pipeline A 作为独立 hardcoded LangGraph StateGraph 在 `src/e2e/pipeline-a/` 目录实现，不复用泛型 graph-builder（该 builder 为用户自定义 pipeline 设计，过于复杂）。LLM 节点调用 `executeCapabilityDirect`（claude-runner.ts）。所有 git/MR 操作走 `resolveGitlabConfig()`。Admin API 注册为 Fastify 插件，前端用 React + Ant Design 5。

**Tech Stack:** LangGraph (`@langchain/langgraph`), Fastify 5, React 18, Ant Design 5, Vitest

**前置条件:** Plan 1（`2026-04-30-e2e-pipeline-a-infra.md`）全部完成

---

## 文件地图

| 操作 | 路径 |
|---|---|
| 新建 | `src/e2e/pipeline-a/types.ts` |
| 新建 | `src/e2e/pipeline-a/graph.ts` |
| 新建 | `src/e2e/pipeline-a/nodes/init-generation.ts` |
| 新建 | `src/e2e/pipeline-a/nodes/generate-or-skip.ts` |
| 新建 | `src/e2e/pipeline-a/nodes/static-check.ts` |
| 新建 | `src/e2e/pipeline-a/nodes/baseline-sandbox.ts` |
| 新建 | `src/e2e/pipeline-a/nodes/baseline-check.ts` |
| 新建 | `src/e2e/pipeline-a/nodes/diagnose.ts` |
| 新建 | `src/e2e/pipeline-a/nodes/commit-pr.ts` |
| 新建 | `src/e2e/pipeline-a/runner.ts` |
| 新建 | `src/__tests__/integration/pipeline-a.test.ts` |
| 新建 | `src/admin/routes/e2e-specs.ts` |
| 新建 | `src/admin/routes/e2e-targets.ts` |
| 修改 | `src/admin/index.ts` (注册两个新路由) |
| 新建 | `web/src/api/e2e.ts` |
| 新建 | `web/src/pages/E2eSpecsPage.tsx` |
| 新建 | `web/src/pages/E2eTargetsPage.tsx` |
| 修改 | `web/src/App.tsx` (添加两条路由) |
| 修改 | `web/src/components/Layout.tsx` (侧边栏新增"自动化测试"菜单) |

---

### Task 1: Pipeline A 状态类型

**Files:**
- 新建: `src/e2e/pipeline-a/types.ts`

- [ ] **Step 1: 定义 state annotation**

```typescript
// src/e2e/pipeline-a/types.ts
import { Annotation } from '@langchain/langgraph'

export interface SpecWorkItem {
  specId: bigint
  specPath: string
  title: string
  contentHash: string
  targetProjectId: string
  scriptPath?: string       // 生成出来的 .spec.ts 路径
  generatedContent?: string // LLM 输出的脚本文本
}

export interface BaselineSandboxHandle {
  envId: string
  kind: string
  endpoints: Record<string, string>
  internalRefs: Record<string, unknown>
  sandboxId: bigint
}

export type DiagnosisVerdict = 'script_bug' | 'product_bug'

export interface BaselineResult {
  specId: bigint
  passed: boolean
  verdict?: DiagnosisVerdict
  evidenceDir?: string
  evidenceSummary?: string
}

export const PipelineAState = Annotation.Root({
  // 输入
  targetProjectId: Annotation<string>({ default: () => '', reducer: (_, v) => v }),
  specPaths: Annotation<string[]>({ default: () => [], reducer: (_, v) => v }),
  baseBranch: Annotation<string>({ default: () => 'main', reducer: (_, v) => v }),

  // 工作列表
  specs: Annotation<SpecWorkItem[]>({ default: () => [], reducer: (_, v) => v }),
  currentSpecIndex: Annotation<number>({ default: () => 0, reducer: (_, v) => v }),

  // 沙盒
  sandboxHandle: Annotation<BaselineSandboxHandle | null>({ default: () => null, reducer: (_, v) => v }),

  // 当前 spec 处理中间状态
  staticCheckAttempts: Annotation<number>({ default: () => 0, reducer: (_, v) => v }),
  staticCheckResult: Annotation<'pass' | 'fail' | null>({ default: () => null, reducer: (_, v) => v }),
  baselineAttempts: Annotation<number>({ default: () => 0, reducer: (_, v) => v }),
  lastBaselineResult: Annotation<BaselineResult | null>({ default: () => null, reducer: (_, v) => v }),
  diagnosisVerdict: Annotation<DiagnosisVerdict | null>({ default: () => null, reducer: (_, v) => v }),

  // 结果
  completedSpecs: Annotation<Array<{ specId: bigint; status: string; prUrl?: string }>>({
    default: () => [],
    reducer: (prev, v) => [...prev, ...v],
  }),

  // governor 限制
  maxStaticCheckAttempts: Annotation<number>({ default: () => 2, reducer: (_, v) => v }),
  maxBaselineAttempts: Annotation<number>({ default: () => 3, reducer: (_, v) => v }),

  // 错误暂存
  lastError: Annotation<string | null>({ default: () => null, reducer: (_, v) => v }),
})

export type PipelineAStateType = typeof PipelineAState.State
```

- [ ] **Step 2: Commit**

```bash
git add src/e2e/pipeline-a/types.ts
git commit -m "feat(e2e): Pipeline A state annotation 类型定义"
```

---

### Task 2: init_generation 节点

**Files:**
- 新建: `src/e2e/pipeline-a/nodes/init-generation.ts`

- [ ] **Step 1: 写节点实现**

```typescript
// src/e2e/pipeline-a/nodes/init-generation.ts
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { upsertE2eSpec, updateE2eSpecStatus, listE2eSpecs } from '../../../db/repositories/e2e-specs.js'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import type { PipelineAStateType, SpecWorkItem } from '../types.js'

export async function initGenerationNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { targetProjectId, specPaths, baseBranch } = state

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`e2e_target_projects: project "${targetProjectId}" not found`)

  // 解析 GitLab 配置（拿 repoPath 用于后续 git 操作）
  await resolveGitlabConfig() // validates config is available; throws if both DB and env empty

  // 如果 specPaths 为空，从 e2e_specs 表拉所有 pending spec
  let resolvedPaths = specPaths
  if (!resolvedPaths.length) {
    const all = await listE2eSpecs(targetProjectId)
    resolvedPaths = all.filter(s => s.generationStatus === 'pending').map(s => s.specPath)
  }

  const specs: SpecWorkItem[] = []
  for (const specPath of resolvedPaths) {
    // spec 内容 hash 等信息由调用方传入，这里直接 upsert 占位
    const spec = await upsertE2eSpec({
      targetProjectId,
      specPath,
      title: specPath.split('/').pop()?.replace('.md', '') ?? specPath,
      contentHash: 'tbd', // 调用方在触发时应该传正确 hash
    })
    await updateE2eSpecStatus(spec.id, 'generating')
    specs.push({
      specId: spec.id,
      specPath,
      title: spec.title,
      contentHash: spec.contentHash,
      targetProjectId,
    })
  }

  console.log(`[PipelineA:initGeneration] ${specs.length} specs to generate for ${targetProjectId}`)
  return { specs, currentSpecIndex: 0 }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/e2e/pipeline-a/nodes/init-generation.ts
git commit -m "feat(e2e): Pipeline A init_generation 节点"
```

---

### Task 3: generate_or_skip + LLM 生成器节点

**Files:**
- 新建: `src/e2e/pipeline-a/nodes/generate-or-skip.ts`

- [ ] **Step 1: 写节点实现**

```typescript
// src/e2e/pipeline-a/nodes/generate-or-skip.ts
import { spawnSync } from 'child_process'
import { join } from 'path'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { updateE2eSpecStatus } from '../../../db/repositories/e2e-specs.js'
import { runE2eLlmGenerator } from './llm-generator.js'
import type { PipelineAStateType } from '../types.js'

export async function generateOrSkipNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec) return {}

  const project = await getE2eTargetProject(spec.targetProjectId)
  if (!project) throw new Error(`project not found: ${spec.targetProjectId}`)

  const outScriptPath = `tests/e2e/${spec.specPath.split('/').pop()!.replace('.md', '.spec.ts')}`

  // 如果项目实现了 --generate，优先用项目侧
  if (project.capabilities.generate) {
    const testScript = join(project.workingDir, project.scripts.test)
    const result = spawnSync(testScript, ['--generate', spec.specPath, `--out=${outScriptPath}`], {
      encoding: 'utf8',
      timeout: 120_000,
    })
    if (result.status === 0) {
      const updatedSpec = { ...spec, scriptPath: outScriptPath }
      const updatedSpecs = [...state.specs]
      updatedSpecs[state.currentSpecIndex] = updatedSpec
      return { specs: updatedSpecs }
    }
    console.warn(`[PipelineA:generateOrSkip] project --generate failed (exit ${result.status}), falling back to LLM`)
  }

  // 平台兜底：LLM 生成
  const generated = await runE2eLlmGenerator(spec.specPath, spec.title)
  const updatedSpec = { ...spec, scriptPath: outScriptPath, generatedContent: generated }
  const updatedSpecs = [...state.specs]
  updatedSpecs[state.currentSpecIndex] = updatedSpec

  return { specs: updatedSpecs, staticCheckAttempts: 0 }
}
```

- [ ] **Step 2: 写 LLM 生成器 helper**

新建 `src/e2e/pipeline-a/nodes/llm-generator.ts`：

```typescript
// src/e2e/pipeline-a/nodes/llm-generator.ts
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { executeCapabilityDirectForE2e } from '../llm-bridge.js'

export async function runE2eLlmGenerator(specPath: string, title: string): Promise<string> {
  let specContent = ''
  try { specContent = readFileSync(specPath, 'utf8') } catch { /* spec in git, not local */ }

  const prompt = `你是一个 Playwright 测试工程师。根据以下 markdown 验收规约，生成对应的 Playwright TypeScript 测试脚本。
要求：
1. 每个场景生成一个 test() block，test name 与场景 ID 一致
2. 使用 Playwright locator API（getByRole / getByTestId），避免 CSS 类选择器
3. 每个断言用 expect()，超时用 { timeout: 10000 }
4. 不使用 page.waitForTimeout()，改用 waitForSelector / expect().toBeVisible()
5. 文件头 import { test, expect } from '@playwright/test'

spec 路径: ${specPath}
spec 标题: ${title}

spec 内容:
${specContent || '(文件需要从 GitLab 读取，请根据路径推断场景)'}

请直接输出 TypeScript 代码，不要额外解释。`

  const result = await executeCapabilityDirectForE2e(prompt, 'generate_script')
  return result
}
```

- [ ] **Step 3: 写 LLM bridge 辅助（连接 claude-runner）**

新建 `src/e2e/pipeline-a/llm-bridge.ts`：

```typescript
// src/e2e/pipeline-a/llm-bridge.ts
// 轻量 LLM 调用封装，不走 claude-runner 的完整 Session/IM 上下文，直接 executeCapabilityDirect
import { ClaudeRunner } from '../../agent/claude-runner.js'
import { buildClaudeEnv } from '../../agent/claude-config.js'

let _runner: ClaudeRunner | null = null

function getRunner(): ClaudeRunner {
  if (!_runner) {
    _runner = new ClaudeRunner()
  }
  return _runner
}

export async function executeCapabilityDirectForE2e(prompt: string, sessionKey: string): Promise<string> {
  const runner = getRunner()
  // executeCapabilityDirect 返回 void，用内部 textBuffer 拿结果
  // 这里通过注入自定义 onText 回调收集输出
  const chunks: string[] = []
  await runner.executeCapabilityDirect({
    prompt,
    systemPrompt: 'You are a Playwright test engineer. Output only TypeScript code.',
    context: { cwd: process.cwd() } as any,
    tools: [],
    sessionKey,
    freshSession: true,
    maxTurns: 5,
    onText: (t: string) => chunks.push(t),
  })
  return chunks.join('')
}
```

> **注意**：`executeCapabilityDirect` 的具体签名以 `src/agent/claude-runner.ts` 实际代码为准。如果该方法不暴露 `onText` 回调，改用 `executeCapabilityDirect` 的返回值，或在 runner 内部用 session transcript 读最后的 assistant message。

- [ ] **Step 4: Commit**

```bash
git add src/e2e/pipeline-a/nodes/generate-or-skip.ts src/e2e/pipeline-a/nodes/llm-generator.ts src/e2e/pipeline-a/llm-bridge.ts
git commit -m "feat(e2e): Pipeline A generate_or_skip + LLM generator 节点"
```

---

### Task 4: static_check 节点

**Files:**
- 新建: `src/e2e/pipeline-a/nodes/static-check.ts`

- [ ] **Step 1: 写单测**

新建 `src/__tests__/unit/pipeline-a-static-check.test.ts`：

```typescript
// src/__tests__/unit/pipeline-a-static-check.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn() }))

import { spawnSync } from 'child_process'
import { staticCheckNode } from '../../e2e/pipeline-a/nodes/static-check.js'

const baseState = {
  specs: [{ specId: 1n, specPath: 'docs/s.md', title: 'S', contentHash: 'x', targetProjectId: 'chatops', scriptPath: 'tests/e2e/s.spec.ts' }],
  currentSpecIndex: 0,
  staticCheckAttempts: 0,
  maxStaticCheckAttempts: 2,
  baseBranch: 'main',
  targetProjectId: 'chatops',
  specPaths: [],
  sandboxHandle: null,
  baselineAttempts: 0,
  lastBaselineResult: null,
  completedSpecs: [],
  maxBaselineAttempts: 3,
  lastError: null,
}

describe('staticCheckNode', () => {
  it('tsc 通过 → staticCheckResult=pass', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout: '', stderr: '' } as any)
    const result = await staticCheckNode(baseState as any)
    expect(result.staticCheckResult).toBe('pass')
  })

  it('tsc 失败 → staticCheckResult=fail + stderr 存入 lastError', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: "error TS2345: ..." } as any)
    const result = await staticCheckNode(baseState as any)
    expect(result.staticCheckResult).toBe('fail')
    expect(result.lastError).toContain('TS2345')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/__tests__/unit/pipeline-a-static-check.test.ts --reporter=verbose
# 预期: FAIL — staticCheckNode not found
```

- [ ] **Step 3: 实现 static_check 节点**

```typescript
// src/e2e/pipeline-a/nodes/static-check.ts
import { spawnSync } from 'child_process'
import type { PipelineAStateType } from '../types.js'

export async function staticCheckNode(
  state: PipelineAStateType,
): Promise<Partial<PipelineAStateType & { staticCheckResult: 'pass' | 'fail' }>> {
  const result = spawnSync('npx', ['tsc', '--noEmit', '--project', 'tsconfig.json'], {
    encoding: 'utf8',
    timeout: 60_000,
    shell: true,
  })

  if (result.status === 0) {
    return { staticCheckResult: 'pass', lastError: null }
  }

  const stderr = result.stderr ?? result.stdout ?? 'tsc failed'
  console.warn(`[PipelineA:staticCheck] tsc failed:\n${stderr.slice(0, 500)}`)
  return {
    staticCheckResult: 'fail',
    staticCheckAttempts: state.staticCheckAttempts + 1,
    lastError: stderr,
  }
}
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/__tests__/unit/pipeline-a-static-check.test.ts --reporter=verbose
# 预期: 2 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/e2e/pipeline-a/nodes/static-check.ts src/__tests__/unit/pipeline-a-static-check.test.ts
git commit -m "feat(e2e): Pipeline A static_check 节点 + 单测"
```

---

### Task 5: Baseline sandbox 节点（provision + build + deploy）

**Files:**
- 新建: `src/e2e/pipeline-a/nodes/baseline-sandbox.ts`

- [ ] **Step 1: 写单测**

新建 `src/__tests__/unit/pipeline-a-baseline-sandbox.test.ts`：

```typescript
// src/__tests__/unit/pipeline-a-baseline-sandbox.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('../../../db/repositories/e2e-sandboxes.js', () => ({
  createSandbox: vi.fn().mockResolvedValue({ id: 1n, status: 'provisioning', handle: {} }),
  updateSandboxStatus: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../db/repositories/e2e-target-projects.js', () => ({
  getE2eTargetProject: vi.fn().mockResolvedValue({
    id: 'chatops', scripts: { deploy: 'deploy.sh', build: 'build.sh' }, workingDir: '.',
  }),
}))

import { spawnSync } from 'child_process'
import { setupBaselineSandboxNode } from '../../e2e/pipeline-a/nodes/baseline-sandbox.js'

const baseState = {
  specs: [{ specId: 1n, targetProjectId: 'chatops', specPath: 's.md', title: 'S', contentHash: 'x' }],
  currentSpecIndex: 0, baseBranch: 'main', targetProjectId: 'chatops',
  specPaths: [], sandboxHandle: null, baselineAttempts: 0, lastBaselineResult: null,
  completedSpecs: [], maxBaselineAttempts: 3, maxStaticCheckAttempts: 2,
  staticCheckAttempts: 0, lastError: null,
}

describe('setupBaselineSandboxNode', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('provision 成功 → sandboxHandle 非空', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '{"envId":"test-1","kind":"docker-compose-local","endpoints":{"api":"http://localhost:13001"},"internalRefs":{}}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '{"artifact":"chatops:test","kind":"docker-image"}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '{"deployedAt":"2026-04-30T00:00:00Z"}', stderr: '' } as any)
    const result = await setupBaselineSandboxNode(baseState as any)
    expect(result.sandboxHandle).not.toBeNull()
    expect(result.sandboxHandle?.envId).toBe('test-1')
  })

  it('provision 失败 → throws', async () => {
    vi.mocked(spawnSync).mockReturnValue({ status: 1, stdout: '', stderr: 'docker error' } as any)
    await expect(setupBaselineSandboxNode(baseState as any)).rejects.toThrow('provision failed')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/__tests__/unit/pipeline-a-baseline-sandbox.test.ts --reporter=verbose
# 预期: FAIL
```

- [ ] **Step 3: 实现 baseline-sandbox 节点**

```typescript
// src/e2e/pipeline-a/nodes/baseline-sandbox.ts
import { spawnSync } from 'child_process'
import { writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import { createSandbox, updateSandboxStatus } from '../../../db/repositories/e2e-sandboxes.js'
import type { PipelineAStateType, BaselineSandboxHandle } from '../types.js'

function runScript(scriptPath: string, args: string[], timeoutMs = 300_000): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(scriptPath, args, { encoding: 'utf8', timeout: timeoutMs, shell: false })
  return { status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

function parseLastJson(text: string): Record<string, unknown> {
  const lines = text.trimEnd().split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (line.startsWith('{')) {
      try { return JSON.parse(line) } catch { /* skip */ }
    }
  }
  return {}
}

export async function setupBaselineSandboxNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { targetProjectId, baseBranch, specs, currentSpecIndex } = state
  const spec = specs[currentSpecIndex]

  const project = await getE2eTargetProject(targetProjectId)
  if (!project) throw new Error(`project not found: ${targetProjectId}`)

  const handleFile = join(tmpdir(), `e2e-handle-baseline-${Date.now()}.json`)
  const deployScript = join(project.workingDir, project.scripts.deploy)
  const buildScript = join(project.workingDir, project.scripts.build)

  // Step 1: provision
  const provision = runScript(deployScript, [`provision`, `--branch=${baseBranch}`, `--out-handle=${handleFile}`])
  if (provision.status !== 0) throw new Error(`provision failed: ${provision.stderr.slice(0, 300)}`)

  const handleJson = JSON.parse(readFileSync(handleFile, 'utf8'))
  const sandboxRecord = await createSandbox({ e2eRunId: null, kind: handleJson.kind ?? 'docker-compose-local', handle: handleJson })

  // Step 2: build
  const build = runScript(buildScript, [], 600_000)
  if (build.status !== 0) {
    await updateSandboxStatus(sandboxRecord.id, 'failed')
    throw new Error(`build failed: ${build.stderr.slice(0, 300)}`)
  }

  // Step 3: deploy
  const deploy = runScript(deployScript, [`deploy`, `--handle=${handleFile}`])
  if (deploy.status !== 0) {
    await updateSandboxStatus(sandboxRecord.id, 'failed')
    throw new Error(`deploy failed: ${deploy.stderr.slice(0, 300)}`)
  }

  await updateSandboxStatus(sandboxRecord.id, 'ready', { readyAt: new Date() })

  const sandboxHandle: BaselineSandboxHandle = {
    envId: handleJson.envId,
    kind: handleJson.kind ?? 'docker-compose-local',
    endpoints: handleJson.endpoints ?? {},
    internalRefs: handleJson.internalRefs ?? {},
    sandboxId: sandboxRecord.id,
  }

  console.log(`[PipelineA:setupBaseline] Sandbox ready: ${sandboxHandle.envId}`)
  return { sandboxHandle }
}

export async function teardownBaselineSandboxNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { sandboxHandle, targetProjectId } = state

  if (sandboxHandle) {
    const project = await getE2eTargetProject(targetProjectId)
    if (project) {
      const deployScript = join(project.workingDir, project.scripts.deploy)
      const handleFile = join(tmpdir(), `e2e-handle-teardown-${sandboxHandle.envId}.json`)
      writeFileSync(handleFile, JSON.stringify(sandboxHandle))
      const result = runScript(deployScript, [`teardown`, `--handle=${handleFile}`])
      if (result.status !== 0) {
        console.warn(`[PipelineA:teardown] teardown failed: ${result.stderr.slice(0, 200)}`)
      }
      await updateSandboxStatus(sandboxHandle.sandboxId, 'torn_down', { destroyedAt: new Date() })
    }
  }

  // 无论从哪条路径来到 teardown（product_bug / 超限 / 正常 commit 后），
  // commitAndPrNode 正常成功时已自增 currentSpecIndex。
  // 失败路径（product_bug / static 超限 / baseline 超限）currentSpecIndex 未自增，在此补齐。
  const specWasCommitted = state.completedSpecs.length > 0 &&
    state.completedSpecs[state.completedSpecs.length - 1].specId === state.specs[state.currentSpecIndex]?.specId
  const nextIndex = specWasCommitted ? state.currentSpecIndex : state.currentSpecIndex + 1

  return {
    sandboxHandle: null,
    currentSpecIndex: nextIndex,
    staticCheckAttempts: 0,
    baselineAttempts: 0,
    staticCheckResult: null,
    lastBaselineResult: null,
    diagnosisVerdict: null,
  }
}
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/__tests__/unit/pipeline-a-baseline-sandbox.test.ts --reporter=verbose
# 预期: 2 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/e2e/pipeline-a/nodes/baseline-sandbox.ts src/__tests__/unit/pipeline-a-baseline-sandbox.test.ts
git commit -m "feat(e2e): Pipeline A baseline sandbox 节点 (provision + build + deploy + teardown)"
```

---

### Task 6: baseline_check + 自修复循环节点

**Files:**
- 新建: `src/e2e/pipeline-a/nodes/baseline-check.ts`
- 新建: `src/e2e/pipeline-a/nodes/diagnose.ts`

- [ ] **Step 1: 写 baseline_check 节点**

```typescript
// src/e2e/pipeline-a/nodes/baseline-check.ts
import { spawnSync } from 'child_process'
import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getE2eTargetProject } from '../../../db/repositories/e2e-target-projects.js'
import type { PipelineAStateType, BaselineResult } from '../types.js'

export async function runBaselineCheckNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec) return {}

  const project = await getE2eTargetProject(spec.targetProjectId)
  if (!project) throw new Error(`project not found: ${spec.targetProjectId}`)

  const testScript = join(project.workingDir, project.scripts.test)
  const evidenceDir = join(tmpdir(), `e2e-evidence-baseline-${spec.specId}-attempt-${state.baselineAttempts + 1}`)
  mkdirSync(evidenceDir, { recursive: true })

  // 从 specPath 推断 scenarioId（文件名去掉 .md）
  const scenarioId = spec.specPath.split('/').pop()!.replace('.md', '')

  const result = spawnSync(testScript, [`--scenario`, scenarioId, `--evidence-dir=${evidenceDir}`], {
    encoding: 'utf8',
    timeout: 300_000,
  })

  const passed = result.status === 0
  const lastLine = (result.stdout ?? '').trim().split('\n').pop() ?? ''
  let summary = `Baseline check ${passed ? 'PASSED' : 'FAILED'} for ${scenarioId}`
  try { summary = JSON.parse(lastLine)?.summary ?? summary } catch { /* ignore */ }

  const baselineResult: BaselineResult = {
    specId: spec.specId,
    passed,
    evidenceDir,
    evidenceSummary: summary,
  }

  console.log(`[PipelineA:baselineCheck] attempt ${state.baselineAttempts + 1}: ${passed ? 'PASS' : 'FAIL'}`)
  return {
    lastBaselineResult: baselineResult,
    baselineAttempts: state.baselineAttempts + 1,
  }
}
```

- [ ] **Step 2: 写 diagnose 节点（LLM 判定 script_bug vs product_bug）**

```typescript
// src/e2e/pipeline-a/nodes/diagnose.ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { executeCapabilityDirectForE2e } from '../llm-bridge.js'
import type { PipelineAStateType, DiagnosisVerdict } from '../types.js'

export async function diagnoseBaselineNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType & { diagnosisVerdict: DiagnosisVerdict }>> {
  const { lastBaselineResult, specs, currentSpecIndex } = state
  const spec = specs[currentSpecIndex]
  if (!lastBaselineResult || !spec) return { diagnosisVerdict: 'script_bug' }

  // 读证据
  const evidenceDir = lastBaselineResult.evidenceDir ?? ''
  let evidenceSummary = lastBaselineResult.evidenceSummary ?? ''
  let manifestContent = ''
  try {
    manifestContent = readFileSync(join(evidenceDir, 'manifest.json'), 'utf8')
  } catch { /* evidence dir may not exist in test */ }

  const prompt = `你是一个 QA 工程师，需要诊断以下 Playwright baseline 测试失败的根因。

spec 路径: ${spec.specPath}
失败摘要: ${evidenceSummary}
证据 manifest:
${manifestContent || '(无证据文件)'}

判断规则：
- 如果失败原因是"选择器错误、断言逻辑错误、时序假设错误、import 错误"等，判定为 script_bug
- 如果失败原因是"功能本身就是坏的、API 返回错误 response、数据库错误"等，判定为 product_bug
- 默认倾向 script_bug（baseline 理应是绿色的）

请只输出一个 JSON：{"verdict": "script_bug"} 或 {"verdict": "product_bug"}，不要其他文字。`

  const output = await executeCapabilityDirectForE2e(prompt, `diagnose-baseline-${spec.specId}`)

  let verdict: DiagnosisVerdict = 'script_bug' // default
  try {
    const match = output.match(/"verdict"\s*:\s*"(script_bug|product_bug)"/)
    if (match) verdict = match[1] as DiagnosisVerdict
  } catch { /* default */ }

  console.log(`[PipelineA:diagnose] spec ${spec.specId}: verdict=${verdict}`)
  return { diagnosisVerdict: verdict }
}

export async function fixScriptNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const { lastBaselineResult, specs, currentSpecIndex } = state
  const spec = specs[currentSpecIndex]
  if (!spec?.scriptPath) return {}

  const evidenceDir = lastBaselineResult?.evidenceDir ?? ''
  let evidenceSummary = lastBaselineResult?.evidenceSummary ?? 'baseline failed'

  const prompt = `你是一个 Playwright 测试工程师，需要修复以下测试脚本中的 bug。

脚本路径: ${spec.scriptPath}
失败原因: ${evidenceSummary}

请输出修复后的完整 TypeScript 文件内容（包含所有 import 语句），不要任何解释。`

  const fixedContent = await executeCapabilityDirectForE2e(prompt, `fix-script-${spec.specId}`)

  const updatedSpec = { ...spec, generatedContent: fixedContent }
  const updatedSpecs = [...state.specs]
  updatedSpecs[state.currentSpecIndex] = updatedSpec

  return { specs: updatedSpecs, lastError: null }
}
```

- [ ] **Step 3: Commit**

```bash
git add src/e2e/pipeline-a/nodes/baseline-check.ts src/e2e/pipeline-a/nodes/diagnose.ts
git commit -m "feat(e2e): Pipeline A baseline_check + diagnose + fix_script 节点"
```

---

### Task 7: commit_and_pr + auto_merge 节点

**Files:**
- 新建: `src/e2e/pipeline-a/nodes/commit-pr.ts`

- [ ] **Step 1: 写单测**

新建 `src/__tests__/unit/pipeline-a-commit-pr.test.ts`：

```typescript
// src/__tests__/unit/pipeline-a-commit-pr.test.ts
import { describe, it, expect, vi } from 'vitest'

vi.mock('child_process', () => ({ spawnSync: vi.fn() }))
vi.mock('../../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn().mockResolvedValue({ url: 'https://gitlab.example.com', token: 'test-token' }),
}))
vi.mock('../../../db/repositories/e2e-specs.js', () => ({
  updateE2eSpecStatus: vi.fn().mockResolvedValue(undefined),
}))

import { spawnSync } from 'child_process'
import { commitAndPrNode } from '../../e2e/pipeline-a/nodes/commit-pr.js'

const baseState = {
  specs: [{
    specId: 1n, specPath: 'docs/test-specs/login.md', title: 'Login',
    contentHash: 'abc', targetProjectId: 'chatops',
    scriptPath: 'tests/e2e/login.spec.ts', generatedContent: 'test("login", () => {})',
  }],
  currentSpecIndex: 0,
  baseBranch: 'main', targetProjectId: 'chatops',
  specPaths: [], sandboxHandle: null, baselineAttempts: 1, lastBaselineResult: { specId: 1n, passed: true },
  completedSpecs: [], maxBaselineAttempts: 3, maxStaticCheckAttempts: 2, staticCheckAttempts: 0, lastError: null,
}

describe('commitAndPrNode', () => {
  it('git + MR 命令全成功 → prUrl 返回', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)  // write file
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)  // git add
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)  // git commit
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)  // git push
      .mockReturnValueOnce({ status: 0, stdout: 'https://gitlab.example.com/mr/1\n', stderr: '' } as any) // glab mr create

    const result = await commitAndPrNode(baseState as any)
    expect(result.completedSpecs).toHaveLength(1)
    expect(result.completedSpecs![0].prUrl).toContain('gitlab')
  })

  it('glab mr create 失败 → spec 标 baseline_failed', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'glab: unauthorized' } as any)

    const result = await commitAndPrNode(baseState as any)
    expect(result.completedSpecs![0].status).toBe('baseline_failed')
  })
})
```

- [ ] **Step 2: 运行测试，确认失败**

```bash
npx vitest run src/__tests__/unit/pipeline-a-commit-pr.test.ts --reporter=verbose
# 预期: FAIL
```

- [ ] **Step 3: 实现 commit_and_pr 节点**

```typescript
// src/e2e/pipeline-a/nodes/commit-pr.ts
import { spawnSync } from 'child_process'
import { writeFileSync, mkdirSync } from 'fs'
import { dirname } from 'path'
import { resolveGitlabConfig } from '../../../config/gitlab.js'
import { updateE2eSpecStatus } from '../../../db/repositories/e2e-specs.js'
import type { PipelineAStateType } from '../types.js'

function git(args: string[], env: Record<string, string> = {}): { status: number; stdout: string } {
  const r = spawnSync('git', args, { encoding: 'utf8', timeout: 60_000, env: { ...process.env, ...env } })
  return { status: r.status ?? -1, stdout: r.stdout ?? '' }
}

export async function commitAndPrNode(state: PipelineAStateType): Promise<Partial<PipelineAStateType>> {
  const spec = state.specs[state.currentSpecIndex]
  if (!spec?.scriptPath || !spec.generatedContent) {
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  const { url: gitlabUrl, token } = await resolveGitlabConfig()
  const gitEnv = token ? { GIT_ASKPASS: 'echo', GIT_TOKEN: token } : {}

  // 写生成的脚本到工作树
  mkdirSync(dirname(spec.scriptPath), { recursive: true })
  writeFileSync(spec.scriptPath, spec.generatedContent, 'utf8')

  // git add + commit + push 到 iteration branch
  const branchName = `e2e-gen/${spec.specId}-${Date.now()}`
  git(['checkout', '-b', branchName])
  git(['add', spec.scriptPath])
  const commitResult = git(['commit', '-m', `feat(e2e): 自动生成测试脚本 — ${spec.title}`])
  if (commitResult.status !== 0) {
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  git(['push', 'origin', branchName], gitEnv)

  // 创建 MR（用 glab CLI，从 resolveGitlabConfig 读 URL）
  const mrResult = spawnSync('glab', [
    'mr', 'create',
    `--title=feat(e2e): 自动生成测试脚本 — ${spec.title}`,
    `--description=由 Pipeline A 自动生成，已过 baseline self-correct 验证`,
    `--source-branch=${branchName}`,
    `--target-branch=${state.baseBranch}`,
    '--yes',
  ], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, GITLAB_TOKEN: token ?? '', GITLAB_HOST: gitlabUrl ?? '' },
  })

  if (mrResult.status !== 0) {
    await updateE2eSpecStatus(spec.specId, 'baseline_failed')
    return { completedSpecs: [{ specId: spec.specId, status: 'baseline_failed' }] }
  }

  const prUrl = mrResult.stdout.trim().split('\n').pop() ?? ''
  await updateE2eSpecStatus(spec.specId, 'pr_open', { generatedPrUrl: prUrl, generatedArtifactPath: spec.scriptPath, lastGeneratedAt: new Date() })

  // 启动自动 merge（异步等 CI）
  void autoMergePr(prUrl, spec.specId, token ?? '', gitlabUrl ?? '')

  return {
    completedSpecs: [{ specId: spec.specId, status: 'pr_open', prUrl }],
    currentSpecIndex: state.currentSpecIndex + 1,
    baselineAttempts: 0,
    staticCheckAttempts: 0,
    sandboxHandle: null,
  }
}

async function autoMergePr(prUrl: string, specId: bigint, token: string, gitlabUrl: string): Promise<void> {
  // 提取 MR IID（URL 末尾的数字）
  const iid = prUrl.split('/').pop()
  if (!iid) return

  // 等 CI（轮询，最多 30 分钟）
  let ciPassed = false
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 30_000))
    const checkResult = spawnSync('glab', ['mr', 'view', iid, '--output=json'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, GITLAB_TOKEN: token, GITLAB_HOST: gitlabUrl },
    })
    if (checkResult.status === 0) {
      try {
        const mr = JSON.parse(checkResult.stdout)
        if (mr.detailed_merge_status === 'mergeable' || mr.pipeline?.status === 'success') {
          ciPassed = true
          break
        }
        if (mr.pipeline?.status === 'failed') break
      } catch { /* continue polling */ }
    }
  }

  if (!ciPassed) {
    console.warn(`[PipelineA:autoMerge] CI timed out for MR ${iid}, leaving pr_open`)
    return
  }

  spawnSync('glab', ['mr', 'merge', iid, '--yes', '--squash'], {
    encoding: 'utf8', timeout: 60_000,
    env: { ...process.env, GITLAB_TOKEN: token, GITLAB_HOST: gitlabUrl },
  })
  await updateE2eSpecStatus(specId, 'committed')
  console.log(`[PipelineA:autoMerge] MR ${iid} merged, spec ${specId} → committed`)
}
```

- [ ] **Step 4: 运行测试**

```bash
npx vitest run src/__tests__/unit/pipeline-a-commit-pr.test.ts --reporter=verbose
# 预期: 2 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/e2e/pipeline-a/nodes/commit-pr.ts src/__tests__/unit/pipeline-a-commit-pr.test.ts
git commit -m "feat(e2e): Pipeline A commit_and_pr + auto_merge 节点"
```

---

### Task 8: Pipeline A 图装配 + runner + 集成测试

**Files:**
- 新建: `src/e2e/pipeline-a/graph.ts`
- 新建: `src/e2e/pipeline-a/runner.ts`
- 新建: `src/__tests__/integration/pipeline-a.test.ts`

- [ ] **Step 1: 装配 LangGraph 图**

```typescript
// src/e2e/pipeline-a/graph.ts
import { StateGraph, START, END } from '@langchain/langgraph'
import { PipelineAState } from './types.js'
import { initGenerationNode } from './nodes/init-generation.js'
import { generateOrSkipNode } from './nodes/generate-or-skip.js'
import { staticCheckNode } from './nodes/static-check.js'
import { setupBaselineSandboxNode, teardownBaselineSandboxNode } from './nodes/baseline-sandbox.js'
import { runBaselineCheckNode } from './nodes/baseline-check.js'
import { diagnoseBaselineNode, fixScriptNode } from './nodes/diagnose.js'
import { commitAndPrNode } from './nodes/commit-pr.js'
import type { PipelineAStateType } from './types.js'

export function buildPipelineAGraph() {
  const graph = new StateGraph(PipelineAState)

  graph
    .addNode('init_generation', initGenerationNode)
    .addNode('generate_or_skip', generateOrSkipNode)
    .addNode('static_check', staticCheckNode)
    .addNode('fix_script_static', fixScriptNode)
    .addNode('setup_baseline_sandbox', setupBaselineSandboxNode)
    .addNode('run_baseline_check', runBaselineCheckNode)
    .addNode('diagnose_baseline', diagnoseBaselineNode)
    .addNode('fix_script_baseline', fixScriptNode)
    .addNode('commit_and_pr', commitAndPrNode)
    .addNode('teardown_sandbox', teardownBaselineSandboxNode)

  graph.addEdge(START, 'init_generation')
  graph.addEdge('init_generation', 'generate_or_skip')
  graph.addEdge('generate_or_skip', 'static_check')

  // static_check 循环（staticCheckResult 字段已在 PipelineAState 中定义）
  graph.addConditionalEdges('static_check', (s: PipelineAStateType) => {
    if (s.staticCheckResult === 'pass') return 'setup_baseline_sandbox'
    if (s.staticCheckAttempts >= s.maxStaticCheckAttempts) return 'teardown_sandbox'
    return 'fix_script_static'
  }, {
    setup_baseline_sandbox: 'setup_baseline_sandbox',
    fix_script_static: 'fix_script_static',
    teardown_sandbox: 'teardown_sandbox',
  })

  graph.addEdge('fix_script_static', 'static_check')
  graph.addEdge('setup_baseline_sandbox', 'run_baseline_check')

  // baseline_check 结果路由
  graph.addConditionalEdges('run_baseline_check', (s: PipelineAStateType) => {
    if (s.lastBaselineResult?.passed) return 'commit_and_pr'
    return 'diagnose_baseline'
  }, {
    commit_and_pr: 'commit_and_pr',
    diagnose_baseline: 'diagnose_baseline',
  })

  // diagnose 路由（diagnosisVerdict 字段已在 PipelineAState 中定义）
  graph.addConditionalEdges('diagnose_baseline', (s: PipelineAStateType) => {
    if (s.diagnosisVerdict === 'product_bug') return 'teardown_sandbox'
    if (s.baselineAttempts >= s.maxBaselineAttempts) return 'teardown_sandbox'
    return 'fix_script_baseline'
  }, {
    fix_script_baseline: 'fix_script_baseline',
    teardown_sandbox: 'teardown_sandbox',
  })

  graph.addEdge('fix_script_baseline', 'run_baseline_check')
  graph.addEdge('commit_and_pr', 'teardown_sandbox')

  // teardown 后：product_bug / static_check 超限 / baseline 超限 路径下 currentSpecIndex 未自增
  // teardownBaselineSandboxNode 负责统一自增（见该节点实现）
  graph.addConditionalEdges('teardown_sandbox', (s: PipelineAStateType) => {
    if (s.currentSpecIndex < s.specs.length) return 'generate_or_skip'
    return END
  }, {
    generate_or_skip: 'generate_or_skip',
    [END]: END,
  })

  return graph.compile()
}
```

- [ ] **Step 2: 写 runner（capability 入口）**

```typescript
// src/e2e/pipeline-a/runner.ts
import { buildPipelineAGraph } from './graph.js'
import type { PipelineAStateType } from './types.js'

export interface PipelineAInput {
  targetProjectId: string
  specPaths?: string[]
  baseBranch?: string
}

export async function runPipelineA(input: PipelineAInput): Promise<void> {
  const graph = buildPipelineAGraph()
  const initialState: Partial<PipelineAStateType> = {
    targetProjectId: input.targetProjectId,
    specPaths: input.specPaths ?? [],
    baseBranch: input.baseBranch ?? 'main',
  }

  console.log(`[PipelineA] Starting for project=${input.targetProjectId}, specs=${input.specPaths?.length ?? 'all'}`)

  for await (const chunk of await graph.stream(initialState, { recursionLimit: 50 })) {
    const [nodeName, state] = Object.entries(chunk)[0]
    console.log(`[PipelineA] ${nodeName} completed`)
  }

  console.log('[PipelineA] Done')
}
```

- [ ] **Step 3: 写集成测试（mock 所有 invoke_target_script + LLM）**

新建 `src/__tests__/integration/pipeline-a.test.ts`：

```typescript
// src/__tests__/integration/pipeline-a.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetTestDb } from '../helpers/db.js'

// Mock 外部依赖
vi.mock('child_process', () => ({ spawnSync: vi.fn(), spawn: vi.fn() }))
vi.mock('../../e2e/pipeline-a/llm-bridge.js', () => ({
  executeCapabilityDirectForE2e: vi.fn()
    .mockResolvedValueOnce('test("login-success", async ({ page }) => { await page.goto("/"); await expect(page).toHaveTitle("ChatOps"); })')
    .mockResolvedValue('{"verdict":"script_bug"}'),
}))
vi.mock('../../config/gitlab.js', () => ({
  resolveGitlabConfig: vi.fn().mockResolvedValue({ url: 'https://gitlab.example.com', token: 'tok' }),
}))

import { spawnSync } from 'child_process'
import { runPipelineA } from '../../e2e/pipeline-a/runner.js'
import { listE2eSpecs } from '../../db/repositories/e2e-specs.js'

function mockSpawnSuccess(stdout = '{}') {
  vi.mocked(spawnSync).mockReturnValue({ status: 0, stdout, stderr: '' } as any)
}

beforeEach(async () => {
  await resetTestDb()
  vi.clearAllMocks()
})

describe('Pipeline A integration', () => {
  it('happy path: generate → static_check pass → baseline pass → pr_open', async () => {
    // provision + build + deploy → success
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '{"envId":"test-1","kind":"docker-compose-local","endpoints":{},"internalRefs":{}}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '{"artifact":"chatops:test","kind":"docker-image"}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '{"deployedAt":"2026-04-30"}', stderr: '' } as any)
      // static_check → pass
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any)
      // run_baseline_check → pass
      .mockReturnValueOnce({ status: 0, stdout: '{"result":"pass","summary":"ok","duration_ms":500}', stderr: '' } as any)
      // git add, commit, push, glab mr create, teardown
      .mockReturnValue({ status: 0, stdout: 'https://gitlab.example.com/devops/chatops/-/merge_requests/1\n', stderr: '' } as any)

    await runPipelineA({ targetProjectId: 'chatops', specPaths: ['docs/test-specs/login.md'], baseBranch: 'main' })

    const specs = await listE2eSpecs('chatops')
    expect(specs.some(s => s.generationStatus === 'pr_open')).toBe(true)
  })

  it('baseline fails 3 times → spec marked baseline_failed', async () => {
    vi.mocked(spawnSync)
      .mockReturnValueOnce({ status: 0, stdout: '{"envId":"test-2","kind":"docker-compose-local","endpoints":{},"internalRefs":{}}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '{}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' } as any) // static_check pass
      // 3 baseline fail attempts
      .mockReturnValueOnce({ status: 1, stdout: '{"result":"fail","summary":"selector not found"}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '{"result":"fail","summary":"selector not found"}', stderr: '' } as any)
      .mockReturnValueOnce({ status: 1, stdout: '{"result":"fail","summary":"selector not found"}', stderr: '' } as any)
      .mockReturnValue({ status: 0, stdout: '', stderr: '' } as any) // teardown

    await runPipelineA({ targetProjectId: 'chatops', specPaths: ['docs/test-specs/login.md'], baseBranch: 'main' })

    const specs = await listE2eSpecs('chatops')
    expect(specs.some(s => s.generationStatus === 'baseline_failed')).toBe(true)
  })
})
```

- [ ] **Step 4: 运行集成测试**

```bash
npx vitest run src/__tests__/integration/pipeline-a.test.ts --reporter=verbose
# 预期: 2 tests PASS
```

- [ ] **Step 5: Commit**

```bash
git add src/e2e/pipeline-a/graph.ts src/e2e/pipeline-a/runner.ts src/__tests__/integration/pipeline-a.test.ts
git commit -m "feat(e2e): Pipeline A 图装配 + runner + 集成测试"
```

---

### Task 9: Admin API 路由

**Files:**
- 新建: `src/admin/routes/e2e-specs.ts`
- 新建: `src/admin/routes/e2e-targets.ts`
- 修改: `src/admin/index.ts`

- [ ] **Step 1: 写 e2e-targets 路由（只读）**

```typescript
// src/admin/routes/e2e-targets.ts
import type { FastifyInstance } from 'fastify'
import { listE2eTargetProjects, getE2eTargetProject } from '../../db/repositories/e2e-target-projects.js'

export async function registerE2eTargetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/e2e-targets', async (_req, reply) => {
    return reply.send(await listE2eTargetProjects())
  })

  app.get<{ Params: { id: string } }>('/e2e-targets/:id', async (req, reply) => {
    const project = await getE2eTargetProject(req.params.id)
    if (!project) return reply.status(404).send({ error: 'not found' })
    return reply.send(project)
  })
}
```

- [ ] **Step 2: 写 e2e-specs 路由**

```typescript
// src/admin/routes/e2e-specs.ts
import type { FastifyInstance } from 'fastify'
import { listE2eSpecs, getE2eSpec, upsertE2eSpec, updateE2eSpecStatus } from '../../db/repositories/e2e-specs.js'
import { runPipelineA } from '../../e2e/pipeline-a/runner.js'

export async function registerE2eSpecRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { projectId?: string } }>('/e2e-specs', async (req, reply) => {
    const projectId = req.query.projectId ?? 'chatops'
    return reply.send(await listE2eSpecs(projectId))
  })

  app.post<{ Body: { targetProjectId: string; specPath: string; title: string; contentHash?: string } }>(
    '/e2e-specs',
    async (req, reply) => {
      const { targetProjectId, specPath, title, contentHash } = req.body
      if (!targetProjectId || !specPath || !title) {
        return reply.status(400).send({ error: 'targetProjectId, specPath, title required' })
      }
      const spec = await upsertE2eSpec({ targetProjectId, specPath, title, contentHash: contentHash ?? 'manual' })
      return reply.status(201).send(spec)
    },
  )

  app.post<{ Params: { id: string } }>('/e2e-specs/:id/generate', async (req, reply) => {
    const spec = await getE2eSpec(BigInt(req.params.id))
    if (!spec) return reply.status(404).send({ error: 'spec not found' })
    if (spec.generationStatus === 'generating') {
      return reply.status(409).send({ error: 'already generating' })
    }

    // 异步启动 Pipeline A（不等待完成）
    void runPipelineA({ targetProjectId: spec.targetProjectId, specPaths: [spec.specPath] }).catch((err) => {
      console.error('[e2e-specs:generate] Pipeline A error:', err)
      updateE2eSpecStatus(spec.id, 'baseline_failed').catch(() => {})
    })

    return reply.status(202).send({ message: 'generation started', specId: spec.id.toString() })
  })

  app.put<{ Params: { id: string }; Body: { generationStatus?: string; skip?: boolean } }>(
    '/e2e-specs/:id',
    async (req, reply) => {
      const spec = await getE2eSpec(BigInt(req.params.id))
      if (!spec) return reply.status(404).send({ error: 'not found' })

      if (req.body.skip) {
        await updateE2eSpecStatus(spec.id, 'skipped')
      } else if (req.body.generationStatus) {
        await updateE2eSpecStatus(spec.id, req.body.generationStatus as any)
      }
      return reply.send(await getE2eSpec(spec.id))
    },
  )
}
```

- [ ] **Step 3: 在 src/admin/index.ts 注册两个新路由**

找到 `src/admin/index.ts` 中已有的路由注册，在末尾追加：

```typescript
import { registerE2eTargetRoutes } from './routes/e2e-targets.js'
import { registerE2eSpecRoutes } from './routes/e2e-specs.js'

// 在注册函数里：
await app.register(registerE2eTargetRoutes, { prefix: '/admin' })
await app.register(registerE2eSpecRoutes, { prefix: '/admin' })
```

- [ ] **Step 4: 手工测试 API（需 pnpm dev 已启动）**

```bash
curl -s http://localhost:3000/admin/e2e-targets | jq '.[0].id'
# 预期: "chatops"

curl -s "http://localhost:3000/admin/e2e-specs?projectId=chatops" | jq 'length'
# 预期: 0（表为空）
```

- [ ] **Step 5: Commit**

```bash
git add src/admin/routes/e2e-targets.ts src/admin/routes/e2e-specs.ts src/admin/index.ts
git commit -m "feat(e2e): Admin API — /e2e-targets (只读) + /e2e-specs (CRUD + 触发生成)"
```

---

### Task 10: 前端 API 层

**Files:**
- 新建: `web/src/api/e2e.ts`

- [ ] **Step 1: 写 API 层**

```typescript
// web/src/api/e2e.ts
import axios from 'axios'

export interface E2eTargetProject {
  id: string
  displayName: string
  gitlabRepo: string
  defaultBranch: string
  workingDir: string
  scripts: { build: string; deploy: string; test: string; fix?: string }
  capabilities: Record<string, unknown>
  defaultSandboxKind: string
  createdAt: string
}

export type GenerationStatus =
  | 'pending' | 'generating' | 'pr_open' | 'committed'
  | 'baseline_failed' | 'blocked_on_baseline_bug' | 'skipped'

export interface E2eSpec {
  id: string
  targetProjectId: string
  specPath: string
  title: string
  contentHash: string
  generatedArtifactPath: string | null
  generatedPrUrl: string | null
  generationStatus: GenerationStatus
  lastGeneratedAt: string | null
  createdAt: string
}

export const e2eApi = {
  listTargets: () => axios.get<E2eTargetProject[]>('/admin/e2e-targets').then(r => r.data),
  getTarget: (id: string) => axios.get<E2eTargetProject>(`/admin/e2e-targets/${id}`).then(r => r.data),

  listSpecs: (projectId = 'chatops') =>
    axios.get<E2eSpec[]>('/admin/e2e-specs', { params: { projectId } }).then(r => r.data),

  createSpec: (data: { targetProjectId: string; specPath: string; title: string }) =>
    axios.post<E2eSpec>('/admin/e2e-specs', data).then(r => r.data),

  generateSpec: (id: string) =>
    axios.post<{ message: string; specId: string }>(`/admin/e2e-specs/${id}/generate`).then(r => r.data),

  skipSpec: (id: string) =>
    axios.put<E2eSpec>(`/admin/e2e-specs/${id}`, { skip: true }).then(r => r.data),
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/api/e2e.ts
git commit -m "feat(e2e): 前端 API 层 — e2e.ts"
```

---

### Task 11: 前端 E2eSpecsPage

**Files:**
- 新建: `web/src/pages/E2eSpecsPage.tsx`

- [ ] **Step 1: 写 E2eSpecsPage 组件**

```tsx
// web/src/pages/E2eSpecsPage.tsx
import { useState, useEffect, useCallback } from 'react'
import { Table, Tag, Button, Space, message, Typography, Tooltip, Badge } from 'antd'
import { ReloadOutlined, ThunderboltOutlined, StopOutlined } from '@ant-design/icons'
import type { ColumnsType } from 'antd/es/table'
import { e2eApi, type E2eSpec, type GenerationStatus } from '../api/e2e'

const { Text, Link } = Typography

const STATUS_CONFIG: Record<GenerationStatus, { color: string; label: string }> = {
  pending:                 { color: 'default',  label: '待生成' },
  generating:              { color: 'processing', label: '生成中' },
  pr_open:                 { color: 'blue',    label: 'PR 已创建' },
  committed:               { color: 'success', label: '已合入' },
  baseline_failed:         { color: 'error',   label: 'Baseline 失败' },
  blocked_on_baseline_bug: { color: 'warning', label: '产品 Bug 阻塞' },
  skipped:                 { color: 'default', label: '已跳过' },
}

export default function E2eSpecsPage() {
  const [specs, setSpecs] = useState<E2eSpec[]>([])
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await e2eApi.listSpecs('chatops')
      setSpecs(data)
    } catch {
      message.error('加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // 5s 轮询刷新（有 generating 状态时）
  useEffect(() => {
    const hasGenerating = specs.some(s => s.generationStatus === 'generating')
    if (!hasGenerating) return
    const timer = setInterval(load, 5000)
    return () => clearInterval(timer)
  }, [specs, load])

  const handleGenerate = async (spec: E2eSpec) => {
    setGenerating(prev => new Set(prev).add(spec.id))
    try {
      await e2eApi.generateSpec(spec.id)
      message.success(`已触发生成：${spec.title}`)
      await load()
    } catch {
      message.error('触发失败')
    } finally {
      setGenerating(prev => { const s = new Set(prev); s.delete(spec.id); return s })
    }
  }

  const handleSkip = async (spec: E2eSpec) => {
    try {
      await e2eApi.skipSpec(spec.id)
      await load()
    } catch {
      message.error('操作失败')
    }
  }

  const columns: ColumnsType<E2eSpec> = [
    {
      title: '规约路径',
      dataIndex: 'specPath',
      render: (path: string) => <Text code>{path}</Text>,
    },
    {
      title: '标题',
      dataIndex: 'title',
    },
    {
      title: '状态',
      dataIndex: 'generationStatus',
      render: (status: GenerationStatus) => {
        const cfg = STATUS_CONFIG[status]
        return (
          <Badge
            status={status === 'generating' ? 'processing' : undefined}
            text={<Tag color={cfg.color}>{cfg.label}</Tag>}
          />
        )
      },
    },
    {
      title: '生成的脚本',
      dataIndex: 'generatedArtifactPath',
      render: (path: string | null) => path ? <Text code>{path}</Text> : <Text type="secondary">—</Text>,
    },
    {
      title: 'PR',
      dataIndex: 'generatedPrUrl',
      render: (url: string | null) => url ? <Link href={url} target="_blank">查看 PR</Link> : <Text type="secondary">—</Text>,
    },
    {
      title: '上次生成',
      dataIndex: 'lastGeneratedAt',
      render: (d: string | null) => d ? new Date(d).toLocaleString() : '—',
    },
    {
      title: '操作',
      render: (_: unknown, spec: E2eSpec) => {
        const isGenerating = spec.generationStatus === 'generating' || generating.has(spec.id)
        const canGenerate = ['pending', 'baseline_failed', 'blocked_on_baseline_bug', 'committed'].includes(spec.generationStatus)
        return (
          <Space>
            {canGenerate && (
              <Button
                size="small"
                type="primary"
                icon={<ThunderboltOutlined />}
                loading={isGenerating}
                onClick={() => handleGenerate(spec)}
              >
                {spec.generationStatus === 'pending' ? '生成' : '重生成'}
              </Button>
            )}
            {spec.generationStatus !== 'skipped' && (
              <Tooltip title="跳过 Stage 1（项目已有脚本）">
                <Button size="small" icon={<StopOutlined />} onClick={() => handleSkip(spec)}>
                  跳过
                </Button>
              </Tooltip>
            )}
          </Space>
        )
      },
    },
  ]

  return (
    <div style={{ padding: 24 }}>
      <Space style={{ marginBottom: 16, width: '100%', justifyContent: 'space-between' }}>
        <Typography.Title level={4} style={{ margin: 0 }}>测试规约管理</Typography.Title>
        <Button icon={<ReloadOutlined />} onClick={load} loading={loading}>刷新</Button>
      </Space>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={specs}
        loading={loading}
        pagination={{ pageSize: 20 }}
        locale={{ emptyText: '暂无测试规约。在仓库 docs/test-specs/ 目录下创建 markdown spec 文件后，通过 API 或 IM 触发注册。' }}
      />
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add web/src/pages/E2eSpecsPage.tsx
git commit -m "feat(e2e): 前端 E2eSpecsPage — 规约列表 + 状态徽章 + 生成按钮"
```

---

### Task 12: 前端 E2eTargetsPage + 路由 + 侧边栏

**Files:**
- 新建: `web/src/pages/E2eTargetsPage.tsx`
- 修改: `web/src/App.tsx`
- 修改: `web/src/components/Layout.tsx`（或实际的侧边栏文件）

- [ ] **Step 1: 写 E2eTargetsPage（只读详情）**

```tsx
// web/src/pages/E2eTargetsPage.tsx
import { useState, useEffect } from 'react'
import { Card, Descriptions, Tag, Spin, Typography, Space } from 'antd'
import { CheckCircleTwoTone, CloseCircleTwoTone } from '@ant-design/icons'
import { e2eApi, type E2eTargetProject } from '../api/e2e'

const { Title, Text, Link } = Typography

function ScriptTag({ path, exists }: { path: string; exists?: boolean }) {
  return (
    <Space>
      <Text code>{path}</Text>
      {exists !== undefined && (
        exists
          ? <CheckCircleTwoTone twoToneColor="#52c41a" />
          : <CloseCircleTwoTone twoToneColor="#ff4d4f" />
      )}
    </Space>
  )
}

export default function E2eTargetsPage() {
  const [project, setProject] = useState<E2eTargetProject | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    e2eApi.getTarget('chatops')
      .then(setProject)
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <Spin style={{ display: 'block', margin: '48px auto' }} />
  if (!project) return <Text type="danger">未找到 chatops 项目配置</Text>

  const gitlabUrl = `https://gitlab.example.com/${project.gitlabRepo}`

  return (
    <div style={{ padding: 24, maxWidth: 800 }}>
      <Title level={4}>被测项目详情</Title>
      <Card>
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="项目 ID">
            <Text code>{project.id}</Text>
          </Descriptions.Item>
          <Descriptions.Item label="显示名称">{project.displayName}</Descriptions.Item>
          <Descriptions.Item label="GitLab 仓库">
            <Link href={gitlabUrl} target="_blank">{project.gitlabRepo}</Link>
          </Descriptions.Item>
          <Descriptions.Item label="默认分支">
            <Tag>{project.defaultBranch}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="沙盒类型">
            <Tag color="blue">{project.defaultSandboxKind}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="build.sh">
            <ScriptTag path={project.scripts.build} />
          </Descriptions.Item>
          <Descriptions.Item label="deploy.sh">
            <ScriptTag path={project.scripts.deploy} />
          </Descriptions.Item>
          <Descriptions.Item label="test.sh">
            <ScriptTag path={project.scripts.test} />
          </Descriptions.Item>
          {project.scripts.fix && (
            <Descriptions.Item label="fix.sh (可选)">
              <ScriptTag path={project.scripts.fix} />
            </Descriptions.Item>
          )}
          <Descriptions.Item label="能力">
            {Object.entries(project.capabilities).map(([k, v]) => (
              <Tag key={k} color={v ? 'green' : 'default'}>{k}</Tag>
            ))}
          </Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  )
}
```

- [ ] **Step 2: 在 App.tsx 添加路由**

找到 `web/src/App.tsx` 中现有路由定义（`<Route path=...`），添加：

```tsx
import E2eSpecsPage from './pages/E2eSpecsPage'
import E2eTargetsPage from './pages/E2eTargetsPage'

// 在现有路由列表里加：
<Route path="/e2e-targets" element={<E2eTargetsPage />} />
<Route path="/e2e-specs" element={<E2eSpecsPage />} />
```

- [ ] **Step 3: 在侧边栏添加"自动化测试"菜单项**

找到 `web/src/components/Layout.tsx`（或实际的 sidebar/menu 文件），在现有菜单项末尾加：

```tsx
{
  key: 'e2e',
  label: '自动化测试',
  type: 'group',
  children: [
    {
      key: '/e2e-targets',
      label: <Link to="/e2e-targets">被测项目</Link>,
      icon: <ExperimentOutlined />,
    },
    {
      key: '/e2e-specs',
      label: <Link to="/e2e-specs">测试规约</Link>,
      icon: <FileTextOutlined />,
    },
  ],
}
```

> 注意：根据实际 Layout 文件的 menu 结构调整。如果使用 `items` 数组，则在数组末尾追加上面的对象。需要从 `@ant-design/icons` 导入 `ExperimentOutlined` 和 `FileTextOutlined`。

- [ ] **Step 4: 验证前端编译**

```bash
cd web && npx tsc --noEmit
# 预期: 0 errors
```

- [ ] **Step 5: 在浏览器里验证**

```bash
# 确保后端在跑
pnpm dev &
cd web && pnpm dev
```

打开 http://localhost:5173/e2e-specs：
- 侧边栏显示"自动化测试"菜单组
- 页面加载显示空表格（暂无规约）
- 刷新按钮可用

打开 http://localhost:5173/e2e-targets：
- 显示 chatops 项目的 Descriptions 卡片
- scripts 路径正确显示

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/E2eTargetsPage.tsx web/src/App.tsx web/src/components/Layout.tsx
git commit -m "feat(e2e): 前端 E2eTargetsPage + 侧边栏菜单 + 路由"
```

---

## 验收标准

- [ ] `npx vitest run src/__tests__/unit/pipeline-a-static-check.test.ts` → 2 PASS
- [ ] `npx vitest run src/__tests__/unit/pipeline-a-baseline-sandbox.test.ts` → 2 PASS
- [ ] `npx vitest run src/__tests__/unit/pipeline-a-commit-pr.test.ts` → 2 PASS
- [ ] `npx vitest run src/__tests__/integration/pipeline-a.test.ts` → 2 PASS
- [ ] `cd web && npx tsc --noEmit` → 0 errors
- [ ] `curl /admin/e2e-targets` → chatops 项目 JSON
- [ ] `curl /admin/e2e-specs?projectId=chatops` → `[]`（空列表）
- [ ] 手工触发: POST `/admin/e2e-specs` 注册一个 spec → POST `/admin/e2e-specs/:id/generate` → 状态变 `generating`
- [ ] 浏览器 `/e2e-specs` 页显示规约列表和「生成」按钮
- [ ] 浏览器 `/e2e-targets` 页显示 chatops 项目详情
- [ ] 端到端 dogfood：写 1 份 `docs/test-specs/login.md` → 通过 UI 触发 → 观察 Pipeline A 日志 → 确认 `.spec.ts` 文件 commit 进仓库
